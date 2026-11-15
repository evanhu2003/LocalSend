// HTTPS 伺服器(53317):提供 LocalSend v2 端點，接收手錶傳來的檔案（PROTOCOL.md 第 4、6 節）
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fingerprintOfDer } from './cert.js';
import { isInside, log, normalizeIp, readJson, safeRelativeParts, sendError, sendJson, TMP_DIR_NAME, uniquePath } from './util.js';

const MAX_CHECKSUM_RETRIES = 3;
const SESSION_IDLE_MS = 3 * 60_000; // 接收 session 超過 3 分鐘沒動靜就結束
// 上傳中超過這段時間沒收到任何資料 → 視為斷線（手錶關 Wi-Fi、走出範圍時 TCP 不一定會送出 RST）
const UPLOAD_STALL_MS = 60_000;
const MAX_MESSAGES = 200;

export class Receiver {
  /** @param {import('./state.js').AppState} state @param {import('./lsclient.js').LsClient} client */
  constructor(state, client) {
    this.state = state;
    this.client = client;
    this.tmpDir = path.join(state.config.receiveDirAbs, TMP_DIR_NAME);
  }

  start() {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    // 清掉上次殘留的暫存檔
    for (const f of fs.readdirSync(this.tmpDir)) fs.rmSync(path.join(this.tmpDir, f), { recursive: true, force: true });

    const { certPem, keyPem } = this.state.identity;
    this.server = https.createServer({
      cert: certPem,
      key: keyPem,
      requestCert: true, // 要求用戶端憑證（手錶永遠會出示）
      rejectUnauthorized: false, // 對方是自簽，自行用 fingerprint 判斷
      ALPNProtocols: ['http/1.1'],
      requestTimeout: 0, // 大檔上傳可能超過預設 300 秒
      headersTimeout: 60_000,
      keepAliveTimeout: 10_000,
    }, (req, res) => this.handle(req, res).catch((e) => {
      log('處理請求時發生錯誤：', e);
      sendError(res, e.status ?? 500, e.status ? e.message : 'Internal server error');
    }));
    this.server.on('tlsClientError', () => { /* 掃描器或錯誤連線，忽略 */ });
    // TCP keepalive:對方無聲無息消失時（例如手錶休眠斷網），等待中的連線也能被偵測並關閉
    this.server.on('connection', (sock) => sock.setKeepAlive(true, 15_000));
    this.idleTimer = setInterval(() => this.checkIdle(), 10_000);
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.state.config.port, '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  stop() {
    clearInterval(this.idleTimer);
    this.server?.close();
  }

  peerFingerprint(req) {
    const c = req.socket.getPeerCertificate?.();
    return c && c.raw ? fingerprintOfDer(c.raw) : null;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const p = url.pathname;
    const ip = normalizeIp(req.socket.remoteAddress);
    const certFp = this.peerFingerprint(req);

    if (req.method === 'GET' && (p === '/api/localsend/v2/info' || p === '/api/localsend/v1/info')) {
      const s = this.state.selfInfo();
      return sendJson(res, 200, { alias: s.alias, version: s.version, deviceModel: s.deviceModel, deviceType: s.deviceType, fingerprint: s.fingerprint, download: false });
    }
    if (req.method !== 'POST' || !p.startsWith('/api/localsend/v2/')) {
      req.resume();
      return sendError(res, 404, 'Not found');
    }
    // 仿照手錶：未開網頁分享時強制 mTLS
    if (!certFp) {
      req.resume();
      return sendError(res, 403, 'Client certificate required');
    }
    switch (p) {
      case '/api/localsend/v2/register': return this.onRegister(req, res, ip, certFp);
      case '/api/localsend/v2/prepare-upload': return this.onPrepareUpload(req, res, ip, certFp, url);
      case '/api/localsend/v2/upload': return this.onUpload(req, res, ip, url);
      case '/api/localsend/v2/cancel': return this.onCancel(req, res, ip, url);
      default:
        req.resume();
        return sendError(res, 404, 'Not found');
    }
  }

  async onRegister(req, res, ip, certFp) {
    const dto = await readJson(req, 64 * 1024);
    if (!dto || typeof dto.alias !== 'string' || typeof dto.fingerprint !== 'string') return sendError(res, 400, 'Invalid JSON body');
    const s = this.state.selfInfo();
    // 先回應（手錶只等 500 ms）
    sendJson(res, 200, { alias: s.alias, version: s.version, deviceModel: s.deviceModel, deviceType: s.deviceType, fingerprint: s.fingerprint, download: false });
    // body fingerprint 必須等於用戶端憑證，否則靜默忽略（與手錶相同）
    if (dto.fingerprint.toUpperCase() !== certFp || certFp === s.fingerprint) return;
    const { isNew, device } = this.state.upsertDevice({
      fingerprint: certFp,
      alias: dto.alias.slice(0, 100),
      version: dto.version,
      deviceModel: typeof dto.deviceModel === 'string' ? dto.deviceModel : null,
      deviceType: typeof dto.deviceType === 'string' ? dto.deviceType : null,
      ip,
      port: Number(dto.port) || 53317,
      protocol: dto.protocol === 'http' ? 'http' : 'https',
    });
    if (isNew) log(`裝置向我們註冊：${device.alias}（${ip}）`);
  }

  async onPrepareUpload(req, res, ip, certFp, url) {
    const dto = await readJson(req);
    if (!dto || typeof dto !== 'object' || !dto.info || typeof dto.files !== 'object' || dto.files === null) {
      return sendError(res, 400, 'Invalid JSON body');
    }
    const files = [];
    for (const [key, f] of Object.entries(dto.files)) {
      if (!f || typeof f.fileName !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0) return sendError(res, 400, 'Invalid JSON body');
      files.push({
        id: typeof f.id === 'string' ? f.id : key,
        fileName: f.fileName.normalize('NFC'),
        size: f.size,
        fileType: typeof f.fileType === 'string' ? f.fileType : 'application/octet-stream',
        sha256: typeof f.sha256 === 'string' ? f.sha256.toLowerCase() : null,
        preview: typeof f.preview === 'string' ? f.preview : null,
        modified: f.metadata && typeof f.metadata.modified === 'string' ? f.metadata.modified : null,
        status: 'pending',
      });
    }
    if (files.length === 0) return sendError(res, 400, 'No files provided');

    const info = dto.info;
    const sender = {
      alias: typeof info.alias === 'string' ? info.alias.slice(0, 100) : '未知裝置',
      deviceModel: typeof info.deviceModel === 'string' ? info.deviceModel : null,
      deviceType: typeof info.deviceType === 'string' ? info.deviceType : null,
      fingerprint: certFp,
      ip,
      port: Number(info.port) || 53317,
      protocol: info.protocol === 'http' ? 'http' : 'https',
    };
    // 順便更新裝置列表
    if (certFp !== this.state.identity.fingerprint) {
      this.state.upsertDevice({ fingerprint: certFp, alias: sender.alias, deviceModel: sender.deviceModel, deviceType: sender.deviceType, ip, port: sender.port, protocol: sender.protocol });
    }

    // 文字訊息：只有 1 個 text/* 檔案且帶 preview → 直接顯示，回 204
    if (files.length === 1 && files[0].fileType.startsWith('text/') && files[0].preview !== null) {
      this.state.messages.push({ id: crypto.randomUUID(), from: sender.alias, fromFingerprint: certFp, text: files[0].preview.slice(0, 100_000), at: Date.now() });
      if (this.state.messages.length > MAX_MESSAGES) this.state.messages.splice(0, this.state.messages.length - MAX_MESSAGES);
      this.state.changed();
      this.state.notify('info', `收到來自「${sender.alias}」的文字訊息`);
      log(`收到文字訊息（來自 ${sender.alias}）`);
      res.writeHead(204);
      return res.end();
    }

    // 單一 session
    if (this.state.incoming || this.state.receive) return sendError(res, 409, 'Blocked by another session');

    const incoming = {
      id: crypto.randomUUID(),
      sender,
      files,
      deadline: Date.now() + this.state.config.acceptTimeoutSec * 1000,
      res,
    };
    this.state.incoming = incoming;
    this.state.changed();
    this.state.notify('incoming', `「${sender.alias}」想傳送 ${files.length} 個檔案給你`);
    log(`傳入請求：${sender.alias}（${ip}），${files.length} 個檔案`);

    incoming.timer = setTimeout(() => this.decide(incoming.id, false, 'timeout'), this.state.config.acceptTimeoutSec * 1000);
    // 對方等待中直接斷線 = 取消
    res.on('close', () => {
      if (this.state.incoming === incoming && !res.writableEnded) {
        clearTimeout(incoming.timer);
        this.state.incoming = null;
        this.state.changed();
        this.state.notify('warn', `「${sender.alias}」已取消傳送`);
        log('對方在等待接受時取消了');
      }
    });
  }

  /** 網頁上按下接受 / 拒絕 */
  decide(id, accept, reason = 'user') {
    const inc = this.state.incoming;
    if (!inc || inc.id !== id) return false;
    clearTimeout(inc.timer);
    this.state.incoming = null;
    if (!accept) {
      sendError(inc.res, 403, reason === 'timeout' ? 'Rejected (timeout)' : 'Rejected');
      if (reason === 'timeout') this.state.notify('warn', `「${inc.sender.alias}」的傳送請求已逾時，自動拒絕`);
      log(`已拒絕傳入請求（${reason}）`);
      this.state.changed();
      return true;
    }
    const sessionId = crypto.randomUUID();
    const tokens = {};
    for (const f of inc.files) {
      f.token = crypto.randomUUID();
      f.received = 0;
      f.attempts = 0;
      tokens[f.id] = f.token;
    }
    this.state.receive = {
      sessionId,
      sender: inc.sender,
      files: inc.files,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      uploads: new Set(), // 進行中的上傳請求，session 被取消時一併中斷
    };
    sendJson(inc.res, 200, { sessionId, files: tokens });
    log(`已接受傳入請求，session ${sessionId}`);
    this.state.changed();
    return true;
  }

  async onUpload(req, res, ip, url) {
    const sessionId = url.searchParams.get('sessionId');
    const fileId = url.searchParams.get('fileId');
    const token = url.searchParams.get('token');
    if (!sessionId || !fileId || !token) {
      req.resume();
      return sendError(res, 400, 'Missing parameters');
    }
    const session = this.state.receive;
    const file = session?.files.find((f) => f.id === fileId);
    if (!session || session.sessionId !== sessionId || session.sender.ip !== ip || !file || file.token !== token || file.status !== 'pending') {
      req.resume();
      return sendError(res, 403, 'Invalid token or IP address');
    }

    file.status = 'receiving';
    file.received = 0;
    file.attempts++;
    session.lastActivity = Date.now();
    this.state.changed();

    const tmp = path.join(this.tmpDir, `${crypto.randomUUID()}.part`);
    const out = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha256');
    let tooMuch = false;
    let lastPush = 0;

    session.uploads.add(req);
    const result = await new Promise((resolve) => {
      let done = false;
      let stall = null;
      const armStall = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          log(`上傳 ${file.fileName} 超過 ${UPLOAD_STALL_MS / 1000} 秒沒有資料，視為斷線`);
          finish('stalled');
          req.destroy();
        }, UPLOAD_STALL_MS);
      };
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(stall);
        resolve(r);
      };
      armStall();
      req.on('data', (chunk) => {
        if (tooMuch) return;
        armStall();
        file.received += chunk.length;
        if (file.received > file.size) {
          tooMuch = true;
          req.unpipe(out);
          finish('size');
          return;
        }
        hash.update(chunk);
        session.lastActivity = Date.now();
        if (Date.now() - lastPush > 250) {
          lastPush = Date.now();
          this.state.changed();
        }
      });
      req.on('aborted', () => finish('aborted'));
      req.on('error', () => finish('aborted'));
      res.on('close', () => { if (!res.writableEnded) finish('aborted'); });
      out.on('error', (e) => {
        log('寫入檔案失敗：', e.message);
        finish('write');
      });
      req.pipe(out);
      out.on('finish', () => finish('ok'));
    });

    session.uploads.delete(req);
    // 這段期間 session 可能已被取消
    const stillActive = this.state.receive === session;
    if (result !== 'ok' || !stillActive) {
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      if (stillActive) {
        file.status = 'failed';
        file.error = { size: '大小超過宣告值', aborted: '連線中斷', stalled: '連線逾時', write: '寫入磁碟失敗' }[result] ?? result;
        this.afterFileDone(session);
      }
      if (result === 'size') {
        sendError(res, 500, 'File size mismatch');
        req.destroy();
      } else if (!res.destroyed) {
        sendError(res, stillActive ? 500 : 403, stillActive ? 'Upload failed' : 'Session cancelled');
      }
      return;
    }
    if (file.received !== file.size) {
      fs.rm(tmp, { force: true }, () => {});
      file.status = 'failed';
      file.error = `大小不符（收到 ${file.received}，應為 ${file.size}）`;
      this.afterFileDone(session);
      return sendError(res, 500, 'File size mismatch');
    }
    const digest = hash.digest('hex');
    if (file.sha256 && file.sha256 !== digest) {
      fs.rm(tmp, { force: true }, () => {});
      if (file.attempts >= MAX_CHECKSUM_RETRIES) {
        file.status = 'failed';
        file.error = 'SHA-256 校驗失敗';
        this.afterFileDone(session);
      } else {
        file.status = 'pending'; // 允許重傳
        file.received = 0;
        this.state.changed();
      }
      return sendError(res, 422, 'Checksum mismatch');
    }

    try {
      const saved = this.moveIntoPlace(tmp, file);
      file.savedRel = path.relative(this.state.config.receiveDirAbs, saved).split(path.sep).join('/');
      file.status = 'finished';
      log(`已收到檔案：${file.savedRel}（${file.size} bytes）`);
      sendJson(res, 200, undefined);
      this.state.emit('received');
    } catch (e) {
      fs.rm(tmp, { force: true }, () => {});
      file.status = 'failed';
      file.error = '無法儲存檔案：' + e.message;
      sendError(res, 500, 'Could not save file');
    }
    this.afterFileDone(session);
  }

  moveIntoPlace(tmp, file) {
    const root = this.state.config.receiveDirAbs;
    const parts = safeRelativeParts(file.fileName);
    const name = parts.pop();
    const dir = path.join(root, ...parts);
    if (dir !== root && !isInside(root, dir)) throw new Error('路徑不合法');
    fs.mkdirSync(dir, { recursive: true });
    const target = uniquePath(dir, name);
    if (!isInside(root, target)) throw new Error('路徑不合法');
    fs.renameSync(tmp, target);
    if (file.modified) {
      const t = new Date(file.modified);
      if (!Number.isNaN(t.getTime())) {
        try { fs.utimesSync(target, new Date(), t); } catch { /* 忽略 */ }
      }
    }
    return target;
  }

  afterFileDone(session) {
    this.state.changed();
    if (this.state.receive !== session) return;
    const allDone = session.files.every((f) => f.status === 'finished' || f.status === 'failed');
    if (allDone) this.endSession(session, 'done');
  }

  endSession(session, reason) {
    if (this.state.receive !== session) return;
    session.finishedAt = Date.now();
    this.state.receive = null;
    const ok = session.files.filter((f) => f.status === 'finished').length;
    const msg = reason === 'done'
      ? `已從「${session.sender.alias}」收到 ${ok}/${session.files.length} 個檔案`
      : reason === 'remote-cancel' ? `「${session.sender.alias}」取消了傳送`
        : reason === 'idle' ? '對方太久沒有上傳，接收已結束' : '接收已取消';
    this.state.notify(reason === 'done' && ok === session.files.length ? 'success' : 'warn', msg);
    log(msg);
    this.state.lastReceive = session;
    // 取消 / 逾時：中斷還在傳的上傳，暫存檔會在 onUpload 裡刪掉
    for (const r of session.uploads) r.destroy();
    session.uploads.clear();
    this.state.changed();
    this.state.emit('received');
  }

  async onCancel(req, res, ip, url) {
    req.resume();
    const sessionId = url.searchParams.get('sessionId');
    const inc = this.state.incoming;
    if (inc && inc.sender.ip === ip && !sessionId) {
      clearTimeout(inc.timer);
      this.state.incoming = null;
      sendError(inc.res, 403, 'Cancelled by sender');
      this.state.notify('warn', `「${inc.sender.alias}」已取消傳送`);
      this.state.changed();
    }
    const s = this.state.receive;
    if (s && s.sessionId === sessionId && s.sender.ip === ip) {
      for (const f of s.files) if (f.status === 'pending' || f.status === 'receiving') { f.status = 'failed'; f.error = '對方已取消'; }
      this.endSession(s, 'remote-cancel');
    } else if (sessionId) {
      // 可能是手錶要取消「我們傳給它」的工作
      this.state.emit('remote-cancel', { sessionId, ip });
    }
    sendJson(res, 200, undefined);
  }

  /** 網頁上按「取消接收」 */
  async cancelLocal() {
    const s = this.state.receive;
    if (!s) return false;
    for (const f of s.files) if (f.status === 'pending' || f.status === 'receiving') { f.status = 'failed'; f.error = '已取消'; }
    this.endSession(s, 'local-cancel');
    // 通知手錶停止上傳（手錶會依 sessionId + 來源 IP 找到它的傳送）
    try {
      await this.client.request({
        target: { ip: s.sender.ip, port: s.sender.port, protocol: s.sender.protocol },
        fingerprint: s.sender.fingerprint,
        path: '/api/localsend/v2/cancel',
        query: { sessionId: s.sessionId },
        timeoutMs: 3000,
      }).promise;
    } catch (e) {
      log('通知對方取消失敗：', e.message);
    }
    return true;
  }

  checkIdle() {
    const s = this.state.receive;
    if (!s) return;
    const busy = s.files.some((f) => f.status === 'receiving');
    if (!busy && Date.now() - s.lastActivity > SESSION_IDLE_MS) {
      for (const f of s.files) if (f.status === 'pending') { f.status = 'failed'; f.error = '逾時未上傳'; }
      this.endSession(s, 'idle');
    }
  }
}
