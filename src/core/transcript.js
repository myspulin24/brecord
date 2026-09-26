// Turns raw ASR segments into readable speaker turns and back.
'use strict';
const { meanRms, peakRms } = require('./wav');

// Below this (~ -50 dBFS) a stretch of audio is treated as silence.
const SILENCE_RMS = 0.003;

// Speaker labels written into notes: the recorder (microphone) and everyone
// heard through the computer's audio.
const ME = 'Já';
const THEM = 'Ostatní';

function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function parseTimestamp(ts) {
  const parts = ts.split(':').map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

// "Loud speech" level of a channel: 95th percentile over non-silent windows.
function speechLevel(arr) {
  const loud = Array.from(arr).filter((v) => v > SILENCE_RMS);
  if (loud.length < 10) return 0;
  loud.sort((a, b) => a - b);
  return loud[Math.floor(loud.length * 0.95)];
}

// Whisper happily invents text for silence ("Thank you for watching").
// Drop segments whose audio never rises above the noise floor, plus pure
// non-speech tags like [BLANK_AUDIO] or (music).
function dropHallucinations(segments, analysis) {
  return segments.filter((seg) => {
    const text = seg.text.trim();
    if (!text || /^(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪[^♪]*♪?)$/.test(text)) return false;
    if (analysis && peakRms(analysis, seg.start, Math.max(seg.end, seg.start + 0.1)) < SILENCE_RMS) return false;
    return true;
  });
}

// Mic on the left channel, system audio on the right: whichever channel is
// louder relative to its own typical speech level decides the speaker.
// Normalising per channel keeps this working with speakers (echo on the mic)
// as well as headphones. Returns false when labels would be meaningless,
// e.g. an in-room meeting where the system channel stayed silent.
function labelSpeakers(segments, analysis) {
  if (!analysis || analysis.rms.length < 2) return false;
  const micRef = speechLevel(analysis.rms[0]);
  const sysRef = speechLevel(analysis.rms[1]);
  if (!micRef || !sysRef) return false;
  for (const seg of segments) {
    const end = Math.max(seg.end, seg.start + 0.1);
    const mic = meanRms(analysis, 0, seg.start, end) / micRef;
    const sys = meanRms(analysis, 1, seg.start, end) / sysRef;
    seg.speaker = sys > mic ? THEM : ME;
  }
  return true;
}

// Merges consecutive segments into paragraphs: same speaker, short gap,
// and not longer than maxSec so timestamps stay useful.
function mergeTurns(segments, { maxGap = 2.5, maxSec = 75 } = {}) {
  const turns = [];
  for (const seg of segments) {
    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === seg.speaker && seg.start - prev.end <= maxGap && seg.end - prev.start <= maxSec) {
      prev.text = `${prev.text} ${seg.text.trim()}`;
      prev.end = seg.end;
    } else {
      turns.push({ start: seg.start, end: seg.end, speaker: seg.speaker, text: seg.text.trim() });
    }
  }
  return turns;
}

function buildTurns(segments, analysis) {
  const kept = dropHallucinations(segments.map((s) => ({ ...s })), analysis);
  const labelled = labelSpeakers(kept, analysis);
  return { turns: mergeTurns(kept), labelled };
}

// Markdown transcript line: **[00:01:23] Me:** text   (speaker optional)
function turnsToMarkdown(turns) {
  return turns
    .map((t) => `**[${formatTimestamp(t.start)}]${t.speaker ? ` ${t.speaker}:` : ''}** ${t.text}`)
    .join('\n\n');
}

const TURN_LINE = /^\*\*\[(\d{1,2}:\d{2}:\d{2})\](?: ([^:*]+):)?\*\*\s?(.*)$/;

function markdownToTurns(md) {
  const turns = [];
  for (const block of md.split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const m = lines[0].match(TURN_LINE);
    if (m) {
      turns.push({ start: parseTimestamp(m[1]), end: parseTimestamp(m[1]), speaker: m[2] || undefined, text: [m[3], ...lines.slice(1)].join(' ').trim() });
    } else if (turns.length && block.trim()) {
      turns[turns.length - 1].text += ` ${block.trim()}`;
    }
  }
  return turns;
}

// Compact plain-text form for the LLM.
function turnsToPlain(turns) {
  return turns.map((t) => `[${formatTimestamp(t.start)}]${t.speaker ? ` ${t.speaker}:` : ''} ${t.text}`).join('\n');
}

module.exports = { ME, THEM, SILENCE_RMS, buildTurns, dropHallucinations, formatTimestamp, labelSpeakers, markdownToTurns, mergeTurns, parseTimestamp, turnsToMarkdown, turnsToPlain };
