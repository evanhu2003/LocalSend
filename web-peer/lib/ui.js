// 本機網頁介面伺服器：http://127.0.0.1:53318（只綁 localhost）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isInside, log, readJson, sendError, sendJson, TMP_DIR_NAME } from './util.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

export class UiServer {
  constructor({ state, receiver, sender, discovery, publicDir }) {
    this.state = state;
    this.receiver = receiver;
    this.sender = sender;
    this.discovery = discovery;
    this.publicDir = publicDir;
    this.clients = new Set();
    state.on('change', () => this.broadcast('state', state.snapshot()));
    state.on('notice', (n) => this.broadcast('notice', n));
    state.on('received', () => this.broadcast('received', {}));
  }

  start() {
    const port = this.state.config.uiPort;
    this.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    this.allowedOrigins = new Set([...this.allowedHosts].map((h) => `http://${h}`));
    this.server = http.createServer({ requestTimeout: 0 }, (req, res) => this.handle(req, res).catch((e) => {
      if (!e.status) log('網頁介面錯誤：', e);
      sendError(res, e.status ?? 500, e.message);
    }));
    setInterval(() => this.broadcastRaw(': ping\n\n'), 20_000).unref();
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  broadcastRaw(s) {
    for (const res of this.clients) res.write(s);
  }

  broadcast(event, data) {
    this.broadcastRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async handle(req, res) {
    // 防 DNS rebinding:只接受 127.0.0.1 / localhost 的 Host
    if (!this.allowedHosts.has(String(req.headers.host).toLowerCase())) {
      req.resume();
      return sendError(res, 403, 'Forbidden host');
    }
    // 防 CSRF / 跨站讀取：瀏覽器帶了 Origin 就必須是本頁；
    // 會改變狀態的請求若帶 Sec-Fetch-Site，也必須是同源
    const origin = req.headers.origin;
    if (origin !== undefined && !this.allowedOrigins.has(String(origin).toLowerCase())) {
      req.resume();
      return sendError(res, 403, 'Forbidden origin');
    }
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' && site !== undefined && site !== 'same-origin') {
      req.resume();
      return sendError(res, 403, 'Cross-site request blocked');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (req.method === 'GET') {
      if (STATIC[p]) return this.serveStatic(res, ...STATIC[p]);
      if (p === '/api/state') return sendJson(res, 200, this.state.snapshot());
      if (p === '/api/events') return this.sse(req, res);
      if (p === '/api/received') return sendJson(res, 200, this.listReceived());
      if (p.startsWith('/files/')) return this.serveFile(req, res, p.slice('/files/'.length));
      return sendError(res, 404, 'Not found');
    }

    // 所有會改變狀態的請求都要帶自訂 header:其他網站無法跨來源送出（會被 CORS preflight 擋下）
    if (req.headers['x-localsend-ui'] !== '1') {
      req.resume();
      return sendError(res, 403, 'Missing X-LocalSend-UI header');
    }

    if (req.method === 'POST' && p === '/api/stage') {
      const meta = await this.sender.stage(req, {
        name: url.searchParams.get('name'),
        type: url.searchParams.get('type'),
        lastModified: url.searchParams.get('lastModified'),
      });
      return sendJson(res, 200, { id: meta.id, fileName: meta.fileName, size: meta.size, fileType: meta.fileType });
    }
    if (req.method === 'DELETE' && p.startsWith('/api/stage/')) {
      req.resume();
      return sendJson(res, 200, { ok: this.sender.unstage(decodeURIComponent(p.slice('/api/stage/'.length))) });
    }
    if (req.method !== 'POST') {
      req.resume();
      return sendError(res, 404, 'Not found');
    }

    const body = (await readJson(req, 1024 * 1024)) ?? {};
    let m;
    switch (true) {
      case p === '/api/alias': {
        const alias = String(body.alias ?? '').trim().slice(0, 40);
        if (!alias) return sendError(res, 400, '名稱不可空白');
        this.state.config.alias = alias;
        this.state.config.save();
        this.state.changed();
        this.discovery.announce();
        return sendJson(res, 200, { ok: true });
      }
      case p === '/api/scan':
        this.discovery.scan().catch((e) => log('掃描失敗：', e.message));
        return sendJson(res, 200, { ok: true });
      case p === '/api/send': {
        const job = this.sender.send({
          fingerprint: String(body.fingerprint ?? ''),
          stagedIds: Array.isArray(body.stagedIds) ? body.stagedIds.map(String) : [],
          text: typeof body.text === 'string' ? body.text : null,
          pin: typeof body.pin === 'string' && body.pin ? body.pin : null,
        });
        return sendJson(res, 200, { jobId: job.id });
      }
      case !!(m = p.match(/^\/api\/send\/([\w-]+)\/cancel$/)):
        return sendJson(res, 200, { ok: await this.sender.cancel(m[1]) });
      case !!(m = p.match(/^\/api\/send\/([\w-]+)\/dismiss$/)):
        return sendJson(res, 200, { ok: this.sender.dismiss(m[1]) });
      case !!(m = p.match(/^\/api\/incoming\/([\w-]+)\/(accept|decline)$/)):
        return sendJson(res, 200, { ok: this.receiver.decide(m[1], m[2] === 'accept') });
      case p === '/api/receive/cancel':
        return sendJson(res, 200, { ok: await this.receiver.cancelLocal() });
      case p === '/api/messages/clear':
        this.state.messages = [];
        this.state.changed();
        return sendJson(res, 200, { ok: true });
      case p === '/api/open-folder':
        this.openFolder(this.state.config.receiveDirAbs);
        return sendJson(res, 200, { ok: true });
      default:
        return sendError(res, 404, 'Not found');
    }
  }

  serveStatic(res, file, type) {
    fs.readFile(path.join(this.publicDir, file), (err, buf) => {
      if (err) return sendError(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': buf.length });
      res.end(buf);
    });
  }

  sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(this.state.snapshot())}\n\n`);
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  /** 列出收件資料夾裡的檔案（最新在前，最多 300 個） */
  listReceived() {
    const root = this.state.config.receiveDirAbs;
    const out = [];
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.toLowerCase() === TMP_DIR_NAME) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 8) walk(full, depth + 1);
        } else if (e.isFile()) {
          try {
            const st = fs.statSync(full);
            out.push({ path: path.relative(root, full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs });
          } catch { /* 忽略 */ }
        }
      }
    };
    walk(root, 0);
    out.sort((a, b) => Math.max(b.ctime, b.mtime) - Math.max(a.ctime, a.mtime));
    return { dir: root, files: out.slice(0, 300) };
  }

  serveFile(req, res, encoded) {
    const root = this.state.config.receiveDirAbs;
    let rel;
    try {
      rel = encoded.split('/').map(decodeURIComponent).join(path.sep);
    } catch {
      return sendError(res, 400, 'Bad path');
    }
    const full = path.resolve(root, rel);
    const first = path.relative(root, full).split(path.sep)[0].toLowerCase();
    if (!isInside(root, full) || first === TMP_DIR_NAME) return sendError(res, 403, 'Forbidden');
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) return sendError(res, 404, 'Not found');
      const name = path.basename(full);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
    });
  }

  openFolder(dir) {
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } catch (e) {
      log('無法開啟資料夾：', e.message);
    }
  }
}
