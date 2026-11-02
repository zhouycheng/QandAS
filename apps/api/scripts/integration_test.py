import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import integration


class IntegrationEnvironmentTest(unittest.TestCase):
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
                self.assertEqual(4, len({config[name]["password"] for name in ["admin", "secondAdmin", "student", "secondStudent"]}))
                for name in ["student", "secondStudent"]:
                    password = config[name]["password"]
                    self.assertEqual(16, len(password))
                    self.assertRegex(password, "[A-Za-z]")
                    self.assertRegex(password, "[0-9]")
                self.assertIn("BACKEND_MAIL_TRANSPORT=local-capture", (private / "backend.env").read_text())
                with self.assertRaises(RuntimeError):
                    integration.initialize()
                self.assertEqual(original, integration.CONFIG.read_bytes())
                config["api"] = "https://example.com"
                integration.save(integration.CONFIG, config)
                with self.assertRaises(RuntimeError):
                    integration.configuration()


if __name__ == "__main__":
    unittest.main()
