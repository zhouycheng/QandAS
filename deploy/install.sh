#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
qanda_source_dir=$(cd "$(dirname "$0")" && pwd)
test -s /srv/qanda/production.env
test "$(stat -c '%a' /srv/qanda/production.env)" = 600
install -d -o root -g root -m 0755 /srv/qanda/web-assets /usr/local/lib/qanda
install -d -o root -g root -m 0700 /var/lib/qanda-deploy /etc/qanda
install -m 0644 "$qanda_source_dir"/compose.*.yml "$qanda_source_dir"/prometheus.yml /srv/qanda/
install -m 0644 "$qanda_source_dir"/../apps/api/monitoring/{rabbitmq-plugins,sync-rules.yml} /srv/qanda/
install -m 0755 "$qanda_source_dir/deployctl.py" /usr/local/sbin/qanda-deployctl
install -m 0755 "$qanda_source_dir/candidate-check.py" /usr/local/lib/qanda/candidate-check.py
install -m 0755 "$qanda_source_dir/restore-check.py" /usr/local/lib/qanda/restore-check.py
install -m 0755 "$qanda_source_dir/backup.sh" /usr/local/sbin/qanda-backup
install -m 0755 "$qanda_source_dir/db-admin.sh" /usr/local/sbin/qanda-db
if ! id qanda-deploy >/dev/null 2>&1; then useradd --create-home --user-group --shell /bin/bash qanda-deploy; fi
passwd --lock qanda-deploy >/dev/null
chmod 0700 /home/qanda-deploy
install -m 0440 "$qanda_source_dir/qanda-deploy.sudoers" /etc/sudoers.d/qanda-deploy
visudo -cf /etc/sudoers.d/qanda-deploy
if ! test -s /etc/qanda/backup.key; then (umask 077; openssl rand -base64 48 > /etc/qanda/backup.key); fi
install -m 0644 "$qanda_source_dir"/qanda-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
qanda_node_role=$(python3 -c 'import json,pathlib;p=pathlib.Path("/srv/qanda/node.json");print(json.loads(p.read_text())["role"] if p.exists() else "combined")')
if test "$qanda_node_role" = frontend; then exit 0; fi
systemctl enable --now qanda-backup.timer
docker volume create qanda-production-assets >/dev/null
docker compose -p qanda-infrastructure --env-file /srv/qanda/production.env \
  -f /srv/qanda/compose.infrastructure.yml up -d --wait --wait-timeout 180
