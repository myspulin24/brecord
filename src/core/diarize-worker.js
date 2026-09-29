// Child process for speaker diarization (see speakers.js). The native
// diarizer blocks for a minute or more on a long recording, and it must
// neither freeze the app nor take it down if it crashes, so it runs here.
//
// In:  { file, channel, segmentation, embedding, numSpeakers, threshold, threads }
// Out: { ok, segments: [{ start, end, speaker }], speakers: [{ id, seconds, embedding }] }
'use strict';
const fs = require('fs');
const { readWavInfo } = require('./wav');

// Clusters smaller than this are fragments of someone else's voice (a cough,
// a word caught in overlap): they join the voice they sound most like. The
// bar grows with the recording, from 4 s up to 20 s for an hour and more.
const MIN_SPEAKER_SEC = 4;
const MAX_SPEAKER_SEC = 20;
const MIN_SPEAKER_SHARE = 0.005;
// Two clusters this alike are one person split in two. Measured on this
// model: halves of one voice score 0.68–0.82, two people rarely above 0.55.
const SAME_VOICE = 0.8;
// Seconds of a speaker's longest segments that go into their voiceprint.
const EMBED_SEC = 60;

function readChannel(file, channel) {
  const info = readWavInfo(file);
  if (info.format !== 1 || info.bitsPerSample !== 16) throw new Error('Rozpoznat mluvčí jde jen v 16bitovém WAV');
  if (info.sampleRate !== 16000) throw new Error(`Nahrávka má ${info.sampleRate} Hz, rozpoznání mluvčích potřebuje 16 kHz`);
  const frames = Math.floor(info.dataBytes / info.blockAlign);
  const out = new Float32Array(frames);
  const ch = Math.min(channel, info.channels - 1);
  const chunk = 16000 * 30;
  const buf = Buffer.alloc(chunk * info.blockAlign);
  const fd = fs.openSync(file, 'r');
  try {
    for (let frame = 0; frame < frames; frame += chunk) {
      const n = Math.min(chunk, frames - frame);
      fs.readSync(fd, buf, 0, n * info.blockAlign, info.dataOffset + frame * info.blockAlign);
      for (let i = 0; i < n; i++) out[frame + i] = buf.readInt16LE(i * info.blockAlign + ch * 2) / 32768;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

const cosine = (a, b) => {
  let dot = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
};

function voiceprint(extractor, samples, segments) {
  const longest = [...segments].sort((a, b) => b.end - b.start - (a.end - a.start));
  const parts = [];
  let total = 0;
  for (const s of longest) {
    if (total >= EMBED_SEC) break;
    parts.push(samples.subarray(Math.floor(s.start * 16000), Math.floor(s.end * 16000)));
    total += s.end - s.start;
  }
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    joined.set(p, at);
    at += p.length;
  }
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples: joined });
  stream.inputFinished();
  if (!extractor.isReady(stream)) return null;
  return Array.from(extractor.compute(stream, false));
}

function diarize(job) {
  const sherpa = require('sherpa-onnx-node');
  const samples = readChannel(job.file, job.channel);
  const numThreads = job.threads || 2;
  const diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: job.segmentation }, numThreads },
    embedding: { model: job.embedding, numThreads },
    clustering: { numClusters: job.numSpeakers > 0 ? job.numSpeakers : -1, threshold: job.threshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  const segments = diarizer.process(samples).map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }));
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: job.embedding, numThreads });

  const clusters = new Map();
  for (const s of segments) {
    const c = clusters.get(s.speaker) || { id: s.speaker, seconds: 0, segments: [] };
    c.seconds += s.end - s.start;
    c.segments.push(s);
    clusters.set(s.speaker, c);
  }
  for (const c of clusters.values()) c.embedding = voiceprint(extractor, samples, c.segments);

  // With a fixed number of speakers the user knows best; otherwise tidy up
  // what threshold clustering leaves behind.
  if (!(job.numSpeakers > 0)) {
    const merge = (from, into) => {
      for (const s of from.segments) s.speaker = into.id;
      into.segments.push(...from.segments);
      into.seconds += from.seconds;
      into.embedding = voiceprint(extractor, samples, into.segments);
      clusters.delete(from.id);
    };
    const total = [...clusters.values()].reduce((n, c) => n + c.seconds, 0);
    const minSec = Math.min(MAX_SPEAKER_SEC, Math.max(MIN_SPEAKER_SEC, total * MIN_SPEAKER_SHARE));
    for (let changed = true; changed && clusters.size > 1; ) {
      changed = false;
      const list = [...clusters.values()].sort((a, b) => a.seconds - b.seconds);
      const small = list.find((c) => c.seconds < minSec);
      if (small) {
        const others = list.filter((c) => c !== small && c.embedding);
        const best = small.embedding ? others.sort((a, b) => cosine(small.embedding, b.embedding) - cosine(small.embedding, a.embedding))[0] : others[others.length - 1];
        if (best) {
          merge(small, best);
          changed = true;
          continue;
        }
      }
      let pair = null;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (!list[i].embedding || !list[j].embedding) continue;
          const sim = cosine(list[i].embedding, list[j].embedding);
          if (sim >= SAME_VOICE && (!pair || sim > pair.sim)) pair = { sim, from: list[i], into: list[j] };
        }
      }
      if (pair) {
        merge(pair.from, pair.into);
        changed = true;
      }
    }
  }

  segments.sort((a, b) => a.start - b.start);
  return {
    segments,
    speakers: [...clusters.values()].map((c) => ({ id: c.id, seconds: Math.round(c.seconds * 10) / 10, embedding: c.embedding })),
  };
}

if (require.main === module) {
  process.once('message', (job) => {
    let reply;
    try {
      reply = { ok: true, ...diarize(job) };
    } catch (err) {
      reply = { ok: false, error: err.message };
    }
    process.send(reply, () => process.exit(0));
  });
}

module.exports = { cosine, diarize };
