import importlib.util
import fcntl
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployctl', Path(__file__).parents[1] / 'deployctl.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
sys.path.insert(0, str(Path(__file__).parents[1]))
import targets
import dispatch


def release(character='a'):
    return {'revision': character * 40,
            **{k: f'ghcr.io/zhouycheng/qanda-{k}@sha256:' + character * 64 for k in ('backend', 'web')}}


def saved_image(kind='backend', revision='a' * 40, repo_tag=None):
    image = f'ghcr.io/zhouycheng/qanda-{kind}@sha256:' + 'a' * 64
    tag = repo_tag or deploy.local_image_ref(image)
    config = json.dumps({'config': {'Labels': {
        'org.opencontainers.image.source': 'https://github.com/zhouycheng/QandA',
        'org.opencontainers.image.revision': revision}}}).encode()
    manifest = json.dumps([{'Config': 'config.json', 'RepoTags': [tag], 'Layers': ['layer/layer.tar']}]).encode()
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode='w') as saved:
        for name, data in [('manifest.json', manifest), ('config.json', config), ('layer/layer.tar', b'layer')]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            saved.addfile(info, io.BytesIO(data))
    return archive.getvalue(), {'revision': revision, kind: image}


class ReleaseTests(unittest.TestCase):
    def test_stalled_header_and_archive_expire_without_queuing_a_release_or_holding_the_lock(self):
        for payload in (b'{', (json.dumps({'username':'test','token':'isolated-token','release':release(),
                                         'image_sha256':'a'*64})+'\n').encode()+b'partial archive'):
            with self.subTest(archive=payload!=b'{'), tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                code=f'''
import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('deadline_deployctl',{str(Path(deploy.__file__).resolve())!r})
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
d.STATE=Path({str(root)!r});d.INPUT_TIMEOUT_SECONDS=1
d.os.geteuid=lambda:0;d.protected=lambda path:None;d.preflight=lambda **kwargs:None;d.node_role=lambda:'backend'
sys.argv=['qanda-deployctl','deploy']
try:d.main()
except TimeoutError:print('DEPLOY_INPUT_TIMEOUT')
'''
                process=subprocess.Popen([sys.executable,'-c',code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                try:
                    process.stdin.write(payload);process.stdin.flush();process.wait(timeout=5)
                    self.assertEqual(process.returncode,0,process.stderr.read().decode())
                    self.assertIn(b'DEPLOY_INPUT_TIMEOUT',process.stdout.read())
                    self.assertFalse((root/'request.json').exists());self.assertFalse((root/'operation.json').exists())
                    with (root/'lock').open('a') as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                finally:
                    if process.poll() is None:process.kill();process.wait()
                    process.stdin.close();process.stdout.close();process.stderr.close()

    def test_node_roles_select_only_the_owned_services(self):
        for role, expected in [('frontend', ('web',)), ('backend', ('api', 'worker', 'monitor')), ('combined', deploy.SERVICES)]:
            with self.subTest(role=role), patch.object(deploy, 'node_role', return_value=role):
                self.assertEqual(deploy.services(), expected)

    def test_topology_rejects_shell_syntax_and_arbitrary_users(self):
        good = {k: {'server': 'server-a', 'admin_user': 'ubuntu'} for k in ('frontend', 'backend')}
        self.assertEqual(targets.validate(good), good)
        for field, value in [('server', 'host;whoami'), ('server', '-oProxyCommand=bad'), ('admin_user', 'root@other')]:
            bad = {**good, 'backend': {**good['backend'], field: value}}
            with self.subTest(value=value), self.assertRaises(ValueError):
                targets.validate(bad)

    def test_split_nodes_require_separate_owner_deployments(self):
        import json
        topology = {k: {'server': k, 'admin_user': 'ubuntu', 'service_ip': f'100.64.0.{i + 10}'} for i, k in enumerate(('frontend', 'backend'))}
        with tempfile.NamedTemporaryFile() as summary, patch.dict('os.environ', {
            'DEPLOY_TARGETS': json.dumps(topology), 'DEPLOY_NODE': 'all', 'OPERATION': 'deploy', 'GITHUB_STEP_SUMMARY': summary.name
        }), patch.object(dispatch, 'remote', return_value={'current': release()}), \
             patch.object(dispatch, 'execute') as execute:
            with self.assertRaises(ValueError):
                dispatch.main()
            execute.assert_not_called()

    def test_only_qanda_immutable_images_are_accepted(self):
        self.assertEqual(deploy.validate_release(release()), release())
        for field, value in [('revision', 'main'), ('backend', 'nginx:latest'), ('web', 'ghcr.io/other/web@sha256:' + 'a'*64)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                deploy.validate_release({**release(), field: value})
        with self.assertRaises(ValueError):
            deploy.validate_release({**release(), 'command': 'arbitrary'})

    def test_image_archive_is_digest_checked_and_bound_to_release_labels(self):
        archive, target = saved_image()
        labels = json.dumps({'org.opencontainers.image.source': 'https://github.com/zhouycheng/QandA',
                             'org.opencontainers.image.revision': target['revision']})
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'run', side_effect=['loaded', labels]) as run:
            deploy.load_image_archive(io.BytesIO(archive), target, hashlib.sha256(archive).hexdigest())
            self.assertEqual(run.call_args_list[0].args[:2], ('docker', 'load'))
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                deploy.load_image_archive(io.BytesIO(archive), target, '0' * 64)
            run.assert_not_called()
        archive, target = saved_image(repo_tag='ghcr.io/other/image:latest')
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'requested image'):
                deploy.load_image_archive(io.BytesIO(archive), target, hashlib.sha256(archive).hexdigest())
            run.assert_not_called()

    def test_registry_image_pull_retries_are_bounded(self):
        failure = subprocess.CalledProcessError(1, ['docker', 'pull'])
        with patch.object(deploy, 'run', side_effect=[failure, failure, '']) as run, \
             patch.object(deploy.time, 'sleep') as sleep:
            deploy.pull_image('ghcr.io/zhouycheng/qanda-backend@sha256:' + 'a' * 64)
            self.assertEqual(run.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 10])
        with patch.object(deploy, 'run', side_effect=failure) as run, \
             patch.object(deploy.time, 'sleep') as sleep, self.assertRaises(subprocess.CalledProcessError):
            deploy.pull_image('ghcr.io/zhouycheng/qanda-backend@sha256:' + 'a' * 64)
            self.assertEqual(run.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 10])

    def test_backend_controller_queues_registry_release_without_archive(self):
        state = {'revision': 'a' * 40, 'backend': 'ghcr.io/zhouycheng/qanda-backend@sha256:' + 'a' * 64}
        request = {'username': 'runner', 'token': 'isolated-test-token', 'release': state}
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(request).encode() + b'\n'))
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'node_role', return_value='backend'), \
             patch.object(deploy, 'protected'), patch.object(deploy, 'preflight'), \
             patch.object(deploy.os, 'geteuid', return_value=0), \
             patch.object(deploy.sys, 'argv', ['qanda-deployctl', 'deploy']), \
             patch.object(deploy.sys, 'stdin', stdin), patch.object(deploy, 'run') as run:
            deploy.main()
            operation = deploy.read(Path(directory) / 'operation.json')
            queued = deploy.read(Path(directory) / 'request.json')
        self.assertEqual(operation['phase'], 'queued')
        self.assertEqual(queued['release'], state)
        self.assertEqual(run.call_args.args[:2], ('systemd-run', '--unit=qanda-release'))

    def test_deploy_uses_local_digest_aliases_for_compose(self):
        with patch.object(deploy, 'run', return_value='') as run, patch.object(deploy, 'ROOT', Path('/tmp')):
            deploy.compose(release(), 'ps')
        env = run.call_args.kwargs['env']
        self.assertEqual(env['BACKEND_IMAGE'], deploy.local_image_ref(release()['backend']))
        self.assertEqual(env['WEB_IMAGE'], deploy.local_image_ref(release()['web']))

    def test_initialization_failure_restores_app_and_keeps_previous_state(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'preflight'), patch.object(deploy, 'run'), patch.object(deploy, 'assets'), \
             patch.object(deploy, 'health'), patch.object(deploy, 'activate') as activate, \
             patch.object(deploy, 'ensure_local_images'):
            deploy.atomic(deploy.STATE / 'current.json', release())
            def compose(version, *args):
                if args[0] == 'run':
                    raise RuntimeError('initialization failed')
            with patch.object(deploy, 'compose', side_effect=compose) as calls, self.assertRaises(RuntimeError):
                deploy.apply({'release': release('b'), 'action': 'deploy'})
            activate.assert_called_once_with(release())
            self.assertEqual(deploy.read(deploy.STATE / 'current.json'), release())
            self.assertEqual(deploy.read(deploy.STATE / 'operation.json')['phase'], 'rolled-back')
            self.assertEqual(calls.call_args_list[0].args[1], 'stop')

    def test_backup_failure_does_not_stop_running_app(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'preflight'), patch.object(deploy, 'compose') as compose, \
             patch.object(deploy, 'ensure_local_images'):
            deploy.atomic(deploy.STATE / 'current.json', release())
            def command(*args):
                if args[0] == '/usr/local/sbin/qanda-backup':
                    raise RuntimeError('backup failed')
            with patch.object(deploy, 'run', side_effect=command), self.assertRaises(RuntimeError):
                deploy.apply({'release': release('b'), 'action': 'deploy'})
            compose.assert_not_called()

    def test_failed_first_release_preserves_the_operations_entry(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'node_role', return_value='backend'), patch.object(deploy, 'preflight'), \
             patch.object(deploy, 'tailnet_image', return_value='project-network-image'), \
             patch.object(deploy, 'compose') as compose, patch.object(deploy, 'run') as run, \
             patch.object(deploy, 'ensure_local_images'), \
             patch.object(deploy, 'activate', side_effect=RuntimeError('first startup failed')):
            with self.assertRaisesRegex(RuntimeError, 'first startup'):
                deploy.apply({'release': release(), 'action': 'deploy'})
            self.assertEqual(deploy.read(deploy.STATE / 'operation.json')['phase'], 'failed')
            self.assertFalse(any(call.args[:2] == ('systemctl', 'stop') for call in run.call_args_list))
            self.assertEqual(compose.call_args.args[1:], ('stop', '--timeout', '120', 'api', 'worker', 'monitor'))

    def test_success_records_both_releases_and_preserves_volumes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'preflight'), patch.object(deploy, 'run'), patch.object(deploy, 'assets'), \
             patch.object(deploy, 'activate'), patch.object(deploy, 'health'), patch.object(deploy.time, 'sleep'), \
             patch.object(deploy, 'compose') as compose, patch.object(deploy, 'ensure_local_images'):
            deploy.atomic(deploy.STATE / 'current.json', release())
            deploy.apply({'release': release('b'), 'action': 'deploy'})
            self.assertEqual(deploy.read(deploy.STATE / 'previous.json'), release())
            self.assertEqual(deploy.read(deploy.STATE / 'current.json'), release('b'))
            self.assertEqual(deploy.read(deploy.STATE / 'operation.json')['phase'], 'complete')
            self.assertTrue(all('down' not in call.args and '-v' not in call.args for call in compose.call_args_list))


if __name__ == '__main__':
    unittest.main()
