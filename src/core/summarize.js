// Transcript -> { title, summary[5], decisions[], action_items[] } via one of
// several providers. The CLI providers (Claude Code, Codex) reuse the user's
// existing subscription login; the API providers read keys from ~/.minutes/.env.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CLIS, cliEnv, cliStatus, resolveCli } = require('./cli-tools');
const { cloudApisEnabled } = require('./config');
const { glossaryPrompt, parseGlossary } = require('./glossary');
const { run, tail } = require('./proc');
const { ME, THEM, turnsToPlain } = require('./transcript');

const NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'decisions', 'action_items'],
  properties: {
    title: { type: 'string', description: 'Short, specific meeting title (max 8 words)' },
    summary: { type: 'array', items: { type: 'string' }, description: 'Exactly 5 bullet points' },
    decisions: { type: 'array', items: { type: 'string' } },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'task', 'due'],
        properties: {
          owner: { type: 'string' },
          task: { type: 'string' },
          due: { type: 'string', description: 'Deadline if mentioned, else empty string' },
        },
      },
    },
  },
};

const CLI_TIMEOUT_MS = 20 * 60 * 1000;

const LANGUAGES = { cs: 'Czech', en: 'English', sk: 'Slovak', de: 'German', pl: 'Polish' };
const estimateTokens = (text) => Math.ceil(text.length / 3.2);

function systemPrompt({ myName, notesLanguage, labelled, glossary = [] }) {
  const code = notesLanguage || 'cs';
  const language = code === 'auto' ? null : LANGUAGES[code] || code;
  const me = myName ? `${myName} (labelled "${ME}")` : `the person who recorded it (labelled "${ME}")`;
  return [
    'You turn a raw meeting transcript into concise, accurate meeting notes.',
    'The transcript comes from automatic speech recognition: expect misheard words, missing punctuation and no speaker names. Silently fix obvious recognition errors when the meaning is clear.',
    labelled
      ? `Speaker labels: "${ME}" (Czech for "me") is ${me}, captured by their microphone. "${THEM}" (Czech for "others") is everyone heard through the computer's audio, i.e. the remote participants. Labels are inferred from audio levels and can be wrong on short or overlapping turns.`
      : 'The transcript has no speaker labels; attribute statements to people only when it is clear from context.',
    ...glossaryPrompt(glossary),
    '',
    'Produce:',
    '- title: a short, specific title for the meeting (at most 8 words).',
    '- summary: exactly 5 bullet points with the most important topics and outcomes, most important first (fewer only if the transcript is too short for five distinct points). One or two sentences each, concrete (names, numbers, dates) rather than generic.',
    '- decisions: every decision the participants actually agreed on. Not proposals, open questions or suggestions. Empty list if none.',
    `- action_items: every concrete follow-up someone committed to or was assigned. owner = the responsible person, named as in the meeting; use "${myName || ME}" for tasks the recorder took on; "${code === 'en' ? 'Unassigned' : 'Nepřiřazeno'}" if nobody clearly owns it. due = the deadline or timeframe if one was mentioned, otherwise an empty string. Empty list if none.`,
    '',
    myName
      ? `In the summary and decisions, refer to "${ME}" as ${myName}.`
      : `The notes are for the person who recorded them: in the summary and decisions, address "${ME}" as "you" (in Czech use the formal "vy" forms, e.g. "Požádal jste…").`,
    'Use only information from the transcript; never invent names, numbers or commitments.',
    `Write all text in ${language || 'the same language as the transcript (the dominant one if it is mixed)'}.`,
    'Respond with only a JSON object: {"title": string, "summary": [string], "decisions": [string], "action_items": [{"owner": string, "task": string, "due": string}]}.',
  ].join('\n');
}

function meetingHeader(meta = {}) {
  if (!meta.startedAt) return '';
  const d = new Date(meta.startedAt);
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const mins = meta.durationSec ? `, about ${Math.max(1, Math.round(meta.durationSec / 60))} min long` : '';
  return `Meeting date: ${date} (${day})${mins}. Use it to resolve relative dates such as "next Friday" (write due dates in the notes' language).`;
}

function parseJsonLoose(text) {
  let s = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error(`Odpověď neobsahovala JSON: ${s.slice(0, 200)}`);
  return JSON.parse(s.slice(a, b + 1));
}

function normalizeNotes(obj) {
  const str = (v) => (v == null ? '' : String(v)).trim();
  const list = (v) =>
    (Array.isArray(v) ? v : v ? [v] : [])
      .map((x) => (typeof x === 'string' ? x : x && (x.text || x.point || x.decision || x.summary)) || '')
      .map(str)
      .filter(Boolean);
  const actions = (Array.isArray(obj.action_items) ? obj.action_items : [])
    .map((a) => (typeof a === 'string' ? { owner: 'Nepřiřazeno', task: a, due: '' } : { owner: str(a.owner) || 'Nepřiřazeno', task: str(a.task || a.action || a.description), due: str(a.due || a.deadline) }))
    .filter((a) => a.task);
  return { title: str(obj.title), summary: list(obj.summary).slice(0, 5), decisions: list(obj.decisions), action_items: actions };
}

function splitByBudget(text, budgetTokens) {
  const parts = [];
  let current = [];
  let size = 0;
  for (const line of text.split('\n')) {
    const t = estimateTokens(line) + 1;
    if (size + t > budgetTokens && current.length) {
      parts.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += t;
  }
  if (current.length) parts.push(current.join('\n'));
  return parts;
}

// ---------------------------------------------------------------- providers

async function runClaudeCode(cfg, { system, user, signal }) {
  const bin = resolveCli('claude', cfg);
  if (!bin) throw new Error(`Claude Code CLI nebylo nalezeno. Instalace: ${CLIS.claude.install}`);
  const opts = cfg.settings.summary.claudeCode;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-claude-'));
  try {
    const systemFile = path.join(tmp, 'system.txt');
    fs.writeFileSync(systemFile, system);
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(NOTES_SCHEMA),
      '--system-prompt-file', systemFile,
      '--tools', '',
      '--no-session-persistence',
      '--safe-mode',
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    const res = await run(bin, args, { input: user, cwd: tmp, env: cliEnv(), timeoutMs: CLI_TIMEOUT_MS, signal });
    let out;
    try {
      out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    } catch {
      throw new Error(`neočekávaný výstup (kód ${res.code}): ${tail(res.stderr || res.stdout, 6)}`);
    }
    if (out.is_error) throw new Error(String(out.result || out.subtype || 'selhalo'));
    const usage = Object.entries(out.modelUsage || {}).sort((a, b) => (b[1].outputTokens || 0) - (a[1].outputTokens || 0));
    return { data: out.structured_output, text: out.result, model: (usage[0] && usage[0][0]) || opts.model || 'výchozí model' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runCodex(cfg, { system, user, signal }) {
  const bin = resolveCli('codex', cfg);
  if (!bin) throw new Error(`Codex CLI nebylo nalezeno. Instalace: ${CLIS.codex.install}`);
  const opts = cfg.settings.summary.codex;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minutes-codex-'));
  try {
    const schemaFile = path.join(tmp, 'schema.json');
    const outFile = path.join(tmp, 'last-message.txt');
    fs.writeFileSync(schemaFile, JSON.stringify(NOTES_SCHEMA));
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral', // don't keep the transcript in ~/.codex/sessions
      '--ignore-user-config', // no MCP servers / hooks from the user's config
      '--ignore-rules',
      '--sandbox', 'read-only',
      '--color', 'never',
      '-C', tmp,
      '--output-schema', schemaFile,
      '-o', outFile,
      '-c', 'analytics.enabled=false',
      '-c', 'feedback.enabled=false',
    ];
    if (opts.model) args.push('-m', opts.model);
    if (opts.effort) args.push('-c', `model_reasoning_effort=${opts.effort}`);
    args.push('-');
    const input = `${system}\n\nDo not run commands or read files; answer directly from the text below.\n\n${user}`;
    const res = await run(bin, args, { input, cwd: tmp, env: cliEnv(), timeoutMs: CLI_TIMEOUT_MS, signal, maxStdout: 4 * 1024 * 1024 });
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
    if (res.code !== 0 || !text) {
      // stderr echoes the whole prompt; the error is at the end.
      throw new Error(`kód ${res.code}: ${tail(res.stderr, 6) || 'žádný výstup'}`);
    }
    const model = (res.stderr.match(/^model:\s*(.+)$/m) || [])[1];
    return { text, model: (model && model.trim()) || opts.model || 'výchozí model' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runAnthropic(cfg, { system, user, signal }) {
  const key = cfg.keys.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY není nastavený');
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const model = cfg.settings.summary.anthropic.model || 'claude-opus-5';
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: NOTES_SCHEMA } },
  };
  if (/^claude-(opus-5|fable-5|mythos-5)/.test(model)) {
    // Re-run a safety-declined request on Anthropic's recommended fallback model.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let msg;
  try {
    msg = await client.beta.messages.stream(params, { signal }).finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('ANTHROPIC_API_KEY byl odmítnut', { cause: err });
    if (err instanceof Anthropic.RateLimitError) throw new Error('Limit Anthropic API je vyčerpaný, zkuste to později', { cause: err });
    throw err;
  }
  if (msg.stop_reason === 'refusal') throw new Error(`Claude požadavek odmítl (${(msg.stop_details && msg.stop_details.category) || 'refusal'})`);
  if (msg.stop_reason === 'max_tokens') throw new Error('Odpověď Claude byla useknutá (max_tokens)');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, model: msg.model || model };
}

async function postJson(url, headers, body, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 3;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
}

async function runOpenAICompatible({ base, key, model, system, user, signal }) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' } };
  let json;
  try {
    json = await postJson(`${base}/chat/completions`, headers, body, signal);
  } catch (err) {
    // Some OpenAI-compatible servers don't support JSON mode; the prompt still asks for JSON.
    if (err.status !== 400 || !/response_format|json/i.test(err.body || '')) throw err;
    delete body.response_format;
    json = await postJson(`${base}/chat/completions`, headers, body, signal);
  }
  return { text: json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content, model: json.model || model };
}

async function runOpenAI(cfg, args) {
  const o = cfg.settings.summary.openai;
  const base = (o.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  if (!cfg.keys.OPENAI_API_KEY && !o.baseUrl) throw new Error('OPENAI_API_KEY není nastavený');
  return runOpenAICompatible({ ...args, base, key: cfg.keys.OPENAI_API_KEY, model: o.model || 'gpt-5-mini' });
}

async function runGroq(cfg, args) {
  if (!cfg.keys.GROQ_API_KEY) throw new Error('GROQ_API_KEY není nastavený');
  return runOpenAICompatible({ ...args, base: 'https://api.groq.com/openai/v1', key: cfg.keys.GROQ_API_KEY, model: cfg.settings.summary.groq.model || 'openai/gpt-oss-120b' });
}

const ollamaHost = (cfg) => (cfg.settings.summary.ollama.host || 'http://127.0.0.1:11434').replace(/\/$/, '');

async function ollamaModels(cfg) {
  const res = await fetch(`${ollamaHost(cfg)}/api/tags`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.models || []).map((m) => m.name).filter((n) => !/embed/i.test(n));
}

async function ollamaReachable(cfg) {
  try {
    await ollamaModels(cfg);
    return true;
  } catch {
    return false;
  }
}

async function runOllama(cfg, { system, user, signal, estTokens }) {
  let model = cfg.settings.summary.ollama.model;
  if (!model) {
    let models;
    try {
      models = await ollamaModels(cfg);
    } catch {
      throw new Error(`Ollama neběží na ${ollamaHost(cfg)}`);
    }
    model = models[0];
    if (!model) throw new Error('Ollama nemá žádný model (např. spusťte: ollama pull llama3.1)');
  }
  // Ollama silently truncates input beyond num_ctx, so size it to the prompt.
  const numCtx = Math.min(32768, Math.max(8192, 2 ** Math.ceil(Math.log2(estTokens + 3000))));
  const timeout = AbortSignal.timeout(30 * 60 * 1000);
  const json = await postJson(
    `${ollamaHost(cfg)}/api/chat`,
    {},
    { model, stream: false, format: NOTES_SCHEMA, options: { num_ctx: numCtx, temperature: 0.2 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    signal ? AbortSignal.any([signal, timeout]) : timeout,
  );
  return { text: json.message && json.message.content, model };
}

const PROVIDERS = {
  'claude-code': { label: 'Claude Code', run: runClaudeCode, maxInputTokens: 150000 },
  codex: { label: 'Codex', run: runCodex, maxInputTokens: 150000 },
  ollama: { label: 'Ollama', run: runOllama, maxInputTokens: 12000 },
  anthropic: { label: 'Anthropic API', run: runAnthropic, maxInputTokens: 150000, api: true },
  openai: { label: 'OpenAI API', run: runOpenAI, maxInputTokens: 100000, api: true },
  // Groq's free tier caps tokens per minute, so keep requests small.
  groq: { label: 'Groq API', run: runGroq, maxInputTokens: 6000, api: true },
};

// ------------------------------------------------------------ orchestration

async function firstAvailable(cfg) {
  if ((await cliStatus('claude', cfg)).loggedIn) return 'claude-code';
  if ((await cliStatus('codex', cfg)).loggedIn) return 'codex';
  if (cloudApisEnabled(cfg)) {
    if (cfg.keys.ANTHROPIC_API_KEY) return 'anthropic';
    if (cfg.keys.OPENAI_API_KEY) return 'openai';
    if (cfg.keys.GROQ_API_KEY) return 'groq';
  }
  if (await ollamaReachable(cfg)) return 'ollama';
  return null;
}

async function resolvePlan(cfg) {
  const s = cfg.settings.summary;
  // API-key providers stay off while they are experimental.
  const allowed = (id) => !!PROVIDERS[id] && (!PROVIDERS[id].api || cloudApisEnabled(cfg));
  const primary = s.provider === 'auto' ? await firstAvailable(cfg) : s.provider;
  const plan = allowed(primary) ? [primary] : [];
  if (allowed(s.fallback) && !plan.includes(s.fallback)) plan.push(s.fallback);
  return plan;
}

async function summarizeWith(id, turns, cfg, { meta, signal, onStatus } = {}) {
  const provider = PROVIDERS[id];
  const s = cfg.settings;
  const system = systemPrompt({ myName: s.myName, notesLanguage: s.notesLanguage, labelled: turns.some((t) => t.speaker), glossary: parseGlossary(s.transcription.prompt) });
  const header = meetingHeader(meta);
  const transcript = turnsToPlain(turns);
  let model;
  const call = async (user) => {
    const r = await provider.run(cfg, { system, user, signal, estTokens: estimateTokens(system + user) });
    model = r.model;
    return normalizeNotes(r.data || parseJsonLoose(r.text));
  };

  if (estimateTokens(transcript) <= provider.maxInputTokens) {
    const notes = await call(`${header}\n\n<transcript>\n${transcript}\n</transcript>`);
    return { notes, provider: provider.label, model };
  }
  // Too long for one request: summarise parts, then merge the partial notes.
  const parts = splitByBudget(transcript, provider.maxInputTokens);
  const partials = [];
  for (let i = 0; i < parts.length; i++) {
    if (onStatus) onStatus(`shrnuji část ${i + 1}/${parts.length}`);
    partials.push(await call(`${header}\n\nThis is part ${i + 1} of ${parts.length} of one long meeting. Write notes for this part only (up to 5 summary bullets).\n\n<transcript>\n${parts[i]}\n</transcript>`));
  }
  if (onStatus) onStatus('spojuji části');
  const notes = await call(
    `${header}\n\nBelow are notes written separately for ${parts.length} consecutive parts of one meeting. Merge them into notes for the whole meeting: exactly 5 summary bullets covering the whole meeting, plus all decisions and action items with duplicates merged (keep owners and due dates).\n\n<partial_notes>\n${JSON.stringify(partials, null, 1)}\n</partial_notes>`,
  );
  return { notes, provider: provider.label, model };
}

async function summarize(turns, cfg, { meta, onStatus, signal } = {}) {
  const plan = await resolvePlan(cfg);
  if (!plan.length) {
    throw new Error('Není k dispozici žádný poskytovatel shrnutí. Otevřete Nastavení → AI shrnutí a přihlaste se do Claude Code nebo Codexu, případně spusťte Ollamu.');
  }
  const errors = [];
  for (const [i, id] of plan.entries()) {
    const provider = PROVIDERS[id];
    if (id === 'ollama' && i > 0 && !(await ollamaReachable(cfg))) {
      errors.push('Záložní Ollama: neběží');
      continue;
    }
    try {
      if (onStatus) onStatus(`shrnuji přes ${provider.label}`);
      const result = await summarizeWith(id, turns, cfg, { meta, signal, onStatus });
      return { ...result, warnings: errors };
    } catch (err) {
      if (signal && signal.aborted) throw err;
      errors.push(`${provider.label}: ${err.message}`);
    }
  }
  throw new Error(`Shrnutí selhalo.\n${errors.join('\n')}`);
}

// Used by the Settings window's "Test" buttons.
async function testProvider(id, cfg) {
  const turns = [
    { start: 2, speaker: ME, text: 'Pojďme potvrdit termín spuštění. Navrhuji čtrnáctého října.' },
    { start: 9, speaker: THEM, text: 'Souhlasím, čtrnáctý platí. Petra pošle návrh tiskové zprávy do pátku.' },
    { start: 16, speaker: ME, text: 'Výborně, já do té doby aktualizuji ceník na webu.' },
  ];
  const started = Date.now();
  const result = await summarizeWith(id, turns, cfg, { meta: { startedAt: Date.now(), durationSec: 20 } });
  return { ...result, ms: Date.now() - started };
}

module.exports = { LANGUAGES, NOTES_SCHEMA, PROVIDERS, estimateTokens, normalizeNotes, ollamaModels, ollamaReachable, parseJsonLoose, resolvePlan, splitByBudget, summarize, summarizeWith, systemPrompt, testProvider };
