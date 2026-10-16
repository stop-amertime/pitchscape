"""Pitchscape analysis server on Modal (https://modal.com).

  POST /analyze        multipart form field `file` (the song), or `url` (a link to an audio file, which the server
                       downloads: see server/fetch.py); header `X-Pitchscape-Key: <passphrase>`
                       -> {"status": "done", "pack": {...}, "sha256": "..."}       the same audio was analysed before
                       -> {"status": "queued", "job": "<id>", "key": "<k>", "sha256": "..."}  analysis started
                       A file by link and the same file uploaded have the same SHA-256, so the same analysis.
  GET  /jobs/{job}?key=<k>   (same header)
                       -> {"status": "running", "stage": "..."} | {"status": "done", "pack": {...}}
                          | {"status": "failed", "error": "..."}
  GET  /packs/{sha256}  (same header) -> {"status": "done", "pack": {...}} or 404
                       lets the page ask for a song it has fingerprinted before uploading anything
  GET  /library/{sha256}/audio  (same header) -> the song's audio as it was sent, for playing a song opened by link

Results are kept for good in a Modal Volume, one JSON file per song, named by the audio's SHA-256 (and the pipeline
version), so a song is only ever analysed once. Each song's audio and what identifies it (title, artist, ISRC...: see
song_info in pipeline.py) are kept too, in library/<sha256>/ as server/local.py keeps them, so a later pipeline version
can analyse it again without it being sent.
Deployed by .github/workflows/deploy-server.yml on every push to main that touches server/.
"""
import asyncio
import hashlib
import json
import os
import re
import tempfile
import time

import modal

PIPELINE_VERSION = '5'          # bump when the analysis changes, so old cached results are not served
ALLOWED_ORIGINS = ['https://stop-amertime.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000']
SITE = '/usr/local/lib/python3.11/site-packages'

app = modal.App('pitchscape')
cache = modal.Volume.from_name('pitchscape-cache', create_if_missing=True)      # durable; first TiB free
progress = modal.Dict.from_name('pitchscape-progress', create_if_missing=True)   # transient stage messages
running = modal.Dict.from_name('pitchscape-running', create_if_missing=True)     # song -> the job analysing it
CACHE = '/cache'


def pack_path(key):
    version, sha = key.split(':', 1)
    return f'{CACHE}/v{version}/{sha}.json'


def _download_models():
    from demucs.pretrained import get_model
    from faster_whisper import WhisperModel
    from huggingface_hub import hf_hub_download
    get_model('htdemucs_6s')
    hf_hub_download('thebluescreen/adtof-drums-onnx', 'adtof_frame_rnn.onnx')
    WhisperModel('medium', device='cpu', compute_type='int8')


gpu_image = (
    modal.Image.debian_slim(python_version='3.11')
    .apt_install('ffmpeg')
    .pip_install('torch==2.5.1', 'torchaudio==2.5.1', 'demucs==4.1.0', 'basic-pitch[onnx]==0.4.0', 'onnxruntime==1.31.0',
                 'faster-whisper==1.2.1', 'ctranslate2==4.8.3', 'torchcrepe==0.0.24', 'librosa==0.11.0', 'soundfile==0.14.0',
                 'scipy==1.17.1', 'huggingface_hub==2.2.0', 'setuptools==79.0.1',
                 'mosqito==1.2.1', 'matplotlib==3.11.2')
    # Basic Pitch pulls in TensorFlow on Linux; it runs on ONNX here, and TensorFlow clashes with NumPy 2
    .run_commands('pip uninstall -y tensorflow tensorflow-cpu tensorflow-io-gcs-filesystem || true')
    # faster-whisper on CUDA needs the cuDNN and cuBLAS that came with torch on the library path
    .env({'LD_LIBRARY_PATH': f'{SITE}/nvidia/cudnn/lib:{SITE}/nvidia/cublas/lib'})
    .run_function(_download_models)
    .add_local_python_source('server')
)
web_image = (modal.Image.debian_slim(python_version='3.11').pip_install('fastapi[standard]', 'python-multipart')
             .add_local_python_source('server'))


# no CPU or memory reservation: with one (8 cores, 16 GiB beside an L4) jobs sat unstarted. A container may use idle
# cores beyond its request anyway, and the tone measurements spread over up to eight of them.
@app.function(image=gpu_image, gpu='L4', timeout=1500, max_containers=2, scaledown_window=120, volumes={CACHE: cache})
def analyze(audio: bytes, key: str, name: str):
    from server.pipeline import analyze as run
    ext = os.path.splitext(name)[1] or '.mp3'
    with tempfile.NamedTemporaryFile(suffix=ext) as f:
        f.write(audio)
        f.flush()
        pack = run(f.name, device='cuda', title=os.path.splitext(name)[0], name=name,
                   progress=lambda *a: progress.put(key, ' '.join(str(x) for x in a)))
    path = pack_path(key)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as fh:
        json.dump(pack, fh)
    kept = f'{CACHE}/library/{key.split(":", 1)[1]}'
    os.makedirs(kept, exist_ok=True)
    if not any(f.startswith('audio.') for f in os.listdir(kept)):
        with open(f'{kept}/audio{ext.lower()}', 'wb') as fh:
            fh.write(audio)
    with open(f'{kept}/song.json', 'w') as fh:
        json.dump(pack.get('song'), fh, ensure_ascii=False)
    cache.commit()
    return pack


@app.function(image=web_image, secrets=[modal.Secret.from_name('pitchscape', required_keys=['PITCHSCAPE_PASSPHRASE'])],
              volumes={CACHE: cache})
@modal.asgi_app()
@modal.concurrent(max_inputs=20)
def api():
    from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
    from fastapi.responses import FileResponse
    from server.fetch import Refused, fetch
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.middleware.gzip import GZipMiddleware

    web = FastAPI()
    web.add_middleware(GZipMiddleware, minimum_size=2000)
    web.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=['GET', 'POST'], allow_headers=['*'])

    async def read_pack(key):
        path = pack_path(key)
        if not os.path.exists(path):
            for _ in range(3):                          # see results the GPU containers wrote since
                try:
                    await cache.reload.aio()
                    break
                except Exception:                       # refused while another request has a file open
                    await asyncio.sleep(0.2)
        if os.path.exists(path):
            with open(path) as fh:
                return json.load(fh)
        return None

    def check(passphrase):
        if not passphrase or passphrase != os.environ['PITCHSCAPE_PASSPHRASE']:
            raise HTTPException(401, 'Wrong passphrase.')

    @web.get('/')
    async def hello():
        return {'service': 'pitchscape', 'version': PIPELINE_VERSION}

    async def keep_audio(sha, data, name):
        """A song opened by link into the library now, so the page can play it from here at once."""
        kept = f'{CACHE}/library/{sha}'
        if os.path.isdir(kept) and any(f.startswith('audio.') for f in os.listdir(kept)):
            return
        os.makedirs(kept, exist_ok=True)
        with open(f'{kept}/audio{(os.path.splitext(name)[1] or ".mp3").lower()}', 'wb') as fh:
            fh.write(data)
        await cache.commit.aio()

    @web.post('/analyze')
    async def submit(file: UploadFile = File(None), url: str = Form(''), x_pitchscape_key: str = Header('')):
        check(x_pitchscape_key)
        if file is not None:
            data, name = await file.read(), file.filename or 'song.mp3'
            if len(data) > 80_000_000:
                raise HTTPException(413, 'That file is over 80 MB.')
        elif url:
            try:
                data, name = await asyncio.to_thread(fetch, url)
            except Refused as e:
                raise HTTPException(e.status, str(e))
        else:
            raise HTTPException(400, 'Send a file or a link.')
        sha = hashlib.sha256(data).hexdigest()
        key = PIPELINE_VERSION + ':' + sha
        if file is None:
            await keep_audio(sha, data, name)
        cached = await read_pack(key)
        if cached is not None:
            return {'status': 'done', 'pack': cached, 'sha256': sha}
        # the same song sent again while it is still being analysed (a reload, a second tab): follow that job, unless
        # it looks stuck (no stage reported after 8 minutes) or is older than any job can run
        entry = await running.get.aio(key)
        job = None
        if isinstance(entry, dict):
            age = time.time() - entry.get('t', 0)
            if age < 1800 and (age < 480 or await progress.get.aio(key)):
                job = entry.get('job')
        if job:
            try:
                pack = await modal.FunctionCall.from_id(job).get.aio(timeout=0)
            except TimeoutError:
                return {'status': 'queued', 'job': job, 'key': key, 'sha256': sha}
            except Exception:                       # it failed or its output expired: start afresh
                pass
            else:
                return {'status': 'done', 'pack': pack, 'sha256': sha}
        call = await analyze.spawn.aio(data, key, name)
        await progress.put.aio(key, None)
        await running.put.aio(key, {'job': call.object_id, 't': time.time()})
        return {'status': 'queued', 'job': call.object_id, 'key': key, 'sha256': sha}

    @web.get('/jobs/{job}')
    async def poll(job: str, key: str, x_pitchscape_key: str = Header('')):
        check(x_pitchscape_key)
        try:
            pack = await modal.FunctionCall.from_id(job).get.aio(timeout=0)
        except TimeoutError:
            return {'status': 'running', 'stage': await progress.get.aio(key)}
        except Exception as e:                      # the job raised, or its output expired
            return {'status': 'failed', 'error': str(e)[:300]}
        return {'status': 'done', 'pack': pack}

    @web.get('/packs/{sha}')
    async def lookup(sha: str, x_pitchscape_key: str = Header('')):
        check(x_pitchscape_key)
        if not re.fullmatch(r'[0-9a-f]{64}', sha):
            raise HTTPException(400, 'Not a SHA-256.')
        pack = await read_pack(PIPELINE_VERSION + ':' + sha)
        if not pack:
            raise HTTPException(404, 'Not analysed yet.')
        return {'status': 'done', 'pack': pack}

    @web.get('/library/{sha}/audio')
    async def song_audio(sha: str, x_pitchscape_key: str = Header('')):
        check(x_pitchscape_key)
        if not re.fullmatch(r'[0-9a-f]{64}', sha):
            raise HTTPException(400, 'Not a SHA-256.')
        kept = f'{CACHE}/library/{sha}'
        for attempt in range(2):
            found = sorted(f for f in os.listdir(kept) if f.startswith('audio.')) if os.path.isdir(kept) else []
            if found:
                return FileResponse(f'{kept}/{found[0]}', headers={'Cache-Control': 'private, max-age=86400'})
            if not attempt:
                try:
                    await cache.reload.aio()            # kept since by another container
                except Exception:
                    pass
        raise HTTPException(404, "The server hasn't kept this song's audio.")

    return web
