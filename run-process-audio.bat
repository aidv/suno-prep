@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "CONCURRENCY=%~1"

if "%CONCURRENCY%"=="" (
  set "CONCURRENCY=2"
)

set "FFMPEG_CONCURRENCY=%CONCURRENCY%"

echo Running process-audio.js with FFMPEG_CONCURRENCY=%FFMPEG_CONCURRENCY%
node "%SCRIPT_DIR%process-audio.js"

set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%