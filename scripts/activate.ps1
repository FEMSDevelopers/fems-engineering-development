<#
.SYNOPSIS
  Activates the project environment in the current PowerShell session (like a Python venv's Activate.ps1).
  Puts .venv\node and node_modules\.bin first on PATH. Run `deactivate` to undo.

.EXAMPLE
  . .\scripts\activate.ps1
#>
$FplRoot = Split-Path -Parent $PSScriptRoot
$FplNode = Join-Path $FplRoot '.venv\node'

if (-not (Test-Path (Join-Path $FplNode 'node.exe'))) {
  Write-Warning "No portable Node in .venv\node. Run setup.cmd first (or setup with -UseSystemNode)."
  return
}
if (-not $env:FPL_OLD_PATH) { $env:FPL_OLD_PATH = $env:Path }
$env:Path = "$FplNode;$(Join-Path $FplRoot 'node_modules\.bin');$env:FPL_OLD_PATH"
$env:FPL_ROOT = $FplRoot

if (-not (Test-Path function:global:_fpl_old_prompt)) { Copy-Item function:prompt function:global:_fpl_old_prompt }
function global:prompt { "(fpl) " + (& _fpl_old_prompt) }

function global:deactivate {
  if ($env:FPL_OLD_PATH) { $env:Path = $env:FPL_OLD_PATH; Remove-Item Env:FPL_OLD_PATH }
  Remove-Item Env:FPL_ROOT -ErrorAction SilentlyContinue
  if (Test-Path function:global:_fpl_old_prompt) {
    Copy-Item function:global:_fpl_old_prompt function:global:prompt
    Remove-Item function:global:_fpl_old_prompt
  }
  Remove-Item function:global:npm, function:global:npx -ErrorAction SilentlyContinue
  Remove-Item function:global:deactivate
}

# In PowerShell, `npm` would resolve to npm.ps1, which some execution policies block; route it to npm.cmd.
function global:npm { & (Join-Path $FplNode 'npm.cmd') @args }
function global:npx { & (Join-Path $FplNode 'npx.cmd') @args }

Write-Host "fpl environment active: node $(& (Join-Path $FplNode 'node.exe') -v). Commands: npm run dev | npm test | npm run db:local -- stop | deactivate" -ForegroundColor Green
