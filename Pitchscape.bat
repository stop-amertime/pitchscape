@echo off
rem Pitchscape on this computer: double-click to start, close the window to stop.
rem The first run sets everything up in .venv (a few GB of downloads); after that it starts in seconds.
rem Anything after the file name is passed on, e.g.  Pitchscape.bat --device cpu --update-library
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Pitchscape

rem ---- Python 3.11 and ffmpeg
set "PY="
where py >nul 2>nul && py -3.11 -c "import sys" >nul 2>nul && set "PY=py -3.11"
if not defined PY (
  where python >nul 2>nul && python -c "import sys; sys.exit(sys.version_info[:2] != (3, 11))" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Pitchscape needs Python 3.11. Install it with:   winget install Python.Python.3.11
  echo or from https://www.python.org/downloads/ , then double-click this file again.
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo Pitchscape needs ffmpeg. Install it with:   winget install Gyan.FFmpeg
  echo then close this window and double-click this file again.
  pause
  exit /b 1
)

rem ---- its own Python environment, set up once and again whenever server\requirements.txt changes
if not exist ".venv\Scripts\python.exe" (
  echo Making Pitchscape's Python environment in .venv
  %PY% -m venv .venv
  if errorlevel 1 goto failed
)
set "VPY=.venv\Scripts\python.exe"
fc /b server\requirements.txt .venv\pitchscape-requirements.txt >nul 2>nul
if errorlevel 1 (
  echo Installing what Pitchscape needs. The first time downloads a few GB, so it takes a while.
  "%VPY%" -m pip install --upgrade pip
  rem the GPU build of PyTorch when there is an NVIDIA card, the CPU build otherwise
  where nvidia-smi >nul 2>nul
  if errorlevel 1 (set "TORCH=https://download.pytorch.org/whl/cpu") else (set "TORCH=https://download.pytorch.org/whl/cu128")
  "%VPY%" -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url !TORCH!
  if errorlevel 1 goto failed
  "%VPY%" -m pip install -r server\requirements.txt
  if errorlevel 1 goto failed
  rem Basic Pitch pulls in TensorFlow, which Pitchscape does not use and which clashes with NumPy 2
  "%VPY%" -m pip uninstall -y tensorflow tensorflow-cpu tensorflow-intel >nul 2>nul
  rem an uninstall can leave an empty tensorflow folder, which Basic Pitch takes for TensorFlow and fails on
  if exist ".venv\Lib\site-packages\tensorflow" rmdir /s /q ".venv\Lib\site-packages\tensorflow"
  copy /y server\requirements.txt .venv\pitchscape-requirements.txt >nul
)

rem ---- start; the lyrics timer (faster-whisper) finds CUDA's libraries in the ones PyTorch brought
set "PATH=%CD%\.venv\Lib\site-packages\torch\lib;%PATH%"
echo Starting Pitchscape. It opens in your browser; close this window to stop it.
"%VPY%" -m server.local --open %*
pause
exit /b 0

:failed
echo.
echo Setting up failed (the reason is above). Fix that, then double-click this file again.
pause
exit /b 1
