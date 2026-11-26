#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
for required in node ffmpeg osascript osacompile; do
  command -v "$required" >/dev/null 2>&1 || { echo "Required for development checks: $required" >&2; exit 1; }
done
[ -x bin/music-tags-file ] && [ -x build/bin/music-tags-file ] || {
  echo 'Build the native module and copy build/bin/music-tags-file to bin/ first (docs/development.md).' >&2
  exit 1
}
for source_file in music-tags native/package.sh scripts/*.sh; do sh -n "$source_file"; done
for source_file in ./*.js tests/*.js; do node --check "$source_file"; done
script_dir=$(mktemp -d)
trap 'rm -rf -- "$script_dir"' EXIT
for source_file in ./*.applescript; do osacompile -o "$script_dir/$(basename "$source_file").scpt" "$source_file"; done
node --test --test-concurrency=1 tests/*.test.js
osascript -l JavaScript tests/native.jxa.js "$project_dir"
