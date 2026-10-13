<#
.SYNOPSIS
  Run an admin CLI against the live database in the Docker named volume.

.DESCRIPTION
  With DEPLOYMENT=docker the database is inside a named volume that the host
  cannot see, so `pnpm auth:reset-password` on the host would edit a dead file
  and report success. This wraps the docker compose exec that actually reaches
  it, and passes a TTY through, which the password and code prompts require.

  The container image has no pnpm, so it invokes the package scripts through
  npm instead. That is also why the command looks different from the host one.

.PARAMETER Command
  Command name, with either spelling: auth-setup / auth:setup / setup.
  Run with -List to see them.

.EXAMPLE
  .\scripts\auth.ps1 check-totp
  .\scripts\auth.ps1 enable-totp
  .\scripts\auth.ps1 sessions --all
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string] $Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Rest,

  [switch] $List
)

$ErrorActionPreference = 'Stop'

# Accepts auth-setup, auth:setup or setup.
$Normalise = {
  param([string] $Name)
  $n = $Name.Trim().ToLowerInvariant()
  if ($n -match '^auth[-:]') { return 'auth:' + $n.Substring(5) }
  if ($n -match '^project[-:]') { return 'project:' + $n.Substring(8) }
  return $n
}

$Known = @(
  'auth:setup',
  'auth:reset-password',
  'auth:enable-totp',
  'auth:check-totp',
  'auth:disable-totp',
  'auth:sessions',
  'project:add'
)

if ($List -or -not $Command) {
  Write-Host ''
  Write-Host 'Admin commands (run against the live database in the Docker volume):' -ForegroundColor Cyan
  foreach ($k in $Known) { Write-Host "  .\scripts\auth.ps1 $($k -replace ':','-')" }
  Write-Host ''
  Write-Host 'Run with -List for this help. Extra arguments are passed through, e.g.:' -ForegroundColor DarkGray
  Write-Host '  .\scripts\auth.ps1 sessions --all' -ForegroundColor DarkGray
  Write-Host ''
  exit 0
}

$script = & $Normalise $Command

if ($script -notin $Known) {
  Write-Error "Unknown command '$Command'. Known: $($Known -join ', ')"
  Write-Error "Run .\scripts\auth.ps1 -List for the list."
  exit 1
}

# Fail early and clearly rather than letting docker emit something cryptic if the
# gateway is not up: without a running container the volume is not attached to
# anything, and `exec` would fail with a name-resolution error that looks like a
# compose problem.
$running = docker compose ps --status running --quiet 2>$null
if (-not $running) {
  Write-Error 'The gateway container is not running, so there is no database to talk to.'
  Write-Error 'Start it first:  docker compose up -d'
  exit 1
}

# No -T: the prompts need a TTY, and omitting it is what makes readHidden work.
& docker compose exec gateway npm --prefix apps/api run $script @Rest
exit $LASTEXITCODE
