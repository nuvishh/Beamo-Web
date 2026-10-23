/* Beamo Web — browser-to-browser file sharing over WebRTC DataChannel.
 * Two pairing modes:
 *  - Easy connect (v4): a 6-digit code via the free PeerJS cloud broker.
 *    Only the handshake touches the broker — files go directly
 *    peer-to-peer and never pass through any server.
 *  - Offline: signaling via QR codes (or pasted codes), no internet.
 */
'use strict';

const $ = id => document.getElementById(id);
const CHUNK = 64 * 1024; // negotiated down to dc.maxMessageSize per transfer
const BUFFER_HIGH = 8 * 1024 * 1024; // pause sending while the channel holds this much
const PREFIX = 'BEAMO1:';
const PREFIX2 = 'BEAMO2:';

/* ---------------- codec ----------------
 * BEAMO2 codes are deflate-compressed before base64 — the SDP is mostly
 * repeated structure, so the QR payload shrinks ~45% and scans much
 * faster. BEAMO1 (plain JSON) codes from older versions still decode. */
function enc(obj) {
  return PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function dec(code) {
  code = code.trim();
  if (code.startsWith(PREFIX)) code = code.slice(PREFIX.length);
  code = code.replace(/-/g, '+').replace(/_/g, '/');
  while (code.length % 4) code += '=';
  return JSON.parse(decodeURIComponent(escape(atob(code))));
}
function b64urlFromBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function encSignal(obj) {
  if (window.CompressionStream) {
    try {
      const cs = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('deflate'));
      const buf = await new Response(cs).arrayBuffer();
      return PREFIX2 + b64urlFromBytes(new Uint8Array(buf));
    } catch (e) { /* fall through to plain */ }
  }
  return enc(obj);
}
async function decSignal(code) {
  code = (code || '').trim();
  if (code.startsWith(PREFIX2)) {
    if (!window.DecompressionStream) throw new Error('compressed code not supported in this browser');
    const bytes = bytesFromB64url(code.slice(PREFIX2.length));
    const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return JSON.parse(await new Response(ds).text());
  }
  return dec(code);
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function fmtSpeed(bps) {
  if (bps < 1024) return bps.toFixed(0) + ' B/s';
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / (1024 * 1024)).toFixed(1) + ' MB/s';
}
function fmtEta(s) {
  if (s == null) return '';
  if (s < 60) return s + 's left';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's left';
}
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- SDP minify ----------------
 * Rebuilds a minimal datachannel-only SDP from the browser's full SDP so
 * the QR stays small and scans fast. Every value comes from the original
 * SDP verbatim — only optional lines are dropped. Falls back to the full
 * SDP if any essential field is missing. */
function minSdp(sdp) {
  const line = re => { const m = sdp.match(re); return m ? m[1] : ''; };
  // Legacy format (sctpmap): keep it as-is minus lines Brave rejects —
  // sctp-port must never appear alongside sctpmap.
  if (/a=sctpmap:/.test(sdp)) {
    return sdp.split('\r\n')
      .filter(l => !l.startsWith('a=max-message-size:') && !l.startsWith('a=sctp-port:'))
      .join('\r\n');
  }
  const ufrag = line(/a=ice-ufrag:(\S+)/);
  const pwd = line(/a=ice-pwd:(\S+)/);
  const fp = line(/a=fingerprint:([^\r\n]+)/);
  const setup = line(/a=setup:(\S+)/);
  if (!ufrag || !pwd || !fp || !setup) return sdp; // safety fallback
  const mid = line(/a=mid:(\S+)/) || '0';
  const sctp = line(/a=sctp-port:(\S+)/) || '5000';
  const mline = line(/(m=application[^\r\n]*)/) || 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel';
  const cline = line(/(c=IN[^\r\n]*)/) || 'c=IN IP4 0.0.0.0';
  // candidates: prefer IPv4 UDP host, keep ≤2, kept verbatim
  // (Chrome's parser rejects trimmed candidate lines)
  const allCands = sdp.split('\r\n').filter(l => l.startsWith('a=candidate:'));
  const good = allCands.filter(l => /\budp\b/i.test(l) && /\btyp host\b/.test(l) && /\d+\.\d+\.\d+\.\d+/.test(l));
  // one best candidate: on a LAN the receiver's best IPv4 host candidate is
  // the one the sender needs; fewer lines = faster-scanning QR
  const cands = (good.length ? good : allCands).slice(0, 1);
  if (!cands.length) return sdp; // safety fallback
  const sid = Math.floor(Math.random() * 1e9);
  // NOTE: trailing CRLF is required — Chromium's SDP parser rejects
  // the description if the last line isn't terminated.
  return [
    'v=0',
    'o=- ' + sid + ' 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    mline,
    cline,
    'a=ice-ufrag:' + ufrag,
    'a=ice-pwd:' + pwd,
    'a=fingerprint:' + fp,
    'a=setup:' + setup,
    'a=mid:' + mid,
    'a=sctp-port:' + sctp,
    ...cands
  ].join('\r\n') + '\r\n';
}

/* ---------------- screens ---------------- */
function show(name) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  $('scr-' + name).classList.add('active');
  window.scrollTo(0, 0);
}
function myName() {
  const v = $('devName').value.trim();
  return v || "A device";
}

/* ---------------- QR ---------------- */
function renderQr(el, code) {
  el.style.display = 'block';
  el.innerHTML = '';
  try {
    const qr = qrcode(0, 'L');
    qr.addData(code);
    qr.make();
    el.innerHTML = qr.createImgTag(5, 4);
  } catch (e) {
    el.innerHTML = '<p style="color:#000">Code too long for QR — use paste instead.</p>';
  }
}

/* ---------------- webrtc ---------------- */
let pc = null, dc = null, role = null, peerName = '', myDeviceName = '';
let peer = null, pconn = null, pairCode = '';
let connected = false;

function newPC() {
  closeConn();
  // No ICE servers: pure LAN, host candidates only. Fully offline.
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    setStatus(st === 'connected' ? 'Connected ✓' : st === 'failed' ? 'Connection failed — stay on the same Wi-Fi and retry.' : st);
    if (st === 'connected') onConnected();
    if (st === 'failed' || st === 'closed' || st === 'disconnected') connected = false;
  };
  pc.ondatachannel = e => { dc = e.channel; wireChannel(); };
}

function closeConn() {
  try { dc && dc.close(); } catch (e) {}
  try { pc && pc.close(); } catch (e) {}
  try { pconn && pconn.close(); } catch (e) {}
  try { peer && peer.destroy(); } catch (e) {}
  pc = dc = null; pconn = peer = null; connected = false;
}

function waitGathering() {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(res => {
    const t = setTimeout(res, 10000);
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        pc.removeEventListener('icegatheringstatechange', check);
        res();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function wireChannel() {
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 1024 * 1024;
  dc.onopen = () => {
    connected = true;
    setStatus('Connected ✓');
    dc.send(JSON.stringify({ t: 'hello', name: myDeviceName }));
    onConnected();
  };
  dc.onmessage = onMsg;
  dc.onclose = () => { connected = false; setStatus('Disconnected.'); };
}

function setStatus(msg) {
  const el = role === 'rx' ? $('rxStatus') : $('txStatus');
  el.textContent = msg || '';
  el.classList.toggle('ok', /Connected ✓/.test(msg || ''));
}

/* ---------------- easy connect (6-digit code via PeerJS) ----------------
 * The transfer engine talks to `dc` through a narrow RTCDataChannel-like
 * interface, so a PeerJS DataConnection is wrapped in a shim exposing the
 * same surface (send / bufferedAmount / maxMessageSize / onopen /
 * onmessage / onclose / bufferedamountlow). Engine code is untouched. */
const PEER_PREFIX = 'beamoweb-';

function makePeerDc(conn) {
  const raw = () => conn.dataChannel || null;
  const shim = {
    binaryType: 'arraybuffer',
    onopen: null, onmessage: null, onclose: null,
    get bufferedAmount() { const r = raw(); return r ? r.bufferedAmount : 0; },
    get maxMessageSize() { const r = raw(); return (r && r.maxMessageSize) || 262144; },
    set bufferedAmountLowThreshold(v) {
      const r = raw(); if (r) try { r.bufferedAmountLowThreshold = v; } catch (e) {}
    },
    addEventListener(type, h) { const r = raw(); if (r) r.addEventListener(type, h); },
    removeEventListener(type, h) { const r = raw(); if (r) try { r.removeEventListener(type, h); } catch (e) {} },
    send(data) { conn.send(data); },
    close() { try { conn.close(); } catch (e) {} }
  };
  conn.on('open', () => { if (shim.onopen) shim.onopen(); });
  conn.on('data', data => { if (shim.onmessage) shim.onmessage({ data }); });
  conn.on('close', () => { if (shim.onclose) shim.onclose(); });
  conn.on('error', () => {});
  return shim;
}

function newPairCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* Receiver side: claim a code on the broker and wait for a sender.
 * Runs alongside the QR offer — whichever connects first wins. */
function startReceiveCode(tries) {
  tries = tries || 0;
  pairCode = newPairCode();
  $('rxCode').textContent = pairCode.split('').join(' ');
  let p;
  try { p = new Peer(PEER_PREFIX + pairCode, { debug: 0 }); }
  catch (e) { setStatus('Code connect unavailable here — use the QR below.'); return; }
  peer = p;
  p.on('open', () => { if (!connected) setStatus('Waiting for sender — share the code above…'); });
  p.on('connection', c => {
    if (connected || pconn) { try { c.close(); } catch (e) {} return; }
    pconn = c;
    dc = makePeerDc(c);
    wireChannel();
    setStatus('Connecting…');
  });
  p.on('error', err => {
    if (err.type === 'unavailable-id' && tries < 4) {
      try { p.destroy(); } catch (e) {}
      if (peer === p) peer = null;
      startReceiveCode(tries + 1);
      return;
    }
    if (!connected && (err.type === 'network' || err.type === 'server-error'))
      setStatus('Code connect needs internet — the QR below works offline.');
  });
  p.on('disconnected', () => { try { p.reconnect(); } catch (e) {} });
}

/* Sender side: type the receiver's code, PeerJS brokers the handshake. */
function connectWithCode() {
  const code = ($('txCode').value || '').replace(/\D/g, '');
  if (code.length !== 6) { setStatus('Enter the 6-digit code shown on the receiver.'); return; }
  role = 'tx'; peerName = ''; myDeviceName = myName();
  closeConn();
  setStatus('Connecting…');
  let p;
  try { p = new Peer({ debug: 0 }); }
  catch (e) { setStatus('Code connect unavailable in this browser — use QR instead.'); return; }
  peer = p;
  p.on('open', () => {
    const c = p.connect(PEER_PREFIX + code, { reliable: true });
    pconn = c;
    dc = makePeerDc(c);
    wireChannel();
  });
  p.on('error', err => {
    if (err.type === 'peer-unavailable')
      setStatus('No receiver with that code — check the digits; the receiver must keep their screen open.');
    else if (err.type === 'network' || err.type === 'server-error')
      setStatus('Code connect needs internet — or use QR instead.');
    else setStatus('Connection error (' + err.type + ') — try QR instead.');
  });
}

function onConnected() {
  if (role === 'tx') {
    $('txSendCard').style.display = 'block';
    $('txPeer').textContent = peerName ? 'to ' + peerName : '';
    stopScanner();
    pumpQueue(); // (re)send pending offers — drives transfer resume
  }
}

/* ---- receiver: create offer ---- */
async function startReceive() {
  role = 'rx'; peerName = ''; myDeviceName = myName();
  $('rxAnswerCard').style.display = 'none';
  $('rxList').innerHTML = '<p class="hint">Accepted files will appear here.</p>';
  newPC();
  dc = pc.createDataChannel('beamo');
  wireChannel();
  $('rxHint').textContent = 'Creating connection offer…';
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitGathering();
  const code = await encSignal({ t: 'offer', sdp: minSdp(pc.localDescription.sdp) });
  renderQr($('rxQr'), code);
  $('rxHint').textContent = 'Offline option: on the sender, tap Send → Scan QR (or paste the code).';
  $('rxAnswerCard').style.display = 'block';
  setStatus('Waiting for sender…');
  startReceiveCode(); // easy-connect code runs in parallel — first to connect wins
}

/* ---------------- SDP sanitize ----------------
 * Strips SDP lines that some browsers reject at parse time.
 * Applied to INCOMING offers/answers, so even codes generated by older
 * app versions keep working. */
function sanitizeSdp(sdp) {
  let lines = sdp.split('\r\n').filter(l => !l.startsWith('a=max-message-size:'));
  // sctp-port and sctpmap are mutually exclusive — keep sctpmap (legacy) if both present
  if (lines.some(l => l.startsWith('a=sctpmap:')))
    lines = lines.filter(l => !l.startsWith('a=sctp-port:'));
  return lines.join('\r\n');
}

async function applyAnswer() {
  const raw = $('rxAnswer').value;
  if (!raw.trim()) return;
  try {
    const o = await decSignal(raw);
    if (o.t !== 'answer') throw new Error('not an answer');
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sanitizeSdp(o.sdp) }));
    setStatus('Connecting…');
  } catch (e) {
    setStatus('Invalid answer code: ' + e.message);
  }
}

/* ---- sender: consume offer, produce answer ---- */
async function applyOffer(raw) {
  const o = await decSignal(raw);
  if (o.t !== 'offer') throw new Error('not an offer');
  role = 'tx'; myDeviceName = myName();
  newPC();
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sanitizeSdp(o.sdp) }));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitGathering();
  const code = await encSignal({ t: 'answer', sdp: minSdp(pc.localDescription.sdp) });
  renderQr($('txQr'), code);
  $('txQrHint').style.display = 'block';
  $('txAnswerCode').style.display = 'block';
  $('txAnswerCode').value = code;
  setStatus('Answer ready — show this QR to the receiver, then wait.');
}

/* ---------------- transfer protocol ----------------
 * control frames are JSON strings; file bytes are ArrayBuffers.
 * S->R: {t:'file', id, name, size} | R->S: {t:'accept'|'decline', id}
 * S->R: chunks… then {t:'done', id}
 * S->R: {t:'text', id, text}  (no accept needed)
 */
const incoming = {};   // id -> {name,size,chunks,received,t0}
const outgoing = {};   // id -> {file,name,size,sent,t0,el}
let activeRxId = null;
const sendQueue = [];
let sending = false;

function onMsg(e) {
  if (typeof e.data === 'string') {
    let m;
    try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.t === 'hello') { peerName = m.name || ''; onConnected(); return; }
    if (m.t === 'file') return onFileOffer(m);
    if (m.t === 'text') return onTextMsg(m);
    if (m.t === 'accept') return onAccept(m.id);
    if (m.t === 'have') return onHave(m);
    if (m.t === 'decline') return onDecline(m.id);
    if (m.t === 'done') return onDone(m.id);
    return;
  }
  onChunk(e.data);
}

/* ---- receiving ---- */
function onFileOffer(m) {
  const prev = incoming[m.id];
  if (prev && prev.size === m.size && prev.received > 0 && prev.received < m.size) {
    // Resume: same id re-offered after a reconnect and we already hold part
    // of it. Flush pending disk writes, line the writer up at the byte we
    // reached, then tell the sender where to continue from.
    activeRxId = m.id;
    (async () => {
      try { await prev.writeChain; } catch (e) {}
      if (prev.sink && prev.sink.type !== 'mem' && prev.sink.writable.seek) {
        try { await prev.sink.writable.seek(prev.received); } catch (e) {}
      }
      try { dc.send(JSON.stringify({ t: 'have', id: m.id, received: prev.received })); } catch (e) {}
    })();
    const el = $('rx-' + m.id);
    if (el) {
      const row = el.querySelector('.row');
      if (row) row.innerHTML = '<div class="meta">Resuming… ' + fmtBytes(prev.received) + ' already here</div><div class="bar"><div></div></div><div class="meta spd"></div>';
      const bar = el.querySelector('.bar > div');
      if (bar) bar.style.width = (prev.received / prev.size * 100) + '%';
    }
    return;
  }
  if (prev) { // stale partial entry (0 bytes or wrong size) — start fresh
    const old = $('rx-' + m.id);
    if (old) old.remove();
    delete incoming[m.id];
  }
  incoming[m.id] = { name: m.name, size: m.size, chunks: [], received: 0, t0: Date.now() };
  activeRxId = m.id;
  const list = $('rxList');
  if (list.querySelector('.hint')) list.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'xfer'; div.id = 'rx-' + m.id;
  div.innerHTML =
    '<div class="fn">📄 ' + escapeHtml(m.name) + '</div>' +
    '<div class="meta">' + fmtBytes(m.size) + ' · from ' + escapeHtml(peerName || 'sender') + '</div>' +
    '<div class="row"><button class="btn small green" data-a="y">Accept</button>' +
    '<button class="btn small" data-a="n">Decline</button></div>';
  div.querySelector('[data-a="y"]').onclick = async () => {
    const ok = await prepareSink(m);
    if (!ok) { // user cancelled the save dialog — tell the sender
      dc.send(JSON.stringify({ t: 'decline', id: m.id }));
      div.remove(); delete incoming[m.id];
      return;
    }
    dc.send(JSON.stringify({ t: 'accept', id: m.id }));
    const toDisk = incoming[m.id].sink && incoming[m.id].sink.type !== 'mem';
    div.querySelector('.row').innerHTML = '<div class="meta">Receiving…' + (toDisk ? ' (saving to disk 💾)' : '') + '</div><div class="bar"><div></div></div><div class="meta spd"></div>';
  };
  div.querySelector('[data-a="n"]').onclick = () => {
    dc.send(JSON.stringify({ t: 'decline', id: m.id }));
    div.remove(); delete incoming[m.id];
  };
  list.prepend(div);
  // Auto-accept: skip the tap for every file when the toggle is on.
  if ($('rxAutoAccept') && $('rxAutoAccept').checked)
    div.querySelector('[data-a="y"]').click();
}

function onTextMsg(m) {
  const list = $('rxList');
  if (list.querySelector('.hint')) list.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'xfer';
  const safe = escapeHtml(m.text || '');
  div.innerHTML =
    '<div class="fn">📝 Text note from ' + escapeHtml(peerName || 'sender') + '</div>' +
    '<div class="note">' + safe + '</div>' +
    '<div class="row"><button class="btn small" data-a="c">Copy</button>' +
    '<button class="btn small" data-a="s">Save .txt</button></div>';
  div.querySelector('[data-a="c"]').onclick = () => {
    navigator.clipboard.writeText(m.text || '');
  };
  div.querySelector('[data-a="s"]').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([m.text || ''], { type: 'text/plain' }));
    a.download = 'beamo-note.txt'; a.click();
  };
  list.prepend(div);
}

/* ---- receive sink: memory for small files, disk for large ones ----
 * Files >= DISK_THRESHOLD stream straight to disk so multi-GB transfers
 * never fill RAM: File System Access (user picks the destination) when
 * available, OPFS temp file otherwise, memory as last resort. */
const DISK_THRESHOLD = 150 * 1024 * 1024;
async function prepareSink(m) {
  const inc = incoming[m.id];
  inc.sink = { type: 'mem' };
  inc.chunks = [];
  inc.writeChain = Promise.resolve();
  if (m.size < DISK_THRESHOLD) return true;
  if (window.showSaveFilePicker) {
    try {
      const base = m.name.split('/').pop(); // folder paths arrive as name — picker wants a file name
      const handle = await window.showSaveFilePicker({ suggestedName: base });
      inc.sink = { type: 'fs', writable: await handle.createWritable() };
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
    }
  }
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('beamo-' + m.id + '.tmp', { create: true });
    if (fh.createWritable) {
      inc.sink = { type: 'opfs', writable: await fh.createWritable(), fh, root };
    }
  } catch (e) {}
  return true;
}
// clean up OPFS temp files left by earlier sessions
(async () => {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys())
      if (name.startsWith('beamo-')) await root.removeEntry(name);
  } catch (e) {}
})();

function onChunk(data) {
  const inc = incoming[activeRxId];
  if (!inc) return;
  if (inc.sink && inc.sink.type !== 'mem') {
    const w = inc.sink.writable;
    inc.writeChain = (inc.writeChain || Promise.resolve()).then(() => w.write(data)).catch(() => {});
  } else {
    inc.chunks.push(data);
  }
  inc.received += data.byteLength;
  const el = $('rx-' + activeRxId);
  if (el) {
    const pct = inc.size ? (inc.received / inc.size * 100) : 0;
    const bar = el.querySelector('.bar > div');
    if (bar) bar.style.width = Math.min(100, pct) + '%';
    const spd = el.querySelector('.spd');
    if (spd) spd.textContent = speedLine(inc);
  }
}

function speedLine(x) {
  const el = (Date.now() - x.t0) / 1000;
  if (el < 0.5) return '';
  const bps = x.received / el;
  const rem = x.size - x.received;
  return fmtSpeed(bps) + (bps > 0 && rem > 0 ? ' · ' + fmtEta(Math.ceil(rem / bps)) : '');
}

async function onDone(id) {
  const inc = incoming[id];
  if (!inc) return;
  const el = $('rx-' + id);
  const showLink = url => {
    const link = '<a class="dl" href="' + url + '" download="' + escapeAttr(inc.name) + '">⬇ Download ' + escapeHtml(inc.name) + '</a>';
    if (el) {
      el.querySelector('.meta').textContent = fmtBytes(inc.size) + ' · complete ✓';
      const bar = el.querySelector('.bar > div');
      if (bar) bar.style.width = '100%';
      const d = document.createElement('div');
      d.style.marginTop = '8px'; d.innerHTML = link;
      el.appendChild(d);
    }
    // auto-download too (may be blocked — the link above is the fallback)
    try {
      const a = document.createElement('a');
      a.href = url; a.download = inc.name;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (_) {}
  };
  if (inc.sink && inc.sink.type !== 'mem') {
    try { await inc.writeChain; await inc.sink.writable.close(); } catch (e) {}
    if (inc.sink.type === 'fs') {
      // already written to the file the user picked — nothing to download
      if (el) {
        el.querySelector('.meta').textContent = fmtBytes(inc.size) + ' · saved to disk ✓';
        const bar = el.querySelector('.bar > div');
        if (bar) bar.style.width = '100%';
        const row = el.querySelector('.row');
        if (row) row.innerHTML = '<div class="meta">💾 Saved directly to your device.</div>';
      }
    } else {
      const file = await inc.sink.fh.getFile().catch(() => null);
      if (file) showLink(URL.createObjectURL(file));
    }
  } else {
    showLink(URL.createObjectURL(new Blob(inc.chunks)));
  }
  delete incoming[id];
  if (activeRxId === id) activeRxId = null;
}

/* ---- sending ---- */
function fileLabel(f) { return f.__path || f.webkitRelativePath || f.name; }

function queueFiles(files) {
  for (const f of files) {
    const id = uid();
    sendQueue.push({ id, file: f });
    addTxCard(id, fileLabel(f), f.size);
  }
  pumpQueue();
}

function addTxCard(id, name, size) {
  const div = document.createElement('div');
  div.className = 'xfer'; div.id = 'tx-' + id;
  div.innerHTML =
    '<div class="fn">📄 ' + escapeHtml(name) + '</div>' +
    '<div class="meta">' + fmtBytes(size) + ' · waiting…</div>' +
    '<div class="bar"><div></div></div>';
  $('txList').prepend(div);
}

function txCard(id) { return $('tx-' + id); }

function pumpQueue() {
  if (sending || !sendQueue.length || !connected) return;
  sending = true;
  const { id, file } = sendQueue.shift();
  outgoing[id] = { name: fileLabel(file), size: file.size, sent: 0, t0: Date.now() };
  try {
    dc.send(JSON.stringify({ t: 'file', id, name: fileLabel(file), size: file.size }));
  } catch (e) { // channel died between check and send — retry on reconnect
    sendQueue.unshift({ id, file }); delete outgoing[id]; sending = false; return;
  }
  const el = txCard(id);
  if (el) el.querySelector('.meta').textContent = fmtBytes(file.size) + ' · waiting for accept…';
  outgoing[id].file = file;
}

function onAccept(id) {
  const o = outgoing[id];
  if (!o || !o.file) return;
  const el = txCard(id);
  if (el) el.querySelector('.meta').textContent = fmtBytes(o.size) + ' · sending…';
  sendChunks(id, 0);
}

// Receiver already holds part of this file (reconnect) — resume mid-file.
function onHave(m) {
  const o = outgoing[m.id];
  if (!o || !o.file) return;
  const el = txCard(m.id);
  if (el) el.querySelector('.meta').textContent = fmtBytes(o.size) + ' · resuming…';
  sendChunks(m.id, Math.min(m.received || 0, o.size));
}

// Connection dropped mid-transfer: put the file back at the head of the
// queue with its SAME id — the receiver recognises it and replies 'have'
// with how much it already has, so the transfer resumes instead of
// restarting from zero.
function requeueFront(id) {
  const o = outgoing[id];
  sending = false;
  if (!o || !o.file) return;
  sendQueue.unshift({ id, file: o.file });
  delete outgoing[id];
  const el = txCard(id);
  if (el) el.querySelector('.meta').textContent =
    fmtBytes(o.size) + ' · connection lost — will resume on reconnect';
}

function onDecline(id) {
  const el = txCard(id);
  if (el) el.querySelector('.meta').textContent = 'Declined by receiver.';
  delete outgoing[id];
  sending = false;
  pumpQueue();
}

async function sendChunks(id, startAt) {
  const o = outgoing[id];
  if (!o) { sending = false; return; }
  // Stream the file from disk chunk-by-chunk — never load it fully into
  // RAM, so multi-GB files send fine. Chunk size honours the channel's
  // negotiated max message size.
  const chunkSize = Math.min(CHUNK, (dc && dc.maxMessageSize) || 16 * 1024);
  let off = startAt || 0;
  o.sent = off;
  const total = o.file.size;
  try {
    while (off < total) {
      if (!connected) { requeueFront(id); return; }
      while (dc.bufferedAmount > BUFFER_HIGH) {
        await new Promise(res => {
          const h = () => { dc.removeEventListener('bufferedamountlow', h); res(); };
          dc.addEventListener('bufferedamountlow', h);
          setTimeout(res, 500);
        });
        if (!connected) { requeueFront(id); return; }
      }
      const end = Math.min(off + chunkSize, total);
      const part = await o.file.slice(off, end).arrayBuffer();
      dc.send(part);
      off = end;
      o.sent = off;
      const el = txCard(id);
      if (el) {
        const bar = el.querySelector('.bar > div');
        if (bar) bar.style.width = (off / total * 100) + '%';
        el.querySelector('.meta').textContent =
          fmtBytes(off) + ' / ' + fmtBytes(total) + ' · ' + speedLine({ received: off, size: total, t0: o.t0 });
      }
    }
    dc.send(JSON.stringify({ t: 'done', id }));
    const el = txCard(id);
    if (el) {
      el.querySelector('.meta').textContent = fmtBytes(total) + ' · sent ✓';
      const bar = el.querySelector('.bar > div');
      if (bar) bar.style.width = '100%';
    }
    delete outgoing[id];
    sending = false;
    pumpQueue();
  } catch (e) {
    requeueFront(id); // channel error — file goes back to the queue to resume
  }
}

function sendTextNote() {
  const text = $('txText').value.trim();
  if (!text || !connected) return;
  dc.send(JSON.stringify({ t: 'text', id: uid(), text }));
  $('txText').value = '';
}

/* ---------------- QR scanning (sender) ---------------- */
let scanStream = null, scanning = false;

async function startScanner(onCode, caption) {
  if (!('BarcodeDetector' in window)) {
    if (role === 'tx') $('txPasteWrap').style.display = 'block';
    setStatus('Camera scan not supported here — paste the code instead.');
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }, audio: false
    });
  } catch (e) {
    if (role === 'tx') $('txPasteWrap').style.display = 'block';
    setStatus('Camera blocked — paste the code instead.');
    return;
  }
  $('scanVideo').srcObject = scanStream;
  $('scanCap').textContent = caption || 'Point at the QR code';
  await $('scanVideo').play().catch(() => {});
  $('scanner').classList.add('open');
  scanning = true;
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const loop = async () => {
    if (!scanning) return;
    try {
      const codes = await detector.detect($('scanVideo'));
      if (codes.length) {
        const v = codes[0].rawValue || '';
        if (v.indexOf(PREFIX) === 0 || v.indexOf(PREFIX2) === 0) {
          stopScanner();
          try { await onCode(v); }
          catch (e) { setStatus('Invalid QR: ' + e.message); }
          return;
        }
      }
    } catch (_) {}
    requestAnimationFrame(loop);
  };
  loop();
}

function stopScanner() {
  scanning = false;
  $('scanner').classList.remove('open');
  if (scanStream) {
    scanStream.getTracks().forEach(t => t.stop());
    scanStream = null;
  }
}

/* ---------------- escaping ---------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

/* ---------------- wiring ---------------- */
$('goRx').onclick = () => { show('rx'); startReceive().catch(e => setStatus('Error: ' + e.message)); };
$('goTx').onclick = () => { role = 'tx'; show('tx'); setStatus(''); };
$('rxBack').onclick = () => { closeConn(); show('home'); };
$('txBack').onclick = () => { closeConn(); stopScanner(); show('home'); };
$('rxApplyAnswer').onclick = applyAnswer;
$('rxScanAnswer').onclick = () => startScanner(
  async code => { $('rxAnswer').value = code; await applyAnswer(); },
  "Point at the sender's answer QR"
);
$('txScan').onclick = () => startScanner(
  async code => { await applyOffer(code); },
  "Point at the receiver's QR code"
);
$('scanClose').onclick = stopScanner;
$('txPasteBtn').onclick = () => {
  $('txPasteWrap').style.display = $('txPasteWrap').style.display === 'none' ? 'block' : 'none';
};
$('txApplyOffer').onclick = async () => {
  try { await applyOffer($('txOffer').value); }
  catch (e) { setStatus('Invalid code: ' + e.message); }
};
$('txFiles').onchange = e => { queueFiles(e.target.files); e.target.value = ''; };
$('txDrop').onclick = () => $('txFiles').click();
$('txFolderBtn').onclick = () => $('txFolder').click();
$('txFolder').onchange = e => { queueFiles(e.target.files); e.target.value = ''; };
// Paste to send: files/screenshots copied to the clipboard go straight
// into the send queue while the Send screen is open.
window.addEventListener('paste', e => {
  if (role !== 'tx' || !$('scr-tx').classList.contains('active')) return;
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) queueFiles(files);
});
['dragenter', 'dragover'].forEach(ev => $('txDrop').addEventListener(ev, e => {
  e.preventDefault(); $('txDrop').classList.add('over');
}));
['dragleave', 'drop'].forEach(ev => $('txDrop').addEventListener(ev, e => {
  e.preventDefault(); $('txDrop').classList.remove('over');
}));
$('txDrop').addEventListener('drop', async e => {
  if (!connected) { setStatus('Connect to the receiver first, then drop files.'); return; }
  if (!e.dataTransfer) return;
  const files = await filesFromDrop(e.dataTransfer);
  if (files.length) queueFiles(files);
});

// Expand a drop into a flat file list, walking dropped folders and
// keeping each file's relative path (f.__path) for display.
async function filesFromDrop(dt) {
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  async function walk(entry, path) {
    if (entry.isFile) {
      const f = await new Promise(r => entry.file(r, () => r(null)));
      if (f) { f.__path = path + f.name; out.push(f); }
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise(r => reader.readEntries(r, () => r([])));
        for (const e of batch) await walk(e, path + entry.name + '/');
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}
// dropping anywhere else must not navigate away from the page
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
$('txSendText').onclick = sendTextNote;
$('txConnectCode').onclick = connectWithCode;
$('txCode').addEventListener('keydown', e => { if (e.key === 'Enter') connectWithCode(); });
$('txCode').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});
$('rxCopyCode').onclick = () => {
  if (pairCode) navigator.clipboard.writeText(pairCode).catch(() => {});
  $('rxCopyCode').textContent = '✓ Copied';
  setTimeout(() => { $('rxCopyCode').textContent = '📋 Copy code'; }, 1500);
};
