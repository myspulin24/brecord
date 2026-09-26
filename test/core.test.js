'use strict';
// Offline unit tests for the shared core (no audio devices, no network).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'brecord-test-'));
process.env.BRECORD_HOME = path.join(TMP, 'home');

const config = require('../src/core/config');
const notes = require('../src/core/notes');
const { run } = require('../src/core/proc');
const summarize = require('../src/core/summarize');
const transcript = require('../src/core/transcript');
const wav = require('../src/core/wav');
const { PcmQueue } = require('../src/core/win-loopback');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// Stereo test signal: a 440 Hz tone on the left for the first half,
// on the right for the second half, silence around it.
function makeStereo(seconds, { toneLeft = [0.5, 2], toneRight = [2.5, 4] } = {}) {
  const rate = 16000;
  const pcm = new Int16Array(seconds * rate * 2);
  for (let i = 0; i < seconds * rate; i++) {
    const t = i / rate;
    const v = Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000);
    if (t >= toneLeft[0] && t < toneLeft[1]) pcm[i * 2] = v;
    if (t >= toneRight[0] && t < toneRight[1]) pcm[i * 2 + 1] = v;
  }
  return pcm;
}

test('WavWriter streams PCM and finalizes the header', async () => {
  const file = path.join(TMP, 'writer.wav');
  const w = new wav.WavWriter(file, { channels: 2 });
  const pcm = makeStereo(2);
  w.write(new Uint8Array(pcm.buffer, 0, pcm.byteLength / 2));
  w.write(new Uint8Array(pcm.buffer, pcm.byteLength / 2));
  const { durationSec } = await w.close();
  assert.equal(durationSec, 2);
  const info = wav.readWavInfo(file);
  assert.equal(info.channels, 2);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.durationSec, 2);
});

test('repairWav fixes a recording cut off before the header was patched', () => {
  const file = path.join(TMP, 'crashed.wav');
  const pcm = makeStereo(1);
  fs.writeFileSync(file, Buffer.concat([wav.wavHeader({ sampleRate: 16000, channels: 2, dataBytes: 0 }), Buffer.from(pcm.buffer), Buffer.from([1])]));
  assert.equal(wav.repairWav(file), true);
  const info = wav.readWavInfo(file);
  assert.equal(info.claimedBytes, pcm.byteLength);
  assert.equal(info.durationSec, 1);
  assert.equal(wav.repairWav(file), false);
});

test('analyzeWav measures each channel and planChunks cuts in silence', async () => {
  const file = path.join(TMP, 'analyze.wav');
  wav.writeWav(file, makeStereo(5), { channels: 2 });
  const a = await wav.analyzeWav(file);
  assert.equal(a.rms.length, 2);
  assert.ok(wav.meanRms(a, 0, 1, 1.5) > 0.1, 'mic tone detected');
  assert.ok(wav.meanRms(a, 1, 1, 1.5) < 0.001, 'system silent during mic tone');
  assert.ok(wav.meanRms(a, 1, 3, 3.5) > 0.1, 'system tone detected');
  const chunks = wav.planChunks(a, 2.2, 1);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[chunks.length - 1].end, a.durationSec);
  // First cut lands in the silent gap between 2.0 s and 2.5 s.
  assert.ok(chunks[0].end >= 1.9 && chunks[0].end <= 2.5, `cut at ${chunks[0].end}`);
  const out = wav.writeMonoSlice(file, a, 1, 2, path.join(TMP, 'slice.wav'));
  assert.equal(wav.readWavInfo(out).channels, 1);
  assert.equal(wav.readWavInfo(out).durationSec, 1);
});

test('speaker labels follow the louder channel and silence is dropped', async () => {
  const file = path.join(TMP, 'speakers.wav');
  wav.writeWav(file, makeStereo(5), { channels: 2 });
  const a = await wav.analyzeWav(file);
  const segments = [
    { start: 0.6, end: 1.9, text: 'Hello from me.' },
    { start: 2.6, end: 3.9, text: 'Hello from them.' },
    { start: 4.2, end: 4.9, text: 'Thank you for watching!' }, // silent: hallucination
    { start: 1.0, end: 1.5, text: '[BLANK_AUDIO]' },
  ];
  const { turns, labelled } = transcript.buildTurns(segments, a);
  assert.equal(labelled, true);
  assert.deepEqual(turns.map((t) => [t.speaker, t.text]), [['Já', 'Hello from me.'], ['Ostatní', 'Hello from them.']]);
});

test('no speaker labels when the system channel stayed silent', async () => {
  const file = path.join(TMP, 'mic-only.wav');
  wav.writeWav(file, makeStereo(5, { toneRight: [0, 0], toneLeft: [0.5, 4] }), { channels: 2 });
  const a = await wav.analyzeWav(file);
  const { turns, labelled } = transcript.buildTurns([{ start: 1, end: 2, text: 'In the room.' }], a);
  assert.equal(labelled, false);
  assert.equal(turns[0].speaker, undefined);
});

test('transcript markdown round-trips', () => {
  const turns = [
    { start: 3, end: 8, speaker: 'Já', text: 'První bod.' },
    { start: 9, end: 12, speaker: 'Ostatní', text: 'Odpověď: s dvojtečkou.' },
    { start: 3725, end: 3730, text: 'No speaker here.' },
  ];
  const back = transcript.markdownToTurns(transcript.turnsToMarkdown(turns));
  assert.deepEqual(back.map((t) => [t.start, t.speaker, t.text]), turns.map((t) => [t.start, t.speaker, t.text]));
  assert.equal(transcript.formatTimestamp(3725), '01:02:05');
});

test('mergeTurns joins close segments from the same speaker', () => {
  const merged = transcript.mergeTurns([
    { start: 0, end: 2, speaker: 'Já', text: 'One' },
    { start: 2.5, end: 4, speaker: 'Já', text: 'two.' },
    { start: 4.2, end: 6, speaker: 'Ostatní', text: 'Three.' },
    { start: 20, end: 22, speaker: 'Ostatní', text: 'Later.' },
  ]);
  assert.deepEqual(merged.map((t) => t.text), ['One two.', 'Three.', 'Later.']);
});

test('notes render with summary on top and read back for re-summarizing', () => {
  const dir = path.join(TMP, 'notes');
  fs.mkdirSync(dir);
  const startedAt = new Date(2026, 8, 26, 14, 30);
  const base = notes.allocateBaseName(dir, startedAt);
  assert.equal(base, '2026-09-26-1430');
  fs.writeFileSync(path.join(dir, `${base}.wav`), '');
  assert.equal(notes.allocateBaseName(dir, startedAt), '2026-09-26-1430-2');

  const file = path.join(dir, `${base}.md`);
  const turns = [{ start: 1, end: 4, speaker: 'Já', text: 'Spouštíme v pondělí.' }];
  const summary = {
    provider: 'Claude Code',
    model: 'sonnet',
    notes: { title: 'Termín spuštění', summary: ['a', 'b', 'c', 'd', 'e'], decisions: ['Spouštíme v pondělí'], action_items: [{ owner: 'Petra', task: 'Informovat QA', due: 'pátek' }] },
  };
  notes.writeNote(file, { startedAt, durationSec: 2520, audioFile: path.join(dir, `${base}.wav`), transcription: 'whisper.cpp (medium)', turns, summary });
  const md = fs.readFileSync(file, 'utf8');
  assert.ok(md.startsWith('# Termín spuštění'));
  assert.ok(md.indexOf('## Shrnutí') < md.indexOf('\n---\n'), 'summary above the divider');
  assert.ok(md.indexOf('## Rozhodnutí') < md.indexOf('\n---\n'));
  assert.ok(md.indexOf('## Úkoly') < md.indexOf('\n---\n'));
  assert.ok(md.indexOf('## Přepis') > md.indexOf('\n---\n'), 'transcript below the divider');
  assert.match(md, /- \[ \] \*\*Petra\*\* — Informovat QA _\(termín: pátek\)_/);
  assert.match(md, /Zvuk: \[2026-09-26-1430\.wav\]/);
  assert.match(md, /\*\*2026-09-26 · 14:30–15:12 · 42 min\*\*/);

  const back = notes.readNote(file);
  assert.equal(back.durationSec, 2520);
  assert.equal(back.startedAt.getTime(), startedAt.getTime());
  assert.equal(back.transcription, 'whisper.cpp (medium)');
  assert.equal(back.turns[0].text, 'Spouštíme v pondělí.');
  assert.equal(back.turns[0].speaker, 'Já');
  assert.equal(back.pending, false);

  const listed = notes.listNotes(dir);
  assert.equal(listed[0].title, 'Termín spuštění');
  assert.equal(listed[0].status, 'ok');
  assert.equal(listed[0].actions, 1);
  assert.equal(listed[0].durationSec, 2520);

  notes.writeNote(file, { startedAt, durationSec: 60, turns, pending: true });
  assert.equal(notes.readNote(file).pending, true);
  assert.equal(notes.listNotes(dir)[0].status, 'pending');
});

test('notes from the English development builds are still readable', () => {
  const file = path.join(TMP, '2026-09-26-1444.md');
  fs.writeFileSync(file, [
    '# Short call',
    '',
    '**2026-09-26 · 14:44–14:44 · 17 s**  ',
    'Audio: [x.wav](<x.wav>) · Transcript: whisper.cpp (medium) · Summary: Claude Code (opus)',
    '',
    '> ⚠️ **Summary failed.** boom',
    '',
    '---',
    '',
    '## Transcript',
    '',
    '**[00:00:00] Me:** Hello there.',
    '',
  ].join('\n'));
  const back = notes.readNote(file);
  assert.equal(back.turns[0].text, 'Hello there.');
  assert.equal(back.transcription, 'whisper.cpp (medium)');
  assert.equal(back.durationSec, 17);
  const listed = notes.listNotes(TMP).find((n) => n.file === file);
  assert.equal(listed.status, 'summary-failed');
});

test('dotenv parsing and key updates keep the file tidy', () => {
  assert.deepEqual(config.parseDotenv('# c\nA=1\nexport B="two words" # x\nC=\'q\'\nD=plain # comment\n bad line'), { A: '1', B: 'two words', C: 'q', D: 'plain' });
  config.ensureEnvFile();
  config.setEnvValue('GROQ_API_KEY', 'gsk_test');
  let text = fs.readFileSync(config.ENV_FILE, 'utf8');
  assert.match(text, /^GROQ_API_KEY=gsk_test$/m);
  assert.doesNotMatch(text, /# GROQ_API_KEY=/);
  assert.equal(config.loadConfig().keys.GROQ_API_KEY, 'gsk_test');
  config.setEnvValue('GROQ_API_KEY', '');
  text = fs.readFileSync(config.ENV_FILE, 'utf8');
  assert.match(text, /^# GROQ_API_KEY=$/m);
  assert.equal(config.readEnvFile().GROQ_API_KEY, undefined);
});

test('settings merge over defaults', () => {
  const s = config.updateSettings({ summary: { provider: 'codex', codex: { model: 'x' } } });
  assert.equal(s.summary.provider, 'codex');
  assert.equal(s.summary.codex.model, 'x');
  assert.equal(s.summary.claudeCode.model, '');
  assert.equal(config.readSettings().transcription.whisperModel, 'medium');
});

test('LLM output is parsed leniently and normalized', () => {
  const raw = '<think>hmm</think>Sure!\n```json\n{"title":"T","summary":["1","2","3","4","5","6"],"decisions":"One","action_items":["Loose task",{"owner":"","task":"Do it","due":null}]}\n```';
  const n = summarize.normalizeNotes(summarize.parseJsonLoose(raw));
  assert.equal(n.summary.length, 5);
  assert.deepEqual(n.decisions, ['One']);
  assert.deepEqual(n.action_items, [
    { owner: 'Nepřiřazeno', task: 'Loose task', due: '' },
    { owner: 'Nepřiřazeno', task: 'Do it', due: '' },
  ]);
  assert.throws(() => summarize.parseJsonLoose('no json here'));
});

test('long transcripts are split on line boundaries within the budget', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `[00:00:${String(i % 60).padStart(2, '0')}] Me: sentence number ${i}`);
  const parts = summarize.splitByBudget(lines.join('\n'), 300);
  assert.ok(parts.length > 1);
  assert.equal(parts.join('\n'), lines.join('\n'));
  for (const p of parts) assert.ok(summarize.estimateTokens(p) <= 300 + 20);
});

test('system prompt adapts to the recorder name and labels', () => {
  const named = summarize.systemPrompt({ myName: 'Michal', labelled: true, notesLanguage: 'en' });
  assert.match(named, /"Já" \(Czech for "me"\) is Michal/);
  assert.match(named, /Write all text in English/);
  assert.match(named, /"Unassigned"/);
  const anon = summarize.systemPrompt({ labelled: false });
  assert.match(anon, /no speaker labels/);
  assert.match(anon, /Write all text in Czech/);
  assert.match(anon, /formal "vy"/);
  assert.match(anon, /"Nepřiřazeno"/);
  assert.match(summarize.systemPrompt({ notesLanguage: 'auto' }), /same language as the transcript/);
});

test('API providers are ignored while they are experimental', async () => {
  const base = config.loadConfig();
  const cfg = {
    ...base,
    keys: { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y', GROQ_API_KEY: 'z' },
    settings: { ...base.settings, summary: { ...base.settings.summary, provider: 'anthropic', fallback: 'groq' }, transcription: { ...base.settings.transcription, provider: 'openai' } },
  };
  assert.deepEqual(await summarize.resolvePlan(cfg), []);
  assert.deepEqual(require('../src/core/transcribe').transcriptionPlan(cfg), ['local']);
  cfg.settings = { ...cfg.settings, experimental: { cloudApis: true } };
  assert.deepEqual(await summarize.resolvePlan(cfg), ['anthropic', 'groq']);
  assert.deepEqual(require('../src/core/transcribe').transcriptionPlan(cfg), ['openai', 'local']);
});

test('PcmQueue fills the right channel, pads silence, keeps samples aligned', () => {
  const q = new PcmQueue();
  const samples = Buffer.alloc(6);
  samples.writeInt16LE(1000, 0);
  samples.writeInt16LE(-2000, 2);
  samples.writeInt16LE(3000, 4);
  q.push(samples.subarray(0, 3)); // a sample split across two pipe reads
  q.push(samples.subarray(3));
  const stereo = Buffer.alloc(4 * 4); // 4 frames
  for (let i = 0; i < 4; i++) stereo.writeInt16LE(7, i * 4); // mic on the left
  const peak = q.fillRight(stereo);
  const right = [0, 1, 2, 3].map((i) => stereo.readInt16LE(i * 4 + 2));
  const left = [0, 1, 2, 3].map((i) => stereo.readInt16LE(i * 4));
  assert.deepEqual(right, [1000, -2000, 3000, 0]);
  assert.deepEqual(left, [7, 7, 7, 7]);
  assert.ok(Math.abs(peak - 3000 / 32768) < 1e-9);

  q.push(Buffer.alloc(60000)); // backlog from clock drift gets trimmed
  q.fillRight(Buffer.alloc(16));
  assert.ok(q.bytes <= 16000);
});

test('cmd.exe escaping survives an npm-style .cmd shim', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(TMP, 'shim dir (x)');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'argv.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(path.join(dir, 'argv.cmd'), `@ECHO off\r\nSETLOCAL\r\n"${process.execPath}" "%~dp0\\argv.js" %*\r\n`);
  const args = ['--json-schema', JSON.stringify(summarize.NOTES_SCHEMA), '--tools', '', 'a b', 'q"uote', '100%', 'x&y|z', 'caret^', 'back\\slash\\', '!bang!', '(paren)', '%PATH%'];
  const r = await run(path.join(dir, 'argv.cmd'), args);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), args);
});

test('WASAPI loopback helper compiles and lists outputs', { skip: process.platform !== 'win32', timeout: 120000 }, async (t) => {
  const winLoopback = require('../src/core/win-loopback');
  const exe = await winLoopback.ensureHelper();
  assert.ok(fs.existsSync(exe), 'helper exe was built');
  try {
    const outputs = await winLoopback.listOutputs();
    assert.ok(Array.isArray(outputs));
    t.diagnostic(`${outputs.length} output device(s)`);
  } catch (err) {
    // CI runners may have no audio service; building and starting the helper is what matters here.
    t.diagnostic(`listOutputs: ${err.message}`);
  }
});
