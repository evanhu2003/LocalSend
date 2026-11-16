'use strict';
// LocalSend 電腦端網頁介面（純 JS，無建置步驟）

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
  return n;
};

let state = null;
let selectedDevice = null;
let tab = 'files';
let aliasDirty = false;
const selection = []; // { key, file, stagedId, progress, status, error, xhr }
const jobPayloads = new Map(); // jobId → 送出內容（輸入 PIN 後重送用）
const baseTitle = document.title;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtTime(ms) {
  return new Date(ms).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function bar(frac, fail) {
  return el('div', { class: 'bar' + (fail ? ' fail' : '') }, el('div', { style: `width:${Math.max(0, Math.min(1, frac)) * 100}%` }));
}
// 線條圖示（路徑取自 Lucide，ISC 授權）；內容是固定字串，不含任何外部資料
const ICON_PATHS = {
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
};
function deviceIcon(t) {
  // 手機和手錶回報的 deviceType 都是 mobile，協定裡分不出來，一律用手機圖示
  const name = { mobile: 'smartphone', desktop: 'monitor', web: 'globe', headless: 'cpu', server: 'server' }[t] ?? 'smartphone';
  const tpl = document.createElement('template');
  tpl.innerHTML = `<span class="dev-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg></span>`;
  return tpl.content.firstChild;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-LocalSend-UI': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 無內容 */ }
  if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
  return data;
}

function toast(text, level = 'info') {
  const t = el('div', { class: `toast ${level}` }, text);
  $('toasts').append(t);
  setTimeout(() => t.remove(), level === 'warn' ? 7000 : 4500);
}

/* ---------- 即時更新(SSE) ---------- */
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => { $('conn').textContent = '已連線'; $('conn').className = 'conn on'; });
  es.addEventListener('error', () => { $('conn').textContent = '與本機服務中斷，重新連線中…'; $('conn').className = 'conn off'; });
  es.addEventListener('state', (e) => { state = JSON.parse(e.data); render(); });
  es.addEventListener('notice', (e) => {
    const n = JSON.parse(e.data);
    toast(n.text, n.level === 'incoming' ? 'info' : n.level);
  });
  es.addEventListener('received', () => loadReceived());
}

/* ---------- 畫面 ---------- */
function render() {
  if (!state) return;
  if (!aliasDirty && document.activeElement !== $('alias')) $('alias').value = state.self.alias;
  $('recvDir').textContent = state.self.receiveDir;
  $('scan').disabled = state.scanning;
  $('scan').textContent = state.scanning ? '掃描中…' : '重新掃描';
  renderDevices();
  renderSendState();
  renderJobs();
  renderIncoming();
  renderReceiving();
  renderMessages();
}

function renderDevices() {
  const ul = $('devices');
  ul.replaceChildren();
  if (selectedDevice && !state.devices.some((d) => d.fingerprint === selectedDevice)) selectedDevice = null;
  if (!selectedDevice && state.devices.length === 1) selectedDevice = state.devices[0].fingerprint;
  for (const d of state.devices) {
    const meta = [d.deviceModel, `${d.ip}:${d.port}`, `#${d.fingerprint.slice(0, 6)}`].filter(Boolean).join(' · ');
    const li = el('li', {
      class: 'device' + (d.fingerprint === selectedDevice ? ' selected' : ''),
      tabindex: '0',
      role: 'button',
      'aria-pressed': d.fingerprint === selectedDevice ? 'true' : 'false',
      onclick: () => { selectedDevice = d.fingerprint; render(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectedDevice = d.fingerprint; render(); } },
    },
    deviceIcon(d.deviceType),
    el('div', { class: 'dev-text' },
      el('div', { class: 'name', title: d.alias }, d.alias),
      el('div', { class: 'meta full', title: meta }, meta),
      el('div', { class: 'meta short', title: meta }, [d.deviceModel, d.ip].filter(Boolean).join(' · ')),
      d.tailscale ? el('span', { class: 'tag', title: '透過 Tailscale 連線' }, 'Tailscale') : null));
    ul.append(li);
  }
  $('noDevices').hidden = state.devices.length > 0;
  const ts = state.tailscale;
  const tsEl = $('tsStatus');
  // 沒裝 Tailscale 的人不必看到這行；裝了但沒連上（未登入、已停止等）才顯示原因
  tsEl.hidden = !ts || !ts.enabled || (!ts.available && !ts.installed);
  if (ts && ts.enabled) {
    tsEl.textContent = ts.available ? `已連上 Tailscale：同帳號有 ${ts.online} 台裝置在線上` : `未使用 Tailscale 探索：${ts.reason ?? '原因不明'}`;
    tsEl.title = ts.available ? '會定期詢問這些裝置上有沒有開著 LocalSend' : '';
  }
}

function renderSendState() {
  const dev = state?.devices.find((d) => d.fingerprint === selectedDevice);
  $('target').textContent = dev ? `傳送到：${dev.alias}` : (state?.devices.length ? '請先在上方選擇一台裝置' : '尚未找到裝置');
  const staging = selection.some((s) => s.status === 'uploading');
  const ready = tab === 'files'
    ? selection.length > 0 && selection.every((s) => s.status === 'ready')
    : $('text').value.trim().length > 0;
  $('send').disabled = !dev || !ready;
  $('send').textContent = staging ? '準備檔案中…' : '傳送';
  // 中間軌道：有目標且可以送時箭頭開始流動，傳送中流得更快
  const rail = $('rail');
  rail.classList.toggle('ready', Boolean(dev && ready));
  rail.classList.toggle('sending', Boolean(state?.sendJobs.some((j) => j.status === 'sending')));
  $('railTarget').replaceChildren(...(dev
    ? [el('span', { class: 'label' }, '傳送到'), deviceIcon(dev.deviceType), el('span', { class: 'name', title: dev.alias }, dev.alias)]
    : [el('span', { class: 'label' }, state?.devices.length ? '在上方選擇一台裝置' : '尚未找到裝置')]));
  const total = selection.reduce((s, x) => s + x.file.size, 0);
  $('selSummary').textContent = selection.length ? `${selection.length} 個檔案，共 ${fmtSize(total)}` : '';
  $('clearSel').hidden = selection.length === 0;
}

const JOB_STATUS = {
  waiting: ['等待對方接受', 'run'],
  sending: ['傳送中', 'run'],
  done: ['完成', 'ok'],
  rejected: ['被拒絕', 'bad'],
  busy: ['對方忙碌', 'bad'],
  failed: ['失敗', 'bad'],
  cancelled: ['已取消', ''],
  pin_required: ['需要 PIN 碼', 'bad'],
};

function renderJobs() {
  const ul = $('jobs');
  ul.replaceChildren();
  for (const j of [...state.sendJobs].reverse()) {
    const [label, cls] = JOB_STATUS[j.status] ?? [j.status, ''];
    const active = j.status === 'waiting' || j.status === 'sending';
    const sent = j.files.reduce((s, f) => s + (f.status === 'finished' ? f.size : f.sent), 0);
    const total = j.files.reduce((s, f) => s + f.size, 0) || 1;
    const actions = [];
    if (active) actions.push(el('button', { class: 'btn small danger', onclick: () => api('POST', `/api/send/${j.id}/cancel`).catch((e) => toast(e.message, 'warn')) }, '取消'));
    if (j.status === 'pin_required') actions.push(el('button', { class: 'btn small primary', onclick: () => retryWithPin(j) }, '輸入 PIN'));
    if (!active) actions.push(el('button', { class: 'btn small ghost', title: '從列表移除', onclick: () => api('POST', `/api/send/${j.id}/dismiss`).catch(() => {}) }, '✕'));
    const li = el('li', { class: 'job' },
      el('div', { class: 'job-head' },
        el('div', {}, el('strong', {}, j.isText ? '文字訊息' : `${j.files.length} 個檔案`), ' → ', j.target.alias),
        el('div', { class: 'row', style: 'margin:0' }, el('span', { class: `badge ${cls}` }, label), ...actions)),
      j.message && !active ? el('div', { class: 'muted small' }, j.message) : null,
      j.status === 'waiting' ? el('div', { class: 'muted small' }, '請在手錶上按「接受」') : null,
      j.status === 'sending' || (j.status !== 'waiting' && !j.isText && j.files.length) ? bar(sent / total, j.status === 'failed') : null,
      j.status === 'sending' ? el('div', { class: 'muted small' }, `${fmtSize(sent)} / ${fmtSize(total)}`) : null,
      !j.isText && (j.status === 'sending' || j.status === 'failed')
        ? el('ul', { class: 'filelist compact' }, j.files.map((f) => el('li', {},
          el('span', { class: 'fname', title: f.fileName }, f.fileName),
          el('span', { class: 'fsize' }, fileStatusLabel(f)))))
        : null);
    ul.append(li);
  }
}

function fileStatusLabel(f) {
  switch (f.status) {
    case 'finished': return '✓ 完成';
    case 'failed': return '✗ ' + (f.error ?? '失敗');
    case 'skipped': return '略過';
    case 'sending': return `${Math.floor((f.sent / (f.size || 1)) * 100)}%`;
    case 'receiving': return `${Math.floor((f.received / (f.size || 1)) * 100)}%`;
    default: return '等待中';
  }
}

async function retryWithPin(job) {
  const payload = jobPayloads.get(job.id);
  if (!payload) return toast('無法重送，請重新選擇檔案再傳一次', 'warn');
  const pin = prompt(`「${job.target.alias}」要求輸入 PIN 碼：`);
  if (!pin) return;
  try {
    await api('POST', `/api/send/${job.id}/dismiss`);
    const r = await api('POST', '/api/send', { ...payload, pin });
    jobPayloads.set(r.jobId, payload);
  } catch (e) {
    toast(e.message, 'warn');
  }
}

let countdownTimer = null;
function renderIncoming() {
  const inc = state.incoming;
  const box = $('incoming');
  if (!inc) {
    box.hidden = true;
    document.title = baseTitle;
    clearInterval(countdownTimer);
    countdownTimer = null;
    box.dataset.id = '';
    return;
  }
  if (box.dataset.id === inc.id) return;
  box.dataset.id = inc.id;
  $('incFrom').replaceChildren(el('strong', {}, inc.sender.alias), `（${[inc.sender.deviceModel, inc.sender.ip].filter(Boolean).join(' · ')}）想傳送以下檔案：`);
  $('incFiles').replaceChildren(...inc.files.map((f) => el('li', {}, el('span', { class: 'fname', title: f.fileName }, f.fileName), el('span', { class: 'fsize' }, fmtSize(f.size)))));
  $('incTotal').textContent = `共 ${inc.files.length} 個檔案，${fmtSize(inc.totalSize)}`;
  box.hidden = false;
  document.title = '【有新的傳入請求】' + baseTitle;
  const total = Math.max(1, inc.deadline - Date.now());
  const tick = () => {
    const left = Math.max(0, inc.deadline - Date.now());
    $('incBar').style.width = `${(left / total) * 100}%`;
    $('incLeft').textContent = `${Math.ceil(left / 1000)} 秒內未回應會自動拒絕`;
  };
  tick();
  clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
  $('accept').focus();
}

function renderReceiving() {
  const box = $('receiving');
  const r = state.receive;
  if (!r) return box.replaceChildren();
  const got = r.files.reduce((s, f) => s + (f.status === 'finished' ? f.size : (f.received || 0)), 0);
  const total = r.files.reduce((s, f) => s + f.size, 0) || 1;
  box.replaceChildren(el('div', { class: 'recv-box' },
    el('div', { class: 'job-head' },
      el('div', {}, '正在接收來自 ', el('strong', {}, r.sender.alias), ' 的檔案'),
      el('button', { class: 'btn small danger', onclick: () => api('POST', '/api/receive/cancel').catch((e) => toast(e.message, 'warn')) }, '取消')),
    bar(got / total),
    el('div', { class: 'muted small' }, `${fmtSize(got)} / ${fmtSize(total)}`),
    el('ul', { class: 'filelist compact' }, r.files.map((f) => el('li', {},
      el('span', { class: 'fname', title: f.fileName }, f.fileName),
      el('span', { class: 'fsize' }, fileStatusLabel(f)))))));
}

function renderMessages() {
  const box = $('messages');
  if (!state.messages.length) return box.replaceChildren();
  box.replaceChildren(
    el('div', { class: 'job-head' }, el('strong', {}, '收到的文字訊息'),
      el('button', { class: 'btn small ghost', onclick: () => api('POST', '/api/messages/clear').catch(() => {}) }, '清除')),
    ...[...state.messages].reverse().map((m) => el('div', { class: 'msg' },
      el('div', { class: 'msg-head' }, el('span', {}, `來自 ${m.from}`), el('span', {}, fmtTime(m.at))),
      el('pre', {}, m.text),
      el('button', {
        class: 'btn small ghost', style: 'margin-top:6px',
        onclick: () => navigator.clipboard.writeText(m.text).then(() => toast('已複製'), () => toast('無法複製', 'warn')),
      }, '複製'))));
}

async function loadReceived() {
  try {
    const r = await fetch('/api/received').then((x) => x.json());
    const ul = $('received');
    ul.replaceChildren(...r.files.map((f) => {
      const href = '/files/' + f.path.split('/').map(encodeURIComponent).join('/');
      return el('li', {},
        el('a', { class: 'fname', href, download: f.path.split('/').pop(), title: f.path }, f.path),
        el('span', { class: 'fsize' }, `${fmtSize(f.size)} · ${fmtTime(Math.max(f.mtime, f.ctime))}`));
    }));
    $('noReceived').hidden = r.files.length > 0;
  } catch { /* 稍後重試 */ }
}

/* ---------- 選擇檔案並暫存到本機服務（串流上傳，不整個讀進記憶體） ---------- */
function addFiles(list) {
  for (const file of list) {
    const item = { key: Math.random().toString(36).slice(2), file, stagedId: null, progress: 0, status: 'uploading', error: null, xhr: null };
    selection.push(item);
    stageFile(item);
  }
  renderSelection();
}

function stageFile(item) {
  const q = new URLSearchParams({ name: item.file.name, type: item.file.type || '', lastModified: String(item.file.lastModified || 0) });
  const xhr = new XMLHttpRequest();
  item.xhr = xhr;
  xhr.open('POST', '/api/stage?' + q);
  xhr.setRequestHeader('X-LocalSend-UI', '1');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) { item.progress = e.loaded / e.total; renderSelection(); }
  };
  xhr.onload = () => {
    item.xhr = null;
    if (xhr.status === 200) {
      item.stagedId = JSON.parse(xhr.responseText).id;
      item.status = 'ready';
      item.progress = 1;
    } else {
      item.status = 'error';
      try { item.error = JSON.parse(xhr.responseText).message; } catch { item.error = `HTTP ${xhr.status}`; }
    }
    renderSelection();
  };
  xhr.onerror = () => { item.xhr = null; item.status = 'error'; item.error = '無法讀取檔案'; renderSelection(); };
  xhr.send(item.file); // 瀏覽器會直接從磁碟串流送出
}

function removeItem(item) {
  const i = selection.indexOf(item);
  if (i >= 0) selection.splice(i, 1);
  item.xhr?.abort();
  if (item.stagedId) api('DELETE', `/api/stage/${item.stagedId}`).catch(() => {});
  renderSelection();
}

function renderSelection() {
  $('selected').replaceChildren(...selection.map((s) => el('li', {},
    el('span', { class: 'fname', title: s.file.name }, s.file.name),
    el('span', {},
      el('span', { class: 'fsize' }, s.status === 'error' ? `✗ ${s.error}` : s.status === 'uploading' ? `準備中 ${Math.floor(s.progress * 100)}%` : fmtSize(s.file.size)),
      el('button', { class: 'x', title: '移除', 'aria-label': `移除 ${s.file.name}`, onclick: () => removeItem(s) }, '✕')),
    s.status === 'uploading' ? bar(s.progress) : null)));
  renderSendState();
}

/* ---------- 事件 ---------- */
$('picker').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type);
  if (files.length) addFiles(files);
  else toast('無法加入資料夾，請選擇檔案', 'warn');
});
// 拖到頁面其他地方也不要讓瀏覽器直接開啟檔案
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('clearSel').addEventListener('click', () => { [...selection].forEach(removeItem); });
$('text').addEventListener('input', renderSendState);

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  renderSendState();
}));

$('send').addEventListener('click', async () => {
  const payload = tab === 'files'
    ? { fingerprint: selectedDevice, stagedIds: selection.map((s) => s.stagedId) }
    : { fingerprint: selectedDevice, text: $('text').value };
  $('send').disabled = true;
  try {
    const r = await api('POST', '/api/send', payload);
    jobPayloads.set(r.jobId, payload);
    if (tab === 'text') $('text').value = '';
  } catch (e) {
    toast(e.message, 'warn');
  }
  renderSendState();
});

$('scan').addEventListener('click', () => api('POST', '/api/scan').then(() => toast('正在掃描區域網路…')).catch((e) => toast(e.message, 'warn')));
$('openFolder').addEventListener('click', () => api('POST', '/api/open-folder').catch((e) => toast(e.message, 'warn')));

$('alias').addEventListener('input', () => { aliasDirty = true; });
const saveAlias = () => api('POST', '/api/alias', { alias: $('alias').value })
  .then(() => { aliasDirty = false; toast('已更新裝置名稱'); })
  .catch((e) => toast(e.message, 'warn'));
$('aliasSave').addEventListener('click', saveAlias);
$('alias').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveAlias(); });

$('accept').addEventListener('click', () => {
  const id = $('incoming').dataset.id;
  if (id) api('POST', `/api/incoming/${id}/accept`).catch((e) => toast(e.message, 'warn'));
});
$('decline').addEventListener('click', () => {
  const id = $('incoming').dataset.id;
  if (id) api('POST', `/api/incoming/${id}/decline`).catch((e) => toast(e.message, 'warn'));
});

// 寬視窗把「傳送」按鈕移到中間軌道，窄視窗放回傳送卡片底部（斷點與 style.css 相同）
const wideLayout = matchMedia('(min-width: 960px)');
const placeSendButton = () => (wideLayout.matches ? $('railSlot') : $('sendRow')).append($('send'));
wideLayout.addEventListener('change', placeSendButton);
placeSendButton();

connect();
loadReceived();
