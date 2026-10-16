"""Serve the repository for tools/browser_check.html, which runs src/pipeline in a browser on a test song.

  python tools/browser_check.py [port]      then open http://127.0.0.1:8765/tools/browser_check.html?song=NAME

Only on this machine (127.0.0.1). Each run's results are POSTed back and appended to testsongs/parity/browser.jsonl.
"""
import http.server, json, os, sys, time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript',
                      '.onnx': 'application/octet-stream'}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        os.makedirs(os.path.join(ROOT, 'testsongs', 'parity'), exist_ok=True)
        with open(os.path.join(ROOT, 'testsongs', 'parity', 'browser.jsonl'), 'a') as f:
            f.write(json.dumps({'t': time.strftime('%Y-%m-%d %H:%M:%S'), **body}) + '\n')
        print(json.dumps(body), flush=True)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print('http://127.0.0.1:%d/tools/browser_check.html' % port, flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
