<#
.SYNOPSIS
  Run backend (FastAPI :8000) + frontend (Next.js :3000) together with one command,
  then auto-login via the dev session cookie.

.USAGE
  .\dev.ps1                # start both, open http://localhost:3000/dev-login (auto-login)
  .\dev.ps1 -NoBrowser     # start both, don't open a browser

  Everything is automatic: missing venv/deps/node_modules get installed,
  ports 3000/8000 are reclaimed if busy. Just run it.

  Ctrl+C stops both servers (whole process trees are killed).

REQUIREMENTS
  Node.js (npm) + backend\.venv with deps installed (pip install -r requirements.txt).
#>
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"
$py = Join-Path $backendDir ".venv\Scripts\python.exe"
$bePort, $fePort = 8000, 3000

function PortHolder {
  param($port)
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return (Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue) }
  return $null
}

# --- preflight (all automatic: missing pieces are installed, busy ports reclaimed)
if (-not (Test-Path $py)) {
  Write-Host "Backend venv missing - creating .venv and installing requirements (one time, may take minutes)..." -ForegroundColor Yellow
  & python -m venv (Join-Path $backendDir ".venv")
  if ($LASTEXITCODE -ne 0) { throw "python not found. Install Python 3.11+ first." }
  & $py -m pip install -r (Join-Path $backendDir "requirements.txt")
}
$nodeSrc = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeSrc) { throw "node not found. Install Node.js 20+ first." }
$npm = Join-Path (Split-Path -Parent $nodeSrc) "npm.cmd"
if (-not (Test-Path $npm)) {
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
}
if (-not $npm) { throw "npm.cmd not found next to node. Reinstall Node.js 20+." }
if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
  Write-Host "frontend/node_modules missing - running npm install (one time)..." -ForegroundColor Yellow
  & $npm install --prefix $frontendDir
}
try { & $py -c "import uvicorn, fastapi" 2>$null } catch {
  Write-Host "Backend deps missing - running pip install -r requirements.txt..." -ForegroundColor Yellow
  & $py -m pip install -r (Join-Path $backendDir "requirements.txt")
}

foreach ($p in @($bePort, $fePort)) {
  $holder = PortHolder $p
  if ($holder) {
    Write-Host "Port $p held by $($holder.ProcessName) (PID $($holder.Id)) - reclaiming..." -ForegroundColor Yellow
    taskkill /PID $holder.Id /T /F | Out-Null
    Start-Sleep -Seconds 2
    if (PortHolder $p) { throw "Port $p still busy after kill. Stop the owning process manually." }
  }
}

# --- start -------------------------------------------------------------------
Write-Host "Starting backend  : http://localhost:$bePort/docs" -ForegroundColor Cyan
$be = Start-Process -FilePath $py -ArgumentList "-m uvicorn app.main:app --reload --port $bePort" `
  -WorkingDirectory $backendDir -PassThru -NoNewWindow
Write-Host "Starting frontend : http://localhost:$fePort" -ForegroundColor Cyan
$fe = Start-Process -FilePath $npm -ArgumentList "run dev -- --port $fePort" `
  -WorkingDirectory $frontendDir -PassThru -NoNewWindow

function WaitUrl {
  param($url, $label, $timeoutSec = 180)
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($be.HasExited -or $fe.HasExited) { throw "$label exited during startup. See console output above." }
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { Write-Host "$label OK : $url" -ForegroundColor Green; return }
    } catch { Start-Sleep -Seconds 2 }
  }
  throw "Timed out waiting for $label ($url)."
}

try {
  WaitUrl "http://localhost:$bePort/health" "Backend"
  WaitUrl "http://localhost:$fePort/" "Frontend"
  Write-Host ""
  Write-Host "Both up. Auto-login: http://localhost:$fePort/dev-login  (sets dev cookie -> /dashboard)" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process "http://localhost:$fePort/dev-login" }
  Write-Host "Press Ctrl+C to stop both servers." -ForegroundColor DarkGray
  Wait-Process -Id $be.Id, $fe.Id
} finally {
  foreach ($id in @($be.Id, $fe.Id)) {
    if ($id -and (Get-Process -Id $id -ErrorAction SilentlyContinue)) {
      taskkill /PID $id /T /F 2>&1 | Out-Null
    }
  }
  Write-Host "Servers stopped." -ForegroundColor DarkGray
}
