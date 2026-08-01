<#
.SYNOPSIS
    SG CRM in-place installer / patcher. Runs on the TARGET machine.

.DESCRIPTION
    This script is bundled into sg_crm-setup.exe by scripts\build-installer.ps1
    and is what the exe actually runs. It is also usable on its own: extract the
    payload next to it and run it directly.

    Steps, in order, each announced on the console:

      1. make sure Node.js >= 22 is installed (winget, else a pinned x64 MSI)
      2. expand payload.zip
      3. copy the app into the target directory, replacing app files but
         NEVER touching data\, .env or node_modules\
      4. on a fresh install, write .env with a freshly generated SESSION_SECRET
      5. npm install --omit=dev  (no-op when nothing changed)
      6. restart the SgCrm service if there is one, otherwise open a terminal
         window running the server

    Database migrations apply themselves when the server boots, so a patch is
    complete once the server is back up.

.PARAMETER TargetDir
    Where to install. Defaults to $env:SGCRM_DIR, then C:\sg_crm.

.PARAMETER PayloadZip
    The payload archive. Defaults to payload.zip next to this script.

.PARAMETER NoLaunch
    Do everything except starting the server. Also settable with SGCRM_NO_LAUNCH=1.

.PARAMETER SelfTest
    Run the internal assertions (Node version parsing) and exit. No side effects.

.NOTES
    ASCII ONLY in this file. Windows PowerShell 5.1 reads a BOM-less .ps1 as
    ANSI, so a UTF-8 em dash decodes into a smart quote that the parser treats
    as a string delimiter.
#>

[CmdletBinding()]
param(
    [string] $TargetDir,
    [string] $PayloadZip,
    [switch] $NoLaunch,
    [switch] $SelfTest
)

$ErrorActionPreference = 'Stop'

# Node fallback when winget is not available. Bump both together.
$NodeMinMajor  = 22
$NodeMsiVersion = '22.11.0'
$NodeMsiUrl    = "https://nodejs.org/dist/v$NodeMsiVersion/node-v$NodeMsiVersion-x64.msi"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Never mirrored over: runtime state, secrets, installed packages, the git
# checkout the live server may still be, and stray build output.
$ExcludeDirs  = @('data', 'node_modules', '.git', 'dist-installer', 'tools')
$ExcludeFiles = @('.env', '*.log')

function Write-Step {
    param([string] $Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Info {
    param([string] $Message)
    Write-Host "    $Message"
}

function Write-Warn {
    param([string] $Message)
    Write-Host "    WARNING: $Message" -ForegroundColor Yellow
}

<#
    Print native output, unwrapping the ErrorRecord that 2>&1 wraps each stderr
    line in - otherwise every one of them renders as the useless string
    "System.Management.Automation.RemoteException".
#>
function Write-NativeOutput {
    param($Lines)
    foreach ($line in @($Lines)) {
        $text = if ($line -is [System.Management.Automation.ErrorRecord]) {
            $line.Exception.Message
        } else {
            [string] $line
        }
        if ($text -and $text.Trim()) { Write-Host "    $($text.TrimEnd())" }
    }
}

<#
    Run a native exe, capture everything it says, and return the exit code in
    $script:LastNativeExit along with the output.

    Windows PowerShell 5.1 turns ANY stderr write from a native command into a
    NativeCommandError, which $ErrorActionPreference='Stop' makes fatal. npm,
    winget and robocopy all use stderr for ordinary chatter, so the preference
    is dropped for the duration and the exit code is what gets judged.
#>
function Invoke-Native {
    param([string] $Exe, [string[]] $Arguments = @())
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @Arguments 2>&1
        $script:LastNativeExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    return $out
}

# ---------------------------------------------------------------------------
# Node detection
# ---------------------------------------------------------------------------

<#
    Parse the output of `node --version` ("v22.11.0") and say whether it is new
    enough. Returns $null when the text is not a version at all, which is how a
    missing node.exe looks. Kept as a pure function so -SelfTest can exercise it
    without a Node install to point at.
#>
function Get-NodeMajor {
    param([string] $VersionText)
    if ($null -eq $VersionText) { return $null }
    $m = [regex]::Match($VersionText.Trim(), '^v?(\d+)\.(\d+)\.(\d+)')
    if (-not $m.Success) { return $null }
    return [int] $m.Groups[1].Value
}

function Test-NodeVersionOk {
    param([string] $VersionText, [int] $MinMajor = $NodeMinMajor)
    $major = Get-NodeMajor $VersionText
    if ($null -eq $major) { return $false }
    return $major -ge $MinMajor
}

function Get-InstalledNodeVersion {
    $exe = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $exe) { return $null }
    try {
        $out = & $exe.Source --version 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return ($out | Select-Object -First 1)
    } catch {
        return $null
    }
}

<# Pick up a PATH that an installer just changed, without a new shell. #>
function Update-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-NodeViaWinget {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        Write-Info 'winget is not available on this machine.'
        return $false
    }
    Write-Info 'Installing Node.js LTS with winget (accept the UAC prompt if it appears)...'
    $out = Invoke-Native -Exe $winget.Source -Arguments @(
        'install', 'OpenJS.NodeJS.LTS', '--silent',
        '--accept-package-agreements', '--accept-source-agreements')
    Write-NativeOutput $out
    if ($script:LastNativeExit -ne 0) {
        Write-Warn "winget exited with code $script:LastNativeExit."
        return $false
    }
    return $true
}

function Install-NodeViaMsi {
    $msi = Join-Path $env:TEMP "node-v$NodeMsiVersion-x64.msi"
    Write-Info "Downloading $NodeMsiUrl"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch {
        # older hosts only; TLS 1.2 is already the default on anything current
    }
    Invoke-WebRequest -Uri $NodeMsiUrl -OutFile $msi -UseBasicParsing
    Write-Info "Running msiexec (this needs administrator rights)..."
    # not $args: that is an automatic variable inside a function
    $msiArgs = @('/i', "`"$msi`"", '/qn', '/norestart')
    if (Test-IsAdmin) {
        $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru
    } else {
        $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Verb RunAs -Wait -PassThru
    }
    if ($p.ExitCode -ne 0) {
        throw "msiexec failed with exit code $($p.ExitCode) installing Node $NodeMsiVersion."
    }
    return $true
}

function Ensure-Node {
    $current = Get-InstalledNodeVersion
    if (Test-NodeVersionOk $current) {
        Write-Info "Node $current is installed and new enough (need >= $NodeMinMajor)."
        return
    }

    if ($null -eq $current) {
        Write-Info "Node.js was not found on PATH."
    } else {
        Write-Info "Node $current is too old (need >= $NodeMinMajor)."
    }

    if (-not (Install-NodeViaWinget)) {
        Write-Info 'Falling back to the pinned Node MSI.'
        Install-NodeViaMsi | Out-Null
    }

    Update-ProcessPath
    $current = Get-InstalledNodeVersion
    if (-not (Test-NodeVersionOk $current)) {
        throw ("Node.js is still not usable after the install attempt " +
               "(node --version reported '$current'). Install Node $NodeMinMajor or newer " +
               "from https://nodejs.org and run this setup again.")
    }
    Write-Info "Node $current is now installed."
}

# ---------------------------------------------------------------------------
# Self test
# ---------------------------------------------------------------------------

if ($SelfTest) {
    $cases = @(
        @{ Text = 'v22.11.0';  Ok = $true;  Major = 22 },
        @{ Text = 'v24.15.0';  Ok = $true;  Major = 24 },
        @{ Text = 'v22.0.0';   Ok = $true;  Major = 22 },
        @{ Text = '22.11.0';   Ok = $true;  Major = 22 },
        @{ Text = ' v23.1.0 '; Ok = $true;  Major = 23 },
        @{ Text = 'v21.7.3';   Ok = $false; Major = 21 },
        @{ Text = 'v18.20.4';  Ok = $false; Major = 18 },
        @{ Text = 'v9.11.2';   Ok = $false; Major = 9 },
        @{ Text = 'v100.0.0';  Ok = $true;  Major = 100 },
        @{ Text = '';          Ok = $false; Major = $null },
        @{ Text = $null;       Ok = $false; Major = $null },
        @{ Text = "'node' is not recognized as an internal or external command";
                               Ok = $false; Major = $null }
    )
    $failed = 0
    foreach ($c in $cases) {
        $major = Get-NodeMajor $c.Text
        $ok    = Test-NodeVersionOk $c.Text
        $label = if ($null -eq $c.Text) { '<null>' } elseif ($c.Text -eq '') { '<empty>' } else { $c.Text }
        if ($major -ne $c.Major -or $ok -ne $c.Ok) {
            Write-Host "FAIL  $label -> major=$major ok=$ok (expected major=$($c.Major) ok=$($c.Ok))"
            $failed++
        } else {
            Write-Host "ok    $label -> major=$major ok=$ok"
        }
    }
    if ($failed -gt 0) {
        Write-Host "$failed self-test case(s) failed."
        exit 1
    }
    Write-Host "All $($cases.Count) Node version cases passed."
    exit 0
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

$stagingDir = $null

try {
    if (-not $TargetDir) { $TargetDir = $env:SGCRM_DIR }
    if (-not $TargetDir) { $TargetDir = 'C:\sg_crm' }
    if (-not $PayloadZip) { $PayloadZip = Join-Path $ScriptDir 'payload.zip' }
    if ($env:SGCRM_NO_LAUNCH -eq '1') { $NoLaunch = $true }

    $versionFile = Join-Path $ScriptDir 'version.txt'
    $version = if (Test-Path $versionFile) { (Get-Content $versionFile -First 1).Trim() } else { 'unknown' }

    Write-Host ''
    Write-Host "SG CRM setup" -ForegroundColor Green
    Write-Host "  package version : $version"
    Write-Host "  target directory: $TargetDir"
    Write-Host "  payload         : $PayloadZip"

    if (-not (Test-Path $PayloadZip)) {
        throw "payload.zip was not found at $PayloadZip. The setup package is incomplete."
    }

    # --- 1. Node ------------------------------------------------------------
    Write-Step 'Checking Node.js'
    Ensure-Node

    # --- 2. Payload ---------------------------------------------------------
    Write-Step 'Unpacking the application files'
    $stagingDir = Join-Path $env:TEMP ("sgcrm-payload-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    Expand-Archive -Path $PayloadZip -DestinationPath $stagingDir -Force
    $fileCount = (Get-ChildItem $stagingDir -Recurse -File).Count
    Write-Info "$fileCount files unpacked."

    # --- 3. Copy into place -------------------------------------------------
    $isFresh = -not (Test-Path (Join-Path $TargetDir 'package.json'))
    if ($isFresh) {
        Write-Step "Fresh install into $TargetDir"
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    } else {
        Write-Step "Updating the existing install at $TargetDir"
        Write-Info 'data\, .env and node_modules\ are left untouched.'
    }

    # robocopy /MIR so files deleted upstream also disappear here, with the
    # things that belong to this machine rather than to the release excluded.
    $rcArgs = @($stagingDir, $TargetDir, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:2')
    $rcArgs += '/XD'
    $rcArgs += $ExcludeDirs
    $rcArgs += '/XF'
    $rcArgs += $ExcludeFiles
    $rcOut = Invoke-Native -Exe 'robocopy.exe' -Arguments $rcArgs
    $rc = $script:LastNativeExit
    # robocopy: 0-7 are success codes, 8+ mean at least one file failed
    if ($rc -ge 8) {
        Write-Host ($rcOut | Out-String)
        throw "robocopy failed with exit code $rc copying the application files."
    }
    Write-Info "Application files in place (robocopy status $rc)."
    Copy-Item $versionFile (Join-Path $TargetDir 'VERSION.txt') -Force -ErrorAction SilentlyContinue

    # --- 4. .env ------------------------------------------------------------
    $envPath = Join-Path $TargetDir '.env'
    if (Test-Path $envPath) {
        Write-Step 'Configuration'
        Write-Info '.env already exists and was not modified.'
    } else {
        Write-Step 'Creating .env'
        $bytes = New-Object 'System.Byte[]' 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })

        $examplePath = Join-Path $TargetDir '.env.example'
        if (Test-Path $examplePath) {
            $lines = Get-Content $examplePath
            $lines = $lines | ForEach-Object {
                if ($_ -match '^\s*NODE_ENV\s*=')       { 'NODE_ENV=production' }
                elseif ($_ -match '^\s*SESSION_SECRET\s*=') { "SESSION_SECRET=$secret" }
                else { $_ }
            }
            Set-Content -Path $envPath -Value $lines -Encoding ascii
        } else {
            Set-Content -Path $envPath -Encoding ascii -Value @(
                'NODE_ENV=production',
                'PORT=3000',
                "SESSION_SECRET=$secret",
                'ADMIN_USERNAME=admin',
                'ADMIN_PASSWORD=admin123',
                'ENABLE_CRON=true'
            )
        }
        Write-Info "Wrote $envPath with a freshly generated SESSION_SECRET."
        Write-Host ''
        Write-Host '    !!! The admin account will be created as admin / admin123.' -ForegroundColor Yellow
        Write-Host '    !!! Log in and change it under Settings -> Security straight away.' -ForegroundColor Yellow
    }

    # --- 5. Dependencies ----------------------------------------------------
    Write-Step 'Installing dependencies (npm install --omit=dev)'
    Write-Info 'This is quick when nothing changed, and slow the first time.'
    # $ErrorActionPreference='Stop' turns any stderr write from a native command
    # into a fatal NativeCommandError on Windows PowerShell 5.1, and npm warns on
    # stderr routinely. The exit code is the only trustworthy signal.
    Push-Location $TargetDir
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $npmOut = & npm.cmd install --omit=dev --no-audit --no-fund 2>&1
        $npmRc = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
        Pop-Location
    }
    Write-NativeOutput $npmOut
    if ($npmRc -ne 0) {
        throw "npm install failed with exit code $npmRc in $TargetDir."
    }
    Write-Info 'Dependencies are up to date.'

    # --- 6. Launch ----------------------------------------------------------
    if ($NoLaunch) {
        Write-Step 'Not starting the server (NoLaunch was requested)'
        Write-Info "Start it yourself with:  cd /d $TargetDir && node server\src\index.js"
    } else {
        $svc = Get-Service -Name 'SgCrm' -ErrorAction SilentlyContinue
        if ($svc) {
            Write-Step 'Restarting the SgCrm Windows service'
            $nssm = Get-Command nssm.exe -ErrorAction SilentlyContinue
            if ($nssm -and (Test-IsAdmin)) {
                Invoke-Native -Exe $nssm.Source -Arguments @('restart', 'SgCrm') | Out-Null
            } elseif ($nssm) {
                Start-Process -FilePath $nssm.Source -ArgumentList @('restart', 'SgCrm') -Verb RunAs -Wait
            } else {
                Restart-Service -Name 'SgCrm' -Force
            }
            Start-Sleep -Seconds 2
            $svc = Get-Service -Name 'SgCrm' -ErrorAction SilentlyContinue
            Write-Info "Service SgCrm is now '$($svc.Status)'. The new code is live."
        } else {
            Write-Step 'Starting the server in a new terminal window'
            Write-Info 'No SgCrm service is installed, so the server runs in a window.'
            Write-Info 'Closing that window stops the CRM. To run it as a service instead:'
            Write-Info "  powershell -ExecutionPolicy Bypass -File $TargetDir\scripts\install-service.ps1"

            # The command lives in a .cmd shipped with the app rather than being
            # spelled out here: an inline "cmd /k cd /d ... && set ... && node ..."
            # has to survive PowerShell argument joining AND two levels of cmd
            # quoting, and quietly loses everything after the first && when the
            # path contains spaces. `cmd /c start` also detaches the new window
            # from this process tree, so setup can finish while the server runs.
            $launcher = Join-Path $TargetDir 'scripts\installer\start-server.cmd'
            if (-not (Test-Path $launcher)) {
                throw "Launcher not found at $launcher - the payload is incomplete."
            }
            Start-Process -FilePath 'cmd.exe' `
                -ArgumentList "/c start `"SG CRM server`" `"$launcher`"" `
                -WorkingDirectory $TargetDir
            Start-Sleep -Seconds 3
            Write-Info 'Server window opened.'
        }
    }

    Write-Host ''
    Write-Host "SG CRM $version is deployed to $TargetDir." -ForegroundColor Green
    if (-not $NoLaunch) {
        Write-Host 'Open http://localhost:3000 (or whatever PORT says in .env).'
    }
    exit 0
}
catch {
    Write-Host ''
    Write-Host 'SETUP FAILED' -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ScriptStackTrace) { Write-Host "  at $($_.ScriptStackTrace -split "`n" | Select-Object -First 1)" }
    Write-Host ''
    Write-Host '  Nothing was launched. The existing install, if any, still has its data.'
    exit 1
}
finally {
    if ($stagingDir -and (Test-Path $stagingDir)) {
        Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
