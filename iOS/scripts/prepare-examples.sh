#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
source_dir="${1:-${project_dir:h}/data/ten-photo-pilot-20260908/run-UdBWjj}"
target_dir="$project_dir/StudentApp/Resources/SamplePhotos"
mkdir -p "$target_dir"

# Private, full original-page copies. Never commit these images or alter the source.
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
