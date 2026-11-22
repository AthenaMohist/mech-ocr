@echo off
chcp 65001 >nul
title mech-kb OCR 懒人包
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
