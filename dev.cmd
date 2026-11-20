@echo off
REM Starts local PostgreSQL + API (:8080) + web UI (:5173). Ctrl+C stops everything.
setlocal
cd /d "%~dp0"
if exist ".venv\node\node.exe" set "PATH=%~dp0.venv\node;%PATH%"
if not exist "node_modules" (
  echo Packages are not installed yet. Run setup.cmd first.
  pause
  exit /b 1
)
REM Open the browser once the web UI answers (it starts after the API is ready).
start "" /b cmd /c "node tools\wait-url.mjs http://127.0.0.1:5173 240 >nul & start http://localhost:5173"
call npm.cmd run dev
