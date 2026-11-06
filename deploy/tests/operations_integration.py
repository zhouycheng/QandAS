#!/usr/bin/env python3
"""Verify the forced SSH command against disposable application containers."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import uuid

DEPLOY = Path(__file__).parents[1]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def main():
    if os.geteuid() != 0 or not Path('/usr/sbin/sshd').exists():
        raise RuntimeError('Use an isolated Linux Docker host with root access and OpenSSH server')
    prefix = 'qanda-ops-check-' + uuid.uuid4().hex[:8]
    server = None
    created_network = False
    created_container = False
    with tempfile.TemporaryDirectory(prefix=prefix, dir='/root') as directory:
        root = Path(directory)
        try:
            run('docker', 'network', 'create', prefix)
            created_network = True
            run('docker', 'run', '-d', '--name', prefix, '--network', prefix,
                '--label', 'com.docker.compose.project=' + prefix,
                '--label', 'com.docker.compose.service=web',
                '--label', 'com.docker.compose.oneoff=False', 'nginx:1.28-alpine')
            created_container = True
            config = root / 'config'
            config.mkdir()
            (config / 'node.json').write_text('{"role":"frontend"}')
            controller = root / 'deployctl'
            source = (DEPLOY / 'deployctl.py').read_text()
            source = source.replace("ROOT = Path('/srv/qanda')", f'ROOT = Path({str(config)!r})')
            source = source.replace("STATE = Path('/var/lib/qanda-deploy')", f'STATE = Path({str(root / "state")!r})')
            source = source.replace('qanda-application', prefix)
            controller.write_text(source)
            controller.chmod(0o755)
            entry = root / 'entry'
            source = (DEPLOY / 'remote-entry.py').read_text().replace('/usr/local/sbin/qanda-deployctl', str(controller))
            # A loopback-only root fixture avoids creating system users; its command rights remain qanda-debug.
            source = source.replace('pwd.getpwuid(os.getuid()).pw_name', "'qanda-debug'")
            entry.write_text(source)
            entry.chmod(0o755)
            for name in ('host', 'client'):
                run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(root / name))
            known = root / 'known_hosts'
            known.write_text('qanda-ops-test ' + (root / 'host.pub').read_text())
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            source = (DEPLOY / 'qanda-ops.sshd.conf').read_text()
            for old, new in {
                'ListenAddress 172.29.71.1': 'ListenAddress 127.0.0.1', 'Port 2203': f'Port {port}',
                '/etc/qanda/ssh_host_ed25519_key': str(root / 'host'), '/run/qanda-sshd.pid': str(root / 'pid'),
                'AllowUsers qanda-deploy qanda-debug': 'AllowUsers root', 'PermitRootLogin no': 'PermitRootLogin yes',
                '/etc/ssh/qanda-authorized-keys/%u': str(root / 'client.pub'),
                '/usr/local/lib/qanda/remote-entry.py': str(entry),
            }.items():
                source = source.replace(old, new)
            sshd_config = root / 'sshd.conf'
            sshd_config.write_text(source)
            Path('/run/sshd').mkdir(exist_ok=True)
            run('/usr/sbin/sshd', '-t', '-f', str(sshd_config))
            effective = run('/usr/sbin/sshd', '-T', '-f', str(sshd_config),
                            '-C', 'user=qanda-deploy,host=localhost,addr=127.0.0.1').stdout
            assert 'disableforwarding yes' in effective and 'permittty no' in effective
            ssh = ['ssh', '-F', '/dev/null', '-p', str(port), '-i', str(root / 'client'),
                   '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                   '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(known),
                   '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'HostKeyAlias=qanda-ops-test',
                   '-o', 'ConnectTimeout=2']
            with (root / 'sshd.log').open('w') as log:
                server = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(sshd_config)], stdout=log, stderr=log)
                for _ in range(20):
                    try:
                        status = run(*ssh, '-T', 'root@127.0.0.1', 'containers', timeout=10)
                        break
                    except subprocess.CalledProcessError:
                        if server.poll() is not None:
                            raise RuntimeError('Isolated SSH server exited')
                        time.sleep(0.5)
                else:
                    raise RuntimeError('Isolated SSH authentication did not become ready')
                assert json.loads(status.stdout)[0]['service'] == 'web'
                shell = run(*ssh, '-T', 'root@127.0.0.1', 'shell web', input='printf CONTAINER_OK', timeout=10)
                assert shell.stdout == 'CONTAINER_OK'
                run(*ssh, '-T', 'root@127.0.0.1', 'logs web', timeout=10)
                run(*ssh, '-T', 'root@127.0.0.1', 'restart web', timeout=20)
                for command in ('whoami', 'docker ps', 'deploy', 'shell api', 'shell web --privileged', 'logs web; whoami', 'internal-sftp'):
                    result = subprocess.run([*ssh, '-T', 'root@127.0.0.1', command], capture_output=True, timeout=10)
                    assert result.returncode != 0, command
                forward = subprocess.run([*ssh, '-W', f'127.0.0.1:{port}', 'root@127.0.0.1'], capture_output=True, timeout=10)
                assert forward.returncode != 0
            print('PASS: scoped SSH logs, container shell and restart; host commands, other roles, deployment, SFTP and forwarding rejected')
        finally:
            if server:
                server.terminate()
                server.wait(timeout=10)
            if created_container:
                run('docker', 'rm', '-f', prefix)
            if created_network:
                run('docker', 'network', 'rm', prefix)


if __name__ == '__main__':
    main()
