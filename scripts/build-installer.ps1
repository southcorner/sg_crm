<#
.SYNOPSIS
    Build dist-installer\sg_crm-setup.exe: one self-extracting file that
    installs or patches SG CRM on the live server.

.DESCRIPTION
    Runs on the BUILD machine (a normal checkout of this repo). It:

      1. builds the client (npm run build) unless -SkipBuild
      2. stages every git-tracked file plus client\dist into a temp tree
      3. zips that tree into payload.zip
      4. writes version.txt (git short hash + build date)
      5. generates an IExpress .SED file and runs iexpress.exe /N on it

    IExpress ships with Windows, so there is no toolchain to install. Note that
    IExpress flattens its file list -- it cannot carry a directory tree -- which
    is why the app is shipped as a single payload.zip that install.ps1 expands.

    The resulting exe contains install.cmd, install.ps1, payload.zip and
    version.txt. Running it extracts those to a temp folder and runs install.cmd.

.PARAMETER OutDir
    Where the exe goes. Default <repo>\dist-installer (gitignored).

.PARAMETER SkipBuild
    Reuse the existing client\dist instead of running npm run build.

.PARAMETER KeepStaging
    Leave the staging folder behind for inspection.

.PARAMETER IExpressExe
    Path to iexpress.exe. Autodetected from PATH / System32 / SysNative.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File C:\sg_crm\scripts\build-installer.ps1

.NOTES
    ASCII ONLY in this file and in everything it writes. The .SED must be ANSI
    for IExpress, and Windows PowerShell 5.1 mis-decodes a BOM-less UTF-8 .ps1.
#>

[CmdletBinding()]
param(
    [string] $OutDir,
    [switch] $SkipBuild,
    [switch] $KeepStaging,
    [string] $IExpressExe
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir   = Split-Path -Parent $ScriptDir
$InstallerSrc = Join-Path $ScriptDir 'installer'
if (-not $OutDir) { $OutDir = Join-Path $RepoDir 'dist-installer' }

$ExeName = 'sg_crm-setup.exe'

function Write-Step {
    param([string] $Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
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
    Run a native exe and hand back its output.

    Windows PowerShell 5.1 turns ANY stderr write from a native command into a
    NativeCommandError, which $ErrorActionPreference='Stop' then makes fatal.
    vite prints its chunk-size hint on stderr and npm warns constantly, so a
    perfectly successful build would otherwise abort this script. Exit codes are
    the only honest signal, so that is what gets checked.
#>
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)] [string] $Exe,
        [string[]] $Arguments = @(),
        [string] $What = 'command',
        [switch] $Quiet
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if (-not $Quiet -and $out) { Write-NativeOutput $out }
    if ($code -ne 0) {
        if ($Quiet -and $out) { Write-NativeOutput $out }
        throw "$What failed with exit code $code"
    }
    return $out
}

function Resolve-IExpress {
    if ($IExpressExe) {
        if (-not (Test-Path $IExpressExe)) { throw "iexpress.exe not found at $IExpressExe" }
        return $IExpressExe
    }
    $cmd = Get-Command iexpress.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @("$env:WINDIR\System32\iexpress.exe", "$env:WINDIR\SysNative\iexpress.exe")) {
        if (Test-Path $c) { return $c }
    }
    throw 'iexpress.exe was not found. It ships with Windows; check C:\Windows\System32\iexpress.exe.'
}

# ---------------------------------------------------------------------------

Push-Location $RepoDir
try {
    $iexpress = Resolve-IExpress
    Write-Host "repo      : $RepoDir"
    Write-Host "iexpress  : $iexpress"

    # --- version --------------------------------------------------------------
    $shortHash = ((Invoke-Native -Exe 'git' -Arguments @('rev-parse', '--short', 'HEAD') -What 'git rev-parse' -Quiet) | Select-Object -First 1).ToString().Trim()
    $dirty = Invoke-Native -Exe 'git' -Arguments @('status', '--porcelain') -What 'git status' -Quiet
    $suffix = if ($dirty) { '-dirty' } else { '' }
    $version = "{0}+{1}{2}" -f (Get-Date -Format 'yyyy-MM-dd'), $shortHash, $suffix
    Write-Host "version   : $version"

    # --- 1. build the client --------------------------------------------------
    if ($SkipBuild) {
        Write-Step 'Skipping the client build (-SkipBuild)'
    } else {
        Write-Step 'Building the client (npm run build)'
        Invoke-Native -Exe 'npm.cmd' -Arguments @('run', 'build') -What 'npm run build' | Out-Null
    }
    $distIndex = Join-Path $RepoDir 'client\dist\index.html'
    if (-not (Test-Path $distIndex)) {
        throw "client\dist\index.html is missing. Run without -SkipBuild."
    }

    # --- 2. stage -------------------------------------------------------------
    Write-Step 'Staging the payload'
    $work = Join-Path $env:TEMP ("sgcrm-build-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    $stage = Join-Path $work 'app'      # becomes payload.zip
    $flat  = Join-Path $work 'flat'     # the four files IExpress carries
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    New-Item -ItemType Directory -Path $flat  -Force | Out-Null

    # every git-tracked file, structure preserved
    $tracked = @(Invoke-Native -Exe 'git' -Arguments @('ls-files') -What 'git ls-files (is this a git checkout?)' -Quiet)
    foreach ($rel in $tracked) {
        if (-not $rel) { continue }
        $src = Join-Path $RepoDir $rel
        if (-not (Test-Path $src)) { continue }   # deleted but still in the index
        $dst = Join-Path $stage ($rel -replace '/', '\')
        $dstDir = Split-Path -Parent $dst
        if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
        Copy-Item $src $dst -Force
    }
    Write-Host "    $($tracked.Count) tracked files staged"

    # the built client, which is gitignored on purpose
    $distStage = Join-Path $stage 'client\dist'
    New-Item -ItemType Directory -Path $distStage -Force | Out-Null
    Copy-Item (Join-Path $RepoDir 'client\dist\*') $distStage -Recurse -Force
    $distCount = (Get-ChildItem $distStage -Recurse -File).Count
    Write-Host "    $distCount client\dist files staged"

    # paranoia: these must never travel with a release
    foreach ($forbidden in @('.env', 'data', 'node_modules', 'dist-installer')) {
        $p = Join-Path $stage $forbidden
        if (Test-Path $p) {
            Remove-Item $p -Recurse -Force
            Write-Host "    removed $forbidden from the staging tree"
        }
    }

    # --- 3. payload.zip + the flat file set -----------------------------------
    Write-Step 'Compressing the payload'
    $payloadZip = Join-Path $flat 'payload.zip'
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $payloadZip -CompressionLevel Optimal -Force
    $zipMb = [math]::Round((Get-Item $payloadZip).Length / 1MB, 2)
    Write-Host "    payload.zip is $zipMb MB"

    Copy-Item (Join-Path $InstallerSrc 'install.cmd') $flat -Force
    Copy-Item (Join-Path $InstallerSrc 'install.ps1') $flat -Force
    Set-Content -Path (Join-Path $flat 'version.txt') -Value $version -Encoding ascii

    # --- 4. the .SED ----------------------------------------------------------
    Write-Step 'Generating the IExpress directive file'
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
    $exePath = Join-Path $OutDir $ExeName
    if (Test-Path $exePath) { Remove-Item $exePath -Force }
    $sedPath = Join-Path $work 'sg_crm-setup.sed'

    $files = @('install.cmd', 'install.ps1', 'payload.zip', 'version.txt')

    $sed = New-Object System.Collections.Generic.List[string]
    $sed.Add('[Version]')
    $sed.Add('Class=IEXPRESS')
    $sed.Add('SEDVersion=3')
    $sed.Add('[Options]')
    $sed.Add('PackagePurpose=InstallApp')
    $sed.Add('ShowInstallProgramWindow=1')   # the operator must see the log
    $sed.Add('HideExtractAnimation=1')
    $sed.Add('UseLongFileName=1')
    $sed.Add('InsideCompressed=0')
    $sed.Add('CAB_FixedSize=0')
    $sed.Add('CAB_ResvCodeSigning=0')
    $sed.Add('RebootMode=N')
    $sed.Add('InstallPrompt=%InstallPrompt%')
    $sed.Add('DisplayLicense=%DisplayLicense%')
    $sed.Add('FinishMessage=%FinishMessage%')
    $sed.Add('TargetName=%TargetName%')
    $sed.Add('FriendlyName=%FriendlyName%')
    $sed.Add('AppLaunched=%AppLaunched%')
    $sed.Add('PostInstallCmd=%PostInstallCmd%')
    $sed.Add('AdminQuietInstCmd=%AdminQuietInstCmd%')
    $sed.Add('UserQuietInstCmd=%UserQuietInstCmd%')
    $sed.Add('SourceFiles=SourceFiles')
    $sed.Add('[Strings]')
    $sed.Add('InstallPrompt=')
    $sed.Add('DisplayLicense=')
    $sed.Add('FinishMessage=')
    $sed.Add("TargetName=$exePath")
    $sed.Add("FriendlyName=SG CRM setup $version")
    # AppLaunched must name a file that is IN the package. "cmd.exe /c install.cmd"
    # builds fine and then silently does nothing at run time; the bare file name
    # is what actually executes.
    $sed.Add('AppLaunched=install.cmd')
    $sed.Add('PostInstallCmd=<None>')
    $sed.Add('AdminQuietInstCmd=')
    $sed.Add('UserQuietInstCmd=')
    for ($i = 0; $i -lt $files.Count; $i++) {
        $sed.Add(("FILE{0}=`"{1}`"" -f $i, $files[$i]))
    }
    $sed.Add('[SourceFiles]')
    $sed.Add("SourceFiles0=$flat")
    $sed.Add('[SourceFiles0]')
    for ($i = 0; $i -lt $files.Count; $i++) {
        $sed.Add(("%FILE{0}%=" -f $i))
    }

    # IExpress reads the .SED as ANSI. ASCII keeps that unambiguous.
    Set-Content -Path $sedPath -Value $sed -Encoding ascii
    Write-Host "    $sedPath"

    # --- 5. build -------------------------------------------------------------
    Write-Step 'Running iexpress'
    # Two things iexpress is fussy about, both learned the hard way:
    #   * it is a GUI-subsystem program, so `& iexpress ...` returns immediately
    #     and $LASTEXITCODE is meaningless -- the process has to be waited on.
    #   * the .SED argument must NOT be quoted. A quoted path makes it exit 1
    #     without building anything and without saying why. Running from the
    #     .SED's own directory and passing the bare file name sidesteps both the
    #     quoting rule and any spaces in the path.
    $sedName = Split-Path -Leaf $sedPath
    $proc = Start-Process -FilePath $iexpress -ArgumentList @('/N', '/Q', $sedName) `
        -WorkingDirectory $work -Wait -PassThru
    $rc = $proc.ExitCode
    if (-not (Test-Path $exePath)) {
        throw ("iexpress finished with exit code $rc but $exePath was not produced. " +
               "Run it interactively to see the dialog: $iexpress /N $sedPath")
    }

    $exeMb = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
    Write-Host ''
    Write-Host "Built $exePath" -ForegroundColor Green
    Write-Host "  version : $version"
    Write-Host "  size    : $exeMb MB"
    Write-Host "  contents: $($files -join ', ')"
    Write-Host ''
    Write-Host 'Copy that one file to the server and run it. It patches in place and'
    Write-Host 'leaves data\, .env and node_modules\ alone.'

    if ($KeepStaging) {
        Write-Host ''
        Write-Host "Staging kept at $work"
    } else {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit 0
}
catch {
    Write-Host ''
    Write-Host "BUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    Pop-Location
}
