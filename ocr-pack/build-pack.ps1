#requires -version 5.1
<#
  mech-kb OCR Pack - Build script
  Run on dev machine: collects Ollama + glm-ocr model + tessdata + KB code + scripts -> zip
  Output: ocr-pack/dist/mech-kb-ocr-pack.zip  (extract and use)
#>
$ErrorActionPreference = 'Stop'
$projRoot = Split-Path $PSScriptRoot -Parent
$packSrc  = $PSScriptRoot
$dist     = Join-Path $packSrc 'dist'
$distRoot = Join-Path $dist 'mech-kb-ocr-pack'

function Step($m) { Write-Host "`n>> $m" -ForegroundColor Cyan }
function OK($m)   { Write-Host "   [OK] $m" -ForegroundColor Green }

Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  mech-kb OCR Pack - Build'            -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan

# ---- Clean ----
Step 'Clean old output'
if (Test-Path $distRoot) { & cmd /c "rd /s /q `"$distRoot`"" 2>$null }
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
OK 'dist dir ready'

# ---- 1. Scripts ----
Step 'Copy scripts and config'
Copy-Item (Join-Path $packSrc '*.cmd') $distRoot -Force
Copy-Item (Join-Path $packSrc '*.ps1') $distRoot -Force
Copy-Item (Join-Path $packSrc '.state.template') $distRoot -Recurse -Force
if (Test-Path (Join-Path $packSrc 'README.md')) {
  Copy-Item (Join-Path $packSrc 'README.md') $distRoot -Force
}
OK 'Scripts copied'

# ---- 2. Ollama ----
Step 'Copy Ollama portable'
$ollamaSrc = Join-Path $projRoot '.tools\ollama'
if (-not (Test-Path $ollamaSrc)) { Write-Host '  [X] Missing .tools\ollama' -ForegroundColor Red; exit 1 }
$ollamaDst = Join-Path $distRoot 'ollama'
New-Item -ItemType Directory -Path $ollamaDst -Force | Out-Null
Copy-Item (Join-Path $ollamaSrc '*') $ollamaDst -Recurse -Force
$s = [math]::Round((Get-ChildItem $ollamaDst -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
OK "ollama ${s}MB"

# ---- 3. glm-ocr model (smart: only glm-ocr related files) ----
Step 'Copy glm-ocr model'
$modelsSrc = Join-Path $env:USERPROFILE '.ollama\models'
if (-not (Test-Path $modelsSrc)) { Write-Host '  [X] Missing model dir ~/.ollama/models' -ForegroundColor Red; exit 1 }
$modelsDst = Join-Path $distRoot 'models'

# Find glm-ocr manifests (compat manifests + manifests-v2)
$manifestFiles = Get-ChildItem -Path $modelsSrc -Recurse -Filter 'latest' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'glm-ocr' }
if (-not $manifestFiles) { Write-Host '  [X] glm-ocr not found in ~/.ollama/models' -ForegroundColor Red; exit 1 }

# Collect blob digests from manifests
$digests = @{}
foreach ($mf in $manifestFiles) {
  $rel = $mf.FullName.Substring($modelsSrc.Length + 1)
  $dstManifest = Join-Path $modelsDst $rel
  $dstDir = Split-Path $dstManifest -Parent
  New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
  Copy-Item $mf.FullName $dstManifest -Force
  try {
    $j = Get-Content $mf.FullName -Raw | ConvertFrom-Json
    if ($j.config.digest) { $digests[$j.config.digest] = $true }
    foreach ($l in $j.layers) { $digests[$l.digest] = $true }
  } catch {}
}

# Copy blobs + metadata (digest uses "sha256:" but filename uses "sha256-")
$blobsDst = Join-Path $modelsDst 'blobs'
New-Item -ItemType Directory -Path $blobsDst -Force | Out-Null
$copied = 0
foreach ($d in $digests.Keys) {
  $fname = $d -replace ':', '-'              # sha256:xxx -> sha256-xxx
  $src = Join-Path $modelsSrc "blobs\$fname"
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $blobsDst $fname) -Force
    $copied++
    $metaSrc = Join-Path $modelsSrc "metadata\$fname"
    if (Test-Path $metaSrc) {
      $metaDst = Join-Path $modelsDst 'metadata'
      if (-not (Test-Path $metaDst)) { New-Item -ItemType Directory -Path $metaDst -Force | Out-Null }
      Copy-Item $metaSrc (Join-Path $metaDst $fname) -Force
    }
  }
}
$ms = [math]::Round((Get-ChildItem $modelsDst -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 2)
OK "glm-ocr model: $copied blobs, ${ms}GB"

# ---- 4. tessdata ----
Step 'Prepare tessdata'
$tessDst = Join-Path $distRoot 'tessdata'
New-Item -ItemType Directory -Path $tessDst -Force | Out-Null
$tessSrc = Join-Path $projRoot '.state\tessdata\chi_sim.traineddata'
if (Test-Path $tessSrc) {
  Copy-Item $tessSrc $tessDst -Force
  OK 'Copied from .state\tessdata'
} else {
  $cache = Join-Path $env:LOCALAPPDATA 'tesseract.js\cache'
  $found = Get-ChildItem -Path $cache -Recurse -Filter 'chi_sim.traineddata' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { Copy-Item $found.FullName (Join-Path $tessDst 'chi_sim.traineddata') -Force; OK 'Copied from tesseract.js cache' }
  else {
    Write-Host '   Downloading chi_sim.traineddata...' -ForegroundColor Yellow
    try {
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/chi_sim.traineddata' `
        -OutFile (Join-Path $tessDst 'chi_sim.traineddata') -UseBasicParsing -TimeoutSec 120
      OK 'Downloaded'
    } catch { Write-Host '   [!] Download failed, deploy.cmd will handle it' -ForegroundColor Yellow }
  }
}

# ---- 5. KB code ----
Step 'Copy KB code'
$kbDst = Join-Path $distRoot 'kb'
$exclude = '.git', '.state', '.tools', 'node_modules', '.index', 'runtime', '.workbuddy', 'ocr-pack', 'dist', '.trash'
& robocopy $projRoot $kbDst /MIR /XD $exclude /XF '*.zip' '*.log' 'nul' /NJH /NJS /NP /NFL /NDL 2>$null
if ($LASTEXITCODE -ge 8) { Write-Host "  [X] robocopy failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
$ks = [math]::Round((Get-ChildItem $kbDst -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
OK "KB code ${ks}MB"
if (-not (Test-Path (Join-Path $kbDst 'package.json'))) { Write-Host '  [!] KB missing package.json' -ForegroundColor Yellow }

# ---- 6. Zip ----
Step 'Package zip'
$zip = Join-Path $dist 'mech-kb-ocr-pack.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host '   Compressing (may take a few minutes)...'
Compress-Archive -Path (Join-Path $distRoot '*') -DestinationPath $zip -CompressionLevel Optimal
$zs = [math]::Round((Get-Item $zip).Length / 1GB, 2)
OK "zip: $zip  (${zs}GB)"

# ---- Summary ----
Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host '  Build complete!' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host "  Output: $zip" -ForegroundColor White
Write-Host "  Size:   ${zs}GB" -ForegroundColor White
Write-Host "  Usage:  extract, run deploy.cmd, then start.cmd" -ForegroundColor Cyan
Write-Host ''
