// 全域狀態 + 變更通知（給網頁 SSE 用）
import { EventEmitter } from 'node:events';

export class AppState extends EventEmitter {
  constructor(config, identity) {
    super();
    this.config = config;
    this.identity = identity;
    /** @type {Map<string, any>} fingerprint → 裝置 */
    this.devices = new Map();
    /** 等待網頁決定的傳入請求（最多一個，因為單一 session） */
    this.incoming = null;
    /** 進行中的接收 session */
    this.receive = null;
    /** @type {Map<string, any>} jobId → 傳送工作 */
    this.sendJobs = new Map();
    /** 收到的文字訊息 */
    this.messages = [];
    /** 是否正在掃描網段 */
    this.scanning = false;
    this._timer = null;
  }

  /** 我方的 RegisterDto / announce 內容 */
  selfInfo() {
    return {
      alias: this.config.alias,
      version: '2.2',
      deviceModel: 'Windows',
      deviceType: 'desktop',
      fingerprint: this.identity.fingerprint,
      port: this.config.port,
      protocol: 'https',
      download: false,
    };
  }

  upsertDevice(d) {
    const prev = this.devices.get(d.fingerprint);
    const next = { ...prev, ...d, lastSeen: Date.now(), failures: 0 };
    this.devices.set(d.fingerprint, next);
    this.changed();
    return { device: next, isNew: !prev };
  }

  /** 狀態有變：合併 120ms 內的多次變更再推送 */
  changed() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.emit('change');
    }, 120);
  }

  notify(level, text) {
    this.emit('notice', { level, text, at: Date.now() });
  }

  snapshot() {
    const pickFiles = (files) => files.map((f) => ({
      id: f.id, fileName: f.fileName, size: f.size, fileType: f.fileType,
      status: f.status, received: f.received ?? 0, sent: f.sent ?? 0, error: f.error ?? null,
      savedAs: f.savedRel ?? null,
    }));
    return {
      self: { alias: this.config.alias, fingerprint: this.identity.fingerprint, port: this.config.port, receiveDir: this.config.receiveDirAbs },
      scanning: this.scanning,
      devices: [...this.devices.values()]
        .sort((a, b) => a.alias.localeCompare(b.alias))
        .map((d) => ({
          fingerprint: d.fingerprint, alias: d.alias, ip: d.ip, port: d.port, protocol: d.protocol,
          deviceModel: d.deviceModel ?? null, deviceType: d.deviceType ?? null, lastSeen: d.lastSeen,
        })),
      incoming: this.incoming && {
        id: this.incoming.id,
        sender: this.incoming.sender,
        files: pickFiles(this.incoming.files),
        totalSize: this.incoming.files.reduce((s, f) => s + f.size, 0),
        deadline: this.incoming.deadline,
      },
      receive: this.receive && {
        sessionId: this.receive.sessionId,
        sender: this.receive.sender,
        files: pickFiles(this.receive.files),
        startedAt: this.receive.startedAt,
        finishedAt: this.receive.finishedAt ?? null,
      },
      sendJobs: [...this.sendJobs.values()].map((j) => ({
        id: j.id, target: j.target, status: j.status, message: j.message ?? null,
        files: pickFiles(j.files), createdAt: j.createdAt, isText: !!j.text,
      })),
      messages: this.messages.slice(-50),
    };
  }
}
