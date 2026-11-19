#!/usr/bin/env python3
"""Restricted single-host 题小搭 deployment. Configuration and state are root-owned."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib/qanda"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import source_build
import business_gateway

ROOT = Path('/srv/qanda')
STATE = Path('/var/lib/qanda-deploy')
REQUEST = Path('/run/qanda-release-request.json')
INPUT_TIMEOUT_SECONDS = 30
SERVICES = ('api', 'worker', 'monitor', 'bank-mcp', 'web')
GATEWAY_IMAGE = 'nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236'
PULL_TIMEOUT_SECONDS = 15 * 60


def node_role():
    role = read(ROOT / 'node.json', {'role': 'combined'})['role']
    if role not in ('combined', 'backend', 'frontend'):
        raise ValueError('Unknown node role')
    return role


def services(release=None):
    owned = ('web',) if node_role() == 'frontend' else SERVICES[:-1] if node_role() == 'backend' else SERVICES
    if release is not None and 'mcp' not in release:
        return tuple(service for service in owned if service != 'bank-mcp')
    return owned


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
    expected_networks = {'qanda-application'} | (set() if service in ('web', 'bank-mcp') else {'qanda-data'})
    if set(container['NetworkSettings']['Networks']) != expected_networks:
        raise RuntimeError('Unexpected application networks')
    for mount in container['Mounts']:
        if (mount['Type'] == 'volume' and mount.get('Name') == 'qanda-production-assets'
                and mount['Destination'] == '/var/lib/qanda/assets' and service in ('api', 'worker', 'monitor')):
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
        for name in services(read(STATE / 'current.json')):
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
    kwargs.setdefault('timeout', 600)
    try:
        result = subprocess.run([str(x) for x in args], check=True, text=True, capture_output=True, **kwargs)
    except subprocess.CalledProcessError as error:
        if read(STATE / 'operation.json', {}).get('operation_id'):
            with (STATE / 'release.log').open('a') as log:
                log.write(source_build.redact((error.stdout or '') + (error.stderr or '')))
        raise
    return result.stdout.strip()


def atomic(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump(value, output)
    os.replace(temporary, path)


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def validate_release(release):
    images = ('web',) if node_role() == 'frontend' else ('backend',) if node_role() == 'backend' else ('backend', 'web')
    required = {'revision', *images}
    if isinstance(release, dict) and 'mcp' in release and 'backend' in required:
        required.add('mcp')
    metadata = {'operation_id'} if isinstance(release, dict) and 'operation_id' in release else set()
    if metadata and (not isinstance(release['operation_id'], str) or not re.fullmatch(r'[0-9]+-[0-9]+-(backend|frontend)', release['operation_id'])):
        raise ValueError('Invalid release operation identity')
    if not isinstance(release, dict) or set(release) - metadata != required:
        raise ValueError('Expected the revision and images owned by this node')
    if not isinstance(release['revision'], str) or not re.fullmatch(r'[0-9a-f]{40}', release['revision']):
        raise ValueError('Expected a full commit SHA')
    for kind in set(release) - {'revision', 'operation_id'}:
        if not isinstance(release[kind], str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', release[kind]):
            raise ValueError('Image repository or digest is not allowed')
    return release


def input_timed_out(_signum, _frame):
    raise TimeoutError('Deployment input exceeded its time budget')


def error_message(error):
    return str(error) if isinstance(error, (ValueError, RuntimeError, TimeoutError)) else type(error).__name__


def image_labels(image):
    return json.loads(run('docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', image))


def require_image_labels(image, revision):
    labels = image_labels(image) or {}
    if (labels.get('org.opencontainers.image.source') != 'https://github.com/zhouycheng/QandAS'
            or labels.get('org.opencontainers.image.revision') != revision):
        raise RuntimeError('Image labels do not match this repository release')
    if labels.get('qanda.role') != node_role():
        raise RuntimeError('Local image role does not match this node')


def pull_image(image):
    for attempt in range(3):
        try:
            run('docker', 'pull', image, timeout=PULL_TIMEOUT_SECONDS)
            return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))


def ensure_local_images(release):
    for kind in ('backend', 'mcp', 'web'):
        if kind in release:
            require_image_labels(release[kind], release['revision'])


def protected(path):
    for item in (path, *path.parents):
        st = item.lstat()
        if item.is_symlink() or st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError('Root-owned configuration is required')


def compose(release, *args):
    # Compose interpolates inactive services too; scratch cannot start an unselected role.
    env = {**os.environ, 'BACKEND_IMAGE': release['backend'] if 'backend' in release else 'scratch',
           'WEB_IMAGE': release['web'] if 'web' in release else 'scratch',
           'QANDA_MCP_IMAGE': release.get('mcp', 'scratch'), 'REVISION': release['revision']}
    command = ['docker', 'compose', '-p', 'qanda-application', '--env-file', ROOT / 'production.env']
    if (ROOT / 'node.env').exists():
        command += ['--env-file', ROOT / 'node.env']
    if 'mcp' in release:
        command += ['--profile', 'bank-mcp']
    command += ['-f', ROOT / 'compose.application.yml']
    return run(*command, *args, env=env)


def tailnet_command(release):
    return ['docker', 'compose', '-p', 'qanda-tailnet', '--env-file', str(ROOT / 'node.env'),
            '-f', str(ROOT / 'compose.tailnet.yml')], dict(os.environ)


def tailnet_compose(release, *args):
    command, env = tailnet_command(release)
    return run(*command, *args, env=env)


def public_gateway_command():
    return ['docker', 'compose', '-p', 'qanda-public-gateway', '--env-file', str(ROOT / 'node.env'),
            '-f', str(ROOT / 'compose.public-gateway.yml')], {**os.environ, 'GATEWAY_IMAGE': GATEWAY_IMAGE}


def public_gateway(*args):
    command, env = public_gateway_command()
    return run(*command, *args, env=env)


def start_public_gateway():
    run('systemctl', 'start', 'qanda-public-gateway.service')
    for _ in range(120):
        container = public_gateway('ps', '-q', 'gateway')
        if container and run('docker', 'inspect', '-f', '{{.State.Health.Status}}', container) == 'healthy':
            return
        time.sleep(2)
    raise RuntimeError('Public business gateway did not become ready')


def reload_gateway_routes():
    # Render only the shared routes. Certificate selection belongs to the node owner.
    public_gateway('exec', '-T', 'gateway', 'sh', '-ec', """
        cd /etc/nginx/conf.d
        routes=gateway-routes.inc
        envsubst '$QANDA_GATEWAY_ALLOWED_CLIENT $QANDA_GATEWAY_KEY' \
            < /etc/nginx/templates/gateway-routes.inc.template > "$routes.new"
        if cmp -s "$routes" "$routes.new"; then rm "$routes.new"; exit 0; fi
        cp "$routes" "$routes.previous"
        mv "$routes.new" "$routes"
        if nginx -t && nginx -s reload; then rm "$routes.previous"; else mv "$routes.previous" "$routes"; exit 1; fi
    """)


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
    public_mcp_resource()
    if node_role() != 'combined':
        for name in ('node.json', 'node.env', 'compose.tailnet.yml', 'tailnet-config/serve.json'):
            protected(ROOT / name)
        business_gateway.configuration(ROOT / 'node.env', node_role())
        if node_role() == 'backend':
            for name in ('compose.public-gateway.yml', 'public-gateway/default.conf.template', 'public-gateway/gateway-routes.inc.template'):
                protected(ROOT / name)
            for path in (ROOT / 'public-gateway').glob('*.template'):
                protected(path)
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


def public_mcp_resource():
    resource = 'https://qanda.zhoust.cn/mcp'
    for line in (ROOT / 'production.env').read_text().splitlines():
        if line.startswith('QANDA_MCP_RESOURCE='):
            resource = line.partition('=')[2].strip().strip("'\"") or resource
    if not resource.startswith('https://') or not resource.endswith('/mcp'):
        raise ValueError('Expected HTTPS MCP resource on the admin origin')
    parts = urlsplit(resource)
    if (parts.hostname in ('localhost', '127.0.0.1', '::1') and parts.path == '/mcp' and
            not parts.username and not parts.password and not parts.query and not parts.fragment and
            (parts.port is None or 1 <= parts.port <= 65535)):
        return resource
    return business_gateway.endpoint(resource[:-4]) + '/mcp'


def health(release):
    for role in services(release):
        container = compose(release, 'ps', '-q', role)
        if not container or run('docker', 'inspect', '-f', '{{.State.Health.Status}}', container) != 'healthy':
            raise RuntimeError('Application group is not healthy')
    if node_role() != 'combined':
        run('/usr/local/lib/qanda/network-guard.py', '--check')
        run('systemctl', 'is-active', 'qanda-ops.service')
        check_tailnet_identity(release)
        container = tailnet_compose(release, 'ps', '-q', 'tailnet')
        if not container or run('docker', 'inspect', '-f', '{{.State.Health.Status}}', container) != 'healthy':
            raise RuntimeError('Project operations node is not healthy')
    if node_role() == 'backend':
        container = public_gateway('ps', '-q', 'gateway')
        if not container or run('docker', 'inspect', '-f', '{{.State.Health.Status}}', container) != 'healthy':
            raise RuntimeError('Public business gateway is not healthy')
        return
    resource = public_mcp_resource()
    origin = resource[:-4]
    with urllib.request.urlopen(origin + '/api/v1/health', timeout=15) as response:
        if json.load(response).get('status') != 'UP':
            raise RuntimeError('Public API check failed')
    with urllib.request.urlopen(origin + '/', timeout=15) as response:
        if b'<div id="root"' not in response.read():
            raise RuntimeError('Public admin check failed')
    if (image_labels(release['web']) or {}).get('qanda.mcp.gateway') == 'true':
        with urllib.request.urlopen(origin + '/.well-known/oauth-protected-resource/mcp', timeout=15) as response:
            if json.load(response).get('resource') != resource:
                raise RuntimeError('Public MCP gateway resource mismatch')
        try:
            with urllib.request.urlopen(resource, timeout=15):
                raise RuntimeError('Public MCP endpoint did not request authorization')
        except urllib.error.HTTPError as error:
            with error:
                expected = 'resource_metadata="' + origin + '/.well-known/oauth-protected-resource/mcp"'
                if error.code != 401 or expected not in error.headers.get('WWW-Authenticate', ''):
                    raise RuntimeError('Public MCP authorization challenge failed') from error


def mark(phase):
    state = read(STATE / 'operation.json', {})
    if state.get('operation_id'):
        with (STATE / 'release.log').open('a') as log:
            log.write('Phase: ' + phase + '\n')
    if phase == 'failed':
        state['failed_phase'] = state.get('phase')
    atomic(STATE / 'operation.json', {**state, 'phase': phase, 'updated': int(time.time())})


def activate(release):
    # Persist the image variables so host restarts/manual compose commands use the same release.
    desired = read(STATE / 'desired.json', {})
    if 'mcp' in desired and 'mcp' not in release:
        compose(desired, 'rm', '--stop', '--force', 'bank-mcp')
    atomic(STATE / 'desired.json', release)
    compose(release, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '240', *services(release))
    if node_role() == 'backend':
        start_public_gateway()
        if 'mcp' in release:
            reload_gateway_routes()
    if node_role() != 'combined':
        # Application releases keep the operations node and release status connection alive.
        run('systemctl', 'start', 'qanda-ops.service', 'qanda-tailnet.service')
        for _ in range(120):
            containers = tailnet_compose(release, 'ps', '-q', 'tailnet').splitlines()
            if len(containers) == 1 and all(run('docker', 'inspect', '-f', '{{.State.Health.Status}}', c) == 'healthy' for c in containers):
                break
            time.sleep(2)
        else:
            raise RuntimeError('Project tailnet did not become ready')
        # Reassert QandA bridge rules after host firewall services have started.
        run('/usr/local/lib/qanda/network-guard.py')


def apply(request):
    release = request['release']
    current = read(STATE / 'current.json')
    preflight(first=current is None)
    mark('pulling')
    ensure_local_images(release)
    if node_role() != 'combined':
        for image in (tailnet_image(),) + ((GATEWAY_IMAGE,) if node_role() == 'backend' else ()):
            try:
                run('docker', 'image', 'inspect', image)
            except subprocess.CalledProcessError:
                pull_image(image)
    if request['action'] == 'deploy' and node_role() != 'frontend':
        mark('backing-up')
        run('/usr/local/sbin/qanda-backup')
    stopped = False
    try:
        if request['action'] == 'deploy' and node_role() != 'frontend':
            mark('checking-candidate')
            candidate = ['/usr/local/lib/qanda/candidate-check.py', release['backend']]
            if node_role() == 'combined':
                candidate.append(release['web'])
            if 'mcp' in release:
                candidate.extend(['--mcp', release['mcp']])
            run(*candidate)
            mark('initializing')
            previous = ['-e', 'BACKEND_PREVIOUS_REVISION=' + current['revision']] if current else []
            compose(release, 'run', '--rm', '--no-deps', *previous, 'schema-init')
        if current:
            mark('stopping')
            # Stop only 题小搭 application roles. Infrastructure and persistent volumes stay running.
            stopped = True
            compose(current, 'stop', '--timeout', '120', *services(current))
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
        elif not current:
            # Keep the independent operations entry reachable for diagnosis and retry.
            compose(release, 'stop', '--timeout', '120', *services(release))
            mark('failed')
        else:
            mark('failed')
        raise
    if current:
        atomic(STATE / 'previous.json', current)
    atomic(STATE / 'current.json', release)
    mark('complete')


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def validate_source_request(request, action):
    expected = {'operation_id', 'role', 'revision', 'token'} if action == 'deploy' else {'operation_id', 'role'}
    if set(request) != expected or request.get('role') != node_role() or node_role() == 'combined':
        raise ValueError('Unexpected source deployment request')
    if (not isinstance(request['operation_id'], str) or not re.fullmatch(r'[0-9]+-[0-9]+-(backend|frontend)', request['operation_id'])
            or not request['operation_id'].endswith('-' + node_role())):
        raise ValueError('Invalid operation identity')
    if action == 'deploy':
        if not isinstance(request['revision'], str) or not re.fullmatch(r'[0-9a-f]{40}', request['revision']):
            raise ValueError('Invalid source revision')
        if not isinstance(request['token'], str) or not re.fullmatch(r'[!-~]{1,4096}', request['token']):
            raise ValueError('Invalid source credential')


def reconcile(locked=False):
    operation = read(STATE / 'operation.json', {})
    if operation.get('phase') in (None, 'complete', 'failed', 'rolled-back'):
        return
    if not locked:
        with open(STATE / 'lock', 'w') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            return reconcile(locked=True)
    active = subprocess.run(['systemctl', 'is-active', 'qanda-release.service'], capture_output=True, text=True, timeout=15).stdout.strip()
    if (operation.get('boot_id') and operation['boot_id'] != boot_id()) or active not in ('active', 'activating'):
        phase = operation.get('phase')
        recover = phase in ('stopping', 'starting', 'observing', 'rolling-back')
        current = read(STATE / 'current.json') if recover else None
        mark('rolling-back' if current else 'failed')
        REQUEST.unlink(missing_ok=True)
        subprocess.run(['docker', 'rm', '-f', source_build.BUILD_NAME], capture_output=True, timeout=30)
        for directory in STATE.glob('qanda-source-*'):
            if directory.is_dir() and not directory.is_symlink():
                shutil.rmtree(directory)
        if current:
            activate(current)
            health(current)
            mark('rolled-back')


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Use the restricted sudo command')
    protected(Path(__file__).resolve())
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    protected(STATE)
    action = sys.argv[1] if len(sys.argv) >= 2 else ''
    if action == 'reconcile':
        reconcile()
        return
    if action in ('containers', 'logs', 'shell', 'restart'):
        debug(action, sys.argv[2:])
        return
    if len(sys.argv) != 2:
        raise ValueError('Expected one deployment action')
    if action in ('status', 'release-logs'):
        reconcile()
        if action == 'release-logs':
            query = json.loads(sys.stdin.buffer.readline(4096))
            operation = read(STATE / 'operation.json', {})
            if set(query) != {'operation_id', 'offset'} or query['operation_id'] != operation.get('operation_id') or type(query['offset']) is not int or query['offset'] < 0:
                raise ValueError('Invalid release log cursor')
            path = STATE / 'release.log'
            with path.open('rb') as log:
                data = log.read().decode(errors='replace')
                # Emit complete lines so a credential cannot straddle polling chunks.
                data = source_build.redact(data[:data.rfind('\n') + 1])
                end = min(len(data), query['offset'] + 65536)
                print(json.dumps({'offset': end, 'text': data[query['offset']:end]}))
            return
        print(json.dumps({'source_build_protocol': 1, 'mcp_release_protocol': 1, 'role': node_role(), 'operation': read(STATE / 'operation.json'), 'current': read(STATE / 'current.json')}))
        return
    if action == 'tailnet-run':
        if node_role() == 'combined':
            raise ValueError('Project tailnet requires a split node')
        for name in ('node.env', 'compose.tailnet.yml', 'tailnet-config/serve.json'):
            protected(ROOT / name)
        tailnet_image()
        command, env = tailnet_command({})
        os.execvpe(command[0], [*command, 'up', '--no-build', '--pull', 'never', '--remove-orphans',
                              '--abort-on-container-exit', '--exit-code-from', 'tailnet'], env)
    if action == 'public-gateway-run':
        if node_role() != 'backend':
            raise ValueError('Only the backend node owns the public business gateway')
        business_gateway.configuration(ROOT / 'node.env', 'backend')
        for name in ('node.env', 'compose.public-gateway.yml', 'public-gateway/default.conf.template', 'public-gateway/gateway-routes.inc.template'):
            protected(ROOT / name)
        command, env = public_gateway_command()
        os.execvpe(command[0], [*command, 'up', '--no-build', '--pull', 'never', '--remove-orphans',
                              '--abort-on-container-exit', '--exit-code-from', 'gateway'], env)
    with open(STATE / 'lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if action == 'apply':
            request = read(REQUEST)
            REQUEST.unlink()
            try:
                if request['action'] == 'deploy':
                    request['release'] = source_build.build(request, mark)
                    request['release']['operation_id'] = request['operation_id']
                apply(request)
            except Exception as error:
                with (STATE / 'release.log').open('a') as log:
                    log.write(source_build.redact(str(error)) + '\n')
                raise
            finally:
                (REQUEST).unlink(missing_ok=True)
                if read(STATE / 'operation.json', {}).get('phase') not in ('complete', 'failed', 'rolled-back'):
                    mark('failed')
            return
        reconcile(locked=True)
        if action not in ('deploy', 'rollback'):
            raise ValueError('Expected deploy, rollback or status')
        if read(STATE / 'operation.json', {}).get('phase') not in (None, 'complete', 'rolled-back', 'failed'):
            raise RuntimeError('An operation is already active')
        previous_handler = signal.signal(signal.SIGALRM, input_timed_out)
        signal.alarm(INPUT_TIMEOUT_SECONDS)
        try:
            request = json.loads(sys.stdin.buffer.readline(16385))
            validate_source_request(request, action)
            for name in ('current.json', 'previous.json'):
                prior = read(STATE / name)
                if prior:
                    validate_release(prior)
                    ensure_local_images(prior)
            release = {'revision': request['revision']} if action == 'deploy' else validate_release(read(STATE / 'previous.json'))
            preflight(first=not (STATE / 'current.json').exists())
            if sys.stdin.buffer.read(1):
                raise ValueError('Unexpected request body')
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous_handler)
        atomic(REQUEST, {**request, 'action': action, 'release': release})
        operation = {'phase': 'queued', 'revision': release['revision'], 'action': action}
        operation.update(operation_id=request['operation_id'], boot_id=boot_id())
        log = STATE / 'release.log'
        log.write_text('Release queued\n')
        log.chmod(0o600)
        atomic(STATE / 'operation.json', operation)
        try:
            run('systemd-run', '--unit=qanda-release', '--collect', '--property=RuntimeMaxSec=3600',
                '--property=TimeoutStopSec=30', '--property=KillMode=control-group',
                '--property=ExecStopPost=/usr/local/sbin/qanda-deployctl reconcile',
                '/usr/local/sbin/qanda-deployctl', 'apply')
        except Exception:
            REQUEST.unlink(missing_ok=True)
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
        print(f'qanda-deployctl: {error_message(error)}', file=sys.stderr)
        sys.exit(1)
