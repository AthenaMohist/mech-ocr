#requires -version 5.1
<#
  mech-ocr Deploy — install deps + verify Ollama/model + check KB sibling
  mech-ocr is the root (pipeline.js at root), KB (mech-kb) should be sibling dir.
#>
$ErrorActionPreference = 'Stop'
$pack = $PSScriptRoot
$ocrRoot = Split-Path $pack -Parent

function Step($n, $msg) { Write-Host "`n[$n/6] $msg" -ForegroundColor Cyan }
function OK($msg)       { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg)     { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Fail($msg)     { Write-Host "  [X]  $m" -ForegroundColor Red; Read-Host 'Press Enter to exit'; exit 1 }

Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  mech-ocr Deploy'                      -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan

Step 1 'Check Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js not found. Install Node 18+ from https://nodejs.org' }
$v = & node --version
OK "Node $v"

Step 2 'Install mech-ocr dependencies'
$nm = Join-Path $ocrRoot 'node_modules'
if ((Test-Path (Join-Path $nm 'pdf-to-img')) -and (Test-Path (Join-Path $nm 'tesseract.js'))) {
  OK 'Dependencies already installed, skip'
} else {
  Write-Host '  npm install (npmmirror)...'
  Push-Location $ocrRoot
  try { & npm install --registry=https://registry.npmmirror.com --no-audit --no-fund 2>&1 | Select-Object -Last 4 | ForEach-Object { Write-Host "  $_" } }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' }
  OK 'Dependencies installed'
}

Step 3 'Check Ollama'
$ollamaExe = Join-Path $pack 'ollama\ollama.exe'
if (-not (Test-Path $ollamaExe)) { Fail "Missing $ollamaExe. Ensure pack is complete" }
OK "ollama.exe $([math]::Round((Get-Item $ollamaExe).Length/1MB,1))MB"

Step 4 'Check glm-ocr model'
$modelsDir = Join-Path $pack 'models'
if (-not (Test-Path (Join-Path $modelsDir 'manifests'))) { Fail "Missing models dir: $modelsDir" }
$glm = Get-ChildItem $modelsDir -Recurse -Filter 'latest' -EA SilentlyContinue | Where-Object { $_.FullName -match 'glm-ocr' }
if (-not $glm) { Fail 'glm-ocr model not found in models dir' }
$ms = [math]::Round((Get-ChildItem $modelsDir -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 2)
OK "glm-ocr model ready (${ms}GB)"

Step 5 'Prepare tessdata'
$tessDir = Join-Path $pack 'tessdata'
$chiSim = Join-Path $tessDir 'chi_sim.traineddata'
if (Test-Path $chiSim) { OK 'chi_sim exists' }
else {
  New-Item -ItemType Directory -Path $tessDir -Force | Out-Null
  Write-Host '  Downloading chi_sim.traineddata...'
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest 'https://github.com/tesseract-ocr/tessdata_fast/raw/main/chi_sim.traineddata' -OutFile $chiSim -UseBasicParsing -TimeoutSec 120
    OK 'chi_sim downloaded'
  } catch { Warn 'Download failed, tesseract will auto-download on first use' }
}

Step 6 'Check KB (mech-kb) sibling'
$kbRoot = Join-Path (Split-Path $ocrRoot -Parent) 'mech-kb'
if (Test-Path (Join-Path $kbRoot 'bin\mech-kb.js')) {
  OK "KB found: $kbRoot"
  Write-Host '  KB ocr_start will auto-find mech-ocr via sibling path' -ForegroundColor DarkGray
} else {
  Warn 'KB (mech-kb) not found in sibling dir'
  Write-Host '  Clone mech-kb alongside mech-ocr for full integration' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host '  Deploy complete!' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host '  Next: double-click start.cmd' -ForegroundColor Cyan
Write-Host ''
Read-Host 'Press Enter to exit'
