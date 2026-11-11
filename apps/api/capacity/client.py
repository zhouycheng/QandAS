"""Private SSH transport and the existing HTTP contract used by capacity tools."""
import http.client
import json
from pathlib import Path
import re
import select
import shlex
import subprocess
import sys
import threading
import time
import uuid


def private_json(path, value):
    path = Path(path); path.write_text(json.dumps(value, ensure_ascii=False)); path.chmod(0o600)


class Remote:
    def __init__(self, state):
        self.state = Path(state); self.config = json.loads((self.state / 'connection.json').read_text())
        c = self.config
        if not re.fullmatch(r'[0-9]{8}(?:-[a-z0-9]+)?', self.state.name) or c['remote_dir'] != '/var/lib/qanda-capacity/' + self.state.name:
            raise ValueError('A dedicated capacity run directory is required')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]*', c['host']) or not re.fullmatch(r'[a-z_][a-z0-9_-]*', c['user']):
            raise ValueError('Invalid private connection parameters')
        self.ssh = ['ssh', '-i', c['key'], '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', c['user'] + '@' + c['host']]

    def shell(self, args, timeout=360, data=None):
        result = subprocess.run(self.ssh + [shlex.join([str(x) for x in args])], input=data, capture_output=True, timeout=timeout)
        if result.returncode:
            log = self.state / 'ssh-errors.log'; log.write_bytes(result.stdout + result.stderr); log.chmod(0o600)
            raise RuntimeError('Remote command failed; private ssh-errors.log contains diagnostics')
        return result.stdout

    def action(self, action, limits='on', timeout=600):
        return json.loads(self.shell(['sudo', '-n', 'python3', self.config['remote_dir'] + '/remote.py', action, '--run', self.state.name, '--limits', limits], timeout))

    def tunnel(self):
        c = self.config
        p = subprocess.Popen([sys.executable, str(Path(__file__).with_name('tunnel.py')), '--state', str(self.state)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=(self.state / 'tunnel.log').open('ab'))
        try:
            if not select.select([p.stdout], [], [], 15)[0]:
                raise RuntimeError('Private tunnel setup timeout')
            ready = json.loads(p.stdout.readline())
            limit = ready.get('nofile_soft', 0)
            if not ready.get('tunnel_ready') or (limit != -1 and limit < 32768):
                raise RuntimeError('Private tunnel file limit was not verified')
            private_json(self.state / 'tunnel-limit.json', ready)
            for _ in range(30):
                if p.poll() is not None:
                    raise RuntimeError('Private tunnel failed; inspect private tunnel.log')
                try:
                    status, _ = Api(c['port']).request('GET', '/health')
                    if status == 200:
                        return p
                except OSError:
                    pass
                time.sleep(0.3)
            raise RuntimeError('Private tunnel readiness timeout')
        except BaseException:
            p.terminate(); p.wait(timeout=10); raise


class Api:
    def __init__(self, port, token=None):
        self.port, self.token, self.connection = port, token, None

    def request(self, method, path, body=None, key=None, token=None):
        if self.connection is None:
            self.connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        headers = {'Accept': 'application/json'}
        bearer = token if token is not None else self.token
        if bearer:
            headers['Authorization'] = 'Bearer ' + bearer
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if method not in ('GET', 'HEAD', 'DELETE') and path != '/auth/sessions' and path != '/admin/auth/sessions':
            headers['Idempotency-Key'] = key or str(uuid.uuid4())
        try:
            self.connection.request(method, '/api/v1' + path, None if body is None else json.dumps(body, ensure_ascii=False).encode(), headers)
            response = self.connection.getresponse(); raw = response.read()
            value = json.loads(raw) if raw else None
            return response.status, value
        except Exception:
            self.connection.close(); self.connection = None; raise

    def call(self, method, path, body=None, key=None, token=None, expected=(200, 201, 202)):
        status, value = self.request(method, path, body, key, token)
        if status not in expected:
            raise RuntimeError(method + ' ' + path.split('?')[0] + ': HTTP ' + str(status) + ' ' + str((value or {}).get('code', '')))
        return value


class Lease:
    """Keep the remote automatic restore lease alive during fixture preparation."""
    def __init__(self, remote): self.remote, self.stop = remote, threading.Event()
    def __enter__(self):
        def beat():
            while not self.stop.is_set():
                try: self.remote.action('heartbeat', timeout=5)
                except Exception: pass
                self.stop.wait(30)
        self.thread = threading.Thread(target=beat, daemon=True); self.thread.start(); return self
    def __exit__(self, *args): self.stop.set(); self.thread.join(timeout=6)


def answer(item):
    q = item['question']; kind = q['type']
    if kind in ('SINGLE_CHOICE', 'MULTIPLE_CHOICE'):
        return {'optionKeys': ['A'] if kind == 'SINGLE_CHOICE' else ['A', 'B']}
    if kind == 'TRUE_FALSE':
        return {'value': True}
    if kind == 'FILL_BLANK':
        return {'blanks': ['容量测试'] * q['blankCount']}
    return {'text': '容量测试参考答案'}


def smoke(port, dataset):
    user = dataset['users'][0]; api = Api(port, user['token']); scope = dataset['banks'][0]['scope']
    preview = api.call('POST', '/practice/scope-preview', scope)
    session = api.call('POST', '/practice/sessions', {'scope': scope, 'expectedContentVersion': preview['contentVersion'], 'expectedContentVersions': preview['contentVersions'], 'deviceId': user['deviceId']})
    items = [{'itemId': x['itemId'], 'answer': answer(x), 'confirmed': True} for x in session['items']]
    body = {'expectedVersion': session['version'], 'currentIndex': len(items) - 1, 'durationSeconds': 0, 'writerToken': session['writer']['writerToken'], 'clientSequence': 1, 'items': items}
    key = str(uuid.uuid4()); path = '/practice/sessions/' + session['id']
    first = api.call('POST', path + '/sync-commands', body, key)
    api.call('POST', path + '/sync-commands', body, key)
    deadline = time.monotonic() + 30
    while True:
        value = api.call('GET', path + '/sync-commands/' + key)
        if value['state'] == 'COMMITTED':
            break
        assert value['state'] not in ('REJECTED', 'DEAD_LETTER'), value['state']
        assert time.monotonic() < deadline, 'Smoke commit timeout'; time.sleep(0.1)
    ack = value['acknowledgement']; assert ack['acknowledgedSequence'] == 1
    finish = dict(body, expectedVersion=ack['version'], clientSequence=2, kind='FINISH')
    key = str(uuid.uuid4()); api.call('POST', path + '/sync-commands', finish, key)
    api.call('POST', path + '/sync-commands', finish, key)
    deadline = time.monotonic() + 30
    while True:
        value = api.call('GET', path + '/sync-commands/' + key)
        if value['state'] == 'COMMITTED': break
        assert value['state'] not in ('REJECTED', 'DEAD_LETTER'), value['state']
        assert time.monotonic() < deadline, 'Smoke finalization timeout'; time.sleep(0.1)
    result = value['result']; duplicate = api.call('GET', path + '/sync-commands/' + key)['result']
    assert duplicate['id'] == result['id'] and result['answeredCount'] == len(items)
    assert result['objective']['wrong'] == 0
    return {'passed': True, 'accepted_state': first['state'], 'committed': True, 'duplicate_finish_same_result': True, 'answered': result['answeredCount']}
