'use strict';
/* exported ICONS, icon, hydrateIcons */
// 24×24 stroke icons (currentColor). Kept inline so the UI has no assets to load.
const ICONS = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>',
  notes: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/><path d="M8.5 13h7M8.5 16.5h5"/>',
  sparkles: '<path d="M11 3.5l1.9 5.1 5.1 1.9-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  wave: '<path d="M4 10v4M8 6.5v11M12 3.5v17M16 7.5v9M20 10.5v3"/>',
  headphones: '<path d="M3.5 15v-3a8.5 8.5 0 0 1 17 0v3"/><rect x="3.5" y="14" width="4" height="6.5" rx="1.6"/><rect x="16.5" y="14" width="4" height="6.5" rx="1.6"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  flask: '<path d="M9 3.5h6M10 3.5v5.8L4.8 18.2a1.6 1.6 0 0 0 1.4 2.3h11.6a1.6 1.6 0 0 0 1.4-2.3L14 9.3V3.5"/><path d="M7.6 14.5h8.8"/>',
  mic: '<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5v3"/>',
  micOff: '<path d="M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M9 9v2.5a3 3 0 0 0 5 2.2"/><path d="M5.5 11a6.5 6.5 0 0 0 10.9 4.8M18.5 11a6.4 6.4 0 0 1-.4 2.2"/><path d="M12 17.5v3M4 4l16 16"/>',
  speaker: '<path d="M11 5 6.5 9H3.5v6h3L11 19z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6"/><path d="M18.3 6.2a8.5 8.5 0 0 1 0 11.6"/>',
  speakerOff: '<path d="M11 5 6.5 9H3.5v6h3L11 19z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  check: '<path d="M5 12.5 10 17.5 19.5 7"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  tasks: '<path d="m4 7.5 2 2 3.5-3.5"/><path d="m4 15.5 2 2 3.5-3.5"/><path d="M13 8h7M13 16h7"/>',
  pencil: '<path d="M4.5 19.5h3.8L19 8.8a2.7 2.7 0 0 0-3.8-3.8L4.5 15.7z"/><path d="m13.8 6.4 3.8 3.8"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.8 11.6a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/><path d="M10.2 11v5.5M13.8 11v5.5"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  chevronDown: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  chevronRight: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  refresh: '<path d="M19.5 11.5a7.5 7.5 0 0 0-13.4-4.2L4.5 9"/><path d="M4.5 4.5V9H9"/><path d="M4.5 12.5a7.5 7.5 0 0 0 13.4 4.2l1.6-1.7"/><path d="M19.5 19.5V15H15"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>',
  logIn: '<path d="M14.5 3.5h3a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-3"/><path d="m10 16.5 4.5-4.5L10 7.5"/><path d="M14.5 12h-10"/>',
  logOut: '<path d="M9.5 20.5h-3a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3"/><path d="m15 16.5 4.5-4.5L15 7.5"/><path d="M19.5 12h-10"/>',
  zap: '<path d="M13 3 5 13.5h6.5L11 21l8-10.5h-6.5z"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
  alert: '<path d="M10.3 4.2 2.9 17.3a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="m10.9 12.6 8.1-8.1M16 7.5l2 2M13.5 10l2 2"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6 3.9 3.9 0 0 1-.4 7.4z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
  download: '<path d="M12 3.5v11.5"/><path d="m7 10.5 5 5 5-5"/><path d="M5 20.5h14"/>',
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.8 7.8 0 1 0 10 10z"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 8.8 4.1-1.2 7-4.6 7-8.8V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  power: '<path d="M12 3.5v8"/><path d="M6.6 6.8a7.5 7.5 0 1 0 10.8 0"/>',
  fileAudio: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/><path d="M9 12.5v4M12 11v7M15 13.5v2"/>',
  redo: '<path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2l2.1 2.2"/><path d="M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  claude: '<path d="M12 4v16M4 12h16M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6"/>',
  codex: '<path d="m7 8.5 3.5 3.5L7 15.5M12.5 15.5h5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
};

function icon(name, size = 18, cls = '') {
  const body = ICONS[name] || '';
  const fill = name === 'more' || name === 'dot' ? ' fill="currentColor"' : '';
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${fill}>${body}</svg>`;
}

// Replaces <i data-icon="name"></i> placeholders with inline SVG.
function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    const size = Number(el.dataset.size) || 18;
    el.outerHTML = icon(el.dataset.icon, size, el.className);
  }
}
