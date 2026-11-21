// SCROLL 2.5 -- §45 Interactive Multi-Turn Chat Session Runtime + §47.2 Tool Retriever
// + §48 Multimodal + §50 Async Workers + D16 Telemetry, Hash-Chained Audit, & Budget Governor.
//
// Bridges SCROLL's filesystem-native agent spec (IDENTITY/SOUL/hard-rules/USER/knowledge/memory/
// skills/style/grounding) with live multi-turn chat sessions: durable per-round JSONL transcripts,
// token-aware compaction & overflow recovery, portable §47.2 Tool Retriever with Room-Sticky
// group cache invariance, `AbortController` turn interrupt, multimodal attachments, and async workers.
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadAgent } from './scroll.js';
import { openUser, classifyTurn, isIdentityQuestion, checkAiDisclosure, applyAiLabel } from './user.js';
import { openKnowledge, formatKnowledgeBlock } from './knowledge.js';
import { openSkills } from './skills.js';
import { collectPrincipalSources, groundReply, verifyClaimsInvariant } from './grounding.js';
import { enforceStyle, hasBareNumericSlider } from './style.js';
import { pickProvider, approxTokens } from './providers.js';
import {
  acquireWriterLock,
  createEventLogger,
  createAuditChain,
  createBudgetGovernor,
  createApprovalStore,
} from './chat-telemetry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedExternalSafetyTemplate = null;
function loadExternalSafetyContract() {
  if (cachedExternalSafetyTemplate !== null) return cachedExternalSafetyTemplate;
  const tplPath = path.resolve(__dirname, '..', 'templates', 'external-safety-contract.md');
  try {
    cachedExternalSafetyTemplate = fs.readFileSync(tplPath, 'utf8').trim();
  } catch {
    cachedExternalSafetyTemplate = '';
  }
  return cachedExternalSafetyTemplate;
}

function escapeXmlAttr(val) {
  return String(val ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim()
    .slice(0, 120);
}

function formatTurnSpeakerTag({ sender, turnClassification, isGroup }) {
  const id = escapeXmlAttr(sender?.channelId || sender?.id || turnClassification?.speakerId || 'unknown');
  const name = escapeXmlAttr(sender?.name || '');
  const trust = escapeXmlAttr(turnClassification?.speakerTrust || 'external');
  const writeTools = turnClassification?.writeToolsAllowed ? 'true' : 'false';
  const groupFlag = isGroup ? 'true' : 'false';
  const nameAttr = name ? ` name="${name}"` : '';
  return `<turn_speaker id="${id}"${nameAttr} trust="${trust}" is_group="${groupFlag}" write_tools="${writeTools}" />`;
}

function isContextOverflowError(err) {
  if (!err) return false;
  if (err.code === 'CONTEXT_LENGTH_EXCEEDED') return true;
  const msg = String(err.message || err).toLowerCase();
  const status = Number(err.status || 0);
  if (status === 400 || status === 413 || status === 0) {
    return /context.?length|maximum.?context|prompt.?is.?too.?long|too many tokens|exceeds?.{0,25}token|input.{0,20}too.?long|context_window/.test(msg);
  }
  return false;
}

// ── §50 Async Background Worker Pool ──────────────────────────────────────────
export function createWorkerPool({ maxConcurrent = 3, onComplete = null } = {}) {
  const limit = Math.max(1, Number(maxConcurrent || 3));
  const jobs = new Map();
  const queue = [];
  let active = 0;

  function pump() {
    while (active < limit && queue.length > 0) {
      const entry = queue.shift();
      if (entry.cancelled) continue;
      active++;
      entry.status = 'running';
      entry.startedAt = new Date().toISOString();
      Promise.resolve()
        .then(() => entry.fn({ signal: entry.controller.signal, jobId: entry.id }))
        .then((output) => {
          entry.status = entry.controller.signal.aborted ? 'cancelled' : 'completed';
          entry.output = output;
          entry.finishedAt = new Date().toISOString();
          entry.resolve(snapshotJob(entry));
          if (typeof onComplete === 'function') {
            try { onComplete(snapshotJob(entry)); } catch { /* isolate callback */ }
          }
        })
        .catch((err) => {
          entry.status = entry.controller.signal.aborted ? 'cancelled' : 'failed';
          entry.error = String(err?.message || err);
          entry.finishedAt = new Date().toISOString();
          entry.resolve(snapshotJob(entry));
          if (typeof onComplete === 'function') {
            try { onComplete(snapshotJob(entry)); } catch { /* isolate callback */ }
          }
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  function snapshotJob(e) {
    return {
      id: e.id,
      label: e.label,
      chatId: e.chatId,
      status: e.status,
      createdAt: e.createdAt,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      output: e.output,
      error: e.error,
    };
  }

  function submit({ id = null, label = 'worker', chatId = null, fn } = {}) {
    if (typeof fn !== 'function') throw new Error('workerPool.submit: fn is required');
    const jobId = id || `wk_${crypto.randomBytes(4).toString('hex')}`;
    const controller = new AbortController();
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const entry = {
      id: jobId,
      label: String(label || jobId),
      chatId: chatId != null ? String(chatId) : null,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      output: undefined,
      error: null,
      cancelled: false,
      controller,
      fn,
      done,
      resolve: resolveDone,
    };
    jobs.set(jobId, entry);
    queue.push(entry);
    pump();
    return snapshotJob(entry);
  }

  function get(jobId) {
    const e = jobs.get(jobId);
    return e ? snapshotJob(e) : null;
  }

  function list({ chatId = null, status = null } = {}) {
    return [...jobs.values()]
      .filter((e) => (!chatId || e.chatId === String(chatId)) && (!status || e.status === status))
      .map(snapshotJob);
  }

  function cancel(jobId) {
    const e = jobs.get(jobId);
    if (!e) return { ok: false, reason: 'not_found' };
    if (e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled') {
      return { ok: false, reason: 'already_finished', status: e.status };
    }
    e.cancelled = true;
    e.controller.abort();
    if (e.status === 'queued') {
      e.status = 'cancelled';
      e.finishedAt = new Date().toISOString();
      e.resolve(snapshotJob(e));
    }
    return { ok: true, id: jobId };
  }

  async function waitFor(jobId) {
    const e = jobs.get(jobId);
    if (!e) throw new Error(`worker_not_found:${jobId}`);
    return e.done;
  }

  function close() {
    for (const e of jobs.values()) {
      if (e.status === 'queued' || e.status === 'running') cancel(e.id);
    }
  }

  return {
    submit,
    get,
    list,
    cancel,
    waitFor,
    close,
    get activeCount() { return active; },
    get queuedCount() { return queue.filter((q) => !q.cancelled).length; },
  };
}

// ── Session Transcript Store & Crash-Recovery Sanitizer ───────────────────────
function safeConvFileName(convId) {
  const clean = String(convId || 'default').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const hash = crypto.createHash('sha256').update(String(convId || 'default')).digest('hex').slice(0, 8);
  return `${clean}_${hash}.jsonl`;
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* ignore torn tail */ }
  }
  return out;
}

function appendJsonl(filePath, record) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', { mode: 0o600 });
}

function writeJsonlAtomic(filePath, records) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// Repairs crash-interrupted transcripts where an `assistant` message with `toolCalls`
// lacks matching `role: 'tool'` results (prevents HTTP 400 on Anthropic/OpenAI/Gemini).
export function sanitizeOrphanToolCalls(rows) {
  if (!Array.isArray(rows) || !rows.length) return { rows: [], repaired: 0 };
  const out = [];
  let repaired = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    if (row.role === 'assistant' && Array.isArray(row.toolCalls) && row.toolCalls.length > 0) {
      out.push(row);
      const expected = new Map();
      for (const tc of row.toolCalls) {
        if (tc && tc.id) expected.set(String(tc.id), tc.name || 'tool');
      }
      const seen = new Set();
      let j = i + 1;
      while (j < rows.length && rows[j]?.role === 'tool') {
        out.push(rows[j]);
        if (rows[j].toolCallId) seen.add(String(rows[j].toolCallId));
        j++;
      }
      for (const [tcId, tcName] of expected.entries()) {
        if (!seen.has(tcId)) {
          out.push({
            role: 'tool',
            toolCallId: tcId,
            name: tcName,
            ts: new Date().toISOString(),
            content: JSON.stringify({ error: 'interrupted_before_tool_result', recovered: true }),
            recovered: true,
          });
          repaired++;
        }
      }
      i = j - 1;
      continue;
    }
    // Drop orphaned leading/stray tool messages that have no preceding assistant toolCall
    if (row.role === 'tool') {
      const prev = out[out.length - 1];
      if (!prev || (prev.role !== 'tool' && !(prev.role === 'assistant' && Array.isArray(prev.toolCalls) && prev.toolCalls.length))) {
        repaired++;
        continue;
      }
    }
    out.push(row);
  }
  return { rows: out, repaired };
}

// Convert persisted history + current user message into strict provider-safe messages:
// - Maps compaction `system` records into `user` without creating consecutive `user` turns
//   (merges consecutive `user` text messages so Anthropic strict role alternation never 400s).
// - Preserves `assistant` toolCalls, `thinkingBlocks`, `thoughtSignature`, and `tool` messages.
export function buildProviderMessages(history, finalUserMessage) {
  const raw = [
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: finalUserMessage },
  ];
  const normalized = [];
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue;
    if (h.role === 'tool') {
      normalized.push({
        role: 'tool',
        toolCallId: h.toolCallId || h.id || 'call_0',
        name: h.name || 'tool',
        content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content ?? ''),
      });
      continue;
    }
    if (h.role === 'assistant') {
      const msg = {
        role: 'assistant',
        content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content ?? ''),
      };
      if (Array.isArray(h.toolCalls) && h.toolCalls.length) msg.toolCalls = h.toolCalls;
      if (Array.isArray(h.thinkingBlocks) && h.thinkingBlocks.length) msg.thinkingBlocks = h.thinkingBlocks;
      if (Array.isArray(h.rawParts) && h.rawParts.length) msg.rawParts = h.rawParts;
      normalized.push(msg);
      continue;
    }
    // `user` or `system` (compaction summary)
    const contentText = typeof h.content === 'string' ? h.content : JSON.stringify(h.content ?? '');
    const prev = normalized[normalized.length - 1];
    if (prev && prev.role === 'user' && typeof prev.content === 'string') {
      prev.content = prev.content ? `${prev.content}\n\n${contentText}` : contentText;
    } else {
      normalized.push({ role: 'user', content: contentText });
    }
  }
  return normalized;
}

// ── §48 Multimodal Attachment Normalizer ──────────────────────────────────────
async function processAttachments(attachments, hooks = null) {
  const images = [];
  const notes = [];
  if (!Array.isArray(attachments) || !attachments.length) return { images, notes };

  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    const kind = String(att.type || att.kind || '').toLowerCase();
    if (kind === 'image' || kind === 'photo' || /^image\//.test(att.mimeType || '')) {
      images.push({
        url: att.url || null,
        base64: att.base64 || null,
        path: att.path || null,
        mimeType: att.mimeType || 'image/jpeg',
        caption: att.caption || null,
      });
      if (hooks && typeof hooks.describeImage === 'function') {
        const desc = await hooks.describeImage(att);
        if (desc) notes.push(`[Image description] ${String(desc).trim()}`);
      } else if (att.caption) {
        notes.push(`[Image caption] ${String(att.caption).trim()}`);
      }
    } else if (kind === 'audio' || kind === 'voice' || /^audio\//.test(att.mimeType || '')) {
      if (att.transcript) {
        notes.push(`[Voice transcript] ${String(att.transcript).trim()}`);
      } else if (hooks && typeof hooks.transcribeAudio === 'function') {
        const transcript = await hooks.transcribeAudio(att);
        if (transcript) notes.push(`[Voice transcript] ${String(transcript).trim()}`);
      } else {
        notes.push('[Voice attachment received; no STT hook configured]');
      }
    } else if (kind === 'document' || kind === 'file') {
      if (hooks && typeof hooks.extractDocument === 'function') {
        const extracted = await hooks.extractDocument(att);
        if (extracted) notes.push(`[Document: ${att.name || 'file'}]\n${String(extracted).slice(0, 6000)}`);
      } else if (att.text) {
        notes.push(`[Document: ${att.name || 'file'}]\n${String(att.text).slice(0, 6000)}`);
      } else if (att.path && fs.existsSync(att.path)) {
        const preview = fs.readFileSync(att.path, 'utf8').slice(0, 6000);
        notes.push(`[Document: ${att.name || path.basename(att.path)}]\n${preview}`);
      }
    }
  }
  return { images, notes };
}

function deterministicCompactionSummary(turns) {
  const lines = [];
  for (const t of turns) {
    if (t.role === 'tool') continue;
    const role = t.role === 'assistant' ? 'Assistant' : (t.senderLabel || 'User');
    const txt = String(t.content || '').replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    lines.push(`- ${role}: ${txt.slice(0, 220)}${txt.length > 220 ? '...' : ''}`);
  }
  return `[Earlier conversation summary (${turns.length} turns)]\n${lines.slice(-20).join('\n')}`;
}

function estimateHistoryTokens(rows) {
  let chars = 0;
  for (const r of rows || []) {
    chars += String(r.content || '').length;
    if (Array.isArray(r.toolCalls)) chars += JSON.stringify(r.toolCalls).length;
  }
  return Math.ceil(chars / 4);
}

// ── §45 Interactive Multi-Turn Chat Session Runtime ───────────────────────────
export function createChatSessionRuntime({
  agentName,
  cwd = process.cwd(),
  deploymentDir = null,
  stateDir = null,
  provider = null,
  providerName = 'auto',
  model = null,
  authStore = null,
  tools = null,
  skillsRegistry = null,
  enableSkills = true,
  voiceHooks = null,
  memoryStore = null,
  memoryTracker = null,
  knowledgeIndex = null,
  scheduler = null,
  workerPool = null,
  multimodalHooks = null,
  channelMap = null,
  maxToolRounds = 6,
  compactAtChars = 48_000,
  compactAtTokens = null,
  keepRecentTurns = 12,
  aiLabel = '[AI Assistant]',
  dateOrder = 'dmy',
  userFile = null,
  knowledgeDir = null,
  cacheTtl = null,
  reuseProviderThreads = true,
  acquireLock = true,
  strictToolSupport = true,
  budget = null,
  eventLogger = null,
  auditChain = null,
  approvalStore = null,
} = {}) {
  if (!agentName) throw new Error('createChatSessionRuntime: agentName is required');
  const rootDir = path.resolve(deploymentDir || cwd);
  const absStateDir = stateDir ? path.resolve(stateDir) : null;
  const sessionsDir = absStateDir ? path.join(absStateDir, 'sessions', agentName) : null;

  // D16 Single-writer PID lock on stateDir (prevents dual-daemon corruption)
  const writerLock = (absStateDir && acquireLock !== false)
    ? acquireWriterLock(path.join(absStateDir, 'locks', String(agentName).replace(/[^A-Za-z0-9_.-]/g, '_')), { owner: `scroll-chat:${agentName}` })
    : null;

  const activeProvider = provider || pickProvider(providerName, { model, authStore, cwd: rootDir });

  // D16 Telemetry (`events.jsonl`), Hash-Chained Audit (`audit.jsonl`), Approvals
  const events = eventLogger || createEventLogger({
    filePath: absStateDir ? path.join(absStateDir, 'events.jsonl') : null,
  });
  const audit = auditChain || createAuditChain({
    filePath: absStateDir ? path.join(absStateDir, 'audit.jsonl') : null,
  });
  const approvals = approvalStore || createApprovalStore({
    dir: absStateDir ? path.join(absStateDir, 'approvals') : null,
  });

  let agent = null;
  let userDoc = null;
  let kb = knowledgeIndex || null;
  let skills = skillsRegistry || null;
  let skillsIndexText = '';
  let budgetGovernor = null;

  const memHistory = new Map();
  const inflightControllers = new Map();
  const convQueues = new Map();
  const providerThreads = new Map();
  const hydratedToolsByConv = new Map();
  const cacheStats = { hits: 0, misses: 0, threadReuses: 0, threadResets: 0, lastPrefixHash: null };

  function buildBudgetGovernor() {
    const idBudget = agent?.frontmatter?.budget && typeof agent.frontmatter.budget === 'object'
      ? agent.frontmatter.budget
      : {};
    const merged = { ...idBudget, ...(budget && typeof budget === 'object' ? budget : {}) };
    return createBudgetGovernor({
      maxInputTokensPerTurn: merged.maxInputTokensPerTurn ?? merged.max_input_tokens_per_turn ?? null,
      maxDailyUsd: merged.maxDailyUsd ?? merged.max_daily_usd ?? null,
      maxConversationDailyUsd: merged.maxConversationDailyUsd ?? merged.max_conversation_daily_usd ?? null,
      maxToolCallsPerTurn: merged.maxToolCallsPerTurn ?? merged.max_tool_calls_per_turn ?? 24,
      maxIdenticalToolRepeats: merged.maxIdenticalToolRepeats ?? merged.max_identical_tool_repeats ?? 3,
      maxConsecutiveToolErrors: merged.maxConsecutiveToolErrors ?? merged.max_consecutive_tool_errors ?? 4,
      pricing: merged.pricing || undefined,
      stateFile: absStateDir ? path.join(absStateDir, `budget-${String(agentName).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`) : null,
    });
  }

  function reload() {
    agent = loadAgent(agentName, rootDir);
    userDoc = openUser({ cwd: rootDir, file: userFile });
    if (!knowledgeIndex) {
      kb = openKnowledge({ cwd: rootDir, dir: knowledgeDir });
    } else {
      kb = knowledgeIndex;
    }

    // §34 Skills wiring (frozen Region A `<available_skills>` + `skill_list`/`skill_view` tools)
    skillsIndexText = '';
    if (skillsRegistry) {
      skills = skillsRegistry;
    } else if (enableSkills !== false) {
      try {
        skills = openSkills({ cwd: rootDir, agent: agent.name, identity: agent.frontmatter });
      } catch {
        skills = null;
      }
    } else {
      skills = null;
    }
    if (skills) {
      try {
        const idx = typeof skills.index === 'function' ? skills.index() : null;
        if (idx && idx.text) {
          skillsIndexText = String(idx.text).trim();
        }
        if (tools && typeof tools.registerSkills === 'function' && (!tools.has || !tools.has('skill_list'))) {
          if (idx && idx.text) tools.registerSkills(skills);
        }
      } catch { /* ignore skills init error */ }
    }

    budgetGovernor = buildBudgetGovernor();

    if (providerThreads.size > 0) {
      cacheStats.threadResets += providerThreads.size;
      providerThreads.clear();
    }
    return {
      agentName: agent.name,
      userActive: Boolean(userDoc && userDoc.active),
      knowledgeChunks: kb && kb.active ? kb.chunks.length : 0,
      skillsVisible: skills && typeof skills.names === 'function' ? skills.names().length : 0,
    };
  }

  reload();

  function sessionFile(conversationId) {
    return sessionsDir ? path.join(sessionsDir, safeConvFileName(conversationId)) : null;
  }

  function loadHistory(conversationId) {
    if (memHistory.has(conversationId)) return memHistory.get(conversationId);
    const file = sessionFile(conversationId);
    const rawRows = file ? readJsonl(file) : [];
    const { rows, repaired } = sanitizeOrphanToolCalls(rawRows);
    if (repaired > 0 && file) {
      writeJsonlAtomic(file, rows);
      events.emit('session.recovered', { conversationId, repairedOrphanTools: repaired });
    }
    memHistory.set(conversationId, rows);
    return rows;
  }

  function getHistory(conversationId) {
    return [...loadHistory(conversationId)];
  }

  function getHydratedMap(conversationId) {
    const key = String(conversationId);
    if (!hydratedToolsByConv.has(key)) hydratedToolsByConv.set(key, new Map());
    return hydratedToolsByConv.get(key);
  }

  function clearProviderThread(conversationId = null) {
    if (!conversationId) {
      const n = providerThreads.size;
      providerThreads.clear();
      cacheStats.threadResets += n;
      return { ok: true, cleared: n };
    }
    const existed = providerThreads.delete(String(conversationId));
    if (existed) cacheStats.threadResets++;
    return { ok: true, cleared: existed ? 1 : 0 };
  }

  function clearSession(conversationId) {
    memHistory.set(conversationId, []);
    hydratedToolsByConv.delete(String(conversationId));
    clearProviderThread(conversationId);
    const file = sessionFile(conversationId);
    if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
    try { memoryTracker?.onSessionReset?.(conversationId); } catch { /* ignore */ }
    return { ok: true, conversationId };
  }

  function scrubHistory(conversationId, needles = []) {
    const clean = (needles || []).map((n) => String(n || '').trim().toLowerCase()).filter((n) => n.length >= 3);
    if (!clean.length) return { ok: true, scrubbed: 0 };
    const targets = conversationId ? [String(conversationId)] : [...memHistory.keys()];
    if (!conversationId && sessionsDir && fs.existsSync(sessionsDir)) {
      for (const f of fs.readdirSync(sessionsDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const abs = path.join(sessionsDir, f);
        const rows = readJsonl(abs);
        let touched = false;
        const next = rows.map((row) => {
          let c = String(row.content || '');
          let rowTouched = false;
          for (const n of clean) {
            const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
            if (re.test(c)) { c = c.replace(re, '[forgotten]'); rowTouched = true; }
          }
          if (rowTouched) { touched = true; return { ...row, content: c }; }
          return row;
        });
        if (touched) writeJsonlAtomic(abs, next);
      }
    }
    let scrubbed = 0;
    for (const cid of targets) {
      const arr = loadHistory(cid);
      let touched = false;
      const next = arr.map((row) => {
        let c = String(row.content || '');
        let rowTouched = false;
        for (const n of clean) {
          const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
          if (re.test(c)) { c = c.replace(re, '[forgotten]'); rowTouched = true; }
        }
        if (rowTouched) { touched = true; scrubbed++; return { ...row, content: c }; }
        return row;
      });
      if (touched) {
        memHistory.set(cid, next);
        const file = sessionFile(cid);
        if (file) writeJsonlAtomic(file, next);
        clearProviderThread(cid);
      }
    }
    if (!conversationId && scrubbed > 0) clearProviderThread(null);
    return { ok: true, scrubbed };
  }

  function appendHistory(conversationId, record) {
    const arr = loadHistory(conversationId);
    arr.push(record);
    const file = sessionFile(conversationId);
    if (file) appendJsonl(file, record);
  }

  async function compactSession(conversationId, { summarizer = null, keep = keepRecentTurns, meta = null } = {}) {
    const arr = loadHistory(conversationId);
    if (arr.length <= keep) return { compacted: false, turns: arr.length };

    // Choose split point so we NEVER split an `assistant` (toolCalls) from its `role: 'tool'` results!
    let splitIdx = Math.max(1, arr.length - keep);
    while (splitIdx < arr.length && arr[splitIdx]?.role === 'tool') {
      splitIdx++;
    }
    if (splitIdx >= arr.length) {
      splitIdx = Math.max(1, arr.length - keep);
      while (splitIdx > 0 && arr[splitIdx]?.role === 'tool') splitIdx--;
      if (splitIdx > 0 && arr[splitIdx - 1]?.role === 'assistant' && Array.isArray(arr[splitIdx - 1]?.toolCalls)) {
        splitIdx--;
      }
    }
    if (splitIdx <= 0) return { compacted: false, turns: arr.length };

    const head = arr.slice(0, splitIdx);
    const tail = arr.slice(splitIdx);
    if (!head.length) return { compacted: false, turns: arr.length };

    // §32.2 pre-compaction flush
    if (memoryTracker && typeof memoryTracker.onBeforeCompact === 'function') {
      try {
        await memoryTracker.onBeforeCompact({ conversationId, turnsToCompact: head, ...(meta || {}) });
      } catch { /* never block compaction on memory flush error */ }
    }
    const summaryText = typeof summarizer === 'function'
      ? String(await summarizer(head) || '').trim()
      : deterministicCompactionSummary(head);
    const next = [
      { role: 'system', kind: 'compaction', ts: new Date().toISOString(), content: summaryText, compactedTurns: head.length },
      ...tail,
    ];
    memHistory.set(conversationId, next);
    clearProviderThread(conversationId);
    const file = sessionFile(conversationId);
    if (file) writeJsonlAtomic(file, next);
    events.emit('session.compacted', { conversationId, compactedTurns: head.length, remainingTurns: next.length });
    return { compacted: true, compactedTurns: head.length, remainingTurns: next.length };
  }

  function abortTurn(conversationId) {
    const ctrl = inflightControllers.get(conversationId);
    if (!ctrl) return { ok: false, active: false };
    ctrl.abort();
    inflightControllers.delete(conversationId);
    return { ok: true, aborted: true };
  }

  // Per-conversation FIFO mutex so concurrent sendTurn() on same convId never corrupt history or threads
  function withConvMutex(convKey, fn) {
    const prev = convQueues.get(convKey) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    const tail = prev.then(() => next);
    convQueues.set(convKey, tail);
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
        if (convQueues.get(convKey) === tail) {
          convQueues.delete(convKey);
        }
      }
    });
  }

  // §13 Strict Stable Prefix Builder (Region A):
  // ONLY byte-stable sections belong in `systemPrompt` so provider prompt-caching hits across turns.
  // In group rooms (`isGroup === true`), Room-Sticky posture renders `USER.md` & external safety
  // contract for the room audience (`external`), NEVER flipping when Owner/Teammate/Guest alternate!
  function buildSystemPrompt({
    roomAudience,
    stableMemoryBlock,
    voiceStableBlock,
    availableToolsIndexText = '',
  }) {
    const parts = [];
    const fm = agent.frontmatter || {};
    parts.push(`# Agent Identity\nName: ${fm.name || agent.name}\nTitle: ${fm.title || agent.name}`);
    if (agent.soul) parts.push(`# Soul & Persona\n${agent.soul.trim()}`);
    if (agent.hardRules) parts.push(`# Hard Rules (Non-Negotiable)\n${agent.hardRules.trim()}`);
    if (agent.lessons) {
      const cleanedLessons = String(agent.lessons)
        .split('\n')
        .filter((ln) => !/^<!--.*-->$/.test(ln.trim()))
        .join('\n')
        .trim();
      if (cleanedLessons && /^[-*#]/m.test(cleanedLessons) && cleanedLessons.length > 24) {
        parts.push(`# Procedural Lessons (L5 · §7)\n${cleanedLessons.slice(0, 4000)}`);
      }
    }
    if (userDoc && userDoc.active) {
      const rendered = userDoc.render({ audience: roomAudience === 'external' ? 'external' : 'internal' });
      if (rendered && rendered.text) parts.push(rendered.text);
    }
    if (voiceStableBlock) {
      if (hasBareNumericSlider(voiceStableBlock)) {
        throw new Error('voice_hook_bare_numeric_slider_rejected (§43)');
      }
      parts.push(String(voiceStableBlock).trim());
    }
    if (stableMemoryBlock) parts.push(String(stableMemoryBlock).trim());
    if (skillsIndexText) parts.push(skillsIndexText);
    if (availableToolsIndexText) parts.push(availableToolsIndexText);
    if (roomAudience === 'external') {
      const safetyContract = loadExternalSafetyContract();
      if (safetyContract) parts.push(safetyContract);
    }
    // Note (SCROLL 2.5): duplicate `# Available Tools` prose block removed — tool schemas are
    // delivered via structured `dynamicTools` / `tools` and (when deferred) `<available_tools>`!
    return parts.filter(Boolean).join('\n\n');
  }

  async function executeSendTurn({
    conversationId = 'default',
    text = '',
    sender = null,
    participants = null,
    isGroup = false,
    channel = 'chat',
    messageId = null,
    messageIds = null,
    chatTitle = null,
    attachments = [],
    contextBlocks = [],
    model: callModel = null,
    effort = null,
    toolsAllow = null,
    delegatedTools = null,
    approved = false,
    approvalTokenId = null,
    onDelta = null,
    signal = null,
    requestApproval = null,
    summarizer = null,
    extraPrincipalSources = [],
  } = {}) {
    if (!activeProvider.ready) {
      throw new Error(`provider_not_ready:${activeProvider.name}:${activeProvider.missing || 'not ready'}`);
    }
    const t0 = Date.now();
    const convKey = String(conversationId);
    const traceId = `tr_${crypto.randomBytes(6).toString('hex')}`;

    const controller = new AbortController();
    inflightControllers.set(convKey, controller);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      // 1. §42 Turn Classification (Internal vs External + Group Lowest-Trust Wall)
      const turnClassification = classifyTurn(userDoc, {
        sender,
        participants,
        isGroup,
        channelMap,
        chatSubject: convKey,
      });

      // Room-Sticky Audience for Region A cache invariance in group rooms (G8)
      const roomAudience = isGroup ? 'external' : (turnClassification.contentAudience === 'external' ? 'external' : 'internal');

      events.emit('turn.start', {
        traceId,
        agent: agent.name,
        conversationId: convKey,
        channel,
        isGroup: Boolean(isGroup),
        speakerTrust: turnClassification.speakerTrust,
        contentAudience: turnClassification.contentAudience,
        roomAudience,
      });

      // 2. §48 Multimodal attachments
      const mm = await processAttachments(attachments, multimodalHooks);
      const userContent = [String(text || '').trim(), ...mm.notes].filter(Boolean).join('\n\n');

      // 3. §31-§33 Subject Memory
      let subjectSid = null;
      let memorySessionId = null;
      let turnRef = null;
      let memoryContext = null;
      let memoryBlock = '';
      let dynamicMemoryBlock = '';
      if (memoryTracker && typeof memoryTracker.recordAndLoad === 'function') {
        const tracked = await memoryTracker.recordAndLoad({
          conversationId: convKey,
          text: userContent,
          sender,
          participants,
          isGroup,
          channel,
          messageId,
          messageIds,
          chatTitle,
          turnClassification,
        });
        if (tracked) {
          subjectSid = tracked.subjectSid || null;
          memorySessionId = tracked.memorySessionId || null;
          turnRef = tracked.turnRef || null;
          memoryContext = tracked.context || null;
          memoryBlock = tracked.stableMemoryBlock !== undefined ? (tracked.stableMemoryBlock || '') : (tracked.memoryBlock || '');
          dynamicMemoryBlock = tracked.dynamicMemoryBlock || '';
        }
      } else if (memoryStore && turnClassification.memoryScope === 'principal_and_team') {
        const alias = (sender && (sender.channelId || sender.id))
          ? `${channel}:${sender.channelId || sender.id}`
          : `chat:${convKey}`;
        subjectSid = memoryStore.resolve(alias);
        if (!subjectSid) {
          subjectSid = memoryStore.createSubject({ kind: isGroup ? 'group' : 'person', label: sender?.name || convKey });
          memoryStore.link(alias, subjectSid);
        }
        const existingSessions = memoryStore.listSessions(subjectSid);
        memorySessionId = existingSessions.at(-1) || memoryStore.openSession(subjectSid, { surface: channel });
        try {
          const rec = memoryStore.appendTurn(subjectSid, memorySessionId, { role: 'user', speaker: subjectSid, text: userContent, surface: channel });
          turnRef = rec.ref;
        } catch {
          memorySessionId = memoryStore.openSession(subjectSid, { surface: channel });
          const rec = memoryStore.appendTurn(subjectSid, memorySessionId, { role: 'user', speaker: subjectSid, text: userContent, surface: channel });
          turnRef = rec.ref;
        }
        const snap = memoryStore.snapshot(subjectSid);
        if (snap && !snap.denied && snap.text) memoryBlock = snap.text;
      }

      // 4. §34 Mid-session skills refresh (notice goes to volatile Region C — Region A stays byte-frozen!)
      let skillsRefreshNotice = '';
      if (skills && typeof skills.refresh === 'function') {
        try {
          const ref = skills.refresh({ rebuild: false });
          if (ref && ref.notice) skillsRefreshNotice = ref.notice;
        } catch { /* ignore */ }
      }

      // 5. §44 Knowledge Retrieval
      const history = loadHistory(convKey);
      const prevUserTurn = [...history].reverse().find((h) => h.role === 'user');
      const kbResult = kb && kb.active
        ? kb.retrieve(userContent, { prevQuery: prevUserTurn ? prevUserTurn.content : '' })
        : { hits: [], chunks: [] };

      // 6. Voice Hook 1: beforeTurn
      let voiceBefore = null;
      if (voiceHooks && typeof voiceHooks.beforeTurn === 'function') {
        voiceBefore = await voiceHooks.beforeTurn({
          conversationId: convKey,
          text: userContent,
          rawText: text,
          sender,
          isGroup,
          channel,
          turnClassification,
          history,
          contextBlocks,
        });
      }

      // 7. §47.2 Tool Surface (Catalog C / Visible V / Executable E + Room-Sticky in groups)
      let toolSurface = {
        mode: 'direct',
        activeSchemas: [],
        availableToolsIndex: { text: '', hash: 'none', deferredCount: 0, estimatedTokens: 0, tier: 'none' },
        deferredNames: new Set(),
      };
      if (tools) {
        if (typeof tools.getPromptSurface === 'function') {
          toolSurface = tools.getPromptSurface({
            allowWriteTools: turnClassification.writeToolsAllowed,
            delegatedTools,
            turnToolsAllow: toolsAllow,
            roomSticky: Boolean(isGroup),
          });
        } else if (typeof tools.listSchemas === 'function') {
          const allowSetFallback = Array.isArray(toolsAllow) ? new Set(toolsAllow.map(String)) : null;
          toolSurface.activeSchemas = tools
            .listSchemas({ allowWriteTools: turnClassification.writeToolsAllowed, delegatedTools })
            .filter((s) => !allowSetFallback || allowSetFallback.has(s.name));
        }
      }
      const toolSchemas = toolSurface.activeSchemas;

      // Fail-closed check when provider does NOT support structured tool calling
      if (toolSchemas.length > 0 && activeProvider.supportsTools === false) {
        if (strictToolSupport !== false) {
          throw new Error(`provider_does_not_support_tools:${activeProvider.name}`);
        }
        events.emit('provider.tools_unsupported', { provider: activeProvider.name, toolCount: toolSchemas.length });
      }

      // 8. §13 Strict Stable Prefix (Region A) vs Volatile Suffix (Region C)
      const hasSplitVoice = Boolean(voiceBefore && (voiceBefore.stableSystemBlock !== undefined || voiceBefore.volatileTurnBlock !== undefined));
      const voiceStableBlock = hasSplitVoice
        ? (voiceBefore.stableSystemBlock || '')
        : (voiceBefore?.systemBlock || voiceBefore?.promptPrefix || '');
      const voiceVolatileBlock = hasSplitVoice ? (voiceBefore.volatileTurnBlock || '') : '';
      if (voiceVolatileBlock && hasBareNumericSlider(voiceVolatileBlock)) {
        throw new Error('voice_hook_bare_numeric_slider_rejected (§43)');
      }

      const systemPrompt = buildSystemPrompt({
        roomAudience,
        stableMemoryBlock: memoryBlock,
        voiceStableBlock,
        availableToolsIndexText: toolSurface.availableToolsIndex?.text || '',
      });

      const knowledgeBlock = Array.isArray(kbResult.chunks) && kbResult.chunks.length
        ? formatKnowledgeBlock(kbResult.chunks, { hash: kb?.hash || null })
        : '';
      const extraContextList = [
        ...(Array.isArray(contextBlocks) ? contextBlocks : []),
        ...(voiceBefore && Array.isArray(voiceBefore.extraContextBlocks) ? voiceBefore.extraContextBlocks : []),
      ].map((b) => String(b || '').trim()).filter(Boolean);

      const speakerTag = (isGroup || sender)
        ? formatTurnSpeakerTag({ sender, turnClassification, isGroup })
        : '';

      const volatileSuffixParts = [
        speakerTag,
        skillsRefreshNotice,
        knowledgeBlock,
        voiceVolatileBlock ? String(voiceVolatileBlock).trim() : '',
        ...extraContextList,
        dynamicMemoryBlock ? String(dynamicMemoryBlock).trim() : '',
      ].filter(Boolean);

      const finalUserMessage = volatileSuffixParts.length
        ? `${volatileSuffixParts.join('\n\n')}\n\n${userContent}`
        : userContent;

      // Pre-flight token-aware compaction (prevents overflow before calling provider!)
      const preflightTokens = approxTokens(systemPrompt) + estimateHistoryTokens(history) + approxTokens(finalUserMessage);
      const tokenLimit = compactAtTokens != null ? Number(compactAtTokens) : Math.ceil(Number(compactAtChars || 48_000) / 3);
      let compacted = false;
      if (history.length > keepRecentTurns && preflightTokens > tokenLimit) {
        const pre = await compactSession(convKey, {
          summarizer,
          meta: { sender, isGroup, channel, memoryContext },
        });
        if (pre.compacted) compacted = true;
      }

      const activeHistory = loadHistory(convKey);
      let messages = buildProviderMessages(activeHistory, finalUserMessage);

      const resolvedModel = callModel || model || agent.frontmatter?.model?.primary || undefined;
      const modelSig = resolvedModel || activeProvider.model || 'default';
      // Canonical schema hash includes both tool names & schemaHashes so any schema drift resets thread cleanly
      const toolSig = toolSchemas.map((t) => `${t.name}:${t.schemaHash || ''}`).join(',');
      const prefixHash = crypto.createHash('sha256')
        .update(`${systemPrompt}\n---\n${toolSig}\n---\n${toolSurface.availableToolsIndex?.hash || ''}\n---\n${roomAudience}\n---\n${modelSig}`)
        .digest('hex')
        .slice(0, 16);
      cacheStats.lastPrefixHash = prefixHash;

      const cacheKey = `${agent.name}:${convKey}`;
      const canReuseThread = Boolean(reuseProviderThreads && activeProvider.name === 'codex-app-server');
      let threadReused = false;

      // Persist incoming user turn BEFORE tool rounds for crash-safe durability
      const turnStartIso = new Date().toISOString();
      appendHistory(convKey, {
        role: 'user',
        ts: turnStartIso,
        senderId: sender?.id || sender?.channelId || null,
        senderLabel: sender?.name || null,
        content: userContent,
      });

      // Buffer streaming deltas on external grounded turns so ungrounded text NEVER leaks live!
      const mustBufferStream = Boolean(turnClassification.groundingRequired && typeof onDelta === 'function');
      const bufferedDeltas = [];
      const effectiveOnDelta = typeof onDelta === 'function'
        ? (mustBufferStream ? (d) => bufferedDeltas.push(String(d || '')) : onDelta)
        : null;

      // 9. §47 Live Multi-Round Tool Loop
      const toolTraces = [];
      const toolOutputsText = [];
      const trustedToolOutputsText = [];
      const principalMaySay = userDoc?.active ? (userDoc.sections?.maySay || '') : '';
      const hydratedTools = getHydratedMap(convKey);
      const turnTracker = budgetGovernor.createTurnTracker();
      let rawReply = '';
      let lastRes = null;
      let turnSideEffects = 0;
      let overflowRetried = false;
      let totalUsage = { uncachedInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, providerTotalTokens: 0 };

      const runGatedTool = async ({ id, name, arguments: argsObj }, round) => {
        // D16 Budget & Loop/Error Circuit Breaker check BEFORE tool execution (including Codex RPC callbacks!)
        const budgetChk = budgetGovernor.checkBeforeCall({ conversationId: convKey });
        if (!budgetChk.ok) {
          const blocked = { ok: false, decision: 'deny', reason: budgetChk.reason, detail: budgetChk };
          toolTraces.push({ round, id, name, arguments: argsObj, result: blocked });
          audit.append({ traceId, conversationId: convKey, kind: 'budget_deny', tool: name, reason: budgetChk.reason });
          events.emit('budget.blocked', { traceId, conversationId: convKey, tool: name, reason: budgetChk.reason });
          return { ok: false, text: JSON.stringify(blocked), execRes: blocked, circuitBroken: budgetChk };
        }
        const loopChk = turnTracker.beforeToolCall(name, argsObj || {});
        if (!loopChk.ok) {
          const blocked = { ok: false, decision: 'deny', reason: loopChk.reason, detail: loopChk };
          toolTraces.push({ round, id, name, arguments: argsObj, result: blocked });
          audit.append({ traceId, conversationId: convKey, kind: 'circuit_breaker', tool: name, reason: loopChk.reason });
          events.emit('circuit_breaker.tripped', { traceId, conversationId: convKey, tool: name, reason: loopChk.reason });
          return { ok: false, text: JSON.stringify(blocked), execRes: blocked, circuitBroken: loopChk };
        }

        // Provenance-safe grounding: NEVER allow untrusted web_fetch/web_search or external group input
        // to launder factual claims for financial/destructive tool arguments!
        const ownerUserText = (!isGroup && turnClassification.speakerTrust === 'internal') ? userContent : '';
        const trustedGroundingSources = [
          ownerUserText,
          ...kbResult.chunks,
          principalMaySay,
          ...(Array.isArray(extraPrincipalSources) ? extraPrincipalSources : []),
          ...trustedToolOutputsText,
        ].filter(Boolean).join('\n');

        const execRes = await tools.executeTool(name, argsObj || {}, {
          turnClassification,
          delegatedTools,
          toolsAllow,
          userDoc,
          approvalStore: approvals,
          approvalTokenId,
          hydratedTools,
          deferredNames: toolSurface.deferredNames,
          trustedGroundingSources,
          groundingSources: trustedGroundingSources,
          subjectSid,
          memorySessionId,
          turnRef,
          memoryContext,
          chatId: convKey,
          sender,
          approved,
          requestApproval,
          signal: controller.signal,
          spawnWorkerFn: async (taskText, wCtx = {}) => {
            const wBudget = budgetGovernor.checkBeforeCall({
              conversationId: convKey,
              estimatedInputTokens: approxTokens(systemPrompt) + approxTokens(taskText),
            });
            if (!wBudget.ok) throw new Error(wBudget.reason);
            const wRes = await activeProvider.generate(taskText, {
              model: resolvedModel,
              system: systemPrompt,
              cachePrefix: systemPrompt,
              cacheKey: `${cacheKey}:worker`,
              cacheTtl,
              signal: wCtx.signal || controller.signal,
              authStore,
            });
            budgetGovernor.recordUsage({
              conversationId: convKey,
              usage: wRes.usage,
              fallbackInputTokens: approxTokens(systemPrompt) + approxTokens(taskText),
            });
            return { text: wRes.text, usage: wRes.usage };
          },
        });

        // Track side effects so Codex thread retry NEVER replays a turn after a mutating tool ran!
        if (execRes.ok && execRes.tier && execRes.tier !== 'read_only') {
          turnSideEffects++;
        }

        const cbRes = turnTracker.afterToolResult(Boolean(execRes.ok));
        toolTraces.push({ round, id, name, arguments: argsObj, result: execRes });

        audit.append({
          traceId,
          conversationId: convKey,
          kind: 'tool_call',
          tool: name,
          tier: execRes.tier || null,
          decision: execRes.decision || (execRes.ok ? 'allow' : 'deny'),
          ok: Boolean(execRes.ok),
          reason: execRes.reason || execRes.error || null,
          approver: execRes.approver || null,
        });
        events.emit('tool.call', {
          traceId,
          conversationId: convKey,
          tool: name,
          tier: execRes.tier || null,
          decision: execRes.decision || null,
          ok: Boolean(execRes.ok),
          breakerTripped: !cbRes.ok ? cbRes.reason : null,
        });

        const serialized = JSON.stringify(
          execRes.ok
            ? execRes.output
            : { error: execRes.error || execRes.reason, decision: execRes.decision, validationErrors: execRes.validationErrors }
        );
        if (execRes.ok) {
          toolOutputsText.push(serialized);
          if (execRes.trustedOutput !== false) {
            trustedToolOutputsText.push(serialized);
          }
        }
        return { ok: execRes.ok, text: serialized.slice(0, 12_000), execRes, circuitBroken: !cbRes.ok ? cbRes : null };
      };

      const maxRounds = Math.max(1, Number(maxToolRounds || 6));
      for (let round = 0; round < maxRounds; round++) {
        if (controller.signal.aborted) {
          return {
            text: '',
            bubbles: [],
            rawText: '',
            aborted: true,
            toolTraces,
            turnClassification,
            knowledgeHits: kbResult.hits,
            usage: totalUsage,
            durationMs: Date.now() - t0,
          };
        }

        const estRoundTokens = approxTokens(systemPrompt) + estimateHistoryTokens(messages);
        const modelBudgetChk = budgetGovernor.checkBeforeCall({
          conversationId: convKey,
          estimatedInputTokens: estRoundTokens,
        });
        if (!modelBudgetChk.ok) {
          audit.append({ traceId, conversationId: convKey, kind: 'budget_halt', reason: modelBudgetChk.reason });
          events.emit('budget.halted', { traceId, conversationId: convKey, reason: modelBudgetChk.reason });
          const err = new Error(modelBudgetChk.reason);
          err.code = 'BUDGET_EXCEEDED';
          err.budget = modelBudgetChk;
          throw err;
        }

        const buildGenOpts = (msgs) => ({
          model: resolvedModel,
          system: systemPrompt,
          cachePrefix: systemPrompt,
          cacheKey,
          cacheTtl,
          messages: msgs,
          tools: toolSchemas.length && activeProvider.supportsTools !== false ? toolSchemas : undefined,
          onToolCall: tools && toolSchemas.length && activeProvider.supportsTools !== false
            ? ({ tool, arguments: argsObj, callId }) => runGatedTool({ id: callId, name: tool, arguments: argsObj }, round)
            : undefined,
          images: round === 0 && mm.images.length ? mm.images : undefined,
          effort,
          onDelta: effectiveOnDelta,
          signal: controller.signal,
          authStore,
        });

        let res;
        const invokeProviderOnce = async (msgs) => {
          const genOpts = buildGenOpts(msgs);
          if (canReuseThread && round === 0) {
            const cached = providerThreads.get(convKey);
            const canContinue = Boolean(cached && cached.prefixHash === prefixHash && cached.model === modelSig);
            if (cached && !canContinue) {
              providerThreads.delete(convKey);
              cacheStats.threadResets++;
            }
            if (canContinue) {
              try {
                const r = await activeProvider.generate(userContent, {
                  ...genOpts,
                  threadId: cached.threadId,
                  ephemeral: false,
                  messages: [{ role: 'user', content: finalUserMessage }],
                });
                cached.turnsReused = (cached.turnsReused || 0) + 1;
                cacheStats.threadReuses++;
                threadReused = true;
                return r;
              } catch (err) {
                if (controller.signal.aborted || err?.status === 401 || err?.status === 429) throw err;
                // Live Bug #3 fix: NEVER auto-retry a failed turn if a mutating tool side-effect already executed!
                if (turnSideEffects > 0) {
                  providerThreads.delete(convKey);
                  cacheStats.threadResets++;
                  err.nonRetryableAfterSideEffect = true;
                  throw err;
                }
                if (isContextOverflowError(err)) throw err;
                providerThreads.delete(convKey);
                cacheStats.threadResets++;
                const r = await activeProvider.generate(userContent, {
                  ...genOpts,
                  ephemeral: false,
                });
                if (r?.threadId) {
                  providerThreads.set(convKey, { threadId: r.threadId, prefixHash, model: modelSig, turnsReused: 0 });
                }
                return r;
              }
            }
            const r = await activeProvider.generate(userContent, {
              ...genOpts,
              ephemeral: false,
            });
            if (r?.threadId) {
              providerThreads.set(convKey, { threadId: r.threadId, prefixHash, model: modelSig, turnsReused: 0 });
            }
            return r;
          }
          return activeProvider.generate(userContent, genOpts);
        };

        try {
          res = await invokeProviderOnce(messages);
        } catch (err) {
          // G12: Catch 400 context_length_exceeded -> auto-compact once + rotate Codex thread + retry
          if (isContextOverflowError(err) && !overflowRetried && turnSideEffects === 0 && !controller.signal.aborted) {
            overflowRetried = true;
            clearProviderThread(convKey);
            const curHist = loadHistory(convKey);
            // Compact everything before the newly appended current user turn (if possible)
            const keepAfterOverflow = Math.max(1, Math.min(Math.floor(keepRecentTurns / 2), Math.max(1, curHist.length - 2)));
            const compRes = await compactSession(convKey, {
              summarizer,
              keep: keepAfterOverflow,
              meta: { sender, isGroup, channel, memoryContext, reason: 'context_overflow' },
            });
            if (compRes.compacted) compacted = true;
            const refreshedHist = loadHistory(convKey);
            // Exclude the trailing user turn we just persisted to avoid duplicating `finalUserMessage`
            const priorRows = refreshedHist.length > 0 && refreshedHist[refreshedHist.length - 1]?.role === 'user'
              ? refreshedHist.slice(0, -1)
              : refreshedHist;
            messages = buildProviderMessages(priorRows, finalUserMessage);
            events.emit('session.overflow_retry', { traceId, conversationId: convKey, compacted: compRes.compacted });
            res = await invokeProviderOnce(messages);
          } else {
            throw err;
          }
        }

        lastRes = res;
        const u = res.usage || {};
        totalUsage.uncachedInputTokens += Number(u.uncachedInputTokens || 0);
        totalUsage.cachedInputTokens += Number(u.cachedInputTokens || 0);
        totalUsage.outputTokens += Number(u.outputTokens || 0);
        totalUsage.providerTotalTokens += Number(u.providerTotalTokens || 0);
        budgetGovernor.recordUsage({
          conversationId: convKey,
          usage: u,
          fallbackInputTokens: estRoundTokens,
        });
        if (Number(u.cachedInputTokens || 0) > 0) cacheStats.hits++;
        else cacheStats.misses++;

        events.emit('gen_ai.client.inference', {
          traceId,
          conversationId: convKey,
          round,
          'gen_ai.provider.name': activeProvider.name,
          'gen_ai.request.model': res.model || resolvedModel || activeProvider.model,
          'gen_ai.usage.input_tokens': Number(u.uncachedInputTokens || 0) + Number(u.cachedInputTokens || 0),
          'gen_ai.usage.cached_input_tokens': Number(u.cachedInputTokens || 0),
          'gen_ai.usage.output_tokens': Number(u.outputTokens || 0),
          durationMs: res.durationMs || 0,
        });

        const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];
        if (!calls.length || !tools) {
          rawReply = String(res.text || '').trim();
          break;
        }

        // Crash-safe per-round persistence: persist assistant toolCalls BEFORE running tools,
        // then persist each tool result immediately after execution!
        const assistantToolRec = {
          role: 'assistant',
          ts: new Date().toISOString(),
          content: res.text || '',
          toolCalls: calls,
          ...(Array.isArray(res.thinkingBlocks) && res.thinkingBlocks.length ? { thinkingBlocks: res.thinkingBlocks } : {}),
          ...(Array.isArray(res.rawParts) && res.rawParts.length ? { rawParts: res.rawParts } : {}),
        };
        messages.push(assistantToolRec);
        appendHistory(convKey, assistantToolRec);

        let trippedBreaker = null;
        for (const tc of calls) {
          const ran = await runGatedTool(tc, round);
          const toolMsg = {
            role: 'tool',
            ts: new Date().toISOString(),
            toolCallId: tc.id || `call_${round}_${tc.name}`,
            name: tc.name,
            content: ran.text,
          };
          messages.push(toolMsg);
          appendHistory(convKey, toolMsg);
          if (ran.circuitBroken) trippedBreaker = ran.circuitBroken;
        }
        if (trippedBreaker) {
          audit.append({ traceId, conversationId: convKey, kind: 'circuit_breaker', reason: trippedBreaker.reason });
          const err = new Error(trippedBreaker.reason);
          err.code = 'CIRCUIT_BREAKER_TRIPPED';
          err.breaker = trippedBreaker;
          throw err;
        }
      }

      // 10. §42-§44 Outgoing Grounding, AI Disclosure & Style Enforcement
      // Provenance-safe: ONLY trusted tool outputs + KB + USER.md may_say + extraPrincipalSources!
      const principalSources = collectPrincipalSources({
        knowledgeChunks: kbResult.chunks,
        maySay: principalMaySay,
        toolOutputs: trustedToolOutputsText,
        extra: extraPrincipalSources,
      });

      let aiDisclosure = { checked: false, ok: true };
      if (turnClassification.aiDisclosureRequired && isIdentityQuestion(userContent)) {
        const chk = checkAiDisclosure(rawReply);
        aiDisclosure = { checked: true, ...chk };
      }

      let grounding = { checked: false, ok: true, claims: [], missing: [], pairMismatches: [], held: [] };
      if (turnClassification.groundingRequired && principalSources.trim().length > 0) {
        const g = groundReply(rawReply, principalSources, { dateOrder });
        grounding = { checked: true, ...g };
      }

      const styleCfg = agent.frontmatter?.style || {};
      const styled = enforceStyle(rawReply, styleCfg);
      let finalText = styled.text;
      let bubbles = styled.bubbles;
      let voiceMeta = null;

      // 11. Voice Hook 2: shapeOutgoing (protected by §43 verifyClaimsInvariant!)
      if (voiceHooks && typeof voiceHooks.shapeOutgoing === 'function') {
        const shaped = await voiceHooks.shapeOutgoing({
          conversationId: convKey,
          rawText: rawReply,
          text: finalText,
          bubbles,
          sender,
          isGroup,
          channel,
          turnClassification,
          voiceBefore,
          grounding,
        });
        if (shaped && typeof shaped === 'object') {
          const candText = typeof shaped.text === 'string'
            ? shaped.text
            : (Array.isArray(shaped.bubbles) ? shaped.bubbles.join('\n') : finalText);
          const inv = verifyClaimsInvariant(rawReply, candText, { dateOrder });
          if (inv.ok) {
            finalText = candText;
            if (Array.isArray(shaped.bubbles) && shaped.bubbles.length) bubbles = shaped.bubbles;
            voiceMeta = shaped.meta || shaped;
          } else {
            voiceMeta = { ...(shaped.meta || {}), claimsInvariantFallback: true, before: inv.before, after: inv.after };
          }
        }
      }

      if (turnClassification.aiDisclosureRequired && agent.frontmatter?.speaks_as === 'self' && aiDisclosure.checked && !aiDisclosure.ok) {
        finalText = applyAiLabel(finalText, { label: aiLabel, speaksAs: 'self' });
        bubbles = [finalText];
      }

      // Live Bug #5 fix: Release buffered stream ONLY if grounding passed!
      let streamHeld = false;
      if (mustBufferStream) {
        if (grounding.ok) {
          if (finalText) onDelta(finalText);
          else if (bufferedDeltas.length) onDelta(bufferedDeltas.join(''));
        } else {
          streamHeld = true;
          events.emit('grounding.stream_held', {
            traceId,
            conversationId: convKey,
            missing: grounding.missing,
            held: grounding.held,
          });
        }
      }

      // 12. Persist final assistant turn & check post-turn compaction
      const nowIso = new Date().toISOString();
      appendHistory(convKey, {
        role: 'assistant',
        ts: nowIso,
        content: finalText,
      });

      if (memoryTracker && typeof memoryTracker.recordAssistantTurn === 'function') {
        try {
          await memoryTracker.recordAssistantTurn({
            conversationId: convKey,
            text: finalText,
            sender,
            isGroup,
            channel,
            agentName: agent.name,
            memoryContext,
          });
        } catch { /* isolate memory write error */ }
      } else if (memoryStore && subjectSid && memorySessionId) {
        try {
          memoryStore.appendTurn(subjectSid, memorySessionId, { role: 'assistant', speaker: agent.name, text: finalText, surface: channel });
        } catch { /* ignore if session closed */ }
      }

      const totalChars = loadHistory(convKey).reduce((acc, m) => acc + String(m.content || '').length, 0);
      if (totalChars > compactAtChars) {
        const c = await compactSession(convKey, {
          summarizer,
          meta: { sender, isGroup, channel, memoryContext },
        });
        if (c.compacted) compacted = true;
      }

      events.emit('turn.complete', {
        traceId,
        conversationId: convKey,
        durationMs: Date.now() - t0,
        toolCalls: toolTraces.length,
        toolMode: toolSurface.mode,
        groundingOk: grounding.ok,
        streamHeld,
        prefixHash,
        threadReused,
        compacted,
      });

      return {
        text: finalText,
        bubbles,
        rawText: rawReply,
        toolTraces,
        toolMode: toolSurface.mode,
        grounding,
        streamHeld,
        aiDisclosure,
        style: styled,
        turnClassification,
        knowledgeHits: kbResult.hits,
        usage: totalUsage,
        durationMs: Date.now() - t0,
        model: lastRes?.model || callModel || activeProvider.model,
        responseId: lastRes?.responseId || null,
        prefixHash,
        threadReused,
        voiceMeta,
        compacted,
        aborted: false,
        traceId,
      };
    } finally {
      inflightControllers.delete(convKey);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  function sendTurn(opts = {}) {
    const convKey = String(opts?.conversationId || 'default');
    return withConvMutex(convKey, () => executeSendTurn(opts));
  }

  async function close() {
    for (const ctrl of inflightControllers.values()) ctrl.abort();
    inflightControllers.clear();
    providerThreads.clear();
    hydratedToolsByConv.clear();
    if (workerPool && typeof workerPool.close === 'function') workerPool.close();
    if (scheduler && typeof scheduler.stop === 'function') scheduler.stop();
    if (activeProvider && typeof activeProvider.close === 'function') {
      await activeProvider.close();
    }
    if (writerLock && typeof writerLock.release === 'function') {
      writerLock.release();
    }
  }

  function getCacheStats() {
    return {
      ...cacheStats,
      activeProviderThreads: providerThreads.size,
    };
  }

  return {
    get agent() { return agent; },
    get userDoc() { return userDoc; },
    get knowledgeIndex() { return kb; },
    get skillsRegistry() { return skills; },
    get budgetGovernor() { return budgetGovernor; },
    eventLogger: events,
    auditChain: audit,
    approvalStore: approvals,
    provider: activeProvider,
    reload,
    sendTurn,
    abortTurn,
    getHistory,
    clearSession,
    clearProviderThread,
    getCacheStats,
    scrubHistory,
    compactSession,
    close,
  };
}
