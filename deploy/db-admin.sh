#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Use sudo qanda-db' >&2; exit 1; }
umask 077
qanda_operation=${1:-}
qanda_db=(docker compose -p qanda-infrastructure --env-file /srv/qanda/production.env -f /srv/qanda/compose.infrastructure.yml exec -T postgres)
case "$qanda_operation" in
  export)
    test "$#" = 2
    test ! -e "$2"
    qanda_export_file=$(mktemp "${2}.working.XXXXXX")
    trap 'rm -f -- "$qanda_export_file"' EXIT
    "${qanda_db[@]}" pg_dump -U qanda_backend -d qanda_backend -Fc > "$qanda_export_file"
    chmod 0600 "$qanda_export_file"
    mv -n "$qanda_export_file" "$2"
    sha256sum "$2" > "${2}.sha256"
    ;;
  psql)
    test "$#" = 1
    exec docker compose -p qanda-infrastructure --env-file /srv/qanda/production.env -f /srv/qanda/compose.infrastructure.yml \
      exec postgres psql -U qanda_backend -d qanda_backend -v ON_ERROR_STOP=1
    ;;
  sql|restore)
    test "$#" = 2
    test -f "$2"
    exec 8>/var/lib/qanda-deploy/lock
    flock -n 8
    # Import and release share a lock; writes stay stopped if the import or verification fails.
    qanda_state=/var/lib/qanda-deploy/current.json
    test -s "$qanda_state"
    export BACKEND_IMAGE WEB_IMAGE REVISION
    BACKEND_IMAGE=$(python3 -c 'import json;print(json.load(open("/var/lib/qanda-deploy/current.json"))["backend"])')
    WEB_IMAGE=$(python3 -c 'import json;print(json.load(open("/var/lib/qanda-deploy/current.json"))["web"])')
    REVISION=$(python3 -c 'import json;print(json.load(open("/var/lib/qanda-deploy/current.json"))["revision"])')
    qanda_app=(docker compose -p qanda-application --env-file /srv/qanda/production.env)
    if test -f /srv/qanda/node.env; then qanda_app+=(--env-file /srv/qanda/node.env); fi
    qanda_app+=(-f /srv/qanda/compose.application.yml)
    qanda_services=(api worker monitor web)
    if test -f /srv/qanda/node.json; then
      qanda_role=$(python3 -c 'import json;print(json.load(open("/srv/qanda/node.json"))["role"])')
      test "$qanda_role" != frontend
      if test "$qanda_role" = backend; then
        qanda_app+=(-f /srv/qanda/compose.backend-node.yml)
        qanda_services=(api worker monitor)
      fi
    fi
    /usr/local/sbin/qanda-backup
    "${qanda_app[@]}" stop "${qanda_services[@]}"
    if test "$qanda_operation" = sql; then
      "${qanda_db[@]}" psql -U qanda_backend -d qanda_backend -v ON_ERROR_STOP=1 --single-transaction < "$2"
    else
      "${qanda_db[@]}" pg_restore -U qanda_backend -d qanda_backend --exit-on-error --single-transaction < "$2"
    fi
    "${qanda_db[@]}" psql -U qanda_backend -d qanda_backend -v ON_ERROR_STOP=1 -c 'ANALYZE;'
    "${qanda_app[@]}" up -d --no-build --pull never --wait --wait-timeout 240 "${qanda_services[@]}"
    ;;
  *) echo 'Usage: sudo qanda-db {psql|export FILE.dump|sql FILE.sql|restore FILE.dump}' >&2; exit 1 ;;
esac
