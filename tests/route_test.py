# Exercise server/modal_app.py's real FastAPI routes with Modal's pieces stubbed out (no Modal account needed).
# Needs: pip install modal fastapi httpx python-multipart.  Run: python tests/route_test.py
import hashlib, json, os, sys, tempfile, types
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
os.environ['PITCHSCAPE_PASSPHRASE'] = 'test'
import modal
import server.modal_app as m
from fastapi.testclient import TestClient

tmp = tempfile.mkdtemp(); m.CACHE = tmp
calls = {'reload': 0, 'spawn': 0}; FINISHED = set()
async def reload():
    calls['reload'] += 1
    if calls['reload'] == 1: raise RuntimeError('there are open files preventing the operation')
async def spawn(data, key, name):
    calls['spawn'] += 1; return types.SimpleNamespace(object_id='fc-1')
async def prog(key): return 'drums: ADTOF'
PACK = {'format': 'song-overprint-pack', 'version': 4, 'dur': 12.0, 'frames': 517, 'arrays': {'x': 'A' * 50000}, 'stats': {'hits': {'kick': 11}}}
class Call:
    def __init__(self, job): self.job = job; self.get = types.SimpleNamespace(aio=self._get)
    async def _get(self, timeout=None):
        if self.job == 'fc-bad': raise RuntimeError('boom')
        if self.job not in FINISHED: raise TimeoutError()
        return PACK
m.cache = types.SimpleNamespace(reload=types.SimpleNamespace(aio=reload))
m.analyze = types.SimpleNamespace(spawn=types.SimpleNamespace(aio=spawn))
async def prog_put(k, v): pass
m.progress = types.SimpleNamespace(get=types.SimpleNamespace(aio=prog), put=types.SimpleNamespace(aio=prog_put))
RUN = {}
async def run_get(k): return RUN.get(k)
async def run_put(k, v): RUN[k] = v
m.running = types.SimpleNamespace(get=types.SimpleNamespace(aio=run_get), put=types.SimpleNamespace(aio=run_put))
modal.FunctionCall.from_id = staticmethod(lambda job: Call(job))

web = m.api._raw_f_()
c = TestClient(web); K = {'X-Pitchscape-Key': 'test'}
audio = b'RIFF fake audio bytes'; sha = hashlib.sha256(audio).hexdigest()
def check(label, cond, extra=''):
    print(('ok   ' if cond else 'FAIL ') + label, extra); assert cond
r = c.get('/'); check('GET / needs no key', r.status_code == 200 and r.json()['service'] == 'pitchscape')
check('lookup without key is refused', c.get(f'/packs/{sha}').status_code == 401)
check('lookup with wrong key is refused', c.get(f'/packs/{sha}', headers={'X-Pitchscape-Key': 'nope'}).status_code == 401)
check('lookup of a non-hash is refused', c.get('/packs/not-a-hash', headers=K).status_code == 400)
r = c.get(f'/packs/{sha}', headers=K); check('unknown song is a 404', r.status_code == 404)
check('a refused reload is retried', calls['reload'] == 2, f"(reloads: {calls['reload']})")
r = c.post('/analyze', headers=K, files={'file': ('song.mp3', audio, 'audio/mpeg')}); j = r.json()
check('new song is queued', j.get('status') == 'queued' and j['job'] == 'fc-1' and j['key'] == m.PIPELINE_VERSION + ':' + sha and calls['spawn'] == 1)
r2 = c.post('/analyze', headers=K, files={'file': ('again.mp3', audio, 'audio/mpeg')}).json()
check('the same song sent while it runs follows that job', r2 == {'status': 'queued', 'job': 'fc-1', 'key': m.PIPELINE_VERSION + ':' + sha} and calls['spawn'] == 1)
r = c.get(f"/jobs/fc-1?key={j['key']}", headers=K); check('running job reports its stage', r.json() == {'status': 'running', 'stage': 'drums: ADTOF'})
FINISHED.add('fc-1')
r = c.get(f"/jobs/fc-1?key={j['key']}", headers=K); check('finished job returns the pack straight from the job', r.json().get('status') == 'done' and r.json()['pack'] == PACK)
r = c.get(f"/jobs/fc-bad?key={j['key']}", headers=K); check('a job that raised is reported failed', r.json() == {'status': 'failed', 'error': 'boom'})
# the GPU container writes the pack to the volume
path = m.pack_path(j['key']); os.makedirs(os.path.dirname(path), exist_ok=True); json.dump(PACK, open(path, 'w'))
r = c.get(f'/packs/{sha}', headers={**K, 'Accept-Encoding': 'gzip'})
check('known song is found by fingerprint', r.status_code == 200 and r.json()['pack'] == PACK)
check('the pack is sent gzipped', r.headers.get('content-encoding') == 'gzip', f"({r.headers.get('content-encoding')}, {len(r.content)} bytes decoded)")
r = c.post('/analyze', headers=K, files={'file': ('renamed.mp3', audio, 'audio/mpeg')})
check('re-upload of a known song is answered from the cache, no GPU', r.json().get('status') == 'done' and calls['spawn'] == 1)
r = c.options(f'/packs/{sha}', headers={'Origin': 'https://stop-amertime.github.io', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-pitchscape-key'})
check('the site may call it', r.headers.get('access-control-allow-origin') == 'https://stop-amertime.github.io')
r = c.options(f'/packs/{sha}', headers={'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'GET'})
check('other sites may not', r.headers.get('access-control-allow-origin') is None)
big = c.post('/analyze', headers=K, files={'file': ('big.mp3', b'0' * 80_000_001, 'audio/mpeg')})
check('files over 80 MB are refused', big.status_code == 413)
print('all route checks passed')
