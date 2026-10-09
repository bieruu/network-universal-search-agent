<#
.SYNOPSIS
  One-command deploy of the FastAPI backend to Koyeb.

.DESCRIPTION
  Wraps the runbook in WORKFLOW.md 8.6. It exists because the manual version has
  four ways to fail *after* a slow Docker build: a `DATABASE_URL` that points at
  localhost, the wrong TLS spelling, a `BETTER_AUTH_SECRET` that does not match
  the frontend, and an app that has to be created before it can take secrets.
  All four are checked here first, in under a second.

  Values are resolved in this order, first hit wins:
    1. an environment variable of the same name
    2. backend\.env   (already gitignored, already holds the secret)
    3. an interactive prompt, hidden input for anything secret

  Why the CLI and not a `koyeb.yaml`: Koyeb does not publish that file's schema
  on its docs site, and its own example repo (koyeb/example-docker-compose) does
  not use one. Every flag below is taken from the published CLI reference
  (koyeb docs, "CLI Reference", read 2026-10-10), so nothing here is guessed.

.EXAMPLE
  .\deploy-koyeb.ps1                  # deploy and verify
  .\deploy-koyeb.ps1 -DryRun          # check everything, deploy nothing
  .\deploy-koyeb.ps1 -Region was      # free instances exist in fra or was only
#>
[CmdletBinding()]
param(
  [string]$AppName = 'osint-api',
  # Koyeb's free Instance type is only offered in these two regions. It scales
  # to zero after 1 hour idle and that cannot be disabled - see WORKFLOW.md 8.6.
  [ValidateSet('fra', 'was')]
  [string]$Region = 'fra',
  [string]$GitRepo = '',
  [switch]$DryRun,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repo 'backend'
$envFile = Join-Path $backendDir '.env'

# The work directory IS the Docker build context, and the Dockerfile copies
# requirements.txt, alembic.ini and alembic/ -- which exist only under backend/.
# A wrong workdir fails the build with "COPY failed: file not found in context".
$WorkDir = 'backend'
$Port = 8000
$HealthPath = '/health'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    ok  $msg" -ForegroundColor Green }
function Write-Bad($msg) { Write-Host "    XX  $msg" -ForegroundColor Red }
function Write-Note($msg) { Write-Host "    --  $msg" -ForegroundColor Yellow }

# --- resolve a setting from env, then .env, then ask -------------------
function Resolve-Setting {
  param([string]$Name, [switch]$Secret, [switch]$Optional, [string]$Prompt)

  $fromEnv = [Environment]::GetEnvironmentVariable($Name)
  if ($fromEnv) { Write-Ok "$Name from environment"; return $fromEnv }

  if (Test-Path $envFile) {
    $hit = Get-Content $envFile | Where-Object { $_ -match "^\s*$Name=(.*)$" } |
      Select-Object -First 1
    if ($hit) {
      $value = ($hit -replace "^\s*$Name=", '').Trim()
      if ($value) {
        if ($value -match 'localhost|127\.0\.0\.1') {
          Write-Note "$Name in backend\.env points at localhost - ignoring it"
        } else {
          Write-Ok "$Name from backend\.env"
          return $value
        }
      }
    }
  }

  if ($Optional) { Write-Note "$Name not set (optional)"; return '' }

  $label = if ($Prompt) { $Prompt } else { $Name }
  if ($Secret) {
    $secure = Read-Host "$label" -AsSecureString
    $value = [System.Net.NetworkCredential]::new('', $secure).Password
  } else {
    $value = Read-Host "$label"
  }
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is required." }
  Write-Ok "$Name entered"
  return $value.Trim()
}

# --- preflight ----------------------------------------------------------
Write-Step 'Preflight'

if (-not (Get-Command koyeb -ErrorAction SilentlyContinue)) {
  Write-Bad 'The koyeb CLI is not installed. Install it, then re-run:'
  Write-Host '       npm install -g koyeb' -ForegroundColor Yellow
  Write-Host '       (https://www.koyeb.com/docs/build-and-deploy/cli/installation)' -ForegroundColor Yellow
  exit 1
}
Write-Ok 'koyeb CLI found'

# `koyeb whoami` fails when there is no session, which is exactly the state in
# which every later call would fail with an opaque 401. Catch it here instead.
$who = & koyeb whoami 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  Write-Bad 'Not authenticated with Koyeb. Run:  koyeb login'
  Write-Host $who.Trim() -ForegroundColor Yellow
  exit 1
}
Write-Ok "authenticated: $($who.Trim())"

foreach ($p in @('Dockerfile', 'requirements.txt', 'alembic.ini', 'alembic', 'app')) {
  if (-not (Test-Path (Join-Path $backendDir $p))) {
    Write-Bad "backend\$p is missing - the work directory would fail to build."
    exit 1
  }
}
Write-Ok "build context backend\$WorkDir\$([IO.Path]::DirectorySeparatorChar) is complete"

if (-not $GitRepo) {
  $origin = (& git -C $repo config --get remote.origin.url 2>$null | Out-String).Trim()
  if ($origin) {
    $GitRepo = ($origin -replace '\.git$', '' -replace '^git@github\.com:', 'https://github.com/')
  }
}
if (-not $GitRepo) {
  Write-Bad 'Could not determine the git remote. Pass -GitRepo explicitly.'
  exit 1
}
Write-Ok "git source: $GitRepo"

# --- configuration ------------------------------------------------------
Write-Step 'Configuration'
$databaseUrl = Resolve-Setting -Name 'DATABASE_URL' -Prompt 'Supabase DIRECT connection string (host starts with db.)'
$authSecret = Resolve-Setting -Name 'BETTER_AUTH_SECRET' -Secret
$shodanKey = Resolve-Setting -Name 'SHODAN_API_KEY' -Optional
$appUrl = Resolve-Setting -Name 'APP_URL' -Prompt 'Your Vercel origin, e.g. https://network-universal-search-agent.vercel.app'
$corsOrigins = Resolve-Setting -Name 'CORS_ORIGINS' -Optional
if (-not $corsOrigins) { $corsOrigins = $appUrl; Write-Note 'CORS_ORIGINS not set, using APP_URL' }

Write-Step 'Validating (these are the four ways a deploy fails *after* a slow build)'
$failures = @()

# asyncpg is the only driver in requirements.txt; a plain postgresql:// URL
# fails at import time, not at connect time.
if ($databaseUrl -notmatch '^postgresql\+asyncpg://') {
  $failures += 'DATABASE_URL must start with postgresql+asyncpg:// (asyncpg is the only driver installed).'
}
# asyncpg takes ssl= as a keyword and rejects sslmode= outright, while
# config.py's production guard accepts EITHER - so a sslmode= URL passes
# validation and then dies at connect time, inside a container, as a
# TypeError. This script is deliberately stricter than config.py.
if ($databaseUrl -match '\bsslmode=') {
  $failures += 'DATABASE_URL uses sslmode=. asyncpg rejects it ("unexpected keyword argument"); use ?ssl=require.'
} elseif ($databaseUrl -notmatch '\bssl=require\b') {
  $failures += 'DATABASE_URL has no TLS parameter. Use ?ssl=require (asyncpg only accepts ssl as a keyword).'
}
if ($databaseUrl -match '@localhost|@127\.0\.0\.1') {
  $failures += 'DATABASE_URL points at localhost. On Koyeb it must be the Supabase host.'
}
# Mirrors app/core/config.py so the container does not fail closed at boot.
if ($authSecret.Length -lt 32 -or
    $authSecret -match '^(replace-with|change-me|dev-secret|your-secret)' -or
    $authSecret -eq 'change-me-32-chars-min') {
  $failures += 'BETTER_AUTH_SECRET must be at least 32 characters and not a placeholder.'
}
if ($corsOrigins -like '*`**') { $failures += "CORS_ORIGINS must not contain '*' - config.py refuses to boot on it." }
if ($appUrl -notmatch '^https://') { $failures += 'APP_URL must be https:// - middleware.ts fails closed on plain http in production.' }
$originCount = ($corsOrigins -split ',').Count
Write-Host "    CORS_ORIGINS: $originCount origin(s)"

# The single most common cross-service mistake: the backend signs and the
# frontend verifies the session cookie with the same secret.
$frontendSecret = $null
$feEnv = Join-Path $repo 'frontend\.env.local'
if (Test-Path $feEnv) {
  $hit = Get-Content $feEnv | Where-Object { $_ -match '^\s*BETTER_AUTH_SECRET=(.*)$' } | Select-Object -First 1
  if ($hit) { $frontendSecret = ($hit -replace '^\s*BETTER_AUTH_SECRET=', '').Trim() }
}
if ($frontendSecret) {
  if ($frontendSecret -ceq $authSecret) { Write-Ok 'BETTER_AUTH_SECRET matches frontend\.env.local' }
  else { $failures += 'BETTER_AUTH_SECRET does NOT match frontend\.env.local - every scan would 401.' }
} else {
  Write-Note 'frontend\.env.local has no secret to compare against'
}

if ($failures.Count) {
  Write-Bad "$($failures.Count) problem(s):"
  $failures | ForEach-Object { Write-Host "        - $_" -ForegroundColor Red }
  exit 1
}
Write-Ok 'configuration is consistent'

if ($DryRun) {
  Write-Step 'Dry run - stopping here'
  Write-Host "    app       : $AppName"
  Write-Host "    source    : $GitRepo (branch main, workdir $WorkDir, docker builder)"
  Write-Host "    instance  : free ($Region)"
  Write-Host "    port      : $Port -> $HealthPath"
  Write-Host '    secrets   : DATABASE_URL, BETTER_AUTH_SECRET, SHODAN_API_KEY, CORS_ORIGINS, APP_URL'
  exit 0
}

# --- secrets ------------------------------------------------------------
# Created/updated BEFORE the service so the first deployment already has them.
# Passed with -v rather than --value-from-stdin on purpose: piping a string in
# PowerShell appends a newline, which would silently corrupt APP_URL and
# CORS_ORIGINS. argv exposure on a one-shot local run is the smaller risk.
Write-Step 'Secrets (they never enter git; this file has none)'
$secrets = [ordered]@{
  'DATABASE_URL'       = $databaseUrl
  'BETTER_AUTH_SECRET' = $authSecret
  'CORS_ORIGINS'       = $corsOrigins
  'APP_URL'            = $appUrl
}
if ($shodanKey) {
  # A copied .env.example placeholder would make the Shodan source look
  # configured and turn a clean "not configured" badge into an API error.
  if ($shodanKey -match '^(your|replace|changeme|xxx|<)' -or $shodanKey -match '[-_]key$') {
    Write-Note 'SHODAN_API_KEY looks like a placeholder - treating it as unset'
    $shodanKey = ''
  }
}
if ($shodanKey) { $secrets['SHODAN_API_KEY'] = $shodanKey } else { Write-Note 'SHODAN_API_KEY skipped: scans stay partial' }

$existing = (& koyeb secrets list -o json 2>$null | Out-String)
foreach ($name in $secrets.Keys) {
  if ($existing -match "`"$name`"") { & koyeb secrets update $name -v $secrets[$name] }
  else { & koyeb secrets create $name -v $secrets[$name] }
  if ($LASTEXITCODE -ne 0) { Write-Bad "koyeb secrets failed for $name"; exit 1 }
}
Write-Ok "$($secrets.Count) secrets set"

# --- service ------------------------------------------------------------
# Non-secret config. RATE_LIMIT_PER_HOUR must be a REAL process env var, not a
# .env baked into the image: app/core/config.py checks os.getenv so that unset
# is distinguishable from a deliberate value, and refuses to boot without it.
# Scale is pinned to 1 because the rate limiter is per-process - a second
# instance would multiply every quota.
$plainEnv = @(
  'APP_ENV=production',
  'CACHE_BACKEND=postgres',
  'RATE_LIMIT_PER_HOUR=5',
  'RATE_LIMIT_DAILY_TOTAL=50'
)
$envArgs = @()
foreach ($kv in $plainEnv) { $envArgs += @('--env', $kv) }
foreach ($name in $secrets.Keys) { $envArgs += @('--env', "$name={{secret.$name}}") }

$serviceArgs = @(
  '--git', $GitRepo,
  '--git-branch', 'main',
  '--git-workdir', $WorkDir,
  '--git-builder', 'docker',
  '--git-docker-dockerfile', 'Dockerfile',
  '--regions', $Region,
  '--instance-type', 'free',
  '--min-scale', '1',
  '--max-scale', '1',
  '--type', 'web',
  '--ports', "${Port}:http",
  # /health, not /ready: /ready opens a database connection on every probe.
  # The 60s grace covers the CMD running `alembic upgrade head` first.
  '--checks', "${Port}:http:$HealthPath",
  '--checks-grace-period', "${Port}=60"
) + $envArgs

$appsOut = (& koyeb apps list 2>&1 | Out-String)
$appExists = $appsOut -match [regex]::Escape($AppName)

if ($appExists) {
  Write-Step "Updating the existing app '$AppName'"
  & koyeb services update "$AppName/$AppName" @serviceArgs
} else {
  Write-Step "Creating app + service '$AppName'"
  Write-Host '    the first build compiles Subfinder with Go; expect several minutes' -ForegroundColor Yellow
  & koyeb apps init $AppName @serviceArgs
}
if ($LASTEXITCODE -ne 0) {
  Write-Bad 'koyeb could not apply the service configuration'
  exit 1
}

if ($SkipDeploy) { Write-Step 'Skipping deploy (-SkipDeploy)'; exit 0 }

# --- verify -------------------------------------------------------------
Write-Step 'Reading the public URL'
$domain = ''
try {
  $app = (& koyeb apps describe $AppName -o json 2>$null | Out-String) | ConvertFrom-Json
  $domain = $app.domain
} catch { $domain = '' }

if (-not $domain) {
  Write-Note 'could not read the domain from the CLI'
  Write-Host "    open https://app.koyeb.com and copy the App's URL, then set" -ForegroundColor Yellow
  Write-Host "    BACKEND_URL=https://<app-url> in the Vercel project settings" -ForegroundColor Yellow
  exit 0
}
$url = "https://$domain"
Write-Ok $url

Write-Step "Waiting for $HealthPath"
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  try {
    $health = Invoke-WebRequest -Uri "$url$HealthPath" -UseBasicParsing -TimeoutSec 10
    if ($health.StatusCode -eq 200) { Write-Ok "$HealthPath -> $($health.Content)"; $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 5
}
if (-not $ok) {
  Write-Bad "$HealthPath never answered"
  Write-Host "       koyeb deployments logs $AppName" -ForegroundColor Yellow
  exit 1
}

try {
  $ready = Invoke-WebRequest -Uri "$url/ready" -UseBasicParsing -TimeoutSec 25
  Write-Ok "/ready -> $($ready.Content)"
} catch {
  Write-Bad '/ready failed - the container reached the internet but not the database'
  Write-Host "       koyeb deployments logs $AppName   # look for a TLS or auth error on DATABASE_URL" -ForegroundColor Yellow
}

Write-Step 'Done'
Write-Host "    backend : $url"
Write-Host "    next    : set BACKEND_URL=$url in Vercel, then redeploy" -ForegroundColor Yellow
Write-Host '    then    : sign up, scan example.com, sign out (WORKFLOW.md 8.2 step 6)' -ForegroundColor Yellow
Write-Host '    keepalive: set the repo variable BACKEND_HEALTH_URL=' -ForegroundColor Yellow
Write-Host "              '$url$HealthPath' to arm .github/workflows/keep-backend-awake.yml" -ForegroundColor Yellow