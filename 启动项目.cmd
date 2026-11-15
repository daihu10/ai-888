@echo off
setlocal
cd /d "%~dp0"
title Tick Stock Panel
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-window.ps1"
if errorlevel 1 (
    echo.
    echo Startup failed. Check the message above.
    pause
)
endlocal
