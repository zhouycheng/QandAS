import importlib.util
import hashlib
import ipaddress
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import ANY, patch

DEPLOY = Path(__file__).parents[1]
sys.path.insert(0, str(DEPLOY))
import targets
import dispatch
import deployctl

spec = importlib.util.spec_from_file_location('network_guard', DEPLOY / 'network-guard.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def topology():
    return {kind: {'server': kind + '-management', 'admin_user': 'ubuntu',
                   'service_ip': f'100.64.0.{i + 10}'} for i, kind in enumerate(('frontend', 'backend'))}


class TailnetTests(unittest.TestCase):
    def test_service_routes_use_container_addresses_and_trust_only_the_local_gateway(self):
        nodes = topology()
        targets.validate(nodes)
        front = dict(line.split('=', 1) for line in targets.node_configuration(nodes, 'frontend')['env'].splitlines())
        back = dict(line.split('=', 1) for line in targets.node_configuration(nodes, 'backend')['env'].splitlines())
        self.assertEqual(front['PRODUCTION_API_UPSTREAM'], 'http://qanda-tailnet:18084')
        self.assertEqual(front['TAILNET_API_UPSTREAM'], 'http://100.64.0.11:18084')
        self.assertEqual(back['TAILNET_ALLOWED_CLIENT'], '100.64.0.10')
        self.assertEqual(back['TAILNET_API_UPSTREAM'], 'http://api:8083')
        self.assertEqual(back['PRODUCTION_TRUSTED_PROXIES'], r'172\.29\.71\.20')
        self.assertEqual(front['TAILNET_TAG_ARGS'], '')
        self.assertEqual(back['TAILNET_TAG_ARGS'], '--advertise-tags=tag:qanda-backend')
        self.assertNotIn('TAILNET_BIND_ADDRESS', back)

    def test_rejects_public_missing_and_duplicate_project_addresses(self):
        for bad in ('203.0.113.5', '127.0.0.1', '100.64.0.10', 'fd00::1'):
            nodes = topology()
            nodes['backend']['service_ip'] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                targets.validate(nodes)
        nodes = topology()
        del nodes['backend']['service_ip']
        with self.assertRaises(ValueError):
            targets.validate(nodes)

    def test_shared_address_remapping_changes_service_routes_but_not_ci_targets(self):
        nodes = topology()
        nodes['backend']['service_ip'] = nodes['frontend']['service_ip']
        nodes['backend']['peer_ip'] = '100.64.0.20'
        nodes['frontend']['peer_ip'] = '100.64.0.21'
        targets.validate(nodes)
        front = dict(line.split('=', 1) for line in targets.node_configuration(nodes, 'frontend')['env'].splitlines())
        back = dict(line.split('=', 1) for line in targets.node_configuration(nodes, 'backend')['env'].splitlines())
        self.assertEqual(front['TAILNET_API_UPSTREAM'], 'http://100.64.0.20:18084')
        self.assertEqual(back['TAILNET_ALLOWED_CLIENT'], '100.64.0.21')
        self.assertEqual(back['TAILNET_NODE_IP'], nodes['backend']['service_ip'])
        nodes['backend']['peer_ip'] = '203.0.113.9'
        with self.assertRaises(ValueError):
            targets.validate(nodes)

    def test_render_is_private_and_never_connects_or_updates_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'targets.json'
            source.write_text(json.dumps(topology()))
            source.chmod(0o600)
            with patch.object(targets.subprocess, 'run') as remote, patch('builtins.print'):
                targets.configure(source, root / 'rendered')
            remote.assert_not_called()
            for kind in ('frontend', 'backend'):
                path = root / 'rendered' / kind / 'node.env'
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(len(path.read_text().splitlines()), 10)

    def test_selected_deployment_never_contacts_the_other_owner(self):
        with tempfile.NamedTemporaryFile() as summary, tempfile.NamedTemporaryFile() as archive, patch.dict('os.environ', {
            'DEPLOY_TARGETS': json.dumps(topology()), 'DEPLOY_NODE': 'frontend',
            'OPERATION': 'deploy', 'GITHUB_STEP_SUMMARY': summary.name,
            'IMAGE_ARCHIVE': archive.name,
            'IMAGE_ARCHIVE_SHA256': hashlib.sha256(b'verified image').hexdigest(),
            'DEPLOY_SSH_KEY': 'isolated-test-key', 'DEPLOY_SSH_KNOWN_HOSTS': 'isolated-host-key',
        }), patch.object(dispatch, 'remote', return_value={'current': None, 'role': 'frontend'}) as remote, \
                patch.object(dispatch, 'execute', return_value={'operation': {'phase': 'complete'}, 'current': {'revision': 'a' * 40}}) as execute:
            archive.write(b'verified image')
            archive.flush()
            dispatch.main()
            remote.assert_called_once_with('100.64.0.10', 'status', ssh=ANY)
            execute.assert_called_once_with('100.64.0.10', 'deploy', ssh=ANY,
                                            image_archive=archive.name,
                                            image_sha256=hashlib.sha256(b'verified image').hexdigest())
            command = remote.call_args.kwargs['ssh']
            self.assertIn('-C', command)
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertIn('HostKeyAlias=qanda-frontend', command)
            self.assertFalse(Path(command[command.index('-i') + 1]).exists())

    def test_backend_deployment_can_pull_its_digest_on_the_backend_node(self):
        with tempfile.NamedTemporaryFile() as summary, patch.dict('os.environ', {
            'DEPLOY_TARGETS': json.dumps(topology()), 'DEPLOY_NODE': 'backend',
            'OPERATION': 'deploy', 'GITHUB_STEP_SUMMARY': summary.name,
            'DEPLOY_SSH_KEY': 'isolated-test-key', 'DEPLOY_SSH_KNOWN_HOSTS': 'isolated-host-key',
        }, clear=True), patch.object(dispatch, 'remote', return_value={'current': None, 'role': 'backend'}) as remote, \
                patch.object(dispatch, 'execute', return_value={
                    'operation': {'phase': 'complete'}, 'current': {'revision': 'a' * 40}}) as execute:
            dispatch.main()
        remote.assert_called_once_with('100.64.0.11', 'status', ssh=ANY)
        execute.assert_called_once_with('100.64.0.11', 'deploy', ssh=ANY,
                                        image_archive=None, image_sha256=None)

    def test_wrong_management_role_never_starts_a_release(self):
        with patch.dict('os.environ', {'DEPLOY_TARGETS': json.dumps(topology()), 'DEPLOY_NODE': 'backend',
                                     'DEPLOY_SSH_KEY': 'isolated-test-key', 'DEPLOY_SSH_KNOWN_HOSTS': 'isolated-host-key'}), \
                patch.object(dispatch, 'remote', return_value={'role': 'frontend'}), \
                patch.object(dispatch, 'execute') as execute, self.assertRaises(ValueError):
            dispatch.main()
        execute.assert_not_called()

    def test_connection_check_reads_only_status_and_never_starts_a_release(self):
        for role in ('frontend', 'backend'):
            with self.subTest(role=role), tempfile.NamedTemporaryFile() as summary, patch.dict('os.environ', {
                'DEPLOY_TARGETS': json.dumps(topology()), 'DEPLOY_NODE': role, 'OPERATION': 'check',
                'GITHUB_STEP_SUMMARY': summary.name, 'DEPLOY_SSH_KEY': 'isolated-test-key',
                'DEPLOY_SSH_KNOWN_HOSTS': 'isolated-host-key',
            }), patch.object(dispatch, 'remote', return_value={'role': role, 'current': None, 'operation': None}) as remote, \
                    patch.object(dispatch, 'execute') as execute:
                dispatch.main()
                execute.assert_not_called()
                self.assertEqual(remote.call_count, 1)
                self.assertEqual(remote.call_args.args[1], 'status')
                self.assertIn('connection verified', Path(summary.name).read_text())

    def test_tailnet_identity_and_routing_are_verified(self):
        status = {'BackendState': 'Running', 'TailscaleIPs': ['100.64.0.11'], 'Self': {'Tags': ['tag:qanda-backend']}}
        with tempfile.TemporaryDirectory() as directory, patch.object(deployctl, 'ROOT', Path(directory)), \
                patch.object(deployctl, 'node_role', return_value='backend'):
            (Path(directory) / 'node.env').write_text('TAILNET_NODE_IP=100.64.0.11\n')
            expected_serve = {'TCP': {'2222': {'TCPForward': '172.29.71.1:2203'}}}
            with patch.object(deployctl, 'tailnet_compose', side_effect=[json.dumps(status), '{}', json.dumps(expected_serve)]):
                deployctl.check_tailnet_identity({})
            with patch.object(deployctl, 'tailnet_compose', side_effect=[json.dumps(status), '{}', '{"TCP":{"2222":{"TCPForward":"172.29.71.1:22"}}}']), self.assertRaises(RuntimeError):
                deployctl.check_tailnet_identity({})
            for prefs in ({'RunSSH': True}, {'RouteAll': True}, {'AdvertiseRoutes': ['10.0.0.0/8']}, {'ExitNodeID': 'some-node'}):
                with self.subTest(prefs=prefs), patch.object(deployctl, 'tailnet_compose', side_effect=[json.dumps(status), json.dumps(prefs)]), self.assertRaises(RuntimeError):
                    deployctl.check_tailnet_identity({})
            for changed in ({'TailscaleIPs': ['100.64.0.99']}, {'TailscaleIPs': None}, {'Self': None},
                            {'Self': {'Tags': ['tag:qanda-backend', 'tag:qanda-frontend']}}):
                with self.subTest(changed=changed), patch.object(deployctl, 'tailnet_compose', return_value=json.dumps({**status, **changed})), self.assertRaises(RuntimeError):
                    deployctl.check_tailnet_identity({})

    def test_frontend_requires_a_user_owned_identity_to_reach_the_shared_backend(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(deployctl, 'ROOT', Path(directory)), \
                patch.object(deployctl, 'node_role', return_value='frontend'):
            (Path(directory) / 'node.env').write_text('TAILNET_NODE_IP=100.64.0.10\n')
            status = {'BackendState': 'Running', 'TailscaleIPs': ['100.64.0.10'], 'Self': {'UserID': 123}}
            serve = {'TCP': {'2222': {'TCPForward': '172.29.71.1:2203'}}}
            with patch.object(deployctl, 'tailnet_compose', side_effect=[json.dumps(status), '{}', json.dumps(serve)]):
                deployctl.check_tailnet_identity({})
            for identity in ({}, {'UserID': 123, 'Tags': ['tag:qanda-frontend']}):
                with patch.object(deployctl, 'tailnet_compose', return_value=json.dumps({**status, 'Self': identity})), self.assertRaises(RuntimeError):
                    deployctl.check_tailnet_identity({})

    def test_each_owner_policy_restricts_ci_and_shared_service_access(self):
        policies = {kind: json.loads((DEPLOY / f'tailnet-{kind}-policy.example.json').read_text())
                    for kind in ('frontend', 'backend')}
        for policy in policies.values():
            self.assertEqual(policy['ssh'], [])
            self.assertTrue(all('*' not in g['src'] + g['dst'] + g['ip'] for g in policy['grants']))
            ci = [g for g in policy['grants'] if 'tag:qanda-ci' in g['src']]
            self.assertEqual(len(ci), 1)
            self.assertEqual(ci[0]['ip'], ['tcp:2222'])
        shared = [g for g in policies['backend']['grants'] if 'autogroup:shared' in g['src']]
        self.assertEqual(shared, [{'src': ['autogroup:shared'], 'dst': ['tag:qanda-backend'],
                                  'ip': ['tcp:2222', 'tcp:18084', 'tcp:18085']}])

    def test_firewall_blocks_host_new_connections_and_private_egress_but_preserves_replies(self):
        for version, allowed, denied in (
            (4, '172.29.71.9', ('169.254.169.254', '100.64.0.8', '192.168.1.1', '172.19.0.5')),
            (6, 'fd12:3456::9', ('fe80::1', 'fd98::1', '::1')),
        ):
            entries = guard.rules(version, ['172.29.71.0/24', 'fd12:3456::/64'])
            self.assertEqual(entries['QANDA-HOST'][-1], ['-j', 'DROP'])
            self.assertIn('RELATED,ESTABLISHED', entries['QANDA-HOST'][0])
            def verdict(address):
                for rule in entries['QANDA-EGRESS'][1:]:
                    if '-d' not in rule or ipaddress.ip_address(address) in ipaddress.ip_network(rule[1]):
                        return rule[-1]
            self.assertEqual(verdict(allowed), 'RETURN')
            for address in denied:
                self.assertEqual(verdict(address), 'DROP')

    def test_firewall_rejects_a_permissive_rule_between_project_jumps(self):
        def command(*args, **kwargs):
            if args[-2] == '-S' and args[-1] in guard.CHAINS:
                chain = args[-1]
                return '\n'.join(' '.join(['-A', chain, *entry]) for entry in guard.rules(4, [])[chain])
            if args[-2:] == ('-S', 'INPUT'):
                return '-A INPUT -i br-data -j QANDA-HOST\n-A INPUT -j ACCEPT\n-A INPUT -i br-app -j QANDA-HOST\n'
            return ''
        with patch.object(guard, 'run', side_effect=command), self.assertRaisesRegex(RuntimeError, 'precede'):
            guard.enforce(['br-app', 'br-data'], [], check=True)


if __name__ == '__main__':
    unittest.main()
