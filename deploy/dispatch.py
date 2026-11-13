#!/usr/bin/env python3
"""Deploy one verified release through the selected node owner's management network."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid
from targets import validate


def remote(server, operation, request=None, ssh=None):
    command = [*ssh, 'qanda-deploy@' + server, operation]
    result = subprocess.run(command,
                            input=None if request is None else (json.dumps(request) + '\n').encode(),
                            check=True, capture_output=True, timeout=45)
    return json.loads(result.stdout) if operation in ('status', 'release-logs') else None


def execute(server, action, ssh=None):
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
    raise RuntimeError('Server operation continues independently; inspect its status')


def main():
    targets = validate(json.loads(os.environ['DEPLOY_TARGETS']))
    selected = os.environ['DEPLOY_NODE']
    if selected not in ('frontend', 'backend'):
        raise ValueError('Unknown deployment node')
    node = targets[selected]
    with tempfile.TemporaryDirectory(prefix='qanda-deploy-ssh-') as directory:
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
        if before.get('role') != selected:
            raise ValueError('The management target has a different deployment role')
        if before.get('source_build_protocol') != 1:
            raise ValueError('Install the source-build deployment controller on this node first')
        if os.environ['OPERATION'] == 'check':
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write(f'Node {selected}: Tailscale and restricted SSH connection verified; role `{before["role"]}`\n')
            return
        status = execute(server, os.environ['OPERATION'], ssh=ssh)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'Node {selected}: {status["operation"]["phase"]}, revision `{status["current"]["revision"]}`\n\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as error:
        output = error.stderr or b''
        if isinstance(output, bytes):
            output = output.decode(errors='replace')
        message = next((line.strip() for line in output.splitlines()
                        if line.startswith('qanda-deployctl: ')), '')
        if message:
            print(f'Deployment failed (exit {error.returncode}): {message}', file=sys.stderr)
        else:
            print(f'Deployment command failed with exit code {error.returncode}; no safe server message was returned', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print(f'Deployment failed: {type(error).__name__}; inspect this node through its owner', file=sys.stderr)
        sys.exit(1)
