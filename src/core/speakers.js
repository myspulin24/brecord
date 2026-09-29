// Who spoke when. Voice-based diarization (sherpa-onnx: pyannote
// segmentation + CAM++ speaker embeddings) splits "Ostatní" into separate
// people. Remembered voices name them on the next recording, and the names
// the user gives in a note are what gets remembered. Everything stays in
// ~/.brecord; nothing about a voice leaves the computer.
'use strict';
const crypto = require('crypto');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOME, MODELS_DIR, writeFileAtomic } = require('./config');
const { IS_WIN, run } = require('./proc');

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const MODELS = {
  segmentation: {
    file: 'pyannote-segmentation-3.0.onnx',
    url: `${RELEASES}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,
    archiveSha256: '24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',
    member: 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx',
    sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079',
    mb: 7,
  },
  embedding: {
    // CAM++ trained on 200k speakers (zh + en): on Teams audio it holds one
    // voice together far better than the VoxCeleb models.
    file: '3dspeaker-campplus-zh-en-common-16k.onnx',
    url: `${RELEASES}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`,
    sha256: 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2',
    mb: 28,
  },
};
const MODELS_MB = MODELS.segmentation.mb + MODELS.embedding.mb;
const SPEAKER_MODELS_DIR = path.join(MODELS_DIR, 'speakers');
const VOICES_FILE = path.join(HOME, 'voices.json');
const NOTE_VOICES_DIR = path.join(HOME, 'speakers');

// Clustering threshold: tuned so one person is rarely split in two while two
// people are rarely merged; a split is fixed by giving both the same name.
const THRESHOLD = 0.6;
// A remembered voice names a cluster only when it is this close and clearly
// closer than any other remembered voice.
const MATCH = 0.72;
const MATCH_MARGIN = 0.08;
const GENERIC = /^Mluvčí \d+$/;

const modelFile = (m) => path.join(SPEAKER_MODELS_DIR, m.file);

function speakerModelsInstalled() {
  return Object.values(MODELS).every((m) => {
    try {
      return fs.statSync(modelFile(m)).size > 1024 * 1024;
    } catch {
      return false;
    }
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function installSpeakerModels({ onProgress, signal } = {}) {
  const { download } = require('./setup');
  fs.mkdirSync(SPEAKER_MODELS_DIR, { recursive: true });
  const steps = Object.values(MODELS).filter((m) => !fs.existsSync(modelFile(m)));
  const report = (i) => (got, total) => onProgress && onProgress((i + (total ? got / total : 0)) / steps.length);
  for (const [i, m] of steps.entries()) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brecord-speakers-'));
    try {
      const fetched = path.join(tmp, path.basename(m.url));
      await download(m.url, fetched, { onProgress: report(i), signal });
      let source = fetched;
      if (m.member) {
        if (sha256(fetched) !== m.archiveSha256) throw new Error(`Stažený ${path.basename(m.url)} nesouhlasí s kontrolním součtem`);
        const tar = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
        const res = await run(tar, ['-xjf', fetched, '-C', tmp, m.member]);
        if (res.code !== 0) throw new Error(`Nepodařilo se rozbalit ${path.basename(m.url)}: ${res.stderr}`);
        source = path.join(tmp, ...m.member.split('/'));
      }
      if (sha256(source) !== m.sha256) throw new Error(`Model ${m.file} nesouhlasí s kontrolním součtem`);
      fs.copyFileSync(source, `${modelFile(m)}.part`);
      fs.renameSync(`${modelFile(m)}.part`, modelFile(m));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { dir: SPEAKER_MODELS_DIR, installed: speakerModelsInstalled() };
}

// Runs the worker; in the packaged app it is Electron itself in Node mode.
function runDiarization(file, { channel, numSpeakers = 0, signal } = {}) {
  if (!speakerModelsInstalled()) return Promise.reject(new Error('Modely pro rozpoznání mluvčích nejsou nainstalované'));
  const threads = Math.max(1, Math.min(4, os.cpus().length - 1));
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'diarize-worker.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // not allowed everywhere; it just runs at normal priority
    }
    let stderr = '';
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => {
      child.kill();
      done(reject, Object.assign(new Error('Zrušeno'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('message', (msg) => (msg.ok ? done(resolve, msg) : done(reject, new Error(msg.error))));
    child.on('error', (err) => done(reject, err));
    child.on('exit', (code) => done(reject, new Error(`Rozpoznání mluvčích skončilo s kódem ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)));
    child.send({ file, channel, numSpeakers, threshold: THRESHOLD, threads, segmentation: modelFile(MODELS.segmentation), embedding: modelFile(MODELS.embedding) });
  });
}

// ── Remembered voices ────────────────────────────────────────────────────
const cosine = (a, b) => require('./diarize-worker').cosine(a, b);

function loadVoices() {
  try {
    const data = JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8'));
    return Array.isArray(data.voices) ? data.voices.filter((v) => v && v.name && Array.isArray(v.embedding)) : [];
  } catch {
    return [];
  }
}

function saveVoices(voices) {
  writeFileAtomic(VOICES_FILE, `${JSON.stringify({ model: MODELS.embedding.file, voices }, null, 1)}\n`, 0o600);
}

// Greedy best-first: each remembered voice names at most one speaker.
function matchVoices(speakers, voices) {
  const pairs = [];
  for (const s of speakers) {
    if (!s.embedding) continue;
    const scored = voices.map((v) => ({ v, sim: cosine(s.embedding, v.embedding) })).sort((a, b) => b.sim - a.sim);
    if (!scored.length || scored[0].sim < MATCH || (scored[1] && scored[0].sim - scored[1].sim < MATCH_MARGIN)) continue;
    pairs.push({ id: s.id, name: scored[0].v.name, sim: scored[0].sim });
  }
  pairs.sort((a, b) => b.sim - a.sim);
  const names = new Map();
  const taken = new Set();
  for (const p of pairs) {
    if (taken.has(p.name) || names.has(p.id)) continue;
    names.set(p.id, p.name);
    taken.add(p.name);
  }
  return names;
}

// Adds a named voiceprint, averaged with what was remembered for that name
// and weighted by how much speech each is made of.
function learnVoice(voices, name, embedding, seconds) {
  const existing = voices.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (!existing) {
    voices.push({ name, embedding, seconds, updatedAt: new Date().toISOString() });
    return voices;
  }
  const w = existing.seconds || 1;
  const sum = existing.embedding.map((x, i) => x * w + embedding[i] * seconds);
  const norm = Math.sqrt(sum.reduce((n, x) => n + x * x, 0)) || 1;
  existing.embedding = sum.map((x) => x / norm);
  existing.seconds = w + seconds;
  existing.updatedAt = new Date().toISOString();
  return voices;
}

function forgetVoice(name) {
  saveVoices(loadVoices().filter((v) => v.name !== name));
}

// ── Per-note voiceprints: what "Mluvčí 2" of a note sounded like, so naming
// it later can teach the voice. Kept in ~/.brecord, not next to the note.
function noteVoicesFile(noteFile) {
  const id = crypto.createHash('sha1').update(path.resolve(noteFile).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(NOTE_VOICES_DIR, `${path.basename(noteFile, '.md')}-${id}.json`);
}

function loadNoteVoices(noteFile) {
  try {
    return JSON.parse(fs.readFileSync(noteVoicesFile(noteFile), 'utf8')).labels || {};
  } catch {
    return {};
  }
}

function saveNoteVoices(noteFile, labels) {
  fs.mkdirSync(NOTE_VOICES_DIR, { recursive: true });
  writeFileAtomic(noteVoicesFile(noteFile), `${JSON.stringify({ note: path.resolve(noteFile), labels })}\n`, 0o600);
}

// ── From clusters to transcript labels ───────────────────────────────────
// Labels in order of first appearance; remembered voices get their name.
function labelClusters(diar, segments, voices) {
  const names = matchVoices(diar.speakers, voices);
  const order = [];
  for (const seg of segments) if (seg.cluster != null && !order.includes(seg.cluster)) order.push(seg.cluster);
  const labels = new Map();
  let n = 0;
  for (const id of order) labels.set(id, names.get(id) || `Mluvčí ${++n}`);
  return { labels, named: new Set(names.keys()) };
}

// The cluster that covers most of a segment; if none touches it, the
// nearest one in time.
function clusterAt(diar, start, end) {
  let best = null;
  let bestOverlap = 0;
  let nearest = null;
  let nearestGap = Infinity;
  for (const d of diar.segments) {
    const overlap = Math.min(end, d.end) - Math.max(start, d.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = d.speaker;
    }
    const gap = overlap > 0 ? 0 : Math.min(Math.abs(d.start - end), Math.abs(start - d.end));
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = d.speaker;
    }
  }
  return best != null ? best : nearest;
}

module.exports = {
  GENERIC,
  MODELS,
  MODELS_MB,
  SPEAKER_MODELS_DIR,
  clusterAt,
  forgetVoice,
  installSpeakerModels,
  labelClusters,
  learnVoice,
  loadNoteVoices,
  loadVoices,
  matchVoices,
  runDiarization,
  saveNoteVoices,
  saveVoices,
  speakerModelsInstalled,
};
