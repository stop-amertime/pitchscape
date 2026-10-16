# Exercise server/modal_app.py's real FastAPI routes with Modal's pieces stubbed out (no Modal account needed).
# Needs: pip install modal fastapi httpx python-multipart.  Run: python tests/route_test.py
import hashlib, http.server, json, os, sys, tempfile, threading, types
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
async def commit(): calls['commit'] = calls.get('commit', 0) + 1
m.cache = types.SimpleNamespace(reload=types.SimpleNamespace(aio=reload), commit=types.SimpleNamespace(aio=commit))
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
check('the same song sent while it runs follows that job', r2 == {'status': 'queued', 'job': 'fc-1', 'key': m.PIPELINE_VERSION + ':' + sha, 'sha256': sha} and calls['spawn'] == 1)
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

# songs by link: a real download (server/fetch.py) from a little web server on this machine. Only its port is let
# through the public-address check; every other address goes through the real check.
import server.fetch as F
link_audio = b'ID3 another fake song'; link_sha = hashlib.sha256(link_audio).hexdigest()
class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        routes = {'/song.mp3': (200, 'audio/mpeg', link_audio), '/same.mp3': (200, 'audio/mpeg', audio),
                  '/page': (200, 'text/html; charset=utf-8', b'<html>a video</html>'), '/big.mp3': (200, 'audio/mpeg', b'0' * 2000)}
        if self.path == '/hop':
            self.send_response(302); self.send_header('Location', '/song.mp3'); self.end_headers(); return
        if self.path == '/inside':
            self.send_response(302); self.send_header('Location', 'http://169.254.169.254/latest/meta-data'); self.end_headers(); return
        code, ctype, body = routes.get(self.path, (404, 'text/plain', b'no'))
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
site = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Site); PORT = site.server_address[1]
threading.Thread(target=site.serve_forever, daemon=True).start()
real_public_ip = F.public_ip
F.public_ip = lambda host, port: '127.0.0.1' if (host, port) == ('127.0.0.1', PORT) else real_public_ip(host, port)
SITE = f'http://127.0.0.1:{PORT}'
def link(u): return c.post('/analyze', headers=K, data={'url': u})
spawned = calls['spawn']
r = link(SITE + '/song.mp3'); j = r.json()
check('a song by link is downloaded and queued', r.status_code == 200 and j.get('status') == 'queued' and j['sha256'] == link_sha and calls['spawn'] == spawned + 1, str(j))
kept = os.path.join(tmp, 'library', link_sha)
check('its audio is kept in the library at once', open(os.path.join(kept, 'audio.mp3'), 'rb').read() == link_audio and calls.get('commit'))
r = c.get(f'/library/{link_sha}/audio', headers=K)
check('and the page can play it from the server', r.status_code == 200 and r.content == link_audio and r.headers['content-type'].startswith('audio/mpeg'))
check('the audio needs the key', c.get(f'/library/{link_sha}/audio').status_code == 401)
check('audio not kept is a 404', c.get(f'/library/{"0" * 64}/audio', headers=K).status_code == 404)
r = link(SITE + '/hop').json()
check('a redirect is followed to the same song', r.get('status') in ('queued', 'done') and r['sha256'] == link_sha and calls['spawn'] == spawned + 1, str(r)[:120])
r = link(SITE + '/same.mp3').json()
check('a file by link is the same song as the same file uploaded (no new analysis)', r.get('status') == 'done' and r['sha256'] == sha and r['pack'] == PACK and calls['spawn'] == spawned + 1, str(r)[:120])
for u, why in [('http://127.0.0.1/song.mp3', 'loopback'), ('http://localhost/song.mp3', 'localhost'), ('http://10.1.2.3/song.mp3', 'private'),
               ('http://192.168.1.1/', 'home router'), ('http://169.254.169.254/latest/meta-data', 'cloud metadata'), ('http://[::1]/song.mp3', 'IPv6 loopback'),
               ('http://[::ffff:10.0.0.1]/song.mp3', 'IPv4-mapped private'), ('http://100.64.0.1/song.mp3', 'carrier-grade NAT'), ('file:///etc/passwd', 'file://'),
               (SITE + '/inside', 'a redirect to the metadata address')]:
    r = link(u)
    check(f'refused: {why}', r.status_code == 400 and calls['spawn'] == spawned + 1, r.json().get('detail', ''))
r = link(SITE + '/page'); check('a web page is refused', r.status_code == 400 and 'web page' in r.json()['detail'])
r = link(SITE + '/nothing'); check('a missing file is reported', r.status_code == 502 and '404' in r.json()['detail'])
F.LIMIT = 1000
r = link(SITE + '/big.mp3'); check('a file over the limit is refused', r.status_code == 413, r.json().get('detail', ''))
check('neither upload nor link is a 400', c.post('/analyze', headers=K, data={}).status_code == 400)
check('Drive share links become download links', F.direct('https://drive.google.com/file/d/1AbC-d_9/view?usp=sharing') == 'https://drive.usercontent.google.com/download?id=1AbC-d_9&export=download&confirm=t')
check('Dropbox share links become download links', F.direct('https://www.dropbox.com/scl/fi/xyz/song.mp3?rlkey=abc&dl=0') == 'https://www.dropbox.com/scl/fi/xyz/song.mp3?rlkey=abc&dl=1')
check('other links are left as they are', F.direct(SITE + '/song.mp3') == SITE + '/song.mp3')
site.shutdown()
print('all route checks passed')
