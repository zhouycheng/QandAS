"""Verify live limit thresholds and k6 protocol behavior before high load."""
import argparse
import collections
import concurrent.futures
import json
from pathlib import Path
import threading

from client import Api, Lease, Remote, private_json
from run import trial


def validate(remote):
    dataset = json.loads((remote.state / 'dataset.json').read_text()); user = dataset['users'][0]; rows = []
    for policy in ('on', 'off'):
        remote.action('reset', policy); tunnel = remote.tunnel(); local = threading.local()
        def request(method, path):
            if not hasattr(local, 'api'): local.api = Api(remote.config['port'], user['token'])
            return local.api.request(method, path)[0]
        try:
            with concurrent.futures.ThreadPoolExecutor(4) as pool:
                read = collections.Counter(pool.map(lambda _: request('GET', '/me'), range(610)))
                write = collections.Counter(pool.map(lambda _: request('POST', '/me/activity/heartbeat'), range(130)))
            assert read == {200: 610}, dict(read)
            assert write == {200: 130}, dict(write)
            if policy == 'off':
                api = Api(remote.config['port'])
                assert api.request('GET', '/me')[0] == 401
                assert api.request('GET', '/me', token='invalid')[0] == 401
                assert api.request('GET', '/admin/test-accounts', token=user['token'])[0] == 403
            rows.append({'limits': policy, 'read': dict(read), 'write': dict(write), 'account_request_quota': 'none', 'authentication_and_permissions': 'retained'})
            print(json.dumps(rows[-1]), flush=True)
        finally: tunnel.terminate(); tunnel.wait(timeout=10)
    private_json(remote.state / 'limits-live.json', rows)
    for scenario, seconds in [('read', 10), ('sync', 20), ('journey', 240)]:
        result = trial(remote, scenario, 1, 'off', seconds, 'validation-' + scenario)
        assert result['stable'] and result.get('business_operations', 0) >= 1, 'Native protocol validation failed: ' + scenario
    return {'live_thresholds_and_protocol': 'passed'}


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--state', required=True); args = p.parse_args(); remote = Remote(Path(args.state))
    with Lease(remote): print(json.dumps(validate(remote)), flush=True)
