#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Generate self-signed code signing cert and sign PaintKiDukaan build artifacts.
.DESCRIPTION
    Run once to create cert, then again after each build to sign.
    Must run as Administrator (cert store access + signtool).
.USAGE
    .\windows-sign.ps1 -Setup          # First time: create cert
    .\windows-sign.ps1 -Sign           # Sign build artifacts
    .\windows-sign.ps1 -Sign -ExePath "path\to\custom.exe"  # Sign specific file
#>
param(
    [switch]$Setup,
    [switch]$Sign,
    [string]$ExePath
)

$ErrorActionPreference = "Stop"

$CertSubject = "CN=PaintKiDukaan Test"
$CertStore = "Cert:\CurrentUser\My"
$ArtifactDir = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"

function Get-SigningCert {
    $certs = Get-ChildItem -Path $CertStore -CodeSigningCert |
        Where-Object { $_.Subject -eq $CertSubject }
    return $certs | Sort-Object NotAfter -Descending | Select-Object -First 1
}

if ($Setup) {
    $existing = Get-SigningCert
    if ($existing) {
        Write-Host "Cert already exists (Thumbprint: $($existing.Thumbprint), Expires: $($existing.NotAfter))" -ForegroundColor Yellow
        $overwrite = Read-Host "Create new cert? (y/N)"
        if ($overwrite -ne "y") { exit 0 }
    }

    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $CertSubject `
        -CertStoreLocation $CertStore `
        -NotAfter (Get-Date).AddYears(3) `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256

    Write-Host ""
    Write-Host "=== Certificate Created ===" -ForegroundColor Green
    Write-Host "Thumbprint: $($cert.Thumbprint)"
    Write-Host "Expires:     $($cert.NotAfter)"
    Write-Host ""
    Write-Host "Set this env var (add to PowerShell profile or System Environment Variables):" -ForegroundColor Cyan
    Write-Host "`$env:WINDOWS_CERT_THUMBPRINT = `"$($cert.Thumbprint)`"" -ForegroundColor White
    Write-Host ""
    Write-Host "Or add to tauri.conf.json bundle.windows.certificateThumbprint" -ForegroundColor Cyan
    exit 0
}

if ($Sign) {
    $thumbprint = $env:WINDOWS_CERT_THUMBPRINT
    if (-not $thumbprint) {
        $cert = Get-SigningCert
        if (-not $cert) {
            Write-Host "No cert found. Run: .\windows-sign.ps1 -Setup" -ForegroundColor Red
            exit 1
        }
        $thumbprint = $cert.Thumbprint
        Write-Host "Auto-detected cert thumbprint: $thumbprint" -ForegroundColor Yellow
    }

    $files = @()
    if ($ExePath) {
        $files += $ExePath
    } else {
        $nsisExes = Get-ChildItem -Path $ArtifactDir -Filter "*.exe" -ErrorAction SilentlyContinue
        if ($nsisExes) { $files += $nsisExes.FullName }

        $mainExe = "src-tauri\target\x86_64-pc-windows-msvc\release\paintkiduakan-master.exe"
        if (Test-Path $mainExe) { $files += $mainExe }
    }

    if ($files.Count -eq 0) {
        Write-Host "No artifacts found to sign. Build first with: pnpm tauri:build:win" -ForegroundColor Red
        exit 1
    }

    foreach ($file in $files) {
        Write-Host "Signing: $file" -ForegroundColor Cyan
        signtool sign /fd SHA256 /sha1 $thumbprint /tr http://timestamp.digicert.com /td SHA256 $file
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAILED to sign: $file" -ForegroundColor Red
            exit 1
        }
    }

    Write-Host ""
    Write-Host "=== All artifacts signed ===" -ForegroundColor Green
    exit 0
}

Write-Host "Usage:" -ForegroundColor Cyan
Write-Host "  .\windows-sign.ps1 -Setup     # Create self-signed cert"
Write-Host "  .\windows-sign.ps1 -Sign      # Sign build artifacts"
