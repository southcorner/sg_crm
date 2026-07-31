<#
.SYNOPSIS
    Install (or remove) SG CRM as a Windows service using NSSM.

.DESCRIPTION
    SG CRM is one long-lived Node process: it serves the API and the built
    client, runs the node-cron schedulers and holds the WhatsApp session. It
    therefore has to be up whenever the machine is up, and it has to come back
    by itself after a crash or a reboot. NSSM does exactly that and nothing else.

    This script:
      * checks NSSM is available (and tells you how to get it if not)
      * finds node.exe (or takes -NodeExe)
      * installs the service running  node server\src\index.js  with
        AppDirectory = the repo root
      * sets NODE_ENV=production and ENABLE_CRON=true in the service environment
      * configures crash auto-restart (delay + throttle so a boot-loop backs off)
      * redirects stdout/stderr to data\logs\service-out.log / service-err.log
        with NSSM's own size-based rotation
      * starts the service and prints its status

    Run it from an ELEVATED PowerShell. It is idempotent: run it again after a
    code update or an .env change to re-apply the configuration.

    NOTE: the app also writes its own data\logs\app.log (rotated in-process by
    server\src\logger.js). service-out.log is the raw stdout NSSM captures -
    same lines, different rotation owner. Neither rotates the other's files.

.PARAMETER ServiceName
    Windows service name. Default SgCrm.

.PARAMETER RepoDir
    Repo root. Defaults to the parent of this script (normally C:\sg_crm).

.PARAMETER NodeExe
    Full path to node.exe. Autodetected from PATH / Program Files if omitted.

.PARAMETER Port
    Port to force in the service environment. Omit to let .env / the default
    (3000) decide.

.PARAMETER NssmExe
    Full path to nssm.exe. Autodetected from PATH / choco / Program Files.

.PARAMETER Uninstall
    Stop and remove the service, then exit. Nothing under data\ is touched.

.PARAMETER NoStart
    Configure the service but do not start it.

.EXAMPLE
    # install + start (elevated)
    powershell -ExecutionPolicy Bypass -File C:\sg_crm\scripts\install-service.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File C:\sg_crm\scripts\install-service.ps1 -Uninstall

.NOTES
    Day-to-day usage once installed
    -------------------------------
      nssm start   SgCrm
      nssm stop    SgCrm
      nssm restart SgCrm
      nssm status  SgCrm
      nssm edit    SgCrm            # GUI for every setting below

    Native equivalents (no nssm.exe needed):
      sc.exe query SgCrm
      net start SgCrm  /  net stop SgCrm
      Get-Service SgCrm | Format-List *

    Logs:
      Get-Content C:\sg_crm\data\logs\service-out.log -Tail 50 -Wait
      Get-Content C:\sg_crm\data\logs\app.log         -Tail 50 -Wait

    After a code update:  git pull; npm install; npm run build; nssm restart SgCrm
    After a Node upgrade: npm rebuild better-sqlite3; nssm restart SgCrm
#>

[CmdletBinding()]
param(
    [string] $ServiceName = 'SgCrm',
    [string] $RepoDir,
    [string] $NodeExe,
    [string] $NssmExe,
    [int]    $Port = 0,
    [switch] $Uninstall,
    [switch] $NoStart
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $RepoDir) { $RepoDir = Split-Path -Parent $ScriptDir }
$RepoDir    = (Resolve-Path $RepoDir).Path
$EntryPoint = Join-Path $RepoDir 'server\src\index.js'
$LogDir     = Join-Path $RepoDir 'data\logs'
$OutLog     = Join-Path $LogDir 'service-out.log'
$ErrLog     = Join-Path $LogDir 'service-err.log'

# --- log rotation (NSSM, for the redirected stdout/stderr only) -------------
$RotateBytes   = 10MB   # roll once a file passes this
$RotateSeconds = 86400  # ...or once a day, whichever comes first

# --- crash handling ---------------------------------------------------------
$RestartDelayMs  = 5000    # wait this long before restarting a crashed process
$ThrottleMs      = 15000   # a process that dies inside this window counts as a
                           # boot loop; NSSM then backs off instead of spinning

function Assert-Admin {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'This script must be run from an elevated PowerShell (Run as Administrator).'
    }
}

function Resolve-Nssm {
    if ($NssmExe) {
        if (-not (Test-Path $NssmExe)) { throw "nssm.exe not found at $NssmExe" }
        return $NssmExe
    }
    $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:ChocolateyInstall\bin\nssm.exe",
        'C:\ProgramData\chocolatey\bin\nssm.exe',
        "$env:ProgramFiles\nssm\win64\nssm.exe",
        "$env:ProgramFiles\nssm\nssm.exe",
        (Join-Path $RepoDir 'tools\nssm.exe')
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }

    throw @"
NSSM is not installed (nssm.exe is not on PATH).

Install it one of these ways, then run this script again:

  1. Chocolatey (easiest, puts it on PATH):
         choco install nssm -y

  2. Manual download:
         https://nssm.cc/download   ->   nssm-2.24.zip
         unzip, copy win64\nssm.exe to C:\Windows\System32\
         (or anywhere, and pass -NssmExe "C:\path\to\nssm.exe")

NSSM is a tiny service wrapper: it keeps `node server\src\index.js` running,
restarts it if it dies, and captures its output to a file. Nothing else.
"@
}

function Resolve-Node {
    if ($NodeExe) {
        if (-not (Test-Path $NodeExe)) { throw "node.exe not found at $NodeExe" }
        return $NodeExe
    }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
        if (Test-Path $c) { return $c }
    }
    throw 'node.exe not found. Install Node 22+ from https://nodejs.org, or pass -NodeExe "C:\Program Files\nodejs\node.exe".'
}

function Invoke-Nssm {
    param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Args)
    $output = & $script:Nssm @Args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "nssm $($Args -join ' ') failed (exit $LASTEXITCODE): $output"
    }
    return $output
}

function Test-ServiceExists {
    param([string] $Name)
    $null -ne (Get-Service -Name $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------

Assert-Admin
$script:Nssm = Resolve-Nssm
Write-Host "nssm:  $script:Nssm"

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if ($Uninstall) {
    if (-not (Test-ServiceExists $ServiceName)) {
        Write-Host "Service '$ServiceName' is not installed - nothing to do."
        exit 0
    }
    Write-Host "Stopping '$ServiceName'..."
    & $script:Nssm stop $ServiceName | Out-Null   # already-stopped is not an error worth failing on
    Start-Sleep -Seconds 2
    Invoke-Nssm remove $ServiceName confirm | Out-Null
    Write-Host "Service '$ServiceName' removed. Nothing under data\ was touched."
    exit 0
}

# ---------------------------------------------------------------------------
# Install / re-apply
# ---------------------------------------------------------------------------

if (-not (Test-Path $EntryPoint)) { throw "Entry point not found: $EntryPoint" }
if (-not (Test-Path (Join-Path $RepoDir '.env'))) {
    Write-Warning "No .env at $RepoDir\.env - the server will refuse to start in production without SESSION_SECRET. Copy .env.example to .env first."
}
if (-not (Test-Path (Join-Path $RepoDir 'client\dist\index.html'))) {
    Write-Warning "client\dist is missing - run 'npm run build' or the service will serve the API only."
}
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$node = Resolve-Node
Write-Host "node:  $node"
Write-Host "repo:  $RepoDir"

if (Test-ServiceExists $ServiceName) {
    Write-Host "Service '$ServiceName' already exists - stopping it to re-apply configuration."
    & $script:Nssm stop $ServiceName | Out-Null
    Start-Sleep -Seconds 2
} else {
    Write-Host "Installing service '$ServiceName'..."
    Invoke-Nssm install $ServiceName $node $EntryPoint | Out-Null
}

# --- what to run ------------------------------------------------------------
Invoke-Nssm set $ServiceName Application       $node              | Out-Null
Invoke-Nssm set $ServiceName AppParameters     "`"$EntryPoint`""  | Out-Null
Invoke-Nssm set $ServiceName AppDirectory      $RepoDir           | Out-Null
Invoke-Nssm set $ServiceName DisplayName       'SG CRM'           | Out-Null
Invoke-Nssm set $ServiceName Description       'SG CRM - Zoho Books-backed sales CRM: API, web UI, nightly digests and the WhatsApp session.' | Out-Null
Invoke-Nssm set $ServiceName Start             SERVICE_AUTO_START | Out-Null

# --- environment ------------------------------------------------------------
# Everything else (SESSION_SECRET, SMTP, Zoho) comes from .env, which the app
# loads itself from the repo root. Only the two flags that decide *how* the
# process behaves as a service live here.
$envLines = @('NODE_ENV=production', 'ENABLE_CRON=true')
if ($Port -gt 0) { $envLines += "PORT=$Port" }
Invoke-Nssm set $ServiceName AppEnvironmentExtra ($envLines -join ' ') | Out-Null

# --- crash handling ---------------------------------------------------------
Invoke-Nssm set $ServiceName AppExit Default Restart      | Out-Null
Invoke-Nssm set $ServiceName AppRestartDelay $RestartDelayMs | Out-Null
Invoke-Nssm set $ServiceName AppThrottle     $ThrottleMs     | Out-Null
# graceful stop: Ctrl-C first (the app closes the DB and the WhatsApp browser),
# then WM_CLOSE, then terminate. 20 s is the app's own shutdown timeout.
Invoke-Nssm set $ServiceName AppStopMethodSkip     0     | Out-Null
Invoke-Nssm set $ServiceName AppStopMethodConsole  20000 | Out-Null
Invoke-Nssm set $ServiceName AppStopMethodWindow   5000  | Out-Null
Invoke-Nssm set $ServiceName AppStopMethodThreads  5000  | Out-Null
Invoke-Nssm set $ServiceName AppKillProcessTree    1     | Out-Null   # take Chromium with it

# --- logging ----------------------------------------------------------------
Invoke-Nssm set $ServiceName AppStdout $OutLog | Out-Null
Invoke-Nssm set $ServiceName AppStderr $ErrLog | Out-Null
Invoke-Nssm set $ServiceName AppStdoutCreationDisposition 4 | Out-Null  # append
Invoke-Nssm set $ServiceName AppStderrCreationDisposition 4 | Out-Null
Invoke-Nssm set $ServiceName AppRotateFiles   1              | Out-Null
Invoke-Nssm set $ServiceName AppRotateOnline  1              | Out-Null  # rotate without a restart
Invoke-Nssm set $ServiceName AppRotateSeconds $RotateSeconds | Out-Null
Invoke-Nssm set $ServiceName AppRotateBytes   $RotateBytes   | Out-Null

Write-Host ''
Write-Host "Configured '$ServiceName':"
Write-Host "  command      $node `"$EntryPoint`""
Write-Host "  working dir  $RepoDir"
Write-Host "  environment  $($envLines -join '  ')"
Write-Host "  restart      after $($RestartDelayMs / 1000)s, throttled below $($ThrottleMs / 1000)s uptime"
Write-Host "  stdout       $OutLog"
Write-Host "  stderr       $ErrLog"
Write-Host "  rotation     every $RotateSeconds s or $([math]::Round($RotateBytes / 1MB)) MB"

if ($NoStart) {
    Write-Host ''
    Write-Host "Not starting (-NoStart). When ready:  nssm start $ServiceName"
    exit 0
}

Write-Host ''
Write-Host "Starting '$ServiceName'..."
Invoke-Nssm start $ServiceName | Out-Null
Start-Sleep -Seconds 3
$status = & $script:Nssm status $ServiceName
Write-Host "Status: $status"

if ($status -notmatch 'SERVICE_RUNNING') {
    Write-Warning "The service did not reach SERVICE_RUNNING. Check $ErrLog - the usual cause is a missing SESSION_SECRET in .env or the port already being in use."
    exit 1
}

$url = if ($Port -gt 0) { "http://localhost:$Port" } else { 'http://localhost:3000' }
Write-Host ''
Write-Host "SG CRM is running - open $url"
Write-Host "Tail the log with:  Get-Content `"$OutLog`" -Tail 50 -Wait"
