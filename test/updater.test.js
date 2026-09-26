'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { notesToText, updateMode } = require('../src/updater');

test('update mode per package type', () => {
  assert.equal(updateMode({ packaged: false, platform: 'win32', env: {} }), 'dev');
  assert.equal(updateMode({ packaged: true, platform: 'win32', env: {} }), 'auto');
  assert.equal(updateMode({ packaged: true, platform: 'linux', env: { APPIMAGE: '/tmp/BRecord.AppImage' } }), 'auto');
  assert.equal(updateMode({ packaged: true, platform: 'linux', env: {} }), 'manual'); // .deb
  assert.equal(updateMode({ packaged: true, platform: 'darwin', env: {} }), 'manual'); // unsigned: no Squirrel.Mac
});

test('release notes from GitHub HTML become readable lines', () => {
  const html = '<h3>Přidáno</h3>\n<ul>\n<li><strong>Aktualizace</strong> z GitHubu</li>\n<li>Linux &amp; AppImage</li>\n</ul><p>Díky&nbsp;za&nbsp;zpětnou vazbu</p>';
  assert.equal(notesToText(html), 'Přidáno\n\n• Aktualizace z GitHubu\n\n• Linux & AppImage\n\nDíky za zpětnou vazbu');
  assert.equal(notesToText([{ version: '1.0.0', note: '<p>A</p>' }]), 'A');
  assert.equal(notesToText(null), '');
});
