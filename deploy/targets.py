#!/usr/bin/env python3
"""Apply one private topology file through administrator Tailscale SSH and GitHub secrets."""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import shlex
import subprocess

TAILSCALE_IMAGE = 'tailscale/tailscale@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c'


def validate(targets):
    if set(targets) != {'frontend', 'backend'}:
        raise ValueError('Expected frontend and backend targets')
    for node in targets.values():
        if not {'server', 'admin_user'} <= set(node) or set(node) - {'server', 'admin_user', 'service_ip', 'peer_ip'}:
            raise ValueError('Expected server, admin_user and optional project service_ip/peer_ip')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}', node['server']):
            raise ValueError('Invalid Tailscale hostname or IPv4 address')
        if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', node['admin_user']):
            raise ValueError('Invalid administrator username')
        for field in ('service_ip', 'peer_ip'):
            if field in node and ipaddress.ip_address(node[field]) not in ipaddress.ip_network('100.64.0.0/10'):
                raise ValueError('Project addresses must be Tailscale IPv4 addresses')
    if targets['frontend']['server'] != targets['backend']['server']:
        if not all('service_ip' in node for node in targets.values()):
            raise ValueError('Split nodes require project container service_ip addresses')
        for local, peer in (('frontend', 'backend'), ('backend', 'frontend')):
            if targets[local]['service_ip'] == targets[peer].get('peer_ip', targets[peer]['service_ip']):
                raise ValueError('The peer address must differ from the local container address')
    return targets


def node_configuration(targets, kind):
    split = targets['frontend']['server'] != targets['backend']['server']
    if not split:
        return {'role': 'combined', 'env': '\n'}
    frontend = kind == 'frontend'
    backend_ip = targets['backend'].get('peer_ip', targets['backend']['service_ip'])
    values = {
        'TAILNET_NODE_ROLE': kind,
        'TAILNET_NODE_IP': targets[kind]['service_ip'],
        'TAILSCALE_IMAGE': TAILSCALE_IMAGE,
        # Cross-tailnet shares are visible only to user-owned recipient nodes.
        'TAILNET_TAG_ARGS': '' if frontend else '--advertise-tags=tag:qanda-backend',
        'TAILNET_ALLOWED_CLIENT': '172.29.71.10' if frontend else targets['frontend'].get('peer_ip', targets['frontend']['service_ip']),
        'TAILNET_API_UPSTREAM': f'http://{backend_ip}:18084' if frontend else 'http://api:8083',
        'TAILNET_MONITOR_UPSTREAM': f'http://{backend_ip}:18085' if frontend else 'http://monitor:8083',
        'PRODUCTION_API_UPSTREAM': 'http://qanda-tailnet:18084',
        'PRODUCTION_MONITOR_UPSTREAM': 'http://qanda-tailnet:18085',
        'PRODUCTION_TRUSTED_PROXIES': r'172\.29\.71\.20',
    }
    return {'role': kind, 'env': ''.join(f'{k}={v}\n' for k, v in values.items())}


def configure(path, output=None):
    if path.stat().st_mode & 0o077:
        raise ValueError('The private topology file must have mode 0600')
    targets = validate(json.loads(path.read_text()))
    frontend, backend = targets['frontend'], targets['backend']
    split = frontend['server'] != backend['server']
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
        payload = node_configuration(targets, kind)
        if output:
            destination = output / kind
            destination.mkdir(parents=True, exist_ok=True, mode=0o700)
            for name, value in [('node.json', json.dumps({'role': payload['role']})), ('node.env', payload['env'])]:
                target = destination / name
                target.touch(mode=0o600, exist_ok=True)
                target.chmod(0o600)
                target.write_text(value)
            continue
        subprocess.run(['tailscale', 'ssh', node['admin_user'] + '@' + node['server'],
                        'sudo -n python3 -c ' + shlex.quote(commands)],
                       input=json.dumps(payload).encode(), check=True, capture_output=True)
    if output:
        print('Private node configuration rendered; install it through each owner’s management channel')
        return
    subprocess.run(['gh', 'secret', 'set', 'DEPLOY_TARGETS', '--repo', 'zhouycheng/QandA'],
                   input=json.dumps(targets).encode(), check=True, capture_output=True)
    print('Private deployment targets synchronized; provision new nodes before running the deployment')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('targets', type=Path)
    parser.add_argument('--render', type=Path, help='Render private files for independent administrator installation')
    args = parser.parse_args()
    configure(args.targets, args.render)
