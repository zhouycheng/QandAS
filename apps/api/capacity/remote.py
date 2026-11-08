"""Root-only lifecycle and measurements for an isolated capacity run."""
import argparse
import base64
import concurrent.futures
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import resource
import secrets
import subprocess
import sys
import time
import uuid

APP = ['qanda-application-' + role + '-1' for role in ('api', 'worker', 'monitor')]
ORIGINAL = ['qanda-infrastructure-postgres-1', 'qanda-infrastructure-rabbitmq-1']


def command(args, data=None, timeout=300):
    result = subprocess.run([str(x) for x in args], input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        # Docker errors can include interpolated configuration; retain them privately.
        with (ROOT / 'commands.log').open('ab') as log:
            log.write(result.stdout + result.stderr)
        raise RuntimeError('Remote command failed: ' + str(args[0]))
    return result.stdout


def inspect(names):
    return json.loads(command(['docker', 'inspect', *names]))


def save(path, value):
    path.write_text(json.dumps(value)); path.chmod(0o600)


def manifest():
    return json.loads((ROOT / 'manifest.json').read_text())


def assert_capacity():
    m = manifest()
    assert not (ROOT / 'restored').exists(), 'The run was restored; use a new run identifier'
    assert all(not x['State']['Running'] for x in inspect(ORIGINAL)), 'Original infrastructure must remain stopped during the experiment'
    assert all(x['State']['Running'] and x['Config']['Labels'].get('qanda.capacity.run') == RUN for x in inspect([m['postgres'], m['rabbit']])), 'Temporary infrastructure ownership or state mismatch'


def tunnel():
    assert_capacity()
    pid = os.getppid()
    for _ in range(8):
        if pid <= 1: break
        proc = Path('/proc') / str(pid)
        if (proc / 'comm').read_text().strip() in ('sshd', 'sshd-session'):
            soft, hard = resource.prlimit(pid, resource.RLIMIT_NOFILE)
            if hard != resource.RLIM_INFINITY and hard < 32768:
                raise RuntimeError('The private SSH session has insufficient file capacity')
            # Only this test connection changes; daemon defaults and other sessions keep their limits.
            effective = soft if soft == resource.RLIM_INFINITY else max(soft, 32768)
            resource.prlimit(pid, resource.RLIMIT_NOFILE, (effective, hard))
            return {'tunnel_ready': True, 'nofile_soft': effective, 'previous_soft': soft}
        pid = int(next(line.split()[1] for line in (proc / 'status').read_text().splitlines() if line.startswith('PPid:')))
    raise RuntimeError('A dedicated SSH session is required for the private tunnel')


def compose_args(*args, overlay=True):
    if overlay and args[0] != 'stop': assert_capacity()
    m = manifest()
    env = {**os.environ, 'BACKEND_IMAGE': m['image'], 'WEB_IMAGE': 'scratch', 'REVISION': m['revision']}
    base = ['docker', 'compose', '-p', 'qanda-application', '--env-file', '/srv/qanda/production.env', '--env-file', '/srv/qanda/node.env', '-f', '/srv/qanda/compose.application.yml']
    if overlay:
        base += ['-f', str(ROOT / 'override.json')]
    return base + list(args), env


def compose(*args, overlay=True):
    base, env = compose_args(*args, overlay=overlay)
    result = subprocess.run(base, env=env, capture_output=True, timeout=360)
    with (ROOT / 'commands.log').open('ab') as log:
        log.write(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError('Capacity compose failed; private commands.log contains diagnostics')
    return result.stdout


def bootstrap():
    args, env = compose_args('run', '--rm', '--no-deps', '-it', 'api', 'bootstrap')
    subprocess.run(args, env=env, check=True, timeout=120)
    return {'bootstrap': True}


def sql(query):
    return command(['docker', 'exec', manifest()['postgres'], 'psql', '-U', 'qanda_backend', '-d', 'qanda_backend', '-Atqc', query]).decode().strip()


def wait_infra(pg, rabbit):
    for _ in range(90):
        a = subprocess.run(['docker', 'exec', pg, 'pg_isready', '-U', 'qanda_backend'], capture_output=True)
        b = subprocess.run(['docker', 'exec', rabbit, 'rabbitmq-diagnostics', '-q', 'check_running'], capture_output=True)
        if a.returncode == b.returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError('Infrastructure readiness timeout')


def broker(reset=False):
    m = manifest(); base = ['docker', 'exec', m['rabbit'], 'rabbitmqctl']
    if reset:
        command(base + ['delete_vhost', m['vhost']])
    command(base + ['add_vhost', m['vhost']])
    command(base + ['set_permissions', '-p', m['vhost'], 'qanda', '.*', '.*', '.*'])


def mode(enabled):
    value = json.loads((ROOT / 'override.json').read_text())
    for service in value['services'].values():
        service['environment']['BACKEND_REQUEST_LIMITS_ENABLED'] = str(enabled).lower()
    save(ROOT / 'override.json', value)
    compose('up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '240', 'api', 'worker', 'monitor')


def prepare():
    if (ROOT / 'manifest.json').exists():
        raise RuntimeError('A run already exists; inspect or restore it before preparing again')
    state = json.loads(Path('/var/lib/qanda-deploy/current.json').read_text())
    assert json.loads(Path('/srv/qanda/node.json').read_text())['role'] == 'backend'
    old = inspect(APP + ORIGINAL)
    assert all(x['State']['Running'] for x in old), 'Original services must be running'
    m = {'run': RUN, 'image': old[0]['Config']['Image'], 'revision': state['revision'],
         'original_ids': {x['Name'].lstrip('/'): x['Id'] for x in old},
         'postgres': 'qanda-capacity-pg-' + RUN, 'rabbit': 'qanda-capacity-rabbit-' + RUN,
         'vhost': 'qanda-capacity-' + RUN,
         'volumes': ['qanda-capacity-' + RUN + '-' + role for role in ('pg', 'rabbit')],
         'env_sha256': hashlib.sha256(Path('/srv/qanda/production.env').read_bytes()).hexdigest(),
         'backup_timer': subprocess.run(['systemctl', 'is-active', '--quiet', 'qanda-backup.timer']).returncode == 0}
    assert len({x['Image'] for x in old[:3]}) == 1, 'Application image mismatch'
    save(ROOT / 'manifest.json', m)
    command(['systemd-run', '--unit=qanda-capacity-guard-' + RUN, '--on-active=60s', '--on-unit-active=60s', '/usr/bin/python3', ROOT / 'remote.py', 'lease', '--run', RUN])
    command(['tar', '-cpf', ROOT / 'original-config.tar', '-C', '/srv/qanda', 'production.env', 'node.env', 'node.json', 'compose.application.yml'])
    if m['backup_timer']:
        command(['systemctl', 'stop', 'qanda-backup.timer'])
    command(['docker', 'stop', '-t', '120', *APP])
    command(['docker', 'stop', '-t', '90', *ORIGINAL])
    for row, name, volume, role in zip(old[3:], [m['postgres'], m['rabbit']], m['volumes'], ['pg', 'rabbit']):
        envfile = ROOT / (role + '.env')
        envfile.write_text('\n'.join(row['Config']['Env']) + '\n'); envfile.chmod(0o600)
        command(['docker', 'volume', 'create', '--label', 'qanda.capacity.run=' + RUN, volume])
        args = ['docker', 'run', '-d', '--name', name, '--label', 'qanda.capacity.run=' + RUN,
                '--network', 'qanda-data', '--network-alias', 'qanda-postgres' if role == 'pg' else 'qanda-rabbitmq',
                '--memory', str(row['HostConfig']['Memory']), '--memory-swap', str(row['HostConfig']['MemorySwap']),
                '--restart', 'unless-stopped', '--env-file', envfile, '-v', volume + (':/var/lib/postgresql/data' if role == 'pg' else ':/var/lib/rabbitmq')]
        if role == 'rabbit':
            args += ['-v', '/srv/qanda/rabbitmq-plugins:/etc/rabbitmq/enabled_plugins:ro']
        command(args + [row['Config']['Image']])
    wait_infra(m['postgres'], m['rabbit']); broker()
    settings = {'BACKEND_REQUEST_LIMITS_ENABLED': 'false', 'SPRING_RABBITMQ_VIRTUAL_HOST': m['vhost'],
                'SERVER_TOMCAT_MBEANREGISTRY_ENABLED': 'true',
                'BACKEND_MAIL_DISPATCH_ENABLED': 'false',
                'BACKEND_TEST_ACCOUNT_ENCRYPTION_KEYS': '1:' + base64.b64encode(secrets.token_bytes(32)).decode(),
                'BACKEND_TEST_ACCOUNT_ENCRYPTION_ACTIVE_VERSION': '1'}
    save(ROOT / 'override.json', {'services': {role: {'environment': settings.copy()} for role in ('api', 'worker', 'monitor', 'schema-init')}})
    compose('run', '--rm', '--no-deps', 'schema-init')
    mode(False)
    return {'prepared': True, 'revision': m['revision'], 'original_data_retained': True}


def snapshot():
    compose('stop', 'api', 'worker', 'monitor')
    data = command(['docker', 'exec', manifest()['postgres'], 'pg_dump', '-U', 'qanda_backend', '-Fc', 'qanda_backend'])
    (ROOT / 'seed.dump').write_bytes(data); (ROOT / 'seed.dump').chmod(0o600)
    return {'snapshot_bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def reset(enabled):
    assert_capacity()
    m = manifest(); compose('stop', 'api', 'worker', 'monitor')
    command(['docker', 'exec', m['postgres'], 'dropdb', '-U', 'qanda_backend', '--force', 'qanda_backend'])
    command(['docker', 'exec', m['postgres'], 'createdb', '-U', 'qanda_backend', 'qanda_backend'])
    seed = (ROOT / 'seed.dump').read_bytes()
    command(['docker', 'exec', '-i', m['postgres'], 'pg_restore', '-U', 'qanda_backend', '-d', 'qanda_backend', '--exit-on-error'], seed)
    compose('run', '--rm', '--no-deps', 'schema-init')
    sql('ANALYZE')
    broker(True); mode(enabled)
    return {'reset': True, 'limits': enabled, 'seed_sha256': hashlib.sha256(seed).hexdigest()}


def fetch(row, port, path):
    try:
        addresses = row['NetworkSettings']['Networks']
        ip = next(value['IPAddress'] for value in addresses.values() if value.get('IPAddress'))
        c = http.client.HTTPConnection(ip, port, timeout=0.8); c.request('GET', path)
        r = c.getresponse(); data = r.read().decode(); c.close()
        return r.status, data
    except Exception:
        return 0, ''


def collect():
    m = manifest(); rows = inspect(APP + [m['postgres'], m['rabbit'], 'qanda-infrastructure-prometheus-1', 'qanda-tailnet', 'qanda-tailnet-gateway-1'])
    mem = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()}
    disk = os.statvfs('/var/lib/docker')
    result = {'time': time.time(), 'host': {'available': mem['MemAvailable'], 'total': mem['MemTotal'], 'swap_used': mem['SwapTotal'] - mem['SwapFree'], 'disk_free': disk.f_bavail * disk.f_frsize, 'load': os.getloadavg()}, 'containers': {}}
    result['host']['cpu_ticks'] = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:]]
    result['host']['network'] = {line.split(':')[0].strip(): [int(x) for x in line.split(':')[1].split()] for line in Path('/proc/net/dev').read_text().splitlines()[2:] if line.split(':')[0].strip() in ('eth0', 'ens3')}
    result['host']['sshd'] = command(['ps', '-C', 'sshd', '-o', 'pid=,pcpu=,rss=']).decode().strip()
    for row in rows:
        item = {'running': row['State']['Running'], 'oom': row['State']['OOMKilled'], 'restarts': row['RestartCount'], 'limit': row['HostConfig']['Memory'], 'health': row['State'].get('Health', {}).get('Status')}
        probes = row['State'].get('Health', {}).get('Log', [])
        item['probe_ok'] = not probes or probes[-1]['ExitCode'] == 0
        pid = row['State']['Pid']
        if pid:
            try:
                cg = next(line.split(':', 2)[2] for line in Path('/proc/' + str(pid) + '/cgroup').read_text().splitlines() if line.startswith('0::'))
                base = Path('/sys/fs/cgroup') / cg.lstrip('/')
                item['memory'] = int((base / 'memory.current').read_text())
                item['cpu'] = dict(line.split() for line in (base / 'cpu.stat').read_text().splitlines())
                item['memory_events'] = dict(line.split() for line in (base / 'memory.events').read_text().splitlines())
            except (OSError, StopIteration):
                pass
        result['containers'][row['Name'].lstrip('/')] = item
    def metrics(row):
        status, data = fetch(row, 9091, '/actuator/prometheus')
        ready, _ = fetch(row, 9091, '/actuator/health/readiness')
        result['containers'][row['Name'].lstrip('/')]['probe_ok'] = ready == 200
        keep = ('http_server_requests_', 'hikaricp_', 'jvm_gc_', 'jvm_memory_', 'process_cpu_', 'tomcat_threads_', 'qanda_http_')
        return row['Name'].lstrip('/'), {'status': status, 'metrics': '\n'.join(line for line in data.splitlines() if line.startswith(keep))}
    with concurrent.futures.ThreadPoolExecutor(3) as pool:
        result['application'] = dict(pool.map(metrics, rows[:3]))
    status, data = fetch(rows[4], 15692, '/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count&family=queue_delivery_metrics&family=queue_exchange_metrics')
    result['rabbit'] = {'status': status, 'metrics': '\n'.join(line for line in data.splitlines() if ('vhost="' + m['vhost'] + '"') in line)}
    try:
        query = "SELECT json_build_object('connections',(SELECT count(*) FROM pg_stat_activity),'active',(SELECT count(*) FROM pg_stat_activity WHERE state='active'),'lock_waits',(SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock'),'activity_pending',(SELECT count(*) FROM domain_event_outbox WHERE processed_at IS NULL),'activity_oldest_seconds',(SELECT coalesce(extract(epoch FROM now()-min(occurred_at)),0) FROM domain_event_outbox WHERE processed_at IS NULL))"
        raw = command(['docker', 'exec', '-e', 'PGOPTIONS=-c statement_timeout=500', m['postgres'], 'psql', '-U', 'qanda_backend', '-d', 'qanda_backend', '-Atqc', query], timeout=2)
        result['postgres'] = json.loads(raw)
    except (subprocess.SubprocessError, RuntimeError, ValueError):
        result['postgres'] = {'metrics_unavailable': True}
    return result


def verify():
    return json.loads(sql("""SELECT json_build_object('commands',(SELECT coalesce(json_object_agg(state,n),'{}') FROM (SELECT state,count(*) n FROM sync_command GROUP BY state) c),'committed_without_receipt',(SELECT count(*) FROM sync_command WHERE state='COMMITTED' AND receipt_id IS NULL),'results',(SELECT count(*) FROM practice_result),'users',(SELECT count(*) FROM test_account),'questions',(SELECT count(*) FROM question),'activity_pending',(SELECT count(*) FROM domain_event_outbox WHERE processed_at IS NULL))"""))


def audit():
    ledger = json.load(sys.stdin)
    ids = sorted({str(uuid.UUID(x['id'])) for x in ledger})
    client_ids = {str(uuid.UUID(x['id'])) for x in ledger if x.get('client_accepted', True)}
    states = {}
    for start in range(0, len(ids), 500):
        values = ','.join("'" + value + "'::uuid" for value in ids[start:start + 500])
        states.update(json.loads(sql("SELECT coalesce(json_object_agg(id,state),'{}') FROM sync_command WHERE id IN (" + values + ")")))
    answers = {}
    for record in sorted(ledger, key=lambda x: x['sequence']):
        if states.get(str(uuid.UUID(record['id']))) != 'COMMITTED': continue
        for item in record['items']:
            answers[str(uuid.UUID(item['itemId']))] = {'id': str(uuid.UUID(item['itemId'])), 'answer': item['answer'], 'confirmed': item.get('confirmed', False), 'marked': item.get('marked', False)}
    totals = {'accepted': len(set(states) | client_ids), 'registered': len(states), 'client_accepted': len(client_ids),
              'committed': sum(value == 'COMMITTED' for value in states.values()), 'missing': len(client_ids - set(states)),
              'pending': sum(value in ('ACCEPTING', 'QUEUED', 'RETRYING') for value in states.values()),
              'rejected': sum(value in ('REJECTED', 'DEAD_LETTER') for value in states.values()), 'answer_mismatches': 0}
    expected = list(answers.values())
    for start in range(0, len(expected), 500):
        value = json.dumps(expected[start:start + 500], ensure_ascii=False).replace("'", "''")
        query = """SELECT count(*) FROM jsonb_to_recordset('%s'::jsonb) e(id uuid,answer jsonb,confirmed boolean,marked boolean) LEFT JOIN practice_item p ON p.id=e.id
            WHERE p.id IS NULL OR p.confirmed IS DISTINCT FROM e.confirmed OR p.marked IS DISTINCT FROM e.marked
            OR (e.answer ? 'text' AND p.answer_text IS DISTINCT FROM e.answer->>'text')
            OR (e.answer ? 'value' AND p.answer_boolean IS DISTINCT FROM (e.answer->>'value')::boolean)
            OR (e.answer ? 'blanks' AND p.answer_blanks::jsonb IS DISTINCT FROM e.answer->'blanks')
            OR (e.answer ? 'optionKeys' AND (SELECT jsonb_agg(option_key ORDER BY option_key) FROM practice_item_choice WHERE item_id=p.id) IS DISTINCT FROM e.answer->'optionKeys')""" % value
        totals['answer_mismatches'] += int(sql(query))
    totals['result_mismatches'] = int(sql("""SELECT count(*) FROM practice_session s LEFT JOIN practice_result r ON r.session_id=s.id
        WHERE s.status='SUBMITTED' AND (r.id IS NULL OR r.answered_count<>r.total_count OR r.wrong_count<>0 OR r.unanswered_count<>0
        OR r.total_count<>(SELECT count(*) FROM practice_item p WHERE p.session_id=s.id)
        OR r.correct_count<>(SELECT count(*) FROM practice_item p WHERE p.session_id=s.id AND p.outcome='CORRECT')
        OR r.short_answer_count<>(SELECT count(*) FROM practice_item p WHERE p.session_id=s.id AND p.outcome='SELF_RATED'))"""))
    return totals


def restore(clean=False):
    m = manifest()
    assert json.loads(Path('/var/lib/qanda-deploy/current.json').read_text())['revision'] == m['revision'], 'Deployment revision changed; preserve the newer release for review'
    assert hashlib.sha256(Path('/srv/qanda/production.env').read_bytes()).hexdigest() == m['env_sha256'], 'Original configuration changed; preserve it for review'
    command(['docker', 'stop', '-t', '120', *APP])
    for name in [m['postgres'], m['rabbit']]:
        row = subprocess.run(['docker', 'inspect', name], capture_output=True)
        if row.returncode == 0:
            value = json.loads(row.stdout)[0]
            assert value['Config']['Labels'].get('qanda.capacity.run') == RUN
            command(['docker', 'stop', '-t', '60', name])
    command(['docker', 'start', *ORIGINAL]); wait_infra(*ORIGINAL)
    assert all(m['original_ids'][row['Name'].lstrip('/')] == row['Id'] for row in inspect(ORIGINAL)), 'Original infrastructure identity changed'
    compose('up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '240', 'api', 'worker', 'monitor', overlay=False)
    if m['backup_timer']:
        command(['systemctl', 'start', 'qanda-backup.timer'])
    subprocess.run(['systemctl', 'stop', 'qanda-capacity-guard-' + RUN + '.timer'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (ROOT / 'restored').touch()
    if clean:
        for name in [m['postgres'], m['rabbit']]:
            found = subprocess.run(['docker', 'inspect', name], capture_output=True)
            if found.returncode == 0:
                assert json.loads(found.stdout)[0]['Config']['Labels'].get('qanda.capacity.run') == RUN
                command(['docker', 'rm', name])
        for volume in m['volumes']:
            found = subprocess.run(['docker', 'volume', 'inspect', volume], capture_output=True)
            if found.returncode == 0:
                info = json.loads(found.stdout)[0]
                assert info['Labels'].get('qanda.capacity.run') == RUN
                command(['docker', 'volume', 'rm', volume])
        for private in ('seed.dump', 'pg.env', 'rabbit.env', 'override.json', 'original-config.tar'):
            (ROOT / private).unlink(missing_ok=True)
    return {'restored': True, 'temporary_data_cleaned': clean, 'revision': m['revision']}


def lease():
    if not (ROOT / 'manifest.json').exists() or (ROOT / 'restored').exists(): return {'inactive': True}
    if time.time() - (ROOT / 'heartbeat').stat().st_mtime < 300: return {'alive': True}
    with (ROOT / 'operation.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return {'busy': True}
        return restore()


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('action', choices=['prepare', 'bootstrap', 'heartbeat', 'lease', 'collect', 'addresses', 'tunnel', 'snapshot', 'reset', 'mode', 'verify', 'audit', 'restore', 'cleanup']); p.add_argument('--run', required=True); p.add_argument('--limits', choices=['on', 'off'], default='on')
    args = p.parse_args(); RUN = args.run
    assert os.geteuid() == 0 and re.fullmatch(r'[0-9]{8}(?:-[a-z0-9]+)?', RUN)
    ROOT = Path('/var/lib/qanda-capacity') / RUN; ROOT.mkdir(parents=True, mode=0o700, exist_ok=True); ROOT.chmod(0o700)
    if args.action != 'lease': (ROOT / 'heartbeat').touch()
    if args.action == 'heartbeat': print(json.dumps({'alive': True}))
    elif args.action == 'lease': print(json.dumps(lease()))
    elif args.action == 'addresses':
        row = inspect([APP[0]])[0]; print(json.dumps({'api': row['NetworkSettings']['Networks']['qanda-application']['IPAddress']}))
    else:
        calls = {'prepare': prepare, 'bootstrap': bootstrap, 'collect': collect, 'tunnel': tunnel, 'snapshot': snapshot, 'reset': lambda: reset(args.limits == 'on'), 'mode': lambda: mode(args.limits == 'on'), 'verify': verify, 'audit': audit, 'restore': restore, 'cleanup': lambda: restore(True)}
        if args.action in ('collect', 'verify', 'audit', 'tunnel'):
            print(json.dumps(calls[args.action]()))
        else:
            with (ROOT / 'operation.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                print(json.dumps(calls[args.action]()))
