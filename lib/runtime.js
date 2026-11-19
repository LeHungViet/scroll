// SCROLL — the runtime. `scroll run` drives a thin, file-based multi-agent loop.
//
// Design (stays true to the thesis — no engine/DB/bus):
//   • One controller owns WORK.md (a declarative DAG of tasks).
//   • The runner advances the DAG DETERMINISTICALLY (ready tasks = deps done),
//     the LLM only acts INSIDE a step.
//   • Agents coordinate through the filesystem: each task appends to blackboard/.
//   • A cost gate decides single vs multi BEFORE spawning.
//   • Hard caps + a circuit breaker bound spend/time/iterations.
//   • Context is ordered stable-prefix-first so providers can cache it.
//   • Every step is verified and checkpointed; everything is an append-only event.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseYaml, parseFrontmatter, loadAgent, estimateCost } from './scroll.js';
import { pickProvider, approxTokens } from './providers.js';
import { resolveTier, policyForTier, needsGrounding, evaluateAction, loadMcpRisk, loadAgentSecurity, normalizeTier } from './permissions.js';
import { collectSources, checkGrounding } from './grounding.js';
import { writeDigest } from './digest.js';
import { openStore } from './memory.js';
import { openSkills, resolveSources, bindingsToolFor } from './skills.js';
import { openTeam } from './people.js';
import { openUser, classifyTurn, isIdentityQuestion, checkAiDisclosure, applyAiLabel } from './user.js';
import crypto from 'node:crypto';

const PRICING = { input: 3, cachedInput: 0.3, output: 15 }; // $/million tokens
const DEFAULT_CAPS = { maxIterations: 20, maxInputTokens: 120000, maxWallClockMs: 900000, maxUsd: 5, recursionDepth: 2 };

// ── WORK.md parsing ───────────────────────────────────────────────────────────
// Tasks are fenced ```task blocks of YAML (same shape `scroll check` validates).
export function parseWork(raw) {
  const { frontmatter } = parseFrontmatter(raw.startsWith('---') ? raw : `---\n---\n${raw}`);
  const controller = (frontmatter && frontmatter.controller) || null;
  const blocks = [...raw.matchAll(/```task\n([\s\S]*?)```/g)].map((m) => m[1]);
  const tasks = [];
  for (const b of blocks) {
    let t; try { t = parseYaml(b); } catch { continue; }
    if (!t || !t.id) continue;
    // v1.9 §40 — owner: agent:<name> | person:<slug> | <name> (an agent, as before)
    const rawOwner = String(t.owner || controller || 'controller');
    const person = rawOwner.startsWith('person:') ? rawOwner.slice(7) : null;
    const owner = rawOwner.replace(/^agent:/, '');
    tasks.push({
      id: t.id, title: t.title || t.id, status: t.status || 'todo',
      owner, person, agent: person ? null : (t.agent || owner || controller),
      objective: t.objective || t.title || '', output_format: t.output_format || 'decision-ready markdown',
      source_guidance: arr(t.source_guidance), boundaries: arr(t.boundaries),
      blockedBy: arr(t.blockedBy), parallel: t.parallel === true,
      risk: t.risk || null, tool: t.tool || null, ground: t.ground || null, final: t.final === true,
      deterministic: t.deterministic === true, op: t.op || 'merge',
      engine: t.engine || null, effort: t.effort || null, sandbox: t.sandbox || null,
      workdir: t.workdir || null, timeout_ms: t.timeout_ms || null,
      subject: t.subject || null, memory_topics: arr(t.memory_topics), // v1.7 §31.5: whose memory this step may read
      skills: arr(t.skills), // v1.8 §34.7: skills this step loads in full
      for: t.for ? String(t.for).replace(/^person:/, '') : null, people: arr(t.people).map((x) => String(x)), // v1.9 §39
      action: t.action || null, amount: t.amount ?? null,                 // v1.9 §40: what the gate checks the approver against
    });
  }
  return { controller: String(controller || (tasks.find((x) => !x.person) || tasks[0] || {}).owner || 'controller').replace(/^agent:/, ''), tasks };
}
const arr = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);

// ── the run ─────────────────────────────────────────────────────────────────
export async function runWork(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const providerName = opts.providerName || 'auto';
  const provider = opts.provider || pickProvider(providerName, { model: opts.model });   // an injected provider object (apps, tests)

  // run dir + isolated scratch (provider calls run here so a repo CLAUDE.md can't leak in)
  const runId = opts.runId || new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = opts.runDir ? path.resolve(opts.runDir) : path.join(cwd, 'runs', runId);
  const blackboardDir = path.join(runDir, 'blackboard');
  const scratchDir = path.join(runDir, 'scratch');
  const controlDir = opts.controlDir ? path.resolve(opts.controlDir) : path.join(runDir, 'control');
  const approvalsDir = path.join(controlDir, 'approvals'); // v1.4: must-approve gates land here
  fs.mkdirSync(blackboardDir, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });
  const eventsPath = opts.eventsPath ? path.resolve(opts.eventsPath) : path.join(runDir, 'events.jsonl');
  const outPath = opts.outPath ? path.resolve(opts.outPath) : path.join(runDir, 'output.md');
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  if (fs.existsSync(eventsPath) && !opts.resume) fs.rmSync(eventsPath); // resume APPENDS to the stream

  const emit = (type, data = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), runId, type, data });
    fs.appendFileSync(eventsPath, line + '\n');
    if (opts.json) console.log(line);
    else if (opts.verbose) console.log(`  ${type}${data.id ? ' ' + data.id : ''}`);
  };

  if (!provider.ready) { emit('error', { reason: provider.missing }); throw new Error(`provider not ready: ${provider.missing}`); }

  // v1.6: per-task engine routing — a task may name its own engine (codex/grok/claude/...).
  // Providers are memoized per engine name; the run-level provider stays the default.
  const providerCache = new Map();
  const providerFor = (engineName) => {
    if (!engineName) return provider;
    if (!providerCache.has(engineName)) providerCache.set(engineName, pickProvider(engineName, {}));
    const p = providerCache.get(engineName);
    if (!p.ready) { emit('error', { reason: `engine ${engineName}: ${p.missing}` }); throw new Error(`provider not ready: ${p.missing}`); }
    return p;
  };

  // build the work model (multi-agent file, or a synthesized single task)
  let work;
  if (opts.workFile) {
    work = parseWork(fs.readFileSync(path.resolve(cwd, opts.workFile), 'utf8'));
  } else if (opts.task) {
    work = { controller: opts.agent || 'controller', tasks: [{
      id: 'task', title: 'single task', status: 'todo', owner: opts.agent || 'controller', agent: opts.agent || null,
      objective: opts.task, output_format: 'decision-ready markdown', source_guidance: [], boundaries: [],
      blockedBy: [], parallel: false, risk: opts.risk || null, tool: opts.tool || null, ground: opts.ground || null, final: true,
      skills: arr(opts.skills), person: null, for: opts.for || null, people: arr(opts.people), action: opts.action || null, amount: opts.amount ?? null,
    }] };
  } else {
    throw new Error('runWork needs --work <WORK.md> or --task "<text>"');
  }
  if (!work.tasks.length) throw new Error('no tasks found');
  if (opts.subject) for (const t of work.tasks) if (!t.subject) t.subject = opts.subject;
  if (opts.for) for (const t of work.tasks) if (!t.for && !t.person) t.for = String(opts.for).replace(/^person:/, '');

  // v1.9 §38–§40 — deployment USER.md (single file outside agents/, preferred) or legacy people/
  // dir. Read once per run so prompt prefixes stay byte-stable; frontmatter stays machine-only.
  const userDoc = openUser({ cwd, file: opts.userFile || null, config: opts.config || null });
  const legacyTeam = openTeam({ cwd, dir: opts.peopleDir || null, config: opts.config || null });
  const team = userDoc.active ? userDoc : legacyTeam;
  const peopleOn = team.active || work.tasks.some((t) => t.person);
  // §20.6 — gate decisions about approvals go to an append-only, hash-chained audit trail
  const auditPath = path.join(runDir, 'audit.jsonl');
  const audit = (rec) => {
    let prev = '';
    if (fs.existsSync(auditPath)) { const ls = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean); prev = ls.length ? crypto.createHash('sha256').update(ls[ls.length - 1]).digest('hex').slice(0, 32) : ''; }
    const line = JSON.stringify({ ts: new Date().toISOString(), runId, ...rec, prev });
    fs.appendFileSync(auditPath, line + '\n');
  };
  if (userDoc.exists) {
    const hc = userDoc.checkHashChange(opts.stateDir || path.join(cwd, '.scroll'));
    if (hc.changed) {
      emit('user_md_changed', { file: path.relative(cwd, userDoc.file) || userDoc.file, previousHash: hc.previousHash, hash: hc.hash });
      audit({ event: 'user_md_changed', file: path.relative(cwd, userDoc.file) || userDoc.file, previousHash: hc.previousHash, hash: hc.hash });
    }
  }
  const userBlocks = new Map();
  const userFor = (audience = 'internal') => {
    if (!userDoc.active) return '';
    if (!userBlocks.has(audience)) {
      const r = userDoc.render({ audience });
      userBlocks.set(audience, r);
      if (r.text) emit('user_loaded', { audience, snapshot: r.hash, fileHash: r.fileHash, chars: r.chars });
    }
    return userBlocks.get(audience).text;
  };
  const notify = (reason, to, extra = {}) => {
    if (!peopleOn || !to) return;
    const people = team.resolve(to).map((slug) => { const c = team.get(slug); return { slug, channels: (c && c.frontmatter && Array.isArray(c.frontmatter.channels)) ? c.frontmatter.channels : [] }; });
    emit('notify', { reason, to, people, ...extra });
  };
  const peopleInWork = [...new Set(work.tasks.filter((t) => t.person).map((t) => t.person))];
  const peopleBlocks = new Map();
  const peopleFor = (task, agent) => {
    if (userDoc.active || !legacyTeam.active) return '';
    const fm = (agent && agent.frontmatter) || {};
    const sv = legacyTeam.servedBy(fm, { forSlug: task.for });
    const mentioned = [...new Set([...task.people.flatMap((r) => (legacyTeam.get(r) ? [r] : legacyTeam.resolve(r))), ...peopleInWork])].sort();
    const key = `${agent ? agent.name : '_'}|${sv.slug || ''}|${mentioned.join(',')}`;
    if (!peopleBlocks.has(key)) {
      const r = legacyTeam.render({ agent: agent ? agent.name : null, identity: fm, served: sv.slug, mentioned });
      peopleBlocks.set(key, r);
      if (!sv.slug && sv.reason !== 'none') emit('people_denied', { taskId: task.id, reason: sv.reason, candidates: sv.candidates });
      if (r.text) emit('people_loaded', { taskId: task.id, agent: agent ? agent.name : null, served: r.served, mentioned: r.mentioned, snapshot: r.hash, chars: r.chars });
    }
    return peopleBlocks.get(key).text;
  };
  const waiting = [];
  const outbox = [];
  const writeOutbox = (ob) => {
    const f = path.join(runDir, 'outbox', `${ob.taskId}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(ob, null, 2) + '\n');
    outbox.push(ob);
  };
  const turnInput = opts.turn || (opts.sender || opts.participants || opts.isGroup ? {
    sender: opts.sender || null,
    participants: opts.participants || null,
    isGroup: !!opts.isGroup,
    channelMap: opts.channelMap || null,
    chatSubject: opts.chatSubject || null,
    approvedByHuman: !!opts.approvedByHuman,
    autoSendExternal: !!opts.autoSendExternal,
    aiLabel: opts.aiLabel || undefined,
  } : null);

  // v1.7 §31.5: a step that names a subject gets that subject's frozen load contract — nothing else.
  // The store is a data plane outside the repo; a store inside the workdir is refused (I-01).
  let memStore = null;
  const memRoot = opts.memoryStore || process.env.SCROLL_MEMORY_STORE;
  if (work.tasks.some((t) => t.subject)) {
    if (!memRoot) throw new Error('a task names a subject but no memory store is configured (--memory-store or SCROLL_MEMORY_STORE)');
    memStore = openStore({ root: memRoot, region: opts.memoryRegion || process.env.SCROLL_MEMORY_REGION || 'local', policy: opts.memoryPolicy || process.env.SCROLL_MEMORY_POLICY || undefined, workdir: cwd });
  }
  const memoryFor = (task, caps, turnPolicy = null) => {
    if (!memStore || !task.subject) return '';
    // v1.9 §42: external content audience may ONLY load the current chat's own subject memory
    if (turnPolicy && turnPolicy.memoryScope === 'chat_only') {
      if (!turnPolicy.chatSubject || task.subject !== turnPolicy.chatSubject) {
        emit('memory_denied', { taskId: task.id, subject: task.subject, reason: 'external_memory_scope' });
        return '';
      }
    }
    const sid = /^s_[a-z0-9]+_[0-9a-f]{16}$/.test(task.subject) ? task.subject : memStore.resolve(task.subject);
    if (!sid || !memStore.exists(sid)) { emit('memory_denied', { taskId: task.id, reason: 'unknown_subject' }); return ''; }
    const snap = memStore.snapshot(sid, { capabilities: caps, topics: (task.memory_topics || []).length ? task.memory_topics : null, verified: opts.verified !== false });
    if (snap.denied) { emit('memory_denied', { taskId: task.id, reason: snap.denied }); return ''; }
    emit('memory_loaded', { taskId: task.id, subject: memStore.hmac(sid), snapshot: snap.hash, memoryChars: snap.chars, truncated: snap.truncated });
    return snap.text;
  };

  // v1.8 §34 — one skill registry per agent for the whole run: its index is frozen at open, so the
  // stable prefix stays byte-identical across ticks. Opened only when a skill source exists or a
  // task names a skill (a repo without skills runs exactly as before).
  const skillRegs = new Map();
  const skillsFor = (agent, wanted) => {
    const key = agent ? agent.name : '_';
    if (skillRegs.has(key)) return skillRegs.get(key);
    let reg = null;
    try {
      const fm = (agent && agent.frontmatter) || {};
      const sources = resolveSources({ cwd, agent: agent ? agent.name : null, identity: fm });
      if (wanted || sources.some((s) => fs.existsSync(s.path))) {
        reg = openSkills({ cwd, agent: agent ? agent.name : null, identity: fm, sources, pinned: fm.skills,
          available: { capabilities: Array.isArray(fm.capabilities) ? fm.capabilities : [] },
          toolFor: bindingsToolFor(agent && agent.tools, opts.skillRuntime || null),
          emit: (type, data) => emit(type, { agent: key, ...data }) });
      }
    } catch (e) { emit('error', { reason: `skills: ${e.message}` }); }
    skillRegs.set(key, reg);
    return reg;
  };

  const startedAt = Date.now();
  emit('run_started', { mode: opts.workFile ? 'multi-agent' : 'single', provider: provider.name, model: provider.model });
  emit('work_loaded', { tasks: work.tasks.length, controller: work.controller });

  // single controller (failure-mode #1 guard): exactly one owner of WORK.md, ≤1 owner per task
  emit('work_contract', { controller: work.controller, controllerCount: 1, ownerCountPerTaskMax: 1 });

  // per-language token budgeting: a controller agent's language scales the estimate
  // (Vietnamese ≈ 1.8× English) so the cost gate is honest for non-English markets.
  let runLanguage = opts.language || null;
  if (!runLanguage) { try { runLanguage = loadAgent(work.controller, cwd)?.frontmatter?.language || null; } catch { /* no controller folder */ } }
  const mcpTools = loadMcpRisk(cwd); // per-tool risk from a repo-level .mcp.json

  // cost gate BEFORE any spawn
  const distinctAgents = new Set(work.tasks.filter((t) => !t.person).map((t) => t.agent || t.owner)).size;   // a person's step spawns no agent
  const objectivesText = work.tasks.map((t) => t.objective).join(' ');
  const est = estimateCost(objectivesText, Math.max(2, distinctAgents), { language: runLanguage });
  const parallelReady = work.tasks.filter((t) => t.parallel).length;
  let decision = (parallelReady >= 2 && distinctAgents > 1) ? 'multi' : 'single';
  const spawnedAgents = decision === 'multi' ? distinctAgents : 1;
  emit('cost_gate', { singleTokens: est.single, multiTokens: est.multi, decision, spawnedAgents, language: runLanguage || 'en', reason: decision === 'multi' ? 'parallel read-heavy work' : 'single is enough' });
  if (decision === 'single') for (const t of work.tasks) t.parallel = false; // enforce it

  // lean path: a single small task gets a slim prefix — a 1-call task can't amortize a full
  // agent-definition dump, so sending it uncached is pure overhead (kept the contract, which drives quality).
  const leanSingle = decision === 'single' && work.tasks.length === 1 && (work.tasks[0].blockedBy || []).length === 0 && !opts.noLean;
  // nudges (on-thesis output behavior): reject-multi when a fan-out was genuinely on the table; checkpoint-frame for long work.
  const rejectMultiNudge = decision === 'single' && (distinctAgents > 1 || /multi-?agent|spawn|fan-?out|nhiều agent|nhieu agent/i.test(objectivesText));
  const longRun = work.tasks.length > 1 || /(\d+\s*(steps|bước|buoc|ticks?))|resume|long[- ]?run|nhiều bước|nhieu buoc/i.test(objectivesText);

  // hard caps
  const caps = { ...DEFAULT_CAPS, ...(opts.caps || {}) };
  emit('cap_set', { maxIterations: caps.maxIterations, maxInputTokens: caps.maxInputTokens, maxWallClockMs: caps.maxWallClockMs, maxUsd: caps.maxUsd });

  // efficiency levers: trim intermediate output · cap blackboard injected downstream · route sub-tasks to a cheaper model.
  const finalMaxTokens = opts.maxTokens || 800;
  const intermediateMaxTokens = opts.intermediateMaxTokens || Math.min(400, finalMaxTokens);
  const blackboardCap = opts.blackboardCap || 900; // chars of a dependency's blackboard injected downstream
  const route = opts.route !== false;
  const dependents = new Set(work.tasks.flatMap((t) => t.blockedBy || []));
  const isSynthesis = (task) => task.final || !dependents.has(task.id); // a leaf / final task gets full budget + primary model

  const ledger = { uncached: 0, cached: 0, output: 0, usd: 0, calls: 0, cachedCalls: 0 };
  const done = new Set();
  const outputs = {};

  // per-owner security (risk_defaults + approval overrides from IDENTITY.security), memoized
  const securityCache = {};
  const agentSecurity = (task) => {
    const key = task.agent || task.owner || '_';
    if (securityCache[key]) return securityCache[key];
    let sec = { riskDefaults: {}, approvalOverrides: {} };
    try { sec = loadAgentSecurity(loadAgent(task.agent || task.owner, cwd).dir); } catch { /* no agent folder */ }
    securityCache[key] = sec; return sec;
  };

  const billable = () => Math.round(ledger.uncached + ledger.cached * (PRICING.cachedInput / PRICING.input) + ledger.output * (PRICING.output / PRICING.input));
  const usd = () => (ledger.uncached / 1e6) * PRICING.input + (ledger.cached / 1e6) * PRICING.cachedInput + (ledger.output / 1e6) * PRICING.output;
  const capBreach = (iter) => {
    if (iter > caps.maxIterations) return `maxIterations ${caps.maxIterations}`;
    if (ledger.uncached + ledger.cached > caps.maxInputTokens) return `maxInputTokens ${caps.maxInputTokens}`;
    if (Date.now() - startedAt > caps.maxWallClockMs) return `maxWallClockMs ${caps.maxWallClockMs}`;
    if (usd() > caps.maxUsd) return `maxUsd ${caps.maxUsd}`;
    return null;
  };

  async function runTask(task) {
    task.status = 'doing';
    // v1.9 §40 — a person's step: no model call. The runner asks (a request file + a notify event to
    // the channels on the card) and stops there; it continues when that person marks it done.
    if (task.person) return personStep(task);
    const depSummaries = task.blockedBy.map((id) => {
      const p = path.join(blackboardDir, `${id}.md`);
      if (!fs.existsSync(p)) return '';
      let body = fs.readFileSync(p, 'utf8');
      if (body.length > blackboardCap) body = body.slice(0, blackboardCap) + '\n…[trimmed for downstream]';
      return `### from ${id}\n${body}`;
    }).filter(Boolean);
    emit('task_contract', {
      taskId: task.id, objective: task.objective, outputFormat: task.output_format,
      sourceGuidance: task.source_guidance, boundaries: task.boundaries,
    });

    // v1.9 §42 — per-turn internal vs external audience classifier (verified channelId, group lowest-trust wall)
    const turnPolicy = turnInput ? classifyTurn(userDoc, turnInput) : null;
    if (turnPolicy) {
      emit('turn_classified', { taskId: task.id, ...turnPolicy });
    }

    // ── permission gate (v1.4): risk-tiered, DETERMINISTIC, enforced HERE before the action ──
    // A tier comes from the task's declared tool (resolved via .mcp.json / IDENTITY.security) or a
    // direct task.risk tier. Legacy `irreversible` maps to `destructive`. The gate is in code, not
    // the prompt — a model cannot be talked out of it.
    const sec = agentSecurity(task);
    const tier = task.tool
      ? resolveTier(task.tool, { mcpTools, riskDefaults: sec.riskDefaults }).tier
      : normalizeTier(task.risk);
    if (tier && turnPolicy && !turnPolicy.writeToolsAllowed && ['reversible_write', 'financial', 'destructive'].includes(tier)) {
      const gateId = `${task.id}-gate`;
      emit('permission_decision', { taskId: task.id, tool: task.tool || null, tier, decision: 'deny', reason: 'external_write_forbidden' });
      task.status = 'blocked';
      emit('gate_blocked', { gateId, reason: 'external_write_forbidden' });
      return;
    }
    if (tier) {
      const policy = policyForTier(tier, sec.approvalOverrides);
      const gateId = `${task.id}-gate`;
      let approved = !!opts.autoApprove;
      const approvalFile = [path.join(approvalsDir, `${gateId}.json`), path.join(controlDir, `${gateId}.approved`)].find((f) => fs.existsSync(f)); // second: legacy path
      const gate = { tier, action: task.action || null, amount: task.amount ?? (task.ground && task.ground.amount) ?? null };
      if (opts.autoApprove && policy === 'must-approve') audit({ gateId, taskId: task.id, agent: task.agent || task.owner, tier, action: gate.action, decision: 'auto-approved', approver: 'operator:--auto-approve' });
      else if (approvalFile && policy === 'must-approve') {
        const raw = fs.readFileSync(approvalFile, 'utf8');
        let by = null; try { by = JSON.parse(raw || '{}').by || null; } catch { /* legacy: an empty marker */ }
        if (!peopleOn) {
          approved = true;   // no team configured: the file's presence approves, as before v1.9
          audit({ gateId, taskId: task.id, agent: task.agent || task.owner, tier, action: gate.action, decision: 'accepted', approver: by || 'unattributed', file: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16) });
        } else {
          // §40 — the approval names its person, and that person's card must cover this action and amount
          const v = team.canApprove(by, gate);
          audit({ gateId, taskId: task.id, agent: task.agent || task.owner, tier, action: gate.action, amount: gate.amount, decision: v.ok ? 'accepted' : 'rejected', approver: by || 'unattributed', reason: v.ok ? undefined : v.reason, file: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16) });
          if (v.ok) approved = true;
          else emit('approval_rejected', { gateId, taskId: task.id, by: by || null, tier, action: gate.action, reason: v.reason });
        }
      }

      // grounding pre-check: for financial|destructive, every declared param must trace to a real
      // prior source (blackboard / prior output / steer / objective) — a fabricated id never executes.
      let grounded = null;
      const groundingRequired = needsGrounding(tier) && task.ground != null;
      if (groundingRequired) {
        const steerP = path.join(controlDir, 'steer.md');
        const sources = collectSources({
          depSummaries, objective: task.objective,
          steer: fs.existsSync(steerP) ? fs.readFileSync(steerP, 'utf8') : '',
          priorOutputs: Object.values(outputs),
        });
        const g = checkGrounding(task.ground, sources);
        grounded = g.ok;
        emit('grounding_checked', { taskId: task.id, tier, traced: g.traced, missing: g.missing, passed: g.ok });
      }

      const verdict = evaluateAction({ tier, policy, approved, groundingRequired, grounded });
      emit('gate_requested', { gateId, risk: tier, tier, policy, approvedBeforeAction: verdict.decision === 'allow' });
      emit('permission_decision', { taskId: task.id, tool: task.tool || null, tier, policy, decision: verdict.decision, reason: verdict.reason });

      if (verdict.decision === 'deny') {
        emit('grounding_failed', { taskId: task.id, tier });
        task.status = 'blocked'; emit('gate_blocked', { gateId, reason: 'grounding' }); return;
      }
      if (verdict.decision === 'await') {
        fs.mkdirSync(approvalsDir, { recursive: true });
        const approvers = peopleOn ? team.approversFor(gate) : undefined;
        fs.writeFileSync(path.join(approvalsDir, `${gateId}.requested.json`),
          JSON.stringify({ gateId, tool: task.tool || null, tier, policy, action: gate.action, amount: gate.amount, approvers, ts: new Date().toISOString() }, null, 2));
        task.status = 'blocked'; emit('gate_blocked', { gateId });
        if (peopleOn) { waiting.push({ taskId: task.id, kind: 'approval', gateId, approvers }); for (const s of approvers) notify('gate', `person:${s}`, { gateId, taskId: task.id, tier }); }
        return;
      }
      emit('gate_approved', { gateId, approvedBeforeAction: true });
    }

    // deterministic step: a mechanical task (merge/passthrough) runs in code — 0 provider call, 0 tokens.
    if (task.deterministic) {
      emit('context_loaded', {
        taskId: task.id,
        sourcesRead: task.blockedBy.length + task.source_guidance.length,
        sources: [...task.blockedBy, ...task.source_guidance],
        lean: leanSingle,
        compact: false,
        files: [],
        chars: 0,
        fileChars: {},
      });
      const mergedBody = task.op === 'passthrough'
        ? (depSummaries[0] || task.objective)
        : [`## ${task.title}`, ...depSummaries].filter(Boolean).join('\n\n');
      const merged = task.final
        ? [
            '## Verdict',
            'Use the checkpointed, resumable plan below; this deterministic merge combines the verified step outputs without another model call.',
            '',
            '## Evidence',
            mergedBody,
            '',
            '## Assumptions',
            '- The merged step outputs are the evidence source for this final report.',
            '- Source ids are preserved from the upstream task outputs where available.',
            '',
            '## Next actions',
            '- Continue from the latest checkpoint if interrupted.',
            '- Verify each completed step before proceeding to the next one.',
          ].join('\n')
        : mergedBody;
      const bbPathD = path.join(blackboardDir, `${task.id}.md`);
      fs.appendFileSync(bbPathD, `${merged}\n`);
      emit('blackboard_write', { taskId: task.id, path: path.relative(runDir, bbPathD), appendOnly: true, bytes: Buffer.byteLength(merged) });
      emit('deterministic_step', { taskId: task.id, op: task.op, providerCalls: 0, tokens: 0 });
      outputs[task.id] = merged; task.status = 'done'; done.add(task.id);
      emit('task_completed', { id: task.id, deterministic: true });
      return;
    }

    // Stable-prefix-first context (cacheable) → volatile last.
    let agent = null;
    try { agent = loadAgent(task.agent || task.owner, cwd); } catch { /* agent folder optional */ }
    // v1.8 §34.7 — a step that names skills gets their full instructions; one it cannot have does not run
    const skillReg = skillsFor(agent, task.skills.length > 0);
    const skillBodies = [];
    for (const sname of task.skills) {
      const v = skillReg ? skillReg.view(sname) : { ok: false, error: 'no skill sources' };
      if (!v.ok) { emit('gate_blocked', { gateId: `${task.id}-skill`, reason: 'skill', skill: sname, detail: v.error }); task.status = 'blocked'; return; }
      emit('skill_loaded', { taskId: task.id, name: sname, hash: v.hash, source: v.source });
      skillBodies.push(`<skill name="${sname}">\n${v.text}\n</skill>`);
    }
    // the index is for an agent that can read skills on demand (§34.4: capability skills.read);
    // without it, a step still gets the skills it names, in full
    const canRead = Array.isArray(agent?.frontmatter?.capabilities) && agent.frontmatter.capabilities.includes('skills.read');
    const skillIndex = skillReg && canRead ? skillReg.index().text : '';
    const synthesis = isSynthesis(task);
    const agentCaps = (agent && agent.frontmatter && Array.isArray(agent.frontmatter.capabilities)) ? agent.frontmatter.capabilities : [];
    const baseToolPolicy = agentCaps.some((c) => /^(shell|fs\.write|mcp|web)/.test(String(c))) ? 'full' : 'none'; // reasoning-only agent → let the provider strip tool schemas
    const toolPolicy = (turnPolicy && turnPolicy.toolPolicyOverride) ? turnPolicy.toolPolicyOverride : baseToolPolicy;
    const compact = opts.compactPrefix !== undefined ? !!opts.compactPrefix : leanSingle; // compact prefix trims identity/tools but NEVER drops hard-rules.md (§6)
    const userBlock = userFor(turnPolicy ? turnPolicy.contentAudience : 'internal');
    const peopleBlock = peopleFor(task, agent);   // v1.9 §39: last in the stable prefix, frozen per agent+person
    const loadedFiles = [];
    const fileChars = {};
    const addCtx = (label, text) => {
      if (!text) return '';
      loadedFiles.push(label);
      fileChars[label] = text.length;
      return text;
    };
    if (peopleBlock) { loadedFiles.push('people'); fileChars.people = peopleBlock.length; }
    const stablePrefix = compact
      ? [
        leanSingle ? 'SCROLL agent — single small task; answer the objective directly.' : 'SCROLL agent — reason directly from the contract below.',
        addCtx('SOUL.md', agent && agent.soul ? agent.soul : ''),
        addCtx('hard-rules.md', agent && agent.hardRules ? agent.hardRules : ''),
        addCtx('USER.md', userBlock),
        peopleBlock, // compact-people
      ].filter(Boolean).join('\n\n')
      : [
        'SCROLL agent. Coordinate through files; one controller owns WORK.md.',
        addCtx('IDENTITY.md', agent && agent.identityBody ? agent.identityBody : ''),
        addCtx('SOUL.md', agent && agent.soul ? agent.soul : ''),
        addCtx('TOOLS.md', agent && agent.tools ? agent.tools : ''),
        addCtx('hard-rules.md', agent && agent.hardRules ? agent.hardRules : ''), // full-hr
        addCtx('skills:index', skillIndex), // v1.8 §34.3: pinned skill index, frozen for the run
        addCtx('USER.md', userBlock),
        peopleBlock,
      ].filter(Boolean).join('\n\n');
    emit('context_loaded', {
      taskId: task.id,
      sourcesRead: task.blockedBy.length + task.source_guidance.length,
      sources: [...task.blockedBy, ...task.source_guidance],
      lean: leanSingle,
      compact,
      files: loadedFiles,
      chars: stablePrefix.length,
      fileChars,
    });
    // sub-tasks return terse findings (they only feed the blackboard); only the synthesis needs full prose.
    const deliverable = synthesis
      ? `Return ${task.output_format} with sections: Verdict, Evidence, Assumptions, Next actions. Cite source ids like [S1]. Do not say you are blocked unless a source is truly missing.`
      : 'Return ONLY the key findings as terse bullet points — no preamble, no headings, ≤120 words. Cite source ids like [S1].';
    const volatile = [
      `Task: ${task.title}`,
      `Objective: ${task.objective}`,
      task.source_guidance.length ? `Sources:\n${task.source_guidance.join('\n')}` : '',
      memoryFor(task, agentCaps, turnPolicy),
      skillBodies.length ? `Skills for this step (follow them):\n\n${skillBodies.join('\n\n')}` : '',
      depSummaries.length ? `Blackboard (prior findings):\n${depSummaries.join('\n\n')}` : '',
      task.boundaries.length ? `Boundaries: ${task.boundaries.join('; ')}` : '',
      deliverable,
      rejectMultiNudge ? 'The cost gate selected SINGLE-agent: explicitly recommend single-agent and state you reject spawning unnecessary multi-agent for a task this small.' : '',
      longRun ? 'Frame the work as short, checkpointed, resumable steps (verify/revise/report) — never one uninterrupted run.' : '',
    ].filter(Boolean).join('\n\n');
    const prompt = `${stablePrefix}\n\n---\n\n${volatile}`;

    const agentSub = agent && agent.frontmatter && agent.frontmatter.model && agent.frontmatter.model.fallback;
    const callModel = task.engine ? null : ((!synthesis && route && (opts.subModel || agentSub)) ? (opts.subModel || agentSub) : opts.model); // engine task → that provider's own default model
    const callMaxTokens = synthesis ? finalMaxTokens : intermediateMaxTokens;
    // isolated working dir per task → two parallel agents never write the same scratch (worktree-lite).
    // With --worktree on a git repo, a real `git worktree` is used so parallel writes can't corrupt state.
    const taskScratch = path.join(scratchDir, task.id);
    fs.mkdirSync(taskScratch, { recursive: true });
    let workdir = taskScratch;
    if (task.workdir) workdir = path.resolve(cwd, task.workdir); // v1.6: repo-anchored task (code work needs the repo, not scratch)
    if (opts.worktree && task.parallel) { const wt = makeWorktree(cwd, runDir, task.id, emit); if (wt) workdir = wt; }
    if (task.parallel) emit('isolated_scratch', { taskId: task.id, dir: path.relative(runDir, workdir) });

    const prov = providerFor(task.engine);
    emit('provider_call_started', { taskId: task.id, provider: prov.name, label: task.owner, role: synthesis ? 'synthesis' : 'sub', model: callModel || prov.model, maxTokens: callMaxTokens, toolPolicy, engine: task.engine || null, effort: task.effort || null, sandbox: task.sandbox || null });
    const r = await prov.generate(prompt, { cwd: workdir, model: callModel, cachePrefix: stablePrefix, system: stablePrefix, maxTokens: callMaxTokens, toolPolicy, effort: task.effort, sandbox: task.sandbox, timeoutMs: task.timeout_ms || opts.stepTimeoutMs });
    ledger.uncached += r.usage.uncachedInputTokens; ledger.cached += r.usage.cachedInputTokens; ledger.output += r.usage.outputTokens; ledger.calls += 1;
    if (r.usage.cachedInputTokens > 0) ledger.cachedCalls += 1;
    emit('provider_call_completed', { taskId: task.id, durationMs: r.durationMs, usage: r.usage, responseId: r.responseId });
    if (r.usage.cachedInputTokens > 0 && ledger.calls >= 2) {
      emit('cache_path_checked', { cachedInputTokens: r.usage.cachedInputTokens, uncachedInputTokens: r.usage.uncachedInputTokens, providerCalls: ledger.calls, passed: true });
    }

    // v1.9 §42 — external-audience reply checks: AI identity disclosure / owner handoff / draft-only gate
    if (turnPolicy && turnPolicy.contentAudience === 'external') {
      const speaksAs = (agent && agent.frontmatter && agent.frontmatter.speaks_as) ? String(agent.frontmatter.speaks_as) : 'self';
      const approvedByHuman = !!(turnInput && turnInput.approvedByHuman);
      const reasons = [];
      let handoffTo = null;
      if (isIdentityQuestion(task.objective)) {
        if (speaksAs === 'owner') {
          reasons.push('identity_question_handoff');
          handoffTo = userDoc.active ? userDoc.handoffRole() : 'owner';
        } else {
          const disc = checkAiDisclosure(r.text);
          if (!disc.ok) reasons.push(disc.reason);
        }
      }
      if (!approvedByHuman && !(turnInput && turnInput.autoSendExternal === true && reasons.length === 0)) {
        reasons.push('external_requires_approval');
      }
      const decision = reasons.length > 0 ? 'hold' : 'send';
      const labeledText = applyAiLabel(r.text, {
        label: (turnInput && turnInput.aiLabel) || '[AI Assistant]',
        speaksAs,
        approvedByHuman,
      });
      const approvers = peopleOn ? team.approversFor({ tier: 'external_comm', action: 'send' }) : [];
      const ob = {
        taskId: task.id, decision, reasons, speaksAs, handoffTo,
        text: r.text, labeledText, approvers, ts: new Date().toISOString(),
      };
      writeOutbox(ob);
      emit('reply_checked', { taskId: task.id, decision, reasons, speaksAs, handoffTo });
      if (decision === 'hold') {
        emit('reply_held', { taskId: task.id, reasons, approvers, handoffTo });
        waiting.push({ taskId: task.id, kind: 'reply', reasons, approvers, handoffTo });
      }
    }

    const bbPath = path.join(blackboardDir, `${task.id}.md`);
    fs.appendFileSync(bbPath, `${r.text}\n`);
    emit('blackboard_write', { taskId: task.id, path: path.relative(runDir, bbPath), appendOnly: true, bytes: Buffer.byteLength(r.text) });

    outputs[task.id] = r.text;
    task.status = 'done'; done.add(task.id);
    emit('task_completed', { id: task.id });
  }

  function personStep(task) {
    const slug = task.person;
    const card = team.get(slug);
    if (!card || !card.valid) {
      emit('error', { reason: `task ${task.id}: person "${slug}" has no valid card in ${path.relative(cwd, team.dir) || team.dir}`, taskId: task.id });
      task.status = 'blocked'; waiting.push({ taskId: task.id, kind: 'person', person: slug, problem: card ? 'invalid_card' : 'unknown_person' }); return;
    }
    const doneP = path.join(controlDir, 'done', `${task.id}.json`);
    if (fs.existsSync(doneP)) {
      let d = {}; try { d = JSON.parse(fs.readFileSync(doneP, 'utf8')); } catch { /* unreadable */ }
      if (d.by === slug) {
        const text = `${String(d.note || d.output || `${slug} marked this step done.`)}\n`;
        const bbP = path.join(blackboardDir, `${task.id}.md`);
        fs.appendFileSync(bbP, text);
        emit('blackboard_write', { taskId: task.id, path: path.relative(runDir, bbP), appendOnly: true, bytes: Buffer.byteLength(text) });
        emit('human_task_done', { taskId: task.id, person: slug });
        outputs[task.id] = text; task.status = 'done'; done.add(task.id);
        emit('task_completed', { id: task.id, person: slug });
        return;
      }
      // a done mark from anyone but the assignee does not count (machine-checked, like an approval)
      emit('human_task_rejected', { taskId: task.id, person: slug, by: d.by || null, reason: 'not_assignee' });
      audit({ taskId: task.id, kind: 'person_step', person: slug, decision: 'rejected', by: d.by || 'unattributed', reason: 'not_assignee' });
    }
    const reqP = path.join(controlDir, 'requests', `${task.id}.json`);
    const channels = Array.isArray(card.frontmatter.channels) ? card.frontmatter.channels : [];
    const first = !fs.existsSync(reqP);
    if (first) {
      fs.mkdirSync(path.dirname(reqP), { recursive: true });
      fs.writeFileSync(reqP, JSON.stringify({ taskId: task.id, person: slug, title: task.title, objective: task.objective, output_format: task.output_format, channels, ts: new Date().toISOString() }, null, 2) + '\n');
    }
    emit('human_task_requested', { taskId: task.id, person: slug, channels, first });
    if (first) notify('person_step', `person:${slug}`, { taskId: task.id });   // asked once; a resume does not ask again
    task.status = 'blocked'; waiting.push({ taskId: task.id, kind: 'person', person: slug });
  }

  // crash-resume (real, cross-process): on --resume, restore completed tasks from the persisted
  // checkpoint, reload their blackboard outputs into memory, and SKIP re-running them (no re-billing).
  let startIteration = 0;
  if (opts.resume) {
    const cpPath = path.join(runDir, 'checkpoint.json');
    if (fs.existsSync(cpPath)) {
      try {
        const cp = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
        for (const [id, st] of Object.entries(cp.statuses || {})) {
          const tk = work.tasks.find((t) => t.id === id);
          if (tk && st === 'done') {
            tk.status = 'done'; done.add(id);
            const bb = path.join(blackboardDir, `${id}.md`);
            if (fs.existsSync(bb)) outputs[id] = fs.readFileSync(bb, 'utf8'); // restore output for synthesis
          }
        }
        startIteration = cp.iteration || 0;
        emit('resumed', { from: 'checkpoint.json', restoredDone: [...done], iteration: startIteration });
      } catch (e) { emit('error', { reason: 'resume failed: ' + e.message }); }
    } else {
      emit('resume_noop', { reason: 'no checkpoint.json — running from the start' });
    }
  }

  // deterministic advance loop
  let iteration = startIteration;
  let stopped = null;
  let resumeReloaded = false;
  while (work.tasks.some((t) => t.status !== 'done' && t.status !== 'blocked')) {
    if (fs.existsSync(path.join(controlDir, 'stop'))) { stopped = 'control/stop'; emit('circuit_breaker', { reason: stopped }); break; }
    const breach = capBreach(iteration + 1);
    if (breach) { stopped = breach; emit('circuit_breaker', { reason: breach, action: 'pause' }); fs.writeFileSync(path.join(runDir, 'PAUSED'), breach); notify('on_exceed', team.cfg.notify.on_exceed || (team.membersOf('owner').length ? 'role:owner' : null), { breach }); break; }

    const ready = work.tasks.filter((t) => t.status === 'todo' && t.blockedBy.every((id) => done.has(id)));
    if (!ready.length) {
      if (work.tasks.every((t) => t.status === 'done' || t.status === 'blocked')) break;
      // what is left waits on a blocked step (a gate, a person): stop here and resume later — not a deadlock
      if (work.tasks.some((t) => t.status === 'blocked')) { emit('waiting', { blocked: work.tasks.filter((t) => t.status === 'blocked').map((t) => t.id), pending: work.tasks.filter((t) => t.status === 'todo').map((t) => t.id) }); break; }
      emit('error', { reason: 'deadlock: no ready tasks but work remains', pending: work.tasks.filter((t) => t.status === 'todo').map((t) => t.id) });
      throw new Error('WORK.md deadlock (check blockedBy cycles)');
    }

    const parallelBatch = ready.filter((t) => t.parallel);
    const batch = (decision === 'multi' && parallelBatch.length >= 2) ? parallelBatch : [ready[0]];
    emit('dispatch', { iteration: iteration + 1, tasks: batch.map((t) => t.id), parallel: batch.length > 1 });
    await Promise.all(batch.map((t) => runTask(t)));

    iteration += 1;
    // checkpoint: filesystem is the state; try git, fall back to a checkpoint file.
    const statuses = Object.fromEntries(work.tasks.map((t) => [t.id, t.status]));
    fs.writeFileSync(path.join(runDir, 'checkpoint.json'), JSON.stringify({ iteration, statuses }, null, 2));
    let backend = 'file';
    const git = spawnSync('git', ['-C', cwd, 'add', '-A'], { encoding: 'utf8' });
    if (git.status === 0) { const c = spawnSync('git', ['-C', cwd, 'commit', '-m', `scroll run ${runId} iter ${iteration}`], { encoding: 'utf8' }); if (c.status === 0) backend = 'git'; }
    emit('checkpoint_written', { checkpointId: `${runId}-iter${iteration}`, backend });

    // measured resume: simulate a crash after the first checkpoint, then RESUME from the persisted file
    // (re-read checkpoint.json → restore task statuses → continue). This exercises resume logic, not just file existence.
    if (opts.resumeSelftest && !resumeReloaded && iteration === 1) {
      const cp = JSON.parse(fs.readFileSync(path.join(runDir, 'checkpoint.json'), 'utf8'));
      done.clear();
      for (const [id, st] of Object.entries(cp.statuses || {})) {
        const tk = work.tasks.find((t) => t.id === id);
        if (tk) { tk.status = st; if (st === 'done') done.add(id); }
      }
      resumeReloaded = true;
      emit('interrupt_simulated', { afterIteration: 1, restoredFrom: `${runId}-iter1`, restoredDone: [...done] });
    }
  }

  // pick final output (dependents computed above)
  const finalTask = work.tasks.find((t) => t.final && t.status === 'done')
    || [...work.tasks].reverse().find((t) => t.status === 'done' && !dependents.has(t.id))
    || [...work.tasks].reverse().find((t) => t.status === 'done');
  const finalText = finalTask ? outputs[finalTask.id] : '';
  fs.writeFileSync(outPath, finalText || '');
  emit('output_saved', { path: path.relative(runDir, outPath) || outPath, bytes: Buffer.byteLength(finalText || ''), finalTask: finalTask ? finalTask.id : null });

  // verify BEFORE completed
  const checks = verify(finalText);
  emit('verification', { passed: checks.passed, checks: checks.detail });

  // measured checkpoint-resume evidence (only when a resume self-test was requested)
  if (opts.resumeSelftest) {
    emit('checkpoint_resume_checked', {
      passed: resumeReloaded && done.size === work.tasks.length,
      checkpointId: `${runId}-iter1`,
      resumedFrom: 'checkpoint.json',
      completedAfterResume: done.size === work.tasks.length,
    });
  }

  const inputTotal = ledger.uncached + ledger.cached;
  const metrics = {
    uncachedInputTokens: ledger.uncached, cachedInputTokens: ledger.cached, outputTokens: ledger.output,
    billableTokenEquivalent: billable(), costUsd: round(usd(), 5), durationMs: Date.now() - startedAt,
    cacheHitPct: inputTotal ? round((ledger.cached / inputTotal) * 100, 1) : 0,
    providerCalls: ledger.calls, tasksCompleted: done.size, tasksTotal: work.tasks.length,
    decision, spawnedAgents,
  };
  const status = stopped ? 'paused' : (done.size === work.tasks.length ? 'completed' : 'incomplete');
  emit(stopped ? 'paused' : 'completed', { status, verificationPassed: checks.passed, metrics });

  // comprehension digest — a human-readable summary derived from the event stream (no model call),
  // so an owner can READ what the run did rather than just trust it (anti passive-delegation).
  let digestPath = null;
  try {
    digestPath = writeDigest({ runDir, eventsPath, language: runLanguage || 'en', metrics });
    emit('digest_written', { path: path.relative(runDir, digestPath) });
  } catch (e) { emit('error', { reason: 'digest failed: ' + e.message }); }

  return { runId, runDir, eventsPath, outPath, digestPath, status, verification: checks, metrics, decision, spawnedAgents, waiting, outbox };
}

// Create a git worktree for a parallel task (real isolation for parallel writes). Returns the path,
// or null if cwd is not a git repo / worktree creation fails (caller falls back to a scratch dir).
function makeWorktree(cwd, runDir, taskId, emit) {
  const isRepo = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status === 0;
  if (!isRepo) return null;
  const wt = path.join(runDir, 'worktrees', taskId);
  const r = spawnSync('git', ['-C', cwd, 'worktree', 'add', '--detach', '--force', wt], { encoding: 'utf8' });
  if (r.status === 0) { emit('worktree_created', { taskId, path: path.relative(cwd, wt) }); return wt; }
  return null;
}

function verify(text) {
  const t = (text || '').toLowerCase();
  const detail = {
    hasVerdict: /verdict|kết luận|ket luan/.test(t),
    hasEvidence: /evidence|bằng chứng|bang chung|##\s*evidence/.test(t),
    hasAssumptions: /assumption|giả định|gia dinh/.test(t),
    hasNextActions: /next action|next step|hành động|hanh dong|##\s*next/.test(t),
    citesSources: /\[s\d\]/i.test(text || ''),
    notBlocked: !/\b(i am|i'm)\s+blocked\b|cannot read|can't read|không đọc được|khong doc duoc|bị kẹt|bi ket|missing sources|source is missing|sources are missing|permission denied/.test(t),
  };
  // pass = solved the task in the required shape and did not stall on a blocker
  const passed = detail.hasVerdict && (detail.hasNextActions || detail.hasEvidence) && detail.notBlocked;
  return { passed, detail };
}

const round = (n, d = 2) => { const p = 10 ** d; return Math.round(n * p) / p; };
