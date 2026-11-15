"""Measure writer sockets in disposable Docker services with production memory quotas."""
import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import ssl
import select
import subprocess
import sys
import threading
import time
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True)
    parser.add_argument('--k6', required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--users', nargs='+', type=int, choices=(200,1800,2000), default=[200,1800,2000])
    args = parser.parse_args()
    state = args.state.resolve()
    state.mkdir(mode=0o700, parents=True, exist_ok=False)
    prefix = 'qanda-writer-' + uuid.uuid4().hex[:10]
    names, samples = [], []
    tunnel = None
    process = None
    stop = threading.Event()
    def docker(*command, data=None):
        result = subprocess.run(['colima', 'ssh', '--', 'sudo', 'docker', *command], input=data, text=True, capture_output=True, timeout=120)
        if result.returncode:
            (state / 'docker-error.log').write_text(result.stderr)
            raise RuntimeError('Isolated Docker command failed; inspect the private run directory')
        return result.stdout.strip()
    def start(kind, image, *options, command=()):
        name = prefix + '-' + kind
        names.append(name)
        docker('run', '-d', '--name', name, '--network', prefix, '--cpus', '4', *options, image, *command)
        return name
    def sql(text):
        return docker('exec', '-i', prefix + '-db', 'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'qanda_backend', '-d', 'qanda_backend', data=text)
    def sample():
        while not stop.wait(5):
            try:
                samples.append({'at': time.time(), 'containers': [json.loads(line) for line in docker('stats', '--no-stream', '--format', '{{json .}}', *names).splitlines()]})
                metrics = docker('exec', prefix + '-api', 'curl', '-s', '--max-time', '3', 'http://127.0.0.1:9091/actuator/prometheus')
                samples[-1]['jvm'] = [line for line in metrics.splitlines() if line.startswith(('jvm_memory_used_bytes', 'jvm_memory_committed_bytes', 'jvm_buffer_memory_used_bytes', 'jvm_threads_live_threads', 'qanda_practice_socket_connections'))]
                if any(not json.loads(line)['Running'] for line in docker('inspect', '--format', '{{json .State}}', *names).splitlines()): stop.set()
            except Exception:
                stop.set()
    docker('network', 'create', prefix)
    try:
        sources = subprocess.check_output(['git', 'ls-files', 'apps/api/src/main', 'apps/api/pom.xml', 'apps/api/Dockerfile'], text=True).splitlines()
        digest = hashlib.sha256()
        for source in sorted(sources): digest.update(source.encode() + b'\0' + Path(source).read_bytes() + b'\0')
        metadata = {'base_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'runtime_source_sha256': digest.hexdigest(),
                    'image_id': docker('image', 'inspect', '--format', '{{.Id}}', args.image), 'architecture': docker('image', 'inspect', '--format', '{{.Architecture}}', args.image),
                    'jar_sha256': hashlib.sha256(Path('apps/api/target/qanda-backend-1.0.0.jar').read_bytes()).hexdigest(),
                    'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'load_sha256': hashlib.sha256(Path(__file__).with_name('writer-sockets.js').read_bytes()).hexdigest()}
        gateway_image = 'nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236'
        metadata['gateway_image_id'] = docker('image', 'inspect', '--format', '{{.Id}}', gateway_image)
        metadata['gateway_architecture'] = docker('image', 'inspect', '--format', '{{.Architecture}}', gateway_image)
        gateway_sources = [Path('deploy') / name for name in ('public-gateway-nginx.conf','public-gateway.conf','public-gateway-routes.inc','public-gateway-https.conf')]
        metadata['gateway_source_sha256'] = hashlib.sha256(b''.join(f.read_bytes() for f in gateway_sources)).hexdigest()
        metadata['transport'] = 'HTTPS/WSS via project gateway; isolated certificate'
        (state/'metadata.json').write_text(json.dumps(metadata))
        key = base64.b64encode(secrets.token_bytes(32)).decode()
        env = {'BACKEND_MODE': 'test', 'BACKEND_LOCAL_CONTAINER': 'true', 'BACKEND_BIND_ADDRESS': '0.0.0.0',
               'BACKEND_DB_URL': f'jdbc:postgresql://{prefix}-db:5432/qanda_backend', 'BACKEND_DB_USER': 'qanda_backend',
               'BACKEND_DB_PASSWORD': 'isolated-writer-password', 'BACKEND_RABBIT_HOST': prefix + '-rabbit',
               'BACKEND_RABBIT_USER': 'qanda', 'BACKEND_RABBIT_PASSWORD': 'isolated-writer-queue',
               'BACKEND_WECHAT_PROVIDER': 'local', 'BACKEND_CONTENT_SAFETY_PROVIDER': 'local',
               'BACKEND_IDENTITY_RATE_KEY': key, 'BACKEND_DB_POOL_SIZE': '4', 'BACKEND_CONTENT_CACHE_ENABLED': 'false',
               **{f'BACKEND_{kind}_KEYS': '1:' + key for kind in ('COMMAND_DIGEST', 'IDENTITY_MAC', 'MAIL_ENCRYPTION', 'TEST_ACCOUNT_ENCRYPTION')}}
        path = state / 'test.env'
        path.write_text(''.join(f'{k}={v}\n' for k, v in env.items())); path.chmod(0o600)
        start('db', 'postgres:17.6-alpine', '--memory', '256m', '-e', 'POSTGRES_DB=qanda_backend', '-e', 'POSTGRES_USER=qanda_backend', '-e', 'POSTGRES_PASSWORD=isolated-writer-password')
        start('rabbit', 'rabbitmq:4.2.5-management', '--memory', '384m', '-e', 'RABBITMQ_DEFAULT_USER=qanda', '-e', 'RABBITMQ_DEFAULT_PASS=isolated-writer-queue', '-e', 'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2')
        for _ in range(90):
            try:
                sql('SELECT 1;'); docker('exec', prefix + '-rabbit', 'rabbitmq-diagnostics', '-q', 'ping'); break
            except RuntimeError: time.sleep(1)
        else: raise RuntimeError('Dependencies did not become ready')
        docker('run', '--rm', '--network', prefix, '--env-file', str(path), args.image, 'schema-init')
        admin, subject, bank = [str(uuid.uuid4()) for _ in range(3)]
        sql(f"INSERT INTO admin_account(id,username,name,password_hash,role,status) VALUES('{admin}','writer_capacity','容量测试','unused','SUPER_ADMIN','ACTIVE');"
            f"INSERT INTO subject(id,name,status) VALUES('{subject}','连接容量测试','ACTIVE');"
            f"INSERT INTO question_bank(id,subject_id,name,status,created_by) VALUES('{bank}','{subject}','隔离连接测试','ACTIVE','{admin}');")
        fixture, statements = [], []
        for i in range(2000):
            user, session, device, practice, writer = [str(uuid.uuid4()) for _ in range(5)]
            token = 'u_' + secrets.token_urlsafe(32)
            other_device, other_session, other_token = str(uuid.uuid4()), str(uuid.uuid4()), 'u_' + secrets.token_urlsafe(32)
            fixture.append({'token': token, 'device': device, 'practice': practice, 'writer': writer, 'otherDevice': other_device, 'otherToken': other_token})
            statements.extend([
                f"INSERT INTO user_account(id,account_code,nickname) VALUES('{user}','WS{i:010}','容量测试');",
                f"INSERT INTO user_session(id,user_id,token_digest,credential_version,device_id,auth_method,issued_at,expires_at,last_seen_at) VALUES('{session}','{user}',decode('{hashlib.sha256(token.encode()).hexdigest()}','hex'),1,'{device}','EMAIL',now(),now()+interval '2 hours',now());",
                f"INSERT INTO user_session(id,user_id,token_digest,credential_version,device_id,auth_method,issued_at,expires_at,last_seen_at) VALUES('{other_session}','{user}',decode('{hashlib.sha256(other_token.encode()).hexdigest()}','hex'),1,'{other_device}','EMAIL',now(),now()+interval '2 hours',now());",
                f"INSERT INTO practice_session(id,user_id,bank_id,selection_kind,question_order,feedback,status,configuration_snapshot) VALUES('{practice}','{user}','{bank}','NORMAL','SEQUENTIAL','IMMEDIATE','IN_PROGRESS','{{\"chapterIds\":[],\"count\":1,\"order\":\"SEQUENTIAL\",\"selectionKind\":\"NORMAL\",\"feedback\":\"IMMEDIATE\",\"contentVersion\":1}}');",
                f"INSERT INTO practice_sync_state(session_id,writer_device_id,writer_token) VALUES('{practice}','{device}','{writer}');"
            ])
        sql('BEGIN;\n' + '\n'.join(statements) + '\nCOMMIT; ANALYZE;')
        fixture_path = state / 'fixture.json'; fixture_path.write_text(json.dumps(fixture)); fixture_path.chmod(0o600)
        api = start('api', args.image, '--memory', '576m', '--env-file', str(path), '-e', 'BACKEND_ROLE=api', '--entrypoint', 'java', command=('-Xmx256m', '-jar', '/app/app.jar'))
        start('worker', args.image, '--memory', '384m', '--env-file', str(path), '-e', 'BACKEND_ROLE=worker', '-e', 'BACKEND_WORKER_ENABLED=true', '--entrypoint', 'java', command=('-Xmx192m', '-jar', '/app/app.jar'))
        templates = state / 'templates'; templates.mkdir(mode=0o755)
        for source, name in [('public-gateway.conf','default.conf.template'),('public-gateway-routes.inc','gateway-routes.inc.template'),('public-gateway-https.conf','https.conf.template')]:
            content = (Path('deploy') / source).read_text().replace('http://api:8083',f'http://{prefix}-api:8083')
            target = templates / name; target.write_text(content); target.chmod(0o644)
        certificate, private_key = state/'certificate.pem', state/'tls-key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1',
                        '-keyout',str(private_key),'-out',str(certificate)],check=True,capture_output=True)
        certificate.chmod(0o644);private_key.chmod(0o644)  # Disposable fixture inside the private run directory.
        gateway = start('gateway',gateway_image,'--memory','256m','--ulimit','nofile=32768:32768','--user','101:101','--cap-drop','ALL','--read-only','--security-opt','no-new-privileges:true',
                        '--tmpfs','/etc/nginx/conf.d:uid=101,gid=101,mode=0755','--tmpfs','/var/cache/nginx:uid=101,gid=101,mode=0755','--tmpfs','/var/run:uid=101,gid=101,mode=0755',
                        '-v',str(templates)+':/etc/nginx/templates:ro','-v',str(Path('deploy/public-gateway-nginx.conf').resolve())+':/etc/nginx/nginx.conf:ro',
                        '-v',str(certificate)+':/etc/qanda/tls/fullchain.pem:ro','-v',str(private_key)+':/etc/qanda/tls/privkey.pem:ro',
                        '-e','QANDA_GATEWAY_KEY='+'a'*64,'-e','QANDA_GATEWAY_ALLOWED_CLIENT=8.8.8.8','-p','127.0.0.1::8443')
        port = docker('port', gateway, '8443/tcp').rsplit(':', 1)[1]
        tunnel = subprocess.Popen([sys.executable, str(Path(__file__).with_name('tunnel.py')), '--state', str(state), '--local-port', port], stdout=subprocess.PIPE, stderr=(state/'tunnel.log').open('w'))
        if not select.select([tunnel.stdout], [], [], 30)[0]: raise RuntimeError('Local tunnel startup timed out')
        ready = json.loads(tunnel.stdout.readline())
        if not ready['tunnel_ready'] or ready['nofile_soft'] not in (-1,) and ready['nofile_soft']<32768: raise RuntimeError('Local tunnel file capacity was not verified')
        (state/'tunnel.json').write_text(json.dumps(ready))
        url = 'https://127.0.0.1:' + str(ready['port'])
        trust = ssl.create_default_context(cafile=str(certificate))
        for _ in range(90):
            try:
                if json.load(urllib.request.urlopen(url + '/api/v1/health', timeout=3, context=trust))['status'] == 'UP': break
            except Exception: time.sleep(1)
        else: raise RuntimeError('Isolated API did not become ready')
        handshake = http.client.HTTPSConnection('127.0.0.1', int(ready['port']), context=trust, timeout=5)
        first = fixture[0]
        try:
            handshake.request('GET',f"/api/v1/practice/writer-socket?sessionId={first['practice']}&deviceId={first['device']}",headers={
                'Authorization':'Bearer '+first['token'],'Origin':'https://servicewechat.com','Upgrade':'websocket','Connection':'Upgrade',
                'Sec-WebSocket-Key':base64.b64encode(secrets.token_bytes(16)).decode(),'Sec-WebSocket-Version':'13'})
            assert handshake.getresponse().status == 101, 'Authenticated TLS websocket upgrade failed'
            metadata['tls_upgrade_verified'] = True
            (state/'metadata.json').write_text(json.dumps(metadata))
        finally: handshake.close()
        sampler = threading.Thread(target=sample, daemon=True); sampler.start()
        runs = []
        for users in args.users:
            for mode in ('baseline', 'sockets'):
                sql('TRUNCATE sync_command,command_receipt CASCADE; UPDATE practice_sync_state SET accepted_sequence=0,acknowledged_sequence=0; UPDATE practice_session SET version=1,duration_seconds=0,current_index=0;')
                assert sql('SELECT count(*) FROM practice_session WHERE version<>1 OR duration_seconds<>0 OR current_index<>0;') == '0', 'Practice metadata reset was incomplete'
                replacements = ','.join(f"('{row['practice']}'::uuid,'{row['device']}'::uuid,'{row['writer']}'::uuid)" for row in fixture)
                sql(f"UPDATE practice_sync_state s SET writer_device_id=f.device,writer_token=f.token,writer_epoch=1,writer_sealed=false,takeover_id=NULL,takeover_device_id=NULL,takeover_expires_at=NULL,takeover_state=NULL FROM (VALUES {replacements}) f(id,device,token) WHERE s.session_id=f.id;")
                label = f'{users}-{mode}'
                run_env = {**os.environ, 'K6_INSECURE_SKIP_TLS_VERIFY': 'true', 'WRITER_FIXTURE': str(fixture_path), 'WRITER_URL': url, 'WRITER_MODE': mode, 'WRITER_USERS': str(users)}
                print(json.dumps({'phase': 'start', 'run': label}), flush=True)
                began = time.time()
                with (state / (label + '.log')).open('w') as log:
                    process = subprocess.Popen([args.k6, 'run', '--quiet', '--summary-export', str(state / (label + '.json')), str(Path(__file__).with_name('writer-sockets.js'))], env=run_env, stdout=log, stderr=log)
                    deadline = time.monotonic()+290
                    while process.poll() is None and time.monotonic()<deadline and not stop.is_set() and tunnel.poll() is None: time.sleep(1)
                    if process.poll() is None: process.terminate();process.wait(timeout=10)
                counts = sql("SELECT count(*),count(*) FILTER(WHERE state='COMMITTED'),count(*) FILTER(WHERE state IN ('QUEUED','RETRYING','REJECTED','DEAD_LETTER')) FROM sync_command;")
                for _ in range(30):
                    if counts.split('|')[2] == '0': break
                    time.sleep(1)
                    counts = sql("SELECT count(*),count(*) FILTER(WHERE state='COMMITTED'),count(*) FILTER(WHERE state IN ('QUEUED','RETRYING','REJECTED','DEAD_LETTER')) FROM sync_command;")
                practice_ids = ','.join("'" + row['practice'] + "'" for row in fixture[:users])
                verified = int(sql(f"SELECT count(*) FROM practice_session p JOIN practice_sync_state s ON s.session_id=p.id WHERE p.id IN ({practice_ids}) AND p.duration_seconds=2 AND s.acknowledged_sequence=2;"))
                runs.append({'verified_progress': verified, 'users': users, 'mode': mode, 'started': began, 'ended': time.time(), 'exit': process.returncode, 'commands': counts})
                (state / 'result.json').write_text(json.dumps({'runs': runs, 'samples': samples}, ensure_ascii=False))
                print(json.dumps({'phase': 'complete', **runs[-1]}), flush=True)
                if process.returncode or stop.is_set() or counts != f'{2*users}|{2*users}|0' or verified != users: raise RuntimeError('Capacity checks failed; private evidence retained')
        stop.set(); sampler.join(timeout=10)
        print('Writer socket comparison completed', flush=True)
    finally:
        stop.set()
        if process and process.poll() is None: process.terminate();process.wait(timeout=10)
        for name in names:
            try:
                (state / (name.rsplit('-', 1)[-1] + '-state.json')).write_text(docker('inspect', '--format', '{{json .State}}', name))
                (state / (name.rsplit('-', 1)[-1] + '-service.log')).write_text(docker('logs', '--tail', '160', name))
            except Exception: pass
        if tunnel and tunnel.poll() is None: tunnel.terminate();tunnel.wait(timeout=10)
        for name in reversed(names):
            subprocess.run(['colima', 'ssh', '--', 'sudo', 'docker', 'rm', '-f', '-v', name], capture_output=True, timeout=60)
        subprocess.run(['colima', 'ssh', '--', 'sudo', 'docker', 'network', 'rm', prefix], capture_output=True, timeout=30)


if __name__ == '__main__': main()
