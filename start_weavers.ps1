[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$NoBuild,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Resolve-ProjectPython {
    $candidates = @(
        (Join-Path $Root ".venv\Scripts\python.exe"),
        (Join-Path $Root "venv\Scripts\python.exe")
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return $python.Source
    }

    throw "Python niet gevonden. Maak eerst een virtualenv aan of installeer Python."
}

function Test-FrontendBuildInput {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo]$File
    )

    $frontendRoot = (Resolve-Path (Join-Path $Root "frontend")).Path
    $relativePath = $File.FullName
    if ($relativePath.StartsWith($frontendRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relativePath = $relativePath.Substring($frontendRoot.Length).TrimStart([char[]]@("\", "/"))
    }
    if ($relativePath -match "(^|[\\/])__tests__([\\/]|$)") {
        return $false
    }
    if ($relativePath -match "\.(test|spec)\.[^\\/]+$") {
        return $false
    }
    if ($relativePath -match "(^|[\\/])setupTests\.[^\\/]+$") {
        return $false
    }

    return $true
}

function Get-FrontendBuildState {
    $distIndex = Join-Path $Root "frontend\dist\index.html"
    if (-not (Test-Path $distIndex)) {
        return "missing"
    }

    $distTime = (Get-Item $distIndex).LastWriteTimeUtc
    $frontendRoot = Join-Path $Root "frontend"
    $sourcePaths = @(
        (Join-Path $frontendRoot "index.html"),
        (Join-Path $frontendRoot "package.json"),
        (Join-Path $frontendRoot "package-lock.json"),
        (Join-Path $frontendRoot "vite.config.js")
    )

    $sourceFiles = @()
    foreach ($path in $sourcePaths) {
        if (Test-Path $path) {
            $sourceFiles += Get-Item $path
        }
    }
    if (Test-Path (Join-Path $frontendRoot "src")) {
        $sourceFiles += Get-ChildItem (Join-Path $frontendRoot "src") -Recurse -File | Where-Object { Test-FrontendBuildInput $_ }
    }

    foreach ($file in $sourceFiles) {
        if ($file.LastWriteTimeUtc -gt $distTime) {
            return "stale"
        }
    }

    return "current"
}

function Invoke-FrontendBuild {
    if ($SkipInstall) {
        & (Join-Path $Root "build_frontend.ps1") -SkipInstall
    }
    else {
        & (Join-Path $Root "build_frontend.ps1")
    }
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

function Confirm-FrontendBuild {
    param(
        [Parameter(Mandatory = $true)]
        [string]$State
    )

    if ($NoBuild) {
        return $false
    }

    if ($Build) {
        return $true
    }

    if ($State -eq "current") {
        return $false
    }

    if ($State -eq "missing") {
        Write-Host "Frontend build ontbreekt."
    }
    elseif ($State -eq "stale") {
        Write-Host "Frontend build lijkt verouderd."
    }

    $answer = Read-Host "Nu frontend bouwen en daarna starten? [J/n]"
    return ($answer -eq "" -or $answer -match "^(j|ja|y|yes)$")
}

function Ensure-FrontendBuild {
    $frontendState = Get-FrontendBuildState
    if (Confirm-FrontendBuild $frontendState) {
        Invoke-FrontendBuild
    }
    elseif ($frontendState -eq "missing") {
        Write-Warning "Start zonder frontend build; de web UI toont pas iets nuttigs na een build."
    }
    elseif ($frontendState -eq "stale") {
        Write-Warning "Start met bestaande frontend build; recente frontend source-wijzigingen zitten daar mogelijk niet in."
    }
}

function Start-WeaversServer {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PythonPath
    )

    $appPath = Join-Path $Root "app.py"
    Write-Host "Weavers of Power starten op http://127.0.0.1:8080"
    Write-Host "Druk op 'r' om te herstarten of 'q' om te stoppen."
    return Start-Process -FilePath $PythonPath -ArgumentList @($appPath) -WorkingDirectory $Root -NoNewWindow -PassThru
}

function Stop-WeaversServer {
    param(
        [System.Diagnostics.Process]$Process
    )

    if ($null -eq $Process -or $Process.HasExited) {
        return
    }

    Write-Host "Server stoppen..."
    try {
        $Process.CloseMainWindow() | Out-Null
    }
    catch {
        # Console processes often do not have a main window.
    }

    Start-Sleep -Milliseconds 700
    if (-not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
    try {
        $Process.WaitForExit(5000) | Out-Null
    }
    catch {
        # If the process already disappeared, there is nothing left to wait for.
    }
}

function Test-ConsoleKeyAvailable {
    try {
        return [Console]::KeyAvailable
    }
    catch {
        return $false
    }
}

$python = Resolve-ProjectPython
Write-Host "Python: $python"

Ensure-FrontendBuild

$server = $null
$exitCode = 0

try {
    while ($true) {
        $restartRequested = $false
        $stopRequested = $false
        $server = Start-WeaversServer $python

        while (-not $server.HasExited) {
            Start-Sleep -Milliseconds 200
            if (-not (Test-ConsoleKeyAvailable)) {
                continue
            }

            $key = [Console]::ReadKey($true)
            if ($key.KeyChar -eq 'r' -or $key.KeyChar -eq 'R') {
                Write-Host ""
                $answer = Read-Host "Server opnieuw opstarten? [J/n]"
                if ($answer -eq "" -or $answer -match "^(j|ja|y|yes)$") {
                    $restartRequested = $true
                    Stop-WeaversServer $server
                    Ensure-FrontendBuild
                    break
                }
                Write-Host "Herstart geannuleerd."
            }
            elseif ($key.KeyChar -eq 'q' -or $key.KeyChar -eq 'Q') {
                Write-Host ""
                $answer = Read-Host "Server stoppen? [J/n]"
                if ($answer -eq "" -or $answer -match "^(j|ja|y|yes)$") {
                    $stopRequested = $true
                    Stop-WeaversServer $server
                    break
                }
                Write-Host "Stop geannuleerd."
            }
        }

        if ($restartRequested) {
            continue
        }

        if ($stopRequested) {
            $exitCode = 0
            break
        }

        $exitCode = $server.ExitCode
        break
    }
}
finally {
    Stop-WeaversServer $server
}

exit $exitCode
