import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRelease, isUnreleased, listVersions } from '../scripts/changelog.mjs';

const md = `# Změny

Úvod.

## 0.4.0 — nevydáno

### Přidáno

- Nová věc.

## 0.3.0 — 2026-09-27

### Přidáno

- **Aktualizace** z GitHubu.

## 0.2.0 — 2026-09-20

## 0.1.0 — 2026-09-10

- První verze.
`;

test('section for a version, without its heading', () => {
  assert.equal(extractRelease(md, '0.3.0'), '### Přidáno\n\n- **Aktualizace** z GitHubu.');
  assert.equal(extractRelease(md, 'v0.3.0'.slice(1)), extractRelease(md, '0.3.0'));
  assert.equal(extractRelease(md, '0.1.0'), '- První verze.');
});

test('missing or empty sections are refused', () => {
  assert.equal(extractRelease(md, '9.9.9'), null);
  assert.equal(extractRelease(md, '0.2.0'), null);
  assert.equal(extractRelease(md, '0.3'), null); // no prefix matches
});

test('unreleased sections are recognised', () => {
  assert.equal(isUnreleased(md, '0.4.0'), true);
  assert.equal(isUnreleased(md, '0.3.0'), false);
  assert.deepEqual(listVersions(md), ['0.4.0', '0.3.0', '0.2.0', '0.1.0']);
});
