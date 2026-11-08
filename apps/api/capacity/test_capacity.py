"""Self-checks for success accounting, adaptive load, and recovery boundaries."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from run import Guard, Metrics, backlog_violations, epoch, next_target, summarize, violations
from seed import question
import remote


class CapacityTests(unittest.TestCase):
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
    def sample(self, **host):
        return {'host': {'available': 2 * 1024 ** 3, 'disk_free': 20 * 1024 ** 3, **host}, 'containers': {'api': {'oom': False, 'restarts': 0, 'running': True, 'memory_events': {'oom_kill': '9'}}}}

    def test_429_and_unsent_work_cannot_count_as_successful_capacity(self):
        rows = [(0, 'http_reqs', 1, {'status': '200'}), (1, 'http_reqs', 1, {'status': '429'}), (2, 'http_reqs', 1, {'status': '0'}), (3, 'dropped_iterations', 50, {})]
        value = summarize(rows)
        self.assertEqual(value['http'], 3); self.assertEqual(value['error_rate'], 2 / 3)
        self.assertEqual(value['dropped_iterations'], 50); self.assertIn('request_errors', violations(value))

    def test_accepted_and_committed_are_separate(self):
        value = summarize([(0, 'accepted_commands', 10, {}), (1, 'committed_commands', 7, {}), (2, 'command_commit_latency', 16000, {})])
        self.assertEqual(value['accepted_commands'], 10); self.assertEqual(value['committed_commands'], 7)
        self.assertIn('commit_p99_ms', violations(value))

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

    def test_container_oom_counter_is_numeric(self):
        g = Guard(self.sample()); value = self.sample(); value['containers']['api']['memory_events']['oom_kill'] = '10'
        self.assertEqual(g.check(value, 1), 'container_oom:api')

    def test_adaptive_target_has_no_fixed_4000_ceiling(self):
        self.assertEqual(next_target(4000, False), 8000)
        self.assertEqual(next_target(4000, True), 5000)
        self.assertGreater(next_target(10 ** 9, False), 10 ** 9)

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
