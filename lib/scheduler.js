// SCROLL 2.0 -- §49 Timezone-Aware Cron, Heartbeat & Reminder Scheduler.
//
// Features:
//   - Standard 5-field cron expressions (`min hour dom month dow`) evaluated in any IANA timezone
//     (e.g. `Asia/Ho_Chi_Minh`, `UTC`, `America/New_York`) via native `Intl.DateTimeFormat`.
//   - Interval (`everyMs`) and one-shot (`at` ISO timestamp) reminders.
//   - Atomic `0600` JSON persistence outside git.
//   - Exponential backoff on transient / 429 failures.
//   - Global kill-switch (`paused`) and per-job `maxDailyRuns` budget ceiling.
//   - Owner DM authority: `canManageJob(actor, job)` permits a verified `owner`/`admin` in DM
//     to inspect, pause, edit, or delete ANY group's scheduled job.
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCHEDULER_SCHEMA = 'scroll-scheduler/1';

function parseCronField(expr, min, max, { mapSevenToZero = false } = {}) {
  const allowed = new Set();
  const parts = String(expr || '').trim().split(',').filter(Boolean);
  if (!parts.length) throw new Error(`invalid_cron_field:${expr}`);
  for (const part of parts) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart !== undefined ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid_cron_step:${part}`);
    let start, end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) throw new Error(`invalid_cron_range:${part}`);
      start = a;
      end = b;
    } else {
      const v = Number(rangePart);
      if (!Number.isInteger(v)) throw new Error(`invalid_cron_value:${part}`);
      start = v;
      end = v;
    }
    if (start < min || end > (mapSevenToZero ? 7 : max)) throw new Error(`cron_out_of_bounds:${part}`);
    for (let i = start; i <= end; i += step) {
      allowed.add(mapSevenToZero && i === 7 ? 0 : i);
    }
  }
  return allowed;
}

export function parseCron(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron_must_have_5_fields:${expression}`);
  }
  return {
    expression: fields.join(' '),
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dom: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12),
    dow: parseCronField(fields[4], 0, 6, { mapSevenToZero: true }),
    domWildcard: fields[2] === '*',
    dowWildcard: fields[4] === '*',
  };
}

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date, timeZone = 'UTC') {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const p of fmt.formatToParts(d)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    dow: WEEKDAY_MAP[map.weekday] ?? 0,
    dateKey: `${map.year}-${map.month}-${map.day}`,
    minuteKey: `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`,
  };
}

export function matchesCron(parsed, date, timeZone = 'UTC') {
  const p = zonedParts(date, timeZone);
  if (!parsed.minute.has(p.minute)) return false;
  if (!parsed.hour.has(p.hour)) return false;
  if (!parsed.month.has(p.month)) return false;
  const domMatch = parsed.dom.has(p.day);
  const dowMatch = parsed.dow.has(p.dow);
  if (!parsed.domWildcard && !parsed.dowWildcard) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

function writeAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
}

export function canManageJob(actor, job) {
  if (!actor || !job) return false;
  const roles = Array.isArray(actor.roles) ? actor.roles.map((r) => String(r).toLowerCase()) : [];
  const isOwnerOrAdmin = roles.includes('owner') || roles.includes('admin');
  // Verified owner/admin in DM can manage ANY job (including group crons)
  if (actor.isInternal && isOwnerOrAdmin && actor.isDm) return true;
  // Owner/admin in same chat or explicit job creator
  if (actor.isInternal && isOwnerOrAdmin) return true;
  if (actor.isInternal && actor.id && job.ownerId && actor.id === job.ownerId) return true;
  return false;
}

export function createScheduler({
  filePath = null,
  defaultTz = 'UTC',
  clock = () => Date.now(),
  onTrigger = null,
  tickIntervalMs = 15_000,
  baseRetryMs = 30_000,
  maxRetryMs = 600_000,
} = {}) {
  const absPath = filePath ? path.resolve(filePath) : null;
  let timer = null;
  const runningJobs = new Set();

  function empty() {
    return { schema: SCHEDULER_SCHEMA, paused: false, jobs: {} };
  }

  function load() {
    if (!absPath || !fs.existsSync(absPath)) return empty();
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return {
      schema: raw.schema || SCHEDULER_SCHEMA,
      paused: Boolean(raw.paused),
      jobs: raw.jobs && typeof raw.jobs === 'object' ? { ...raw.jobs } : {},
    };
  }

  let state = load();

  function persist() {
    if (absPath) writeAtomic(absPath, state);
  }

  function validateTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
    catch { throw new Error(`invalid_timezone:${tz}`); }
  }

  function addJob({
    id = null,
    name = 'Scheduled job',
    cron = null,
    everyMs = null,
    at = null,
    tz = defaultTz,
    targetChatId = null,
    agentName = null,
    prompt = '',
    enabled = true,
    maxDailyRuns = 24,
    maxRetries = 3,
    ownerId = null,
    metadata = {},
  } = {}) {
    const validTz = validateTz(tz || defaultTz);
    if (!cron && !everyMs && !at) {
      throw new Error('addJob: one of cron, everyMs, or at is required');
    }
    if (cron) parseCron(cron); // validates syntax upfront
    if (everyMs != null && (!Number.isFinite(Number(everyMs)) || Number(everyMs) < 1000)) {
      throw new Error('addJob: everyMs must be >= 1000');
    }
    if (at && Number.isNaN(Date.parse(at))) {
      throw new Error(`addJob: invalid ISO timestamp "${at}"`);
    }
    const jobId = id || `job_${crypto.randomBytes(4).toString('hex')}`;
    const nowIso = new Date(clock()).toISOString();
    const job = {
      id: jobId,
      name: String(name || jobId),
      cron: cron ? String(cron).trim() : null,
      everyMs: everyMs != null ? Number(everyMs) : null,
      at: at ? new Date(at).toISOString() : null,
      tz: validTz,
      targetChatId: targetChatId != null ? String(targetChatId) : null,
      agentName: agentName || null,
      prompt: String(prompt || ''),
      enabled: Boolean(enabled),
      maxDailyRuns: Math.max(1, Number(maxDailyRuns || 24)),
      maxRetries: Math.max(0, Number(maxRetries ?? 3)),
      ownerId: ownerId || null,
      metadata: metadata || {},
      createdAt: nowIso,
      updatedAt: nowIso,
      lastRunAt: null,
      lastMinuteKey: null,
      lastStatus: null,
      lastError: null,
      dailyDateKey: null,
      dailyRuns: 0,
      consecutiveFailures: 0,
      retryAt: null,
    };
    state.jobs[jobId] = job;
    persist();
    return { ...job };
  }

  function updateJob(id, patch = {}) {
    const cur = state.jobs[id];
    if (!cur) throw new Error(`job_not_found:${id}`);
    if (patch.cron) parseCron(patch.cron);
    if (patch.tz) validateTz(patch.tz);
    const next = {
      ...cur,
      ...patch,
      id: cur.id,
      updatedAt: new Date(clock()).toISOString(),
    };
    state.jobs[id] = next;
    persist();
    return { ...next };
  }

  function removeJob(id) {
    if (!state.jobs[id]) return { ok: false, removed: false };
    delete state.jobs[id];
    persist();
    return { ok: true, removed: true };
  }

  function getJob(id) {
    return state.jobs[id] ? { ...state.jobs[id] } : null;
  }

  function listJobs({ chatId = null, agentName = null, enabledOnly = false } = {}) {
    return Object.values(state.jobs)
      .filter((j) => (!chatId || j.targetChatId === String(chatId))
        && (!agentName || j.agentName === agentName)
        && (!enabledOnly || j.enabled))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((j) => ({ ...j }));
  }

  function setPaused(paused) {
    state.paused = Boolean(paused);
    persist();
    return { paused: state.paused };
  }

  function isJobDue(job, nowMs) {
    if (!job.enabled) return { due: false, reason: 'disabled' };
    if (runningJobs.has(job.id)) return { due: false, reason: 'running' };
    const parts = zonedParts(nowMs, job.tz || defaultTz);
    const runsToday = job.dailyDateKey === parts.dateKey ? Number(job.dailyRuns || 0) : 0;
    if (runsToday >= Number(job.maxDailyRuns || 24)) {
      return { due: false, reason: 'daily_budget_cap' };
    }
    // Retry window takes precedence when a previous attempt failed
    if (job.retryAt) {
      const retryMs = Date.parse(job.retryAt);
      if (Number.isFinite(retryMs) && nowMs >= retryMs) {
        return { due: true, reason: 'retry', parts };
      }
      return { due: false, reason: 'retry_backoff' };
    }
    if (job.at) {
      const atMs = Date.parse(job.at);
      if (!job.lastRunAt && Number.isFinite(atMs) && nowMs >= atMs) {
        return { due: true, reason: 'oneshot', parts };
      }
      return { due: false, reason: 'oneshot_not_due' };
    }
    if (job.everyMs) {
      const lastMs = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
      if (!lastMs || nowMs - lastMs >= job.everyMs) {
        return { due: true, reason: 'interval', parts };
      }
      return { due: false, reason: 'interval_wait' };
    }
    if (job.cron) {
      if (job.lastMinuteKey === parts.minuteKey) return { due: false, reason: 'already_ran_minute' };
      const parsed = parseCron(job.cron);
      if (matchesCron(parsed, nowMs, job.tz || defaultTz)) {
        return { due: true, reason: 'cron', parts };
      }
    }
    return { due: false, reason: 'not_matched' };
  }

  async function executeJob(job, reason, parts, handler) {
    runningJobs.add(job.id);
    const live = state.jobs[job.id];
    const nowIso = new Date(clock()).toISOString();
    try {
      if (live.dailyDateKey !== parts.dateKey) {
        live.dailyDateKey = parts.dateKey;
        live.dailyRuns = 0;
      }
      live.dailyRuns += 1;
      live.lastRunAt = nowIso;
      live.lastMinuteKey = parts.minuteKey;
      live.retryAt = null;
      persist();

      const out = typeof handler === 'function' ? await handler({ ...live }, { reason, parts }) : null;
      live.lastStatus = 'ok';
      live.lastError = null;
      live.consecutiveFailures = 0;
      if (live.at && !live.cron && !live.everyMs) {
        live.enabled = false; // one-shot completes once
      }
      live.updatedAt = new Date(clock()).toISOString();
      persist();
      return { jobId: live.id, ok: true, output: out };
    } catch (err) {
      const msg = String(err?.message || err);
      live.lastStatus = 'error';
      live.lastError = msg.slice(0, 300);
      live.consecutiveFailures = Number(live.consecutiveFailures || 0) + 1;
      if (live.consecutiveFailures <= Number(live.maxRetries ?? 3)) {
        const delay = err?.retryAfterMs
          ? Math.max(1000, Number(err.retryAfterMs))
          : Math.min(maxRetryMs, baseRetryMs * Math.pow(2, live.consecutiveFailures - 1));
        live.retryAt = new Date(clock() + delay).toISOString();
      } else {
        live.retryAt = null;
      }
      live.updatedAt = new Date(clock()).toISOString();
      persist();
      return { jobId: live.id, ok: false, error: msg, retryAt: live.retryAt };
    } finally {
      runningJobs.delete(job.id);
    }
  }

  async function tick({ handler = onTrigger } = {}) {
    if (state.paused) return { paused: true, triggered: [], skipped: [] };
    const nowMs = clock();
    const triggered = [];
    const skipped = [];
    for (const job of Object.values(state.jobs)) {
      const check = isJobDue(job, nowMs);
      if (!check.due) {
        if (check.reason === 'daily_budget_cap' || check.reason === 'retry_backoff') {
          skipped.push({ jobId: job.id, reason: check.reason });
        }
        continue;
      }
      const res = await executeJob(job, check.reason, check.parts, handler);
      triggered.push(res);
    }
    return { paused: false, triggered, skipped };
  }

  function start({ handler = onTrigger } = {}) {
    if (timer) return;
    timer = setInterval(() => {
      tick({ handler }).catch(() => {});
    }, Math.max(1000, Number(tickIntervalMs || 15_000)));
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    filePath: absPath,
    get paused() { return state.paused; },
    addJob,
    updateJob,
    removeJob,
    getJob,
    listJobs,
    setPaused,
    canManageJob,
    isJobDue,
    tick,
    start,
    stop,
  };
}
