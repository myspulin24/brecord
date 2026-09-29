// recording.wav -> transcript -> summary -> recording.md (same folder).
// The note is written as soon as the transcript exists, so a failed or
// interrupted summary never loses the transcript.
'use strict';
const fs = require('fs');
const path = require('path');
const { applyToTurns, parseGlossary } = require('./glossary');
const { BASE_NAME, dateFromBaseName, readNote, writeNote } = require('./notes');
const { summarize } = require('./summarize');
const { installSpeakerModels, loadVoices, runDiarization, saveNoteVoices, speakerModelsInstalled } = require('./speakers');
const { buildTurns, diarizationChannel } = require('./transcript');
const { transcribe } = require('./transcribe');
const { analyzeWav, readWavInfo, repairWav } = require('./wav');

async function processRecording(audioFile, { cfg, meta = {}, onStatus = () => {}, signal } = {}) {
  const file = path.resolve(audioFile);
  const base = path.basename(file, path.extname(file));
  const noteFile = path.join(path.dirname(file), `${base}.md`);
  const warnings = [...(meta.warnings || [])];

  let analysis = null;
  if (/\.wav$/i.test(file)) {
    repairWav(file);
    try {
      analysis = await analyzeWav(file);
    } catch {
      // Not 16-bit PCM: whisper.cpp can still read it, we just lose speaker labels.
    }
  }
  const durationSec = analysis ? analysis.durationSec : meta.durationSec || 0;
  if (analysis && durationSec < 1) throw new Error('Nahrávka je kratší než jedna sekunda');
  if (meta.systemAudio !== false && analysis && analysis.rms[1] && !analysis.rms[1].some((v) => v > 0)) {
    warnings.push('Systémový zvuk byl celou dobu tichý. Pokud ostatní mluvili přes počítač, zkontrolujte vybraný výstup (Nastavení → Zvuk) a oprávnění k nahrávání systémového zvuku.');
  }
  const startedAt = meta.startedAt || (BASE_NAME.test(base) ? dateFromBaseName(base) : new Date(fs.statSync(file).mtimeMs - durationSec * 1000));

  onStatus({ stage: 'transcribing', progress: 0 });
  const transcript = await transcribe(file, cfg, {
    analysis,
    signal,
    onProgress: (progress) => onStatus({ stage: 'transcribing', progress }),
  });
  warnings.push(...transcript.warnings.map((w) => `Použit záložní lokální přepis: ${w}`));

  // Who is who: optional, so a failure here costs the labels, not the note.
  let diar = null;
  const channel = cfg.settings.speakers.enabled !== false ? diarizationChannel(analysis) : null;
  if (channel != null) {
    onStatus({ stage: 'speakers' });
    try {
      if (!speakerModelsInstalled()) {
        onStatus({ stage: 'speakers', text: 'Stahuji modely pro rozpoznání mluvčích…' });
        await installSpeakerModels({ signal });
        onStatus({ stage: 'speakers' });
      }
      diar = { channel, ...(await runDiarization(file, { channel, numSpeakers: meta.numSpeakers, signal })) };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      warnings.push(`Mluvčí se nepodařilo rozlišit: ${String(err.message).split('\n')[0]}`);
    }
  }
  const built = buildTurns(transcript.segments, analysis, { diar, voices: diar ? loadVoices() : [] });
  const turns = applyToTurns(built.turns, parseGlossary(cfg.settings.transcription.prompt));
  if (built.speakerVoices) saveNoteVoices(noteFile, built.speakerVoices);
  // Processing a note again (to tell speakers apart) keeps what was ticked off.
  let doneTasks = [];
  try {
    if (fs.existsSync(noteFile)) doneTasks = readNote(noteFile).doneTasks;
  } catch {
    // a failed note has no tasks to keep
  }
  const common = { startedAt, durationSec: durationSec || (turns.length ? turns[turns.length - 1].end : 0), audioFile: file, transcription: transcript.engine, turns, warnings };

  if (!turns.length || cfg.settings.summary.provider === 'none') {
    writeNote(noteFile, common);
    return { noteFile, turns, summary: null };
  }

  writeNote(noteFile, { ...common, pending: true });
  onStatus({ stage: 'summarizing' });
  try {
    const summary = await summarize(turns, cfg, { meta: common, signal, onStatus: (text) => onStatus({ stage: 'summarizing', text }) });
    for (const w of summary.warnings) common.warnings.push(`Použito záložní shrnutí: ${w}`);
    writeNote(noteFile, { ...common, summary, doneTasks });
    return { noteFile, turns, summary };
  } catch (err) {
    if (signal && signal.aborted) throw err; // leave the pending marker so it resumes next launch
    writeNote(noteFile, { ...common, summaryError: err.message });
    return { noteFile, turns, summary: null, summaryError: err.message };
  }
}

// Re-runs only the LLM step on an existing note (after fixing a provider,
// switching models, or when a previous run was interrupted).
async function resummarizeNote(noteFile, { cfg, onStatus = () => {}, signal } = {}) {
  const note = readNote(noteFile);
  if (!note.turns.length) throw new Error('Poznámka neobsahuje přepis, který by šlo shrnout');
  // A dictionary entry added since fixes the old transcript too.
  note.turns = applyToTurns(note.turns, parseGlossary(cfg.settings.transcription.prompt));
  const audio = ['.wav', '.m4a', '.mp3']
    .map((ext) => noteFile.replace(/\.md$/i, ext))
    .find((p) => fs.existsSync(p));
  const common = { startedAt: note.startedAt, durationSec: note.durationSec, audioFile: audio, transcription: note.transcription, turns: note.turns };
  onStatus({ stage: 'summarizing' });
  try {
    const summary = await summarize(note.turns, cfg, { meta: common, signal, onStatus: (text) => onStatus({ stage: 'summarizing', text }) });
    writeNote(noteFile, { ...common, summary, doneTasks: note.doneTasks, warnings: summary.warnings.map((w) => `Použito záložní shrnutí: ${w}`) });
    return { noteFile, summary };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    writeNote(noteFile, { ...common, summaryError: err.message });
    return { noteFile, summary: null, summaryError: err.message };
  }
}

// Recordings that never got (a complete) note: crashed mid-recording, app
// quit while processing, or a summary interrupted halfway.
function findUnfinished(notesDir, { maxAgeDays = 7 } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(notesDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const jobs = [];
  for (const name of entries) {
    if (!name.endsWith('.wav') || !BASE_NAME.test(name.slice(0, -4))) continue;
    const wav = path.join(notesDir, name);
    const md = wav.replace(/\.wav$/, '.md');
    try {
      if (fs.statSync(wav).mtimeMs < cutoff) continue;
      if (!fs.existsSync(md)) {
        repairWav(wav);
        if (readWavInfo(wav).durationSec >= 1) jobs.push({ type: 'process', file: wav });
      } else if (readNote(md).pending) {
        jobs.push({ type: 'resummarize', file: md });
      }
    } catch {
      // Unreadable file: leave it for the user.
    }
  }
  return jobs;
}

module.exports = { findUnfinished, processRecording, resummarizeNote };
