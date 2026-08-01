@echo off
rem ---------------------------------------------------------------------------
rem  SG CRM setup bootstrap.
rem
rem  IExpress extracts this next to install.ps1, payload.zip and version.txt and
rem  runs it. All it does is start PowerShell with the execution policy relaxed
rem  for this one process, then keep the window open so the operator can read
rem  what happened.
rem
rem  ASCII ONLY in this file.
rem ---------------------------------------------------------------------------
setlocal
title SG CRM setup

set "SCRIPT_DIR=%~dp0"

echo.
echo   ===========================================
echo    SG CRM setup
echo   ===========================================
echo.
if defined SGCRM_DIR echo   Target directory override: %SGCRM_DIR%

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo   -------------------------------------------
    echo    SETUP FAILED  ^(exit code %RC%^)
    echo    Read the messages above before closing.
    echo   -------------------------------------------
) else (
    echo   -------------------------------------------
    echo    Setup finished.
    echo   -------------------------------------------
)
echo.
rem SGCRM_NO_PAUSE=1 is for scripted runs; a human should always get the pause
rem so the window does not vanish with the error still on it.
if not "%SGCRM_NO_PAUSE%"=="1" pause
exit /b %RC%
