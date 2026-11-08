"""Self-checks for success accounting, adaptive load, and recovery boundaries."""
import json
import io
import asyncio
import os
from pathlib import Path
import tempfile
import sys
import subprocess
import time
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from run import Guard, Metrics, audit_after_drain, backlog_violations, collection_failure, epoch, next_target, summarize, suite, trial, violations, wait_drain
from seed import question
from resources import http_busy, metrics, server_p95, series
import remote
import client as transport_client
import tunnel as transport_tunnel


class CapacityTests(unittest.TestCase):
    def test_sync_retry_matches_client_backoff_jitter_and_retry_after(self):
        subprocess.run(['node', '--input-type=module', '-e', '''
import assert from 'node:assert/strict';
import { retryDelay } from './retry-delay.mjs';
assert.equal(retryDelay(1, 0, 0), 500);
assert.equal(retryDelay(2, 0, 1), 2000);
assert.equal(retryDelay(10, 0, 1), 60000);
assert.equal(retryDelay(1, '60', 0), 60000);
assert.equal(retryDelay(2, 1, 0), 1000);
assert.equal(retryDelay(1, 'invalid', 1), 1000);
'''], cwd=Path(__file__).parent, check=True, capture_output=True)

    def test_async_transport_pins_host_verification_and_project_listener(self):
        listener = SimpleNamespace(close=Mock(), wait_closed=AsyncMock())
        connection = SimpleNamespace(run=AsyncMock(return_value=SimpleNamespace(stdout='{"tunnel_ready":true,"nofile_soft":32768}')),
                                     forward_local_port=AsyncMock(return_value=listener), wait_closed=AsyncMock(), abort=Mock())
        context = AsyncMock(); context.__aenter__.return_value = connection
        connect = Mock(return_value=context)
        client = SimpleNamespace(state=Path('20261109-r2'), config={'host': 'test.invalid', 'user': 'operator', 'key': '/private/test-key', 'port': 18093, 'remote_dir': '/var/lib/qanda-capacity/20261109-r2'}, action=Mock(return_value={'api': '172.29.71.2'}))
        with patch.object(transport_tunnel, 'Remote', return_value=client), patch.dict(sys.modules, {'asyncssh': SimpleNamespace(connect=connect)}), patch('builtins.print'):
            with self.assertRaisesRegex(RuntimeError, 'closed unexpectedly'): asyncio.run(transport_tunnel.serve('private-state'))
        settings = connect.call_args.kwargs
        self.assertTrue(settings['known_hosts'].endswith('/.ssh/known_hosts'))
        self.assertIsNone(settings['config']); self.assertIsNone(settings['agent_path'])
        self.assertEqual(settings['client_keys'], ['/private/test-key'])
        connection.forward_local_port.assert_awaited_once_with('127.0.0.1', 18093, '172.29.71.2', 8083)
        self.assertIn('remote.py tunnel --run 20261109-r2', connection.run.call_args.args[0])
        listener.close.assert_called_once(); listener.wait_closed.assert_awaited_once()

    def test_async_transport_rejects_targets_outside_project_network(self):
        connect = Mock()
        client = SimpleNamespace(config={}, action=Mock(return_value={'api': '127.0.0.1'}))
        with patch.object(transport_tunnel, 'Remote', return_value=client), patch.dict(sys.modules, {'asyncssh': SimpleNamespace(connect=connect)}):
            with self.assertRaisesRegex(ValueError, 'project API bridge'): asyncio.run(transport_tunnel.serve('private-state'))
        connect.assert_not_called()

    def test_unverified_tunnel_limit_closes_transport_before_api_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            process = Mock(stdout=io.BytesIO(b'{"tunnel_ready":true,"nofile_soft":1024}\n'))
            client = SimpleNamespace(state=Path(directory), config={'port': 18093})
            with patch.object(transport_client.subprocess, 'Popen', return_value=process), patch.object(transport_client.select, 'select', return_value=([process.stdout], [], [])), patch.object(transport_client, 'Api') as api:
                with self.assertRaisesRegex(RuntimeError, 'file limit was not verified'): transport_client.Remote.tunnel(client)
            process.terminate.assert_called_once(); process.wait.assert_called_once(); api.assert_not_called()

    def test_tunnel_raises_only_its_ssh_ancestor_soft_limit(self):
        with tempfile.TemporaryDirectory() as root:
            for pid, name, parent in ((10, 'sudo', 20), (20, 'sshd', 30)):
                proc = Path(root) / str(pid); proc.mkdir()
                (proc / 'comm').write_text(name); (proc / 'status').write_text('PPid:\t' + str(parent))
            unlimited = remote.resource.RLIM_INFINITY
            for soft, hard, effective in ((1024, 1048576, 32768), (65536, 1048576, 65536), (unlimited, unlimited, unlimited)):
                with self.subTest(soft=soft):
                    with patch.object(remote, 'assert_capacity'), patch.object(remote.os, 'getppid', return_value=10), patch.object(remote, 'Path', return_value=Path(root)), patch.object(remote.resource, 'prlimit', create=True, return_value=(soft, hard)) as limit:
                        value = remote.tunnel()
                    self.assertEqual(limit.call_args_list[-1].args, (20, remote.resource.RLIMIT_NOFILE, (effective, hard)))
                    self.assertTrue(value['tunnel_ready']); self.assertEqual(value['previous_soft'], soft)

    def test_tunnel_requires_sufficient_hard_limit_without_changing_it(self):
        with tempfile.TemporaryDirectory() as root:
            proc = Path(root) / '10'; proc.mkdir(); (proc / 'comm').write_text('sshd')
            with patch.object(remote, 'assert_capacity'), patch.object(remote.os, 'getppid', return_value=10), patch.object(remote, 'Path', return_value=Path(root)), patch.object(remote.resource, 'prlimit', create=True, return_value=(1024, 2048)) as limit:
                with self.assertRaisesRegex(RuntimeError, 'insufficient file capacity'): remote.tunnel()
                self.assertEqual(limit.call_count, 1)

    def test_tunnel_refuses_non_ssh_ancestors_and_inactive_runs(self):
        with patch.object(remote, 'assert_capacity'), patch.object(remote.os, 'getppid', return_value=1), patch.object(remote.resource, 'prlimit', create=True) as limit:
            with self.assertRaisesRegex(RuntimeError, 'dedicated SSH'): remote.tunnel()
            limit.assert_not_called()
        with patch.object(remote, 'assert_capacity', side_effect=AssertionError('inactive')), patch.object(remote.resource, 'prlimit', create=True) as limit:
            with self.assertRaisesRegex(AssertionError, 'inactive'): remote.tunnel()
            limit.assert_not_called()

    def test_timeout_registrations_are_audited_and_unsent_intents_are_excluded(self):
        first, second, unsent, item = [str(uuid.uuid4()) for _ in range(4)]
        def record(command, sequence, text, accepted):
            return {'id': command, 'sequence': sequence, 'client_accepted': accepted,
                    'items': [{'itemId': item, 'answer': {'text': text}, 'confirmed': True, 'marked': True}]}
        ledger = [record(first, 1, 'earlier', True), record(second, 2, 'latest committed', False), record(unsent, 3, 'never accepted', False)]
        with patch('remote.sys.stdin', io.StringIO(json.dumps(ledger))), patch.object(remote, 'sql', side_effect=[json.dumps({first: 'COMMITTED', second: 'COMMITTED'}), '0', '0']) as sql:
            value = remote.audit()
        self.assertEqual((value['accepted'], value['registered'], value['client_accepted'], value['committed']), (2, 2, 1, 2))
        self.assertEqual(value['missing'], 0)
        query = sql.call_args_list[1].args[0]
        self.assertIn('latest committed', query); self.assertNotIn('never accepted', query)
        self.assertIn('p.marked IS DISTINCT FROM e.marked', query)

    def test_client_accepted_missing_from_database_is_not_ignored(self):
        ledger = [{'id': str(uuid.uuid4()), 'sequence': 1, 'items': []}]
        with patch('remote.sys.stdin', io.StringIO(json.dumps(ledger))), patch.object(remote, 'sql', side_effect=['{}', '0']):
            value = remote.audit()
        self.assertEqual((value['accepted'], value['registered'], value['committed'], value['missing']), (1, 0, 0, 1))

    def test_inactive_run_cannot_stop_services_or_restore_data(self):
        with patch.object(remote, 'assert_capacity', side_effect=AssertionError('inactive')), patch.object(remote, 'compose') as compose, patch.object(remote, 'command') as command:
            with self.assertRaises(AssertionError): remote.reset(False)
            compose.assert_not_called();command.assert_not_called()

    def test_invalid_start_load_cannot_touch_the_remote_environment(self):
        remote = Mock()
        with self.assertRaises(ValueError): suite(remote, start_users=0)
        remote.action.assert_not_called()

    def test_slow_collection_is_not_a_lost_management_connection(self):
        remote = Mock()
        self.assertEqual(collection_failure(remote, 1, 0), (0, None))
        self.assertEqual(collection_failure(remote, 2, 0), (0, 'monitoring_unavailable'))
        remote.shell.side_effect = TimeoutError()
        self.assertEqual(collection_failure(remote, 1, 0), (1, None))
        self.assertEqual(collection_failure(remote, 2, 1), (2, 'management_connection_timeout'))

    def test_drained_queue_does_not_imply_ready_application(self):
        remote = Mock()
        status = {'commands': {}, 'activity_pending': 0}
        def health(ready): return {'containers': {'qanda-application-' + role + '-1': {'running': True, 'probe_ok': ready} for role in ('api', 'worker', 'monitor')}, 'application': {'qanda-application-api-1': {'metrics': 'tomcat_threads_busy_threads{name="http-nio-8083"} 0'}}}
        remote.action.side_effect = [status.copy(), health(False), status.copy(), health(True), status.copy(), health(True)]
        with patch('run.time.sleep') as sleep:
            self.assertTrue(wait_drain(remote)['recovered']); self.assertEqual(sleep.call_count, 2)

    def test_recovery_waits_for_http_completion_and_stable_persistence_counts(self):
        remote = Mock()
        def health(busy):
            return {'containers': {'qanda-application-' + role + '-1': {'running': True, 'probe_ok': True} for role in ('api', 'worker', 'monitor')}, 'application': {'qanda-application-api-1': {'metrics': 'tomcat_threads_busy_threads{name="http-nio-8083"} ' + str(busy)}}}
        def status(count): return {'commands': {'COMMITTED': count}, 'results': 0, 'activity_pending': 0}
        remote.action.side_effect = [status(1), health(1), status(1), health(0), status(2), health(0), status(2), health(0)]
        with patch('run.time.sleep'):
            result = wait_drain(remote)
        self.assertTrue(result['recovered']); self.assertEqual(result['commands']['COMMITTED'], 2)
        self.assertEqual(http_busy(metrics('tomcat_threads_busy_threads{name="http-nio-8083"} 0\ntomcat_threads_busy_threads{name="http-nio-9091"} 1')), 0)

    def test_missing_http_metrics_cannot_confirm_recovery(self):
        remote = Mock()
        remote.action.side_effect = [{'commands': {}, 'activity_pending': 0}, {'containers': {'qanda-application-' + role + '-1': {'running': True, 'probe_ok': True} for role in ('api', 'worker', 'monitor')}}]
        self.assertFalse(wait_drain(remote, timeout=0)['recovered'])

    def test_late_registrations_trigger_a_fresh_drain_and_audit(self):
        remote = Mock(state=Path('20261109-r5'), config={'remote_dir': '/var/lib/qanda-capacity/20261109-r5'})
        def status(count): return {'commands': {'COMMITTED': count}, 'results': 4, 'activity_pending': 0, 'recovered': True}
        remote.action.return_value = status(174); remote.shell.return_value = '{"registered":170}'
        with tempfile.TemporaryDirectory() as root, patch('run.wait_drain', side_effect=[status(172), status(174)]) as drain:
            result, audit = audit_after_drain(remote, [], Path(root))
        self.assertEqual(drain.call_count, 2); self.assertEqual(remote.shell.call_count, 2)
        self.assertTrue(result['recovered']); self.assertEqual(result['commands']['COMMITTED'] - 4, audit['registered'])

    def test_resume_rejects_different_backend_before_any_remote_action(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root); folder = state / 'trials/example'; folder.mkdir(parents=True)
            (folder / 'result.json').write_text(json.dumps({'backend_revision': 'older', 'scenario': 'read', 'target': 10, 'limits': 'on', 'duration': 180}))
            remote = SimpleNamespace(state=state, config={'expected_revision': 'current'}, action=Mock())
            with self.assertRaisesRegex(AssertionError, 'configuration mismatch'):
                trial(remote, 'read', 10, 'on', 180, 'example')
            remote.action.assert_not_called()

    def test_native_k6_timestamp_precision(self):
        self.assertEqual(epoch('2026-11-08T16:10:56.56157+08:00'), epoch('2026-11-08T08:10:56.561570000Z'))

    def test_synthetic_blank_question_contains_its_numbered_slot(self):
        value = question('bank', 'chapter', 3)
        self.assertEqual(value['type'], 'FILL_BLANK')
        self.assertEqual(value['stem'].count('{{1}}'), len(value['blanks']))

    def test_subsecond_projection_batches_are_not_sustained_backlog(self):
        rows = [{'observed_at': i * 5, 'postgres': {'activity_pending': 0 if i < 6 else 14, 'activity_oldest_seconds': .94}} for i in range(13)]
        self.assertEqual(backlog_violations(rows), [])

    def test_growing_projection_lag_is_detected(self):
        rows = [{'observed_at': i * 5, 'postgres': {'activity_pending': i * 5, 'activity_oldest_seconds': i}} for i in range(13)]
        self.assertIn('activity_projection_growth', backlog_violations(rows))

    def test_resource_export_keeps_numeric_metrics_and_omits_labels(self):
        text = 'hikaricp_connections_pending{pool="private-name"} 2\ninvalid NaN\n'
        self.assertEqual(list(metrics(text)), [('hikaricp_connections_pending', {'pool': 'private-name'}, 2.0)])
        row = {'observed_at': 1, 'host': {'available': 1024 ** 2, 'swap_used': 0, 'disk_free': 10 * 1024 ** 3}, 'containers': {}, 'application': {'qanda-application-api-1': {'metrics': text}}, 'window': {}}
        value = series([row])[0]
        self.assertEqual(value['api_pool_pending'], 2)
        self.assertNotIn('private-name', json.dumps(value))

    def test_server_histogram_excludes_health_and_subtracts_baseline(self):
        def sample(health, quick, count):
            text = '\n'.join([
                'http_server_requests_seconds_bucket{uri="/api/v1/health",le="0.001"} ' + str(health),
                'http_server_requests_seconds_bucket{uri="/api/v1/practice/sessions",le="0.1"} ' + str(quick),
                'http_server_requests_seconds_bucket{uri="/api/v1/practice/sessions",le="0.5"} ' + str(count),
                'http_server_requests_seconds_bucket{uri="/api/v1/practice/sessions",le="+Inf"} ' + str(count)])
            return {'application': {'qanda-application-api-1': {'metrics': text}}}
        self.assertEqual(server_p95([sample(0, 10000, 10000), sample(100000, 10001, 10010)]), 500)
    def sample(self, **host):
        return {'host': {'available': 2 * 1024 ** 3, 'disk_free': 20 * 1024 ** 3, **host}, 'containers': {'api': {'oom': False, 'restarts': 0, 'running': True, 'memory_events': {'oom_kill': '9'}}}}

    def test_429_and_unsent_work_cannot_count_as_successful_capacity(self):
        rows = [(0, 'http_reqs', 1, {'status': '200'}), (1, 'http_reqs', 1, {'status': '429'}), (2, 'http_reqs', 1, {'status': '0'}), (3, 'dropped_iterations', 50, {})]
        value = summarize(rows)
        self.assertEqual(value['http'], 3); self.assertEqual(value['error_rate'], 2 / 3)
        self.assertEqual((value['unavailable'], value['timeouts']), (0, 0))
        self.assertEqual(value['dropped_iterations'], 50); self.assertIn('request_errors', violations(value))

    def test_accepted_and_committed_are_separate(self):
        value = summarize([(0, 'accepted_commands', 10, {}), (1, 'committed_commands', 7, {}), (2, 'command_commit_latency', 16000, {})])
        self.assertEqual(value['accepted_commands'], 10); self.assertEqual(value['committed_commands'], 7)
        self.assertIn('commit_p99_ms', violations(value))

    def test_interrupted_counters_cannot_make_completed_throughput_negative_and_vus_survive_missing_summary(self):
        rows = [(0, 'http_reqs', 1, {'status': '200'}), (2, 'http_reqs', 1, {'status': '503'}),
                (1, 'business_operations', 1, {}), (1, 'business_failures', 2, {}),
                (1, 'business_success', 1, {}), (1, 'vus', 50, {}), (2, 'vus', 40, {})]
        value = summarize(rows)
        self.assertEqual(value['completed_operations_per_second'], .5)
        self.assertEqual(value['achieved_vus_peak'], 50)

    def test_overload_and_timeouts_remain_failures_and_have_separate_counts(self):
        value = summarize([(0, 'http_reqs', 1, {'status': '200'}), (1, 'http_reqs', 2, {'status': '503'}), (2, 'http_reqs', 3, {'status': '0', 'error_code': '1050'})])
        self.assertEqual((value['unavailable'], value['timeouts'], value['server_errors'], value['transport_errors']), (2, 3, 2, 3))
        self.assertAlmostEqual(value['error_rate'], 5 / 6)
        self.assertAlmostEqual(value['successful_rps'], .5)

    def test_busy_polling_cannot_hide_slow_session_creation(self):
        rows = [(i, 'http_req_duration', 20, {'name': 'GET /progress-commands/:id'}) for i in range(100)]
        rows.append((101, 'http_req_duration', 5000, {'name': 'POST /practice/sessions'}))
        value = summarize(rows)
        self.assertEqual(value['p95_ms'], 20)
        self.assertIn('endpoint_p95_ms', violations(value))

    def test_memory_guard_requires_sustained_pressure(self):
        g = Guard(self.sample()); low = self.sample(available=100 * 1024 ** 2)
        self.assertIsNone(g.check(low, 1)); self.assertIsNone(g.check(low, 15))
        self.assertEqual(g.check(low, 16), 'host_memory_reserve')
        self.assertIsNone(g.check(self.sample(), 17)); self.assertIsNone(g.check(low, 18))

    def test_single_core_transport_saturation_is_a_generator_boundary(self):
        guard = Guard(self.sample()); busy = self.sample(); busy['generator'] = {'tunnel_cpu_percent': 95}
        self.assertIsNone(guard.check(busy, 1)); self.assertIsNone(guard.check(busy, 15))
        self.assertEqual(guard.check(busy, 16), 'generator_tunnel_cpu_ceiling')
        self.assertIsNone(guard.check(self.sample(), 17)); self.assertIsNone(guard.check(busy, 18))

    def test_container_oom_counter_is_numeric(self):
        g = Guard(self.sample()); value = self.sample(); value['containers']['api']['memory_events']['oom_kill'] = '10'
        self.assertEqual(g.check(value, 1), 'container_oom:api')

    def test_adaptive_target_has_no_fixed_4000_ceiling(self):
        self.assertEqual(next_target(4000), 8000)
        self.assertEqual(next_target(1), 2)
        self.assertGreater(next_target(10 ** 9), 10 ** 9)

    def test_partial_metric_lines_are_retried(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'metrics.json'
            row = json.dumps({'type': 'Point', 'metric': 'http_reqs', 'data': {'time': '2026-11-08T00:00:00Z', 'value': 1, 'tags': {'status': '200'}}})
            path.write_text(row[:20]); m = Metrics(); m.update(path); self.assertEqual(m.offset, 0)
            path.write_text(row + '\n')
            with patch('run.time.time', return_value=1794096000): m.update(path)
            self.assertEqual(m.offset, len(row) + 1)

    def test_existing_run_refuses_prepare_before_stopping_services(self):
        with tempfile.TemporaryDirectory() as root, patch.object(remote, 'ROOT', Path(root), create=True), patch.object(remote, 'command') as command:
            (Path(root) / 'manifest.json').write_text('{}')
            with self.assertRaisesRegex(RuntimeError, 'already exists'): remote.prepare()
            command.assert_not_called()

    def test_original_infrastructure_cannot_be_used_as_capacity_storage(self):
        with tempfile.TemporaryDirectory() as root, patch.object(remote, 'ROOT', Path(root), create=True), patch.object(remote, 'manifest', return_value={}), patch.object(remote, 'inspect', return_value=[{'State': {'Running': True}}]):
            with self.assertRaisesRegex(AssertionError, 'Original infrastructure'): remote.assert_capacity()

    def test_remote_lease_restores_only_after_heartbeat_expires(self):
        with tempfile.TemporaryDirectory() as root, patch.object(remote, 'ROOT', Path(root), create=True), patch.object(remote, 'restore', return_value={'restored': True}) as restore:
            path = Path(root); (path / 'manifest.json').write_text('{}'); (path / 'heartbeat').touch()
            self.assertEqual(remote.lease(), {'alive': True}); restore.assert_not_called()
            os.utime(path / 'heartbeat', (time.time() - 301, time.time() - 301))
            self.assertEqual(remote.lease(), {'restored': True}); restore.assert_called_once()


if __name__ == '__main__': unittest.main()
