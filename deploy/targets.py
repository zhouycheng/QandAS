#!/usr/bin/env python3
"""Apply one private topology file through administrator Tailscale SSH and GitHub secrets."""
import ipaddress
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys


def validate(targets):
    if set(targets) != {'frontend', 'backend'}:
        raise ValueError('Expected frontend and backend targets')
    for node in targets.values():
        if set(node) != {'server', 'admin_user'}:
            raise ValueError('Expected server and admin_user')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}', node['server']):
            raise ValueError('Invalid Tailscale hostname or IPv4 address')
        if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', node['admin_user']):
            raise ValueError('Invalid administrator username')
    return targets


def configure(path):
    if path.stat().st_mode & 0o077:
        raise ValueError('The private topology file must have mode 0600')
    targets = validate(json.loads(path.read_text()))
    frontend, backend = targets['frontend'], targets['backend']
    split = frontend['server'] != backend['server']
    if split:
        result = subprocess.run(['tailscale', 'ssh', backend['admin_user'] + '@' + backend['server'], 'tailscale ip -4'],
                                check=True, capture_output=True, text=True)
        address = str(ipaddress.ip_address(result.stdout.strip()))
        if ipaddress.ip_address(address) not in ipaddress.ip_network('100.64.0.0/10'):
            raise ValueError('Backend binding must be a Tailscale IPv4 address')
    commands = '''import sys,json,os
from pathlib import Path
data=json.load(sys.stdin)
root=Path('/srv/qanda')
root.mkdir(mode=0o755,exist_ok=True)
for name,content in [('node.json',json.dumps({'role':data['role']})),('node.env',data['env'])]:
 p=root/(name+'.tmp');p.write_text(content);p.chmod(0o600);os.replace(p,root/name)
'''
    for kind, node in targets.items():
        if not split and kind == 'frontend':
            continue
        values = []
        if split:
            values = [f'TAILNET_BIND_ADDRESS={address}', f'PRODUCTION_API_UPSTREAM=http://{address}:18084',
                      f'PRODUCTION_MONITOR_UPSTREAM=http://{address}:18085']
        payload = {'role': kind if split else 'combined', 'env': '\n'.join(values) + '\n'}
        subprocess.run(['tailscale', 'ssh', node['admin_user'] + '@' + node['server'],
                        'sudo -n python3 -c ' + shlex.quote(commands)],
                       input=json.dumps(payload).encode(), check=True, capture_output=True)
    subprocess.run(['gh', 'secret', 'set', 'DEPLOY_TARGETS', '--repo', 'zhouycheng/QandA'],
                   input=json.dumps(targets).encode(), check=True, capture_output=True)
    print('Private deployment targets synchronized; provision new nodes before running the deployment')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Usage: targets.py PRIVATE_TARGETS.json')
    configure(Path(sys.argv[1]))
