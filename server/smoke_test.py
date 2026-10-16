"""After a deploy: send a short generated clip through the live server and report what it found.

usage: PITCHSCAPE_PASSPHRASE=... python server/smoke_test.py https://<workspace>--pitchscape-api.modal.run
Uses only the standard library. The clip is synthetic (kick, snare, hats, bass and a sung-like tone), so it can live in
a public repo. Its result is cached like any song's, so only the first run after a pipeline change uses the GPU.
"""
import io, json, math, os, random, struct, sys, time, urllib.error, urllib.request, wave

SR, DUR = 22050, 12.0


def clip():
    n, rnd = int(SR * DUR), random.Random(7)
    x = [0.0] * n
    def add(t0, f):
        s0 = int(t0 * SR)
        for i, v in enumerate(f):
            if s0 + i < n:
                x[s0 + i] += v
    for b in range(int(DUR / 0.5)):
        t = b * 0.5
        if b % 2 == 0:   # kick: falling sine
            ph, out = 0.0, []
            for i in range(int(0.3 * SR)):
                tt = i / SR; ph += 2 * math.pi * (50 + 100 * math.exp(-tt * 30)) / SR; out.append(0.9 * math.sin(ph) * math.exp(-tt * 9))
            add(t, out)
        else:            # snare: noise burst with a body
            add(t, [(rnd.uniform(-1, 1) * 0.5 + 0.3 * math.sin(2 * math.pi * 190 * i / SR)) * math.exp(-i / SR * 20) for i in range(int(0.2 * SR))])
        prev, out = 0.0, []
        for i in range(int(0.06 * SR)):   # hat: high-passed noise
            v = rnd.uniform(-1, 1); out.append((v - prev) * 0.25 * math.exp(-i / SR * 60)); prev = v
        add(t + 0.25, out)
    for k, m in enumerate([45, 45, 48, 43] * 6):                      # bass line
        f = 440 * 2 ** ((m - 69) / 12)
        add(k * 0.5, [0.35 * math.sin(2 * math.pi * f * i / SR) * min(1, i / 200) for i in range(int(0.45 * SR))])
    for k, m in enumerate([69, 72, 71, 67, 64, 67]):                  # a sung-like line with vibrato
        f = 440 * 2 ** ((m - 69) / 12); ph, out = 0.0, []
        for i in range(int(1.6 * SR)):
            tt = i / SR; ph += 2 * math.pi * f * 2 ** (0.3 * math.sin(2 * math.pi * 5.5 * tt) / 12) / SR
            out.append(0.2 * sum(math.sin(h * ph) / h for h in (1, 2, 3, 4)) * min(1, tt / 0.05) * min(1, (1.6 - tt) / 0.1))
        add(0.3 + k * 1.8, out)
    peak = max(abs(v) for v in x) or 1
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b''.join(struct.pack('<h', int(32000 * v / peak)) for v in x))
    return buf.getvalue()


def call(url, key, data=None, ctype=None):
    req = urllib.request.Request(url, data=data, headers={'X-Pitchscape-Key': key, **({'Content-Type': ctype} if ctype else {})})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def main():
    api, key = sys.argv[1].rstrip('/'), os.environ['PITCHSCAPE_PASSPHRASE']
    want = sys.argv[2] if len(sys.argv) > 2 else None
    # after a deploy the old server keeps answering for a few minutes: wait for the new one, or this tests the old
    t0 = time.time()
    while True:
        says = json.loads(urllib.request.urlopen(api + '/', timeout=120).read())
        if want is None or str(says.get('version')) == want:
            break
        if time.time() - t0 > 900:
            sys.exit('the server still says version %s, not %s' % (says.get('version'), want))
        time.sleep(15)
    print('server says:', says)
    audio, bnd = clip(), 'pitchscape-smoke'
    body = (f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="smoke-test.wav"\r\n'
            f'Content-Type: audio/wav\r\n\r\n').encode() + audio + f'\r\n--{bnd}--\r\n'.encode()
    t0 = time.time()
    j = call(api + '/analyze', key, body, f'multipart/form-data; boundary={bnd}')
    job, jkey = j.get('job'), j.get('key')
    while j.get('status') not in ('done', 'failed'):
        if time.time() - t0 > 900:
            sys.exit('timed out waiting for the analysis')
        print('  %4.0fs %s' % (time.time() - t0, j.get('stage') or j.get('status')))
        time.sleep(10)
        j = call(f'{api}/jobs/{job}?key={jkey}', key)
    if j['status'] == 'failed':
        sys.exit('analysis failed: ' + j.get('error', '?'))
    pk = j['pack']
    print('done in %.0f s; pack stats: %s' % (time.time() - t0, json.dumps(pk.get('stats'))))
    hits = (pk.get('stats') or {}).get('hits', {})
    if not hits.get('kick') or not pk['frames']:
        sys.exit('the result looks empty')


if __name__ == '__main__':
    main()
