<#
.SYNOPSIS
  One-command deploy of the FastAPI backend to Fly.io.

.DESCRIPTION
  Wraps the runbook in WORKFLOW.md 8.6. It exists because the manual version
  has four ways to fail *after* a slow Docker build: a `DATABASE_URL` that
  points at localhost, the wrong TLS spelling, a `BETTER_AUTH_SECRET` that
  does not match the frontend, and an app that has to be created before it can
  take secrets. All four are checked here first, in under a second.

  Values are resolved in this order, first hit wins:
    1. an environment variable of the same name
    2. backend\.env   (already gitignored, already holds the secret)
    3. an interactive prompt, hidden input for anything secret

.EXAMPLE
  .\deploy-fly.ps1                 # deploy
  .\deploy-fly.ps1 -DryRun         # check everything, deploy nothing
  .\deploy-fly.ps1 -FlyOrg personal
#>
[CmdletBinding()]
param(
  [string]$AppName = 'osint-api',
  [string]$FlyOrg = '',
  [switch]$DryRun,
  [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repo 'backend'
$envFile = Join-Path $backendDir '.env'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    ok  $msg" -ForegroundColor Green }
function Write-Bad($msg) { Write-Host "    XX  $msg" -ForegroundColor Red }

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
          Write-Host "    --  $Name in backend\.env points at localhost - ignoring it" -ForegroundColor Yellow
        } else {
          Write-Ok "$Name from backend\.env"
          return $value
        }
      }
    }
  }

  if ($Optional) { Write-Host "    --  $Name not set (optional)" -ForegroundColor Yellow; return '' }

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

if (-not (Get-Command flyctl -ErrorAction SilentlyContinue) -and
    -not (Get-Command fly -ErrorAction SilentlyContinue)) {
  Write-Bad 'flyctl is not installed. Install it, then re-run:'
  Write-Host '       iwr -useb https://fly.io/install.ps1 | iex' -ForegroundColor Yellow
  exit 1
}
$fly = if (Get-Command flyctl -ErrorAction SilentlyContinue) { 'flyctl' } else { 'fly' }
Write-Ok "flyctl found ($fly)"

if (-not (Test-Path (Join-Path $backendDir 'fly.toml'))) {
  Write-Bad 'backend\fly.toml is missing. This script deploys from backend\ on purpose.'
  exit 1
}

# Fly reads the build context from the directory it deploys in, and the
# Dockerfile copies files that exist only under backend/.
Push-Location $backendDir
try {

  Write-Step 'Configuration'
  $databaseUrl = Resolve-Setting -Name 'DATABASE_URL' -Prompt 'Supabase DIRECT connection string (host starts with db.)'
  $authSecret = Resolve-Setting -Name 'BETTER_AUTH_SECRET' -Secret
  $shodanKey = Resolve-Setting -Name 'SHODAN_API_KEY' -Optional
  $appUrl = Resolve-Setting -Name 'APP_URL' -Prompt 'Your Vercel origin, e.g. https://my-app.vercel.app'
  $corsOrigins = Resolve-Setting -Name 'CORS_ORIGINS' -Optional
  if (-not $corsOrigins) { $corsOrigins = $appUrl; Write-Host "    --  CORS_ORIGINS not set, using APP_URL" -ForegroundColor Yellow }

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
  # TypeError. This script is deliberately stricter than config.py: only
  # ssl=require is accepted here.
  if ($databaseUrl -match '\bsslmode=') {
    $failures += 'DATABASE_URL uses sslmode=. asyncpg rejects it ("unexpected keyword argument"); use ?ssl=require.'
  } elseif ($databaseUrl -notmatch '\bssl=require\b') {
    $failures += 'DATABASE_URL has no TLS parameter. Use ?ssl=require (asyncpg only accepts ssl as a keyword).'
  }
  if ($databaseUrl -match '@localhost|@127\.0\.0\.1') {
    $failures += 'DATABASE_URL points at localhost. On Fly it must be the Supabase host.'
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
    Write-Host '    --  frontend\.env.local has no secret to compare against' -ForegroundColor Yellow
  }

  if ($failures.Count) {
    Write-Bad "$($failures.Count) problem(s):"
    $failures | ForEach-Object { Write-Host "        - $_" -ForegroundColor Red }
    exit 1
  }
  Write-Ok 'configuration is consistent'

  if ($DryRun) {
    Write-Step 'Dry run - stopping here'
    Write-Host '    app       :' $AppName
    Write-Host '    region    : nrt (from fly.toml)'
    Write-Host '    secrets   : DATABASE_URL, BETTER_AUTH_SECRET, SHODAN_API_KEY, CORS_ORIGINS, APP_URL'
    exit 0
  }

  # --- app ------------------------------------------------------------
  Write-Step "Ensuring the Fly app '$AppName' exists"
  $appsOut = & $fly apps list 2>&1 | Out-String
  if ($appsOut -match [regex]::Escape($AppName)) {
    Write-Ok "app '$AppName' already exists"
  } else {
    Write-Host "    creating '$AppName' ..." -ForegroundColor Yellow
    if ($FlyOrg) { & $fly apps create $AppName --org $FlyOrg } else { & $fly apps create $AppName }
    if ($LASTEXITCODE -ne 0) { Write-Bad 'fly apps create failed'; exit 1 }
  }

  if ($FlyOrg) { $env:FLY_APP = $AppName }

  # --- secrets --------------------------------------------------------
  Write-Step 'Setting secrets (they never enter git; fly.toml has none)'
  $secrets = @(
    "DATABASE_URL=$databaseUrl",
    "BETTER_AUTH_SECRET=$authSecret",
    "CORS_ORIGINS=$corsOrigins",
    "APP_URL=$appUrl"
  )
  if ($shodanKey) {
    # A copied .env.example placeholder would make the Shodan source look
    # configured and turn a clean "not configured" badge into an API error.
    if ($shodanKey -match '^(your|replace|changeme|xxx|<)' -or $shodanKey -match '[-_]key$') {
      Write-Host "    --  SHODAN_API_KEY looks like a placeholder - treating it as unset" -ForegroundColor Yellow
      $shodanKey = ''
    }
  }
  if ($shodanKey) { $secrets += "SHODAN_API_KEY=$shodanKey" } else { Write-Host '    --  SHODAN_API_KEY skipped: scans stay partial' -ForegroundColor Yellow }
  & $fly secrets set @secrets
  if ($LASTEXITCODE -ne 0) { Write-Bad 'fly secrets set failed'; exit 1 }
  Write-Ok "$($secrets.Count) secrets set"

  if ($SkipDeploy) { Write-Step 'Skipping deploy (-SkipDeploy)'; exit 0 }

  # --- deploy ---------------------------------------------------------
  Write-Step 'Deploying (the build compiles Subfinder with Go; expect several minutes)'
  & $fly deploy --wait-timeout 10m
  if ($LASTEXITCODE -ne 0) {
    Write-Bad 'deploy failed - the real reason is in the log, not the exit code:'
    Write-Host "       $fly logs --tail" -ForegroundColor Yellow
    exit 1
  }

  # --- verify ---------------------------------------------------------
  Write-Step 'Verifying the public URL'
  $url = "https://$AppName.fly.dev"
  $ok = $false
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Seconds 5
    try {
      $health = Invoke-WebRequest -Uri "$url/health" -UseBasicParsing -TimeoutSec 10
      if ($health.StatusCode -eq 200) {
        Write-Ok "$url/health -> $($health.Content)"
        $ok = $true
        break
      }
    } catch { }
  }
  if (-not $ok) {
    Write-Bad "$url/health never answered"
    Write-Host "       $fly logs --tail" -ForegroundColor Yellow
    exit 1
  }

  try {
    $ready = Invoke-WebRequest -Uri "$url/ready" -UseBasicParsing -TimeoutSec 25
    Write-Ok "$url/ready -> $($ready.Content)"
  } catch {
    Write-Bad '/ready failed - the container reached the internet but not the database'
    Write-Host "       $fly logs --tail   # look for a TLS or auth error on DATABASE_URL" -ForegroundColor Yellow
  }

  Write-Step 'Done'
  Write-Host "    backend : $url"
  Write-Host "    next    : set BACKEND_URL=$url in Vercel, then redeploy" -ForegroundColor Yellow
  Write-Host '    then    : sign up, scan example.com, sign out (WORKFLOW.md 8.2 step 6)' -ForegroundColor Yellow
} finally {
  Pop-Location
}