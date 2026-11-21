// SCROLL 2.0 -- §47 Live Multi-Round Tool Executor & Built-in Tool Registry.
//
// Every tool call -- built-in or MCP -- passes through ONE deterministic safety gate before
// executing:
//   1. §42 boundary enforcement (external/mixed-group turns cannot invoke write/exec/admin tools).
//   2. §21 risk tier + policy matrix (`resolveTier` + `policyForTier` + `evaluateAction`).
//   3. §22 action grounding for financial/destructive tiers (`checkGrounding`).
//   4. Interactive HITL approval (`requestApproval` callback) when policy is `must-approve`.
//   5. §28 post-write read-back effect confirmation (`confirmEffect`) when declared.
//   6. Structured audit log for every allow / await / deny / executed call.
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTier, policyForTier, needsGrounding, evaluateAction, loadMcpRisk, loadAgentSecurity } from './permissions.js';
import { checkGrounding } from './grounding.js';
import { confirmEffect } from './effects.js';

const execFileAsync = promisify(execFile);

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

export function isSafePublicUrl(rawUrl) {
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
  for (const re of PRIVATE_IP_PATTERNS) {
    if (re.test(host)) return { ok: false, reason: `ssrf_blocked_private_ip:${host}` };
  }
  return { ok: true, url: u.toString() };
}

function resolveInsideRoot(rootDir, relPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, String(relPath || '.'));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`path_traversal_denied:${relPath}`);
  }
  return target;
}

const DEFAULT_BUILTIN_RISK = {
  read_file: 'read_only',
  list_dir: 'read_only',
  web_search: 'read_only',
  web_fetch: 'read_only',
  memory_search: 'read_only',
  knowledge_search: 'read_only',
  memory_remember: 'reversible_write',
  memory_forget: 'destructive',
  automations: 'reversible_write',
  spawn_worker: 'reversible_write',
  exec: 'destructive',
};

export function createToolRegistry({
  cwd = process.cwd(),
  agentDir = null,
  memoryStore = null,
  knowledgeIndex = null,
  scheduler = null,
  workerPool = null,
  mcpManager = null,
  requestApproval = null,
  webSearchFn = null,
  fetchImpl = globalThis.fetch,
  allowedExecBinaries = null,
  riskDefaults = null,
  approvalOverrides = null,
  onAudit = null,
} = {}) {
  const tools = new Map();
  const auditLog = [];

  const sec = agentDir ? loadAgentSecurity(agentDir) : { riskDefaults: {}, approvalOverrides: {} };
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

  function recordAudit(entry) {
    const full = { ts: new Date().toISOString(), ...entry };
    auditLog.push(full);
    if (auditLog.length > 500) auditLog.shift();
    if (typeof onAudit === 'function') {
      try { onAudit(full); } catch { /* ignore */ }
    }
    return full;
  }

  function register(def) {
    if (!def || !def.name || typeof def.execute !== 'function') {
      throw new Error('tool register: name and execute(args, ctx) are required');
    }
    tools.set(def.name, {
      name: def.name,
      description: def.description || '',
      parameters: def.parameters || { type: 'object', properties: {} },
      risk: def.risk || null,
      ground: Array.isArray(def.ground) ? def.ground : [],
      confirm: def.confirm || null,
      execute: def.execute,
    });
  }

  function unregister(name) {
    return tools.delete(name);
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
    async execute(args) {
      const abs = resolveInsideRoot(cwd, args.path);
      if (memoryStore) {
        const chk = memoryStore.assertToolPathAllowed(abs);
        if (!chk.allowed) throw new Error(chk.reason);
      }
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error(`not_a_file:${args.path}`);
      const cap = Math.min(64_000, Math.max(256, Number(args.maxBytes || 16_000)));
      const raw = fs.readFileSync(abs, 'utf8');
      return {
        path: path.relative(cwd, abs),
        bytes: stat.size,
        truncated: raw.length > cap,
        content: raw.slice(0, cap),
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
    async execute(args) {
      const abs = resolveInsideRoot(cwd, args.path || '.');
      if (memoryStore) {
        const chk = memoryStore.assertToolPathAllowed(abs);
        if (!chk.allowed) throw new Error(chk.reason);
      }
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .slice(0, 200)
        .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
      return { path: path.relative(cwd, abs) || '.', entries };
    },
  });

  register({
    name: 'web_fetch',
    description: 'Fetch a public HTTP/HTTPS URL (blocks localhost and private/metadata IPs).',
    risk: 'read_only',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'number' },
      },
      required: ['url'],
    },
    async execute(args) {
      const safe = isSafePublicUrl(args.url);
      if (!safe.ok) throw new Error(safe.reason);
      const res = await fetchImpl(safe.url, { method: 'GET', redirect: 'follow' });
      const finalSafe = isSafePublicUrl(res.url || safe.url);
      if (!finalSafe.ok) throw new Error(`redirect_${finalSafe.reason}`);
      const text = await res.text();
      const cap = Math.min(24_000, Math.max(500, Number(args.maxChars || 8000)));
      return { url: res.url || safe.url, status: res.status, truncated: text.length > cap, body: text.slice(0, cap) };
    },
  });

  register({
    name: 'web_search',
    description: 'Search the web using a configured search provider.',
    risk: 'read_only',
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
      return { query: args.query, results };
    },
  });

  if (knowledgeIndex) {
    register({
      name: 'knowledge_search',
      description: 'Search the indexed deployment knowledge base (SOPs, manuals, tariffs, FAQs).',
      risk: 'read_only',
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
          fn: () => ctx.spawnWorkerFn(String(args.task || ''), ctx),
        });
        return { ok: true, jobId: job.id, status: job.status };
      },
    });
  }

  register({
    name: 'exec',
    description: 'Execute a single binary with arguments inside the workspace (destructive tier; requires approval).',
    risk: 'destructive',
    ground: ['command'],
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
    },
    async execute(args) {
      const bin = String(args.command || '').trim();
      if (!bin) throw new Error('exec: command is required');
      if (Array.isArray(allowedExecBinaries) && !allowedExecBinaries.includes(bin)) {
        throw new Error(`exec_binary_not_allowed:${bin}`);
      }
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const { stdout, stderr } = await execFileAsync(bin, cmdArgs, {
        cwd,
        timeout: Math.min(60_000, Number(args.timeoutMs || 15_000)),
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: String(stdout || '').slice(0, 12_000), stderr: String(stderr || '').slice(0, 4000) };
    },
  });

  function syncMcpTools() {
    if (!mcpManager) return [];
    const discovered = mcpManager.listDiscoveredTools();
    const added = [];
    for (const t of discovered) {
      const toolName = tools.has(t.name) ? t.fullName : t.name;
      register({
        name: toolName,
        description: t.description,
        parameters: t.parameters,
        risk: t.risk || 'destructive',
        ground: t.ground,
        confirm: t.confirm,
        async execute(args) {
          return mcpManager.callTool(t.server, t.name, args);
        },
      });
      added.push(toolName);
    }
    return added;
  }

  function listSchemas({ allowWriteTools = true, delegatedTools = null } = {}) {
    const delegatedSet = Array.isArray(delegatedTools) && delegatedTools.length ? new Set(delegatedTools.map(String)) : null;
    const out = [];
    for (const def of tools.values()) {
      const { tier } = resolveTier(def.name, {
        mcpTools: { ...mcpRisk, ...(def.risk ? { [def.name]: { risk: def.risk, ground: def.ground } } : {}) },
        riskDefaults: mergedRiskDefaults,
      });
      if (!allowWriteTools && tier !== 'read_only' && !(delegatedSet && delegatedSet.has(def.name))) continue;
      out.push({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        tier,
      });
    }
    return out;
  }

  async function executeTool(name, args = {}, ctx = {}) {
    const def = tools.get(name);
    if (!def) {
      const res = { ok: false, decision: 'deny', error: `unknown_tool:${name}` };
      recordAudit({ tool: name, decision: 'deny', reason: res.error });
      return res;
    }

    const effectiveMcp = {
      ...mcpRisk,
      ...(def.risk ? { [name]: { risk: def.risk, ground: def.ground || [] } } : {}),
    };
    const { tier, via } = resolveTier(name, { mcpTools: effectiveMcp, riskDefaults: mergedRiskDefaults });
    const policy = policyForTier(tier, mergedApprovalOverrides);

    // §42 boundary wall: external / mixed-group turns are strictly read-only unless explicitly owner-delegated by host code
    const delegatedSet = Array.isArray(ctx.delegatedTools) ? new Set(ctx.delegatedTools.map(String)) : null;
    if (ctx.turnClassification && !ctx.turnClassification.writeToolsAllowed && tier !== 'read_only' && !(delegatedSet && delegatedSet.has(name))) {
      const res = { ok: false, decision: 'deny', tier, policy, reason: 'boundary_wall_write_tools_blocked' };
      recordAudit({ tool: name, tier, policy, decision: 'deny', reason: res.reason });
      return res;
    }

    // §22 grounding pre-check for financial/destructive tiers
    const groundingRequired = needsGrounding(tier);
    let grounded = null;
    let groundingMissing = [];
    if (groundingRequired) {
      const groundKeys = (effectiveMcp[name]?.ground && effectiveMcp[name].ground.length)
        ? effectiveMcp[name].ground
        : (def.ground || []);
      if (groundKeys.length) {
        const subset = {};
        for (const k of groundKeys) {
          if (args && args[k] !== undefined) subset[k] = args[k];
        }
        const g = checkGrounding(subset, ctx.groundingSources || '');
        grounded = g.ok;
        groundingMissing = g.missing;
      } else {
        grounded = true;
      }
    }

    // Pre-approval evaluation
    let approved = Boolean(ctx.approved);
    let evalRes = evaluateAction({ tier, policy, approved, groundingRequired, grounded });

    if (evalRes.decision === 'deny') {
      const res = { ok: false, decision: 'deny', tier, policy, reason: evalRes.reason, missingGrounding: groundingMissing };
      recordAudit({ tool: name, tier, policy, via, decision: 'deny', reason: evalRes.reason, missingGrounding: groundingMissing });
      return res;
    }

    // §21 HITL approval callback when policy is must-approve
    if (evalRes.decision === 'await') {
      const approver = ctx.requestApproval || requestApproval;
      if (typeof approver === 'function') {
        const decision = await approver({
          tool: name,
          tier,
          policy,
          args,
          chatId: ctx.chatId || null,
          sender: ctx.sender || null,
        });
        approved = Boolean(decision === true || (decision && decision.approved === true));
        evalRes = evaluateAction({ tier, policy, approved, groundingRequired, grounded });
      }
      if (evalRes.decision !== 'allow') {
        const res = { ok: false, decision: 'await', tier, policy, reason: evalRes.reason };
        recordAudit({ tool: name, tier, policy, via, decision: 'await', reason: evalRes.reason });
        return res;
      }
    }

    // Execute the tool
    try {
      const output = await def.execute(args || {}, ctx);
      // §28 effect confirmation if declared
      let confirmation = null;
      if (def.confirm) {
        confirmation = await confirmEffect({
          tool: name,
          tier,
          confirm: def.confirm,
          params: args || {},
          invoke: async (probeName, probeParams) => {
            const probeDef = tools.get(probeName);
            if (!probeDef) throw new Error(`confirm_probe_not_found:${probeName}`);
            return probeDef.execute(probeParams || {}, ctx);
          },
        });
        if (!confirmation.ok) {
          recordAudit({ tool: name, tier, policy, via, decision: 'unconfirmed', reason: confirmation.reason });
          return { ok: false, decision: 'unconfirmed', tier, policy, output, confirmation, error: confirmation.reason };
        }
      }
      recordAudit({ tool: name, tier, policy, via, decision: 'allow', ok: true, approved });
      return { ok: true, decision: 'allow', tier, policy, output, confirmation };
    } catch (err) {
      const msg = String(err?.message || err);
      recordAudit({ tool: name, tier, policy, via, decision: 'error', error: msg });
      return { ok: false, decision: 'error', tier, policy, error: msg };
    }
  }

  return {
    register,
    unregister,
    syncMcpTools,
    listSchemas,
    executeTool,
    has: (name) => tools.has(name),
    getAuditLog: () => [...auditLog],
  };
}
