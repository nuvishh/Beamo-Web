/* Beamo Web — browser-to-browser file sharing over WebRTC DataChannel.
 * Fully offline: signaling happens via QR codes (or pasted codes).
 * No server, no account, no internet needed — just the same Wi-Fi/hotspot.
 */
'use strict';

const $ = id => document.getElementById(id);
const CHUNK = 16 * 1024; // DataChannel message size (safe for all browsers)
const PREFIX = 'BEAMO1:';

/* ---------------- codec ---------------- */
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
 * Shrinks the WebRTC offer/answer so the QR stays small and scannable.
 * Drops lines a datachannel doesn't need and keeps max 2 IPv4 UDP host
 * candidates (the path used on same-WiFi). Falls back to original
 * candidates if none match, so exotic networks still connect. */
function minSdp(sdp) {
  let kept = 0;
  const out = [];
  const DROP = new Set([
    'a=end-of-candidates',
    'a=ice-options:trickle',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS'
  ]);
  for (const line of sdp.split('\r\n')) {
    if (!line || DROP.has(line)) continue;
    if (line.startsWith('a=candidate:')) {
      const good = /\budp\b/i.test(line) && /\btyp host\b/.test(line) &&
                   /\d+\.\d+\.\d+\.\d+/.test(line);
      if (!good || kept >= 2) continue;
      kept++;
    }
    out.push(line);
  }
  if (kept === 0) {
    // No IPv4 UDP host candidate (e.g. IPv6-only net) — restore a few originals
    for (const line of sdp.split('\r\n')) {
      if (line.startsWith('a=candidate:') && out.filter(l => l.startsWith('a=candidate:')).length < 3)
        out.push(line);
    }
  }
  return out.join('\r\n');
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
    const qr = qrcode(0, 'M');
    qr.addData(code);
    qr.make();
    el.innerHTML = qr.createImgTag(5, 4);
  } catch (e) {
    el.innerHTML = '<p style="color:#000">Code too long for QR — use paste instead.</p>';
  }
}

/* ---------------- webrtc ---------------- */
let pc = null, dc = null, role = null, peerName = '', myDeviceName = '';
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
  pc = dc = null; connected = false;
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
  dc.bufferedAmountLowThreshold = 512 * 1024;
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

function onConnected() {
  if (role === 'tx') {
    $('txSendCard').style.display = 'block';
    $('txPeer').textContent = peerName ? 'to ' + peerName : '';
    stopScanner();
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
  const code = enc({ t: 'offer', sdp: minSdp(pc.localDescription.sdp) });
  renderQr($('rxQr'), code);
  $('rxHint').textContent = 'On the sender: tap Send → Scan QR (or paste the code).';
  $('rxAnswerCard').style.display = 'block';
  setStatus('Waiting for sender…');
}

async function applyAnswer() {
  const raw = $('rxAnswer').value;
  if (!raw.trim()) return;
  try {
    const o = dec(raw);
    if (o.t !== 'answer') throw new Error('not an answer');
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: o.sdp }));
    setStatus('Connecting…');
  } catch (e) {
    setStatus('Invalid answer code: ' + e.message);
  }
}

/* ---- sender: consume offer, produce answer ---- */
async function applyOffer(raw) {
  const o = dec(raw);
  if (o.t !== 'offer') throw new Error('not an offer');
  role = 'tx'; myDeviceName = myName();
  newPC();
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: o.sdp }));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitGathering();
  const code = enc({ t: 'answer', sdp: minSdp(pc.localDescription.sdp) });
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
    if (m.t === 'decline') return onDecline(m.id);
    if (m.t === 'done') return onDone(m.id);
    return;
  }
  onChunk(e.data);
}

/* ---- receiving ---- */
function onFileOffer(m) {
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
  div.querySelector('[data-a="y"]').onclick = () => {
    dc.send(JSON.stringify({ t: 'accept', id: m.id }));
    div.querySelector('.row').innerHTML = '<div class="meta">Receiving…</div><div class="bar"><div></div></div><div class="meta spd"></div>';
  };
  div.querySelector('[data-a="n"]').onclick = () => {
    dc.send(JSON.stringify({ t: 'decline', id: m.id }));
    div.remove(); delete incoming[m.id];
  };
  list.prepend(div);
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

function onChunk(data) {
  const inc = incoming[activeRxId];
  if (!inc) return;
  inc.chunks.push(data);
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

function onDone(id) {
  const inc = incoming[id];
  if (!inc) return;
  const blob = new Blob(inc.chunks);
  const url = URL.createObjectURL(blob);
  const el = $('rx-' + id);
  const link = '<a class="dl" href="' + url + '" download="' + escapeAttr(inc.name) + '">⬇ Download ' + escapeHtml(inc.name) + '</a>';
  if (el) {
    el.querySelector('.meta').textContent = fmtBytes(inc.size) + ' · complete ✓';
    const bar = el.querySelector('.bar > div');
    if (bar) bar.style.width = '100%';
    const row = el.querySelector('.row') || el;
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
  delete incoming[id];
  if (activeRxId === id) activeRxId = null;
}

/* ---- sending ---- */
function queueFiles(files) {
  for (const f of files) {
    const id = uid();
    sendQueue.push({ id, file: f });
    addTxCard(id, f.name, f.size);
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
  outgoing[id] = { name: file.name, size: file.size, sent: 0, t0: Date.now() };
  dc.send(JSON.stringify({ t: 'file', id, name: file.name, size: file.size }));
  const el = txCard(id);
  if (el) el.querySelector('.meta').textContent = fmtBytes(file.size) + ' · waiting for accept…';
  outgoing[id].file = file;
}

function onAccept(id) {
  const o = outgoing[id];
  if (!o || !o.file) return;
  const el = txCard(id);
  if (el) el.querySelector('.meta').textContent = fmtBytes(o.size) + ' · sending…';
  sendChunks(id);
}

function onDecline(id) {
  const el = txCard(id);
  if (el) el.querySelector('.meta').textContent = 'Declined by receiver.';
  delete outgoing[id];
  sending = false;
  pumpQueue();
}

async function sendChunks(id) {
  const o = outgoing[id];
  const buf = await o.file.arrayBuffer();
  let off = 0;
  const total = buf.byteLength;
  while (off < total) {
    while (dc.bufferedAmount > 1024 * 1024) {
      await new Promise(res => {
        const h = () => { dc.removeEventListener('bufferedamountlow', h); res(); };
        dc.addEventListener('bufferedamountlow', h);
        setTimeout(res, 500);
      });
      if (!connected) return;
    }
    const end = Math.min(off + CHUNK, total);
    dc.send(buf.slice(off, end));
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
        if (v.indexOf(PREFIX) === 0) {
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
$('txSendText').onclick = sendTextNote;
