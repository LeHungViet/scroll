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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';

const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;

function extForImageMime(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  return '.jpg';
}

function writeTempImageBase64(b64, mimeType) {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/i, '').trim();
  if (!clean) throw new Error('codex_image_base64_empty');
  const buf = Buffer.from(clean, 'base64');
  if (buf.length === 0) throw new Error('codex_image_base64_empty');
  if (buf.length > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(`codex_image_exceeds_max_bytes:${buf.length}>${MAX_INLINE_IMAGE_BYTES}`);
  }
  const tmpPath = path.join(
    os.tmpdir(),
    `scroll-vision-${process.pid}-${crypto.randomBytes(8).toString('hex')}${extForImageMime(mimeType)}`
  );
  fs.writeFileSync(tmpPath, buf, { mode: 0o600 });
  return tmpPath;
}

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
  // Active turn-bound tool handlers: threadId -> { turnId, handler, signal, closed, completedCalls, inflightCalls, pendingCalls }
  const activeTurnBindings = new Map();
  // Completed/aborted turn IDs per thread so late RPCs from an earlier turn can NEVER bind to a new turn
  const finishedTurnIdsByThread = new Map();

  function markTurnFinished(threadId, tid) {
    if (!threadId || !tid) return;
    let set = finishedTurnIdsByThread.get(threadId);
    if (!set) {
      set = new Set();
      finishedTurnIdsByThread.set(threadId, set);
    }
    set.add(String(tid));
    if (set.size > 64) {
      const first = set.values().next().value;
      set.delete(first);
    }
  }

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

  function sendToolResult(id, text, ok) {
    try {
      sendRaw({
        jsonrpc: '2.0',
        id,
        result: {
          contentItems: [{ type: 'inputText', text }],
          success: Boolean(ok),
        },
      });
    } catch { /* ignore closed pipe */ }
  }

  function handleServerRequest(msg) {
    const id = msg.id;
    const method = msg.method;
    const p = msg.params || {};
    if (method === 'item/tool/call') {
      if (!p.threadId) {
        sendToolResult(id, JSON.stringify({ error: 'missing_thread_id', tool: p.tool }), false);
        return;
      }
      const binding = activeTurnBindings.get(p.threadId);
      if (!binding || typeof binding.handler !== 'function') {
        sendToolResult(id, JSON.stringify({ error: 'no_tool_handler_registered', tool: p.tool }), false);
        return;
      }
      if (binding.closed || binding.signal?.aborted) {
        sendToolResult(id, JSON.stringify({ error: 'turn_closed_or_aborted', tool: p.tool }), false);
        return;
      }
      const prevSet = finishedTurnIdsByThread.get(p.threadId);
      if (p.turnId && prevSet && prevSet.has(String(p.turnId))) {
        sendToolResult(
          id,
          JSON.stringify({ error: 'stale_turn_id_rejected', gotTurnId: p.turnId, tool: p.tool }),
          false
        );
        return;
      }
      if (!binding.turnId) {
        if (!p.turnId) {
          sendToolResult(id, JSON.stringify({ error: 'missing_turn_id', tool: p.tool }), false);
          return;
        }
        binding.pendingCalls.push({ id, p });
        return;
      }
      dispatchToolCall(id, p, binding);
      return;
    }
    // Fail-closed default for unhandled server approval requests so turns never hang
    try {
      sendRaw({ jsonrpc: '2.0', id, result: { decision: 'decline' } });
    } catch { /* ignore */ }
  }

  function dispatchToolCall(id, p, binding) {
    if (binding.closed || binding.signal?.aborted) {
      sendToolResult(id, JSON.stringify({ error: 'turn_closed_or_aborted', tool: p.tool }), false);
      return;
    }
    if (!binding.turnId || !p.turnId || p.turnId !== binding.turnId) {
      sendToolResult(
        id,
        JSON.stringify({ error: 'turn_id_mismatch', expectedTurnId: binding.turnId || null, gotTurnId: p.turnId || null, tool: p.tool }),
        false
      );
      return;
    }
    const callKey = p.callId ? String(p.callId) : null;
    if (typeof binding.onActivity === 'function') binding.onActivity('tool_start');
    if (callKey && binding.completedCalls.has(callKey)) {
      const cached = binding.completedCalls.get(callKey);
      sendToolResult(id, cached.text, cached.ok);
      return;
    }
    const invokePromise = (callKey && binding.inflightCalls.has(callKey))
      ? binding.inflightCalls.get(callKey)
      : Promise.resolve().then(() => binding.handler({
        tool: p.tool,
        arguments: p.arguments || {},
        callId: callKey,
        threadId: p.threadId || null,
        turnId: p.turnId || binding.turnId || null,
      }));
    if (callKey && !binding.inflightCalls.has(callKey)) {
      binding.inflightCalls.set(callKey, invokePromise);
    }
    invokePromise
      .then((res) => {
        if (typeof binding.onActivity === 'function') binding.onActivity('tool_end');
        const text = typeof res === 'string'
          ? res
          : (typeof res?.text === 'string' ? res.text : JSON.stringify(res ?? {}));
        const ok = res?.ok !== false && res?.success !== false;
        if (callKey) {
          binding.inflightCalls.delete(callKey);
          binding.completedCalls.set(callKey, { text, ok });
        }
        if (binding.closed || binding.signal?.aborted) {
          sendToolResult(id, JSON.stringify({ error: 'turn_closed_or_aborted', tool: p.tool }), false);
          return;
        }
        sendToolResult(id, text, ok);
      })
      .catch((err) => {
        if (typeof binding.onActivity === 'function') binding.onActivity('tool_error');
        if (callKey) binding.inflightCalls.delete(callKey);
        sendToolResult(id, JSON.stringify({ error: String(err?.message || err) }), false);
      });
  }

  function bindAuthoritativeTurnId(binding, tid) {
    if (!binding || !tid || binding.turnId) return;
    binding.turnId = String(tid);
    const queued = binding.pendingCalls.splice(0, binding.pendingCalls.length);
    for (const item of queued) {
      dispatchToolCall(item.id, item.p, binding);
    }
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    // Server-to-client RPC request (has BOTH method and id)
    if (msg.method && msg.id !== undefined) {
      handleServerRequest(msg);
      return;
    }
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
      const myProc = spawn(bin, spawnArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc = myProc;
      const startedAtMs = Date.now();
      myProc.stdin?.on('error', (err) => {
        if (proc === myProc && !closing) rejectAllPending(err);
      });
      myProc.stderr.on('data', (buf) => {
        stderrTail = (stderrTail + buf.toString('utf8')).slice(-2000);
      });
      const myRl = readline.createInterface({ input: myProc.stdout });
      rl = myRl;
      myRl.on('line', (line) => {
        if (proc !== myProc) return;
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) return;
        try {
          handleMessage(JSON.parse(trimmed));
        } catch {
          // ignore non-JSON diagnostic line
        }
      });
      myProc.once('exit', (code, sig) => {
        if (proc !== myProc) {
          try { myRl.close(); } catch { /* ignore */ }
          return;
        }
        const wasStarted = started;
        started = false;
        startPromise = null;
        try { myRl.close(); } catch { /* ignore */ }
        if (rl === myRl) rl = null;
        proc = null;
        if (!closing) {
          rejectAllPending(new Error(`codex_app_server_exited:${code ?? sig}:${stderrTail.slice(-200)}`));
          if (wasStarted) {
            // Reset restart counter if process ran stably for >= 60s before exiting
            if (Date.now() - startedAtMs >= 60_000) restartCount = 0;
            restartCount++;
          }
        }
      });
      myProc.once('error', (err) => {
        if (proc !== myProc) return;
        started = false;
        startPromise = null;
        rejectAllPending(err);
      });
      try {
        const initRes = await request('initialize', {
          clientInfo,
          capabilities: { experimentalApi: true },
        }, { timeoutMs: Math.min(timeoutMs, 30_000) });
        notify('initialized', {});
        started = true;
        return initRes;
      } catch (err) {
        // Kill child process cleanly on init timeout/error so no orphan leaks or disrupts future procs
        started = false;
        try { myRl.close(); } catch { /* ignore */ }
        if (rl === myRl) rl = null;
        if (proc === myProc) proc = null;
        if (myProc.exitCode === null) {
          try { myProc.kill('SIGKILL'); } catch { /* ignore */ }
        }
        throw err;
      }
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

  function toDynamicTools(tools) {
    if (!Array.isArray(tools) || !tools.length) return null;
    return tools.map((t) => ({
      type: 'function',
      name: String(t.name),
      description: String(t.description || ''),
      inputSchema: t.inputSchema || t.parameters || { type: 'object', properties: {} },
      deferLoading: false,
    }));
  }

  async function startThread({
    model = null,
    ephemeral = true,
    approvalPolicy = 'never',
    sandbox = 'read-only',
    baseInstructions = null,
    developerInstructions = null,
    dynamicTools = null,
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
    const dyn = toDynamicTools(dynamicTools);
    if (dyn) params.dynamicTools = dyn;
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
    onToolCall = null,
    signal = null,
    timeoutMs: turnTimeout = timeoutMs,
    maxWallMs = null,
  } = {}) {
    await ensureStarted();
    if (!threadId) throw new Error('runTurn: threadId is required');
    const items = Array.isArray(input)
      ? input
      : [{ type: 'text', text: String(input ?? '') }];
    const startedAt = Date.now();
    const hardWallMs = Math.max(Number(turnTimeout || 120_000), Number(maxWallMs || Math.max(Number(turnTimeout || 120_000) * 3, 300_000)));

    let resetIdleTimer = () => {};
    const turnBinding = typeof onToolCall === 'function'
      ? {
        turnId: null,
        handler: onToolCall,
        signal,
        closed: false,
        completedCalls: new Map(),
        inflightCalls: new Map(),
        pendingCalls: [],
        onActivity: () => resetIdleTimer(),
      }
      : null;
    if (turnBinding) activeTurnBindings.set(threadId, turnBinding);

    return new Promise((resolve, reject) => {
      let settled = false;
      let turnId = null;
      let text = '';
      let finalItemText = '';
      let usage = { uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, providerTotalTokens: 0 };
      let idleTimer = null;
      let wallTimer = null;

      const cleanup = () => {
        if (turnId) markTurnFinished(threadId, turnId);
        if (turnBinding) {
          turnBinding.closed = true;
          for (const item of turnBinding.pendingCalls.splice(0, turnBinding.pendingCalls.length)) {
            sendToolResult(item.id, JSON.stringify({ error: 'turn_closed_or_aborted', tool: item.p?.tool }), false);
          }
          if (activeTurnBindings.get(threadId) === turnBinding) {
            activeTurnBindings.delete(threadId);
          }
        }
        unsub();
        if (idleTimer) clearTimeout(idleTimer);
        if (wallTimer) clearTimeout(wallTimer);
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
        if (turnBinding) turnBinding.closed = true;
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

      const abortForTimeout = (label) => {
        if (turnBinding) turnBinding.closed = true;
        if (turnId) {
          request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 }).catch(() => {});
        }
        finish(new Error(label));
      };

      // Activity-aware idle timer: resets when tools start/finish or deltas stream,
      // bounded by `hardWallMs` ceiling so genuinely hung turns still abort cleanly.
      resetIdleTimer = () => {
        if (settled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abortForTimeout(`codex_turn_timeout:${turnTimeout}ms`), turnTimeout);
        if (typeof idleTimer.unref === 'function') idleTimer.unref();
      };
      resetIdleTimer();
      wallTimer = setTimeout(() => abortForTimeout(`codex_turn_wall_timeout:${hardWallMs}ms`), hardWallMs);
      if (typeof wallTimer.unref === 'function') wallTimer.unref();

      const pendingNotifications = [];
      const pendingTerminalByTurn = new Map();

      const handleTurnNotification = (msg) => {
        if (settled) return;
        const p = msg.params || {};
        // Strict thread/turn binding: never leak notifications missing threadId or belonging to another turn
        const msgThreadId = p.threadId || p.turn?.threadId || null;
        if (typeof msgThreadId !== 'string' || msgThreadId !== threadId) return;
        // Read ONLY protocol-defined turnId fields per Codex App-Server v2 JSON schema (no item.turnId fallback, no String() coercion!)
        const isTurnLifecycle = msg.method === 'turn/started' || msg.method === 'turn/completed';
        const rawTurnId = isTurnLifecycle ? p.turn?.id : p.turnId;
        const msgTurnId = typeof rawTurnId === 'string' && rawTurnId.length > 0 ? rawTurnId : null;
        if (msg.method === 'turn/started') {
          if (!msgTurnId) return;
          const prevSet = finishedTurnIdsByThread.get(threadId);
          if (prevSet && prevSet.has(msgTurnId)) return;
          if (!turnId) {
            turnId = msgTurnId;
            bindAuthoritativeTurnId(turnBinding, turnId);
            flushPendingNotifications();
          }
          return;
        }
        if (!msgTurnId) return;
        if (finishedTurnIdsByThread.get(threadId)?.has(msgTurnId)) return;
        if (!turnId) {
          // Buffer turn-scoped notifications before authoritative turnId binds:
          // always preserve turn/completed in pendingTerminalByTurn and coalesce consecutive deltas so bursts never drop completion!
          if (msg.method === 'turn/completed') {
            if (pendingTerminalByTurn.size >= 64 && !pendingTerminalByTurn.has(msgTurnId)) {
              const oldest = pendingTerminalByTurn.keys().next().value;
              pendingTerminalByTurn.delete(oldest);
            }
            pendingTerminalByTurn.set(msgTurnId, msg);
            return;
          }
          if (msg.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
            const last = pendingNotifications[pendingNotifications.length - 1];
            if (last && last.method === 'item/agentMessage/delta' && last.params?.turnId === msgTurnId) {
              last.params = { ...last.params, delta: String(last.params.delta || '') + p.delta };
              return;
            }
          }
          if (pendingNotifications.length < 256) {
            pendingNotifications.push({ ...msg, params: { ...p } });
          }
          return;
        }
        // Strict exact-string turnId match for ALL turn notifications including thread/tokenUsage/updated
        if (msgTurnId !== turnId) return;
        if (msg.method === 'item/agentMessage/delta') {
          resetIdleTimer();
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
            else if (/context.?length|maximum.?context|too many tokens|prompt.?too.?long/i.test(errMsg)) {
              err.status = 400;
              err.code = 'CONTEXT_LENGTH_EXCEEDED';
            }
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
      };

      const flushPendingNotifications = () => {
        if (!turnId) return;
        if (pendingNotifications.length) {
          const queued = pendingNotifications.splice(0, pendingNotifications.length);
          for (const m of queued) {
            handleTurnNotification(m);
            if (settled) break;
          }
        }
        if (!settled && pendingTerminalByTurn.has(turnId)) {
          const termMsg = pendingTerminalByTurn.get(turnId);
          pendingTerminalByTurn.clear();
          handleTurnNotification(termMsg);
        } else {
          pendingTerminalByTurn.clear();
        }
      };

      const unsub = onNotification(handleTurnNotification);

      const params = { threadId, input: items };
      if (model && model !== 'auto') params.model = model;
      if (effort) params.effort = effort;
      request('turn/start', params, { timeoutMs: Math.min(turnTimeout, 30_000), signal })
        .then((res) => {
          if (typeof res?.turn?.id === 'string' && res.turn.id.length > 0 && !turnId) {
            turnId = res.turn.id;
            bindAuthoritativeTurnId(turnBinding, turnId);
            flushPendingNotifications();
          }
        })
        .catch((err) => finish(err));
    });
  }

  async function generate(prompt, {
    system = null,
    messages = null,
    tools = null,
    onToolCall = null,
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
        dynamicTools: Array.isArray(tools) && tools.length && typeof onToolCall === 'function' ? tools : null,
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
    const tempFiles = [];
    let res;
    try {
      if (Array.isArray(images)) {
        for (const img of images) {
          if (!img) continue;
          if (img.url) {
            input.push({ type: 'image', url: img.url });
          } else if (img.path) {
            input.push({ type: 'localImage', path: img.path });
          } else if (img.base64) {
            const tmpPath = writeTempImageBase64(img.base64, img.mimeType);
            tempFiles.push(tmpPath);
            input.push({ type: 'localImage', path: tmpPath });
          }
        }
      }
      res = await runTurn({
        threadId: activeThreadId,
        input,
        model: resolvedModel,
        effort,
        onDelta,
        onToolCall,
        signal,
        timeoutMs: turnTimeout,
      });
    } finally {
      for (const f of tempFiles) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
    }
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
