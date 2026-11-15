// 傳送端：暫存瀏覽器上傳的檔案，再以 prepare-upload / upload / cancel 傳給手錶（PROTOCOL.md 第 5、6.2 節）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline, Transform } from 'node:stream';
import { errorMessage } from './lsclient.js';
import { guessMime, log, sanitizeSegment } from './util.js';

const MAX_PARALLEL = 2;
const MAX_ATTEMPTS = 4; // 1 次 + 校驗失敗(422)重傳 3 次

export class Sender {
  /** @param {import('./state.js').AppState} state @param {import('./lsclient.js').LsClient} client */
  constructor(state, client) {
    this.state = state;
    this.client = client;
    this.stageDir = path.join(state.config.dataDir, 'staging');
    /** @type {Map<string, any>} */
    this.staged = new Map();
    fs.rmSync(this.stageDir, { recursive: true, force: true });
    fs.mkdirSync(this.stageDir, { recursive: true });
    state.on('remote-cancel', ({ sessionId, ip }) => {
      for (const job of state.sendJobs.values()) {
        if (job.remoteSessionId === sessionId && job.target.ip === ip && job.status === 'sending') {
          this.abortJob(job, 'cancelled', '對方已取消接收');
        }
      }
    });
  }

  /** 把瀏覽器送來的檔案串流寫到暫存區，同時計算 SHA-256 */
  stage(req, { name, type, lastModified }) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const file = path.join(this.stageDir, id);
      const out = fs.createWriteStream(file);
      const hash = crypto.createHash('sha256');
      let size = 0;
      let failed = false;
      const fail = (e) => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.rm(file, { force: true }, () => {});
        reject(e);
      };
      req.on('data', (c) => {
        size += c.length;
        hash.update(c);
      });
      req.on('aborted', () => fail(new Error('上傳中斷')));
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        if (failed) return;
        const fileName = (String(name ?? '').split(/[\\/]/).map(sanitizeSegment).filter(Boolean).pop()) || '未命名檔案';
        const meta = {
          id,
          fileName,
          size,
          fileType: guessMime(fileName, type),
          sha256: hash.digest('hex'),
          modified: Number(lastModified) > 0 ? new Date(Number(lastModified)).toISOString() : null,
          path: file,
        };
        this.staged.set(id, meta);
        resolve(meta);
      });
      req.pipe(out);
    });
  }

  unstage(id) {
    const m = this.staged.get(id);
    if (!m) return false;
    this.staged.delete(id);
    fs.rm(m.path, { force: true }, () => {});
    return true;
  }

  /** 開始一個傳送工作 */
  send({ fingerprint, stagedIds = [], text = null, pin = null }) {
    const device = this.state.devices.get(fingerprint);
    if (!device) throw Object.assign(new Error('找不到這台裝置，請重新掃描'), { status: 404 });
    const files = [];
    if (text != null && text !== '') {
      const buf = Buffer.from(String(text), 'utf8');
      files.push({
        id: crypto.randomUUID(),
        fileName: `${crypto.randomUUID()}.txt`,
        size: buf.length,
        fileType: 'text/plain',
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        preview: String(text),
        buffer: buf,
        status: 'pending',
        sent: 0,
      });
    } else {
      for (const sid of stagedIds) {
        const m = this.staged.get(sid);
        if (!m) throw Object.assign(new Error('有檔案已不在暫存區，請重新選擇'), { status: 400 });
        files.push({ id: crypto.randomUUID(), fileName: m.fileName, size: m.size, fileType: m.fileType, sha256: m.sha256, modified: m.modified, path: m.path, stagedId: sid, status: 'pending', sent: 0 });
      }
    }
    if (files.length === 0) throw Object.assign(new Error('沒有要傳送的內容'), { status: 400 });

    const job = {
      id: crypto.randomUUID(),
      target: { fingerprint: device.fingerprint, alias: device.alias, ip: device.ip, port: device.port, protocol: device.protocol },
      files,
      text,
      stagedIds,
      status: 'waiting',
      message: null,
      createdAt: Date.now(),
      handles: new Set(),
    };
    this.state.sendJobs.set(job.id, job);
    // 只保留最近 20 筆
    const ids = [...this.state.sendJobs.keys()];
    for (const old of ids.slice(0, Math.max(0, ids.length - 20))) {
      const j = this.state.sendJobs.get(old);
      if (!['waiting', 'sending'].includes(j.status)) this.state.sendJobs.delete(old);
    }
    this.state.changed();
    this.run(job, pin).catch((e) => {
      if (job.status === 'waiting' || job.status === 'sending') this.setStatus(job, 'failed', e.message);
    });
    return job;
  }

  setStatus(job, status, message = null) {
    job.status = status;
    job.message = message;
    this.state.changed();
    log(`傳送給 ${job.target.alias}：${status}${message ? '（' + message + '）' : ''}`);
  }

  async run(job, pin) {
    const t = job.target;
    const filesDto = {};
    for (const f of job.files) {
      filesDto[f.id] = {
        id: f.id,
        fileName: f.fileName,
        size: f.size,
        fileType: f.fileType,
        sha256: f.sha256,
        ...(f.preview != null ? { preview: f.preview } : {}),
        ...(f.modified ? { metadata: { modified: f.modified } } : {}),
      };
    }
    const handle = this.client.request({
      target: t,
      fingerprint: t.protocol === 'https' ? t.fingerprint : null,
      path: '/api/localsend/v2/prepare-upload',
      query: pin ? { pin } : undefined,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ info: this.state.selfInfo(), files: filesDto }),
      // 不設逾時：手錶使用者可能要一段時間才按接受
    });
    job.handles.add(handle);
    let r;
    try {
      r = await handle.promise;
    } catch (e) {
      if (job.status !== 'waiting') return; // 已被取消
      return this.setStatus(job, 'failed', e.code === 'FP_MISMATCH' ? e.message : `無法連線：${e.message}`);
    } finally {
      job.handles.delete(handle);
    }
    if (job.status !== 'waiting') return;

    switch (r.status) {
      case 200: break;
      case 204:
        for (const f of job.files) f.status = 'finished';
        return this.setStatus(job, 'done', job.text ? '對方已收到訊息' : '對方不需要這些檔案');
      case 401: return this.setStatus(job, 'pin_required', pin ? 'PIN 碼錯誤' : '對方要求輸入 PIN 碼');
      case 403: return this.setStatus(job, 'rejected', '對方拒絕了');
      case 409: return this.setStatus(job, 'busy', '對方正在進行其他傳輸');
      case 429: return this.setStatus(job, 'failed', 'PIN 嘗試次數過多，請稍後再試');
      default: return this.setStatus(job, 'failed', errorMessage(r));
    }

    let data;
    try {
      data = JSON.parse(r.body.toString('utf8'));
    } catch {
      data = null;
    }
    if (!data || typeof data.sessionId !== 'string' || typeof data.files !== 'object' || !data.files) {
      return this.setStatus(job, 'failed', '對方回應格式錯誤');
    }
    job.remoteSessionId = data.sessionId;
    const queue = [];
    for (const f of job.files) {
      const token = data.files[f.id];
      if (typeof token === 'string') {
        f.token = token;
        queue.push(f);
      } else {
        f.status = 'skipped';
      }
    }
    if (queue.length === 0) return this.setStatus(job, 'done', '對方沒有接受任何檔案');
    this.setStatus(job, 'sending');

    const worker = async () => {
      while (queue.length && job.status === 'sending') {
        const f = queue.shift();
        await this.uploadFile(job, f);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, worker));
    if (job.status !== 'sending') return;
    const ok = job.files.filter((f) => f.status === 'finished').length;
    const total = job.files.filter((f) => f.status !== 'skipped').length;
    if (ok === total) this.setStatus(job, 'done', `已傳送 ${ok} 個檔案`);
    else this.setStatus(job, 'failed', `只成功 ${ok}/${total} 個檔案`);
  }

  async uploadFile(job, f) {
    const t = job.target;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && job.status === 'sending'; attempt++) {
      f.status = 'sending';
      f.sent = 0;
      this.state.changed();
      let body;
      if (f.buffer) {
        body = f.buffer;
      } else {
        try {
          await fs.promises.access(f.path);
        } catch {
          f.status = 'failed';
          f.error = '暫存檔已被移除';
          return;
        }
        // 注意：不可直接對讀取串流掛 'data' 監聽 —— 那會讓它立刻開始流動,
        // 而 lsclient 要等 TLS 握手、核對 fingerprint 後才 pipe，中間讀出的資料會遺失,
        // 對方收不滿 Content-Length 就會永遠卡住。改用 Transform 計數：沒人讀取時會暫停。
        const src = fs.createReadStream(f.path, { highWaterMark: 256 * 1024 });
        let last = 0;
        const counter = new Transform({
          transform: (chunk, _enc, cb) => {
            f.sent += chunk.length;
            if (Date.now() - last > 250) {
              last = Date.now();
              this.state.changed();
            }
            cb(null, chunk);
          },
        });
        body = pipeline(src, counter, () => { /* 錯誤由 request 處理；這裡只負責連帶關閉 */ });
      }
      const handle = this.client.request({
        target: t,
        fingerprint: t.protocol === 'https' ? t.fingerprint : null,
        path: '/api/localsend/v2/upload',
        query: { sessionId: job.remoteSessionId, fileId: f.id, token: f.token },
        body,
        contentLength: f.size,
      });
      job.handles.add(handle);
      try {
        const r = await handle.promise;
        if (r.status === 200) {
          f.sent = f.size;
          f.status = 'finished';
          this.state.changed();
          return;
        }
        if (r.status === 422 && attempt < MAX_ATTEMPTS) {
          log(`檔案 ${f.fileName} 校驗失敗，重傳（第 ${attempt} 次）`);
          continue;
        }
        f.status = 'failed';
        f.error = errorMessage(r);
        this.state.changed();
        return;
      } catch (e) {
        if (job.status !== 'sending') return;
        f.status = 'failed';
        f.error = e.message;
        this.state.changed();
        return;
      } finally {
        job.handles.delete(handle);
        if (body && typeof body.destroy === 'function') body.destroy();
      }
    }
  }

  abortJob(job, status, message) {
    const wasSending = job.status === 'sending';
    if (!['waiting', 'sending'].includes(job.status)) return false;
    this.setStatus(job, status, message);
    for (const f of job.files) if (f.status === 'pending' || f.status === 'sending') f.status = 'failed';
    for (const h of job.handles) h.abort('cancelled');
    job.handles.clear();
    return wasSending;
  }

  /** 網頁上按「取消」 */
  async cancel(jobId) {
    const job = this.state.sendJobs.get(jobId);
    if (!job) return false;
    const wasSending = this.abortJob(job, 'cancelled', '已取消');
    // 等待接受中：中斷連線即可（手錶也這麼做）；上傳中：通知對方結束 session
    if (wasSending && job.remoteSessionId) {
      try {
        await this.client.request({
          target: job.target,
          fingerprint: job.target.protocol === 'https' ? job.target.fingerprint : null,
          path: '/api/localsend/v2/cancel',
          query: { sessionId: job.remoteSessionId },
          timeoutMs: 3000,
        }).promise;
      } catch (e) {
        log('送出取消請求失敗：', e.message);
      }
    }
    return true;
  }

  dismiss(jobId) {
    const job = this.state.sendJobs.get(jobId);
    if (!job || ['waiting', 'sending'].includes(job.status)) return false;
    this.state.sendJobs.delete(jobId);
    this.state.changed();
    return true;
  }
}
