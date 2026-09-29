// Where notes open: Pilcrow, the Markdown editor, when it is installed, the
// system's default app for .md files otherwise.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isFile, which } = require('./proc');

const PILCROW_RELEASES = 'https://github.com/myspulin24/pilcrow/releases/latest';

// Where the Pilcrow installers put the app: NSIS per user or per machine,
// the .app bundle, and the deb/rpm binary on the PATH.
function pilcrowCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    return [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Pilcrow', 'Pilcrow.exe'), env.ProgramFiles && path.join(env.ProgramFiles, 'Pilcrow', 'Pilcrow.exe')].filter(Boolean);
  }
  if (platform === 'darwin') return ['/Applications/Pilcrow.app', path.join(os.homedir(), 'Applications', 'Pilcrow.app')];
  return [];
}

function findPilcrow() {
  if (process.platform === 'darwin') return pilcrowCandidates().find((app) => fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) || null;
  const found = pilcrowCandidates().find(isFile);
  if (found) return found;
  return process.platform === 'win32' ? null : which('Pilcrow') || which('pilcrow');
}

// macOS hands the file to the app bundle as a document, elsewhere it is the
// first argument; a running Pilcrow picks it up itself.
function pilcrowCommand(app, file, platform = process.platform) {
  return platform === 'darwin' ? ['open', ['-a', app, file]] : [app, [file]];
}

// Resolves to 'pilcrow' or 'system', whichever the note went to. If Pilcrow
// can't be started, the note still opens, in the default app.
function openNote(file, { editor = 'pilcrow', openPath }) {
  const fallback = () => Promise.resolve(openPath(file)).then(() => 'system');
  const app = editor === 'pilcrow' ? findPilcrow() : null;
  if (!app) return fallback();
  const [command, args] = pilcrowCommand(app, file);
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      child.unref();
      resolve('pilcrow');
    });
    child.once('error', () => resolve(fallback()));
  });
}

module.exports = { PILCROW_RELEASES, findPilcrow, openNote, pilcrowCandidates, pilcrowCommand };
