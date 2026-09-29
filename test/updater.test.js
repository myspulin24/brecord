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
  assert.equal(notesToText(html), 'Přidáno\n• Aktualizace z GitHubu\n• Linux & AppImage\n\nDíky za zpětnou vazbu');
  // What GitHub makes of a CHANGELOG item wrapped at 80 columns.
  const wrapped = '<h3>Poznámky</h3>\n<ul>\n<li><strong>Úkoly.</strong> Označíte je<br>\njako hotové (<code>- [x]</code>).</li>\n<li>Druhá</li>\n</ul>\n<h3>Opravy</h3>\n<ul>\n<li>Kruh</li>\n</ul>';
  assert.equal(notesToText(wrapped), 'Poznámky\n• Úkoly. Označíte je jako hotové (- [x]).\n• Druhá\n\nOpravy\n• Kruh');
  assert.equal(notesToText('<ul><li>Nové</li></ul><hr><p><strong>Stažení:</strong> Windows</p>'), '• Nové');
  assert.equal(notesToText([{ version: '1.0.0', note: '<p>A</p>' }]), 'A');
  assert.equal(notesToText(null), '');
});

// Stand-in for electron-updater's autoUpdater: counts checks, emits on demand.
function fakeUpdater() {
  const { EventEmitter } = require('node:events');
  const u = new EventEmitter();
  u.checks = 0;
  u.checkForUpdates = async () => {
    u.checks++;
    u.emit('checking-for-update');
  };
  u.downloadUpdate = async () => {};
  return u;
}

test('updates are looked for again only when the last check is stale', async () => {
  const { createUpdater } = require('../src/updater');
  const impl = fakeUpdater();
  const states = [];
  const updater = createUpdater({ app: { isPackaged: true, getVersion: () => '0.4.0' }, platform: 'win32', env: {}, log: () => {}, isAutoDownload: () => true, onChange: (s) => states.push(s), impl });
  assert.equal(updater.checkIfStale(), true, 'never checked yet');
  assert.equal(impl.autoDownload, true, 'Windows downloads on its own');
  impl.emit('update-not-available');
  assert.equal(updater.checkIfStale(), false, 'just checked');
  assert.equal(updater.checkIfStale(0), true, 'stale again');
  assert.equal(impl.checks, 2);

  // Once a version is downloading or ready, nothing asks GitHub again.
  impl.emit('update-available', { version: '0.5.0', releaseNotes: '<p>Nové</p>' });
  assert.equal(states.at(-1).status, 'downloading');
  impl.emit('update-downloaded', { version: '0.5.0' });
  assert.equal(updater.state().status, 'ready');
  assert.equal(updater.checkIfStale(0), false);
  await updater.check();
  assert.equal(impl.checks, 2);
});

test('without automatic download the new version is only announced', async () => {
  const { createUpdater } = require('../src/updater');
  const impl = fakeUpdater();
  const updater = createUpdater({ app: { isPackaged: true, getVersion: () => '0.4.0' }, platform: 'darwin', env: {}, log: () => {}, isAutoDownload: () => true, onChange: () => {}, impl });
  await updater.check();
  assert.equal(impl.autoDownload, false, 'macOS never downloads: it cannot replace itself');
  impl.emit('update-available', { version: '0.5.0', releaseNotes: '' });
  assert.equal(updater.state().status, 'available');
  assert.match(updater.state().releaseUrl, /\/tag\/v0\.5\.0$/);
});
