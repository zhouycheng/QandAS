#!/usr/bin/env python3
"""Exercise project gateways and scoped host firewall rules with disposable containers."""
import importlib.util
import http.server
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.request
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
    event_server = None
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

    def start(suffix, net, config=None, address=None, env=None, port=None, hardened=False, templates=None, files=None, alias=None):
        name = prefix + '-' + suffix
        args = ['create', '--name', name, '--network', net]
        if address:
            args += ['--ip', address]
        if alias:
            args += ['--network-alias', alias]
        if port:
            args += ['-p', port]
        if hardened:
            args += ['--user', '101:101', '--cap-drop', 'ALL', '--read-only', '--security-opt', 'no-new-privileges:true']
            for directory in ('/etc/nginx/conf.d', '/var/cache/nginx', '/var/run'):
                args += ['--tmpfs', directory + ':uid=101,gid=101,mode=0755']
        for key, value in (env or {}).items():
            args += ['-e', f'{key}={value}']
        if config:
            templates = {'default.conf': config, **(templates or {})}
        for target, content in (templates or {}).items():
            path = Path(temporary.name) / (suffix + '-' + target)
            path.write_text(content)
            path.chmod(0o644)
            args += ['-v', str(path) + f':/etc/nginx/templates/{target}.template:ro']
        for source, target in (files or {}).items():
            args += ['-v', str(source) + ':' + target + ':ro']
        docker(*args, image)
        names.append(name)
        docker('start', name)
        return name

    def get(source, url, headers=()):
        args = ['exec', source, 'wget', '-T', '2', '-q', '-O', '-']
        for header in headers:
            args += ['--header', header]
        return docker(*args, url)

    def blocked(source, url, headers=()):
        try:
            get(source, url, headers)
        except subprocess.CalledProcessError:
            return
        raise AssertionError('An isolated destination was reachable')

    try:
        docker('image', 'inspect', image)
        app, info = network('app')
        other, other_info = network('other')
        subnet = ipaddress.ip_network(info['IPAM']['Config'][0]['Subnet'])
        ip = lambda number: str(subnet.network_address + number)
        host_ip = info['IPAM']['Config'][0]['Gateway']
        bridge = info.get('Options', {}).get('com.docker.network.bridge.name') or 'br-' + info['Id'][:12]
        bridges.append(bridge)
        root = Path(temporary.name)
        root.chmod(0o755)
        certificate, key = root / 'certificate.pem', root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=backend.test', '-addext', 'subjectAltName=DNS:backend.test',
                        '-keyout', str(key), '-out', str(certificate)], check=True, capture_output=True)
        certificate.chmod(0o644)
        key.chmod(0o644)  # Disposable fixture; the hardened gateway runs as UID 101.
        api_conf = '''server { listen 8083;
            location = /api/v1/health {
                if ($http_authorization != '') { return 409; }
                if ($http_cookie != '') { return 409; }
                if ($args != '') { return 409; }
                return 200 "API:$http_x_forwarded_for:$http_x_qanda_gateway_key";
            }
            location / { return 200 "API:$http_x_forwarded_for:$http_x_qanda_gateway_key"; }
        }'''
        event_requests = []
        class Events(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def do_GET(self):
                event_requests.append({'path': self.path, 'authorization': self.headers.get('Authorization'),
                                       'cookie': self.headers.get('Cookie'), 'gateway_key': self.headers.get('X-Qanda-Gateway-Key')})
                self.send_response(200)
                if self.path == '/api/v1/health':
                    self.send_header('Content-Length', '15')
                    self.end_headers()
                    self.wfile.write(b'{"status":"UP"}')
                    return
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Transfer-Encoding', 'chunked')
                self.end_headers()
                for index, event in enumerate((b'data: first\n\n', b'data: second\n\n')):
                    if index:
                        time.sleep(4)
                    self.wfile.write(f'{len(event):x}\r\n'.encode() + event + b'\r\n')
                    self.wfile.flush()
                self.wfile.write(b'0\r\n\r\n')

            def do_POST(self):
                event_requests.append({'path': self.path, 'unexpected_post': True})
                self.send_error(405)

            def log_message(self, *args):
                pass

        event_server = http.server.ThreadingHTTPServer((host_ip, 0), Events)
        threading.Thread(target=event_server.serve_forever, daemon=True).start()
        monitor_conf = f'''server {{ listen 8083;
            location = /api/v1/admin/monitoring/sync/stream {{
                proxy_pass http://{host_ip}:{event_server.server_port}; proxy_buffering off;
            }}
            location / {{ return 200 "MONITOR:$http_x_qanda_gateway_key"; }}
        }}'''
        start('api', app, api_conf, ip(40))
        start('monitor', app, monitor_conf, ip(41))
        gateway_key = 'a' * 64
        routes = (DEPLOY / 'public-gateway-routes.inc').read_text().replace('http://api:8083', f'http://{ip(40)}:8083').replace('http://monitor:8083', f'http://{ip(41)}:8083')
        backend = start('backend', app, (DEPLOY / 'public-gateway.conf').read_text(), ip(21), {
            'QANDA_GATEWAY_ALLOWED_CLIENT': ip(10), 'QANDA_GATEWAY_KEY': gateway_key,
        }, hardened=True, alias='backend.test', templates={
            'gateway-routes.inc': routes, 'https.conf': (DEPLOY / 'public-gateway-https.conf').read_text(),
        }, files={certificate: '/etc/qanda/tls/fullchain.pem', key: '/etc/qanda/tls/privkey.pem'})
        web_conf = (DEPLOY / 'web.conf').read_text()
        web = start('web', app, web_conf.replace('/etc/ssl/cert.pem', '/fixture/ca.pem'), ip(10), {
            'QANDA_API_UPSTREAM': 'https://backend.test:8443', 'QANDA_MONITOR_UPSTREAM': 'https://backend.test:8443',
            'QANDA_GATEWAY_KEY': gateway_key,
        }, files={certificate: '/fixture/ca.pem'})
        edge_conf = f'''server {{ listen 8080; location / {{
            proxy_pass http://{ip(10)}:8080; proxy_set_header X-Forwarded-For $remote_addr;
            proxy_http_version 1.1; proxy_set_header Connection ''; proxy_buffering off;
        }} }}'''
        start('frontend', app, edge_conf, ip(20), port='127.0.0.1:38193:8080')
        member = start('member', app, address=ip(11))
        control = start('control', other)
        host = start('host-canary', 'host', 'server { listen 38191; location / { return 200 "HOST"; } }')
        start('other-project', other, 'server { listen 80; location / { return 200 "OTHER"; } }', port='38192:80')
        other_host = other_info['IPAM']['Config'][0]['Gateway']
        for _ in range(30):
            try:
                assert get(member, f'http://{ip(20)}:8080/api/v1/health', ['X-Forwarded-For: 203.0.113.99']) == 'API:' + ip(11) + ':'
                break
            except (subprocess.CalledProcessError, AssertionError):
                time.sleep(1)
        else:
            raise AssertionError('Gateway chain did not become ready')
        assert get(web, f'http://{ip(21)}:8080/api/v1/health') == 'API::'
        assert get(member, f'http://{ip(20)}:8080/api/v1/health?token=fixture',
                   ['Authorization: Bearer fixture', 'Cookie: session=fixture', 'X-Qanda-Gateway-Key: fixture']) == 'API:' + ip(11) + ':'
        assert get(member, f'http://{ip(20)}:8080/api/v1/catalog', ['X-Qanda-Gateway-Key: forged']) == 'API:' + ip(11) + ':'
        assert get(member, f'http://{ip(20)}:8080/api/v1/admin/statistics/activity') == 'MONITOR:'
        blocked(web, f'http://{ip(21)}:8080/api/v1/catalog')
        blocked(web, f'http://{ip(21)}:8080/api/v1/catalog', ['X-Qanda-Gateway-Key: ' + gateway_key])
        blocked(web, f'http://{ip(21)}:8080/api/v1/admin/statistics/activity', ['X-Qanda-Gateway-Key: wrong'])
        blocked(member, f'http://{ip(21)}:8080/api/v1/health')
        blocked(member, f'http://{ip(21)}:8080/api/v1/catalog', ['X-Qanda-Gateway-Key: ' + gateway_key])
        docker('exec', web, 'test', '-s', '/etc/ssl/cert.pem')
        untrusted = start('untrusted-web', 'container:' + web, web_conf.replace('listen 8080;', 'listen 8086;'), env={
            'QANDA_API_UPSTREAM': 'https://backend.test:8443', 'QANDA_MONITOR_UPSTREAM': 'https://backend.test:8443',
            'QANDA_GATEWAY_KEY': gateway_key,
        })
        for _ in range(30):
            try:
                get(untrusted, 'http://127.0.0.1:8086/healthz')
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        blocked(untrusted, 'http://127.0.0.1:8086/api/v1/health')
        diagnostic = subprocess.run(['docker', 'logs', untrusted], check=True, capture_output=True)
        assert b'upstream SSL certificate verify error' in diagnostic.stdout + diagnostic.stderr
        staging = start('staging-web', 'container:' + web, web_conf.replace('listen 8080;', 'listen 8087;'), env={
            'QANDA_API_UPSTREAM': f'http://{host_ip}:{event_server.server_port}',
            'QANDA_MONITOR_UPSTREAM': f'http://{host_ip}:{event_server.server_port}', 'QANDA_GATEWAY_KEY': gateway_key,
        })
        for _ in range(30):
            try:
                get(staging, 'http://127.0.0.1:8087/healthz')
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        assert get(staging, 'http://127.0.0.1:8087/api/v1/health?token=fixture',
                   ['Authorization: Bearer fixture', 'Cookie: session=fixture', 'X-Qanda-Gateway-Key: fixture']) == '{"status":"UP"}'
        assert event_requests[-1] == {'path': '/api/v1/health', 'authorization': None, 'cookie': None, 'gateway_key': None}
        count = len(event_requests)
        login = subprocess.run(['docker', 'exec', staging, 'wget', '-T', '2', '-q', '-O', '-',
                                '--post-data', '{"password":"fixture"}', '--header', 'Authorization: Bearer fixture',
                                'http://127.0.0.1:8087/api/v1/admin/login'], capture_output=True)
        assert login.returncode != 0 and len(event_requests) == count, 'Staging forwarded credentials over HTTP'
        blocked(staging, 'http://127.0.0.1:8087/api/v1/admin/monitoring/sync/stream')
        assert len(event_requests) == count
        combined = start('combined-web', app, web_conf.replace('listen 8080;', 'listen 8088;'), env={
            'QANDA_API_UPSTREAM': f'http://{ip(40)}:8083', 'QANDA_MONITOR_UPSTREAM': f'http://{ip(41)}:8083',
            'QANDA_GATEWAY_KEY': '',
        })
        for _ in range(30):
            try:
                assert get(combined, 'http://127.0.0.1:8088/api/v1/catalog') == 'API::'
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        else:
            raise AssertionError('Combined deployment internal HTTP route changed')
        started = time.monotonic()
        with urllib.request.urlopen('http://127.0.0.1:38193/api/v1/admin/monitoring/sync/stream', timeout=12) as stream:
            assert stream.headers['Content-Type'] == 'text/event-stream'
            assert stream.readline() == b'data: first\n'
            assert time.monotonic() - started < 3, 'SSE first event was buffered'
            assert b'data: second' in stream.read()
        assert get(member, f'http://{host_ip}:38191') == 'HOST'
        assert get(member, f'http://{host_ip}:38192') == 'OTHER'
        guard.enforce(bridges, [str(subnet)])
        guard.enforce(bridges, [str(subnet)], check=True)
        blocked(member, f'http://{host_ip}:38191')
        blocked(member, f'http://{host_ip}:38192')
        assert get(control, f'http://{other_host}:38191') == 'HOST'
        assert get(control, f'http://{other_host}:38192') == 'OTHER'
        assert get(member, f'http://{ip(20)}:8080/api/v1/health') == 'API:' + ip(11) + ':'
        print('PASS: sanitized HTTP health staging; no HTTP credential forwarding; verified HTTPS; combined internal HTTP; gateway credential enforcement and stripping; API and monitoring routing; SSE streaming; source and host isolation')
    except Exception:
        for name in names:
            result = subprocess.run(['docker', 'logs', '--tail', '5', name], capture_output=True)
            print(name + ': ' + (result.stdout + result.stderr).decode(errors='replace'), flush=True)
        raise
    finally:
        if event_server:
            event_server.shutdown()
            event_server.server_close()
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
