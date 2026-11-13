"""Build a fixed repository revision in disposable, resource-limited containers."""
import http.client
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
import tarfile
import time

NODE_IMAGE = 'node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57'
JAVA_IMAGE = 'eclipse-temurin:21-jdk-jammy@sha256:432e54724c3e57d1846aeb886f4d339f3b0522931c4e64119c2797013b7cfc3c'
RUNTIME_IMAGE = 'eclipse-temurin:21-jre-jammy'
WEB_RUNTIME_IMAGE = 'nginx:1.28-alpine'
LOG = Path('/var/lib/qanda-deploy/release.log')
BUILD_NAME = 'qanda-release-build'
BUILD_ROOT = Path('/var/lib/qanda-deploy')
CACHE_ROOT = Path('/var/cache/qanda-build')


def redact(text):
    return re.sub(r'(?:gh[psu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)', '[REDACTED]', text)


def command(*args, env=None):
    with LOG.open('ab', buffering=0) as output:
        start = output.tell()
        process = subprocess.Popen([str(x) for x in args], stdout=output, stderr=subprocess.STDOUT,
                                   env=env, start_new_session=True)
        try:
            code = process.wait(timeout=1800)
        except BaseException:
            import signal
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
    if code:
        raise RuntimeError('Release command failed; inspect release logs')
    with LOG.open('rb') as output:
        output.seek(start)
        return output.read().decode(errors='replace').strip()


def resources():
    memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    if int(memory['MemAvailable'].split()[0]) < 1536 * 1024:
        raise RuntimeError('Source build requires 1.5 GiB available RAM')
    if shutil.disk_usage(BUILD_ROOT).free < 5 * 1024**3:
        raise RuntimeError('Source build requires 5 GiB free disk')


def ensure_image(image):
    try:
        command('docker', 'image', 'inspect', image)
        return
    except RuntimeError:
        pass
    for attempt in range(3):
        try:
            command('docker', 'pull', image)
            return
        except RuntimeError:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))


def fetch(source, revision, token):
    connection = http.client.HTTPSConnection('codeload.github.com', timeout=120)
    try:
        # Do not follow redirects with the source credential.
        connection.request('GET', '/zhouycheng/QandAS/tar.gz/' + revision,
                           headers={'Authorization': 'Bearer ' + token})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError('Source download failed: HTTP ' + str(response.status))
        with tarfile.open(fileobj=response, mode='r|gz') as archive:
            if archive.pax_headers.get('comment') != revision:
                raise RuntimeError('Fetched source revision does not match the request')
            source.mkdir()
            for member in archive:
                path = PurePosixPath(member.name)
                if not path.parts or path.is_absolute() or '..' in path.parts or path.parts[0] != 'QandAS-' + revision:
                    raise ValueError('Invalid source archive path')
                relative = path.parts[1:]
                if not relative and member.isdir():
                    continue
                if not relative or relative[0] == '.git' or not (member.isdir() or member.isfile()):
                    raise ValueError('Unsupported source archive entry')
                target = source.joinpath(*relative)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as content, target.open('xb') as output:
                        shutil.copyfileobj(content, output)
                    target.chmod(0o755 if member.mode & 0o111 else 0o644)
    finally:
        connection.close()


def build(request, mark):
    revision, role = request['revision'], request['role']
    resources()
    with tempfile.TemporaryDirectory(prefix='qanda-source-', dir=BUILD_ROOT) as temporary:
        source = Path(temporary) / 'source'
        mark('fetching-source')
        fetch(source, revision, request.pop('token'))
        # Build processes have no host privileges or access to production credentials.
        for path in [source, *source.rglob('*')]:
            if not path.is_symlink():
                os.chown(path, 65534, 65534)
        source.chmod(0o755)
        cache = CACHE_ROOT / role
        cache.mkdir(parents=True, exist_ok=True)
        os.chown(cache, 65534, 65534)
        image = JAVA_IMAGE if role == 'backend' else NODE_IMAGE
        ensure_image(image)
        ensure_image(RUNTIME_IMAGE if role == 'backend' else WEB_RUNTIME_IMAGE)
        script = ('cd /source/apps/api && ./mvnw -B -Dmaven.repo.local=/cache/maven -Dmaven.test.skip=true package'
                  if role == 'backend' else
                  'npm --prefix packages/content-format ci && '
                  'npm install --prefix /cache/tools pnpm@11.25.0 && '
                  '/cache/tools/node_modules/.bin/pnpm --dir apps/admin install --frozen-lockfile && '
                  '/cache/tools/node_modules/.bin/pnpm --dir apps/admin build')
        mark('building-application')
        try:
            command('docker', 'run', '--rm', '--name', BUILD_NAME, '--user', '65534:65534',
                    '--cpus=1', '--memory=1g', '--memory-swap=1g', '--pids-limit=256',
                    '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                    '-e', 'HOME=/cache', '-e', 'MAVEN_OPTS=-Xmx640m', '-e', 'NODE_OPTIONS=--max-old-space-size=768',
                    '-v', f'{source}:/source', '-v', f'{cache}:/cache', '-w', '/source', image, 'sh', '-ec', script)
        finally:
            subprocess.run(['docker', 'rm', '-f', BUILD_NAME], capture_output=True, timeout=30)
        mark('building-image')
        kind = 'backend' if role == 'backend' else 'web'
        tag = f'qanda-local/{kind}:{request["operation_id"]}'
        context = source / 'apps/api' if role == 'backend' else source
        dockerfile = context / 'Dockerfile' if role == 'backend' else source / 'deploy/web.Dockerfile'
        build_args = ['--load', '--progress=plain',
                      '--label', 'org.opencontainers.image.source=https://github.com/zhouycheng/QandAS',
                      '--label', f'org.opencontainers.image.revision={revision}', '--label', f'qanda.role={role}',
                      '-t', tag, '-f', dockerfile, context]
        # The Docker Engine builder reuses the runtime base pulled above instead of resolving it remotely.
        command('docker', 'buildx', 'build', '--builder', 'default',
                '--resource', 'memory=1g', '--resource', 'memory-swap=1g',
                '--resource', 'cpu-period=100000', '--resource', 'cpu-quota=100000', *build_args)
        identifier = command('docker', 'image', 'inspect', '--format', '{{.Id}}', tag)
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', identifier):
            raise RuntimeError('Invalid local image identity')
        return {'revision': revision, kind: identifier}
