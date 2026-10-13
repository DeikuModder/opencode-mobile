<#
.SYNOPSIS
  Keep the host supervisor alive, restarting it if it exits for any reason.

.DESCRIPTION
  Wraps host-supervisor.mjs in a restart loop, because the scheduled task's own
  RestartCount does not cover the most likely failure modes:

    - A Ctrl+C / console control event exits the supervisor cleanly. Task Scheduler
      reads that as success (0xC000013A counts as a normal exit), so it never
      retries and the port just stops listening. This has already happened once.
    - A restart during a code change can leave a half-torn-down process behind.

  So this polls the supervisor's own health endpoint instead of trusting the
  process. Health, not liveness of the PID: the supervisor can be up and answering
  /health while its children are being managed, which is the state we actually care
  about. If /health stops answering for PROBE_TIMEOUT_SECONDS the supervisor is
  treated as dead and restarted, no matter how cleanly it exited.

  Restart is deliberately rate limited. A supervisor that dies on startup (missing
  SUPERVISOR_TOKEN, unresolvable opencode binary, port taken) would otherwise spin
  as fast as it can fail, filling the log and burning CPU. Backing off means one
  crash produces one restart attempt per BACKOFF step, not thousands.

  It also refuses to start a second copy: two supervisors would fight over :4100 and
  over the child opencode processes, and the loser would take the children down with
  it on exit. A PID file plus a live-PID check handles that, and stale PID files from
  an unclean exit are cleaned up by verifying the PID is really ours.

.PARAMETER RestartDelaySeconds
  Base of the backoff between restarts. Doubles up to MaxBackoffSeconds.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/supervisor-keepalive.ps1
#>
[CmdletBinding()]
param(
  [int]$ProbeIntervalSeconds = 10,
  [int]$ProbeTimeoutSeconds = 15,
  [int]$RestartDelaySeconds = 5,
  [int]$MaxBackoffSeconds = 300
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Entry = Join-Path $Root "host\host-supervisor.mjs"
$PidFile = Join-Path $Root "logs\supervisor-keepalive.pid"
$LogFile = Join-Path $Root "logs\supervisor-keepalive.log"

if (-not (Test-Path $Entry)) { throw "No supervisor entry point at $Entry" }
New-Item -ItemType Directory -Path (Split-Path $PidFile) -Force | Out-Null

# Same single-writer rule as docker-gateway.ps1: the task's cmd.exe already
# redirects stdout and stderr into this file, so writing to it from in here would
# contend for the handle.
function Write-Log($message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message)
}

# Read at startup and reused: the token does not change without a restart of this
# script, and re-reading every probe would mean parsing .env on a timer.
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) { throw "No .env at $Root; the supervisor needs SUPERVISOR_TOKEN and SERVE_PASSWORD." }
$tokenLine = Get-Content $envFile | Where-Object { $_ -match "^SUPERVISOR_TOKEN=" } | Select-Object -First 1
if (-not $tokenLine) { throw "SUPERVISOR_TOKEN is missing from .env" }
$SupervisorToken = $tokenLine.Substring("SUPERVISOR_TOKEN=".Length).Trim().Trim('"')
$HealthHeaders = @{ Authorization = "Bearer $SupervisorToken" }

function Test-SupervisorHealthy {
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:4100/health" -Headers $HealthHeaders -TimeoutSec $ProbeTimeoutSeconds
    return $true
  } catch {
    return $false
  }
}

# A PID file alone is not enough: after a crash the file survives and every start
# would be refused. Verified by asking the process what it is running.
function Get-ExistingKeepAlivePid {
  if (-not (Test-Path $PidFile)) { return $null }
  # No ?. here: Windows PowerShell 5.1 is the interpreter for this task and does
  # not support the null-conditional operator. It fails at parse time, so the
  # whole script is dead on arrival rather than failing one line in.
  $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue)
  $raw = if ($raw) { $raw.Trim() } else { $null }
  if (-not $raw) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue; return $null }
  $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$raw" -ErrorAction SilentlyContinue
  if (-not $existing) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue; return $null }
  if ($existing.CommandLine -notmatch "supervisor-keepalive") {
    Write-Log "PID $raw is some other process; clearing the stale file"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
  return $raw
}

$existingPid = Get-ExistingKeepAlivePid
if ($existingPid) {
  Write-Log "another keep-alive is already running (pid $existingPid); refusing to start a second supervisor"
  exit 0
}

Set-Content -Path $PidFile -Value $PID -NoNewline
Write-Log "keep-alive starting (pid $PID), supervising $Entry"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($nodeCmd) { $nodeCmd.Source } else { $null }
if (-not $node) { throw "node is not on PATH" }

$backoff = $RestartDelaySeconds
$shuttingDown = $false

# Ctrl+C on this script means "stop", not "restart forever": an operator stopping
# things deliberately should not have it come straight back.
foreach ($sig in @("CtrlC", "ConsoleInterrupt")) {
  try {
    Register-EngineEvent -SourceIdentifier $sig -SupportEvent -Action { $shuttingDown = $true } | Out-Null
  } catch {
    # Not fatal; the parent cmd.exe still forwards a real termination as a kill.
  }
}

$child = $null

function Stop-Child {
  if (-not $child) { return }
  Write-Log "stopping supervisor (pid $($child.Id))"
  try {
    # The supervisor's own exit handler stops its opencode children by PID. Killing
    # the tree here too would race it, and killing by image name is never correct:
    # `taskkill /IM opencode.exe` would also kill the agent running this script.
    Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
    $child.WaitForExit(15000) | Out-Null
  } finally {
    $child = $null
  }
}

try {
  while (-not $shuttingDown) {
    if ($child -and $child.HasExited) {
      # Exit code 0 is normal (a deliberate SIGINT). Anything else is worth a line.
      $code = $child.ExitCode
      Write-Log "supervisor exited with code $code; will restart"
      $child = $null
    }

    if (-not $child) {
      Write-Log "starting supervisor: $node $Entry"
      # stdout/stderr inherited so the task's redirect captures both, same as a
      # direct run. Start-Process with a console would pop a window at every logon.
      $proc = Start-Process -FilePath $node `
        -ArgumentList "`"$Entry`"" `
        -WorkingDirectory $Root `
        -PassThru `
        -NoNewWindow
      $child = $proc
      $backoff = $RestartDelaySeconds

      # Give it time to bind :4100. Starting the health check immediately would
      # declare failure during a perfectly normal cold start.
      Start-Sleep -Seconds 10
      if (Test-SupervisorHealthy) {
        Write-Log "supervisor is healthy on :4100 (pid $($child.Id))"
      } else {
        Write-Log "supervisor did not answer :4100 within 10s; leaving it to start retrying"
      }
    }

    Start-Sleep -Seconds $ProbeIntervalSeconds

    if (Test-SupervisorHealthy) { continue }

    # Not answering. Before restarting, make sure it is not merely mid-startup:
    # a supervisor that binds slowly would otherwise be killed repeatedly.
    Write-Log "no answer on :4100; confirming before restart"
    Start-Sleep -Seconds 10
    if (Test-SupervisorHealthy) {
      Write-Log "answered on the second attempt; not restarting"
      continue
    }

    Stop-Child
    $backoff = [Math]::Min($backoff * 2, $MaxBackoffSeconds)
    Write-Log "restarting in ${backoff}s"
    Start-Sleep -Seconds $backoff
  }
} finally {
  Stop-Child
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Write-Log "keep-alive stopped"
}