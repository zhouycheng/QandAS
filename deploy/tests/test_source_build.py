import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import source_build as build
import deployctl as deploy
import dispatch


class SourceBuildTests(unittest.TestCase):
    def test_deploy_error_output_shows_validation_reason_but_hides_subprocess_details(self):
        self.assertEqual(deploy.error_message(ValueError('Invalid operation identity')), 'Invalid operation identity')
        self.assertEqual(deploy.error_message(subprocess.CalledProcessError(1, ['sudo'], stderr='private output')),
                         'CalledProcessError')

    def request(self, role='backend'):
        return dict(operation_id='123-2-' + role, role=role, revision='a' * 40, token='ghs_testsecret')

    def test_missing_build_images_are_pulled_with_bounded_retries(self):
        with patch.object(build, 'command', side_effect=[RuntimeError()] * 4) as command, \
                patch.object(build.time, 'sleep') as sleep:
            with self.assertRaises(RuntimeError):
                build.ensure_image(build.RUNTIME_IMAGE)
        self.assertEqual([call.args for call in command.call_args_list], [
            ('docker', 'image', 'inspect', build.RUNTIME_IMAGE),
            ('docker', 'pull', build.RUNTIME_IMAGE),
            ('docker', 'pull', build.RUNTIME_IMAGE),
            ('docker', 'pull', build.RUNTIME_IMAGE),
        ])
        self.assertEqual([x.args for x in sleep.call_args_list], [(5,), (10,)])

    def test_request_cannot_select_repository_paths_or_commands(self):
        with patch.object(deploy, 'node_role', return_value='backend'):
            deploy.validate_source_request(self.request(), 'deploy')
            deploy.validate_source_request({**self.request(), 'token': 'ghs_test.secret+token/='}, 'deploy')
            for update in ({'revision': 'main'}, {'role': 'frontend'}, {'operation_id': '../x'}, {'operation_id': '123-2-frontend'},
                           {'repository': 'https://other'}, {'command': 'whoami'}, {'token': ''},
                           {'token': 'bad token'}, {'token': 'bad\ncredential'}):
                with self.subTest(update=update), self.assertRaises(ValueError):
                    deploy.validate_source_request({**self.request(), **update}, 'deploy')

    def test_local_identity_and_legacy_identity_resolve_for_compose(self):
        image = 'sha256:' + 'b' * 64
        with patch.object(deploy, 'node_role', return_value='backend'):
            self.assertEqual(deploy.validate_release({'revision': 'a' * 40, 'backend': image})['backend'], image)
            self.assertEqual(deploy.local_image_ref(image), image)
        self.assertEqual(deploy.local_image_ref('ghcr.io/zhouycheng/qanda-web@sha256:' + 'b' * 64),
                         'ghcr.io/zhouycheng/qanda-web:sha256-' + 'b' * 64)
        with patch.object(deploy, 'require_image_labels', side_effect=subprocess.CalledProcessError(1, 'inspect')), \
                patch.object(deploy, 'pull_image') as pull:
            with self.assertRaises(RuntimeError):
                deploy.ensure_local_images({'revision': 'a' * 40, 'backend': image})
            pull.assert_not_called()

    def test_builds_both_roles_with_limits_and_cleans_up_on_oom(self):
        for role in ('backend', 'frontend'):
            for failure in (False, True):
                with self.subTest(role=role, failure=failure), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    calls, phases = [], []
                    def fetch(source, revision, token):
                        source.mkdir()
                    def command(*args, **kwargs):
                        calls.append(args)
                        if args[:2] == ('docker', 'run') and failure:
                            raise RuntimeError('OOM')
                        if '{{.Id}}' in args:
                            return 'sha256:' + 'b' * 64
                        return ''
                    with patch.object(build, 'BUILD_ROOT', root), patch.object(build, 'CACHE_ROOT', root / 'cache'), \
                            patch.object(build, 'fetch', side_effect=fetch), patch.object(build, 'resources'), \
                            patch.object(build.os, 'chown'), patch.object(build, 'command', side_effect=command), \
                            patch.object(build.subprocess, 'run') as cleanup:
                        request = self.request(role)
                        if failure:
                            with self.assertRaises(RuntimeError):
                                build.build(request, phases.append)
                        else:
                            result = build.build(request, phases.append)
                            self.assertEqual(result['backend' if role == 'backend' else 'web'], 'sha256:' + 'b' * 64)
                        self.assertNotIn('token', request)
                        compiler = next(call for call in calls if call[:2] == ('docker', 'run'))
                        for flag in ('--cpus=1', '--memory=1g', '--memory-swap=1g', '--cap-drop=ALL'):
                            self.assertIn(flag, compiler)
                        self.assertNotIn('ghs_testsecret', str(calls))
                        self.assertNotIn('production.env', str(calls))
                        self.assertIn('building-application', phases)
                        self.assertEqual('building-image' in phases, not failure)
                        if role == 'backend':
                            self.assertIn(('docker', 'image', 'inspect', build.RUNTIME_IMAGE), calls)
                            if not failure:
                                image_build = next(call for call in calls if call[:3] == ('docker', 'buildx', 'build'))
                                self.assertIn('--builder', image_build)
                                self.assertIn('default', image_build)
                                self.assertEqual(image_build.count('--resource'), 4)
                                self.assertFalse(any(call[:3] == ('docker', 'buildx', 'create') for call in calls))
                        elif not failure:
                            self.assertTrue(any(call[:3] == ('docker', 'buildx', 'create') for call in calls))
                        cleanup.assert_called()
                    self.assertFalse(list(root.glob('qanda-source-*')))

    def test_fetch_rejects_revision_mismatch_and_removes_credentials(self):
        temporary = tempfile.TemporaryDirectory
        with temporary() as directory:
            source = Path(directory) / 'source'
            seen = []
            def command(*args, env=None):
                seen.append(args)
                self.assertTrue(Path(env['QANDA_GIT_TOKEN_FILE']).exists())
                return 'b' * 40 if 'rev-parse' in args else ''
            with patch.object(build.tempfile, 'TemporaryDirectory', side_effect=lambda **kw: temporary(dir=directory)), \
                    patch.object(build, 'command', side_effect=command):
                with self.assertRaisesRegex(RuntimeError, 'revision'):
                    build.fetch(source, 'a' * 40, 'ghs_testsecret')
            self.assertEqual(list(Path(directory).iterdir()), [])
            self.assertNotIn('ghs_testsecret', str(seen))

    def test_actions_rejects_old_success_and_recovers_disconnect(self):
        env = {'SOURCE_BUILD': 'true', 'DEPLOY_NODE': 'backend', 'OPERATION_ID': '123-2-backend',
               'GITHUB_SHA': 'a' * 40, 'SOURCE_TOKEN': 'test'}
        state = {'operation': {'operation_id': '123-2-backend', 'revision': 'a' * 40, 'phase': 'complete'},
                 'current': {'revision': 'a' * 40}}
        with patch.dict(os.environ, env):
            with patch.object(dispatch, 'remote', side_effect=[None, {**state, 'operation': {**state['operation'], 'operation_id': 'old'}}]):
                with self.assertRaisesRegex(RuntimeError, 'identity'):
                    dispatch.execute('server', 'deploy')
            with patch.object(dispatch, 'remote', side_effect=[subprocess.CalledProcessError(255, 'ssh'),
                    subprocess.CalledProcessError(255, 'ssh'), state, {'offset': 12, 'text': 'done'}]) as remote, \
                    patch.object(dispatch.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(dispatch.execute('server', 'deploy'), state)
                self.assertEqual([x.args[1] for x in remote.call_args_list].count('deploy'), 1)
            with patch.object(dispatch, 'remote', side_effect=[None, {**state, 'current': {'revision': 'b'*40}},
                                                             {'offset': 0, 'text': ''}]), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'Running revision'):
                    dispatch.execute('server', 'deploy')

    def test_reconcile_interrupted_build_preserves_running_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deploy.atomic(root / 'operation.json', {'operation_id': '123-2-backend', 'phase': 'building-application',
                                                   'boot_id': 'old'})
            with patch.object(deploy, 'STATE', root), patch.object(deploy, 'boot_id', return_value='new'), \
                    patch.object(deploy.subprocess, 'run') as run, patch.object(deploy, 'activate') as activate:
                deploy.reconcile(locked=True)
                self.assertEqual(deploy.read(root / 'operation.json')['phase'], 'failed')
                activate.assert_not_called()
                self.assertGreaterEqual(run.call_count, 3)

    def test_reconcile_retries_old_release_after_interrupted_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = {'revision': 'b' * 40, 'backend': 'sha256:' + 'c' * 64}
            deploy.atomic(root / 'operation.json', {'operation_id': '123-2-backend', 'phase': 'starting', 'boot_id': 'old'})
            deploy.atomic(root / 'current.json', current)
            def systemctl(args, **kwargs):
                return subprocess.CompletedProcess(args, 0, stdout='inactive' if args[:3] == ['systemctl', 'is-active', 'qanda-release.service'] else '')
            glob = Path.glob
            def scoped_glob(path, pattern):
                return iter(()) if path == Path('/run') else glob(path, pattern)
            with patch.object(deploy, 'STATE', root), patch.object(deploy, 'REQUEST', root / 'release-request.json'), \
                    patch.object(deploy, 'boot_id', return_value='new'), patch.object(deploy.subprocess, 'run', side_effect=systemctl), \
                    patch.object(deploy.Path, 'glob', scoped_glob), \
                    patch.object(deploy, 'activate', side_effect=[RuntimeError('temporary recovery failure'), None]) as activate, \
                    patch.object(deploy, 'health') as health:
                with self.assertRaisesRegex(RuntimeError, 'temporary recovery'):
                    deploy.reconcile(locked=True)
                self.assertEqual(deploy.read(root / 'operation.json')['phase'], 'rolling-back')
                deploy.reconcile(locked=True)
                self.assertEqual(deploy.read(root / 'operation.json')['phase'], 'rolled-back')
                self.assertEqual(activate.call_args_list, [((current,),), ((current,),)])
                health.assert_called_once_with(current)

    def test_log_redaction(self):
        self.assertEqual(build.redact('ghs_private ghp_private github_pat_private'), '[REDACTED] [REDACTED] [REDACTED]')

    def test_source_queue_has_private_credentials_and_operation_identity(self):
        import json
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request_file = root / 'private-request.json'
            stdin = SimpleNamespace(buffer=io.BytesIO((json.dumps(self.request()) + '\n').encode()))
            with patch.object(deploy, 'STATE', root), patch.object(deploy, 'REQUEST', request_file), \
                    patch.object(deploy, 'protected'), patch.object(deploy, 'preflight'), \
                    patch.object(deploy, 'node_role', return_value='backend'), \
                    patch.object(deploy, 'boot_id', return_value='boot'), patch.object(deploy.os, 'geteuid', return_value=0), \
                    patch.object(deploy.sys, 'argv', ['deployctl', 'deploy']), patch.object(deploy.sys, 'stdin', stdin), \
                    patch.object(deploy, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
                deploy.main()
                operation = deploy.read(root / 'operation.json')
                self.assertEqual(operation['operation_id'], self.request()['operation_id'])
                self.assertNotIn('token', operation)
                self.assertEqual(request_file.stat().st_mode & 0o777, 0o600)
                self.assertIn('--property=RuntimeMaxSec=3600', run.call_args.args)
                self.assertFalse((root / 'request.json').exists())

    def test_resource_failure_stops_before_fetch(self):
        with patch.object(build.Path, 'read_text', return_value='MemAvailable: 100 kB\n'):
            with self.assertRaisesRegex(RuntimeError, 'RAM'):
                build.resources()
        with patch.object(build, 'resources', side_effect=RuntimeError('Insufficient memory')), \
                patch.object(build, 'fetch') as fetch:
            with self.assertRaises(RuntimeError):
                build.build(self.request(), lambda phase: None)
            fetch.assert_not_called()

    def test_release_logs_keep_ci_and_debug_permissions_separate(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('source_test_entry', Path(__file__).parents[1] / 'remote-entry.py')
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        self.assertEqual(entry.command('qanda-deploy', 'release-logs')[-1], 'release-logs')
        with self.assertRaises(ValueError):
            entry.command('qanda-debug', 'release-logs')
