import importlib.util
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployctl', Path(__file__).parents[1] / 'deployctl.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
sys.path.insert(0, str(Path(__file__).parents[1]))
import targets


def release(character='a'):
    return {'revision': character * 40,
            **{k: 'sha256:' + character * 64 for k in ('backend', 'web')}}


class ReleaseTests(unittest.TestCase):

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


    def test_only_qanda_immutable_images_are_accepted(self):
        self.assertEqual(deploy.validate_release(release()), release())
        for field, value in [('revision', 'main'), ('backend', 'nginx:latest'), ('web', 'ghcr.io/other/web@sha256:' + 'a'*64)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                deploy.validate_release({**release(), field: value})
        with self.assertRaises(ValueError):
            deploy.validate_release({**release(), 'command': 'arbitrary'})


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
