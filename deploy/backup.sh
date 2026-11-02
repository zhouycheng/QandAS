#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
exec 9>/run/lock/qanda-backup.lock
flock -n 9
test -s /etc/qanda/backup.key
install -d -m 0700 /var/backups/qanda
qanda_backup_dir=$(mktemp -d /var/backups/qanda/.working.XXXXXX)
trap 'rm -rf -- "$qanda_backup_dir"' EXIT
docker compose -p qanda-infrastructure --env-file /srv/qanda/production.env \
  -f /srv/qanda/compose.infrastructure.yml exec -T postgres \
  pg_dump -U qanda_backend -d qanda_backend -Fc > "$qanda_backup_dir/database.dump"
qanda_asset_dir=$(docker volume inspect -f '{{.Mountpoint}}' qanda-production-assets)
# Copy files after the DB snapshot: committed image metadata must already have an immutable file.
tar -C "$qanda_asset_dir" -cf "$qanda_backup_dir/assets.tar" .
cp /srv/qanda/production.env "$qanda_backup_dir/production.env"
cp /srv/qanda/compose.*.yml "$qanda_backup_dir/"
for qanda_node_file in /srv/qanda/node.json /srv/qanda/node.env; do
  if test -f "$qanda_node_file"; then cp "$qanda_node_file" "$qanda_backup_dir/"; fi
done
if test -d /var/lib/qanda-deploy; then cp -R /var/lib/qanda-deploy "$qanda_backup_dir/deployment-state"; fi
qanda_backup_file="/var/backups/qanda/$(date -u +%Y%m%dT%H%M%S%NZ).tar.enc"
tar -C "$qanda_backup_dir" -cf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -pass file:/etc/qanda/backup.key -out "${qanda_backup_file}.partial"
mv "${qanda_backup_file}.partial" "$qanda_backup_file"
sha256sum "$qanda_backup_file" > "${qanda_backup_file}.sha256"
