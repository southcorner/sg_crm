<#
.SYNOPSIS
    Nightly hot backup of the SG CRM SQLite database.

.DESCRIPTION
    Runs `VACUUM INTO` through the server's own better-sqlite3 (no sqlite3.exe
    needed, and safe while the service is running and writing), verifies the
    copy with integrity_check, keeps the newest -Keep backups under
    data\backups\ and appends a line to data\logs\backup.log.

    The heavy lifting lives in server\scripts\backup-db.js; this wrapper exists
    so Task Scheduler has one thing to call and one place that logs.

.PARAMETER Keep
    How many backups to retain. Default 14 (two weeks of nightly copies).

.PARAMETER BackupDir
    Where backups go. Default <repo>\data\backups.

.PARAMETER DbPath
    Database to back up. Default <repo>\data\crm.db.

.PARAMETER RegisterTask
    Register a Scheduled Task ("SG CRM nightly backup") that runs this script
    every day at -At (default 01:00) as SYSTEM, then exit. Needs an elevated
    shell. Use -UnregisterTask to remove it.

.PARAMETER At
    Time of day for -RegisterTask, HH:mm. Default 01:00.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File C:\sg_crm\scripts\backup-db.ps1

.EXAMPLE
    # one-off: keep 30 copies somewhere else
    .\backup-db.ps1 -Keep 30 -BackupDir D:\crm-backups

.EXAMPLE
    # install the nightly 01:00 job (elevated PowerShell)
    .\backup-db.ps1 -RegisterTask
    .\backup-db.ps1 -RegisterTask -At 02:30
    .\backup-db.ps1 -UnregisterTask

.NOTES
    Restore = stop the service, replace data\crm.db with a backup copy, delete
    any leftover crm.db-wal / crm.db-shm, start the service. A VACUUM INTO copy
    is a complete standalone database; it needs no WAL file.
#>

[CmdletBinding()]
param(
    [int]    $Keep = 14,
    [string] $BackupDir,
    [string] $DbPath,
    [string] $NodeExe,
    [switch] $RegisterTask,
    [switch] $UnregisterTask,
    [string] $At = '01:00',
    [string] $TaskName = 'SG CRM nightly backup'
)

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir    = Split-Path -Parent $ScriptDir
$NodeScript = Join-Path $RepoDir 'server\scripts\backup-db.js'
$LogDir     = Join-Path $RepoDir 'data\logs'
$LogFile    = Join-Path $LogDir 'backup.log'

function Write-Log {
    param([string] $Message, [string] $Level = 'INFO')
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    Add-Content -Path $LogFile -Value $line -Encoding utf8
    if ($Level -eq 'ERROR') { Write-Host $line -ForegroundColor Red } else { Write-Host $line }
}

function Resolve-NodeExe {
    if ($NodeExe) {
        if (-not (Test-Path $NodeExe)) { throw "node.exe not found at $NodeExe" }
        return $NodeExe
    }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'node.exe is not on PATH. Install Node 22+ or pass -NodeExe "C:\Program Files\nodejs\node.exe".'
}

# ---------------------------------------------------------------------------
# Scheduled task registration
# ---------------------------------------------------------------------------
# Equivalent one-liner if you would rather not use the switch (elevated shell):
#
#   schtasks /Create /TN "SG CRM nightly backup" /SC DAILY /ST 01:00 /RU SYSTEM /RL HIGHEST /F ^
#     /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\sg_crm\scripts\backup-db.ps1"
#
#   schtasks /Run    /TN "SG CRM nightly backup"     # test it now
#   schtasks /Query  /TN "SG CRM nightly backup" /V /FO LIST
#   schtasks /Delete /TN "SG CRM nightly backup" /F

if ($UnregisterTask) {
    schtasks /Delete /TN "$TaskName" /F
    if ($LASTEXITCODE -ne 0) { throw "schtasks /Delete failed with exit code $LASTEXITCODE" }
    Write-Log "scheduled task '$TaskName' removed"
    exit 0
}

if ($RegisterTask) {
    if ($At -notmatch '^([01]?\d|2[0-3]):[0-5]\d$') { throw "-At must look like HH:mm, got '$At'" }
    $self   = Join-Path $ScriptDir 'backup-db.ps1'
    $action = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" -Keep $Keep"
    schtasks /Create /TN "$TaskName" /SC DAILY /ST $At /RU SYSTEM /RL HIGHEST /F /TR "$action"
    if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed with exit code $LASTEXITCODE" }
    Write-Log "scheduled task '$TaskName' registered for $At daily (keep $Keep)"
    Write-Host ''
    Write-Host "Run it once now to prove it works:  schtasks /Run /TN `"$TaskName`""
    exit 0
}

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------

try {
    if (-not (Test-Path $NodeScript)) { throw "missing $NodeScript" }
    $node = Resolve-NodeExe

    $nodeArgs = @($NodeScript, '--json', '--keep', $Keep)
    if ($BackupDir) { $nodeArgs += @('--out', $BackupDir) }
    if ($DbPath)    { $nodeArgs += @('--db',  $DbPath) }

    Push-Location $RepoDir
    try {
        $output = & $node @nodeArgs
        $exit = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($exit -ne 0) { throw "backup-db.js exited with code $exit : $output" }

    $result = $output | Select-Object -Last 1 | ConvertFrom-Json
    $sizeMb = [math]::Round($result.bytes / 1MB, 2)
    $prunedNote = ''
    if ($result.pruned -and @($result.pruned).Count -gt 0) {
        $prunedNote = '  pruned ' + (@($result.pruned) -join ',')
    }
    Write-Log ('ok  {0}  {1} MB  {2} tables  integrity {3}  {4} ms  kept {5}/{6}{7}' -f `
        (Split-Path -Leaf $result.file), $sizeMb, $result.tables, $result.integrity, `
        $result.elapsedMs, $result.remaining, $result.keep, $prunedNote)
    exit 0
}
catch {
    Write-Log "backup FAILED: $($_.Exception.Message)" 'ERROR'
    exit 1
}
