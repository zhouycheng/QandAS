#!/usr/bin/env python3
"""Start immutable images against disposable dependencies; never attach production volumes."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import uuid


def check(backend, web=None):
    prefix = 'qanda-check-' + uuid.uuid4().hex[:12]
    names = []
    def docker(*args):
        return subprocess.run(['docker', *args], check=True, text=True, capture_output=True).stdout.strip()
    def start(suffix, image, *args, command=()):
        name = prefix + '-' + suffix
        names.append(name)
        return docker('run', '-d', '--name', name, '--network', prefix, *args, image, *command)
    docker('network', 'create', prefix)
    try:
        with tempfile.TemporaryDirectory(prefix='qanda-check-') as temporary:
            key = base64.b64encode(secrets.token_bytes(32)).decode()
            values = {'BACKEND_MODE': 'test', 'BACKEND_LOCAL_CONTAINER': 'true', 'BACKEND_BIND_ADDRESS': '0.0.0.0',
                      'BACKEND_DB_URL': f'jdbc:postgresql://{prefix}-db:5432/qanda_backend',
                      'BACKEND_DB_USER': 'qanda_backend', 'BACKEND_DB_PASSWORD': 'isolated-candidate-password',
                      'BACKEND_RABBIT_HOST': prefix + '-rabbit', 'BACKEND_RABBIT_USER': 'qanda',
                      'BACKEND_RABBIT_PASSWORD': 'isolated-queue-password', 'BACKEND_WECHAT_PROVIDER': 'local',
                      'BACKEND_REDIS_HOST': prefix + '-cache', 'BACKEND_REDIS_PASSWORD': 'isolated-cache-password',
                      'BACKEND_CONTENT_CACHE_ENABLED': 'true',
                      'BACKEND_IDENTITY_RATE_KEY': key, 'BACKEND_ROLE': 'all', 'BACKEND_WORKER_ENABLED': 'true',
                      **{f'BACKEND_{kind}_KEYS': '1:' + key for kind in ('COMMAND_DIGEST', 'IDENTITY_MAC', 'MAIL_ENCRYPTION', 'TEST_ACCOUNT_ENCRYPTION')}}
            path = Path(temporary) / 'test.env'
            path.write_text(''.join(f'{k}={v}\n' for k, v in values.items()))
            path.chmod(0o600)
            start('db', 'postgres:17.6-alpine', '-e', 'POSTGRES_DB=qanda_backend', '-e', 'POSTGRES_USER=qanda_backend', '-e', 'POSTGRES_PASSWORD=isolated-candidate-password')
            start('rabbit', 'rabbitmq:4.2.5-management', '-e', 'RABBITMQ_DEFAULT_USER=qanda', '-e', 'RABBITMQ_DEFAULT_PASS=isolated-queue-password', '-e', 'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2')
            start('cache', 'redis:8.10.3-alpine',
                  '--env-file', str(path), '--user', 'redis', '--entrypoint', '/bin/sh', '--read-only',
                  '--tmpfs', '/tmp:rw,noexec,nosuid,size=1m', '--memory', '192m', '--cap-drop', 'ALL',
                  '--security-opt', 'no-new-privileges:true',
                  '-v', str(Path(__file__).with_name('redis-start.sh')) + ':/usr/local/bin/qanda-redis-start:ro',
                  command=('/usr/local/bin/qanda-redis-start',))
            for _ in range(90):
                try:
                    docker('exec', prefix + '-db', 'pg_isready', '-h', '127.0.0.1', '-U', 'qanda_backend', '-d', 'qanda_backend')
                    docker('exec', prefix + '-rabbit', 'rabbitmq-diagnostics', '-q', 'ping')
                    if docker('exec', prefix + '-cache', 'sh', '-c', 'REDISCLI_AUTH="$BACKEND_REDIS_PASSWORD" redis-cli ping') != 'PONG':
                        time.sleep(2)
                        continue
                    break
                except subprocess.CalledProcessError:
                    time.sleep(2)
            else:
                raise RuntimeError('Isolated dependencies did not become ready')
            docker('run', '--rm', '--network', prefix, '--env-file', str(path), backend, 'schema-init')
            # V1 initialization must be repeatable without resetting the database.
            docker('run', '--rm', '--network', prefix, '--env-file', str(path), backend, 'schema-init')
            start('api', backend, '--env-file', str(path))
            for _ in range(90):
                try:
                    result = docker('exec', prefix + '-api', 'curl', '-fsS', 'http://127.0.0.1:9091/actuator/health/readiness')
                    if json.loads(result)['status'] == 'UP':
                        break
                except (subprocess.CalledProcessError, ValueError):
                    pass
                time.sleep(2)
            else:
                raise RuntimeError('Candidate backend did not become ready')
            if web:
                start('web', web)
                for _ in range(20):
                    try:
                        docker('exec', prefix + '-web', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/healthz')
                        break
                    except subprocess.CalledProcessError:
                        time.sleep(1)
                else:
                    raise RuntimeError('Candidate web did not become ready')
            print('Isolated candidate and repeatable V1 initialization passed')
    finally:
        for name in reversed(names):
            subprocess.run(['docker', 'rm', '-f', '-v', name], capture_output=True)
        subprocess.run(['docker', 'network', 'rm', prefix], capture_output=True)


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        sys.exit('Usage: candidate-check.py BACKEND_IMAGE [WEB_IMAGE]')
    check(*sys.argv[1:])
