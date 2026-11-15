// 設定檔：web-peer/data/config.json
// 可用環境變數覆寫：LOCALSEND_RECEIVE_DIR、LOCALSEND_ALIAS、LOCALSEND_UI_PORT
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadConfig(baseDir) {
  const dataDir = path.join(baseDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');

  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* 第一次執行或檔案損毀：使用預設值 */
  }

  const defaults = {
    alias: (os.hostname() || '我的電腦').slice(0, 40),
    receiveDir: './received',
    port: 53317,
    uiPort: 53318,
    // 等待使用者在網頁上按「接受/拒絕」的時間（秒），逾時視為拒絕
    acceptTimeoutSec: 120,
    // 週期性多播宣告間隔（秒）,0 = 關閉
    announceIntervalSec: 60,
  };

  const cfg = { ...defaults, ...saved };
  if (process.env.LOCALSEND_ALIAS) cfg.alias = process.env.LOCALSEND_ALIAS;
  if (process.env.LOCALSEND_RECEIVE_DIR) cfg.receiveDir = process.env.LOCALSEND_RECEIVE_DIR;
  if (process.env.LOCALSEND_UI_PORT) cfg.uiPort = Number(process.env.LOCALSEND_UI_PORT);

  const config = {
    ...cfg,
    dataDir,
    receiveDirAbs: path.resolve(baseDir, cfg.receiveDir),
    save() {
      const out = {
        alias: config.alias,
        receiveDir: cfg.receiveDir,
        port: config.port,
        uiPort: cfg.uiPort,
        acceptTimeoutSec: config.acceptTimeoutSec,
        announceIntervalSec: config.announceIntervalSec,
      };
      fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    },
  };
  fs.mkdirSync(config.receiveDirAbs, { recursive: true });
  if (!fs.existsSync(file)) config.save();
  return config;
}
