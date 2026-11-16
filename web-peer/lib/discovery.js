// 探索：IPv4 多播宣告 + 收到宣告時以 HTTP register 回應 + 子網掃描備援（PROTOCOL.md 第 3 節）
// + Tailscale：tailnet 沒有多播，定期對每台在線的 tailnet 裝置主動 register
import dgram from 'node:dgram';
import { Tailscale } from './tailscale.js';
import { localIPv4, log } from './util.js';

const GROUP = '224.0.0.167';
const PORT = 53317;
const BURST_DELAYS = [100, 500, 2000]; // 一次宣告 = 3 個 datagram
const TS_CONCURRENCY = 4;
const TS_TIMEOUT_MS = 2000;
const TS_MAX_BACKOFF_MS = 120_000; // 沒有 LocalSend 的 tailnet 裝置，最久 2 分鐘再試一次
const FRESH_MS = 45_000; // 與 refreshDevices 相同：這段時間內聯絡過的裝置不必再探測

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
    this.tailscale = new Tailscale();
    this.tsSelfIps = new Set();
    this.tsFingerprint = new Map(); // tailnet IP → 上次在這個 IP 找到的裝置 fingerprint
    this.tsBackoff = new Map(); // tailnet IP → { fails, next }（沒有 LocalSend 的裝置）
    this.tsProbing = null;
    this.tsLastReason = undefined; // 只在狀態改變時記錄一次
  }

  /** 多播只走實體網卡：Tailscale 介面沒有多播，也不做 /24 掃描 */
  multicastIfaces() {
    return localIPv4().filter((i) => !/tailscale/i.test(i.name) && !this.tsSelfIps.has(i.address));
  }

  async start() {
    // 先啟動不依賴多播的部分：多播 socket 綁定失敗（下方會丟出例外）時，Tailscale 探索與裝置維護仍要運作
    this.refreshTimer = setInterval(() => this.refreshDevices(), 20_000);
    const tsIv = Number(this.state.config.tailscaleIntervalSec) || 0;
    if (tsIv > 0) {
      const tick = () => this.probeTailscale().catch((e) => log(`Tailscale 探索失敗：${e.message}`));
      this.tsTimer = setInterval(tick, tsIv * 1000);
      tick();
    }
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
    const iv = this.state.config.announceIntervalSec;
    if (iv > 0) this.announceTimer = setInterval(() => this.announce(), iv * 1000);
    this.announce();
  }

  stop() {
    clearInterval(this.tsTimer);
    clearInterval(this.ifaceTimer);
    clearInterval(this.refreshTimer);
    clearInterval(this.announceTimer);
    try { this.rx?.close(); } catch { /* 忽略 */ }
    for (const s of this.tx.values()) try { s.close(); } catch { /* 忽略 */ }
  }

  /** 為每個 IPv4 介面加入多播群組並建立傳送 socket;介面變動時自動補上 */
  refreshInterfaces() {
    const now = new Set(this.multicastIfaces().map((i) => i.address));
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
   * via = 'tailscale'：同一台裝置目前記錄的是區網 IP、且區網 IP 還沒有確認失敗過時，保留區網 IP（較快），不改用 tailnet IP。
   *   區網 IP 由 refreshDevices 維護；它連不上（failures > 0）之後，下一輪 Tailscale 探測才改用 tailnet IP。
   */
  async registerTo({ ip, port, protocol = 'https', fingerprint = null, hint = null, timeoutMs = 3000, quiet = false, via = null }) {
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
      if (via === 'tailscale') {
        this.tsFingerprint.set(ip, fp);
        const prev = this.state.devices.get(fp);
        if (prev && prev.ip !== ip && !this.state.isTailnet(prev.ip) && !(prev.failures > 0)) return prev;
      }
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
      if (isNew) log(`${via === 'tailscale' ? '透過 Tailscale ' : ''}發現裝置：${device.alias}（${ip}:${port}）`);
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
      const tsProbe = this.probeTailscale({ force: true }).catch((e) => log(`Tailscale 探索失敗：${e.message}`));
      for (const iface of this.multicastIfaces()) {
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
      await tsProbe;
      // 已知裝置也重新確認一次
      await Promise.all([...this.state.devices.values()].map((d) =>
        this.registerTo({ ip: d.ip, port: d.port, protocol: d.protocol, fingerprint: d.fingerprint, quiet: true })));
    } finally {
      this.state.scanning = false;
      this.state.changed();
    }
  }

  /**
   * 讀取 tailnet 在線裝置，對每個 IPv4 送 register（與子網掃描相同流程，不 pin fingerprint）。
   * 成功的裝置出現在「附近的裝置」；依協定，對方 App 也會把這台電腦加進它的清單。
   * force = true（手動「重新掃描」）時忽略退避時間。
   */
  probeTailscale({ force = false } = {}) {
    if (!(Number(this.state.config.tailscaleIntervalSec) > 0)) return Promise.resolve();
    if (this.tsProbing) {
      // 已在進行：手動掃描就等它跑完再補一輪
      return force ? this.tsProbing.then(() => this.probeTailscale({ force })) : this.tsProbing;
    }
    this.tsProbing = this._probeTailscale(force).finally(() => { this.tsProbing = null; });
    return this.tsProbing;
  }

  async _probeTailscale(force) {
    const st = await this.tailscale.status();
    this.tsSelfIps = new Set(st.selfIps);
    const prevTs = this.state.tailscale;
    const next = { enabled: true, available: st.available, installed: st.installed, online: st.peers.length, reason: st.reason };
    this.state.tailscale = next;
    // 暫時讀不到狀態（逾時等）時沿用上次的 tailnet IP 清單，裝置的「Tailscale」標籤與區網優先判斷才不會忽有忽無
    const ips = st.available ? new Set(st.tailnetIps) : this.state.tailnetIps;
    const ipsChanged = ips.size !== this.state.tailnetIps.size || [...ips].some((ip) => !this.state.tailnetIps.has(ip));
    this.state.tailnetIps = ips;
    if (ipsChanged || !prevTs || ['available', 'installed', 'online', 'reason'].some((k) => prevTs[k] !== next[k])) this.state.changed();
    const key = st.available ? 'ok' : st.reason;
    if (key !== this.tsLastReason) {
      this.tsLastReason = key;
      if (st.available) log(`已偵測到 Tailscale（本機 ${st.selfIps.join('、') || '無 IPv4'}），每 ${this.state.config.tailscaleIntervalSec} 秒探測 tailnet 上的裝置`);
      else log(`未使用 Tailscale 探索：${st.reason}`);
    }
    if (!st.available) return;

    const now = Date.now();
    const online = new Set(st.peers.map((p) => p.ip));
    for (const ip of [...this.tsBackoff.keys()]) if (!online.has(ip)) this.tsBackoff.delete(ip);
    for (const ip of [...this.tsFingerprint.keys()]) if (!online.has(ip)) this.tsFingerprint.delete(ip);
    // Tailscale 回報離線的裝置：目前記錄的是它的 tailnet IP 就立刻移除，不必等 refreshDevices 連續失敗 3 次（約 2 分鐘）
    const offline = new Set(st.offlineIps);
    for (const d of [...this.state.devices.values()]) {
      if (offline.has(d.ip)) {
        this.state.devices.delete(d.fingerprint);
        log(`裝置在 Tailscale 上已離線，已移除：${d.alias}`);
        this.state.changed();
      }
    }
    const targets = st.peers.filter(({ ip }) => {
      // 這個 IP 上已有最近聯絡過的裝置（不論目前走區網或 tailnet），交給 refreshDevices 維護
      const fp = this.tsFingerprint.get(ip);
      const known = (fp && this.state.devices.get(fp)) || [...this.state.devices.values()].find((d) => d.ip === ip);
      if (known && now - known.lastSeen < FRESH_MS) return false;
      if (force) return true;
      const b = this.tsBackoff.get(ip);
      return !b || now >= b.next;
    });

    let idx = 0;
    const worker = async () => {
      while (idx < targets.length) {
        const { ip } = targets[idx++];
        const dev = await this.registerTo({ ip, port: PORT, fingerprint: null, timeoutMs: TS_TIMEOUT_MS, quiet: true, via: 'tailscale' });
        if (dev) {
          this.tsBackoff.delete(ip);
        } else {
          // 沒有 LocalSend（或沒開）：指數退避，不寫記錄。
          // 以這一輪開始的時間 now 起算（不是逾時之後），否則 2 秒逾時會讓下一次延後一整個週期
          const fails = (this.tsBackoff.get(ip)?.fails ?? 0) + 1;
          const iv = Number(this.state.config.tailscaleIntervalSec) * 1000;
          this.tsBackoff.set(ip, { fails, next: now + Math.min(iv * 2 ** (fails - 1), Math.max(iv, TS_MAX_BACKOFF_MS)) - 1000 });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(TS_CONCURRENCY, targets.length) }, worker));
  }
}
