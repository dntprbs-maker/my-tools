@echo off
rem Build "AI Usage Monitor.exe" (developer only). Output: dist\AI Usage Monitor\AI Usage Monitor.exe
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  python -m venv .venv || exit /b 1
  .venv\Scripts\python.exe -m pip install -q -r requirements.txt || exit /b 1
)
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --windowed ^
  --name "AI Usage Monitor" --icon app\icon.ico ^
  --add-data "app;app" --add-data "collector;collector" ^
  --hidden-import collector ^
  monitor.pyw
