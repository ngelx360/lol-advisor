@echo off
chcp 65001 >nul
title Subir Actualizacion a GitHub - LoL Advisor
cd /d "%~dp0"

echo ===================================================
echo     PUBLICAR ACTUALIZACION A GITHUB (LoL Advisor)
echo ===================================================
echo.

set /p MSG="Describe la actualizacion o version (ej: v2.2.0 - nuevos counters): "
if "%MSG%"=="" set MSG=Actualizacion LoL Advisor

echo.
echo [1/3] Generando paquete update.zip...
powershell -ExecutionPolicy Bypass -File ".\launcher\crear-actualizacion.ps1"

echo.
echo [2/3] Registrando cambios en Git...
git add .
git commit -m "%MSG%"

echo.
echo [3/3] Subiendo a GitHub...
git push origin main

echo.
echo ===================================================
echo   ¡TODO SUBIDO CON EXITO A GITHUB!
echo   Repositorio: https://github.com/ngelx360/lol-advisor
echo ===================================================
echo.
pause
