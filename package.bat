@echo off
rem 配布用 ZIP を release フォルダに作ります
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package.ps1"
pause
