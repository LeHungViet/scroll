// SCROLL 2.5 — provider adapters (vendor-neutral 4-provider model layer for `scroll run` & `scroll chat`).
// Zero-dep: Node built-ins + global fetch (Node >= 20).
//
// A provider exposes:  { name, model, ready, supportsTools, missing, generate(prompt, opts), close?() }
//   generate(prompt, { model, maxTokens, cwd, system, cachePrefix, messages, tools, images, onDelta, signal, authStore, effort, threadId })
//     -> { text, toolCalls?, thinkingBlocks?, rawParts?, usage:{ uncachedInputTokens, cachedInputTokens, outputTokens, providerTotalTokens }, durationMs, responseId, threadId? }
//
// The runtime is what drives the loop; providers only turn a prompt/messages into text+toolCalls+usage.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCodexAppServerClient, findCodexBinary } from './codex-app-server.js';

const approxTokens = (s) => Math.max(1, Math.ceil((s || '').length / 4));
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithRetry(fetchImpl, url, opts = {}, { maxRetries = 2 } = {}) {
  let attempt = 0;
  while (true) {
    const res = await fetchImpl(url, opts);
    if (res.ok || !RETRYABLE_HTTP_STATUSES.has(res.status) || attempt >= maxRetries || opts?.signal?.aborted) {
      return res;
    }
    const retryAfterMs = parseRetryAfterMs(res.headers);
    const backoff = Math.min(10_000, retryAfterMs != null ? retryAfterMs : (250 * (2 ** attempt) + Math.floor(Math.random() * 150)));
    try { await res.text(); } catch { /* drain body before retry */ }
    attempt++;
    await sleepAbortable(backoff, opts?.signal);
  }
}

// Proper SSE event-block consumer (`\n\n` boundaries, multi-line `data:` join, TextDecoder EOF flush,
// and trailing event without final newline).
async function consumeSseStream(body, onDataPayload) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  function dispatchBlock(block) {
    if (!block) return;
    const dataLines = [];
    for (const rawLine of block.split('\n')) {
      if (rawLine.startsWith('data:')) {
        dataLines.push(rawLine.slice(5).replace(/^ /, ''));
      }
    }
    if (!dataLines.length) return;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') return;
    onDataPayload(payload);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      dispatchBlock(block);
    }
  }
  buf += decoder.decode().replace(/\r\n/g, '\n');
  if (buf.trim()) {
    for (const block of buf.split('\n\n')) {
      dispatchBlock(block);
    }
  }
}

function parseRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const ra = headers.get('retry-after');
  if (!ra) return null;
  const asNum = Number(ra);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.round(asNum * 1000);
  const ts = Date.parse(ra);
  if (Number.isFinite(ts)) return Math.max(0, ts - Date.now());
  return null;
}

function buildHttpError(status, message, headers) {
  const e = new Error(message || `http_error:${status}`);
  e.status = status;
  const retryMs = parseRetryAfterMs(headers);
  if (retryMs != null) e.retryAfterMs = retryMs;
  if ((status === 400 || status === 413) && /context.?length|maximum.?context|prompt.?is.?too.?long|too many tokens|exceeds?.{0,25}token|context_window/i.test(String(message || ''))) {
    e.code = 'CONTEXT_LENGTH_EXCEEDED';
  }
  return e;
}

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

// ── command helpers (pure PATH scan, zero shell expansion) ───────────────────
function commandExists(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (cmd.includes('/')) {
    try { fs.accessSync(cmd, fs.constants.X_OK); return cmd; } catch { return false; }
  }
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch { /* continue */ }
  }
  return false;
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

function readImageBase64(img) {
  if (!img) return null;
  if (img.base64) {
    return {
      mimeType: img.mimeType || 'image/jpeg',
      data: String(img.base64).replace(/^data:[^;]+;base64,/i, '').trim(),
    };
  }
  if (img.path && fs.existsSync(img.path)) {
    const mimeType = img.mimeType || (img.path.endsWith('.png') ? 'image/png' : (img.path.endsWith('.webp') ? 'image/webp' : 'image/jpeg'));
    return { mimeType, data: fs.readFileSync(img.path).toString('base64') };
  }
  return null;
}

function attachImagesToOpenAiContent(text, images) {
  if (!Array.isArray(images) || !images.length) return text;
  const parts = [{ type: 'text', text: String(text || '') }];
  for (const img of images) {
    if (!img) continue;
    if (img.url) {
      parts.push({ type: 'image_url', image_url: { url: img.url } });
    } else {
      const b64 = readImageBase64(img);
      if (b64) {
        parts.push({ type: 'image_url', image_url: { url: `data:${b64.mimeType};base64,${b64.data}` } });
      }
    }
  }
  return parts;
}

// ── MOCK (deterministic — proves runtime mechanics without spending tokens) ────
function makeMockProvider({ scriptedTurns = null } = {}) {
  const seenPrefixes = new Set();
  let turnIdx = 0;
  return {
    name: 'mock', model: 'mock-1', ready: true, supportsTools: true, missing: null,
    async generate(prompt, { cachePrefix = '', system = '', messages = null, tools = null, onDelta = null, scriptedTurns: callScript = null } = {}) {
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
          const out = await entry({ prompt: effectivePrompt, system, messages, tools });
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

function mockAnswer(prompt) {
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
    supportsTools: true,
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
export function codexArgs({ model, toolPolicy, sandbox, effort } = {}) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '--ephemeral'];
  args.push('--sandbox', sandbox === 'write' ? 'workspace-write' : 'read-only');
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (model) args.push('--model', model);
  args.push(...leanFlags(toolPolicy));
  args.push('-');
  return args;
}
function makeCodexProvider({ model } = {}) {
  return {
    name: 'codex-cli', model: model || process.env.CODEX_MODEL || 'codex-default',
    supportsTools: false,
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
    supportsTools: false,
    ready: Boolean(commandExists(bin)), missing: `Claude CLI not found (${bin})`,
    async generate(prompt, { cwd, model: m, toolPolicy, system, messages } = {}) {
      const fullPrompt = Array.isArray(messages) && messages.length ? formatMessagesForPrompt(prompt, messages, system) : prompt;
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

// ── API HTTP + SSE helpers ────────────────────────────────────────────────────
async function fetchJson(url, opts, fetchImpl = globalThis.fetch) {
  const started = Date.now();
  const res = await fetchWithRetry(fetchImpl, url, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    throw buildHttpError(res.status, json?.error?.message || text.slice(0, 300), res.headers);
  }
  return { json, durationMs: Date.now() - started };
}

async function fetchOpenAiSse(url, opts, { onDelta, fetchImpl = globalThis.fetch } = {}) {
  const started = Date.now();
  const res = await fetchWithRetry(fetchImpl, url, opts);
  if (!res.ok) {
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    throw buildHttpError(res.status, json?.error?.message || text.slice(0, 300), res.headers);
  }
  const ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
  if (!ct.includes('text/event-stream') || !res.body) {
    const json = await res.json();
    return { json, durationMs: Date.now() - started, streamed: false };
  }
  let text = '';
  let reasoningContent = '';
  let responseId = null;
  let usage = null;
  let stopReason = null;
  const toolAcc = new Map();
  await consumeSseStream(res.body, (payload) => {
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    if (chunk.id) responseId = chunk.id;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    const delta = choice?.delta;
    if (!delta) return;
    // DeepSeek-R1/V3.2/V4 & reasoning models interleaved thinking stream
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoningContent += delta.reasoning_content;
    }
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
  });
  const truncated = stopReason === 'length' || stopReason === 'max_tokens';
  const toolCalls = [...toolAcc.values()].map((t) => {
    let args = {};
    let malformed = false;
    try { args = JSON.parse(t.argumentsRaw || '{}'); } catch { args = { raw: t.argumentsRaw }; malformed = true; }
    // Even if `argumentsRaw` is empty and parses as `{}`, a `length`/`max_tokens` cut NEVER safely completed arguments!
    if (truncated) malformed = true;
    return { id: t.id, name: t.name, arguments: args, ...(malformed ? { malformed: true, truncated } : {}) };
  });
  return {
    streamed: true,
    text,
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls,
    usage,
    stopReason,
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
          ...(typeof m.reasoningContent === 'string' && m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
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
        out.push({
          role: m.role || 'user',
          content,
          ...(m.role === 'assistant' && typeof m.reasoningContent === 'string' && m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
        });
      }
    }
  } else {
    out.push({ role: 'user', content: attachImagesToOpenAiContent(prompt, images) });
  }
  return out;
}

function parseOpenAiChatResponse(json, durationMs, onDelta) {
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const stopReason = choice.finish_reason || null;
  const truncated = stopReason === 'length' || stopReason === 'max_tokens';
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  const reasoningContent = typeof msg.reasoning_content === 'string' && msg.reasoning_content ? msg.reasoning_content : null;
  if (typeof onDelta === 'function' && text) onDelta(text);
  const toolCalls = (msg.tool_calls || []).map((tc, idx) => {
    let args = {};
    let malformed = false;
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = { raw: tc.function?.arguments }; malformed = true; }
    // Parity with SSE: if finish_reason is length/max_tokens, mark tool call malformed+truncated even if args parsed as {}
    if (truncated) malformed = true;
    return {
      id: tc.id || `call_${idx}`,
      name: tc.function?.name || '',
      arguments: args,
      ...(malformed ? { malformed: true, truncated } : {}),
    };
  });
  const u = json.usage || {};
  const cached = Number(u.prompt_tokens_details?.cached_tokens || 0);
  const input = Number(u.prompt_tokens || 0);
  const output = Number(u.completion_tokens || 0);
  return {
    text,
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls,
    stopReason,
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

function usesMaxCompletionTokens(modelId) {
  const base = String(modelId || '').trim().split('/').pop() || '';
  return /^(?:o[1-9](?:$|[-._])|gpt-5(?:$|[-._])|codex-)/i.test(base);
}

// ── OpenAI-compatible HTTP provider ───────────────────────────────────────────
function makeOpenAICompatibleProvider({
  model = null,
  baseUrl = null,
  apiKey = null,
  authStore = null,
  providerId = 'openai',
  headers = {},
  cacheKey: defaultCacheKey = null,
  cacheTtl: defaultCacheTtl = null,
  includeStreamUsage = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolvedBase = (baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const resolvedKey = apiKey || process.env.OPENAI_API_KEY || null;
  return {
    name: 'openai-compatible',
    model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    supportsTools: true,
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
      const targetModel = m || this.model;
      const bodyObj = {
        model: targetModel,
        messages: buildOpenAiChatMessages(prompt, { system, messages, images }),
        ...(usesMaxCompletionTokens(targetModel) ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      };
      const oaTools = toOpenAiTools(tools);
      if (oaTools) bodyObj.tools = oaTools;
      if (stream) {
        bodyObj.stream = true;
        if (includeStreamUsage !== false) {
          bodyObj.stream_options = { include_usage: true };
        }
      }

      const effectiveCacheKey = promptCacheKey || cacheKey || defaultCacheKey || null;
      const effectiveTtl = cacheTtl || defaultCacheTtl || null;

      const execWithCred = async (cred) => {
        const targetBase = (cred?.baseUrl || resolvedBase).replace(/\/+$/, '');
        const url = `${targetBase}/chat/completions`;
        const payload = { ...bodyObj };
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
              ...(r.reasoningContent ? { reasoningContent: r.reasoningContent } : {}),
              toolCalls: r.toolCalls,
              stopReason: r.stopReason || null,
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
    supportsTools: true,
    get ready() { return Boolean(key || (authStore && authStore.listProfiles({ provider: 'openai' }).length > 0)); },
    missing: 'OPENAI_API_KEY not set',
    async generate(prompt, opts = {}) {
      const { maxTokens = 800, model: m, messages, tools, images, system, onDelta, signal, authStore: callStore, cacheKey = null, promptCacheKey = null, cacheTtl = null } = opts;
      const store = callStore || authStore;
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

// ── Anthropic Messages API (2.5 Full Parity: Real SSE + Parallel Tool Coalescing + Thinking + Images + AuthStore) ──
function attachImagesToAnthropicBlocks(text, images) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text: String(text) });
  for (const img of images || []) {
    if (!img) continue;
    if (img.url) {
      blocks.push({ type: 'image', source: { type: 'url', url: img.url } });
    } else {
      const b64 = readImageBase64(img);
      if (b64) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: b64.mimeType, data: b64.data } });
      }
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

function buildAnthropicMessages(prompt, { cachePrefix = '', messages = null, images = null } = {}) {
  const userText = cachePrefix && String(prompt || '').startsWith(cachePrefix)
    ? String(prompt).slice(cachePrefix.length)
    : prompt;
  if (!Array.isArray(messages) || !messages.length) {
    const content = Array.isArray(images) && images.length
      ? attachImagesToAnthropicBlocks(userText || prompt, images)
      : (userText || prompt);
    return [{ role: 'user', content }];
  }

  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId || msg.id || 'tool_0',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
      };
      // Coalesce consecutive `role: 'tool'` results into ONE `user` turn (prevents Anthropic HTTP 400!)
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') {
        prev.content.push(block);
      } else if (prev && prev.role === 'user') {
        prev.content = [
          ...(typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : prev.content),
          block,
        ];
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks = [];
      if (Array.isArray(msg.thinkingBlocks)) {
        for (const tb of msg.thinkingBlocks) blocks.push(tb);
      }
      if (msg.content) blocks.push({ type: 'text', text: String(msg.content) });
      if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
        for (const tc of msg.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || {} });
        }
      }
      out.push({
        role: 'assistant',
        content: blocks.length ? (blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks) : '',
      });
      continue;
    }

    // `user` message (defensively merge consecutive user messages to guarantee strict alternation)
    const isLastUser = i === messages.length - 1;
    const textVal = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    const content = isLastUser && Array.isArray(images) && images.length
      ? attachImagesToAnthropicBlocks(textVal, images)
      : textVal;
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user') {
      const prevBlocks = typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : [...prev.content];
      const nextBlocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      prev.content = [...prevBlocks, ...nextBlocks];
    } else {
      out.push({ role: 'user', content });
    }
  }
  return out;
}

async function fetchAnthropicSse(url, opts, { onDelta, fetchImpl = globalThis.fetch } = {}) {
  const started = Date.now();
  const res = await fetchWithRetry(fetchImpl, url, opts);
  if (!res.ok) {
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    throw buildHttpError(res.status, json?.error?.message || text.slice(0, 300), res.headers);
  }
  const ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
  if (!ct.includes('text/event-stream') || !res.body) {
    const json = await res.json();
    return { streamed: false, json, durationMs: Date.now() - started };
  }

  let responseId = null;
  let text = '';
  let stopReason = null;
  const blocks = new Map(); // index -> { type, id, name, text, jsonRaw, thinking, signature, data }
  const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };

  await consumeSseStream(res.body, (payload) => {
    let ev;
    try { ev = JSON.parse(payload); } catch { return; }
    if (ev.type === 'message_start') {
      if (ev.message?.id) responseId = ev.message.id;
      const u = ev.message?.usage || {};
      if (u.input_tokens != null) usage.input_tokens = Number(u.input_tokens);
      if (u.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = Number(u.cache_creation_input_tokens);
      if (u.cache_read_input_tokens != null) usage.cache_read_input_tokens = Number(u.cache_read_input_tokens);
      if (u.output_tokens != null) usage.output_tokens = Number(u.output_tokens);
    } else if (ev.type === 'content_block_start') {
      const cb = ev.content_block || {};
      blocks.set(ev.index ?? blocks.size, {
        type: cb.type || 'text',
        id: cb.id || null,
        name: cb.name || null,
        text: cb.text || '',
        jsonRaw: '',
        thinking: cb.thinking || '',
        signature: cb.signature || '',
        data: cb.data || null,
      });
    } else if (ev.type === 'content_block_delta') {
      const entry = blocks.get(ev.index ?? 0);
      const d = ev.delta || {};
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        text += d.text;
        if (entry) entry.text += d.text;
        if (typeof onDelta === 'function' && d.text) onDelta(d.text);
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        if (entry) entry.jsonRaw += d.partial_json;
      } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        if (entry) entry.thinking += d.thinking;
      } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
        if (entry) entry.signature += d.signature;
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      const u = ev.usage || {};
      if (u.output_tokens != null) usage.output_tokens = Number(u.output_tokens);
      if (u.input_tokens != null) usage.input_tokens = Number(u.input_tokens);
      if (u.cache_read_input_tokens != null) usage.cache_read_input_tokens = Number(u.cache_read_input_tokens);
      if (u.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = Number(u.cache_creation_input_tokens);
    } else if (ev.type === 'error') {
      const status = ev.error?.type === 'overloaded_error' ? 529 : (ev.error?.type === 'rate_limit_error' ? 429 : 500);
      const err = buildHttpError(status, ev.error?.message || 'anthropic_stream_error', res.headers);
      err.errorType = ev.error?.type || 'stream_error';
      throw err;
    }
  });

  const truncated = stopReason === 'max_tokens';
  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const toolCalls = [];
  const thinkingBlocks = [];
  for (const b of ordered) {
    if (b.type === 'tool_use') {
      let args = {};
      let malformed = false;
      try { args = JSON.parse(b.jsonRaw || '{}'); } catch { args = { raw: b.jsonRaw }; malformed = true; }
      if (truncated) malformed = true;
      toolCalls.push({
        id: b.id || `toolu_${toolCalls.length}`,
        name: b.name || '',
        arguments: args,
        ...(malformed ? { malformed: true, truncated } : {}),
      });
    } else if (b.type === 'thinking') {
      thinkingBlocks.push({ type: 'thinking', thinking: b.thinking, ...(b.signature ? { signature: b.signature } : {}) });
    } else if (b.type === 'redacted_thinking') {
      thinkingBlocks.push({ type: 'redacted_thinking', data: b.data });
    }
  }
  const cr = Number(usage.cache_read_input_tokens || 0);
  const ccTok = Number(usage.cache_creation_input_tokens || 0);
  const input = Number(usage.input_tokens || 0);
  const out = Number(usage.output_tokens || 0);
  return {
    streamed: true,
    text: text.trim(),
    toolCalls,
    thinkingBlocks,
    stopReason,
    usage: {
      uncachedInputTokens: input + ccTok,
      cachedInputTokens: cr,
      outputTokens: out,
      providerTotalTokens: input + ccTok + cr + out,
    },
    durationMs: Date.now() - started,
    responseId,
  };
}

function makeAnthropicProvider({
  model,
  apiKey = null,
  baseUrl = null,
  authStore = null,
  providerId = 'anthropic',
  cacheTtl: defaultCacheTtl = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || null;
  const resolvedBase = (baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    name: 'anthropic',
    model: model || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
    supportsTools: true,
    get ready() {
      if (key) return true;
      if (authStore && authStore.listProfiles({ provider: providerId }).length > 0) return true;
      return false;
    },
    missing: 'ANTHROPIC_API_KEY not set (or no anthropic profile in authStore)',
    async generate(prompt, {
      maxTokens = 800,
      model: m,
      cachePrefix = '',
      system: sysProp = '',
      messages = null,
      tools = null,
      images = null,
      cacheTtl = null,
      onDelta = null,
      stream = Boolean(onDelta),
      signal = null,
      authStore: callAuthStore = null,
    } = {}) {
      const store = callAuthStore || authStore;
      const effectiveTtl = cacheTtl || defaultCacheTtl || null;
      const cc = effectiveTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

      const sysText = sysProp || cachePrefix;
      const system = sysText
        ? [{ type: 'text', text: sysText, cache_control: { ...cc } }]
        : undefined;
      const apiMessages = buildAnthropicMessages(prompt, { cachePrefix, messages, images });

      // §13 Breakpoint 3: penultimate message caches entire multi-turn history prefix
      if (apiMessages.length >= 2) {
        const prev = apiMessages[apiMessages.length - 2];
        if (typeof prev.content === 'string') {
          prev.content = [{ type: 'text', text: prev.content, cache_control: { ...cc } }];
        } else if (Array.isArray(prev.content) && prev.content.length > 0) {
          prev.content = prev.content.map((b, idx) => (idx === prev.content.length - 1 ? { ...b, cache_control: { ...cc } } : b));
        }
      }

      const body = {
        model: m || this.model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: apiMessages,
        ...(stream ? { stream: true } : {}),
      };
      if (Array.isArray(tools) && tools.length) {
        body.tools = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } }));
        body.tools[body.tools.length - 1].cache_control = { ...cc };
      }

      const execWithCred = async (cred) => {
        const targetBase = (cred?.baseUrl || resolvedBase).replace(/\/+$/, '');
        const url = `${targetBase}/v1/messages`;
        const reqHeaders = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(cred?.headers || {}),
        };
        if (effectiveTtl === '1h') reqHeaders['anthropic-beta'] = 'extended-cache-ttl-2025-04-11';
        if (cred?.type === 'oauth' && cred.token) {
          reqHeaders.Authorization = `Bearer ${cred.token}`;
        } else {
          const apiK = cred?.token || key;
          if (apiK) reqHeaders['x-api-key'] = apiK;
        }
        const fetchOpts = { method: 'POST', headers: reqHeaders, body: JSON.stringify(body), signal };

        const parseAnthropicJson = (json, durationMs) => {
          const blocks = json.content || [];
          const stopReason = json.stop_reason || null;
          const truncated = stopReason === 'max_tokens';
          const text = blocks.filter((p) => p.type === 'text' || p.text).map((p) => p.text || '').join('\n').trim();
          if (typeof onDelta === 'function' && text) onDelta(text);
          const toolCalls = blocks.filter((p) => p.type === 'tool_use').map((p) => ({
            id: p.id,
            name: p.name,
            arguments: p.input || {},
            ...(truncated ? { malformed: true, truncated: true } : {}),
          }));
          const thinkingBlocks = blocks.filter((p) => p.type === 'thinking' || p.type === 'redacted_thinking');
          const u = json.usage || {};
          const cr = Number(u.cache_read_input_tokens || 0);
          const ccTok = Number(u.cache_creation_input_tokens || 0);
          const input = Number(u.input_tokens || 0);
          return {
            text,
            toolCalls,
            thinkingBlocks,
            stopReason,
            usage: { uncachedInputTokens: input + ccTok, cachedInputTokens: cr, outputTokens: Number(u.output_tokens || 0), providerTotalTokens: input + ccTok + cr + Number(u.output_tokens || 0) },
            durationMs,
            responseId: json.id,
          };
        };

        if (stream) {
          const r = await fetchAnthropicSse(url, fetchOpts, { onDelta, fetchImpl });
          if (r.streamed) return r;
          return parseAnthropicJson(r.json, r.durationMs);
        }

        const { json, durationMs } = await fetchJson(url, fetchOpts, fetchImpl);
        return parseAnthropicJson(json, durationMs);
      };

      if (store && store.listProfiles({ provider: providerId }).length > 0) {
        const { result, profileId } = await store.withFailover(providerId, execWithCred);
        return { ...result, authProfileId: profileId };
      }
      return execWithCred(null);
    },
  };
}

// ── Google Gemini API (2.5 Full Parity: Real SSE + Parallel Function Calling + thoughtSignature + Images + AuthStore) ──
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'patternProperties',
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  '$comment',
  'default',
  'examples',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
]);

function sanitizeGeminiNode(node, { isPropertiesMap = false } = {}) {
  // Primitives (strings inside `required` / `enum`, numbers, booleans, null) MUST pass through untouched!
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeGeminiNode(item, { isPropertiesMap: false }));
  }
  // Unwrap Pydantic v2 / FastMCP nullable union `anyOf`/`oneOf: [{ type: T, ... }, { type: 'null' }]` before stripping
  let source = node;
  if (!isPropertiesMap && !node.type && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf))) {
    const branches = Array.isArray(node.anyOf) ? node.anyOf : node.oneOf;
    const nonNullBranch = branches.find((b) => b && typeof b === 'object' && b.type && b.type !== 'null');
    const hasNull = branches.some((b) => b && typeof b === 'object' && b.type === 'null');
    if (nonNullBranch) {
      source = { ...nonNullBranch, ...node, type: nonNullBranch.type, ...(hasNull ? { nullable: true } : {}) };
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    // Only filter/transform JSON-Schema keywords on schema nodes, NEVER when `k` is a tool parameter name inside `properties`!
    if (!isPropertiesMap) {
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      if (k === 'const') {
        if (v !== undefined && v !== null) out.enum = [String(v)];
        continue;
      }
      if (k === 'type' && Array.isArray(v)) {
        const nonNull = v.filter((t) => typeof t === 'string' && t !== 'null');
        if (nonNull.length) out.type = nonNull[0];
        if (v.includes('null')) out.nullable = true;
        continue;
      }
    }
    if (k === 'properties' && !isPropertiesMap && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeGeminiNode(v, { isPropertiesMap: true });
    } else if (v && typeof v === 'object') {
      out[k] = sanitizeGeminiNode(v, { isPropertiesMap: false });
    } else {
      out[k] = v;
    }
  }
  // Gemini rejects `required` keys that do not exist in `properties`
  if (!isPropertiesMap && Array.isArray(out.required)) {
    const propKeys = out.properties && typeof out.properties === 'object' ? Object.keys(out.properties) : [];
    const propSet = new Set(propKeys);
    const filteredReq = out.required.filter((r) => typeof r === 'string' && propSet.has(r));
    if (filteredReq.length) out.required = filteredReq;
    else delete out.required;
  }
  return out;
}

export function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return sanitizeGeminiNode(schema, { isPropertiesMap: false });
}

function buildGeminiContents(prompt, { messages = null, images = null } = {}) {
  const contents = [];
  if (Array.isArray(messages) && messages.length) {
    for (const msg of messages) {
      if (msg.role === 'tool') {
        let parsed = null;
        try { parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content; } catch { parsed = null; }
        const responseObj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          ? parsed
          : { result: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '') };
        const part = { functionResponse: { name: msg.name || 'tool', response: responseObj } };
        const prev = contents[contents.length - 1];
        if (prev && prev.role === 'user' && prev.parts.some((p) => p.functionResponse)) {
          prev.parts.push(part);
        } else {
          contents.push({ role: 'user', parts: [part] });
        }
        continue;
      }
      if (msg.role === 'assistant') {
        if (Array.isArray(msg.rawParts) && msg.rawParts.length) {
          contents.push({ role: 'model', parts: msg.rawParts });
          continue;
        }
        const parts = [];
        if (msg.content) parts.push({ text: String(msg.content) });
        if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
          for (const tc of msg.toolCalls) {
            const p = { functionCall: { name: tc.name, args: tc.arguments || {} } };
            if (tc.thoughtSignature) p.thoughtSignature = tc.thoughtSignature;
            parts.push(p);
          }
        }
        contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
        continue;
      }
      const txt = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      contents.push({ role: 'user', parts: [{ text: txt }] });
    }
  } else {
    contents.push({ role: 'user', parts: [{ text: String(prompt ?? '') }] });
  }

  if (Array.isArray(images) && images.length && contents.length) {
    const last = contents[contents.length - 1];
    for (const img of images) {
      if (!img) continue;
      if (img.url && !img.base64 && !img.path) {
        last.parts.push({ fileData: { mimeType: img.mimeType || 'image/jpeg', fileUri: img.url } });
      } else {
        const b64 = readImageBase64(img);
        if (b64) {
          last.parts.push({ inlineData: { mimeType: b64.mimeType, data: b64.data } });
        }
      }
    }
  }
  return contents;
}

function parseGeminiParts(parts, toolCounter = { n: 0 }) {
  const visibleTexts = [];
  const toolCalls = [];
  const rawParts = [];
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    rawParts.push(p);
    if (p.functionCall) {
      toolCounter.n++;
      const tc = {
        id: p.functionCall.id || `gem_call_${toolCounter.n}_${p.functionCall.name || 'tool'}`,
        name: p.functionCall.name || '',
        arguments: p.functionCall.args || {},
      };
      if (p.thoughtSignature) tc.thoughtSignature = p.thoughtSignature;
      toolCalls.push(tc);
    } else if (typeof p.text === 'string' && p.text && p.thought !== true) {
      visibleTexts.push(p.text);
    }
  }
  return { text: visibleTexts.join(''), toolCalls, rawParts };
}

async function fetchGeminiSse(url, opts, { onDelta, fetchImpl = globalThis.fetch } = {}) {
  const started = Date.now();
  const res = await fetchWithRetry(fetchImpl, url, opts);
  if (!res.ok) {
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    throw buildHttpError(res.status, json?.error?.message || text.slice(0, 300), res.headers);
  }
  const ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
  if (!ct.includes('text/event-stream') || !res.body) {
    const json = await res.json();
    return { streamed: false, json, durationMs: Date.now() - started };
  }

  let text = '';
  const allToolCalls = [];
  const allRawParts = [];
  const toolCounter = { n: 0 };
  let usageMeta = {};
  let responseId = null;
  let stopReason = null;

  await consumeSseStream(res.body, (payload) => {
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    if (chunk.responseId) responseId = chunk.responseId;
    if (chunk.usageMetadata) usageMeta = chunk.usageMetadata;
    const cand0 = chunk.candidates?.[0];
    if (cand0?.finishReason) stopReason = cand0.finishReason;
    const parts = (chunk.candidates || []).flatMap((c) => c.content?.parts || []);
    if (!parts.length) return;
    const parsed = parseGeminiParts(parts, toolCounter);
    if (parsed.text) {
      text += parsed.text;
      if (typeof onDelta === 'function') onDelta(parsed.text);
    }
    if (parsed.toolCalls.length) allToolCalls.push(...parsed.toolCalls);
    if (parsed.rawParts.length) allRawParts.push(...parsed.rawParts);
  });

  const cached = Number(usageMeta.cachedContentTokenCount || 0);
  const input = Number(usageMeta.promptTokenCount || 0);
  const out = Number(usageMeta.candidatesTokenCount || 0);
  return {
    streamed: true,
    text: text.trim(),
    toolCalls: allToolCalls,
    rawParts: allRawParts,
    stopReason,
    usage: {
      uncachedInputTokens: Math.max(0, input - cached),
      cachedInputTokens: cached,
      outputTokens: out,
      providerTotalTokens: Number(usageMeta.totalTokenCount || (input + out)),
    },
    durationMs: Date.now() - started,
    responseId,
  };
}

function makeGeminiProvider({
  model,
  apiKey = null,
  baseUrl = null,
  authStore = null,
  providerId = 'google',
  cachedContent: defaultCachedContent = null,
  cachedContentIncludesTools = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
  const resolvedBase = (baseUrl || process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  return {
    name: 'gemini',
    model: model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    supportsTools: true,
    get ready() {
      if (key) return true;
      if (authStore && authStore.listProfiles({ provider: providerId }).length > 0) return true;
      return false;
    },
    missing: 'GEMINI_API_KEY/GOOGLE_API_KEY not set (or no google profile in authStore)',
    async generate(prompt, {
      maxTokens = 800,
      model: m,
      system = '',
      messages = null,
      tools = null,
      images = null,
      cachedContent = null,
      onDelta = null,
      stream = Boolean(onDelta),
      signal = null,
      authStore: callAuthStore = null,
    } = {}) {
      const store = callAuthStore || authStore;
      const mp = (m || this.model).startsWith('models/') ? (m || this.model) : `models/${m || this.model}`;
      const contents = buildGeminiContents(prompt, { messages, images });
      const hasTools = Array.isArray(tools) && tools.length > 0;
      const body = { contents, generationConfig: { maxOutputTokens: maxTokens } };

      const effectiveCachedContent = cachedContent || defaultCachedContent || null;
      // Gemini rejects sending `cachedContent` together with `systemInstruction` or `tools`.
      // If dynamic `tools` are supplied and the cache handle wasn't built with tools baked in,
      // gracefully fall back to Gemini's automatic Implicit Caching (`systemInstruction` + `tools`).
      if (effectiveCachedContent && (!hasTools || cachedContentIncludesTools)) {
        body.cachedContent = String(effectiveCachedContent);
      } else {
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        if (hasTools) {
          body.tools = [{
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description || '',
              parameters: sanitizeGeminiSchema(t.parameters),
            })),
          }];
        }
      }

      const execWithCred = async (cred) => {
        const targetBase = (cred?.baseUrl || resolvedBase).replace(/\/+$/, '');
        const reqHeaders = { 'Content-Type': 'application/json', ...(cred?.headers || {}) };
        let url;
        if (cred?.type === 'oauth' && cred.token) {
          reqHeaders.Authorization = `Bearer ${cred.token}`;
          url = stream
            ? `${targetBase}/${mp}:streamGenerateContent?alt=sse`
            : `${targetBase}/${mp}:generateContent`;
        } else {
          const apiK = cred?.token || key;
          const qs = apiK ? `key=${encodeURIComponent(apiK)}` : '';
          url = stream
            ? `${targetBase}/${mp}:streamGenerateContent?alt=sse${qs ? `&${qs}` : ''}`
            : `${targetBase}/${mp}:generateContent${qs ? `?${qs}` : ''}`;
        }
        const fetchOpts = { method: 'POST', headers: reqHeaders, body: JSON.stringify(body), signal };

        if (stream) {
          const r = await fetchGeminiSse(url, fetchOpts, { onDelta, fetchImpl });
          if (r.streamed) return r;
          const json = r.json;
          const u = json.usageMetadata || {};
          const cached = Number(u.cachedContentTokenCount || 0);
          const input = Number(u.promptTokenCount || 0);
          const parts = (json.candidates || []).flatMap((c) => c.content?.parts || []);
          const parsed = parseGeminiParts(parts);
          const text = parsed.text.trim();
          if (typeof onDelta === 'function' && text) onDelta(text);
          return {
            text,
            toolCalls: parsed.toolCalls,
            rawParts: parsed.rawParts,
            usage: { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: Number(u.candidatesTokenCount || 0), providerTotalTokens: Number(u.totalTokenCount || 0) },
            durationMs: r.durationMs,
            responseId: json.responseId || null,
          };
        }

        const { json, durationMs } = await fetchJson(url, fetchOpts, fetchImpl);
        const u = json.usageMetadata || {};
        const cached = Number(u.cachedContentTokenCount || 0);
        const input = Number(u.promptTokenCount || 0);
        const parts = (json.candidates || []).flatMap((c) => c.content?.parts || []);
        const parsed = parseGeminiParts(parts);
        const text = parsed.text.trim();
        if (typeof onDelta === 'function' && text) onDelta(text);
        return {
          text,
          toolCalls: parsed.toolCalls,
          rawParts: parsed.rawParts,
          usage: { uncachedInputTokens: Math.max(0, input - cached), cachedInputTokens: cached, outputTokens: Number(u.candidatesTokenCount || 0), providerTotalTokens: Number(u.totalTokenCount || 0) },
          durationMs,
          responseId: json.responseId || null,
        };
      };

      if (store && store.listProfiles({ provider: providerId }).length > 0) {
        const { result, profileId } = await store.withFailover(providerId, execWithCred);
        return { ...result, authProfileId: profileId };
      }
      return execWithCred(null);
    },
  };
}

// ── Grok CLI (Grok Build) — v1.6 ─────────────────────────────────────────────
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
    supportsTools: false,
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

export function pickProvider(name = 'auto', opts = {}) {
  if (name && name !== 'auto') {
    const f = FACTORIES[name];
    if (!f) throw new Error(`unknown provider "${name}" (have: ${Object.keys(FACTORIES).join(', ')})`);
    return f(opts);
  }
  const order = ['openai', 'anthropic', 'gemini', 'codex-app-server', 'codex', 'claude'];
  for (const n of order) { const p = FACTORIES[n](opts); if (p.ready) return p; }
  const codex = FACTORIES.codex(opts);
  return codex;
}

export { approxTokens };
