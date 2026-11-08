"""Prepare deterministic synthetic content through existing administrator APIs."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import threading
import uuid
from client import Api, Remote, private_json, smoke


def question(bank, chapter, number):
    kind = ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'FILL_BLANK', 'SHORT_ANSWER'][number % 5]
    q = {'questionBankId': bank, 'chapterId': chapter, 'type': kind, 'stem': '容量测试合成题 ' + str(number) + '。' + '根据题干给出的条件完成作答，本题只用于验证系统处理与持久化能力。' * 4,
         'explanation': '容量测试解析。' + '按照题目条件推导答案，核对服务端判分与客户端作答是否一致。' * 4}
    if kind in ('SINGLE_CHOICE', 'MULTIPLE_CHOICE'):
        q.update(options=[{'key': x, 'content': '合成选项 ' + x} for x in 'ABCD'], correctAnswer=['A'] if kind == 'SINGLE_CHOICE' else ['A', 'B'])
    elif kind == 'TRUE_FALSE': q['correctValue'] = True
    elif kind == 'FILL_BLANK':
        q['stem'] += '请填写 {{1}}。'; q['blanks'] = [{'answers': ['容量测试']}]
    else: q['referenceAnswer'] = '容量测试参考答案'
    return q


def run(state, wanted):
    remote = Remote(state); port = remote.config['port']; root = Path(state)
    auth = json.loads((root / 'admin.json').read_text())
    login = Api(port).call('POST', '/admin/auth/sessions', {**auth, 'deviceId': str(uuid.uuid4())})
    token = login['accessToken']; api = Api(port, token)
    target = root / 'dataset.json'
    dataset = json.loads(target.read_text()) if target.exists() else {'banks': [], 'users': [], 'seed_version': 1}
    if not dataset['banks']:
        subject = api.call('POST', '/admin/subjects', {'name': '容量测试课程', 'description': '固定合成数据集'})['id']
        for number in range(20):
            bank = api.call('POST', '/admin/question-banks', {'subjectId': subject, 'name': '容量测试题库 ' + str(number + 1), 'description': '独立压测数据，含多种题型与完整解析。'})['id']
            chapter = api.call('POST', '/admin/question-banks/' + bank + '/chapters', {'name': '合成章节', 'sortOrder': 0})['id']
            questions = [question(bank, chapter, i) for i in range(400)]
            for i in range(50):
                q = {'questionBankId': bank, 'chapterId': chapter, 'type': 'READING', 'stem': '容量测试阅读题组 ' + str(i), 'passage': '阅读下列合成材料并完成问题。' * 30, 'explanation': '阅读题组解析。'}
                children = [question(bank, chapter, 0), question(bank, chapter, 2)]
                q['subQuestions'] = [{k: v for k, v in x.items() if k not in ('questionBankId', 'chapterId')} for x in children]
                questions.append(q)
            version = api.call('GET', '/admin/question-banks/' + bank)['contentVersion']
            preview = api.call('POST', '/admin/question-banks/' + bank + '/import-preview', {'expectedContentVersion': version, 'questions': questions})
            if not preview['valid']:
                raise RuntimeError('Synthetic question validation failed: ' + json.dumps(preview['issues'], ensure_ascii=False))
            for start in range(0, len(questions), 50):
                result = api.call('POST', '/admin/question-banks/' + bank + '/imports', {'expectedContentVersion': version, 'questions': questions[start:start + 50]})
                version = result['contentVersion']
            row = api.call('GET', '/admin/question-banks/' + bank)
            api.call('PUT', '/admin/question-banks/' + bank + '/publication', {'expectedVersion': row['version'], 'status': 'PUBLISHED'})
            dataset['banks'].append({'id': bank, 'scope': {'questionBankId': bank, 'count': 20, 'order': 'RANDOM', 'selectionKind': 'NORMAL'}})
            private_json(target, dataset)
            print(json.dumps({'seeded_banks': len(dataset['banks']), 'answerable_questions': 500 * len(dataset['banks'])}), flush=True)
    local = threading.local()
    def user(_):
        if not hasattr(local, 'api'): local.api = Api(port, token)
        a = local.api
        record = a.call('POST', '/admin/test-accounts', {'validDays': 7, 'includeInStatistics': True})
        credentials = a.call('GET', '/admin/test-accounts/' + record['id'] + '/credentials')
        device = str(uuid.uuid4())
        session = a.call('POST', '/auth/sessions', {**{k: credentials[k] for k in ('email', 'password')}, 'deviceId': device}, token='')
        return {'id': record['id'], 'token': session['accessToken'], 'deviceId': device, 'expiresAt': session['expiresAt']}
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        for record in pool.map(user, range(max(0, wanted - len(dataset['users'])))):
            dataset['users'].append(record)
            if len(dataset['users']) % 50 == 0:
                private_json(target, dataset); print(json.dumps({'seeded_users': len(dataset['users'])}), flush=True)
    private_json(target, dataset)
    for bank in dataset['banks']:
        bank['preview'] = Api(port, dataset['users'][0]['token']).call('POST', '/practice/scope-preview', bank['scope'])
    private_json(target, dataset)
    return {'users': len(dataset['users']), 'banks': len(dataset['banks'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--state', required=True); parser.add_argument('--users', type=int, default=1000); parser.add_argument('--smoke', action='store_true'); args = parser.parse_args()
    if args.smoke:
        remote = Remote(args.state); print(json.dumps(smoke(remote.config['port'], json.loads((Path(args.state) / 'dataset.json').read_text()))))
    else:
        print(json.dumps(run(args.state, args.users)))
