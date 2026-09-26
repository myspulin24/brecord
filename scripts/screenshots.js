#!/usr/bin/env node
// Regenerates the README screenshots (docs/) from sample data, so no real
// notes, accounts or file paths end up in the repository.
//   npm run screenshots
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brecord-shots-'));
process.env.BRECORD_HOME = home;
const notesDir = path.join(home, 'notes');
fs.mkdirSync(notesDir, { recursive: true });
fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ onboarded: true, notesDir, myName: 'Michal' }));

const notes = require('../src/core/notes');
const day = (d, h, m) => new Date(2026, 8, d, h, m);
const samples = [
  [day(26, 9, 30), 2700, 'Plánování vydání webu', ['Nový web se spustí 14. října.', 'Rozpočet na reklamu je 5 000 USD.', 'Pokladna potřebuje ještě otestovat.', 'Tiskovou zprávu připraví Petra.', 'Další schůzka proběhne v pátek.'], [{ owner: 'Petra', task: 'Připravit tiskovou zprávu', due: 'pátek' }, { owner: 'Michal', task: 'Aktualizovat ceník', due: 'tento týden' }]],
  [day(25, 14, 0), 1800, 'Týdenní synchronizace týmu', ['Sprint je na 80 %.', 'Chybí napojení platební brány.', 'Tým přidá jednoho testera.', 'Retrospektiva se přesouvá na úterý.', 'Nové požadavky počkají na další sprint.'], [{ owner: 'Jana', task: 'Napojit platební bránu', due: 'středa' }]],
  [day(24, 10, 15), 1500, 'Rozhovor s dodavatelem', ['Dodavatel nabídl roční smlouvu.', 'Cena klesne o 12 %.', 'SLA zůstává 99,9 %.', 'Smlouvu projde právní oddělení.', 'Rozhodnutí padne do konce měsíce.'], []],
];
for (const [startedAt, durationSec, title, summary, actions] of samples) {
  const base = notes.allocateBaseName(notesDir, startedAt);
  notes.writeNote(path.join(notesDir, `${base}.md`), {
    startedAt,
    durationSec,
    transcription: 'whisper.cpp (medium)',
    turns: [{ start: 3, end: 8, speaker: 'Já', text: 'Tak začneme.' }],
    summary: { provider: 'Claude Code', model: 'sonnet', notes: { title, summary, decisions: [], action_items: actions } },
  });
}

const out = path.join(home, 'shots');
const electron = require('electron');
const env = { ...process.env, BRECORD_AUTO_UPDATE: '0' };
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electron, [ROOT, `--screenshot=${out}`, '--scenes=home-recording,notes', '--themes=dark,light'], { env, encoding: 'utf8', timeout: 180000 });
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(1);
}
const docs = path.join(ROOT, 'docs');
fs.mkdirSync(docs, { recursive: true });
for (const [from, to] of [['dark-home-recording', 'home-dark'], ['light-home-recording', 'home-light'], ['dark-notes', 'notes-dark']]) {
  fs.copyFileSync(path.join(out, `${from}.png`), path.join(docs, `${to}.png`));
}
fs.rmSync(home, { recursive: true, force: true });
console.log(`README screenshots written to ${docs}`);
