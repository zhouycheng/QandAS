"""Provision temporary test data while preserving the original project services."""
import argparse
import json
import os
from pathlib import Path
import pty
import secrets
import select
import shlex
import subprocess
import time

from client import Lease, Remote, private_json, smoke
import seed


def bootstrap(remote):
    auth = {'username': 'capacity_admin', 'password': secrets.token_urlsafe(24) + 'Aa7'}
    private_json(remote.state / 'admin.json', auth)
    prompts = ['管理员用户名：', '管理员姓名：', '管理员密码：']
    values = [auth['username'], '容量测试管理员', auth['password']]
    cmd = ['sudo', '-n', 'python3', remote.config['remote_dir'] + '/remote.py', 'bootstrap', '--run', remote.state.name]
    master, slave = pty.openpty(); child = subprocess.Popen(remote.ssh[:-1] + ['-tt', remote.ssh[-1], shlex.join(cmd)], stdin=slave, stdout=slave, stderr=slave); os.close(slave)
    buffer, transcript, stage = b'', b'', 0
    try:
        deadline = time.monotonic() + 120
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], .2)[0]:
                try: chunk = os.read(master, 65536)
                except OSError: break
                buffer += chunk; transcript += chunk
            if stage < 3 and prompts[stage].encode() in buffer:
                os.write(master, (values[stage] + '\n').encode()); stage += 1; buffer = b''
        code = child.wait(timeout=10)
        if stage != 3 or code: raise RuntimeError('Capacity administrator bootstrap failed')
    finally:
        if child.poll() is None: child.terminate(); child.wait(timeout=10)
        os.close(master)
        path = remote.state / 'bootstrap.log'; path.write_bytes(transcript.replace(auth['password'].encode(), b'[REDACTED]')); path.chmod(0o600)


def setup(remote, users):
    expected = remote.config.get('expected_revision')
    state = json.loads(remote.shell(['sudo', '-n', '/usr/local/sbin/qanda-deployctl', 'status']))
    if not expected or state['role'] != 'backend' or state['current']['revision'] != expected or state['operation']['phase'] != 'complete':
        raise RuntimeError('Verified deployment revision does not match the private run configuration')
    content = Path(__file__).with_name('remote.py').read_bytes()
    code = "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.parent.mkdir(mode=0o700,parents=True,exist_ok=True); p.write_bytes(sys.stdin.buffer.read()); p.chmod(0o700)"
    remote.shell(['sudo', '-n', 'python3', '-c', code, remote.config['remote_dir'] + '/remote.py'], data=content)
    tunnel = None
    try:
        print(json.dumps(remote.action('prepare')), flush=True)
        bootstrap(remote); tunnel = remote.tunnel()
        print(json.dumps(seed.run(remote.state, users)), flush=True)
        dataset = json.loads((remote.state / 'dataset.json').read_text())
        result = smoke(remote.config['port'], dataset); private_json(remote.state / 'smoke.json', result)
        print(json.dumps(result), flush=True)
        baseline = remote.action('collect'); private_json(remote.state / 'baseline.json', baseline)
        tunnel.terminate(); tunnel.wait(); tunnel = None
        print(json.dumps(remote.action('snapshot')), flush=True)
        private_json(remote.state / 'prepared-state.json', {'prepared': True, 'revision': expected, 'users': len(dataset['users']), 'banks': 20, 'answerable_questions': 10000})
    except BaseException:
        try: private_json(remote.state / 'restoration.json', remote.action('restore'))
        except Exception: pass
        raise
    finally:
        if tunnel: tunnel.terminate(); tunnel.wait(timeout=10)


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--state', required=True); p.add_argument('--users', type=int, default=1000); args = p.parse_args()
    remote = Remote(args.state)
    with Lease(remote): setup(remote, args.users)
