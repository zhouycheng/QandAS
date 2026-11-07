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


if __name__ == '__main__':
    unittest.main()
