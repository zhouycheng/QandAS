#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
qanda_source_dir=$(cd "$(dirname "$0")" && pwd)
case "${1:-}" in ''|--control-only) ;; *) echo 'Usage: install.sh [--control-only]' >&2; exit 1 ;; esac
test "$#" -le 1
qanda_node_role=$(python3 -c 'import json,pathlib;p=pathlib.Path("/srv/qanda/node.json");print(json.loads(p.read_text())["role"] if p.exists() else "combined")')
if test "${1:-}" != --control-only; then
  if test -L /srv/qanda; then
    echo '/srv/qanda must not be a symbolic link.' >&2
    exit 1
  fi
  if test -L /srv/qanda/production.env; then
    echo 'production.env must not be a symbolic link.' >&2
    exit 1
  fi
  if ! test -s /srv/qanda/production.env; then
    if test "$qanda_node_role" = frontend; then
      if ! test -d /srv/qanda; then install -d -o root -g root -m 0755 /srv/qanda; fi
      if ! python3 -c 'import os,sys;s=os.stat("/srv/qanda");sys.exit(0 if s.st_uid==0 and not s.st_mode & 0o022 else 1)'; then
        echo '/srv/qanda must be root-owned and not group/world-writable.' >&2
        exit 1
      fi
      (umask 077; printf '%s\n' '# Frontend node; backend credentials are stored on the backend node.' > /srv/qanda/production.env)
    else
      python3 "$qanda_source_dir/configure-production-env.py"
    fi
  fi
  test -s /srv/qanda/production.env
  test "$(stat -c '%a' /srv/qanda/production.env)" = 600
  test "$(stat -c '%U:%G' /srv/qanda/production.env)" = root:root
fi
install -d -o root -g root -m 0755 /srv/qanda/web-assets /usr/local/lib/qanda
install -d -o root -g root -m 0700 /var/lib/qanda-deploy /etc/qanda
install -m 0644 "$qanda_source_dir"/compose.*.yml "$qanda_source_dir"/prometheus.yml /srv/qanda/
install -m 0644 "$qanda_source_dir"/../apps/api/monitoring/{rabbitmq-plugins,sync-rules.yml} /srv/qanda/
install -m 0755 "$qanda_source_dir/deployctl.py" /usr/local/sbin/qanda-deployctl
install -m 0755 "$qanda_source_dir/network-guard.py" /usr/local/lib/qanda/network-guard.py
install -m 0755 "$qanda_source_dir/remote-entry.py" /usr/local/lib/qanda/remote-entry.py
install -m 0644 "$qanda_source_dir"/tailnet-*.conf /srv/qanda/
install -d -o root -g root -m 0755 /srv/qanda/tailnet-config
install -m 0644 "$qanda_source_dir/tailnet-serve.json" /srv/qanda/tailnet-config/serve.json
install -m 0644 "$qanda_source_dir"/qanda-{tailnet,ops}.service /etc/systemd/system/
install -m 0644 "$qanda_source_dir/qanda-ops.sshd.conf" /etc/ssh/qanda-ops.conf
install -m 0755 "$qanda_source_dir/candidate-check.py" /usr/local/lib/qanda/candidate-check.py
install -m 0755 "$qanda_source_dir/restore-check.py" /usr/local/lib/qanda/restore-check.py
install -m 0755 "$qanda_source_dir/backup.sh" /usr/local/sbin/qanda-backup
install -m 0755 "$qanda_source_dir/db-admin.sh" /usr/local/sbin/qanda-db
for qanda_ops_user in qanda-deploy qanda-debug; do
  if ! id "$qanda_ops_user" >/dev/null 2>&1; then useradd --create-home --user-group --shell /bin/sh "$qanda_ops_user"; fi
  case " $(id -nG "$qanda_ops_user") " in
    *' docker '*|*' sudo '*|*' wheel '*) echo 'Project accounts must not have host administrator groups.' >&2; exit 1 ;;
  esac
  usermod --shell /bin/sh "$qanda_ops_user"
done
passwd --lock qanda-deploy >/dev/null
passwd --lock qanda-debug >/dev/null
chmod 0700 /home/qanda-deploy /home/qanda-debug
install -d -o root -g root -m 0755 /etc/ssh/qanda-authorized-keys
if ! test -s /etc/qanda/ssh_host_ed25519_key; then ssh-keygen -q -t ed25519 -N '' -f /etc/qanda/ssh_host_ed25519_key; fi
install -m 0440 "$qanda_source_dir/qanda-deploy.sudoers" /etc/sudoers.d/qanda-deploy
visudo -cf /etc/sudoers.d/qanda-deploy
systemctl daemon-reload
if test "$qanda_node_role" != combined; then
  python3 - <<'PY'
import runpy, subprocess
controller = runpy.run_path('/usr/local/sbin/qanda-deployctl', run_name='qanda_bootstrap')
controller['protected'](controller['ROOT'] / 'node.env')
for image in (controller['tailnet_image'](), controller['GATEWAY_IMAGE']):
    subprocess.run(['docker', 'pull', image], check=True)
PY
  if ! docker network inspect qanda-application >/dev/null 2>&1; then
    docker network create --subnet 172.29.71.0/24 \
      --label com.docker.compose.network=application \
      --label com.docker.compose.project=qanda-application qanda-application >/dev/null
  fi
  if test "$qanda_node_role" = backend && ! docker network inspect qanda-data >/dev/null 2>&1; then
    docker network create --label com.docker.compose.network=data \
      --label com.docker.compose.project=qanda-infrastructure qanda-data >/dev/null
  fi
  systemctl enable qanda-ops.service qanda-tailnet.service
fi
if test "${1:-}" = --control-only; then
  test "$qanda_node_role" != combined
  exit 0
fi
if ! test -s /etc/qanda/backup.key; then (umask 077; openssl rand -base64 48 > /etc/qanda/backup.key); fi
install -m 0644 "$qanda_source_dir"/qanda-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
if test "$qanda_node_role" = frontend; then
  systemctl disable --now qanda-backup.timer
  exit 0
fi
systemctl enable --now qanda-backup.timer
docker volume create qanda-production-assets >/dev/null
docker compose -p qanda-infrastructure --env-file /srv/qanda/production.env \
  -f /srv/qanda/compose.infrastructure.yml up -d --wait --wait-timeout 180
