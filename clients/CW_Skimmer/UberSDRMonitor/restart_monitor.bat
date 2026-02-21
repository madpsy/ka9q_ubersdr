@echo off
echo Stopping any running UberSDRMonitor instances...
taskkill /F /IM UberSDRMonitor.exe 2>nul
timeout /t 1 /nobreak >nul
echo Starting UberSDRMonitor...
start "" "%~dp0UberSDRMonitor.exe"
echo Done!
