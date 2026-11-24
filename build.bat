@echo off
rem WorkshopManager.exe をビルドします（dist フォルダに出力）
cd /d "%~dp0"
python -m pip install --upgrade pyinstaller pywebview || goto :err
python -m PyInstaller --noconfirm --clean --onefile --noconsole ^
  --name WorkshopManager --icon icon.ico --version-file version_info.txt ^
  --add-data "static;static" server.py || goto :err
echo.
echo 完了: dist\WorkshopManager.exe
pause
exit /b 0
:err
echo ビルドに失敗しました
pause
exit /b 1
