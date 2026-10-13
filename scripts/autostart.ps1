<#
.SYNOPSIS
  Start, stop, or inspect the opencode-mobile autostart tasks.

.DESCRIPTION
  Thin wrapper over the two scheduled tasks created by install-autostart.ps1, so
  the day-to-day commands are one short line and do not require remembering the
  task names.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/autostart.ps1 -Action Status
  powershell -ExecutionPolicy Bypass -File scripts/autostart.ps1 -Action Restart
#>
[CmdletBinding()]
param(
  [ValidateSet("Start", "Stop", "Restart", "Status", "Uninstall")]
  [string]$Action = "Status"
)

$ErrorActionPreference = "Stop"
$Tasks = @("ocm-supervisor", "ocm-gateway")

function Get-TaskState($name) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $t) { return "not installed" }
  return [string]$t.State
}

switch ($Action) {
  "Start" {
    foreach ($n in $Tasks) { Start-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
  }
  "Stop" {
    # Stop in the dependent order: the gateway can be mid-proxy-request, and the
    # supervisor is what owns the opencode processes it would try to clean up.
    foreach ($n in @("ocm-gateway", "ocm-supervisor")) { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
  }
  "Restart" {
    foreach ($n in @("ocm-gateway", "ocm-supervisor")) { Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
    foreach ($n in $Tasks) { Start-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
  }
  "Uninstall" {
    foreach ($n in $Tasks) {
      $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
      if ($t) {
        Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $n -Confirm:$false
        Write-Host "removed $n"
      }
    }
    Write-Host ""
    Write-Host "Uninstalling the tasks does not stop `opencode serve`, which the"
    Write-Host "supervisor started as a child process; stop the supervisor task"
    Write-Host "before uninstalling if you want those to go away."
    Write-Host ""
    Write-Host "Do not stop opencode by image name. `Get-Process opencode |"
    Write-Host "Stop-Process` would also kill any opencode TUI you have open in a"
    Write-Host "terminal, which is unrelated to this app. If a serve process is"
    Write-Host "stuck, shut it down from inside the app or close the terminal that"
    Write-Host "owns it."
    return
  }
}

Write-Host ""
Write-Host ("{0,-16} {1,-14} {2}" -f "TASK", "STATE", "HEALTH")
Write-Host ("-" * 52)

$supState = Get-TaskState "ocm-supervisor"
$supHealth = "-"
# /health is behind SUPERVISOR_TOKEN, so an unauthenticated probe gets a 401 and
# reads as "no answer" even while the supervisor is perfectly healthy. Read the
# token from .env rather than reporting a false negative. The value is used in a
# request header and never printed.
$supToken = $null
$envFile = Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path ".env"
if (Test-Path $envFile) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^SUPERVISOR_TOKEN=" } | Select-Object -First 1
  if ($line) { $supToken = $line.Substring("SUPERVISOR_TOKEN=".Length).Trim().Trim('"') }
}
try {
  if (-not $supToken) { throw "no SUPERVISOR_TOKEN in .env" }
  $headers = @{ Authorization = "Bearer $supToken" }
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:4100/health" -Headers $headers -TimeoutSec 3
  $supHealth = "ok, $($r.running.Count) serve running"
} catch {
  # Expected when the supervisor is stopped; not an error to report loudly.
  $supHealth = if ($supState -eq "Running") { "no answer on :4100" } else { "-" }
}
Write-Host ("{0,-16} {1,-14} {2}" -f "ocm-supervisor", $supState, $supHealth)

$gwState = Get-TaskState "ocm-gateway"
$gwHealth = "-"
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/auth/state" -UseBasicParsing -TimeoutSec 3
  $gwHealth = "HTTP $($r.StatusCode)"
} catch {
  $gwHealth = if ($gwState -eq "Running") { "no answer on :3000" } else { "-" }
}
Write-Host ("{0,-16} {1,-14} {2}" -f "ocm-gateway", $gwState, $gwHealth)

Write-Host ""
Write-Host "Open ports this app uses (all should be loopback-only except serve):"
try {
  Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalPort -in 3000, 4100, 4101, 4102, 4103 } |
    Select-Object @{n = "port"; e = { $_.LocalPort } }, LocalAddress |
    Sort-Object port |
    Format-Table -AutoSize |
    Out-String |
    Write-Host
} catch {
  Write-Host "  (could not enumerate listeners)"
}
