Add-Type -AssemblyName System.Drawing

$srcPath = "C:\Users\Admin\.gemini\antigravity\brain\2eebac5e-9515-4396-8ee9-d8942debb44c\.user_uploaded\media_1795074881203_98e85bce.png"
if (-not (Test-Path $srcPath)) {
    Write-Error "Source image not found: $srcPath"
    exit 1
}

$srcImg = [System.Drawing.Image]::FromFile($srcPath)
Write-Host "Source image loaded: $($srcImg.Width)x$($srcImg.Height)"

$targetSizes = @(256, 128, 64, 48, 32, 16)
$tempDir = Join-Path $PSScriptRoot "temp_icons"
if (-not (Test-Path $tempDir)) {
    New-Item -ItemType Directory -Path $tempDir | Out-Null
}

# 1. Generate square 512x512 master PNG
$masterSize = 512
$masterBmp = New-Object System.Drawing.Bitmap($masterSize, $masterSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($masterBmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Fit source inside master keeping aspect ratio with 5% padding
$padding = 16
$maxH = $masterSize - ($padding * 2)
$scale = $maxH / $srcImg.Height
$drawW = [int]($srcImg.Width * $scale)
$drawH = [int]($srcImg.Height * $scale)
$drawX = [int](($masterSize - $drawW) / 2)
$drawY = [int](($masterSize - $drawH) / 2)

$g.DrawImage($srcImg, $drawX, $drawY, $drawW, $drawH)
$g.Dispose()

$masterPath = Join-Path $PSScriptRoot "tally_icon.png"
$publicMasterPath = Join-Path $PSScriptRoot "public\tally_icon.png"
$masterBmp.Save($masterPath, [System.Drawing.Imaging.ImageFormat]::Png)
$masterBmp.Save($publicMasterPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Saved master PNG to: $masterPath and $publicMasterPath"

# 2. Generate resized PNGs for ICO builder
foreach ($sz in $targetSizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gSz = [System.Drawing.Graphics]::FromImage($bmp)
    $gSz.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gSz.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $gSz.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gSz.Clear([System.Drawing.Color]::Transparent)
    $gSz.DrawImage($masterBmp, 0, 0, $sz, $sz)
    $gSz.Dispose()

    $outPng = Join-Path $tempDir "icon_${sz}.png"
    $bmp.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$masterBmp.Dispose()
$srcImg.Dispose()
Write-Host "Resized PNGs generated successfully in $tempDir"
