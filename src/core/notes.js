// Note files: ~/MeetingNotes/YYYY-MM-DD-HHMM.md next to YYYY-MM-DD-HHMM.wav.
// Notes are written in Czech; notes from the English-language development
// builds can still be read back (re-summarized, listed).
'use strict';
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./config');
const { markdownToTurns, turnsToMarkdown } = require('./transcript');

// Marks a note whose summary hasn't been written yet, so an interrupted
// run can be resumed on the next launch.
const PENDING_MARKER = '<!-- brecord:summary-pending -->';
const PENDING_RE = /<!-- (?:brecord|minutes):summary-pending -->/;
const TRANSCRIPT_HEADING = '## Přepis';
const TRANSCRIPT_RE = /\n## (?:Přepis|Transcript)\n/g;
const BASE_NAME = /^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$/;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function allocateBaseName(dir, date) {
  const base = stamp(date);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!['.md', '.wav'].some((ext) => fs.existsSync(path.join(dir, name + ext)))) return name;
  }
}

function dateFromBaseName(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : null;
}

function formatDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.round(sec)} s`;
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function parseDuration(text) {
  const s = text.match(/^(\d+) s$/);
  if (s) return Number(s[1]);
  const h = text.match(/(\d+) h/);
  const min = text.match(/(\d+) min/);
  return (h ? Number(h[1]) * 3600 : 0) + (min ? Number(min[1]) * 60 : 0);
}

const bulletList = (items, fallback) => (items && items.length ? items.map((i) => `- ${i}`).join('\n') : `_${fallback}_`);
const quote = (text) => text.replace(/\n/g, '\n> ');

function renderNote({ startedAt, durationSec, audioFile, transcription, turns, summary, summaryError, transcriptError, pending, warnings = [] }) {
  const start = new Date(startedAt);
  const end = new Date(start.getTime() + durationSec * 1000);
  const notes = summary && summary.notes;
  const title = (notes && notes.title) || 'Schůzka';
  const date = `${stamp(start).slice(0, 10)} · ${hhmm(start)}–${hhmm(end)} · ${formatDuration(durationSec)}`;
  const credits = [
    audioFile && `Zvuk: [${path.basename(audioFile)}](<${path.basename(audioFile)}>)`,
    transcription && `Přepis: ${transcription}`,
    summary && `Shrnutí: ${summary.provider}${summary.model ? ` (${summary.model})` : ''}`,
  ].filter(Boolean);

  const out = [`# ${title}`, '', `**${date}**  `, credits.join(' · '), ''];
  for (const w of warnings) out.push(`> ⚠️ ${w}`, '');

  if (transcriptError) {
    out.push(
      `> ⚠️ **Přepis se nepodařil.** ${quote(transcriptError)}`,
      '>',
      '> Zvukový soubor zůstal uložený. Opravte přepis v Nastavení a v menu BRecord zvolte **Zpracovat zvukový soubor…**',
      '',
    );
  } else if (pending) {
    out.push(PENDING_MARKER, '', '_Shrnutí se připravuje…_', '');
  } else if (summaryError) {
    out.push(
      `> ⚠️ **Shrnutí se nepodařilo.** ${quote(summaryError)}`,
      '>',
      '> Opravte poskytovatele v Nastavení a v menu BRecord zvolte **Znovu shrnout poznámku…**',
      '',
    );
  } else if (notes) {
    out.push('## Shrnutí', '', bulletList(notes.summary, 'Bez shrnutí.'), '');
    out.push('## Rozhodnutí', '', bulletList(notes.decisions, 'Žádná rozhodnutí.'), '');
    out.push('## Úkoly', '');
    out.push(
      notes.action_items.length
        ? notes.action_items.map((a) => `- [ ] **${a.owner}** — ${a.task}${a.due ? ` _(termín: ${a.due})_` : ''}`).join('\n')
        : '_Žádné úkoly._',
      '',
    );
  }

  out.push('---', '', TRANSCRIPT_HEADING, '');
  const empty = transcriptError ? '_Přepis není k dispozici._' : '_V nahrávce nezazněla žádná řeč._';
  out.push(turns && turns.length ? turnsToMarkdown(turns) : empty, '');
  return out.join('\n');
}

function writeNote(file, data) {
  writeFileAtomic(file, renderNote(data));
  return file;
}

function splitNote(md) {
  let idx = -1;
  for (const m of md.matchAll(TRANSCRIPT_RE)) idx = m.index;
  return idx < 0 ? null : { header: md.slice(0, idx), body: md.slice(idx).replace(/^\n## [^\n]+\n/, '') };
}

// Reads back what re-summarizing needs: the transcript turns and header info.
function readNote(file) {
  const md = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const parts = splitNote(md);
  if (!parts) throw new Error(`${path.basename(file)} neobsahuje oddíl „${TRANSCRIPT_HEADING}“`);
  const turns = markdownToTurns(parts.body);
  const transcription = (parts.header.match(/(?:Přepis|Transcript): ([^·\n]+)/) || [])[1];
  const m = parts.header.match(/\*\*(\d{4}-\d{2}-\d{2}) · (\d{2}):(\d{2})–\d{2}:\d{2} · ([^*]+)\*\*/);
  let startedAt = dateFromBaseName(path.basename(file, '.md')) || fs.statSync(file).mtime;
  let durationSec = turns.length ? turns[turns.length - 1].end + 5 : 0;
  if (m) {
    const [y, mo, d] = m[1].split('-').map(Number);
    startedAt = new Date(y, mo - 1, d, Number(m[2]), Number(m[3]));
    durationSec = parseDuration(m[4].trim());
  }
  return { turns, startedAt, durationSec, transcription: transcription && transcription.trim(), pending: PENDING_RE.test(md) };
}

// Overview for the app's note list, newest first.
function listNotes(dir, { limit = 200 } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const items = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      const md = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      const title = ((md.match(/^# (.+)$/m) || [])[1] || name.slice(0, -3)).trim();
      const m = md.match(/\*\*(\d{4}-\d{2}-\d{2}) · (\d{2}):(\d{2})–(\d{2}:\d{2}) · ([^*]+)\*\*/);
      const base = name.slice(0, -3);
      let startedAt = dateFromBaseName(base) || stat.mtime;
      let durationSec = 0;
      if (m) {
        const [y, mo, d] = m[1].split('-').map(Number);
        startedAt = new Date(y, mo - 1, d, Number(m[2]), Number(m[3]));
        durationSec = parseDuration(m[5].trim());
      }
      let status = 'ok';
      if (PENDING_RE.test(md)) status = 'pending';
      else if (/\*\*(Přepis se nepodařil|Transcription failed)/.test(md)) status = 'transcript-failed';
      else if (/\*\*(Shrnutí se nepodařilo|Summary failed)/.test(md)) status = 'summary-failed';
      else if (!/\n## (Shrnutí|Summary)\n/.test(md)) status = 'transcript-only';
      const summary = (md.match(/\n## (?:Shrnutí|Summary)\n\n- (.+)/) || [])[1] || '';
      const actions = (md.match(/^- \[ \] /gm) || []).length;
      const audio = ['.wav', '.m4a', '.mp3'].map((ext) => path.join(dir, base + ext)).find((p) => fs.existsSync(p)) || null;
      items.push({ file, base, title, startedAt: startedAt.getTime(), durationSec, status, summary, actions, audio, modified: stat.mtimeMs });
    } catch {
      // unreadable note: skip
    }
  }
  items.sort((a, b) => b.startedAt - a.startedAt || b.modified - a.modified);
  return items.slice(0, limit);
}

module.exports = { BASE_NAME, PENDING_MARKER, allocateBaseName, dateFromBaseName, formatDuration, listNotes, readNote, renderNote, writeNote };
