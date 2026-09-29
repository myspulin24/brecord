// BRecord: menu bar (macOS) / tray (Windows) meeting recorder with a main window.
'use strict';
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
} = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./core/config');
const cli = require('./core/cli-tools');
const editor = require('./core/editor');
const { findUnfinished, processRecording, resummarizeNote } = require('./core/pipeline');
const notes = require('./core/notes');
const { fixPath, killAll } = require('./core/proc');
const setup = require('./core/setup');
const { PROVIDERS, ollamaModels, resolvePlan, testProvider } = require('./core/summarize');
const { describePlan, localWhisper, modelPath } = require('./core/transcribe');
const { WavWriter } = require('./core/wav');
const winLoopback = require('./core/win-loopback');
const { RELEASES_URL, createUpdater } = require('./updater');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const APP_ID = 'io.github.myspulin24.brecord'; // = build.appId (Windows notifications need them to match)
const ASSETS = path.join(__dirname, '..', 'assets');
const SHORTCUT = 'CommandOrControl+Alt+R';
const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(a.indexOf('=') + 1) : null;
};
const SMOKE_SECONDS = Number(argValue('smoke-test')) || 0;
// Development: render the UI off-screen into PNGs and exit.
const SHOT_DIR = argValue('screenshot');
const START_HIDDEN = process.argv.includes('--hidden');

const PRIVACY_URL = {
  microphone: IS_MAC ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' : 'ms-settings:privacy-microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

app.setName('BRecord');

function logError(kind, err) {
  const line = `${new Date().toISOString()} ${kind}: ${(err && err.stack) || err}\n`;
  console.error(line);
  try {
    fs.mkdirSync(config.HOME, { recursive: true });
    fs.appendFileSync(path.join(config.HOME, 'brecord.log'), line);
  } catch {
    // nowhere to log
  }
}
// Plain log lines (updater progress etc.); the file is capped at ~1 MB.
function logLine(tag, message) {
  try {
    fs.mkdirSync(config.HOME, { recursive: true });
    const fd = fs.openSync(path.join(config.HOME, 'brecord.log'), 'a+');
    try {
      // Over 1 MB: keep only the newest 256 kB.
      const { size } = fs.fstatSync(fd);
      if (size > 1024 * 1024) {
        const keep = Buffer.alloc(256 * 1024);
        const n = fs.readSync(fd, keep, 0, keep.length, size - keep.length);
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, keep.subarray(0, n), 0, n, 0);
      }
      fs.writeSync(fd, `${new Date().toISOString()} ${tag}: ${message}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // nowhere to log
  }
}
process.on('uncaughtException', (err) => logError('uncaughtException', err));
process.on('unhandledRejection', (err) => logError('unhandledRejection', err));

// --- Chromium switches (must run before 'ready') ---------------------------
if (process.platform === 'linux') {
  // System audio comes from the PulseAudio / PipeWire monitor of the default sink.
  app.commandLine.appendSwitch('enable-features', 'PulseaudioLoopbackForScreenShare');
}
if (IS_MAC) {
  // Electron 39+ captures system audio through Core Audio taps by default,
  // which silently yields a dead stream unless the app bundle declares
  // NSAudioCaptureUsageDescription (not the case when run via `npm start`).
  // Default to ScreenCaptureKit, i.e. the "Screen & System Audio Recording"
  // permission, which works from a terminal as well as packaged.
  if (config.readSettings().macSystemAudio === 'coreaudio-tap') {
    app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacCatapLoopbackAudioForScreenShare');
  } else {
    app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
    app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare');
  }
}

// --- State ------------------------------------------------------------------
let tray = null;
let recorderWin = null;
let mainWin = null;
let recorderReady = null;
let quitting = false;
let queueRunning = false;
let trayHintShown = false;
let updater = null;
const abortProcessing = new AbortController();
const keepNotifications = [];
const logins = new Map(); // cli id -> login handle

const state = {
  phase: 'idle', // idle | starting | recording | stopping
  recording: null,
  recWarnings: [],
  jobs: [],
  task: null, // e.g. "Stahuji model whisperu 42 %"
  lastNote: null,
  mics: [],
  outputs: [], // Windows output devices from the loopback helper
  info: { transcription: '…', summary: '…', summaryPlan: [] },
  update: { mode: 'dev', status: 'unsupported' },
  monitoring: false,
};

function log(...args) {
  console.log('[brecord]', ...args);
}

function notify(title, body, onClick) {
  if (SMOKE_SECONDS || SHOT_DIR || !Notification.isSupported()) return;
  if (!config.readSettings().notifications) return;
  const n = new Notification({ title, body, icon: path.join(ASSETS, 'appIcon.png') });
  if (onClick) n.on('click', onClick);
  n.show();
  keepNotifications.push(n); // keep a reference so the click handler survives GC
  if (keepNotifications.length > 5) keepNotifications.shift();
}

const firstLine = (text) => String(text || '').split('\n').filter(Boolean).slice(0, 2).join(' — ');
const pct = (p) => `${Math.round(p * 100)} %`;

// --- Theme --------------------------------------------------------------------
function themeColors() {
  return nativeTheme.shouldUseDarkColors ? { bg: '#0c0d12', fg: '#e8eaf0' } : { bg: '#f4f5f8', fg: '#1b1d24' };
}

function applyTheme() {
  nativeTheme.themeSource = config.readSettings().theme || 'system';
}

nativeTheme.on('updated', () => {
  const before = barTheme;
  detectBarTheme();
  if (before !== barTheme) updateTray();
  if (!mainWin || mainWin.isDestroyed()) return;
  const c = themeColors();
  mainWin.setBackgroundColor(c.bg);
  if (!IS_MAC) mainWin.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: 44 });
});

// --- Tray ---------------------------------------------------------------------
// The BR tray mark is drawn in white or near-black depending on the bar
// behind it. That's the system's taskbar / menu bar setting, independent of
// the theme chosen inside BRecord.
let barTheme = 'dark';
function detectBarTheme() {
  try {
    if (IS_WIN) {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      barTheme = /SystemUsesLightTheme\s+REG_DWORD\s+0x1\b/.test(out) ? 'light' : 'dark';
    } else if (IS_MAC) {
      barTheme = systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark' ? 'dark' : 'light';
    } else {
      barTheme = 'dark';
    }
  } catch {
    barTheme = 'dark'; // key missing on older Windows: dark taskbar
  }
}

// kind: idle | rec | rec-dim (second blink frame) | busy
function trayImage(kind) {
  return nativeImage.createFromPath(path.join(ASSETS, 'tray', `${barTheme}-${kind}.png`));
}

let blinkTimer = null;
let blinkOn = true;
function syncTrayBlink() {
  const recording = state.phase === 'recording';
  if (recording && !blinkTimer) {
    blinkOn = true;
    blinkTimer = setInterval(() => {
      blinkOn = !blinkOn;
      if (tray && state.phase === 'recording') tray.setImage(trayImage(blinkOn ? 'rec' : 'rec-dim'));
    }, 800);
  } else if (!recording && blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
}

function elapsed() {
  if (!state.recording) return '';
  const s = Math.floor((Date.now() - state.recording.startedAt.getTime()) / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(hh ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function jobView(job) {
  const name = path.basename(job.file).replace(/\.(wav|md|mp3|m4a|flac|ogg)$/i, '');
  const s = job.status || {};
  let text = 'Ve frontě';
  if (s.stage === 'transcribing') text = `Přepisuji${s.progress ? ` ${pct(s.progress)}` : '…'}`;
  else if (s.stage === 'summarizing') text = s.text ? s.text.charAt(0).toUpperCase() + s.text.slice(1) : 'Připravuji shrnutí…';
  return { id: job.file, name, type: job.type, stage: s.stage || 'queued', progress: s.progress || 0, text };
}

function buildMenu() {
  const items = [];
  const rec = state.phase === 'recording' || state.phase === 'stopping';
  if (rec && state.recording) {
    const t = state.recording.startedAt;
    items.push({ label: `● Nahrávám od ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`, enabled: false });
  }
  items.push(
    rec
      ? { label: state.phase === 'stopping' ? 'Zastavuji…' : 'Zastavit nahrávání', enabled: state.phase === 'recording', accelerator: config.readSettings().globalShortcut ? SHORTCUT : undefined, click: () => stopRecording() }
      : { label: state.phase === 'starting' ? 'Spouštím…' : 'Spustit nahrávání', enabled: state.phase === 'idle', accelerator: config.readSettings().globalShortcut ? SHORTCUT : undefined, click: () => startRecording() },
  );
  for (const w of state.recWarnings) items.push({ label: `⚠ ${w.text}`, enabled: !!w.url, click: () => w.url && shell.openExternal(w.url) });
  items.push({ type: 'separator' });
  for (const job of state.jobs) {
    const v = jobView(job);
    items.push({ label: `${v.name} — ${v.text.toLowerCase()}`, enabled: false });
  }
  if (state.task) items.push({ label: state.task, enabled: false });
  const up = state.update;
  if (up.status === 'ready') {
    items.push({ label: `Restartovat a nainstalovat BRecord ${up.version}`, enabled: state.phase === 'idle', click: () => installUpdate() });
  } else if (up.status === 'available' && up.mode === 'manual') {
    items.push({ label: `Stáhnout BRecord ${up.version}…`, click: () => shell.openExternal(up.releaseUrl) });
  }
  items.push({ label: 'Otevřít BRecord', click: () => showMain('home') });
  items.push({ label: 'Otevřít poslední poznámku', enabled: !!state.lastNote, click: () => state.lastNote && openNoteFile(state.lastNote) });
  items.push({ label: 'Otevřít složku s poznámkami', click: openNotesFolder });
  items.push({ type: 'separator' });
  const settings = config.readSettings();
  const lockDevices = state.phase !== 'idle'; // devices apply from the next recording
  items.push({
    label: 'Vstup (mikrofon)',
    enabled: !lockDevices,
    submenu: [
      { label: 'Výchozí mikrofon systému', type: 'radio', checked: !settings.micDeviceId, click: () => setDevice('micDeviceId', '') },
      ...state.mics.map((m, i) => ({ label: m.label || `Mikrofon ${i + 1}`, type: 'radio', checked: resolveMicId(settings) === m.deviceId, click: () => setDevice('micDeviceId', m.deviceId) })),
    ],
  });
  items.push({
    label: 'Výstup (systémový zvuk)',
    enabled: !lockDevices,
    submenu: outputChoices().map((o) => ({ label: o.label, type: 'radio', checked: (settings.outputDeviceId || '') === o.value, click: () => setDevice('outputDeviceId', o.value) })),
  });
  items.push({ label: 'Zpracovat zvukový soubor…', click: pickAndProcess });
  items.push({ label: 'Znovu shrnout poznámku…', click: () => pickAndResummarize() });
  items.push({ type: 'separator' });
  items.push({ label: `Přepis: ${state.info.transcription}`, enabled: false });
  items.push({ label: `Shrnutí: ${state.info.summary}`, enabled: false });
  items.push({ label: 'Nastavení…', accelerator: 'CommandOrControl+,', click: () => showMain('ai') });
  items.push({ type: 'separator' });
  items.push({ label: 'Ukončit BRecord', accelerator: 'CommandOrControl+Q', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function publicState() {
  return {
    phase: state.phase,
    startedAt: state.recording ? state.recording.startedAt.getTime() : null,
    jobs: state.jobs.map(jobView),
    task: state.task,
    info: state.info,
    mics: state.mics,
    outputs: outputChoices(),
    warnings: state.recWarnings.map((w) => ({ text: w.text, url: w.url || null })),
    lastNote: state.lastNote,
    monitoring: state.monitoring,
    update: state.update,
  };
}

function sendToUi(channel, data) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data);
}

function updateTray() {
  if (tray) {
    const busy = state.jobs.length || state.task;
    syncTrayBlink();
    tray.setImage(trayImage(state.phase === 'recording' ? (blinkOn ? 'rec' : 'rec-dim') : busy ? 'busy' : 'idle'));
    tray.setContextMenu(buildMenu());
    const status = state.phase === 'recording' ? `nahrávám ${elapsed()}` : state.jobs.length ? jobView(state.jobs[0]).text.toLowerCase() : state.task || 'připraveno';
    tray.setToolTip(`BRecord — ${status}`);
    if (IS_MAC) tray.setTitle(state.phase === 'recording' ? ` ${elapsed()}` : '');
  }
  sendToUi('state', publicState());
}

let trayTimer = null;
function updateTraySoon() {
  if (trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    updateTray();
  }, 400);
}

async function refreshInfo() {
  const cfg = config.loadConfig();
  state.info.transcription = describePlan(cfg);
  try {
    const plan = await resolvePlan(cfg);
    state.info.summaryPlan = plan.map((id) => PROVIDERS[id].label);
    state.info.summary = plan.length ? state.info.summaryPlan.join(' → ') : cfg.settings.summary.provider === 'none' ? 'vypnuto' : 'není k dispozici';
  } catch (err) {
    state.info.summary = `chyba: ${err.message}`;
  }
  updateTray();
}

// --- Main window --------------------------------------------------------------
function createMainWindow({ show }) {
  const c = themeColors();
  mainWin = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 940,
    minHeight: 660,
    title: 'BRecord',
    show: false,
    backgroundColor: c.bg,
    icon: path.join(ASSETS, 'appIcon.png'),
    titleBarStyle: 'hidden',
    ...(IS_MAC ? { trafficLightPosition: { x: 20, y: 18 } } : { titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload-app.js'),
      sandbox: true,
      contextIsolation: true,
      offscreen: !!SHOT_DIR, // dev screenshots: render without showing a window
    },
  });
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (show) revealMain();
  });
  mainWin.on('close', (e) => {
    if (quitting || SHOT_DIR) return;
    e.preventDefault();
    mainWin.hide();
    stopMonitor();
    if (IS_MAC && app.dock) app.dock.hide();
    if (!trayHintShown && !config.readSettings().trayHintShown) {
      trayHintShown = true;
      config.updateSettings({ trayHintShown: true });
      notify('BRecord běží dál', IS_MAC ? 'Najdete ho v řádku nabídek nahoře.' : 'Najdete ho v oznamovací oblasti vpravo dole.');
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

function revealMain() {
  if (!alive(mainWin)) createMainWindow({ show: false });
  if (IS_MAC && app.dock) app.dock.show();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  if (IS_MAC) app.focus({ steal: true });
  if (updater) updater.checkIfStale();
}

function showMain(page) {
  revealMain();
  if (page) {
    const go = () => sendToUi('navigate', page);
    if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', go);
    else go();
  }
}

// --- Recorder window (hidden; owns getUserMedia / getDisplayMedia) ---------
let callSeq = 0;
const pendingCalls = new Map();

function createRecorderWindow() {
  recorderWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: {
      preload: path.join(__dirname, 'preload-recorder.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  recorderReady = new Promise((resolve) => recorderWin.webContents.once('did-finish-load', resolve));
  recorderWin.loadFile(path.join(__dirname, 'recorder', 'recorder.html'));
  recorderWin.webContents.on('render-process-gone', (_e, details) => {
    log('recorder process gone:', details.reason);
    for (const [id, p] of pendingCalls) {
      clearTimeout(p.timer);
      p.reject(new Error('Nahrávací proces spadl'));
      pendingCalls.delete(id);
    }
    const wasRecording = state.phase === 'recording';
    state.monitoring = false;
    recorderWin.destroy();
    createRecorderWindow();
    if (wasRecording) {
      notify('Nahrávání přerušeno', 'Nahrávací proces spadl. To, co se stihlo nahrát, se zpracuje.');
      finishRecording();
    }
  });
}

async function recorderCall(cmd, args = {}, timeoutMs = 30000) {
  await recorderReady;
  return new Promise((resolve, reject) => {
    const id = ++callSeq;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Nahrávací proces neodpověděl („${cmd}“)`));
    }, timeoutMs);
    pendingCalls.set(id, { resolve, reject, timer });
    if (!alive(recorderWin)) {
      clearTimeout(timer);
      pendingCalls.delete(id);
      reject(new Error('Nahrávací proces neběží'));
      return;
    }
    recorderWin.webContents.send('recorder:command', { id, cmd, args });
  });
}

const alive = (win) => !!win && !win.isDestroyed();
const fromRecorder = (e) => alive(recorderWin) && e.sender === recorderWin.webContents;

ipcMain.on('recorder:reply', (e, { id, result, error }) => {
  if (!fromRecorder(e)) return;
  const p = pendingCalls.get(id);
  if (!p) return;
  pendingCalls.delete(id);
  clearTimeout(p.timer);
  if (error) p.reject(new Error(error));
  else p.resolve(result);
});

ipcMain.on('recorder:chunk', (e, { pcm, micPeak, sysPeak }) => {
  const rec = state.recording;
  if (!fromRecorder(e) || !rec) return;
  let buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (rec.native) {
    buf = Buffer.from(buf); // IPC buffers may be shared; copy before writing into it
    rec.sysPeak = Math.max(rec.sysPeak, rec.native.queue.fillRight(buf));
  } else {
    rec.sysPeak = Math.max(rec.sysPeak, sysPeak || 0);
  }
  rec.writer.write(buf);
  rec.micPeak = Math.max(rec.micPeak, micPeak || 0);
});

ipcMain.on('recorder:event', (e, event) => {
  if (!fromRecorder(e)) return;
  if (event.type === 'level') {
    if (!alive(mainWin) || !mainWin.isVisible()) return;
    let sys = event.sys;
    const native = state.recording && state.recording.native;
    if (native) {
      sys = native.level;
      native.level = 0;
    }
    sendToUi('levels', { mic: event.mic, sys, monitor: !!event.monitor });
  } else if (event.type === 'devices') {
    state.mics = event.devices || [];
    updateTray();
    refreshOutputs();
  } else if (event.type === 'warning' && state.phase === 'recording') {
    state.recWarnings.push({ text: event.message });
    notify('BRecord', event.message);
    updateTray();
  }
});

async function refreshOutputs() {
  if (!IS_WIN) return;
  try {
    state.outputs = await winLoopback.listOutputs();
  } catch (err) {
    log('output devices:', err.message);
    state.outputs = [];
  }
  updateTray();
}

// Options for the system-audio ("Ostatní") source, shared by tray and UI.
function outputChoices() {
  const choices = [];
  if (IS_WIN) {
    const def = state.outputs.find((o) => o.default);
    const comm = state.outputs.find((o) => o.communications);
    choices.push({ value: '', label: 'Výchozí výstup', detail: def ? def.name : 'Podle nastavení Windows', kind: 'default' });
    if (state.outputs.length) choices.push({ value: 'communications', label: 'Komunikační zařízení', detail: comm ? `${comm.name} · používá Teams a Zoom` : 'Používá Teams a Zoom', kind: 'communications' });
    for (const o of state.outputs) choices.push({ value: o.id, label: o.name || o.id, detail: [o.default && 'výchozí', o.communications && 'komunikační'].filter(Boolean).join(' · '), kind: 'device' });
  } else {
    choices.push({ value: '', label: 'Veškerý zvuk počítače', detail: 'Bez ohledu na výstupní zařízení', kind: 'default' });
  }
  choices.push({ value: 'none', label: 'Nenahrávat', detail: 'Jen mikrofon, např. osobní schůzka', kind: 'none' });
  const current = config.readSettings().outputDeviceId || '';
  if (!choices.some((c) => c.value === current)) choices.splice(choices.length - 1, 0, { value: current, label: 'Odpojené zařízení', detail: 'Připojte ho, nebo vyberte jiné', kind: 'device' });
  return choices;
}

function setupMediaHandlers() {
  // getDisplayMedia() in the recorder resolves here: first screen + system audio loopback.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => (sources.length ? callback({ video: sources[0], audio: 'loopback' }) : callback({})))
      .catch((err) => {
        log('getSources failed:', err.message);
        callback({});
      });
  });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(alive(recorderWin) && wc === recorderWin.webContents && ['media', 'display-capture'].includes(permission));
  });
}

// --- Permissions --------------------------------------------------------------
function permissionStatus() {
  const get = (type) => {
    try {
      return systemPreferences.getMediaAccessStatus(type);
    } catch {
      return 'unknown';
    }
  };
  return {
    microphone: IS_MAC || IS_WIN ? get('microphone') : 'granted',
    screen: IS_MAC ? get('screen') : 'granted',
  };
}

// Asks for microphone access (macOS shows the system prompt; on Windows the
// privacy switch decides) and verifies it by briefly opening the microphone.
async function requestMicrophone() {
  if (IS_MAC && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone');
  }
  const status = permissionStatus().microphone;
  if (status === 'denied' || status === 'restricted') {
    return { granted: false, status, settingsUrl: PRIVACY_URL.microphone };
  }
  const probe = await recorderCall('probeMic', { micDeviceId: resolveMicId() }, 60000);
  if (probe.ok) {
    state.mics = probe.devices || state.mics;
    updateTray();
    return { granted: true, status: 'granted', label: probe.label };
  }
  return { granted: false, status: probe.denied ? 'denied' : status, error: probe.error, settingsUrl: PRIVACY_URL.microphone };
}

// Saved microphone → a current device id. Ids are salted per Chromium profile
// and may change, so fall back to the saved label.
function resolveMicId(settings = config.readSettings()) {
  const id = settings.micDeviceId || '';
  if (!id || !state.mics.length || state.mics.some((m) => m.deviceId === id)) return id;
  const byLabel = settings.micDeviceLabel && state.mics.find((m) => m.label === settings.micDeviceLabel);
  if (byLabel) {
    config.updateSettings({ micDeviceId: byLabel.deviceId });
    return byLabel.deviceId;
  }
  return id;
}

// --- Microphone test ------------------------------------------------------------
async function startMonitor(micDeviceId) {
  if (state.phase !== 'idle') return { ok: true, recording: true };
  const r = await recorderCall('monitor', { micDeviceId: micDeviceId === undefined ? resolveMicId() : micDeviceId });
  state.monitoring = !!r.ok;
  return r;
}

function stopMonitor() {
  state.monitoring = false;
  if (alive(recorderWin)) recorderCall('monitorStop').catch(() => {});
}

// --- Recording ----------------------------------------------------------------
let blockerId = null;
let tickTimer = null;

async function startRecording() {
  if (state.phase !== 'idle') return;
  state.phase = 'starting';
  state.recWarnings = [];
  state.monitoring = false;
  updateTray();
  let writer = null;
  try {
    const cfg = config.loadConfig();
    if (IS_MAC && systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone');
    }
    fs.mkdirSync(cfg.notesDir, { recursive: true });
    const startedAt = new Date();
    const base = notes.allocateBaseName(cfg.notesDir, startedAt);
    const file = path.join(cfg.notesDir, `${base}.wav`);
    writer = new WavWriter(file, { channels: 2 });
    const rec = { writer, file, startedAt, micPeak: 0, sysPeak: 0, systemAudio: true, native: null };
    state.recording = rec;

    // System audio ("Ostatní"): on Windows the WASAPI helper records the
    // chosen output (Chromium's screen-share loopback proved unreliable);
    // on macOS Chromium's ScreenCaptureKit loopback records everything.
    const output = cfg.settings.outputDeviceId || '';
    let systemAudio = output === 'none' ? 'none' : 'loopback';
    if (IS_WIN && output !== 'none') {
      try {
        const native = { queue: new winLoopback.PcmQueue(), handle: null, level: 0 };
        native.handle = await winLoopback.startCapture(output || 'default', {
          onData: (d) => {
            native.queue.push(d);
            for (let i = 0; i + 1 < d.length; i += 64) {
              const v = Math.abs(d.readInt16LE(i)) / 32768;
              if (v > native.level) native.level = v;
            }
          },
          onExit: (code, message) => {
            if (state.recording === rec && state.phase === 'recording') {
              state.recWarnings.push({ text: `Systémový zvuk se přestal nahrávat: ${message || `kód ${code}`}` });
              notify('BRecord', 'Systémový zvuk se přestal nahrávat. Je výstupní zařízení stále připojené?');
              updateTray();
            }
          },
        });
        rec.native = native;
        systemAudio = 'none';
      } catch (err) {
        log('native loopback failed:', err.message);
        state.recWarnings.push({ text: `Vybraný výstup nejde nahrávat (${err.message}), zkouším výchozí výstup` });
      }
    }

    // Long timeout: the first run on macOS waits for permission prompts.
    const result = await recorderCall('start', { micDeviceId: resolveMicId(cfg.settings), systemAudio, externalSystem: !!rec.native }, 120000);
    if (!result.mic && !result.system && !rec.native) throw new Error(result.errors.map((e) => e.message).join('\n') || 'Nepodařilo se otevřít žádný zdroj zvuku');
    for (const err of result.errors) {
      const url = err.source === 'mic' ? PRIVACY_URL.microphone : IS_MAC ? PRIVACY_URL.screen : null;
      state.recWarnings.push({ text: err.message, url: err.soft ? null : url });
    }
    rec.systemAudio = result.system || !!rec.native;
    if (IS_MAC && result.system && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      state.recWarnings.push({ text: 'Systémový zvuk potřebuje oprávnění „Nahrávání obrazovky a systémového zvuku“ (po povolení BRecord restartujte)', url: PRIVACY_URL.screen });
    }
    if (state.recWarnings.length) notify('Nahrávám s omezeným zvukem', state.recWarnings.map((w) => w.text).join('\n'));
    state.phase = 'recording';
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    tickTimer = setInterval(() => {
      if (!tray || !state.recording) return;
      if (IS_MAC) tray.setTitle(` ${elapsed()}`);
      else tray.setToolTip(`BRecord — nahrávám ${elapsed()}`);
    }, 1000);
    log('recording to', file, JSON.stringify(result));
  } catch (err) {
    log('start failed:', err.message);
    state.phase = 'idle';
    if (state.recording && state.recording.native) state.recording.native.handle.stop();
    state.recording = null;
    if (writer) {
      await writer.close().catch(() => {});
      fs.rmSync(writer.file, { force: true });
    }
    recorderCall('stop', {}, 5000).catch(() => {});
    notify('Nahrávání se nepodařilo spustit', firstLine(err.message));
    sendToUi('toast', { kind: 'error', text: `Nahrávání se nepodařilo spustit: ${firstLine(err.message)}` });
  }
  updateTray();
}

async function stopRecording({ enqueue = true } = {}) {
  if (state.phase !== 'recording') return;
  state.phase = 'stopping';
  updateTray();
  try {
    await recorderCall('stop', {}, 15000);
  } catch (err) {
    log('stop:', err.message);
  }
  await finishRecording({ enqueue });
}

async function finishRecording({ enqueue = true } = {}) {
  const rec = state.recording;
  state.recording = null;
  state.phase = 'idle';
  if (blockerId !== null) powerSaveBlocker.stop(blockerId);
  blockerId = null;
  clearInterval(tickTimer);
  if (!rec) return updateTray();
  if (rec.native) rec.native.handle.stop();
  const { durationSec } = await rec.writer.close().catch((err) => {
    notify('Nahrávku se nepodařilo uložit', err.message);
    return { durationSec: 0 };
  });
  log(`recorded ${durationSec.toFixed(1)} s (mic peak ${rec.micPeak.toFixed(3)}, system peak ${rec.sysPeak.toFixed(3)})`);
  if (durationSec < 1) {
    fs.rmSync(rec.file, { force: true });
    notify('Nahrávka zahozena', 'Byla kratší než jedna sekunda.');
  } else if (enqueue) {
    const warnings = state.recWarnings.map((w) => w.text);
    enqueueJob({ type: 'process', file: rec.file, meta: { startedAt: rec.startedAt, warnings, systemAudio: rec.systemAudio } });
  }
  state.recWarnings = [];
  updateTray();
}

function toggleRecording() {
  if (state.phase === 'idle') startRecording();
  else if (state.phase === 'recording') stopRecording();
}

// --- Processing queue -----------------------------------------------------------
const smokeResults = [];

function enqueueJob(job) {
  if (state.jobs.some((j) => j.file === job.file)) return;
  state.jobs.push(job);
  updateTray();
  runQueue();
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  while (state.jobs.length && !quitting) {
    const job = state.jobs[0];
    const cfg = config.loadConfig();
    const opts = {
      cfg,
      meta: job.meta,
      signal: abortProcessing.signal,
      onStatus: (s) => {
        job.status = s;
        updateTraySoon();
      },
    };
    try {
      const r = job.type === 'resummarize' ? await resummarizeNote(job.file, opts) : await processRecording(job.file, opts);
      state.lastNote = r.noteFile;
      smokeResults.push({ ok: true, ...r, turns: undefined });
      const open = () => openNoteFile(r.noteFile);
      if (r.summaryError) notify('Přepis uložen, shrnutí se nepodařilo', firstLine(r.summaryError), open);
      else notify((r.summary && r.summary.notes.title) || 'Poznámky jsou hotové', path.basename(r.noteFile), open);
      if (cfg.settings.openNoteWhenDone && !SMOKE_SECONDS) open();
    } catch (err) {
      if (abortProcessing.signal.aborted) break;
      log('processing failed:', err.message);
      smokeResults.push({ ok: false, error: err.message });
      if (job.type === 'process') writeFailedNote(job, err);
      notify('Zpracování se nepodařilo', firstLine(err.message), openNotesFolder);
    }
    state.jobs.shift();
    updateTray();
    sendToUi('notes:changed');
  }
  queueRunning = false;
  refreshInfo();
  if (SMOKE_SECONDS && !state.jobs.length) finishSmokeTest();
}

// A note with the error keeps the recording from being retried on every launch.
function writeFailedNote(job, err) {
  const noteFile = job.file.replace(/\.[^.]+$/, '.md');
  if (fs.existsSync(noteFile)) return;
  try {
    notes.writeNote(noteFile, {
      startedAt: (job.meta && job.meta.startedAt) || new Date(),
      durationSec: 0,
      audioFile: job.file,
      turns: [],
      transcriptError: err.message,
    });
    state.lastNote = noteFile;
  } catch (e) {
    log('could not write failure note:', e.message);
  }
}

// --- Actions ------------------------------------------------------------------
function openNoteFile(file) {
  return editor.openNote(file, { editor: config.readSettings().noteEditor, openPath: shell.openPath });
}

// Paths from the window must name a note in the notes folder, nothing else.
function uiNote(file) {
  const target = path.resolve(String(file || ''));
  const rel = path.relative(path.resolve(config.loadConfig().notesDir), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || !/\.md$/i.test(rel)) throw new Error('Tohle není poznámka ze složky s poznámkami');
  return target;
}

// The note's own recording, processed again: after fixing transcription.
function reprocessNote(file) {
  const noteFile = uiNote(file);
  const audio = ['.wav', '.m4a', '.mp3', '.flac', '.ogg'].map((ext) => noteFile.replace(/\.md$/i, ext)).find((p) => fs.existsSync(p));
  if (!audio) throw new Error('Nahrávka k této poznámce už ve složce není');
  enqueueJob({ type: 'process', file: audio });
  return true;
}

function openNotesFolder() {
  const dir = config.loadConfig().notesDir;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

function setDevice(key, value) {
  const patch = { [key]: value };
  if (key === 'micDeviceId') patch.micDeviceLabel = (state.mics.find((m) => m.deviceId === value) || {}).label || '';
  config.updateSettings(patch);
  updateTray();
  sendToUi('settings', config.readSettings());
}

async function pickAndProcess() {
  const r = await dialog.showOpenDialog(mainWin && mainWin.isVisible() ? mainWin : undefined, {
    title: 'Zpracovat zvukový soubor',
    defaultPath: config.loadConfig().notesDir,
    properties: ['openFile'],
    filters: [{ name: 'Zvuk', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg'] }],
  });
  if (r.canceled || !r.filePaths[0]) return false;
  const file = r.filePaths[0];
  const noteFile = file.replace(/\.[^.]+$/, '.md');
  if (fs.existsSync(noteFile)) {
    const choice = await dialog.showMessageBox({ type: 'question', buttons: ['Nahradit', 'Zrušit'], defaultId: 0, cancelId: 1, message: `${path.basename(noteFile)} už existuje.`, detail: 'Nové zpracování ji přepíše.' });
    if (choice.response !== 0) return false;
    fs.rmSync(noteFile, { force: true });
  }
  enqueueJob({ type: 'process', file });
  return true;
}

async function pickAndResummarize(file) {
  if (!file) {
    const r = await dialog.showOpenDialog(mainWin && mainWin.isVisible() ? mainWin : undefined, {
      title: 'Znovu shrnout poznámku',
      defaultPath: config.loadConfig().notesDir,
      properties: ['openFile'],
      filters: [{ name: 'Poznámka BRecord', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePaths[0]) return false;
    file = r.filePaths[0];
  }
  enqueueJob({ type: 'resummarize', file });
  return true;
}

// --- Updates ------------------------------------------------------------------
function onUpdate(next) {
  const prev = state.update;
  state.update = next;
  // An open window offers the update itself; from the tray it takes a
  // notification, and clicking it opens the window with the offer.
  const windowShown = alive(mainWin) && mainWin.isVisible() && !mainWin.isMinimized();
  if (next.status !== prev.status && !windowShown) {
    if (next.status === 'ready') {
      notify(`BRecord ${next.version} je připravený k instalaci`, 'Klikněte a nainstalujte ho. Jinak se nainstaluje sám při ukončení.', () => showMain());
    } else if (next.status === 'available' && next.mode === 'manual') {
      notify(`Je k dispozici BRecord ${next.version}`, 'Klikněte pro podrobnosti a stažení.', () => showMain());
    }
  }
  updateTray();
}

// Restarts into the downloaded version, but never in the middle of a meeting.
function installUpdate() {
  if (state.phase !== 'idle') return { ok: false, reason: 'Aktualizace se nainstaluje po skončení nahrávání.' };
  if (!updater || updater.state().status !== 'ready') return { ok: false, reason: 'Aktualizace ještě není stažená.' };
  quitting = true;
  abortProcessing.abort(); // interrupted jobs resume after the restart
  stopMonitor();
  killAll();
  updater.install();
  return { ok: true };
}

function applyShortcut() {
  if (!app.isReady()) return;
  globalShortcut.unregister(SHORTCUT);
  if (!config.readSettings().globalShortcut) return true;
  const ok = globalShortcut.register(SHORTCUT, toggleRecording);
  if (!ok) sendToUi('toast', { kind: 'error', text: 'Zkratku Ctrl+Alt+R už používá jiná aplikace.' });
  return ok;
}

// --- UI IPC -------------------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!alive(mainWin) || e.sender !== mainWin.webContents) throw new Error('Nepovoleno');
    return fn(...args);
  });
}

function registerUiIpc() {
  handle('app:state', () => {
    const cfg = config.loadConfig();
    return {
      settings: cfg.settings,
      defaults: config.DEFAULT_SETTINGS,
      keys: Object.fromEntries(config.API_KEY_NAMES.map((k) => [k, !!cfg.keys[k]])),
      paths: { settings: cfg.settingsFile, env: cfg.envFile, home: cfg.home, notes: cfg.notesDir },
      platform: process.platform,
      packaged: app.isPackaged,
      version: app.getVersion(),
      openAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
      whisperModels: setup.MODELS,
      clis: Object.fromEntries(
        Object.entries(cli.CLIS).map(([id, c]) => [
          id,
          { label: c.label, install: c.install, docs: c.docs, loginModes: Object.fromEntries(Object.entries(c.loginModes).map(([m, v]) => [m, { label: v.label, needsSecret: !!v.needsSecret }])) },
        ]),
      ),
      permissions: permissionStatus(),
      releasesUrl: RELEASES_URL,
      copyright: '© 2026 Michal Jašek',
      state: publicState(),
      debug: !!SHOT_DIR,
    };
  });

  handle('settings:save', (patch) => {
    const next = config.updateSettings(patch);
    if (patch.summary || patch.transcription || patch.experimental) cli.invalidate();
    if ('theme' in patch) applyTheme();
    if ('globalShortcut' in patch) applyShortcut();
    refreshInfo();
    return next;
  });

  handle('status:clis', async (fresh) => {
    const cfg = config.loadConfig();
    const [claude, codex] = await Promise.all([cli.cliStatus('claude', cfg, { fresh }), cli.cliStatus('codex', cfg, { fresh })]);
    return { claude, codex };
  });

  handle('status:local', async () => {
    const cfg = config.loadConfig();
    let ollama = { reachable: false, models: [] };
    try {
      ollama = { reachable: true, models: await ollamaModels(cfg) };
    } catch {
      // not running
    }
    const plan = await resolvePlan(cfg).catch(() => []);
    const downloaded = Object.keys(setup.MODELS).filter((name) => fs.existsSync(modelPath(name)));
    return { whisper: localWhisper(cfg), transcription: describePlan(cfg), ollama, downloaded, summaryPlan: plan.map((id) => PROVIDERS[id].label) };
  });

  handle('cli:login', (id, mode, secret) => {
    if (logins.has(id)) logins.get(id).cancel();
    const loginHandle = cli.startLogin(id, config.loadConfig(), mode, {
      secret,
      onOutput: (text) => sendToUi('cli:login-output', { id, text }),
      onExit: (code, err) => {
        logins.delete(id);
        sendToUi('cli:login-exit', { id, code, error: err && err.message });
        refreshInfo();
      },
    });
    logins.set(id, loginHandle);
    return true;
  });
  handle('cli:login-input', (id, text) => logins.get(id) && logins.get(id).write(text));
  handle('cli:login-cancel', (id) => logins.get(id) && logins.get(id).cancel());
  handle('cli:logout', async (id) => {
    await cli.logout(id, config.loadConfig());
    refreshInfo();
    return true;
  });
  handle('cli:terminal', (id, mode) => cli.openLoginInTerminal(id, config.loadConfig(), mode));

  handle('provider:test', async (id) => {
    try {
      const r = await testProvider(id, config.loadConfig());
      return { ok: true, ms: r.ms, model: r.model, notes: r.notes };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  handle('keys:set', (name, value) => {
    if (!config.API_KEY_NAMES.includes(name)) throw new Error('Neznámý klíč');
    config.setEnvValue(name, value);
    refreshInfo();
    return true;
  });

  handle('dialog:folder', async (current) => {
    const r = await dialog.showOpenDialog(mainWin, { defaultPath: config.expandHome(current || ''), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (current) => {
    const r = await dialog.showOpenDialog(mainWin, { defaultPath: config.expandHome(current || ''), properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('whisper:install', async ({ what, model, variant }) => {
    const progress = (label) => (received, total) => {
      state.task = `${label}${total ? ` ${pct(received / total)}` : ''}`;
      sendToUi('setup:progress', { what, received, total, label });
      updateTraySoon();
    };
    try {
      if (what === 'binary') {
        await setup.installWhisperBinary({ variant, force: true, onProgress: progress('Stahuji whisper.cpp'), onLog: (line) => sendToUi('setup:progress', { what, log: line }) });
      } else {
        await setup.installModel(model, { onProgress: progress(`Stahuji model ${model}`) });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      state.task = null;
      refreshInfo();
    }
  });

  handle('devices:refresh', async () => {
    try {
      state.mics = await recorderCall('devices');
    } catch {
      // keep the previous list
    }
    await refreshOutputs();
    return publicState();
  });

  handle('recording:toggle', () => toggleRecording());
  handle('monitor:start', (deviceId) => startMonitor(deviceId));
  handle('monitor:stop', () => stopMonitor());
  handle('permissions:status', () => permissionStatus());
  handle('permissions:request-mic', () => requestMicrophone());

  handle('notes:list', (limit) => notes.listNotes(config.loadConfig().notesDir, { limit: limit || 200 }));
  handle('notes:open', (file) => openNoteFile(uiNote(file)));
  handle('notes:reveal', (file) => shell.showItemInFolder(uiNote(file)));
  handle('notes:editor', () => ({ pilcrow: editor.findPilcrow(), download: editor.PILCROW_RELEASES }));
  handle('notes:tasks', (file) => notes.readTasks(uiNote(file)));
  handle('notes:task', (file, op) => {
    const { type, line, raw, done, owner, task, due } = op || {};
    return notes.updateTask(uiNote(file), { type: String(type), line: Number(line), raw: String(raw || ''), done: !!done, owner, task, due });
  });
  handle('notes:reprocess', (file) => reprocessNote(file));
  handle('notes:folder', () => openNotesFolder());
  handle('notes:process-file', () => pickAndProcess());
  handle('notes:resummarize', (file) => pickAndResummarize(file && uiNote(file)));

  handle('open:path', (p) => {
    const target = config.expandHome(p);
    if (target === config.ENV_FILE) config.ensureEnvFile();
    return shell.openPath(target);
  });
  handle('open:url', (url) => {
    if (/^(https?:|x-apple\.systempreferences:|ms-settings:)/.test(url)) return shell.openExternal(url);
    return false;
  });
  handle('app:login-item', (on) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
    return app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;
  });
  handle('app:quit', () => app.quit());
  handle('update:check', async () => {
    if (!updater) return state.update;
    try {
      return await updater.check({ manual: true });
    } catch (err) {
      return { ...updater.state(), status: 'error', error: err.message };
    }
  });
  handle('update:download', () => (updater ? updater.download() : state.update));
  handle('update:install', () => installUpdate());
  handle('update:open', (url) => shell.openExternal(typeof url === 'string' && url.startsWith(RELEASES_URL) ? url : `${RELEASES_URL}/latest`));
}

// --- Development: screenshots / smoke test -------------------------------------
async function captureUi() {
  const wc = mainWin.webContents;
  const errors = [];
  // Listen before the page finishes loading so start-up errors are caught too.
  wc.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') errors.push(`${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const scenes = (argValue('scenes') || 'onboarding-0,onboarding-1,home,home-mic,home-recording,home-processing,notes,notes-tasks,notes-issue,ai,transcription,audio,general,experimental,update-offer').split(',');
  const themes = (argValue('themes') || 'dark').split(',');
  await new Promise((r) => setTimeout(r, 1500));
  for (const theme of themes) {
    nativeTheme.themeSource = theme;
    for (const scene of scenes) {
      await wc.executeJavaScript(`window.__brecord && window.__brecord.scene(${JSON.stringify(scene)})`);
      await new Promise((r) => setTimeout(r, scene === 'ai' ? 6000 : 1400));
      const image = await wc.capturePage();
      fs.writeFileSync(path.join(SHOT_DIR, `${theme}-${scene}.png`), image.toPNG());
    }
  }
  console.log(`SCREENSHOTS ${SHOT_DIR} errors=${JSON.stringify(errors)}`);
  quitting = true;
  stopMonitor();
  // Non-zero exit when the UI logged errors: this doubles as the CI smoke test.
  app.exit(errors.length ? 2 : 0);
}

async function runSmokeTest() {
  log(`smoke test: recording for ${SMOKE_SECONDS} s`);
  await startRecording();
  if (state.phase !== 'recording') {
    console.log(JSON.stringify({ ok: false, error: 'recording did not start' }));
    app.exit(1);
    return;
  }
  setTimeout(() => stopRecording(), SMOKE_SECONDS * 1000);
}

function finishSmokeTest() {
  console.log(`SMOKE_RESULT ${JSON.stringify(smokeResults)}`);
  quitting = true;
  app.exit(smokeResults.every((r) => r.ok) ? 0 : 1);
}

// --- App lifecycle --------------------------------------------------------------
// Dev screenshots use their own profile so they never touch (or get blocked
// by) a BRecord the user is running.
if (SHOT_DIR) app.setPath('userData', path.join(app.getPath('temp'), 'brecord-screenshot-profile'));

if (!SHOT_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(async () => {
    fixPath();
    if (IS_WIN) app.setAppUserModelId(APP_ID);
    applyTheme();
    setupMediaHandlers();
    registerUiIpc();
    createRecorderWindow();
    const first = !config.readSettings().onboarded;
    if (first && config.readSettings().micDeviceId && !config.readSettings().micDeviceLabel) {
      // Settings migrated from the Minutes build: its device ids belong to another profile.
      config.updateSettings({ micDeviceId: '' });
    }

    if (SHOT_DIR) {
      recorderCall('devices').then((d) => (state.mics = d), () => {});
      await refreshOutputs();
      refreshInfo();
      createMainWindow({ show: false });
      return captureUi();
    }

    detectBarTheme();
    // Windows fires no event when only the taskbar colour changes; recheck now and then.
    if (IS_WIN) setInterval(() => {
      const before = barTheme;
      detectBarTheme();
      if (before !== barTheme) updateTray();
    }, 60000);
    tray = new Tray(trayImage('idle'));
    tray.setToolTip('BRecord');
    if (!IS_MAC) tray.on('click', () => showMain());
    createMainWindow({ show: !START_HIDDEN && !SMOKE_SECONDS });
    if (IS_MAC && app.dock && (START_HIDDEN || SMOKE_SECONDS)) app.dock.hide();
    updateTray();
    refreshInfo();
    applyShortcut();

    updater = createUpdater({
      app,
      log: logLine,
      isAutoDownload: () => config.readSettings().autoUpdate !== false,
      shouldAutoCheck: () => process.env.BRECORD_AUTO_UPDATE !== '0' && config.readSettings().updateChecks !== false,
      onChange: onUpdate,
    });
    state.update = updater.state();
    if (!SMOKE_SECONDS) updater.start();

    recorderCall('devices')
      .then((devices) => {
        state.mics = devices;
        resolveMicId();
        updateTray();
        sendToUi('settings', config.readSettings());
      })
      .catch(() => {});
    refreshOutputs();

    if (SMOKE_SECONDS) return runSmokeTest();

    const cfg = config.loadConfig();
    if (!first) {
      const unfinished = findUnfinished(cfg.notesDir);
      if (unfinished.length) {
        notify('BRecord', `Dokončuji ${unfinished.length === 1 ? 'přerušenou nahrávku' : `${unfinished.length} přerušené nahrávky`}.`);
        unfinished.forEach(enqueueJob);
      }
    }
  });

  app.on('window-all-closed', () => {
    // Tray app: keep running without windows.
  });

  app.on('activate', () => showMain());

  app.on('before-quit', (e) => {
    if (quitting) return;
    if (state.phase === 'recording' || state.phase === 'starting') {
      e.preventDefault();
      // Save the audio; it gets transcribed on the next launch.
      stopRecording({ enqueue: false }).finally(() => {
        quitting = true;
        app.quit();
      });
      return;
    }
    if (state.jobs.length) {
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['Ukončit', 'Zrušit'],
        defaultId: 1,
        cancelId: 1,
        message: 'BRecord ještě zpracovává nahrávku.',
        detail: 'Při příštím spuštění naváže tam, kde skončil.',
      });
      if (choice === 1) {
        e.preventDefault();
        return;
      }
    }
    quitting = true;
    abortProcessing.abort();
    for (const h of logins.values()) h.cancel();
    stopMonitor();
    killAll();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
