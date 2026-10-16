"""Pitchscape analysis server on Modal (https://modal.com).

  POST /analyze        multipart form field `file` (the song); header `X-Pitchscape-Key: <passphrase>`
                       -> {"status": "done", "pack": {...}}                 the same audio was analysed before
                       -> {"status": "queued", "job": "<id>", "key": "<k>"}  analysis started
  GET  /jobs/{job}?key=<k>   (same header)
                       -> {"status": "running", "stage": "..."} | {"status": "done", "pack": {...}}
                          | {"status": "failed", "error": "..."}
  GET  /packs/{sha256}  (same header) -> {"status": "done", "pack": {...}} or 404
                       lets the page ask for a song it has fingerprinted before uploading anything

Results are kept for good in a Modal Volume, one JSON file per song, named by the audio's SHA-256 (and the pipeline
version), so a song is only ever analysed once. Audio is not kept.
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

PIPELINE_VERSION = '3'          # bump when the analysis changes, so old cached results are not served
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
web_image = modal.Image.debian_slim(python_version='3.11').pip_install('fastapi[standard]', 'python-multipart')


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
    cache.commit()
    return pack


@app.function(image=web_image, secrets=[modal.Secret.from_name('pitchscape', required_keys=['PITCHSCAPE_PASSPHRASE'])],
              volumes={CACHE: cache})
@modal.asgi_app()
@modal.concurrent(max_inputs=20)
def api():
    from fastapi import FastAPI, File, Header, HTTPException, UploadFile
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

    @web.post('/analyze')
    async def submit(file: UploadFile = File(...), x_pitchscape_key: str = Header('')):
        check(x_pitchscape_key)
        data = await file.read()
        if len(data) > 80_000_000:
            raise HTTPException(413, 'That file is over 80 MB.')
        key = PIPELINE_VERSION + ':' + hashlib.sha256(data).hexdigest()
        cached = await read_pack(key)
        if cached is not None:
            return {'status': 'done', 'pack': cached}
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
                return {'status': 'queued', 'job': job, 'key': key}
            except Exception:                       # it failed or its output expired: start afresh
                pass
            else:
                return {'status': 'done', 'pack': pack}
        call = await analyze.spawn.aio(data, key, file.filename or 'song.mp3')
        await progress.put.aio(key, None)
        await running.put.aio(key, {'job': call.object_id, 't': time.time()})
        return {'status': 'queued', 'job': call.object_id, 'key': key}

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

    return web
