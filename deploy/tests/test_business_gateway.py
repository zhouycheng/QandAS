import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('business_gateway', Path(__file__).parents[1] / 'business_gateway.py')
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class BusinessGatewayTests(unittest.TestCase):
    def test_public_origins_preserve_scheme_host_and_explicit_port(self):
        for origin in ('http://8.8.8.8', 'https://backend.example.com:8443'):
            self.assertEqual(gateway.endpoint(origin + '/'), origin)
        for value in (None, '', 'ftp://backend.example.com', 'http://localhost', 'http://127.0.0.1',
                      'http://100.64.0.1', 'http://[2606:4700::1111]', 'http://@backend.example.com',
                      'http://user:pass@backend.example.com', 'http://backend.example.com/api',
                      'http://backend.example.com?q=1', 'http://backend.example.com#fragment',
                      'http://backend.example.com:0', 'http://backend.example.com:65536',
                      'http://backend.example.com:invalid', 'http://bad_host.example',
                      'http://backend.example.com\n', 'http://backend.example.com\\other'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                gateway.endpoint(value)

    def test_client_requires_public_ipv4_and_key_requires_independent_hex_bytes(self):
        self.assertEqual(gateway.client_address('8.8.8.8'), '8.8.8.8')
        self.assertEqual(gateway.gateway_key('a' * 64), 'a' * 64)
        for value in ('127.0.0.1', '192.168.1.1', '100.64.0.1', '::1', '', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                gateway.client_address(value)
        for value in (None, '', 'a' * 63, 'A' * 64, 'x' * 64, 'a' * 64 + '\n'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                gateway.gateway_key(value)

    def test_private_configuration_validates_both_roles_and_duplicate_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'node.env'
            prefix = 'PUBLIC_GATEWAY_KEY=' + 'a' * 64 + '\n'
            path.write_text(prefix + 'PUBLIC_GATEWAY_ALLOWED_CLIENT=8.8.8.8\n')
            path.chmod(0o600)
            self.assertEqual(gateway.configuration(path, 'backend')['PUBLIC_GATEWAY_ALLOWED_CLIENT'], '8.8.8.8')
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, '0600'):
                gateway.configuration(path, 'backend')
            path.chmod(0o600)
            front = prefix + 'PRODUCTION_API_UPSTREAM=https://backend.example.com\nPRODUCTION_MONITOR_UPSTREAM=https://backend.example.com\n'
            path.write_text(front)
            self.assertIn('PRODUCTION_API_UPSTREAM', gateway.configuration(path, 'frontend'))
            for contents in (front + 'PUBLIC_GATEWAY_KEY=' + 'b' * 64, front.replace('.com\n', '.com/\n'),
                             front.replace('https://backend.example.com', 'http://127.0.0.1'), front + 'invalid field'):
                path.write_text(contents)
                with self.subTest(contents=contents), self.assertRaises(ValueError):
                    gateway.configuration(path, 'frontend')


if __name__ == '__main__':
    unittest.main()
