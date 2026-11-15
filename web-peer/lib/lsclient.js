// 對其他 LocalSend 裝置發出 HTTPS 請求(mTLS:一律出示我方憑證，並 pin 對方 fingerprint)
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { fingerprintOfDer } from './cert.js';

export class FingerprintMismatchError extends Error {
  constructor(expected, actual) {
    super(`對方憑證 fingerprint 不符（預期 ${expected.slice(0, 12)}…，實際 ${String(actual).slice(0, 12)}…）`);
    this.code = 'FP_MISMATCH';
  }
}

export class LsClient {
  constructor(identity) {
    this.identity = identity;
    this.agents = new Map();
    // maxCachedSessions: 0 —— 停用 TLS session 重用：Node 在重用的 session 上拿不到對方憑證,
    // 會讓 fingerprint pin 失效。每條新連線都做完整握手。
    const tls = { cert: identity.certPem, key: identity.keyPem, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], maxCachedSessions: 0 };
    // 掃描用：不保留連線
    this.scanAgent = new https.Agent({ ...tls, keepAlive: false, maxSockets: 64 });
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    this._tls = tls;
  }

  agentFor(fingerprint) {
    let a = this.agents.get(fingerprint);
    if (!a) {
      // 每台裝置一個 agent;手錶每個 IP 最多 8 條連線，這裡最多用 4 條。
      // 不重用連線：閒置的舊連線可能已被手錶（休眠、換網路）無聲關掉,
      // 在上面送 prepare-upload / upload 會直接失敗。每個請求重新握手只多花幾十毫秒。
      a = new https.Agent({ ...this._tls, keepAlive: false, maxSockets: 4 });
      this.agents.set(fingerprint, a);
    }
    return a;
  }

  /**
   * @param {object} o
   * @param {{ip:string, port:number, protocol?:string}} o.target
   * @param {string|null} o.fingerprint 預期的對方 fingerprint;null = 不 pin（子網掃描）
   * @param {string} o.path  例如 /api/localsend/v2/register
   * @param {Record<string,string>} [o.query]
   * @param {Buffer|string|Readable|null} [o.body]
   * @param {number} [o.contentLength]
   * @param {number} [o.timeoutMs] 整個請求的逾時；0 / 未設 = 不限
   * @returns {{promise: Promise<{status:number, headers:object, body:Buffer, peerFingerprint:string|null}>, abort: (reason?:string)=>void}}
   */
  request(o) {
    const isHttps = (o.target.protocol ?? 'https') === 'https';
    const qs = o.query ? '?' + new URLSearchParams(o.query).toString() : '';
    const expected = o.fingerprint ? o.fingerprint.toUpperCase() : null;
    let body = o.body ?? null;
    if (typeof body === 'string') body = Buffer.from(body, 'utf8');
    const headers = { ...(o.headers ?? {}) };
    if (Buffer.isBuffer(body)) headers['Content-Length'] = body.length;
    else if (body && o.contentLength != null) headers['Content-Length'] = o.contentLength;
    else if (!body) headers['Content-Length'] = 0;

    let req;
    let timer;
    let abortReason = null;
    const promise = new Promise((resolve, reject) => {
      const mod = isHttps ? https : http;
      const agent = isHttps ? (expected ? this.agentFor(expected) : this.scanAgent) : this.httpAgent;
      req = mod.request({
        host: o.target.ip,
        port: o.target.port,
        method: o.method ?? 'POST',
        path: o.path + qs,
        headers,
        agent,
      });
      let peerFingerprint = null;

      const fail = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      req.on('error', (err) => fail(abortReason ? Object.assign(new Error(abortReason), { code: 'ABORTED' }) : err));

      // 等對方憑證驗證通過才送出 body
      const ready = new Promise((ok) => {
        req.on('socket', (sock) => {
          // TCP keepalive:等手錶按接受時對方若消失，約 25 秒內就能發現，不會永遠卡在「等待對方接受」
          sock.setKeepAlive(true, 15_000);
          if (!isHttps) return ok();
          const check = (fp) => {
            peerFingerprint = fp;
            if (expected && fp !== expected) {
              req.destroy(new FingerprintMismatchError(expected, fp));
              return;
            }
            ok();
          };
          if (sock.__lsFp !== undefined) return check(sock.__lsFp);
          sock.once('secureConnect', () => {
            const c = sock.getPeerCertificate();
            sock.__lsFp = c && c.raw ? fingerprintOfDer(c.raw) : null;
            check(sock.__lsFp);
          });
        });
      });

      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 1024 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), peerFingerprint });
        });
        res.on('error', fail);
      });

      if (o.timeoutMs) {
        timer = setTimeout(() => {
          abortReason = 'timeout';
          req.destroy();
        }, o.timeoutMs);
      }

      ready.then(() => {
        if (req.destroyed) return;
        if (body instanceof Readable) {
          body.on('error', (e) => req.destroy(e));
          body.pipe(req);
        } else {
          req.end(body ?? undefined);
        }
      });
    });
    return {
      promise,
      abort: (reason = 'aborted') => {
        abortReason = reason;
        req?.destroy();
      },
    };
  }

  /** 方便用法：送 JSON 並解析回應 */
  async json(o) {
    const r = await this.request({ ...o, body: JSON.stringify(o.json), headers: { 'Content-Type': 'application/json' } }).promise;
    let data = null;
    try {
      data = r.body.length ? JSON.parse(r.body.toString('utf8')) : null;
    } catch {
      data = null;
    }
    return { ...r, data };
  }
}

/** 從錯誤回應取出訊息 */
export function errorMessage(r) {
  try {
    const j = JSON.parse(r.body.toString('utf8'));
    if (j && typeof j.message === 'string') return j.message;
  } catch {
    /* 不是 JSON */
  }
  return r.body.toString('utf8').slice(0, 200) || `HTTP ${r.status}`;
}
