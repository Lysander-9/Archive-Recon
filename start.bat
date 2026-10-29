@echo off
chcp 65001 >nul
setlocal

title 渗透测试信息搜集工具
echo ========================================
echo   渗透测试信息搜集工具
echo   Wayback Machine ^& Common Crawl
echo ========================================
echo.

set "APP_SCRIPT=%~dp0main.py"
set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=C:\Users\Lysander\.workbuddy\binaries\python\envs\pentest-tool\Scripts\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

if not exist "%APP_SCRIPT%" (
    echo [错误] 找不到程序文件：
    echo "%APP_SCRIPT%"
    goto :finish
)

"%PYTHON_EXE%" -c "import tkinter, customtkinter, requests" >nul 2>&1
if errorlevel 1 (
    echo [错误] 当前 Python 环境缺少 Tkinter 或项目依赖。
    echo Python: "%PYTHON_EXE%"
    echo.
    echo 请使用包含 Tcl/Tk 的 Python 3.10+，并在该环境安装 requirements.txt 中的依赖。
    echo 当前环境至少需要 tkinter、customtkinter 和 requests。
    goto :finish
)

"%PYTHON_EXE%" "%APP_SCRIPT%"

:finish
echo.
pause
endlocal
