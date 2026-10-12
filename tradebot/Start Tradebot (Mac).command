#!/bin/bash
# Double-click to start Tradebot. The first start installs what it needs (takes a minute).
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed. Get it from https://www.python.org/downloads/"
  read -r -p "Press Enter to close"
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "Setting up Tradebot for the first time..."
  python3 -m venv .venv || exit 1
fi
.venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt || { echo "Setup failed. Check your internet connection."; read -r; exit 1; }
.venv/bin/python run.py "$@"
