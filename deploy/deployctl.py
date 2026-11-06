#!/usr/bin/env python3
"""Restricted single-host 题小搭 deployment. Configuration and state are root-owned."""
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
GATEWAY_IMAGE = 'nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236'


def node_role():
    role = read(ROOT / 'node.json', {'role': 'combined'})['role']
    if role not in ('combined', 'backend', 'frontend'):
        raise ValueError('Unknown node role')
    return role


def services():
    return ('web',) if node_role() == 'frontend' else SERVICES[:3] if node_role() == 'backend' else SERVICES


def debug_request(action, args):
    if action == 'containers' and not args:
        return None
    if action not in ('logs', 'shell', 'restart') or not args or args[0] not in services():
        raise ValueError('Select an application service owned by this node')
    if len(args) != 1 and not (action == 'logs' and args[1:] == ['--follow']):
        raise ValueError('Unexpected container operation arguments')
    return args[0]


def owned_container(service):
    if service not in services():
        raise ValueError('Service is not owned by this node')
    found = run('docker', 'ps', '-aq', '--no-trunc',
                '--filter', 'label=com.docker.compose.project=qanda-application',
                '--filter', 'label=com.docker.compose.service=' + service,
                '--filter', 'label=com.docker.compose.oneoff=False').splitlines()
    if len(found) != 1 or not re.fullmatch(r'[0-9a-f]{64}', found[0]):
        raise RuntimeError('Expected exactly one project application container')
    container = json.loads(run('docker', 'inspect', found[0]))[0]
    labels = container['Config'].get('Labels') or {}
    config = container['HostConfig']
    if (container['Id'] != found[0] or labels.get('com.docker.compose.project') != 'qanda-application'
            or labels.get('com.docker.compose.service') != service
            or labels.get('com.docker.compose.oneoff') != 'False'
            or config.get('Privileged') or config.get('CapAdd') or config.get('Devices')
            or config.get('NetworkMode') == 'host' or config.get('PidMode') == 'host'
            or config.get('IpcMode') == 'host'):
        raise RuntimeError('Container does not satisfy the project isolation boundary')
    expected_networks = {'qanda-application'} | (set() if service == 'web' else {'qanda-data'})
    if set(container['NetworkSettings']['Networks']) != expected_networks:
        raise RuntimeError('Unexpected application networks')
    for mount in container['Mounts']:
        if (mount['Type'] == 'volume' and mount.get('Name') == 'qanda-production-assets'
                and mount['Destination'] == '/var/lib/qanda/assets' and service != 'web'):
            continue
        if (mount['Type'] == 'bind' and mount['Source'] == str(ROOT / 'web-assets')
                and mount['Destination'] == '/srv/qanda-assets' and not mount['RW'] and service == 'web'):
            continue
        raise RuntimeError('Unexpected application mount')
    return container


def debug(action, args):
    service = debug_request(action, args)
    protected(ROOT / 'node.json')
    if action == 'containers':
        result = []
        for name in services():
            container = owned_container(name)
            result.append({'service': name, 'image': container['Config']['Image'],
                           'state': container['State']['Status'],
                           'health': container['State'].get('Health', {}).get('Status')})
        print(json.dumps(result))
        return
    container = owned_container(service)
    identifier = container['Id']
    if action == 'restart':
        with open(STATE / 'lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if read(STATE / 'operation.json', {}).get('phase') not in (None, 'complete', 'failed', 'rolled-back'):
                raise RuntimeError('A release is in progress')
            run('docker', 'restart', '--time', '120', identifier)
        print('Container restarted; use containers to inspect readiness')
        return
    if action == 'logs':
        command = ['docker', 'logs', '--tail', '200', '--timestamps']
        if args[1:]:
            command.append('--follow')
        command.append(identifier)
    else:
        command = ['docker', 'exec', '-i'] + (['-t'] if sys.stdin.isatty() and sys.stdout.isatty() else [])
        command += [identifier, '/bin/sh']
    os.execvp(command[0], command)


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
    images = ('web',) if node_role() == 'frontend' else ('backend',) if node_role() == 'backend' else ('backend', 'web')
    required = {'revision', *images}
    if not isinstance(release, dict) or set(release) not in (required, {'revision', 'backend', 'web'}):
        raise ValueError('Expected the revision and images owned by this node')
    if not isinstance(release['revision'], str) or not re.fullmatch(r'[0-9a-f]{40}', release['revision']):
        raise ValueError('Expected a full commit SHA')
    for kind in set(release) - {'revision'}:
        if not isinstance(release[kind], str) or not re.fullmatch(r'ghcr\.io/zhouycheng/qanda-' + kind + r'@sha256:[0-9a-f]{64}', release[kind]):
            raise ValueError('Image repository or digest is not allowed')
    return {key: value for key, value in release.items() if key in required}


def protected(path):
    for item in (path, *path.parents):
        st = item.lstat()
        if item.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Root-owned configuration is required')


def compose(release, *args):
    # Compose interpolates inactive services too; scratch cannot start an unselected role.
    env = {**os.environ, 'BACKEND_IMAGE': release.get('backend', 'scratch'),
           'WEB_IMAGE': release.get('web', 'scratch'), 'REVISION': release['revision']}
    command = ['docker', 'compose', '-p', 'qanda-application', '--env-file', ROOT / 'production.env']
    if (ROOT / 'node.env').exists():
        command += ['--env-file', ROOT / 'node.env']
    command += ['-f', ROOT / 'compose.application.yml']
    return run(*command, *args, env=env)


def tailnet_command(release):
    return ['docker', 'compose', '-p', 'qanda-tailnet', '--env-file', str(ROOT / 'node.env'),
            '-f', str(ROOT / 'compose.tailnet.yml')], {**os.environ, 'GATEWAY_IMAGE': GATEWAY_IMAGE}


def tailnet_compose(release, *args):
    command, env = tailnet_command(release)
    return run(*command, *args, env=env)


def tailnet_image():
    values = dict(line.split('=', 1) for line in (ROOT / 'node.env').read_text().splitlines() if '=' in line)
    image = values.get('TAILSCALE_IMAGE', '')
    if not re.fullmatch(r'tailscale/tailscale@sha256:[0-9a-f]{64}', image):
        raise ValueError('An immutable official Tailscale image is required')
    return image


def check_tailnet_identity(release):
    values = dict(line.split('=', 1) for line in (ROOT / 'node.env').read_text().splitlines() if '=' in line)
    status = json.loads(tailnet_compose(release, 'exec', '-T', 'tailnet', 'tailscale', 'status', '--json'))
    identity = status.get('Self') or {}
    valid_identity = (not identity.get('Tags') and bool(identity.get('UserID'))
                      if node_role() == 'frontend' else identity.get('Tags') == ['tag:qanda-backend'])
    if (status.get('BackendState') != 'Running'
            or values.get('TAILNET_NODE_IP') not in (status.get('TailscaleIPs') or [])
            or not valid_identity):
        raise RuntimeError('Project container identity does not match the configured node')
    prefs = json.loads(tailnet_compose(release, 'exec', '-T', 'tailnet', 'tailscale', 'debug', 'prefs'))
    if prefs.get('AdvertiseRoutes') or prefs.get('RunSSH') or prefs.get('RouteAll') or prefs.get('ExitNodeID'):
        raise RuntimeError('Project container must not provide host access or subnet routing')
    serve = json.loads(tailnet_compose(release, 'exec', '-T', 'tailnet', 'tailscale', 'serve', 'status', '--json'))
    if (serve.get('TCP') != {'2222': {'TCPForward': '172.29.71.1:2203'}}
            or serve.get('Web') or any((serve.get('AllowFunnel') or {}).values())):
        raise RuntimeError('Unexpected project operations forwarding configuration')


def preflight(first=False):
    for name in ('compose.application.yml', 'production.env'):
        protected(ROOT / name)
    for name in ('node.json', 'node.env'):
        if (ROOT / name).exists():
            protected(ROOT / name)
    if (ROOT / 'production.env').stat().st_mode & 0o077:
        raise RuntimeError('production.env must have mode 0600')
    if node_role() != 'combined':
        for name in ('node.json', 'node.env', 'compose.tailnet.yml', 'tailnet-config/serve.json', f'tailnet-{node_role()}.conf'):
            protected(ROOT / name)
        for name in ('/etc/ssh/qanda-ops.conf', '/usr/local/lib/qanda/remote-entry.py',
                     '/etc/ssh/qanda-authorized-keys/qanda-deploy', '/etc/ssh/qanda-authorized-keys/qanda-debug'):
            protected(Path(name))
            if not Path(name).stat().st_size:
                raise RuntimeError('Project SSH configuration and public keys are required')
        tailnet_image()
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
    if node_role() != 'combined':
        run('/usr/local/lib/qanda/network-guard.py', '--check')
        run('systemctl', 'is-active', 'qanda-ops.service')
        check_tailnet_identity(release)
        for service in ('tailnet', 'gateway'):
            container = tailnet_compose(release, 'ps', '-q', service)
            if not container or run('docker', 'inspect', '-f', '{{.State.Health.Status}}', container) != 'healthy':
                raise RuntimeError('Project tailnet is not healthy')
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
    if node_role() != 'combined':
        # Application releases keep the fixed control gateway and the polling connection alive.
        run('systemctl', 'start', 'qanda-ops.service', 'qanda-tailnet.service')
        for _ in range(120):
            containers = tailnet_compose(release, 'ps', '-q', 'tailnet', 'gateway').splitlines()
            if len(containers) == 2 and all(run('docker', 'inspect', '-f', '{{.State.Health.Status}}', c) == 'healthy' for c in containers):
                break
            time.sleep(2)
        else:
            raise RuntimeError('Project tailnet did not become ready')


def apply(request):
    release = request['release']
    current = read(STATE / 'current.json')
    preflight(first=current is None)
    mark('pulling')
    for kind in ('backend', 'web'):
        if kind in release:
            run('docker', 'pull', release[kind])
    if node_role() != 'combined':
        run('docker', 'pull', tailnet_image())
        run('docker', 'pull', GATEWAY_IMAGE)
    if request['action'] == 'deploy' and node_role() != 'frontend':
        mark('backing-up')
        run('/usr/local/sbin/qanda-backup')
    stopped = False
    try:
        if current:
            mark('stopping')
            # Stop only 题小搭 application roles. Infrastructure and persistent volumes stay running.
            stopped = True
            compose(current, 'stop', '--timeout', '120', *services())
        if request['action'] == 'deploy' and node_role() != 'frontend':
            mark('checking-candidate')
            candidate = ['/usr/local/lib/qanda/candidate-check.py', release['backend']]
            if node_role() == 'combined':
                candidate.append(release['web'])
            run(*candidate)
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
            # Keep the independent operations entry reachable for diagnosis and retry.
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
    action = sys.argv[1] if len(sys.argv) >= 2 else ''
    if action in ('containers', 'logs', 'shell', 'restart'):
        debug(action, sys.argv[2:])
        return
    if len(sys.argv) != 2:
        raise ValueError('Expected one deployment action')
    if action == 'status':
        print(json.dumps({'role': node_role(), 'operation': read(STATE / 'operation.json'), 'current': read(STATE / 'current.json')}))
        return
    if action == 'tailnet-run':
        if node_role() == 'combined':
            raise ValueError('Project tailnet requires a split node')
        for name in ('node.env', 'compose.tailnet.yml', 'tailnet-config/serve.json', f'tailnet-{node_role()}.conf'):
            protected(ROOT / name)
        tailnet_image()
        command, env = tailnet_command({})
        os.execvpe(command[0], [*command, 'up', '--no-build', '--pull', 'never',
                              '--abort-on-container-exit', '--exit-code-from', 'tailnet'], env)
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
