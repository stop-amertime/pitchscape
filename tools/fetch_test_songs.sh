#!/bin/sh
# Fetch the real recordings listed in tools/test_songs.json into testsongs/ (git-ignored). Skips files already there.
set -e
cd "$(dirname "$0")/.."
mkdir -p testsongs
python3 - <<'PY'
import json, os, subprocess
for s in json.load(open('tools/test_songs.json'))['songs']:
    out = os.path.join('testsongs', s['file'])
    if os.path.exists(out) and os.path.getsize(out) > 100000:
        continue
    print('fetching', s['file'])
    subprocess.run(['curl', '-sSfL', '--retry', '4', '-o', out, s['url']], check=True)
PY
ls -l testsongs
