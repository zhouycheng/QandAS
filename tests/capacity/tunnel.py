"""Forward the private API using asyncio without the native SSH poll ceiling."""
import argparse
import asyncio
import ipaddress
import json
from pathlib import Path
import shlex
import signal
import sys
import subprocess

from client import Remote


async def serve(state):
    import asyncssh
    remote = Remote(state); config = remote.config
    target = remote.action('addresses')['api']
    if ipaddress.ip_address(target) not in ipaddress.ip_network('172.29.71.0/24'):
        raise ValueError('The capacity tunnel requires the project API bridge address')
    async with asyncssh.connect(config['host'], username=config['user'], client_keys=[config['key']],
                                known_hosts=str(Path.home() / '.ssh/known_hosts'), config=None, agent_path=None,
                                connect_timeout=10, keepalive_interval=5, keepalive_count_max=2) as connection:
        command = ['sudo', '-n', 'python3', config['remote_dir'] + '/remote.py', 'tunnel', '--run', remote.state.name]
        result = await connection.run(shlex.join(command), check=True, timeout=15)
        ready = json.loads(result.stdout)
        listener = await connection.forward_local_port('127.0.0.1', config['port'], target, 8083)
        loop = asyncio.get_running_loop(); stopping = asyncio.Event()
        def stop():
            stopping.set(); connection.abort()
        loop.add_signal_handler(signal.SIGTERM, stop)
        try:
            print(json.dumps(ready), flush=True)
            await connection.wait_closed()
            if not stopping.is_set(): raise RuntimeError('The private SSH connection closed unexpectedly')
        finally:
            loop.remove_signal_handler(signal.SIGTERM)
            listener.close(); await listener.wait_closed()


async def serve_local(state, target_port):
    import asyncssh
    config_path = Path.home() / '.colima/_lima/colima/ssh.config'
    fields = {}
    for line in config_path.read_text().splitlines():
        parts = shlex.split(line)
        if len(parts) == 2: fields[parts[0].lower()] = parts[1]
    host, port = fields['hostname'], int(fields['port'])
    if host != '127.0.0.1': raise ValueError('The local tunnel must reach the local VM')
    host_key = subprocess.check_output(['colima', 'ssh', '--', 'sudo', 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], text=True).strip()
    known = Path(state) / 'vm-known-hosts'
    known.write_text(f'[{host}]:{port} {host_key}\n'); known.chmod(0o600)
    async with asyncssh.connect(host, port=port, username=fields['user'], client_keys=[fields['identityfile']],
                               known_hosts=str(known), config=None, agent_path=None, connect_timeout=10,
                               keepalive_interval=5, keepalive_count_max=2) as connection:
        # Apply the existing capacity connection limit to this SSH session only.
        helper = '''import os,resource,json
from pathlib import Path
pid=os.getppid()
for _ in range(8):
 p=Path('/proc')/str(pid)
 if (p/'comm').read_text().strip() in ('sshd','sshd-session'):
  soft,hard=resource.prlimit(pid,resource.RLIMIT_NOFILE)
  if hard!=resource.RLIM_INFINITY and hard<32768: raise RuntimeError('Insufficient SSH file capacity')
  resource.prlimit(pid,resource.RLIMIT_NOFILE,(max(soft,32768) if soft!=resource.RLIM_INFINITY else soft,hard))
  print(json.dumps({'nofile_soft':resource.prlimit(pid,resource.RLIMIT_NOFILE)[0]}));break
 pid=int(next(v.split()[1] for v in (p/'status').read_text().splitlines() if v.startswith('PPid:')))
else: raise RuntimeError('Dedicated SSH session not found')'''
        limit = json.loads((await connection.run(shlex.join(['sudo', '-n', 'python3', '-c', helper]), check=True, timeout=15)).stdout)
        listener = await connection.forward_local_port('127.0.0.1', 0, '127.0.0.1', target_port)
        loop = asyncio.get_running_loop(); stopping = asyncio.Event()
        def stop(): stopping.set(); connection.abort()
        loop.add_signal_handler(signal.SIGTERM, stop)
        try:
            print(json.dumps({'tunnel_ready': True, 'port': listener.get_port(), **limit}), flush=True)
            await connection.wait_closed()
            if not stopping.is_set(): raise RuntimeError('Local capacity tunnel closed unexpectedly')
        finally:
            loop.remove_signal_handler(signal.SIGTERM); listener.close(); await listener.wait_closed()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--state', required=True); parser.add_argument('--local-port', type=int); args = parser.parse_args()
    try: asyncio.run(serve_local(args.state,args.local_port) if args.local_port else serve(args.state))
    except Exception as error:
        print('Private SSH transport failed: ' + type(error).__name__, file=sys.stderr); sys.exit(1)
