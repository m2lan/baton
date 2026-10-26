@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [Baton] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 goto fail
)

start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:fail
echo.
echo [Baton] npm install failed. Check Node.js (^>=20^) and network.
pause
