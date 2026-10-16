"""Serve the built page (docs/) with a stand-in for the analysis server, for previewing local analyses.

A song loaded in the page is "analysed" by returning testsongs/packs/<file name without extension>.json (made by
tools/analyse_test_songs.py). Usage: python tools/preview_server.py [port]   (default 8010; key: "test")
"""
import json, os, re, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PACKS = os.path.join(ROOT, 'testsongs', 'packs')
# the server's version, read from its source (importing it needs Modal installed)
PIPELINE_VERSION = re.search(r"^PIPELINE_VERSION = '([^']+)'", open(os.path.join(ROOT, 'server', 'modal_app.py')).read(), re.M).group(1)

JOBS = {}


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=os.path.join(ROOT, 'docs'), **k)

    def reply(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        m = re.search(rb'filename="([^"]+)"', body)
        name = os.path.splitext(m.group(1).decode('utf-8', 'replace'))[0] if m else ''
        path = os.path.join(PACKS, name + '.json')
        if not os.path.exists(path):
            return self.reply({'detail': 'no local analysis for ' + name}, 404)
        JOBS[name] = path
        self.reply({'status': 'queued', 'job': name, 'key': PIPELINE_VERSION + ':local'})

    def do_GET(self):
        if self.path.startswith('/config.json'):
            host = self.headers.get('Host', 'localhost')
            return self.reply({'api': 'http://' + host, 'pipeline': PIPELINE_VERSION})
        if self.path.startswith('/packs/'):
            return self.reply({'detail': 'Not analysed yet.'}, 404)
        if self.path.startswith('/jobs/'):
            name = self.path.split('/')[2].split('?')[0]
            name = __import__('urllib.parse').parse.unquote(name)
            return self.reply({'status': 'done', 'pack': json.load(open(JOBS[name]))} if name in JOBS else {'status': 'failed', 'error': 'unknown job'})
        if self.path == '/':
            self.path = '/index.html'
        return super().do_GET()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8010
    print('preview on http://localhost:%d (server key: test)' % port)
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
