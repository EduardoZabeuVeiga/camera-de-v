@echo off
title Camera IP - Servidor
color 0A
cd /d "%~dp0"
if not exist "node_modules" npm install
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000 " ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
node server.js
pause
