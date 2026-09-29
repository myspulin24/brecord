#!/usr/bin/env node
// End-to-end test of the recording pipeline without audio hardware.
//
// Installs whisper.cpp and the tiny model into a separate BRECORD_HOME (cached
// in CI), synthesizes speech with espeak-ng, lays it out like a BRecord
// recording (16 kHz stereo, microphone on the left) and runs the same
// processRecording() the app uses, with summaries off. Passes when the note
// exists, has the transcript section and the transcript contains the words.
//   node scripts/e2e-smoke.js            (needs espeak-ng on PATH)
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.BRECORD_HOME || path.join(os.homedir(), '.brecord-e2e');
process.env.BRECORD_HOME = HOME; // before any core module reads it

const SENTENCE = 'Hello team. This is the BRecord smoke test. We ship the new release on Monday.';
const EXPECTED = ['hello', 'smoke', 'test', 'release', 'monday'];

async function main() {
  fs.mkdirSync(HOME, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'brecord-e2e-'));
  const notesDir = path.join(work, 'notes');
  fs.writeFileSync(
    path.join(HOME, 'settings.json'),
    JSON.stringify({ onboarded: true, notesDir, summary: { provider: 'none', fallback: 'none' }, transcription: { whisperModel: 'tiny', language: 'en' } }, null, 2),
  );

  const config = require('../src/core/config');
  const setup = require('../src/core/setup');
  const { processRecording } = require('../src/core/pipeline');
  const { readWavInfo, writeWav } = require('../src/core/wav');

  console.log('1/4 whisper.cpp a model tiny');
  const bin = await setup.installWhisperBinary({ onLog: (l) => l && console.log(`    ${l}`) });
  console.log(`    ${bin.skipped ? 'z mezipaměti' : 'nainstalováno'}: ${bin.bin}`);
  const model = await setup.installModel('tiny');
  console.log(`    ${model.skipped ? 'z mezipaměti' : 'staženo'}: ${model.file}`);

  console.log('2/4 syntéza řeči (espeak-ng)');
  const raw = path.join(work, 'speech.wav');
  execFileSync('espeak-ng', ['-v', 'en-us', '-s', '145', '-w', raw, SENTENCE]);

  console.log('3/4 nahrávka ve formátu BRecord (16 kHz stereo)');
  const info = readWavInfo(raw);
  const src = fs.readFileSync(raw).subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  const inFrames = Math.floor(src.length / info.blockAlign);
  const lead = 8000; // 0.5 s of silence before the speech
  const outFrames = Math.floor((inFrames * 16000) / info.sampleRate) + 2 * lead;
  const stereo = new Int16Array(outFrames * 2);
  for (let i = 0; i < outFrames - 2 * lead; i++) {
    const pos = (i * info.sampleRate) / 16000;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, inFrames - 1);
    const t = pos - a;
    const v = src.readInt16LE(a * info.blockAlign) * (1 - t) + src.readInt16LE(b * info.blockAlign) * t;
    stereo[(i + lead) * 2] = Math.round(v); // microphone channel; system audio stays silent
  }
  fs.mkdirSync(notesDir, { recursive: true });
  const wav = path.join(notesDir, '2026-01-02-0304.wav');
  writeWav(wav, stereo, { sampleRate: 16000, channels: 2 });

  console.log('4/4 zpracování');
  const result = await processRecording(wav, { cfg: config.loadConfig(), onStatus: () => {} });
  const md = fs.readFileSync(result.noteFile, 'utf8');
  const transcript = md.slice(md.indexOf('## Přepis')).toLowerCase();
  const hits = EXPECTED.filter((w) => transcript.includes(w));
  console.log(`    přepis: ${transcript.split('\n').filter((l) => l.startsWith('**[')).join(' ').slice(0, 300)}`);
  if (!md.includes('## Přepis')) throw new Error('Poznámka nemá oddíl s přepisem');
  if (hits.length < 3) throw new Error(`V přepisu se našla jen slova: ${hits.join(', ') || '(žádné)'}`);
  if (md.includes('Shrnutí se nepodařilo') || md.includes('Přepis se nepodařil')) throw new Error('Poznámka hlásí chybu');
  // Speaker recognition ran too (worker process, native module, models):
  // one voice on the microphone leaves the transcript without labels.
  if (md.includes('Mluvčí se nepodařilo rozlišit')) throw new Error(`Rozpoznání mluvčích selhalo: ${(md.match(/Mluvčí se nepodařilo rozlišit: [^\n]*/) || [''])[0]}`);
  console.log(`OK: nalezena slova ${hits.join(', ')}`);
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`E2E SELHAL: ${err.message}`);
  process.exit(1);
});
