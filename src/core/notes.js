// Note files: ~/MeetingNotes/YYYY-MM-DD-HHMM.md next to YYYY-MM-DD-HHMM.wav.
// Notes are written in Czech; notes from the English-language development
// builds can still be read back (re-summarized, listed).
'use strict';
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./config');
const { ME, THEM, markdownToTurns, turnsToMarkdown } = require('./transcript');

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

// Tasks are the checkbox lines above the transcript, so ones added in an
// editor count too, while a "- [ ]" someone said out loud never does.
const TASK_LINE = /^(\s*)[-*] \[([ xX])\] (.*)$/;
const TASK_PARTS = /^\*\*(.+?)\*\* — (.*?)(?: _\((?:termín|due): (.+?)\)_)?$/;
const TASKS_HEADING = /^## (?:Úkoly|Action items)$/;
const NO_TASKS = '_Žádné úkoly._';
const oneLine = (text, max = 400) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

function taskLine({ owner, task, due, done }) {
  owner = oneLine(owner, 80);
  task = oneLine(task);
  due = oneLine(due, 80);
  const body = owner ? `**${owner}** — ${task}` : task;
  return `- [${done ? 'x' : ' '}] ${body}${due ? ` _(termín: ${due})_` : ''}`;
}

// Owner and task text, case and spacing aside: how a re-summarized note
// recognises the tasks that were already ticked off.
const taskKey = (owner, task) => `${oneLine(owner)}|${oneLine(task)}`.toLowerCase();

const bulletList = (items, fallback) => (items && items.length ? items.map((i) => `- ${i}`).join('\n') : `_${fallback}_`);
const quote = (text) => text.replace(/\n/g, '\n> ');

function renderNote({ startedAt, durationSec, audioFile, transcription, turns, summary, summaryError, transcriptError, pending, warnings = [], doneTasks = [] }) {
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
        ? notes.action_items.map((a) => taskLine({ ...a, done: doneTasks.includes(taskKey(a.owner, a.task)) })).join('\n')
        : NO_TASKS,
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

function transcriptStart(md) {
  let idx = -1;
  for (const m of md.matchAll(TRANSCRIPT_RE)) idx = m.index;
  return idx;
}

function splitNote(md) {
  const idx = transcriptStart(md);
  return idx < 0 ? null : { header: md.slice(0, idx), body: md.slice(idx).replace(/^\n## [^\n]+\n/, '') };
}

// Checkbox lines of the note's header, each with its line number so a change
// can be written back to exactly that line.
function parseTasks(md) {
  const end = transcriptStart(md);
  const lines = (end < 0 ? md : md.slice(0, end)).split('\n');
  const tasks = [];
  lines.forEach((raw, line) => {
    const m = raw.match(TASK_LINE);
    if (!m) return;
    const body = m[3].trim();
    const parts = body.match(TASK_PARTS);
    tasks.push({
      line,
      raw: body,
      done: m[2] !== ' ',
      owner: parts ? parts[1] : '',
      task: parts ? parts[2] : body,
      due: parts && parts[3] ? parts[3] : '',
    });
  });
  return tasks;
}

function readText(file) {
  const fd = fs.openSync(file, 'r');
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readTasks(file) {
  return parseTasks(readText(file).replace(/\r\n/g, '\n'));
}

const isSectionEnd = (line) => /^## |^---$/.test(line);

// Ticks, adds, edits or removes one task in the .md file itself. A change to
// an existing line is refused if that line no longer holds the task the UI
// showed, e.g. because the note was edited elsewhere in the meantime.
function updateTask(file, op) {
  const original = readText(file);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const md = original.replace(/\r\n/g, '\n');
  const lines = md.split('\n');
  const start = transcriptStart(md);
  const end = start < 0 ? lines.length : md.slice(0, start).split('\n').length;
  const heading = lines.findIndex((l, i) => i < end && TASKS_HEADING.test(l));

  if (op.type === 'add') {
    if (!oneLine(op.task)) throw new Error('Úkol potřebuje text');
    const line = taskLine({ owner: op.owner, task: op.task, due: op.due });
    if (heading >= 0) {
      let next = lines.findIndex((l, i) => i > heading && (i >= end || isSectionEnd(l)));
      if (next < 0) next = end;
      const placeholder = lines.findIndex((l, i) => i > heading && i < next && l.trim() === NO_TASKS);
      if (placeholder >= 0) {
        lines[placeholder] = line;
      } else {
        let last = heading + 1;
        for (let i = heading + 1; i < next; i++) if (lines[i].trim()) last = i;
        lines.splice(last + 1, 0, line);
      }
    } else {
      // Notes without a summary have no task list yet: start one above the
      // divider that separates the transcript.
      let at = end;
      while (at > 0 && !lines[at - 1].trim()) at--;
      if (at > 0 && lines[at - 1] === '---') at--;
      lines.splice(at, 0, '## Úkoly', '', line, '');
    }
  } else {
    const current = parseTasks(md).find((t) => t.line === op.line);
    if (!current || current.raw !== op.raw) throw new Error('Poznámka se mezitím změnila. Úkoly jsou znovu načtené.');
    const indent = lines[op.line].match(TASK_LINE)[1];
    if (op.type === 'toggle') {
      lines[op.line] = lines[op.line].replace(/\[[ xX]\]/, op.done ? '[x]' : '[ ]');
    } else if (op.type === 'edit') {
      if (!oneLine(op.task)) throw new Error('Úkol potřebuje text');
      lines[op.line] = indent + taskLine({ owner: op.owner, task: op.task, due: op.due, done: current.done });
    } else if (op.type === 'remove') {
      lines.splice(op.line, 1);
      // The last task gone: put the "no tasks" line back, as a fresh note has.
      if (heading >= 0 && heading < op.line) {
        let next = lines.findIndex((l, i) => i > heading && isSectionEnd(l));
        if (next < 0) next = lines.length;
        if (!lines.slice(heading + 1, next).some((l) => l.trim())) lines.splice(heading + 1, next - heading - 1, '', NO_TASKS, '');
      }
    } else {
      throw new Error(`Neznámá změna úkolu: ${op.type}`);
    }
  }
  writeFileAtomic(file, lines.join('\n').replace(/\n/g, eol));
  return readTasks(file);
}

// Who speaks in a note's transcript: per label the number of turns, roughly
// how long they spoke and their longest turn (quoted, and where to play it).
function noteSpeakers(file) {
  const md = readText(file).replace(/\r\n/g, '\n');
  const parts = splitNote(md);
  const turns = parts ? markdownToTurns(parts.body) : [];
  const byLabel = new Map();
  turns.forEach((t, i) => {
    if (!t.speaker) return;
    const next = turns[i + 1];
    // Transcript lines keep only the start; the next one bounds the length.
    const seconds = Math.max(1, Math.min(90, (next ? next.start : t.start + 15) - t.start));
    const entry = byLabel.get(t.speaker) || { label: t.speaker, turns: 0, seconds: 0, sample: '', sampleStart: 0, sampleSeconds: 0 };
    entry.turns += 1;
    entry.seconds += seconds;
    if (t.text.length > entry.sample.length) {
      entry.sample = t.text;
      entry.sampleStart = t.start;
      entry.sampleSeconds = seconds;
    }
    byLabel.set(t.speaker, entry);
  });
  const speakers = [...byLabel.values()].map((e) => ({ ...e, sample: e.sample.length > 220 ? `${e.sample.slice(0, 217).trimEnd()}…` : e.sample }));
  return { speakers, voices: speakers.some((sp) => sp.label !== ME && sp.label !== THEM) };
}

const SPEAKER_LINE = /^(\*\*\[\d{1,2}:\d{2}:\d{2}\]) ([^:*]+):\*\*/;
const speakerName = (name) => oneLine(name, 60).replace(/[:*[\]]/g, '').trim();

// Renames speakers in the transcript ({ "Mluvčí 2": "Petra" }); two labels
// given the same name become one person. Returns the names actually applied.
function renameSpeakers(file, mapping) {
  const rename = new Map();
  for (const [from, to] of Object.entries(mapping || {})) {
    const name = speakerName(to);
    if (name && name !== from) rename.set(from, name);
  }
  if (!rename.size) return {};
  const original = readText(file);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const md = original.replace(/\r\n/g, '\n');
  const start = transcriptStart(md);
  if (start < 0) throw new Error(`${path.basename(file)} neobsahuje přepis`);
  const body = md
    .slice(start)
    .split('\n')
    .map((line) => line.replace(SPEAKER_LINE, (all, stamp, label) => (rename.has(label) ? `${stamp} ${rename.get(label)}:**` : all)))
    .join('\n');
  writeFileAtomic(file, (md.slice(0, start) + body).replace(/\n/g, eol));
  return Object.fromEntries(rename);
}

// The reason a failed note gives, without the Markdown quote around it.
function noteIssue(md) {
  const m = md.match(/^> ⚠️ \*\*(?:Přepis se nepodařil|Shrnutí se nepodařilo|Transcription failed|Summary failed)\.?\*\* ?(.*(?:\n> .+)*)/m);
  return m ? m[1].replace(/\n> /g, '\n').trim() : '';
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
  const doneTasks = parseTasks(md).filter((t) => t.done).map((t) => taskKey(t.owner, t.task));
  return { turns, startedAt, durationSec, transcription: transcription && transcription.trim(), pending: PENDING_RE.test(md), doneTasks };
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
      const fd = fs.openSync(file, 'r');
      let stat;
      let md;
      try {
        stat = fs.fstatSync(fd);
        md = fs.readFileSync(fd, 'utf8').replace(/\r\n/g, '\n');
      } finally {
        fs.closeSync(fd);
      }
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
      const tasks = parseTasks(md);
      const done = tasks.filter((t) => t.done).length;
      const audio = ['.wav', '.m4a', '.mp3'].map((ext) => path.join(dir, base + ext)).find((p) => fs.existsSync(p)) || null;
      const issue = status === 'summary-failed' || status === 'transcript-failed' ? noteIssue(md) : '';
      items.push({ file, base, title, startedAt: startedAt.getTime(), durationSec, status, summary, actions: tasks.length - done, tasksDone: done, tasksTotal: tasks.length, issue, audio, modified: stat.mtimeMs });
    } catch {
      // unreadable note: skip
    }
  }
  items.sort((a, b) => b.startedAt - a.startedAt || b.modified - a.modified);
  return items.slice(0, limit);
}

module.exports = { BASE_NAME, PENDING_MARKER, allocateBaseName, dateFromBaseName, formatDuration, listNotes, noteIssue, noteSpeakers, parseTasks, readNote, readTasks, renameSpeakers, renderNote, speakerName, taskKey, updateTask, writeNote };
