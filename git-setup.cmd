@echo off
setlocal EnableExtensions
rem ===========================================================================
rem  git-setup.cmd - one time: connect this folder to GitHub and upload the app
rem    Repository: https://github.com/FEMSDevelopers/fems-engineering-development
rem  Safe to run again (skips what is already done). Excluded from GitHub by
rem  .gitignore: _backup_before_* folders, node_modules, .venv (portable Node +
rem  local database), dist, .env (local settings and passwords), logs.
rem  Sign-in: Git Credential Manager opens a GitHub sign-in window the first time.
rem ===========================================================================
cd /d "%~dp0"
set "REPO=https://github.com/FEMSDevelopers/fems-engineering-development.git"

where git >nul 2>nul || (
  echo Git is not installed or not on PATH. Install it from https://git-scm.com/download/win and run this again.
  goto :fail
)

if not exist ".git" (
  echo Creating the local repository...
  git init || goto :fail
)

rem Your name / e-mail for commits (asked once if git does not know them yet)
git config user.name >nul 2>nul || (
  set /p "GNAME=Your name for commits: "
  call git config user.name "%%GNAME%%"
)
git config user.email >nul 2>nul || (
  set /p "GMAIL=Your e-mail for commits: "
  call git config user.email "%%GMAIL%%"
)

git branch -M main || goto :fail

rem Remote "origin": added, or pointed at the repository if it exists already
git remote get-url origin >nul 2>nul && (
  git remote set-url origin "%REPO%"
) || (
  git remote add origin "%REPO%" || goto :fail
)

rem Backup folders never go to GitHub (also removed from the index if added before)
git rm -r -q --cached --ignore-unmatch "_backup_before_*" "_fpl_src_snapshot.tgz" >nul 2>nul

echo Adding the application files...
git add -A || goto :fail
git diff --cached --quiet && (
  echo Nothing new to commit.
) || (
  git commit -m "FEMS engineering workbench (fractal-pointlist): application files" || goto :fail
)

echo Uploading to GitHub...
git push -u origin main && goto :ok

rem Push refused: GitHub has commits this folder does not have (e.g. a README made on GitHub)
echo.
echo GitHub has changes that are not in this folder - merging them in, then uploading again...
git pull --no-edit --allow-unrelated-histories origin main || goto :conflict
git push -u origin main || goto :fail

:ok
echo.
echo Done: https://github.com/FEMSDevelopers/fems-engineering-development
pause
exit /b 0

:conflict
echo.
echo The merge with GitHub stopped on conflicting files. Resolve them (git status lists them),
echo then run git-push.cmd.
pause
exit /b 1

:fail
echo.
echo Stopped - see the message above.
pause
exit /b 1
