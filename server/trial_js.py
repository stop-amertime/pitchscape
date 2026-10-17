"""A trial of the JavaScript pipeline on Modal, apart from the live server: its own app, nothing cached, nothing
served. Analyses a freely licensed song from archive.org on an L4 with server/analyse.mjs (the image the server
will use: node_image in modal_app.py) and prints the GPU, each stage's time and the providers each model ran on.

  modal run -m server.trial_js [--url URL] [--words/--no-words] [--runs 2]

Run by .github/workflows/trial-js.yml (by hand), since the Modal token is a repository secret. The second run of the
same container shows the time without the cold start (models loaded from disk, shaders and kernels compiled).
"""
import json
import os
import subprocess
import tempfile
import time
import urllib.request

import modal

from server.modal_app import APP, node_image

app = modal.App('pitchscape-trial')
SONG = 'https://archive.org/download/JoshWoodwardSelection/20-JoshWoodward-HereToday-01-Incoherent.mp3'


@app.function(image=node_image, gpu='L4', timeout=1800)
def trial(url: str, words: bool, runs: int):
    out = [subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
                          capture_output=True, text=True).stdout.strip(), f'cores {os.cpu_count()}']
    with urllib.request.urlopen(url, timeout=60) as r:
        audio = r.read()
    name = 'Josh Woodward - Incoherent.mp3'
    with tempfile.TemporaryDirectory() as d:
        song, pack = os.path.join(d, 'song.mp3'), os.path.join(d, 'pack.json')
        open(song, 'wb').write(audio)
        for i in range(runs):
            t = time.time()
            p = subprocess.run(['node', f'{APP}/server/analyse.mjs', song, pack, name] + ([] if words else ['--no-words']),
                               capture_output=True, text=True, cwd=APP)
            out.append(f'run {i + 1}: exit {p.returncode} in {time.time() - t:.1f} s')
            out += [l for l in p.stderr.splitlines() if 'stage times' in l or 'running on' in l or 'Error' in l
                    or 'could not' in l][-30:]
            if p.returncode:
                out.append(p.stderr[-3000:])
                break
            pk = json.load(open(pack))
            out.append('pack: version %s, %s notes, hits %s, lyrics %s' % (
                pk['version'], pk['stats']['notes'], json.dumps(pk['stats']['hits']),
                json.dumps({k: pk['stats']['lyrics'].get(k) for k in ('found', 'matched', 'heard')})))
    return '\n'.join(out)


@app.local_entrypoint()
def main(url: str = SONG, words: bool = True, runs: int = 2):
    print(trial.remote(url, words, runs))
