#!/usr/bin/env node
// Příkazová řádka BRecord: stejné zpracování jako v aplikaci.
//   node src/cli.js doctor
//   node src/cli.js setup [--model medium] [--variant cpu|blas|cuda] [--skip-model] [--skip-binary]
//   node src/cli.js process <zvukový-soubor>
//   node src/cli.js resummarize <poznámka.md>
//   node src/cli.js test-summary [claude-code|codex|ollama]
'use strict';
const fs = require('fs');
const path = require('path');
const { API_KEY_NAMES, cloudApisEnabled, loadConfig } = require('./core/config');
const { CLIS, cliStatus } = require('./core/cli-tools');
const { processRecording, resummarizeNote } = require('./core/pipeline');
const { fixPath } = require('./core/proc');
const setup = require('./core/setup');
const { PROVIDERS, ollamaModels, resolvePlan, testProvider } = require('./core/summarize');
const { describePlan, localWhisper } = require('./core/transcribe');

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
function progressPrinter(label) {
  return (received, total) => {
    const pct = total ? ` ${((received / total) * 100).toFixed(0)} %` : '';
    process.stdout.write(`\r  ${label}: ${mb(received)}${total ? ` z ${mb(total)}` : ''}${pct}   `);
  };
}

function statusPrinter() {
  let last = '';
  return (s) => {
    const line = s.stage === 'transcribing' && s.progress !== undefined ? `přepisuji ${Math.round(s.progress * 100)} %` : s.text || (s.stage === 'summarizing' ? 'připravuji shrnutí' : 'přepisuji');
    if (line !== last) console.log(`  … ${(last = line)}`);
  };
}

async function doctor() {
  const cfg = loadConfig();
  const w = localWhisper(cfg);
  const ok = (b) => (b ? '✓' : '✗');
  console.log(`Nastavení     ${cfg.settingsFile}${fs.existsSync(cfg.settingsFile) ? '' : ' (výchozí)'}`);
  console.log(`Poznámky      ${cfg.notesDir}`);
  console.log('');
  console.log(`Přepis → ${describePlan(cfg)}`);
  console.log(`  ${ok(w.bin)} whisper.cpp   ${w.bin || 'nenalezen (npm run setup)'}`);
  console.log(`  ${ok(w.modelExists)} model         ${w.model}`);
  console.log('');
  const plan = await resolvePlan(cfg);
  console.log(`Shrnutí → ${plan.map((id) => PROVIDERS[id].label).join(', záloha ') || 'žádný poskytovatel není k dispozici'}`);
  for (const id of Object.keys(CLIS)) {
    const s = await cliStatus(id, cfg, { fresh: true });
    const detail = !s.path ? 'nenainstalováno' : !s.installed ? `nefunguje: ${s.error}` : `${s.version} · ${s.loggedIn ? `přihlášeno (${s.account})` : 'nepřihlášeno'}`;
    console.log(`  ${ok(s.loggedIn)} ${s.label.padEnd(12)} ${detail}`);
  }
  try {
    const models = await ollamaModels(cfg);
    console.log(`  ✓ Ollama       ${models.length ? models.join(', ') : 'běží, bez modelů'}`);
  } catch {
    console.log('  ✗ Ollama       neběží');
  }
  console.log('');
  console.log(`Experimentální API (${cloudApisEnabled(cfg) ? 'zapnuto' : 'vypnuto'}):`);
  const configured = new Set(API_KEY_NAMES.filter((name) => cfg.keys[name]));
  for (const name of API_KEY_NAMES) console.log(`  ${configured.has(name) ? '✓' : '✗'} ${name}`);
}

async function runSetup(args) {
  const cfg = loadConfig();
  const model = String(flag(args, 'model', cfg.settings.transcription.whisperModel || 'medium'));
  if (!flag(args, 'skip-binary', false)) {
    console.log('whisper.cpp');
    const r = await setup.installWhisperBinary({
      variant: String(flag(args, 'variant', 'cpu')),
      force: !!flag(args, 'force', false),
      onProgress: progressPrinter('stahuji'),
      onLog: (line) => line && console.log(`  ${line}`),
    });
    console.log(`\n  ${r.skipped ? 'už je nainstalovaný' : 'nainstalováno'}: ${r.bin}`);
  }
  if (!flag(args, 'skip-model', false)) {
    console.log(`Model whisperu „${model}“ (~${setup.MODELS[model] || '?'} MB)`);
    const r = await setup.installModel(model, { onProgress: progressPrinter('stahuji') });
    console.log(`\n  ${r.skipped ? 'už je stažený' : 'staženo'}: ${r.file}`);
  }
  console.log('\nHotovo. Zkontrolujte vše přes `npm run doctor` a spusťte `npm start`.');
}

async function main(argv) {
  fixPath();
  const [command, ...args] = argv;
  switch (command) {
    case 'doctor':
      return doctor();
    case 'setup':
      return runSetup(args);
    case 'process': {
      if (!args[0]) throw new Error('Použití: process <zvukový-soubor>');
      const r = await processRecording(args[0], { cfg: loadConfig(), onStatus: statusPrinter() });
      console.log(r.summaryError ? `Přepis uložen, ale shrnutí selhalo:\n${r.summaryError}` : 'Hotovo.');
      console.log(r.noteFile);
      return;
    }
    case 'resummarize': {
      if (!args[0]) throw new Error('Použití: resummarize <poznámka.md>');
      const r = await resummarizeNote(path.resolve(args[0]), { cfg: loadConfig(), onStatus: statusPrinter() });
      console.log(r.summaryError ? `Shrnutí selhalo:\n${r.summaryError}` : `Hotovo: ${r.noteFile}`);
      return;
    }
    case 'test-summary': {
      const cfg = loadConfig();
      const id = args[0] || (await resolvePlan(cfg))[0];
      if (!PROVIDERS[id]) throw new Error(`Neznámý poskytovatel „${id}“. Dostupné: ${Object.keys(PROVIDERS).join(', ')}`);
      console.log(`Testuji ${PROVIDERS[id].label}…`);
      const r = await testProvider(id, cfg);
      console.log(`Funguje: ${(r.ms / 1000).toFixed(1)} s, model ${r.model}`);
      console.log(JSON.stringify(r.notes, null, 2));
      return;
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 8).join('\n').replace(/^\/\/ ?/gm, ''));
      if (command) process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\nChyba: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
