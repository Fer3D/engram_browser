@echo off
REM Engram Browser launcher - starts the local server, then opens the browser.
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required but was not found on PATH.
  pause
  exit /b 1
)

REM Optional: point at a different Engram, or use another port.
REM set ENGRAM_URL=http://127.0.0.1:7437
REM set ENGRAM_BROWSER_PORT=7474

REM The URL must follow the port the server will actually use, so resolve it once here.
REM "if not defined" is not enough: an empty value still counts as defined, and server.mjs
REM would then fall back to 7473 while this file opened a broken URL. Match Node's "|| 7473".
if "%ENGRAM_BROWSER_PORT%"=="" set ENGRAM_BROWSER_PORT=7473

start "" "http://127.0.0.1:%ENGRAM_BROWSER_PORT%"
node server.mjs

pause
