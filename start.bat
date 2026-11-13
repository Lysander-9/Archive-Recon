@echo off
chcp 65001 >nul
setlocal EnableExtensions

title Archive-Recon
echo ========================================
echo   Archive-Recon
echo   Wayback Machine ^& Common Crawl
echo ========================================
echo.

set "APP_SCRIPT=%~dp0main.py"
if exist "%APP_SCRIPT%" goto :find_python

echo [ERROR] main.py not found next to this script:
echo         "%APP_SCRIPT%"
goto :finish

:find_python
rem 1) project virtualenv  2) py launcher  3) python on PATH
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PY_CMD="%~dp0.venv\Scripts\python.exe""
    goto :check_python
)
where py >nul 2>&1
if not errorlevel 1 (
    set "PY_CMD=py -3"
    goto :check_python
)
where python >nul 2>&1
if not errorlevel 1 (
    set "PY_CMD=python"
    goto :check_python
)
echo [ERROR] No Python 3 found.
echo         Install Python 3.10+ (with Tcl/Tk) or create .venv first.
goto :finish

:check_python
%PY_CMD% -c "import sys" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] The Python command below does not work:
    echo         %PY_CMD%
    echo         Create .venv with: uv venv .venv
    goto :finish
)

rem Check GUI toolkit and runtime dependencies before launching
%PY_CMD% -c "import tkinter, customtkinter, requests, pandas" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Tkinter or project dependencies are missing.
    echo         Python: %PY_CMD%
    echo.
    echo         Use a Python 3.10+ build that includes Tcl/Tk, then run:
    echo         %PY_CMD% -m pip install -r "%~dp0requirements.txt"
    goto :finish
)

%PY_CMD% "%APP_SCRIPT%"

:finish
echo.
pause
endlocal
