@echo off
rem ReportChat launcher for Windows. Keep this file ASCII-only.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title ReportChat
set "OPEN_BROWSER=1"
if not defined PORT set "PORT=3000"
"%~dp0node\node.exe" "%~dp0server\index.js"
echo.
echo ReportChat stopped. Press any key to close this window.
pause >nul
