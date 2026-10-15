#!/usr/bin/env bash
# usage: tools/add_song.sh SONG.mp3 LYRICS.txt slug "Title" "Artist"
# Produces docs/<slug>.pack.json and docs/<slug>.mp3, then tells you the two lines to add in src/app.html.
set -euo pipefail
cd "$(dirname "$0")/.."
SONG="$1"; LYR="$2"; SLUG="$3"; TITLE="$4"; ARTIST="$5"
WORK="work/$SLUG"; mkdir -p "$WORK"
python3 tools/separate.py "$SONG" "$WORK/stems"
node tools/prepare_lyrics.js "$LYR" "$WORK"
if [ -n "${OPENROUTER_API_KEY:-}" ]; then python3 tools/check_line_order.py "$WORK" || echo "line-order check failed; continuing"; fi
python3 tools/align.py "$WORK"
python3 tools/repair_timing.py "$WORK"
node tools/build_pack.js "$WORK" "docs/$SLUG.pack.json" "$TITLE" "$ARTIST" "$SLUG.mp3"
cp "$SONG" "docs/$SLUG.mp3"
echo
echo "Done. To list it on the page, edit src/app.html:"
echo "  1. add to SONGS:  '$SLUG': { pack: '$SLUG.pack.json', preview: 30 },"
echo "  2. add a shelf button: <button class=\"song\" type=\"button\" data-song=\"$SLUG\" aria-pressed=\"false\"><b>$TITLE</b><span>$ARTIST · AI stems, word timing</span></button>"
echo "  then run: node src/build.js"
