import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).parents[1]
sys.path.insert(0, str(DEPLOY))
import deployctl


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

    def test_activation_reasserts_project_firewall_after_tailnet_is_ready(self):
        events = []
        def command(*args, **kwargs):
            events.append(args)
            return 'healthy' if args[:2] == ('docker', 'inspect') else ''
        def tailnet(*args):
            events.append(('tailnet-ready',))
            return 'tailnet'
        with tempfile.TemporaryDirectory() as directory, patch.object(deployctl, 'STATE', Path(directory)), \
                patch.object(deployctl, 'node_role', return_value='backend'), \
                patch.object(deployctl, 'compose'), patch.object(deployctl, 'start_public_gateway'), patch.object(deployctl, 'run', side_effect=command), \
                patch.object(deployctl, 'tailnet_compose', side_effect=tailnet), patch.object(deployctl.time, 'sleep'):
            deployctl.activate({'revision': 'a' * 40, 'backend': 'backend-image'})
        self.assertLess(events.index(('tailnet-ready',)), events.index(('/usr/local/lib/qanda/network-guard.py',)))

    def test_each_node_accepts_only_its_own_release(self):
        for role, kind in [('frontend', 'web'), ('backend', 'backend')]:
            with patch.object(deployctl, 'node_role', return_value=role):
                value = {'revision': 'a'*40, kind: 'sha256:'+'b'*64}
                self.assertEqual(deployctl.validate_release(value), value)
                for invalid in [dict(value, other='sha256:'+'c'*64),
                                dict(value, **{kind: 'ghcr.io/zhouycheng/qanda-'+kind+'@sha256:'+'b'*64})]:
                    with self.assertRaises(ValueError): deployctl.validate_release(invalid)

    def test_backend_release_does_not_require_a_web_image_or_start_a_web_candidate(self):
        def command(args, **kwargs):
            output='{"status":"UP"}' if 'curl' in args else ('PONG' if any('redis-cli ping' in arg for arg in args) else '')
            return SimpleNamespace(stdout=output)
        with patch.object(candidate.subprocess, 'run', side_effect=command) as docker, patch('builtins.print'):
            candidate.check('backend-image')
        commands = [call.args[0] for call in docker.call_args_list]
        self.assertEqual(sum('schema-init' in command for command in commands), 2)
        self.assertFalse(any('wget' in command for command in commands))
        cache=next(command for command in commands if 'redis:8.10.3-alpine' in command)
        self.assertIn('--read-only',cache)
        self.assertIn('--memory',cache)
        self.assertNotIn('-p',cache)


if __name__ == '__main__':
    unittest.main()
