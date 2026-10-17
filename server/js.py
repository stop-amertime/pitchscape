"""The analysis, run by the servers (server/modal_app.py, server/local.py): the JavaScript pipeline (src/pipeline)
under Node, through server/analyse.mjs. server/pipeline.py is no longer run; it is kept as the reference the JavaScript
was checked against (tools/parity*.py)."""
import json
import os
import subprocess
import tempfile

# the checkout holding server/analyse.mjs and src/pipeline (on Modal: node_image's /app, apart from this module)
ROOT = os.environ.get('PITCHSCAPE_ROOT') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ENTRY = os.path.join(ROOT, 'server', 'analyse.mjs')


class Failed(Exception):
    pass


def song_info(path, name):
    """What identifies the song (tags, length, cover art...): pipeline.song_info's record, read by src/pipeline/tags.mjs."""
    p = subprocess.run(['node', ENTRY, path, '--info', name], capture_output=True, text=True, encoding='utf-8')
    if p.returncode:
        raise Failed(p.stderr.strip()[-500:] or 'node failed')
    return json.loads(p.stdout)


def analyze(path, name, progress=lambda msg: None, ep=None, words=True):
    """The song at `path` (sent as `name`) -> its pack. progress(message) gets each stage message as it comes."""
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, 'pack.json')
        cmd = ['node', ENTRY, path, out, name] + (['--ep', ep] if ep else []) + ([] if words else ['--no-words'])
        err = tempfile.TemporaryFile(mode='w+', encoding='utf-8')
        with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True, encoding='utf-8', cwd=ROOT) as p:
            for line in p.stdout:
                if line.startswith('progress '):
                    progress(line[9:].rstrip('\n'))
        if p.returncode:
            err.seek(0)
            lines = err.read().strip().splitlines()
            print('\n'.join(lines[-40:]), flush=True)          # the whole story for the server's log
            said = [l for l in lines if 'Error' in l and not l.lstrip().startswith('at ')]
            raise Failed((said or lines or [f'node exited with {p.returncode}'])[-1].strip())
        with open(out, encoding='utf-8') as fh:
            return json.load(fh)
