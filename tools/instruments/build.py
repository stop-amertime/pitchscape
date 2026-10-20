# Ground-truth test songs for score.py, from open multitrack datasets downloaded into testsongs/multitrack/dl/ (all
# git-ignored; see notes/instrument-separation.md). Each song becomes testsongs/multitrack/<set>/<song>/ with mix.wav
# and truth.json: {mix, instruments: [{name, class, audio, notes [[t0, t1, midi]]}]}.
#   slakh     BabySlakh (Manilow et al. 2019, CC BY 4.0; the first 20 songs of Slakh2100, rendered from MIDI at 16 kHz):
#             every rendered track is an instrument, notes from its own MIDI file. Slakh's bass MIDI is often an octave
#             above the audio (YourMT3+ paper, 2407.04822): each bass track's notes are moved by whole octaves to
#             match pYIN on its own audio.
#   cantoria  Cantoria (Cuesta et al., CC BY 4.0): a vocal quartet, each singer recorded alone; notes from the
#             dataset's own pYIN f0 of each singer's track (its voicing decision), cut where the rounded pitch changes.
#   musdb     MUSDB18-HQ test set (Rafii et al., educational use; 50 real recordings, stereo): vocals, bass, drums,
#             other; vocals' and bass's notes from pYIN on their own tracks (the vocals track can hold backing voices,
#             which pYIN follows one at a time). Only the voice's and bass's leaks and notes mean much here (other is
#             many instruments).
#   slakhpan  slakh's songs mixed in stereo, as an engineer might pan them: bass and drums centred, two or more of
#             one class spread evenly from -0.7 to 0.7 (constant-power pan), the rest at random within +-0.6 (seed 0).
#             The best case for a stereo split (fixed pans, no reverb), to see what it could do at most.
#   duets     cantoria's singers two at a time: every pair of the four, the first 60 s of each song (84 duets), the
#             case two-singer separators (MedleyVox) are trained for.
#   <venv python> tools/instruments/build.py slakh|slakhpan|cantoria|duets|musdb
import glob, json, os, shutil, sys, tarfile, zipfile, warnings; warnings.filterwarnings('ignore')
import numpy as np, librosa, soundfile as sf

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'testsongs', 'multitrack'); DL = os.path.join(ROOT, 'dl')


def runs_to_notes(t, hz):
    """A monophonic track's notes from its f0 (NaN where unvoiced): rounded to semitones, a note per run of one pitch,
    40 ms or more."""
    dt = float(np.median(np.diff(t))); out, cur = [], None
    for i, h in enumerate(hz):
        m = int(round(librosa.hz_to_midi(h))) if h == h else None
        if cur and m != cur[2]: out.append([cur[0], t[i], cur[2]]); cur = None
        if m is not None and cur is None: cur = [t[i], None, m]
    if cur: out.append([cur[0], t[-1] + dt, cur[2]])
    return [[round(float(a), 3), round(float(b), 3), m] for a, b, m in out if b - a >= 0.04]


def notes_from_f0(y, sr, fmin, fmax):
    """runs_to_notes on pYIN's f0 and its own voicing decision."""
    f0, vf, _ = librosa.pyin(y, fmin=fmin, fmax=fmax, sr=sr, frame_length=2048, hop_length=256)
    return runs_to_notes(np.arange(len(f0)) * 256 / sr, np.where(vf, f0, np.nan))


def slakh():
    import yaml, pretty_midi
    src = os.path.join(DL, 'babyslakh_16k')
    if not os.path.isdir(src):
        with tarfile.open(os.path.join(DL, 'babyslakh_16k.tar.gz')) as t: t.extractall(DL)
    for tr in sorted(glob.glob(os.path.join(src, 'Track*'))):
        meta = yaml.safe_load(open(os.path.join(tr, 'metadata.yaml')))
        out = os.path.join(ROOT, 'slakh', os.path.basename(tr)); os.makedirs(out, exist_ok=True)
        shutil.copy(os.path.join(tr, 'mix.wav'), os.path.join(out, 'mix.wav'))
        inst = []
        for sid, m in sorted(meta['stems'].items()):
            wav = os.path.join(tr, 'stems', sid + '.wav'); mid = os.path.join(tr, 'MIDI', sid + '.mid')
            if not os.path.exists(wav): continue          # (BabySlakh's metadata says audio_rendered: false throughout)
            dst = f'{sid}.wav'; shutil.copy(wav, os.path.join(out, dst))
            notes = []
            if not m.get('is_drum') and os.path.exists(mid):
                pm = pretty_midi.PrettyMIDI(mid)
                notes = [[round(n.start, 3), round(n.end, 3), n.pitch] for i in pm.instruments for n in i.notes]
                if m['inst_class'] == 'Bass' and notes:
                    y, sr = librosa.load(wav, sr=None)
                    f0, vf, _ = librosa.pyin(y, fmin=30, fmax=400, sr=sr, hop_length=512)
                    heard = np.nanmedian(librosa.hz_to_midi(f0[vf])) if vf.any() else None
                    if heard is not None:
                        shift = 12 * round((heard - np.median([n[2] for n in notes])) / 12)
                        notes = [[a, b, p + shift] for a, b, p in notes]
            inst.append({'name': f"{sid} {m.get('midi_program_name', m['inst_class'])}", 'class': 'drums' if m.get('is_drum') else m['inst_class'].lower(),
                         'audio': dst, 'notes': notes})
        json.dump({'mix': 'mix.wav', 'source': 'BabySlakh (CC BY 4.0)', 'instruments': inst}, open(os.path.join(out, 'truth.json'), 'w'))
        print(os.path.basename(tr), [i['name'] for i in inst], flush=True)


def cantoria():
    src = os.path.join(DL, 'CantoriaDataset_v1.0.0')
    if not os.path.isdir(src):
        with zipfile.ZipFile(os.path.join(DL, 'CantoriaDataset_v1.0.0.zip')) as z: z.extractall(src)   # (no top folder)
    audio = glob.glob(os.path.join(src, 'Audio', '*.wav'))
    songs = sorted({os.path.basename(a).split('_')[1] for a in audio})
    for s in songs:
        parts = sorted(a for a in audio if os.path.basename(a).split('_')[1] == s and os.path.basename(a).split('_')[2][0] in 'SATB')
        if len(parts) < 2: continue
        out = os.path.join(ROOT, 'cantoria', s); os.makedirs(out, exist_ok=True)
        ys, inst = [], []
        for a in parts:
            v = os.path.basename(a).split('_')[2][0]
            y, sr = librosa.load(a, sr=44100, mono=True); ys.append(y)
            sf.write(os.path.join(out, v + '.wav'), y, sr)
            f0 = np.loadtxt(os.path.join(src, 'F0_pyin', os.path.basename(a)[:-4] + '.csv'), delimiter=',')
            inst.append({'name': {'S': 'soprano', 'A': 'alto', 'T': 'tenor', 'B': 'bass'}[v], 'class': 'voice', 'audio': v + '.wav',
                         'notes': runs_to_notes(f0[:, 0], np.where(f0[:, 1] > 0, f0[:, 1], np.nan))})
        n = max(map(len, ys)); mix = sum(np.pad(y, (0, n - len(y))) for y in ys)
        sf.write(os.path.join(out, 'mix.wav'), mix / max(1, np.abs(mix).max() / 0.99), 44100)
        json.dump({'mix': 'mix.wav', 'source': 'Cantoria (CC BY 4.0)', 'instruments': inst}, open(os.path.join(out, 'truth.json'), 'w'))
        print(s, [i['name'] for i in inst], flush=True)


def slakhpan():
    rng = np.random.default_rng(0)
    for d in sorted(glob.glob(os.path.join(ROOT, 'slakh', 'Track*'))):
        T = json.load(open(os.path.join(d, 'truth.json')))
        out = os.path.join(ROOT, 'slakhpan', os.path.basename(d)); os.makedirs(out, exist_ok=True)
        byc = {}
        for i in T['instruments']: byc.setdefault(i['class'], []).append(i)
        mix = None
        for c, ins in byc.items():
            pans = [0.0] * len(ins) if c in ('bass', 'drums') and len(ins) == 1 else                    list(np.linspace(-0.7, 0.7, len(ins))) if len(ins) > 1 else [float(rng.uniform(-0.6, 0.6))]
            for i, p in zip(ins, pans):
                y, sr = sf.read(os.path.join(d, i['audio']), dtype='float32')
                a = (p + 1) * np.pi / 4; st = np.stack([np.cos(a) * y, np.sin(a) * y], 1)
                shutil.copy(os.path.join(d, i['audio']), os.path.join(out, i['audio'])); i['pan'] = round(float(p), 3)
                mix = st if mix is None else np.pad(mix, ((0, max(0, len(st) - len(mix))), (0, 0)))
                mix[:len(st)] += st
        sf.write(os.path.join(out, 'mix.wav'), mix / max(1, np.abs(mix).max() / 0.99), sr)
        T['source'] += ', panned (build.py slakhpan)'
        json.dump(T, open(os.path.join(out, 'truth.json'), 'w'))
        print(os.path.basename(d), [(i['name'], i['pan']) for i in T['instruments']], flush=True)


# MUSDB18-HQ's zip (Zenodo 3338373, 22.7 GB) keeps the test songs in its last 7.9 GB: only that is downloaded,
#   curl -r 14782844315- https://zenodo.org/api/records/3338373/files/musdb18hq.zip/content > dl/musdb18hq-test.part
# and its entries are read from there by the zip's own central directory (at the end of the file).
MUSDB_TEST_FROM = 14782844315


def extract_tail(part, start, out, prefix):
    import struct, zlib
    with open(part, 'rb') as f:
        f.seek(0, 2); n = f.tell(); f.seek(max(0, n - 4_000_000)); b = f.read(); base = start + max(0, n - 4_000_000)
        i = b.rfind(b'PK'); cd_size, cd_off = struct.unpack('<QQ', b[i + 40:i + 56])
        p = cd_off - base
        while b[p:p + 4] == b'PK':
            meth, = struct.unpack('<H', b[p + 10:p + 12]); csz, = struct.unpack('<I', b[p + 20:p + 24])
            usz, = struct.unpack('<I', b[p + 24:p + 28]); nl, el, cl = struct.unpack('<HHH', b[p + 28:p + 34])
            off, = struct.unpack('<I', b[p + 42:p + 46]); name = b[p + 46:p + 46 + nl].decode(); ex = b[p + 46 + nl:p + 46 + nl + el]
            q = 0
            while q < len(ex):
                hid, hl = struct.unpack('<HH', ex[q:q + 4]); v = ex[q + 4:q + 4 + hl]; k = 0
                if hid == 1:
                    if usz == 0xFFFFFFFF: usz, = struct.unpack('<Q', v[k:k + 8]); k += 8
                    if csz == 0xFFFFFFFF: csz, = struct.unpack('<Q', v[k:k + 8]); k += 8
                    if off == 0xFFFFFFFF: off, = struct.unpack('<Q', v[k:k + 8])
                q += 4 + hl
            p += 46 + nl + el + cl
            if not name.startswith(prefix) or name.endswith('/'): continue
            f.seek(off - start); h = f.read(30); lnl, lel = struct.unpack('<HH', h[26:30]); f.seek(off - start + 30 + lnl + lel)
            data = f.read(csz)
            if meth == 8: data = zlib.decompress(data, -15)
            assert len(data) == usz, name
            dst = os.path.join(out, *name.split('/')); os.makedirs(os.path.dirname(dst), exist_ok=True)
            open(dst, 'wb').write(data)


def duets(secs=60.0):
    from itertools import combinations
    for d in sorted(os.path.dirname(t) for t in glob.glob(os.path.join(ROOT, 'cantoria', '*', 'truth.json'))):
        T = json.load(open(os.path.join(d, 'truth.json')))
        for a, b in combinations(T['instruments'], 2):
            out = os.path.join(ROOT, 'duets', f"{os.path.basename(d)}_{a['name'][0]}{b['name'][0]}"); os.makedirs(out, exist_ok=True)
            ys = []
            for i in (a, b):
                y, sr = sf.read(os.path.join(d, i['audio']), dtype='float32'); y = y[:int(secs * sr)]
                sf.write(os.path.join(out, i['audio']), y, sr); ys.append(y)
            n = min(map(len, ys)); mix = ys[0][:n] + ys[1][:n]
            sf.write(os.path.join(out, 'mix.wav'), mix / max(1, np.abs(mix).max() / 0.99), sr)
            inst = [dict(i, notes=[[t0, min(t1, secs), m] for t0, t1, m in i['notes'] if t0 < secs]) for i in (a, b)]
            json.dump({'mix': 'mix.wav', 'source': T['source'] + ', two singers (build.py duets)', 'instruments': inst},
                      open(os.path.join(out, 'truth.json'), 'w'))
        print(os.path.basename(d), flush=True)


def musdb_song(args):
    d, out = args
    os.makedirs(out, exist_ok=True); inst = []
    for s in ['vocals', 'bass', 'drums', 'other']:
        shutil.copy(os.path.join(d, s + '.wav'), os.path.join(out, s + '.wav'))
        notes = []
        if s in ('vocals', 'bass'):
            y, _ = librosa.load(os.path.join(d, s + '.wav'), sr=22050, mono=True)
            notes = notes_from_f0(y, 22050, *((65, 1100) if s == 'vocals' else (30, 400)))
        inst.append({'name': s, 'class': 'voice' if s == 'vocals' else s, 'audio': s + '.wav', 'notes': notes})
    shutil.copy(os.path.join(d, 'mixture.wav'), os.path.join(out, 'mix.wav'))
    json.dump({'mix': 'mix.wav', 'source': 'MUSDB18-HQ test (educational use)', 'instruments': inst}, open(os.path.join(out, 'truth.json'), 'w'))
    return os.path.basename(d)


def musdb():
    from multiprocessing import Pool
    src = os.path.join(DL, 'musdb18hq')
    if not os.path.isdir(src): extract_tail(os.path.join(DL, 'musdb18hq-test.part'), MUSDB_TEST_FROM, src, 'test/')
    songs = sorted(glob.glob(os.path.join(src, 'test', '*')))
    jobs = [(d, os.path.join(ROOT, 'musdb', ''.join(c if c.isalnum() else '_' for c in os.path.basename(d))[:40])) for d in songs]
    with Pool(8) as p:
        for name in p.imap_unordered(musdb_song, jobs): print(name, flush=True)


if __name__ == '__main__':
    {'slakh': slakh, 'slakhpan': slakhpan, 'cantoria': cantoria, 'duets': duets, 'musdb': musdb}[sys.argv[1]]()
