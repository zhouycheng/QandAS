#!/usr/bin/env python3
"""Restricted single-host QandA deployment. Configuration and state are root-owned."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path('/srv/qanda')
STATE = Path('/var/lib/qanda-deploy')
SERVICES = ('api', 'worker', 'monitor', 'web')


def node_role():
    role = read(ROOT / 'node.json', {'role': 'combined'})['role']
    if role not in ('combined', 'backend', 'frontend'):
        raise ValueError('Unknown node role')
    return role


def services():
    return ('web',) if node_role() == 'frontend' else SERVICES[:3] if node_role() == 'backend' else SERVICES


def run(*args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def atomic(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    os.replace(temporary, path)


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def validate_release(release):
    if not isinstance(release, dict) or set(release) != {'revision', 'backend', 'web'}:
        raise ValueError('Expected revision, backend and web')
    if not isinstance(release['revision'], str) or not re.fullmatch(r'[0-9a-f]{40}', release['revision']):
        raise ValueError('Expected a full commit SHA')
    for kind in ('backend', 'web'):
        if not isinstance(release[kind], str) or not re.fullmatch(r'ghcr\.io/zhouycheng/qanda-' + kind + r'@sha256:[0-9a-f]{64}', release[kind]):
            raise ValueError('Image repository or digest is not allowed')
    return release


def protected(path):
    for item in (path, *path.parents):
        st = item.lstat()
        if item.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Root-owned configuration is required')


def compose(release, *args):
    env = {**os.environ, 'BACKEND_IMAGE': release['backend'], 'WEB_IMAGE': release['web'], 'REVISION': release['revision']}
    command = ['docker', 'compose', '-p', 'qanda-application', '--env-file', ROOT / 'production.env']
    if (ROOT / 'node.env').exists():
        command += ['--env-file', ROOT / 'node.env']
    command += ['-f', ROOT / 'compose.application.yml']
    if node_role() == 'backend':
        command += ['-f', ROOT / 'compose.backend-node.yml']
    return run(*command, *args, env=env)


def preflight(first=False):
    for name in ('compose.application.yml', 'production.env'):
        protected(ROOT / name)
    for name in ('node.json', 'node.env', 'compose.backend-node.yml'):
        if (ROOT / name).exists():
            protected(ROOT / name)
    if (ROOT / 'production.env').stat().st_mode & 0o077:
        raise RuntimeError('production.env must have mode 0600')
    info = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    required = 128 if node_role() == 'frontend' else 1536 if first else 384
    if int(info['MemAvailable'].split()[0]) < required * 1024:
        raise RuntimeError('Insufficient available RAM')
    if shutil.disk_usage(ROOT).free < 3 * 1024**3:
        raise RuntimeError('At least 3 GiB free disk is required')


def assets(release):
    container = run('docker', 'create', release['web'])
    try:
        with tempfile.TemporaryDirectory(prefix='qanda-assets-') as temporary:
            run('docker', 'cp', f'{container}:/usr/share/nginx/html/assets/.', temporary)
            destination = ROOT / 'web-assets/assets'
            destination.mkdir(parents=True, exist_ok=True)
            for source in Path(temporary).rglob('*'):
                if source.is_symlink():
                    raise RuntimeError('Asset symlinks are not allowed')
                if source.is_file():
                    target = destination / source.relative_to(temporary)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists() and hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(source.read_bytes()).digest():
                        raise RuntimeError('Immutable asset content conflict')
                    if not target.exists():
                        shutil.copyfile(source, target)
                        target.chmod(0o644)
    finally:
        run('docker', 'rm', container)


def health(release):
    for role in services():
        container = compose(release, 'ps', '-q', role)
        if not container or run('docker', 'inspect', '-f', '{{.State.Health.Status}}', container) != 'healthy':
            raise RuntimeError('Application group is not healthy')
    if node_role() == 'backend':
        return
    with urllib.request.urlopen('https://qanda.zhoust.cn/api/v1/health', timeout=15) as response:
        if json.load(response).get('status') != 'UP':
            raise RuntimeError('Public API check failed')
    with urllib.request.urlopen('https://qanda.zhoust.cn/', timeout=15) as response:
        if b'<div id="root"' not in response.read():
            raise RuntimeError('Public admin check failed')


def mark(phase):
    state = read(STATE / 'operation.json', {})
    if phase == 'failed':
        state['failed_phase'] = state.get('phase')
    atomic(STATE / 'operation.json', {**state, 'phase': phase, 'updated': int(time.time())})


def activate(release):
    # Persist the image variables so host restarts/manual compose commands use the same release.
    atomic(STATE / 'desired.json', release)
    compose(release, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '240', *services())


def apply(request):
    release = request['release']
    current = read(STATE / 'current.json')
    preflight(first=current is None)
    mark('pulling')
    for kind in ('backend', 'web'):
        run('docker', 'pull', release[kind])
    if request['action'] == 'deploy' and node_role() != 'frontend':
        mark('backing-up')
        run('/usr/local/sbin/qanda-backup')
    stopped = False
    try:
        if current:
            mark('stopping')
            # Stop only QandA application roles. Infrastructure and persistent volumes stay running.
            stopped = True
            compose(current, 'stop', '--timeout', '120', *services())
        if request['action'] == 'deploy' and node_role() != 'frontend':
            mark('checking-candidate')
            run('/usr/local/lib/qanda/candidate-check.py', release['backend'], release['web'])
            mark('initializing')
            compose(release, 'run', '--rm', '--no-deps', 'schema-init')
        if node_role() != 'backend':
            assets(release)
        mark('starting')
        activate(release)
        mark('observing')
        for _ in range(6):
            health(release)
            time.sleep(10)
    except Exception:
        if current and stopped:
            mark('rolling-back')
            activate(current)
            health(current)
            mark('rolled-back')
        else:
            compose(release, 'stop', '--timeout', '120', *services())
            mark('failed')
        raise
    if current:
        atomic(STATE / 'previous.json', current)
    atomic(STATE / 'current.json', release)
    mark('complete')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Use the restricted sudo command')
    protected(Path(__file__).resolve())
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    protected(STATE)
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action == 'status':
        print(json.dumps({'operation': read(STATE / 'operation.json'), 'current': read(STATE / 'current.json')}))
        return
    with open(STATE / 'lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if action == 'apply':
            path = STATE / 'request.json'
            request = read(path)
            path.unlink()
            with tempfile.TemporaryDirectory(prefix='qanda-registry-', dir='/run') as temporary:
                os.environ['DOCKER_CONFIG'] = temporary
                try:
                    run('docker', 'login', 'ghcr.io', '--username', request.pop('username'), '--password-stdin', input=request.pop('token') + '\n')
                    apply(request)
                finally:
                    if read(STATE / 'operation.json', {}).get('phase') not in ('complete', 'failed', 'rolled-back'):
                        mark('failed')
            return
        if action not in ('deploy', 'rollback'):
            raise ValueError('Expected deploy, rollback or status')
        if read(STATE / 'operation.json', {}).get('phase') not in (None, 'complete', 'rolled-back', 'failed'):
            raise RuntimeError('An operation is already active')
        if (STATE / 'request.json').exists():
            raise RuntimeError('An earlier request requires reconciliation')
        request = json.loads(sys.stdin.read(16385))
        if set(request) != ({'release', 'username', 'token'} if action == 'deploy' else {'username', 'token'}):
            raise ValueError('Unexpected request fields')
        if not re.fullmatch(r'[A-Za-z0-9-]{1,39}', request['username']) or not 1 <= len(request['token']) <= 4096:
            raise ValueError('Invalid registry credentials')
        release = validate_release(request['release'] if action == 'deploy' else read(STATE / 'previous.json'))
        preflight(first=not (STATE / 'current.json').exists())
        atomic(STATE / 'request.json', {**request, 'action': action, 'release': release})
        atomic(STATE / 'operation.json', {'phase': 'queued', 'revision': release['revision'], 'action': action})
        try:
            run('systemd-run', '--unit=qanda-release', '--collect', '/usr/local/sbin/qanda-deployctl', 'apply')
        except Exception:
            (STATE / 'request.json').unlink()
            mark('failed')
            raise
        print('Release queued; poll status')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError) and STATE.exists():
            path = STATE / 'diagnostic.txt'
            path.write_text(error.stderr or 'Command failed without diagnostic output')
            path.chmod(0o600)
        print(f'qanda-deployctl: {type(error).__name__}; inspect deployment status', file=sys.stderr)
        sys.exit(1)
