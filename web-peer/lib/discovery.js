// 探索：IPv4 多播宣告 + 收到宣告時以 HTTP register 回應 + 子網掃描備援（PROTOCOL.md 第 3 節）
import dgram from 'node:dgram';
import { localIPv4, log } from './util.js';

const GROUP = '224.0.0.167';
const PORT = 53317;
const BURST_DELAYS = [100, 500, 2000]; // 一次宣告 = 3 個 datagram

export class Discovery {
  /** @param {import('./state.js').AppState} state @param {import('./lsclient.js').LsClient} client */
  constructor(state, client) {
    this.state = state;
    this.client = client;
    this.rx = null;
    this.tx = new Map(); // 介面位址 → 傳送用 socket
    this.joined = new Set();
    this.joinFailed = new Set(); // 只記錄一次失敗，避免每 15 秒洗版
    this.registering = new Map(); // ip → 時間，避免同一台短時間內重複 register
  }

  async start() {
    await new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.once('error', reject);
      s.bind(PORT, '0.0.0.0', () => {
        s.removeListener('error', reject);
        s.on('error', (e) => log('多播 socket 錯誤：', e.message));
        s.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
        try {
          s.setMulticastLoopback(true);
          s.setMulticastTTL(1);
        } catch {
          /* 忽略 */
        }
        this.rx = s;
        resolve();
      });
    });
    this.refreshInterfaces();
    this.ifaceTimer = setInterval(() => this.refreshInterfaces(), 15_000);
    this.refreshTimer = setInterval(() => this.refreshDevices(), 20_000);
    const iv = this.state.config.announceIntervalSec;
    if (iv > 0) this.announceTimer = setInterval(() => this.announce(), iv * 1000);
    this.announce();
  }

  stop() {
    clearInterval(this.ifaceTimer);
    clearInterval(this.refreshTimer);
    clearInterval(this.announceTimer);
    try { this.rx?.close(); } catch { /* 忽略 */ }
    for (const s of this.tx.values()) try { s.close(); } catch { /* 忽略 */ }
  }

  /** 為每個 IPv4 介面加入多播群組並建立傳送 socket;介面變動時自動補上 */
  refreshInterfaces() {
    const now = new Set(localIPv4().map((i) => i.address));
    for (const addr of now) {
      // 每次都重新加入：Wi-Fi 短暫斷線再連上（IP 不變）時 Windows 會清掉群組成員資格,
      // 只靠「新介面才加入」會讓之後再也收不到手錶的宣告。已加入時會回 EINVAL / EADDRINUSE，忽略即可。
      try {
        this.rx.addMembership(GROUP, addr);
        if (this.joined.has(addr)) log(`介面 ${addr} 的多播群組成員資格已遺失，已重新加入`);
        else log(`已在介面 ${addr} 加入多播群組 ${GROUP}`);
        this.joined.add(addr);
        this.joinFailed.delete(addr);
      } catch (e) {
        const already = e.code === 'EINVAL' || e.code === 'EADDRINUSE';
        if (!(this.joined.has(addr) && already)) {
          if (!this.joinFailed.has(addr)) log(`介面 ${addr} 加入多播群組失敗：${e.message}`);
          this.joinFailed.add(addr);
        }
      }
      if (!this.tx.has(addr)) {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        s.on('error', (e) => {
          log(`介面 ${addr} 傳送 socket 錯誤：${e.message}`);
          try { s.close(); } catch { /* 忽略 */ }
          this.tx.delete(addr);
        });
        s.bind(0, addr, () => {
          try {
            s.setMulticastInterface(addr);
            s.setMulticastTTL(1);
            s.setMulticastLoopback(true);
          } catch { /* 忽略 */ }
        });
        this.tx.set(addr, s);
      }
    }
    for (const addr of [...this.joined]) {
      if (!now.has(addr)) {
        try { this.rx.dropMembership(GROUP, addr); } catch { /* 介面已消失 */ }
        this.joined.delete(addr);
      }
    }
    for (const [addr, s] of [...this.tx]) {
      if (!now.has(addr)) {
        try { s.close(); } catch { /* 忽略 */ }
        this.tx.delete(addr);
      }
    }
  }

  /** 送出一次宣告(3 個 datagram) */
  announce() {
    const payload = Buffer.from(JSON.stringify({ ...this.state.selfInfo(), announce: true }), 'utf8');
    let acc = 0;
    for (const d of BURST_DELAYS) {
      acc += d;
      setTimeout(() => {
        for (const [addr, s] of this.tx) {
          s.send(payload, PORT, GROUP, (err) => {
            if (err) log(`介面 ${addr} 送出宣告失敗：${err.message}`);
          });
        }
      }, acc);
    }
  }

  onMessage(msg, rinfo) {
    let dto;
    try {
      dto = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (!dto || typeof dto.fingerprint !== 'string' || typeof dto.alias !== 'string') return;
    if (dto.fingerprint === this.state.identity.fingerprint) return; // 自己的宣告
    const port = Number(dto.port) || PORT;
    const protocol = dto.protocol === 'http' ? 'http' : 'https';
    const ip = rinfo.address;
    // 收到宣告 → 以 HTTP register 回應(pin 住宣告裡的 fingerprint)
    this.registerTo({ ip, port, protocol, fingerprint: dto.fingerprint.toUpperCase(), hint: dto });
  }

  /**
   * 對裝置送 register;成功就加入裝置列表。
   * fingerprint 為 null 時不 pin（子網掃描），改用對方 TLS 憑證的 fingerprint。
   */
  async registerTo({ ip, port, protocol = 'https', fingerprint = null, hint = null, timeoutMs = 3000, quiet = false }) {
    const key = `${ip}:${port}`;
    const last = this.registering.get(key);
    if (fingerprint && last && Date.now() - last < 1500) return null;
    this.registering.set(key, Date.now());
    try {
      const r = await this.client.json({
        target: { ip, port, protocol },
        fingerprint,
        path: '/api/localsend/v2/register',
        json: this.state.selfInfo(),
        timeoutMs,
      });
      if (r.status !== 200 || !r.data || typeof r.data.alias !== 'string') return null;
      const fp = protocol === 'https' ? r.peerFingerprint : (fingerprint ?? r.data.fingerprint);
      if (!fp || fp === this.state.identity.fingerprint) return null;
      const { isNew, device } = this.state.upsertDevice({
        fingerprint: fp,
        alias: r.data.alias,
        version: r.data.version,
        deviceModel: r.data.deviceModel ?? hint?.deviceModel ?? null,
        deviceType: r.data.deviceType ?? hint?.deviceType ?? null,
        ip,
        port,
        protocol,
      });
      if (isNew) log(`發現裝置：${device.alias}（${ip}:${port}）`);
      return device;
    } catch (e) {
      if (!quiet) log(`register ${ip}:${port} 失敗：${e.message}`);
      return null;
    }
  }

  /** 定期確認已知裝置是否還在線上 */
  async refreshDevices() {
    const now = Date.now();
    for (const d of [...this.state.devices.values()]) {
      if (now - d.lastSeen < 45_000) continue;
      const ok = await this.registerTo({ ip: d.ip, port: d.port, protocol: d.protocol, fingerprint: d.fingerprint, quiet: true });
      if (!ok) {
        const cur = this.state.devices.get(d.fingerprint);
        if (!cur) continue;
        cur.failures = (cur.failures ?? 0) + 1;
        if (cur.failures >= 3) {
          this.state.devices.delete(d.fingerprint);
          log(`裝置離線，已移除：${d.alias}`);
          this.state.changed();
        }
      }
    }
  }

  /** 手動掃描：送宣告，再掃描所在 /24 網段（多播被路由器擋住時的備援） */
  async scan() {
    if (this.state.scanning) return;
    this.state.scanning = true;
    this.state.changed();
    try {
      this.announce();
      const self = new Set(localIPv4().map((i) => i.address));
      const targets = [];
      for (const iface of localIPv4()) {
        // 只掃 /24 以內（較大的網段太慢，也不像家用 Wi-Fi）
        const [a, b, c] = iface.address.split('.');
        if (iface.address.startsWith('169.254.')) continue;
        for (let i = 1; i < 255; i++) {
          const ip = `${a}.${b}.${c}.${i}`;
          if (!self.has(ip)) targets.push(ip);
        }
      }
      const known = new Set([...this.state.devices.values()].map((d) => d.ip));
      let idx = 0;
      const worker = async () => {
        while (idx < targets.length) {
          const ip = targets[idx++];
          if (known.has(ip)) continue;
          await this.registerTo({ ip, port: PORT, fingerprint: null, timeoutMs: 1500, quiet: true });
        }
      };
      await Promise.all(Array.from({ length: 50 }, worker));
      // 已知裝置也重新確認一次
      await Promise.all([...this.state.devices.values()].map((d) =>
        this.registerTo({ ip: d.ip, port: d.port, protocol: d.protocol, fingerprint: d.fingerprint, quiet: true })));
    } finally {
      this.state.scanning = false;
      this.state.changed();
    }
  }
}
