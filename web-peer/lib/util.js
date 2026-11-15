// 共用小工具：檔名安全處理、MIME 推測、IP 正規化、JSON body 讀取
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/** 收件資料夾內的暫存子資料夾名稱 */
export const TMP_DIR_NAME = '.localsend-tmp';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** 清理單一路徑片段；回傳空字串表示應捨棄 */
export function sanitizeSegment(seg) {
  let s = String(seg).normalize('NFC');
  // 控制字元與 Windows 不允許的字元
  s = s.replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_');
  // 去掉前後空白、結尾的點與空白（Windows 會自動截掉，可能造成名稱衝突）
  s = s.trim().replace(/[. ]+$/g, '');
  if (s === '' || s === '.' || s === '..') return '';
  if (WINDOWS_RESERVED.test(s)) s = '_' + s;
  // 收件暫存資料夾的名稱保留給程式自己用，避免對方把檔案寫進去（啟動時會被清掉）
  if (s.toLowerCase() === TMP_DIR_NAME) s = '_' + s;
  // 限制長度（以 UTF-16 長度近似），保留副檔名
  if (s.length > 180) {
    const ext = path.extname(s).slice(0, 20);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s;
}

/**
 * 把對方提供的 fileName（可能含 / 子資料夾）轉成安全的相對路徑片段陣列。
 * 任何 `..`、絕對路徑、磁碟代號都會被移除。
 */
export function safeRelativeParts(fileName) {
  const parts = String(fileName ?? '')
    .split(/[\\/]+/)
    .map(sanitizeSegment)
    .filter(Boolean);
  if (parts.length === 0) parts.push('未命名檔案');
  // 子資料夾最多保留 8 層
  if (parts.length > 9) parts.splice(0, parts.length - 9);
  return parts;
}

/** 確認 target 位於 root 之內（含 root 本身則回 false） */
export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 在資料夾中找一個不會覆蓋既有檔案的名稱：a.jpg → a (1).jpg */
export function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

const MIME = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html',
  json: 'application/json', xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', apk: 'application/vnd.android.package-archive',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMime(fileName, fallback) {
  if (fallback && /^[\w.+-]+\/[\w.+-]+$/.test(fallback)) return fallback;
  const ext = path.extname(String(fileName)).slice(1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

/** "::ffff:192.168.1.2" → "192.168.1.2" */
export function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** 本機所有非內部 IPv4 位址 */
export function localIPv4() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        out.push({ name, address: a.address, netmask: a.netmask });
      }
    }
  }
  return out;
}

/** 讀取 JSON body（有大小上限） */
export function readJson(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj) {
  if (res.headersSent || res.destroyed) return;
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, body ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } : {});
  res.end(body);
}

export function sendError(res, status, message) {
  sendJson(res, status, { message });
}

export function log(...args) {
  const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  console.log(`[${t}]`, ...args);
}
