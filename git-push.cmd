@echo off
setlocal EnableExtensions
rem ===========================================================================
rem  git-push.cmd - upload the current application files to GitHub
rem    Repository: https://github.com/FEMSDevelopers/fems-engineering-development
rem  Commits every change (new, changed and deleted files) and pushes it.
rem  Excluded by .gitignore: _backup_before_* folders, node_modules, .venv, dist,
rem  .env, logs. Run git-setup.cmd once first.
rem  Optional: git-push.cmd "message"   (otherwise you are asked; Enter = date/time)
rem ===========================================================================
cd /d "%~dp0"
set "REPO=https://github.com/FEMSDevelopers/fems-engineering-development.git"

where git >nul 2>nul || (
  echo Git is not installed or not on PATH. Install it from https://git-scm.com/download/win and run this again.
  goto :fail
)
if not exist ".git" (
  echo This folder is not connected to GitHub yet - run git-setup.cmd first.
  goto :fail
)

git branch -M main || goto :fail
git remote get-url origin >nul 2>nul && (
  git remote set-url origin "%REPO%"
) || (
  git remote add origin "%REPO%" || goto :fail
)

rem Backup folders never go to GitHub (also removed from the index if added before)
git rm -r -q --cached --ignore-unmatch "_backup_before_*" "_fpl_src_snapshot.tgz" >nul 2>nul

git add -A || goto :fail
git diff --cached --quiet && (
  echo No changes to commit.
  goto :push
)

echo Changes to upload:
git status --short
echo.
set "MSG=%~1"
if "%MSG%"=="" set /p "MSG=Commit message (Enter = Update yyyy-mm-dd hh:mm): "
if "%MSG%"=="" for /f "tokens=1,*" %%a in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm\""') do set "MSG=Update %%a %%b"
git commit -m "%MSG%" || goto :fail

:push
echo Uploading to GitHub...
git push -u origin main && goto :ok

rem Push refused: GitHub has newer commits (pushed from another computer) - take them first
echo.
echo GitHub has newer changes - getting them first, then uploading again...
git pull --no-edit --rebase origin main || goto :conflict
git push -u origin main || goto :fail

:ok
echo.
echo Done: https://github.com/FEMSDevelopers/fems-engineering-development
pause
exit /b 0

:conflict
echo.
echo Getting the changes from GitHub stopped on conflicting files. Resolve them
echo (git status lists them; then git rebase --continue), or undo with: git rebase --abort
pause
exit /b 1

:fail
echo.
echo Stopped - see the message above.
pause
exit /b 1
