"""Forward the private API using asyncio without the native SSH poll ceiling."""
import argparse
import asyncio
import ipaddress
import json
from pathlib import Path
import shlex
import signal
import sys

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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--state', required=True); args = parser.parse_args()
    try: asyncio.run(serve(args.state))
    except Exception as error:
        print('Private SSH transport failed: ' + type(error).__name__, file=sys.stderr); sys.exit(1)
