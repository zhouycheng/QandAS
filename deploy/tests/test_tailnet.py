import importlib.util
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
    return {
        'frontend': {'server': 'frontend-management', 'admin_user': 'ubuntu', 'service_ip': '100.64.0.10', 'public_ip': '8.8.8.8'},
        'backend': {'server': 'backend-management', 'admin_user': 'ubuntu', 'service_ip': '100.64.0.11', 'public_api_url': 'http://backend.example.com'},
    }


class TailnetTests(unittest.TestCase):
    def test_business_uses_public_endpoint_and_operations_keep_their_own_nodes(self):
        nodes = topology()
        targets.validate(nodes)
        front = dict(line.split('=', 1) for line in targets.node_configuration(nodes, 'frontend', 'a' * 64)['env'].splitlines())
        back = dict(line.split('=', 1) for line in targets.node_configuration(nodes, 'backend', 'a' * 64)['env'].splitlines())
        self.assertEqual(front['PRODUCTION_API_UPSTREAM'], 'http://backend.example.com')
        self.assertEqual(front['PRODUCTION_MONITOR_UPSTREAM'], front['PRODUCTION_API_UPSTREAM'])
        self.assertEqual(back['PUBLIC_GATEWAY_ALLOWED_CLIENT'], '8.8.8.8')
        self.assertEqual(back['PRODUCTION_TRUSTED_PROXIES'], r'172\.29\.71\.30')
        self.assertEqual(front['PUBLIC_GATEWAY_KEY'], back['PUBLIC_GATEWAY_KEY'])
        self.assertFalse(any(key.startswith(('TAILNET_API', 'TAILNET_MONITOR', 'TAILNET_ALLOWED')) for key in front | back))
        self.assertEqual(front['TAILNET_TAG_ARGS'], '')
        self.assertEqual(back['TAILNET_TAG_ARGS'], '--advertise-tags=tag:qanda-backend')
        self.assertNotIn('TAILNET_BIND_ADDRESS', back)

    def test_rejects_public_or_missing_operations_addresses(self):
        for bad in ('203.0.113.5', '127.0.0.1', 'fd00::1'):
            nodes = topology()
            nodes['backend']['service_ip'] = bad
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                targets.validate(nodes)
        nodes = topology()
        del nodes['backend']['service_ip']
        with self.assertRaises(ValueError):
            targets.validate(nodes)

    def test_independent_operations_networks_may_use_the_same_address(self):
        nodes = topology()
        nodes['backend']['service_ip'] = nodes['frontend']['service_ip']
        targets.validate(nodes)
        back = dict(line.split('=', 1) for line in targets.node_configuration(nodes, 'backend', 'a' * 64)['env'].splitlines())
        self.assertEqual(back['TAILNET_NODE_IP'], '100.64.0.10')
        nodes['backend']['peer_ip'] = '203.0.113.9'
        with self.assertRaises(ValueError):
            targets.validate(nodes)

    def test_render_is_private_and_never_connects_or_updates_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'targets.json'
            source.write_text(json.dumps(topology()))
            source.chmod(0o600)
            key = root / 'gateway.key'
            key.write_text('a' * 64 + '\n')
            key.chmod(0o600)
            with patch.object(targets.subprocess, 'run') as remote, patch('builtins.print'):
                targets.configure(source, root / 'rendered', key)
            remote.assert_not_called()
            for kind in ('frontend', 'backend'):
                path = root / 'rendered' / kind / 'node.env'
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertIn('PUBLIC_GATEWAY_KEY=', path.read_text())

    def test_selected_deployment_never_contacts_the_other_owner(self):
        with tempfile.NamedTemporaryFile() as summary, patch.dict('os.environ', {
            'DEPLOY_TARGETS': json.dumps(topology()), 'DEPLOY_NODE': 'frontend',
            'OPERATION': 'deploy', 'GITHUB_STEP_SUMMARY': summary.name,
            'DEPLOY_SSH_KEY': 'isolated-test-key', 'DEPLOY_SSH_KNOWN_HOSTS': 'isolated-host-key',
        }), patch.object(dispatch, 'remote', return_value={'current': None, 'role': 'frontend', 'source_build_protocol': 1}) as remote, \
                patch.object(dispatch, 'execute', return_value={'operation': {'phase': 'complete'}, 'current': {'revision': 'a' * 40}}) as execute:
            dispatch.main()
            remote.assert_called_once_with('100.64.0.10', 'status', ssh=ANY)
            execute.assert_called_once_with('100.64.0.10', 'deploy', ssh=ANY)
            command = remote.call_args.kwargs['ssh']
            self.assertIn('-C', command)
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertIn('HostKeyAlias=qanda-frontend', command)
            self.assertFalse(Path(command[command.index('-i') + 1]).exists())

    def test_backend_deployment_builds_only_on_the_backend_node(self):
        with tempfile.NamedTemporaryFile() as summary, patch.dict('os.environ', {
            'DEPLOY_TARGETS': json.dumps(topology()), 'DEPLOY_NODE': 'backend',
            'OPERATION': 'deploy', 'GITHUB_STEP_SUMMARY': summary.name,
            'DEPLOY_SSH_KEY': 'isolated-test-key', 'DEPLOY_SSH_KNOWN_HOSTS': 'isolated-host-key',
        }, clear=True), patch.object(dispatch, 'remote', return_value={'current': None, 'role': 'backend', 'source_build_protocol': 1}) as remote, \
                patch.object(dispatch, 'execute', return_value={
                    'operation': {'phase': 'complete'}, 'current': {'revision': 'a' * 40}}) as execute:
            dispatch.main()
        remote.assert_called_once_with('100.64.0.11', 'status', ssh=ANY)
        execute.assert_called_once_with('100.64.0.11', 'deploy', ssh=ANY)

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
            }), patch.object(dispatch, 'remote', return_value={'role': role, 'current': None, 'operation': None, 'source_build_protocol': 1}) as remote, \
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

    def test_frontend_preserves_the_provisioned_user_owned_operations_identity(self):
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

    def test_each_owner_policy_exposes_only_the_restricted_operations_port(self):
        policies = {kind: json.loads((DEPLOY / f'tailnet-{kind}-policy.example.json').read_text())
                    for kind in ('frontend', 'backend')}
        for policy in policies.values():
            self.assertEqual(policy['ssh'], [])
            self.assertTrue(all('*' not in g['src'] + g['dst'] + g['ip'] for g in policy['grants']))
            ci = [g for g in policy['grants'] if 'tag:qanda-ci' in g['src']]
            self.assertEqual(len(ci), 1)
            self.assertEqual(ci[0]['ip'], ['tcp:2222'])
        self.assertTrue(all(g['ip'] == ['tcp:2222'] for policy in policies.values() for g in policy['grants']))

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

    def test_only_flat_non_accepting_chains_may_precede_project_guards(self):
        for target, accepted in (('DROP', True), ('REJECT', True), ('RETURN', False), ('ACCEPT', False)):
            with self.subTest(target=target):
                self.assertEqual(guard.non_accepting_jump('iptables', '-A INPUT -j ' + target), accepted)
        for body, accepted in (
            ('', True),
            ('-A CLOUD-DENY -p tcp --dport 22 -j REJECT\n-A CLOUD-DENY -j RETURN', True),
            ('-A CLOUD-DENY -j ACCEPT', False),
            ('-A CLOUD-DENY -j OTHER', False),
            ('-A CLOUD-DENY -g OTHER', False),
            ('-A CLOUD-DENY -j LOG', False),
        ):
            with self.subTest(body=body), patch.object(guard, 'run', return_value='-N CLOUD-DENY\n' + body):
                self.assertEqual(guard.non_accepting_jump('iptables', '-A INPUT -j CLOUD-DENY'), accepted)
                self.assertFalse(guard.non_accepting_jump('iptables', '-A INPUT -g CLOUD-DENY'))
        with patch.object(guard, 'run', return_value='-P INPUT ACCEPT\n-A INPUT -j DROP'):
            self.assertFalse(guard.non_accepting_jump('iptables', '-A FORWARD -j INPUT'))
        with patch.object(guard, 'run', side_effect=subprocess.CalledProcessError(1, 'iptables')):
            self.assertFalse(guard.non_accepting_jump('iptables', '-A INPUT -j UNKNOWN'))

    def test_firewall_check_preserves_a_preceding_deny_only_security_agent_chain(self):
        def command(*args, **kwargs):
            version = 6 if args[0] == 'ip6tables' else 4
            if args[-2] == '-S' and args[-1] in guard.CHAINS:
                chain = args[-1]
                return '\n'.join(' '.join(['-A', chain, *entry]) for entry in guard.rules(version, [])[chain])
            if args[-2:] == ('-S', 'INPUT'):
                return '-A INPUT -j CLOUD-DENY\n-A INPUT -i br-app -j QANDA-HOST\n'
            if args[-2:] == ('-S', 'CLOUD-DENY'):
                return '-N CLOUD-DENY\n-A CLOUD-DENY -p tcp --dport 22 -j REJECT\n'
            if args[-2] == '-S':
                return '-A ' + args[-1] + ' -i br-app -j QANDA-EGRESS\n'
            return ''
        with patch.object(guard, 'run', side_effect=command) as run:
            guard.enforce(['br-app'], [], check=True)
        self.assertFalse(any(arg in ('-I', '-D', '-F', '--noflush') for call in run.call_args_list for arg in call.args))


if __name__ == '__main__':
    unittest.main()
