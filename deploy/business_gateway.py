"""Validate the public business endpoint independently of the operations network."""
import ipaddress
from pathlib import Path
import re
from urllib.parse import urlsplit, urlunsplit


def endpoint(value):
    if not isinstance(value, str) or re.search(r'[\s\\]', value):
        raise ValueError('Expected a public HTTP or HTTPS endpoint')
    parts = urlsplit(value)
    if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None or parts.password is not None
            or parts.path not in ('', '/') or parts.query or parts.fragment):
        raise ValueError('Expected an HTTP or HTTPS origin without credentials or a path')
    try:
        address = ipaddress.ip_address(parts.hostname)
    except ValueError:
        if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?', parts.hostname) or '.' not in parts.hostname:
            raise ValueError('Expected a public hostname')
    else:
        if address.version != 4 or not address.is_global:
            raise ValueError('Expected a public IPv4 endpoint')
    if parts.port is not None and not 1 <= parts.port <= 65535:
        raise ValueError('Invalid public endpoint port')
    return urlunsplit((parts.scheme, parts.netloc, '', '', ''))


def client_address(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError as error:
        raise ValueError('Expected the frontend public IPv4 address') from error
    if address.version != 4 or not address.is_global:
        raise ValueError('Expected the frontend public IPv4 address')
    return str(address)


def gateway_key(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
        raise ValueError('The business gateway requires an independent 32-byte hexadecimal key')
    return value


def configuration(path, role):
    path = Path(path)
    if path.stat().st_mode & 0o077:
        raise ValueError('node.env must have mode 0600')
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        if not match or match[1] in values:
            raise ValueError('Invalid or duplicate node environment field')
        values[match[1]] = match[2]
    gateway_key(values.get('PUBLIC_GATEWAY_KEY'))
    if role == 'backend':
        client_address(values.get('PUBLIC_GATEWAY_ALLOWED_CLIENT', ''))
    elif role == 'frontend':
        for name in ('PRODUCTION_API_UPSTREAM', 'PRODUCTION_MONITOR_UPSTREAM'):
            if endpoint(values.get(name)) != values[name]:
                raise ValueError('Use the canonical public origin without a trailing slash')
    else:
        raise ValueError('Expected a split deployment role')
    return values
