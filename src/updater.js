// Automatic updates from GitHub Releases (electron-updater).
//
// How an update gets installed depends on the package:
//   Windows (NSIS) and Linux AppImage: downloaded in the background,
//     installed on quit or with "Restartovat a nainstalovat".
//   macOS and Linux .deb: the new version is announced with a link to the
//     release. Squirrel.Mac only swaps an app signed with a Developer ID, and
//     BRecord is ad-hoc signed; a .deb belongs to the package manager.
//
// The feed is the latest published (non-draft, non-prerelease) release of
// github.com/myspulin24/brecord, set by `build.publish` in package.json.
'use strict';

const RELEASES_URL = 'https://github.com/myspulin24/brecord/releases';
const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function updateMode({ packaged, platform, env }) {
  if (!packaged) return 'dev';
  if (platform === 'win32') return 'auto';
  if (platform === 'linux') return env.APPIMAGE ? 'auto' : 'manual';
  return 'manual';
}

// GitHub renders release notes to HTML; the UI shows them as plain lines.
function notesToText(notes) {
  const raw = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes || '');
  return raw
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|h[1-6]|li|ul|ol|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function createUpdater({ app, log, isAutoDownload, shouldAutoCheck = () => true, onChange }) {
  const mode = updateMode({ packaged: app.isPackaged, platform: process.platform, env: process.env });
  const state = { mode, status: mode === 'dev' ? 'unsupported' : 'idle', current: app.getVersion(), version: null, notes: '', progress: 0, error: null, checkedAt: null, releaseUrl: `${RELEASES_URL}/latest` };
  let autoUpdater = null;
  let timer = null;

  const set = (patch) => {
    Object.assign(state, patch);
    onChange({ ...state });
  };

  if (mode !== 'dev') {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.logger = { info: (m) => log('updater', m), warn: (m) => log('updater', m), error: (m) => log('updater', m), debug: () => {} };
    autoUpdater.autoDownload = false; // decided per check, see check()
    autoUpdater.autoInstallOnAppQuit = mode === 'auto';
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => set({ status: 'current', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (info) => {
      set({
        status: mode === 'auto' && autoUpdater.autoDownload ? 'downloading' : 'available',
        version: info.version,
        notes: notesToText(info.releaseNotes),
        releaseUrl: `${RELEASES_URL}/tag/v${info.version}`,
        progress: 0,
        checkedAt: Date.now(),
      });
    });
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: Math.max(0, Math.min(1, (p.percent || 0) / 100)) }));
    autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, progress: 1 }));
    autoUpdater.on('error', (err) => {
      // Offline or GitHub unreachable: not worth alarming anyone, try again later.
      set({ status: state.status === 'downloading' ? 'available' : 'error', error: err ? err.message : 'Neznámá chyba' });
    });
  }

  async function check({ manual = false } = {}) {
    if (!autoUpdater || state.status === 'downloading' || state.status === 'ready') return { ...state };
    autoUpdater.autoDownload = mode === 'auto' && isAutoDownload();
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set({ status: 'error', error: err.message });
      if (manual) throw err;
    }
    return { ...state };
  }

  async function download() {
    if (!autoUpdater || mode !== 'auto' || state.status !== 'available') return { ...state };
    set({ status: 'downloading', progress: 0 });
    await autoUpdater.downloadUpdate();
    return { ...state };
  }

  function install() {
    if (!autoUpdater || state.status !== 'ready') return false;
    // Silent install, then start the new version.
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  function start() {
    if (!autoUpdater) return;
    const tick = () => shouldAutoCheck() && check();
    setTimeout(tick, FIRST_CHECK_MS);
    timer = setInterval(tick, CHECK_EVERY_MS);
  }

  function stop() {
    clearInterval(timer);
  }

  return { state: () => ({ ...state }), check, download, install, start, stop };
}

module.exports = { RELEASES_URL, createUpdater, notesToText, updateMode };
