#!/usr/bin/env python3
"""Exercise project gateways and scoped host firewall rules with disposable containers."""
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

DEPLOY = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('guard', DEPLOY / 'network-guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Run in an isolated Linux Docker host as administrator')
    for binary in ('iptables', 'ip6tables'):
        for chain in guard.CHAINS:
            if subprocess.run([binary, '-S', chain], capture_output=True).returncode == 0:
                raise RuntimeError('Existing project firewall found; use an isolated test host')
    prefix = 'qanda-isolation-check-' + uuid.uuid4().hex[:8]
    names, networks, bridges = [], [], []
    temporary = tempfile.TemporaryDirectory(prefix=prefix)
    image = 'nginx:1.28-alpine'

    def docker(*args, **kwargs):
        return subprocess.run(['docker', *args], check=True, capture_output=True, **kwargs).stdout.decode().strip()

    def network(suffix):
        name = prefix + '-' + suffix
        docker('network', 'create', name)
        networks.append(name)
        value = json.loads(docker('network', 'inspect', name))[0]
        return name, value

    def start(suffix, net, config=None, address=None, env=None, port=None, hardened=False):
        name = prefix + '-' + suffix
        args = ['create', '--name', name, '--network', net]
        if address:
            args += ['--ip', address]
        if port:
            args += ['-p', port]
        if hardened:
            args += ['--user', '101:101', '--cap-drop', 'ALL', '--read-only', '--security-opt', 'no-new-privileges:true']
            for directory in ('/etc/nginx/conf.d', '/var/cache/nginx', '/var/run'):
                args += ['--tmpfs', directory + ':uid=101,gid=101,mode=0755']
        for key, value in (env or {}).items():
            args += ['-e', f'{key}={value}']
        if config:
            path = Path(temporary.name) / (suffix + '.conf')
            path.write_text(config)
            path.chmod(0o644)
            args += ['-v', str(path) + ':/etc/nginx/templates/default.conf.template:ro']
        docker(*args, image)
        names.append(name)
        docker('start', name)
        return name

    def get(source, url, headers=()):
        args = ['exec', source, 'wget', '-T', '2', '-q', '-O', '-']
        for header in headers:
            args += ['--header', header]
        return docker(*args, url)

    def blocked(source, url):
        try:
            get(source, url)
        except subprocess.CalledProcessError:
            return
        raise AssertionError('An isolated destination was reachable')

    try:
        docker('image', 'inspect', image)
        app, info = network('app')
        other, other_info = network('other')
        subnet = ipaddress.ip_network(info['IPAM']['Config'][0]['Subnet'])
        ip = lambda number: str(subnet.network_address + number)
        bridge = info.get('Options', {}).get('com.docker.network.bridge.name') or 'br-' + info['Id'][:12]
        bridges.append(bridge)
        api_conf = 'server { listen 8083; location / { return 200 "API:$http_x_forwarded_for"; } }'
        monitor_conf = 'server { listen 8083; location / { return 200 "MONITOR"; } }'
        start('api', app, api_conf, ip(30))
        start('monitor', app, monitor_conf, ip(31))
        start('backend', app, (DEPLOY / 'tailnet-backend.conf').read_text(), ip(21), {
            'TAILNET_ALLOWED_CLIENT': ip(20), 'TAILNET_API_UPSTREAM': f'http://{ip(30)}:8083',
            'TAILNET_MONITOR_UPSTREAM': f'http://{ip(31)}:8083',
        }, hardened=True)
        front_conf = (DEPLOY / 'tailnet-frontend.conf').read_text().replace('http://web:8080', f'http://{ip(10)}:8080')
        start('frontend', app, front_conf, ip(20), {
            'TAILNET_ALLOWED_CLIENT': ip(10), 'TAILNET_API_UPSTREAM': f'http://{ip(21)}:18084',
            'TAILNET_MONITOR_UPSTREAM': f'http://{ip(21)}:18085',
        }, hardened=True)
        start('web', app, (DEPLOY / 'web.conf').read_text(), ip(10), {
            'QANDA_API_UPSTREAM': f'http://{ip(20)}:18084', 'QANDA_MONITOR_UPSTREAM': f'http://{ip(20)}:18085',
        })
        member = start('member', app, address=ip(11))
        control = start('control', other)
        host = start('host-canary', 'host', 'server { listen 38191; location / { return 200 "HOST"; } }')
        start('other-project', other, 'server { listen 80; location / { return 200 "OTHER"; } }', port='38192:80')
        host_ip = info['IPAM']['Config'][0]['Gateway']
        other_host = other_info['IPAM']['Config'][0]['Gateway']
        for _ in range(30):
            try:
                assert get(member, f'http://{ip(20)}:8080/api/v1/health', ['X-Forwarded-For: 203.0.113.99']) == 'API:' + ip(11)
                break
            except (subprocess.CalledProcessError, AssertionError):
                time.sleep(1)
        else:
            raise AssertionError('Gateway chain did not become ready')
        assert get(member, f'http://{ip(20)}:8080/api/v1/admin/monitoring/sync/stream') == 'MONITOR'
        blocked(member, f'http://{ip(21)}:18084/api/v1/health')
        blocked(member, f'http://{ip(20)}:18084/api/v1/health')
        assert get(member, f'http://{host_ip}:38191') == 'HOST'
        assert get(member, f'http://{host_ip}:38192') == 'OTHER'
        guard.enforce(bridges, [str(subnet)])
        guard.enforce(bridges, [str(subnet)], check=True)
        blocked(member, f'http://{host_ip}:38191')
        blocked(member, f'http://{host_ip}:38192')
        assert get(control, f'http://{other_host}:38191') == 'HOST'
        assert get(control, f'http://{other_host}:38192') == 'OTHER'
        assert get(member, f'http://{ip(20)}:8080/api/v1/health') == 'API:' + ip(11)
        print('PASS: API and monitoring routing; forwarded-header overwrite; source restrictions; host and other-project isolation; unrelated network access preserved')
    finally:
        for binary, parent in (('iptables', 'DOCKER-USER'), ('ip6tables', 'FORWARD')):
            for bridge in bridges:
                for chain, destination in (('INPUT', 'QANDA-HOST'), (parent, 'QANDA-EGRESS')):
                    subprocess.run([binary, '-w', '5', '-D', chain, '-i', bridge, '-j', destination], capture_output=True)
            for chain in guard.CHAINS:
                subprocess.run([binary, '-w', '5', '-F', chain], capture_output=True)
                subprocess.run([binary, '-w', '5', '-X', chain], capture_output=True)
        for name in reversed(names):
            docker('rm', '-f', name)
        for name in reversed(networks):
            docker('network', 'rm', name)
        temporary.cleanup()


if __name__ == '__main__':
    main()
