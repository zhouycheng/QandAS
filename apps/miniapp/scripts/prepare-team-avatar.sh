#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# 320px 头像足够小程序高清显示，保留上传的原图作为来源。
sips -Z 320 -s format jpeg -s formatOptions 85 \
  "$project_dir/design/team/peter.jpg" \
  --out "$project_dir/miniprogram/assets/team/peter.jpg" >/dev/null
