[CmdletBinding()]
param(
    [string]$Tag = "weavers-of-power:local",
    [string]$Name = "weavers-of-power",
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,
    [switch]$Build,
    [switch]$Recreate
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($Arguments -join ' ') faalde met exitcode $LASTEXITCODE."
    }
}

function Test-DockerObject {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        & docker @Arguments *> $null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is niet gevonden. Installeer en start Docker Desktop."
}

if (-not (Test-DockerObject info)) {
    throw "De Docker-engine is niet beschikbaar. Start Docker Desktop en probeer opnieuw."
}

$imageExists = Test-DockerObject image inspect $Tag
if ($Build -or -not $imageExists) {
    & (Join-Path $Root "build_docker.ps1") -Tag $Tag
    if ($LASTEXITCODE -ne 0) {
        throw "De Docker-image kon niet worden gebouwd."
    }
}

$containerExists = Test-DockerObject container inspect $Name
if ($containerExists -and ($Build -or $Recreate)) {
    Write-Host "Bestaande container opnieuw aanmaken..."
    Invoke-Docker rm --force $Name
    $containerExists = $false
}

if ($containerExists) {
    $running = & docker container inspect --format "{{.State.Running}}" $Name
    if ($running -eq "true") {
        Write-Host "Container '$Name' draait al."
    }
    else {
        Invoke-Docker start $Name
    }
}
else {
    Invoke-Docker run `
        --detach `
        --name $Name `
        --restart unless-stopped `
        --publish "${Port}:8080" `
        --volume weavers-data:/app/data `
        --volume weavers-saves:/app/saves `
        --volume weavers-custom-art:/app/images/Playing_Characters/extra/custom `
        $Tag
}

Write-Host ""
Write-Host "Weavers of Power draait op http://localhost:$Port"
Write-Host "Stoppen: docker stop $Name"
Write-Host "Logs:    docker logs --follow $Name"
