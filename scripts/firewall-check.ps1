<#
.SYNOPSIS
  Verify the Windows Firewall is not exposing the opencode-mobile ports to the LAN.

.DESCRIPTION
  The gateway, the supervisor, and every `opencode serve` instance are designed to
  be reachable only from this machine and from the Docker gateway. To do that they
  have to bind 0.0.0.0 (the container reaches the host over a non-loopback
  address), which means the firewall is the only thing standing between the LAN
  and a remote-code-execution endpoint.

  This script checks the inbound rules for those ports. It is a READ-ONLY audit:
  it reports what is exposed and does not change anything. Apply a block rule with
  firewall-block-lan.ps1 once you have read the output.

  A rule can be "allowing" while a higher-priority block rule still denies the
  traffic, so the verdict here is the pessimistic one: anything with an explicit
  allow rule, or no block rule at all, is reported as exposed.

  IMPORTANT, and the reason this reports "UNVERIFIED" rather than "EXPOSED" when
  no rule matches: absence of a block rule is NOT evidence that a port is
  reachable. Windows falls back to the profile's DefaultInboundAction for
  unmatched traffic, and on a default install that is Block, so a machine with
  no rules at all for these ports is in fact closed. This script cannot tell the
  difference from a machine whose default is Allow, so it says UNVERIFIED and
  tells you how to settle it, rather than claiming a finding it has not made.
#>

[CmdletBinding()]
param(
  # Ports the design expects to be LAN-invisible.
  [int[]]$Ports = @(3000, 4100) + (4101..4110)
)

$ErrorActionPreference = "Stop"
Import-Module NetSecurity -ErrorAction SilentlyContinue

Write-Host "Inbound firewall profile state:" -ForegroundColor Cyan
$profiles = Get-NetFirewallProfile | Where-Object { $_.Enabled -eq "True" }
foreach ($p in $profiles) {
  Write-Host ("  {0,-12} inbound={1}  defaultInboundAction={2}" -f $p.Name, $p.Enabled, $p.DefaultInboundAction)
}
if (-not $profiles) {
  Write-Warning "No firewall profile is enabled. Everything below is exposed."
}

# The effective fallback for a port that no rule matches. This decides whether a
# missing block rule actually means the port is open.
$defaultAllows = @($profiles | Where-Object { $_.DefaultInboundAction -eq "Allow" }).Count -gt 0
$defaultUnknown = @($profiles | Where-Object { $_.DefaultInboundAction -eq "NotConfigured" }).Count -gt 0
if ($defaultAllows) {
  Write-Host ""
  Write-Warning "A profile defaults to Allow, so unmatched inbound traffic IS accepted. Ports with no rule are reachable."
} elseif ($defaultUnknown) {
  Write-Host ""
  Write-Host "Profile default is NotConfigured: unmatched traffic falls back to the Windows default (Block)," -ForegroundColor Yellow
  Write-Host "so a port with no matching rule is most likely already closed. This script cannot prove that." -ForegroundColor Yellow
}

# Collect every enabled inbound rule that mentions one of our ports. Matching on
# the LocalPort field covers both TCP and UDP and avoids parsing netsh output.
# Windows does not always store LocalPort as a bare integer. It can be a comma list
# ("80,443"), a range ("4101-4110"), a dynamic keyword ("RPC", "RPCEPMap",
# "IPHTTPS"), or "Any"/"Cualquiera". Comparing any of those with [int] or calling
# .Trim() on them throws, which aborts the whole audit, so the value is normalised
# here first.
#
# A wildcard port is NOT expanded to every port we care about. Windows ships ~145
# inbound enabled TCP rules on "Any" local port, and on this machine every one of
# them is pinned to a specific program (svchost.exe, System) for a service such as
# Wi-Fi Direct or the Connected Devices Platform. None can admit a node.exe or
# opencode.exe listener. Expanding them made every port report "275 program-scoped
# allow rule(s)", which is noise that buries the actual answer.
#
# They are therefore counted once, as a single summary, and only ever reported as
# program-scoped. Only rules naming one of our exact ports affect a verdict.
$script:UnparsedLocalPorts = @{}
$script:ScopedWildcardAllow = 0
$script:ScopedWildcardBlock = 0
$script:WildcardLocales = @("Any", "Cualquiera", "Tous", "Alle", "Qualquer", "Qualunque", "Wszystkie")

function Test-IsWildcardPort {
  param([string]$Text)
  foreach ($w in $script:WildcardLocales) {
    if ($Text -eq $w) { return $true }
  }
  return $false
}

# True when the rule could admit traffic for an arbitrary program. A rule pinned to
# one executable cannot expose a different one, whatever its port range.
function Test-AdmitsAnyProgram {
  param([object]$Rule)

  $app = $Rule | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue
  if (-not $app) { return $true }
  $program = [string]$app.Program
  if ([string]::IsNullOrWhiteSpace($program)) { return $true }
  foreach ($w in $script:WildcardLocales) {
    if ($program -eq $w) { return $true }
  }
  # An explicit program path means the rule only applies to that program.
  return $false
}

function Get-PortsFromLocalPort {
  param([object]$LocalPort)

  $result = @()
  if ($null -eq $LocalPort) { return $result }

  foreach ($raw in @($LocalPort)) {
    $text = ([string]$raw).Trim()
    if ($text.Length -eq 0) { continue }

    # Wildcards are summarised separately rather than matched against every port.
    if (Test-IsWildcardPort $text) { continue }

    foreach ($token in ($text -split ",")) {
      $entry = $token.Trim()
      if ($entry.Length -eq 0) { continue }
      if (Test-IsWildcardPort $entry) { continue }

      if ($entry -match '^\d+$') {
        $result += [int]$entry
      } elseif ($entry -match '^(\d+)\s*-\s*(\d+)$') {
        $lo = [int]$matches[1]
        $hi = [int]$matches[2]
        if ($lo -gt $hi) { $lo, $hi = $hi, $lo }
        $result += $lo..$hi
      } else {
        # A dynamic keyword: no fixed port to compare, so it cannot be judged here.
        $script:UnparsedLocalPorts[$entry] = $true
      }
    }
  }
  return $result
}

$rules = Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue
$byPort = @{}
foreach ($r in $rules) {
  $filter = $r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
  if (-not $filter) { continue }
  $admitsAny = Test-AdmitsAnyProgram $r
  $action = [string]$r.Action

  # Summarise wildcard-port rules once instead of counting each against every port.
  if (Test-IsWildcardPort ([string]$filter.LocalPort).Trim()) {
    if ($admitsAny) {
      if ($action -match '^(Allow|Permitir)$') { $script:ScopedWildcardAllow++ }
      elseif ($action -match '^(Block|Bloquear)$') { $script:ScopedWildcardBlock++ }
    }
    continue
  }

  foreach ($port in (Get-PortsFromLocalPort $filter.LocalPort)) {
    if ($Ports -contains $port) {
      $byPort[$port] += ,@($r.DisplayName, $action, $admitsAny)
    }
  }
}

$exposed = @()
$rows = foreach ($port in $Ports) {
  $hits = if ($byPort.ContainsKey($port)) { $byPort[$port] } else { @() }
  $admitsAny = @($hits | Where-Object { $_[2] })
  $allBlocks = @($admitsAny | Where-Object { $_[1] -match '^(Block|Bloquear)$' })
  $anyAllows = @($admitsAny | Where-Object { $_[1] -match '^(Allow|Permitir)$' })
  # A program-scoped rule on our exact port is still worth surfacing: it cannot expose
  # our listener today, but it would if that program changed.
  $scopedAllows = @($hits | Where-Object { -not $_[2] -and $_[1] -match '^(Allow|Permitir)$' })

  # A Block rule denies traffic regardless of a lower-priority Allow, so it wins.
  # Previously Allow was checked first, which reported every port as exposed even
  # with an explicit Block in place.
  $verdict = if ($allBlocks.Count -gt 0) {
    if ($anyAllows.Count -gt 0) { "blocked (allow rule also present)" } else { "blocked" }
  } elseif ($anyAllows.Count -gt 0) {
    "EXPOSED (allow rule)"
  } elseif ($defaultAllows) {
    "EXPOSED (profile allows)"
  } elseif ($defaultUnknown) {
    "UNVERIFIED (no rule)"
  } else {
    "closed (profile blocks)"
  }
  if ($verdict -like "EXPOSED*" -or $verdict -like "UNVERIFIED*") { $exposed += $port }

  [pscustomobject]@{
    Port     = $port
    Verdict  = $verdict
    Block    = ($allBlocks | ForEach-Object { $_[0] }) -join "; "
    Allow    = ($anyAllows | ForEach-Object { $_[0] }) -join "; "
    ScopeNote = if ($scopedAllows.Count -gt 0) {
      "$($scopedAllows.Count) program-scoped allow(s)"
    } else { "" }
  }
}

# Format-Table -AutoSize drops a column entirely when a neighbouring value is long
# enough to overflow, which silently hid the Block column. Truncating keeps every
# column visible so a blocked port cannot look like it has no block rule.
function Format-Cell {
  param([object]$Value, [int]$Max = 60)
  $text = ([string]$Value)
  if ($text.Length -le $Max) { return $text }
  return $text.Substring(0, $Max - 3) + "..."
}

Write-Host ""
$rows | ForEach-Object {
  [pscustomobject]@{
    Port      = $_.Port
    Verdict   = $_.Verdict
    Block     = (Format-Cell $_.Block)
    Allow     = (Format-Cell $_.Allow)
    ScopeNote = $_.ScopeNote
  }
} | Format-Table -AutoSize | Out-String | Write-Host

if ($script:UnparsedLocalPorts.Count -gt 0) {
  Write-Host ("Note: {0} inbound rule(s) use dynamic port keywords ({1}), which name no fixed" -f `
    $script:UnparsedLocalPorts.Count, (($script:UnparsedLocalPorts.Keys | Sort-Object) -join ", ")) -ForegroundColor Yellow
  Write-Host "port and cannot be judged against this list. They match only the dynamic RPC ports," -ForegroundColor Yellow
  Write-Host "not 3000/4100/4101-4110, so they do not affect the verdicts above." -ForegroundColor Yellow
  Write-Host ""
}

if ($script:ScopedWildcardAllow -gt 0) {
  Write-Host ("Note: {0} inbound allow rule(s) listen on all ports but are pinned to one program" -f `
    $script:ScopedWildcardAllow) -ForegroundColor Yellow
  Write-Host "(Wi-Fi Direct, Connected Devices Platform, and similar). None can admit traffic" -ForegroundColor Yellow
  Write-Host "for node.exe or opencode.exe, so they cannot expose these ports. They are excluded" -ForegroundColor Yellow
  Write-Host "from the verdicts above deliberately." -ForegroundColor Yellow
  Write-Host ""
}

if ($exposed.Count -gt 0) {
  $confirmed = @($rows | Where-Object { $_.Verdict -like "EXPOSED*" })
  if ($confirmed.Count -gt 0) {
    $confirmed | Select-Object Port, Verdict | Format-Table -AutoSize | Out-String | Write-Host
    $names = ($confirmed | Select-Object -ExpandProperty Port) -join ", "
    Write-Warning "$($confirmed.Count) port(s) are reachable from the LAN: $names"
    Write-Host "An Allow rule here admits arbitrary programs on that port, and no Block" -ForegroundColor Yellow
    Write-Host "rule overrides it. Fix with: .\scripts\firewall-block-lan.ps1" -ForegroundColor Yellow
  }

  $unverified = @($rows | Where-Object { $_.Verdict -like "UNVERIFIED*" } | Select-Object -ExpandProperty Port)
  if ($unverified.Count -gt 0) {
    Write-Host ""
    Write-Host "$($unverified.Count) port(s) have no matching rule: $($unverified -join ', ')" -ForegroundColor Yellow
    Write-Host "Not provably open, and not provably closed. To settle it, from another" -ForegroundColor Yellow
    Write-Host "machine on the LAN:" -ForegroundColor Yellow
    Write-Host "    Test-NetConnection <this-host-ip> -Port 4100" -ForegroundColor Yellow
    Write-Host "or add explicit block rules so the answer no longer depends on the" -ForegroundColor Yellow
    Write-Host "profile default:" -ForegroundColor Yellow
    Write-Host "    .\scripts\firewall-block-lan.ps1" -ForegroundColor Yellow
  }
  exit 1
}

Write-Host "All expected ports are LAN-blocked by an explicit rule." -ForegroundColor Green
exit 0
