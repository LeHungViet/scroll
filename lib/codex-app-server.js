// SCROLL 2.0 -- §46 Persistent Codex App-Server JSON-RPC 2.0 stdio client.
//
// Why: spawning `codex exec` cold per chat turn incurs ~1.5-3s startup overhead and loses
// thread continuity. `codex app-server --listen stdio://` keeps a single persistent JSON-RPC
// daemon that natively manages Sign in with ChatGPT OAuth (`account/read`, `account/login/start`),
// rate limits (`account/rateLimits/read`), model discovery (`model/list`), and streaming turns
// (`thread/start`, `turn/start`, `item/agentMessage/delta`, `turn/interrupt`).
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

function isExecutableFile(p) {
  if (!p) return false;
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

export function findCodexBinary({ command = null, searchPaths = [], env = process.env } = {}) {
  const direct = [command, env.CODEX_APP_SERVER_BIN, env.CODEX_CLI].filter(Boolean);
  for (const cand of direct) {
    if (cand.includes('/') && isExecutableFile(cand)) return cand;
    if (!cand.includes('/')) {
      const r = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(cand)}`], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
  }
  for (const cand of searchPaths || []) {
    if (isExecutableFile(cand)) return cand;
  }
  const onPath = spawnSync('bash', ['-lc', 'command -v codex'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim();
  return null;
}

export function createCodexAppServerClient({
  command = null,
  args = null,
  searchPaths = [],
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 120_000,
  clientInfo = { name: 'scroll-runtime', version: '2.0.0' },
  defaultModel = null,
  disableBuiltinTools = true,
  maxRestarts = 2,
} = {}) {
  let proc = null;
  let rl = null;
  let started = false;
  let startPromise = null;
  let closing = false;
  let nextId = 1;
  let restartCount = 0;
  let cachedModels = null;
  let stderrTail = '';

  const pending = new Map();
  const notificationListeners = new Set();

  function resolvedBinary() {
    return findCodexBinary({ command, searchPaths, env });
  }

  function buildArgs() {
    if (Array.isArray(args)) return [...args];
    const base = ['app-server', '--listen', 'stdio://'];
    if (disableBuiltinTools) base.push('-c', 'apps._default.default_tools_enabled=false');
    return base;
  }

  function onNotification(fn) {
    notificationListeners.add(fn);
    return () => notificationListeners.delete(fn);
  }

  function rejectAllPending(err) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        err.data = msg.error.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      for (const listener of notificationListeners) {
        try { listener(msg); } catch { /* listener error isolated */ }
      }
    }
  }

  function sendRaw(obj) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) {
      throw new Error('codex_app_server_not_running');
    }
    proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  function notify(method, params = {}) {
    sendRaw({ jsonrpc: '2.0', method, params });
  }

  function request(method, params = {}, { timeoutMs: reqTimeout = timeoutMs, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      const id = nextId++;
      const onAbort = () => {
        if (pending.has(id)) {
          pending.delete(id);
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }
      };
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(new Error(`codex_rpc_timeout:${method}:${reqTimeout}ms`));
        }
      }, reqTimeout);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (val) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        reject: (err) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        },
        timer,
      });
      try {
        sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    });
  }

  async function start() {
    if (started && proc && proc.exitCode === null) return;
    if (startPromise) return startPromise;
    closing = false;
    startPromise = (async () => {
      const bin = resolvedBinary();
      if (!bin) throw new Error('codex_binary_not_found');
      const spawnArgs = buildArgs();
      stderrTail = '';
      proc = spawn(bin, spawnArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stderr.on('data', (buf) => {
        stderrTail = (stderrTail + buf.toString('utf8')).slice(-2000);
      });
      rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) return;
        try {
          handleMessage(JSON.parse(trimmed));
        } catch {
          // ignore non-JSON diagnostic line
        }
      });
      proc.once('exit', (code, sig) => {
        const wasStarted = started;
        started = false;
        startPromise = null;
        if (rl) { try { rl.close(); } catch { /* ignore */ } rl = null; }
        proc = null;
        if (!closing) {
          rejectAllPending(new Error(`codex_app_server_exited:${code ?? sig}:${stderrTail.slice(-200)}`));
          if (wasStarted) restartCount++;
        }
      });
      proc.once('error', (err) => {
        started = false;
        startPromise = null;
        rejectAllPending(err);
      });
      const initRes = await request('initialize', {
        clientInfo,
        capabilities: {},
      }, { timeoutMs: Math.min(timeoutMs, 30_000) });
      notify('initialized', {});
      started = true;
      return initRes;
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function ensureStarted() {
    if (started && proc && proc.exitCode === null) return;
    if (restartCount > maxRestarts) {
      throw new Error(`codex_app_server_max_restarts_exceeded:${maxRestarts}`);
    }
    await start();
  }

  async function readAccount({ refreshToken = false } = {}) {
    await ensureStarted();
    return request('account/read', { refreshToken });
  }

  async function startLogin({ type = 'chatgpt', apiKey = null } = {}) {
    await ensureStarted();
    const params = type === 'apiKey' ? { type: 'apiKey', apiKey } : { type };
    return request('account/login/start', params);
  }

  async function readRateLimits() {
    await ensureStarted();
    return request('account/rateLimits/read', {});
  }

  async function listModels({ refresh = false } = {}) {
    await ensureStarted();
    if (!refresh && Array.isArray(cachedModels) && cachedModels.length) return cachedModels;
    const res = await request('model/list', {});
    const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res?.models) ? res.models : []);
    cachedModels = list;
    return list;
  }

  async function resolveModel(requested = null) {
    const models = await listModels();
    const knownIds = new Set(models.map((m) => m.id || m.model).filter(Boolean));
    const pickIfKnown = (cand) => {
      if (!cand || cand === 'auto' || cand === 'codex-default') return null;
      if (!knownIds.size || knownIds.has(cand)) return cand;
      return null;
    };
    const exact = pickIfKnown(requested) || pickIfKnown(defaultModel);
    if (exact) return exact;
    if (!models.length) return requested && requested !== 'auto' ? requested : (defaultModel || 'gpt-5');
    const def = models.find((m) => m.isDefault === true) || models[0];
    return def.id || def.model || 'gpt-5';
  }

  async function startThread({
    model = null,
    ephemeral = true,
    approvalPolicy = 'never',
    sandbox = 'read-only',
    baseInstructions = null,
    developerInstructions = null,
    cwd: threadCwd = cwd,
  } = {}) {
    await ensureStarted();
    const resolvedModel = await resolveModel(model);
    const params = {
      model: resolvedModel,
      ephemeral,
      approvalPolicy,
      sandbox,
      cwd: threadCwd,
    };
    if (baseInstructions) params.baseInstructions = baseInstructions;
    if (developerInstructions) params.developerInstructions = developerInstructions;
    const res = await request('thread/start', params);
    const threadId = res?.thread?.id || res?.threadId || res?.id || null;
    if (!threadId) throw new Error('codex_thread_start_missing_id');
    return { threadId, model: resolvedModel, raw: res };
  }

  async function runTurn({
    threadId,
    input,
    model = null,
    effort = null,
    onDelta = null,
    signal = null,
    timeoutMs: turnTimeout = timeoutMs,
  } = {}) {
    await ensureStarted();
    if (!threadId) throw new Error('runTurn: threadId is required');
    const items = Array.isArray(input)
      ? input
      : [{ type: 'text', text: String(input ?? '') }];
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      let settled = false;
      let turnId = null;
      let text = '';
      let finalItemText = '';
      let usage = { uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, providerTotalTokens: 0 };

      const cleanup = () => {
        unsub();
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(val);
      };

      const onAbort = () => {
        if (turnId) {
          request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }).catch(() => {});
        }
        finish(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal) {
        if (signal.aborted) {
          finish(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        if (turnId) {
          request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }).catch(() => {});
        }
        finish(new Error(`codex_turn_timeout:${turnTimeout}ms`));
      }, turnTimeout);

      const unsub = onNotification((msg) => {
        const p = msg.params || {};
        if (p.threadId && p.threadId !== threadId) return;
        if (msg.method === 'turn/started' && p.turn?.id) {
          turnId = p.turn.id;
        } else if (msg.method === 'item/agentMessage/delta') {
          const delta = typeof p.delta === 'string' ? p.delta : '';
          if (delta) {
            text += delta;
            if (typeof onDelta === 'function') {
              try { onDelta(delta); } catch { /* ignore callback error */ }
            }
          }
        } else if (msg.method === 'item/completed' && p.item && (p.item.type === 'agentMessage' || p.item.type === 'agent_message')) {
          if (typeof p.item.text === 'string' && p.item.text) finalItemText = p.item.text;
        } else if (msg.method === 'thread/tokenUsage/updated' || msg.method === 'turn/tokenUsage/updated') {
          const u = p.tokenUsage?.last || p.tokenUsage?.total || p.usage || {};
          const input = Number(u.inputTokens ?? u.input_tokens ?? 0);
          const cached = Number(u.cachedInputTokens ?? u.cached_input_tokens ?? 0);
          const out = Number(u.outputTokens ?? u.output_tokens ?? 0);
          const total = Number(u.totalTokens ?? u.total_tokens ?? (input + out));
          usage = {
            uncachedInputTokens: Math.max(0, input - cached),
            cachedInputTokens: cached,
            outputTokens: out,
            providerTotalTokens: total,
          };
        } else if (msg.method === 'turn/completed') {
          const status = p.turn?.status || 'completed';
          const errObj = p.turn?.error || null;
          if (status === 'failed' || errObj) {
            const errMsg = (errObj && (errObj.message || JSON.stringify(errObj))) || 'codex_turn_failed';
            const err = new Error(errMsg);
            if (/429|rate.?limit|quota/i.test(errMsg)) err.status = 429;
            else if (/401|auth|login/i.test(errMsg)) err.status = 401;
            finish(err);
            return;
          }
          finish(null, {
            text: (text || finalItemText || '').trim(),
            status,
            usage,
            threadId,
            turnId: p.turn?.id || turnId,
            durationMs: Date.now() - startedAt,
          });
        }
      });

      const params = { threadId, input: items };
      if (model && model !== 'auto') params.model = model;
      if (effort) params.effort = effort;
      request('turn/start', params, { timeoutMs: Math.min(turnTimeout, 30_000), signal })
        .then((res) => {
          if (res?.turn?.id) turnId = res.turn.id;
        })
        .catch((err) => finish(err));
    });
  }

  async function generate(prompt, {
    system = null,
    messages = null,
    images = null,
    model = null,
    effort = null,
    threadId = null,
    ephemeral = true,
    onDelta = null,
    signal = null,
    timeoutMs: turnTimeout = timeoutMs,
  } = {}) {
    await ensureStarted();
    const resolvedModel = await resolveModel(model);
    let activeThreadId = threadId;
    if (!activeThreadId) {
      const th = await startThread({
        model: resolvedModel,
        ephemeral,
        baseInstructions: system || undefined,
      });
      activeThreadId = th.threadId;
    }
    const input = [];
    let bodyText = '';
    if (Array.isArray(messages) && messages.length) {
      bodyText = messages.map((m) => {
        const role = m.role === 'assistant' ? 'Assistant' : (m.role === 'tool' ? `Tool(${m.name || 'tool'})` : 'User');
        return `[${role}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
      }).join('\n\n');
    } else {
      bodyText = String(prompt ?? '');
    }
    input.push({ type: 'text', text: bodyText });
    if (Array.isArray(images)) {
      for (const img of images) {
        if (!img) continue;
        if (img.url) input.push({ type: 'image', url: img.url });
        else if (img.path) input.push({ type: 'localImage', path: img.path });
      }
    }
    const res = await runTurn({
      threadId: activeThreadId,
      input,
      model: resolvedModel,
      effort,
      onDelta,
      signal,
      timeoutMs: turnTimeout,
    });
    return {
      text: res.text,
      usage: res.usage,
      durationMs: res.durationMs,
      responseId: res.turnId || activeThreadId,
      threadId: activeThreadId,
      model: resolvedModel,
    };
  }

  async function close() {
    closing = true;
    started = false;
    rejectAllPending(new Error('codex_app_server_closed'));
    if (rl) { try { rl.close(); } catch { /* ignore */ } rl = null; }
    const child = proc;
    proc = null;
    if (!child) return;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', fin);
      try { child.kill('SIGTERM'); } catch { fin(); }
      setTimeout(() => {
        if (!done) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          fin();
        }
      }, 2000).unref();
    });
  }

  return {
    get ready() { return Boolean(resolvedBinary()); },
    get running() { return Boolean(started && proc && proc.exitCode === null); },
    resolvedBinary,
    start,
    request,
    notify,
    onNotification,
    readAccount,
    startLogin,
    readRateLimits,
    listModels,
    resolveModel,
    startThread,
    runTurn,
    generate,
    close,
  };
}
