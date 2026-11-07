#!/usr/bin/env bash
set -euo pipefail
case "${IMAGE_KIND:-}" in backend|web) ;; *) echo 'Expected backend or web' >&2; exit 1 ;; esac
if ! [[ "${IMAGE:-}" =~ ^ghcr\.io/zhouycheng/qanda-${IMAGE_KIND}@sha256:[0-9a-f]{64}$ ]]; then
  echo 'Image does not match the selected private repository and digest' >&2
  exit 1
fi
printf '%s' "$REGISTRY_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
docker pull "$IMAGE" >/dev/null
repository=${IMAGE%@sha256:*}
digest=${IMAGE##*@}
local_tag="${repository}:sha256-${digest#sha256:}"
docker tag "$IMAGE" "$local_tag"
docker save --output "$RUNNER_TEMP/qanda-image.tar" "$local_tag"
echo "sha256=$(sha256sum "$RUNNER_TEMP/qanda-image.tar" | cut -d ' ' -f 1)" >> "$GITHUB_OUTPUT"
