#!/usr/bin/env node
// Speaker recognition in the packaged app (`npm run pack` first).
//
// Installs the models into a throw-away data folder, then runs the unpacked
// build with --diarize-test on sherpa-onnx's two-speaker sample. That covers
// what a unit test can't: the worker process started from inside app.asar,
// the native module unpacked next to it, and its libraries on this platform.
// Nothing is played or recorded.
//   node scripts/smoke-speakers.js [--app <path-to-executable>]
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/3-two-speakers-en.wav';

async function main() {
  const { findApp } = require('./smoke');
  const app = findApp();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brecord-speakers-'));
  process.env.BRECORD_HOME = home; // before speakers.js reads the config
  const speakers = require('../src/core/speakers');
  const { download } = require('../src/core/setup');
  try {
    console.log('1/3 modely pro rozpoznání mluvčích');
    await speakers.installSpeakerModels();
    console.log('2/3 ukázková nahrávka se dvěma mluvčími');
    const wav = path.join(home, 'two-speakers.wav');
    await download(SAMPLE, wav);
    console.log(`3/3 rozpoznání v sestavené aplikaci: ${app}`);
    const env = { ...process.env, BRECORD_HOME: home };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [`--diarize-test=${wav}`];
    if (process.platform === 'linux') args.push('--no-sandbox');
    const r = spawnSync(app, args, { env, encoding: 'utf8', timeout: 3 * 60 * 1000 });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const line = (out.match(/DIARIZE_RESULT (\{.*\})/) || [])[1];
    if (!line) throw new Error(`Aplikace nevrátila výsledek (kód ${r.status}):\n${out.slice(-3000)}`);
    const result = JSON.parse(line);
    if (!result.ok) throw new Error(`Rozpoznání selhalo: ${result.error}`);
    if (result.speakers.length < 2) throw new Error(`Čekal jsem dva mluvčí, rozpoznal jsem ${result.speakers.length}`);
    if (!result.speakers.every((sp) => sp.embedding)) throw new Error('Některý mluvčí nemá hlasový otisk');
    console.log(`OK: ${result.speakers.length} mluvčí (${result.speakers.map((sp) => `${sp.seconds} s`).join(', ')})`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`SMOKE SELHAL: ${err.message}`);
  process.exit(1);
});
