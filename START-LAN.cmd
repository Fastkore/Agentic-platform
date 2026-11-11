@echo off
setlocal
cd /d "%~dp0"
echo Codex Chat Bridge Web - LAN
echo Browser: http://127.0.0.1:8787
echo Stop: Ctrl+C. Keep this window open while using the server.
if exist "runtime\node.exe" (
  "runtime\node.exe" "dist\server\index.js" --lan
) else (
  node "dist\server\index.js" --lan
)
pause
