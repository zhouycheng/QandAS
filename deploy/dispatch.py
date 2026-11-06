#!/usr/bin/env python3
"""Deploy one verified release through the selected node owner's management network."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from targets import validate


def remote(server, operation, request=None, ssh=None):
    command = ([*ssh, 'qanda-deploy@' + server, operation] if ssh else
               ['tailscale', 'ssh', 'qanda-deploy@' + server, 'sudo -n /usr/local/sbin/qanda-deployctl ' + operation])
    result = subprocess.run(command,
                            input=None if request is None else json.dumps(request).encode(),
                            check=True, capture_output=True)
    return json.loads(result.stdout) if operation == 'status' else None


def execute(server, action, ssh=None):
    request = {'username': os.environ['GITHUB_ACTOR'], 'token': os.environ['REGISTRY_TOKEN']}
    if action == 'deploy':
        node = os.environ.get('DEPLOY_NODE', 'all')
        images = ('web',) if node == 'frontend' else ('backend',) if node == 'backend' else ('backend', 'web')
        request['release'] = {'revision': os.environ['GITHUB_SHA'], **{kind: os.environ[kind.upper()] for kind in images}}
    remote(server, action, request, ssh=ssh)
    for _ in range(150):
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
            ssh = ['ssh', '-F', '/dev/null', '-p', '2222', '-i', str(key),
                   '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known_hosts),
                   '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlias=qanda-' + selected,
                   '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1']
        before = remote(server, 'status', ssh=ssh)
        if selected != 'all' and before.get('role') != selected:
            raise ValueError('The management target has a different deployment role')
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
    except Exception as error:
        print(f'Deployment failed: {type(error).__name__}; inspect this node through its owner', file=sys.stderr)
        sys.exit(1)
