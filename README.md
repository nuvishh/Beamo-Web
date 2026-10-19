# 📡 Beamo Web

Browser-to-browser file sharing — no server, no internet, no account.

Two browsers on the same Wi-Fi (or hotspot) connect directly via **WebRTC DataChannel**. Signaling happens through **QR codes**, so the whole thing works fully offline.

## How to use

1. Open the page on both devices.
2. One side taps **Receive** → shows a QR code (connection offer).
3. Other side taps **Send** → **Scan QR** (or paste the code) → shows its answer QR/code back.
4. Receiver pastes the sender's answer code → connected ✓
5. Sender picks files → receiver accepts → transfer with live progress, speed and ETA.

Text notes can be sent too — they arrive as copyable notes (with a save-as-.txt option).

## Notes

- QR scanning uses the browser's built-in `BarcodeDetector` (Chrome/Edge on Android). If unavailable, paste the code instead.
- QR-both-ways needs a camera on both sides (phone ↔ phone, phone ↔ laptop). A camera-less TV can't scan — for TV transfers, use the Beamo app's browser-upload page.
- Files are transferred peer-to-peer and never touch a server.

## Files

- `index.html` — the page
- `style.css` — dark Beamo theme
- `app.js` — WebRTC handshake + transfer protocol (no dependencies)
- `qrcode.min.js` — inlined QR generator ([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), MIT)

Host it anywhere static — GitHub Pages, Netlify, or just open `index.html` on each device.
