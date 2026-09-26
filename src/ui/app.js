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

  // Jobs
  const card = $('#jobs-card');
  card.hidden = !s.jobs.length && !s.task;
  const host = $('#jobs');
  host.replaceChildren();
  for (const job of s.jobs) host.append(renderJob(job));
  if (s.task) {
    const row = el('div', 'job');
    const ic = el('span', 'job-icon');
    ic.innerHTML = icon('download', 20);
    const main = el('div');
    main.append(el('div', 'job-name', s.task));
    const bar = el('div', 'progress indeterminate');
    bar.append(el('div', 'progress-fill'));
    main.append(bar);
    row.append(ic, main, el('span'));
    host.append(row);
  }
}

function renderJob(job) {
  const row = el('div', 'job');
  const ic = el('span', `job-icon${job.stage === 'queued' ? ' queued' : ''}`);
  ic.innerHTML = icon(job.stage === 'summarizing' ? 'sparkles' : job.type === 'resummarize' ? 'redo' : 'wave', 20);
  const main = el('div');
  main.append(el('div', 'job-name', job.name));
  main.append(el('div', 'job-text', job.text));
  const bar = el('div', `progress${job.stage === 'summarizing' || (job.stage === 'transcribing' && !job.progress) ? ' indeterminate' : ''}`);
  const fill = el('div', 'progress-fill');
  fill.style.setProperty('--p', job.stage === 'transcribing' ? job.progress : job.stage === 'queued' ? 0 : 1);
  bar.append(fill);
  main.append(bar);
  const steps = el('div', 'job-steps');
  const order = job.type === 'resummarize' ? ['summarizing'] : ['transcribing', 'summarizing'];
  const names = { transcribing: 'Přepis', summarizing: 'Shrnutí' };
  order.forEach((st, i) => {
    if (i) steps.append(el('span', 'job-sep'));
    const idx = order.indexOf(job.stage);
    steps.append(el('span', `job-step${st === job.stage ? ' active' : idx > i ? ' done' : ''}`, names[st]));
  });
  row.append(ic, main, steps);
  return row;
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
}

const STATUS = {
  ok: { icon: 'notes', cls: '', badge: null },
  'transcript-only': { icon: 'notes', cls: 'plain', badge: { text: 'Jen přepis', cls: '' } },
  pending: { icon: 'clock', cls: 'warn', badge: { text: 'Připravuje se', cls: 'warn' } },
  'summary-failed': { icon: 'alert', cls: 'bad', badge: { text: 'Shrnutí selhalo', cls: 'bad' } },
  'transcript-failed': { icon: 'alert', cls: 'bad', badge: { text: 'Přepis selhal', cls: 'bad' } },
};

function noteRow(n, i, big) {
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
  const parts = [fmtDay(n.startedAt), fmtTime(n.startedAt), n.durationSec ? fmtDuration(n.durationSec) : null, n.actions ? `${n.actions} ${plural(n.actions, 'úkol', 'úkoly', 'úkolů')}` : null].filter(Boolean);
  parts.forEach((p, idx) => {
    if (idx) meta.append(el('span', 'sep'));
    meta.append(el('span', '', p));
  });
  main.append(meta);
  if (big && n.summary) main.append(el('div', 'note-summary', n.summary));
  const side = el('div', 'note-side');
  if (st.badge) side.append(el('span', `badge ${st.badge.cls}`, st.badge.text));
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
  const open = () => api.openNote(n.file);
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
    if (notesFilter === 'actions' && !n.actions) return false;
    if (notesFilter === 'issues' && !['summary-failed', 'transcript-failed', 'pending'].includes(n.status)) return false;
    return !q || n.title.toLowerCase().includes(q) || (n.summary || '').toLowerCase().includes(q);
  });
  const all = $('#all-notes');
  all.replaceChildren();
  if (!list.length) all.append(store.notes.length ? emptyState('Nic nenalezeno', 'Zkuste jiné hledání nebo filtr.', 'search') : emptyState('Zatím žádné poznámky', 'Po první nahrávce se tu objeví zápis ze schůzky.'));
  list.forEach((n, i) => all.append(noteRow(n, Math.min(i, 12), true)));
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
    setToggle(btn, store.settings[key]);
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
      if (name === 'general-update') {
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
      if (name === 'home' || name === 'home-mic' || name === 'home-recording') {
        go('home');
        if (name === 'home-mic') setTimeout(() => openDevicePicker('mic'), 400);
        if (name === 'home-recording') {
          applyState({ ...store.state, phase: 'recording', startedAt: Date.now() - 754000, jobs: [{ name: '2026-09-26-1402', type: 'process', stage: 'transcribing', progress: 0.42, text: 'Přepisuji 42 %' }] });
          fakeTimer = setInterval(() => {
            levels.micT = Math.random() * 0.5;
            levels.sysT = Math.random() * 0.35;
            levels.lastEvent = performance.now();
            ensureLevelLoop();
          }, 50);
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
    : 'Nová verze se stáhne na pozadí a nainstaluje při ukončení.';
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
