#!/usr/bin/env node
/**
 * Vytáhne z CHANGELOG.md sekci k jedné verzi.
 *
 * Používá to vydávací workflow: text se stane popisem vydání na GitHubu
 * a aplikace ho ukáže v Nastavení → Aktualizace jako „Co je nového“,
 * když nabídne novou verzi.
 *
 * Když sekce chybí nebo je prázdná, skončí to chybou. To je záměr: vydání
 * bez poznámek se nemá sestavit, aby uživatel neviděl prázdnou kolonku.
 */

import { readFileSync } from 'node:fs';

/** Nadpis sekce: `## 1.2.3` nebo `## 1.2.3 — cokoliv` (datum, „nevydáno“). */
function headingFor(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+v?${escaped}\\s*(?:[—–-].*)?$`);
}

/** Text sekce k dané verzi bez nadpisu, nebo `null`, když tam není. */
export function extractRelease(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const heading = headingFor(version);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
}

/** Je sekce k verzi ještě označená jako nevydaná? Vydat se to nemá. */
export function isUnreleased(markdown, version) {
  const line = markdown.split(/\r?\n/).find((l) => headingFor(version).test(l));
  return !!line && /nevydáno|unreleased/i.test(line);
}

/** Verze, ke kterým už sekce existuje. */
export function listVersions(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => /^##\s+v?(\d+\.\d+\.\d+)/.exec(line)?.[1])
    .filter((value) => value !== undefined);
}

// --- spuštění z příkazové řádky --------------------------------------------
//   node scripts/changelog.mjs 0.3.0            vypíše text sekce
//   node scripts/changelog.mjs 0.3.0 --release  navíc odmítne sekci „nevydáno“

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  const version = process.argv[2];
  if (!version) {
    console.error('Použití: node scripts/changelog.mjs <verze> [--release]   (například 0.3.0)');
    process.exit(2);
  }
  const markdown = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const notes = extractRelease(markdown, version);
  if (notes === null) {
    console.error(
      `V CHANGELOG.md není co říct k verzi ${version}.\n` +
        `Přidejte nahoru sekci "## ${version} — <datum>" a napište do ní, co je nového.\n` +
        `Sekce, které tam jsou: ${listVersions(markdown).join(', ') || '(žádné)'}`,
    );
    process.exit(1);
  }
  if (process.argv.includes('--release') && isUnreleased(markdown, version)) {
    console.error(`Sekce ${version} je v CHANGELOG.md pořád „nevydáno“. Doplňte datum vydání.`);
    process.exit(1);
  }
  process.stdout.write(notes);
}
