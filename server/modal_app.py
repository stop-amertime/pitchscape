"""Pitchscape analysis server on Modal (https://modal.com).

  POST /analyze        multipart form field `file` (the song); header `X-Pitchscape-Key: <passphrase>`
                       -> {"status": "done", "pack": {...}}                 the same audio was analysed before
                       -> {"status": "queued", "job": "<id>", "key": "<k>"}  analysis started
  GET  /jobs/{job}?key=<k>   (same header)
                       -> {"status": "running", "stage": "..."} | {"status": "done", "pack": {...}}
                          | {"status": "failed", "error": "..."}

Results are cached by the audio's SHA-256, so a song is only ever analysed once. Audio is not kept.
Deployed by .github/workflows/deploy-server.yml on every push to main that touches server/.
"""
import hashlib
import os
import tempfile

import modal

PIPELINE_VERSION = '1'          # bump when the analysis changes, so old cached results are not served
ALLOWED_ORIGINS = ['https://stop-amertime.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000']
SITE = '/usr/local/lib/python3.11/site-packages'

app = modal.App('pitchscape')
results = modal.Dict.from_name('pitchscape-results', create_if_missing=True)
progress = modal.Dict.from_name('pitchscape-progress', create_if_missing=True)


def _download_models():
    from demucs.pretrained import get_model
    from faster_whisper import WhisperModel
    from huggingface_hub import hf_hub_download
    get_model('htdemucs')
    hf_hub_download('thebluescreen/adtof-drums-onnx', 'adtof_frame_rnn.onnx')
    WhisperModel('medium', device='cpu', compute_type='int8')


gpu_image = (
    modal.Image.debian_slim(python_version='3.11')
    .apt_install('ffmpeg')
    .pip_install('torch==2.5.1', 'torchaudio==2.5.1', 'demucs==4.1.0', 'basic-pitch[onnx]==0.4.0', 'onnxruntime==1.31.0',
                 'faster-whisper==1.2.1', 'ctranslate2==4.8.3', 'torchcrepe==0.0.24', 'librosa==0.11.0', 'soundfile==0.14.0',
                 'scipy==1.17.1', 'huggingface_hub==2.2.0', 'setuptools==79.0.1')
    # Basic Pitch pulls in TensorFlow on Linux; it runs on ONNX here, and TensorFlow clashes with NumPy 2
    .run_commands('pip uninstall -y tensorflow tensorflow-cpu tensorflow-io-gcs-filesystem || true')
    # faster-whisper on CUDA needs the cuDNN and cuBLAS that came with torch on the library path
    .env({'LD_LIBRARY_PATH': f'{SITE}/nvidia/cudnn/lib:{SITE}/nvidia/cublas/lib'})
    .run_function(_download_models)
    .add_local_python_source('server')
)
web_image = modal.Image.debian_slim(python_version='3.11').pip_install('fastapi[standard]', 'python-multipart')


@app.function(image=gpu_image, gpu='L4', timeout=1200, max_containers=2, scaledown_window=120)
def analyze(audio: bytes, key: str, name: str):
    from server.pipeline import analyze as run
    ext = os.path.splitext(name)[1] or '.mp3'
    with tempfile.NamedTemporaryFile(suffix=ext) as f:
        f.write(audio)
        f.flush()
        pack = run(f.name, device='cuda', title=os.path.splitext(name)[0],
                   progress=lambda *a: progress.put(key, ' '.join(str(x) for x in a)))
    results[key] = pack
    return key


@app.function(image=web_image, secrets=[modal.Secret.from_name('pitchscape', required_keys=['PITCHSCAPE_PASSPHRASE'])])
@modal.asgi_app()
@modal.concurrent(max_inputs=20)
def api():
    from fastapi import FastAPI, File, Header, HTTPException, UploadFile
    from fastapi.middleware.cors import CORSMiddleware

    web = FastAPI()
    web.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=['GET', 'POST'], allow_headers=['*'])

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
        cached = await results.get.aio(key)
        if cached is not None:
            return {'status': 'done', 'pack': cached}
        call = await analyze.spawn.aio(data, key, file.filename or 'song.mp3')
        return {'status': 'queued', 'job': call.object_id, 'key': key}

    @web.get('/jobs/{job}')
    async def poll(job: str, key: str, x_pitchscape_key: str = Header('')):
        check(x_pitchscape_key)
        try:
            await modal.FunctionCall.from_id(job).get.aio(timeout=0)
        except TimeoutError:
            return {'status': 'running', 'stage': await progress.get.aio(key)}
        except Exception as e:                      # the job raised, or its output expired
            return {'status': 'failed', 'error': str(e)[:300]}
        return {'status': 'done', 'pack': await results.get.aio(key)}

    return web
