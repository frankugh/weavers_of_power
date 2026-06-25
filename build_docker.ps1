[CmdletBinding()]
param(
    [string]$Tag = "weavers-of-power:local"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is niet gevonden. Installeer en start Docker Desktop."
}

$buildArguments = @("build", "--tag", $Tag)
$certificate = @(
    Get-ChildItem Cert:\CurrentUser\Root
    Get-ChildItem Cert:\LocalMachine\Root
) | Where-Object {
    $_.Subject -like "CN=AVG Web/Mail Shield Root*"
} | Select-Object -First 1

try {
    if ($certificate) {
        Write-Host "AVG TLS-certificaat tijdelijk beschikbaar maken voor de Docker-build..."
        $body = [Convert]::ToBase64String(
            $certificate.RawData,
            [Base64FormattingOptions]::InsertLineBreaks
        )
        $env:DOCKER_BUILD_CA = "-----BEGIN CERTIFICATE-----`n$body`n-----END CERTIFICATE-----"
        $buildArguments += @("--secret", "id=build_ca,env=DOCKER_BUILD_CA")
    }

    $buildArguments += "."
    & docker @buildArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker-build faalde met exitcode $LASTEXITCODE."
    }
}
finally {
    Remove-Item Env:\DOCKER_BUILD_CA -ErrorAction SilentlyContinue
}
