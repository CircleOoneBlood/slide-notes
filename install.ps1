# Install a downloaded source release on Windows without administrator rights.
# Requires Python 3.12+ and an internet connection for Python dependencies.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-CheckedPython {
    param([string[]] $PythonArguments)
    $prefix = $script:PythonPrefix
    & $script:PythonCommand @prefix @PythonArguments
    if ($LASTEXITCODE -ne 0) { throw "Python exited with code $LASTEXITCODE" }
}

if ($env:SLIDE_NOTES_PYTHON) {
    $PythonCommand = $env:SLIDE_NOTES_PYTHON
    $PythonPrefix = @()
} elseif (Get-Command py.exe -ErrorAction SilentlyContinue) {
    $PythonCommand = (Get-Command py.exe).Source
    $PythonPrefix = @('-3')
} elseif (Get-Command python.exe -ErrorAction SilentlyContinue) {
    $PythonCommand = (Get-Command python.exe).Source
    $PythonPrefix = @()
} else {
    throw 'Install Python 3.12+ from python.org, then run this installer again.'
}
Invoke-CheckedPython -PythonArguments @('-c', 'import sys; sys.exit(''Slide Notes requires Python 3.12+'') if sys.version_info < (3,12) else None')

$SourceDirectory = $PSScriptRoot
if ($env:SLIDE_NOTES_INSTALL_DIR) {
    $AppDirectory = [System.IO.Path]::GetFullPath($env:SLIDE_NOTES_INSTALL_DIR)
} else {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is missing; set SLIDE_NOTES_INSTALL_DIR.' }
    $AppDirectory = Join-Path $env:LOCALAPPDATA 'SlideNotes\app'
}
if ($env:SLIDE_NOTES_BIN_DIR) {
    $BinDirectory = [System.IO.Path]::GetFullPath($env:SLIDE_NOTES_BIN_DIR)
} else {
    $BinDirectory = Join-Path (Split-Path $AppDirectory -Parent) 'bin'
}
$VenvPython = Join-Path $AppDirectory 'Scripts\python.exe'
$OwnerFile = Join-Path $AppDirectory '.slide-notes-install.json'
if (Test-Path -LiteralPath $AppDirectory) {
    $existing = Get-Item -LiteralPath $AppDirectory -Force
    if (-not $existing.PSIsContainer -or ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Existing path was not overwritten: $AppDirectory"
    }
    $owned = $false
    if (Test-Path -LiteralPath $OwnerFile) {
        $marker = Get-Item -LiteralPath $OwnerFile -Force
        if ($marker.PSIsContainer -or ($marker.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "Existing marker was not overwritten: $OwnerFile"
        }
        try { $owned = (Get-Content -LiteralPath $OwnerFile -Raw | ConvertFrom-Json).application -eq 'slide-notes' } catch { $owned = $false }
    } elseif (-not (Get-ChildItem -LiteralPath $AppDirectory -Force | Select-Object -First 1)) {
        $owned = $true
    } elseif (Test-Path -LiteralPath $VenvPython -PathType Leaf) {
        & $VenvPython -I -c 'import importlib.metadata; importlib.metadata.version(''slide-notes-local'')' 2>$null
        $owned = $LASTEXITCODE -eq 0
    }
    if (-not $owned) { throw "Existing directory does not belong to Slide Notes: $AppDirectory" }
}
[System.IO.Directory]::CreateDirectory($AppDirectory) | Out-Null
[System.IO.Directory]::CreateDirectory($BinDirectory) | Out-Null
if (-not (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
    Invoke-CheckedPython -PythonArguments @('-m', 'venv', $AppDirectory)
}
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OwnerFile, '{"application":"slide-notes","format":1}' + "`n", $Utf8)
& $VenvPython -c 'import sys; sys.exit(''Existing environment requires Python 3.12+; choose a new SLIDE_NOTES_INSTALL_DIR'') if sys.version_info < (3,12) else None'
if ($LASTEXITCODE -ne 0) { throw 'The existing Python environment is incompatible.' }
& $VenvPython -m pip install --disable-pip-version-check --upgrade $SourceDirectory
if ($LASTEXITCODE -ne 0) { throw 'Installing Python dependencies failed; correct the error and rerun install.ps1.' }

# Optional command wrappers are installed in a private bin directory. We never
# modify PATH automatically and preserve existing unrelated commands.
$ManagedWrapper = '# Slide Notes managed launcher v1'
$commands = @{'slide-notes' = 'slide_notes.launcher'; 'slide-notes-agent' = 'slide_notes.cli'}
foreach ($command in $commands.Keys) {
    $wrapper = Join-Path $BinDirectory ($command + '.ps1')
    if (Test-Path -LiteralPath $wrapper) {
        $existing = Get-Item -LiteralPath $wrapper -Force
        if ($existing.PSIsContainer -or ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or -not ((Get-Content -LiteralPath $wrapper -Raw).Contains($ManagedWrapper))) {
            Write-Warning "Existing command was not overwritten: $wrapper"
            continue
        }
    }
    $quotedPython = "'" + $VenvPython.Replace("'", "''") + "'"
    $contents = "$ManagedWrapper`r`n& $quotedPython -m $($commands[$command]) @args`r`nexit `$LASTEXITCODE`r`n"
    # The BOM also makes non-ASCII paths work in Windows PowerShell 5.1.
    [System.IO.File]::WriteAllText($wrapper, $contents, (New-Object System.Text.UTF8Encoding($true)))
}
& $VenvPython -m slide_notes.launcher desktop install
if ($LASTEXITCODE -ne 0) { throw 'The package was installed, but creating the Start Menu shortcut failed.' }
Write-Host "`nInstalled. Open Slide Notes from the Start Menu."
Write-Host "CLI executables: $(Join-Path $AppDirectory 'Scripts')"
Write-Host 'Notes remain in the Workspaces you choose.'
