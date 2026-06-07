@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_weavers.ps1" %*
