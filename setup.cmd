@echo off
REM Creates the local environment (.venv: portable Node + packages + local database). Safe to re-run.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup failed - see the messages above.
  pause
  exit /b 1
)
echo.
pause
