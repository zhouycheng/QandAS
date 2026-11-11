#!/bin/sh
set -eu
case "${BACKEND_REDIS_PASSWORD:-}" in
  ''|*[!A-Za-z0-9_-]*) echo 'Redis requires a generated cache password.' >&2; exit 1 ;;
esac
test "${#BACKEND_REDIS_PASSWORD}" -ge 16
test "${#BACKEND_REDIS_PASSWORD}" -le 256
umask 077
qanda_cache_config=$(mktemp /tmp/qanda-redis.XXXXXX)
printf 'bind 0.0.0.0\nprotected-mode yes\nrequirepass %s\nsave ""\nappendonly no\nmaxmemory 96mb\nmaxmemory-policy allkeys-lfu\n' "$BACKEND_REDIS_PASSWORD" > "$qanda_cache_config"
exec redis-server "$qanda_cache_config"
