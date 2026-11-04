#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$project_dir/miniprogram/assets/brand"
# 320px 覆盖关于页图标的三倍屏幕密度，原图保存在设计目录。
sips -Z 320 -s format jpeg -s formatOptions 85 \
  "$project_dir/design/app-logo/题搭Logo 睁眼蓝底.png" \
  --out "$project_dir/miniprogram/assets/brand/app-icon.jpg" >/dev/null
