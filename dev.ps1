<#
.SYNOPSIS
  Run backend (FastAPI :8000) + frontend (Next.js :3000) together with one command,
  then open the real sign-up page.

.USAGE
  .\dev.ps1                # start both, open http://localhost:3000/sign-up
  .\dev.ps1 -NoBrowser     # start both, don't open a browser

  Everything is automatic: missing venv/deps/node_modules get installed, a stale dev
  server from this repo left on 3000/8000 is reclaimed. A system process holding 3000
  is never killed - the frontend moves to the next free port (and says so). 8000 held
  by a system process is a hard error.

  Ctrl+C stops both servers (whole process trees are killed).

  Must stay pure ASCII: this file has to parse under Windows PowerShell 5.1.

REQUIREMENTS
  Node.js (npm) + backend\.venv with deps installed (pip install -r requirements-dev.txt).
#>
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"
$py = Join-Path $backendDir ".venv\Scripts\python.exe"
$bePort = 8000
$fePort = 3000
$fePortCandidates = @(3000, 3001, 3002, 3003, 3010)

# Any socket state counts: a Bound (not yet listening) socket, or a stale one in
# TimeWait, still makes the real server fail with EADDRINUSE.
function PortHolder {
  param($port)
  # Prefer a real owner (a TimeWait leftover reports PID 0) and a listening socket.
  $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 } |
    Sort-Object { $_.State -ne "Listen" }
  $owningPid = if ($conns) { ($conns | Select-Object -First 1).OwningProcess } else { 0 }
  if (-not $owningPid) {
    # Get-NetTCPConnection can be unavailable or miss a socket; netstat never does.
    foreach ($line in (netstat -ano | Select-String -Pattern "^\s*TCP\s+\S+:$port\s")) {
      $tail = ($line.Line -split '\s+')[-1]
      if ($tail -match '^\d+$' -and [int]$tail -gt 0) { $owningPid = [int]$tail; break }
    }
  }
  if ($owningPid) {
    return (Get-Process -Id $owningPid -ErrorAction SilentlyContinue)
  }
  return $null
}

# Port policy: we only reclaim a process we can prove is ours; anything else is
# somebody's work, not a leak.
# - Only the canonical ports 3000 and 8000 are ever reclaimed.
# - The fallback candidates (3001, 3002, 3003, 3010) are never killed; a busy one
#   is skipped, because it is another project's dev server until proven otherwise.
# - 8000: python/pythonw/uvicorn running app.main:app, or a command line in this repo.
# - 3000: a command line in this repo (a stale `next dev` resolves our node_modules),
#   never a stranger - plus a refusal of session 0, where services live.
function Test-DevProcess {
  param($proc, $port)
  if (-not $proc) { return $false }
  # Windows services run in session 0, and a service hosted by a Python/Node
  # image has exactly the same name as a dev server. Nothing a user starts from
  # a terminal lives in session 0, so refuse that whole session before any other
  # test: "never kill a system process" has to be enforced, not implied.
  if ($proc.SessionId -eq 0) { return $false }
  $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
  if (-not $cmdLine) { return $false }
  if ($port -eq $bePort) {
    if (@("python", "pythonw", "uvicorn") -notcontains $proc.ProcessName.ToLower()) { return $false }
    # Whole words only: "app.main:appx" or a "--reload" of "myuvicorn" is not ours.
    return ($cmdLine -like "*$root*" -or ($cmdLine -match '(?i)\buvicorn\b' -and $cmdLine -match '(?i)\bapp\.main:app\b'))
  }
  # Frontend: the only proof is that the holder runs from this checkout.
  return ($cmdLine -like "*$root*")
}

# taskkill is async; wait until the socket is really gone before rebinding.
function WaitPortFree {
  param($port, $timeoutSec = 10)
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (-not (PortHolder $port)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (-not (PortHolder $port))
}

function Stop-DevHolder {
  param($holder, $port)
  Write-Host "Port $port held by $($holder.ProcessName) (PID $($holder.Id)) - reclaiming..." -ForegroundColor Yellow
  taskkill /PID $holder.Id /T /F 2>&1 | Out-Null
  return (WaitPortFree $port)
}

# --- preflight (all automatic: missing pieces are installed, busy ports reclaimed)
if (-not (Test-Path $py)) {
  Write-Host "Backend venv missing - creating .venv and installing requirements (one time, may take minutes)..." -ForegroundColor Yellow
  & python -m venv (Join-Path $backendDir ".venv")
  if ($LASTEXITCODE -ne 0) { throw "python not found. Install Python 3.11+ first." }
  & $py -m pip install -r (Join-Path $backendDir "requirements-dev.txt")
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
  Write-Host "Backend deps missing - running pip install -r requirements-dev.txt..." -ForegroundColor Yellow
  & $py -m pip install -r (Join-Path $backendDir "requirements-dev.txt")
}

# --- ports: reclaim only what we own ------------------------------------------
$beHolder = PortHolder $bePort
if ($beHolder) {
  if (-not (Test-DevProcess $beHolder $bePort)) {
    throw "Port $bePort is held by $($beHolder.ProcessName) (PID $($beHolder.Id)), which is not a dev server from this repo. dev.ps1 will not kill it - stop it or change the backend port, then run again."
  }
  if (-not (Stop-DevHolder $beHolder $bePort)) {
    throw "Port $bePort still busy after killing $($beHolder.ProcessName) (PID $($beHolder.Id)). Stop the owning process manually."
  }
}

# Only the canonical frontend port may be reclaimed. A fallback candidate that is
# busy belongs to somebody else, so it is skipped, never killed.
$fe3000 = PortHolder $fePort
if ($fe3000 -and (Test-DevProcess $fe3000 $fePort)) {
  if (-not (Stop-DevHolder $fe3000 $fePort)) { Write-Host "Port $fePort still busy after kill - using another port." -ForegroundColor Yellow }
}

foreach ($p in $fePortCandidates) {
  if (-not (PortHolder $p)) { $fePort = $p; break }
}
if (PortHolder $fePort) {
  throw "Frontend ports $($fePortCandidates -join ', ') are all in use by other processes. Free one of them and run again."
}

$origin = "http://localhost:$fePort"
if ($fePort -ne 3000) {
  $blocker = PortHolder 3000
  Write-Host "Port 3000 is held by $($blocker.ProcessName) (PID $($blocker.Id)) - frontend will run on $origin instead." -ForegroundColor Yellow
  Write-Host "  The documented port is 3000. OAuth callback URLs registered for :3000 will NOT work on :$fePort." -ForegroundColor Yellow
}

# --- start -------------------------------------------------------------------
Write-Host "Starting backend  : http://localhost:$bePort/docs" -ForegroundColor Cyan
$be = Start-Process -FilePath $py -ArgumentList "-m uvicorn app.main:app --reload --port $bePort" `
  -WorkingDirectory $backendDir -PassThru -NoNewWindow

Write-Host "Starting frontend : $origin" -ForegroundColor Cyan
# Better Auth bakes baseURL/trustedOrigins (server + browser auth client) from env when
# the dev server starts, so a fallback origin must be in the child's environment - a URL
# we merely open would leave the server and the browser disagreeing and silently break
# sign-in. Save, set, spawn, restore: Start-Process inherits the current process env.
$envKeys = @("NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_API_URL", "BETTER_AUTH_URL")
$savedEnv = @{}
foreach ($k in $envKeys) { $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, "Process") }
# The restore has to survive a failed spawn: Start-Process throwing under
# $ErrorActionPreference = "Stop" aborts the script, and a dot-sourced script
# would leave BETTER_AUTH_URL pinned to a localhost origin in the caller's
# session - which `lib/auth.ts` then bakes into baseURL/trustedOrigins.
try {
  if ($fePort -ne 3000) {
    [Environment]::SetEnvironmentVariable("NEXT_PUBLIC_APP_URL", $origin, "Process")
    [Environment]::SetEnvironmentVariable("NEXT_PUBLIC_API_URL", "$origin/api", "Process")
    [Environment]::SetEnvironmentVariable("BETTER_AUTH_URL", $origin, "Process")
  }
  $fe = Start-Process -FilePath $npm -ArgumentList "run dev -- --port $fePort" `
    -WorkingDirectory $frontendDir -PassThru -NoNewWindow
} finally {
  foreach ($k in $envKeys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], "Process") }
}

function WaitUrl {
  param($url, $label, $timeoutSec = 180)
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($be.HasExited) { throw "Backend exited during startup. See console output above." }
    if ($fe.HasExited) { throw "Frontend exited during startup. See console output above." }
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { Write-Host "$label OK : $url" -ForegroundColor Green; return }
    } catch { Start-Sleep -Seconds 2 }
  }
  throw "Timed out waiting for $label ($url)."
}

try {
  WaitUrl "http://localhost:$bePort/health" "Backend"
  WaitUrl "$origin/" "Frontend"
  Write-Host ""
  Write-Host "Both up. Create or sign in to an account: $origin/sign-up" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process "$origin/sign-up" }
  Write-Host "Press Ctrl+C to stop both servers." -ForegroundColor DarkGray
  Wait-Process -Id $be.Id, $fe.Id
} finally {
  foreach ($procId in @($be.Id, $fe.Id)) {
    if ($procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
      taskkill /PID $procId /T /F 2>&1 | Out-Null
    }
  }
  Write-Host "Servers stopped." -ForegroundColor DarkGray
}
