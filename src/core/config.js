// Settings live in ~/.brecord/settings.json (edited in the app's Settings);
// API keys live in ~/.brecord/.env. Nothing here imports Electron so the CLI
// can share it.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function expandHome(p) {
  if (!p) return p;
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

const APP_ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.resolve(expandHome(process.env.BRECORD_HOME || process.env.MINUTES_HOME || path.join(os.homedir(), '.brecord')));

// The app was called Minutes during development; keep its downloaded models.
const LEGACY_HOME = path.join(os.homedir(), '.minutes');
if (!process.env.BRECORD_HOME && !process.env.MINUTES_HOME && !fs.existsSync(HOME) && fs.existsSync(LEGACY_HOME)) {
  try {
    fs.renameSync(LEGACY_HOME, HOME);
  } catch {
    // In use or on another volume: start fresh; the old folder stays untouched.
  }
}
const SETTINGS_FILE = path.join(HOME, 'settings.json');
const ENV_FILE = path.join(HOME, '.env');
const MODELS_DIR = path.join(HOME, 'models');
const WHISPER_DIR = path.join(HOME, 'whisper');
const API_KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY'];

const DEFAULT_SETTINGS = {
  onboarded: false,
  notesDir: '~/MeetingNotes',
  myName: '',
  // Language of the written notes: 'cs', 'en', 'sk', 'de', 'pl', or 'auto'
  // (same as the meeting). Empty means the default, Czech.
  notesLanguage: 'cs',
  theme: 'system', // system | dark | light
  openNoteWhenDone: false,
  noteEditor: 'pilcrow', // pilcrow (when installed) | system
  notifications: true,
  globalShortcut: false, // Ctrl/Cmd+Alt+R starts and stops recording
  trayHintShown: false,
  updateChecks: true, // look for a new release on GitHub (BRECORD_AUTO_UPDATE=0 turns it off)
  autoUpdate: true, // download in the background and install on quit (Windows, AppImage)
  micDeviceId: '',
  // Chromium's device ids are salted per profile and can change; the label
  // lets us find the same microphone again.
  micDeviceLabel: '',
  // System audio source: '' = default output device, 'none' = microphone
  // only. Windows also accepts 'communications' (the device Teams/Zoom use
  // by default) or a specific output device id.
  outputDeviceId: '',
  // macOS only: 'screen-capture' uses the Screen & System Audio Recording
  // permission; 'coreaudio-tap' uses Core Audio taps (macOS 14.2+, needs
  // NSAudioCaptureUsageDescription, i.e. the packaged app). Restart to apply.
  macSystemAudio: 'screen-capture',
  summary: {
    // auto = first available of: Claude Code CLI, Codex CLI, API keys, Ollama.
    provider: 'auto',
    // Tried when the primary fails. Ollama is skipped silently if not running.
    fallback: 'ollama',
    claudeCode: { path: '', model: '', effort: '' },
    codex: { path: '', model: '', effort: '' },
    ollama: { host: 'http://127.0.0.1:11434', model: '' },
    anthropic: { model: 'claude-opus-5' },
    openai: { model: 'gpt-5-mini', baseUrl: '' },
    groq: { model: 'openai/gpt-oss-120b' },
  },
  // Features still being tested; shown greyed out in Settings → Experimental.
  experimental: {
    // Cloud Whisper transcription and API-key summaries (Anthropic, OpenAI, Groq).
    cloudApis: false,
  },
  transcription: {
    // auto = cloud Whisper API if enabled and a key is set, otherwise local
    // whisper.cpp. Local whisper.cpp is always the fallback.
    provider: 'auto',
    whisperModel: 'medium',
    whisperBin: '',
    language: 'auto',
    prompt: '',
    threads: 0,
    openaiModel: 'whisper-1',
    groqModel: 'whisper-large-v3-turbo',
  },
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows refuses to replace a file another process holds open; fall back to a plain write.
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, data);
  }
}

function readSettings() {
  try {
    return deepMerge(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[brecord] Could not read ${SETTINGS_FILE}: ${err.message}`);
    return deepMerge(DEFAULT_SETTINGS, {});
  }
}

function updateSettings(patch) {
  const next = deepMerge(readSettings(), patch);
  writeFileAtomic(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

function readEnvFile() {
  try {
    return parseDotenv(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const ENV_TEMPLATE = [
  '# API klíče pro BRecord (experimentální funkce). Shrnutí přes Claude Code / Codex',
  '# používají přihlášení v CLI a klíč nepotřebují.',
  '# ANTHROPIC_API_KEY=',
  '# OPENAI_API_KEY=',
  '# GROQ_API_KEY=',
  '',
].join('\n');

// Sets one KEY=value line (an empty value comments it out), leaving comments
// and other keys untouched.
function setEnvValue(key, value) {
  let lines;
  try {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  } catch {
    lines = ENV_TEMPLATE.split('\n');
  }
  // Matches both "KEY=..." and the commented "# KEY=" placeholder.
  const re = new RegExp(`^\\s*#?\\s*(?:export\\s+)?${key}\\s*=`);
  const idx = lines.findIndex((l) => re.test(l));
  const clean = String(value || '').trim();
  const line = clean ? `${key}=${clean}` : `# ${key}=`;
  if (idx >= 0) {
    lines[idx] = line;
  } else if (clean) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(line);
  }
  writeFileAtomic(ENV_FILE, `${lines.join('\n').replace(/\n*$/, '')}\n`, 0o600);
}

function ensureEnvFile() {
  if (!fs.existsSync(ENV_FILE)) writeFileAtomic(ENV_FILE, ENV_TEMPLATE, 0o600);
  return ENV_FILE;
}

function apiKeys() {
  const file = readEnvFile();
  const keys = {};
  for (const name of API_KEY_NAMES) keys[name] = (file[name] || process.env[name] || '').trim();
  return keys;
}

// Cloud Whisper and API-key summaries are experimental and off by default.
const cloudApisEnabled = (cfg) => !!(cfg.settings.experimental && cfg.settings.experimental.cloudApis);

function loadConfig() {
  const settings = readSettings();
  return {
    appRoot: APP_ROOT,
    home: HOME,
    settingsFile: SETTINGS_FILE,
    envFile: ENV_FILE,
    modelsDir: MODELS_DIR,
    whisperDir: WHISPER_DIR,
    settings,
    notesDir: path.resolve(expandHome(settings.notesDir || DEFAULT_SETTINGS.notesDir)),
    keys: apiKeys(),
  };
}

module.exports = {
  API_KEY_NAMES,
  APP_ROOT,
  DEFAULT_SETTINGS,
  ENV_FILE,
  HOME,
  MODELS_DIR,
  SETTINGS_FILE,
  WHISPER_DIR,
  cloudApisEnabled,
  deepMerge,
  ensureEnvFile,
  expandHome,
  loadConfig,
  parseDotenv,
  readEnvFile,
  readSettings,
  setEnvValue,
  updateSettings,
  writeFileAtomic,
};
