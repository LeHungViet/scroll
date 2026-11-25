// SCROLL 2.5 -- §12 / §18 / §20.6 / §21 Chat Observability, Hash-Chained Audit,
// Budget & Loop Circuit Breakers, Single-Writer PID Lock, and Atomic Per-Call Approvals.
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
const SENSITIVE_KEY_RE = /(?:token|secret|password|passwd|api_?key|authorization|cookie|credential|private_?key|bearer)/i;

export function redactTelemetry(val) {
  if (typeof val === 'string') return val.replace(SECRET_VALUE_RE, '[REDACTED]');
  if (Array.isArray(val)) return val.map(redactTelemetry);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      // Redact sensitive keys regardless of value type (prevents `{ authorization: { value: "..." } }` leaks)
      if (SENSITIVE_KEY_RE.test(k) && v !== undefined && v !== null) {
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

// Synchronous short-lived spin lock with owner token verification for multi-process JSON/JSONL appends.
function withShortFileLockSync(lockPath, fn, { maxWaitMs = 1500 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + maxWaitMs;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, ts: Date.now() }) + '\n'); } finally { fs.closeSync(fd); }
      acquired = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        // Only reap when holder PID is dead (never steal from a live process!)
        if (cur && cur.pid && !isPidAlive(cur.pid)) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 10_000) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch { continue; }
      }
      if (Date.now() >= deadline) {
        throw new Error(`short_file_lock_timeout:${lockPath}`);
      }
      // Bounded short wait using Atomics.wait (zero CPU busy spin)
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8);
      } catch { /* ignore */ }
    }
  }

  try {
    return fn();
  } finally {
    try {
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (cur && cur.token === token) fs.rmSync(lockPath, { force: true });
    } catch { /* ignore */ }
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
function readTailHash(filePath) {
  let seq = 0;
  let prevHash = '0'.repeat(64);
  if (!filePath || !fs.existsSync(filePath)) return { seq, prevHash };
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
  return { seq, prevHash };
}

export function createAuditChain({ filePath = null, onAudit = null } = {}) {
  let { seq, prevHash } = readTailHash(filePath);
  const lockPath = filePath ? `${filePath}.lock` : null;

  function append(entry) {
    const doAppend = () => {
      // Refresh tail from disk inside lock so multi-bot / multi-process writers NEVER break the chain
      if (filePath) {
        const tail = readTailHash(filePath);
        seq = tail.seq;
        prevHash = tail.prevHash;
      }
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
      return full;
    };

    const full = lockPath ? withShortFileLockSync(lockPath, doAppend) : doAppend();
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

export const DEFAULT_TIER_MULTIPLIERS = Object.freeze({
  standard: 1,
  default: 1,
  auto: 1,
  flex: 0.5,
  batch: 0.5,
  priority: 2,
  fast: 2,
});

const BACKGROUND_BUCKETS = new Set(['background', 'automation', 'scheduled', 'cron', 'heartbeat']);

function normalizeTierName(tier) {
  if (!tier) return null;
  const s = String(tier).trim().toLowerCase();
  return s || null;
}

export function resolveModelPricing(pricing = DEFAULT_PRICING, {
  model = null,
  serviceTier = null,
  pricingByModel = null,
  tierMultipliers = null,
} = {}) {
  const baseDefault = { ...DEFAULT_PRICING, ...(pricing && typeof pricing === 'object' ? pricing : {}) };
  const tier = normalizeTierName(serviceTier);
  const modelKey = model ? String(model).trim() : null;
  const baseModelKey = modelKey ? modelKey.replace(/-\d{4}-\d{2}-\d{2}$/, '') : null;

  let matched = null;
  let exactTierMatch = false;
  if (pricingByModel && typeof pricingByModel === 'object' && modelKey) {
    if (tier && pricingByModel[`${modelKey}@${tier}`]) {
      matched = pricingByModel[`${modelKey}@${tier}`];
      exactTierMatch = true;
    } else if (tier && baseModelKey && pricingByModel[`${baseModelKey}@${tier}`]) {
      matched = pricingByModel[`${baseModelKey}@${tier}`];
      exactTierMatch = true;
    } else if (pricingByModel[modelKey]) {
      matched = pricingByModel[modelKey];
    } else if (baseModelKey && pricingByModel[baseModelKey]) {
      matched = pricingByModel[baseModelKey];
    }
  }

  const raw = matched ? { ...baseDefault, ...matched } : baseDefault;
  const multipliers = {
    ...DEFAULT_TIER_MULTIPLIERS,
    ...(tierMultipliers && typeof tierMultipliers === 'object' ? tierMultipliers : {}),
  };
  const tierFactor = (!exactTierMatch && tier && !raw.tierMultiplied && Number.isFinite(Number(multipliers[tier])))
    ? Number(multipliers[tier])
    : 1;

  const scale = (v) => (v == null ? undefined : Number(v) * tierFactor);
  return {
    inputPerM: Number(raw.inputPerM ?? DEFAULT_PRICING.inputPerM) * tierFactor,
    cachedPerM: Number(raw.cachedPerM ?? DEFAULT_PRICING.cachedPerM) * tierFactor,
    outputPerM: Number(raw.outputPerM ?? DEFAULT_PRICING.outputPerM) * tierFactor,
    imageInputPerM: scale(raw.imageInputPerM),
    imageOutputPerM: scale(raw.imageOutputPerM),
    audioInputPerM: scale(raw.audioInputPerM),
    audioOutputPerM: scale(raw.audioOutputPerM),
    perMinute: raw.perMinute != null ? Number(raw.perMinute) : null,
    perCall: raw.perCall != null ? Number(raw.perCall) : null,
    tierFactor,
    exactTierMatch,
  };
}

export function estimateUsageUsd(usage, pricing = DEFAULT_PRICING, opts = {}) {
  if (!usage || typeof usage !== 'object') return 0;
  const p = resolveModelPricing(pricing, {
    model: opts?.model ?? usage?.model ?? null,
    serviceTier: opts?.serviceTier ?? usage?.serviceTier ?? null,
    pricingByModel: opts?.pricingByModel ?? null,
    tierMultipliers: opts?.tierMultipliers ?? null,
  });

  if (p.perMinute != null && usage.seconds != null) {
    return (Math.max(0, Number(usage.seconds) || 0) / 60) * p.perMinute;
  }
  if (p.perCall != null && usage.calls != null) {
    return Math.max(0, Number(usage.calls) || 0) * p.perCall;
  }

  const cached = Math.max(0, Number(usage.cachedInputTokens || 0));
  const rawUncached = Math.max(0, Number(usage.uncachedInputTokens || 0));
  const imageIn = Math.max(0, Number(usage.imageInputTokens || 0));
  const audioIn = Math.max(0, Number(usage.audioInputTokens || 0));
  const textIn = usage.textInputTokens != null
    ? Math.max(0, Number(usage.textInputTokens) || 0)
    : Math.max(0, rawUncached - imageIn - audioIn);

  const imageOut = Math.max(0, Number(usage.imageOutputTokens || 0));
  const audioOut = Math.max(0, Number(usage.audioOutputTokens || 0));
  const rawOut = Math.max(0, Number(usage.outputTokens || 0));
  const textOut = usage.textOutputTokens != null
    ? Math.max(0, Number(usage.textOutputTokens) || 0)
    : Math.max(0, rawOut - imageOut - audioOut);

  const imgInRate = p.imageInputPerM ?? p.inputPerM;
  const audInRate = p.audioInputPerM ?? p.inputPerM;
  const imgOutRate = p.imageOutputPerM ?? p.outputPerM;
  const audOutRate = p.audioOutputPerM ?? p.outputPerM;

  return (
    textIn * p.inputPerM
    + imageIn * imgInRate
    + audioIn * audInRate
    + cached * p.cachedPerM
    + textOut * p.outputPerM
    + imageOut * imgOutRate
    + audioOut * audOutRate
  ) / 1_000_000;
}

export function createBudgetGovernor({
  maxInputTokensPerTurn = null,
  maxDailyUsd = null,
  maxMonthlyUsd = null,
  maxConversationDailyUsd = null,
  maxBackgroundDailyUsd = null,
  bucketCaps = null,
  maxToolCallsPerTurn = 24,
  maxIdenticalToolRepeats = 3,
  maxConsecutiveToolErrors = 4,
  pricing = DEFAULT_PRICING,
  pricingByModel = null,
  tierMultipliers = null,
  alertThresholds = [0.8, 1.0],
  onBudgetAlert = null,
  stateFile = null,
  clock = () => Date.now(),
} = {}) {
  const nowDay = () => new Date(clock()).toISOString().slice(0, 10);
  const nowMonth = () => nowDay().slice(0, 7);
  const normBucketCaps = {};
  if (bucketCaps && typeof bucketCaps === 'object') {
    for (const [k, v] of Object.entries(bucketCaps)) {
      if (v != null && Number.isFinite(Number(v)) && Number(v) >= 0) {
        normBucketCaps[String(k).toLowerCase()] = Number(v);
      }
    }
  }
  if (maxBackgroundDailyUsd != null && Number.isFinite(Number(maxBackgroundDailyUsd)) && normBucketCaps.background == null) {
    normBucketCaps.background = Number(maxBackgroundDailyUsd);
  }
  const normalizedThresholds = Array.isArray(alertThresholds)
    ? [...new Set(alertThresholds.map(Number).filter((x) => Number.isFinite(x) && x > 0 && x <= 1))].sort((a, b) => a - b)
    : [];

  const daily = {
    day: nowDay(),
    totalUsd: 0,
    byConv: {},
    byBucket: {},
    monthly: { month: nowMonth(), totalUsd: 0, byBucket: {} },
    reconciled: { day: null, dayUsd: 0, month: null, monthUsd: 0, orgMonthUsd: null, syncedAt: null },
    alertsSent: {},
  };
  const lockPath = stateFile ? `${stateFile}.lock` : null;

  function normalizeBucket(bucket) {
    const b = String(bucket || 'interactive').trim().toLowerCase() || 'interactive';
    return BACKGROUND_BUCKETS.has(b) ? 'background' : b;
  }

  function bucketCapFor(bucket) {
    const b = normalizeBucket(bucket);
    if (normBucketCaps[b] != null) return normBucketCaps[b];
    if (b === 'background' && maxBackgroundDailyUsd != null) return Number(maxBackgroundDailyUsd);
    return null;
  }

  function loadFromDisk() {
    const today = nowDay();
    const curMonth = today.slice(0, 7);
    if (daily.day !== today) {
      daily.day = today;
      daily.totalUsd = 0;
      daily.byConv = {};
      daily.byBucket = {};
    }
    if (!daily.monthly || daily.monthly.month !== curMonth) {
      daily.monthly = { month: curMonth, totalUsd: 0, byBucket: {} };
    }
    if (stateFile && fs.existsSync(stateFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (saved && typeof saved === 'object') {
          if (saved.day === today) {
            daily.totalUsd = Number(saved.totalUsd || 0);
            daily.byConv = saved.byConv && typeof saved.byConv === 'object' ? { ...saved.byConv } : {};
            daily.byBucket = saved.byBucket && typeof saved.byBucket === 'object' ? { ...saved.byBucket } : {};
          }
          if (saved.monthly && saved.monthly.month === curMonth) {
            daily.monthly = {
              month: curMonth,
              totalUsd: Number(saved.monthly.totalUsd || 0),
              byBucket: saved.monthly.byBucket && typeof saved.monthly.byBucket === 'object'
                ? { ...saved.monthly.byBucket }
                : {},
            };
          } else if (saved.day && String(saved.day).startsWith(curMonth) && !saved.monthly) {
            // Upgrade legacy daily-only state file in the same month without losing spend
            daily.monthly = { month: curMonth, totalUsd: Number(saved.totalUsd || 0), byBucket: {} };
          }
          if (saved.reconciled && typeof saved.reconciled === 'object') {
            daily.reconciled = {
              day: saved.reconciled.day || null,
              dayUsd: Number(saved.reconciled.dayUsd || 0),
              month: saved.reconciled.month || null,
              monthUsd: Number(saved.reconciled.monthUsd || 0),
              orgMonthUsd: saved.reconciled.orgMonthUsd != null ? Number(saved.reconciled.orgMonthUsd) : null,
              syncedAt: saved.reconciled.syncedAt || null,
            };
          }
          if (saved.alertsSent && typeof saved.alertsSent === 'object') {
            daily.alertsSent = { ...saved.alertsSent };
          }
        }
      } catch { /* ignore */ }
    }
  }

  loadFromDisk();

  function effectiveDailyUsd() {
    const rec = daily.reconciled?.day === daily.day ? Number(daily.reconciled.dayUsd || 0) : 0;
    return Math.max(daily.totalUsd, rec);
  }

  function effectiveMonthlyUsd() {
    const rec = daily.reconciled?.month === daily.monthly.month ? Number(daily.reconciled.monthUsd || 0) : 0;
    return Math.max(daily.monthly.totalUsd, rec);
  }

  function topConversations(limit = 3) {
    return Object.entries(daily.byConv || {})
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .slice(0, limit)
      .map(([conversationId, usd]) => ({ conversationId, usd: +Number(usd || 0).toFixed(6) }));
  }

  function evaluateAlertsUnlocked() {
    if (!normalizedThresholds.length) return [];
    const triggered = [];
    const check = (period, key, spentUsd, capUsd, bucket = null, source = 'local') => {
      if (capUsd == null || !(Number(capUsd) > 0)) return;
      for (const th of normalizedThresholds) {
        if (spentUsd < Number(capUsd) * th) continue;
        const pct = Math.round(th * 100);
        const alertKey = `${period}:${key}:${pct}`;
        if (daily.alertsSent[alertKey]) continue;
        daily.alertsSent[alertKey] = new Date(clock()).toISOString();
        const ev = {
          period,
          bucket,
          thresholdPct: pct,
          spentUsd: +Number(spentUsd).toFixed(6),
          capUsd: Number(capUsd),
          reached: spentUsd >= Number(capUsd),
          day: daily.day,
          month: daily.monthly.month,
          source,
          topConversations: topConversations(3),
        };
        triggered.push(ev);
      }
    };

    const effDay = effectiveDailyUsd();
    const daySrc = daily.reconciled?.day === daily.day && daily.reconciled.dayUsd > daily.totalUsd ? 'reconciled' : 'local';
    if (maxDailyUsd != null) check('daily', daily.day, effDay, maxDailyUsd, null, daySrc);

    const effMo = effectiveMonthlyUsd();
    const moSrc = daily.reconciled?.month === daily.monthly.month && daily.reconciled.monthUsd > daily.monthly.totalUsd ? 'reconciled' : 'local';
    if (maxMonthlyUsd != null) check('monthly', daily.monthly.month, effMo, maxMonthlyUsd, null, moSrc);

    for (const [bName, bCap] of Object.entries(normBucketCaps)) {
      const bSpent = Number(daily.byBucket[bName] || 0);
      check('bucket', `${bName}:${daily.day}`, bSpent, bCap, bName, 'local');
    }

    return triggered;
  }

  function dispatchAlerts(alerts) {
    if (typeof onBudgetAlert !== 'function' || !alerts.length) return;
    for (const ev of alerts) {
      try { onBudgetAlert(ev); } catch { /* isolate alert callback */ }
    }
  }

  function persistUnlocked() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      const tmp = `${stateFile}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify(daily, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch { /* ignore */ }
  }

  function checkBeforeCall({
    conversationId = 'default',
    estimatedInputTokens = 0,
    estimatedOutputTokens = 0,
    model = null,
    serviceTier = null,
    bucket = 'interactive',
  } = {}) {
    loadFromDisk();
    if (maxInputTokensPerTurn && estimatedInputTokens > maxInputTokensPerTurn) {
      return { ok: false, reason: 'budget_input_tokens_per_turn_exceeded', limit: maxInputTokensPerTurn, actual: estimatedInputTokens };
    }
    const estUsd = estimateUsageUsd({
      uncachedInputTokens: Number(estimatedInputTokens || 0),
      cachedInputTokens: 0,
      outputTokens: Number(estimatedOutputTokens || 0),
    }, pricing, { model, serviceTier, pricingByModel, tierMultipliers });

    const normBucket = normalizeBucket(bucket);
    const bCap = bucketCapFor(normBucket);
    const bUsd = Number(daily.byBucket[normBucket] || 0);
    if (bCap != null && (bUsd >= bCap || (estUsd > 0 && bUsd + estUsd > bCap))) {
      return {
        ok: false,
        reason: 'budget_bucket_daily_usd_exceeded',
        bucket: normBucket,
        limit: bCap,
        actual: bUsd,
        estimatedCallUsd: estUsd,
      };
    }

    const effDay = effectiveDailyUsd();
    if (maxDailyUsd != null && (effDay >= maxDailyUsd || (estUsd > 0 && effDay + estUsd > maxDailyUsd))) {
      return { ok: false, reason: 'budget_daily_usd_exceeded', limit: maxDailyUsd, actual: effDay, estimatedCallUsd: estUsd };
    }

    const effMonth = effectiveMonthlyUsd();
    if (maxMonthlyUsd != null && (effMonth >= maxMonthlyUsd || (estUsd > 0 && effMonth + estUsd > maxMonthlyUsd))) {
      return { ok: false, reason: 'budget_monthly_usd_exceeded', limit: maxMonthlyUsd, actual: effMonth, estimatedCallUsd: estUsd };
    }

    const convUsd = Number(daily.byConv[String(conversationId)] || 0);
    if (maxConversationDailyUsd != null && (convUsd >= maxConversationDailyUsd || (estUsd > 0 && convUsd + estUsd > maxConversationDailyUsd))) {
      return { ok: false, reason: 'budget_conversation_daily_usd_exceeded', limit: maxConversationDailyUsd, actual: convUsd, estimatedCallUsd: estUsd };
    }
    return { ok: true, estimatedCallUsd: estUsd, bucket: normBucket };
  }

  function recordUsage({
    conversationId = 'default',
    usage = null,
    fallbackInputTokens = 0,
    model = null,
    serviceTier = null,
    bucket = 'interactive',
  } = {}) {
    let alertsToDispatch = [];
    const apply = () => {
      loadFromDisk();
      const hasAnyUsage = usage && (
        usage.uncachedInputTokens
        || usage.cachedInputTokens
        || usage.outputTokens
        || usage.imageInputTokens
        || usage.imageOutputTokens
        || usage.audioInputTokens
        || usage.audioOutputTokens
        || usage.seconds != null
        || usage.calls != null
      );
      const effUsage = hasAnyUsage
        ? usage
        : { uncachedInputTokens: fallbackInputTokens, cachedInputTokens: 0, outputTokens: 0 };
      const usd = estimateUsageUsd(effUsage, pricing, { model, serviceTier, pricingByModel, tierMultipliers });
      const ck = String(conversationId);
      const bk = normalizeBucket(bucket);
      daily.totalUsd += usd;
      daily.byConv[ck] = Number(daily.byConv[ck] || 0) + usd;
      daily.byBucket[bk] = Number(daily.byBucket[bk] || 0) + usd;
      daily.monthly.totalUsd += usd;
      daily.monthly.byBucket[bk] = Number(daily.monthly.byBucket[bk] || 0) + usd;
      alertsToDispatch = evaluateAlertsUnlocked();
      persistUnlocked();
      return {
        usd,
        dailyTotalUsd: daily.totalUsd,
        effectiveDailyUsd: effectiveDailyUsd(),
        monthlyTotalUsd: daily.monthly.totalUsd,
        effectiveMonthlyUsd: effectiveMonthlyUsd(),
        convDailyUsd: daily.byConv[ck],
        bucketDailyUsd: daily.byBucket[bk],
        bucket: bk,
        alertsTriggered: alertsToDispatch,
      };
    };
    const out = lockPath ? withShortFileLockSync(lockPath, apply) : apply();
    dispatchAlerts(alertsToDispatch);
    return out;
  }

  function syncExternalInvoice({
    day = null,
    dayUsd = null,
    month = null,
    monthUsd = null,
    orgMonthUsd = null,
  } = {}) {
    let alertsToDispatch = [];
    const apply = () => {
      loadFromDisk();
      if (day && dayUsd != null && Number.isFinite(Number(dayUsd))) {
        daily.reconciled.day = String(day).slice(0, 10);
        daily.reconciled.dayUsd = Math.max(0, Number(dayUsd));
      }
      if (month && monthUsd != null && Number.isFinite(Number(monthUsd))) {
        daily.reconciled.month = String(month).slice(0, 7);
        daily.reconciled.monthUsd = Math.max(0, Number(monthUsd));
      }
      if (orgMonthUsd != null && Number.isFinite(Number(orgMonthUsd))) {
        daily.reconciled.orgMonthUsd = Math.max(0, Number(orgMonthUsd));
      }
      daily.reconciled.syncedAt = new Date(clock()).toISOString();
      alertsToDispatch = evaluateAlertsUnlocked();
      persistUnlocked();
      const invMonth = daily.reconciled.month === daily.monthly.month ? daily.reconciled.monthUsd : null;
      const driftPct = invMonth != null && invMonth > 0
        ? +(((daily.monthly.totalUsd - invMonth) / invMonth) * 100).toFixed(1)
        : null;
      return {
        effectiveDailyUsd: effectiveDailyUsd(),
        effectiveMonthlyUsd: effectiveMonthlyUsd(),
        localDailyUsd: daily.totalUsd,
        localMonthlyUsd: daily.monthly.totalUsd,
        reconciled: { ...daily.reconciled },
        driftPct,
        alertsTriggered: alertsToDispatch,
      };
    };
    const out = lockPath ? withShortFileLockSync(lockPath, apply) : apply();
    dispatchAlerts(alertsToDispatch);
    return out;
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
    syncExternalInvoice,
    createTurnTracker,
    getSnapshot: () => {
      loadFromDisk();
      return {
        day: daily.day,
        totalUsd: daily.totalUsd,
        effectiveDailyUsd: effectiveDailyUsd(),
        byConv: { ...daily.byConv },
        byBucket: { ...daily.byBucket },
        monthly: {
          month: daily.monthly.month,
          totalUsd: daily.monthly.totalUsd,
          effectiveMonthlyUsd: effectiveMonthlyUsd(),
          byBucket: { ...daily.monthly.byBucket },
        },
        reconciled: { ...daily.reconciled },
      };
    },
  };
}

// ── Atomic POSIX Single-Use Approval Token Store (issued/ -> consumed/ via renameSync) ──
// Zero-dep, multi-process race-free: POSIX `rename()` guarantees at most ONE caller
// across any number of processes can transition a token from `issued/` to `consumed/`.
export function createApprovalStore({ dir = null, defaultTtlMs = 15 * 60_000 } = {}) {
  const pendingMem = new Map();
  const consumedMem = new Map();
  const absDir = dir ? path.resolve(dir) : null;
  const issuedDir = absDir ? path.join(absDir, 'issued') : null;
  const consumedDir = absDir ? path.join(absDir, 'consumed') : null;

  function safeId(id) {
    return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function issuedPath(id) {
    return issuedDir ? path.join(issuedDir, `${safeId(id)}.json`) : null;
  }

  function consumedPath(id) {
    return consumedDir ? path.join(consumedDir, `${safeId(id)}.json`) : null;
  }

  function legacyPath(id) {
    return absDir ? path.join(absDir, `${safeId(id)}.json`) : null;
  }

  function writeAtomic(filePath, rec) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  function readJsonSafe(p) {
    if (!p || !fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }

  function get(id) {
    if (!id) return null;
    if (absDir) {
      return readJsonSafe(issuedPath(id))
        || readJsonSafe(consumedPath(id))
        || readJsonSafe(legacyPath(id));
    }
    return pendingMem.get(id) || consumedMem.get(id) || null;
  }

  function issue({
    tool,
    args = {},
    approver = null,
    tier = 'destructive',
    amount = null,
    conversationId = null,
    turnId = null,
    schemaHash = null,
    ttlMs = defaultTtlMs,
  } = {}) {
    if (!tool) throw new Error('approval_issue: tool is required');
    const id = `appr_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const rec = {
      id,
      tool: String(tool),
      argsHash: hashArgs(args),
      approver: approver ? String(approver) : null,
      tier: String(tier),
      amount: amount != null && Number.isFinite(Number(amount)) ? Number(amount) : null,
      conversationId: conversationId ? String(conversationId) : null,
      turnId: turnId ? String(turnId) : null,
      schemaHash: schemaHash ? String(schemaHash) : null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Math.max(1000, Number(ttlMs || defaultTtlMs))).toISOString(),
      used: false,
    };
    if (absDir) {
      fs.mkdirSync(issuedDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(consumedDir, { recursive: true, mode: 0o700 });
      writeAtomic(issuedPath(id), rec);
    } else {
      pendingMem.set(id, rec);
    }
    return rec;
  }

  function validateRecord(rec, { tool, args, userDoc, tier, amount, conversationId, turnId, schemaHash }) {
    if (rec.used) return { ok: false, reason: 'approval_token_already_used' };
    if (Date.now() > Date.parse(rec.expiresAt)) return { ok: false, reason: 'approval_token_expired' };
    if (rec.tool !== String(tool)) return { ok: false, reason: 'approval_tool_mismatch' };
    const actualHash = hashArgs(args);
    if (rec.argsHash !== actualHash) return { ok: false, reason: 'approval_args_hash_mismatch' };
    // Strict binding: if token was issued with a conversationId/turnId/schemaHash, caller MUST supply the exact match!
    if (rec.conversationId && String(conversationId || '') !== rec.conversationId) {
      return { ok: false, reason: 'approval_conversation_mismatch' };
    }
    if (rec.turnId && String(turnId || '') !== rec.turnId) {
      return { ok: false, reason: 'approval_turn_mismatch' };
    }
    if (rec.schemaHash && String(schemaHash || '') !== rec.schemaHash) {
      return { ok: false, reason: 'approval_schema_hash_mismatch' };
    }
    if (userDoc && userDoc.active && typeof userDoc.canApprove === 'function') {
      if (!rec.approver) return { ok: false, reason: 'approval_missing_approver' };
      const checkAmt = amount != null ? Number(amount) : rec.amount;
      const chk = userDoc.canApprove(rec.approver, { tier, amount: checkAmt });
      if (chk && chk.ok === false) {
        return { ok: false, reason: chk.reason || 'approver_not_authorized' };
      }
    }
    return { ok: true };
  }

  function consume({
    tokenId,
    tool,
    args = {},
    userDoc = null,
    tier = 'destructive',
    amount = null,
    conversationId = null,
    turnId = null,
    schemaHash = null,
  } = {}) {
    if (!tokenId || !/^[A-Za-z0-9_-]{8,128}$/.test(String(tokenId))) {
      return { ok: false, reason: 'approval_token_not_found' };
    }

    if (absDir) {
      const src = issuedPath(tokenId);
      const dst = consumedPath(tokenId);
      const rec = readJsonSafe(src);
      if (!rec) {
        if (fs.existsSync(dst)) return { ok: false, reason: 'approval_token_already_used' };
        return { ok: false, reason: 'approval_token_not_found' };
      }

      const valid = validateRecord(rec, { tool, args, userDoc, tier, amount, conversationId, turnId, schemaHash });
      if (!valid.ok) return valid;

      // Atomic POSIX claim: only ONE process/call succeeds in moving `issued/<id>` -> `consumed/<id>`!
      fs.mkdirSync(consumedDir, { recursive: true, mode: 0o700 });
      try {
        fs.renameSync(src, dst);
      } catch (err) {
        if (err?.code === 'ENOENT') return { ok: false, reason: 'approval_token_already_used' };
        throw err;
      }

      const claimed = { ...rec, used: true, usedAt: new Date().toISOString() };
      try { writeAtomic(dst, claimed); } catch { /* already moved atomically */ }
      return { ok: true, token: claimed };
    }

    // In-memory atomic single-use transition
    const rec = pendingMem.get(tokenId);
    if (!rec) {
      if (consumedMem.has(tokenId)) return { ok: false, reason: 'approval_token_already_used' };
      return { ok: false, reason: 'approval_token_not_found' };
    }
    const valid = validateRecord(rec, { tool, args, userDoc, tier, amount, conversationId, turnId, schemaHash });
    if (!valid.ok) return valid;
    pendingMem.delete(tokenId);
    const claimed = { ...rec, used: true, usedAt: new Date().toISOString() };
    consumedMem.set(tokenId, claimed);
    return { ok: true, token: claimed };
  }

  return { issue, consume, get, hashArgs };
}
