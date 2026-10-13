<#
.SYNOPSIS
  Register the opencode-mobile gateway and host supervisor to start at logon.

.DESCRIPTION
  Two things have to be running for the app to work: the host supervisor (which
  spawns `opencode serve` on Windows) and the gateway (which serves the API, the
  SPA, and the /api/serve proxy).

  Task Scheduler rather than `sc.exe` services, deliberately. The supervisor
  spawns `opencode serve`, and opencode resolves its own provider credentials
  from the *user profile*. A Windows service running as LocalSystem has a
  different profile, so every model call would fail with an auth error that looks
  like an opencode bug. A scheduled task runs as you, keeps the profile, and
  needs no stored password.

  "At logon" also means the app is only up while you are signed in. Running
  whether or not you are logged on is possible (LogonType S4U) but the agent would
  then have no interactive session to work in, and it needs the password stored in
  the task definition to do it.

.PARAMETER NoGateway
  Register only the supervisor, e.g. when the gateway runs in Docker instead.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
#>
[CmdletBinding()]
param([switch]$NoGateway)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Get-NodePath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "node is not on PATH. Install Node 24+ and reopen the terminal." }
  return $cmd.Source
}

function Assert-Prereqs {
  if (-not (Test-Path (Join-Path $Root ".env"))) {
    throw "No .env at $Root. Copy .env.example to .env and fill it in first."
  }
  # The supervisor spawns processes and is reachable from the container, so an
  # unset token would make that port an RCE endpoint for anything that can route
  # to it. Refuse to register rather than install that silently.
  $envText = Get-Content (Join-Path $Root ".env") -Raw
  if ($envText -notmatch "(?m)^SUPERVISOR_TOKEN=.+") {
    throw "SUPERVISOR_TOKEN is blank in .env. Generate one: node -e `"console.log(require('crypto').randomBytes(32).toString('base64url'))`""
  }
  if ($envText -notmatch "(?m)^SERVE_PASSWORD=.+") {
    throw "SERVE_PASSWORD is blank in .env. It is the credential the gateway presents to opencode."
  }
  if ($NoGateway) { return }
  # Only the node-hosted gateway needs a local build; the Docker one builds its own
  # image and bakes the API in.
  if (Test-Path (Join-Path $Root "docker-compose.yml")) { return }
  $dist = Join-Path $Root "apps\api\dist\src\main.js"
  if (-not (Test-Path $dist)) {
    throw "API is not built. Run: pnpm build"
  }
}

function Register-Task {
  param(
    [string]$Name,
    [string]$Script,
    [string]$LogFile,
    # A .ps1 needs powershell.exe rather than node.exe; anything else is a JS entry
    # point run by node. Set when the script is PowerShell.
    [switch]$PowerShell,
    [int]$RestartMinutes = 1
  )
  $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "  replacing existing task: $Name" -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  }

  # Task Scheduler has no stdout/stderr fields on a task action, so the output
  # goes nowhere unless the action is wrapped in a shell. That is why the action
  # is cmd.exe rather than node.exe: without this, a task that dies on startup
  # leaves no trace at all, and the only symptom is a port that never opens.
  # The redirections are part of the argument string and are parsed by cmd.
  $entry = Join-Path $Root $Script
  if ($PowerShell) {
    $exe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $inner = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $entry
  } else {
    $exe = Get-NodePath
    $inner = '"{0}"' -f $entry
  }
  # `/c` and the wrapping quotes around the whole command are both load-bearing.
  # Without `/c` cmd waits on stdin and never runs the program; without the outer
  # quotes cmd mis-parses the redirect, silently creating no log at all. Both
  # failures look identical from outside: the task reports Running, the port never
  # opens, and there is no error anywhere to follow.
  $args = '/c ""{0}" {1} >> "{2}" 2>&1"' -f $exe, $inner, $LogFile
  $action = New-ScheduledTaskAction `
    -Execute $env:ComSpec `
    -Argument $args `
    -WorkingDirectory $Root

  # The same fully-qualified identity for the trigger and the principal. Mixing
  # a bare $env:USERNAME on the trigger with DOMAIN\USERNAME on the principal
  # registers cleanly and then does not fire for the account that was intended.
  $accountId = "{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $accountId

  # Interactive: only runs when the user is signed on, so no password is stored
  # anywhere and opencode keeps access to the user profile.
  $principal = New-ScheduledTaskPrincipal -UserId $accountId -LogonType Interactive -RunLevel Limited

  # The gateway task retries on a longer delay than the supervisor: it polls for the
  # Docker daemon itself, so a fast retry either duplicates that wait or fails while
  # Docker Desktop is still booting. Three tries a minute apart can be spent before
  # Docker is up at all.
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes $RestartMinutes) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew

  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null

  # Start it now so the install is verified rather than assumed.
  Start-ScheduledTask -TaskName $Name
  Write-Host "  registered + started: $Name  (logs: $LogFile)" -ForegroundColor Green
}

Assert-Prereqs
$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

Write-Host "Installing opencode-mobile autostart tasks in $Root"

# The keep-alive wrapper, not the supervisor directly. Task Scheduler's own
  # RestartCount treats a clean Ctrl+C exit as success and never retries, which is
  # exactly the failure that took the supervisor down; the wrapper polls :4100 and
  # restarts regardless of how the process exited.
  Register-Task `
    -Name "ocm-supervisor" `
    -Script "scripts\supervisor-keepalive.ps1" `
    -LogFile (Join-Path $logDir "supervisor-task.log") `
    -PowerShell

if (-not $NoGateway) {
  # Docker-only: the gateway lives in a container, so starting it means
  # `docker compose up -d`, not running node. This also depends on Docker Desktop
  # having started, which the script waits for.
  if (Test-Path (Join-Path $Root "docker-compose.yml")) {
    Register-Task `
      -Name "ocm-gateway" `
      -Script "scripts\docker-gateway.ps1" `
      -LogFile (Join-Path $logDir "gateway-compose-task.log") `
      -PowerShell `
      -RestartMinutes 3
  } else {
    # No compose file, so this checkout runs the gateway directly from node.
    $dist = Join-Path $Root "apps\api\dist\src\main.js"
    Register-Task -Name "ocm-gateway" -Script "apps\api\dist\src\main.js" -LogFile (Join-Path $logDir "gateway-task.log")
  }
}

Start-Sleep -Seconds 6
Write-Host ""
Write-Host "Task status:"
Get-ScheduledTask -TaskName "ocm-*" |
  Select-Object TaskName, State |
  Format-Table -AutoSize |
  Out-String |
  Write-Host

Write-Host "Check the gateway answered:"
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/auth/state" -UseBasicParsing -TimeoutSec 5
  Write-Host "  GET /api/auth/state -> $($r.StatusCode) $($r.Content)" -ForegroundColor Green
} catch {
  Write-Warning "Gateway did not answer on :3000 yet ($($_.Exception.Message))."
  Write-Warning "The task log holds the real error; if it is empty, run it by hand:"
  Write-Warning "  node apps\api\dist\src\main.js"
}

Write-Host ""
Write-Host "Logs are plain append-only text. They are not rotated; if you keep the"
Write-Host "tasks installed for months, trim them yourself or delete them to reset."
Write-Host ""
Write-Host "Manage with scripts/autostart.ps1 -Action Start|Stop|Restart|Status"
