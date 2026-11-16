// Tailscale 整合：讀取 `tailscale status --json`，列出 tailnet 上在線的裝置 IPv4
// tailnet 沒有多播，所以由電腦主動對每台在線裝置送 register（見 discovery.js）。
// 測試用：設定環境變數 LS_TAILSCALE_STATUS_FILE=<json 檔路徑>，改從檔案讀取狀態，不呼叫 CLI。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Windows 先用安裝路徑的絕對路徑：只寫 'tailscale' 時，libuv 會先在目前資料夾找 tailscale.exe 再找 PATH
const CANDIDATES = process.platform === 'win32'
  ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), 'tailscale']
  : ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function run(cmd) {
  return new Promise((resolve, reject) => {
    // execFile 不經過 shell，參數固定，路徑含空白也不需要另外加引號
    execFile(cmd, ['status', '--json'], { timeout: 4000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      // 未登入 / 已停止時 CLI 仍可能輸出 JSON 但結束碼非 0，優先採用 stdout
      if (stdout && stdout.trim().startsWith('{')) return resolve(stdout);
      if (err) {
        err.stderr = String(stderr ?? '').trim();
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

function failReason(e) {
  if (e.code === 'NOT_INSTALLED') return '未安裝 Tailscale';
  if (e.killed || e.signal) return 'tailscale 指令逾時';
  if (e instanceof SyntaxError) return '無法解析 tailscale 狀態';
  if (/failed to connect|connection refused|is tailscaled? running/i.test(e.stderr ?? '')) return 'Tailscale 服務未執行';
  return `無法執行 tailscale（${(e.stderr || e.message).split(/\r?\n/)[0].slice(0, 200)}）`;
}

const unavailable = (reason, installed = true) => ({ available: false, installed, reason, selfIps: [], peers: [], offlineIps: [], tailnetIps: [] });

export class Tailscale {
  constructor() {
    this.cmd = null; // 成功執行過的 CLI 路徑
  }

  async readRaw() {
    const file = process.env.LS_TAILSCALE_STATUS_FILE;
    if (file) return (await fs.readFile(file, 'utf8')).replace(/^﻿/, ''); // 記事本等工具存檔時可能加上 BOM
    const list = this.cmd ? [this.cmd, ...CANDIDATES.filter((c) => c !== this.cmd)] : CANDIDATES;
    let lastErr = null;
    for (const cmd of list) {
      try {
        const out = await run(cmd);
        this.cmd = cmd;
        return out;
      } catch (e) {
        lastErr = e;
        if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EPERM') continue; // 換下一個位置
        throw e;
      }
    }
    throw Object.assign(new Error('找不到 tailscale 指令'), { code: 'NOT_INSTALLED', cause: lastErr });
  }

  /**
   * @returns {Promise<{available:boolean, installed:boolean, reason:string|null, selfIps:string[],
   *   peers:{ip:string, hostName:string, os:string}[], offlineIps:string[], tailnetIps:string[]}>}
   *   peers：和本機同一個帳號、在線上的裝置（每個 IPv4 一筆），只探測這些；
   *   offlineIps：同帳號但離線的裝置 IPv4；tailnetIps：tailnet 上所有裝置（含本機）的 IPv4 / IPv6。
   *   available=false 時 reason 說明原因；不會丟出例外。
   */
  async status() {
    let j;
    try {
      j = JSON.parse(await this.readRaw());
    } catch (e) {
      return unavailable(failReason(e), e.code !== 'NOT_INSTALLED');
    }
    if (!j || typeof j !== 'object') return unavailable('無法解析 tailscale 狀態');
    if (j.BackendState !== 'Running') {
      const reason = j.BackendState === 'NeedsLogin' || j.BackendState === 'NeedsMachineAuth' ? 'Tailscale 尚未登入'
        : j.BackendState === 'Stopped' ? 'Tailscale 已停止' : `Tailscale 狀態：${j.BackendState ?? '未知'}`;
      return unavailable(reason);
    }
    const list = (ips) => (Array.isArray(ips) ? ips : []).filter((ip) => typeof ip === 'string');
    const v4 = (ips) => list(ips).filter((ip) => IPV4.test(ip));
    const selfIps = v4(j.Self?.TailscaleIPs);
    const self = new Set(selfIps);
    const selfUser = j.Self?.UserID;
    const tailnetIps = new Set(list(j.Self?.TailscaleIPs).map((ip) => ip.toLowerCase()));
    const peers = [];
    const offlineIps = [];
    const seen = new Set();
    for (const p of Object.values(j.Peer ?? {})) {
      if (!p) continue;
      for (const ip of list(p.TailscaleIPs)) tailnetIps.add(ip.toLowerCase());
      // 只探測同一個帳號的裝置：不對同一個 tailnet 裡別人的電腦、分享進來的裝置發送本機名稱與 fingerprint
      if (p.ShareeNode === true || (selfUser != null && p.UserID !== selfUser)) continue;
      for (const ip of v4(p.TailscaleIPs)) {
        if (self.has(ip) || seen.has(ip)) continue;
        seen.add(ip);
        if (p.Online === true) peers.push({ ip, hostName: String(p.HostName ?? ''), os: String(p.OS ?? '') });
        else offlineIps.push(ip);
      }
    }
    return { available: true, installed: true, reason: null, selfIps, peers, offlineIps, tailnetIps: [...tailnetIps] };
  }
}
