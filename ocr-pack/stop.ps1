#requires -version 5.1
<# mech-kb OCR Pack - Stop all services #>
$ErrorActionPreference = 'SilentlyContinue'
$pack = $PSScriptRoot

Write-Host 'Stopping mech-kb related processes...' -ForegroundColor Cyan
$killed = 0

# 1. mech-kb Studio (node bin\mech-kb.js studio)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'mech-kb.js.*studio' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host "  [stopped] Studio (PID $($_.ProcessId))" -ForegroundColor Green
    $killed++
  }

# 2. OCR worker (node .../ocr.js, but not ocr-engines/ocr-bench)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'ocr\.js' -and $_.CommandLine -notmatch 'ocr-engines' -and $_.CommandLine -notmatch 'ocr-bench' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host "  [stopped] OCR worker (PID $($_.ProcessId))" -ForegroundColor Green
    $killed++
  }

# 3. Ollama (ollama.exe serve / ollama app)
Get-CimInstance Win32_Process -Filter "Name='ollama.exe'" |
  Where-Object { $_.CommandLine -match 'serve' -or $_.CommandLine -match 'ollama app' -or $_.CommandLine -match 'ollama.exe' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host "  [stopped] Ollama (PID $($_.ProcessId))" -ForegroundColor Green
    $killed++
  }
Get-Process ollama -ErrorAction SilentlyContinue |
  ForEach-Object {
    Stop-Process -Id $_.Id -Force
    Write-Host "  [stopped] ollama.exe (PID $($_.Id))" -ForegroundColor Green
    $killed++
  }

if ($killed -eq 0) {
  Write-Host '  No running mech-kb services found' -ForegroundColor Yellow
} else {
  Write-Host "  Stopped $killed process(es)" -ForegroundColor Green
}

# Verify ports released
Start-Sleep -Milliseconds 800
$oll = $false; $stu = $false
try { Invoke-WebRequest 'http://127.0.0.1:11434/api/version' -TimeoutSec 1 -UseBasicParsing | Out-Null; $oll = $true } catch {}
try { Invoke-WebRequest 'http://localhost:7350' -TimeoutSec 1 -UseBasicParsing | Out-Null; $stu = $true } catch {}
if ($oll) { Write-Host '  [!] Ollama port still in use' -ForegroundColor Yellow }
if ($stu) { Write-Host '  [!] Studio port still in use' -ForegroundColor Yellow }
if (-not $oll -and -not $stu) { Write-Host '  Ports released' -ForegroundColor Green }
