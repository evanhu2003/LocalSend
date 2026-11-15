// LocalSend 相容 PC 節點：HTTPS 53317（協定）+ HTTP 127.0.0.1:53318（網頁介面）
// 用法：node server.js [--open]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateIdentity } from './lib/cert.js';
import { loadConfig } from './lib/config.js';
import { Discovery } from './lib/discovery.js';
import { LsClient } from './lib/lsclient.js';
import { Receiver } from './lib/receiver.js';
import { Sender } from './lib/sender.js';
import { AppState } from './lib/state.js';
import { UiServer } from './lib/ui.js';
import { localIPv4, log } from './lib/util.js';

const baseDir = path.dirname(fileURLToPath(import.meta.url));

function fatal(msg, err) {
  console.error('\n[錯誤] ' + msg);
  if (err) console.error('       ' + (err.message ?? err));
  process.exit(1);
}

async function main() {
  const config = loadConfig(baseDir);
  const isFirst = !fs.existsSync(path.join(config.dataDir, 'cert.pem'));
  if (isFirst) log('第一次執行，正在產生憑證…');
  const identity = loadOrCreateIdentity(config.dataDir);

  const state = new AppState(config, identity);
  const client = new LsClient(identity);
  const receiver = new Receiver(state, client);
  const sender = new Sender(state, client);
  const discovery = new Discovery(state, client);
  const ui = new UiServer({ state, receiver, sender, discovery, publicDir: path.join(baseDir, 'public') });

  try {
    await receiver.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') fatal(`連接埠 ${config.port} 已被占用。請先關閉電腦上的 LocalSend 官方程式或其他 web-peer 視窗再試一次。`);
    fatal('無法啟動 LocalSend 伺服器', e);
  }
  try {
    await ui.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') fatal(`網頁介面連接埠 ${config.uiPort} 已被占用，可能已經有一個 web-peer 在執行。`);
    fatal('無法啟動網頁介面', e);
  }
  try {
    await discovery.start();
  } catch (e) {
    log(`多播探索無法啟動（${e.message}），仍可使用「掃描網段」尋找裝置。`);
  }

  const uiUrl = `http://127.0.0.1:${config.uiPort}`;
  console.log('');
  console.log('==============================================');
  console.log(' LocalSend Web Peer 已啟動');
  console.log(`  裝置名稱：${config.alias}`);
  console.log(`  本機 IP：${localIPv4().map((i) => i.address).join('、') || '（無）'}`);
  console.log(`  協定埠：${config.port}（HTTPS / UDP 多播）`);
  console.log(`  網頁介面：${uiUrl}`);
  console.log(`  收件資料夾：${config.receiveDirAbs}`);
  console.log(`  憑證指紋：${identity.fingerprint}`);
  console.log(' 關閉這個視窗或按 Ctrl+C 即可結束。');
  console.log('==============================================');
  console.log('');

  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', uiUrl]]
      : process.platform === 'darwin' ? ['open', [uiUrl]] : ['xdg-open', [uiUrl]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  }

  const shutdown = () => {
    log('正在結束…');
    discovery.stop();
    receiver.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('uncaughtException', (e) => log('未預期的錯誤：', e));
process.on('unhandledRejection', (e) => log('未處理的錯誤：', e));

main().catch((e) => fatal('啟動失敗', e));
