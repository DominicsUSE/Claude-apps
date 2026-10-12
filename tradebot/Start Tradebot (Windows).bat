@echo off
rem Double-click to start Tradebot. The first start installs what it needs (takes a minute).
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Get it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
if not exist .venv\Scripts\python.exe (
  echo Setting up Tradebot for the first time...
  %PY% -m venv .venv || goto :fail
)
.venv\Scripts\python.exe -m pip install --quiet --disable-pip-version-check -r requirements.txt || goto :fail
.venv\Scripts\python.exe run.py %*
pause
exit /b 0
:fail
echo Setup failed. Check your internet connection and try again.
pause
exit /b 1
