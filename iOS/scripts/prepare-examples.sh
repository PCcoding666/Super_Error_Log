#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
source_dir="${1:-${project_dir:h}/data/ten-photo-pilot-20260908/run-UdBWjj}"
target_dir="$project_dir/StudentApp/Resources/SamplePhotos"
mkdir -p "$target_dir"

# Private, full original-page copies. Never commit these images or alter the source.
# M1 起：StudentApp/Resources/SamplePhotos 已在 project.pbxproj 的同步组
# membershipExceptions 中排除，任何配置都不进 app 构建；示例原图由
# Resources/SyntheticExamples/ 的合成图承接。本脚本仍把私有原图放进该目录
# 仅供本机磁盘参考，对 bundle 已无影响。
for code in IMG_5516 IMG_5518 IMG_5517; do
  source_path="$source_dir/$code/source.jpg"
  target_path="$target_dir/$code.jpg"
  [[ -f "$source_path" ]] || { print -u2 "Missing original: $source_path"; exit 1; }
  if [[ -f "$target_path" ]]; then
    cmp -s "$source_path" "$target_path" || { print -u2 "Existing copy differs; not overwriting: $target_path"; exit 1; }
  else
    cp "$source_path" "$target_path"
  fi
done
print "Three private source-page examples are ready."
