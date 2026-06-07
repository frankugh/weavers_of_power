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
        (Join-Path $frontendRoot "vite.config.js")
    )

    $sourceFiles = @()
    foreach ($path in $sourcePaths) {
        if (Test-Path $path) {
            $sourceFiles += Get-Item $path
        }
    }
    if (Test-Path (Join-Path $frontendRoot "src")) {
        $sourceFiles += Get-ChildItem (Join-Path $frontendRoot "src") -Recurse -File
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

$python = Resolve-ProjectPython
Write-Host "Python: $python"

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

Write-Host "Weavers of Power starten op http://127.0.0.1:8080"
& $python (Join-Path $Root "app.py")
exit $LASTEXITCODE
