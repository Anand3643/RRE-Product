@echo off
title RRE Tally Web Edition
echo =======================================================
echo   Starting TallyPrime Web Edition (Double-Entry Engine)
echo =======================================================
cd /d "%~dp0"
echo Launching Tally Gateway at http://localhost:4000 ...
start http://localhost:4000
node server.js
pause
