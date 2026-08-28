@echo off
cd /d "%~dp0hslo"
title HSLO 5.4.0 - MOS E MBYLL
color 0D
echo.
echo  ============================================
echo   HSLO V5 5.4.0  -  MOS E MBYLL KETE DRITARE
echo  ============================================
echo.
echo  1. Kjo dritare duhet te mbetet HAPUR.
echo  2. Hap ne browser:  http://127.0.0.1:8765/
echo.
echo  Duke liruar portin 8765 nese eshte i zene ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>nul
)
timeout /t 1 /nobreak >nul

echo  Duke nisur serverin CORS ne portin 8765 ...
echo.

where python >nul 2>nul
if %errorlevel%==0 (
  python cors-server.py
  goto AFTER
)
where py >nul 2>nul
if %errorlevel%==0 (
  py cors-server.py
  goto AFTER
)

echo  GABIM: Nuk u gjet Python.
echo  Instalo Python nga python.org dhe provo perseri.
echo.
pause
exit /b 1

:AFTER
echo.
echo  Serveri u mbyll.
echo.
pause
