#!/usr/bin/env python3
"""Validate a backup against a disposable PostgreSQL container, never a production DB."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import time
import uuid


def check(backup):
    path = Path(backup).resolve()
    expected = Path(str(path) + '.sha256').read_text().split()[0]
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError('Backup checksum mismatch')
    clear = subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000',
                            '-pass', 'file:/etc/qanda/backup.key', '-in', str(path)], check=True, capture_output=True).stdout
    name = 'qanda-restore-' + uuid.uuid4().hex[:12]
    def docker(*args, **kwargs):
        return subprocess.run(['docker', *args], check=True, capture_output=True, **kwargs).stdout
    try:
        docker('run', '-d', '--name', name, '-e', 'POSTGRES_DB=qanda_backend', '-e', 'POSTGRES_USER=qanda_backend',
               '-e', 'POSTGRES_PASSWORD=isolated-restore-password', 'postgres:17.6-alpine')
        for _ in range(60):
            try:
                docker('exec', name, 'pg_isready', '-U', 'qanda_backend')
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        else:
            raise RuntimeError('Restore database did not start')
        docker('exec', name, 'psql', '-U', 'qanda_backend', '-d', 'qanda_backend', '-v', 'ON_ERROR_STOP=1', '-c',
               'CREATE ROLE qanda_monitor; CREATE ROLE qanda_activity_writer;')
        with tarfile.open(fileobj=io.BytesIO(clear)) as archive:
            database = archive.extractfile('./database.dump').read()
            docker('exec', '-i', name, 'pg_restore', '-U', 'qanda_backend', '-d', 'qanda_backend', '--exit-on-error', input=database)
            result = docker('exec', name, 'psql', '-U', 'qanda_backend', '-d', 'qanda_backend', '-At', '-c',
                            "SELECT coalesce(json_agg(a),'[]') FROM (SELECT storage_key,sha256 FROM file_asset) a")
            with tarfile.open(fileobj=archive.extractfile('./assets.tar')) as assets:
                for row in json.loads(result):
                    data = assets.extractfile('./' + row['storage_key']).read()
                    if hashlib.sha256(data).hexdigest() != row['sha256']:
                        raise ValueError('Restored asset integrity failure')
        print('Isolated database restore and attachment integrity passed; queue recovery requires its persistent data')
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', name], capture_output=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Usage: restore-check.py BACKUP.tar.enc')
    check(sys.argv[1])
