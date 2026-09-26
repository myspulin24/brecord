// PCM WAV helpers. Recordings are 16 kHz 16-bit stereo: left = microphone,
// right = system audio. Keeping the sources on separate channels lets us tell
// "Me" from "Them" later, and whisper.cpp mixes stereo down on its own.
'use strict';
const fs = require('fs');
const fsp = fs.promises;

const SAMPLE_RATE = 16000;

function wavHeader({ sampleRate, channels, dataBytes }) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

// Streams PCM to disk as it arrives so a crash loses at most the last chunk;
// the header sizes are patched on close (or by repairWav after a crash).
class WavWriter {
  constructor(file, { sampleRate = SAMPLE_RATE, channels = 2 } = {}) {
    this.file = file;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bytes = 0;
    this.fd = fs.openSync(file, 'wx');
    fs.writeSync(this.fd, wavHeader({ sampleRate, channels, dataBytes: 0 }));
    this.queue = Promise.resolve();
    this.error = null;
  }

  write(chunk) {
    if (this.fd === null) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const offset = 44 + this.bytes;
    this.bytes += buf.length;
    this.queue = this.queue.then(
      () =>
        new Promise((resolve) => {
          fs.write(this.fd, buf, 0, buf.length, offset, (err) => {
            if (err && !this.error) this.error = err;
            resolve();
          });
        }),
    );
  }

  get durationSec() {
    return this.bytes / (this.sampleRate * this.channels * 2);
  }

  async close() {
    await this.queue;
    if (this.fd !== null) {
      fs.writeSync(this.fd, wavHeader({ sampleRate: this.sampleRate, channels: this.channels, dataBytes: this.bytes }), 0, 44, 0);
      fs.closeSync(this.fd);
      this.fd = null;
    }
    if (this.error) throw this.error;
    return { bytes: this.bytes, durationSec: this.durationSec };
  }
}

function readWavInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Not a WAV file');
    }
    let pos = 12;
    let fmt = null;
    const chunkHead = Buffer.alloc(8);
    while (pos + 8 <= size) {
      fs.readSync(fd, chunkHead, 0, 8, pos);
      const id = chunkHead.toString('ascii', 0, 4);
      const len = chunkHead.readUInt32LE(4);
      if (id === 'fmt ') {
        const f = Buffer.alloc(16);
        fs.readSync(fd, f, 0, 16, pos + 8);
        fmt = {
          format: f.readUInt16LE(0),
          channels: f.readUInt16LE(2),
          sampleRate: f.readUInt32LE(4),
          blockAlign: f.readUInt16LE(12),
          bitsPerSample: f.readUInt16LE(14),
        };
      } else if (id === 'data') {
        if (!fmt) throw new Error('WAV data chunk before fmt chunk');
        const available = size - (pos + 8);
        // 0 / 0xFFFFFFFF mean "unknown" (unfinished recording or streaming writer).
        const claimed = len === 0 || len === 0xffffffff ? available : Math.min(len, available);
        const dataBytes = claimed - (claimed % fmt.blockAlign);
        return { ...fmt, dataOffset: pos + 8, dataBytes, claimedBytes: len, fileSize: size, durationSec: dataBytes / (fmt.sampleRate * fmt.blockAlign) };
      }
      pos += 8 + len + (len % 2);
    }
    throw new Error('WAV file has no data chunk');
  } finally {
    fs.closeSync(fd);
  }
}

// Fixes the size fields of a recording that was cut off by a crash or power loss.
function repairWav(file) {
  const info = readWavInfo(file);
  if (info.dataOffset !== 44 || info.claimedBytes === info.dataBytes) return false;
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(36 + info.dataBytes);
    fs.writeSync(fd, b, 0, 4, 4);
    b.writeUInt32LE(info.dataBytes);
    fs.writeSync(fd, b, 0, 4, 40);
    fs.ftruncateSync(fd, 44 + info.dataBytes);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

// One pass over the file computing RMS per channel in `frameSec` windows.
// rms[0] is the mic, rms[1] (stereo only) the system audio.
async function analyzeWav(file, frameSec = 0.1) {
  const info = readWavInfo(file);
  if (info.format !== 1 || info.bitsPerSample !== 16) throw new Error('Only 16-bit PCM WAV can be analysed');
  const { channels, sampleRate, blockAlign } = info;
  const framesPerWindow = Math.max(1, Math.round(sampleRate * frameSec));
  const totalFrames = Math.floor(info.dataBytes / blockAlign);
  const windows = Math.ceil(totalFrames / framesPerWindow);
  const used = Math.min(channels, 2);
  const rms = Array.from({ length: used }, () => new Float32Array(windows));
  const sums = new Float64Array(used);

  const handle = await fsp.open(file, 'r');
  try {
    const chunkFrames = framesPerWindow * 64;
    const buf = Buffer.alloc(chunkFrames * blockAlign);
    let frame = 0;
    let win = 0;
    let inWin = 0;
    while (frame < totalFrames) {
      const want = Math.min(chunkFrames, totalFrames - frame);
      const { bytesRead } = await handle.read(buf, 0, want * blockAlign, info.dataOffset + frame * blockAlign);
      const got = Math.floor(bytesRead / blockAlign);
      if (!got) break;
      for (let i = 0; i < got; i++) {
        const base = i * blockAlign;
        for (let c = 0; c < used; c++) {
          const v = buf.readInt16LE(base + c * 2) / 32768;
          sums[c] += v * v;
        }
        if (++inWin === framesPerWindow) {
          for (let c = 0; c < used; c++) {
            rms[c][win] = Math.sqrt(sums[c] / inWin);
            sums[c] = 0;
          }
          win++;
          inWin = 0;
        }
      }
      frame += got;
    }
    if (inWin) for (let c = 0; c < used; c++) rms[c][win] = Math.sqrt(sums[c] / inWin);
  } finally {
    await handle.close();
  }
  return { ...info, frameSec, rms, file };
}

function windowRange(analysis, startSec, endSec) {
  const n = analysis.rms[0].length;
  const a = Math.max(0, Math.min(n - 1, Math.floor(startSec / analysis.frameSec)));
  const b = Math.max(a + 1, Math.min(n, Math.ceil(endSec / analysis.frameSec)));
  return [a, b];
}

function meanRms(analysis, channel, startSec, endSec) {
  const arr = analysis.rms[channel];
  if (!arr) return 0;
  const [a, b] = windowRange(analysis, startSec, endSec);
  let sum = 0;
  for (let i = a; i < b; i++) sum += arr[i];
  return sum / (b - a);
}

function peakRms(analysis, startSec, endSec) {
  const [a, b] = windowRange(analysis, startSec, endSec);
  let peak = 0;
  for (const arr of analysis.rms) for (let i = a; i < b; i++) if (arr[i] > peak) peak = arr[i];
  return peak;
}

// Splits a long recording into pieces of at most maxSec, cutting in the
// quietest half-second near each boundary so words aren't chopped in half.
function planChunks(analysis, maxSec = 600, searchSec = 20) {
  const total = analysis.durationSec;
  const bounds = [0];
  let pos = 0;
  while (total - pos > maxSec) {
    const target = pos + maxSec;
    let best = target;
    let bestEnergy = Infinity;
    for (let t = Math.max(pos + 1, target - searchSec); t <= target; t += analysis.frameSec) {
      const energy = analysis.rms.reduce((s, _, c) => s + meanRms(analysis, c, t - 0.25, t + 0.25), 0);
      if (energy < bestEnergy) {
        bestEnergy = energy;
        best = t;
      }
    }
    bounds.push(best);
    pos = best;
  }
  bounds.push(total);
  return bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] }));
}

// Writes [startSec, endSec) of a PCM16 WAV as a mono 16-bit WAV (for upload).
function writeMonoSlice(file, info, startSec, endSec, outFile) {
  const { blockAlign, channels, sampleRate } = info;
  const first = Math.floor(startSec * sampleRate);
  const last = Math.min(Math.floor(endSec * sampleRate), Math.floor(info.dataBytes / blockAlign));
  const frames = Math.max(0, last - first);
  const src = Buffer.alloc(frames * blockAlign);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, src, 0, src.length, info.dataOffset + first * blockAlign);
  } finally {
    fs.closeSync(fd);
  }
  const out = Buffer.alloc(44 + frames * 2);
  wavHeader({ sampleRate, channels: 1, dataBytes: frames * 2 }).copy(out, 0);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += src.readInt16LE(i * blockAlign + c * 2);
    out.writeInt16LE(Math.round(sum / channels), 44 + i * 2);
  }
  fs.writeFileSync(outFile, out);
  return outFile;
}

function writeWav(file, samples, { sampleRate = SAMPLE_RATE, channels = 1 } = {}) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  fs.writeFileSync(file, Buffer.concat([wavHeader({ sampleRate, channels, dataBytes: data.length }), data]));
}

module.exports = { SAMPLE_RATE, WavWriter, analyzeWav, meanRms, peakRms, planChunks, readWavInfo, repairWav, wavHeader, writeMonoSlice, writeWav };
