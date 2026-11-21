// SCROLL 2.5 -- §12 / §18 / §20.6 / §21 Chat Observability, Hash-Chained Audit,
// Budget & Loop Circuit Breakers, Single-Writer PID Lock, and Persistent Per-Call Approvals.
//
// Brings the governance guarantees of `lib/runtime.js` directly into `lib/chat-session.js`
// while keeping zero runtime dependencies and OpenTelemetry GenAI-aligned field names.
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g;

export function redactTelemetry(val) {
  if (typeof val === 'string') return val.replace(SECRET_VALUE_RE, '[REDACTED]');
  if (Array.isArray(val)) return val.map(redactTelemetry);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      if (/(?:token|secret|password|api_?key|authorization|cookie)/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactTelemetry(v);
      }
    }
    return out;
  }
  return val;
}

export function canonicalJson(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(val).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}';
}

export function hashArgs(args) {
  return crypto.createHash('sha256').update(canonicalJson(args ?? {})).digest('hex').slice(0, 24);
}

// ── Single-Writer PID Lockfile (enforces 1 active writer per state directory) ──
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function acquireWriterLock(stateDir, { lockName = '.writer.lock', owner = 'scroll-chat' } = {}) {
  if (!stateDir) return { acquired: false, release() {} };
  const absDir = path.resolve(stateDir);
  fs.mkdirSync(absDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(absDir, lockName);
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const payload = JSON.stringify({ pid: process.pid, token, owner, host: os.hostname(), startedAt: new Date().toISOString() }) + '\n';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeSync(fd, payload); } finally { fs.closeSync(fd); }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (cur.token === token) fs.rmSync(lockPath, { force: true });
        } catch { /* ignore */ }
      };
      return { acquired: true, lockPath, token, release };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { existing = null; }
      if (existing && existing.pid && isPidAlive(existing.pid)) {
        throw new Error(`writer_lock_held:pid=${existing.pid}:owner=${existing.owner || 'unknown'}:path=${lockPath}`);
      }
      // Stale lock from dead process -> remove and retry once
      try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
    }
  }
  throw new Error(`writer_lock_contention:${lockPath}`);
}

// ── Append-Only OTel GenAI-Aligned Event Stream (`events.jsonl`) ───────────────
export function createEventLogger({ filePath = null, onEvent = null } = {}) {
  function emit(type, data = {}) {
    const rec = {
      ts: new Date().toISOString(),
      type: String(type || 'event'),
      ...redactTelemetry(data),
    };
    if (filePath) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.appendFileSync(filePath, JSON.stringify(rec) + '\n', { mode: 0o600 });
      } catch { /* isolate disk telemetry error */ }
    }
    if (typeof onEvent === 'function') {
      try { onEvent(rec); } catch { /* isolate callback */ }
    }
    return rec;
  }
  return { emit, filePath };
}

// ── Tamper-Evident Hash-Chained Audit Log (`audit.jsonl`, §20.6) ───────────────
export function createAuditChain({ filePath = null, onAudit = null } = {}) {
  let seq = 0;
  let prevHash = '0'.repeat(64);

  if (filePath && fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.hash === 'string' && parsed.hash.length === 64) {
          prevHash = parsed.hash;
          seq = Number(parsed.seq || seq + 1);
        }
      } catch { /* ignore torn line */ }
    }
  }

  function append(entry) {
    seq++;
    const body = {
      seq,
      ts: new Date().toISOString(),
      ...redactTelemetry(entry),
      prevHash,
    };
    const hash = crypto.createHash('sha256').update(prevHash + '\n' + canonicalJson(body)).digest('hex');
    const full = { ...body, hash };
    prevHash = hash;
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(filePath, JSON.stringify(full) + '\n', { mode: 0o600 });
    }
    if (typeof onAudit === 'function') {
      try { onAudit(full); } catch { /* isolate callback */ }
    }
    return full;
  }

  return { append, filePath, get lastHash() { return prevHash; }, get count() { return seq; } };
}

export function verifyAuditChain(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: true, count: 0, errors: [] };
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
  let expectedPrev = '0'.repeat(64);
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch {
      errors.push({ line: i + 1, reason: 'invalid_json' });
      continue;
    }
    if (rec.prevHash !== expectedPrev) {
      errors.push({ line: i + 1, reason: 'prev_hash_mismatch', expected: expectedPrev, actual: rec.prevHash });
    }
    const { hash, ...body } = rec;
    const recomputed = crypto.createHash('sha256').update(expectedPrev + '\n' + canonicalJson(body)).digest('hex');
    if (hash !== recomputed) {
      errors.push({ line: i + 1, reason: 'hash_mismatch', expected: recomputed, actual: hash });
    }
    expectedPrev = hash || expectedPrev;
  }
  return { ok: errors.length === 0, count: lines.length, errors };
}

// ── §12 Budget Governor & Runaway Loop Circuit Breaker ─────────────────────────
const DEFAULT_PRICING = { inputPerM: 3.0, cachedPerM: 0.3, outputPerM: 15.0 };

export function estimateUsageUsd(usage, pricing = DEFAULT_PRICING) {
  const p = { ...DEFAULT_PRICING, ...(pricing || {}) };
  const uncached = Number(usage?.uncachedInputTokens || 0);
  const cached = Number(usage?.cachedInputTokens || 0);
  const output = Number(usage?.outputTokens || 0);
  return (uncached * p.inputPerM + cached * p.cachedPerM + output * p.outputPerM) / 1_000_000;
}

export function createBudgetGovernor({
  maxInputTokensPerTurn = null,
  maxDailyUsd = null,
  maxConversationDailyUsd = null,
  maxToolCallsPerTurn = 24,
  maxIdenticalToolRepeats = 3,
  maxConsecutiveToolErrors = 4,
  pricing = DEFAULT_PRICING,
  stateFile = null,
} = {}) {
  const daily = { day: new Date().toISOString().slice(0, 10), totalUsd: 0, byConv: {} };
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved && saved.day === daily.day) {
        daily.totalUsd = Number(saved.totalUsd || 0);
        daily.byConv = saved.byConv && typeof saved.byConv === 'object' ? saved.byConv : {};
      }
    } catch { /* ignore */ }
  }

  function rolloverDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (daily.day !== today) {
      daily.day = today;
      daily.totalUsd = 0;
      daily.byConv = {};
    }
  }

  function persist() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${stateFile}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(daily, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch { /* ignore */ }
  }

  function checkBeforeCall({ conversationId = 'default', estimatedInputTokens = 0 } = {}) {
    rolloverDay();
    if (maxInputTokensPerTurn && estimatedInputTokens > maxInputTokensPerTurn) {
      return { ok: false, reason: 'budget_input_tokens_per_turn_exceeded', limit: maxInputTokensPerTurn, actual: estimatedInputTokens };
    }
    if (maxDailyUsd != null && daily.totalUsd >= maxDailyUsd) {
      return { ok: false, reason: 'budget_daily_usd_exceeded', limit: maxDailyUsd, actual: daily.totalUsd };
    }
    const convUsd = Number(daily.byConv[String(conversationId)] || 0);
    if (maxConversationDailyUsd != null && convUsd >= maxConversationDailyUsd) {
      return { ok: false, reason: 'budget_conversation_daily_usd_exceeded', limit: maxConversationDailyUsd, actual: convUsd };
    }
    return { ok: true };
  }

  function recordUsage({ conversationId = 'default', usage = null, fallbackInputTokens = 0 } = {}) {
    rolloverDay();
    const effUsage = usage && (usage.uncachedInputTokens || usage.cachedInputTokens || usage.outputTokens)
      ? usage
      : { uncachedInputTokens: fallbackInputTokens, cachedInputTokens: 0, outputTokens: 0 };
    const usd = estimateUsageUsd(effUsage, pricing);
    daily.totalUsd += usd;
    const ck = String(conversationId);
    daily.byConv[ck] = Number(daily.byConv[ck] || 0) + usd;
    persist();
    return { usd, dailyTotalUsd: daily.totalUsd, convDailyUsd: daily.byConv[ck] };
  }

  function createTurnTracker() {
    let toolCalls = 0;
    let consecutiveErrors = 0;
    const callSigCounts = new Map();

    return {
      beforeToolCall(name, args) {
        toolCalls++;
        if (maxToolCallsPerTurn && toolCalls > maxToolCallsPerTurn) {
          return { ok: false, reason: 'circuit_breaker_max_tool_calls_per_turn', limit: maxToolCallsPerTurn, count: toolCalls };
        }
        const sig = `${name}:${hashArgs(args)}`;
        const count = (callSigCounts.get(sig) || 0) + 1;
        callSigCounts.set(sig, count);
        if (maxIdenticalToolRepeats && count > maxIdenticalToolRepeats) {
          return { ok: false, reason: 'circuit_breaker_identical_tool_repeat_loop', tool: name, repeats: count };
        }
        return { ok: true, count: toolCalls };
      },
      afterToolResult(ok) {
        if (ok) {
          consecutiveErrors = 0;
          return { ok: true };
        }
        consecutiveErrors++;
        if (maxConsecutiveToolErrors && consecutiveErrors >= maxConsecutiveToolErrors) {
          return { ok: false, reason: 'circuit_breaker_consecutive_tool_errors', consecutiveErrors };
        }
        return { ok: true };
      },
      get toolCalls() { return toolCalls; },
      get consecutiveErrors() { return consecutiveErrors; },
    };
  }

  return {
    checkBeforeCall,
    recordUsage,
    createTurnTracker,
    getSnapshot: () => ({ day: daily.day, totalUsd: daily.totalUsd, byConv: { ...daily.byConv } }),
  };
}

// ── Persistent Per-Call Approval Token Store (survives restart, bound to tool+argsHash) ──
export function createApprovalStore({ dir = null, defaultTtlMs = 15 * 60_000 } = {}) {
  const mem = new Map();
  const absDir = dir ? path.resolve(dir) : null;

  function tokenPath(id) {
    const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
    return absDir ? path.join(absDir, `${safe}.json`) : null;
  }

  function save(rec) {
    mem.set(rec.id, rec);
    const p = tokenPath(rec.id);
    if (p) {
      fs.mkdirSync(absDir, { recursive: true, mode: 0o700 });
      const tmp = `${p}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, p);
    }
    return rec;
  }

  function load(id) {
    if (!id) return null;
    if (mem.has(id)) return mem.get(id);
    const p = tokenPath(id);
    if (!p || !fs.existsSync(p)) return null;
    try {
      const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
      mem.set(id, rec);
      return rec;
    } catch { return null; }
  }

  function issue({
    tool,
    args = {},
    approver = null,
    tier = 'destructive',
    amount = null,
    ttlMs = defaultTtlMs,
  } = {}) {
    if (!tool) throw new Error('approval_issue: tool is required');
    const id = `appr_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const rec = {
      id,
      tool: String(tool),
      argsHash: hashArgs(args),
      approver: approver ? String(approver) : null,
      tier: String(tier),
      amount: amount != null && Number.isFinite(Number(amount)) ? Number(amount) : null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Math.max(1000, Number(ttlMs || defaultTtlMs))).toISOString(),
      used: false,
    };
    return save(rec);
  }

  function consume({
    tokenId,
    tool,
    args = {},
    userDoc = null,
    tier = 'destructive',
    amount = null,
  } = {}) {
    const rec = load(tokenId);
    if (!rec) return { ok: false, reason: 'approval_token_not_found' };
    if (rec.used) return { ok: false, reason: 'approval_token_already_used' };
    if (Date.now() > Date.parse(rec.expiresAt)) return { ok: false, reason: 'approval_token_expired' };
    if (rec.tool !== String(tool)) return { ok: false, reason: 'approval_tool_mismatch' };
    const actualHash = hashArgs(args);
    if (rec.argsHash !== actualHash) return { ok: false, reason: 'approval_args_hash_mismatch' };
    if (userDoc && userDoc.active && typeof userDoc.canApprove === 'function') {
      if (!rec.approver) return { ok: false, reason: 'approval_missing_approver' };
      const checkAmt = amount != null ? Number(amount) : rec.amount;
      const chk = userDoc.canApprove(rec.approver, { tier, actionClass: tier, amount: checkAmt });
      if (chk && chk.ok === false) {
        return { ok: false, reason: chk.reason || 'approver_not_authorized' };
      }
    }
    rec.used = true;
    rec.usedAt = new Date().toISOString();
    save(rec);
    return { ok: true, token: rec };
  }

  return { issue, consume, get: load, hashArgs };
}
