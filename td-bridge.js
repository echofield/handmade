// td-bridge.js — ASTROLAB Field -> TouchDesigner OSC bridge (zero dependencies)
//
// The browser can't speak OSC (it's UDP; browsers don't do UDP). This little
// relay accepts the Field over a WebSocket from hands.js and forwards every
// value to TouchDesigner as OSC. Built only on Node's stdlib — nothing to install.
//
//   RUN:  node td-bridge.js
//   TD :  add an "OSC In CHOP", set Network Port = 7000, Active = On.
//         every Field value arrives as a channel:  pitch, brightness, melody, union, ...
//
const http = require('http');
const crypto = require('crypto');
const dgram = require('dgram');

const WS_PORT = 8765;        // hands.js connects here (ws://127.0.0.1:8765)
const OSC_HOST = '127.0.0.1';
const OSC_PORTS = [7000, 9000];   // every Field frame is fanned out to: 7000 = TouchDesigner · 9000 = Unity (OscJack)

const udp = dgram.createSocket('udp4');

// --- minimal OSC encoder: one float arg per address ---
const pad4 = (n) => (4 - (n % 4)) % 4;
function oscFloat(addr, value) {
  const a = Buffer.from(addr + '\0');
  const ap = Buffer.alloc(pad4(a.length));
  const tag = Buffer.from(',f\0\0');             // ",f" + 2 nulls = 4-byte aligned
  const f = Buffer.alloc(4); f.writeFloatBE(value, 0);
  return Buffer.concat([a, ap, tag, f]);
}
function sendField(obj) {
  for (const k in obj) {
    const v = Number(obj[k]);
    if (!isFinite(v)) continue;
    const msg = oscFloat('/field/' + k, v);
    for (const port of OSC_PORTS) udp.send(msg, 0, msg.length, port, OSC_HOST);   // fan out to every reader
  }
}

// --- minimal WebSocket server: handshake + masked text-frame decode ---
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ASTROLAB TD bridge\n'); });

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  console.log('ASTROLAB connected.');

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { return; }            // payloads this large never occur here
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;               // wait for the rest of the frame
      let payload;
      if (masked) {
        const mask = buf.slice(off, off + 4);
        const data = buf.slice(off + 4, off + 4 + len);
        payload = Buffer.alloc(len);
        for (let i = 0; i < len; i++) payload[i] = data[i] ^ mask[i & 3];
      } else payload = buf.slice(off, off + len);
      buf = buf.slice(need);
      if (op === 0x8) { socket.end(); return; }     // close frame
      if (op === 0x1) {                             // text frame -> Field JSON
        try { sendField(JSON.parse(payload.toString('utf8'))); } catch (e) {}
      }
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => console.log('ASTROLAB disconnected.'));
});

server.listen(WS_PORT, '127.0.0.1', () => {
  console.log('Field bridge up.  ws://127.0.0.1:' + WS_PORT + '  ->  OSC ' + OSC_HOST + ':' + OSC_PORTS.join(',') + '  (/field/<name>)');
  console.log('TouchDesigner: add an "OSC In CHOP", Network Port = 7000, Active = On.');
  console.log('Unity (OscJack): add an "OSC Event Receiver"/connection on UDP port 9000.');
});
