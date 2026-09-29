// Speech-to-text: local whisper.cpp, or the OpenAI / Groq Whisper APIs.
// Returns segments as { start, end, text } in seconds.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MODELS_DIR, WHISPER_DIR, cloudApisEnabled, expandHome } = require('./config');
const { parseGlossary, whisperPrompt } = require('./glossary');
const { IS_WIN, isFile, run, tail, which } = require('./proc');
const { planChunks, writeMonoSlice } = require('./wav');

const API = {
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', keyName: 'OPENAI_API_KEY', modelKey: 'openaiModel' },
  groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', keyName: 'GROQ_API_KEY', modelKey: 'groqModel' },
};
// 10 min of 16 kHz mono PCM is ~19 MB, safely under both APIs' 25 MB limit.
const API_CHUNK_SEC = 600;
const API_MAX_UPLOAD = 24 * 1024 * 1024;

function modelPath(name) {
  if (!name) return null;
  if (/[\\/]/.test(name) || name.endsWith('.bin')) return path.resolve(expandHome(name));
  return path.join(MODELS_DIR, `ggml-${name}.bin`);
}

function findWhisperBin(override) {
  if (override) {
    const p = path.resolve(expandHome(override));
    return isFile(p) ? p : null;
  }
  const names = IS_WIN ? ['whisper-cli.exe'] : ['whisper-cli', 'whisper-cpp'];
  // App-managed install: release archives unpack to whisper/<tag>/…, with
  // the binary in Release/ (Windows) or whisper-bin-ubuntu-x64/ (Linux).
  const found = findIn(WHISPER_DIR, names, 3);
  if (found) return found;
  for (const n of ['whisper-cli', 'whisper-cpp']) {
    const found = which(n);
    if (found) return found;
  }
  return null;
}

function findIn(dir, names, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const n of names) if (entries.some((e) => e.name === n && (e.isFile() || e.isSymbolicLink()))) return path.join(dir, n);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findIn(path.join(dir, e.name), names, depth - 1);
    if (hit) return hit;
  }
  return null;
}

function localWhisper(cfg) {
  const t = cfg.settings.transcription;
  const bin = findWhisperBin(t.whisperBin);
  const model = modelPath(t.whisperModel);
  const modelExists = !!model && isFile(model);
  return { bin, model, modelName: t.whisperModel, modelExists, ok: !!bin && modelExists };
}

// Order in which engines are tried. Local whisper.cpp always comes last so
// a failed cloud call (offline, quota) still produces a transcript.
function transcriptionPlan(cfg) {
  const provider = cfg.settings.transcription.provider;
  const plan = [];
  // Cloud Whisper is experimental and stays off unless enabled.
  if (cloudApisEnabled(cfg)) {
    if (provider === 'auto') {
      if (cfg.keys.GROQ_API_KEY) plan.push('groq');
      else if (cfg.keys.OPENAI_API_KEY) plan.push('openai');
    } else if (API[provider]) {
      plan.push(provider);
    }
  }
  plan.push('local');
  return plan;
}

function describePlan(cfg) {
  const [first] = transcriptionPlan(cfg);
  if (first !== 'local') return `${API[first].label} Whisper API`;
  const w = localWhisper(cfg);
  return w.ok ? `whisper.cpp (${w.modelName})` : 'whisper.cpp (nenainstalovaný)';
}

// whisper.cpp keeps the prompt only for the first 30 s window unless told to
// carry it; builds from before that option reject it, so ask the binary.
const carryCache = new Map();
async function canCarryPrompt(bin) {
  if (!carryCache.has(bin)) {
    carryCache.set(bin, run(bin, ['--help'], { cwd: path.dirname(bin), timeoutMs: 15000 })
      .then((r) => /--carry-initial-prompt/.test(`${r.stdout}\n${r.stderr}`))
      .catch(() => false));
  }
  return carryCache.get(bin);
}

async function transcribeLocal(file, cfg, { onProgress, signal }) {
  const w = localWhisper(cfg);
  if (!w.bin) throw new Error('whisper.cpp není nainstalovaný (Nastavení → Přepis → Nainstalovat)');
  if (!w.modelExists) throw new Error(`Model whisperu nebyl nalezen: ${w.model} (Nastavení → Přepis → Stáhnout model)`);
  const t = cfg.settings.transcription;
  const threads = t.threads > 0 ? t.threads : Math.max(1, Math.min(8, os.cpus().length - 1));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-whisper-'));
  const outBase = path.join(tmp, 'transcript');
  const args = ['-m', w.model, '-f', file, '-l', t.language || 'auto', '-t', String(threads), '-oj', '-of', outBase, '-pp'];
  const prompt = whisperPrompt(parseGlossary(t.prompt));
  if (prompt) {
    args.push('--prompt', prompt);
    if (await canCarryPrompt(w.bin)) args.push('--carry-initial-prompt');
  }
  try {
    let lastPct = -1;
    // The Linux release keeps its shared libraries next to the binary.
    const env = process.platform === 'linux'
      ? { ...process.env, LD_LIBRARY_PATH: [path.dirname(w.bin), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
      : undefined;
    const res = await run(w.bin, args, {
      env,
      cwd: path.dirname(w.bin),
      signal,
      lowPriority: true,
      maxStdout: 1024 * 1024,
      onStderr: (chunk) => {
        const matches = [...chunk.matchAll(/progress\s*=\s*(\d+)%/g)];
        const pct = matches.length ? Number(matches[matches.length - 1][1]) : -1;
        if (pct >= 0 && pct !== lastPct && onProgress) onProgress((lastPct = pct) / 100);
      },
    });
    const jsonFile = `${outBase}.json`;
    if (res.code !== 0 || !isFile(jsonFile)) throw new Error(`whisper.cpp selhal (kód ${res.code}):\n${tail(res.stderr)}`);
    const json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const segments = (json.transcription || []).map((s) => ({
      start: s.offsets.from / 1000,
      end: s.offsets.to / 1000,
      text: String(s.text || '').trim(),
    }));
    return { segments, engine: `whisper.cpp (${path.basename(w.model, '.bin').replace(/^ggml-/, '')})`, language: json.result && json.result.language };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function fetchWithRetry(url, init, { attempts = 3, signal } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok) return res;
      const body = await res.text();
      const err = new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
      err.status = res.status;
      if (res.status !== 429 && res.status < 500) throw err;
      lastErr = err;
      const retryAfter = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, (retryAfter > 0 ? retryAfter : 2 ** i * 2) * 1000));
    } catch (err) {
      if (err.status || (signal && signal.aborted)) throw err;
      lastErr = err; // network error: retry
      await new Promise((r) => setTimeout(r, 2 ** i * 1000));
    }
  }
  throw lastErr;
}

async function transcribeApi(provider, file, cfg, { analysis, onProgress, signal }) {
  const api = API[provider];
  const key = cfg.keys[api.keyName];
  if (!key) throw new Error(`${api.label}: přepis je vybraný, ale ${api.keyName} není nastavený`);
  const t = cfg.settings.transcription;
  const model = t[api.modelKey];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-upload-'));
  try {
    let pieces;
    if (analysis) {
      pieces = planChunks(analysis, API_CHUNK_SEC).map((c, i) => ({
        ...c,
        file: writeMonoSlice(file, analysis, c.start, c.end, path.join(tmp, `chunk-${i}.wav`)),
      }));
    } else {
      if (fs.statSync(file).size > API_MAX_UPLOAD) throw new Error('Soubor je větší než 24 MB; převeďte ho na WAV, aby se dal rozdělit');
      pieces = [{ start: 0, end: Infinity, file }];
    }

    const segments = [];
    let language;
    let previousText = '';
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(piece.file)]), path.basename(piece.file));
      form.append('model', model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      if (t.language && t.language !== 'auto') form.append('language', t.language);
      // Carry the end of the previous chunk as context so names and spelling stay consistent.
      const prompt = [whisperPrompt(parseGlossary(t.prompt)), previousText.slice(-400)].filter(Boolean).join(' ');
      if (prompt) form.append('prompt', prompt);
      const res = await fetchWithRetry(`${api.base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      }, { signal });
      const json = await res.json();
      language = language || json.language;
      const chunkSegments = json.segments && json.segments.length
        ? json.segments.map((s) => ({ start: piece.start + s.start, end: piece.start + s.end, text: String(s.text || '').trim() }))
        : [{ start: piece.start, end: Number.isFinite(piece.end) ? piece.end : piece.start + (json.duration || 0), text: String(json.text || '').trim() }];
      segments.push(...chunkSegments);
      previousText = json.text || '';
      if (onProgress) onProgress((i + 1) / pieces.length);
    }
    return { segments, engine: `${api.label} ${model}`, language };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function transcribe(file, cfg, { analysis, onProgress, onEngine, signal } = {}) {
  const errors = [];
  for (const engine of transcriptionPlan(cfg)) {
    if (engine === 'local' && errors.length && !localWhisper(cfg).ok) break; // nothing to fall back to
    try {
      if (onEngine) onEngine(engine);
      const result = engine === 'local'
        ? await transcribeLocal(file, cfg, { onProgress, signal })
        : await transcribeApi(engine, file, cfg, { analysis, onProgress, signal });
      return { ...result, warnings: errors };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      errors.push(`${engine === 'local' ? 'whisper.cpp' : API[engine].label}: ${err.message}`);
    }
  }
  throw new Error(`Přepis selhal.\n${errors.join('\n')}`);
}

module.exports = { API, describePlan, findWhisperBin, localWhisper, modelPath, transcribe, transcriptionPlan, fetchWithRetry };
