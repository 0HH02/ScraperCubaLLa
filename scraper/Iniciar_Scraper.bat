@echo off
chcp 65001 >nul
title Scraper Cuballama - Pipeline
cd /d "%~dp0"

where py >nul 2>&1
if %errorlevel%==0 (
    py -3 run_pipeline.py
    goto :done
)

where python >nul 2>&1
if %errorlevel%==0 (
    python run_pipeline.py
    goto :done
)

echo.
echo [ERROR] No se encontro Python. Instala Python 3.11+ desde https://www.python.org/
echo.
pause
exit /b 1

:done
set EXIT_CODE=%errorlevel%
echo.
if %EXIT_CODE% neq 0 (
    echo Presiona una tecla para cerrar...
    pause >nul
    exit /b %EXIT_CODE%
)
echo Presiona una tecla para cerrar...
pause >nul
exit /b %EXIT_CODE%
