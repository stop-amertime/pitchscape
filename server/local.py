"""Pitchscape on your own computer: the page and the analysis server in one, with no Modal and no passphrase.

    python -m server.local                 then open http://localhost:8000
    python -m server.local --port 8123 --device cpu --whisper small --cache D:/pitchscape-cache

It answers the same routes as the Modal server (server/modal_app.py), runs server/pipeline.py on this machine (on a
CUDA GPU if PyTorch sees one, otherwise on the CPU) one song at a time, and keeps each result in the cache folder
(default ~/.pitchscape/cache), named like the Modal cache, so a song is analysed once per pipeline version.

The page is built from src/ on every load (the same steps as src/build.js), so an edit to src/app.html or src/dsp.js
shows on the next refresh. Setup: see "Run it on your own computer" in README.md.
"""
import argparse, email.parser, email.policy, hashlib, json, os, queue, re, sys, tempfile, threading, time, traceback
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
# the pipeline version, read from the Modal app's source (importing that needs Modal installed)
PIPELINE_VERSION = re.search(r"^PIPELINE_VERSION = '([^']+)'", open(os.path.join(ROOT, 'server', 'modal_app.py')).read(), re.M).group(1)


def build_page():
    """docs/index.html as src/build.js would write it, from the current src/app.html and src/dsp.js."""
    app = open(os.path.join(ROOT, 'src', 'app.html'), encoding='utf-8').read()
    dsp = open(os.path.join(ROOT, 'src', 'dsp.js'), encoding='utf-8').read()
    page = app.replace('/*DSP_SOURCE*/', dsp, 1)
    cut = page.index('<main class="app">')
    reset = ('html{color-scheme:light}:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
             'body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}')
    return ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<style>' + reset
            + '</style>\n' + page[:cut] + '</head>\n<body>\n' + page[cut:] + '</body>\n</html>\n')


class Jobs:
    """One song analysed at a time, in a worker thread; each job's latest stage is kept for the page to show."""

    def __init__(self, cache, device, whisper):
        self.cache, self.device, self.whisper = cache, device, whisper
        self.q, self.state, self.lock = queue.Queue(), {}, threading.Lock()
        threading.Thread(target=self.work, daemon=True).start()

    def path(self, key):
        version, sha = key.split(':', 1)
        return os.path.join(self.cache, 'v' + version, sha + '.json')

    def cached(self, key):
        p = self.path(key)
        if os.path.exists(p):
            with open(p, encoding='utf-8') as fh:
                return json.load(fh)
        return None

    def submit(self, data, name):
        key = PIPELINE_VERSION + ':' + hashlib.sha256(data).hexdigest()
        with self.lock:
            st = self.state.get(key)
            if st and st['status'] in ('queued', 'running'):
                return key
            self.state[key] = {'status': 'queued', 'stage': None}
        self.q.put((key, data, name))
        return key

    def work(self):
        from server.pipeline import analyze, log
        while True:
            key, data, name = self.q.get()
            self.state[key] = {'status': 'running', 'stage': None}
            t0 = time.time()
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    f = os.path.join(tmp, 'song' + (os.path.splitext(name)[1] or '.mp3'))
                    with open(f, 'wb') as fh:
                        fh.write(data)

                    def progress(*a):
                        msg = ' '.join(str(x) for x in a)
                        self.state[key]['stage'] = msg
                        log(msg)
                    pack = analyze(f, device=self.device, whisper_size=self.whisper, title=os.path.splitext(name)[0],
                                   name=name, progress=progress)
                p = self.path(key)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, 'w', encoding='utf-8') as fh:
                    json.dump(pack, fh)
                self.state[key] = {'status': 'done'}
                print('analysed %s in %.0f s' % (name, time.time() - t0), flush=True)
            except Exception as e:
                traceback.print_exc()
                self.state[key] = {'status': 'failed', 'error': (type(e).__name__ + ': ' + str(e))[:300]}

    def poll(self, key):
        pack = self.cached(key)
        if pack is not None:
            return {'status': 'done', 'pack': pack}
        st = self.state.get(key)
        if not st:
            return {'status': 'failed', 'error': 'This server has no record of that job (it may have restarted). Load the song again.'}
        if st['status'] == 'failed':
            return {'status': 'failed', 'error': st['error']}
        return {'status': 'running', 'stage': st.get('stage')}


def handler(jobs):
    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=os.path.join(ROOT, 'docs'), **k)

        def send(self, body, ctype, code=200):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def reply(self, obj, code=200):
            self.send(json.dumps(obj).encode(), 'application/json', code)

        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if path in ('/', '/index.html'):
                return self.send(build_page().encode('utf-8'), 'text/html; charset=utf-8')
            if path == '/config.json':
                return self.reply({'api': 'http://' + self.headers.get('Host', 'localhost'), 'pipeline': PIPELINE_VERSION, 'local': True})
            if path == '/api' or path == '/version':
                return self.reply({'service': 'pitchscape', 'version': PIPELINE_VERSION, 'local': True})
            m = re.fullmatch(r'/packs/([0-9a-f]{64})', path)
            if m:
                pack = jobs.cached(PIPELINE_VERSION + ':' + m.group(1))
                return self.reply({'status': 'done', 'pack': pack}) if pack else self.reply({'detail': 'Not analysed yet.'}, 404)
            m = re.fullmatch(r'/jobs/([^/]+)', path)
            if m:
                key = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('key', [''])[0]
                return self.reply(jobs.poll(key))
            return super().do_GET()

        def do_POST(self):
            if urllib.parse.urlparse(self.path).path != '/analyze':
                return self.reply({'detail': 'Not found.'}, 404)
            n = int(self.headers.get('Content-Length', 0))
            if n > 80_000_000:
                return self.reply({'detail': 'That file is over 80 MB.'}, 413)
            body = self.rfile.read(n)
            msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
                b'Content-Type: ' + self.headers.get('Content-Type', '').encode() + b'\r\n\r\n' + body)
            part = next((p for p in msg.iter_parts() if p.get_param('name', header='content-disposition') == 'file'), None)
            if part is None:
                return self.reply({'detail': 'No file in the upload.'}, 400)
            data, name = part.get_payload(decode=True), part.get_filename() or 'song.mp3'
            key = PIPELINE_VERSION + ':' + hashlib.sha256(data).hexdigest()
            pack = jobs.cached(key)
            if pack is not None:
                return self.reply({'status': 'done', 'pack': pack})
            key = jobs.submit(data, name)
            return self.reply({'status': 'queued', 'job': key.split(':', 1)[1][:16], 'key': key})

        def log_message(self, fmt, *a):
            if not re.match(r'"GET /jobs/', fmt % a):
                sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % a))
    return H


def main():
    ap = argparse.ArgumentParser(description='Pitchscape on this computer: the page and the analysis server.')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--host', default='127.0.0.1', help='0.0.0.0 to let a phone on the same network open it')
    ap.add_argument('--device', default='auto', help='cuda, cpu or auto (cuda when PyTorch sees a GPU)')
    ap.add_argument('--whisper', help='Whisper model size for timing the lyrics (default: medium on a GPU, base on CPU)')
    ap.add_argument('--cache', default=os.path.join(os.path.expanduser('~'), '.pitchscape', 'cache'))
    a = ap.parse_args()
    device = a.device
    if device == 'auto':
        import torch
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    jobs = Jobs(a.cache, device, a.whisper)
    print('Pitchscape %s on %s, results kept in %s' % (PIPELINE_VERSION, device.upper(), a.cache))
    print('open http://%s:%d' % ('localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host, a.port), flush=True)
    ThreadingHTTPServer((a.host, a.port), handler(jobs)).serve_forever()


if __name__ == '__main__':
    main()
