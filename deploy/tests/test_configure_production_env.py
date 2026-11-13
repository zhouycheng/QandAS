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




    def test_complete_configuration_is_read_only_and_missing_fields_are_rejected(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); target = root / 'production.env'
            complete = configure.render(configure.TEMPLATE.read_text(), {
                'BACKEND_REDIS_PASSWORD': 'test-secret', 'BACKEND_WECHAT_CALLBACK_TOKEN': 'test-callback',
                'BACKEND_WECHAT_CALLBACK_AES_KEY': configure.token().rstrip('='),
            })
            target.write_text(complete); target.chmod(0o600)
            owned_root = Mock(wraps=root); owned_root.stat.return_value = SimpleNamespace(st_uid=0, st_mode=0o755)
            owned_target = Mock(wraps=target)
            owned_target.lstat.return_value = SimpleNamespace(st_uid=0, st_mode=0o100600, st_size=len(complete))
            with patch.object(configure, 'ROOT', owned_root), patch.object(configure, 'TARGET', owned_target), patch.object(configure.os, 'geteuid', return_value=0):
                configure.validate_config()
                self.assertEqual(target.read_text(), complete)
                for key, value in (('BACKEND_WECHAT_CALLBACK_TOKEN', 'ab'), ('BACKEND_WECHAT_CALLBACK_AES_KEY', 'invalid'),
                                   ('BACKEND_CONTENT_SAFETY_PUBLIC_BASE_URL', 'http://qanda.example.com')):
                    invalid = configure.render(complete, {key: value})
                    target.write_text(invalid)
                    with self.subTest(key=key), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                        configure.validate_config()
                    self.assertEqual(target.read_text(), invalid)
                target.write_text("BACKEND_REDIS_PASSWORD='test-secret'\n")
                with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): configure.validate_config()
                self.assertEqual(target.read_text(), "BACKEND_REDIS_PASSWORD='test-secret'\n")

    def test_callback_fields_match_current_runtime_requirements(self):
        template = configure.TEMPLATE.read_text()
        for key in ('BACKEND_CONTENT_SAFETY_PROVIDER', 'BACKEND_CONTENT_SAFETY_PUBLIC_BASE_URL',
                    'BACKEND_WECHAT_CALLBACK_TOKEN', 'BACKEND_WECHAT_CALLBACK_AES_KEY'):
            self.assertIn(key, configure.template_keys(template))
        self.assertTrue(configure.https_origin('https://qanda.example.com'))
        for value in ('http://qanda.example.com', 'https://user@qanda.example.com', 'https://qanda.example.com/api',
                      'https://qanda.example.com?q=1', 'https://qanda.example.com:invalid'):
            with self.subTest(value=value):
                self.assertFalse(configure.https_origin(value))


if __name__ == '__main__':
    unittest.main()
