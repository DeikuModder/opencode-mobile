<#
.SYNOPSIS
  Bring the Docker-hosted gateway up, waiting for Docker Desktop to be ready.

.DESCRIPTION
  The gateway runs in Docker, so "start the gateway" means "docker compose up -d",
  not "run a process". That needs Docker's own daemon, which is a separate piece of
  software that may still be starting at logon. Without this wait, the very first
  `docker compose up` fails with "the daemon is not running" or a named-pipe error,
  and a task with RetryCount will burn all its attempts inside the first few
  seconds and then sit dead until the next logon.

  So this polls for the daemon first, then runs compose once, idempotently:
  `up -d` against an already-healthy container is a no-op, which makes the task
  safe to run again at any time.

  Deliberately NOT registered as a service. The gateway is fine as a task, but
  the supervisor genuinely needs the user profile (see install-autostart.ps1),
  and keeping both in one mechanism is easier to reason about.

.PARAMETER ComposeFile
  Compose file to use. Defaults to docker-compose.yml next to this script.

.PARAMETER TimeoutSeconds
  How long to wait for the Docker daemon before giving up. The task's own retry
  settings then cover a Docker Desktop that is slower than this.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/docker-gateway.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/docker-gateway.ps1 -TimeoutSeconds 600
#>
[CmdletBinding()]
param(
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ComposeFile = Join-Path $Root "docker-compose.yml"
$LogFile = Join-Path $Root "logs\gateway-compose-task.log"

New-Item -ItemType Directory -Path (Split-Path $LogFile) -Force | Out-Null

# Writes to stdout only. The scheduled task's cmd.exe already redirects stdout and
# stderr into that same file, so writing to it from in here would contend for the
# handle and fail. Keeping one writer means the log cannot interleave or truncate.
function Write-Log($message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message)
}

if (-not (Test-Path $ComposeFile)) { throw "No compose file at $ComposeFile" }

Write-Log "waiting for the Docker daemon (up to ${TimeoutSeconds}s)"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
  # `docker info` is the authoritative check: the Desktop UI can be open and
  # still be waiting on its VM, whereas this only succeeds once the engine answers.
  docker info *> $null
  if ($LASTEXITCODE -eq 0) {
    $ready = $true
    break
  }
  Start-Sleep -Seconds 5
}

if (-not $ready) {
  Write-Log "Docker daemon did not become ready in ${TimeoutSeconds}s; giving up for this attempt"
  exit 1
}

Write-Log "docker daemon ready; bringing the gateway up"
Push-Location $Root
try {
  # docker writes its progress to stderr, so a merged capture arrives as PowerShell
  # NativeCommandError records. Harmless, but with ErrorActionPreference=Stop it
  # would throw before $LASTEXITCODE could be read, turning a normal "No services
  # to build" notice into a failed task. Relaxed for this one call, exit code is
  # the real verdict.
  $previousPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = docker compose -f $ComposeFile up -d --remove-orphans 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previousPref
} finally {
  Pop-Location
}
foreach ($line in $output) { Write-Log "  $line" }

if ($code -ne 0) {
  Write-Log "docker compose up failed with exit code $code"
  exit $code
}

# Verified rather than assumed: the task should be observably correct, not merely
# have exited 0.
Start-Sleep -Seconds 10
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/auth/state" -UseBasicParsing -TimeoutSec 10
  Write-Log "gateway answered on :3000 with HTTP $($r.StatusCode)"
  exit 0
} catch {
  Write-Log "compose finished but :3000 did not answer ($($_.Exception.Message))"
  exit 1
}