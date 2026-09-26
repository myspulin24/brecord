// Claude Code and Codex CLIs: discovery, version, login status, login/logout.
// Both CLIs keep their own credentials (keychain / ~/.claude, ~/.codex);
// BRecord never sees tokens, it only drives the CLIs' own auth commands.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { expandHome } = require('./config');
const { IS_WIN, escapeCmdArg, invocation, isFile, killTree, run, start, tail, which } = require('./proc');

const CLIS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    settingsKey: 'claudeCode',
    provider: 'claude-code',
    install: 'npm install -g @anthropic-ai/claude-code',
    docs: 'https://docs.claude.com/en/docs/claude-code/setup',
    loginModes: {
      subscription: { label: 'Předplatné Claude', args: ['auth', 'login', '--claudeai'] },
      console: { label: 'Anthropic Console', args: ['auth', 'login', '--console'] },
    },
    logoutArgs: ['auth', 'logout'],
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    settingsKey: 'codex',
    provider: 'codex',
    install: 'npm install -g @openai/codex',
    docs: 'https://developers.openai.com/codex/cli',
    loginModes: {
      chatgpt: { label: 'Účet ChatGPT', args: ['login'] },
      device: { label: 'Kód zařízení', args: ['login', '--device-auth'] },
      apikey: { label: 'API klíč OpenAI', args: ['login', '--with-api-key'], needsSecret: true },
    },
    logoutArgs: ['logout'],
  },
};

// Keeps the CLIs from sending their own usage telemetry when we drive them.
const QUIET_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', NO_COLOR: '1' };

function cliEnv() {
  return { ...process.env, ...QUIET_ENV };
}

function resolveCli(id, cfg) {
  const def = CLIS[id];
  const override = cfg.settings.summary[def.settingsKey].path;
  if (override) {
    const p = path.resolve(expandHome(override));
    return isFile(p) ? p : null;
  }
  return which(def.bin);
}

const cache = new Map();
const CACHE_MS = 15000;

async function cliStatus(id, cfg, { fresh = false } = {}) {
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.status;
  const def = CLIS[id];
  const status = { id, label: def.label, installed: false, path: null, version: null, loggedIn: false, account: null, error: null };
  status.path = resolveCli(id, cfg);
  if (status.path) {
    try {
      const v = await run(status.path, ['--version'], { env: cliEnv(), timeoutMs: 20000 });
      status.installed = v.code === 0;
      status.version = tail(v.stdout || v.stderr, 1) || null;
      if (!status.installed) status.error = tail(v.stderr || v.stdout, 3);
    } catch (err) {
      status.error = err.message;
    }
  }
  if (status.installed) {
    try {
      if (id === 'claude') {
        const r = await run(status.path, ['auth', 'status', '--json'], { env: cliEnv(), timeoutMs: 20000 });
        const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
        status.loggedIn = !!j.loggedIn;
        if (j.loggedIn) {
          const plan = j.subscriptionType ? `tarif ${j.subscriptionType}` : j.authMethod;
          status.account = [j.email, plan].filter(Boolean).join(' · ');
        }
      } else {
        const r = await run(status.path, ['login', 'status'], { env: cliEnv(), timeoutMs: 20000 });
        const text = tail(`${r.stdout}\n${r.stderr}`, 3);
        status.loggedIn = r.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
        status.account = status.loggedIn ? text.replace(/^Logged in (using|with)\s*/i, '') : null;
      }
    } catch (err) {
      status.error = `Nepodařilo se zjistit stav přihlášení: ${err.message}`;
    }
  }
  cache.set(id, { at: Date.now(), status });
  return status;
}

function invalidate(id) {
  if (id) cache.delete(id);
  else cache.clear();
}

// Runs the CLI's own login command with piped stdio. Output (including the
// sign-in URL) is streamed to onOutput; write() answers prompts such as
// "paste the code". For API-key logins the secret goes to stdin.
function startLogin(id, cfg, mode, { secret, onOutput, onExit } = {}) {
  const def = CLIS[id];
  const loginMode = def.loginModes[mode];
  if (!loginMode) throw new Error(`Neznámý způsob přihlášení ${mode}`);
  const bin = resolveCli(id, cfg);
  if (!bin) throw new Error(`${def.label} CLI nebylo nalezeno. Nainstalujte ho příkazem: ${def.install}`);
  invalidate(id);
  const child = start(bin, loginMode.args, {
    env: cliEnv(),
    onOutput,
    onExit: (code, err) => {
      invalidate(id);
      if (onExit) onExit(code, err);
    },
  });
  if (loginMode.needsSecret) child.stdin.end(`${secret || ''}\n`);
  return {
    write: (text) => {
      if (child.stdin.writable) child.stdin.write(`${text}\n`);
    },
    cancel: () => killTree(child),
  };
}

async function logout(id, cfg) {
  const def = CLIS[id];
  const bin = resolveCli(id, cfg);
  if (!bin) throw new Error(`${def.label} CLI nebylo nalezeno`);
  invalidate(id);
  const r = await run(bin, def.logoutArgs, { env: cliEnv(), timeoutMs: 30000 });
  invalidate(id);
  if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout, 4) || `exit ${r.code}`);
}

// Command line for a new console window: "start" hands it to a second
// cmd.exe, so arguments go through two parsing passes, which escapeCmdArg's
// double escaping is made for. npm's codex.cmd resolves to codex.exe.
function windowsTerminalLine(bin, args, launcher = 'start "BRecord" cmd /d /k') {
  const inv = invocation(bin, args);
  const cmdline = inv.verbatim ? [bin, ...args] : [inv.command, ...inv.args];
  return `${launcher} ${cmdline.map(escapeCmdArg).join(' ')}`;
}

// Fallback for login flows that insist on a real terminal.
function openLoginInTerminal(id, cfg, mode) {
  const def = CLIS[id];
  const bin = resolveCli(id, cfg) || def.bin;
  const args = def.loginModes[mode || Object.keys(def.loginModes)[0]].args;
  if (process.platform === 'darwin') {
    const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const command = [bin, ...args].map(quote).join(' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${command}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
  } else if (IS_WIN) {
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${windowsTerminalLine(bin, args)}"`], { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', bin, ...args], { detached: true, stdio: 'ignore' }).unref();
  }
}

module.exports = { CLIS, QUIET_ENV, cliEnv, cliStatus, invalidate, logout, openLoginInTerminal, resolveCli, startLogin, windowsTerminalLine };
