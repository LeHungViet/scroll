// SCROLL 2.5 -- §47 Zero-Dependency MCP (Model Context Protocol) Client:
//   - stdio JSON-RPC 2.0 transport with sanitized subprocess env (no ambient secret leak!)
//   - Streamable HTTP transport (`POST` JSON-RPC + `application/json` & `text/event-stream`,
//     `Mcp-Session-Id` header lifecycle, automatic HTTP 404 stale-session re-initialization)
//   - Fail-closed `${vault:KEY}` resolution (throws on missing secret instead of empty string)
//   - Per-server fault isolation in `connectAll()` (one dead server never aborts others)
//   - `notifications/tools/list_changed` handling + `.scroll/mcp.lock.json` TOFU schema pinning
//     & ASI04 rug-pull quarantine (`diffMcpLock` / `approveMcpLock`)
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { buildSanitizedEnv } from './sandbox.js';
import { resolveVaultPlaceholders } from './vault.js';
import { computeSchemaHash, computeDescHash } from './tool-retriever.js';

function normalizeTransport(cfg) {
  const raw = String(cfg.transport || cfg.type || '').trim().toLowerCase();
  if (raw === 'stdio') return 'stdio';
  if (raw === 'http' || raw === 'streamable-http' || raw === 'streamable_http') return 'http';
  if (raw) return raw;
  if (cfg.command) return 'stdio';
  if (cfg.url) return 'http';
  return 'stdio';
}

function hashCommandSpec(cfg) {
  const basis = cfg.transport === 'http'
    ? `http:${cfg.url || ''}`
    : `stdio:${cfg.command || ''} ${(cfg.args || []).join(' ')}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

const SUPPORTED_MCP_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function assertSafeMcpHttpUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { throw new Error(`mcp_http_invalid_url:${rawUrl}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`mcp_http_disallowed_protocol:${u.protocol}`);
  }
  const host = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === '169.254.169.254' || host === 'metadata.google.internal' || host === 'metadata') {
    throw new Error(`mcp_http_ssrf_blocked:${host}`);
  }
  return u.toString();
}

export function loadMcpConfig({
  cwd = process.cwd(),
  agentDir = null,
  env = process.env,
  vault = null,
  failClosed = true,
  isolateErrors = false,
  onServerError = null,
} = {}) {
  const files = [path.join(cwd, '.mcp.json')];
  if (agentDir) files.push(path.join(agentDir, '.mcp.json'));
  const servers = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const [name, cfg] of Object.entries(parsed.mcpServers || {})) {
      if (!cfg || typeof cfg !== 'object') continue;
      try {
        const resolvedEnv = {};
        for (const [k, v] of Object.entries(cfg.env || {})) {
          resolvedEnv[k] = resolveVaultPlaceholders(String(v), { env, vault, failClosed });
        }
        const resolvedHeaders = {};
        for (const [k, v] of Object.entries(cfg.headers || {})) {
          resolvedHeaders[k] = resolveVaultPlaceholders(String(v), { env, vault, failClosed });
        }
        const transport = normalizeTransport(cfg);
        const args = Array.isArray(cfg.args)
          ? cfg.args.map((a) => resolveVaultPlaceholders(String(a), { env, vault, failClosed }))
          : [];
        const url = cfg.url ? resolveVaultPlaceholders(String(cfg.url), { env, vault, failClosed }) : null;
        servers[name] = {
          name,
          command: cfg.command || null,
          args,
          url,
          transport,
          cwd: cfg.cwd ? path.resolve(cwd, cfg.cwd) : cwd,
          env: resolvedEnv,
          headers: resolvedHeaders,
          description: cfg.description || '',
          deferLoading: cfg.defer_loading !== undefined ? Boolean(cfg.defer_loading) : null,
          tags: Array.isArray(cfg.tags) ? cfg.tags.map(String) : [],
          allowEnv: Array.isArray(cfg.allow_env) ? cfg.allow_env.map(String) : null,
          tools: cfg.tools && typeof cfg.tools === 'object' ? cfg.tools : {},
        };
        servers[name].cmdHash = hashCommandSpec(servers[name]);
      } catch (err) {
        if (!isolateErrors) throw err;
        if (typeof onServerError === 'function') {
          onServerError({ server: name, error: String(err?.message || err) });
        }
      }
    }
  }
  return servers;
}

// ── .scroll/mcp.lock.json (TOFU Pinning & ASI04 Rug-Pull Quarantine) ───────────
export function mcpLockPath(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), '.scroll', 'mcp.lock.json');
}

export function loadMcpLock(cwd = process.cwd()) {
  const p = mcpLockPath(cwd);
  if (!fs.existsSync(p)) return { version: 1, tools: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { version: 1, tools: parsed?.tools && typeof parsed.tools === 'object' ? parsed.tools : {} };
  } catch {
    return { version: 1, tools: {} };
  }
}

export function saveMcpLock(cwd = process.cwd(), lockObj) {
  const p = mcpLockPath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tools: lockObj.tools || {} }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

export function verifyServerConfigAgainstLock(serverName, cfg, { cwd = process.cwd() } = {}) {
  const lock = loadMcpLock(cwd);
  const entries = Object.values(lock.tools || {}).filter((e) => e && e.server === serverName);
  if (!entries.length) {
    return { ok: true, pinnedServer: false };
  }
  const actualCmdHash = cfg?.cmdHash || null;
  for (const e of entries) {
    if (e.cmdHash && actualCmdHash !== e.cmdHash) {
      return {
        ok: false,
        pinnedServer: true,
        reason: 'mcp_server_command_drifted_asi04',
        expectedCmdHash: e.cmdHash,
        actualCmdHash,
      };
    }
  }
  return { ok: true, pinnedServer: true };
}

export function verifyAndPinTools(discoveredTools, { cwd = process.cwd(), autoPin = true, pinnedBy = 'tofu' } = {}) {
  const lock = loadMcpLock(cwd);
  // Snapshot servers that ALREADY have pinned tools BEFORE this pass:
  // TOFU `autoPin` may only onboard brand-new servers, NEVER silently approve newly-injected tools on an already-locked server!
  const previouslyPinnedServers = new Set(
    Object.values(lock.tools || {})
      .map((e) => e && e.server)
      .filter(Boolean)
  );
  let dirty = false;
  const approved = [];
  const quarantined = [];

  for (const t of discoveredTools || []) {
    const key = t.fullName || `mcp.${t.server}.${t.name}`;
    const schemaHash = computeSchemaHash({ name: key, description: t.description, parameters: t.parameters });
    const descHash = computeDescHash(t.description || '');
    const enriched = { ...t, fullName: key, schemaHash, descHash };

    const pinned = lock.tools[key];
    if (!pinned) {
      if (autoPin && !previouslyPinnedServers.has(t.server)) {
        lock.tools[key] = {
          server: t.server,
          cmdHash: t.cmdHash || null,
          tool: t.name,
          schemaHash,
          descHash,
          risk: t.risk || null,
          ground: Array.isArray(t.ground) ? t.ground : [],
          short_description: t.shortDescription || null,
          pinnedBy,
          pinnedAt: new Date().toISOString(),
        };
        dirty = true;
        approved.push({ ...enriched, lockStatus: 'pinned_new' });
      } else {
        quarantined.push({
          ...enriched,
          lockStatus: 'unpinned',
          reason: previouslyPinnedServers.has(t.server)
            ? 'mcp_unpinned_tool_on_locked_server'
            : 'mcp_tool_not_pinned',
        });
      }
      continue;
    }

    const cmdDrifted = Boolean(
      (pinned.cmdHash && t.cmdHash !== pinned.cmdHash)
      || (!pinned.cmdHash && t.cmdHash)
    );
    const riskDrifted = Boolean(pinned.risk && t.risk && pinned.risk !== t.risk);
    const pinnedGround = JSON.stringify(Array.isArray(pinned.ground) ? [...pinned.ground].sort() : []);
    const actualGround = JSON.stringify(Array.isArray(t.ground) ? [...t.ground].sort() : []);
    const groundDrifted = Boolean(Array.isArray(pinned.ground) && pinned.ground.length && pinnedGround !== actualGround);
    if (pinned.schemaHash !== schemaHash || pinned.descHash !== descHash || cmdDrifted || riskDrifted || groundDrifted) {
      quarantined.push({
        ...enriched,
        lockStatus: 'quarantined_drift',
        reason: cmdDrifted
          ? 'mcp_server_command_drifted_asi04'
          : (riskDrifted || groundDrifted ? 'mcp_governance_metadata_drifted_asi04' : 'mcp_schema_or_description_mutated_asi04'),
        expectedSchemaHash: pinned.schemaHash,
        expectedDescHash: pinned.descHash,
        expectedCmdHash: pinned.cmdHash || null,
      });
    } else {
      approved.push({
        ...enriched,
        shortDescription: pinned.short_description || enriched.shortDescription || null,
        lockStatus: 'verified',
      });
    }
  }

  if (dirty) saveMcpLock(cwd, lock);
  return { approved, quarantined, lockPath: mcpLockPath(cwd) };
}

export function approveMcpLock(cwd = process.cwd(), toolsToApprove = [], { pinnedBy = 'operator' } = {}) {
  const lock = loadMcpLock(cwd);
  let count = 0;
  for (const t of toolsToApprove || []) {
    const key = t.fullName || `mcp.${t.server}.${t.name}`;
    lock.tools[key] = {
      server: t.server,
      cmdHash: t.cmdHash || null,
      tool: t.name,
      schemaHash: t.schemaHash || computeSchemaHash({ name: key, description: t.description, parameters: t.parameters }),
      descHash: t.descHash || computeDescHash(t.description || ''),
      risk: t.risk || null,
      ground: Array.isArray(t.ground) ? t.ground : [],
      short_description: t.shortDescription || null,
      pinnedBy,
      pinnedAt: new Date().toISOString(),
    };
    count++;
  }
  const lockFile = saveMcpLock(cwd, lock);
  return { ok: true, approved: count, lockPath: lockFile };
}

// ── Transport 1: Zero-Dep MCP stdio JSON-RPC 2.0 Client ───────────────────────
export function createMcpStdioClient({
  name = 'mcp',
  command,
  args = [],
  cwd = process.cwd(),
  env = {},
  allowEnv = null,
  baseEnv = process.env,
  timeoutMs = 30_000,
  onToolsChanged = null,
  clientInfo = { name: 'scroll-mcp-client', version: '2.5.0' },
} = {}) {
  if (!command) throw new Error(`createMcpStdioClient(${name}): command is required`);
  let proc = null;
  let rl = null;
  let connected = false;
  let closing = false;
  let nextId = 1;
  let serverInfo = null;
  const pending = new Map();

  function rejectPending(err) {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function sendRaw(obj) {
    if (!proc || !proc.stdin || proc.stdin.destroyed) {
      throw new Error(`mcp_not_connected:${name}`);
    }
    proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  function request(method, params = {}, { timeoutMs: reqTimeout = timeoutMs, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`mcp_aborted:${name}:${method}`));
        return;
      }
      const id = nextId++;
      const onAbort = () => {
        if (pending.has(id)) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`mcp_aborted:${name}:${method}`));
        }
      };
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(new Error(`mcp_timeout:${name}:${method}:${reqTimeout}ms`));
        }
      }, reqTimeout);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (v) => { if (signal) signal.removeEventListener('abort', onAbort); resolve(v); },
        reject: (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e); },
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

  function notify(method, params = {}) {
    sendRaw({ jsonrpc: '2.0', method, params });
  }

  async function connect() {
    if (connected && proc && proc.exitCode === null) return serverInfo;
    closing = false;
    // Sanitized env: NEVER inherit ambient OPENAI_API_KEY / ANTHROPIC_API_KEY / bot tokens!
    const sanitizedEnv = buildSanitizedEnv({
      allowEnv: allowEnv || undefined,
      extraEnv: env,
      baseEnv,
    });
    proc = spawn(command, args, {
      cwd,
      env: sanitizedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Drain stderr into a bounded ring buffer so verbose MCP servers NEVER deadlock on full 64KB OS pipe
    let stderrTail = '';
    proc.stderr?.on('data', (chunk) => {
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > 16_384) stderrTail = stderrTail.slice(-16_384);
    });
    // Prevent unhandled EPIPE error event from crashing the host when child exits mid-write
    proc.stdin?.on('error', (err) => {
      connected = false;
      if (!closing) rejectPending(err);
    });
    rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }
      // Distinguish JSON-RPC response (id present, NO method) from server-initiated request (id AND method)
      if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const e = new Error(msg.error.message || JSON.stringify(msg.error));
          e.code = msg.error.code;
          entry.reject(e);
        } else {
          entry.resolve(msg.result);
        }
      } else if (msg.method === 'notifications/tools/list_changed' && typeof onToolsChanged === 'function') {
        try { onToolsChanged(name); } catch { /* isolate callback */ }
      }
    });
    proc.once('exit', (code, sig) => {
      connected = false;
      if (rl) { try { rl.close(); } catch { /* ignore */ } rl = null; }
      proc = null;
      if (!closing) rejectPending(new Error(`mcp_server_exited:${name}:${code ?? sig}`));
    });
    proc.once('error', (err) => {
      connected = false;
      rejectPending(err);
    });
    try {
      const res = await request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo,
      });
      notify('notifications/initialized', {});
      connected = true;
      serverInfo = res;
      return res;
    } catch (err) {
      // Never leak orphan child processes when initialize fails or times out!
      closing = true;
      connected = false;
      if (rl) { try { rl.close(); } catch { /* ignore */ } rl = null; }
      if (proc && proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      proc = null;
      rejectPending(err);
      throw err;
    }
  }

  async function listTools() {
    if (!connected) await connect();
    const out = [];
    let cursor = undefined;
    for (let page = 0; page < 20; page++) {
      const res = await request('tools/list', cursor ? { cursor } : {});
      if (Array.isArray(res?.tools)) out.push(...res.tools);
      cursor = res?.nextCursor || null;
      if (!cursor) break;
    }
    return out;
  }

  async function callTool(toolName, argsObj = {}, { timeoutMs: callTimeout = timeoutMs, signal = null } = {}) {
    if (!connected) await connect();
    const res = await request('tools/call', { name: toolName, arguments: argsObj || {} }, { timeoutMs: callTimeout, signal });
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
    return {
      ok: !res?.isError,
      isError: Boolean(res?.isError),
      text: text || (content.length ? JSON.stringify(content) : JSON.stringify(res ?? {})),
      content,
      raw: res,
    };
  }

  async function close() {
    closing = true;
    connected = false;
    rejectPending(new Error(`mcp_closed:${name}`));
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
      }, 1500).unref();
    });
  }

  return {
    name,
    transport: 'stdio',
    get connected() { return connected; },
    connect,
    listTools,
    callTool,
    close,
  };
}

// ── Transport 2: Zero-Dep MCP Streamable HTTP Client (MCP 2025-03 / 2025-06) ───
async function parseMcpHttpResponse(res, expectedId, onNotification, onEventId = null) {
  const ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : '';
  if (!ct.includes('text/event-stream')) {
    const text = await res.text();
    if (!text.trim()) return null;
    const json = JSON.parse(text);
    if (json.error) {
      const e = new Error(json.error.message || JSON.stringify(json.error));
      e.code = json.error.code;
      throw e;
    }
    return json.result;
  }

  // Proper SSE framing (`\n\n` event boundaries, multi-line `data:`, `id:` tracking, EOF flush)
  const raw = res.body && typeof res.body.getReader === 'function'
    ? await (async () => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
        }
        acc += decoder.decode();
        return acc;
      })()
    : await res.text();

  let matchedResult = undefined;
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) {
        const evId = line.slice(3).trim();
        if (evId && typeof onEventId === 'function') onEventId(evId);
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    let msg;
    try { msg = JSON.parse(payload); } catch { continue; }
    if (msg.method && msg.id === undefined) {
      if (typeof onNotification === 'function') onNotification(msg);
      continue;
    }
    // Ignore server-initiated requests (both `id` AND `method`) when waiting for our RPC response
    if (msg.method && msg.id !== undefined) {
      continue;
    }
    if (expectedId === undefined || msg.id === expectedId) {
      if (msg.error) {
        const e = new Error(msg.error.message || JSON.stringify(msg.error));
        e.code = msg.error.code;
        throw e;
      }
      matchedResult = msg.result;
    }
  }
  return matchedResult;
}

export function createMcpHttpClient({
  name = 'mcp-http',
  url,
  headers = {},
  timeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
  onToolsChanged = null,
  clientInfo = { name: 'scroll-mcp-client', version: '2.5.0' },
} = {}) {
  if (!url) throw new Error(`createMcpHttpClient(${name}): url is required`);
  const safeUrl = assertSafeMcpHttpUrl(url);
  let sessionId = null;
  let negotiatedProtocol = SUPPORTED_MCP_PROTOCOLS[1]; // default 2025-03-26
  let lastEventId = null;
  let connected = false;
  let nextId = 1;
  let serverInfo = null;

  async function rpc(method, params = {}, { isNotification = false, timeoutMs: reqTimeout = timeoutMs, signal = null, allowReinit = true } = {}) {
    const id = isNotification ? undefined : nextId++;
    const body = isNotification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id, method, params };
    const reqHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': negotiatedProtocol,
      ...headers,
    };
    if (sessionId) reqHeaders['Mcp-Session-Id'] = sessionId;
    if (lastEventId) reqHeaders['Last-Event-ID'] = lastEventId;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), reqTimeout);
    const onExtAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onExtAbort, { once: true });
    }
    try {
      const res = await fetchImpl(safeUrl, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      // Streamable HTTP stale session recovery: HTTP 404 -> drop Mcp-Session-Id and re-initialize once
      if (res.status === 404 && allowReinit && sessionId && method !== 'initialize') {
        sessionId = null;
        connected = false;
        await connect();
        return rpc(method, params, { isNotification, timeoutMs: reqTimeout, signal, allowReinit: false });
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`mcp_http_${res.status}:${name}:${errText.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const newSid = res.headers && typeof res.headers.get === 'function'
        ? (res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id'))
        : null;
      if (newSid) sessionId = newSid;
      if (isNotification || res.status === 202) return null;

      return await parseMcpHttpResponse(
        res,
        id,
        (notif) => {
          if (notif.method === 'notifications/tools/list_changed' && typeof onToolsChanged === 'function') {
            try { onToolsChanged(name); } catch { /* ignore */ }
          }
        },
        (evId) => { lastEventId = evId; },
      );
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExtAbort);
    }
  }

  async function connect() {
    if (connected) return serverInfo;
    const res = await rpc('initialize', {
      protocolVersion: negotiatedProtocol,
      capabilities: {},
      clientInfo,
    }, { allowReinit: false });
    if (res && typeof res.protocolVersion === 'string') {
      if (!SUPPORTED_MCP_PROTOCOLS.includes(res.protocolVersion)) {
        // Keep negotiated version if server speaks a newer compatible 2025-* revision; reject obviously invalid
        if (!/^202[4-9]-\d{2}-\d{2}$/.test(res.protocolVersion)) {
          throw new Error(`mcp_unsupported_protocol_version:${name}:${res.protocolVersion}`);
        }
      }
      negotiatedProtocol = res.protocolVersion;
    }
    await rpc('notifications/initialized', {}, { isNotification: true, allowReinit: false }).catch(() => {});
    connected = true;
    serverInfo = res;
    return res;
  }

  async function listTools() {
    if (!connected) await connect();
    const out = [];
    let cursor = undefined;
    for (let page = 0; page < 20; page++) {
      const res = await rpc('tools/list', cursor ? { cursor } : {});
      if (Array.isArray(res?.tools)) out.push(...res.tools);
      cursor = res?.nextCursor || null;
      if (!cursor) break;
    }
    return out;
  }

  async function callTool(toolName, argsObj = {}, { timeoutMs: callTimeout = timeoutMs, signal = null } = {}) {
    if (!connected) await connect();
    const res = await rpc('tools/call', { name: toolName, arguments: argsObj || {} }, { timeoutMs: callTimeout, signal });
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
    return {
      ok: !res?.isError,
      isError: Boolean(res?.isError),
      text: text || (content.length ? JSON.stringify(content) : JSON.stringify(res ?? {})),
      content,
      raw: res,
    };
  }

  async function close() {
    const sid = sessionId;
    connected = false;
    sessionId = null;
    // Streamable HTTP session termination (best-effort DELETE per MCP spec)
    if (sid) {
      try {
        await fetchImpl(safeUrl, {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': sid, 'Mcp-Protocol-Version': negotiatedProtocol, ...headers },
        });
      } catch { /* ignore best-effort session termination */ }
    }
  }

  return {
    name,
    transport: 'http',
    get connected() { return connected; },
    get sessionId() { return sessionId; },
    get protocolVersion() { return negotiatedProtocol; },
    connect,
    listTools,
    callTool,
    close,
  };
}

// ── Multi-Server MCP Manager (Fault-Isolated + TOFU Lockfile Pinning ON by default) ──
export function createMcpManager({
  cwd = process.cwd(),
  agentDir = null,
  env = process.env,
  vault = null,
  failClosedVault = true,
  isolateConfigErrors = true,
  timeoutMs = 30_000,
  fetchImpl = globalThis.fetch,
  enforceLock = true,
  autoPinLock = true,
  onToolsChanged = null,
} = {}) {
  const configErrors = [];
  const configs = loadMcpConfig({
    cwd,
    agentDir,
    env,
    vault,
    failClosed: failClosedVault,
    isolateErrors: isolateConfigErrors,
    onServerError: (e) => configErrors.push(e),
  });
  const clients = new Map();
  const failedServers = [...configErrors];
  let quarantinedTools = [];
  let quarantinedKeySet = new Set();
  let approvedKeySet = new Set();
  let lockVerifiedOnce = false;

  async function refreshServer(name) {
    const entry = clients.get(name);
    if (!entry) return null;
    const tools = await entry.client.listTools();
    entry.tools = tools;
    // Re-verify lockfile immediately on `tools/list_changed` so mid-session rug-pull deltas are quarantined!
    if (enforceLock) {
      listDiscoveredTools();
    }
    if (typeof onToolsChanged === 'function') {
      try { onToolsChanged({ server: name, count: tools.length, quarantined: quarantinedTools.length }); } catch { /* ignore */ }
    }
    return tools;
  }

  async function connectOne(name, cfg) {
    // R2-P0-2: Verify pinned server `cmdHash` BEFORE spawning any stdio child process or connecting to HTTP endpoint!
    if (enforceLock) {
      const pre = verifyServerConfigAgainstLock(name, cfg, { cwd });
      if (!pre.ok) {
        throw new Error(`${pre.reason}:${name}`);
      }
    }
    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new Error(`mcp_stdio_missing_command:${name}`);
      const client = createMcpStdioClient({
        name,
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        env: cfg.env,
        allowEnv: cfg.allowEnv,
        baseEnv: env,
        timeoutMs,
        onToolsChanged: () => { refreshServer(name).catch(() => {}); },
      });
      await client.connect();
      const tools = await client.listTools();
      clients.set(name, { client, cfg, tools });
      return { server: name, transport: 'stdio', tools: tools.map((t) => t.name) };
    }
    if (cfg.transport === 'http') {
      if (!cfg.url) throw new Error(`mcp_http_missing_url:${name}`);
      const client = createMcpHttpClient({
        name,
        url: cfg.url,
        headers: cfg.headers,
        timeoutMs,
        fetchImpl,
        onToolsChanged: () => { refreshServer(name).catch(() => {}); },
      });
      await client.connect();
      const tools = await client.listTools();
      clients.set(name, { client, cfg, tools });
      return { server: name, transport: 'http', tools: tools.map((t) => t.name) };
    }
    throw new Error(`mcp_unsupported_transport:${name}:${cfg.transport}`);
  }

  async function connectAll() {
    failedServers.length = 0;
    failedServers.push(...configErrors);
    const entries = Object.entries(configs);
    const settled = await Promise.allSettled(entries.map(([name, cfg]) => connectOne(name, cfg)));
    const summary = [];
    for (let i = 0; i < settled.length; i++) {
      const [name] = entries[i];
      const r = settled[i];
      if (r.status === 'fulfilled') {
        summary.push(r.value);
      } else {
        failedServers.push({ server: name, error: String(r.reason?.message || r.reason) });
      }
    }
    return summary;
  }

  function listDiscoveredTools() {
    const raw = [];
    for (const [server, entry] of clients.entries()) {
      for (const t of entry.tools) {
        const meta = entry.cfg.tools?.[t.name] || {};
        raw.push({
          server,
          namespace: `mcp.${server}`,
          cmdHash: entry.cfg.cmdHash,
          name: t.name,
          fullName: `mcp.${server}.${t.name}`,
          description: t.description || `MCP tool ${t.name} from ${server}`,
          shortDescription: meta.short_description || null,
          serverDescription: entry.cfg.description || '',
          parameters: t.inputSchema || { type: 'object', properties: {} },
          risk: meta.risk || null,
          ground: Array.isArray(meta.ground) ? meta.ground : [],
          confirm: meta.confirm || null,
          deferLoading: meta.defer_loading !== undefined ? Boolean(meta.defer_loading) : entry.cfg.deferLoading,
          tags: [...(entry.cfg.tags || []), ...(Array.isArray(meta.tags) ? meta.tags : [])],
          examples: Array.isArray(meta.examples) ? meta.examples : [],
        });
      }
    }
    if (enforceLock) {
      const res = verifyAndPinTools(raw, { cwd, autoPin: autoPinLock });
      quarantinedTools = res.quarantined;
      quarantinedKeySet = new Set(res.quarantined.map((t) => t.fullName));
      approvedKeySet = new Set(res.approved.map((t) => t.fullName));
      lockVerifiedOnce = true;
      return res.approved;
    }
    quarantinedTools = [];
    quarantinedKeySet = new Set();
    approvedKeySet = new Set(raw.map((t) => t.fullName));
    lockVerifiedOnce = true;
    return raw.map((t) => ({
      ...t,
      schemaHash: computeSchemaHash({ name: t.fullName, description: t.description, parameters: t.parameters }),
      descHash: computeDescHash(t.description),
    }));
  }

  async function callTool(server, toolName, argsObj = {}, opts = {}) {
    const entry = clients.get(server);
    if (!entry) throw new Error(`mcp_server_not_connected:${server}`);
    if (enforceLock) {
      const fullName = `mcp.${server}.${toolName}`;
      if (!lockVerifiedOnce) {
        listDiscoveredTools();
      }
      if (quarantinedKeySet.has(fullName) || !approvedKeySet.has(fullName)) {
        throw new Error(`mcp_tool_quarantined:${fullName}`);
      }
    }
    return entry.client.callTool(toolName, argsObj, opts);
  }

  async function closeAll() {
    const closing = [...clients.values()].map((e) => e.client.close().catch(() => {}));
    clients.clear();
    await Promise.all(closing);
  }

  return {
    configs,
    listConfiguredServers: () => Object.keys(configs),
    connectAll,
    refreshServer,
    listDiscoveredTools,
    listQuarantinedTools: () => [...quarantinedTools],
    getFailedServers: () => [...failedServers],
    getQuarantinedTools: () => [...quarantinedTools],
    callTool,
    closeAll,
  };
}
