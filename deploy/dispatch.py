#!/usr/bin/env python3
"""Dispatch one verified release to backend then frontend over Tailscale SSH."""
import json
import os
import subprocess
import time
from targets import validate


def remote(server, operation, request=None):
    result = subprocess.run(['tailscale', 'ssh', 'qanda-deploy@' + server,
                             'sudo -n /usr/local/sbin/qanda-deployctl ' + operation],
                            input=None if request is None else json.dumps(request).encode(),
                            check=True, capture_output=True)
    return json.loads(result.stdout) if operation == 'status' else None


def execute(server, action):
    request = {'username': os.environ['GITHUB_ACTOR'], 'token': os.environ['REGISTRY_TOKEN']}
    if action == 'deploy':
        request['release'] = {'revision': os.environ['GITHUB_SHA'], 'backend': os.environ['BACKEND'], 'web': os.environ['WEB']}
    remote(server, action, request)
    for _ in range(150):
        status = remote(server, 'status')
        phase = status['operation']['phase']
        if phase == 'complete':
            return status
        if phase in ('failed', 'rolled-back'):
            raise RuntimeError('Server release failed: ' + phase)
        time.sleep(10)
    raise RuntimeError('Server operation continues independently; inspect its status')


def main():
    targets = validate(json.loads(os.environ['DEPLOY_TARGETS']))
    servers = list(dict.fromkeys(targets[k]['server'] for k in ('backend', 'frontend')))
    completed = []
    try:
        for index, server in enumerate(servers):
            previous = remote(server, 'status')['current']
            status = execute(server, os.environ['OPERATION'])
            completed.append((server, previous))
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
                summary.write(f'Node {index + 1}: {status["operation"]["phase"]}, revision `{status["current"]["revision"]}`\n\n')
    except Exception:
        if os.environ['OPERATION'] == 'deploy':
            for server, previous in reversed(completed):
                if previous:
                    execute(server, 'rollback')
        raise


if __name__ == '__main__':
    main()
