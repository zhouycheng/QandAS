#!/usr/bin/env python3
"""Exercise the shipped CLI against disposable PostgreSQL and Redis containers."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid


def main():
    docker = shutil.which('docker')
    name = 'qanda-import-check-' + uuid.uuid4().hex[:12]
    cache = name + '-cache'
    def command(*args, **kwargs):
        return subprocess.run([docker, *args], check=True, capture_output=True, **kwargs).stdout
    def sql(statement):
        return command('exec', name, 'psql', '-U', 'qanda_backend', '-d', 'qanda_backend', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement).decode().strip()
    def redis(*args):
        return command('exec',cache,'redis-cli','--no-auth-warning','-a','isolated-cache-password',*args).decode().strip()
    try:
        command('run', '-d', '--name', name, '-e', 'POSTGRES_DB=qanda_backend', '-e', 'POSTGRES_USER=qanda_backend',
                '-e', 'POSTGRES_PASSWORD=isolated-cli-password', 'postgres:17.6-alpine')
        for _ in range(60):
            try:
                command('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'qanda_backend', '-d', 'qanda_backend')
                break
            except subprocess.CalledProcessError:
                time.sleep(1)
        else:
            raise RuntimeError('Isolated PostgreSQL did not start')
        command('run','-d','--name',cache,'-e','BACKEND_REDIS_PASSWORD=isolated-cache-password','redis:8.10.3-alpine',
                'redis-server','--requirepass','isolated-cache-password','--save','','--appendonly','no')
        for _ in range(30):
            try:
                if redis('PING')=='PONG': break
            except subprocess.CalledProcessError: pass
            time.sleep(1)
        else: raise RuntimeError('Isolated Redis did not start')
        with tempfile.TemporaryDirectory(prefix='qanda-cli-check-') as temporary:
            root = Path(temporary)
            (root / 'state').mkdir()
            (root / 'bin').mkdir()
            sql("CREATE TABLE import_fixture(id integer PRIMARY KEY, value text); INSERT INTO import_fixture VALUES(1,'fixture')")
            fixture = root / 'fixture.dump'
            fixture.write_bytes(command('exec', name, 'pg_dump', '-U', 'qanda_backend', '-d', 'qanda_backend', '-Fc'))
            sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
            source = (Path(__file__).parents[1] / 'db-admin.sh').read_text()
            # Paths and root identity are isolated; Docker can reach only these disposable containers.
            source = source.replace('/var/lib/qanda-deploy', str(root / 'state')).replace('/srv/qanda', str(root / 'config'))
            source = source.replace('/usr/local/sbin/qanda-backup', '/usr/bin/true')
            script = root / 'qanda-db'
            script.write_text(source)
            wrapper = root / 'bin/docker'
            wrapper.write_text('#!/usr/bin/env python3\n' + f'''
import os,subprocess,sys
a=sys.argv[1:]
if a[:4] != ['compose','-p','qanda-infrastructure','--env-file']:
    sys.exit('Unexpected Docker command; refusing to reach any other container')
if a[-4:]==['ps','-a','-q','redis']:
    print({cache!r});sys.exit(0)
if a[-6:]==['up','-d','--wait','--wait-timeout','30','redis']:
    sys.exit(subprocess.run([{docker!r},'exec',{cache!r},'redis-cli','--no-auth-warning','-a','isolated-cache-password','ping'],stdout=subprocess.DEVNULL).returncode)
if 'exec' not in a: sys.exit('Unexpected infrastructure action')
service=a[a.index('exec')+2]
if service not in ('postgres','redis'): sys.exit('Unexpected service')
if service=='redis' and os.environ.get('QANDA_TEST_CACHE_FAILURE')=='1': sys.exit(23)
target={name!r} if service=='postgres' else {cache!r}
command=a[a.index('exec')+3:]
sys.exit(subprocess.run([{docker!r},'exec','-i',target,*command],stdin=sys.stdin.buffer).returncode)
''')
            wrapper.chmod(0o755)
            if not shutil.which('flock'):
                lock = root / 'bin/flock'
                lock.write_text('#!/usr/bin/env python3\nimport fcntl,sys\nfcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)\n')
                lock.chmod(0o755)
            fake_id = root / 'bin/id'
            fake_id.write_text('#!/bin/sh\nprintf \"0\\n\"\n')
            fake_id.chmod(0o755)
            env = {**os.environ, 'PATH': str(root / 'bin') + ':' + os.environ['PATH']}
            def cli(*args, success=True, cache_failure=False):
                result = subprocess.run(['bash', str(script), *map(str, args)], env={**env,'QANDA_TEST_CACHE_FAILURE':str(int(cache_failure))}, capture_output=True)
                if (result.returncode == 0) != success:
                    raise AssertionError('CLI acceptance failed: ' + result.stderr.decode()[-600:])
                return result
            redis('SET','qanda:content:v1:bank-counts:fixture:12','stale-count')
            cli('restore', fixture)
            assert sql('SELECT value FROM import_fixture WHERE id=1') == 'fixture'
            assert redis('DBSIZE')=='0','Successful restore must invalidate cached content versions'
            redis('SET','current-cache','retained')
            cli('restore', fixture, success=False)
            assert sql('SELECT count(*) FROM import_fixture') == '1'
            assert redis('GET','current-cache')=='retained','Rejected restore must preserve the live cache'
            export = root / 'export.dump'
            cli('export', export)
            assert export.stat().st_mode & 0o077 == 0
            assert Path(str(export) + '.sha256').exists()
            cli('export', export, success=False)
            failure = root / 'failure.sql'
            failure.write_text('CREATE TABLE rollback_probe(id integer); INSERT INTO rollback_probe VALUES(1); SELECT 1/0;\n')
            cli('sql', failure, success=False)
            cli('psql', success=False)
            assert sql("SELECT to_regclass('public.rollback_probe') IS NULL") == 't'
            sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
            result=cli('restore',fixture,success=False,cache_failure=True)
            assert sql('SELECT value FROM import_fixture WHERE id=1')=='fixture'
            assert b'Import completed' not in result.stdout,'Cache failure must stop before application reopening'
        print('CLI checks passed: empty DB restore, cache invalidation and failure, existing DB protection, private export, write entry rejection')
    finally:
        subprocess.run([docker, 'rm', '-f', '-v', name], capture_output=True)
        subprocess.run([docker, 'rm', '-f', '-v', cache], capture_output=True)


if __name__ == '__main__':
    main()
