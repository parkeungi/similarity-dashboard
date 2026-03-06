@echo off
:: 숨김 모드로 PowerShell 실행 (창 없음)
powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0right_click_switch.ps1"
