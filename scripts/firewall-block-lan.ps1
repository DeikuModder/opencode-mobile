<#
.SYNOPSIS
  Block LAN access to the opencode-mobile ports.

.DESCRIPTION
  Creates inbound Block rules so 3000, 4100 and 4101-4110 are not reachable from
  other machines, while still allowing loopback and the Docker bridge.

  This matters because the supervisor spawns processes and `opencode serve`
  exposes a full coding agent API. Both must bind 0.0.0.0 for the container to
  reach them over host.docker.internal, so the firewall is the only remaining
  control between the LAN and remote code execution.

  Requires an elevated PowerShell. Run firewall-check.ps1 to audit afterwards.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
  [int[]]$Ports = @(3000, 4100) + (4101..4110),
  # Remove rules this script created previously.
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$RulePrefix = "opencode-mobile block"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "This script needs an elevated PowerShell. Re-run it from an admin prompt."
}

if ($Remove) {
  $existing = Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue
  if ($existing) {
    foreach ($r in $existing) {
      if ($PSCmdlet.ShouldProcess($r.DisplayName, "Remove-NetFirewallRule")) {
        Remove-NetFirewallRule -Name $r.Name -ErrorAction SilentlyContinue
      }
    }
    Write-Host "Removed $($existing.Count) rule(s)." -ForegroundColor Green
  } else {
    Write-Host "No rules to remove."
  }
  return
}

# One rule per port rather than one rule with many ports: a single wide rule is
# easy to edit by accident, and the audit output stays legible per port.
$created = 0
foreach ($port in $Ports) {
  $name = "$RulePrefix $port"
  if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
    Write-Host "  $name already exists, skipping"
    continue
  }
  if ($PSCmdlet.ShouldProcess($name, "New-NetFirewallRule")) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Block `
      -Protocol TCP -LocalPort $port -Profile Any -Enabled True `
      -Description "Blocks LAN access to opencode-mobile port $port. Loopback and the Docker bridge are unaffected." | Out-Null
    $created++
  }
}

Write-Host "Created $created rule(s)." -ForegroundColor Green
Write-Host "Re-run .\scripts\firewall-check.ps1 to confirm." -ForegroundColor Cyan
