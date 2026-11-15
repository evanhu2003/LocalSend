@echo off
rem Keep everything above the re-launch ASCII-only: cmd reads batch files by byte
rem offset, so switching the code page mid-file breaks UTF-8 lines. Re-running
rem this script in a fresh cmd that starts with code page 65001 avoids that.
chcp 65001 >nul
if not "%~1"=="--utf8" (
  cmd /d /c ""%~f0" --utf8"
  exit /b
)
setlocal
cd /d "%~dp0"
title LocalSend 電腦端

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [錯誤] 找不到 Node.js。
  echo 請先到 https://nodejs.org/ 下載並安裝 LTS 版本，安裝完成後再雙擊一次 start.bat。
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\node-forge\" (
  echo 第一次執行，正在安裝必要套件，請稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [錯誤] 套件安裝失敗，請確認網路連線後再試一次。
    echo.
    pause
    exit /b 1
  )
)

echo 正在啟動 LocalSend 電腦端，瀏覽器會自動開啟 http://127.0.0.1:53318
echo.
node server.js --open
echo.
echo LocalSend 電腦端已結束。
pause
