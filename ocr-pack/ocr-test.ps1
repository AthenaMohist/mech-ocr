#requires -version 5.1
<# mech-ocr Engine Self-test #>
$ErrorActionPreference = 'SilentlyContinue'
$pack = $PSScriptRoot
$ocrRoot = Split-Path $pack -Parent

$env:OLLAMA_MODELS = Join-Path $pack 'models'
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:NO_PROXY = 'localhost,127.0.0.1'
$env:MECH_KB_ROOT = $ocrRoot
$env:PATH = (Join-Path $pack 'ollama') + ';' + $env:PATH

Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  mech-ocr Engine Self-test' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan

$pass = 0; $fail = 0
function Check($name, $ok, $detail) {
  if ($ok) { Write-Host "  [PASS] $name  $detail" -ForegroundColor Green; $script:pass++ }
  else     { Write-Host "  [FAIL] $name  $detail" -ForegroundColor Red;   $script:fail++ }
}

Write-Host "`n[1] Ollama" -ForegroundColor Cyan
$ollUp = $false; $ver = ''
try { $r = Invoke-WebRequest 'http://127.0.0.1:11434/api/version' -TimeoutSec 3 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ollUp = $true; $ver = ($r.Content | ConvertFrom-Json).version } } catch {}
if (-not $ollUp) {
  $exe = Join-Path $pack 'ollama\ollama.exe'
  if (Test-Path $exe) {
    Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Ms 500; try { $r = Invoke-WebRequest 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { $ollUp = $true; $ver = ($r.Content | ConvertFrom-Json).version; break } } catch {} }
  }
}
Check 'Ollama reachable' $ollUp $(if ($ollUp) { "v$ver" } else { 'not started' })

Write-Host "`n[2] glm-ocr model" -ForegroundColor Cyan
$hasModel = $false; $mSize = 0
if ($ollUp) {
  try { $tags = (Invoke-WebRequest 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5 -UseBasicParsing).Content | ConvertFrom-Json; $m = $tags.models | Where-Object { $_.name -like 'glm-ocr*' } | Select-Object -First 1; if ($m) { $hasModel = $true; $mSize = [math]::Round($m.size/1GB,2) } } catch {}
}
Check 'glm-ocr model' $hasModel $(if ($hasModel) { "${mSize}GB" } else { 'not found' })

Write-Host "`n[3] Engines interface" -ForegroundColor Cyan
$enginesJson = ''
if (Test-Path (Join-Path $ocrRoot 'engines.js')) {
  Push-Location $ocrRoot
  try { $enginesJson = & node -e "const e=require('./engines');e.available().then(l=>{console.log(JSON.stringify(l));process.exit(0)}).catch(()=>{console.log('[]');process.exit(1)})" 2>$null }
  finally { Pop-Location }
}
$engines = @()
if ($enginesJson) { try { $engines = $enginesJson | ConvertFrom-Json } catch {} }
Write-Host "  Available: $($engines -join ', ')" -ForegroundColor White
Check 'GLM-OCR (primary)' ($engines -contains 'glm-ocr') ''
Check 'tesseract (fallback)' ($engines -contains 'tesseract') ''

Write-Host "`n[4] KB Studio" -ForegroundColor Cyan
$studioUp = $false
try { $r = Invoke-WebRequest 'http://localhost:7350' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { $studioUp = $true } } catch {}
Check 'Studio :7350' $studioUp $(if ($studioUp) { 'running' } else { 'not started' })

Write-Host ''
$color = if ($fail -eq 0) { 'Green' } else { 'Yellow' }
Write-Host '========================================' -ForegroundColor $color
Write-Host "  PASS $pass / FAIL $fail" -ForegroundColor $color
Write-Host '========================================' -ForegroundColor $color
if ($fail -eq 0) { Write-Host '  Engines ready!' -ForegroundColor Green }
Read-Host 'Press Enter'
