#requires -version 5.1
<#
  mech-ocr Start — Ollama (bg) + KB Studio (bg, :7350) + open browser
  Sets OCR_ROOT so KB ocr_start can find mech-ocr/pipeline.js
#>
$ErrorActionPreference = 'Stop'
$pack = $PSScriptRoot
$ocrRoot = Split-Path $pack -Parent
$kbRoot = Join-Path (Split-Path $ocrRoot -Parent) 'mech-kb'

function OK($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X]  $m" -ForegroundColor Red; Read-Host 'Press Enter'; exit 1 }

$env:OLLAMA_MODELS = Join-Path $pack 'models'
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:NO_PROXY = 'localhost,127.0.0.1'
$env:OCR_ROOT = $ocrRoot
$env:PATH = (Join-Path $pack 'ollama') + ';' + $env:PATH

Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  mech-ocr Start' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan

# ---- 1. Ollama ----
Write-Host "`n[1/2] Ollama (GLM-OCR)" -ForegroundColor Cyan
$ollRunning = $false
try { $r = Invoke-WebRequest 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ollRunning = $true } } catch {}
if ($ollRunning) { OK 'Already running' }
else {
  $exe = Join-Path $pack 'ollama\ollama.exe'
  if (-not (Test-Path $exe)) { Fail "Missing $exe" }
  Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try { $r = Invoke-WebRequest 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {}
  }
  if (-not $ready) { Fail 'Ollama startup timeout' }
  OK 'Started'
}
try {
  $tags = (Invoke-WebRequest 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json
  if (($tags.models | Where-Object { $_.name -like 'glm-ocr*' }).Count -gt 0) { OK 'glm-ocr model ready' }
  else { Warn 'glm-ocr not found' }
} catch {}

# ---- 2. KB Studio ----
Write-Host "`n[2/2] mech-kb Studio (:7350)" -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $kbRoot 'bin\mech-kb.js'))) {
  Warn "KB not found at $kbRoot"
  Write-Host '  Start KB Studio manually, or clone mech-kb alongside mech-ocr' -ForegroundColor DarkGray
} else {
  $studioRunning = $false
  try { $r = Invoke-WebRequest 'http://localhost:7350' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { $studioRunning = $true } } catch {}
  if ($studioRunning) { OK 'Studio already running' }
  else {
    Write-Host '  Starting Studio...'
    Start-Process -FilePath 'node' -ArgumentList 'bin\mech-kb.js', 'studio' -WorkingDirectory $kbRoot -WindowStyle Hidden
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      try { $r = Invoke-WebRequest 'http://localhost:7350' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {}
    }
    if ($ready) { OK 'Studio started' } else { Warn 'Studio slow, try http://localhost:7350 manually' }
  }
}

Write-Host ''
Write-Host '  +-------------------------+----------+----------+' -ForegroundColor White
Write-Host '  | Ollama (GLM-OCR)        | running  | 11434    |' -ForegroundColor Green
Write-Host '  | mech-kb Studio          | running  | 7350     |' -ForegroundColor Green
Write-Host '  +-------------------------+----------+----------+' -ForegroundColor White
Write-Host ''
Write-Host "  OCR_ROOT = $ocrRoot" -ForegroundColor DarkGray
Write-Host '  Studio: http://localhost:7350' -ForegroundColor Cyan
Write-Host '  In Sources page, click OCR button -> KB spawns mech-ocr/pipeline.js' -ForegroundColor DarkGray

try { Start-Process 'http://localhost:7350' } catch {}

Write-Host ''
Write-Host '  Close window or press Enter to stop.' -ForegroundColor Yellow
Read-Host 'Press Enter to stop'
& (Join-Path $pack 'stop.ps1')
