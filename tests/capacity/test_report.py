import json
from pathlib import Path
import tempfile
import unittest

from report import generate


class ReportTests(unittest.TestCase):
    def test_individual_results_preserve_integrity_and_sla_without_private_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); state = root / 'state'; folder = state / 'trials/journey-on-2000'
            folder.mkdir(parents=True); output = root / 'public'
            result = {'scenario': 'journey', 'limits': 'on', 'target': 2000, 'duration': 600,
                      'stable': False, 'integrity_passed': True, 'business_success': 1.0,
                      'backend_revision': 'a' * 40, 'commit_p95_ms': 65208, 'commit_p99_ms': 209713,
                      'host': 'private-host', 'token': 'private-token',
                      'client_delivery': {'intents': 15619, 'delivered': 15619, 'recovered_uploads': 67, 'token': 'private-token'},
                      'audit': {'committed': 15619, 'missing': 0, 'pending': 0, 'token': 'private-token'}}
            (folder / 'result.json').write_text(json.dumps(result))
            (state / 'configuration.json').write_text('{"token":"private-token"}')
            generate(state, output)
            row = json.loads((output / 'trials.json').read_text())[0]
            self.assertFalse(row['stable']); self.assertTrue(row['integrity_passed'])
            self.assertEqual(row['client_delivery']['recovered_uploads'], 67)
            self.assertEqual(row['audit']['committed'], 15619)
            self.assertEqual(len(row['source_result_sha256']), 64)
            for path in output.iterdir():
                self.assertNotIn('private-token', path.read_text())
                self.assertNotIn('private-host', path.read_text())
            self.assertIn('整套测试完成：False', (output / 'report.md').read_text())
            self.assertIn('65208／209713', (output / 'report.md').read_text())

    def test_individual_record_overrides_summary_and_empty_runs_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); state = root / 'state'; state.mkdir()
            with self.assertRaisesRegex(ValueError, 'No completed'): generate(state, root / 'empty')
            row = {'scenario': 'read', 'limits': 'on', 'label': 'read', 'target': 1, 'duration': 10,
                   'stable': False, 'integrity_passed': False}
            (state / 'results.json').write_text(json.dumps([row]))
            folder = state / 'trials/read'; folder.mkdir(parents=True)
            (folder / 'result.json').write_text(json.dumps(dict(row, stable=True, integrity_passed=True)))
            generate(state, root / 'public')
            rows = json.loads((root / 'public/trials.json').read_text())
            self.assertEqual(len(rows), 1); self.assertTrue(rows[0]['stable'])


if __name__ == '__main__':
    unittest.main()
