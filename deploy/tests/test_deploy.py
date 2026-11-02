import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deployctl', Path(__file__).parents[1] / 'deployctl.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def release(character='a'):
    return {'revision': character * 40,
            **{k: f'ghcr.io/zhouycheng/qanda-{k}@sha256:' + character * 64 for k in ('backend', 'web')}}


class ReleaseTests(unittest.TestCase):
    def test_only_qanda_immutable_images_are_accepted(self):
        self.assertEqual(deploy.validate_release(release()), release())
        for field, value in [('revision', 'main'), ('backend', 'nginx:latest'), ('web', 'ghcr.io/other/web@sha256:' + 'a'*64)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                deploy.validate_release({**release(), field: value})
        with self.assertRaises(ValueError):
            deploy.validate_release({**release(), 'command': 'arbitrary'})

    def test_migration_failure_restores_app_and_keeps_previous_state(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'preflight'), patch.object(deploy, 'run'), patch.object(deploy, 'assets'), \
             patch.object(deploy, 'health'), patch.object(deploy, 'activate') as activate:
            deploy.atomic(deploy.STATE / 'current.json', release())
            def compose(version, *args):
                if args[0] == 'run':
                    raise RuntimeError('migration failed')
            with patch.object(deploy, 'compose', side_effect=compose) as calls, self.assertRaises(RuntimeError):
                deploy.apply({'release': release('b'), 'action': 'deploy'})
            activate.assert_called_once_with(release())
            self.assertEqual(deploy.read(deploy.STATE / 'current.json'), release())
            self.assertEqual(deploy.read(deploy.STATE / 'operation.json')['phase'], 'rolled-back')
            self.assertEqual(calls.call_args_list[0].args[1], 'stop')

    def test_backup_failure_does_not_stop_running_app(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'preflight'), patch.object(deploy, 'compose') as compose:
            deploy.atomic(deploy.STATE / 'current.json', release())
            def command(*args):
                if args[0] == '/usr/local/sbin/qanda-backup':
                    raise RuntimeError('backup failed')
            with patch.object(deploy, 'run', side_effect=command), self.assertRaises(RuntimeError):
                deploy.apply({'release': release('b'), 'action': 'deploy'})
            compose.assert_not_called()

    def test_success_records_both_releases_and_preserves_volumes(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, 'STATE', Path(directory)), \
             patch.object(deploy, 'preflight'), patch.object(deploy, 'run'), patch.object(deploy, 'assets'), \
             patch.object(deploy, 'activate'), patch.object(deploy, 'health'), patch.object(deploy.time, 'sleep'), \
             patch.object(deploy, 'compose') as compose:
            deploy.atomic(deploy.STATE / 'current.json', release())
            deploy.apply({'release': release('b'), 'action': 'deploy'})
            self.assertEqual(deploy.read(deploy.STATE / 'previous.json'), release())
            self.assertEqual(deploy.read(deploy.STATE / 'current.json'), release('b'))
            self.assertEqual(deploy.read(deploy.STATE / 'operation.json')['phase'], 'complete')
            self.assertTrue(all('down' not in call.args and '-v' not in call.args for call in compose.call_args_list))


if __name__ == '__main__':
    unittest.main()
