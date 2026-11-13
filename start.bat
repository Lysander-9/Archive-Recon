@echo off
chcp 65001 >nul
setlocal EnableExtensions

title Archive Recon
echo ========================================
echo   Archive Recon
echo   Wayback Machine ^& Common Crawl
echo ========================================
echo.

set "ROOT=%~dp0"
set "EXE=%ROOT%desktop\release\win-unpacked\Archive Recon.exe"

if exist "%EXE%" goto :launch

echo [INFO] No local build found at:
echo        "%EXE%"
echo.
echo Users: download ArchiveRecon-^<version^>-win-x64.zip from GitHub Releases,
echo        extract the whole archive and run "Archive Recon.exe" from it.
echo        No Python or Node installation is required.
echo.
echo Developers: build the desktop app locally with
echo        cd /d "%ROOT%desktop"
echo        npm ci
echo        npm run dist:win
echo.
goto :finish

:launch
start "" "%EXE%"

:finish
echo.
pause
endlocal
