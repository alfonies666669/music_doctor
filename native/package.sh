#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir=$(cd -- "${1:-$root/build}" && pwd)
binary="$build_dir/bin/music-tags-file"
[ -x "$binary" ] || { echo 'Build music-tags-file first.' >&2; exit 1; }
version=$("$root/music-tags" --version)
architecture=$(/usr/bin/lipo -archs "$binary" | /usr/bin/tr ' ' '-')
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
name="Music-Doctor-$version-macOS-$architecture"
release="$staging/$name"
mkdir -p "$root/dist" "$release/bin" "$release/licenses"
for f in music-tags jxa.js core.js filters.js file-core.js file-commands.js extract-artwork.applescript README.md NAVIGATION.md; do
  cp "$root/$f" "$release/"
done
cp -R "$root/examples" "$release/"
cp "$binary" "$release/bin/"
taglib_src="$build_dir/_deps/taglib-src"
cp "$taglib_src/COPYING.LGPL" "$release/licenses/TagLib-LGPL.txt"
cp "$taglib_src/COPYING.MPL" "$release/licenses/TagLib-MPL.txt"
cp "$taglib_src/3rdparty/utfcpp/LICENSE" "$release/licenses/utf8cpp.txt"
printf '%s\n' 'TagLib 2.3.2 (unmodified source)' \
  'https://taglib.org/releases/taglib-2.3.2.tar.gz' \
  'The upstream archive contains utf8cpp 4.2.0.' > "$release/licenses/SOURCES.txt"
archive="$root/dist/$name.zip"
[ ! -e "$archive" ] || { echo "Archive already exists: $archive" >&2; exit 1; }
(cd "$staging" && /usr/bin/zip -qr "$archive" "$name")
printf '%s\n' "$archive"
