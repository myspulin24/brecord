// Windows only: per-device system-audio capture through the small WASAPI
// helper in src/native/win-loopback.cs, compiled on first use with the
// csc.exe that ships with .NET Framework 4.x (no SDK required).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { HOME } = require('./config');
const { isFile, run, tail } = require('./proc');

const SOURCE = path.join(__dirname, '..', 'native', 'win-loopback.cs');

function findCsc() {
  const win = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find(isFile);
}

let building = null;

// Returns the helper exe path, compiling it if the source changed.
function ensureHelper() {
  if (process.platform !== 'win32') return Promise.reject(new Error('Potřeba jen na Windows'));
  if (building) return building;
  building = (async () => {
    // Read through fs so this also works from inside app.asar.
    const source = fs.readFileSync(SOURCE, 'utf8');
    const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 10);
    const dir = path.join(HOME, 'bin');
    const exe = path.join(dir, `brecord-loopback-${hash}.exe`);
    if (isFile(exe)) return exe;
    const csc = findCsc();
    if (!csc) throw new Error('Kompilátor .NET Framework 4 (csc.exe) nebyl nalezen, nahrávání systémového zvuku přes WASAPI není k dispozici');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'win-loopback.cs');
    fs.writeFileSync(src, source);
    const res = await run(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${exe}`, src], { timeoutMs: 120000 });
    if (res.code !== 0 || !isFile(exe)) throw new Error(`Nepodařilo se sestavit nahrávací pomocník:\n${tail(res.stdout || res.stderr, 8)}`);
    for (const f of fs.readdirSync(dir)) {
      if (/^(minutes|brecord)-loopback-.*\.exe$/.test(f) && path.join(dir, f) !== exe) fs.rmSync(path.join(dir, f), { force: true });
    }
    return exe;
  })();
  building.catch(() => {
    building = null;
  });
  return building;
}

// [{ id, name, default, communications }]
async function listOutputs() {
  const exe = await ensureHelper();
  const res = await run(exe, ['list'], { timeoutMs: 15000 });
  if (res.code !== 0) throw new Error(tail(res.stderr, 3) || `exit ${res.code}`);
  return JSON.parse(res.stdout);
}

// Streams 16 kHz mono s16le PCM of what `deviceId` plays. Resolves once the
// device is open; rejects if it can't be opened.
async function startCapture(deviceId, { onData, onExit } = {}) {
  const exe = await ensureHelper();
  const child = spawn(exe, ['capture', deviceId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  return new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) {
        child.kill();
        reject(new Error('Výstupní zařízení se nespustilo včas'));
      }
    }, 10000);
    child.stdout.on('data', (d) => onData && onData(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
      if (!ready && /READY/.test(stderr)) {
        ready = true;
        clearTimeout(timer);
        resolve({
          stop: () => {
            child.stdin.end();
            setTimeout(() => child.exitCode === null && child.kill(), 1500);
          },
          info: (stderr.match(/READY (.*)/) || [])[1],
        });
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!ready) reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const message = (stderr.match(/ERROR (.*)/) || [])[1];
      if (!ready) reject(new Error(message || `Nahrávací pomocník skončil (kód ${code})`));
      else if (onExit) onExit(code, message);
    });
  });
}

// Buffers the helper's mono PCM and writes it into the right channel of the
// recorder's stereo chunks. The recorder is the master clock; WASAPI loopback
// delivers nothing while the device is silent, so a short queue is padded
// with silence, and a backlog beyond 1.5 s (clock drift) is trimmed.
class PcmQueue {
  constructor() {
    this.chunks = [];
    this.bytes = 0;
  }

  push(buf) {
    this.chunks.push(buf);
    this.bytes += buf.length;
  }

  // Removes up to n bytes, whole samples only (a sample may be split across
  // two pipe reads), and returns them zero-padded to n.
  take(n) {
    const out = Buffer.alloc(n);
    let want = Math.min(n, this.bytes - (this.bytes % 2));
    want -= want % 2;
    let off = 0;
    while (off < want) {
      const head = this.chunks[0];
      const take = Math.min(head.length, want - off);
      head.copy(out, off, 0, take);
      off += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.bytes -= want;
    return out;
  }

  // Fills the right channel of an interleaved s16le stereo buffer in place;
  // returns the peak level (0..1) of what was written.
  fillRight(stereo, { maxBacklog = 48000, keep = 16000 } = {}) {
    const frames = stereo.length / 4;
    if (this.bytes > maxBacklog) this.take(this.bytes - keep);
    const mono = this.take(frames * 2);
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const sample = mono.readInt16LE(i * 2);
      stereo.writeInt16LE(sample, i * 4 + 2);
      if (Math.abs(sample) > peak) peak = Math.abs(sample);
    }
    return peak / 32768;
  }
}

module.exports = { PcmQueue, ensureHelper, listOutputs, startCapture };
