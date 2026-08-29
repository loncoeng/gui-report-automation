#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 SOURCE_CHROME_DIR TARGET_CHROME_DIR" >&2
  exit 2
fi

source_dir="$1"
target_dir="$2"

if [[ ! -d "$source_dir/Default" || ! -d "$source_dir/Profile 1" ]]; then
  echo "Chrome profiles were not found in source directory: $source_dir" >&2
  exit 1
fi

mkdir -p "$target_dir"

if mountpoint -q "$target_dir"; then
  echo "Chrome user-data view is already mounted at $target_dir"
else
  mount --bind "$source_dir" "$target_dir"
fi

test -d "$target_dir/Default"
test -d "$target_dir/Profile 1"
echo "CHROME_USER_DATA_BIND_READY $target_dir"
