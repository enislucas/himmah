@echo off
setlocal enableextensions enabledelayedexpansion
rem Himmah. Copyright (c) 2026 Enis Lucas Ziadin. All rights reserved.
title Himmah  -  keep this window open while you use the app
cd /d "%~dp0"

echo.
echo   ============================================================
echo     HIMMAH  -  your calm home for tasks, habits and your week
echo   ============================================================
echo.
echo   TIP: for the FULL experience (smart AI + Google Meet links),
echo   open the "Setup Guides" folder and follow START HERE.html
echo   BEFORE you dive in. Himmah works fully without them - these
echo   just switch on the two optional online extras.
echo.

rem ---- 1. Find a working Python 3 --------------------------------------
set "PYCMD="
call :detect_py
if defined PYCMD goto :launch

echo   Python 3 was not found. Himmah needs it to run.
echo   I'll try to install it for you now (no admin needed)...
echo.

rem ---- 2a. Try winget (best path) --------------------------------------
where winget >nul 2>nul
if %errorlevel%==0 (
  echo   Installing Python via winget. Please wait...
  winget install -e --id Python.Python.3.12 --scope user --silent ^
    --accept-package-agreements --accept-source-agreements
  call :detect_py
  if defined PYCMD goto :launch
  echo   winget finished but Python still isn't visible in this window.
  echo.
)

rem ---- 2b. Fallback: download the official installer and run it silently
echo   Downloading the official Python installer from python.org...
set "PYURL=https://www.python.org/ftp/python/3.12.4/python-3.12.4-amd64.exe"
set "PYEXE=%TEMP%\himmah_python_setup.exe"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%PYURL%' -OutFile '%PYEXE%' -UseBasicParsing; exit 0 } catch { exit 1 }"
if not exist "%PYEXE%" (
  echo.
  echo   Could not download Python automatically (no internet, or it was blocked).
  goto :manual
)

echo   Installing Python (this can take a minute)...
"%PYEXE%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0
del "%PYEXE%" >nul 2>nul

call :detect_py
if defined PYCMD goto :launch

rem A fresh install often isn't on PATH in THIS already-open window.
if exist "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" set "PYCMD=%LOCALAPPDATA%\Programs\Python\Launcher\py.exe"
if not defined PYCMD for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%D\python.exe" set "PYCMD=%%D\python.exe"
if defined PYCMD goto :launch

echo.
echo   Python was installed, but this window still has the old settings.
echo   Please CLOSE this window and double-click "Start Himmah.bat" again.
echo   (That one-time reopen lets Windows pick up the new Python.)
echo.
pause
goto :eof

rem ---- 3. Launch -------------------------------------------------------
:launch
echo.
echo   Starting Himmah...  it will open in your browser at http://127.0.0.1:7777/
echo   Keep THIS window open while you use the app. Close it to stop Himmah.
echo.
start "" /b cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:7777/"
%PYCMD% server.py --port 7777
goto :eof

rem ---- helper: set PYCMD to a verified Python 3, else leave it empty ----
:detect_py
set "PYCMD="
py -3 -c "import sys;raise SystemExit(0 if sys.version_info[0]==3 else 1)" >nul 2>nul
if %errorlevel%==0 ( set "PYCMD=py -3" & goto :eof )
for /f "delims=" %%V in ('python -c "import sys;print(sys.version_info[0])" 2^>nul') do set "PYVER=%%V"
if "%PYVER%"=="3" ( set "PYCMD=python" & goto :eof )
goto :eof

rem ---- 4. Could not install --------------------------------------------
:manual
echo.
echo   I couldn't install Python automatically on this PC.
echo   Please install it yourself (5 minutes, free):
echo.
echo     1. Go to   https://www.python.org/downloads/
echo     2. Click the big yellow "Download Python" button.
echo     3. Run the installer and TICK "Add python.exe to PATH".
echo     4. Then double-click "Start Himmah.bat" again.
echo.
pause
goto :eof
