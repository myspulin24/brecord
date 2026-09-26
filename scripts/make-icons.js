#!/usr/bin/env node
// Generates the BRecord logo: the app icon (build/icon.png, assets/appIcon.png)
// and the tray icons (assets/tray/). No image dependencies: shapes are
// rasterised with supersampling and written with a tiny PNG encoder.
//   npm run icons                     write all icons
//   node scripts/make-icons.js --preview <dir>   comparison sheet of logo variants
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');

// ── PNG encoding ───────────────────────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Rasteriser ─────────────────────────────────────────────────────────────
// Shapes are functions (x, y) -> [r, g, b, a] | null in a 0..1 design space.
// Later shapes paint over earlier ones.
function raster(size, shapes) {
  const out = Buffer.alloc(size * size * 4);
  const S = size <= 64 ? 8 : 4; // small icons get more samples per pixel
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const shape of shapes) {
            const c = shape(x, y);
            if (!c) continue;
            const sa = c[3];
            cr = c[0] * sa + cr * (1 - sa);
            cg = c[1] * sa + cg * (1 - sa);
            cb = c[2] * sa + cb * (1 - sa);
            ca = sa + ca * (1 - sa);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = S * S;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      out[i] = alpha ? Math.round((r / n / alpha) * 255) : 0;
      out[i + 1] = alpha ? Math.round((g / n / alpha) * 255) : 0;
      out[i + 2] = alpha ? Math.round((b / n / alpha) * 255) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}
const render = (size, shapes) => encodePng(size, size, raster(size, shapes));

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];
const disc = (cx, cy, r, color) => (x, y) => (Math.hypot(x - cx, y - cy) <= r ? color : null);
const roundedRect = (inset, radius, colorAt) => (x, y) => {
  const lo = inset, hi = 1 - inset;
  const qx = Math.max(lo + radius - x, 0, x - (hi - radius));
  const qy = Math.max(lo + radius - y, 0, y - (hi - radius));
  return x >= lo && x <= hi && y >= lo && y <= hi && Math.hypot(qx, qy) <= radius ? colorAt(x, y) : null;
};
const glow = (cx, cy, r, color, strength) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  return d > r ? null : [color[0], color[1], color[2], strength * (1 - d / r) ** 2];
};

// ── The BR monogram ────────────────────────────────────────────────────────
// Monoline letters on a cap height of 36 units, B stem at x = 0. The red
// recording dot is part of the letterform (see VARIANTS); the chosen one is
// LOGO_VARIANT. The in-app SVG (src/ui/logo.js) is generated from the same
// geometry, so the icon and the UI never drift apart.
const R_STEM = 33;
const B_PARTS = [
  ['line', 0, 0, 0, 36],
  ['line', 0, 0, 12, 0], ['arc', 12, 9, 9], ['line', 12, 18, 0, 18],
  ['line', 0, 18, 13.5, 18], ['arc', 13.5, 27, 9], ['line', 13.5, 36, 0, 36],
];
const R_BOWL = [['line', R_STEM, 0, R_STEM + 9, 0], ['arc', R_STEM + 9, 9, 9], ['line', R_STEM + 9, 18, R_STEM, 18]];
const R_STEM_PART = [['line', R_STEM, 0, R_STEM, 36]];

const VARIANTS = {
  // The dot sits in the counter of the R.
  counter: { layers: [['ink', [...B_PARTS, ...R_STEM_PART, ...R_BOWL, ['line', R_STEM + 7, 18, R_STEM + 18, 36]]], ['dot', { x: R_STEM + 9.4, y: 9, r: 3.4 }]] },
  // The leg of the R ends in the dot, like a pen stroke finishing on "record".
  leg: { layers: [['ink', [...B_PARTS, ...R_STEM_PART, ...R_BOWL, ['line', R_STEM + 7, 18, R_STEM + 16.5, 33.5]]], ['dot', { x: R_STEM + 18, y: 36, r: 4.8 }]] },
  // The bowl of the R is the record button.
  bowl: { layers: [['ink', [['line', R_STEM + 8, 16, R_STEM + 18, 36]]], ['dot', { x: R_STEM + 9.5, y: 9.3, r: 10.3 }], ['ink', [...B_PARTS, ...R_STEM_PART]]] },
};
const LOGO_VARIANT = 'leg';

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Right-facing half circle (the bowls of B and R).
function halfArcDistance(px, py, cx, cy, r) {
  if (px >= cx) return Math.abs(Math.hypot(px - cx, py - cy) - r);
  return Math.min(Math.hypot(px - cx, py - (cy - r)), Math.hypot(px - cx, py - (cy + r)));
}

function bounds(variant, stroke, dotScale = 1) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, pad) => {
    x0 = Math.min(x0, x - pad); y0 = Math.min(y0, y - pad);
    x1 = Math.max(x1, x + pad); y1 = Math.max(y1, y + pad);
  };
  for (const [kind, data] of VARIANTS[variant].layers) {
    if (kind === 'dot') add(data.x, data.y, data.r * dotScale);
    else for (const [t, ...a] of data) {
      if (t === 'line') { add(a[0], a[1], stroke / 2); add(a[2], a[3], stroke / 2); }
      else add(a[0] + a[2], a[1], stroke / 2);
    }
  }
  return { x0, y0, x1, y1 };
}

// Scale and offset that centre the monogram's bounding box on (cx, cy) with
// the given width, in 0..1 canvas units.
function placement({ variant = LOGO_VARIANT, stroke, width, cx = 0.5, cy = 0.5, dotScale = 1 }) {
  const b = bounds(variant, stroke, dotScale);
  const k = width / (b.x1 - b.x0);
  return { k, ox: cx - ((b.x0 + b.x1) / 2) * k, oy: cy - ((b.y0 + b.y1) / 2) * k };
}

// Shapes for the monogram, bottom-most first.
function monogram(opts) {
  const { variant = LOGO_VARIANT, stroke, ink, dot, dotGlow = 0, dotScale = 1 } = opts;
  const { k, ox, oy } = placement(opts);
  const half = (stroke / 2) * k;
  const shapes = [];
  for (const [kind, data] of VARIANTS[variant].layers) {
    if (kind === 'dot') {
      const x = ox + data.x * k, y = oy + data.y * k, r = data.r * dotScale * k;
      if (dotGlow) shapes.push(glow(x, y, r * 2.3, dot, dotGlow));
      shapes.push(disc(x, y, r, dot));
    } else {
      const parts = data;
      shapes.push((x, y) => {
        const X = (x - ox) / k, Y = (y - oy) / k;
        let d = Infinity;
        for (const [t, ...a] of parts) d = Math.min(d, t === 'line' ? segmentDistance(X, Y, ...a) : halfArcDistance(X, Y, ...a));
        return d * k <= half ? ink : null;
      });
    }
  }
  return shapes;
}

// ── Icons ──────────────────────────────────────────────────────────────────
const RED = hex('#FF3B30');
const AMBER = hex('#F5A623');

function tileShapes() {
  const top = hex('#343A48'), bottom = hex('#161922');
  return roundedRect(0.08, 0.2, (_x, y) => {
    const t = (y - 0.08) / 0.84;
    return top.map((c, i) => c + (bottom[i] - c) * t);
  });
}

const APP_MARK = { stroke: 5.4, width: 0.6, cy: 0.5 };

function appIconShapes(variant = LOGO_VARIANT) {
  return [tileShapes(), ...monogram({ variant, ...APP_MARK, ink: hex('#F4F5F7'), dot: RED, dotGlow: 0.35 })];
}

// The same mark as inline SVG for the UI; the viewBox crops to the tile (8..92).
function logoSvg() {
  const { k, ox, oy } = placement(APP_MARK);
  const f = (n) => +n.toFixed(3);
  let ink = '';
  let dot = '';
  for (const [kind, data] of VARIANTS[LOGO_VARIANT].layers) {
    if (kind === 'dot') dot = `<circle class="brand-dot" cx="${f(data.x)}" cy="${f(data.y)}" r="${f(data.r)}" fill="#ff3b30"/>`;
    else for (const [t, ...a] of data) {
      ink += t === 'line' ? `M${f(a[0])} ${f(a[1])}L${f(a[2])} ${f(a[3])}` : `M${f(a[0])} ${f(a[1] - a[2])}A${f(a[2])} ${f(a[2])} 0 0 1 ${f(a[0])} ${f(a[1] + a[2])}`;
    }
  }
  return `<svg class="brand-svg" viewBox="8 8 84 84" aria-hidden="true"><g transform="translate(${f(ox * 100)} ${f(oy * 100)}) scale(${f(k * 100)})"><path d="${ink}" fill="none" stroke="#f4f5f7" stroke-width="${APP_MARK.stroke}" stroke-linecap="round" stroke-linejoin="round"/>${dot}</g></svg>`;
}

// Tray: no tile, heavier strokes so it reads at 16 px. `theme` is the colour
// of the bar behind it; the dot shows the state.
function trayShapes({ variant = LOGO_VARIANT, theme, dot }) {
  const ink = theme === 'dark' ? hex('#FFFFFF') : hex('#1B1D24');
  return monogram({ variant, stroke: 6.6, width: 0.94, cy: 0.5, ink, dot, dotScale: 1.25 });
}

const TRAY_STATES = {
  idle: RED,
  rec: RED,
  'rec-dim': hex('#FF3B30', 0.25), // second frame of the recording blink
  busy: AMBER,
};
const TRAY_SIZES = [['', 16], ['@1.25x', 20], ['@1.5x', 24], ['@2x', 32]];

function main() {
  const assets = path.join(ROOT, 'assets');
  const trayDir = path.join(assets, 'tray');
  fs.mkdirSync(trayDir, { recursive: true });
  for (const f of fs.readdirSync(assets)) if (/^tray.*\.png$/.test(f)) fs.rmSync(path.join(assets, f)); // old ring glyphs
  for (const theme of ['dark', 'light']) {
    for (const [state, dot] of Object.entries(TRAY_STATES)) {
      for (const [suffix, size] of TRAY_SIZES) {
        fs.writeFileSync(path.join(trayDir, `${theme}-${state}${suffix}.png`), render(size, trayShapes({ theme, dot })));
      }
    }
  }
  fs.writeFileSync(path.join(assets, 'appIcon.png'), render(256, appIconShapes()));
  const build = path.join(ROOT, 'build');
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, 'icon.png'), render(1024, appIconShapes()));
  fs.writeFileSync(
    path.join(ROOT, 'src', 'ui', 'logo.js'),
    `'use strict';\n/* exported LOGO_SVG */\n// Generated by scripts/make-icons.js (npm run icons). Do not edit by hand.\nconst LOGO_SVG = '${logoSvg()}';\n`,
  );
  console.log('Icons written to assets/tray/, assets/appIcon.png, build/icon.png and src/ui/logo.js');
}

// Comparison sheet: each variant as app icon, then tray sizes enlarged
// (nearest neighbour) on a dark and a light taskbar.
function preview(dir) {
  const variants = Object.keys(VARIANTS);
  const colW = 300;
  const W = colW * variants.length;
  const H = 300 + 2 * 130;
  const sheet = Buffer.alloc(W * H * 4);
  const fill = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      sheet[i] = c[0]; sheet[i + 1] = c[1]; sheet[i + 2] = c[2]; sheet[i + 3] = 255;
    }
  };
  const blit = (img, size, x0, y0, scale) => {
    for (let y = 0; y < size * scale; y++) for (let x = 0; x < size * scale; x++) {
      const si = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
      const a = img[si + 3] / 255;
      const di = ((y0 + y) * W + (x0 + x)) * 4;
      for (let c = 0; c < 3; c++) sheet[di + c] = Math.round(img[si + c] * a + sheet[di + c] * (1 - a));
    }
  };
  fill(0, 0, W, 300, [40, 42, 48]);
  fill(0, 300, W, 130, [28, 28, 30]);
  fill(0, 430, W, 130, [238, 239, 242]);
  variants.forEach((v, i) => {
    blit(raster(256, appIconShapes(v)), 256, i * colW + 22, 22, 1);
    for (const [row, theme] of [[300, 'dark'], [430, 'light']]) {
      let x = i * colW + 18;
      for (const [size, scale] of [[16, 5], [24, 3], [32, 2]]) {
        blit(raster(size, trayShapes({ variant: v, theme, dot: RED })), size, x, row + 25, scale);
        x += size * scale + 14;
      }
    }
  });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'logo-variants.png');
  fs.writeFileSync(file, encodePng(W, H, sheet));
  console.log(`Preview: ${file} (${variants.join(', ')})`);
}

if (require.main === module) {
  const i = process.argv.indexOf('--preview');
  if (i >= 0) preview(process.argv[i + 1] || '.');
  else main();
}

module.exports = { VARIANTS, LOGO_VARIANT, monogram, bounds };
