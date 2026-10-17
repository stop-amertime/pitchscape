@echo off
rem Pitchscape on this computer: double-click to start, close the window to stop.
rem The first run installs the analysis (npm install) and fetches its models (about 600 MB, once).
rem Anything after the file name is passed on, e.g.  Pitchscape.bat --ep cpu --update-library
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title Pitchscape

rem ---- Python 3 (the small server), Node (the analysis) and ffmpeg (reading audio)
set "PY="
where py >nul 2>nul && py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && python -c "import sys; sys.exit(sys.version_info[0] != 3)" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Pitchscape needs Python 3. Install it with:   winget install Python.Python.3.13
  echo then close this window and double-click this file again.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Pitchscape needs Node. Install it with:   winget install OpenJS.NodeJS.LTS
  echo then close this window and double-click this file again.
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

rem ---- the analysis's packages, installed once and again whenever package-lock.json changes
fc /b package-lock.json node_modules\.pitchscape-lock.json >nul 2>nul
if errorlevel 1 (
  echo Installing what Pitchscape needs.
  call npm ci
  if errorlevel 1 goto failed
  copy /y package-lock.json node_modules\.pitchscape-lock.json >nul
)

echo Starting Pitchscape. It opens in your browser; close this window to stop it.
%PY% -m server.local --open %*
pause
exit /b 0

:failed
echo Something went wrong installing Pitchscape; the messages above say what.
pause
exit /b 1
