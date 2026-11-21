// SCROLL 2.5 -- §47 Live Multi-Round Tool Executor, Built-in Registry,
// Security Boundary Wall (§20-§22, §28, §42), OS Sandbox, & §47.2 Portable Tool Retriever.
//
// Every tool call -- direct, MCP, or unwrapped from `tool_invoke` -- passes through ONE
// deterministic safety gate:
//   0. Transparent unwrap for `tool_invoke` (anti-recursion, hydrated check, schemaHash pin,
//      host JSON Schema arg validation) so ALL downstream gates inspect the REAL target tool.
//   1. Unified allow-list (`IDENTITY.security.tools_allow` intersected with per-turn `toolsAllow`).
//   2. §42 boundary enforcement (external/mixed-group turns cannot invoke write/exec/admin tools).
//   3. §21 risk tier + floor + policy matrix (`resolveTier` + `policyForTier` + `evaluateAction`).
//   4. §22 provenance-aware action grounding for financial/destructive tiers (`checkGrounding`).
//   5. §21 per-call persistent HITL approval token (`approvalStore` + `userDoc.canApprove`).
//   6. §28 fail-closed post-write effect confirmation (`confirmEffect`, read-only probe only).
//   7. Tamper-evident hash-chained audit trail (`auditChain` + ring buffer).
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import {
  resolveTier,
  policyForTier,
  needsGrounding,
  evaluateAction,
  loadMcpRisk,
  loadAgentSecurity,
  matchesToolAllow,
} from './permissions.js';
import { checkGrounding } from './grounding.js';
import { confirmEffect } from './effects.js';
import { runSandboxedExec } from './sandbox.js';
import {
  buildToolRetriever,
  buildAvailableToolsIndex,
  validateToolArgs,
  computeSchemaHash,
} from './tool-retriever.js';
import { scanText } from './skills.js';

const PRIVATE_IPV4_PATTERNS = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC 6598 CGNAT / Tailscale
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^198\.1[89]\./,
  /^224\./,
  /^240\./,
  /^255\.255\.255\.255$/,
];

const EXTERNAL_SENSITIVE_FILES = new Set([
  'identity.md',
  'soul.md',
  'hard-rules.md',
  'tools.md',
  'lessons.md',
  'user.md',
  'work.md',
  'loop.md',
]);

function hexPairToIpv4(hiHex, loHex) {
  const hi = parseInt(hiHex, 16);
  const lo = parseInt(loHex, 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateIp(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);
  if (!ip) return true;

  // Handle IPv6-mapped IPv4 (`::ffff:127.0.0.1` or normalized hex `::ffff:7f00:1`)
  const v4MappedDot = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4MappedDot) return isPrivateIp(v4MappedDot[1]);
  const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (v4MappedHex) {
    const dotted = hexPairToIpv4(v4MappedHex[1], v4MappedHex[2]);
    return dotted ? isPrivateIp(dotted) : true;
  }

  if (net.isIPv4(ip)) {
    return PRIVATE_IPV4_PATTERNS.some((re) => re.test(ip));
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:0' || ip === '0:0:0:0:0:0:0:1') return true;
    if (/^(?:fc|fd)[0-9a-f]{2}:/.test(ip)) return true; // ULA
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;     // link-local
    if (/^ff[0-9a-f]{2}:/.test(ip)) return true;        // multicast
    return false;
  }
  return false;
}

function hostMatchesEgressAllow(host, egressAllow) {
  if (!Array.isArray(egressAllow)) return true;
  if (!egressAllow.length) return false;
  const h = String(host || '').toLowerCase();
  for (const rule of egressAllow) {
    const r = String(rule || '').trim().toLowerCase();
    if (!r) continue;
    if (r === '*') return true;
    if (r === h) return true;
    if (r.startsWith('*.') && (h === r.slice(2) || h.endsWith(r.slice(1)))) return true;
  }
  return false;
}

export function isSafePublicUrl(rawUrl, { egressAllow = null } = {}) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `disallowed_protocol:${u.protocol}` };
  }
  const host = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `ssrf_blocked_host:${host}` };
  }
  if (host === 'metadata.google.internal' || host === '169.254.169.254') {
    return { ok: false, reason: 'ssrf_blocked_metadata' };
  }
  if (isPrivateIp(host)) {
    return { ok: false, reason: `ssrf_blocked_private_ip:${host}` };
  }
  if (egressAllow !== null && !hostMatchesEgressAllow(host, egressAllow)) {
    return { ok: false, reason: `egress_host_not_allowed:${host}` };
  }
  return { ok: true, url: u.toString(), host };
}

async function resolveAndValidatePublicUrl(rawUrl, {
  egressAllow = null,
  contentAudience = 'internal',
  dnsLookup = null,
} = {}) {
  // Egress axis on external audience: block outbound web_fetch unless egressAllow explicitly permits host
  if (contentAudience === 'external' && (!Array.isArray(egressAllow) || !egressAllow.length)) {
    return { ok: false, reason: 'egress_blocked_on_external_audience' };
  }
  const base = isSafePublicUrl(rawUrl, { egressAllow });
  if (!base.ok) return base;

  // DNS resolution check (blocks DNS rebinding to 127.0.0.1, 10.x, 169.254.x, 100.64.x Tailscale, ::1, ::ffff:...)
  const lookupFn = typeof dnsLookup === 'function'
    ? dnsLookup
    : (h) => dns.promises.lookup(h, { all: true, verbatim: true });

  if (!net.isIP(base.host)) {
    try {
      const records = await lookupFn(base.host);
      const list = Array.isArray(records) ? records : (records ? [records] : []);
      for (const rec of list) {
        const ip = typeof rec === 'string' ? rec : rec?.address;
        if (ip && isPrivateIp(ip)) {
          return { ok: false, reason: `ssrf_dns_resolved_private_ip:${base.host}->${ip}` };
        }
      }
    } catch (err) {
      // If custom dnsLookup explicitly rejects or host fails resolution, fail closed on SSRF
      if (typeof dnsLookup === 'function') {
        return { ok: false, reason: `ssrf_dns_lookup_failed:${base.host}:${err?.message || err}` };
      }
      // On offline unit-test mocks using synthetic fetchImpl without real DNS, only block if DNS returned private IP
    }
  }
  return base;
}

function realpathNativeSafe(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch {
    try { return fs.realpathSync(abs); } catch {
      try {
        const parent = fs.realpathSync.native(path.dirname(abs));
        return path.join(parent, path.basename(abs));
      } catch {
        return abs;
      }
    }
  }
}

function resolveInsideRoot(rootDir, relPath) {
  const root = realpathNativeSafe(rootDir);
  const candidate = path.resolve(root, String(relPath || '.'));
  const target = realpathNativeSafe(candidate);
  const rootCmp = process.platform === 'darwin' || process.platform === 'win32' ? root.toLowerCase() : root;
  const targetCmp = process.platform === 'darwin' || process.platform === 'win32' ? target.toLowerCase() : target;
  if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp + path.sep)) {
    throw new Error(`path_traversal_denied:${relPath}`);
  }
  return { root, target, rel: path.relative(root, target) || '.' };
}

function assertFileReadable({ root, target, rel, userDoc, memoryStore, turnClassification }) {
  // Block hidden dotfiles / directories (`.env`, `.scroll/**`, `.mcp.json`, `.git/**`)
  if (rel !== '.') {
    const segments = rel.split(path.sep).filter(Boolean);
    for (const seg of segments) {
      if (seg.startsWith('.')) {
        throw new Error(`sensitive_dotfile_denied:${rel}`);
      }
    }
  }
  // Block USER.md (symlink & case-insensitive protected)
  if (userDoc && typeof userDoc.guard === 'function') {
    const g = userDoc.guard(target);
    if (!g.allowed) throw new Error(g.reason || 'user_md_denied');
  }
  const baseLower = path.basename(target).toLowerCase();
  if (baseLower === 'user.md' && path.dirname(target).toLowerCase() === root.toLowerCase()) {
    throw new Error('user_md_denied');
  }
  if (memoryStore && typeof memoryStore.assertToolPathAllowed === 'function') {
    const chk = memoryStore.assertToolPathAllowed(target);
    if (!chk.allowed) throw new Error(chk.reason);
  }
  // External/mixed-group turns cannot read agent prompt files (`SOUL.md`, `IDENTITY.md`, `hard-rules.md`, etc.)
  if (turnClassification?.contentAudience === 'external' && EXTERNAL_SENSITIVE_FILES.has(baseLower)) {
    throw new Error(`external_audience_file_denied:${baseLower}`);
  }
}

function readBoundedFile(absPath, maxBytes) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`not_a_file:${path.basename(absPath)}`);
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const n = fs.readSync(fd, buf, offset, toRead - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return {
      bytes: stat.size,
      truncated: stat.size > toRead,
      content: buf.subarray(0, offset).toString('utf8'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

const DEFAULT_BUILTIN_RISK = {
  read_file: 'read_only',
  list_dir: 'read_only',
  web_search: 'read_only',
  web_fetch: 'read_only',
  memory_search: 'read_only',
  knowledge_search: 'read_only',
  skill_list: 'read_only',
  skill_view: 'read_only',
  tool_search: 'read_only',
  memory_remember: 'reversible_write',
  memory_forget: 'destructive',
  automations: 'reversible_write',
  spawn_worker: 'reversible_write',
  exec: 'destructive',
};

const CORE_ALWAYS_LOAD_DEFAULTS = [
  'read_file',
  'list_dir',
  'knowledge_search',
  'memory_search',
  'skill_list',
  'skill_view',
];

export function createToolRegistry({
  cwd = process.cwd(),
  agentDir = null,
  userDoc = null,
  memoryStore = null,
  knowledgeIndex = null,
  skills = null,
  scheduler = null,
  workerPool = null,
  mcpManager = null,
  approvalStore = null,
  auditChain = null,
  requestApproval = null,
  webSearchFn = null,
  fetchImpl = globalThis.fetch,
  dnsLookup = null,
  enableExec = null, // null = auto (disabled if strictExec or agentDir disallows; enabled if bare registry or explicitly true)
  strictExec = false,
  allowedExecBinaries = null,
  execRunner = null,
  execSandbox = 'os',
  requireSandbox = true,
  egressAllow = null,
  toolsAllow = null,
  toolsRetrieval = null,
  riskDefaults = null,
  approvalOverrides = null,
  onAudit = null,
  embedFn = null,
} = {}) {
  const tools = new Map();
  const shortAliasMap = new Map(); // optional non-colliding short name -> canonical mcp.<server>.<tool>
  const quarantinedMcp = new Map();
  const auditLog = [];

  const sec = agentDir ? loadAgentSecurity(agentDir) : {
    riskDefaults: {},
    approvalOverrides: {},
    toolsAllow: null,
    egressAllow: null,
    execAllow: null,
    capabilities: null,
    budget: null,
    toolsRetrieval: null,
  };
  const mcpRisk = loadMcpRisk(cwd, agentDir);
  const mergedRiskDefaults = {
    ...DEFAULT_BUILTIN_RISK,
    ...(sec.riskDefaults || {}),
    ...(riskDefaults || {}),
  };
  const mergedApprovalOverrides = {
    ...(sec.approvalOverrides || {}),
    ...(approvalOverrides || {}),
  };
  const effectiveIdentityToolsAllow = toolsAllow !== null ? toolsAllow : sec.toolsAllow;
  const effectiveEgressAllow = egressAllow !== null ? egressAllow : sec.egressAllow;
  const effectiveExecAllow = allowedExecBinaries !== null ? allowedExecBinaries : sec.execAllow;
  const retrievalCfg = {
    mode: 'auto', // auto | portable | off
    deferThreshold: 15,
    maxSchemaBytes: 8192,
    maxIndexTokens: 1500,
    maxSearchResults: 5,
    requireSearchBeforeInvoke: true,
    alwaysLoad: CORE_ALWAYS_LOAD_DEFAULTS,
    ...(sec.toolsRetrieval || {}),
    ...(toolsRetrieval || {}),
  };

  let retrieverCache = null;
  let registryVersion = 0;

  function invalidateRetriever() {
    retrieverCache = null;
    registryVersion++;
  }

  function recordAudit(entry) {
    const full = { ts: new Date().toISOString(), ...entry };
    auditLog.push(full);
    if (auditLog.length > 500) auditLog.shift();
    if (auditChain && typeof auditChain.append === 'function') {
      try { auditChain.append(entry); } catch { /* isolate disk error */ }
    }
    if (typeof onAudit === 'function') {
      try { onAudit(full); } catch { /* ignore */ }
    }
    return full;
  }

  function register(def) {
    if (!def || !def.name || typeof def.execute !== 'function') {
      throw new Error('tool register: name and execute(args, ctx) are required');
    }
    const name = String(def.name);
    const params = def.parameters || { type: 'object', properties: {} };
    const description = String(def.description || '');
    tools.set(name, {
      name,
      description,
      shortDescription: def.shortDescription || null,
      namespace: def.namespace || (def.server ? `mcp.${def.server}` : 'builtin'),
      server: def.server || null,
      serverDescription: def.serverDescription || '',
      parameters: params,
      risk: def.risk || null,
      ground: Array.isArray(def.ground) ? def.ground : [],
      confirm: def.confirm || null,
      deferLoading: def.deferLoading !== undefined ? def.deferLoading : null,
      tags: Array.isArray(def.tags) ? def.tags : [],
      examples: Array.isArray(def.examples) ? def.examples : [],
      schemaHash: def.schemaHash || computeSchemaHash({ name, description, parameters: params }),
      trustedOutput: def.trustedOutput !== undefined ? Boolean(def.trustedOutput) : (name !== 'web_fetch' && name !== 'web_search'),
      execute: def.execute,
    });
    invalidateRetriever();
  }

  function unregister(name) {
    const ok = tools.delete(name);
    if (ok) invalidateRetriever();
    return ok;
  }

  // ── Built-in tools ──
  register({
    name: 'read_file',
    description: 'Read a UTF-8 file inside the workspace directory.',
    risk: 'read_only',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside workspace' },
        maxBytes: { type: 'number', description: 'Max bytes to return (default 16000)' },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      const resolved = resolveInsideRoot(cwd, args.path);
      assertFileReadable({ ...resolved, userDoc: ctx?.userDoc || userDoc, memoryStore, turnClassification: ctx?.turnClassification });
      const cap = Math.min(64_000, Math.max(256, Number(args.maxBytes || 16_000)));
      const data = readBoundedFile(resolved.target, cap);
      return {
        path: resolved.rel,
        bytes: data.bytes,
        truncated: data.truncated,
        content: data.content,
      };
    },
  });

  register({
    name: 'list_dir',
    description: 'List entries in a directory inside the workspace.',
    risk: 'read_only',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory path (default .)' } },
    },
    async execute(args, ctx) {
      const resolved = resolveInsideRoot(cwd, args.path || '.');
      assertFileReadable({ ...resolved, userDoc: ctx?.userDoc || userDoc, memoryStore, turnClassification: ctx?.turnClassification });
      const isExt = ctx?.turnClassification?.contentAudience === 'external';
      const entries = fs.readdirSync(resolved.target, { withFileTypes: true })
        .filter((e) => {
          if (e.name.startsWith('.')) return false;
          const low = e.name.toLowerCase();
          if (low === 'user.md' && resolved.rel === '.') return false;
          if (isExt && EXTERNAL_SENSITIVE_FILES.has(low)) return false;
          return true;
        })
        .slice(0, 200)
        .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
      return { path: resolved.rel, entries };
    },
  });

  register({
    name: 'web_fetch',
    description: 'Fetch a public HTTP/HTTPS URL (enforces DNS/IPv6/CGNAT SSRF guard, manual redirect checks, and egress_allow).',
    risk: 'read_only',
    trustedOutput: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'number' },
      },
      required: ['url'],
    },
    async execute(args, ctx) {
      const audience = ctx?.turnClassification?.contentAudience || 'internal';
      let currentUrl = String(args.url || '');
      let res = null;
      for (let hop = 0; hop < 6; hop++) {
        const check = await resolveAndValidatePublicUrl(currentUrl, {
          egressAllow: effectiveEgressAllow,
          contentAudience: audience,
          dnsLookup,
        });
        if (!check.ok) throw new Error(check.reason);
        res = await fetchImpl(check.url, { method: 'GET', redirect: 'manual', signal: ctx?.signal || undefined });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
          if (!loc) break;
          currentUrl = new URL(loc, check.url).toString();
          continue;
        }
        break;
      }
      if (!res) throw new Error('web_fetch_no_response');
      if (res.status >= 300 && res.status < 400) throw new Error('web_fetch_too_many_redirects');
      const finalCheck = await resolveAndValidatePublicUrl(res.url || currentUrl, {
        egressAllow: effectiveEgressAllow,
        contentAudience: audience,
        dnsLookup,
      });
      if (!finalCheck.ok) throw new Error(`redirect_${finalCheck.reason}`);
      const text = await res.text();
      const cap = Math.min(24_000, Math.max(500, Number(args.maxChars || 8000)));
      return { url: finalCheck.url, status: res.status, truncated: text.length > cap, body: text.slice(0, cap), untrustedExternal: true };
    },
  });

  register({
    name: 'web_search',
    description: 'Search the web using a configured search provider.',
    risk: 'read_only',
    trustedOutput: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async execute(args) {
      if (typeof webSearchFn === 'function') {
        return webSearchFn(String(args.query || ''), { limit: Number(args.limit || 5) });
      }
      const braveKey = process.env.BRAVE_API_KEY;
      if (!braveKey) throw new Error('web_search_not_configured: provide webSearchFn or BRAVE_API_KEY');
      const limit = Math.min(10, Math.max(1, Number(args.limit || 5)));
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(String(args.query || ''))}&count=${limit}`;
      const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey } });
      if (!res.ok) throw new Error(`web_search_failed:${res.status}`);
      const json = await res.json();
      const results = (json.web?.results || []).slice(0, limit).map((r) => ({
        title: r.title, url: r.url, snippet: r.description || '',
      }));
      return { query: args.query, results, untrustedExternal: true };
    },
  });

  if (knowledgeIndex) {
    register({
      name: 'knowledge_search',
      description: 'Search the indexed deployment knowledge base (SOPs, manuals, tariffs, FAQs).',
      risk: 'read_only',
      trustedOutput: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          topK: { type: 'number' },
        },
        required: ['query'],
      },
      async execute(args) {
        const res = knowledgeIndex.retrieve(String(args.query || ''), { topK: Number(args.topK || 4) });
        return {
          query: res.query,
          hits: res.hits.map((h) => ({ file: h.file, heading: h.heading, score: h.score, text: h.text })),
        };
      },
    });
  }

  function registerSkills(skillsReg) {
    if (!skillsReg || typeof skillsReg.tools !== 'function') return [];
    const raw = skillsReg.tools();
    const list = Array.isArray(raw)
      ? raw
      : Object.entries(raw || {}).map(([k, v]) => ({ name: v?.name || k, ...v }));
    const registered = [];
    for (const item of list) {
      if (!item || !item.name || typeof item.run !== 'function') continue;
      register({
        name: String(item.name),
        description: String(item.description || ''),
        risk: 'read_only',
        trustedOutput: true,
        parameters: item.parameters || { type: 'object', properties: {} },
        async execute(args) {
          return item.run(args || {});
        },
      });
      registered.push(String(item.name));
    }
    return registered;
  }

  if (skills) {
    registerSkills(skills);
  }

  if (memoryStore) {
    register({
      name: 'memory_search',
      description: 'Search subject memory for facts, sessions, cards, or day notes.',
      risk: 'read_only',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: { type: 'string', enum: ['all', 'facts', 'sessions', 'cards', 'days'] },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      async execute(args, ctx) {
        const sid = ctx.subjectSid;
        if (!sid) return { hits: [], note: 'no_subject_bound' };
        return memoryStore.search(sid, {
          query: String(args.query || ''),
          scope: args.scope || 'all',
          limit: Number(args.limit || 6),
          session: ctx.memorySessionId || null,
        });
      },
    });

    register({
      name: 'memory_remember',
      description: 'Propose a grounded fact into subject memory with a verbatim quote from the current turn.',
      risk: 'reversible_write',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['key', 'value', 'quote'],
      },
      async execute(args, ctx) {
        if (!ctx.subjectSid || !ctx.turnRef) return { ok: false, reason: 'no_turn_reference' };
        return memoryStore.remember(ctx.subjectSid, {
          key: args.key,
          value: args.value,
          quote: args.quote,
          ref: ctx.turnRef,
        });
      },
    });

    register({
      name: 'memory_forget',
      description: 'Permanently forget and redact fact IDs from subject memory.',
      risk: 'destructive',
      ground: ['ids'],
      confirm: { mode: 'none', reason: 'tombstone_atomic_journal_verified' },
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
        required: ['ids'],
      },
      async execute(args, ctx) {
        if (!ctx.subjectSid) return { ok: false, reason: 'no_subject_bound' };
        return memoryStore.forget(ctx.subjectSid, args.ids, { reason: args.reason || 'user_request' });
      },
    });
  }

  if (scheduler) {
    register({
      name: 'automations',
      description: 'List, create, toggle, update, or delete timezone-aware scheduled cron jobs and reminders.',
      risk: 'reversible_write',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'toggle', 'delete'] },
          jobId: { type: 'string' },
          name: { type: 'string' },
          cron: { type: 'string' },
          everyMs: { type: 'number' },
          at: { type: 'string' },
          tz: { type: 'string' },
          targetChatId: { type: 'string' },
          prompt: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['action'],
      },
      async execute(args, ctx) {
        const actor = {
          id: ctx.turnClassification?.speakerId || ctx.sender?.id || null,
          roles: ctx.turnClassification?.speakerRoles || [],
          isInternal: ctx.turnClassification?.speakerTrust === 'internal',
          isDm: !ctx.turnClassification?.isGroup,
        };
        if (args.action === 'list') {
          return { jobs: scheduler.listJobs({ chatId: args.targetChatId || null }) };
        }
        if (args.action === 'create') {
          if (!actor.isInternal) return { ok: false, reason: 'owner_or_internal_required' };
          const job = scheduler.addJob({
            id: args.jobId || undefined,
            name: args.name || 'Scheduled task',
            cron: args.cron || null,
            everyMs: args.everyMs || null,
            at: args.at || null,
            tz: args.tz || undefined,
            targetChatId: args.targetChatId || ctx.chatId || null,
            prompt: args.prompt || '',
            enabled: args.enabled !== false,
            ownerId: actor.id,
          });
          return { ok: true, job };
        }
        const existing = scheduler.getJob(args.jobId);
        if (!existing) return { ok: false, reason: 'job_not_found' };
        if (!scheduler.canManageJob(actor, existing)) {
          return { ok: false, reason: 'forbidden_manage_job' };
        }
        if (args.action === 'delete') return scheduler.removeJob(args.jobId);
        if (args.action === 'toggle') return { ok: true, job: scheduler.updateJob(args.jobId, { enabled: args.enabled !== undefined ? Boolean(args.enabled) : !existing.enabled }) };
        return {
          ok: true,
          job: scheduler.updateJob(args.jobId, {
            ...(args.name != null ? { name: args.name } : {}),
            ...(args.cron != null ? { cron: args.cron } : {}),
            ...(args.tz != null ? { tz: args.tz } : {}),
            ...(args.prompt != null ? { prompt: args.prompt } : {}),
            ...(args.enabled != null ? { enabled: Boolean(args.enabled) } : {}),
          }),
        };
      },
    });
  }

  if (workerPool) {
    register({
      name: 'spawn_worker',
      description: 'Launch an asynchronous background subagent worker without blocking the chat turn.',
      risk: 'reversible_write',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          task: { type: 'string' },
        },
        required: ['task'],
      },
      async execute(args, ctx) {
        if (typeof ctx.spawnWorkerFn !== 'function') {
          return { ok: false, reason: 'worker_runner_not_configured' };
        }
        const job = workerPool.submit({
          label: args.label || 'background-worker',
          chatId: ctx.chatId || null,
          fn: ({ signal, jobId }) => ctx.spawnWorkerFn(String(args.task || ''), { ...ctx, signal, jobId }),
        });
        return { ok: true, jobId: job.id, status: job.status };
      },
    });
  }

  const execEnabled = enableExec !== null
    ? Boolean(enableExec)
    : (!strictExec);

  if (execEnabled) {
    register({
      name: 'exec',
      description: 'Execute a single binary inside the OS sandbox (destructive tier; requires approval & sanitized env).',
      risk: 'destructive',
      ground: ['command'],
      confirm: { mode: 'none', reason: 'process_exit_verified' },
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'number' },
        },
        required: ['command'],
      },
      async execute(args, ctx) {
        const bin = String(args.command || '').trim();
        if (!bin) throw new Error('exec: command is required');
        if (strictExec && (!Array.isArray(effectiveExecAllow) || !effectiveExecAllow.length)) {
          throw new Error('exec_disabled_strict_allowlist_required');
        }
        if (Array.isArray(effectiveExecAllow) && !effectiveExecAllow.includes(bin)) {
          throw new Error(`exec_binary_not_allowed:${bin}`);
        }
        const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const res = await runSandboxedExec({
          command: bin,
          args: cmdArgs,
          cwd,
          timeoutMs: Math.min(60_000, Number(args.timeoutMs || 15_000)),
          sandbox: execSandbox,
          requireSandbox,
          allowNetwork: false,
          execRunner,
          signal: ctx?.signal || null,
        });
        return {
          stdout: String(res.stdout || '').slice(0, 12_000),
          stderr: String(res.stderr || '').slice(0, 4000),
          sandbox: res.sandbox || execSandbox,
        };
      },
    });
  }

  function resolveToolEntry(name) {
    const direct = tools.get(name);
    if (direct) return { name, def: direct };
    const canonical = shortAliasMap.get(name);
    if (canonical && tools.has(canonical)) return { name: canonical, def: tools.get(canonical) };
    return null;
  }

  function resolveEffectiveTier(name, def) {
    // Only inject `def.risk` into mcpTools when explicitly declared on the tool; leave null for MCP tools
    // without per-tool risk so `IDENTITY.security.risk_defaults['mcp.*']` globs work cleanly!
    const effectiveMcp = {
      ...mcpRisk,
      ...(def?.risk ? { [name]: { risk: def.risk, ground: def.ground || [], confirm: def.confirm || null } } : {}),
    };
    return resolveTier(name, { mcpTools: effectiveMcp, riskDefaults: mergedRiskDefaults });
  }

  function isToolAllowedByPolicy(name, turnToolsAllow = null) {
    if (name === 'tool_search' || name === 'tool_invoke') return true;
    if (!matchesToolAllow(name, effectiveIdentityToolsAllow)) return false;
    if (turnToolsAllow != null && !matchesToolAllow(name, turnToolsAllow)) return false;
    return true;
  }

  function syncMcpTools() {
    if (!mcpManager) return [];
    const discovered = mcpManager.listDiscoveredTools();
    const added = [];
    const bareCounts = new Map();
    for (const t of discovered) {
      bareCounts.set(t.name, (bareCounts.get(t.name) || 0) + 1);
    }
    for (const t of discovered) {
      const fullName = t.fullName || `mcp.${t.server}.${t.name}`;
      // Scan MCP description & parameter text for prompt-injection / hidden Unicode (`ASI01`)
      const descText = `${t.description || ''} ${JSON.stringify(t.parameters || {})}`;
      const findings = scanText(descText, fullName);
      const severe = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
      if (severe.length) {
        quarantinedMcp.set(fullName, { reason: 'mcp_description_injection_blocked', findings: severe });
        recordAudit({ tool: fullName, decision: 'quarantine', reason: 'mcp_description_injection_blocked', findings: severe.map((f) => f.id) });
        continue;
      }

      // Canonical registration under `mcp.<server>.<tool>` so `mcp.*` and `mcp.<server>.*` globs work!
      register({
        name: fullName,
        namespace: t.namespace || `mcp.${t.server}`,
        server: t.server,
        serverDescription: t.serverDescription || '',
        description: t.description,
        shortDescription: t.shortDescription || null,
        parameters: t.parameters,
        risk: t.risk || null, // null lets IDENTITY `mcp.*` risk_defaults resolve before falling back to `destructive`!
        ground: t.ground,
        confirm: t.confirm,
        deferLoading: t.deferLoading,
        tags: t.tags,
        examples: t.examples,
        schemaHash: t.schemaHash,
        trustedOutput: false,
        async execute(args, ctx) {
          return mcpManager.callTool(t.server, t.name, args, { signal: ctx?.signal || null });
        },
      });
      if (!tools.has(t.name) && bareCounts.get(t.name) === 1) {
        shortAliasMap.set(t.name, fullName);
      }
      added.push(fullName);
    }
    return added;
  }

  function buildCatalog({ turnToolsAllow = null } = {}) {
    const out = [];
    for (const def of tools.values()) {
      if (def.name === 'tool_search' || def.name === 'tool_invoke') continue;
      if (!isToolAllowedByPolicy(def.name, turnToolsAllow)) continue;
      const { tier } = resolveEffectiveTier(def.name, def);
      out.push({
        name: def.name,
        namespace: def.namespace,
        serverDescription: def.serverDescription,
        description: def.description,
        shortDescription: def.shortDescription,
        parameters: def.parameters,
        tags: def.tags,
        examples: def.examples,
        ground: def.ground,
        deferLoading: def.deferLoading,
        schemaHash: def.schemaHash,
        tier,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function getRetriever(catalog) {
    if (!retrieverCache || retrieverCache.version !== registryVersion) {
      retrieverCache = {
        version: registryVersion,
        engine: buildToolRetriever(catalog, { embedFn }),
      };
    }
    return retrieverCache.engine;
  }

  // Filter whether a tool is callable for the current turn's speaker posture
  function isVisibleForTurn(entry, { allowWriteTools = true, delegatedTools = null, turnToolsAllow = null } = {}) {
    if (!isToolAllowedByPolicy(entry.name, turnToolsAllow)) return false;
    if (allowWriteTools) return true;
    if (entry.tier === 'read_only') return true;
    const delegatedSet = Array.isArray(delegatedTools) && delegatedTools.length ? new Set(delegatedTools.map(String)) : null;
    return Boolean(delegatedSet && delegatedSet.has(entry.name));
  }

  function searchTools({
    query = '',
    queries = null,
    namespace = null,
    risk = 'all',
    limit = retrievalCfg.maxSearchResults || 5,
    allowWriteTools = true,
    delegatedTools = null,
    turnToolsAllow = null,
    includeForbiddenHints = false,
  } = {}) {
    const catalog = buildCatalog({ turnToolsAllow });
    const engine = getRetriever(catalog);
    const res = engine.search({
      query,
      queries,
      namespace,
      risk,
      limit,
      filterFn: includeForbiddenHints
        ? (entry) => isToolAllowedByPolicy(entry.name, turnToolsAllow)
        : (entry) => isVisibleForTurn(entry, { allowWriteTools, delegatedTools, turnToolsAllow }),
    });
    return {
      trust: 'third_party',
      queries: res.queries,
      totalMatches: res.totalMatches,
      availableNamespaces: res.availableNamespaces,
      tools: res.hits.map((h) => ({
        name: h.name,
        namespace: h.namespace,
        risk: h.tier,
        policy: policyForTier(h.tier, mergedApprovalOverrides),
        ground: h.ground || [],
        schemaHash: h.schemaHash,
        callable_by_current_speaker: isVisibleForTurn(h, { allowWriteTools, delegatedTools, turnToolsAllow }),
        description: h.description,
        parameters: h.parameters,
        ...(h.examples?.length ? { examples: h.examples } : {}),
      })),
    };
  }

  // Register meta-tools lazily when Portable Retrieval is active
  function ensureMetaToolsRegistered() {
    if (!tools.has('tool_search')) {
      register({
        name: 'tool_search',
        description: 'Search deferred tools by keyword or batch queries to inspect exact JSON parameter schemas before calling tool_invoke.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Single search query' },
            queries: { type: 'array', items: { type: 'string' }, description: 'Batch queries for multi-system tasks in 1 round-trip' },
            namespace: { type: 'string', description: 'Optional namespace filter (e.g. mcp.github, builtin)' },
            risk: { type: 'string', enum: ['all', 'read_only', 'write'] },
            limit: { type: 'number' },
          },
        },
        async execute(args, ctx) {
          const allowWrite = ctx?.turnClassification ? Boolean(ctx.turnClassification.writeToolsAllowed) : true;
          const result = searchTools({
            query: args.query || '',
            queries: Array.isArray(args.queries) ? args.queries : null,
            namespace: args.namespace || null,
            risk: args.risk || 'all',
            limit: Number(args.limit || retrievalCfg.maxSearchResults || 5),
            allowWriteTools: allowWrite,
            delegatedTools: ctx?.delegatedTools || null,
            turnToolsAllow: ctx?.toolsAllow || null,
          });
          if (ctx?.hydratedTools && typeof ctx.hydratedTools.set === 'function') {
            for (const item of result.tools) {
              ctx.hydratedTools.set(item.name, item.schemaHash);
            }
          }
          return result;
        },
      });
    }
    if (!tools.has('tool_invoke')) {
      // NOTE: `tool_invoke` is transparently unwrapped inside `executeTool()` BEFORE any security gate!
      register({
        name: 'tool_invoke',
        description: 'Invoke a deferred tool discovered via tool_search by exact name and JSON arguments.',
        risk: 'destructive', // never relies on this tier; unwrap enforces the real target tool's tier/policy/gates!
        confirm: { mode: 'none', reason: 'unwrapped_to_target_tool_gate' },
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact canonical tool name returned by tool_search' },
            arguments: { type: 'object', description: 'JSON object matching the tool parameter schema' },
          },
          required: ['name', 'arguments'],
        },
        async execute() {
          throw new Error('tool_invoke_must_be_unwrapped_by_executeTool');
        },
      });
    }
  }

  // Legacy/simple flat list (still sorted deterministically by name, honors IDENTITY.security.tools_allow!)
  function listSchemas({ allowWriteTools = true, delegatedTools = null, turnToolsAllow = null } = {}) {
    const catalog = buildCatalog({ turnToolsAllow });
    return catalog
      .filter((entry) => isVisibleForTurn(entry, { allowWriteTools, delegatedTools, turnToolsAllow }))
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
        tier: entry.tier,
        schemaHash: entry.schemaHash,
      }));
  }

  // §47.2 Prompt Surface Builder (3-Set C / V / E + Room-Sticky Cache Invariance!)
  //   - When `roomSticky: true` (group rooms), Region A schemas & `<available_tools>` are built from
  //     deployment Catalog C (speaker-independent) so alternating Owner/Teammate turns NEVER flip `prefixHash`!
  //   - Enforcement happens strictly at `tool_search` (Visible V) and `executeTool` (Executable E).
  function getPromptSurface({
    allowWriteTools = true,
    delegatedTools = null,
    turnToolsAllow = null,
    roomSticky = false,
    mode = retrievalCfg.mode,
  } = {}) {
    const catalogC = buildCatalog({ turnToolsAllow: roomSticky ? null : turnToolsAllow });
    const surfaceList = roomSticky
      ? catalogC
      : catalogC.filter((entry) => isVisibleForTurn(entry, { allowWriteTools, delegatedTools, turnToolsAllow }));

    const schemaBytes = surfaceList.reduce(
      (sum, t) => sum + Buffer.byteLength(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }), 'utf8'),
      0
    );

    const shouldDefer = mode === 'portable' || (
      mode !== 'off' && (
        surfaceList.length > Number(retrievalCfg.deferThreshold || 15)
        || schemaBytes >= Number(retrievalCfg.maxSchemaBytes || 8192)
      )
    );

    if (!shouldDefer) {
      return {
        mode: 'direct',
        activeSchemas: surfaceList.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          tier: t.tier,
          schemaHash: t.schemaHash,
        })),
        availableToolsIndex: { text: '', hash: 'direct', deferredCount: 0, estimatedTokens: 0, tier: 'none' },
        deferredNames: new Set(),
      };
    }

    ensureMetaToolsRegistered();
    const alwaysSet = new Set(Array.isArray(retrievalCfg.alwaysLoad) ? retrievalCfg.alwaysLoad.map(String) : CORE_ALWAYS_LOAD_DEFAULTS);
    const active = [];
    const deferred = [];
    const nsDescs = {};

    for (const t of surfaceList) {
      if (t.serverDescription && t.namespace) nsDescs[t.namespace] = t.serverDescription;
      const isAlways = t.deferLoading === false || (t.deferLoading !== true && alwaysSet.has(t.name));
      if (isAlways && active.length < 10) {
        active.push({ name: t.name, description: t.description, parameters: t.parameters, tier: t.tier, schemaHash: t.schemaHash });
      } else {
        deferred.push(t);
      }
    }

    for (const metaName of ['tool_search', 'tool_invoke']) {
      const def = tools.get(metaName);
      if (def) {
        active.push({ name: def.name, description: def.description, parameters: def.parameters, tier: def.risk || 'read_only', schemaHash: def.schemaHash });
      }
    }
    active.sort((a, b) => a.name.localeCompare(b.name));

    const availableToolsIndex = buildAvailableToolsIndex(deferred, {
      maxIndexTokens: retrievalCfg.maxIndexTokens || 1500,
      namespaceDescriptions: nsDescs,
    });
    return {
      mode: 'portable',
      activeSchemas: active,
      availableToolsIndex,
      deferredNames: new Set(deferred.map((d) => d.name)),
    };
  }

  async function executeTool(rawName, args = {}, ctx = {}) {
    // ── Stage 0: Transparent Unwrap for `tool_invoke` BEFORE EVERY GATE! ──
    if (rawName === 'tool_invoke') {
      const targetNameRaw = String(args?.name || '').trim();
      const targetArgs = args?.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? args.arguments
        : {};
      if (!targetNameRaw) {
        const res = { ok: false, decision: 'deny', reason: 'tool_invoke_missing_target_name' };
        recordAudit({ tool: 'tool_invoke', decision: 'deny', reason: res.reason });
        return res;
      }
      if (targetNameRaw === 'tool_invoke' || targetNameRaw === 'tool_search') {
        const res = { ok: false, decision: 'deny', reason: 'recursive_meta_tool_denied' };
        recordAudit({ tool: targetNameRaw, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.reason });
        return res;
      }
      const resolvedTarget = resolveToolEntry(targetNameRaw);
      if (!resolvedTarget) {
        const res = { ok: false, decision: 'deny', error: `unknown_tool:${targetNameRaw}` };
        recordAudit({ tool: targetNameRaw, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.error });
        return res;
      }
      const { name: targetName, def: targetDef } = resolvedTarget;

      // Require search-before-invoke for deferred tools when enabled & hydratedTools Map is tracked
      if (retrievalCfg.requireSearchBeforeInvoke && ctx?.hydratedTools instanceof Map && ctx?.deferredNames instanceof Set && ctx.deferredNames.has(targetName)) {
        const pinnedHash = ctx.hydratedTools.get(targetName);
        if (!pinnedHash) {
          const res = {
            ok: false,
            decision: 'deny',
            reason: 'deferred_tool_not_searched_yet: call tool_search first',
            targetTool: targetName,
          };
          recordAudit({ tool: targetName, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.reason });
          return res;
        }
        if (pinnedHash !== targetDef.schemaHash) {
          const res = {
            ok: false,
            decision: 'deny',
            reason: 'mcp_schema_hash_changed_mid_session_asi04',
            targetTool: targetName,
          };
          recordAudit({ tool: targetName, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.reason });
          return res;
        }
      }

      // Host JSON Schema argument validation (compensates for provider not constraining `arguments: object`)
      const schemaCheck = validateToolArgs(targetArgs, targetDef.parameters);
      if (!schemaCheck.ok) {
        const res = {
          ok: false,
          decision: 'deny',
          reason: 'invalid_tool_arguments',
          validationErrors: schemaCheck.errors,
          expectedParameters: targetDef.parameters,
        };
        recordAudit({ tool: targetName, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.reason, validationErrors: schemaCheck.errors });
        return res;
      }

      // Delegate straight into the SINGLE unified gate under the REAL target tool name!
      return executeTool(targetName, targetArgs, { ...ctx, viaMetaTool: 'tool_invoke' });
    }

    const resolved = resolveToolEntry(rawName);
    if (!resolved) {
      const res = { ok: false, decision: 'deny', error: `unknown_tool:${rawName}` };
      recordAudit({ tool: rawName, viaMetaTool: ctx.viaMetaTool || null, decision: 'deny', reason: res.error });
      return res;
    }
    const { name, def } = resolved;

    // ── Stage 1: Unified Allow-List (`IDENTITY.security.tools_allow` ∩ per-turn `toolsAllow`) ──
    if (!isToolAllowedByPolicy(name, ctx.toolsAllow || null)) {
      const res = { ok: false, decision: 'deny', reason: `tool_not_in_allowlist:${name}` };
      recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, decision: 'deny', reason: res.reason });
      return res;
    }

    const { tier, via } = resolveEffectiveTier(name, def);
    const policy = policyForTier(tier, mergedApprovalOverrides);

    // ── Stage 2: §42 Boundary Wall (external / mixed-group turns strictly read_only unless delegated) ──
    const delegatedSet = Array.isArray(ctx.delegatedTools) ? new Set(ctx.delegatedTools.map(String)) : null;
    if (ctx.turnClassification && !ctx.turnClassification.writeToolsAllowed && tier !== 'read_only' && !(delegatedSet && delegatedSet.has(name))) {
      const res = { ok: false, decision: 'deny', tier, policy, reason: 'boundary_wall_write_tools_blocked' };
      recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, decision: 'deny', reason: res.reason });
      return res;
    }

    // ── Stage 3: §28 Fail-Closed Confirm Spec Check BEFORE running high-risk actions ──
    const isHighRisk = tier === 'financial' || tier === 'destructive';
    if (isHighRisk) {
      const hasValidConfirm = Boolean(
        def.confirm && (
          (def.confirm.probe && def.confirm.expect)
          || (def.confirm.mode === 'none' && typeof def.confirm.reason === 'string' && def.confirm.reason.trim().length > 0)
        )
      );
      if (!hasValidConfirm) {
        const res = { ok: false, decision: 'deny', tier, policy, reason: 'confirm_spec_required_for_high_risk_tool' };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
    }

    // ── Stage 4: §22 Provenance-Aware Grounding Pre-Check ──
    const groundingRequired = needsGrounding(tier);
    let grounded = null;
    let groundingMissing = [];
    if (groundingRequired) {
      const mcpEntry = mcpRisk[name];
      const groundKeys = (mcpEntry?.ground && mcpEntry.ground.length)
        ? mcpEntry.ground
        : (def.ground || []);
      if (groundKeys.length) {
        const subset = {};
        const missingArgs = [];
        for (const k of groundKeys) {
          if (args && args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== '') {
            subset[k] = args[k];
          } else {
            missingArgs.push(k);
          }
        }
        if (missingArgs.length) {
          grounded = false;
          groundingMissing = missingArgs;
        } else {
          // Provenance-safe grounding: prefer `trustedGroundingSources` (excludes untrusted web_fetch/external pages!)
          const sourceText = ctx.trustedGroundingSources !== undefined
            ? ctx.trustedGroundingSources
            : (ctx.groundingSources || '');
          const g = checkGrounding(subset, sourceText);
          grounded = g.ok;
          groundingMissing = g.missing;
        }
      } else {
        grounded = true;
      }
    }

    // ── Stage 5: Per-Call Approval Verification & HITL Callback ──
    const effectiveUserDoc = ctx.userDoc || userDoc;
    const actionAmount = args?.amount != null && Number.isFinite(Number(args.amount)) ? Number(args.amount) : null;
    let approved = false;
    let approverId = null;

    if (ctx.approvalTokenId && approvalStore) {
      const chk = approvalStore.consume({
        tokenId: ctx.approvalTokenId,
        tool: name,
        args,
        userDoc: effectiveUserDoc,
        tier,
        amount: actionAmount,
      });
      if (!chk.ok) {
        const res = { ok: false, decision: 'deny', tier, policy, reason: chk.reason };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
      approved = true;
      approverId = chk.token.approver || null;
    } else if (ctx.approved === true) {
      // Honor explicit per-call `approved: true` (verify optional tool/args binding if supplied)
      if (ctx.approvedTool && ctx.approvedTool !== name) {
        const res = { ok: false, decision: 'deny', tier, policy, reason: 'approval_tool_mismatch' };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
      approved = true;
      approverId = ctx.approver || null;
    }

    let evalRes = evaluateAction({ tier, policy, approved, groundingRequired, grounded });

    if (evalRes.decision === 'deny') {
      const res = { ok: false, decision: 'deny', tier, policy, reason: evalRes.reason, missingGrounding: groundingMissing };
      recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: evalRes.reason, missingGrounding: groundingMissing });
      return res;
    }

    if (evalRes.decision === 'await') {
      const approverFn = ctx.requestApproval || requestApproval;
      if (typeof approverFn === 'function') {
        const decision = await approverFn({
          tool: name,
          server: def.server || null,
          schemaHash: def.schemaHash,
          tier,
          policy,
          args,
          amount: actionAmount,
          chatId: ctx.chatId || null,
          sender: ctx.sender || null,
        });
        const isApproved = Boolean(decision === true || (decision && decision.approved === true));
        const by = (decision && typeof decision === 'object' && (decision.approver || decision.by)) || null;
        if (isApproved) {
          if (effectiveUserDoc && effectiveUserDoc.active && by && typeof effectiveUserDoc.canApprove === 'function') {
            const authChk = effectiveUserDoc.canApprove(by, { tier, actionClass: tier, amount: actionAmount });
            if (authChk && authChk.ok === false) {
              const res = { ok: false, decision: 'deny', tier, policy, reason: authChk.reason || 'approver_not_authorized' };
              recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', approver: by, reason: res.reason });
              return res;
            }
          }
          if (approvalStore) {
            const tok = approvalStore.issue({ tool: name, args, approver: by, tier, amount: actionAmount });
            const consumed = approvalStore.consume({ tokenId: tok.id, tool: name, args, userDoc: by ? effectiveUserDoc : null, tier, amount: actionAmount });
            approved = consumed.ok;
            approverId = by;
          } else {
            approved = true;
            approverId = by;
          }
        }
        evalRes = evaluateAction({ tier, policy, approved, groundingRequired, grounded });
      }
      if (evalRes.decision !== 'allow') {
        const res = { ok: false, decision: 'await', tier, policy, reason: evalRes.reason };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'await', reason: evalRes.reason });
        return res;
      }
    }

    // ── Stage 6: Execute Tool + §28 Read-Only Probe Confirmation ──
    try {
      const output = await def.execute(args || {}, ctx);
      let confirmation = null;
      if (def.confirm && def.confirm.mode !== 'none') {
        confirmation = await confirmEffect({
          tool: name,
          tier,
          confirm: def.confirm,
          params: args || {},
          invoke: async (probeName, probeParams) => {
            const probeResolved = resolveToolEntry(probeName);
            if (!probeResolved) throw new Error(`confirm_probe_not_found:${probeName}`);
            const probeTier = resolveEffectiveTier(probeResolved.name, probeResolved.def).tier;
            if (probeTier !== 'read_only') {
              throw new Error(`confirm_probe_must_be_read_only:${probeResolved.name}:${probeTier}`);
            }
            return probeResolved.def.execute(probeParams || {}, ctx);
          },
        });
        if (!confirmation.ok) {
          recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'unconfirmed', reason: confirmation.reason });
          return { ok: false, decision: 'unconfirmed', tier, policy, output, confirmation, error: confirmation.reason };
        }
      }
      recordAudit({
        tool: name,
        viaMetaTool: ctx.viaMetaTool || null,
        tier,
        policy,
        via,
        decision: 'allow',
        ok: true,
        approved,
        approver: approverId,
        trustedOutput: def.trustedOutput,
      });
      return { ok: true, decision: 'allow', tier, policy, output, confirmation, trustedOutput: def.trustedOutput };
    } catch (err) {
      const msg = String(err?.message || err);
      recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'error', error: msg });
      return { ok: false, decision: 'error', tier, policy, error: msg };
    }
  }

  return {
    register,
    registerSkills,
    unregister,
    syncMcpTools,
    listSchemas,
    getPromptSurface,
    searchTools,
    executeTool,
    has: (name) => Boolean(resolveToolEntry(name)),
    getAuditLog: () => [...auditLog],
    getQuarantinedTools: () => [...quarantinedMcp.entries()].map(([name, info]) => ({ name, ...info })),
    get securityConfig() { return sec; },
  };
}
