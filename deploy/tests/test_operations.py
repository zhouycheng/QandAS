import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).parents[1]
sys.path.insert(0, str(DEPLOY))
import deployctl
import dispatch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


entry = module('remote_entry', 'remote-entry.py')
candidate = module('candidate', 'candidate-check.py')
guard = module('operations_guard', 'network-guard.py')


def container():
    return {'Id': 'a' * 64, 'Config': {'Image': 'project-image', 'Env': ['PRIVATE=secret'], 'Labels': {
        'com.docker.compose.project': 'qanda-application', 'com.docker.compose.service': 'api',
        'com.docker.compose.oneoff': 'False'}}, 'HostConfig': {},
        'State': {'Status': 'running', 'Health': {'Status': 'healthy'}},
        'NetworkSettings': {'Networks': {'qanda-application': {}, 'qanda-data': {}}},
        'Mounts': [{'Type': 'volume', 'Name': 'qanda-production-assets', 'Destination': '/var/lib/qanda/assets'}]}


class OperationsTests(unittest.TestCase):
    def test_publishing_requires_the_exact_verified_artifact_for_each_image(self):
        for kind, artifact, destination in [
                ('backend', 'backend/qanda-backend-1.0.0.jar', 'apps/api/target/qanda-backend-1.0.0.jar'),
                ('web', 'web/index.html', 'apps/admin/dist/index.html')]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                file = root / 'release' / artifact
                file.parent.mkdir(parents=True)
                file.write_bytes(b'verified build output')
                manifest = file.parents[1] / 'SHA256SUMS'
                manifest.write_text(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + artifact + '\n')
                binaries = root / 'bin'
                binaries.mkdir()
                docker = binaries / 'docker'
                docker.write_text('#!/bin/sh\necho registry-contact > registry-contact\nexit 77\n')
                docker.chmod(0o755)
                env = {**os.environ, 'PATH': str(binaries) + os.pathsep + os.environ['PATH'],
                       'RELEASE_KIND': kind, 'CACHE_EXACT_HIT': 'false', 'GITHUB_SHA': 'a' * 40,
                       'REGISTRY_TOKEN': 'test-token', 'GITHUB_ACTOR': 'test'}
                def publish():
                    return subprocess.run(['bash', str(DEPLOY / 'publish-image.sh')], cwd=root,
                                          env=env, capture_output=True).returncode
                self.assertNotEqual(publish(), 0)
                self.assertFalse((root / 'registry-contact').exists())
                env['CACHE_EXACT_HIT'] = 'true'
                file.write_bytes(b'changed after verification')
                self.assertNotEqual(publish(), 0)
                self.assertFalse((root / 'registry-contact').exists())
                file.write_bytes(b'verified build output')
                self.assertEqual(publish(), 77)
                self.assertEqual((root / destination).read_bytes(), file.read_bytes())

    def test_ci_and_debug_commands_have_separate_permissions(self):
        self.assertEqual(entry.command('qanda-deploy', 'deploy')[-1], 'deploy')
        self.assertEqual(entry.command('qanda-debug', 'shell api')[-2:], ['shell', 'api'])
        for user, original in [('qanda-deploy', 'shell api'), ('qanda-debug', 'deploy'),
                               ('qanda-debug', 'bash'), ('qanda-debug', 'internal-sftp'),
                               ('qanda-deploy', 'deploy; whoami'), ('other-user', 'status'),
                               ('qanda-deploy', ''), ('qanda-debug', '')]:
            with self.subTest(user=user, original=original), self.assertRaises(ValueError):
                entry.command(user, original)

    def test_container_arguments_cannot_select_other_services_or_host_commands(self):
        with patch.object(deployctl, 'node_role', return_value='backend'):
            self.assertEqual(deployctl.debug_request('logs', ['api', '--follow']), 'api')
            for action, args in [('shell', ['web']), ('shell', ['api', '--privileged']),
                                 ('shell', ['api;whoami']), ('logs', ['postgres']),
                                 ('logs', ['api', '--since', '1h']), ('containers', ['api']),
                                 ('exec', ['api']), ('restart', ['../other-project'])]:
                with self.subTest(action=action, args=args), self.assertRaises(ValueError):
                    deployctl.debug_request(action, args)

    def test_inspection_rejects_other_projects_host_mounts_and_privileged_containers(self):
        good = container()
        with patch.object(deployctl, 'node_role', return_value='backend'):
            with patch.object(deployctl, 'run', side_effect=['a' * 64, json.dumps([good])]):
                self.assertEqual(deployctl.owned_container('api')['Id'], 'a' * 64)
            variants = []
            for field, value in [('Privileged', True), ('NetworkMode', 'host'), ('PidMode', 'host'),
                                 ('Devices', [{}]), ('CapAdd', ['SYS_ADMIN'])]:
                bad = copy.deepcopy(good)
                bad['HostConfig'][field] = value
                variants.append(bad)
            bad = copy.deepcopy(good)
            bad['Config']['Labels']['com.docker.compose.project'] = 'another-project'
            variants.append(bad)
            bad = copy.deepcopy(good)
            bad['Mounts'] = [{'Type': 'bind', 'Source': '/', 'Destination': '/host', 'RW': True}]
            variants.append(bad)
            bad = copy.deepcopy(good)
            bad['NetworkSettings']['Networks']['other-project'] = {}
            variants.append(bad)
            for bad in variants:
                with patch.object(deployctl, 'run', side_effect=['a' * 64, json.dumps([bad])]), self.assertRaises(RuntimeError):
                    deployctl.owned_container('api')

    def test_shell_executes_inside_the_selected_container(self):
        with patch.object(deployctl, 'node_role', return_value='backend'), patch.object(deployctl, 'protected'), \
                patch.object(deployctl, 'owned_container', return_value=container()), \
                patch.object(sys.stdin, 'isatty', return_value=False), patch.object(deployctl.os, 'execvp') as execute:
            deployctl.debug('shell', ['api'])
        execute.assert_called_once_with('docker', ['docker', 'exec', '-i', 'a' * 64, '/bin/sh'])

    def test_restart_is_blocked_during_a_release(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployctl, 'STATE', Path(directory)), \
                patch.object(deployctl, 'node_role', return_value='backend'), patch.object(deployctl, 'protected'), \
                patch.object(deployctl, 'owned_container', return_value=container()), patch.object(deployctl, 'run') as run:
            (Path(directory) / 'operation.json').write_text('{"phase":"starting"}')
            with self.assertRaisesRegex(RuntimeError, 'release'):
                deployctl.debug('restart', ['api'])
            run.assert_not_called()

    def test_gateway_can_reach_only_the_fixed_project_operations_port_on_the_host(self):
        accepted = [rule for rule in guard.rules(4, ['172.29.71.0/24'])['QANDA-HOST'] if rule[-1] == 'ACCEPT']
        self.assertEqual(accepted, [['-s', '172.29.71.20/32', '-d', '172.29.71.1/32', '-p', 'tcp',
                                    '-m', 'tcp', '--dport', '2203', '-j', 'ACCEPT']])

    def test_each_node_accepts_only_its_own_release_and_normalizes_legacy_state(self):
        release = {'revision': 'a' * 40, 'backend': 'ghcr.io/zhouycheng/qanda-backend@sha256:' + 'a' * 64,
                   'web': 'ghcr.io/zhouycheng/qanda-web@sha256:' + 'b' * 64}
        for role, kind, other in [('backend', 'backend', 'web'), ('frontend', 'web', 'backend')]:
            with patch.object(deployctl, 'node_role', return_value=role):
                expected = {key: release[key] for key in ('revision', kind)}
                self.assertEqual(deployctl.validate_release(expected), expected)
                self.assertEqual(deployctl.validate_release(release), expected)
                with self.assertRaises(ValueError):
                    deployctl.validate_release({key: release[key] for key in ('revision', other)})

    def test_backend_release_does_not_require_a_web_image_or_start_a_web_candidate(self):
        with patch.dict('os.environ', {'DEPLOY_NODE': 'backend', 'GITHUB_ACTOR': 'test',
                                      'REGISTRY_TOKEN': 'isolated-test-token', 'GITHUB_SHA': 'a' * 40,
                                      'BACKEND': 'backend-image'}, clear=True), \
                patch.object(dispatch, 'remote', side_effect=[None, {'operation': {'phase': 'complete'}}]) as remote:
            dispatch.execute('backend-node', 'deploy')
            self.assertEqual(set(remote.call_args_list[0].args[2]['release']), {'revision', 'backend'})
        def command(args, **kwargs):
            return SimpleNamespace(stdout='{"status":"UP"}' if 'curl' in args else '')
        with patch.object(candidate.subprocess, 'run', side_effect=command) as docker, patch('builtins.print'):
            candidate.check('backend-image')
        commands = [call.args[0] for call in docker.call_args_list]
        self.assertEqual(sum('schema-init' in command for command in commands), 2)
        self.assertFalse(any('wget' in command for command in commands))

    def test_dispatch_streams_only_the_hash_checked_image_archive(self):
        archive = b'docker image archive'
        class Sink(io.BytesIO):
            def close(self):
                pass
        class Process:
            def __init__(self, **kwargs):
                self.stdin = Sink()
            def wait(self):
                return 0
        with tempfile.NamedTemporaryFile() as file:
            file.write(archive)
            file.flush()
            process = Process()
            with patch.object(dispatch.subprocess, 'Popen', return_value=process) as popen:
                dispatch.remote('backend-node', 'deploy', {'release': {'revision': 'a' * 40}},
                                ssh=['ssh'], image_archive=file.name,
                                image_sha256=hashlib.sha256(archive).hexdigest())
            header, body = process.stdin.getvalue().split(b'\n', 1)
            self.assertEqual(json.loads(header)['image_sha256'], hashlib.sha256(archive).hexdigest())
            self.assertEqual(body, archive)
            self.assertEqual(popen.call_args.args[0][-2:], ['qanda-deploy@backend-node', 'deploy'])
        with tempfile.NamedTemporaryFile() as file:
            file.write(archive)
            file.flush()
            with patch.object(dispatch.subprocess, 'Popen') as popen, self.assertRaisesRegex(ValueError, 'SHA-256'):
                dispatch.remote('backend-node', 'deploy', {}, ssh=['ssh'], image_archive=file.name,
                                image_sha256='0' * 64)
                popen.assert_not_called()

    def test_image_transfer_package_pulls_only_the_selected_private_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / 'bin'
            binaries.mkdir()
            docker = binaries / 'docker'
            docker.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = save ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --output ]; then shift; printf image-archive > "$1"; break; fi
    shift
  done
fi
''')
            docker.chmod(0o755)
            archive, output, log = root / 'qanda-image.tar', root / 'output', root / 'docker.log'
            image = 'ghcr.io/zhouycheng/qanda-backend@sha256:' + 'a' * 64
            env = {**os.environ, 'PATH': str(binaries) + os.pathsep + os.environ['PATH'],
                   'IMAGE_KIND': 'backend', 'IMAGE': image, 'REGISTRY_TOKEN': 'isolated-token',
                   'GITHUB_ACTOR': 'runner', 'RUNNER_TEMP': str(root), 'GITHUB_OUTPUT': str(output),
                   'DOCKER_LOG': str(log)}
            result = subprocess.run(['bash', str(DEPLOY / 'prepare-image-transfer.sh')], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            local_tag = image.replace('@sha256:', ':sha256-')
            self.assertEqual(archive.read_bytes(), b'image-archive')
            self.assertIn(hashlib.sha256(b'image-archive').hexdigest(), output.read_text())
            self.assertEqual(log.read_text().splitlines(), [
                'login ghcr.io -u runner --password-stdin', f'pull {image}',
                f'tag {image} {local_tag}', f'save --output {archive} {local_tag}', 'logout ghcr.io'])
            env['IMAGE_KIND'] = 'web'
            before = log.read_text()
            rejected = subprocess.run(['bash', str(DEPLOY / 'prepare-image-transfer.sh')], env=env, capture_output=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(log.read_text(), before)

    def test_polling_recovers_from_a_temporary_ssh_disconnect_without_resubmitting(self):
        with patch.dict('os.environ', {'GITHUB_ACTOR': 'test', 'REGISTRY_TOKEN': 'isolated-test-token'}), \
                patch.object(dispatch, 'remote', side_effect=[None, subprocess.CalledProcessError(255, ['ssh']),
                    {'operation': {'phase': 'complete'}}]) as remote, patch.object(dispatch.time, 'sleep') as sleep:
            dispatch.execute('backend-node', 'rollback')
        self.assertEqual([call.args[1] for call in remote.call_args_list], ['rollback', 'status', 'status'])
        sleep.assert_called_once_with(10)


if __name__ == '__main__':
    unittest.main()
