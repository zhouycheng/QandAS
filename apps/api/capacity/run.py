"""Adaptive k6 runs with external host protection and post-run persistence audits."""
import argparse
import collections
import concurrent.futures
from datetime import datetime
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from client import Api, Lease, Remote, private_json, smoke
import seed
from resources import http_busy, metrics as metric_values


def epoch(value):
    # k6 emits variable nanosecond precision; Python 3.9 requires normalized microseconds.
    normalized = re.sub(r'\.(\d+)', lambda m: '.' + m.group(1)[:6].ljust(6, '0'), value)
    return datetime.fromisoformat(normalized.replace('Z', '+00:00')).timestamp()


def percentile(values, p):
    if not values: return None
    data = sorted(values); return data[max(0, math.ceil(len(data) * p) - 1)]


class Metrics:
    def __init__(self):
        self.points = collections.deque(); self.offset = 0

    def update(self, path):
        if not path.exists(): return
        with path.open() as f:
            f.seek(self.offset)
            while True:
                pos = f.tell(); line = f.readline()
                if not line or not line.endswith('\n'):
                    self.offset = pos; break
                row = json.loads(line)
                if row.get('type') != 'Point': continue
                if row['metric'] not in ('http_reqs', 'http_req_duration', 'command_commit_latency', 'business_success', 'business_operations', 'business_failures', 'accepted_commands', 'committed_commands', 'dropped_iterations'): continue
                d = row['data']; stamp = epoch(d['time'])
                self.points.append((stamp, row['metric'], d['value'], d.get('tags', {})))
        cutoff = time.time() - 130
        while self.points and self.points[0][0] < cutoff: self.points.popleft()

    def window(self, seconds=60):
        return summarize(x for x in self.points if x[0] >= time.time() - seconds)


def summarize(points):
    counts = collections.Counter(); durations = []; accepts = []; commits = []; business = []; endpoints = collections.defaultdict(list)
    first, last = None, None
    for stamp, metric, value, tags in points:
        if metric in ('http_reqs', 'http_req_duration'):
            began = stamp - value / 1000 if metric == 'http_req_duration' else stamp
            first = began if first is None else min(first, began); last = stamp if last is None else max(last, stamp)
        if metric == 'http_reqs':
            counts['http'] += value
            code = int(tags.get('status') or 0)
            if code == 503: counts['unavailable'] += value
            if tags.get('error_code') == '1050': counts['timeouts'] += value
            if code == 429: counts['limited'] += value
            elif code >= 500: counts['server_errors'] += value
            elif code == 0: counts['transport_errors'] += value
            elif code >= 400: counts['other_errors'] += value
        elif metric == 'http_req_duration':
            durations.append(value)
            endpoints[tags.get('name', 'unknown')].append(value)
            if tags.get('name', '').startswith('POST ') and tags.get('name', '').endswith('/progress-commands'): accepts.append(value)
        elif metric == 'command_commit_latency': commits.append(value)
        elif metric == 'business_success': business.append(value)
        elif metric in ('business_operations', 'business_failures', 'accepted_commands', 'committed_commands', 'dropped_iterations'):
            counts[metric] += value
    elapsed = max(1, (last or 0) - (first or 0)); total = counts['http']
    result = {**counts, 'elapsed': elapsed, 'rps': total / elapsed,
            'successful_rps': (total - counts['limited'] - counts['server_errors'] - counts['transport_errors'] - counts['other_errors']) / elapsed,
            'completed_operations_per_second': (counts['business_operations'] - counts['business_failures']) / elapsed,
            'error_rate': (counts['limited'] + counts['server_errors'] + counts['transport_errors'] + counts['other_errors']) / max(1, total),
            'server_failure_rate': (counts['server_errors'] + counts['transport_errors']) / max(1, total),
            'business_success': sum(business) / len(business) if business else None,
            'p95_ms': percentile(durations, .95), 'p99_ms': percentile(durations, .99),
            'accept_p95_ms': percentile(accepts, .95), 'commit_p95_ms': percentile(commits, .95), 'commit_p99_ms': percentile(commits, .99)}
    result['endpoint_p95_ms'] = {key: percentile(value, .95) for key, value in endpoints.items()}
    return result


def violations(value):
    result = []
    if value.get('http', 0) and value['error_rate'] > .01: result.append('request_errors')
    if value.get('business_success') is not None and value['business_success'] < .99: result.append('business_errors')
    for metric, limit in [('p95_ms', 2000), ('accept_p95_ms', 1000), ('commit_p95_ms', 5000), ('commit_p99_ms', 15000)]:
        if value.get(metric) is not None and value[metric] > limit: result.append(metric)
    if any(latency > (1000 if name.startswith('POST ') and name.endswith('/progress-commands') else 2000) for name, latency in value.get('endpoint_p95_ms', {}).items()): result.append('endpoint_p95_ms')
    return result


def queue_size(sample):
    metrics = sample.get('rabbit', {}).get('metrics', '')
    return sum(float(line.rsplit(' ', 1)[1]) for line in metrics.splitlines() if line.startswith(('rabbitmq_detailed_queue_messages_ready{', 'rabbitmq_detailed_queue_messages_unacked{')) and 'queue="qanda.sync.progress"' in line)


def backlog_violations(samples):
    if not samples: return []
    end = samples[-1]['observed_at']
    window = [s for s in samples if s['observed_at'] >= end - 60]
    if len(window) < 6 or window[-1]['observed_at'] - window[0]['observed_at'] < 45: return []
    earlier = [s for s in window if s['observed_at'] <= end - 30]
    recent = [s for s in window if s['observed_at'] > end - 30]
    if not earlier or not recent: return []
    mean = lambda rows, get: sum(get(s) for s in rows) / len(rows)
    faults = []
    previous = mean(earlier, queue_size)
    if mean(recent, queue_size) > previous + 10 and all(queue_size(s) > previous + 10 for s in recent[-3:]): faults.append('queue_growth')
    pending = lambda s: s.get('postgres', {}).get('activity_pending', 0)
    # The projection consumes one-second batches; normal subsecond sawtooth is not sustained lag.
    if mean(recent, pending) > mean(earlier, pending) + 10 and all(s.get('postgres', {}).get('activity_oldest_seconds', 0) >= 5 for s in recent[-3:]): faults.append('activity_projection_growth')
    return faults


class Guard:
    def __init__(self, baseline):
        self.baseline = baseline; self.low_memory_since = None; self.unhealthy_since = None; self.tunnel_busy_since = None

    def check(self, sample, now):
        host = sample['host']
        if host['disk_free'] < 5 * 1024 ** 3: return 'host_disk_reserve'
        if host['available'] < 256 * 1024 ** 2:
            if self.low_memory_since is None: self.low_memory_since = now
            if now - self.low_memory_since >= 15: return 'host_memory_reserve'
        else: self.low_memory_since = None
        unhealthy = False
        for name, value in sample['containers'].items():
            old = self.baseline['containers'].get(name, {})
            if old.get('running') and not value['running']: return 'container_stopped:' + name
            if value['oom'] or value['restarts'] > old.get('restarts', 0): return 'container_oom_or_restart:' + name
            if int(value.get('memory_events', {}).get('oom_kill', '0')) > int(old.get('memory_events', {}).get('oom_kill', '0')): return 'container_oom:' + name
            if name.startswith('qanda-application-') and (not value['running'] or value.get('health') == 'unhealthy' or not value.get('probe_ok', True)): unhealthy = True
        if unhealthy:
            if self.unhealthy_since is None: self.unhealthy_since = now
            if now - self.unhealthy_since >= 30: return 'application_unhealthy'
        else: self.unhealthy_since = None
        if sample.get('generator', {}).get('tunnel_cpu_percent', 0) >= 90:
            if self.tunnel_busy_since is None: self.tunnel_busy_since = now
            if now - self.tunnel_busy_since >= 15: return 'generator_tunnel_cpu_ceiling'
        else: self.tunnel_busy_since = None
        return None


def full_metrics(path):
    opener = gzip.open if path.suffix == '.gz' else open
    with opener(path, 'rt') as f:
        for line in f:
            try: row = json.loads(line)
            except json.JSONDecodeError:
                if not line.endswith('\n'): break
                raise
            if row.get('type') == 'Point':
                d = row['data']; yield (epoch(d['time']), row['metric'], d['value'], d.get('tags', {}))


def read_events(path):
    for line in path.read_text().splitlines():
        try:
            row = json.loads(line); msg = row.get('msg', '')
            if isinstance(msg, str) and msg.startswith('{'): yield json.loads(msg)
        except (ValueError, TypeError): pass


def persistence_counts(value):
    return value['commands'], value.get('results'), value.get('activity_pending', 0)


def wait_drain(remote, timeout=600, log=None):
    end = time.monotonic() + timeout; value = None; previous = None
    while True:
        try:
            value = remote.action('verify', timeout=15)
            sample = remote.action('collect', timeout=15)
        except (subprocess.SubprocessError, OSError, ValueError, RuntimeError):
            previous = None
            if log:
                with log.open('a') as file: file.write(json.dumps({'observed_at': time.time(), 'observation_unavailable': True}) + '\n')
            if time.monotonic() >= end:
                if value is None: raise RuntimeError('Recovery could not be verified within ten minutes')
                return {**value, 'recovered': False, 'application_ready': False}
            time.sleep(5); continue
        sample['observed_at'] = time.time()
        if log:
            with log.open('a') as file: file.write(json.dumps(sample) + '\n')
        apps = [x for name, x in sample['containers'].items() if name.startswith('qanda-application-')]
        value['application_ready'] = len(apps) == 3 and all(x['running'] and x.get('probe_ok', False) for x in apps)
        drained = not value.get('activity_pending', 0) and not any(value['commands'].get(x, 0) for x in ('ACCEPTING', 'QUEUED', 'RETRYING'))
        value['http_idle'] = http_busy(metric_values(sample.get('application', {}).get('qanda-application-api-1', {}).get('metrics', ''))) == 0
        quiet = drained and value['application_ready'] and value['http_idle']
        value['recovered'] = quiet and previous is not None and persistence_counts(previous) == persistence_counts(value)
        if value['recovered']: return value
        previous = value if quiet else None
        if time.monotonic() >= end: return value
        time.sleep(5)


def audit_after_drain(remote, intents, folder, timeout=600):
    end = time.monotonic() + timeout
    while True:
        settled = wait_drain(remote, timeout=max(0, end - time.monotonic()), log=folder / 'recovery.jsonl')
        audit = json.loads(remote.shell(['sudo', '-n', 'python3', remote.config['remote_dir'] + '/remote.py', 'audit', '--run', remote.state.name], data=json.dumps(intents).encode()))
        after = remote.action('verify', timeout=15)
        unchanged = persistence_counts(after) == persistence_counts(settled)
        if unchanged or time.monotonic() >= end:
            return {**settled, **after, 'recovered': settled['recovered'] and unchanged}, audit


def user_pool(remote, wanted):
    path = remote.state / 'dataset.json'; value = json.loads(path.read_text())
    if len(value['users']) >= wanted: return
    remote.action('reset', 'off'); tunnel = remote.tunnel()
    try: seed.run(remote.state, wanted)
    finally: tunnel.terminate(); tunnel.wait()
    remote.action('snapshot')


def prepare_finishes(remote, target):
    dataset = json.loads((remote.state / 'dataset.json').read_text()); c = remote.config
    def create(index):
        user = dataset['users'][index]; bank = dataset['banks'][index % len(dataset['banks'])]
        return Api(c['port'], user['token']).call('POST', '/practice/sessions', {'scope': bank['scope'], 'expectedContentVersion': bank['preview']['contentVersion'], 'expectedContentVersions': bank['preview']['contentVersions'], 'deviceId': user['deviceId']})
    with concurrent.futures.ThreadPoolExecutor(4) as pool: values = list(pool.map(create, range(target)))
    path = remote.state / 'prepared.json'; private_json(path, values); return path


def stop_k6(child):
    if child is None: return
    for timeout in (.2, 5):
        if child.poll() is not None: return
        child.send_signal(signal.SIGINT)
        try: child.wait(timeout=timeout)
        except subprocess.TimeoutExpired: continue
    if child.poll() is None: child.kill(); child.wait()


def collection_failure(remote, failures, ssh_errors):
    try:
        remote.shell(['true'], timeout=5)
        ssh_errors = 0
    except (subprocess.SubprocessError, OSError, RuntimeError):
        ssh_errors += 1
    reason = 'management_connection_timeout' if ssh_errors >= 2 else 'monitoring_unavailable' if failures >= 2 and ssh_errors == 0 else None
    return ssh_errors, reason


def trial(remote, scenario, target, limits, seconds, label):
    folder = remote.state / 'trials' / label
    if (folder / 'result.json').exists():
        cached = json.loads((folder / 'result.json').read_text())
        assert (cached['backend_revision'], cached['scenario'], cached['target'], cached['limits'], cached['duration']) == (remote.config['expected_revision'], scenario, target, limits, 1 if scenario.startswith('burst') else seconds), 'Completed run configuration mismatch'
        print(json.dumps({'reused_completed_trial': label, 'original_harness': cached['harness_sha256']}), flush=True)
        return cached
    user_pool(remote, max(target, 1000)); folder.mkdir(parents=True)
    remote.action('reset', limits); tunnel = remote.tunnel(); child = None
    baseline = remote.action('collect', timeout=10); guard = Guard(baseline)
    raw = folder / 'raw.json'; metrics = Metrics(); reason = None; bad_windows = 0; first_unstable = None; last_window = time.monotonic(); ssh_errors = 0; collection_errors = 0
    samples = []; wall_start = time.time(); prepared = None
    try:
        if scenario == 'burst_finish':
            # Fixture creation must not consume the limited run's fixed-window budget.
            remote.action('mode', 'off'); tunnel.terminate(); tunnel.wait(); tunnel = remote.tunnel()
            prepared = prepare_finishes(remote, target)
            remote.action('mode', limits); tunnel.terminate(); tunnel.wait(); tunnel = remote.tunnel()
            baseline = remote.action('collect', timeout=10); guard = Guard(baseline)
        dataset = json.loads((remote.state / 'dataset.json').read_text())
        for _ in range(3): smoke(remote.config['port'], dataset)
        baseline = remote.action('collect', timeout=10); guard = Guard(baseline)
        database_before = remote.action('verify')
        env = {**os.environ, 'DATASET': str(remote.state / 'dataset.json'), 'BASE_URL': 'http://127.0.0.1:' + str(remote.config['port']) + '/api/v1', 'SCENARIO': scenario, 'TARGET': str(target), 'SECONDS': str(seconds), 'START_AT': str(int((time.time() + 30) * 1000))}
        if prepared: env['PREPARED'] = str(prepared)
        command = [remote.config['k6'], 'run', '--quiet', '--no-usage-report', '--no-color', '--log-format=json', '--out', 'json=' + str(raw), '--summary-export', str(folder / 'k6-summary.json'), str(Path(__file__).with_name('load.js'))]
        with (folder / 'stdout.log').open('wb') as out, (folder / 'events.jsonl').open('wb') as err, (folder / 'samples.jsonl').open('w') as sample_log:
            child = subprocess.Popen(command, env=env, stdout=out, stderr=err)
            load_start = time.time()
            while child.poll() is None:
                time.sleep(5)
                if tunnel.poll() is not None:
                    reason = 'private_tunnel_exited'; stop_k6(child); break
                metrics.update(raw); now = time.monotonic()
                try:
                    sample = remote.action('collect', timeout=15); ssh_errors = 0; collection_errors = 0
                    sample['observed_at'] = time.time()
                    processes = subprocess.run(['ps', '-p', str(child.pid) + ',' + str(tunnel.pid), '-o', 'pid=,pcpu=,rss='], capture_output=True, text=True).stdout.splitlines()
                    processes = {int(row[0]): row[1:] for row in (line.split() for line in processes) if len(row) == 3}
                    generator = processes.get(child.pid); transport = processes.get(tunnel.pid)
                    sample['generator'] = {'cpu_percent': float(generator[0]) / os.cpu_count(), 'rss': int(generator[1]) * 1024} if generator else {}
                    if transport: sample['generator'].update(tunnel_cpu_percent=float(transport[0]), tunnel_rss=int(transport[1]) * 1024)
                    pressure = subprocess.run(['memory_pressure', '-Q'], capture_output=True, text=True).stdout
                    match = re.search(r'memory free percentage:\s*(\d+)%', pressure)
                    if match: sample['generator']['system_free_percent'] = int(match.group(1))
                    sample['window'] = metrics.window(); samples.append(sample)
                    sample_log.write(json.dumps(sample) + '\n'); sample_log.flush()
                    reason = guard.check(sample, now)
                    generator = sample['generator']
                    if generator.get('rss', 0) > 6 * 1024 ** 3: reason = 'generator_memory_ceiling'
                    if generator.get('cpu_percent', 0) > 80: reason = 'generator_cpu_ceiling'
                    if generator.get('system_free_percent', 100) < 15: reason = 'generator_system_memory_ceiling'
                    if now - last_window >= 60:
                        faults = violations(sample['window'])
                        if sample['window']['elapsed'] >= 50 and sample['window']['server_failure_rate'] >= .5: reason = 'persistent_server_failure'
                        faults.extend(backlog_violations(samples))
                        bad_windows = bad_windows + 1 if faults else 0
                        if bad_windows >= 2 and first_unstable is None: first_unstable = time.time()
                        if '-soak' in label and bad_windows >= 2: reason = 'soak_sla_breach'
                        print(json.dumps({'trial': label, 'target': target, 'elapsed': int(time.time() - wall_start), 'rps': round(sample['window']['rps'], 2), 'violations': faults}), flush=True)
                        last_window = now
                except (subprocess.SubprocessError, OSError, ValueError, RuntimeError):
                    collection_errors += 1
                    ssh_errors, reason = collection_failure(remote, collection_errors, ssh_errors)
                    with (folder / 'collection-errors.jsonl').open('a') as errors:
                        errors.write(json.dumps({'time': time.time(), 'collection_errors': collection_errors, 'ssh_errors': ssh_errors, 'stop_reason': reason}) + '\n')
                if reason:
                    stop_k6(child)
                    break
            child.wait()
        if reason is None and tunnel.poll() is not None: reason = 'private_tunnel_exited'
        metrics.update(raw)
        summary = summarize(full_metrics(raw)) if raw.exists() else {}
        summary.update(scenario=scenario, target=target, limits=limits, label=label, duration=1 if scenario.startswith('burst') else seconds, wall_seconds=time.time() - wall_start, stop_reason=reason, exit_code=child.returncode)
        summary['tunnel_exit_code'] = tunnel.poll()
        source = Path(__file__).parent
        summary['harness_sha256'] = hashlib.sha256(b''.join((source / name).read_bytes() for name in ('run.py', 'load.js', 'retry-delay.mjs', 'remote.py', 'client.py', 'tunnel.py', 'resources.py', 'requirements.txt'))).hexdigest()
        summary['backend_revision'] = remote.config['expected_revision']
        summary['source_run'] = remote.state.name
        summary['fixture_users'] = len(dataset['users']); summary['fixture_banks'] = len(dataset['banks'])
        summary['observed_seconds'] = max(1, time.time() - wall_start - (30 if scenario.startswith('burst') else 0))
        events = list(read_events(folder / 'events.jsonl'))
        ledger = [x for x in events if x.get('event') == 'accepted']
        accepted_ids = {x['id'] for x in ledger}
        intents = {x['id']: {'id': x['id'], 'sequence': x['body']['clientSequence'], 'items': x['body']['items'],
                             'client_accepted': x['id'] in accepted_ids} for x in events if x.get('event') == 'intent'}
        for value in ledger: intents.setdefault(value['id'], value)
        recovery_started = time.monotonic(); summary['database'], summary['audit'] = audit_after_drain(remote, list(intents.values()), folder)
        summary['database_before'] = database_before
        summary['new_commands'] = sum(summary['database']['commands'].values()) - sum(database_before['commands'].values())
        summary['recovery_seconds'] = time.monotonic() - recovery_started
        summary['recovery_includes_readiness'] = True
        if not summary['database']['recovered'] and reason is None:
            reason = 'recovery_timeout'; summary['stop_reason'] = reason
        audit = summary['audit']; summary['unobserved_registrations'] = summary['new_commands'] - len(accepted_ids)
        summary['unverified_registrations'] = summary['new_commands'] - audit['registered']
        summary['integrity_passed'] = audit['accepted'] == audit['committed'] and not any(audit[k] for k in ('missing', 'pending', 'rejected', 'answer_mismatches', 'result_mismatches')) and summary['database']['committed_without_receipt'] == 0 and summary['unverified_registrations'] == 0
        starts = [x['time'] for x in events if x.get('event') == 'burst_start']
        if starts:
            summary['burst_start_spread_ms'] = max(starts) - min(starts); summary['burst_started'] = len(starts)
            changes = [(x / 1000, 1) for x in starts] + [(stamp, -int(value)) for stamp, metric, value, _ in full_metrics(raw) if metric == 'http_reqs']
            peak, current = 0, 0
            for _, delta in sorted(changes): current += delta; peak = max(peak, current)
            summary['burst_inflight_peak'] = peak
            summary['burst_schedule_valid'] = len(starts) == target and summary['burst_start_spread_ms'] <= 1250
        summary['violations'] = violations(summary)
        active_samples = [s for s in samples if s['observed_at'] <= load_start + seconds + (60 if scenario == 'journey' else 0)]
        if not scenario.startswith('burst') and len(active_samples) >= 13:
            summary['violations'].extend(backlog_violations(active_samples))
        summary['first_unstable_time'] = first_unstable
        summary['unstable_windows'] = sum(bool(violations(s['window'])) for s in samples if s['window']['elapsed'] >= 50)
        summary['stable'] = not reason and first_unstable is None and child.returncode == 0 and not summary['violations'] and summary['integrity_passed'] and summary['database']['recovered'] and summary.get('dropped_iterations', 0) == 0 and summary.get('burst_schedule_valid', True)
        private_json(folder / 'result.json', summary)
        if raw.exists():
            with raw.open('rb') as src, gzip.open(str(raw) + '.gz', 'wb', compresslevel=1) as dst:
                while True:
                    chunk = src.read(1024 ** 2)
                    if not chunk: break
                    dst.write(chunk)
            raw.unlink()
        print(json.dumps({'completed_trial': label, 'stable': summary['stable'], 'rps': summary.get('rps'), 'reason': reason, 'integrity': summary['integrity_passed']}), flush=True)
        return summary
    finally:
        stop_k6(child)
        tunnel.terminate(); tunnel.wait(timeout=10)


def suite(remote, start_users=50):
    if start_users < 1: raise ValueError('The initial active-user load must be positive')
    all_results = []
    for scenario in ('journey', 'read', 'create', 'sync', 'finish', 'burst_create', 'burst_finish'):
        target = start_users if scenario == 'journey' else 100 if scenario.startswith('burst') else 10
        active = {'on': True, 'off': True}; stable = {'on': None, 'off': None}; first_bad = {'on': None, 'off': None}; previous = {}; stagnation = collections.Counter()
        while any(active.values()):
            for policy in ('on', 'off'):
                if not active[policy]: continue
                result = trial(remote, scenario, target, policy, 600 if scenario == 'journey' else 180, f'{scenario}-{policy}-{target}')
                all_results.append(result); private_json(remote.state / 'results.json', all_results)
                if result['stable']: stable[policy] = target
                elif first_bad[policy] is None: first_bad[policy] = target
                if not result['integrity_passed']: raise RuntimeError('Persistence audit failed; preserve evidence and recover before continuing')
                limited = result.get('limited', 0) / max(1, result.get('http', 0))
                old = previous.get(policy)
                if old and result.get('rps', 0) <= old.get('rps', 0) * 1.05 and not result['stable']: stagnation[policy] += 1
                else: stagnation[policy] = 0
                previous[policy] = result
                if result['stop_reason'] or (policy == 'on' and limited > .5) or result.get('server_failure_rate', 0) >= .5 or stagnation[policy] >= 2 or result.get('dropped_iterations', 0) > 0:
                    result['suite_stop'] = result['stop_reason'] or ('rate_limit_gate' if policy == 'on' and limited > .5 else 'arrival_slots_exhausted' if result.get('dropped_iterations', 0) > 0 else 'throughput_stagnation')
                    private_json(remote.state / 'trials' / result['label'] / 'result.json', result)
                    private_json(remote.state / 'results.json', all_results)
                    active[policy] = False
            target = next_target(target)
        for policy in ('on', 'off'):
            low, high = stable[policy], first_bad[policy]
            if low is None and high and high > 1:
                result = trial(remote, scenario, 1, policy, 600 if scenario == 'journey' else 180, f'{scenario}-{policy}-lower-bound')
                all_results.append(result); private_json(remote.state / 'results.json', all_results)
                if result['stable']: low = 1; stable[policy] = 1
            if low and high and high > low:
                attempt = 0
                while high / low > 1.1:
                    middle = (low + high) // 2
                    if middle == low: break
                    checks = [trial(remote, scenario, middle, policy, 600 if scenario == 'journey' else 180, f'{scenario}-{policy}-refine-{attempt}-{repeat}') for repeat in range(2)]
                    all_results.extend(checks); private_json(remote.state / 'results.json', all_results)
                    if all(x['stable'] for x in checks): low = middle
                    else: high = middle
                    attempt += 1
                stable[policy] = low
            for boundary in (stable[policy], first_bad[policy]):
                if boundary is None or scenario == 'journey' and boundary == stable[policy]: continue
                count = sum(x['scenario'] == scenario and x['limits'] == policy and x['target'] == boundary for x in all_results)
                for repeat in range(max(0, 2 - count)):
                    result = trial(remote, scenario, boundary, policy, 600 if scenario == 'journey' else 180, f'{scenario}-{policy}-boundary-{boundary}-{repeat}')
                    all_results.append(result); private_json(remote.state / 'results.json', all_results)
            if stable[policy] and scenario == 'journey':
                candidate = stable[policy]; attempt = 0
                while True:
                    result = trial(remote, scenario, candidate, policy, 1800, f'{scenario}-{policy}-soak-{attempt}')
                    all_results.append(result); private_json(remote.state / 'results.json', all_results)
                    if result['stable'] or candidate == 1: break
                    candidate = max(1, math.floor(candidate * .9)); attempt += 1
    return all_results


def next_target(current):
    return current * 2


def stop_requested(*_):
    raise KeyboardInterrupt('Capacity run interrupted; restoring project services')


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--state', required=True); p.add_argument('--scenario', choices=['read', 'create', 'sync', 'finish', 'journey', 'burst_create', 'burst_finish']); p.add_argument('--target', type=int, default=1); p.add_argument('--limits', choices=['on', 'off'], default='on'); p.add_argument('--seconds', type=int, default=30); p.add_argument('--restore', action='store_true'); p.add_argument('--start-users', type=int, default=50); args = p.parse_args()
    remote = Remote(args.state)
    signal.signal(signal.SIGTERM, stop_requested)
    complete = False
    try:
        with Lease(remote):
            if args.scenario:
                result = trial(remote, args.scenario, args.target, args.limits, args.seconds, 'validation-' + args.scenario + '-' + args.limits + '-' + str(int(time.time())))
                complete = result['integrity_passed']
            else:
                suite(remote, args.start_users); complete = True
    finally:
        private_json(remote.state / 'completion.json', {'suite_complete': complete and args.scenario is None})
        if args.restore:
            restored = remote.action('cleanup' if complete else 'restore'); private_json(remote.state / 'restoration.json', restored)
            print(json.dumps(restored), flush=True)
