#!/usr/bin/env python3
"""Apply one private topology file through administrator Tailscale SSH and GitHub secrets."""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import shlex
import subprocess
import business_gateway

TAILSCALE_IMAGE = 'tailscale/tailscale@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c'


def validate(targets):
    if set(targets) != {'frontend', 'backend'}:
        raise ValueError('Expected frontend and backend targets')
    for kind, node in targets.items():
        fields = {'server', 'admin_user', 'service_ip', 'public_ip' if kind == 'frontend' else 'public_api_url'}
        if not {'server', 'admin_user'} <= set(node) or set(node) - fields:
            raise ValueError('Unexpected deployment target fields')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}', node['server']):
            raise ValueError('Invalid Tailscale hostname or IPv4 address')
        if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', node['admin_user']):
            raise ValueError('Invalid administrator username')
        if 'service_ip' in node and ipaddress.ip_address(node['service_ip']) not in ipaddress.ip_network('100.64.0.0/10'):
            raise ValueError('Operations addresses must be Tailscale IPv4 addresses')
    if targets['frontend']['server'] != targets['backend']['server']:
        if not all('service_ip' in node for node in targets.values()):
            raise ValueError('Split nodes require project container service_ip addresses')
        business_gateway.client_address(targets['frontend'].get('public_ip', ''))
        business_gateway.endpoint(targets['backend'].get('public_api_url'))
    return targets


def node_configuration(targets, kind, gateway_key=None):
    split = targets['frontend']['server'] != targets['backend']['server']
    if not split:
        return {'role': 'combined', 'env': '\n'}
    frontend = kind == 'frontend'
    values = {
        'TAILNET_NODE_ROLE': kind,
        'TAILNET_NODE_IP': targets[kind]['service_ip'],
        'TAILSCALE_IMAGE': TAILSCALE_IMAGE,
        'TAILNET_TAG_ARGS': '' if frontend else '--advertise-tags=tag:qanda-backend',
        'PUBLIC_GATEWAY_KEY': business_gateway.gateway_key(gateway_key),
    }
    if frontend:
        origin = business_gateway.endpoint(targets['backend']['public_api_url'])
        values.update(PRODUCTION_API_UPSTREAM=origin, PRODUCTION_MONITOR_UPSTREAM=origin)
    else:
        values.update(PUBLIC_GATEWAY_ALLOWED_CLIENT=business_gateway.client_address(targets['frontend']['public_ip']),
                      PRODUCTION_TRUSTED_PROXIES=r'172\.29\.71\.30')
    return {'role': kind, 'env': ''.join(f'{k}={v}\n' for k, v in values.items())}


def configure(path, output=None, gateway_key_file=None):
    if path.stat().st_mode & 0o077:
        raise ValueError('The private topology file must have mode 0600')
    targets = validate(json.loads(path.read_text()))
    frontend, backend = targets['frontend'], targets['backend']
    split = frontend['server'] != backend['server']
    key = None
    if split:
        if (gateway_key_file is None or gateway_key_file.is_symlink() or not gateway_key_file.is_file()
                or gateway_key_file.stat().st_mode & 0o077):
            raise ValueError('Use a mode-0600 gateway key file outside the repository')
        key = business_gateway.gateway_key(gateway_key_file.read_text().strip())
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
        payload = node_configuration(targets, kind, key)
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
    subprocess.run(['gh', 'secret', 'set', 'DEPLOY_TARGETS', '--repo', 'zhouycheng/QandAS'],
                   input=json.dumps(targets).encode(), check=True, capture_output=True)
    print('Private deployment targets synchronized; provision new nodes before running the deployment')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('targets', type=Path)
    parser.add_argument('--render', type=Path, help='Render private files for independent administrator installation')
    parser.add_argument('--gateway-key-file', type=Path, help='Private shared gateway key file, mode 0600')
    args = parser.parse_args()
    configure(args.targets, args.render, args.gateway_key_file)
