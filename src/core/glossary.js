// The transcription dictionary (Nastavení → Přepis → Slovník): names and
// terms that must come out spelled right, optionally with what speech
// recognition keeps turning them into.
//
//   Petra Nováková, Acme, OKR
//   SyteLine = Sideline, Sajtlajn
//
// A plain line is a comma-separated list of terms. "term = variants" also
// lists the misheard variants, which are replaced in the transcript. The
// terms go to whisper as a prompt and, with the variants, to the model that
// writes the summary.
'use strict';

const clean = (s) => s.replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words only: "Acme" must not touch "Acmes" or "ReAcme".
const wordRe = (phrase) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(phrase).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'giu');

function parseGlossary(text) {
  const byTerm = new Map();
  const add = (term, variants = []) => {
    const key = term.toLowerCase();
    const entry = byTerm.get(key) || { term, variants: [] };
    for (const v of variants) {
      if (v.toLowerCase() !== key && !entry.variants.some((x) => x.toLowerCase() === v.toLowerCase())) entry.variants.push(v);
    }
    byTerm.set(key, entry);
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq >= 0) {
      const term = clean(line.slice(0, eq));
      if (term) add(term, line.slice(eq + 1).split(/[,;]/).map(clean).filter(Boolean));
    } else {
      for (const term of line.split(/[,;]/).map(clean).filter(Boolean)) add(term);
    }
  }
  return [...byTerm.values()];
}

// whisper.cpp reads at most n_text_ctx/2 (224) tokens of prompt.
function whisperPrompt(glossary, maxChars = 600) {
  let out = '';
  for (const { term } of glossary) {
    const next = out ? `${out}, ${term}` : term;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}

// Replaces known misrecognitions, and fixes the capitalisation of names and
// brands ("syteline" → "SyteLine"). Everything else is left to the summary.
function applyGlossary(text, glossary) {
  let out = String(text || '');
  for (const { term, variants } of glossary) {
    for (const v of variants) out = out.replace(wordRe(v), term);
    if (/\p{Lu}/u.test(term)) out = out.replace(wordRe(term), term);
  }
  return out;
}

function applyToTurns(turns, glossary) {
  if (!glossary.length) return turns;
  return turns.map((t) => ({ ...t, text: applyGlossary(t.text, glossary) }));
}

// For the system prompt of the summary.
function glossaryPrompt(glossary) {
  if (!glossary.length) return [];
  const lines = [
    `Glossary, the correct spelling of names and terms from these meetings: ${glossary.map((e) => e.term).join(', ')}.`,
    'Speech recognition often mishears them. Whenever a word in the transcript sounds like a glossary entry, write the glossary spelling (inflect it naturally in the notes\' language).',
  ];
  const known = glossary.flatMap((e) => e.variants.map((v) => `"${v}" → ${e.term}`));
  if (known.length) lines.push(`Known misrecognitions: ${known.join('; ')}.`);
  return lines;
}

module.exports = { applyGlossary, applyToTurns, glossaryPrompt, parseGlossary, whisperPrompt };
