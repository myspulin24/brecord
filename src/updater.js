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
//
// GitHub is asked right after start and whenever the window is opened again
// after a while; the window then offers the downloaded version (see the
// update offer in ui/app.js).
'use strict';

const RELEASES_URL = 'https://github.com/myspulin24/brecord/releases';
const FIRST_CHECK_MS = 3 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
// While one of these lasts, GitHub isn't asked again.
const BUSY = ['checking', 'downloading', 'ready'];

function updateMode({ packaged, platform, env }) {
  if (!packaged) return 'dev';
  if (platform === 'win32') return 'auto';
  if (platform === 'linux') return env.APPIMAGE ? 'auto' : 'manual';
  return 'manual';
}

// GitHub renders release notes to HTML; the UI shows them as plain lines:
// a heading, then its "• " items, one per line. CHANGELOG wraps its lines at
// 80 columns and GitHub turns every wrap into <br>, so those are spaces.
function notesToText(notes) {
  const raw = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes || '');
  // Below the rule the release page lists downloads, which the app doesn't need.
  return raw
    .split(/<hr\s*\/?>/i)[0]
    .replace(/\s*\n\s*/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<(h[1-6]|p)(\s[^>]*)?>/gi, '\n\n')
    .replace(/<li(\s[^>]*)?>/gi, '\n• ')
    .replace(/<\/(p|ul|ol)>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>?/g, '')
    .replace(/[<>]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function createUpdater({ app, log, isAutoDownload, shouldAutoCheck = () => true, onChange, platform = process.platform, env = process.env, impl }) {
  const mode = updateMode({ packaged: app.isPackaged, platform, env });
  const state = { mode, status: mode === 'dev' ? 'unsupported' : 'idle', current: app.getVersion(), version: null, notes: '', progress: 0, error: null, checkedAt: null, releaseUrl: `${RELEASES_URL}/latest` };
  let autoUpdater = null;
  let timer = null;
  let lastAttempt = 0;

  const set = (patch) => {
    Object.assign(state, patch);
    onChange({ ...state });
  };

  if (mode !== 'dev') {
    autoUpdater = impl || require('electron-updater').autoUpdater;
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
    if (!autoUpdater || BUSY.includes(state.status)) return { ...state };
    lastAttempt = Date.now();
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

  // The window came back after a while (BRecord lives in the tray for days):
  // ask again, so what it shows is never hours old.
  function checkIfStale(maxAgeMs = STALE_MS) {
    if (!autoUpdater || !shouldAutoCheck() || BUSY.includes(state.status) || Date.now() - lastAttempt < maxAgeMs) return false;
    check();
    return true;
  }

  function stop() {
    clearInterval(timer);
  }

  return { state: () => ({ ...state }), check, checkIfStale, download, install, start, stop };
}

module.exports = { FIRST_CHECK_MS, RELEASES_URL, STALE_MS, createUpdater, notesToText, updateMode };
