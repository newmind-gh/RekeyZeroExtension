param([switch]$ForceNpmInstall)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtensionRoot = Join-Path $RepoRoot "apps\extension"

if (-not (Test-Path $ExtensionRoot)) {
    throw "setup.ps1 must be located in the RekeyZeroExtension repository root."
}

if ($null -eq (Get-Command "node" -ErrorAction SilentlyContinue)) {
    throw "Global Node.js is required."
}
if ($null -eq (Get-Command "npm" -ErrorAction SilentlyContinue)) {
    throw "Global npm is required."
}

Write-Host ""
Write-Host "RekeyZeroExtension - Windows Setup" -ForegroundColor Cyan
Write-Host "Repo:           $RepoRoot"
Write-Host "Extension deps: $ExtensionRoot\node_modules"
Write-Host ""
Write-Host ("[ok] Global Node.js: " + (& node --version)) -ForegroundColor Green
Write-Host ("[ok] Global npm: " + (& npm --version)) -ForegroundColor Green

function Install-Dependencies([string]$Path, [string]$Label) {
    Push-Location $Path
    try {
        if ($ForceNpmInstall) {
            npm install
        } elseif (Test-Path "package-lock.json") {
            npm ci
        } else {
            npm install
        }
        if ($LASTEXITCODE -ne 0) { throw "$Label dependency installation failed." }
    } finally {
        Pop-Location
    }
}

Install-Dependencies $ExtensionRoot "Extension"

Push-Location $ExtensionRoot
try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Extension tests failed." }
    npm run check
    if ($LASTEXITCODE -ne 0) { throw "Extension check failed." }
} finally {
    Pop-Location
}


Write-Host ""
Write-Host "RekeyZeroExtension setup completed." -ForegroundColor Green
Write-Host ""
