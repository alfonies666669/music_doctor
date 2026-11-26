#!/bin/sh
# Consolidate old experiment data; source code and audio files are untouched.
set -eu
project_dir=${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
project_dir=$(CDPATH= cd -- "$project_dir" && pwd -P)
[ -f "$project_dir/music-tags" ] && [ -f "$project_dir/core.js" ] || {
  echo 'Expected a Music Doctor project directory.' >&2; exit 1;
}
archive_dir=
moved=0
for candidate in "$project_dir"/music-artwork-apply-* "$project_dir"/french-run*; do
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || continue
  if [ -z "$archive_dir" ]; then
    mkdir -p "$project_dir/runs/archive"
    archive_dir=$(mktemp -d "$project_dir/runs/archive/cleanup-XXXXXXXX")
  fi
  name=$(basename "$candidate")
  mv -- "$candidate" "$archive_dir/$name"
  moved=$((moved + 1))
  # The archived bytes exist before staging the removal of a personal bundle.
  if [ "$(git -C "$project_dir" rev-parse --show-toplevel 2>/dev/null || true)" = "$project_dir" ]; then
    git -C "$project_dir" rm -r -f --cached --ignore-unmatch -- "$name" >/dev/null
  fi
done
if [ "$moved" -eq 0 ]; then echo 'No old experiment folders found.';
else printf 'Archived %s experiment folders: %s\n' "$moved" "$archive_dir"; fi
