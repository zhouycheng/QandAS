#!/usr/bin/env python3
"""Restrict the project's Docker bridges without changing other projects' rules."""
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

ROOT = Path('/srv/qanda')
CHAINS = ('QANDA-HOST', 'QANDA-EGRESS')
PRIVATE = {
    4: ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
        '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4'),
    6: ('::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'),
}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout


def topology(role):
    if role not in ('frontend', 'backend'):
        raise ValueError('A split node role is required')
    names = ['qanda-application'] + (['qanda-data'] if role == 'backend' else [])
    networks = json.loads(run('docker', 'network', 'inspect', *names))
    bridges, subnets = [], []
    for network in networks:
        if network['Driver'] != 'bridge' or network['Name'] not in names:
            raise ValueError('Expected dedicated project bridge networks')
        bridge = network.get('Options', {}).get('com.docker.network.bridge.name') or 'br-' + network['Id'][:12]
        if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,15}', bridge):
            raise ValueError('Invalid bridge interface')
        bridges.append(bridge)
        subnets.extend(str(ipaddress.ip_network(c['Subnet'])) for c in network['IPAM']['Config'] if c.get('Subnet'))
    return bridges, subnets


def rules(version, subnets):
    established = ['-m', 'conntrack', '--ctstate', 'RELATED,ESTABLISHED', '-j', 'RETURN']
    host = [established]
    if version == 4 and '172.29.71.0/24' in subnets:
        host.append(['-s', '172.29.71.20/32', '-d', '172.29.71.1/32', '-p', 'tcp',
                     '-m', 'tcp', '--dport', '2203', '-j', 'ACCEPT'])
    host.append(['-j', 'DROP'])
    egress = [established]
    egress += [['-d', subnet, '-j', 'RETURN'] for subnet in subnets if ipaddress.ip_network(subnet).version == version]
    egress += [['-d', subnet, '-j', 'DROP'] for subnet in PRIVATE[version]]
    egress.append(['-j', 'RETURN'])
    return dict(zip(CHAINS, (host, egress)))


def non_accepting_jump(binary, line):
    def jump_target(rule):
        args = shlex.split(rule)
        if '-g' in args or '--goto' in args or '-j' not in args:
            return None
        return args[args.index('-j') + 1]

    name = jump_target(line)
    if name in ('DROP', 'REJECT'):
        return True
    if name in (None, 'ACCEPT', 'RETURN'):
        return False
    try:
        entries = run(binary, '-w', '5', '-S', name).splitlines()
    except subprocess.CalledProcessError:
        return False
    return entries[:1] == ['-N ' + name] and all(
        entry.startswith('-A ' + name + ' ') and jump_target(entry) in ('DROP', 'REJECT', 'RETURN')
        for entry in entries[1:])


def enforce(bridges, subnets, check=False):
    # Docker's iptables backend preserves DOCKER-USER; nftables requires a separate implementation.
    run('iptables', '-w', '5', '-S', 'DOCKER-USER')
    for version, binary in ((4, 'iptables'), (6, 'ip6tables')):
        expected = rules(version, subnets)
        forwarding = 'DOCKER-USER' if version == 4 else 'FORWARD'
        if not check:
            lines = ['*filter']
            for chain, entries in expected.items():
                lines += [f':{chain} - [0:0]', f'-F {chain}']
                lines += [' '.join(['-A', chain, *entry]) for entry in entries]
            lines.append('COMMIT')
            run(binary + '-restore', '--wait', '5', '--noflush', input='\n'.join(lines) + '\n')
        for chain, entries in expected.items():
            actual = run(binary, '-w', '5', '-S', chain).splitlines()
            def normalize(entry):
                entry = list(entry)
                for address in ('-s', '-d'):
                    if address in entry:
                        i = entry.index(address) + 1
                        entry[i] = str(ipaddress.ip_network(entry[i]))
                if '--ctstate' in entry:
                    i = entry.index('--ctstate') + 1
                    entry[i] = ','.join(sorted(entry[i].split(',')))
                return entry
            ordered = [normalize(shlex.split(line)[2:]) for line in actual if line.startswith('-A ')]
            if ordered != [normalize(entry) for entry in entries]:
                raise RuntimeError('Unexpected project firewall rule order or content')
        for bridge in bridges:
            for parent, chain in (('INPUT', 'QANDA-HOST'), (forwarding, 'QANDA-EGRESS')):
                jump = ['-i', bridge, '-j', chain]
                try:
                    run(binary, '-w', '5', '-C', parent, *jump)
                except subprocess.CalledProcessError:
                    if check:
                        raise
                    run(binary, '-w', '5', '-I', parent, '1', *jump)
                entries = run(binary, '-w', '5', '-S', parent).splitlines()
                target = ' '.join(['-A', parent, *jump])
                project_jumps = {f'-A {parent} -i {item} -j {chain}' for item in bridges}
                # Host security agents may prepend chains that only reject or return.
                if any(line.startswith('-A ') and line not in project_jumps and not non_accepting_jump(binary, line)
                       for line in entries[:entries.index(target)]):
                    if check:
                        raise RuntimeError('Project firewall must precede permissive host rules')
                    run(binary, '-w', '5', '-D', parent, *jump)
                    run(binary, '-w', '5', '-I', parent, '1', *jump)


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Host administrator access is required')
    if sys.argv[1:] not in ([], ['--check']):
        raise ValueError('Usage: network-guard.py [--check]')
    role = json.loads((ROOT / 'node.json').read_text())['role']
    bridges, subnets = topology(role)
    enforce(bridges, subnets, check=bool(sys.argv[1:]))
    print('Project bridge isolation verified')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Project bridge isolation failed: {type(error).__name__}', file=sys.stderr)
        sys.exit(1)
