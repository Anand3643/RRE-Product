@echo off
title Ramraj Enterprises — RRE Manufacturing ERP
echo =======================================================
echo   Starting Ramraj Enterprises Manufacturing ERP Suite
echo =======================================================
cd /d "%~dp0"
echo Opening browser at http://localhost:5000 ...
start http://localhost:5000
npm start
pause
