// Locating and running external tools (whisper.cpp, claude, codex).
// Handles the two classic desktop-app problems: GUI apps on macOS don't get
// the login shell's PATH, and on Windows npm-installed CLIs are .cmd shims
// that Node refuses to spawn without going through cmd.exe.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const running = new Set();

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

let pathFixed = false;
function fixPath() {
  if (pathFixed) return;
  pathFixed = true;
  const home = os.homedir();
  const extra = IS_WIN
    ? [path.join(home, '.local', 'bin'), process.env.APPDATA && path.join(process.env.APPDATA, 'npm')]
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.claude', 'local'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.bun', 'bin'),
        path.join(home, '.volta', 'bin'),
      ];
  let shellPath = '';
  if (!IS_WIN) {
    try {
      const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__BRECORD_PATH__%s" "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/__BRECORD_PATH__(.*)$/s);
      if (m) shellPath = m[1].trim();
    } catch {
      // A slow or broken shell profile shouldn't stop the app; the extra dirs still apply.
    }
  }
  const parts = [...(process.env.PATH || '').split(path.delimiter), ...shellPath.split(path.delimiter), ...extra];
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(path.delimiter);
}

function which(name) {
  fixPath();
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// npm's codex.cmd launches a Node wrapper that launches a native codex.exe;
// running the .exe directly avoids cmd.exe quoting entirely.
function nativeCodexFor(cmdPath) {
  const dir = path.dirname(cmdPath);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const pkg = path.join(dir, 'node_modules', '@openai', 'codex');
  return (
    [
      path.join(pkg, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(dir, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(pkg, 'vendor', triple, 'bin', 'codex.exe'),
    ].find(isFile) || null
  );
}

// cmd.exe escaping, as done by cross-spawn. npm shims re-expand %*, so
// metacharacters need a second round of escaping.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function escapeCmdArg(arg) {
  let s = String(arg);
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');
  s = `"${s}"`.replace(CMD_META, '^$1');
  return s.replace(CMD_META, '^$1');
}

// Returns how to spawn a resolved executable path: { command, args, verbatim }.
function invocation(file, args = []) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    const native = /codex\.cmd$/i.test(file) ? nativeCodexFor(file) : null;
    if (native) return { command: native, args, verbatim: false };
    const line = [file.replace(CMD_META, '^$1'), ...args.map(escapeCmdArg)].join(' ');
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { command: file, args, verbatim: false };
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (IS_WIN && child.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch {
      // Fall through to a plain kill.
    }
  }
  child.kill('SIGTERM');
}

function killAll() {
  for (const child of running) killTree(child);
}

// Spawns a tool and collects its output. stdout is kept (up to maxStdout);
// stderr keeps only the tail, which is what error messages need.
function run(file, args, opts = {}) {
  const { input, cwd, env, timeoutMs = 0, onStdout, onStderr, signal, lowPriority = false, maxStdout = 64 * 1024 * 1024 } = opts;
  const inv = invocation(file, args);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(inv.command, inv.args, {
        cwd,
        env: env || process.env,
        windowsHide: true,
        windowsVerbatimArguments: inv.verbatim,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    running.add(child);
    if (lowPriority && child.pid) {
      try {
        // Keep heavy jobs (whisper) from competing with a recording in progress.
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // not permitted on this system; run at normal priority
      }
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < maxStdout) stdout += d;
      if (onStdout) onStdout(d);
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-64 * 1024);
      if (onStderr) onStderr(d);
    });
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => {
      running.delete(child);
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      running.delete(child);
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) return reject(new Error('Zrušeno'));
      if (timedOut) return reject(new Error(`${path.basename(file)} nedoběhl do ${Math.round(timeoutMs / 1000)} s`));
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // the tool may exit before reading all input
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Like run() but leaves stdin open and returns the child for interactive
// flows (CLI logins). Output is streamed through callbacks.
function start(file, args, { cwd, env, onOutput, onExit } = {}) {
  const inv = invocation(file, args);
  const child = spawn(inv.command, inv.args, {
    cwd,
    env: env || process.env,
    windowsHide: true,
    windowsVerbatimArguments: inv.verbatim,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.add(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => onOutput && onOutput(d));
  child.stderr.on('data', (d) => onOutput && onOutput(d));
  child.stdin.on('error', () => {});
  child.on('error', (err) => {
    running.delete(child);
    if (onExit) onExit(null, err);
  });
  child.on('close', (code) => {
    running.delete(child);
    if (onExit) onExit(code, null);
  });
  return child;
}

const tail = (text, lines = 12) =>
  String(text || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join('\n');

module.exports = { IS_WIN, escapeCmdArg, fixPath, invocation, isFile, killAll, killTree, run, start, tail, which };
