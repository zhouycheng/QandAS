import base64
from contextlib import redirect_stderr
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / 'configure-production-env.py'
SPEC = importlib.util.spec_from_file_location('configure_production_env', SCRIPT)
configure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(configure)


class ProductionEnvironmentTests(unittest.TestCase):
    def test_generated_key_is_32_bytes(self):
        self.assertEqual(32, len(base64.b64decode(configure.token(), validate=True)))

    def test_render_uses_compose_literal_value_syntax(self):
        result = configure.render('A=\nB=kept\n', {'A': "it's $value"})
        self.assertEqual("A='it\\'s $value'\nB=kept\n", result)

    def test_empty_file_is_replaced_with_private_atomic_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / 'production.env'
            target.touch()
            current = target.stat()
            identity = (current.st_dev, current.st_ino, current.st_size)
            with patch.object(configure, 'ROOT', root), patch.object(configure, 'TARGET', target), \
                    patch.object(configure.os, 'fchown'):
                configure.install_config("A='value'\n", replace_empty=identity)
            self.assertEqual("A='value'\n", target.read_text())
            self.assertEqual(0o600, target.stat().st_mode & 0o777)

    def test_existing_config_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / 'production.env'
            target.write_text('existing\n')
            with patch.object(configure, 'ROOT', root), patch.object(configure, 'TARGET', target), \
                    patch.object(configure.os, 'fchown'), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    configure.install_config("A='new'\n", replace_empty=None)
            self.assertEqual('existing\n', target.read_text())

    def test_cache_upgrade_generates_only_missing_credentials_and_is_repeatable(self):
        original="BACKEND_DB_PASSWORD='kept'\nBACKEND_REQUEST_LIMITS_ENABLED=true\n"
        value=configure.extend_cache_config(original)
        self.assertTrue(value.startswith(original))
        self.assertIn("BACKEND_REDIS_HOST='qanda-redis'",value)
        self.assertIn("BACKEND_CONTENT_CACHE_ENABLED='true'",value)
        password=next(line.partition('=')[2].strip("'") for line in value.splitlines() if line.startswith('BACKEND_REDIS_PASSWORD='))
        self.assertEqual(32,len(bytes.fromhex(password)))
        self.assertEqual(value,configure.extend_cache_config(value))

    def test_cache_upgrade_preserves_operator_values_and_fills_an_empty_password(self):
        original="BACKEND_REDIS_HOST='custom-cache'\nBACKEND_CONTENT_CACHE_ENABLED=false\nBACKEND_REDIS_PASSWORD=''\n"
        value=configure.extend_cache_config(original)
        self.assertIn("BACKEND_REDIS_HOST='custom-cache'",value)
        self.assertIn('BACKEND_CONTENT_CACHE_ENABLED=false',value)
        self.assertNotIn("BACKEND_REDIS_PASSWORD=''",value)

    def test_cache_upgrade_refuses_a_concurrently_changed_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);target=root/'production.env';target.write_text("A='new'\n")
            current=target.stat();identity=(current.st_dev,current.st_ino,current.st_size)
            with patch.object(configure,'ROOT',root),patch.object(configure,'TARGET',target),patch.object(configure.os,'fchown'),redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):configure.install_config("A='replacement'\n",identity,expected_content=b"A='old'\n")
            self.assertEqual("A='new'\n",target.read_text())


if __name__ == '__main__':
    unittest.main()
