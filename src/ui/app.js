'use strict';

const api = window.brecord;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const IS_MAC = api.platform === 'darwin';

const store = {
  meta: null,
  settings: null,
  state: null,
  perms: { microphone: 'unknown', screen: 'unknown' },
  cli: {},
  local: null,
  notes: [],
  editor: null,
  voices: [],
  page: null,
  debug: false,
};

// ── Helpers ────────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const patchFor = (p, value) => p.split('.').reduceRight((acc, k) => ({ [k]: acc }), value);
const plural = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'Dnes';
  if (same(d, y)) return 'Včera';
  return `${d.getDate()}. ${d.getMonth() + 1}.${d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}
const fmtTime = (ts) => {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function save(path, value, { quiet = true } = {}) {
  store.settings = await api.save(patchFor(path, value));
  if (!quiet) toast('Uloženo');
  onSettingsChanged(path);
  return store.settings;
}

// ── Toasts ─────────────────────────────────────────────────────────────────
function toast(text, kind = 'ok') {
  const t = el('div', `toast ${kind}`);
  t.innerHTML = icon(kind === 'error' ? 'alert' : 'check', 16);
  t.append(el('span', '', text));
  $('#toasts').append(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 260);
  }, kind === 'error' ? 4200 : 2200);
}

// ── Segmented control ──────────────────────────────────────────────────────
function segmented(root, options, value, onChange) {
  root.replaceChildren();
  const thumb = el('span', 'seg-thumb no-anim');
  root.append(thumb);
  let current = value;
  const buttons = options.map((o) => {
    const b = el('button', 'seg-btn');
    b.type = 'button';
    b.dataset.value = o.value;
    if (o.icon) b.innerHTML = icon(o.icon, 15);
    b.append(el('span', '', o.label));
    b.addEventListener('click', () => {
      if (String(current) === String(o.value)) return;
      set(o.value);
      onChange(o.value);
    });
    root.append(b);
    return b;
  });
  function place() {
    const b = buttons.find((x) => x.dataset.value === String(current));
    thumb.style.opacity = b ? '1' : '0';
    if (!b) return;
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft}px)`;
  }
  function set(v) {
    current = v;
    for (const b of buttons) b.classList.toggle('active', b.dataset.value === String(v));
    place();
  }
  set(value);
  requestAnimationFrame(() => {
    place();
    requestAnimationFrame(() => thumb.classList.remove('no-anim'));
  });
  segmentedRegistry.add(place);
  return { set, place };
}
const segmentedRegistry = new Set();
window.addEventListener('resize', () => segmentedRegistry.forEach((p) => p()));

// ── Toggle ────────────────────────────────────────────────────────────────
function setToggle(btn, on) {
  btn.classList.toggle('on', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// ── Popovers ────────────────────────────────────────────────────────────
let openPop = null;

function openPopover(anchor, build, { width, align = 'start', onClose } = {}) {
  closePopover();
  const pop = el('div', 'popover');
  build(pop);
  $('#popover-layer').append(pop);
  const r = anchor.getBoundingClientRect();
  const w = Math.max(width || r.width, 260);
  pop.style.width = `${w}px`;
  const left = clamp(align === 'end' ? r.right - w : r.left, 12, window.innerWidth - w - 12);
  const h = pop.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 12 && r.top - 8 - h > 12) {
    top = r.top - 8 - h;
    pop.classList.add('above');
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  anchor.classList.add('open');
  requestAnimationFrame(() => pop.classList.add('open'));
  openPop = { pop, anchor, onClose };
  return pop;
}

function closePopover() {
  if (!openPop) return;
  const { pop, anchor, onClose } = openPop;
  openPop = null;
  anchor.classList.remove('open');
  pop.classList.remove('open');
  pop.classList.add('closing');
  setTimeout(() => pop.remove(), 170);
  if (onClose) onClose();
}

document.addEventListener('mousedown', (e) => {
  if (openPop && !openPop.pop.contains(e.target) && !openPop.anchor.contains(e.target)) closePopover();
});
window.addEventListener('blur', closePopover);
window.addEventListener('resize', closePopover);
document.addEventListener('keydown', (e) => {
  if (!openPop) return;
  const items = $$('.pop-item', openPop.pop);
  const idx = items.findIndex((i) => i.classList.contains('kbd'));
  if (e.key === 'Escape') {
    closePopover();
    e.preventDefault();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const next = clamp(idx + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1);
    items.forEach((i, n) => i.classList.toggle('kbd', n === next));
    if (items[next]) items[next].scrollIntoView({ block: 'nearest' });
    e.preventDefault();
  } else if (e.key === 'Enter' && idx >= 0) {
    items[idx].click();
    e.preventDefault();
  }
});

function listPopover(anchor, { header, items, value, onSelect, footer, width, top, onClose, align }) {
  return openPopover(
    anchor,
    (pop) => {
      if (header) {
        const h = el('div', 'pop-header');
        h.append(el('span', '', header));
        pop.append(h);
      }
      if (top) pop.append(top);
      const scroll = el('div', 'pop-scroll');
      let n = 0;
      for (const it of items) {
        if (it.sep) {
          scroll.append(el('div', 'pop-sep'));
          continue;
        }
        const b = el('button', `pop-item${String(it.value) === String(value) ? ' selected' : ''}`);
        b.type = 'button';
        b.style.setProperty('--i', n++);
        b.innerHTML = `<span class="check">${icon('check', 16)}</span>`;
        const text = el('span');
        text.append(el('div', 'pop-label', it.label));
        if (it.detail) text.append(el('div', 'pop-detail', it.detail));
        b.append(text, el('span', 'pop-side', it.side || ''));
        b.addEventListener('click', () => {
          closePopover();
          onSelect(it.value, it);
        });
        scroll.append(b);
      }
      pop.append(scroll);
      if (footer) {
        pop.append(el('div', 'pop-sep'));
        pop.append(footer);
      }
    },
    { width, onClose, align },
  );
}

// Custom select trigger bound to options.
function selectControl(btn, { options, get, set, header, width }) {
  const render = () => {
    const v = get();
    const opt = options().find((o) => String(o.value) === String(v));
    btn.innerHTML = '';
    btn.append(el('span', 'select-value', opt ? opt.label : v || '—'));
    btn.insertAdjacentHTML('beforeend', icon('chevronDown', 16));
  };
  btn.addEventListener('click', () => {
    if (btn.classList.contains('open')) return closePopover();
    listPopover(btn, { header, items: options(), value: get(), width: width || btn.offsetWidth, onSelect: async (v) => { await set(v); render(); } });
  });
  render();
  return { render };
}

// ── Live level meters ────────────────────────────────────────────────────
const levels = { mic: 0, sys: 0, micT: 0, sysT: 0, lastEvent: 0, histAt: 0, hist: { mic: new Float32Array(24), sys: new Float32Array(24) } };
const meters = new Map(); // canvas -> { source, ctx }
let rafId = 0;
let fakeTimer = null;
let idleColor = 'rgba(255,255,255,0.12)';

const GRADIENTS = { mic: ['#a595ff', '#5a7bff'], sys: ['#48dcc9', '#2386c9'] };

function computeColors() {
  idleColor = matchMedia('(prefers-color-scheme: light)').matches ? 'rgba(20,24,40,0.14)' : 'rgba(255,255,255,0.13)';
  drawMeters(true);
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', computeColors);

function registerMeter(canvas, source) {
  if (!canvas) return;
  meters.set(canvas, { source, ctx: canvas.getContext('2d') });
  drawMeter(canvas, meters.get(canvas));
}

function drawMeter(canvas, m) {
  const { ctx } = m;
  const w = canvas.width;
  const h = canvas.height;
  const cw = canvas.clientWidth;
  const scale = cw ? w / cw : 2;
  const barW = 3 * scale;
  const gap = 2 * scale;
  const count = Math.max(4, Math.floor((w + gap) / (barW + gap)));
  const hist = levels.hist[m.source];
  ctx.clearRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, GRADIENTS[m.source][1]);
  grad.addColorStop(1, GRADIENTS[m.source][0]);
  const offset = w - (count * (barW + gap) - gap);
  for (let i = 0; i < count; i++) {
    const v = hist[hist.length - count + i] || 0;
    const bh = Math.max(barW, v * h);
    const x = offset + i * (barW + gap);
    const y = (h - bh) / 2;
    ctx.fillStyle = v > 0.02 ? grad : idleColor;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, bh, barW / 2);
    ctx.fill();
  }
}

function drawMeters(force) {
  for (const [canvas, m] of meters) {
    if (!canvas.isConnected) {
      meters.delete(canvas);
      continue;
    }
    if (force || canvas.offsetParent !== null) drawMeter(canvas, m);
  }
}

function levelLoop(t) {
  rafId = 0;
  for (const k of ['mic', 'sys']) {
    const target = levels[`${k}T`];
    levels[k] += (target > levels[k] ? 0.55 : 0.14) * (target - levels[k]);
    levels[`${k}T`] *= 0.88; // targets decay between 20 Hz level events
  }
  if (t - levels.histAt > 55) {
    levels.histAt = t;
    for (const k of ['mic', 'sys']) {
      const h = levels.hist[k];
      h.copyWithin(0, 1);
      h[h.length - 1] = Math.min(1, Math.sqrt(levels[k]) * 1.3);
    }
  }
  drawMeters(false);
  const recording = store.state && store.state.phase === 'recording';
  const halo = $('#rec-halo');
  if (halo) halo.style.setProperty('--halo', recording ? (1 + Math.min(1, Math.sqrt(levels.mic) * 1.2) * 0.55).toFixed(3) : '1');
  const alive = t - levels.lastEvent < 1200 || levels.mic > 0.004 || levels.sys > 0.004 || levels.hist.mic.some((v) => v > 0.01) || levels.hist.sys.some((v) => v > 0.01);
  if (alive) rafId = requestAnimationFrame(levelLoop);
}

function ensureLevelLoop() {
  if (!rafId) rafId = requestAnimationFrame(levelLoop);
}

api.on('levels', (l) => {
  levels.micT = Math.max(levels.micT, l.mic || 0);
  levels.sysT = Math.max(levels.sysT, l.sys || 0);
  levels.lastEvent = performance.now();
  ensureLevelLoop();
});

// Microphone test runs while a level meter for the mic is on screen.
const monitorOwners = new Set();
async function monitor(owner, on) {
  if (on) monitorOwners.add(owner);
  else monitorOwners.delete(owner);
  if (monitorOwners.size) {
    const r = await api.monitorStart(store.settings.micDeviceId);
    if (r && r.ok === false && r.denied) refreshPermissions();
  } else {
    api.monitorStop();
  }
}

// ── Navigation ──────────────────────────────────────────────────────────
function go(page) {
  if (!$(`.page[data-page="${page}"]`)) page = 'home';
  const prev = store.page;
  if (prev === page) return;
  store.page = page;
  closePopover();
  for (const p of $$('.page')) p.classList.toggle('active', p.dataset.page === page);
  const pg = $(`.page[data-page="${page}"]`);
  pg.classList.remove('enter');
  void pg.offsetWidth;
  pg.classList.add('enter');
  pg.scrollTop = 0;
  $('#page-title').textContent = pg.dataset.title;
  $('#page-subtitle').textContent = pg.dataset.subtitle || '';
  const title = $('.topbar-title');
  title.classList.remove('swap');
  void title.offsetWidth;
  title.classList.add('swap');
  const item = $(`.nav-item[data-page="${page}"]`);
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n === item));
  const ind = $('#nav-indicator');
  if (item) {
    ind.style.opacity = '1';
    ind.style.setProperty('--y', `${item.offsetTop}px`);
  }
  renderTopbarActions(page);
  if (prev === 'audio') monitor('audio', false);
  if (page === 'audio') {
    monitor('audio', true);
    refreshPermissions();
    api.refreshDevices().then(applyState);
  }
  if (page === 'notes' || page === 'home') refreshNotes();
  if (page === 'general') refreshEditor();
  if (page === 'transcription') refreshVoices();
  if (page === 'ai') refreshCli(true);
  if (page === 'transcription' || page === 'ai') refreshLocal();
  requestAnimationFrame(() => segmentedRegistry.forEach((p) => p()));
  renderMiniRec();
}

function renderTopbarActions(page) {
  const host = $('#topbar-actions');
  host.replaceChildren();
  const add = (label, iconName, onClick, cls = 'btn btn-ghost btn-sm') => {
    const b = el('button', cls);
    b.innerHTML = icon(iconName, 16);
    b.append(el('span', '', label));
    b.addEventListener('click', onClick);
    host.append(b);
    return b;
  };
  if (page === 'home' || page === 'notes') add('Zpracovat soubor', 'fileAudio', () => api.processFile());
  if (page === 'notes') add('Otevřít složku', 'folder', () => api.openNotesFolder());
  if (page === 'ai') {
    const b = add('Obnovit stav', 'refresh', async () => {
      b.classList.add('is-loading');
      await refreshCli(true);
      b.classList.remove('is-loading');
    });
  }
  host.classList.remove('swap');
  void host.offsetWidth;
  host.classList.add('swap');
}

// ── App state (recording, jobs, devices) ─────────────────────────────────
let clockTimer = null;

function applyState(s) {
  if (!s) return;
  store.state = s;
  renderUpdate(s.update);
  document.body.classList.toggle('is-recording', s.phase === 'recording');
  renderHome();
  renderMiniRec();
  renderDeviceLists();
  if (sheet.note && (sheet.tab === 'issues' || sheet.tab === 'speakers') && isRunning(sheet.note) !== sheet.running) {
    sheet.running = isRunning(sheet.note);
    if (!$('#sheet-body .speaker-form.dirty')) renderSheetBody();
  }
  maybeOfferUpdate();
  if (s.phase === 'recording' && !clockTimer) {
    clockTimer = setInterval(tickClock, 250);
    tickClock();
  } else if (s.phase !== 'recording' && clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
    tickClock();
  }
}

function tickClock() {
  const s = store.state;
  const text = s && s.startedAt && s.phase === 'recording' ? fmtClock(Date.now() - s.startedAt) : '00:00';
  $('#timer').textContent = text;
  $('#mini-rec-time').textContent = text;
}

function renderMiniRec() {
  const rec = store.state && store.state.phase === 'recording';
  $('#mini-rec').hidden = !(rec && store.page !== 'home');
}

function currentMic() {
  const { micDeviceId: id, micDeviceLabel: label } = store.settings;
  if (!id) return null;
  return store.state.mics.find((x) => x.deviceId === id) || (label && store.state.mics.find((x) => x.label === label)) || { deviceId: id, label: '', missing: true };
}

function micLabel() {
  const m = currentMic();
  if (!m) return 'Výchozí mikrofon';
  return m.missing ? (store.settings.micDeviceLabel ? `${store.settings.micDeviceLabel} (odpojeno)` : 'Odpojený mikrofon') : m.label || 'Mikrofon';
}

async function saveMic(id) {
  const m = store.state.mics.find((x) => x.deviceId === id);
  await save('micDeviceLabel', m ? m.label : '');
  return save('micDeviceId', id);
}

function outputOption() {
  const v = store.settings.outputDeviceId || '';
  return store.state.outputs.find((o) => o.value === v) || { label: 'Výchozí výstup', value: '' };
}

const LANGS = [
  ['auto', 'Automaticky'],
  ['cs', 'Čeština'],
  ['en', 'Angličtina'],
  ['sk', 'Slovenština'],
  ['de', 'Němčina'],
  ['pl', 'Polština'],
  ['fr', 'Francouzština'],
  ['es', 'Španělština'],
  ['it', 'Italština'],
  ['uk', 'Ukrajinština'],
  ['ru', 'Ruština'],
];
const NOTE_LANGS = [
  ['cs', 'Čeština'],
  ['auto', 'Stejný jako schůzka'],
  ['en', 'Angličtina'],
  ['sk', 'Slovenština'],
  ['de', 'Němčina'],
  ['pl', 'Polština'],
];
const langLabel = (list, v) => (list.find((l) => l[0] === v) || list[0])[1];

function renderHome() {
  const s = store.state;
  const hero = $('#hero');
  const recording = s.phase === 'recording' || s.phase === 'stopping';
  hero.classList.toggle('is-recording', recording);
  hero.classList.toggle('is-busy', s.phase === 'starting' || s.phase === 'stopping');
  const btn = $('#rec-btn');
  btn.disabled = s.phase === 'starting' || s.phase === 'stopping';
  btn.setAttribute('aria-label', recording ? 'Zastavit nahrávání' : 'Spustit nahrávání');

  const status = $('#hero-status');
  status.classList.toggle('recording', recording);
  status.classList.toggle('busy', !recording && (s.jobs.length > 0 || s.phase === 'starting'));
  const dot = $('.status-dot', status);
  dot.classList.toggle('live', recording || s.jobs.length > 0);
  $('#hero-status-text').textContent =
    s.phase === 'starting' ? 'Spouštím nahrávání…' : s.phase === 'stopping' ? 'Ukládám nahrávku…' : recording ? 'Nahrávám' : s.jobs.length ? 'Zpracovávám poznámky' : 'Připraveno k nahrávání';
  const shortcut = store.settings.globalShortcut ? (IS_MAC ? ' · ⌘⌥R' : ' · Ctrl+Alt+R') : '';
  $('#hero-hint').textContent = recording ? 'Klikněte pro zastavení. Poznámky se připraví automaticky.' : `Klikněte pro spuštění nahrávání${shortcut}`;

  // Devices
  $('#mic-name').textContent = micLabel();
  const out = outputOption();
  $('#out-name').textContent = out.value === 'none' ? 'Nenahrává se' : out.label;
  const micDenied = store.perms.microphone === 'denied' || store.perms.microphone === 'restricted';
  const micIcon = $('#pill-mic .device-icon');
  micIcon.classList.toggle('off', micDenied);
  micIcon.innerHTML = icon(micDenied ? 'micOff' : 'mic', 20);
  const outIcon = $('#pill-out .device-icon');
  outIcon.classList.toggle('off', out.value === 'none');
  outIcon.innerHTML = icon(out.value === 'none' ? 'speakerOff' : 'speaker', 20);

  // Warnings
  const warn = $('#rec-warnings');
  warn.replaceChildren();
  const warnings = [...s.warnings];
  if (micDenied) warnings.unshift({ text: 'BRecord nemá přístup k mikrofonu, nahraje se jen zvuk z počítače.', action: 'Povolit', go: 'audio' });
  for (const w of warnings) {
    const row = el('div', 'warn-item');
    row.innerHTML = icon('alert', 16);
    row.append(el('span', '', w.text));
    if (w.url || w.go) {
      const b = el('button', 'btn btn-soft btn-sm', w.action || 'Otevřít nastavení');
      b.addEventListener('click', () => (w.go ? go(w.go) : api.openUrl(w.url)));
      row.append(b);
    }
    warn.append(row);
  }

  // Quick chips
  $('#chip-ai-value').textContent = s.info.summaryPlan && s.info.summaryPlan.length ? s.info.summaryPlan[0] : store.settings.summary.provider === 'none' ? 'Vypnuto' : 'Nepřipojeno';
  $('#chip-model-value').textContent = `whisper · ${store.settings.transcription.whisperModel}`;
  $('#chip-lang-value').textContent = langLabel(LANGS, store.settings.transcription.language || 'auto');
  $('#chip-notes-lang-value').textContent = langLabel(NOTE_LANGS, store.settings.notesLanguage || 'cs');

  renderJobs(s);
}

// ── Processing ───────────────────────────────────────────────────────────
// Rows are patched in place, keyed by file: rebuilding them on every state
// update restarted the spinner and made the progress jump instead of glide.
const jobRows = new Map();
const STEP_NAMES = { transcribing: 'Přepis', speakers: 'Mluvčí', summarizing: 'Shrnutí' };

function jobViews(s) {
  const views = s.jobs.map((job) => ({
    key: job.id,
    name: job.name,
    text: job.text,
    icon: job.stage === 'queued' ? 'clock' : job.stage === 'summarizing' ? 'sparkles' : job.stage === 'speakers' ? 'users' : job.type === 'resummarize' ? 'redo' : 'wave',
    mode: job.stage === 'queued' ? 'idle' : job.stage === 'transcribing' && job.progress ? 'progress' : 'spin',
    progress: job.stage === 'transcribing' ? job.progress : 0,
    steps: job.type === 'resummarize' ? ['summarizing'] : store.settings.speakers && store.settings.speakers.enabled === false ? ['transcribing', 'summarizing'] : ['transcribing', 'speakers', 'summarizing'],
    stage: job.stage,
  }));
  if (s.task) views.push({ key: 'task', name: s.task, text: 'Probíhá na pozadí…', icon: 'download', mode: 'spin', progress: 0, steps: [], stage: '' });
  return views;
}

function renderJobs(s) {
  const views = jobViews(s);
  $('#jobs-card').hidden = !views.length;
  const host = $('#jobs');
  const keep = new Set(views.map((v) => v.key));
  for (const [key, row] of jobRows) {
    if (!keep.has(key)) {
      row.remove();
      jobRows.delete(key);
    }
  }
  views.forEach((v, i) => {
    let row = jobRows.get(v.key);
    if (!row) {
      row = jobRow();
      jobRows.set(v.key, row);
    }
    patchJob(row, v);
    // Moving a node restarts its animations, so only touch misplaced rows.
    if (host.children[i] !== row) host.insertBefore(row, host.children[i] || null);
  });
}

function jobRow() {
  const row = el('div', 'job');
  const ring = el('span', 'job-ring');
  ring.innerHTML = '<svg class="ring" viewBox="0 0 48 48" aria-hidden="true"><circle class="ring-track" cx="24" cy="24" r="21" pathLength="100"/><circle class="ring-fill" cx="24" cy="24" r="21" pathLength="100"/></svg><span class="job-glyph"></span>';
  const main = el('div', 'job-main');
  main.append(el('div', 'job-name'), el('div', 'job-text'));
  row.append(ring, main, el('div', 'job-steps'));
  return row;
}

function patchJob(row, v) {
  const ring = row.querySelector('.job-ring');
  ring.dataset.mode = v.mode;
  ring.style.setProperty('--p', Math.max(0, Math.min(1, v.progress)));
  if (ring.dataset.icon !== v.icon) {
    ring.dataset.icon = v.icon;
    ring.querySelector('.job-glyph').innerHTML = icon(v.icon, 18);
  }
  const name = row.querySelector('.job-name');
  if (name.textContent !== v.name) name.textContent = v.name;
  const text = row.querySelector('.job-text');
  if (text.textContent !== v.text) text.textContent = v.text;
  const steps = row.querySelector('.job-steps');
  if (steps.dataset.order !== v.steps.join()) {
    steps.dataset.order = v.steps.join();
    steps.replaceChildren();
    v.steps.forEach((st, i) => {
      if (i) steps.append(el('span', 'job-sep'));
      steps.append(el('span', 'job-step', STEP_NAMES[st]));
    });
  }
  const at = v.steps.indexOf(v.stage);
  steps.querySelectorAll('.job-step').forEach((node, i) => {
    node.classList.toggle('active', i === at);
    node.classList.toggle('done', at > i);
  });
}

// ── Device pickers ───────────────────────────────────────────────────────
function micItems() {
  return [{ value: '', label: 'Výchozí mikrofon systému', detail: 'Podle nastavení systému' }, ...store.state.mics.map((m, i) => ({ value: m.deviceId, label: m.label || `Mikrofon ${i + 1}` }))];
}
function outItems() {
  return store.state.outputs.map((o) => ({ value: o.value, label: o.label, detail: o.detail }));
}

function openDevicePicker(kind) {
  const anchor = kind === 'mic' ? $('#pill-mic') : $('#pill-out');
  if (anchor.classList.contains('open')) return closePopover();
  const recording = store.state.phase !== 'idle';
  const footer = el('div', 'pop-footer');
  const settingsBtn = el('button', 'btn btn-ghost btn-sm');
  settingsBtn.innerHTML = icon('sliders', 15);
  settingsBtn.append(el('span', '', 'Nastavení zvuku'));
  settingsBtn.addEventListener('click', () => {
    closePopover();
    go('audio');
  });
  const refreshBtn = el('button', 'btn btn-ghost btn-sm');
  refreshBtn.innerHTML = icon('refresh', 15);
  refreshBtn.append(el('span', '', 'Obnovit'));
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('is-loading');
    applyState(await api.refreshDevices());
    closePopover();
    openDevicePicker(kind);
  });
  footer.append(settingsBtn, refreshBtn);
  let top = null;
  if (kind === 'mic') {
    top = el('div', 'pop-meter');
    top.innerHTML = icon('mic', 16);
    top.append(el('span', '', recording ? 'Úroveň mikrofonu' : 'Mluvte a sledujte úroveň'));
    const c = el('canvas', 'meter');
    c.width = 112;
    c.height = 44;
    top.append(c);
    requestAnimationFrame(() => registerMeter(c, 'mic'));
    monitor('popover', true);
  }
  listPopover(anchor, {
    header: recording ? 'Změna platí od další nahrávky' : kind === 'mic' ? 'Vstup · mikrofon' : 'Výstup · systémový zvuk',
    items: kind === 'mic' ? micItems() : outItems(),
    value: kind === 'mic' ? (currentMic() || { deviceId: '' }).deviceId : store.settings.outputDeviceId || '',
    top,
    footer,
    onClose: () => kind === 'mic' && monitor('popover', false),
    onSelect: async (v, it) => {
      if (kind === 'mic') await saveMic(v);
      else await save('outputDeviceId', v);
      toast(`${kind === 'mic' ? 'Vstup' : 'Výstup'}: ${it.label}`);
    },
  });
}

function renderOptionList(host, items, value, onSelect) {
  if (!host) return;
  host.replaceChildren();
  items.forEach((it) => {
    const b = el('button', `option${String(it.value) === String(value) ? ' selected' : ''}`);
    b.type = 'button';
    b.append(el('span', 'radio'));
    const text = el('span');
    text.append(el('div', 'option-label', it.label));
    if (it.detail) text.append(el('div', 'option-detail', it.detail));
    b.append(text, el('span'));
    b.addEventListener('click', () => {
      for (const o of host.children) o.classList.toggle('selected', o === b);
      onSelect(it.value, it);
    });
    host.append(b);
  });
}

function renderDeviceLists() {
  const micSelect = (v) => saveMic(v).then(() => monitorOwners.size && api.monitorStart(v));
  const outSelect = (v) => save('outputDeviceId', v).then(renderOutputHint);
  const micValue = (currentMic() || { deviceId: '' }).deviceId;
  renderOptionList($('#mic-list'), micItems(), micValue, micSelect);
  renderOptionList($('#out-list'), outItems(), store.settings.outputDeviceId || '', outSelect);
  renderOptionList($('#ob-mic-list'), micItems(), micValue, micSelect);
  renderOptionList($('#ob-out-list'), outItems(), store.settings.outputDeviceId || '', outSelect);
  renderOutputHint();
}

function renderOutputHint() {
  const v = store.settings.outputDeviceId || '';
  let text;
  if (v === 'none') text = 'Nahrává se jen mikrofon. Hodí se na osobní schůzky; rozlišení mluvčích se vypne.';
  else if (IS_MAC) text = 'BRecord nahrává všechno, co Mac přehrává, bez ohledu na výstupní zařízení.';
  else text = 'Zvolte zařízení, do kterého hraje aplikace schůzky. Teams a Zoom obvykle používají komunikační zařízení (často sluchátka).';
  $('#output-hint').textContent = text;
}

// ── Permissions ─────────────────────────────────────────────────────────
async function refreshPermissions() {
  store.perms = await api.permissions();
  renderPermissions();
  renderHome();
}

function renderPermissions() {
  const host = $('#perm-list');
  host.replaceChildren();
  const mic = store.perms.microphone;
  host.append(
    permRow({
      tile: 'mic',
      iconName: mic === 'denied' || mic === 'restricted' ? 'micOff' : 'mic',
      title: 'Mikrofon',
      text: mic === 'granted' ? 'Povoleno. BRecord nahrává jen během nahrávání.' : mic === 'denied' || mic === 'restricted' ? 'Zakázáno v nastavení systému.' : 'Zatím nepovoleno.',
      ok: mic === 'granted',
      action: mic === 'granted' ? null : mic === 'denied' || mic === 'restricted' ? { label: 'Otevřít nastavení', url: IS_MAC ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' : 'ms-settings:privacy-microphone' } : { label: 'Povolit mikrofon', request: true },
    }),
  );
  if (IS_MAC) {
    const scr = store.perms.screen;
    host.append(
      permRow({
        tile: 'screen',
        iconName: 'monitor',
        title: 'Nahrávání obrazovky a systémového zvuku',
        text: scr === 'granted' ? 'Povoleno. Nahrává se zvuk ostatních účastníků.' : 'Potřeba pro zvuk ostatních. Po povolení BRecord restartujte.',
        ok: scr === 'granted',
        action: scr === 'granted' ? null : { label: 'Otevřít nastavení', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' },
      }),
    );
  } else {
    host.append(permRow({ tile: 'screen', iconName: 'speaker', title: 'Systémový zvuk', text: 'Ve Windows nepotřebuje žádné oprávnění.', ok: true }));
  }
}

function permRow({ tile, iconName, title, text, ok, action }) {
  const row = el('div', 'perm-row');
  const t = el('span', `logo-tile ${tile}`);
  t.innerHTML = icon(iconName, 20);
  const main = el('div');
  main.append(el('div', 'perm-title', title), el('div', 'perm-text', text));
  row.append(t, main);
  if (action) {
    const b = el('button', `btn ${action.request ? 'btn-primary' : 'btn-soft'} btn-sm`, action.label);
    b.addEventListener('click', async () => {
      if (action.url) return api.openUrl(action.url);
      b.disabled = true;
      const r = await api.requestMicrophone();
      if (r.granted) toast('Mikrofon je povolený');
      else toast(r.error ? `Mikrofon: ${r.error}` : 'Přístup k mikrofonu nebyl povolen', 'error');
      refreshPermissions();
    });
    row.append(b);
  } else {
    const p = el('span', `status-pill ${ok ? 'ok' : ''}`);
    p.innerHTML = '<span class="dot"></span>';
    p.append(el('span', '', ok ? 'Povoleno' : 'Nepovoleno'));
    row.append(p);
  }
  return row;
}

// ── Notes ─────────────────────────────────────────────────────────────────
let notesFilter = 'all';

async function refreshNotes() {
  store.notes = await api.listNotes(200);
  $('#notes-count').textContent = store.notes.length ? String(store.notes.length) : '';
  renderNotes();
  syncNoteSheet();
}

const STATUS = {
  ok: { icon: 'notes', cls: '', badge: null },
  'transcript-only': { icon: 'notes', cls: 'plain', badge: { text: 'Jen přepis', cls: '' } },
  pending: { icon: 'clock', cls: 'warn', badge: { text: 'Připravuje se', cls: 'warn' } },
  'summary-failed': { icon: 'alert', cls: 'bad', badge: { text: 'Shrnutí selhalo', cls: 'bad' } },
  'transcript-failed': { icon: 'alert', cls: 'bad', badge: { text: 'Přepis selhal', cls: 'bad' } },
};

// Done/total of a note's tasks; opens the note's task list.
function taskChip(n) {
  const complete = n.tasksDone === n.tasksTotal;
  const chip = el('button', `task-chip${complete ? ' complete' : ''}`);
  chip.type = 'button';
  chip.title = complete ? 'Všechny úkoly jsou hotové' : `${n.actions} ${plural(n.actions, 'otevřený úkol', 'otevřené úkoly', 'otevřených úkolů')}`;
  chip.innerHTML = complete
    ? icon('check', 13)
    : `<svg class="mini-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" pathLength="100"/><circle cx="8" cy="8" r="6" pathLength="100" style="stroke-dashoffset: ${(1 - n.tasksDone / n.tasksTotal) * 100}px"/></svg>`;
  chip.append(el('span', '', `${n.tasksDone}/${n.tasksTotal}`));
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    openNoteSheet(n, 'tasks');
  });
  chip.addEventListener('keydown', (e) => e.stopPropagation());
  return chip;
}

function noteRow(n, i, big, onOpen) {
  const st = STATUS[n.status] || STATUS.ok;
  const row = el('div', 'note-row');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.style.setProperty('--i', i);
  const ic = el('span', `note-icon ${st.cls}`);
  ic.innerHTML = icon(st.icon, 19);
  const main = el('div', 'note-main');
  main.append(el('div', 'note-title', n.title));
  const meta = el('div', 'note-meta');
  const parts = [fmtDay(n.startedAt), fmtTime(n.startedAt), n.durationSec ? fmtDuration(n.durationSec) : null].filter(Boolean);
  parts.forEach((p, idx) => {
    if (idx) meta.append(el('span', 'sep'));
    meta.append(el('span', '', p));
  });
  main.append(meta);
  if (big && n.summary) main.append(el('div', 'note-summary', n.summary));
  const side = el('div', 'note-side');
  if (n.tasksTotal) side.append(taskChip(n));
  if (st.badge) {
    const badge = el('button', `badge clickable ${st.badge.cls}`, st.badge.text);
    badge.type = 'button';
    badge.title = 'Co s tím';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      openNoteSheet(n, 'issues');
    });
    badge.addEventListener('keydown', (e) => e.stopPropagation());
    side.append(badge);
  }
  const actions = el('div', 'note-actions');
  const act = (iconName, title, fn) => {
    const b = el('button', 'btn btn-ghost btn-sm btn-icon');
    b.title = title;
    b.innerHTML = icon(iconName, 16);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    actions.append(b);
  };
  if (n.status !== 'transcript-failed') act('redo', 'Znovu shrnout', async () => {
    if (await api.resummarize(n.file)) toast('Poznámka se znovu shrnuje');
  });
  act('folder', 'Zobrazit ve složce', () => api.revealNote(n.file));
  side.append(actions);
  row.append(ic, main, side);
  const open = onOpen || (() => openNoteFile(n));
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => e.key === 'Enter' && open());
  return row;
}

function emptyState(title, text, iconName = 'notes') {
  const e = el('div', 'empty');
  const ic = el('div', 'empty-icon');
  ic.innerHTML = icon(iconName, 26);
  e.append(ic, el('div', 'empty-title', title), el('div', 'empty-text', text));
  return e;
}

function renderNotes() {
  const recent = $('#recent-notes');
  recent.replaceChildren();
  const top = store.notes.slice(0, 5);
  if (!top.length) recent.append(emptyState('Zatím žádné poznámky', 'Spusťte první nahrávání. Hotový zápis se objeví tady.'));
  top.forEach((n, i) => recent.append(noteRow(n, i, false)));

  const q = ($('#notes-search').value || '').trim().toLowerCase();
  const list = store.notes.filter((n) => {
    if (notesFilter === 'actions' && !n.tasksTotal) return false;
    if (notesFilter === 'issues' && !['summary-failed', 'transcript-failed', 'pending'].includes(n.status)) return false;
    return !q || n.title.toLowerCase().includes(q) || (n.summary || '').toLowerCase().includes(q);
  });
  const all = $('#all-notes');
  all.replaceChildren();
  if (!list.length) all.append(store.notes.length ? emptyState('Nic nenalezeno', 'Zkuste jiné hledání nebo filtr.', 'search') : emptyState('Zatím žádné poznámky', 'Po první nahrávce se tu objeví zápis ze schůzky.'));
  // In the task and problem views a note opens its sheet, not the editor.
  const tab = notesFilter === 'actions' ? 'tasks' : notesFilter === 'issues' ? 'issues' : null;
  list.forEach((n, i) => all.append(noteRow(n, Math.min(i, 12), true, tab && (() => openNoteSheet(n, tab)))));
}

// ── Note sheet: the tasks and problems of one note ──────────────────────
const sheet = { note: null, tab: 'tasks', tasks: null, speakers: null, editing: -1, running: false, draft: null, fresh: null, tabs: null, closeTimer: null };

const ISSUES = {
  'summary-failed': { title: 'Shrnutí se nepodařilo', text: 'Přepis zůstal uložený. Zkontrolujte přihlášení nebo poskytovatele a nechte poznámku shrnout znovu.', action: 'Znovu shrnout', started: 'Poznámka se znovu shrnuje', page: 'ai', pageLabel: 'AI shrnutí' },
  'transcript-failed': { title: 'Přepis se nepodařil', text: 'Nahrávka zůstala uložená. Po opravě přepisu ji nechte zpracovat znovu.', action: 'Zpracovat znovu', started: 'Nahrávka se zpracuje znovu', page: 'transcription', pageLabel: 'Přepis', reprocess: true },
  pending: { title: 'Shrnutí se nedokončilo', text: 'Zpracování se přerušilo, přepis je uložený. Shrnutí se dokončí při příštím spuštění, nebo ho dokončete hned.', action: 'Dokončit shrnutí', started: 'Poznámka se shrnuje', page: 'ai', pageLabel: 'AI shrnutí' },
  'transcript-only': { title: 'Poznámka nemá shrnutí', text: 'Shrnutí bylo vypnuté nebo nebylo k dispozici. Můžete ho doplnit teď.', action: 'Shrnout', started: 'Poznámka se shrnuje', page: 'ai', pageLabel: 'AI shrnutí', soft: true },
};

const errText = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const sheetShows = (n) => !!sheet.note && sheet.note.file === n.file;
const isRunning = (n) => !!store.state && store.state.jobs.some((j) => j.name === n.base);
const editorName = () => (store.settings.noteEditor !== 'system' && store.editor && store.editor.pilcrow ? 'Pilcrow' : '');

function isMine(owner) {
  const o = owner.trim().toLowerCase();
  const me = (store.settings.myName || '').trim().toLowerCase();
  return o === 'já' || o === 'me' || (!!me && o === me);
}

async function openNoteFile(n) {
  try {
    await api.openNote(n.file);
  } catch (err) {
    toast(errText(err), 'error');
  }
}

function iconButton(name, title, fn) {
  const b = el('button', 'btn btn-ghost btn-sm btn-icon');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = icon(name, 15);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function initNoteSheet() {
  const layer = $('#note-sheet');
  layer.innerHTML = `<div class="sheet-backdrop"></div>
    <aside class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <header class="sheet-head">
        <span class="note-icon" id="sheet-icon"></span>
        <div class="sheet-heading"><div class="sheet-title" id="sheet-title"></div><div class="sheet-sub" id="sheet-sub"></div></div>
        <button class="btn btn-ghost btn-sm btn-icon" type="button" id="sheet-close" title="Zavřít (Esc)" aria-label="Zavřít">${icon('x', 16)}</button>
      </header>
      <div class="sheet-tabs" id="sheet-tabs-wrap"><div class="segmented" id="sheet-tabs"></div></div>
      <div class="sheet-body" id="sheet-body"></div>
      <footer class="sheet-foot">
        <button class="btn btn-soft btn-sm" type="button" id="sheet-open">${icon('external', 15)}<span id="sheet-open-label">Otevřít poznámku</span></button>
        <button class="btn btn-ghost btn-sm" type="button" id="sheet-reveal">${icon('folder', 15)}<span>Zobrazit ve složce</span></button>
      </footer>
    </aside>`;
  sheet.tabs = segmented($('#sheet-tabs'), [
    { value: 'tasks', label: 'Úkoly', icon: 'tasks' },
    { value: 'speakers', label: 'Mluvčí', icon: 'users' },
    { value: 'issues', label: 'K vyřešení', icon: 'alert' },
  ], sheet.tab, (v) => {
    stopSample();
    sheet.tab = v;
    sheet.editing = -1;
    renderSheetBody(true);
    if (v === 'speakers') loadSheetSpeakers();
  });
  $('.sheet-backdrop', layer).addEventListener('click', closeNoteSheet);
  $('#sheet-close').addEventListener('click', closeNoteSheet);
  $('#sheet-open').addEventListener('click', () => sheet.note && openNoteFile(sheet.note));
  $('#sheet-reveal').addEventListener('click', () => sheet.note && api.revealNote(sheet.note.file));
  // Escape a popover or a task being edited already claimed goes no further.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.note && !e.defaultPrevented) {
      e.preventDefault();
      closeNoteSheet();
    }
  });
}

async function openNoteSheet(n, tab) {
  closePopover();
  if (!sheetShows(n)) {
    sheet.tasks = null;
    sheet.speakers = null;
    sheet.draft = { task: '', owner: store.settings.myName || '', due: '' };
  }
  sheet.note = n;
  sheet.tab = tab === 'issues' && ISSUES[n.status] ? 'issues' : tab === 'speakers' ? 'speakers' : 'tasks';
  sheet.editing = -1;
  const layer = $('#note-sheet');
  clearTimeout(sheet.closeTimer);
  layer.classList.remove('leaving');
  layer.hidden = false;
  renderSheetHead();
  sheet.tabs.set(sheet.tab);
  renderSheetBody(true);
  requestAnimationFrame(() => {
    layer.classList.add('open');
    sheet.tabs.place();
  });
  $('#sheet-close').focus({ preventScroll: true });
  await Promise.all([loadSheetTasks(), loadSheetSpeakers()]);
}

function closeNoteSheet() {
  stopSample();
  if (!sheet.note) return;
  sheet.note = null;
  const layer = $('#note-sheet');
  layer.classList.remove('open');
  layer.classList.add('leaving');
  sheet.closeTimer = setTimeout(() => {
    layer.hidden = true;
    layer.classList.remove('leaving');
    $('#sheet-body').replaceChildren();
  }, 280);
}

// Reloads the tasks from the file; the list is only rebuilt when they differ,
// so a reload after the user's own change doesn't restart any animation.
async function loadSheetTasks() {
  const n = sheet.note;
  if (!n) return;
  let tasks;
  try {
    tasks = await api.noteTasks(n.file);
  } catch (err) {
    tasks = [];
    toast(errText(err), 'error');
  }
  if (!sheetShows(n) || JSON.stringify(tasks) === JSON.stringify(sheet.tasks)) return;
  const first = !sheet.tasks;
  sheet.tasks = tasks;
  if (sheet.tab === 'tasks' && sheet.editing < 0) renderSheetBody(first);
}

// Keeps an open sheet in step with the note list after a refresh.
function syncNoteSheet() {
  if (!sheet.note) return;
  const n = store.notes.find((x) => x.file === sheet.note.file);
  if (!n) return closeNoteSheet();
  const changed = n.status !== sheet.note.status || n.issue !== sheet.note.issue;
  const modified = n.modified !== sheet.note.modified;
  sheet.note = n;
  renderSheetHead();
  if (sheet.tab === 'issues' && !ISSUES[n.status]) {
    sheet.tab = 'tasks';
    sheet.tabs.set('tasks');
    renderSheetBody(true);
  } else if (changed) {
    renderSheetBody(true);
  }
  if (modified) {
    loadSheetTasks();
    loadSheetSpeakers();
  }
}

function renderSheetHead() {
  const n = sheet.note;
  const st = STATUS[n.status] || STATUS.ok;
  const ic = $('#sheet-icon');
  ic.className = `note-icon ${st.cls}`;
  ic.innerHTML = icon(st.icon, 19);
  $('#sheet-title').textContent = n.title;
  $('#sheet-sub').textContent = [fmtDay(n.startedAt), fmtTime(n.startedAt), n.durationSec ? fmtDuration(n.durationSec) : null].filter(Boolean).join(' · ');
  $('#sheet-tabs .seg-btn[data-value="issues"]').hidden = !ISSUES[n.status];
  requestAnimationFrame(() => sheet.tabs && sheet.tabs.place());
  $('#sheet-open-label').textContent = editorName() ? `Otevřít v ${editorName()}` : 'Otevřít poznámku';
}

// Content slides in when the sheet opens or switches tab; later redraws after
// a change stay still, only the task that changed animates.
function renderSheetBody(enter = false) {
  const body = $('#sheet-body');
  body.replaceChildren();
  body.classList.remove('enter');
  if (enter) {
    void body.offsetWidth;
    body.classList.add('enter');
  }
  if (!sheet.note) return;
  if (sheet.tab === 'issues' && ISSUES[sheet.note.status]) renderIssue(body);
  else if (sheet.tab === 'speakers') renderSpeakers(body);
  else renderTasks(body);
}

function renderTasks(body) {
  const tasks = sheet.tasks;
  if (!tasks) return;
  if (tasks.length) {
    const head = el('div', 'tasks-head');
    head.append(el('div', 'tasks-count'));
    if (tasks.some((t) => !t.done)) {
      const copy = el('button', 'btn btn-ghost btn-sm');
      copy.type = 'button';
      copy.innerHTML = icon('copy', 15);
      copy.append(el('span', '', 'Kopírovat otevřené'));
      copy.addEventListener('click', () => {
        const text = sheet.tasks.filter((t) => !t.done).map((t) => `- [ ] ${t.raw}`).join('\n');
        navigator.clipboard.writeText(text).then(() => toast('Otevřené úkoly jsou ve schránce'));
      });
      head.append(copy);
    }
    const bar = el('div', 'progress tasks-progress');
    bar.append(el('div', 'progress-fill'));
    body.append(head, bar);
  }
  const list = el('div', 'task-list');
  tasks.forEach((t, i) => list.append(sheet.editing === t.line ? taskEditor(t) : taskRow(t, i)));
  if (!tasks.length) list.append(emptyState('Žádné úkoly', 'Ze schůzky nevzešly žádné úkoly. Přidat můžete vlastní.', 'tasks'));
  body.append(list, addTaskForm());
  sheet.fresh = null;
  updateTaskSummary();
}

function updateTaskSummary() {
  const tasks = sheet.tasks || [];
  const done = tasks.filter((t) => t.done).length;
  const count = $('#sheet-body .tasks-count');
  if (count) count.textContent = done === tasks.length ? 'Vše hotovo' : `Hotovo ${done} z ${tasks.length}`;
  const bar = $('#sheet-body .tasks-progress');
  if (bar) {
    bar.classList.toggle('complete', done === tasks.length);
    $('.progress-fill', bar).style.setProperty('--p', tasks.length ? done / tasks.length : 0);
  }
}

function taskRow(t, i) {
  const row = el('div', `task${t.done ? ' done' : ''}${sheet.fresh && !sheet.fresh.has(`${t.line}|${t.raw}`) ? ' added' : ''}`);
  row.style.setProperty('--i', Math.min(i, 10));
  const check = el('button', 'task-check');
  check.type = 'button';
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-checked', String(t.done));
  check.setAttribute('aria-label', t.task);
  check.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.4 8.6 13.5 14.6 7" pathLength="1"/></svg>';
  check.addEventListener('click', () => toggleTask(t, row, check));
  const main = el('div', 'task-main');
  const text = el('div', 'task-text', t.task);
  text.title = 'Dvojklikem upravíte';
  text.addEventListener('dblclick', () => editTask(t));
  main.append(text);
  const meta = el('div', 'task-meta');
  if (t.owner) {
    const owner = el('span', `task-owner${isMine(t.owner) ? ' mine' : ''}`);
    owner.append(el('span', 'avatar', t.owner.trim().charAt(0).toUpperCase()), el('span', '', t.owner));
    meta.append(owner);
  }
  if (t.due) {
    const due = el('span', 'task-due');
    due.innerHTML = icon('calendar', 13);
    due.append(el('span', '', t.due));
    meta.append(due);
  }
  if (meta.childNodes.length) main.append(meta);
  const actions = el('div', 'task-actions');
  actions.append(iconButton('pencil', 'Upravit', () => editTask(t)), iconButton('trash', 'Smazat', () => removeTask(t, row)));
  row.append(check, main, actions);
  return row;
}

function editTask(t) {
  sheet.editing = t.line;
  renderSheetBody();
  const input = $('#sheet-body .task-form.editing .task-input');
  if (input) input.focus();
}

// Ticking changes one character in the file and no line numbers, so the row
// updates in place and the checkmark gets to animate.
async function toggleTask(t, row, check) {
  const note = sheet.note;
  const done = !t.done;
  t.done = done;
  row.classList.toggle('done', done);
  row.classList.remove('pop');
  if (done) {
    void row.offsetWidth;
    row.classList.add('pop');
  }
  check.setAttribute('aria-checked', String(done));
  updateTaskSummary();
  try {
    await api.updateTask(note.file, { type: 'toggle', line: t.line, raw: t.raw, done });
  } catch (err) {
    toast(errText(err), 'error');
    sheet.tasks = null;
    await loadSheetTasks();
  }
  refreshNotesSoon();
}

async function changeTasks(op) {
  const note = sheet.note;
  try {
    const tasks = await api.updateTask(note.file, op);
    if (sheetShows(note)) {
      sheet.fresh = new Set((sheet.tasks || []).map((t) => `${t.line}|${t.raw}`));
      sheet.tasks = tasks;
      sheet.editing = -1;
      renderSheetBody();
    }
    refreshNotesSoon();
    return true;
  } catch (err) {
    toast(errText(err), 'error');
    sheet.tasks = null;
    sheet.editing = -1;
    await loadSheetTasks();
    return false;
  }
}

async function removeTask(t, row) {
  row.classList.add('leaving');
  await new Promise((r) => setTimeout(r, 180));
  if (await changeTasks({ type: 'remove', line: t.line, raw: t.raw })) toast('Úkol je smazaný');
}

function taskForm(values, { submit, onSubmit, onCancel, onInput, cls }) {
  const form = el('form', `task-form ${cls}`);
  const field = (name, placeholder, max) => {
    const input = el('input', `input task-${name}`);
    input.type = 'text';
    input.placeholder = placeholder;
    input.maxLength = max;
    input.value = values[name] || '';
    input.addEventListener('input', () => {
      ok.disabled = !text.value.trim();
      if (onInput) onInput({ task: text.value, owner: owner.value, due: due.value });
    });
    return input;
  };
  const ok = el('button', 'btn btn-primary btn-sm');
  ok.type = 'submit';
  const text = field('task', 'Co je potřeba udělat', 400);
  text.classList.add('task-input');
  const owner = field('owner', 'Kdo', 80);
  const due = field('due', 'Termín', 80);
  ok.innerHTML = icon(onCancel ? 'check' : 'plus', 15);
  ok.append(el('span', '', submit));
  ok.disabled = !text.value.trim();
  const row = el('div', 'task-form-row');
  row.append(owner, due);
  if (onCancel) {
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Zrušit');
    cancel.type = 'button';
    cancel.addEventListener('click', onCancel);
    row.append(cancel);
  }
  row.append(ok);
  form.append(text, row);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!text.value.trim()) return;
    ok.disabled = true;
    await onSubmit({ task: text.value, owner: owner.value, due: due.value });
    ok.disabled = !text.value.trim();
  });
  if (onCancel) {
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCancel();
    });
  }
  return form;
}

function taskEditor(t) {
  return taskForm(t, {
    cls: 'editing',
    submit: 'Uložit',
    onSubmit: (v) => changeTasks({ type: 'edit', line: t.line, raw: t.raw, ...v }),
    onCancel: () => {
      sheet.editing = -1;
      renderSheetBody();
    },
  });
}

function addTaskForm() {
  const wrap = el('div', 'task-add');
  wrap.append(el('div', 'task-add-label', 'Nový úkol'));
  wrap.append(taskForm(sheet.draft, {
    cls: 'adding',
    submit: 'Přidat',
    onInput: (v) => (sheet.draft = v),
    onSubmit: async (v) => {
      if (!(await changeTasks({ type: 'add', ...v }))) return;
      sheet.draft = { task: '', owner: v.owner, due: '' };
      const input = $('#sheet-body .task-form.adding .task-input');
      if (input) {
        input.value = '';
        input.focus();
      }
    },
  }));
  return wrap;
}

function renderIssue(body) {
  const n = sheet.note;
  const info = ISSUES[n.status];
  sheet.running = isRunning(n);
  const card = el('div', `issue${info.soft ? '' : ' bad'}`);
  const head = el('div', 'issue-head');
  const ic = el('span', 'issue-icon');
  ic.innerHTML = icon(info.soft ? 'info' : 'alert', 18);
  head.append(ic, el('div', 'issue-title', info.title));
  card.append(head, el('p', 'issue-text', info.text));
  if (n.issue) card.append(el('div', 'issue-label', 'Co se stalo'), el('pre', 'issue-message', n.issue));
  const actions = el('div', 'issue-actions');
  const run = el('button', 'btn btn-primary btn-sm');
  run.type = 'button';
  if (sheet.running) {
    run.disabled = true;
    run.classList.add('is-loading');
    run.innerHTML = icon('refresh', 15);
    run.append(el('span', '', 'Zpracovává se…'));
  } else {
    run.innerHTML = icon(info.reprocess ? 'wave' : 'redo', 15);
    run.append(el('span', '', info.action));
  }
  run.addEventListener('click', async () => {
    run.disabled = true;
    try {
      if (await (info.reprocess ? api.reprocessNote(n.file) : api.resummarize(n.file))) toast(info.started);
      else run.disabled = false;
    } catch (err) {
      toast(errText(err), 'error');
      run.disabled = false;
    }
  });
  const settingsBtn = el('button', 'btn btn-soft btn-sm');
  settingsBtn.type = 'button';
  settingsBtn.innerHTML = icon('sliders', 15);
  settingsBtn.append(el('span', '', `Nastavení · ${info.pageLabel}`));
  settingsBtn.addEventListener('click', () => {
    closeNoteSheet();
    go(info.page);
  });
  actions.append(run, settingsBtn);
  card.append(actions);
  body.append(card);
}

// ── Speakers of a note ───────────────────────────────────────────────────
let player = null;

// file:///C:/Users/… with each path segment encoded (#, ? and spaces).
function fileUrl(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  return `file:///${parts.map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/').replace(/^\/+/, '')}`;
}

function stopSample() {
  if (!player) return;
  player.audio.pause();
  player.audio.removeAttribute('src');
  player.btn.classList.remove('playing');
  player.btn.innerHTML = icon('play', 14);
  player = null;
}

// A few seconds of the speaker's longest turn, to tell who it is.
function playSample(sp, btn) {
  const same = player && player.btn === btn;
  stopSample();
  if (same || !sheet.speakers || !sheet.speakers.audio) return;
  const audio = new Audio(fileUrl(sheet.speakers.audio));
  const stopAt = sp.sampleStart + Math.min(10, Math.max(3, sp.sampleSeconds));
  audio.addEventListener('loadedmetadata', () => {
    audio.currentTime = sp.sampleStart;
    audio.play().catch(() => stopSample());
  }, { once: true });
  audio.addEventListener('timeupdate', () => audio.currentTime >= stopAt && stopSample());
  audio.addEventListener('error', () => {
    stopSample();
    toast('Nahrávku se nepodařilo přehrát', 'error');
  });
  player = { audio, btn };
  btn.classList.add('playing');
  btn.innerHTML = icon('stop', 14);
}

async function loadSheetSpeakers() {
  const n = sheet.note;
  if (!n) return;
  let info;
  try {
    info = await api.noteSpeakers(n.file);
  } catch (err) {
    info = { speakers: [], voices: false, audio: null };
    toast(errText(err), 'error');
  }
  if (!sheetShows(n)) return;
  const first = !sheet.speakers;
  sheet.speakers = info;
  if (sheet.tab === 'speakers' && !$('#sheet-body .speaker-form.dirty')) renderSheetBody(first);
}

function speakerCount(value, onChange) {
  const wrap = el('div', 'segmented small');
  segmentedOnce(wrap, [{ value: 0, label: 'Automaticky' }, ...[2, 3, 4, 5, 6].map((v) => ({ value: v, label: String(v) }))], value, onChange);
  return wrap;
}

// segmented() remembers every control for re-layout on resize; the sheet
// redraws its body often, so drop the ones that left the page.
function segmentedOnce(root, options, value, onChange) {
  const ctl = segmented(root, options, value, onChange);
  for (const place of [...segmentedRegistry]) if (place !== ctl.place && place.root && !place.root.isConnected) segmentedRegistry.delete(place);
  ctl.place.root = root;
  return ctl;
}

function rerunSpeakers(n, count, button) {
  button.disabled = true;
  api.reprocessNote(n.file, { numSpeakers: count }).then(
    () => {
      toast('Nahrávka se zpracuje znovu, i s rozlišením mluvčích');
      renderSheetBody();
    },
    (err) => {
      button.disabled = false;
      toast(errText(err), 'error');
    },
  );
}

function renderSpeakers(body) {
  const n = sheet.note;
  const info = sheet.speakers;
  if (!info) return;
  const running = isRunning(n);
  const enabled = store.settings.speakers && store.settings.speakers.enabled !== false;
  let count = 0;

  if (!info.voices) {
    const box = el('div', 'speakers-empty');
    const ic = el('div', 'empty-icon');
    ic.innerHTML = icon('users', 26);
    box.append(ic, el('div', 'empty-title', 'Mluvčí zatím nejsou rozlišení'));
    box.append(el('p', 'empty-text', 'Tahle poznámka zná jen „Já“ a „Ostatní“. BRecord může nahrávku zpracovat znovu a rozlišit jednotlivé hlasy. Přepis i shrnutí se napíšou znovu, odškrtnuté úkoly zůstanou.'));
    const row = el('div', 'speakers-rerun');
    row.append(el('span', 'speakers-rerun-label', 'Kolik lidí mluvilo'), speakerCount(0, (v) => (count = Number(v))));
    box.append(row);
    const go = el('button', 'btn btn-primary');
    go.type = 'button';
    go.innerHTML = icon(running ? 'refresh' : 'users', 16);
    go.append(el('span', '', running ? 'Zpracovává se…' : 'Rozpoznat mluvčí'));
    go.classList.toggle('is-loading', running);
    go.disabled = running || !info.audio || !enabled;
    go.addEventListener('click', () => rerunSpeakers(n, count, go));
    box.append(go);
    if (!info.audio) box.append(el('p', 'speakers-note', 'Nahrávka k této poznámce už ve složce není.'));
    else if (!enabled) box.append(el('p', 'speakers-note', 'Rozlišování mluvčích je vypnuté v Nastavení → Přepis.'));
    body.append(box);
    return;
  }

  body.append(el('p', 'speakers-intro', 'Pojmenujte, kdo mluvil. Jména se propíšou do přepisu, shrnutí se napíše znovu a BRecord si hlasy zapamatuje, takže je příště pozná sám.'));
  const form = el('form', 'speaker-form');
  const listId = 'speaker-names';
  const datalist = el('datalist');
  datalist.id = listId;
  const suggestions = new Set([store.settings.myName, ...(store.voices || []).map((v) => v.name), ...info.speakers.map((sp) => sp.label)].filter((x) => x && !/^Mluvčí \d+$/.test(x) && x !== 'Ostatní'));
  for (const name of suggestions) {
    const o = el('option');
    o.value = name;
    datalist.append(o);
  }
  const inputs = [];
  const save = el('button', 'btn btn-primary');
  save.type = 'submit';
  save.innerHTML = icon('check', 16);
  save.append(el('span', '', 'Uložit jména'));
  save.disabled = true;
  const dirty = () => {
    const changed = inputs.some(({ sp, input }) => input.value.trim() && input.value.trim() !== sp.label);
    form.classList.toggle('dirty', changed);
    save.disabled = !changed || running;
  };
  info.speakers.forEach((sp, i) => {
    const generic = /^Mluvčí \d+$/.test(sp.label) || sp.label === 'Ostatní';
    const row = el('div', 'speaker');
    row.style.setProperty('--i', Math.min(i, 10));
    const avatar = el('span', `speaker-avatar${generic ? '' : ' named'}`, generic ? String(i + 1) : sp.label.trim().charAt(0).toUpperCase());
    const main = el('div', 'speaker-main');
    const input = el('input', 'input speaker-name');
    input.type = 'text';
    input.maxLength = 60;
    input.setAttribute('list', listId);
    input.placeholder = generic ? `${sp.label} · zadejte jméno` : sp.label;
    input.value = generic ? '' : sp.label;
    input.setAttribute('aria-label', `Jméno pro ${sp.label}`);
    input.addEventListener('input', dirty);
    inputs.push({ sp, input });
    const meta = el('div', 'speaker-meta');
    meta.append(el('span', '', `${sp.turns} ${plural(sp.turns, 'promluva', 'promluvy', 'promluv')} · ${fmtDuration(sp.seconds)}`));
    if (sp.auto) meta.append(el('span', 'badge accent', 'poznáno podle hlasu'));
    main.append(input, meta, el('div', 'speaker-sample', `„${sp.sample}“`));
    const play = el('button', 'btn btn-soft btn-sm btn-icon speaker-play');
    play.type = 'button';
    play.title = 'Přehrát ukázku';
    play.setAttribute('aria-label', `Přehrát ukázku: ${sp.label}`);
    play.innerHTML = icon('play', 14);
    play.disabled = !info.audio;
    play.addEventListener('click', () => playSample(sp, play));
    row.append(avatar, main, play);
    form.append(row);
  });
  const actions = el('div', 'speaker-actions');
  actions.append(save, el('span', 'speakers-note', 'Dva mluvčí se stejným jménem se spojí v jednoho.'));
  form.append(datalist, actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mapping = {};
    for (const { sp, input } of inputs) if (input.value.trim() && input.value.trim() !== sp.label) mapping[sp.label] = input.value.trim();
    save.disabled = true;
    try {
      const r = await api.saveSpeakerNames(n.file, mapping);
      toast(r.learned.length ? `Jména jsou uložená a BRecord si zapamatoval ${r.learned.length === 1 ? 'hlas' : 'hlasy'}. Shrnutí se píše znovu.` : 'Jména jsou uložená. Shrnutí se píše znovu.');
      sheet.speakers = null;
      form.classList.remove('dirty');
      await loadSheetSpeakers();
      refreshVoices();
    } catch (err) {
      toast(errText(err), 'error');
      dirty();
    }
  });
  body.append(form);

  const again = el('div', 'speakers-again');
  again.append(el('div', 'task-add-label', 'Nesedí to?'));
  const row = el('div', 'speakers-rerun');
  row.append(el('span', 'speakers-rerun-label', 'Kolik lidí mluvilo'), speakerCount(0, (v) => (count = Number(v))));
  const redo = el('button', 'btn btn-soft btn-sm');
  redo.type = 'button';
  redo.innerHTML = icon('redo', 15);
  redo.append(el('span', '', running ? 'Zpracovává se…' : 'Rozpoznat znovu'));
  redo.disabled = running || !info.audio || !enabled;
  redo.addEventListener('click', () => rerunSpeakers(n, count, redo));
  row.append(redo);
  again.append(row);
  body.append(again);
}

// ── Speaker settings (Přepis) ────────────────────────────────────────────
async function refreshVoices() {
  let status;
  try {
    status = await api.speakersStatus();
  } catch {
    return;
  }
  store.voices = status.voices;
  const hint = $('#speakers-hint');
  hint.replaceChildren();
  if (status.installed) {
    hint.textContent = 'Místo „Ostatní“ pozná jednotlivé lidi. Modely jsou nainstalované.';
  } else {
    hint.append(`Místo „Ostatní“ pozná jednotlivé lidi. Modely (${status.mb} MB) se stáhnou při první nahrávce, nebo `);
    const link = el('a', 'link', 'hned teď');
    link.href = '#';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      link.textContent = 'stahuji…';
      const r = await api.installSpeakers();
      if (!r.ok) toast(r.error, 'error');
      refreshVoices();
    });
    hint.append(link, '.');
  }
  const list = $('#voice-list');
  list.replaceChildren();
  if (!status.voices.length) list.append(el('span', 'voice-empty', 'Zatím žádné'));
  for (const v of status.voices) {
    const chip = el('span', 'voice-chip');
    chip.append(el('span', '', v.name));
    const x = el('button', 'voice-forget');
    x.type = 'button';
    x.title = `Zapomenout hlas ${v.name}`;
    x.setAttribute('aria-label', x.title);
    x.innerHTML = icon('x', 12);
    x.addEventListener('click', async () => {
      await api.forgetVoice(v.name);
      toast(`Hlas ${v.name} je zapomenutý`);
      refreshVoices();
    });
    chip.append(x);
    list.append(chip);
  }
}

let notesTimer = null;
function refreshNotesSoon() {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(refreshNotes, 300);
}

// ── Note editor (Pilcrow) ────────────────────────────────────────────────
async function refreshEditor() {
  try {
    store.editor = await api.noteEditor();
  } catch {
    store.editor = null;
  }
  renderEditorHint();
  if (sheet.note) renderSheetHead();
}

function renderEditorHint() {
  const hint = $('#note-editor-hint');
  hint.replaceChildren();
  const e = store.editor;
  if (store.settings.noteEditor === 'system') {
    hint.textContent = 'Aplikace, kterou má systém nastavenou pro soubory .md.';
  } else if (e && e.pilcrow) {
    hint.textContent = 'Poznámka se otevře v Markdown editoru Pilcrow.';
  } else {
    hint.append('Pilcrow není nainstalovaný, poznámky se zatím otevřou ve výchozí aplikaci. ');
    const link = el('a', 'link', 'Stáhnout Pilcrow');
    link.href = '#';
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (e) api.openUrl(e.download);
    });
    hint.append(link);
  }
}

// ── AI summaries ───────────────────────────────────────────────────────────
const CLI_UI = {
  claude: {
    key: 'claudeCode',
    provider: 'claude-code',
    tile: 'claude',
    iconName: 'claude',
    title: 'Claude Code',
    sub: 'Předplatné Claude (Pro, Max, Team) · bez API klíče',
    models: [['', 'Výchozí'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']],
    efforts: [['', 'Výchozí'], ['low', 'Nízká'], ['medium', 'Střední'], ['high', 'Vysoká'], ['xhigh', 'Velmi vysoká'], ['max', 'Max']],
  },
  codex: {
    key: 'codex',
    provider: 'codex',
    tile: 'codex',
    iconName: 'codex',
    title: 'Codex',
    sub: 'Tarif ChatGPT · bez API klíče',
    models: [['', 'Výchozí']],
    efforts: [['', 'Výchozí'], ['minimal', 'Minimální'], ['low', 'Nízká'], ['medium', 'Střední'], ['high', 'Vysoká']],
  },
};
const loginState = {};

const CARD_HTML = `
  <div class="cli-head">
    <span class="logo-tile"></span>
    <div class="cli-title"><h2><span class="t"></span><span class="primary-tag" hidden>Používá se</span></h2><p class="muted sub"></p></div>
    <span class="status-pill checking"><span class="dot"></span><span class="st">Zjišťuji</span></span>
  </div>
  <div class="cli-body"></div>
  <div class="collapse login-collapse"><div class="collapse-inner"><div class="login-flow"></div></div></div>
  <div class="cli-fields">
    <div class="cli-field"><label>Model</label><div class="chips model-chips"></div></div>
    <div class="cli-field"><label>Náročnost</label><div><div class="segmented small effort-seg"></div></div></div>
  </div>
  <div class="cli-actions"></div>
  <div class="collapse test-collapse"><div class="collapse-inner"><div class="test-result"></div></div></div>`;

function buildCliCards() {
  const host = $('#cli-cards');
  host.replaceChildren();
  for (const id of Object.keys(CLI_UI)) {
    const ui = CLI_UI[id];
    const card = el('div', 'card cli-card');
    card.id = `cli-${id}`;
    card.innerHTML = CARD_HTML;
    const tile = $('.logo-tile', card);
    tile.classList.add(ui.tile);
    tile.innerHTML = icon(ui.iconName, 22);
    $('.t', card).textContent = ui.title;
    $('.sub', card).textContent = ui.sub;
    host.append(card);
    renderModelChips(id);
    card._effort = segmented($('.effort-seg', card), ui.efforts.map(([value, label]) => ({ value, label })), getPath(store.settings, `summary.${ui.key}.effort`) || '', (v) => save(`summary.${ui.key}.effort`, v));
    loginState[id] = { phase: 'idle', url: null, log: '', mode: Object.keys(store.meta.clis[id].loginModes)[0], secret: '' };
    renderCliCard(id);
  }
}

function renderModelChips(id) {
  const ui = CLI_UI[id];
  const card = $(`#cli-${id}`);
  const host = card && $('.model-chips', card);
  if (!host) return;
  const path = `summary.${ui.key}.model`;
  const current = getPath(store.settings, path) || '';
  host.replaceChildren();
  const known = ui.models.map((m) => m[0]);
  for (const [value, label] of ui.models) {
    const c = el('button', `chip${current === value ? ' active' : ''}`, label);
    c.addEventListener('click', () => save(path, value).then(() => renderModelChips(id)));
    host.append(c);
  }
  if (current && !known.includes(current)) {
    const c = el('button', 'chip active', current);
    c.title = 'Upravit vlastní model';
    c.addEventListener('click', () => editCustomModel(id, c, current));
    host.append(c);
  } else {
    const c = el('button', 'chip', 'Vlastní…');
    c.addEventListener('click', () => editCustomModel(id, c, ''));
    host.append(c);
  }
}

function editCustomModel(id, chip, value) {
  const input = el('input', 'chip-input');
  input.value = value;
  input.placeholder = id === 'claude' ? 'např. claude-sonnet-5' : 'název modelu';
  chip.replaceWith(input);
  input.focus();
  let done = false;
  const commit = async (ok) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (ok && v !== value) await save(`summary.${CLI_UI[id].key}.model`, v);
    renderModelChips(id);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

function statusPill(node, text, kind) {
  node.className = `status-pill ${kind || ''}`;
  $('.st', node).textContent = text;
}

function renderCliCard(id) {
  const card = $(`#cli-${id}`);
  if (!card) return;
  const s = store.cli[id];
  const ui = CLI_UI[id];
  const def = store.meta.clis[id];
  const pill = $('.status-pill', card);
  const body = $('.cli-body', card);
  const actions = $('.cli-actions', card);
  const fields = $('.cli-fields', card);
  body.replaceChildren();
  actions.replaceChildren();
  const plan = (store.local && store.local.summaryPlan) || [];
  $('.primary-tag', card).hidden = plan[0] !== def.label;
  card.classList.toggle('is-primary', plan[0] === def.label);

  if (!s) {
    statusPill(pill, 'Zjišťuji', 'checking');
    for (let i = 0; i < 2; i++) body.append(el('div', 'skeleton'));
    fields.hidden = true;
    return;
  }
  if (!s.installed) {
    statusPill(pill, s.path ? 'Nefunguje' : 'Nenainstalováno', 'bad');
    fields.hidden = true;
    const box = el('div', 'install-box');
    box.append(el('p', '', s.path ? `CLI se nepodařilo spustit: ${s.error || ''}` : `${ui.title} není nainstalované. Nainstalujte ho v terminálu:`));
    const row = el('div', 'install-cmd');
    row.append(el('code', '', def.install));
    const copy = el('button', 'btn btn-soft btn-sm');
    copy.innerHTML = icon('copy', 15);
    copy.append(el('span', '', 'Kopírovat'));
    copy.addEventListener('click', () => navigator.clipboard.writeText(def.install).then(() => {
      copy.lastChild.textContent = 'Zkopírováno';
      setTimeout(() => (copy.lastChild.textContent = 'Kopírovat'), 1600);
    }));
    row.append(copy);
    box.append(row);
    body.append(box);
    addAction(actions, 'Zkontrolovat znovu', 'refresh', () => refreshCli(true), 'btn btn-soft');
    addAction(actions, 'Návod k instalaci', 'external', () => api.openUrl(def.docs), 'btn btn-ghost');
    return;
  }
  fields.hidden = false;
  const ls = loginState[id];
  if (s.loggedIn) {
    statusPill(pill, 'Přihlášeno', 'ok');
    const acc = el('div', 'cli-account');
    const account = s.account || '';
    const [who, plan2] = account.split(' · ');
    const av = el('span', 'avatar', (who || ui.title).trim().charAt(0).toUpperCase());
    const whoBox = el('div', 'who');
    whoBox.append(el('b', '', who || 'Přihlášený účet'), el('span', '', s.version || ''));
    acc.append(av, whoBox);
    if (plan2) acc.append(el('span', 'plan-chip', plan2));
    body.append(acc);
    addAction(actions, 'Otestovat shrnutí', 'zap', () => runTest(ui.provider), 'btn btn-soft');
    addAction(actions, 'Odhlásit', 'logOut', async () => {
      try {
        await api.logout(id);
        toast(`${ui.title}: odhlášeno`);
      } catch (err) {
        toast(err.message, 'error');
      }
      refreshCli(true);
    }, 'btn btn-ghost');
  } else {
    statusPill(pill, ls.phase === 'running' ? 'Přihlašuji…' : 'Nepřihlášeno', ls.phase === 'running' ? 'checking' : 'warn');
    if (ls.phase === 'idle') addAction(actions, 'Přihlásit se', 'logIn', () => openLogin(id), 'btn btn-primary');
  }
  actions.append(el('span', 'spacer'));
  const more = el('button', 'btn btn-ghost btn-icon');
  more.title = 'Další možnosti';
  more.innerHTML = icon('more', 18);
  more.addEventListener('click', () => cliMoreMenu(id, more));
  actions.append(more);
  renderLoginFlow(id);
}

function addAction(host, label, iconName, fn, cls) {
  const b = el('button', cls);
  b.innerHTML = icon(iconName, 16);
  b.append(el('span', '', label));
  b.addEventListener('click', fn);
  host.append(b);
  return b;
}

function cliMoreMenu(id, anchor) {
  const ui = CLI_UI[id];
  const custom = getPath(store.settings, `summary.${ui.key}.path`);
  const items = [
    { value: 'terminal', label: 'Přihlásit přes terminál', detail: 'Když přihlášení v okně nefunguje' },
    { value: 'refresh', label: 'Obnovit stav' },
    { value: 'path', label: 'Nastavit cestu k CLI…', detail: custom || 'Zjištěno automaticky' },
  ];
  if (custom) items.push({ value: 'auto', label: 'Použít automatickou cestu' });
  items.push({ value: 'docs', label: 'Dokumentace' });
  listPopover(anchor, {
    items,
    value: null,
    width: 290,
    align: 'end',
    onSelect: async (v) => {
      if (v === 'terminal') {
        api.loginInTerminal(id, loginState[id].mode);
        toast('Dokončete přihlášení v terminálu');
        pollLogin(id);
      } else if (v === 'refresh') refreshCli(true);
      else if (v === 'path') {
        const f = await api.chooseFile(custom);
        if (f) {
          await save(`summary.${ui.key}.path`, f);
          refreshCli(true);
        }
      } else if (v === 'auto') {
        await save(`summary.${ui.key}.path`, '');
        refreshCli(true);
      } else if (v === 'docs') api.openUrl(store.meta.clis[id].docs);
    },
  });
}

function openLogin(id) {
  const ls = loginState[id];
  ls.phase = 'choose';
  renderCliCard(id);
}

function renderLoginFlow(id) {
  const card = $(`#cli-${id}`);
  const ls = loginState[id];
  const s = store.cli[id];
  const collapse = $('.login-collapse', card);
  const flow = $('.login-flow', card);
  const show = ls.phase !== 'idle' && !(s && s.loggedIn && ls.phase !== 'done');
  collapse.classList.toggle('open', show);
  if (!show) return;
  const def = store.meta.clis[id];
  flow.replaceChildren();
  const head = el('div', 'login-flow-head');
  head.append(el('b', '', ls.phase === 'done' ? 'Přihlášení dokončeno' : `Přihlášení do ${CLI_UI[id].title}`));
  if (ls.phase !== 'done') {
    const cancel = el('button', 'btn btn-ghost btn-sm', 'Zrušit');
    cancel.addEventListener('click', () => {
      if (ls.phase === 'running' || ls.phase === 'browser') api.loginCancel(id);
      ls.phase = 'idle';
      ls.polling = false;
      renderCliCard(id);
    });
    head.append(cancel);
  }
  flow.append(head);

  if (ls.phase === 'choose') {
    const modes = Object.entries(def.loginModes);
    const segHost = el('div', 'segmented small');
    flow.append(el('div', 'muted', 'Způsob přihlášení'));
    const wrap = el('div');
    wrap.style.margin = '8px 0 12px';
    wrap.append(segHost);
    flow.append(wrap);
    const secret = el('input', 'input');
    secret.type = 'password';
    secret.placeholder = 'Vložte API klíč OpenAI';
    secret.style.width = '100%';
    secret.style.marginBottom = '12px';
    const needs = () => def.loginModes[ls.mode] && def.loginModes[ls.mode].needsSecret;
    secret.hidden = !needs();
    segmented(segHost, modes.map(([value, m]) => ({ value, label: m.label })), ls.mode, (v) => {
      ls.mode = v;
      secret.hidden = !needs();
    });
    flow.append(secret);
    const start = el('button', 'btn btn-primary');
    start.innerHTML = icon('logIn', 16);
    start.append(el('span', '', 'Pokračovat'));
    start.addEventListener('click', () => startLogin(id, needs() ? secret.value.trim() : undefined));
    flow.append(start);
    return;
  }

  const steps = el('div', 'steps');
  const stepState = (n) => {
    if (ls.phase === 'failed') return n === 1 ? 'done' : n === 2 ? 'failed' : '';
    if (ls.phase === 'done') return 'done';
    if (n === 1) return ls.phase === 'running' ? 'active' : 'done';
    if (n === 2) return ls.phase === 'browser' ? 'active' : '';
    return '';
  };
  const step = (n, title, extra) => {
    const st = el('div', `step ${stepState(n)}`);
    const dot = el('span', 'step-dot');
    dot.innerHTML = `<span class="num">${n}</span>${icon(ls.phase === 'failed' && n === 2 ? 'x' : 'check', 14)}`;
    const body = el('div', 'step-body');
    body.append(el('div', 'step-title', title));
    if (extra) body.append(extra);
    st.append(dot, body);
    steps.append(st);
  };
  step(1, 'Spouštím přihlášení');
  let extra = null;
  if (ls.phase === 'browser' || ls.phase === 'failed') {
    extra = el('div');
    if (ls.phase === 'failed') extra.append(el('div', 'muted', ls.error || 'Přihlášení se nepodařilo.'));
    const row = el('div', 'step-extra');
    if (ls.url && ls.phase === 'browser') {
      const open = el('button', 'btn btn-primary btn-sm');
      open.innerHTML = icon('external', 15);
      open.append(el('span', '', 'Otevřít přihlašovací stránku'));
      open.addEventListener('click', () => api.openUrl(ls.url));
      row.append(open);
    }
    if (ls.phase === 'failed') {
      const retry = el('button', 'btn btn-soft btn-sm', 'Zkusit znovu');
      retry.addEventListener('click', () => openLogin(id));
      row.append(retry);
    }
    const term = el('button', 'btn btn-ghost btn-sm');
    term.innerHTML = icon('terminal', 15);
    term.append(el('span', '', 'Přes terminál'));
    term.addEventListener('click', () => {
      api.loginCancel(id);
      api.loginInTerminal(id, ls.mode);
      pollLogin(id);
    });
    row.append(term);
    extra.append(row);
    if (ls.phase === 'browser') {
      const code = el('div', 'code-row');
      const input = el('input');
      input.placeholder = 'Pokud CLI požaduje kód, vložte ho sem';
      const send = el('button', 'btn btn-soft btn-sm', 'Odeslat');
      const submit = () => {
        if (!input.value.trim()) return;
        api.loginInput(id, input.value.trim());
        input.value = '';
        toast('Kód odeslán');
      };
      send.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
      code.append(input, send);
      extra.append(code);
    }
  }
  step(2, 'Dokončete přihlášení v prohlížeči', extra);
  step(3, 'Hotovo');
  flow.append(steps);
  if (ls.log) {
    const toggle = el('button', 'btn btn-ghost btn-sm log-toggle', ls.showLog ? 'Skrýt výstup CLI' : 'Zobrazit výstup CLI');
    toggle.addEventListener('click', () => {
      ls.showLog = !ls.showLog;
      renderLoginFlow(id);
    });
    flow.append(toggle);
    if (ls.showLog) {
      const pre = el('pre', 'log', ls.log);
      flow.append(pre);
      requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
    }
  }
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

async function startLogin(id, secret) {
  const ls = loginState[id];
  Object.assign(ls, { phase: 'running', url: null, log: '', error: null, showLog: false });
  renderCliCard(id);
  try {
    await api.login(id, ls.mode, secret);
    setTimeout(() => {
      if (ls.phase === 'running') {
        ls.phase = 'browser';
        renderCliCard(id);
      }
    }, 1800);
    pollLogin(id);
  } catch (err) {
    Object.assign(ls, { phase: 'failed', error: err.message });
    renderCliCard(id);
  }
}

async function pollLogin(id) {
  const ls = loginState[id];
  if (ls.polling) return;
  ls.polling = true;
  const started = Date.now();
  while (ls.polling && Date.now() - started < 10 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!ls.polling) break;
    const r = await api.cliStatus(true);
    if (r && r[id] && r[id].loggedIn) {
      ls.polling = false;
      ls.phase = 'done';
      store.cli = r;
      renderCliCard(id);
      toast(`${CLI_UI[id].title}: přihlášeno`);
      refreshLocal();
      setTimeout(() => {
        ls.phase = 'idle';
        renderCliCard(id);
      }, 2400);
      return;
    }
  }
  ls.polling = false;
}

api.on('cli:login-output', ({ id, text }) => {
  const ls = loginState[id];
  if (!ls) return;
  const clean = stripAnsi(text);
  ls.log = (ls.log + clean).slice(-6000);
  const url = (clean.match(/https?:\/\/[^\s'"<>)\]]+/) || [])[0];
  if (url && !ls.url) ls.url = url;
  if (ls.phase === 'running') ls.phase = 'browser';
  renderLoginFlow(id);
});

api.on('cli:login-exit', ({ id, code, error }) => {
  const ls = loginState[id];
  if (!ls || ls.phase === 'idle' || ls.phase === 'done') return;
  api.cliStatus(true).then((r) => {
    store.cli = r;
    if (r[id] && r[id].loggedIn) {
      ls.polling = false;
      ls.phase = 'done';
      toast(`${CLI_UI[id].title}: přihlášeno`);
      setTimeout(() => {
        ls.phase = 'idle';
        renderCliCard(id);
      }, 2400);
    } else if (code !== 0 || error) {
      ls.polling = false;
      Object.assign(ls, { phase: 'failed', error: error || `CLI skončilo s kódem ${code}. Zkuste přihlášení přes terminál.` });
    }
    renderCliCard(id);
    refreshLocal();
  });
});

async function refreshCli(fresh) {
  try {
    store.cli = await api.cliStatus(!!fresh);
  } catch (err) {
    toast(`Stav CLI se nepodařilo zjistit: ${err.message}`, 'error');
    return;
  }
  Object.keys(CLI_UI).forEach(renderCliCard);
  renderObCli();
}

async function runTest(provider) {
  const cardId = provider === 'claude-code' ? '#cli-claude' : provider === 'codex' ? '#cli-codex' : '#card-ollama';
  const card = $(cardId);
  const host = $('.test-result', card) || $(`[data-result="${provider}"]`);
  const collapse = host.closest('.collapse');
  host.replaceChildren();
  const box = el('div', 'result-box');
  const head = el('div', 'result-head');
  head.innerHTML = icon('sparkles', 16);
  head.append(el('span', '', 'Připravuji ukázkové shrnutí…'));
  box.append(head, el('div', 'skeleton'), el('div', 'skeleton'));
  $$('.skeleton', box)[1].style.width = '70%';
  host.append(box);
  if (collapse) collapse.classList.add('open');
  const r = await api.testProvider(provider);
  host.replaceChildren();
  const res = el('div', `result-box ${r.ok ? 'ok' : 'bad'}`);
  const h = el('div', 'result-head');
  h.innerHTML = icon(r.ok ? 'check' : 'alert', 16);
  h.append(el('span', '', r.ok ? 'Funguje' : 'Test se nepodařil'));
  if (r.ok) h.append(el('span', 'meta', `${(r.ms / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} s · ${r.model}`));
  res.append(h);
  if (r.ok) {
    res.append(el('div', 'result-title', r.notes.title));
    const ul = el('ul', 'result-list');
    r.notes.summary.forEach((line, i) => {
      const li = el('li', '', line);
      li.style.setProperty('--i', i);
      ul.append(li);
    });
    res.append(ul);
  } else {
    res.append(el('div', 'result-error', r.error));
  }
  host.append(res);
}

function renderPlanLine() {
  const plan = (store.local && store.local.summaryPlan) || [];
  const line = $('#plan-line');
  line.classList.toggle('none', !plan.length);
  const text = $('#plan-text');
  text.replaceChildren();
  if (!plan.length) {
    text.textContent = store.settings.summary.provider === 'none' ? 'Shrnutí je vypnuté, uloží se jen přepis.' : 'Žádný poskytovatel není k dispozici. Přihlaste se níže do Claude Code nebo Codexu.';
    return;
  }
  text.append('Shrnutí napíše ', el('b', '', plan[0]));
  if (plan[1]) text.append(', při chybě ', el('b', '', plan[1]));
  text.append('.');
}

// ── Local tools: whisper, Ollama ─────────────────────────────────────────
const MODEL_INFO = {
  tiny: { name: 'Tiny', speed: 1, acc: 0.3 },
  base: { name: 'Base', speed: 0.9, acc: 0.45 },
  small: { name: 'Small', speed: 0.72, acc: 0.62 },
  'medium-q5_0': { name: 'Medium Q5', speed: 0.58, acc: 0.78 },
  medium: { name: 'Medium', speed: 0.46, acc: 0.8, rec: true },
  'large-v3-turbo-q5_0': { name: 'Large v3 Turbo Q5', speed: 0.52, acc: 0.88 },
  'large-v3-turbo': { name: 'Large v3 Turbo', speed: 0.44, acc: 0.9 },
  'large-v3': { name: 'Large v3', speed: 0.2, acc: 0.95 },
};
const sizeLabel = (mb) => (mb >= 1000 ? `${(mb / 1000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} GB` : `${mb} MB`);
let whisperVariant = 'cpu';

async function refreshLocal() {
  try {
    store.local = await api.localStatus();
  } catch {
    return;
  }
  const l = store.local;
  const w = l.whisper;
  const pill = $('#whisper-status');
  pill.className = `status-pill ${w.ok ? 'ok' : 'warn'}`;
  pill.innerHTML = '<span class="dot"></span>';
  pill.append(el('span', '', w.ok ? 'Připraveno' : !w.bin ? 'Nenainstalováno' : 'Chybí model'));
  $('#whisper-path').textContent = w.bin ? w.bin : 'whisper.cpp zatím není nainstalovaný.';
  const ib = $('#install-binary');
  ib.lastChild.textContent = w.bin ? 'Přeinstalovat whisper.cpp' : IS_MAC ? 'Nainstalovat přes Homebrew' : 'Nainstalovat whisper.cpp';
  ib.className = `btn ${w.bin ? 'btn-ghost' : 'btn-primary'}`;
  renderModelGrid();
  const op = $('#ollama-status');
  op.className = `status-pill ${l.ollama.reachable ? 'ok' : ''}`;
  op.innerHTML = '<span class="dot"></span>';
  op.append(el('span', '', l.ollama.reachable ? 'Běží' : 'Neběží'));
  ollamaSelect.render();
  renderPlanLine();
  Object.keys(CLI_UI).forEach((id) => {
    const card = $(`#cli-${id}`);
    const def = store.meta.clis[id];
    if (!card) return;
    $('.primary-tag', card).hidden = l.summaryPlan[0] !== def.label;
    card.classList.toggle('is-primary', l.summaryPlan[0] === def.label);
  });
}

function renderModelGrid() {
  const grid = $('#model-grid');
  const current = store.settings.transcription.whisperModel;
  const downloaded = (store.local && store.local.downloaded) || [];
  grid.replaceChildren();
  Object.entries(store.meta.whisperModels).forEach(([name, mb], i) => {
    const info = MODEL_INFO[name] || { name, speed: 0.5, acc: 0.5 };
    const card = el('button', `model-card${name === current ? ' selected' : ''}`);
    card.type = 'button';
    card.style.setProperty('--i', i);
    const flags = el('div', 'model-flags');
    if (info.rec) flags.append(el('span', 'model-flag rec', 'Doporučeno'));
    if (downloaded.includes(name)) flags.append(el('span', 'model-flag have', 'Staženo'));
    card.append(el('div', 'model-name', info.name), el('div', 'model-size', sizeLabel(mb)), flags);
    const bars = el('div', 'model-bars');
    for (const [label, v] of [['Rychlost', info.speed], ['Přesnost', info.acc]]) {
      const row = el('div', 'model-bar');
      const track = el('span', 'track');
      const fill = el('span', 'fill');
      fill.style.setProperty('--v', v);
      track.append(fill);
      row.append(el('span', '', label), track);
      bars.append(row);
    }
    card.append(bars);
    if (name === current && !downloaded.includes(name)) {
      const dl = el('div', 'model-download');
      const b = el('span', 'btn btn-primary btn-sm');
      b.innerHTML = icon('download', 15);
      b.append(el('span', '', `Stáhnout · ${sizeLabel(mb)}`));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        installWhisper({ what: 'model', model: name });
      });
      dl.append(b);
      card.append(dl);
    }
    card.addEventListener('click', async () => {
      if (name === store.settings.transcription.whisperModel) return;
      await save('transcription.whisperModel', name);
      renderModelGrid();
      refreshLocal();
    });
    grid.append(card);
  });
}

async function installWhisper(opts) {
  const block = $('#setup-progress');
  block.hidden = false;
  $('.progress', block).classList.add('indeterminate');
  $('#setup-label').textContent = 'Připravuji…';
  $('#setup-value').textContent = '';
  const r = await api.installWhisper({ variant: whisperVariant, ...opts });
  $('.progress', block).classList.remove('indeterminate');
  if (r.ok) {
    $('.progress-fill', block).style.setProperty('--p', 1);
    $('#setup-label').textContent = 'Hotovo';
    toast(opts.what === 'model' ? 'Model je stažený' : 'whisper.cpp je nainstalovaný');
    setTimeout(() => (block.hidden = true), 2200);
  } else {
    $('#setup-label').textContent = `Nepodařilo se: ${r.error}`;
    toast('Instalace se nepodařila', 'error');
  }
  refreshLocal();
}

api.on('setup:progress', ({ received, total, label, log }) => {
  const block = $('#setup-progress');
  block.hidden = false;
  if (log) {
    $('#setup-label').textContent = log;
    return;
  }
  const bar = $('.progress', block);
  bar.classList.toggle('indeterminate', !total);
  if (total) $('.progress-fill', block).style.setProperty('--p', received / total);
  $('#setup-label').textContent = label;
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  $('#setup-value').textContent = total ? `${mb(received)} z ${mb(total)} · ${Math.round((received / total) * 100)} %` : mb(received);
});

let ollamaSelect = { render() {} };

// ── Settings bindings ──────────────────────────────────────────────────────
function bindInputs() {
  for (const input of $$('[data-setting]')) {
    const p = input.dataset.setting;
    input.value = getPath(store.settings, p) || '';
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v === (getPath(store.settings, p) || '')) return;
      save(p, v, { quiet: false });
    });
  }
  for (const btn of $$('[data-toggle]')) {
    const key = btn.dataset.toggle;
    setToggle(btn, getPath(store.settings, key));
    btn.addEventListener('click', () => {
      const on = !btn.classList.contains('on');
      setToggle(btn, on);
      save(key, on);
    });
  }
}

function onSettingsChanged(path) {
  if (path.startsWith('summary') || path.startsWith('transcription') || path === 'experimental') refreshLocalSoon();
  if (path === 'micDeviceId' || path === 'outputDeviceId' || path === 'globalShortcut' || path.startsWith('transcription') || path === 'notesLanguage') {
    renderHome();
    renderDeviceLists();
  }
  if (path === 'notesDir') {
    $('#notes-dir-text').textContent = store.settings.notesDir;
    refreshNotes();
  }
}

let localTimer = null;
function refreshLocalSoon() {
  clearTimeout(localTimer);
  localTimer = setTimeout(refreshLocal, 250);
}

function buildSettings() {
  segmented($('#seg-provider'), [
    { value: 'auto', label: 'Automaticky', icon: 'sparkles' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'none', label: 'Vypnuto' },
  ], store.settings.summary.provider, (v) => save('summary.provider', v));
  segmented($('#seg-fallback'), [
    { value: 'none', label: 'Nic' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'claude-code', label: 'Claude Code' },
    { value: 'codex', label: 'Codex' },
  ], store.settings.summary.fallback, (v) => save('summary.fallback', v));
  segmented($('#seg-variant'), [
    { value: 'cpu', label: 'CPU' },
    { value: 'blas', label: 'OpenBLAS' },
    { value: 'cuda', label: 'NVIDIA CUDA' },
  ], whisperVariant, (v) => (whisperVariant = v));
  segmented($('#seg-theme'), [
    { value: 'system', label: 'Systém', icon: 'monitor' },
    { value: 'dark', label: 'Tmavý', icon: 'moon' },
    { value: 'light', label: 'Světlý', icon: 'sun' },
  ], store.settings.theme || 'system', (v) => save('theme', v));
  segmented($('#seg-mac-capture'), [
    { value: 'screen-capture', label: 'Nahrávání obrazovky' },
    { value: 'coreaudio-tap', label: 'Core Audio (macOS 14.2+)' },
  ], store.settings.macSystemAudio, (v) => save('macSystemAudio', v).then(() => toast('Projeví se po restartu BRecord')));
  segmented($('#seg-note-editor'), [
    { value: 'pilcrow', label: 'Pilcrow' },
    { value: 'system', label: 'Výchozí aplikace' },
  ], store.settings.noteEditor || 'pilcrow', (v) => save('noteEditor', v).then(refreshEditor));
  segmented($('#notes-filter'), [
    { value: 'all', label: 'Vše' },
    { value: 'actions', label: 'S úkoly' },
    { value: 'issues', label: 'K vyřešení' },
  ], notesFilter, (v) => {
    notesFilter = v;
    renderNotes();
  });

  selectControl($('#sel-language'), {
    header: 'Jazyk schůzky',
    options: () => LANGS.map(([value, label]) => ({ value, label: value === 'auto' ? 'Rozpoznat automaticky' : label })),
    get: () => store.settings.transcription.language || 'auto',
    set: (v) => save('transcription.language', v),
  });
  selectControl($('#sel-notes-language'), {
    header: 'Jazyk poznámek',
    options: () => NOTE_LANGS.map(([value, label]) => ({ value, label })),
    get: () => store.settings.notesLanguage || 'cs',
    set: (v) => save('notesLanguage', v),
  });
  ollamaSelect = selectControl($('#ollama-model'), {
    header: 'Model Ollama',
    options: () => [{ value: '', label: 'První nainstalovaný model' }, ...((store.local && store.local.ollama.models) || []).map((m) => ({ value: m, label: m }))],
    get: () => store.settings.summary.ollama.model || '',
    set: (v) => save('summary.ollama.model', v),
  });

  // Threads stepper
  const renderThreads = () => {
    const t = store.settings.transcription.threads || 0;
    $('#threads-value').textContent = t ? String(t) : 'Auto';
  };
  for (const b of $$('#threads-stepper .stepper-btn')) {
    b.addEventListener('click', () => {
      const t = clamp((store.settings.transcription.threads || 0) + Number(b.dataset.step), 0, 32);
      save('transcription.threads', t).then(renderThreads);
    });
  }
  renderThreads();

  $('#install-binary').addEventListener('click', () => installWhisper({ what: 'binary' }));
  $('#refresh-devices').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.classList.add('is-loading');
    applyState(await api.refreshDevices());
    b.classList.remove('is-loading');
    toast('Seznam zařízení obnoven');
  });

  // General
  $('#notes-dir-text').textContent = store.settings.notesDir;
  $('#choose-notes').addEventListener('click', async () => {
    const dir = await api.chooseFolder(store.settings.notesDir);
    if (dir) await save('notesDir', dir, { quiet: false });
  });
  $('#open-notes').addEventListener('click', () => api.openNotesFolder());
  const kbd = $('#shortcut-kbd');
  const keys = IS_MAC ? ['⌘', '⌥', 'R'] : ['Ctrl', 'Alt', 'R'];
  kbd.replaceWith(...keys.flatMap((k, i) => (i ? [' + ', el('kbd', '', k)] : [el('kbd', '', k)])));
  const li = $('#login-item');
  setToggle(li, store.meta.openAtLogin);
  li.disabled = !store.meta.packaged;
  if (!store.meta.packaged) $('#login-item-hint').textContent = 'Dostupné v nainstalované verzi BRecord.';
  li.addEventListener('click', async () => setToggle(li, await api.setLoginItem(!li.classList.contains('on'))));
  const facts = $('#paths');
  for (const [k, v] of [['Nastavení', store.meta.paths.settings], ['Data aplikace', store.meta.paths.home], ['Verze', `BRecord ${store.meta.version}`]]) {
    facts.append(el('dt', '', k), el('dd', '', v));
  }
  $('#quit-app').addEventListener('click', () => api.quit());

  for (const b of $$('[data-test]')) b.addEventListener('click', () => runTest(b.dataset.test));
}

// ── Onboarding ──────────────────────────────────────────────────────────
let obStep = 0;

function showOnboarding(step = 0) {
  $('#onboarding').hidden = false;
  $('#onboarding').classList.remove('leaving');
  obGo(step);
}

function obGo(i) {
  const prev = obStep;
  obStep = i;
  $('#ob-track').style.transform = `translateX(${-i * 100}%)`;
  $$('.ob-step').forEach((s, n) => s.classList.toggle('current', n === i));
  fitOnboarding();
  $$('#ob-progress span').forEach((s, n) => {
    s.classList.toggle('active', n === i);
    s.classList.toggle('done', n < i);
  });
  if (i === 1) renderObPermission();
  if (i === 2) {
    renderDeviceLists();
    api.refreshDevices().then((s) => {
      applyState(s);
      fitOnboarding();
    });
    monitor('onboarding', true);
    registerMeter($('#meter-ob'), 'mic');
  } else if (prev === 2) {
    monitor('onboarding', false);
  }
  if (i === 3) renderObCli();
}

// The viewport takes the height of the current step (steps differ in height).
function fitOnboarding() {
  requestAnimationFrame(() => {
    const step = $$('.ob-step')[obStep];
    if (step) $('.ob-viewport').style.height = `${step.offsetHeight}px`;
  });
}

function renderObPermission(result) {
  const granted = store.perms.microphone === 'granted' || (result && result.granted);
  const denied = result ? !result.granted : store.perms.microphone === 'denied';
  const iconBox = $('#ob-perm-icon');
  iconBox.classList.toggle('ok', granted);
  iconBox.classList.toggle('bad', !granted && denied && !!result);
  const svg = iconBox.querySelector('svg');
  if (svg) svg.outerHTML = icon(granted ? 'check' : !granted && result ? 'micOff' : 'mic', 40);
  const res = $('#ob-perm-result');
  res.replaceChildren();
  const btn = $('#ob-mic-btn');
  $('#ob-skip').hidden = !!granted;
  if (granted) {
    res.innerHTML = icon('check', 16);
    res.append(el('span', '', result && result.label ? `Mikrofon je povolený (${result.label}).` : 'Mikrofon je povolený.'));
    btn.innerHTML = '';
    btn.append(el('span', '', 'Pokračovat'));
    btn.insertAdjacentHTML('beforeend', icon('chevronRight', 16));
    btn.dataset.mode = 'next';
  } else if (result) {
    res.innerHTML = icon('alert', 16);
    res.append(el('span', '', `${result.error ? `Nepodařilo se: ${result.error}. ` : ''}Povolte BRecord v nastavení soukromí a zkuste to znovu.`));
    btn.innerHTML = icon('external', 16);
    btn.append(el('span', '', 'Otevřít nastavení'));
    btn.dataset.mode = 'settings';
    btn.dataset.url = result.settingsUrl || '';
  }
  fitOnboarding();
}

function renderObCli() {
  const host = $('#ob-cli');
  if (!host) return;
  host.replaceChildren();
  for (const id of Object.keys(CLI_UI)) {
    const ui = CLI_UI[id];
    const s = store.cli[id];
    const c = el('div', 'ob-cli-card');
    const tile = el('span', `logo-tile ${ui.tile}`);
    tile.innerHTML = icon(ui.iconName, 22);
    const pill = el('span', `status-pill ${!s ? 'checking' : s.loggedIn ? 'ok' : s.installed ? 'warn' : 'bad'}`);
    pill.innerHTML = '<span class="dot"></span>';
    pill.append(el('span', 'st', !s ? 'Zjišťuji' : s.loggedIn ? 'Přihlášeno' : s.installed ? 'Nepřihlášeno' : 'Nenainstalováno'));
    c.append(tile, el('b', '', ui.title), pill);
    if (s && s.installed && !s.loggedIn) {
      const b = el('button', 'btn btn-soft btn-sm', 'Přihlásit se');
      b.addEventListener('click', () => {
        finishOnboarding().then(() => {
          go('ai');
          openLogin(id);
        });
      });
      c.append(b);
    }
    host.append(c);
  }
  fitOnboarding();
}

async function finishOnboarding() {
  monitor('onboarding', false);
  await save('onboarded', true);
  const ob = $('#onboarding');
  ob.classList.add('leaving');
  await new Promise((r) => setTimeout(r, 360));
  ob.hidden = true;
  ob.classList.remove('leaving');
  maybeOfferUpdate();
}

function bindOnboarding() {
  for (const b of $$('[data-ob-next]')) b.addEventListener('click', () => obGo(Math.min(obStep + 1, 3)));
  $('#ob-mic-btn').addEventListener('click', async () => {
    const btn = $('#ob-mic-btn');
    if (btn.dataset.mode === 'next') return obGo(2);
    if (btn.dataset.mode === 'settings' && btn.dataset.url) {
      api.openUrl(btn.dataset.url);
      btn.dataset.mode = '';
      btn.innerHTML = icon('refresh', 16);
      btn.append(el('span', '', 'Zkusit znovu'));
      return;
    }
    btn.disabled = true;
    btn.classList.add('is-loading');
    const r = await api.requestMicrophone();
    btn.disabled = false;
    btn.classList.remove('is-loading');
    store.perms = await api.permissions();
    renderObPermission(r);
    renderHome();
  });
  $('#ob-finish').addEventListener('click', finishOnboarding);
}

// ── Update offer ─────────────────────────────────────────────────────────
// A downloaded version (or, where BRecord can't replace itself, an announced
// one) is offered once per launch, as soon as the window is on screen and no
// meeting is being recorded or processed. "Později" leaves it to the
// installer that runs when BRecord quits.
const offer = { version: null, dismissed: null, installWhenReady: false, closing: null };

function maybeOfferUpdate() {
  const s = store.state;
  const u = s && s.update;
  if (offer.version) return renderUpdateOffer();
  if (!u || !u.version || (u.status !== 'ready' && u.status !== 'available')) return;
  if (offer.dismissed === u.version || document.visibilityState !== 'visible' || !$('#onboarding').hidden) return;
  if (s.phase !== 'idle' || s.jobs.length) return;
  openUpdateOffer(u.version);
}

function openUpdateOffer(version) {
  closePopover();
  clearTimeout(offer.closing);
  offer.version = version;
  offer.installWhenReady = false;
  const layer = $('#update-offer');
  layer.classList.remove('leaving');
  layer.hidden = false;
  renderUpdateOffer();
  $('#offer-primary').focus({ preventScroll: true });
}

function closeUpdateOffer() {
  if (!offer.version) return;
  offer.dismissed = offer.version;
  offer.version = null;
  const layer = $('#update-offer');
  layer.classList.add('leaving');
  offer.closing = setTimeout(() => {
    layer.hidden = true;
    layer.classList.remove('leaving');
  }, 300);
}

// Release notes arrive as plain lines: "• item" bullets under section names.
function notesList(text) {
  const box = el('div', 'offer-notes');
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let list = null;
  lines.forEach((line, i) => {
    if (line.startsWith('• ')) {
      if (!list) box.append((list = el('ul')));
      list.append(el('li', '', line.slice(2)));
      return;
    }
    list = null;
    const heading = (lines[i + 1] || '').startsWith('• ');
    box.append(el(heading ? 'div' : 'p', heading ? 'offer-notes-head' : 'offer-notes-text', line));
  });
  if (!box.childNodes.length) box.append(el('div', 'offer-notes-empty', 'K této verzi nejsou poznámky.'));
  return box;
}

function renderUpdateOffer() {
  const u = store.state.update;
  if (!offer.version || !u) return;
  if (!['available', 'downloading', 'ready', 'error'].includes(u.status)) return closeUpdateOffer();
  const busy = store.state.phase !== 'idle' || store.state.jobs.length > 0;
  const manual = u.mode === 'manual';
  if (u.status === 'ready' && offer.installWhenReady && !busy) {
    offer.installWhenReady = false;
    installFromOffer();
  }

  $('#offer-title').textContent = u.status === 'ready' ? `BRecord ${u.version} je připravený` : `Je tu BRecord ${u.version}`;
  $('#offer-sub').textContent = `Teď máte ${u.current}.`;
  const text = {
    ready: 'Nová verze je stažená. Instalace trvá pár sekund a BRecord se pak sám znovu otevře.',
    downloading: 'Stahuji novou verzi. Až bude hotovo, nainstaluje se sama.',
    available: manual
      ? IS_MAC
        ? 'Na macOS ji stáhnete ze stránky vydání. Aplikace není podepsaná certifikátem Apple, proto se nemůže nahradit sama.'
        : 'Balíček .deb aktualizuje správce balíčků. Novou verzi stáhnete ze stránky vydání.'
      : 'Stáhne se na pozadí a pak se sama nainstaluje.',
    error: `Stažení se nepodařilo: ${u.error || 'neznámá chyba'}`,
  }[u.status];
  $('#offer-text').textContent = text;

  const progress = $('#offer-progress');
  progress.hidden = u.status !== 'downloading';
  $('.progress-fill', progress).style.setProperty('--p', u.progress || 0);
  $('#offer-progress-text').textContent = `Stahuji ${Math.round((u.progress || 0) * 100)} %`;

  const notes = $('#offer-notes');
  if (notes.dataset.version !== u.version) {
    notes.dataset.version = u.version;
    notes.replaceChildren(notesList(u.notes));
  }

  const primary = $('#offer-primary');
  primary.classList.remove('is-loading');
  primary.disabled = false;
  let label;
  let iconName;
  if (u.status === 'ready') {
    [label, iconName] = busy ? ['Po skončení nahrávání', 'clock'] : ['Nainstalovat a restartovat', 'refresh'];
    primary.disabled = busy;
  } else if (u.status === 'downloading') {
    [label, iconName] = ['Stahuji…', 'download'];
    primary.disabled = true;
    primary.classList.add('is-loading');
  } else if (manual) {
    [label, iconName] = ['Stáhnout ze stránky vydání', 'external'];
  } else {
    [label, iconName] = [u.status === 'error' ? 'Zkusit znovu' : 'Stáhnout a nainstalovat', 'download'];
  }
  primary.innerHTML = icon(iconName, 16);
  primary.append(el('span', '', label));
  $('#offer-later-hint').textContent = manual ? '' : 'Když zvolíte Později, nainstaluje se při ukončení BRecord.';
}

async function installFromOffer() {
  const primary = $('#offer-primary');
  primary.disabled = true;
  primary.classList.add('is-loading');
  const r = await api.installUpdate();
  if (r && r.ok === false) {
    toast(r.reason, 'error');
    renderUpdateOffer();
  }
}

function bindUpdateOffer() {
  $('#offer-primary').addEventListener('click', async () => {
    const u = store.state.update;
    if (u.status === 'ready') return installFromOffer();
    if (u.mode === 'manual') {
      api.openRelease(u.releaseUrl);
      return closeUpdateOffer();
    }
    offer.installWhenReady = true;
    await api.downloadUpdate();
  });
  $('#offer-later').addEventListener('click', closeUpdateOffer);
  $('#update-offer .offer-backdrop').addEventListener('click', closeUpdateOffer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && offer.version && !e.defaultPrevented) {
      e.preventDefault();
      closeUpdateOffer();
    }
  });
  document.addEventListener('visibilitychange', maybeOfferUpdate);
}

// ── Debug scenes (screenshots only) ─────────────────────────────────────
function installDebug() {
  window.__brecord = {
    scene(name) {
      clearInterval(fakeTimer);
      closePopover();
      if (name.startsWith('onboarding')) {
        showOnboarding(Number(name.split('-')[1]) || 0);
        return;
      }
      $('#onboarding').hidden = true;
      closeNoteSheet();
      if (name === 'notes-tasks' || name === 'notes-issue' || name === 'notes-speakers') {
        go('notes');
        refreshNotes().then(() => {
          const n = name === 'notes-speakers' ? store.notes[0] : store.notes.find((x) => (name === 'notes-issue' ? ISSUES[x.status] : x.tasksTotal));
          if (n) openNoteSheet(n, { 'notes-tasks': 'tasks', 'notes-issue': 'issues', 'notes-speakers': 'speakers' }[name]);
        });
        return;
      }
      if (name === 'update-offer') {
        offer.dismissed = null;
        applyState({
          ...store.state,
          phase: 'idle',
          jobs: [],
          update: { mode: 'auto', status: 'ready', current: store.meta.version, version: '9.9.9', progress: 1, checkedAt: Date.now(), releaseUrl: '', notes: 'Poznámky\n\n• Úkoly k odškrtání přímo v aplikaci.\n• Poznámky se otevírají v Pilcrow.\n\nOpravy\n\n• Plynulý ukazatel průběhu zpracování.' },
        });
        return;
      }
      closeUpdateOffer();
      if (name === 'general-update') {
        offer.dismissed = '9.9.9';
        applyState({
          ...store.state,
          phase: 'idle',
          jobs: [],
          update: { mode: 'auto', status: 'ready', current: store.meta.version, version: '9.9.9', progress: 1, checkedAt: Date.now(), releaseUrl: '', notes: 'Přidáno\n\n• Ukázková položka poznámek k vydání.\n• Druhá položka.' },
        });
        go('general');
        setTimeout(() => {
          const card = $('#update-card');
          card.closest('.page').scrollTop = card.offsetTop - 120; // scroll the page only, not the window
        }, 300);
        return;
      }
      if (name === 'home' || name === 'home-mic' || name === 'home-recording' || name === 'home-processing') {
        go('home');
        if (name === 'home-mic') setTimeout(() => openDevicePicker('mic'), 400);
        if (name === 'home-recording' || name === 'home-processing') {
          applyState({ ...store.state, phase: 'recording', startedAt: Date.now() - 754000, jobs: [
            { id: 'a', name: '2026-09-26-1402', type: 'process', stage: 'transcribing', progress: 0.94, text: 'Přepisuji 94 %' },
            { id: 'b', name: '2026-09-26-1115', type: 'resummarize', stage: 'summarizing', progress: 0, text: 'Sepisuji shrnutí přes Claude Code…' },
            { id: 'c', name: '2026-09-26-0930', type: 'process', stage: 'queued', progress: 0, text: 'Ve frontě' },
          ] });
          fakeTimer = setInterval(() => {
            levels.micT = Math.random() * 0.5;
            levels.sysT = Math.random() * 0.35;
            levels.lastEvent = performance.now();
            ensureLevelLoop();
          }, 50);
          if (name === 'home-processing') {
            setTimeout(() => {
              const card = $('#jobs-card');
              card.closest('.page').scrollTop = card.offsetTop - 80;
            }, 300);
          }
        } else {
          applyState({ ...store.state, phase: 'idle', startedAt: null, jobs: [] });
        }
        return;
      }
      go(name);
    },
  };
}

// ── Updates ─────────────────────────────────────────────────────────────────
function renderUpdate(u) {
  if (!u) return;
  const status = $('#update-status');
  const [text, kind] = {
    unsupported: ['Vývojová verze', ''],
    idle: ['Aktuální', 'ok'],
    current: ['Aktuální', 'ok'],
    checking: ['Kontroluji…', 'checking'],
    available: [`Nová verze ${u.version}`, 'warn'],
    downloading: [`Stahuji ${Math.round((u.progress || 0) * 100)} %`, 'checking'],
    ready: ['Připraveno k instalaci', 'ok'],
    error: ['Kontrola selhala', 'bad'],
  }[u.status] || ['—', ''];
  status.className = `status-pill ${kind}`;
  $('.st', status).textContent = text;
  const checked = u.checkedAt ? ` · zkontrolováno ${fmtTime(u.checkedAt)}` : '';
  $('#update-sub').textContent = `Nainstalovaná verze ${store.meta.version}${checked}`;

  const body = $('#update-body');
  body.replaceChildren();
  const actions = el('div', 'actions');
  const recording = store.state && store.state.phase !== 'idle';
  if (u.status === 'unsupported') {
    body.append(el('p', 'update-error', 'Aktualizace fungují v nainstalované verzi. Tahle běží ze zdrojového kódu.'));
  }
  if (u.status === 'downloading') {
    const bar = el('div', 'progress');
    const fill = el('div', 'progress-fill');
    fill.style.setProperty('--p', u.progress || 0);
    bar.append(fill);
    body.append(bar);
  }
  if ((u.status === 'available' || u.status === 'ready' || u.status === 'downloading') && u.version) {
    body.append(el('div', 'update-notes-title', `Co je nového v ${u.version}`));
    body.append(el('div', 'update-notes', u.notes || 'K této verzi nejsou poznámky.'));
  }
  if (u.status === 'error' && u.error) body.append(el('p', 'update-error', `Nepodařilo se spojit s GitHubem: ${u.error}`));

  if (u.status === 'ready') {
    const b = addAction(actions, recording ? 'Nainstaluje se po nahrávání' : 'Restartovat a nainstalovat', 'refresh', async () => {
      const r = await api.installUpdate();
      if (r && r.ok === false) toast(r.reason, 'error');
    }, 'btn btn-primary');
    b.disabled = recording;
  } else if (u.status === 'available') {
    if (u.mode === 'auto') addAction(actions, 'Stáhnout a nainstalovat', 'download', () => api.downloadUpdate(), 'btn btn-primary');
    else addAction(actions, 'Stáhnout ze stránky vydání', 'external', () => api.openRelease(u.releaseUrl), 'btn btn-primary');
  }
  if (u.status !== 'unsupported' && u.status !== 'downloading' && u.status !== 'ready') {
    const b = addAction(actions, 'Zkontrolovat aktualizace', 'refresh', async () => {
      b.classList.add('is-loading');
      const r = await api.checkUpdate();
      b.classList.remove('is-loading');
      if (r && r.status === 'current') toast('Máte nejnovější verzi');
    }, 'btn btn-soft');
    b.disabled = u.status === 'checking';
  }
  if (actions.children.length) body.append(actions);

  const autoField = $('#auto-update-field');
  const manual = u.mode === 'manual';
  $('#auto-update-hint').textContent = manual
    ? (IS_MAC ? 'Na macOS se nová verze stahuje ze stránky vydání (aplikace není podepsaná certifikátem Apple).' : 'Balíček .deb aktualizuje správce balíčků; BRecord vás na novou verzi upozorní.')
    : 'Nová verze se stáhne na pozadí a BRecord vám ji nabídne k instalaci. Jinak se nainstaluje při ukončení.';
  $('button', autoField).disabled = manual;

  const chip = $('#update-chip');
  const showChip = u.status === 'ready' || (u.status === 'available' && (manual || store.settings.autoUpdate === false));
  chip.hidden = !showChip;
  if (showChip) {
    $('#update-chip-title').textContent = `BRecord ${u.version}`;
    $('#update-chip-sub').textContent = u.status === 'ready' ? 'Restartovat a nainstalovat' : manual ? 'Stáhnout novou verzi' : 'Stáhnout aktualizaci';
  }
}

function renderAbout() {
  const line = $('#about-line');
  line.replaceChildren();
  const parts = [`BRecord ${store.meta.version}`, store.meta.copyright, 'Licence MIT'];
  parts.forEach((p, i) => {
    if (i) line.append(el('span', 'sep'));
    line.append(el('span', '', p));
  });
  line.append(el('span', 'sep'));
  const gh = el('button', '', 'GitHub');
  gh.addEventListener('click', () => api.openUrl(store.meta.releasesUrl.replace(/\/releases$/, '')));
  line.append(gh);
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  hydrateIcons();
  for (const mark of $$('.brand-mark')) mark.innerHTML = LOGO_SVG;
  document.body.classList.add(`platform-${api.platform}`);
  store.meta = await api.getState();
  store.settings = store.meta.settings;
  store.state = store.meta.state;
  store.perms = store.meta.permissions;
  store.debug = store.meta.debug;
  $('#app-version').textContent = `BRecord ${store.meta.version}`;

  for (const s of $$('.stagger')) [...s.children].forEach((c, i) => c.style.setProperty('--i', i));

  for (const item of $$('.nav-item')) item.addEventListener('click', () => go(item.dataset.page));
  for (const link of $$('[data-go]')) link.addEventListener('click', (e) => {
    e.preventDefault();
    go(link.dataset.go);
  });
  $('#mini-rec').addEventListener('click', () => go('home'));
  $('#update-chip').addEventListener('click', async () => {
    const u = store.state.update;
    if (u.status === 'ready' && store.state.phase === 'idle') {
      const r = await api.installUpdate();
      if (r && r.ok === false) toast(r.reason, 'error');
    } else if (u.status === 'available' && u.mode === 'manual') api.openRelease(u.releaseUrl);
    else go('general');
  });
  renderAbout();
  $('#rec-btn').addEventListener('click', () => {
    $('#hero').classList.add('is-busy');
    api.toggleRecording();
  });
  $('#pill-mic').addEventListener('click', () => openDevicePicker('mic'));
  $('#pill-out').addEventListener('click', () => openDevicePicker('out'));
  $('#chip-ai').addEventListener('click', () => go('ai'));
  $('#chip-model').addEventListener('click', () => go('transcription'));
  $('#chip-lang').addEventListener('click', () =>
    listPopover($('#chip-lang'), { header: 'Jazyk schůzky', items: LANGS.map(([value, label]) => ({ value, label: value === 'auto' ? 'Rozpoznat automaticky' : label })), value: store.settings.transcription.language || 'auto', width: 250, onSelect: (v) => save('transcription.language', v) }),
  );
  $('#chip-notes-lang').addEventListener('click', () =>
    listPopover($('#chip-notes-lang'), { header: 'Jazyk poznámek', items: NOTE_LANGS.map(([value, label]) => ({ value, label })), value: store.settings.notesLanguage || 'cs', width: 250, align: 'end', onSelect: (v) => save('notesLanguage', v) }),
  );
  $('#notes-search').addEventListener('input', renderNotes);
  initNoteSheet();
  bindUpdateOffer();
  // Back from Pilcrow or another editor: pick up what changed in the notes.
  window.addEventListener('focus', () => {
    if (store.page === 'notes' || store.page === 'home' || sheet.note) refreshNotes();
  });

  buildSettings();
  bindInputs();
  buildCliCards();
  bindOnboarding();
  registerMeter($('#meter-mic'), 'mic');
  registerMeter($('#meter-out'), 'sys');
  registerMeter($('#meter-audio'), 'mic');
  computeColors();

  go('home');
  $('#nav-indicator').style.transition = 'none';
  requestAnimationFrame(() => ($('#nav-indicator').style.transition = ''));
  applyState(store.state);
  renderPermissions();
  renderNotes();
  refreshNotes();
  refreshCli(false);
  refreshLocal();
  refreshEditor();
  refreshVoices();

  api.on('state', applyState);
  api.on('settings', (s) => {
    store.settings = s;
    renderHome();
    renderDeviceLists();
  });
  api.on('navigate', (page) => {
    if (!$('#onboarding').hidden && store.settings.onboarded) $('#onboarding').hidden = true;
    go(page);
  });
  api.on('toast', (t) => toast(t.text, t.kind));
  api.on('notes:changed', refreshNotes);

  if (store.debug) installDebug();
  if (!store.settings.onboarded && !store.debug) showOnboarding(0);
}

init();
