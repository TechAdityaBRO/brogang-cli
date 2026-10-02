@echo off
REM Bro Gang AI CLI installer for Windows CMD
set "url=https://github.com/TechAdityaBRO/brogang-cli/releases/latest/download/brogang-windows-amd64.zip"
set "tmp=%TEMP%\brogang-%RANDOM%"
mkdir "%tmp%" 2>nul
curl -fsSL -o "%tmp%\brogang.zip" "%url%"
tar -xf "%tmp%\brogang.zip" -C "%tmp%"
set "dest=%LOCALAPPDATA%\Programs\brogang"
mkdir "%dest%" 2>nul
copy /y "%tmp%\brogang.exe" "%dest%\brogang.exe" >nul
echo Installed brogang.exe to %dest%
echo Add "%dest%" to your PATH permanently to use brogang everywhere.
