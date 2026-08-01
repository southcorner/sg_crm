@echo off
rem ---------------------------------------------------------------------------
rem  Run SG CRM in this window.
rem
rem  This is what the setup exe launches when there is no SgCrm Windows service
rem  installed. Closing this window stops the CRM, so for a real deployment
rem  install the service instead:
rem      powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
rem
rem  It lives in scripts\installer\ and works out the repo root from its own
rem  location, so it does not care where the CRM was installed.
rem
rem  ASCII ONLY in this file.
rem ---------------------------------------------------------------------------
title SG CRM server

set "REPO=%~dp0..\.."
pushd "%REPO%" || (echo Could not enter "%REPO%". & pause & exit /b 1)

set NODE_ENV=production

echo ===========================================
echo  SG CRM server
echo  directory: %CD%
echo  Close this window to stop the CRM.
echo ===========================================
echo.

node server\src\index.js
set "RC=%ERRORLEVEL%"

echo.
echo -------------------------------------------
echo  The SG CRM server has stopped (exit code %RC%).
echo -------------------------------------------
popd
if not "%SGCRM_NO_PAUSE%"=="1" pause
exit /b %RC%
