// SCROLL — provider adapters (vendor-neutral model layer for `scroll run` & `scroll chat`).
// Zero-dep: Node built-ins + global fetch (Node >= 20).
//
// A provider exposes:  { name, model, ready, missing, generate(prompt, opts), close?() }
//   generate(prompt, { model, maxTokens, cwd, system, cachePrefix, messages, tools, images, onDelta, signal, authStore, effort, threadId })
//     -> { text, toolCalls?, usage:{ uncachedInputTokens, cachedInputTokens, outputTokens, providerTotalTokens }, durationMs, responseId, threadId? }
//
// The runtime is what drives the loop; providers only turn a prompt/messages into text+toolCalls+usage.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createCodexAppServerClient, findCodexBinary } from './codex-app-server.js';

const approxTokens = (s) => Math.max(1, Math.ceil((s || '').length / 4));

// Tool-strip hook: a reasoning-only agent (toolPolicy 'none') doesn't need the CLI's tool schemas.
// Flags are env-configured (verify the exact flag per CLI version) — empty by default, so this is safe.
function leanFlags(toolPolicy) {
  if (toolPolicy !== 'none') return [];
  const raw = process.env.SCROLL_LEAN_CLI_FLAGS;
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Fall through to simple whitespace splitting below.
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

// ── command helpers ──────────────────────────────────────────────────────────
function commandExists(command) {
  if (command.includes('/')) return fs.existsSync(command);
  const r = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(command)}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim();
}

function runCommand(command, args, { cwd, input = '', timeoutMs = 300000 } = {}) {
  const started = Date.now();
  const child = spawnSync(command, args, {
    cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error([`${command} exited ${child.status}`, child.stderr, child.stdout].filter(Boolean).join('\n').slice(0, 4000));
  }
  return { stdout: child.stdout || '', durationMs };
}

function parseJsonLines(stdout) {
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function formatMessagesForPrompt(prompt, messages, system) {
  if (Array.isArray(messages) && messages.length) {
    const parts = [];
    if (system) parts.push(`[System]\n${system}`);
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'Assistant' : (m.role === 'tool' ? `Tool(${m.name || 'tool'})` : 'User');
      parts.push(`[${role}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`);
    }
    return parts.join('\n\n');
  }
  return system && !String(prompt || '').startsWith(system) ? `${system}\n\n${prompt || ''}` : String(prompt || '');
}

function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

function attachImagesToOpenAiContent(text, images) {
  if (!Array.isArray(images) || !images.length) return text;
  const parts = [{ type: 'text', text: String(text || '') }];
  for (const img of images) {
    if (!img) continue;
    if (img.url) {
      parts.push({ type: 'image_url', image_url: { url: img.url } });
    } else if (img.base64) {
      const mime = img.mimeType || 'image/jpeg';
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${img.base64}` } });
    } else if (img.path && fs.existsSync(img.path)) {
      const mime = img.mimeType || (img.path.endsWith('.png') ? 'image/png' : 'image/jpeg');
      const b64 = fs.readFileSync(img.path).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
    }
  }
  return parts;
}

// ── MOCK (deterministic — proves runtime mechanics without spending tokens) ────
// Caching is simulated: the first time a given cachePrefix is seen it is "uncached";
// subsequent calls with the same prefix bill it as cached (this is what a real
// stable-prefix cache does — the runtime is responsible for ordering it stably).
function makeMockProvider({ scriptedTurns = null } = {}) {
  const seenPrefixes = new Set();
  let turnIdx = 0;
  return {
    name: 'mock', model: 'mock-1', ready: true, missing: null,
    async generate(prompt, { cachePrefix = '', system = '', messages = null, onDelta = null, scriptedTurns: callScript = null } = {}) {
      const t0 = Date.now();
      const effectivePrompt = Array.isArray(messages) && messages.length
        ? formatMessagesForPrompt(prompt, messages, '')
        : String(prompt ?? '');
      const prefix = cachePrefix || system || '';
      const prefixTok = approxTokens(prefix);
      const bodyTok = approxTokens(effectivePrompt) - (cachePrefix && effectivePrompt.includes(cachePrefix) ? prefixTok : 0);
      const cached = prefix && seenPrefixes.has(prefix);
      if (prefix) seenPrefixes.add(prefix);

      const script = callScript || scriptedTurns;
      let text;
      let toolCalls = [];
      if (Array.isArray(script) && turnIdx < script.length) {
        const entry = script[turnIdx++];
        if (typeof entry === 'function') {
          const out = await entry({ prompt: effectivePrompt, system, messages });
          text = out?.text ?? '';
          toolCalls = Array.isArray(out?.toolCalls) ? out.toolCalls : [];
        } else if (typeof entry === 'string') {
          text = entry;
        } else {
          text = entry?.text ?? '';
          toolCalls = Array.isArray(entry?.toolCalls) ? entry.toolCalls : [];
        }
      } else {
        text = mockAnswer(effectivePrompt);
      }

      if (typeof onDelta === 'function' && text) {
        onDelta(text);
      }
      return {
        text,
        toolCalls,
        usage: {
          uncachedInputTokens: cached ? Math.max(1, bodyTok) : approxTokens(effectivePrompt),
          cachedInputTokens: cached ? prefixTok : 0,
          outputTokens: approxTokens(text),
          providerTotalTokens: approxTokens(effectivePrompt) + approxTokens(text),
        },
        durationMs: Date.now() - t0 + 5,
        responseId: 'mock-' + Math.random().toString(36).slice(2, 10),
      };
    },
  };
}

// A structured answer that satisfies a Verdict/Evidence/Assumptions/Next-actions
// contract, cites whatever [S#] source ids appear in the prompt, and never repeats
// the planted trap phrasing.
function mockAnswer(prompt) {
  // judge mode (deterministic): if asked to grade, return a fixed parseable score (4.5).
  // Lets the eval LLM-judge path be tested with 0 tokens; real grading uses a real provider.
  if (prompt.includes('SCROLL_JUDGE_JSON')) return '{"scores": {"faithfulness": 5, "clarity": 4, "honesty": 4.5}, "average": 4.5}';
  const sources = [...new Set((prompt.match(/\bS\d\b/g) || []))];
  const c = (i) => (sources[i] ? `[${sources[i]}]` : '');
  const objMatch = prompt.match(/objective:\s*(.+)/i);
  const objective = objMatch ? objMatch[1].trim().slice(0, 120) : 'the requested task';
  return [
    '## Verdict',
    `Conditional go — treat as a measured pilot, not a finished product ${c(0)}.`,
    '',
    '## Evidence',
    `- The core problem is drift/fragmentation across runtimes ${c(0)}.`,
    `- The proposed approach is a single source of truth that renders to each runtime ${c(1)}.`,
    '',
    '## Assumptions',
    `- Production-grade runtime claims stay unmeasured until a real runner exists ${c(2)}.`,
    `- Objective addressed: ${objective}.`,
    '',
    '## Next actions',
    '1. Build the minimal runtime and measure on a real multi-step task.',
    '2. Re-run the eval with >=3 repeats through an API provider.',
  ].join('\n');
}

// ── Codex App-Server (v2.0 §46 persistent JSON-RPC stdio client) ──────────────
function makeCodexAppServerProvider({
  model = null,
  command = null,
  args = null,
  searchPaths = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 120_000,
  effort = null,
  client = null,
} = {}) {
  const rpc = client || createCodexAppServerClient({
    command,
    args,
    searchPaths,
    cwd,
    env,
    timeoutMs,
    defaultModel: model || process.env.CODEX_MODEL || null,
  });
  return {
    name: 'codex-app-server',
    model: model || process.env.CODEX_MODEL || 'auto',
    get ready() { return client ? true : Boolean(findCodexBinary({ command, searchPaths, env })); },
    missing: 'codex binary not found (set CODEX_APP_SERVER_BIN or install codex CLI)',
    client: rpc,
    async generate(prompt, {
      model: m,
      system,
      messages,
      tools,
      onToolCall,
      images,
      effort: e,
      threadId,
      ephemeral = true,
      onDelta,
      signal,
      timeoutMs: tMs,
    } = {}) {
      const res = await rpc.generate(prompt, {
        model: m || (this.model !== 'auto' ? this.model : null),
        system,
        messages,
        tools,
        onToolCall,
        images,
        effort: e || effort,
        threadId,
        ephemeral,
        onDelta,
        signal,
        timeoutMs: tMs || timeoutMs,
      });
      return {
        text: res.text,
        toolCalls: [],
        usage: res.usage,
        durationMs: res.durationMs,
        responseId: res.responseId,
        threadId: res.threadId,
        model: res.model,
      };
    },
    async close() {
      await rpc.close();
    },
  };
}

// ── Codex CLI ─────────────────────────────────────────────────────────────────
// v1.6: pure arg builders (unit-testable, no spawn).
export function codexArgs({ model, toolPolicy, sandbox, effort } = {}) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '--ephemeral'];
  args.push('--sandbox', sandbox === 'write' ? 'workspace-write' : 'read-only');
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (model) args.push('--model', model);
  args.push(...leanFlags(toolPolicy));
  args.push('-'); // prompt via stdin — long prompts never hit argv limits
  return args;
}
function makeCodexProvider({ model } = {}) {
  return {
    name: 'codex-cli', model: model || process.env.CODEX_MODEL || 'codex-default',
    ready: Boolean(commandExists('codex')), missing: 'codex CLI not on PATH',
    async generate(prompt, { cwd, model: m, toolPolicy, sandbox, effort, timeoutMs, system, messages } = {}) {
      const input = Array.isArray(messages) && messages.length ? formatMessagesForPrompt(prompt, messages, system) : prompt;
      const args = codexArgs({ model: (process.env.CODEX_MODEL || m) ? (m || this.model) : null, toolPolicy, sandbox, effort });
      const { stdout, durationMs } = runCommand('codex', args, { cwd, input, timeoutMs: timeoutMs || (sandbox === 'write' ? 900000 : 300000) });
      const events = parseJsonLines(stdout);
      const msg = events.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text || '');
      const done = [...events].reverse().find((e) => e.type === 'turn.completed');
      const u = done?.usage || {};
      const inputTok = Number(u.input_tokens || 0), cached = Number(u.cached_input_tokens || 0);
      return {
        text: msg.at(-1) || '',
        toolCalls: [],
        usage: { uncachedInputTokens: Math.max(0, inputTok - cached), cachedInputTokens: cached, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: inputTok + Number(u.output_tokens || 0) },
        durationMs, responseId: events.find((e) => e.type === 'thread.started')?.thread_id || null,
      };
    },
  };
}

// ── Claude CLI ──────────────────────────────────────────────────────────────
function makeClaudeProvider({ model } = {}) {
  const bin = process.env.CLAUDE_CLI || 'claude';
  return {
    name: 'claude-cli', model: model || process.env.CLAUDE_MODEL || 'claude-default',
    ready: Boolean(commandExists(bin)), missing: `Claude CLI not found (${bin})`,
    async generate(prompt, { cwd, model: m, toolPolicy, system, messages } = {}) {
      const fullPrompt = Array.isArray(messages) && messages.length ? formatMessagesForPrompt(prompt, messages, system) : prompt;
      // Runs in an isolated cwd (caller's scratch dir) so repo CLAUDE.md does not leak in.
      const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk'];
      if (process.env.CLAUDE_MODEL || m) args.push('--model', m || this.model);
      args.push(...leanFlags(toolPolicy));
      args.push(fullPrompt);
      const { stdout, durationMs } = runCommand(bin, args, { cwd });
      const j = JSON.parse(stdout);
      const u = j.usage || {};
      const input = Number(u.input_tokens || 0), cc = Number(u.cache_creation_input_tokens || 0), cr = Number(u.cache_read_input_tokens || 0);
      return {
        text: j.result || '',
        toolCalls: [],
        usage: { uncachedInputTokens: input + cc, cachedInputTokens: cr, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: input + cc + cr + Number(u.output_tokens || 0) },
        durationMs: Number(j.duration_ms || durationMs), responseId: j.session_id || null,
      };
    },
  };
}

// ── API providers (fetch) ─────────────────────────────────────────────────────
async function fetchJson(url, opts, fetchImpl = globalThis.fetch) {
  const started = Date.now();
  const res = await fetchImpl(url, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const e = new Error(json?.error?.message || text.slice(0, 300));
    e.status = res.status;
    const ra = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    if (ra && !Number.isNaN(Number(ra))) e.retryAfterMs = Number(ra) * 1000;
    throw e;
  }
  return { json, durationMs: Date.now() - started };
}

async function fetchOpenAiSse(url, opts, { onDelta, fetchImpl = globalThis.fetch } = {}) {
  const started = Date.now();
  const res = await fetchImpl(url, opts);
  if (!res.ok) {
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    const e = new Error(json?.error?.message || text.slice(0, 300));
    e.status = res.status;
    throw e;
  }
  const ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
  if (!ct.includes('text/event-stream') || !res.body) {
    const json = await res.json();
    return { json, durationMs: Date.now() - started, streamed: false };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let responseId = null;
  let usage = null;
  const toolAcc = new Map();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.id) responseId = chunk.id;
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        if (typeof onDelta === 'function') onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const k = tc.index ?? 0;
          const prev = toolAcc.get(k) || { id: tc.id || `call_${k}`, name: '', argumentsRaw: '' };
          if (tc.id) prev.id = tc.id;
          if (tc.function?.name) prev.name += tc.function.name;
          if (tc.function?.arguments) prev.argumentsRaw += tc.function.arguments;
          toolAcc.set(k, prev);
        }
      }
    }
  }
  const toolCalls = [...toolAcc.values()].map((t) => {
    let args = {};
    try { args = JSON.parse(t.argumentsRaw || '{}'); } catch { args = { raw: t.argumentsRaw }; }
    return { id: t.id, name: t.name, arguments: args };
  });
  return {
    streamed: true,
    text,
    toolCalls,
    usage,
    responseId,
    durationMs: Date.now() - started,
  };
}

function buildOpenAiChatMessages(prompt, { system, messages, images } = {}) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  if (Array.isArray(messages) && messages.length) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const isLastUser = i === messages.length - 1 && m.role === 'user';
      if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId || m.id || 'call_0', name: m.name, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      } else if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) },
          })),
        });
      } else {
        const content = isLastUser && Array.isArray(images) && images.length
          ? attachImagesToOpenAiContent(m.content, images)
          : m.content;
        out.push({ role: m.role || 'user', content });
      }
    }
  } else {
    out.push({ role: 'user', content: attachImagesToOpenAiContent(prompt, images) });
  }
  return out;
}

function parseOpenAiChatResponse(json, durationMs, onDelta) {
  const msg = json.choices?.[0]?.message || {};
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (typeof onDelta === 'function' && text) onDelta(text);
  const toolCalls = (msg.tool_calls || []).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = { raw: tc.function?.arguments }; }
    return { id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`, name: tc.function?.name || '', arguments: args };
  });
  const u = json.usage || {};
  const cached = Number(u.prompt_tokens_details?.cached_tokens || 0);
  const input = Number(u.prompt_tokens || 0);
  const output = Number(u.completion_tokens || 0);
  return {
    text,
    toolCalls,
    usage: {
      uncachedInputTokens: Math.max(0, input - cached),
      cachedInputTokens: cached,
      outputTokens: output,
      providerTotalTokens: Number(u.total_tokens || (input + output)),
    },
    durationMs,
    responseId: json.id || null,
  };
}

// ── OpenAI-compatible HTTP provider (v2.0 §46: OAuth/API/Proxy + tools + vision + SSE) ──
function makeOpenAICompatibleProvider({
  model = null,
  baseUrl = null,
  apiKey = null,
  authStore = null,
  providerId = 'openai',
  headers = {},
  cacheKey: defaultCacheKey = null,
  cacheTtl: defaultCacheTtl = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolvedBase = (baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const resolvedKey = apiKey || process.env.OPENAI_API_KEY || null;
  return {
    name: 'openai-compatible',
    model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    get ready() {
      if (resolvedKey) return true;
      if (authStore && authStore.listProfiles({ provider: providerId }).length > 0) return true;
      return Boolean(baseUrl);
    },
    missing: 'apiKey, authStore profile, or baseUrl not configured',
    async generate(prompt, {
      maxTokens = 1200,
      model: m,
      system,
      messages,
      tools,
      images,
      onDelta,
      signal,
      authStore: callAuthStore,
      cacheKey = null,
      promptCacheKey = null,
      cacheTtl = null,
      stream = Boolean(onDelta),
    } = {}) {
      const store = callAuthStore || authStore;
      const bodyObj = {
        model: m || this.model,
        messages: buildOpenAiChatMessages(prompt, { system, messages, images }),
        max_tokens: maxTokens,
      };
      const oaTools = toOpenAiTools(tools);
      if (oaTools) bodyObj.tools = oaTools;
      if (stream) bodyObj.stream = true;

      const effectiveCacheKey = promptCacheKey || cacheKey || defaultCacheKey || null;
      const effectiveTtl = cacheTtl || defaultCacheTtl || null;

      const execWithCred = async (cred) => {
        const targetBase = (cred?.baseUrl || resolvedBase).replace(/\/+$/, '');
        const url = `${targetBase}/chat/completions`;
        const payload = { ...bodyObj };
        // §13 OpenAI prompt caching: send prompt_cache_key & optional 24h retention on api.openai.com or explicit promptCacheKey
        if (promptCacheKey || (effectiveCacheKey && targetBase.includes('api.openai.com'))) {
          payload.prompt_cache_key = String(promptCacheKey || effectiveCacheKey).slice(0, 64);
          if (effectiveTtl === '24h') payload.prompt_cache_retention = '24h';
        }
        const reqHeaders = {
          'Content-Type': 'application/json',
          ...headers,
          ...(cred?.headers || {}),
        };
        if (!reqHeaders.Authorization && (cred?.token || resolvedKey)) {
          reqHeaders.Authorization = `Bearer ${cred?.token || resolvedKey}`;
        }
        const fetchOpts = { method: 'POST', headers: reqHeaders, body: JSON.stringify(payload), signal };
        if (stream) {
          const r = await fetchOpenAiSse(url, fetchOpts, { onDelta, fetchImpl });
          if (r.streamed) {
            const u = r.usage || {};
            const input = Number(u.prompt_tokens || 0);
            const cached = Number(u.prompt_tokens_details?.cached_tokens || 0);
            const output = Number(u.completion_tokens || approxTokens(r.text));
            return {
              text: r.text.trim(),
              toolCalls: r.toolCalls,
              usage: { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: output, providerTotalTokens: Number(u.total_tokens || (input + output)) },
              durationMs: r.durationMs,
              responseId: r.responseId,
            };
          }
          return parseOpenAiChatResponse(r.json, r.durationMs, onDelta);
        }
        const { json, durationMs } = await fetchJson(url, fetchOpts, fetchImpl);
        return parseOpenAiChatResponse(json, durationMs, onDelta);
      };

      if (store && store.listProfiles({ provider: providerId }).length > 0) {
        const { result, profileId } = await store.withFailover(providerId, execWithCred);
        return { ...result, authProfileId: profileId };
      }
      return execWithCred(null);
    },
  };
}

function makeOpenAIProvider({ model, authStore = null, baseUrl = null, apiKey = null, cacheKey: defaultCacheKey = null, cacheTtl: defaultCacheTtl = null, fetchImpl = globalThis.fetch } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  return {
    name: 'openai', model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    get ready() { return Boolean(key || (authStore && authStore.listProfiles({ provider: 'openai' }).length > 0)); },
    missing: 'OPENAI_API_KEY not set',
    async generate(prompt, opts = {}) {
      const { maxTokens = 800, model: m, messages, tools, images, system, onDelta, signal, authStore: callStore, cacheKey = null, promptCacheKey = null, cacheTtl = null } = opts;
      const store = callStore || authStore;
      // Multi-turn chat, tools, vision, streaming, or authStore failover -> use Chat Completions engine
      if (messages || tools || images || system || onDelta || store || baseUrl) {
        const compat = makeOpenAICompatibleProvider({
          model: m || this.model,
          baseUrl: baseUrl || 'https://api.openai.com/v1',
          apiKey: key,
          authStore: store,
          providerId: 'openai',
          cacheKey: defaultCacheKey,
          cacheTtl: defaultCacheTtl,
          fetchImpl,
        });
        return compat.generate(prompt, { ...opts, model: m || this.model, maxTokens });
      }
      const reqBody = { model: m || this.model, input: prompt, max_output_tokens: maxTokens, store: false };
      const effectiveCacheKey = promptCacheKey || cacheKey || defaultCacheKey || null;
      const effectiveTtl = cacheTtl || defaultCacheTtl || null;
      if (effectiveCacheKey) reqBody.prompt_cache_key = String(effectiveCacheKey).slice(0, 64);
      if (effectiveTtl === '24h') reqBody.prompt_cache_retention = '24h';
      const { json, durationMs } = await fetchJson('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(reqBody),
        signal,
      }, fetchImpl);
      const u = json.usage || {}; const cached = Number(u.input_tokens_details?.cached_tokens || 0); const input = Number(u.input_tokens || 0);
      const text = json.output_text || (json.output || []).flatMap((i) => i.content || []).map((p) => p.text || '').join('\n').trim();
      return { text, toolCalls: [], usage: { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: Number(u.total_tokens || 0) }, durationMs, responseId: json.id };
    },
  };
}

function makeAnthropicProvider({ model, apiKey = null, cacheTtl: defaultCacheTtl = null, fetchImpl = globalThis.fetch } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  return {
    name: 'anthropic', model: model || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    ready: Boolean(key), missing: 'ANTHROPIC_API_KEY not set',
    async generate(prompt, { maxTokens = 800, model: m, cachePrefix = '', system: sysProp = '', messages = null, tools = null, cacheTtl = null, onDelta = null, signal = null } = {}) {
      const effectiveTtl = cacheTtl || defaultCacheTtl || null;
      const cc = effectiveTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

      // §13 Breakpoint 1: stable system prefix
      const sysText = sysProp || cachePrefix;
      const system = sysText
        ? [{ type: 'text', text: sysText, cache_control: { ...cc } }]
        : undefined;
      const userText = cachePrefix && String(prompt || '').startsWith(cachePrefix) ? String(prompt).slice(cachePrefix.length) : prompt;
      const apiMessages = Array.isArray(messages) && messages.length
        ? messages.map((msg) => {
          if (msg.role === 'tool') {
            return { role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.toolCallId || 'tool_0', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }] };
          }
          if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
            const blocks = [];
            if (msg.content) blocks.push({ type: 'text', text: msg.content });
            for (const tc of msg.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || {} });
            return { role: 'assistant', content: blocks };
          }
          return { role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content };
        })
        : [{ role: 'user', content: userText || prompt }];

      // §13 Breakpoint 3: penultimate message caches entire multi-turn history prefix prior to current volatile turn
      if (apiMessages.length >= 2) {
        const prev = apiMessages[apiMessages.length - 2];
        if (typeof prev.content === 'string') {
          prev.content = [{ type: 'text', text: prev.content, cache_control: { ...cc } }];
        } else if (Array.isArray(prev.content) && prev.content.length > 0) {
          const cloned = prev.content.map((b, idx) => (idx === prev.content.length - 1 ? { ...b, cache_control: { ...cc } } : b));
          prev.content = cloned;
        }
      }

      const body = { model: m || this.model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: apiMessages };
      if (Array.isArray(tools) && tools.length) {
        body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }));
        // §13 Breakpoint 2: last tool definition caches the deterministic tool schema block
        body.tools[body.tools.length - 1].cache_control = { ...cc };
      }

      const reqHeaders = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      if (effectiveTtl === '1h') reqHeaders['anthropic-beta'] = 'extended-cache-ttl-2025-04-11';

      const { json, durationMs } = await fetchJson('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: reqHeaders,
        body: JSON.stringify(body),
        signal,
      }, fetchImpl);
      const blocks = json.content || [];
      const text = blocks.filter((p) => p.type === 'text' || p.text).map((p) => p.text || '').join('\n').trim();
      if (typeof onDelta === 'function' && text) onDelta(text);
      const toolCalls = blocks.filter((p) => p.type === 'tool_use').map((p) => ({ id: p.id, name: p.name, arguments: p.input || {} }));
      const u = json.usage || {}; const cr = Number(u.cache_read_input_tokens || 0); const ccTok = Number(u.cache_creation_input_tokens || 0); const input = Number(u.input_tokens || 0);
      return { text, toolCalls, usage: { uncachedInputTokens: input + ccTok, cachedInputTokens: cr, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: input + ccTok + cr + Number(u.output_tokens || 0) }, durationMs, responseId: json.id };
    },
  };
}

function makeGeminiProvider({ model, apiKey = null, cachedContent: defaultCachedContent = null, fetchImpl = globalThis.fetch } = {}) {
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  return {
    name: 'gemini', model: model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    ready: Boolean(key), missing: 'GEMINI_API_KEY/GOOGLE_API_KEY not set',
    async generate(prompt, { maxTokens = 800, model: m, system = '', messages = null, images = null, cachedContent = null, onDelta = null, signal = null } = {}) {
      const mp = (m || this.model).startsWith('models/') ? (m || this.model) : `models/${m || this.model}`;
      const contents = Array.isArray(messages) && messages.length
        ? messages.map((msg) => ({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
        }))
        : [{ role: 'user', parts: [{ text: prompt }] }];
      if (Array.isArray(images) && images.length && contents.length) {
        const last = contents[contents.length - 1];
        for (const img of images) {
          if (img?.base64) last.parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } });
        }
      }
      const body = { contents, generationConfig: { maxOutputTokens: maxTokens } };
      const effectiveCachedContent = cachedContent || defaultCachedContent || null;
      if (effectiveCachedContent) {
        // Explicit Gemini Context Caching handle (systemInstruction lives inside the cachedContent resource)
        body.cachedContent = String(effectiveCachedContent);
      } else if (system) {
        body.systemInstruction = { parts: [{ text: system }] };
      }
      const { json, durationMs } = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/${mp}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      }, fetchImpl);
      const u = json.usageMetadata || {}; const cached = Number(u.cachedContentTokenCount || 0); const input = Number(u.promptTokenCount || 0);
      const text = (json.candidates || []).flatMap((c) => c.content?.parts || []).map((p) => p.text || '').join('\n').trim();
      if (typeof onDelta === 'function' && text) onDelta(text);
      return { text, toolCalls: [], usage: { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: Number(u.candidatesTokenCount || 0), providerTotalTokens: Number(u.totalTokenCount || 0) }, durationMs, responseId: null };
    },
  };
}

// ── Grok CLI (Grok Build) — v1.6 ─────────────────────────────────────────────
// Read-first profile by default (QA role): may read files and run git/curl/test
// commands, but cannot write or push. sandbox:'write' switches to acceptEdits.
export function grokArgs({ model, effort, sandbox, maxTurns } = {}) {
  const args = ['--no-auto-update', '--output-format', 'json', '--max-turns', String(maxTurns || 30), '--sandbox', 'workspace'];
  if (effort) args.push('--effort', String(effort));
  if (model) args.push('-m', model);
  if (sandbox === 'write') {
    args.push('--permission-mode', 'acceptEdits');
  } else {
    args.push('--permission-mode', 'dontAsk');
    for (const a of ['Read', 'Grep', 'Glob', 'Bash']) args.push('--allow', a);
    for (const d of ['Write', 'Edit', 'Bash(rm *)', 'Bash(git push*)', 'Bash(sudo *)']) args.push('--deny', d);
  }
  return args;
}
function makeGrokProvider({ model } = {}) {
  const bin = process.env.GROK_CLI || 'grok';
  return {
    name: 'grok-cli', model: model || process.env.GROK_MODEL || 'grok-4.5',
    ready: Boolean(commandExists(bin)), missing: `grok CLI not found (${bin})`,
    async generate(prompt, { cwd, model: m, effort, sandbox, maxTurns, timeoutMs } = {}) {
      const args = [...grokArgs({ model: m || this.model, effort, sandbox, maxTurns }), '-p', prompt];
      const { stdout, durationMs } = runCommand(bin, args, { cwd, timeoutMs: timeoutMs || 900000 });
      let j = null;
      try { j = JSON.parse(stdout); } catch { j = parseJsonLines(stdout).at(-1) || null; }
      const cand = j && (j.result ?? j.text ?? j.response ?? j.output ?? j.final ?? (typeof j.message === 'string' ? j.message : null));
      const text = typeof cand === 'string' && cand ? cand : stdout.trim();
      const u = (j && j.usage) || {};
      const input = Number(u.input_tokens || u.prompt_tokens || 0), cached = Number(u.cached_input_tokens || u.cache_read_input_tokens || 0), out = Number(u.output_tokens || u.completion_tokens || 0);
      return {
        text,
        toolCalls: [],
        usage: (input || out)
          ? { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: out, providerTotalTokens: input + out }
          : { uncachedInputTokens: approxTokens(prompt), cachedInputTokens: 0, outputTokens: approxTokens(text), providerTotalTokens: approxTokens(prompt) + approxTokens(text) },
        durationMs, responseId: (j && (j.sessionId || j.session_id || j.id)) || null,
      };
    },
  };
}

const FACTORIES = {
  mock: makeMockProvider,
  'codex-app-server': makeCodexAppServerProvider,
  'openai-compatible': makeOpenAICompatibleProvider,
  codex: makeCodexProvider,
  claude: makeClaudeProvider,
  openai: makeOpenAIProvider,
  anthropic: makeAnthropicProvider,
  gemini: makeGeminiProvider,
  grok: makeGrokProvider,
};

// Pick a provider by name, or 'auto' = first ready real provider (API before CLI),
// never silently falling back to mock (mock must be requested explicitly).
export function pickProvider(name = 'auto', opts = {}) {
  if (name && name !== 'auto') {
    const f = FACTORIES[name];
    if (!f) throw new Error(`unknown provider "${name}" (have: ${Object.keys(FACTORIES).join(', ')})`);
    return f(opts);
  }
  const order = ['openai', 'anthropic', 'gemini', 'codex-app-server', 'codex', 'claude'];
  for (const n of order) { const p = FACTORIES[n](opts); if (p.ready) return p; }
  const codex = FACTORIES.codex(opts);
  return codex; // not ready -> caller surfaces .missing
}

export { approxTokens };
