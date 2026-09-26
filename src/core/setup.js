// Installs local transcription: the whisper.cpp binary (release zip on
// Windows, Homebrew on macOS) and a ggml model from Hugging Face.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WHISPER_DIR } = require('./config');
const { IS_WIN, isFile, run, which } = require('./proc');
const { findWhisperBin, modelPath } = require('./transcribe');

const MODELS = {
  tiny: 75,
  base: 142,
  small: 466,
  'medium-q5_0': 514,
  medium: 1530,
  'large-v3-turbo-q5_0': 547,
  'large-v3-turbo': 1620,
  'large-v3': 3100,
};

const modelUrl = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

async function download(url, dest, { onProgress, signal, headers } = {}) {
  const res = await fetch(url, { redirect: 'follow', signal, headers });
  if (!res.ok || !res.body) throw new Error(`Stahování selhalo (HTTP ${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  let received = 0;
  let reported = 0;
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress && Date.now() - reported > 250) {
        reported = Date.now();
        onProgress(received, total);
      }
    }
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    });
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }
  if (total && received !== total) {
    fs.rmSync(part, { force: true });
    throw new Error(`Stahování je neúplné (${received} z ${total} bajtů)`);
  }
  fs.renameSync(part, dest);
  if (onProgress) onProgress(received, total || received);
  return dest;
}

async function installModel(name, { onProgress, signal } = {}) {
  if (!MODELS[name]) throw new Error(`Neznámý model whisperu „${name}“. Dostupné: ${Object.keys(MODELS).join(', ')}`);
  const dest = modelPath(name);
  if (isFile(dest) && fs.statSync(dest).size > 10 * 1024 * 1024) return { file: dest, skipped: true };
  await download(modelUrl(name), dest, { onProgress, signal });
  return { file: dest, skipped: false };
}

// whisper.cpp publishes Windows zips on its per-build releases, so walk back
// until one has the asset we want.
async function findReleaseAsset(assetName) {
  const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20', {
    headers: { 'user-agent': 'brecord-setup', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API vrátilo HTTP ${res.status}`);
  for (const release of await res.json()) {
    const asset = (release.assets || []).find((a) => a.name === assetName);
    if (asset) return { url: asset.browser_download_url, tag: release.tag_name, size: asset.size };
  }
  throw new Error(`Žádné vydání whisper.cpp neobsahuje ${assetName}`);
}

const WINDOWS_ASSETS = {
  cpu: 'whisper-bin-x64.zip',
  blas: 'whisper-blas-bin-x64.zip',
  cuda: 'whisper-cublas-12.4.0-bin-x64.zip',
};

async function installWhisperWindows({ variant = 'cpu', onProgress, onLog, signal } = {}) {
  const assetName = process.arch === 'arm64' ? 'whisper-bin-win-cpu-arm64.zip' : WINDOWS_ASSETS[variant];
  if (!assetName) throw new Error(`Neznámá varianta „${variant}“ (cpu, blas, cuda)`);
  const { url, tag } = await findReleaseAsset(assetName);
  if (onLog) onLog(`Stahuji whisper.cpp ${tag} (${assetName})`);
  const zip = path.join(os.tmpdir(), `brecord-${tag}-${assetName}`);
  await download(url, zip, { onProgress, signal });
  const dest = path.join(WHISPER_DIR, tag);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // Windows 10+ ships bsdtar, which unpacks zip files.
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const res = await run(tar, ['-xf', zip, '-C', dest]);
  fs.rmSync(zip, { force: true });
  if (res.code !== 0) throw new Error(`Nepodařilo se rozbalit ${assetName}: ${res.stderr}`);
  for (const entry of fs.readdirSync(WHISPER_DIR)) {
    if (entry !== tag) fs.rmSync(path.join(WHISPER_DIR, entry), { recursive: true, force: true });
  }
  const bin = findWhisperBin('');
  if (!bin) throw new Error(`V ${assetName} chybí whisper-cli.exe`);
  return bin;
}

async function installWhisperMac({ onLog } = {}) {
  const brew = which('brew');
  if (!brew) throw new Error('Homebrew nebyl nalezen. Nainstalujte ho z https://brew.sh a spusťte: brew install whisper-cpp');
  if (onLog) onLog('Spouštím: brew install whisper-cpp');
  const res = await run(brew, ['install', 'whisper-cpp'], { onStdout: (d) => onLog && onLog(d.trim()), onStderr: (d) => onLog && onLog(d.trim()) });
  if (res.code !== 0) throw new Error(`brew install whisper-cpp selhal:\n${res.stderr.slice(-800)}`);
  const bin = findWhisperBin('');
  if (!bin) throw new Error('whisper-cli ani po instalaci přes brew nebyl nalezen');
  return bin;
}

// Linux: the ubuntu release archive (glibc, CPU build) with its shared
// libraries; transcribe.js points LD_LIBRARY_PATH at them.
async function installWhisperLinux({ onProgress, onLog, signal } = {}) {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!arch) throw new Error(`Pro architekturu ${process.arch} není hotový balíček whisper.cpp; sestavte ho a nastavte jeho cestu v Nastavení`);
  const assetName = `whisper-bin-ubuntu-${arch}.tar.gz`;
  const { url, tag } = await findReleaseAsset(assetName);
  if (onLog) onLog(`Stahuji whisper.cpp ${tag} (${assetName})`);
  const archive = path.join(os.tmpdir(), `brecord-${tag}-${assetName}`);
  await download(url, archive, { onProgress, signal });
  const dest = path.join(WHISPER_DIR, tag);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const res = await run('tar', ['-xzf', archive, '-C', dest]);
  fs.rmSync(archive, { force: true });
  if (res.code !== 0) throw new Error(`Nepodařilo se rozbalit ${assetName}: ${res.stderr}`);
  for (const entry of fs.readdirSync(WHISPER_DIR)) {
    if (entry !== tag) fs.rmSync(path.join(WHISPER_DIR, entry), { recursive: true, force: true });
  }
  const bin = findWhisperBin('');
  if (!bin) throw new Error(`V ${assetName} chybí whisper-cli`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function installWhisperBinary(opts = {}) {
  const existing = findWhisperBin('');
  if (existing && !opts.force) return { bin: existing, skipped: true };
  if (IS_WIN) return { bin: await installWhisperWindows(opts), skipped: false };
  if (process.platform === 'darwin') return { bin: await installWhisperMac(opts), skipped: false };
  if (process.platform === 'linux') return { bin: await installWhisperLinux(opts), skipped: false };
  throw new Error('Sestavte whisper.cpp z https://github.com/ggml-org/whisper.cpp a nastavte jeho cestu v Nastavení');
}

module.exports = { MODELS, download, installModel, installWhisperBinary, modelUrl };
