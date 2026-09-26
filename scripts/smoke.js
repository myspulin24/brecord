#!/usr/bin/env node
// Smoke test of the packaged app (`npm run pack` first).
//
// Starts the unpacked build with a throw-away profile and data folder, renders
// every screen off-screen (no window, no audio devices touched) and fails if
// the app does not exit cleanly or anything was logged to the console as an
// error. Screenshots land in smoke-output/ so CI can attach them.
//   node scripts/smoke.js [--app <path-to-executable>]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'smoke-output');
const SCENES = ['onboarding-0', 'onboarding-1', 'home', 'home-recording', 'notes', 'ai', 'transcription', 'audio', 'general', 'general-update', 'experimental'];
const TIMEOUT_MS = 4 * 60 * 1000;

function findApp() {
  const i = process.argv.indexOf('--app');
  if (i >= 0) return path.resolve(process.argv[i + 1]);
  const candidates = {
    win32: ['win-unpacked/BRecord.exe', 'win-arm64-unpacked/BRecord.exe'],
    darwin: ['mac-arm64/BRecord.app/Contents/MacOS/BRecord', 'mac/BRecord.app/Contents/MacOS/BRecord', 'mac-universal/BRecord.app/Contents/MacOS/BRecord'],
    linux: ['linux-unpacked/brecord', 'linux-arm64-unpacked/brecord'],
  }[process.platform] || [];
  const found = candidates.map((c) => path.join(DIST, c)).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Sestavená aplikace nenalezena v ${DIST}. Spusťte nejdřív: npm run pack`);
  return found;
}

function main() {
  const app = findApp();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brecord-smoke-'));
  // Own notes folder too: the smoke run must never read the user's notes.
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ onboarded: true, notesDir: path.join(home, 'notes') }));
  fs.rmSync(OUT, { recursive: true, force: true });
  const args = [`--screenshot=${OUT}`, `--scenes=${SCENES.join(',')}`, '--themes=dark,light'];
  // Ubuntu runners restrict unprivileged user namespaces, which Chromium's
  // sandbox needs; the smoke run doesn't load remote content.
  if (process.platform === 'linux') args.push('--no-sandbox');
  const env = { ...process.env, BRECORD_HOME: home, BRECORD_AUTO_UPDATE: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`Smoke: ${app}`);
  const child = spawn(app, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    fail(`Aplikace neskončila do ${TIMEOUT_MS / 1000} s`, output);
  }, TIMEOUT_MS);
  child.on('exit', (code) => {
    clearTimeout(timer);
    fs.rmSync(home, { recursive: true, force: true });
    const line = (output.match(/SCREENSHOTS .* errors=(\[.*\])/) || [])[1];
    if (!line) return fail(`Aplikace nedoběhla do konce (kód ${code})`, output);
    const errors = JSON.parse(line);
    if (errors.length) return fail(`Rozhraní hlásilo chyby:\n  ${errors.join('\n  ')}`, output);
    if (code !== 0) return fail(`Aplikace skončila s kódem ${code}`, output);
    const shots = fs.readdirSync(OUT).filter((f) => f.endsWith('.png'));
    const expected = SCENES.length * 2;
    const small = shots.filter((f) => fs.statSync(path.join(OUT, f)).size < 5000);
    if (shots.length !== expected) return fail(`Čekal jsem ${expected} snímků, vzniklo ${shots.length}`, output);
    if (small.length) return fail(`Podezřele prázdné snímky: ${small.join(', ')}`, output);
    console.log(`OK: ${shots.length} obrazovek bez chyb (${OUT})`);
  });
}

function fail(message, output) {
  console.error(`SMOKE SELHAL: ${message}`);
  if (output) console.error(`--- výstup aplikace ---\n${output.slice(-4000)}`);
  process.exit(1);
}

try {
  main();
} catch (err) {
  fail(err.message);
}
