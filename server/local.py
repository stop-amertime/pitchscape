"""Pitchscape on your own computer: the page and the analysis server in one, with no Modal and no passphrase.

    python -m server.local                 then open http://localhost:8000
    python -m server.local --port 8123 --device cpu --whisper small --cache D:/pitchscape-cache

It answers the same routes as the Modal server (server/modal_app.py) and runs server/pipeline.py on this machine (on
a CUDA GPU if PyTorch sees one, otherwise on the CPU), one song at a time.

Every song it is sent is kept in a library (default ~/.pitchscape/library), one folder per song named by the SHA-256 of
its file: the audio as it came (audio.mp3 etc.), its cover art if the file has one (cover.jpg), what identifies it
(song.json: title, artist, album, ISRC, MusicBrainz ids, length, every tag; see song_info in pipeline.py) and its
analysis for each pipeline version (pack-v5.json etc.). So a song is analysed once per version, and with
--update-library every song in the library is brought up to the current version without being sent again.

  POST /analyze                   a `file`, or a `url` to an audio file, which this server downloads (server/fetch.py)
  GET /library                    every song kept: its sha256, song.json and which versions are analysed
  GET /library/<sha256>/audio     the song's audio;  /library/<sha256>/cover  its cover art

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
    """The library, and one song analysed at a time in a worker thread; each job's latest stage is kept for the page."""

    def __init__(self, library, device, whisper):
        self.lib, self.device, self.whisper = library, device, whisper
        self.q, self.state, self.lock = queue.Queue(), {}, threading.Lock()
        os.makedirs(self.lib, exist_ok=True)
        threading.Thread(target=self.work, daemon=True).start()

    def folder(self, sha):
        return os.path.join(self.lib, sha)

    def audio(self, sha):
        d = self.folder(sha)
        return next((os.path.join(d, f) for f in sorted(os.listdir(d)) if f.startswith('audio.')), None) if os.path.isdir(d) else None

    def pack_path(self, key):
        version, sha = key.split(':', 1)
        return os.path.join(self.folder(sha), 'pack-v%s.json' % version)

    def cached(self, key):
        p = self.pack_path(key)
        if os.path.exists(p):
            with open(p, encoding='utf-8') as fh:
                return json.load(fh)
        return None

    def keep(self, data, name):
        """The song into the library (once): its audio as it came, its cover art, and what identifies it."""
        from server.pipeline import song_info
        sha = hashlib.sha256(data).hexdigest()
        d = self.folder(sha)
        if self.audio(sha) is None:
            os.makedirs(d, exist_ok=True)
            ext = (os.path.splitext(name)[1] or '.mp3').lower()
            f = os.path.join(d, 'audio' + ext)
            with open(f + '.part', 'wb') as fh:
                fh.write(data)
            os.replace(f + '.part', f)
            info = song_info(f, name, sha)
            if info['file']['cover']:
                import subprocess
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f, '-an', '-frames:v', '1', os.path.join(d, 'cover.jpg')],
                               capture_output=True)
            self.write(os.path.join(d, 'song.json'), info)
        return sha

    def write(self, path, obj):
        with open(path + '.part', 'w', encoding='utf-8') as fh:
            json.dump(obj, fh, ensure_ascii=False)
        os.replace(path + '.part', path)

    def submit(self, sha):
        key = PIPELINE_VERSION + ':' + sha
        with self.lock:
            st = self.state.get(key)
            if st and st['status'] in ('queued', 'running'):
                return key
            self.state[key] = {'status': 'queued', 'stage': None}
        self.q.put(key)
        return key

    def update_library(self):
        n = 0
        for sha in sorted(os.listdir(self.lib)):
            if re.fullmatch(r'[0-9a-f]{64}', sha) and self.audio(sha) and self.cached(PIPELINE_VERSION + ':' + sha) is None:
                self.submit(sha)
                n += 1
        return n

    def listing(self):
        out = []
        for sha in sorted(os.listdir(self.lib)):
            d = self.folder(sha)
            if not re.fullmatch(r'[0-9a-f]{64}', sha) or not self.audio(sha):
                continue
            try:
                with open(os.path.join(d, 'song.json'), encoding='utf-8') as fh:
                    song = json.load(fh)
            except Exception:
                song = None
            versions = sorted(m.group(1) for m in (re.fullmatch(r'pack-v(.+)\.json', f) for f in os.listdir(d)) if m)
            out.append({'sha256': sha, 'song': song, 'versions': versions, 'cover': os.path.exists(os.path.join(d, 'cover.jpg'))})
        return out

    def work(self):
        from server.pipeline import analyze, log
        while True:
            key = self.q.get()
            sha = key.split(':', 1)[1]
            self.state[key] = {'status': 'running', 'stage': None}
            t0 = time.time()
            try:
                f = self.audio(sha)
                try:
                    with open(os.path.join(self.folder(sha), 'song.json'), encoding='utf-8') as fh:
                        name = json.load(fh)['file']['name']
                except Exception:
                    name = os.path.basename(f)

                def progress(*a):
                    msg = ' '.join(str(x) for x in a)
                    self.state[key]['stage'] = msg
                    log(msg)
                pack = analyze(f, device=self.device, whisper_size=self.whisper, title=os.path.splitext(name)[0],
                               name=name, progress=progress)
                self.write(self.pack_path(key), pack)
                self.write(os.path.join(self.folder(sha), 'song.json'), pack['song'])
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
            if path == '/library':
                return self.reply(jobs.listing())
            m = re.fullmatch(r'/library/([0-9a-f]{64})/(audio|cover)', path)
            if m:
                f = jobs.audio(m.group(1)) if m.group(2) == 'audio' else os.path.join(jobs.folder(m.group(1)), 'cover.jpg')
                if not f or not os.path.exists(f):
                    return self.reply({'detail': 'Not kept.'}, 404)
                import mimetypes
                with open(f, 'rb') as fh:
                    return self.send(fh.read(), mimetypes.guess_type(f)[0] or 'application/octet-stream')
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
            parts = {p.get_param('name', header='content-disposition'): p for p in msg.iter_parts()}
            if 'file' in parts:
                data, name = parts['file'].get_payload(decode=True), parts['file'].get_filename() or 'song.mp3'
            elif 'url' in parts:
                from server.fetch import Refused, fetch
                try:
                    data, name = fetch(parts['url'].get_content().strip())
                except Refused as e:
                    return self.reply({'detail': str(e)}, e.status)
            else:
                return self.reply({'detail': 'Send a file or a link.'}, 400)
            sha = jobs.keep(data, name)
            pack = jobs.cached(PIPELINE_VERSION + ':' + sha)
            if pack is not None:
                return self.reply({'status': 'done', 'pack': pack, 'sha256': sha})
            key = jobs.submit(sha)
            return self.reply({'status': 'queued', 'job': key.split(':', 1)[1][:16], 'key': key, 'sha256': sha})

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
    ap.add_argument('--library', default=os.path.join(os.path.expanduser('~'), '.pitchscape', 'library'))
    ap.add_argument('--update-library', action='store_true', help='analyse every kept song not yet analysed by this version')
    ap.add_argument('--open', action='store_true', help='open the page in the browser once the server is up')
    a = ap.parse_args()
    device = a.device
    if device == 'auto':
        import torch
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        if device == 'cuda':
            # a PyTorch build has kernels only for the GPU generations it was compiled for (2.5.1 stops at sm_90, so
            # an RTX 50-series card, sm_120, crashes on its first operation): use the CPU rather than fail every song
            cap = 'sm_%d%d' % torch.cuda.get_device_capability()
            if cap not in torch.cuda.get_arch_list():
                print('This PyTorch (%s) has no kernels for %s (%s); analysing on the CPU instead.'
                      % (torch.__version__, torch.cuda.get_device_name(), cap))
                device = 'cpu'
    jobs = Jobs(a.library, device, a.whisper)
    url = 'http://%s:%d' % ('localhost' if a.host in ('127.0.0.1', '0.0.0.0') else a.host, a.port)
    server = ThreadingHTTPServer((a.host, a.port), handler(jobs))
    print('Pitchscape %s on %s; songs kept in %s' % (PIPELINE_VERSION, device.upper(), a.library))
    if a.update_library:
        n = jobs.update_library()
        print('analysing %d kept song%s with version %s' % (n, '' if n == 1 else 's', PIPELINE_VERSION))
    print('open', url, flush=True)
    if a.open:
        import webbrowser
        threading.Timer(0.5, webbrowser.open, (url,)).start()
    server.serve_forever()


if __name__ == '__main__':
    main()
