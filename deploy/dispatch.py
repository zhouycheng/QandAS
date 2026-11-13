#!/usr/bin/env python3
"""Deploy one verified release through the selected node owner's management network."""
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
import uuid
from targets import validate


def remote(server, operation, request=None, ssh=None, image_archive=None, image_sha256=None):
    command = ([*ssh, 'qanda-deploy@' + server, operation] if ssh else
               ['tailscale', 'ssh', 'qanda-deploy@' + server, 'sudo -n /usr/local/sbin/qanda-deployctl ' + operation])
    body = dict(request or {})
    if image_archive:
        if not re.fullmatch(r'[0-9a-f]{64}', image_sha256 or ''):
            raise ValueError('The published image archive SHA-256 is missing')
        digest = hashlib.sha256()
        with open(image_archive, 'rb') as archive:
            for chunk in iter(lambda: archive.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != image_sha256:
            raise ValueError('The downloaded image archive failed SHA-256 verification')
        body['image_sha256'] = image_sha256
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr)
            transfer_complete = False
            try:
                process.stdin.write((json.dumps(body) + '\n').encode())
                with open(image_archive, 'rb') as archive:
                    shutil.copyfileobj(archive, process.stdin, 1024 * 1024)
                transfer_complete = True
            except BrokenPipeError:
                pass
            except Exception:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
                process.wait()
                raise
            finally:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
            returncode = process.wait()
            stdout.seek(0)
            stderr.seek(0)
            output, error_output = stdout.read(8192), stderr.read(8192)
            if returncode or not transfer_complete:
                raise subprocess.CalledProcessError(returncode or 1, command, output, error_output)
        return None
    result = subprocess.run(command,
                            input=None if request is None else (json.dumps(body) + '\n').encode(),
                            check=True, capture_output=True, timeout=45)
    return json.loads(result.stdout) if operation in ('status', 'release-logs') else None


def execute(server, action, ssh=None, image_archive=None, image_sha256=None):
    if os.environ.get('SOURCE_BUILD') == 'true':
        node = os.environ['DEPLOY_NODE']
        identifier = os.environ['OPERATION_ID']
        request = {'operation_id': identifier, 'role': node}
        if action == 'deploy':
            request.update(revision=os.environ['GITHUB_SHA'], token=os.environ['SOURCE_TOKEN'])
        try:
            remote(server, action, request, ssh=ssh)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
            if isinstance(error, subprocess.CalledProcessError) and error.returncode != 255:
                raise
            # A lost acknowledgement must never enqueue the release a second time.
        offset = 0
        for _ in range(420):
            try:
                status = remote(server, 'status', ssh=ssh)
                operation = status.get('operation') or {}
                if operation.get('operation_id') != identifier:
                    raise RuntimeError('Server operation identity does not match this run')
                logs = remote(server, 'release-logs', {'operation_id': identifier, 'offset': offset}, ssh=ssh)
                offset = logs['offset']
                delimiter = uuid.uuid4().hex
                print('::stop-commands::' + delimiter, flush=True)
                print(logs['text'], end='', flush=True)
                print('\n::' + delimiter + '::', flush=True)
                if action == 'deploy' and operation.get('revision') != request['revision']:
                    raise RuntimeError('Server operation revision does not match this run')
                if operation['phase'] == 'complete':
                    if status.get('current', {}).get('revision') != operation['revision']:
                        raise RuntimeError('Running revision does not match the completed operation')
                    return status
                if operation['phase'] in ('failed', 'rolled-back'):
                    raise RuntimeError('Server release failed: ' + operation['phase'])
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
                if isinstance(error, subprocess.CalledProcessError) and error.returncode != 255:
                    raise
            time.sleep(10)
    else:
        request = {'username': os.environ['GITHUB_ACTOR'], 'token': os.environ['REGISTRY_TOKEN']}
        if action == 'deploy':
            node = os.environ.get('DEPLOY_NODE', 'all')
            images = ('web',) if node == 'frontend' else ('backend',) if node == 'backend' else ('backend', 'web')
            request['release'] = {'revision': os.environ['GITHUB_SHA'], **{kind: os.environ[kind.upper()] for kind in images}}
        remote(server, action, request, ssh=ssh, image_archive=image_archive, image_sha256=image_sha256)
        for _ in range(300):
            try:
                status = remote(server, 'status', ssh=ssh)
            except subprocess.CalledProcessError as error:
                if error.returncode != 255:
                    raise
                time.sleep(10)
                continue
            phase = status['operation']['phase']
            if phase == 'complete':
                return status
            if phase in ('failed', 'rolled-back'):
                raise RuntimeError('Server release failed: ' + phase)
            time.sleep(10)
    raise RuntimeError('Server operation continues independently; inspect its status')


def main():
    targets = validate(json.loads(os.environ['DEPLOY_TARGETS']))
    selected = os.environ.get('DEPLOY_NODE', 'all')
    if selected not in ('all', 'frontend', 'backend'):
        raise ValueError('Unknown deployment node')
    if selected == 'all' and targets['frontend']['server'] != targets['backend']['server']:
        raise ValueError('Deploy split nodes separately through their owner management networks')
    node = targets['frontend' if selected == 'frontend' else 'backend']
    with tempfile.TemporaryDirectory(prefix='qanda-deploy-ssh-') as directory:
        ssh = None
        server = node['server']
        if selected != 'all':
            server = node['service_ip']
            key, known_hosts = Path(directory) / 'key', Path(directory) / 'known_hosts'
            for path, variable in ((key, 'DEPLOY_SSH_KEY'), (known_hosts, 'DEPLOY_SSH_KNOWN_HOSTS')):
                value = os.environ.get(variable, '')
                if not value.strip():
                    raise ValueError('The selected node requires an SSH key and verified host key')
                path.touch(mode=0o600)
                path.write_text(value.rstrip() + '\n')
            ssh = ['ssh', '-C', '-F', '/dev/null', '-p', '2222', '-i', str(key),
                   '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known_hosts),
                   '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlias=qanda-' + selected,
                   '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1']
        before = remote(server, 'status', ssh=ssh)
        if selected != 'all' and before.get('role') != selected:
            raise ValueError('The management target has a different deployment role')
        if os.environ.get('SOURCE_BUILD') == 'true' and before.get('source_build_protocol') != 1:
            raise ValueError('Install the source-build deployment controller on this node first')
        if os.environ['OPERATION'] == 'check':
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write(f'Node {selected}: Tailscale and restricted SSH connection verified; role `{before["role"]}`\n')
            return
        image_archive = os.environ.get('IMAGE_ARCHIVE') if os.environ['OPERATION'] == 'deploy' else None
        image_sha256 = os.environ.get('IMAGE_ARCHIVE_SHA256') if image_archive else None
        if os.environ['OPERATION'] == 'deploy' and selected == 'frontend' and not image_archive and os.environ.get('SOURCE_BUILD') != 'true':
            raise ValueError('The frontend deployment workflow did not provide its verified image archive')
        status = execute(server, os.environ['OPERATION'], ssh=ssh,
                         image_archive=image_archive, image_sha256=image_sha256)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'Node {selected}: {status["operation"]["phase"]}, revision `{status["current"]["revision"]}`\n\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(f'Deployment failed: {type(error).__name__}; inspect this node through its owner', file=sys.stderr)
        sys.exit(1)
