@echo off
setlocal EnableExtensions
rem ===========================================================================
rem  git-setup.cmd - one time: connect this folder to GitHub and upload the app (safe to run again)
rem    Repository: https://github.com/FEMSDevelopers/fems-engineering-development
rem  Excluded from GitHub by .gitignore: _backup_before_* folders, node_modules,
rem  .venv (portable Node + local database), dist, .env (local settings and
rem  passwords), .vscode, Claude outputs, logs.
rem  Sign-in: Git Credential Manager opens a GitHub sign-in window the first time.
rem ===========================================================================
if /i not "%~1"=="--from-temp" (
  copy /y "%~f0" "%TEMP%\fems-git-setup.cmd" >nul
  "%TEMP%\fems-git-setup.cmd" --from-temp "%~dp0" %*
)
rem (running from the copy in %TEMP%: git may rewrite the script in the folder while it runs)
cd /d "%~2"
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
  call git config --global user.name "%%GNAME%%"
)
git config user.email >nul 2>nul || (
  set /p "GMAIL=Your e-mail for commits: "
  call git config --global user.email "%%GMAIL%%"
)

rem An earlier run left unfinished (window closed, crash, OneDrive lock): clean it up first
if exist ".git\index.lock" (
  echo Removing a leftover git lock file...
  del /f /q ".git\index.lock"
)
if exist ".git\rebase-merge" (
  echo An earlier update was left unfinished - cancelling it and restoring the files of your last commit...
  git rebase --abort
  git reset -q --hard HEAD
)
if exist ".git\rebase-apply" (
  git rebase --abort
  git reset -q --hard HEAD
)
if exist ".git\MERGE_HEAD" (
  echo An earlier merge was left unfinished - cancelling it, your files are kept...
  git merge --abort
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

:push
echo Uploading to GitHub...
git push -u origin main && goto :ok

rem Push refused: GitHub has commits this folder does not have (pushed from another
rem computer, or a file edited on github.com) - merge them in, then upload again.
echo.
echo GitHub has changes that are not in this folder - merging them in...
git -c pull.rebase=false pull --no-edit --allow-unrelated-histories origin main && goto :pushagain
git diff --name-only --diff-filter=U | findstr . >nul || goto :fail
echo.
echo These files were changed both here and on GitHub:
git diff --name-only --diff-filter=U
echo.
choice /c YN /m "Keep THIS folder's version of these files (Y), or stop and resolve them yourself (N)"
if errorlevel 2 goto :conflict
for /f "delims=" %%f in ('git diff --name-only --diff-filter^=U') do (
  git checkout --ours -- "%%f"
  git add -- "%%f"
)
git commit --no-edit || goto :fail

:pushagain
echo Uploading to GitHub...
git push -u origin main || goto :fail

:ok
echo.
echo Done: https://github.com/FEMSDevelopers/fems-engineering-development
pause
exit /b 0

:conflict
echo.
echo The merge is open: fix the files listed by "git status", then run
echo   git add -A ^& git commit --no-edit ^& git-push.cmd
echo or cancel it with: git merge --abort
pause
exit /b 1

:fail
echo.
echo Stopped - see the message above.
pause
exit /b 1
