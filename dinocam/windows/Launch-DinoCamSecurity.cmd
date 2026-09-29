@echo off
rem DinoCamSecurity v2.0 launcher.
rem This file is copied into %LOCALAPPDATA%\DinoCamSecurity by Install-DinoCamSecurity.ps1
rem and is what the Desktop / Start Menu shortcut actually points at. It is the ONLY
rem launcher the installer creates a shortcut for - re-running the installer replaces
rem this file and its shortcuts in place rather than adding a second, older one.
setlocal
set "DINO_DIR=%~dp0"
set "DINO_URL=file:///%DINO_DIR:\=/%index.html"

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "DinoCamSecurity" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="%DINO_URL%"
  exit /b
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "DinoCamSecurity" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app="%DINO_URL%"
  exit /b
)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "DinoCamSecurity" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app="%DINO_URL%"
  exit /b
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "DinoCamSecurity" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --app="%DINO_URL%"
  exit /b
)

rem Neither Edge nor Chrome found in their usual locations - fall back to whatever
rem handles .html by default. The app still works, it just won't open in its own
rem app-style window (it'll open as a normal browser tab).
echo DinoCamSecurity could not find Edge or Chrome in their usual install locations.
echo Opening with your default browser instead.
start "" "%DINO_DIR%index.html"
