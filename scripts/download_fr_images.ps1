# download_fr_images.ps1
#
# Downloads FigureRealm thumbnails for all figures in figures-pending.json
# that don't already have an image in the images/ folder.
#
# Run from the root of your cloned motu-images repo:
#   cd C:\Users\brandon\motu-images
#   .\scripts\download_fr_images.ps1
#
# After it completes:
#   git add images/
#   git commit -m "add FigureRealm thumbnails"
#   git push

$ErrorActionPreference = "Stop"

$RepoRoot   = $PSScriptRoot | Split-Path -Parent
$PendingFile = Join-Path $RepoRoot "figures-pending.json"
$ImagesDir  = Join-Path $RepoRoot "images"

if (-not (Test-Path $PendingFile)) {
    Write-Host "figures-pending.json not found at $PendingFile" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $ImagesDir)) {
    New-Item -ItemType Directory -Path $ImagesDir | Out-Null
}

$pending = Get-Content $PendingFile -Raw | ConvertFrom-Json

# Only process FigureRealm entries that have a thumb_url
$frFigs = $pending | Where-Object { $_.source -eq "figurerealm" -and $_.thumb_url }

Write-Host ""
Write-Host "══════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  MOTU Vault — FigureRealm Image Downloader" -ForegroundColor Cyan
Write-Host "══════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Pending FR figures with thumb URLs: $($frFigs.Count)"
Write-Host ""

$ok      = 0
$skipped = 0
$failed  = 0

foreach ($fig in $frFigs) {
    $dest = Join-Path $ImagesDir "$($fig.id).jpg"

    if (Test-Path $dest) {
        Write-Host "  skip  $($fig.id)" -ForegroundColor DarkGray
        $skipped++
        continue
    }

    try {
        $response = Invoke-WebRequest `
            -Uri $fig.thumb_url `
            -OutFile $dest `
            -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" `
            -Headers @{ "Referer" = "https://www.figurerealm.com/" } `
            -TimeoutSec 30 `
            -PassThru

        $size = (Get-Item $dest).Length
        if ($size -lt 500) {
            Remove-Item $dest -Force
            Write-Host "  tiny  $($fig.id) ($size bytes — skipped)" -ForegroundColor Yellow
            $failed++
        } else {
            Write-Host "  ok    $($fig.id) ($([math]::Round($size/1024, 1)) KB)" -ForegroundColor Green
            $ok++
        }
    } catch {
        Write-Host "  fail  $($fig.id): $($_.Exception.Message)" -ForegroundColor Red
        if (Test-Path $dest) { Remove-Item $dest -Force }
        $failed++
    }

    Start-Sleep -Milliseconds 300
}

Write-Host ""
Write-Host "══════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Downloaded: $ok   Skipped: $skipped   Failed: $failed" -ForegroundColor Cyan
Write-Host ""

if ($ok -gt 0) {
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  git add images/"
    Write-Host "  git commit -m `"add FigureRealm thumbnails ($ok images)`""
    Write-Host "  git push"
}
