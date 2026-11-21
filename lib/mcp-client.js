// SCROLL 2.0 -- §47 Zero-dependency MCP (Model Context Protocol) stdio JSON-RPC 2.0 client.
//
// Reads SCROLL `.mcp.json` (workspace and/or agent level), resolves `${vault:KEY}` from env at
// load time (never writes secrets to disk), spawns configured stdio MCP servers, discovers tools
// via `tools/list`, and invokes them via `tools/call` alongside SCROLL §21 risk/ground/confirm metadata.
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

function resolveVaultPlaceholders(val, env = process.env) {
  if (typeof val !== 'string') return val;
  return val.replace(/\$\{vault:([A-Za-z0-9_.-]+)\}/g, (_, key) => String(env[key] ?? ''));
}

export function loadMcpConfig({ cwd = process.cwd(), agentDir = null, env = process.env } = {}) {
  const files = [path.join(cwd, '.mcp.json')];
  if (agentDir) files.push(path.join(agentDir, '.mcp.json'));
  const servers = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const [name, cfg] of Object.entries(parsed.mcpServers || {})) {
      if (!cfg || typeof cfg !== 'object') continue;
      const resolvedEnv = {};
      for (const [k, v] of Object.entries(cfg.env || {})) {
        resolvedEnv[k] = resolveVaultPlaceholders(String(v), env);
      }
      servers[name] = {
        name,
        command: cfg.command || null,
        args: Array.isArray(cfg.args) ? cfg.args.map((a) => resolveVaultPlaceholders(String(a), env)) : [],
        url: cfg.url ? resolveVaultPlaceholders(String(cfg.url), env) : null,
        transport: cfg.transport || (cfg.command ? 'stdio' : (cfg.url ? 'http' : 'stdio')),
        cwd: cfg.cwd ? path.resolve(cwd, cfg.cwd) : cwd,
        env: resolvedEnv,
        tools: cfg.tools && typeof cfg.tools === 'object' ? cfg.tools : {},
      };
    }
  }
  return servers;
}

export function createMcpStdioClient({
  name = 'mcp',
  command,
  args = [],
  cwd = process.cwd(),
  env = {},
  timeoutMs = 30_000,
  clientInfo = { name: 'scroll-mcp-client', version: '2.0.0' },
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

  function request(method, params = {}, { timeoutMs: reqTimeout = timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`mcp_timeout:${name}:${method}:${reqTimeout}ms`));
        }
      }, reqTimeout);
      pending.set(id, { resolve, reject, timer });
      try {
        sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
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
    proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
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
    const res = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo,
    });
    notify('notifications/initialized', {});
    connected = true;
    serverInfo = res;
    return res;
  }

  async function listTools() {
    if (!connected) await connect();
    const res = await request('tools/list', {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async function callTool(toolName, argsObj = {}, { timeoutMs: callTimeout = timeoutMs } = {}) {
    if (!connected) await connect();
    const res = await request('tools/call', { name: toolName, arguments: argsObj || {} }, { timeoutMs: callTimeout });
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
    get connected() { return connected; },
    connect,
    listTools,
    callTool,
    close,
  };
}

export function createMcpManager({ cwd = process.cwd(), agentDir = null, env = process.env, timeoutMs = 30_000 } = {}) {
  const configs = loadMcpConfig({ cwd, agentDir, env });
  const clients = new Map();

  async function connectAll() {
    const summary = [];
    for (const [name, cfg] of Object.entries(configs)) {
      if (cfg.transport !== 'stdio' || !cfg.command) continue;
      const client = createMcpStdioClient({
        name,
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        env: cfg.env,
        timeoutMs,
      });
      await client.connect();
      const tools = await client.listTools();
      clients.set(name, { client, cfg, tools });
      summary.push({ server: name, tools: tools.map((t) => t.name) });
    }
    return summary;
  }

  function listDiscoveredTools() {
    const out = [];
    for (const [server, entry] of clients.entries()) {
      for (const t of entry.tools) {
        const meta = entry.cfg.tools?.[t.name] || {};
        out.push({
          server,
          name: t.name,
          fullName: `mcp.${server}.${t.name}`,
          description: t.description || `MCP tool ${t.name} from ${server}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
          risk: meta.risk || null,
          ground: Array.isArray(meta.ground) ? meta.ground : [],
          confirm: meta.confirm || null,
        });
      }
    }
    return out;
  }

  async function callTool(server, toolName, argsObj = {}) {
    const entry = clients.get(server);
    if (!entry) throw new Error(`mcp_server_not_connected:${server}`);
    return entry.client.callTool(toolName, argsObj);
  }

  async function closeAll() {
    const closing = [...clients.values()].map((e) => e.client.close().catch(() => {}));
    clients.clear();
    await Promise.all(closing);
  }

  return {
    configs,
    connectAll,
    listDiscoveredTools,
    callTool,
    closeAll,
  };
}
