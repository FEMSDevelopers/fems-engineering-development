<#
.SYNOPSIS
  Creates this project's local environment in .venv (the Node equivalent of a Python virtual environment).

.DESCRIPTION
  1. Downloads a portable Node.js (version from .nvmrc) into .venv\node and verifies its SHA-256
     against nodejs.org's published checksums. Nothing is installed system-wide and no admin rights are needed.
  2. Installs the npm packages into .\node_modules (npm ci, from package-lock.json).
  3. Creates .env from .env.example if it doesn't exist.
  4. Creates the local PostgreSQL database in .venv\pgdata and checks that it starts.
  5. Copies the VS Code tasks/launch/settings from tools\vscode into .vscode (only files that don't exist yet).

  Re-running is safe: finished steps are skipped.

.PARAMETER UseSystemNode
  Use the Node.js already on PATH (v22 or newer) instead of downloading a portable copy.
.PARAMETER Force
  Re-download Node.js and reinstall npm packages.
.PARAMETER SkipVSCode
  Don't copy the VS Code configuration.

.EXAMPLE
  .\setup.cmd
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -UseSystemNode
#>
[CmdletBinding()]
param([switch]$UseSystemNode, [switch]$Force, [switch]$SkipVSCode)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow in Windows PowerShell 5.1 with the progress bar on

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Venv = Join-Path $Root '.venv'
$NodeDir = Join-Path $Venv 'node'
$NodeVersion = (Get-Content (Join-Path $Root '.nvmrc') -Raw).Trim().TrimStart('v')

function Step([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "    $m" -ForegroundColor Green }
function Note([string]$m) { Write-Host "    $m" -ForegroundColor Yellow }
function Run([string]$exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "'$exe $($argList -join ' ')' failed with exit code $LASTEXITCODE" }
}

Write-Host "Point List Workbench - local environment setup" -ForegroundColor White
Write-Host "Project: $Root"
if ($Root -match 'OneDrive') {
  Note "This folder is inside OneDrive. .venv and node_modules hold many files (~500 MB)."
  Note "If installs fail with EBUSY/EPERM errors, pause OneDrive syncing and re-run setup."
}
New-Item -ItemType Directory -Force -Path $Venv | Out-Null

# ---------------------------------------------------------------- Node.js
Step "Node.js"
if ($UseSystemNode) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "Node.js is not on PATH. Install Node 22+ or run setup without -UseSystemNode." }
  $v = (& node -v).Trim().TrimStart('v')
  if ([int]($v.Split('.')[0]) -lt 22) { throw "Node $v found; version 22 or newer is required." }
  Ok "Using system Node v$v ($($cmd.Source))"
} else {
  if ($env:OS -ne 'Windows_NT') { throw "The portable Node download is for Windows. On other systems install Node 22+ and use -UseSystemNode." }
  $exe = Join-Path $NodeDir 'node.exe'
  $have = if (Test-Path $exe) { (& $exe -v).Trim().TrimStart('v') } else { $null }
  if ($have -eq $NodeVersion -and -not $Force) {
    Ok "Portable Node v$have already in .venv\node"
  } else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "node-v$NodeVersion-win-$arch"
    $base = "https://nodejs.org/dist/v$NodeVersion"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $zip = Join-Path $Venv "$name.zip"
    Write-Host "    Downloading $base/$name.zip"
    Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing
    $sums = [string](Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
    $line = ($sums -split "`r?`n") | Where-Object { $_ -match ('\s' + [regex]::Escape("$name.zip") + '$') } | Select-Object -First 1
    if (-not $line) { Remove-Item $zip -Force; throw "No published checksum found for $name.zip" }
    $expected = ($line -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { Remove-Item $zip -Force; throw "Checksum mismatch for $name.zip (expected $expected, got $actual)" }
    Ok "SHA-256 verified against nodejs.org SHASUMS256.txt"
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Expand-Archive -Path $zip -DestinationPath $Venv -Force
    Rename-Item -Path (Join-Path $Venv $name) -NewName 'node'
    Remove-Item $zip -Force
    Ok "Portable Node v$NodeVersion installed in .venv\node"
  }
  $env:Path = "$NodeDir;$env:Path"
}
# npm.cmd (not npm.ps1) so this works under any PowerShell execution policy.
$OnWindows = $env:OS -eq 'Windows_NT'
$Npm = if (-not $OnWindows) { 'npm' } elseif ($UseSystemNode) { 'npm.cmd' } else { Join-Path $NodeDir 'npm.cmd' }
Ok "node $(& node -v) / npm $(& $Npm -v)"

# ---------------------------------------------------------------- npm packages
Step "npm packages (node_modules)"
$stamp = Join-Path $Venv '.npm-installed'
$lock = Join-Path $Root 'package-lock.json'
$fresh = (Test-Path $stamp) -and ((Get-Item -Force $stamp).LastWriteTime -ge (Get-Item -Force $lock).LastWriteTime) -and (Test-Path (Join-Path $Root 'node_modules'))
if ($fresh -and -not $Force) {
  Ok "Already installed (package-lock.json unchanged)"
} else {
  Run $Npm @('ci', '--no-audit', '--no-fund')
  Set-Content -Path $stamp -Value (Get-Date -Format o)
  Ok "Installed"
}
Run $Npm @('run', 'build', '-w', '@fpl/core', '--silent')
Ok "Built shared core package"

# ---------------------------------------------------------------- .env
Step ".env"
if (Test-Path (Join-Path $Root '.env')) { Ok ".env already exists (left unchanged)" }
else { Copy-Item (Join-Path $Root '.env.example') (Join-Path $Root '.env'); Ok "Created .env from .env.example" }

# ---------------------------------------------------------------- local database
Step "Local PostgreSQL (.venv\pgdata)"
try {
  Run $Npm @('run', 'db:local', '--silent', '--', 'check')
} catch {
  Note "The local database didn't start. If the message mentions VCRUNTIME140.dll, install the"
  Note "Microsoft Visual C++ Redistributable (x64): https://aka.ms/vs/17/release/vc_redist.x64.exe"
  Note "Alternative: Docker Desktop, then 'npm run db:up' and 'npm run dev:docker' (see README)."
  throw
}

# ---------------------------------------------------------------- VS Code
if (-not $SkipVSCode) {
  Step "VS Code configuration (.vscode)"
  $src = Join-Path (Join-Path $Root 'tools') 'vscode'
  $dst = Join-Path $Root '.vscode'
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  foreach ($f in Get-ChildItem $src -Filter '*.json') {
    $target = Join-Path $dst $f.Name
    if (Test-Path $target) { Note ".vscode\$($f.Name) exists; left unchanged (template: tools\vscode\$($f.Name))" }
    else { Copy-Item $f.FullName $target; Ok "Added .vscode\$($f.Name)" }
  }
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "  Start everything:  double-click dev.cmd   (or in VS Code: Terminal > Run Task > 'Dev: start all')"
Write-Host "  Then open:         http://localhost:5173"
