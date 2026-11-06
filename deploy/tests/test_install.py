import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class InstallTests(unittest.TestCase):
    def test_control_bootstrap_preserves_application_and_backup_services(self):
        script = Path(__file__).parents[1] / 'install.sh'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shim = root / 'shim'
            shim.write_text('''#!/bin/sh
name=${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$INSTALL_LOG"
case "$name" in
  id) case "$1" in -u) echo 0 ;; -nG) echo "$2" ;; esac ;;
  python3) if test "$1" = -c; then echo "$INSTALL_ROLE"; else cat >/dev/null; fi ;;
  docker) if test "$1 $2" = 'network inspect'; then exit 1; fi ;;
esac
''')
            shim.chmod(0o755)
            for name in ('id', 'install', 'python3', 'docker', 'systemctl', 'useradd',
                         'usermod', 'passwd', 'chmod', 'ssh-keygen', 'visudo', 'openssl'):
                (root / name).symlink_to(shim)
            for role in ('frontend', 'backend'):
                log = root / (role + '.log')
                result = subprocess.run(['bash', str(script), '--control-only'], capture_output=True, text=True,
                                        env={**os.environ, 'PATH': str(root) + ':' + os.environ['PATH'],
                                             'INSTALL_LOG': str(log), 'INSTALL_ROLE': role})
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = log.read_text()
                self.assertIn('systemctl enable qanda-ops.service qanda-tailnet.service', calls)
                self.assertNotIn('qanda-backup.timer', calls)
                self.assertNotIn('docker compose', calls)
                self.assertNotIn('docker volume', calls)
                self.assertNotIn('systemctl start', calls)
                self.assertEqual('com.docker.compose.network=data' in calls, role == 'backend')
