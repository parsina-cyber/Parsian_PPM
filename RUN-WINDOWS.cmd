@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Parsian CRM - Local

if not exist "server.js" goto missing_files
if not exist "domain.js" goto missing_files
if not exist "public\index.html" goto missing_files

call :check_node
if not errorlevel 1 goto ready

echo Node.js 24 or newer is required. Checking the Windows package manager...
where winget >nul 2>&1
if errorlevel 1 goto manual_install
echo Installing the official Node.js LTS package. Windows may ask for permission.
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements

rem A newly installed runtime is not yet in this CMD process's inherited PATH.
set "PATH=%ProgramFiles%\nodejs;%LocalAppData%\Programs\nodejs;%PATH%"
call :check_node
if errorlevel 1 goto manual_install

:ready
set "HOST=127.0.0.1"
set "PORT=3000"
set "COOKIE_SECURE=0"

rem Reuse a running local CRM instead of starting a second process on the same database.
powershell.exe -NoProfile -Command "try { $s=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/session' -TimeoutSec 2; if ($s.PSObject.Properties.Name -contains 'needsSetup') { exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 goto already_running

echo.
echo Starting Parsian CRM at http://localhost:3000
echo Keep this window open while using the app. Press Ctrl+C to stop.
echo No npm install is needed. Your data is saved in the data folder.
echo.

rem Open the browser only after the application is responding.
start "" /b powershell.exe -NoProfile -Command "for ($i=0; $i -lt 40; $i++) { try { $s=Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/session' -TimeoutSec 1; if ($s.PSObject.Properties.Name -contains 'needsSetup') { Start-Process 'http://localhost:3000'; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
node server.js
set "CRM_EXIT=%ERRORLEVEL%"
if "%CRM_EXIT%"=="0" exit /b 0
echo.
echo The server stopped with an error. Read the message above.
echo If port 3000 is in use, close the other server and try again.
pause
exit /b %CRM_EXIT%

:already_running
echo Parsian CRM is already running. Opening your browser...
start "" "http://localhost:3000"
exit /b 0

:manual_install
echo.
echo Automatic installation was not available or Node.js is still not ready.
echo Install the Windows LTS version of Node.js 24 or newer from the official site.
echo Keep Add to PATH enabled. Then close this window and run this file again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:missing_files
echo Extract the entire ZIP first, then run RUN-WINDOWS.cmd from the extracted folder.
pause
exit /b 1

:check_node
node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1);require('node:sqlite')" >nul 2>&1
exit /b %ERRORLEVEL%
