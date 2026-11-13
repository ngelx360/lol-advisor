@echo off
title LoL Ranked Advisor
cd /d "%~dp0"
if exist "LoL Advisor.exe" (
  start "" "LoL Advisor.exe"
  exit /b
)
echo No se encontro LoL Advisor.exe en esta carpeta.
pause
