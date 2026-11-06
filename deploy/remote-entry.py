#!/usr/bin/python3 -I
"""OpenSSH forced command: delegate only the caller's project operations."""
import os
import pwd
import shlex
import sys


def command(user, original):
    args = shlex.split(original)
    if user == 'qanda-deploy' and len(args) == 1 and args[0] in ('deploy', 'rollback', 'status'):
        return ['/usr/bin/sudo', '-n', '/usr/local/sbin/qanda-deployctl', *args]
    if user == 'qanda-debug' and args and args[0] in ('containers', 'logs', 'shell', 'restart'):
        return ['/usr/bin/sudo', '-n', '/usr/local/sbin/qanda-deployctl', *args]
    raise ValueError('Use a permitted deployment or container operation')


if __name__ == '__main__':
    try:
        args = command(pwd.getpwuid(os.getuid()).pw_name, os.environ.get('SSH_ORIGINAL_COMMAND', ''))
        os.execv(args[0], args)
    except (ValueError, KeyError):
        print('Only project operations are available. CI: deploy/rollback/status. Debug: containers, logs SERVICE [--follow], shell SERVICE, restart SERVICE.', file=sys.stderr)
        sys.exit(1)
