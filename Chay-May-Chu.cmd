@echo off
setlocal EnableExtensions
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo [AoE1 Web] Node.js ^>= 24 was not found in PATH.
  echo Please install Node.js 24 or newer from https://nodejs.org/ and try again.
  if "%~1"=="" pause
  exit /b 1
)

set "SCRIPT_DIR=%~dp0"
set "CLI_ENTRY=%SCRIPT_DIR%tools\host\cli.ts"

if not exist "%CLI_ENTRY%" (
  echo [AoE1 Web] Launcher entry not found: "%CLI_ENTRY%"
  if "%~1"=="" pause
  exit /b 1
)

node "%CLI_ENTRY%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  if "%~1"=="" pause
)

exit /b %EXIT_CODE%
