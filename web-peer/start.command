#!/bin/bash
# LocalSend 電腦端的 Mac 版啟動檔：在 Finder 雙擊即可執行，功能和 Windows 的 start.bat 相同。
cd "$(dirname "$0")" || exit 1
printf '\033]0;LocalSend 電腦端\007'

# 從 Finder 雙擊時，PATH 不一定有 Homebrew 的路徑，補在最後當備援
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

pause() {
  echo
  read -n 1 -s -r -p "按任意鍵關閉視窗…"
  echo
}

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "[錯誤] 找不到 Node.js。"
  echo "請先到 https://nodejs.org/ 下載並安裝 LTS 版本（或執行 brew install node），安裝完成後再雙擊一次 start.command。"
  pause
  exit 1
fi

if [ ! -d node_modules/node-forge ]; then
  echo "第一次執行，正在安裝必要套件，請稍候..."
  if ! npm install --no-audit --no-fund; then
    echo
    echo "[錯誤] 套件安裝失敗，請確認網路連線後再試一次。"
    pause
    exit 1
  fi
fi

echo "正在啟動 LocalSend 電腦端，瀏覽器會自動開啟 http://127.0.0.1:53318"
echo
# 按 Ctrl+C 時由 node 自己收尾，這個腳本繼續往下顯示結束訊息
trap ':' INT
node server.js --open
echo
echo "LocalSend 電腦端已結束。"
pause
