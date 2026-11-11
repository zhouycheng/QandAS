import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import integration


class IntegrationEnvironmentTest(unittest.TestCase):
    def test_existing_environment_adds_cache_fields_once_and_preserves_private_values(self):
        with tempfile.TemporaryDirectory() as directory:
            private=Path(directory);path=private/'backend.env'
            original='# existing\nBACKEND_DB_PASSWORD=preserved\nBACKEND_IDENTITY_RATE_KEY=kept\nBACKEND_REDIS_PASSWORD=\n'
            path.write_text(original);path.chmod(0o600)
            with patch.object(integration,'PRIVATE',private), patch.object(integration.Path,'home',return_value=private):
                integration.compose_environment()
                first=path.read_bytes();integration.compose_environment()
                self.assertEqual(first,path.read_bytes())
                values=dict(line.split('=',1) for line in path.read_text().splitlines() if '=' in line)
                self.assertEqual(values['BACKEND_DB_PASSWORD'],'preserved')
                self.assertEqual(values['BACKEND_IDENTITY_RATE_KEY'],'kept')
                self.assertEqual(values['BACKEND_REDIS_PORT'],'56380')
                self.assertGreaterEqual(len(values['BACKEND_REDIS_PASSWORD']),16)
                self.assertEqual(0,path.stat().st_mode & 0o077)

    def test_existing_cache_credentials_are_kept_and_insecure_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            private=Path(directory);path=private/'backend.env'
            path.write_text('BACKEND_REDIS_HOST=custom\nBACKEND_REDIS_PORT=12345\nBACKEND_CONTENT_CACHE_ENABLED=false\nBACKEND_REDIS_PASSWORD=existing-cache-password\n');path.chmod(0o600)
            with patch.object(integration,'PRIVATE',private), patch.object(integration.Path,'home',return_value=private):
                original=path.read_bytes();integration.compose_environment();self.assertEqual(original,path.read_bytes())
                path.chmod(0o644)
                with self.assertRaises(RuntimeError): integration.compose_environment()
                path.chmod(0o600);target=private/'saved.env';path.rename(target);path.symlink_to(target)
                with self.assertRaises(RuntimeError): integration.compose_environment()

    def test_compose_uses_isolated_config_and_private_ses_without_overriding_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            settings = home / ".config/qanda/tencent-ses.env"
            settings.parent.mkdir(parents=True)
            settings.write_text("# private\nTENCENT_SECRET_ID=local-id\nTENCENT_SECRET_KEY=local-key\n")
            settings.chmod(0o600)
            with patch.object(integration.Path, "home", return_value=home), patch.dict(integration.os.environ, {"TENCENT_SECRET_ID": "preferred"}, clear=True), patch.object(integration, "PRIVATE", home / "integration"):
                env = integration.compose_environment()
                self.assertEqual(str(home / "integration/backend.env"), env["BACKEND_ENV_FILE"])
                self.assertEqual("preferred", env["TENCENT_SECRET_ID"])
                self.assertEqual("local-key", env["TENCENT_SECRET_KEY"])
                settings.chmod(0o644)
                with self.assertRaises(RuntimeError):
                    integration.compose_environment()

    def test_isolated_credentials_are_private_and_initialization_preserves_them(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory)
            with patch.object(integration, "PRIVATE", private), patch.object(integration, "CONFIG", private / "environment.json"):
                with contextlib.redirect_stdout(io.StringIO()):
                    integration.initialize()
                original = integration.CONFIG.read_bytes()
                config = integration.configuration()
                self.assertEqual("http://localhost:5174", config["adminUrl"])
                self.assertEqual("integration_admin", config["admin"]["username"])
                self.assertEqual(0, integration.CONFIG.stat().st_mode & 0o077)
                self.assertEqual(0, (private / "backend.env").stat().st_mode & 0o077)
                self.assertNotEqual(config["admin"]["password"], config["secondAdmin"]["password"])
                for name in ["student", "secondStudent"]:
                    self.assertNotIn("password", config[name])
                self.assertIn("BACKEND_CONTENT_SAFETY_PROVIDER=local", (private / "backend.env").read_text())
                self.assertIn("BACKEND_MAIL_TRANSPORT=local-capture", (private / "backend.env").read_text())
                values=dict(line.split('=',1) for line in (private/'backend.env').read_text().splitlines() if '=' in line)
                self.assertGreaterEqual(len(values['BACKEND_REDIS_PASSWORD']),16)
                self.assertEqual('56380',values['BACKEND_REDIS_PORT'])
                self.assertTrue(values['BACKEND_TEST_ACCOUNT_ENCRYPTION_KEYS'].startswith('1:'))
                with self.assertRaises(RuntimeError):
                    integration.initialize()
                self.assertEqual(original, integration.CONFIG.read_bytes())
                config["api"] = "https://example.com"
                integration.save(integration.CONFIG, config)
                with self.assertRaises(RuntimeError):
                    integration.configuration()


if __name__ == "__main__":
    unittest.main()
