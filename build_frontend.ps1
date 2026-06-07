[CmdletBinding()]
param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Frontend = Join-Path $Root "frontend"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') faalde met exitcode $LASTEXITCODE."
    }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm niet gevonden. Installeer Node.js/npm om de frontend te bouwen."
}

Push-Location $Frontend
try {
    if (-not $SkipInstall -and -not (Test-Path "node_modules")) {
        Write-Host "Frontend dependencies installeren..."
        Invoke-Checked "npm" @("install")
    }

    Write-Host "Frontend build maken..."
    Invoke-Checked "npm" @("run", "build")
}
finally {
    Pop-Location
}
