#!/usr/bin/env bash
set -euo pipefail
test "$CACHE_EXACT_HIT" = true
(cd release && sha256sum -c SHA256SUMS)
case "${RELEASE_KIND:-}" in
  backend)
    test -s release/backend/qanda-backend-1.0.0.jar
    mkdir -p apps/api/target
    cp release/backend/qanda-backend-1.0.0.jar apps/api/target/
    qanda_build_context=apps/api
    qanda_dockerfile=apps/api/Dockerfile
    ;;
  web)
    test -s release/web/index.html
    mkdir -p apps/admin/dist
    cp -R release/web/. apps/admin/dist/
    qanda_build_context=.
    qanda_dockerfile=deploy/web.Dockerfile
    ;;
  *) echo 'Expected backend or web' >&2; exit 1 ;;
esac
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
qanda_repository="ghcr.io/zhouycheng/qanda-${RELEASE_KIND}"
printf '%s' "$REGISTRY_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
trap 'docker logout ghcr.io >/dev/null' EXIT
docker buildx create --driver docker-container --use
docker buildx build --platform linux/amd64 --push \
  --label 'org.opencontainers.image.source=https://github.com/zhouycheng/QandA' \
  --label "org.opencontainers.image.revision=$GITHUB_SHA" \
  --cache-from "type=registry,ref=${qanda_repository}:buildcache" \
  --cache-to "type=registry,ref=${qanda_repository}:buildcache,mode=min,ignore-error=true" \
  -t "${qanda_repository}:${GITHUB_SHA}" -f "$qanda_dockerfile" \
  --metadata-file "$RUNNER_TEMP/image.json" "$qanda_build_context"
qanda_digest=$(jq -er '."containerimage.digest" | select(test("^sha256:[0-9a-f]{64}$"))' "$RUNNER_TEMP/image.json")
docker pull "${qanda_repository}@${qanda_digest}" >/dev/null
qanda_anonymous_status=$(curl --silent --show-error --output "$RUNNER_TEMP/anonymous-image.json" \
  --write-out '%{http_code}' "https://ghcr.io/token?service=ghcr.io&scope=repository:zhouycheng/qanda-${RELEASE_KIND}:pull")
case "$qanda_anonymous_status" in
  401|403) ;;
  *) echo 'The release image must deny anonymous pulls' >&2; exit 1 ;;
esac
echo "image=${qanda_repository}@${qanda_digest}" >> "$GITHUB_OUTPUT"
