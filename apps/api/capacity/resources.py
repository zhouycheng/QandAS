"""Reduce private Prometheus/cgroup samples to anonymous numeric evidence."""
import math
import re


def metrics(text):
    for line in text.splitlines():
        match = re.fullmatch(r'([a-zA-Z_:][a-zA-Z_0-9:]*)(?:\{(.*)\})?\s+([^ ]+)', line)
        if not match: continue
        value = float(match[3])
        if math.isfinite(value):
            yield match[1], dict(re.findall(r'(\w+)="([^"\\]*)"', match[2] or '')), value


def total(rows, name, **tags):
    return sum(value for metric, labels, value in rows if metric == name and all(labels.get(k) == v for k, v in tags.items()))


def series(samples):
    result = []; previous = None
    if not samples: return result
    for sample in samples:
        host = sample['host']; time = sample['observed_at']
        row = {'seconds': round(time - samples[0]['observed_at'], 2),
               'available_mib': host['available'] / 1024 ** 2, 'swap_mib': host['swap_used'] / 1024 ** 2,
               'disk_free_gib': host['disk_free'] / 1024 ** 3,
               'postgres_connections': sample.get('postgres', {}).get('connections'),
               'postgres_lock_waits': sample.get('postgres', {}).get('lock_waits'),
               'activity_pending': sample.get('postgres', {}).get('activity_pending'),
               'activity_oldest_seconds': sample.get('postgres', {}).get('activity_oldest_seconds'),
               'generator_cpu_percent': sample.get('generator', {}).get('cpu_percent'),
               'generator_rss_mib': sample.get('generator', {}).get('rss', 0) / 1024 ** 2,
               'successful_rps': sample['window'].get('successful_rps'),
               'http_rps': sample['window'].get('rps'), 'http_p95_ms': sample['window'].get('p95_ms'),
               'commit_p95_ms': sample['window'].get('commit_p95_ms')}
        dt = time - previous['observed_at'] if previous else 0
        if dt > 0:
            delta = [a - b for a, b in zip(host['cpu_ticks'][:8], previous['host']['cpu_ticks'][:8])]
            row['host_cpu_percent'] = 100 * (1 - (delta[3] + delta[4]) / max(1, sum(delta)))
            row['network_tx_mbps'] = sum(max(0, values[8] - previous['host']['network'].get(name, values)[8]) for name, values in host['network'].items()) * 8 / dt / 1e6
        for name, container in sample['containers'].items():
            role = next((x for x in ('api', 'worker', 'monitor', 'postgres', 'rabbitmq') if name == 'qanda-application-' + x + '-1' or x == 'postgres' and name.startswith('qanda-capacity-pg-') or x == 'rabbitmq' and name.startswith('qanda-capacity-rabbit-')), None)
            if not role: continue
            if 'memory' in container: row[role + '_memory_mib'] = container['memory'] / 1024 ** 2
            row[role + '_restarts'] = container['restarts']
            old = previous['containers'].get(name, {}) if previous else {}
            if dt > 0 and 'cpu' in container and 'cpu' in old:
                row[role + '_cpu_cores'] = max(0, int(container['cpu']['usage_usec']) - int(old['cpu']['usage_usec'])) / dt / 1e6
        for role in ('api', 'worker', 'monitor'):
            now = list(metrics(sample['application'].get('qanda-application-' + role + '-1', {}).get('metrics', '')))
            if not now: continue
            row[role + '_heap_mib'] = total(now, 'jvm_memory_used_bytes', area='heap') / 1024 ** 2
            row[role + '_pool_pending'] = total(now, 'hikaricp_connections_pending')
            row[role + '_pool_active'] = total(now, 'hikaricp_connections_active')
            row[role + '_pool_acquire_max_ms'] = total(now, 'hikaricp_connections_acquire_seconds_max') * 1000
            if dt > 0:
                old = list(metrics(previous['application'].get('qanda-application-' + role + '-1', {}).get('metrics', '')))
                row[role + '_gc_pause_percent'] = max(0, total(now, 'jvm_gc_pause_seconds_sum') - total(old, 'jvm_gc_pause_seconds_sum')) * 100 / dt
        rabbit = list(metrics(sample.get('rabbit', {}).get('metrics', '')))
        row['progress_queue'] = total(rabbit, 'rabbitmq_detailed_queue_messages', queue='qanda.sync.progress')
        row['dead_queue'] = total(rabbit, 'rabbitmq_detailed_queue_messages', queue='qanda.sync.dead')
        if dt > 0:
            old = list(metrics(previous.get('rabbit', {}).get('metrics', '')))
            for metric, label in [('rabbitmq_detailed_queue_exchange_messages_published_total', 'queue_published_per_second'), ('rabbitmq_detailed_queue_messages_acked_total', 'queue_acked_per_second')]:
                if any(name == metric for name, _, _ in rabbit):
                    row[label] = max(0, total(rabbit, metric, queue='qanda.sync.progress') - total(old, metric, queue='qanda.sync.progress')) / dt
        result.append({key: round(value, 4) if isinstance(value, float) else value for key, value in row.items()})
        previous = sample
    return result


def server_p95(samples):
    if len(samples) < 2: return None
    def buckets(sample):
        values = {}
        for name, tags, value in metrics(sample['application'].get('qanda-application-api-1', {}).get('metrics', '')):
            if name != 'http_server_requests_seconds_bucket' or not tags.get('uri', '').startswith('/api/v1/') or tags['uri'].endswith('/health'): continue
            bound = float(tags['le']); values[bound] = values.get(bound, 0) + value
        return values
    before, after = buckets(samples[0]), buckets(samples[-1])
    delta = {bound: max(0, count - before.get(bound, 0)) for bound, count in after.items()}
    count = delta.get(float('inf'), max(delta.values(), default=0))
    if not count: return None
    return next((bound * 1000 for bound in sorted(delta) if delta[bound] >= count * .95 and math.isfinite(bound)), None)
