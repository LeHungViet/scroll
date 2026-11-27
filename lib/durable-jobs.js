// SCROLL 2.17 -- sec 57 / sec 58 / sec 63 Durable Multi-Day Job Kernel (`scroll-job/v1`).
// Zero-dependency, vendor-neutral, pure ASCII OSS core (Node >= 20).
//
// Core architectural invariants:
//   1. 8 core lifecycle states (`queued|running|waiting|reconciling|paused|completed|failed|cancelled`)
//      plus structured `waitingFor` (`timer|requester|owner_approval|companion|external|authority`).
//   2. Conditional CAS store (`revision`, `jobEpoch`, `leaseToken`, authoritative lease clock):
//      every wake passes `waiting -> queued -> claim(jobEpoch++) -> running`; parking commits
//      checkpoint, wake contract, and lease release atomically.
//   3. Write `effectIntent(operationId, argsHash)` BEFORE dispatch; unknown outcomes enter
//      `reconciling` and never blindly replay side effects across a 30-day horizon.
//   4. Two-Clock Budget (active slices/minutes/USD + per-day caps decoupled from 7-30d horizon,
//      zero active burn while sleeping; `statutoryLock` capped at 90d escalates instead of expiring).
//   5. Three-Tempo Dual-Speed Cadence (`micro` | `sprint` 30s->3m | `marathon` 15m->4h),
//      `quietHours` suppresses proactive human notifications ONLY (never blocks execution/probes).
//   6. Explicit Exit Contract + Anti-Bailout Interceptor + immutable line-0 `immutableGoal`.
//   7. Three Principals (`requester != owner != approver`), live re-authorization
//      (`effectiveScope = snapshotScope intersect liveScope`), `ask_requester` vs `escalate_owner`
//      with `inlineWaitSec = 0` default, Transactional Outbox (`clientMessageId` + Edit-in-Place),
//      and `steeringInbox` (`intentRev`, scope expansion requires fresh approval).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  redactTicketText,
  redactTicketPayload,
  evaluateGroupOwnerActionGate,
  computeTicketSpecHash,
} from './tickets.js';

export const DURABLE_JOB_SCHEMA = 'scroll-job/v1';

export const DURABLE_JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting',
  'reconciling',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const DURABLE_TERMINAL_STATUSES = Object.freeze(new Set([
  'completed',
  'failed',
  'cancelled',
]));

export const DURABLE_WAIT_REASONS = Object.freeze([
  'timer',
  'requester',
  'owner_approval',
  'companion',
  'external',
  'authority',
]);

export const TEMPO_TIERS = Object.freeze([
  'micro',
  'sprint',
  'marathon',
]);

export const ASK_KINDS = Object.freeze([
  'choice',
  'text',
  'handoff',
]);

export const ASK_TARGET_ROLES = Object.freeze([
  'requester',
  'owner',
]);

export const STEERING_COMMANDS = Object.freeze([
  'clarify',
  'amend',
  'pause',
  'resume',
  'cancel',
]);

export const SPRINT_PROBE_SCHEDULE_SEC = Object.freeze([30, 60, 120, 180]);
export const MARATHON_PROBE_SCHEDULE_SEC = Object.freeze([900, 1800, 3600, 14400]);

export const DEFAULT_JOB_BUDGET = Object.freeze({
  maxSlices: 40,
  maxSlicesPerDay: 20,
  maxActiveMinutes: 60,
  maxUsd: 5.0,
  maxUsdPerDay: 2.0,
  maxConsecutiveFailures: 3,
  maxRestartsPerSlice: 2,
  maxImplicitYields: 2,
  horizonDays: 7,
  statutoryMaxDays: 90,
});

export const HARD_JOB_BUDGET_CEILING = Object.freeze({
  maxSlices: 200,
  maxSlicesPerDay: 60,
  maxActiveMinutes: 480,
  maxUsd: 250.0,
  maxUsdPerDay: 50.0,
  horizonDays: 30,
  statutoryMaxDays: 90,
});

export const JOB_WAIT_MAX_SEC = 45;
export const DEFAULT_INLINE_ASK_WAIT_SEC = 0; // D5: park immediately, never block serial queue
export const DEFAULT_MAX_ASKS_PER_HOUR = 6;
export const DEFAULT_ASK_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_NUDGES = 2;

const WAIT_REASON_SET = new Set(DURABLE_WAIT_REASONS);
const ASK_KIND_SET = new Set(ASK_KINDS);
const STEERING_CMD_SET = new Set(STEERING_COMMANDS);
const UNRESOLVED_EFFECT_STATUSES = Object.freeze(new Set(['dispatched', 'accepted', 'running', 'unknown']));
const TERMINAL_EFFECT_STATUSES = Object.freeze(new Set(['succeeded', 'failed', 'cancelled']));
const ALL_VALID_EFFECT_STATUSES = Object.freeze(new Set([...UNRESOLVED_EFFECT_STATUSES, ...TERMINAL_EFFECT_STATUSES]));
const SAFE_OP_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const FORBIDDEN_PROP_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const SLEEP_ARR = new Int32Array(new SharedArrayBuffer(4));

function sleepMsSync(ms) {
  Atomics.wait(SLEEP_ARR, 0, 0, Math.max(1, Math.round(ms)));
}

function isSafeOpId(id) {
  return typeof id === 'string' && SAFE_OP_ID_RE.test(id) && !FORBIDDEN_PROP_NAMES.has(id);
}

function makeNullProtoDict(src = null) {
  const out = Object.create(null);
  if (src && typeof src === 'object') {
    for (const k of Object.keys(src)) {
      if (FORBIDDEN_PROP_NAMES.has(k)) continue;
      out[k] = src[k];
    }
  }
  return out;
}

function hasUnresolvedEffects(job) {
  if (!job?.effectIntents || typeof job.effectIntents !== 'object') return false;
  for (const k of Object.keys(job.effectIntents)) {
    const it = job.effectIntents[k];
    if (it && UNRESOLVED_EFFECT_STATUSES.has(it.status)) return true;
  }
  return false;
}

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

const STATUS_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'waiting', 'paused', 'cancelled', 'failed']),
  running: new Set(['queued', 'waiting', 'reconciling', 'paused', 'completed', 'failed', 'cancelled']),
  waiting: new Set(['queued', 'reconciling', 'paused', 'cancelled', 'failed']),
  reconciling: new Set(['queued', 'waiting', 'failed', 'cancelled']),
  paused: new Set(['queued', 'cancelled']),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
});

function clampNum(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function stableHash(value) {
  const canon = (v) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(canon);
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
      return out;
    }
    return v;
  };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canon(value))).digest('hex')}`;
}

export function computeJobArgsHash(args) {
  return stableHash(args && typeof args === 'object' ? args : {});
}

export function normalizeJobBudget(raw = {}, { nowMs = Date.now() } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const statutoryLock = Boolean(src.statutoryLock);
  const maxDays = statutoryLock ? HARD_JOB_BUDGET_CEILING.statutoryMaxDays : HARD_JOB_BUDGET_CEILING.horizonDays;
  const horizonDays = Math.round(clampNum(src.horizonDays, DEFAULT_JOB_BUDGET.horizonDays, 1, maxDays));
  const maxSlices = Math.round(clampNum(src.maxSlices, DEFAULT_JOB_BUDGET.maxSlices, 1, HARD_JOB_BUDGET_CEILING.maxSlices));
  const maxSlicesPerDay = Math.round(clampNum(src.maxSlicesPerDay, DEFAULT_JOB_BUDGET.maxSlicesPerDay, 1, Math.min(maxSlices, HARD_JOB_BUDGET_CEILING.maxSlicesPerDay)));
  const maxActiveMinutes = clampNum(src.maxActiveMinutes, DEFAULT_JOB_BUDGET.maxActiveMinutes, 1, HARD_JOB_BUDGET_CEILING.maxActiveMinutes);
  const maxUsd = clampNum(src.maxUsd, DEFAULT_JOB_BUDGET.maxUsd, 0.01, HARD_JOB_BUDGET_CEILING.maxUsd);
  const maxUsdPerDay = clampNum(src.maxUsdPerDay, Math.min(DEFAULT_JOB_BUDGET.maxUsdPerDay, maxUsd), 0.01, Math.min(maxUsd, HARD_JOB_BUDGET_CEILING.maxUsdPerDay));
  const maxExpiresAtMs = nowMs + maxDays * 24 * 60 * 60 * 1000;
  const defaultExpiresAtMs = nowMs + horizonDays * 24 * 60 * 60 * 1000;
  const rawExpires = src.expiresAtMs !== undefined && src.expiresAtMs !== null && Number.isFinite(Number(src.expiresAtMs))
    ? Number(src.expiresAtMs)
    : defaultExpiresAtMs;
  const expiresAtMs = Math.max(nowMs + 60_000, Math.min(maxExpiresAtMs, rawExpires));

  return {
    maxSlices,
    usedSlices: Math.max(0, Number(src.usedSlices || 0)),
    maxSlicesPerDay,
    dailyDateKey: src.dailyDateKey || new Date(nowMs).toISOString().slice(0, 10),
    usedSlicesToday: Math.max(0, Number(src.usedSlicesToday || 0)),
    maxActiveMinutes,
    usedActiveMinutes: Math.max(0, Number(src.usedActiveMinutes || 0)),
    maxUsd,
    maxUsdPerDay,
    usedUsd: Math.max(0, Number(src.usedUsd || 0)),
    usedUsdToday: Math.max(0, Number(src.usedUsdToday || 0)),
    reservedUsd: Math.max(0, Number(src.reservedUsd || 0)),
    maxConsecutiveFailures: Math.round(clampNum(src.maxConsecutiveFailures, DEFAULT_JOB_BUDGET.maxConsecutiveFailures, 1, 10)),
    consecutiveFailures: Math.max(0, Number(src.consecutiveFailures || 0)),
    maxRestartsPerSlice: Math.round(clampNum(src.maxRestartsPerSlice, DEFAULT_JOB_BUDGET.maxRestartsPerSlice, 1, 5)),
    restartsForCurrentSlice: Math.max(0, Number(src.restartsForCurrentSlice || 0)),
    maxImplicitYields: Math.round(clampNum(src.maxImplicitYields, DEFAULT_JOB_BUDGET.maxImplicitYields, 1, 5)),
    implicitYields: Math.max(0, Number(src.implicitYields || 0)),
    horizonDays,
    expiresAtMs,
    statutoryLock,
    statutoryEscalationTarget: src.statutoryEscalationTarget ? String(src.statutoryEscalationTarget) : null,
  };
}

export function evaluateJobBudget(budget, { nowMs = Date.now(), reserveUsd = 0 } = {}) {
  const b = budget || DEFAULT_JOB_BUDGET;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const slicesToday = b.dailyDateKey === today ? Number(b.usedSlicesToday || 0) : 0;
  const usdToday = b.dailyDateKey === today ? Number(b.usedUsdToday || 0) : 0;
  const effReserve = Math.max(0, Number(reserveUsd || 0));

  if (Number(b.usedSlices || 0) >= Number(b.maxSlices || DEFAULT_JOB_BUDGET.maxSlices)) {
    return { allowed: false, code: 'MAX_SLICES_REACHED', reason: `Slice budget exhausted (${b.usedSlices}/${b.maxSlices}).` };
  }
  if (slicesToday >= Number(b.maxSlicesPerDay || DEFAULT_JOB_BUDGET.maxSlicesPerDay)) {
    return { allowed: false, code: 'DAILY_SLICE_CAP_REACHED', reason: `Daily slice cap reached (${slicesToday}/${b.maxSlicesPerDay}).`, retryNextDay: true };
  }
  if (Number(b.usedActiveMinutes || 0) >= Number(b.maxActiveMinutes || DEFAULT_JOB_BUDGET.maxActiveMinutes)) {
    return { allowed: false, code: 'MAX_ACTIVE_MINUTES_REACHED', reason: `Active compute budget exhausted (${b.usedActiveMinutes.toFixed(1)}m/${b.maxActiveMinutes}m).` };
  }
  if (Number(b.usedUsd || 0) + Number(b.reservedUsd || 0) + effReserve > Number(b.maxUsd || DEFAULT_JOB_BUDGET.maxUsd) + 1e-9) {
    return { allowed: false, code: 'MAX_USD_REACHED', reason: `Hard USD cap reached ($${Number(b.usedUsd || 0).toFixed(2)}/$${b.maxUsd}).` };
  }
  if (usdToday + Number(b.reservedUsd || 0) + effReserve > Number(b.maxUsdPerDay || DEFAULT_JOB_BUDGET.maxUsdPerDay) + 1e-9) {
    return { allowed: false, code: 'DAILY_USD_CAP_REACHED', reason: `Daily USD cap reached ($${usdToday.toFixed(2)}/$${b.maxUsdPerDay}).`, retryNextDay: true };
  }
  if (Number(b.consecutiveFailures || 0) >= Number(b.maxConsecutiveFailures || DEFAULT_JOB_BUDGET.maxConsecutiveFailures)) {
    return { allowed: false, code: 'MAX_CONSECUTIVE_FAILURES_REACHED', reason: `Halted after ${b.consecutiveFailures} consecutive failures.` };
  }
  if (b.expiresAtMs && nowMs >= Number(b.expiresAtMs)) {
    if (b.statutoryLock) {
      return { allowed: false, code: 'STATUTORY_HORIZON_ESCALATE', reason: 'Statutory lock reached deadline; owner escalation required without silent expiry.', statutoryEscalate: true };
    }
    return { allowed: false, code: 'HORIZON_EXPIRED', reason: 'Job calendar horizon expired.' };
  }
  return { allowed: true, code: 'OK' };
}

// -- Dual-Speed Tempo Gear & Quiet Hours (Notifications ONLY, never blocks work) --
export function computeTempoTier({
  createdAtMs = 0,
  nowMs = Date.now(),
  requestedSleepSec = 0,
  hasYielded = false,
} = {}) {
  const ageMs = Math.max(0, nowMs - Number(createdAtMs || nowMs));
  const sleepSec = Math.max(0, Number(requestedSleepSec || 0));
  if (!hasYielded && ageMs < 90_000 && sleepSec <= JOB_WAIT_MAX_SEC) return 'micro';
  if (sleepSec > 15 * 60 || ageMs >= 2 * 60 * 60 * 1000) return 'marathon';
  return 'sprint';
}

export function computeNextProbeDelaySec({
  tempoTier = 'sprint',
  negativeProbes = 0,
  pollAfterSec = null,
  etaMs = null,
  nowMs = Date.now(),
  slaDeadlineMs = null,
  jitterRatio = 0,
} = {}) {
  let delaySec;
  if (Number.isFinite(Number(pollAfterSec)) && Number(pollAfterSec) > 0) {
    delaySec = Math.max(10, Math.round(Number(pollAfterSec)));
  } else if (etaMs && Number.isFinite(Number(etaMs)) && Number(etaMs) > nowMs) {
    const untilEtaSec = Math.round((Number(etaMs) - nowMs) / 1000);
    // Wake slightly before or near ETA, bounded by tier cap
    delaySec = Math.max(15, Math.min(untilEtaSec, tempoTier === 'sprint' ? 180 : 3600));
  } else {
    const ladder = tempoTier === 'marathon' ? MARATHON_PROBE_SCHEDULE_SEC : SPRINT_PROBE_SCHEDULE_SEC;
    const idx = Math.min(ladder.length - 1, Math.max(0, Math.floor(Number(negativeProbes || 0))));
    delaySec = ladder[idx];
  }

  if (jitterRatio > 0 && delaySec >= 30) {
    const spread = Math.round(delaySec * Math.min(0.25, jitterRatio));
    delaySec = Math.max(10, delaySec + spread);
  }

  if (slaDeadlineMs && Number.isFinite(Number(slaDeadlineMs)) && Number(slaDeadlineMs) > nowMs) {
    const remainingSec = Math.max(10, Math.floor((Number(slaDeadlineMs) - nowMs) / 1000));
    delaySec = Math.min(delaySec, remainingSec);
  }
  return Math.max(10, delaySec);
}

function parseHm(str, fallbackH, fallbackM) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallbackH * 60 + fallbackM;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const min = Math.max(0, Math.min(59, Number(m[2])));
  return h * 60 + min;
}

function localWallParts(nowMs, tz = 'UTC') {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(new Date(nowMs));
    const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour') % 24,
      minute: get('minute'),
      second: get('second'),
    };
  } catch {
    const d = new Date(nowMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }
}

function localMinutesOfDay(nowMs, tz = 'UTC') {
  const p = localWallParts(nowMs, tz);
  return p.hour * 60 + p.minute;
}

function resolveZonedWallTimeMs(year, month, day, hour, minute, tz = 'UTC', minUtcMs = null) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = targetAsUtc;
  for (let i = 0; i < 4; i++) {
    const lp = localWallParts(guess, tz);
    const localAsUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, lp.second, 0);
    const diff = localAsUtc - targetAsUtc;
    if (diff === 0) break;
    guess -= diff;
  }
  // Probe around guess to capture BOTH occurrences of a fall-back repeated hour (and 30m DST zones) (H9)
  const exactSet = new Set();
  for (const off of [-7200_000, -3600_000, -1800_000, 0, 1800_000, 3600_000, 7200_000]) {
    const cand = Math.floor((guess + off) / 60_000) * 60_000;
    const lp = localWallParts(cand, tz);
    if (lp.year === year && lp.month === month && lp.day === day && lp.hour === hour && lp.minute === minute) {
      exactSet.add(cand);
    }
  }
  if (exactSet.size > 0) {
    const sorted = [...exactSet].sort((a, b) => a - b);
    if (minUtcMs !== null) {
      const next = sorted.find((t) => t > minUtcMs);
      return next !== undefined ? next : null;
    }
    return sorted[0];
  }
  // Spring-forward gap policy (H9): target wall time does not exist on this date (e.g. 02:30 NY -> jumps 01:59 to 03:00).
  // Binary-search for the earliest valid minute instant where local wall time crosses >= target wall time.
  let lo = Math.floor((guess - 7200_000) / 60_000);
  let hi = Math.ceil((guess + 7200_000) / 60_000);
  const isAtOrAfterTarget = (minuteEpoch) => {
    const lp = localWallParts(minuteEpoch * 60_000, tz);
    const localAsUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, 0, 0);
    return localAsUtc >= targetAsUtc;
  };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (isAtOrAfterTarget(mid)) hi = mid;
    else lo = mid + 1;
  }
  const firstAfterGap = lo * 60_000;
  if (minUtcMs !== null && firstAfterGap <= minUtcMs) return null;
  return firstAfterGap;
}

/**
 * Checks whether `nowMs` falls inside room-level quiet hours.
 * IMPORTANT (Council D9): Quiet hours apply ONLY to proactive human notifications/nudges;
 * Sprint/Marathon execution and 0-LLM internal probes NEVER pause for quiet hours.
 */
export function isWithinQuietHours(nowMs, quietHours = null) {
  if (!quietHours || typeof quietHours !== 'object') return false;
  if (quietHours.enabled === false) return false;
  if (!quietHours.start || !quietHours.end) return false;
  const tz = quietHours.tz || quietHours.timezone || 'UTC';
  const cur = localMinutesOfDay(nowMs, tz);
  const start = parseHm(quietHours.start, 22, 0);
  const end = parseHm(quietHours.end, 7, 30);
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end; // overnight window e.g. 22:00-07:30
}

export function nextNotificationWindowMs(nowMs, quietHours = null, { urgent = false } = {}) {
  if (urgent || !isWithinQuietHours(nowMs, quietHours)) return nowMs;
  const tz = quietHours.tz || quietHours.timezone || 'UTC';
  const lp = localWallParts(nowMs, tz);
  const curMin = lp.hour * 60 + lp.minute;
  const endMin = parseHm(quietHours.end, 7, 30);
  const endH = Math.floor(endMin / 60);
  const endM = endMin % 60;
  // Target calendar date in local IANA timezone (DST-safe across spring-forward gap & fall-back repeated hour)
  const addDay = curMin >= endMin ? 1 : 0;
  const targetDate = new Date(Date.UTC(lp.year, lp.month - 1, lp.day + addDay));
  let resolved = resolveZonedWallTimeMs(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth() + 1,
    targetDate.getUTCDate(),
    endH,
    endM,
    tz,
    nowMs,
  );
  if (resolved === null || resolved <= nowMs) {
    const nextDate = new Date(Date.UTC(lp.year, lp.month - 1, lp.day + addDay + 1));
    resolved = resolveZonedWallTimeMs(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      endH,
      endM,
      tz,
      nowMs,
    );
  }
  return resolved;
}

// -- Anti-Bailout Interceptor (No-Promise-Without-Hook, pure ASCII with NFD accent folding) --
const FIRST_PERSON_PROMISE_PATTERNS = [
  /\b(?:i'll|i\s+will|we'll|we\s+will)\s+(?:(?:\w+\s+){0,2})?(?:check\s+back|recheck|monitor|follow\s+up|let\s+you\s+know|notify\s+you|update\s+you)\b/i,
  /\bplease\s+(?:check\s+again|try\s+again\s+later|come\s+back\s+later)\b/i,
  /\b(?:em|minh|toi)\s+se\s+(?:(?:\w+\s+){0,3})?(?:kiem\s+tra\s+lai|check\s+lai|theo\s+doi|bao\s+lai|cap\s+nhat\s+lai|bao\s+ngay)\b/i,
  /\bkhi\s+nao\b[\s\S]{0,60}\b(?:xong|co\s+ket\s+qua|hoan\s+tat)\b[\s\S]{0,40}\b(?:em|minh|toi)\b[\s\S]{0,30}\b(?:bao|nhan|gui|kiem\s+tra|check)\b/i,
];

const PENDING_CONTEXT_PROMISE_PATTERNS = [
  /\bonce\s+(?:it|the\s+(?:\w+\s+){1,3})(?:finishes|completes|is\s+ready)\b/i,
  /\bse\s+(?:(?:\w+\s+){0,3})?(?:kiem\s+tra\s+lai|check\s+lai|theo\s+doi|bao\s+lai|cap\s+nhat\s+lai|bao\s+ngay)\b/i,
  /\bkhi\s+nao\b[\s\S]{0,60}\b(?:xong|co\s+ket\s+qua|hoan\s+tat)\b[\s\S]{0,50}\b(?:bao|nhan|gui|kiem\s+tra|check)\b/i,
];

function foldAscii(str) {
  return String(str || '')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0110\u0111]/g, 'd');
}

const PENDING_TOOL_STATUS_RE = /\b(pending|processing|queued|in_progress|running|accepted|not_ready|still_generating)\b/i;

export function detectPoliteBailout(replyText, {
  toolTraces = [],
  hasJobYield = false,
  hasJobAsk = false,
  hasJobComplete = false,
  hasPendingToolStatus = false,
} = {}) {
  if (hasJobYield || hasJobAsk || hasJobComplete) {
    return { detected: false, reason: 'explicit_hook_present' };
  }
  const text = foldAscii(replyText).trim();
  if (!text) return { detected: false, reason: 'ok' };
  const tracePending = Boolean(hasPendingToolStatus) || (Array.isArray(toolTraces) && toolTraces.some((tr) => {
    const raw = typeof tr === 'string' ? tr : JSON.stringify(tr || {});
    return PENDING_TOOL_STATUS_RE.test(raw);
  }));
  const matchesFirstPerson = FIRST_PERSON_PROMISE_PATTERNS.some((re) => re.test(text));
  const matchesPendingPhrase = PENDING_CONTEXT_PROMISE_PATTERNS.some((re) => re.test(text));

  if ((matchesFirstPerson || matchesPendingPhrase) && tracePending) {
    return {
      detected: true,
      code: 'POLITE_BAILOUT_BLOCKED',
      reason: 'Model promised future follow-up after pending tool output without scheduling job_yield.',
    };
  }
  if (matchesFirstPerson) {
    return {
      detected: true,
      code: 'PROMISE_WITHOUT_HOOK',
      reason: 'Model emitted future follow-up promise without an active durable hook.',
    };
  }
  return { detected: false, reason: 'ok' };
}

// -- sec 63: Live Re-Authorization (`effectiveScope = snapshotScope intersect liveScope`) --
const GROUP_FORBIDDEN_CAPABILITIES = new Set(['secret_fill', 'secret_resolve', 'captcha_handoff']);

function matchesApproverPrincipal(job, cleanActor) {
  if (!cleanActor || !job?.principals?.approver) return false;
  const ap = job.principals.approver;
  if (typeof ap === 'string') return cleanActor === ap.trim();
  if (typeof ap === 'object') {
    return (ap.principalId && cleanActor === String(ap.principalId).trim())
      || (ap.externalId && cleanActor === String(ap.externalId).trim());
  }
  return false;
}

export function evaluateEffectiveAuthority({
  job,
  liveAuth = null,
  nowMs = Date.now(),
} = {}) {
  if (!job || typeof job !== 'object') {
    return { allowed: false, code: 'JOB_NOT_FOUND', parkWaitingFor: 'authority' };
  }
  const hasLiveObj = Boolean(liveAuth && typeof liveAuth === 'object');
  const live = hasLiveObj ? liveAuth : {};
  if (live.policyLookupFailed === true) {
    return { allowed: false, code: 'AUTHORITY_LOOKUP_FAILED', reason: 'Live policy check failed; failing closed.', parkWaitingFor: 'authority' };
  }
  if (live.agentPaused === true) {
    return { allowed: false, code: 'AGENT_PAUSED', reason: 'Agent is paused; suspending durable job.', parkWaitingFor: 'authority' };
  }
  if (job.authority?.expiresAtMs && nowMs >= Number(job.authority.expiresAtMs)) {
    return { allowed: false, code: 'AUTHORITY_EXPIRED', reason: 'Job authority grant expired.', parkWaitingFor: 'authority' };
  }

  const isGroup = Boolean(job.audienceRoom?.isGroup);
  const snapshotTools = Array.isArray(job.authority?.toolScope) ? job.authority.toolScope.map(String) : null;
  const liveTools = Array.isArray(live.allowedTools) ? new Set(live.allowedTools.map(String)) : null;

  if (job.authority?.ticketId && live.ticketRevoked === true) {
    return { allowed: false, code: 'TICKET_REVOKED', reason: 'Backing approval ticket was revoked or rejected.', parkWaitingFor: 'authority' };
  }

  const ownerSet = new Set((job.principals?.ownerIds || []).map(String));
  const reqId = String(job.principals?.requester?.principalId || '');
  const isOwnerRequester = Boolean(
    job.authority?.policySnapshot?.isOwnerSender === true
    || (reqId && ownerSet.has(reqId))
    || (ownerSet.size === 0 && reqId === 'owner'),
  );

  if (isGroup) {
    if (live.botInRoom === false) {
      return { allowed: false, code: 'BOT_REMOVED', reason: 'Bot is no longer a member of the originating group.', parkWaitingFor: 'authority' };
    }
    const effectivePolicy = String(live.groupPolicy || job.authority?.policySnapshot?.groupPolicy || 'owner_or_approve').toLowerCase();
    if (effectivePolicy === 'owner_dm_only') {
      return { allowed: false, code: 'POLICY_RESTRICTED', reason: 'Group policy tightened to owner_dm_only.', parkWaitingFor: 'authority' };
    }
    if (live.ownerInRoom === false) {
      return { allowed: false, code: 'OWNER_LEFT_ROOM', reason: 'Owner is no longer verified in the originating group.', parkWaitingFor: 'authority' };
    }
    if (!hasLiveObj || live.botInRoom !== true || live.ownerInRoom !== true) {
      return {
        allowed: false,
        code: 'AUTHORITY_LOOKUP_FAILED',
        reason: 'Group durable job requires verified liveAuth (botInRoom=true and ownerInRoom=true).',
        parkWaitingFor: 'authority',
      };
    }
    const ownerInRoom = true;
    const gate = evaluateGroupOwnerActionGate({
      isGroup: true,
      isOwnerSender: Boolean(job.authority?.policySnapshot?.isOwnerSender),
      ownerInRoom,
      policy: effectivePolicy,
    });
    if (gate.decision === 'deny') {
      return { allowed: false, code: 'GROUP_GATE_DENIED', reason: gate.reason, parkWaitingFor: 'authority' };
    }
    if (gate.decision === 'require_approval' && !job.authority?.ticketId) {
      return { allowed: false, code: 'APPROVAL_GRANT_REQUIRED', reason: 'Group job requires an active approved ticket grant.', parkWaitingFor: 'authority' };
    }
    if (live.ownerGroupSafe === false && job.authority?.policySnapshot?.ownerGroupSafe === true) {
      return { allowed: false, code: 'OWNER_GROUP_SAFE_REVOKED', reason: 'Companion ownerGroupSafe capability was revoked.', parkWaitingFor: 'authority' };
    }
  } else if (!isOwnerRequester) {
    // Non-owner DM job: require explicit approval ticket and forbid secrets/CAPTCHA handoff!
    if (!job.authority?.ticketId) {
      return {
        allowed: false,
        code: 'APPROVAL_GRANT_REQUIRED',
        reason: 'Non-owner DM durable job requires an active approved ticket grant.',
        parkWaitingFor: 'authority',
      };
    }
  }

  // Verify specHash integrity if ticket-backed (fail-closed if specHash exists and liveSpecHash is missing or mismatched)
  const liveSpecHash = live.liveSpecHash ?? live.approvedSpecHash ?? null;
  if (job.authority?.specHash) {
    if (!liveSpecHash) {
      return { allowed: false, code: 'AUTHORITY_LOOKUP_FAILED', reason: 'Live specHash verification missing for ticket-backed job.', parkWaitingFor: 'authority' };
    }
    if (job.authority.specHash !== liveSpecHash) {
      return { allowed: false, code: 'SPEC_HASH_MISMATCH', reason: 'Ticket specHash changed after approval.', parkWaitingFor: 'authority' };
    }
  }

  const forbidSecrets = isGroup || !isOwnerRequester;
  // Compute strict intersection: effectiveScope = snapshotScope intersect liveScope
  let effectiveTools = snapshotTools ? [...snapshotTools] : (liveTools ? [...liveTools] : []);
  if (snapshotTools && liveTools) {
    effectiveTools = snapshotTools.filter((t) => liveTools.has(t));
  }
  if (forbidSecrets) {
    effectiveTools = effectiveTools.filter((t) => !GROUP_FORBIDDEN_CAPABILITIES.has(t));
  }

  return {
    allowed: true,
    code: 'OK',
    isGroup,
    effectiveTools,
    forbidSecrets,
    forbidCaptchaHandoff: forbidSecrets,
  };
}

// -- sec 63: Requester vs Owner vs Approver vs Stranger Steering Matrix --
export function evaluateSteeringPermission({
  job,
  actorId,
  actorRole = null,
  actorChannel = null,
  commandKind = 'clarify',
  requestedCapabilities = [],
} = {}) {
  if (!job || typeof job !== 'object') {
    return { allowed: false, code: 'JOB_NOT_FOUND' };
  }
  const cmd = String(commandKind || '').trim().toLowerCase();
  if (!STEERING_CMD_SET.has(cmd)) {
    return { allowed: false, code: 'INVALID_STEERING_COMMAND' };
  }
  const cleanActor = actorId != null ? String(actorId).trim() : '';
  const ownerSet = new Set((job.principals?.ownerIds || []).map(String));
  const req = job.principals?.requester || {};
  const isOwner = actorRole === 'owner' || (cleanActor && ownerSet.has(cleanActor));
  const isApprover = !isOwner && (actorRole === 'approver' || matchesApproverPrincipal(job, cleanActor));
  const channelMatches = !actorChannel || !job.audienceRoom?.channel || String(actorChannel).trim().toLowerCase() === String(job.audienceRoom.channel).trim().toLowerCase();
  const isRequester = !isOwner && !isApprover && (
    (cleanActor && req.principalId && cleanActor === String(req.principalId))
    || (cleanActor && channelMatches && req.externalId && cleanActor === String(req.externalId))
  );

  if (isOwner) {
    return { allowed: true, effectiveRole: 'owner', requiresNewApproval: false, code: 'OK' };
  }
  if (!isApprover && !isRequester) {
    return {
      allowed: false,
      effectiveRole: 'stranger',
      code: 'STEERING_DENIED_STRANGER',
      reason: 'Only the task requester, designated approver, or workspace owner may steer, pause, or cancel this job.',
    };
  }
  const nonOwnerRole = isApprover ? 'approver' : 'requester';
  // Neither requester NOR designated approver may resume OR relabel/overwrite an owner/statutory pause (SPEC sec 63 / R3 / N1)
  if ((cmd === 'resume' || cmd === 'pause') && (job.pausedByRole === 'owner' || job.pausedReason === 'statutory')) {
    return {
      allowed: false,
      effectiveRole: nonOwnerRole,
      requiresNewApproval: false,
      code: 'OWNER_PAUSE_LOCKED',
      reason: 'Only the workspace owner may modify or resume a job locked by an owner or statutory pause.',
    };
  }
  if (isApprover) {
    if (cmd === 'amend') {
      return {
        allowed: false,
        effectiveRole: 'approver',
        requiresNewApproval: true,
        code: 'REAPPROVAL_REQUIRED',
        reason: 'Approvers may clarify, pause, resume, or cancel, but scope amendments require owner/new approval.',
      };
    }
    return { allowed: true, effectiveRole: 'approver', requiresNewApproval: false, code: 'OK' };
  }
  if (cmd === 'clarify' || cmd === 'pause' || cmd === 'resume' || cmd === 'cancel') {
    return { allowed: true, effectiveRole: 'requester', requiresNewApproval: false, code: 'OK' };
  }

  // `amend` by requester: allowed ONLY inside granted toolScope; expanding scope needs fresh approval
  const granted = new Set((job.authority?.toolScope || []).map(String));
  const reqCaps = Array.isArray(requestedCapabilities) ? requestedCapabilities.map(String).filter(Boolean) : [];
  const unauthorized = reqCaps.filter((c) => !granted.has(c));
  if (unauthorized.length > 0) {
    return {
      allowed: false,
      effectiveRole: 'requester',
      requiresNewApproval: true,
      unauthorizedCapabilities: unauthorized,
      code: 'REAPPROVAL_REQUIRED',
      reason: `Amendment expands scope beyond approved grant: ${unauthorized.join(', ')}`,
    };
  }
  return { allowed: true, effectiveRole: 'requester', requiresNewApproval: false, code: 'OK' };
}

// -- Audience-safe job projection (never leaks DM notes, owner rejections, or secrets to groups) --
export function projectJobForAudience(job, { isOwner = false, isGroup = false, chatId = null } = {}) {
  if (!job || typeof job !== 'object') return null;
  if (isOwner && !isGroup) return structuredClone(job);
  const reqChat = chatId != null ? String(chatId).trim() : '';
  const jobChat = job.audienceRoom?.chatId != null ? String(job.audienceRoom.chatId).trim() : '';
  if (!reqChat || !jobChat || reqChat !== jobChat) return null;

  const isWaitingOwner = job.status === 'waiting' && (job.waitingFor === 'owner_approval' || job.waitingFor === 'authority');
  return {
    jobId: job.jobId,
    status: job.status,
    waitingFor: isWaitingOwner ? 'owner_approval_neutral' : job.waitingFor,
    neutralNotice: isWaitingOwner
      ? 'This task is awaiting administrator authorization for the next step and will resume automatically.'
      : null,
    tempoTier: job.tempoTier,
    requesterName: job.principals?.requester?.name || null,
    immutableGoal: redactTicketText(job.checkpoint?.immutableGoal || '', 500),
    milestone: job.checkpoint?.milestone || null,
    progressSummary: redactTicketText(job.checkpoint?.progressSummary || '', 300),
    finalReport: job.finalReport ? {
      summary: redactTicketText(job.finalReport.summary || '', 2000),
      deliverables: Array.isArray(job.finalReport.deliverables) ? job.finalReport.deliverables : [],
      completedAt: job.finalReport.completedAt || null,
    } : null,
    nextReviewAt: job.wake?.nextReviewAt || null,
    usedSlices: job.budget?.usedSlices || 0,
    maxSlices: job.budget?.maxSlices || DEFAULT_JOB_BUDGET.maxSlices,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// -- Canonical Durable Job Tool Schemas (scroll-core) --
export const SCROLL_DURABLE_JOB_TOOL_SCHEMAS = Object.freeze([
  Object.freeze({
    name: 'job_wait',
    description: 'Pause briefly (1..45s) inside the current active slice while a fast UI transition or upload settles. For waits longer than 45s, call job_yield.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'read_only',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Seconds to pause (clamped to 1..45).' },
        reason: { type: 'string', description: 'Brief wait reason.' },
      },
      required: ['seconds'],
    },
  }),
  Object.freeze({
    name: 'job_yield',
    description: 'Persist durable checkpoint, release active slice resources (0 sleep cost), and schedule an automatic recheck via sleepSec/wakeAt, event wakeOn[], or a host-registered 0-LLM probeName.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'reversible_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        waitingFor: { type: 'string', enum: DURABLE_WAIT_REASONS },
        sleepSec: { type: 'number', description: 'Seconds until next review/probe.' },
        wakeAt: { type: 'string', description: 'ISO-8601 timestamp for next review.' },
        wakeOn: { type: 'array', items: { type: 'object' }, description: 'Event wake triggers (matched via ANY).' },
        probeName: { type: 'string', description: 'Host-registered 0-LLM probe identifier (raw URLs/paths forbidden).' },
        probeArgs: { type: 'object' },
        checkpoint: { type: 'object', description: 'Updated progressSummary, milestone, nextAction, reacquireAnchors, artifactRefs, state.' },
      },
      required: ['checkpoint'],
    },
  }),
  Object.freeze({
    name: 'job_complete',
    description: 'Mark a DurableJob completed with verified deliverables matching the immutable line-0 goal.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'reversible_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        summary: { type: 'string' },
        deliverables: { type: 'array', items: { type: 'object' } },
        verifiedCriteria: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary'],
    },
  }),
  Object.freeze({
    name: 'job_fail',
    description: 'Terminate a DurableJob cleanly when blocked by an unrecoverable error.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'reversible_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        code: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['reason'],
    },
  }),
  Object.freeze({
    name: 'job_status',
    description: 'Inspect status, active slice budget, and next scheduled review of a DurableJob.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'read_only',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
      },
    },
  }),
  Object.freeze({
    name: 'job_cancel',
    description: 'Request cancellation of a DurableJob (requester or owner only; reconciles in-flight effects before confirming cancelled).',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'reversible_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['jobId'],
    },
  }),
  Object.freeze({
    name: 'ask_requester',
    description: 'Ask the task requester a business/output clarification in the originating room thread (`choice | text | handoff`). Parks immediately (inlineWaitSec=0); never requests secrets.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'external_comm',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        kind: { type: 'string', enum: ASK_KINDS },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'object' } },
        dedupeKey: { type: 'string' },
        defaultOption: { type: 'string', description: 'Optional safe default for Default-Unless-Vetoed (read_only/reversible choices only).' },
        defaultAfterSec: { type: 'number', description: 'Seconds before applying safe default if requester stays silent.' },
        checkpoint: { type: 'object' },
      },
      required: ['kind', 'question'],
    },
  }),
  Object.freeze({
    name: 'escalate_owner',
    description: 'Escalate risk approvals, permission blocks, or owner-only actions privately to Owner DM. Emits only a neutral status line in multi-user groups; parks immediately (inlineWaitSec=0).',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'external_comm',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        kind: { type: 'string', enum: ASK_KINDS },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'object' } },
        dedupeKey: { type: 'string' },
        checkpoint: { type: 'object' },
      },
      required: ['kind', 'question'],
    },
  }),
  Object.freeze({
    name: 'job_notify',
    description: 'Emit an idempotent milestone update or Edit-in-Place status card refresh via the Transactional Outbox.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'external_comm',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        kind: { type: 'string', enum: ['ack_card', 'progress_edit', 'eta_slip', 'final_result'] },
        milestoneId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['jobId', 'kind', 'text'],
    },
  }),
]);

// -- Atomic Conditional-CAS DurableJob Store (In-Memory + File-Backed Reference Store) --
export function createDurableJobStore({
  filePath = null,
  clock = () => Date.now(),
  quietHours = null,
} = {}) {
  const absPath = filePath ? path.resolve(String(filePath)) : null;
  const lockFile = absPath ? `${absPath}.lock` : null;

  const state = {
    jobs: new Map(),           // jobId -> job
    byOriginKey: new Map(),    // tenant|agent|originDedupeKey -> jobId
    asks: new Map(),           // askId -> ask
    outbox: new Map(),         // clientMessageId -> outboxRecord
    steering: new Map(),       // `${jobId}:${sourceEventId}` -> steeringRecord
  };

  function serializeState() {
    const jobs = [...state.jobs.values()].map((j) => ({
      ...j,
      effectIntents: Object.fromEntries(Object.keys(j.effectIntents || {}).map((k) => [k, j.effectIntents[k]])),
    }));
    return JSON.stringify({
      schema: DURABLE_JOB_SCHEMA,
      jobs,
      asks: [...state.asks.values()],
      outbox: [...state.outbox.values()],
      steering: [...state.steering.values()],
    }, null, 2) + '\n';
  }

  function failCorruptSnapshot(detail) {
    // Preserve damaged snapshot for operator forensics; NEVER silently skip or wipe rows (B3)!
    try {
      const corruptCopy = `${absPath}.corrupt.${Date.now()}`;
      if (!fs.existsSync(corruptCopy)) fs.copyFileSync(absPath, corruptCopy);
    } catch { /* best-effort forensic copy */ }
    const e = new Error(`ERR_DURABLE_JOB_STORE_CORRUPT: ${detail}`);
    e.code = 'ERR_DURABLE_JOB_STORE_CORRUPT';
    throw e;
  }

  function hydrateFromDisk() {
    if (!absPath || !fs.existsSync(absPath)) return;
    let rawText;
    try {
      rawText = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      const e = new Error(`ERR_DURABLE_JOB_STORE_READ_FAILED: ${err?.message || err}`);
      e.code = 'ERR_DURABLE_JOB_STORE_READ_FAILED';
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      failCorruptSnapshot(err?.message || String(err));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== DURABLE_JOB_SCHEMA) {
      failCorruptSnapshot('Invalid durable job snapshot schema');
    }
    if (!Array.isArray(parsed.jobs)) failCorruptSnapshot('Snapshot jobs collection must be an array');
    if (!Array.isArray(parsed.asks)) failCorruptSnapshot('Snapshot asks collection must be an array');
    if (!Array.isArray(parsed.outbox)) failCorruptSnapshot('Snapshot outbox collection must be an array');
    if (!Array.isArray(parsed.steering)) failCorruptSnapshot('Snapshot steering collection must be an array');

    const statusSet = new Set(DURABLE_JOB_STATUSES);
    const nextJobs = new Map();
    const nextByOrigin = new Map();
    const nextAsks = new Map();
    const nextOutbox = new Map();
    const nextSteering = new Map();

    for (let i = 0; i < parsed.jobs.length; i++) {
      const j = parsed.jobs[i];
      if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.jobId !== 'string' || !j.jobId.trim()) {
        failCorruptSnapshot(`Malformed job row at index ${i}`);
      }
      if (!statusSet.has(j.status)) {
        failCorruptSnapshot(`Invalid job status at index ${i} (${j.jobId})`);
      }
      if (nextJobs.has(j.jobId)) {
        failCorruptSnapshot(`Duplicate jobId in snapshot: ${j.jobId}`);
      }
      if (j.effectIntents !== undefined) {
        if (j.effectIntents === null || typeof j.effectIntents !== 'object' || Array.isArray(j.effectIntents)) {
          failCorruptSnapshot(`Malformed effectIntents on job ${j.jobId}`);
        }
        for (const [opKey, entry] of Object.entries(j.effectIntents)) {
          if (!isSafeOpId(opKey) || !entry || typeof entry !== 'object' || Array.isArray(entry) || !ALL_VALID_EFFECT_STATUSES.has(entry.status)) {
            failCorruptSnapshot(`Malformed effectIntent entry ${opKey} on job ${j.jobId}`);
          }
        }
      }
      if (j.eventInbox !== undefined && !Array.isArray(j.eventInbox)) {
        failCorruptSnapshot(`Malformed eventInbox on job ${j.jobId}`);
      }
      if (j.steeringPending !== undefined && !Array.isArray(j.steeringPending)) {
        failCorruptSnapshot(`Malformed steeringPending on job ${j.jobId}`);
      }
      const hydratedJob = {
        ...j,
        effectIntents: makeNullProtoDict(j.effectIntents),
        eventInbox: Array.isArray(j.eventInbox) ? j.eventInbox : [],
        steeringPending: Array.isArray(j.steeringPending) ? j.steeringPending : [],
      };
      nextJobs.set(hydratedJob.jobId, hydratedJob);
      const okKey = `${hydratedJob.tenantId}|${hydratedJob.agentId}|${hydratedJob.origin?.dedupeKey || hydratedJob.jobId}`;
      nextByOrigin.set(okKey, hydratedJob.jobId);
    }

    for (let i = 0; i < (parsed.asks || []).length; i++) {
      const a = parsed.asks[i];
      if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.askId !== 'string' || !a.askId.trim() || typeof a.jobId !== 'string' || !a.jobId.trim()) {
        failCorruptSnapshot(`Malformed ask row at index ${i}`);
      }
      if (nextAsks.has(a.askId)) failCorruptSnapshot(`Duplicate askId in snapshot: ${a.askId}`);
      nextAsks.set(a.askId, a);
    }

    for (let i = 0; i < (parsed.outbox || []).length; i++) {
      const o = parsed.outbox[i];
      if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.clientMessageId !== 'string' || !o.clientMessageId.trim() || typeof o.jobId !== 'string' || !o.jobId.trim()) {
        failCorruptSnapshot(`Malformed outbox row at index ${i}`);
      }
      if (nextOutbox.has(o.clientMessageId)) failCorruptSnapshot(`Duplicate outbox clientMessageId in snapshot: ${o.clientMessageId}`);
      nextOutbox.set(o.clientMessageId, o);
    }

    for (let i = 0; i < (parsed.steering || []).length; i++) {
      const s = parsed.steering[i];
      if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.jobId !== 'string' || !s.jobId.trim() || typeof s.sourceEventId !== 'string' || !s.sourceEventId.trim()) {
        failCorruptSnapshot(`Malformed steering row at index ${i}`);
      }
      const sk = `${s.jobId}:${s.sourceEventId}`;
      if (nextSteering.has(sk)) failCorruptSnapshot(`Duplicate steering key in snapshot: ${sk}`);
      nextSteering.set(sk, s);
    }

    state.jobs = nextJobs;
    state.byOriginKey = nextByOrigin;
    state.asks = nextAsks;
    state.outbox = nextOutbox;
    state.steering = nextSteering;
  }

  function withFileLock(fn, { shouldPersist = null } = {}) {
    if (!absPath) return fn();
    const dirPath = path.dirname(absPath);
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    const myHost = os.hostname();
    const myNonce = crypto.randomBytes(12).toString('hex');
    const lockPayload = JSON.stringify({ pid: process.pid, host: myHost, nonce: myNonce, createdAt: Date.now() });
    let fd = null;
    const deadline = Date.now() + 3000;
    while (fd === null) {
      try {
        fd = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeFileSync(fd, lockPayload, 'utf8');
        try { fs.fsyncSync(fd); } catch { /* ignore */ }
      } catch (err) {
        if (err.code !== 'EEXIST') {
          throw new Error(`ERR_JOB_STORE_LOCK_IO: ${err.code || err.message}`);
        }
        // NEVER steal a lock held by a still-alive PID on the same host, regardless of age (B4)!
        let stolen = false;
        try {
          const st = fs.statSync(lockFile);
          const ageMs = Date.now() - st.mtimeMs;
          let holder = null;
          let rawLock = '';
          try {
            rawLock = fs.readFileSync(lockFile, 'utf8');
            if (rawLock) holder = JSON.parse(rawLock);
          } catch { /* corrupt or mid-write lock */ }

          let canSteal = false;
          if (holder && Number.isInteger(Number(holder.pid))) {
            const sameHost = !holder.host || holder.host === myHost;
            if (sameHost) {
              // Same host: ONLY steal if PID is confirmed dead
              canSteal = !isPidAlive(holder.pid);
            } else {
              // Different host on shared volume: conservative 60s stale grace
              canSteal = ageMs > 60_000;
            }
          } else if (ageMs > 15_000) {
            // Unparseable/0-byte crashed lockfile older than 15s
            canSteal = true;
          }

          if (canSteal) {
            // Serialize stale-lock reclaim with a short-lived exclusive `.reclaim` lock so two
            // contenders can never inspect the same stale lock and unlink each other's fresh lock (B4).
            const reclaimLock = `${lockFile}.reclaim`;
            let reclaimFd = null;
            try {
              reclaimFd = fs.openSync(reclaimLock, 'wx', 0o600);
              fs.writeFileSync(reclaimFd, JSON.stringify({ pid: process.pid, host: myHost, createdAt: Date.now() }), 'utf8');
            } catch (rErr) {
              // Clean up orphaned .reclaim lock if its owner PID is dead (or > 15s stale)
              if (rErr?.code === 'EEXIST') {
                try {
                  const rst = fs.statSync(reclaimLock);
                  let rHolder = null;
                  try { rHolder = JSON.parse(fs.readFileSync(reclaimLock, 'utf8')); } catch { /* ignore */ }
                  const rDead = rHolder?.pid && (!rHolder.host || rHolder.host === myHost) ? !isPidAlive(rHolder.pid) : (Date.now() - rst.mtimeMs) > 15_000;
                  if (rDead) fs.unlinkSync(reclaimLock);
                } catch { /* ignore */ }
              }
            }
            if (reclaimFd !== null) {
              try {
                const recheckRaw = fs.readFileSync(lockFile, 'utf8');
                if (recheckRaw === rawLock) {
                  fs.unlinkSync(lockFile);
                  stolen = true;
                }
              } finally {
                try { fs.closeSync(reclaimFd); } catch { /* ignore */ }
                try { fs.unlinkSync(reclaimLock); } catch { /* ignore */ }
              }
            }
          }
        } catch { /* lock released concurrently */ }
        if (stolen) continue;
        if (Date.now() > deadline) {
          throw new Error('ERR_JOB_STORE_LOCK_CONTENTION');
        }
        sleepMsSync(10);
      }
    }
    let tmp = null;
    try {
      hydrateFromDisk();
      const res = fn();
      const persistNow = typeof shouldPersist === 'function' ? Boolean(shouldPersist(res)) : true;
      if (persistNow) {
        tmp = `${absPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
        const tmpFd = fs.openSync(tmp, 'wx', 0o600);
        try {
          fs.writeFileSync(tmpFd, serializeState(), 'utf8');
          fs.fsyncSync(tmpFd);
        } finally {
          fs.closeSync(tmpFd);
        }
        // Verify lock nonce ownership IMMEDIATELY BEFORE atomic rename (B4)
        let curLock = null;
        try { curLock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { curLock = null; }
        if (!curLock || curLock.nonce !== myNonce || Number(curLock.pid) !== process.pid) {
          const e = new Error('ERR_JOB_STORE_LOCK_LOST');
          e.code = 'ERR_JOB_STORE_LOCK_LOST';
          throw e;
        }
        fs.renameSync(tmp, absPath);
        tmp = null;
        // Fsync parent directory for power-loss durability of the rename (B4)
        try {
          const dirFd = fs.openSync(dirPath, 'r');
          try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch { /* unsupported on some platforms/filesystems */ }
      }
      return res;
    } finally {
      if (tmp) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      try { fs.closeSync(fd); } catch { /* ignore */ }
      // Only unlink lockfile if we still own the nonce
      try {
        const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (cur?.nonce === myNonce) fs.unlinkSync(lockFile);
      } catch { /* ignore */ }
    }
  }

  hydrateFromDisk();

  function assertTransition(from, to) {
    const allowed = STATUS_TRANSITIONS[from];
    return Boolean(allowed && allowed.has(to));
  }

  function verifyLease(job, { revision, jobEpoch, leaseToken, nowMs }) {
    if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };
    if (job.status !== 'running') return { ok: false, code: 'JOB_NOT_RUNNING', status: job.status };
    if (!job.lease) return { ok: false, code: 'LEASE_MISSING' };
    if (revision === null || revision === undefined || !Number.isFinite(Number(revision))) {
      return { ok: false, code: 'CAS_REVISION_REQUIRED', expectedRevision: job.revision };
    }
    if (Number(revision) !== Number(job.revision)) {
      return { ok: false, code: 'CAS_REVISION_CONFLICT', expectedRevision: job.revision, receivedRevision: revision };
    }
    if (Number(jobEpoch) !== Number(job.jobEpoch)) {
      return { ok: false, code: 'STALE_JOB_EPOCH', expectedEpoch: job.jobEpoch, receivedEpoch: jobEpoch };
    }
    if (String(leaseToken || '') !== String(job.lease.leaseToken)) {
      return { ok: false, code: 'LEASE_TOKEN_MISMATCH' };
    }
    if (nowMs >= Number(job.lease.expiresAtMs)) {
      return { ok: false, code: 'LEASE_EXPIRED' };
    }
    return { ok: true };
  }

  function hasBlockingOwnerAsk(jobId) {
    for (const a of state.asks.values()) {
      if (a.jobId === jobId && a.targetRole === 'owner' && (a.status === 'open' || a.status === 'paused')) {
        return true;
      }
    }
    return false;
  }

  function mergeCheckpoint(job, cp) {
    if (!cp || typeof cp !== 'object') return;
    job.checkpoint = {
      ...job.checkpoint,
      version: Number(job.checkpoint.version || 0) + 1,
      immutableGoal: job.checkpoint.immutableGoal,
      doneCriteria: job.checkpoint.doneCriteria,
      milestone: cp.milestone ? redactTicketText(cp.milestone, 120) : job.checkpoint.milestone,
      progressSummary: cp.progressSummary !== undefined ? redactTicketText(cp.progressSummary, 600) : job.checkpoint.progressSummary,
      nextAction: cp.nextAction !== undefined ? redactTicketText(cp.nextAction, 600) : job.checkpoint.nextAction,
      reacquireAnchors: cp.reacquireAnchors !== undefined ? redactTicketPayload(cp.reacquireAnchors) : job.checkpoint.reacquireAnchors,
      artifactRefs: Array.isArray(cp.artifactRefs) ? redactTicketPayload(cp.artifactRefs) : job.checkpoint.artifactRefs,
      state: cp.state !== undefined ? redactTicketPayload(cp.state) : job.checkpoint.state,
      lastObservedAtMs: cp.lastObservedAtMs !== undefined && Number.isFinite(Number(cp.lastObservedAtMs))
        ? Number(cp.lastObservedAtMs)
        : job.checkpoint.lastObservedAtMs,
      workLedger: Array.isArray(cp.workLedger)
        ? [`[GOAL] ${job.checkpoint.immutableGoal}`, ...cp.workLedger.filter((l) => !String(l).startsWith('[GOAL]')).slice(0, 24).map((l) => redactTicketText(l, 220))]
        : job.checkpoint.workLedger,
    };
  }

  function ackInboxEvents(job, ackEventIds = null) {
    if (!Array.isArray(job.eventInbox) || job.eventInbox.length === 0) return;
    if (Array.isArray(ackEventIds)) {
      const ackSet = new Set(ackEventIds.map(String));
      job.eventInbox = job.eventInbox.filter((ev) => !ackSet.has(String(ev.eventId || '')));
      return;
    }
    // Default: acknowledge events that were already present when this slice was claimed
    const claimed = Array.isArray(job.lease?.claimedEventIds) ? new Set(job.lease.claimedEventIds.map(String)) : null;
    if (claimed && claimed.size > 0) {
      job.eventInbox = job.eventInbox.filter((ev) => !claimed.has(String(ev.eventId || '')));
    }
  }

  function applyPendingCancelOrPauseOnSliceEnd(job, nowMs) {
    if (job.cancelRequested) {
      job.lease = null;
      if (!hasUnresolvedEffects(job)) {
        job.status = 'cancelled';
        job.waitingFor = null;
        job.wake.nextReviewAtMs = null;
        job.wake.nextReviewAt = null;
        for (const k of job.steeringPending) {
          const rec = state.steering.get(k);
          if (rec && rec.commandKind === 'cancel' && rec.status === 'received') {
            rec.status = 'applied';
            rec.ackAppliedAtMs = nowMs;
          }
        }
        job.steeringPending = job.steeringPending.filter((k) => state.steering.get(k)?.status === 'received');
        return { applied: 'cancelled' };
      }
      job.status = 'reconciling';
      job.waitingFor = null;
      job.wake.nextReviewAtMs = nowMs + 15_000;
      job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
      return { applied: 'reconciling' };
    }
    if (job.pauseRequested) {
      job.lease = null;
      job.status = 'paused';
      job.waitingFor = null;
      job.pauseRequested = false;
      for (const k of job.steeringPending) {
        const rec = state.steering.get(k);
        if (rec && rec.commandKind === 'pause' && rec.status === 'received') {
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
        }
      }
      job.steeringPending = job.steeringPending.filter((k) => state.steering.get(k)?.status === 'received');
      return { applied: 'paused' };
    }
    return null;
  }

  function matchesWakeCondition(ev, wakeOn) {
    if (!Array.isArray(wakeOn) || wakeOn.length === 0) return true;
    return wakeOn.some((w) => {
      if (!w || typeof w !== 'object') return false;
      const wType = String(w.type || '');
      const eType = String(ev?.type || '');
      const typeOk = wType === eType
        || ((wType === 'companion_online' || wType === 'companion.online') && (eType === 'companion_online' || eType === 'companion.online'));
      if (!typeOk) return false;
      if (w.operationId && String(ev?.operationId || '') !== String(w.operationId)) return false;
      if (w.deviceId && String(ev?.deviceId || '') !== String(w.deviceId)) return false;
      if (w.askId && String(ev?.askId || '') !== String(w.askId)) return false;
      return true;
    });
  }

  function applyUsageDelta(job, { activeMsDelta = 0, usdDelta = 0, nowMs }) {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    if (job.budget.dailyDateKey !== today) {
      job.budget.dailyDateKey = today;
      job.budget.usedSlicesToday = 0;
      job.budget.usedUsdToday = 0;
    }
    const mins = Math.max(0, Number(activeMsDelta || 0)) / 60_000;
    const usd = Math.max(0, Number(usdDelta || 0));
    job.budget.usedActiveMinutes = +(Number(job.budget.usedActiveMinutes || 0) + mins).toFixed(4);
    job.budget.usedUsd = +(Number(job.budget.usedUsd || 0) + usd).toFixed(6);
    job.budget.usedUsdToday = +(Number(job.budget.usedUsdToday || 0) + usd).toFixed(6);
    job.budget.reservedUsd = 0;
  }

  function enqueueOutboxInternal({
    jobId,
    clientMessageId,
    kind,
    channel,
    chatId,
    threadId = null,
    editMessageId = null,
    payload = {},
    nowMs = clock(),
    urgent = false,
    roomQuietHours = quietHours,
  }) {
    const cid = String(clientMessageId || '').trim();
    if (!cid) throw new Error('ERR_CLIENT_MESSAGE_ID_REQUIRED');
    if (state.outbox.has(cid)) {
      return { ok: true, deduplicated: true, record: structuredClone(state.outbox.get(cid)) };
    }
    const deliverAfterMs = nextNotificationWindowMs(nowMs, roomQuietHours, { urgent: urgent || kind === 'final_result' || kind === 'ack_card' });
    // Coalesce ONLY unclaimed (or claim-expired) pending progress_edit messages targeting the same live status card (H11)
    if (String(kind) === 'progress_edit' && editMessageId != null) {
      const targetEdit = String(editMessageId);
      for (const prev of state.outbox.values()) {
        const isActivelyClaimed = Boolean(prev.claimedBy && prev.claimExpiresAtMs && nowMs < Number(prev.claimExpiresAtMs));
        if (
          prev.jobId === String(jobId)
          && prev.kind === 'progress_edit'
          && prev.editMessageId === targetEdit
          && prev.deliveryState === 'pending'
          && !isActivelyClaimed
        ) {
          prev.deliveryState = 'superseded';
          prev.claimedBy = null;
          prev.claimToken = null;
          prev.claimExpiresAtMs = null;
          prev.updatedAt = new Date(nowMs).toISOString();
        }
      }
    }
    const rec = {
      outboxId: `ob_${crypto.randomBytes(6).toString('hex')}`,
      jobId: String(jobId),
      clientMessageId: cid,
      kind: String(kind || 'progress_edit'),
      channel: String(channel || 'web'),
      chatId: String(chatId || ''),
      threadId: threadId != null ? String(threadId) : null,
      editMessageId: editMessageId != null ? String(editMessageId) : null,
      deliveryState: 'pending',
      claimedBy: null,
      claimToken: null,
      claimExpiresAtMs: null,
      externalMessageId: null,
      deliverAfterMs,
      payload: redactTicketPayload(payload),
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    state.outbox.set(cid, rec);
    return { ok: true, deduplicated: false, record: structuredClone(rec) };
  }

  function createJob(spec = {}) {
    return withFileLock(() => {
      const nowMs = spec.nowMs ?? clock();
      const tenantId = String(spec.tenantId || 'default').trim();
      const agentId = String(spec.agentId || 'default').trim();
      const origin = spec.origin && typeof spec.origin === 'object' ? spec.origin : { type: 'explicit_tool' };
      const dedupeKey = String(origin.dedupeKey || `${origin.type || 'explicit'}:${origin.refId || crypto.randomUUID()}`).trim();
      const compositeKey = `${tenantId}|${agentId}|${dedupeKey}`;

      if (state.byOriginKey.has(compositeKey)) {
        const existingId = state.byOriginKey.get(compositeKey);
        const existing = state.jobs.get(existingId);
        if (existing) {
          return { ok: true, deduplicated: true, job: structuredClone(existing) };
        }
      }

      const goal = redactTicketText(String(spec.goal || spec.immutableGoal || '').trim(), 2000);
      if (!goal) return { ok: false, code: 'GOAL_REQUIRED', reason: 'DurableJob requires a non-empty immutableGoal.' };

      const reqRaw = spec.principals?.requester || spec.requester || {};
      const requester = {
        principalId: String(reqRaw.principalId || reqRaw.id || 'owner').trim(),
        externalId: reqRaw.externalId != null ? String(reqRaw.externalId).trim() : null,
        name: reqRaw.name ? redactTicketText(reqRaw.name, 80) : null,
      };
      const ownerIds = [...new Set((spec.principals?.ownerIds || spec.ownerIds || []).map(String).filter(Boolean))];
      const approver = spec.principals?.approver || null;

      const roomRaw = spec.audienceRoom || {};
      const audienceRoom = {
        channel: String(roomRaw.channel || 'web').trim().toLowerCase(),
        bindingId: roomRaw.bindingId ? String(roomRaw.bindingId) : null,
        chatId: String(roomRaw.chatId || 'default').trim(),
        threadId: roomRaw.threadId != null ? String(roomRaw.threadId) : null,
        rootMessageId: roomRaw.rootMessageId != null ? String(roomRaw.rootMessageId) : null,
        isGroup: Boolean(roomRaw.isGroup),
      };

      const authRaw = spec.authority || {};
      const authority = {
        ticketId: authRaw.ticketId ? String(authRaw.ticketId) : null,
        specHash: authRaw.specHash ? String(authRaw.specHash) : (authRaw.actionSpec ? computeTicketSpecHash(authRaw.actionSpec) : null),
        policySnapshot: authRaw.policySnapshot && typeof authRaw.policySnapshot === 'object' ? { ...authRaw.policySnapshot } : {},
        toolScope: Array.isArray(authRaw.toolScope) ? [...new Set(authRaw.toolScope.map(String))] : [],
        expiresAtMs: authRaw.expiresAtMs ? Number(authRaw.expiresAtMs) : null,
      };

      const budget = normalizeJobBudget(spec.budget, { nowMs });
      const jobId = String(spec.jobId || `job_${crypto.randomBytes(8).toString('hex')}`);
      const doneCriteria = Array.isArray(spec.doneCriteria)
        ? spec.doneCriteria.map((c) => redactTicketText(c, 160)).filter(Boolean)
        : [];

      const job = {
        schema: DURABLE_JOB_SCHEMA,
        jobId,
        tenantId,
        workspaceId: String(spec.workspaceId || tenantId),
        agentId,
        revision: 1,
        jobEpoch: 0,
        intentRev: 1,
        origin: {
          type: String(origin.type || 'explicit_tool'),
          refId: origin.refId ? String(origin.refId) : null,
          dedupeKey,
        },
        principals: { requester, ownerIds, approver },
        audienceRoom,
        authority,
        status: 'queued',
        waitingFor: null,
        waitGeneration: 0,
        tempoTier: 'micro',
        lease: null,
        budget,
        wake: {
          nextReviewAtMs: nowMs,
          nextReviewAt: new Date(nowMs).toISOString(),
          wakeOn: [],
          probeName: null,
          probeArgs: null,
          negativeProbes: 0,
          etaMs: spec.etaMs ? Number(spec.etaMs) : null,
          slaDeadlineMs: spec.slaDeadlineMs ? Number(spec.slaDeadlineMs) : null,
        },
        checkpoint: {
          version: 0,
          immutableGoal: goal, // Line 0 -- immutable across the entire lifetime of the job
          doneCriteria,
          milestone: 'queued',
          progressSummary: '',
          nextAction: redactTicketText(String(spec.initialNextAction || goal), 600),
          reacquireAnchors: null,
          artifactRefs: Array.isArray(spec.artifactRefs) ? redactTicketPayload(spec.artifactRefs) : [],
          state: spec.initialState ? redactTicketPayload(spec.initialState) : {},
          lastObservedAtMs: null,
          lastWokeAtMs: null,
          workLedger: [`[GOAL] ${goal}`],
        },
        effectIntents: makeNullProtoDict(), // operationId -> { operationId, tool, argsHash, status, receipt, createdAtMs, updatedAtMs }
        eventInbox: [],       // durable unacknowledged events (acknowledged atomically on park/complete)
        steeringPending: [],  // unapplied steering IDs
        cancelRequested: false,
        pauseRequested: false,
        pausedByRole: null,
        pausedReason: null,
        statusCardMessageId: null,
        lastProgressPushAtMs: null,
        createdAtMs: nowMs,
        createdAt: new Date(nowMs).toISOString(),
        updatedAtMs: nowMs,
        updatedAt: new Date(nowMs).toISOString(),
      };

      state.jobs.set(jobId, job);
      state.byOriginKey.set(compositeKey, jobId);
      return { ok: true, deduplicated: false, job: structuredClone(job) };
    });
  }

  function claimJob({
    jobId,
    workerId = 'worker-1',
    leaseMs = 150_000,
    reserveUsd = 0,
    liveAuth = null,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };
      if (job.status !== 'queued') {
        return { ok: false, code: 'JOB_NOT_CLAIMABLE', status: job.status };
      }

      // Honor pending cancel/pause before granting a new slice (P0-3)
      if (job.cancelRequested) {
        if (!hasUnresolvedEffects(job)) {
          job.status = 'cancelled';
          job.waitingFor = null;
          job.lease = null;
          job.wake.nextReviewAtMs = null;
          job.wake.nextReviewAt = null;
          for (const k of job.steeringPending) {
            const rec = state.steering.get(k);
            if (rec && rec.commandKind === 'cancel' && rec.status === 'received') {
              rec.status = 'applied';
              rec.ackAppliedAtMs = nowMs;
            }
          }
          job.steeringPending = job.steeringPending.filter((k) => state.steering.get(k)?.status === 'received');
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          return { ok: false, code: 'JOB_CANCELLED', job: structuredClone(job) };
        }
        job.status = 'reconciling';
        job.wake.nextReviewAtMs = nowMs + 15_000;
        job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: false, code: 'JOB_RECONCILING_CANCEL', job: structuredClone(job) };
      }
      if (job.pauseRequested) {
        job.status = 'paused';
        job.waitingFor = null;
        job.pauseRequested = false;
        for (const k of job.steeringPending) {
          const rec = state.steering.get(k);
          if (rec && rec.commandKind === 'pause' && rec.status === 'received') {
            rec.status = 'applied';
            rec.ackAppliedAtMs = nowMs;
          }
        }
        job.steeringPending = job.steeringPending.filter((k) => state.steering.get(k)?.status === 'received');
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: false, code: 'JOB_PAUSED', job: structuredClone(job) };
      }

      // Block claiming while an unresolved owner escalation ask is still pending (P0-4)
      if (hasBlockingOwnerAsk(job.jobId)) {
        job.status = 'waiting';
        job.waitingFor = 'owner_approval';
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: false, code: 'OWNER_ASK_PENDING', parked: true, waitingFor: 'owner_approval', job: structuredClone(job) };
      }

      // Unconditional live re-authorization check before granting a slice (sec 63, P1-5, P1-6)
      const authRes = evaluateEffectiveAuthority({ job, liveAuth, nowMs });
      if (!authRes.allowed) {
        job.status = 'waiting';
        job.waitingFor = 'authority';
        job.waitGeneration += 1;
        job.revision += 1;
        job.lease = null;
        job.wake.nextReviewAtMs = null;
        job.wake.nextReviewAt = null;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        if (job.principals.ownerIds.length > 0) {
          enqueueOutboxInternal({
            jobId: job.jobId,
            clientMessageId: `auth_park:${job.jobId}:rev${job.revision}`,
            kind: 'owner_dm',
            channel: 'owner_dm',
            chatId: job.principals.ownerIds[0],
            payload: { code: authRes.code, reason: authRes.reason, jobId: job.jobId },
            nowMs,
            urgent: true,
          });
        }
        return { ok: false, code: authRes.code, parked: true, waitingFor: 'authority', job: structuredClone(job) };
      }

      const bChk = evaluateJobBudget(job.budget, { nowMs, reserveUsd });
      if (!bChk.allowed) {
        if (bChk.retryNextDay) {
          const nextDayMs = Date.UTC(
            new Date(nowMs).getUTCFullYear(),
            new Date(nowMs).getUTCMonth(),
            new Date(nowMs).getUTCDate() + 1,
            0, 5, 0,
          );
          job.status = 'waiting';
          job.waitingFor = 'timer';
          job.wake.nextReviewAtMs = nextDayMs;
          job.wake.nextReviewAt = new Date(nextDayMs).toISOString();
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          return { ok: false, code: bChk.code, deferredToNextDay: true, job: structuredClone(job) };
        }
        if (bChk.statutoryEscalate) {
          job.status = 'paused';
          job.pausedByRole = 'system';
          job.pausedReason = 'statutory';
          job.budget.statutoryEscalatedForExpiryMs = job.budget.expiresAtMs;
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          const escTarget = job.budget.statutoryEscalationTarget || job.principals.ownerIds[0] || job.audienceRoom.chatId;
          enqueueOutboxInternal({
            jobId: job.jobId,
            clientMessageId: `statutory_escalate:${job.jobId}:${job.budget.expiresAtMs}`,
            kind: 'owner_dm',
            channel: 'owner_dm',
            chatId: escTarget,
            payload: { code: 'STATUTORY_HORIZON_ESCALATE', jobId: job.jobId, goal: job.checkpoint.immutableGoal },
            nowMs,
            urgent: true,
          });
          return { ok: false, code: bChk.code, escalated: true, job: structuredClone(job) };
        }
        if (bChk.code === 'HORIZON_EXPIRED' && hasUnresolvedEffects(job)) {
          job.cancelRequested = true;
          job.status = 'reconciling';
          job.wake.nextReviewAtMs = nowMs + 15_000;
          job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          return { ok: false, code: 'HORIZON_EXPIRED_RECONCILING', job: structuredClone(job) };
        }
        job.status = bChk.code === 'HORIZON_EXPIRED' ? 'cancelled' : 'failed';
        job.failureCode = bChk.code;
        job.failureReason = bChk.reason;
        job.wake.nextReviewAtMs = null;
        job.wake.nextReviewAt = null;
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        enqueueOutboxInternal({
          jobId: job.jobId,
          clientMessageId: `budget_term:${job.jobId}:${bChk.code}`,
          kind: 'final_result',
          channel: job.audienceRoom.channel,
          chatId: job.audienceRoom.chatId,
          threadId: job.audienceRoom.threadId,
          payload: { status: job.status, code: bChk.code, reason: bChk.reason },
          nowMs,
          urgent: true,
        });
        return { ok: false, code: bChk.code, reason: bChk.reason, job: structuredClone(job) };
      }

      const today = new Date(nowMs).toISOString().slice(0, 10);
      if (job.budget.dailyDateKey !== today) {
        job.budget.dailyDateKey = today;
        job.budget.usedSlicesToday = 0;
        job.budget.usedUsdToday = 0;
      }

      job.status = 'running';
      job.waitingFor = null;
      job.revision += 1;
      job.jobEpoch += 1;
      job.budget.usedSlices += 1;
      job.budget.usedSlicesToday += 1;
      job.budget.reservedUsd = Math.max(0, Number(reserveUsd || 0));
      // Do NOT reset restartsForCurrentSlice here (P1-2); only reset when slice parks/completes!
      const effLeaseMs = Math.max(15_000, Math.min(300_000, Number(leaseMs || 150_000)));
      const leaseToken = `ls_${crypto.randomBytes(10).toString('hex')}`;
      const inboxEvents = job.eventInbox.map((e) => structuredClone(e));
      const claimedEventIds = inboxEvents.map((e) => e.eventId).filter(Boolean);
      job.lease = {
        ownerId: String(workerId),
        leaseToken,
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + effLeaseMs,
        expiresAt: new Date(nowMs + effLeaseMs).toISOString(),
        claimedEventIds,
      };
      job.checkpoint.lastWokeAtMs = nowMs;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();

      const pendingSteer = job.steeringPending
        .map((k) => state.steering.get(k))
        .filter((s) => s && s.status === 'received')
        .map((s) => structuredClone(s));

      return {
        ok: true,
        job: structuredClone(job),
        leaseToken,
        jobEpoch: job.jobEpoch,
        revision: job.revision,
        effectiveAuthority: authRes,
        inboxEvents,
        claimedEventIds,
        pendingSteer,
      };
    });
  }

  function parkJob({
    jobId,
    revision,
    jobEpoch,
    leaseToken,
    waitingFor = 'timer',
    sleepSec = null,
    wakeAtMs = null,
    wakeOn = [],
    probeName = null,
    probeArgs = null,
    checkpoint = {},
    ackEventIds = null,
    activeMsDelta = 0,
    usdDelta = 0,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      const lv = verifyLease(job, { revision, jobEpoch, leaseToken, nowMs });
      if (!lv.ok) return lv;

      const normWaitFor = WAIT_REASON_SET.has(waitingFor) ? waitingFor : 'timer';
      applyUsageDelta(job, { activeMsDelta, usdDelta, nowMs });
      ackInboxEvents(job, ackEventIds);
      job.budget.restartsForCurrentSlice = 0;
      mergeCheckpoint(job, checkpoint);

      // Apply pending cancel/pause BEFORE scheduling wait or immediateWake (P0-3)
      const deferredCtrl = applyPendingCancelOrPauseOnSliceEnd(job, nowMs);
      if (deferredCtrl) {
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return {
          ok: true,
          immediateWake: false,
          controlApplied: deferredCtrl.applied,
          job: structuredClone(job),
        };
      }

      const tempoTier = computeTempoTier({
        createdAtMs: job.createdAtMs,
        nowMs,
        requestedSleepSec: sleepSec || (wakeAtMs ? Math.max(0, (wakeAtMs - nowMs) / 1000) : 0),
        hasYielded: true,
      });

      const explicitSleep = sleepSec != null && Number.isFinite(Number(sleepSec)) && Number(sleepSec) > 0;
      const explicitWakeAt = wakeAtMs != null && Number.isFinite(Number(wakeAtMs));
      let nextReviewAtMs;
      if (normWaitFor === 'companion' && !explicitSleep && !explicitWakeAt && !probeName) {
        // Companion sleep waits for companion_online event; avoid burning slices on short timers (C7)
        nextReviewAtMs = nowMs + 60 * 60 * 1000;
      } else {
        const effDelaySec = explicitWakeAt
          ? Math.max(10, Math.round((Number(wakeAtMs) - nowMs) / 1000))
          : computeNextProbeDelaySec({
              tempoTier,
              negativeProbes: 0,
              pollAfterSec: sleepSec,
              etaMs: job.wake.etaMs,
              nowMs,
              slaDeadlineMs: job.wake.slaDeadlineMs,
            });
        nextReviewAtMs = explicitWakeAt
          ? Math.max(nowMs + 10_000, Number(wakeAtMs))
          : nowMs + effDelaySec * 1000;
      }

      job.tempoTier = tempoTier;
      job.waitGeneration += 1;
      job.wake = {
        ...job.wake,
        nextReviewAtMs,
        nextReviewAt: new Date(nextReviewAtMs).toISOString(),
        wakeOn: Array.isArray(wakeOn) ? redactTicketPayload(wakeOn) : [],
        probeName: probeName ? String(probeName).trim() : null,
        probeArgs: probeArgs && typeof probeArgs === 'object' ? redactTicketPayload(probeArgs) : null,
        requestedSleepSec: explicitSleep ? Number(sleepSec) : (explicitWakeAt ? Math.max(0, (Number(wakeAtMs) - nowMs) / 1000) : null),
        hasExplicitTimer: Boolean(explicitSleep || explicitWakeAt),
        negativeProbes: 0,
      };
      job.lease = null;
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();

      // If an unacknowledged event arrived BEFORE parkJob committed (callback-before-park race),
      // immediately transition to `queued` so the early callback is NEVER lost!
      const matchedEarly = job.eventInbox.length > 0 && job.eventInbox.some((ev) => matchesWakeCondition(ev, job.wake.wakeOn));
      const hasUnappliedSteer = job.steeringPending.some((k) => state.steering.get(k)?.status === 'received');
      if ((matchedEarly || hasUnappliedSteer) && normWaitFor !== 'owner_approval' && normWaitFor !== 'authority') {
        job.status = 'queued';
        job.waitingFor = null;
        return { ok: true, immediateWake: true, job: structuredClone(job) };
      }

      job.status = 'waiting';
      job.waitingFor = normWaitFor;
      return { ok: true, immediateWake: false, job: structuredClone(job) };
    });
  }

  function enqueueWake({
    jobId,
    reason = 'event',
    event = null,
    expectedWaitGeneration = null,
    allowOwnerResume = false,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };
      if (DURABLE_TERMINAL_STATUSES.has(job.status)) {
        return { ok: false, code: 'JOB_TERMINAL', status: job.status };
      }
      if (expectedWaitGeneration != null && Number(expectedWaitGeneration) !== Number(job.waitGeneration)) {
        return { ok: false, code: 'STALE_WAIT_GENERATION', expected: job.waitGeneration, received: expectedWaitGeneration };
      }

      if (event) {
        const alreadyInInbox = event.eventId && job.eventInbox.some((e) => e.eventId === event.eventId);
        if (!alreadyInInbox) {
          job.eventInbox.push({
            eventId: event.eventId || `ev_${crypto.randomBytes(6).toString('hex')}`,
            ...redactTicketPayload(event),
            receivedAtMs: nowMs,
          });
        }
      }

      // If job is currently running, buffer event safely in `eventInbox` without bumping CAS revision
      if (job.status === 'running') {
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, buffered: true, woke: false, status: 'running', job: structuredClone(job) };
      }

      // Do NOT bypass owner_approval or authority wait gates with unrelated events (P0-4)
      if (job.status === 'waiting' && (job.waitingFor === 'owner_approval' || job.waitingFor === 'authority')) {
        const allowUnlock = reason === 'owner_answer'
          || (job.waitingFor === 'authority' && (reason === 'authority_restored' || reason === 'owner_returned' || reason === 'resume'));
        if (!allowUnlock) {
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          return { ok: true, buffered: true, woke: false, status: 'waiting', waitingFor: job.waitingFor, job: structuredClone(job) };
        }
      }

      // Do NOT requeue a reconciling job on ordinary events while unresolved effects are still flying (B2)
      if (job.status === 'reconciling' && hasUnresolvedEffects(job)) {
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, buffered: true, woke: false, status: 'reconciling', job: structuredClone(job) };
      }

      // Do NOT bypass owner/statutory pause locks via enqueueWake unless explicitly authorized (N1)
      if (job.status === 'paused' && (job.pausedByRole === 'owner' || job.pausedReason === 'statutory') && allowOwnerResume !== true) {
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, buffered: Boolean(event), woke: false, status: 'paused', pausedReason: job.pausedReason, job: structuredClone(job) };
      }

      if (job.status === 'waiting' || job.status === 'reconciling' || (job.status === 'paused' && reason === 'resume')) {
        job.status = 'queued';
        job.waitingFor = null;
        if (job.pausedByRole || job.pausedReason) {
          job.pausedByRole = null;
          job.pausedReason = null;
        }
        job.revision += 1;
        job.wake.nextReviewAtMs = nowMs;
        job.wake.nextReviewAt = new Date(nowMs).toISOString();
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, buffered: false, woke: true, job: structuredClone(job) };
      }

      // Already queued (e.g. via answerAsk/submitSteering): signal alreadyQueued so WakeBus still dispatches
      return { ok: true, buffered: false, woke: false, alreadyQueued: job.status === 'queued', status: job.status, job: structuredClone(job) };
    });
  }

  function recordEffectIntent({
    jobId,
    revision,
    jobEpoch,
    leaseToken,
    operationId,
    tool,
    args = {},
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      const lv = verifyLease(job, { revision, jobEpoch, leaseToken, nowMs });
      if (!lv.ok) return lv;
      if (job.cancelRequested) {
        return { ok: false, code: 'CANCEL_REQUESTED_BEFORE_DISPATCH', reason: 'Cancellation won the race before dispatch.' };
      }
      // Steering barrier: worker must drain pending steering before dispatching a new side effect
      const unappliedSteer = job.steeringPending.filter((k) => state.steering.get(k)?.status === 'received');
      if (unappliedSteer.length > 0) {
        return { ok: false, code: 'STEERING_BARRIER_PENDING', pendingCount: unappliedSteer.length };
      }

      const opId = String(operationId || '').trim();
      if (!isSafeOpId(opId)) return { ok: false, code: 'INVALID_OPERATION_ID' };
      const argsHash = computeJobArgsHash({ tool: String(tool || ''), args });
      const existing = Object.hasOwn(job.effectIntents, opId) ? job.effectIntents[opId] : null;
      if (existing) {
        if (existing.argsHash !== argsHash) {
          return { ok: false, code: 'ERR_EFFECT_CONFLICT', operationId: opId };
        }
        return { ok: true, idempotent: true, intent: structuredClone(existing) };
      }
      const intent = {
        operationId: opId,
        tool: String(tool || ''),
        argsHash,
        status: 'dispatched',
        receipt: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      job.effectIntents[opId] = intent;
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();
      return { ok: true, idempotent: false, intent: structuredClone(intent), revision: job.revision };
    });
  }

  function recordEffectReceipt({
    jobId,
    operationId,
    status = 'succeeded',
    receipt = null,
    remoteJobId = null,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };
      const opId = String(operationId || '').trim();
      if (!isSafeOpId(opId) || !Object.hasOwn(job.effectIntents, opId)) {
        return { ok: false, code: 'EFFECT_INTENT_NOT_FOUND' };
      }
      const intent = job.effectIntents[opId];

      const normStatus = ['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(status)
        ? status
        : 'unknown';

      // Monotonic terminal receipts: once settled (succeeded/failed/cancelled), NEVER downgrade (B2, P1-1)
      if (TERMINAL_EFFECT_STATUSES.has(intent.status)) {
        return { ok: true, ignoredStale: true, intent: structuredClone(intent), job: structuredClone(job) };
      }

      intent.status = normStatus;
      if (remoteJobId) intent.remoteJobId = String(remoteJobId);
      if (receipt !== null && receipt !== undefined) intent.receipt = redactTicketPayload(receipt);
      intent.updatedAtMs = nowMs;

      // Never mutate terminal job status when recording a late effect receipt (FABLE P2)
      if (!DURABLE_TERMINAL_STATUSES.has(job.status)) {
        if (normStatus === 'unknown' && (job.status === 'running' || job.status === 'waiting')) {
          job.status = 'reconciling';
          job.waitingFor = null;
          job.lease = null;
          job.wake.nextReviewAtMs = nowMs + 30_000;
          job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
        } else if (TERMINAL_EFFECT_STATUSES.has(normStatus)) {
          const stillFlying = hasUnresolvedEffects(job);
          if (!stillFlying) {
            if (job.cancelRequested) {
              job.status = 'cancelled';
              job.waitingFor = null;
              job.lease = null;
              job.wake.nextReviewAtMs = null;
              job.wake.nextReviewAt = null;
              for (const k of job.steeringPending) {
                const rec = state.steering.get(k);
                if (rec && rec.commandKind === 'cancel' && rec.status === 'received') {
                  rec.status = 'applied';
                  rec.ackAppliedAtMs = nowMs;
                }
              }
              job.steeringPending = job.steeringPending.filter((k) => state.steering.get(k)?.status === 'received');
            } else if (job.status === 'reconciling') {
              job.status = 'queued';
              job.waitingFor = null;
              job.wake.nextReviewAtMs = nowMs;
              job.wake.nextReviewAt = new Date(nowMs).toISOString();
            }
          }
        }
      }
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();
      return { ok: true, intent: structuredClone(intent), job: structuredClone(job) };
    });
  }

  function openAsk({
    jobId,
    revision = null,
    jobEpoch = null,
    leaseToken = null,
    targetRole = 'requester',
    kind = 'choice',
    question,
    options = [],
    dedupeKey = null,
    defaultOption = null,
    defaultAfterSec = null,
    nudgeDelaySec = 2 * 3600,
    checkpoint = null,
    ackEventIds = null,
    activeMsDelta = 0,
    usdDelta = 0,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };
      if (DURABLE_TERMINAL_STATUSES.has(job.status)) {
        return { ok: false, code: 'JOB_TERMINAL', status: job.status };
      }
      if (!leaseToken) {
        return { ok: false, code: 'LEASE_REQUIRED', reason: 'openAsk requires an active slice leaseToken.' };
      }
      const lv = verifyLease(job, { revision, jobEpoch, leaseToken, nowMs });
      if (!lv.ok) return lv;

      const normKind = String(kind || '').trim().toLowerCase();
      if (normKind === 'secret') {
        return { ok: false, code: 'SECRET_ASK_DISABLED_UNTIL_VAULT_PROVIDER', reason: 'ask(kind=secret) is disabled; use SecretProvider handles instead.' };
      }
      if (!ASK_KIND_SET.has(normKind)) {
        return { ok: false, code: 'INVALID_ASK_KIND', reason: `Allowed ask kinds: ${ASK_KINDS.join(', ')}` };
      }

      const normTarget = targetRole === 'owner' ? 'owner' : 'requester';
      const normOptions = Array.isArray(options) ? redactTicketPayload(options.slice(0, 12)) : [];
      if (defaultOption != null && String(defaultOption).trim() !== '') {
        if (normTarget === 'owner') {
          return { ok: false, code: 'ERR_OWNER_ASK_NO_DEFAULT', reason: 'Owner escalations cannot use Default-Unless-Vetoed auto-defaults.' };
        }
        if (normKind !== 'choice') {
          return { ok: false, code: 'INVALID_DEFAULT_OPTION', reason: 'defaultOption is only valid for choice asks.' };
        }
        if (normOptions.length === 0) {
          return { ok: false, code: 'INVALID_DEFAULT_OPTION', reason: 'defaultOption requires non-empty declared options.' };
        }
        const defVal = String(defaultOption).trim();
        const validChoice = normOptions.some((o) =>
          (typeof o === 'string' && o.trim() === defVal)
          || (o && typeof o === 'object' && (String(o.id || '').trim() === defVal || String(o.label || '').trim() === defVal)),
        );
        if (!validChoice) {
          return { ok: false, code: 'INVALID_DEFAULT_OPTION', reason: 'defaultOption must match one of the declared options.' };
        }
      }

      const existingOpen = [...state.asks.values()].find((a) => a.jobId === job.jobId && a.status === 'open');
      if (existingOpen) {
        return { ok: false, code: 'ASK_ALREADY_OPEN', existingAskId: existingOpen.askId };
      }

      // Apply pending cancel/pause before opening a new ask (C10)
      applyUsageDelta(job, { activeMsDelta, usdDelta, nowMs });
      ackInboxEvents(job, ackEventIds);
      job.budget.restartsForCurrentSlice = 0;
      mergeCheckpoint(job, checkpoint);
      const deferredCtrl = applyPendingCancelOrPauseOnSliceEnd(job, nowMs);
      if (deferredCtrl) {
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: false, code: deferredCtrl.applied === 'paused' ? 'JOB_PAUSED' : 'JOB_CANCELLED', controlApplied: deferredCtrl.applied, job: structuredClone(job) };
      }

      // Dedupe within 24h & rate limit <= 6/hr per job
      const dKey = dedupeKey ? String(dedupeKey).trim() : null;
      if (dKey) {
        const dup = [...state.asks.values()].find((a) =>
          a.jobId === job.jobId && a.dedupeKey === dKey && (nowMs - a.createdAtMs) <= DEFAULT_ASK_DEDUPE_WINDOW_MS);
        if (dup) return { ok: false, code: 'ASK_DEDUPLICATED', existingAskId: dup.askId };
      }
      const recentCount = [...state.asks.values()].filter((a) => a.jobId === job.jobId && (nowMs - a.createdAtMs) <= 3600_000).length;
      if (recentCount >= DEFAULT_MAX_ASKS_PER_HOUR) {
        return { ok: false, code: 'ASK_RATE_LIMITED', limitPerHour: DEFAULT_MAX_ASKS_PER_HOUR };
      }

      const recipientPrincipalId = normTarget === 'owner'
        ? (job.principals.ownerIds[0] || 'owner')
        : job.principals.requester.principalId;
      const recipientExternalId = normTarget === 'owner'
        ? null
        : job.principals.requester.externalId;
      const privacy = normTarget === 'owner' ? 'owner_dm_only' : 'room_thread';

      const askId = `ask_${crypto.randomBytes(6).toString('hex')}`;
      const defSec = defaultOption && Number.isFinite(Number(defaultAfterSec)) && Number(defaultAfterSec) >= 60
        ? Math.round(Number(defaultAfterSec))
        : null;
      const effNudgeSec = Math.max(60, Number(nudgeDelaySec || 7200));

      // Transactional outbox FIRST so quietHours deferral informs nextNudgeAtMs (no 07:30 double-ping, C10)
      let initialDeliverAfterMs = nowMs;
      const cleanQuestion = redactTicketText(question || '', 1200);
      const cleanDefaultOpt = defaultOption ? redactTicketText(defaultOption, 200) : null;
      if (normTarget === 'owner') {
        const ob = enqueueOutboxInternal({
          jobId: job.jobId,
          clientMessageId: `ask_owner_dm:${askId}`,
          kind: 'owner_dm',
          channel: 'owner_dm',
          chatId: recipientPrincipalId,
          payload: { askId, kind: normKind, question: cleanQuestion, options: normOptions },
          nowMs,
          urgent: true,
        });
        initialDeliverAfterMs = ob.record?.deliverAfterMs || nowMs;
        if (job.audienceRoom.isGroup) {
          enqueueOutboxInternal({
            jobId: job.jobId,
            clientMessageId: `ask_group_neutral:${askId}`,
            kind: 'progress_edit',
            channel: job.audienceRoom.channel,
            chatId: job.audienceRoom.chatId,
            threadId: job.audienceRoom.threadId,
            editMessageId: job.statusCardMessageId,
            payload: {
              neutral: true,
              text: 'This task is awaiting administrator authorization for the next step and will resume automatically.',
            },
            nowMs,
          });
        }
      } else {
        const ob = enqueueOutboxInternal({
          jobId: job.jobId,
          clientMessageId: `ask_requester:${askId}`,
          kind: 'ask',
          channel: job.audienceRoom.channel,
          chatId: job.audienceRoom.chatId,
          threadId: job.audienceRoom.threadId,
          payload: {
            askId,
            kind: normKind,
            mentionPrincipalId: recipientPrincipalId,
            question: cleanQuestion,
            options: normOptions,
            defaultOption: cleanDefaultOpt,
          },
          nowMs,
        });
        initialDeliverAfterMs = ob.record?.deliverAfterMs || nowMs;
      }

      const nudgeAnchorMs = Math.max(nowMs, initialDeliverAfterMs);
      const ask = {
        askId,
        jobId: job.jobId,
        targetRole: normTarget,
        recipientPrincipalId,
        recipientExternalId,
        kind: normKind,
        intentRev: job.intentRev,
        dedupeKey: dKey,
        status: 'open',
        privacy,
        question: cleanQuestion,
        options: normOptions,
        defaultOption: cleanDefaultOpt,
        defaultActionAtMs: defSec ? nudgeAnchorMs + defSec * 1000 : null,
        nudgeCount: 0,
        maxNudges: DEFAULT_MAX_NUDGES,
        nudgeDelaySec: effNudgeSec,
        nextNudgeAtMs: nudgeAnchorMs + effNudgeSec * 1000,
        answer: null,
        answeredBy: null,
        answeredAtMs: null,
        createdAtMs: nowMs,
        createdAt: new Date(nowMs).toISOString(),
      };
      state.asks.set(askId, ask);

      // Atomic park (D5: inlineWaitSec = 0 -> immediate park, release lease!)
      job.status = 'waiting';
      job.waitingFor = normTarget === 'owner' ? 'owner_approval' : 'requester';
      job.waitGeneration += 1;
      job.lease = null;
      const nextDue = ask.defaultActionAtMs
        ? Math.min(ask.defaultActionAtMs, ask.nextNudgeAtMs)
        : ask.nextNudgeAtMs;
      job.wake.nextReviewAtMs = nextDue;
      job.wake.nextReviewAt = new Date(nextDue).toISOString();
      job.wake.wakeOn = [{ type: normTarget === 'owner' ? 'owner_answer' : 'requester_answer', askId }];
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();

      return {
        ok: true,
        inlineWaitSec: DEFAULT_INLINE_ASK_WAIT_SEC,
        parked: true,
        ask: structuredClone(ask),
        job: structuredClone(job),
      };
    });
  }

  function answerAsk({
    askId,
    actorId,
    actorRole = 'requester',
    answer,
    privateOwnerNote = null,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      if (String(actorRole || '').trim().toLowerCase() === 'agent') {
        return { ok: false, code: 'AGENT_CANNOT_ANSWER', reason: 'Agents are forbidden from answering their own asks.' };
      }
      const ask = state.asks.get(String(askId || ''));
      if (!ask) return { ok: false, code: 'ASK_NOT_FOUND' };
      // Accept late answers for asks paused by 2-Nudge-1-Park (P0-8 / C3 / P1-7)
      if (ask.status !== 'open' && ask.status !== 'paused') {
        return { ok: false, code: 'ASK_NOT_OPEN', status: ask.status };
      }
      const job = state.jobs.get(ask.jobId);
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };

      const cleanActor = actorId != null ? String(actorId).trim() : '';
      const ownerSet = new Set((job.principals?.ownerIds || []).map(String));
      const isOwner = actorRole === 'owner' || (cleanActor && ownerSet.has(cleanActor));
      const isApprover = !isOwner && (actorRole === 'approver' || matchesApproverPrincipal(job, cleanActor));

      if (ask.targetRole === 'owner' && !isOwner && !isApprover) {
        return { ok: false, code: 'OWNER_ONLY_ASK', reason: 'Only workspace owners or designated approvers may answer owner escalations.' };
      }
      if (ask.targetRole === 'requester' && !isOwner && !isApprover) {
        const matchesReq = cleanActor && (
          cleanActor === String(ask.recipientPrincipalId || '')
          || (ask.recipientExternalId && cleanActor === String(ask.recipientExternalId))
        );
        if (!matchesReq) {
          return { ok: false, code: 'ASK_RECIPIENT_MISMATCH', reason: 'Only the task requester or owner may answer this ask.' };
        }
      }

      // CAS close ask
      ask.status = 'answered';
      ask.answer = redactTicketPayload(answer);
      ask.answeredBy = cleanActor || actorRole;
      ask.answeredAtMs = nowMs;
      if (privateOwnerNote && (isOwner || isApprover)) {
        ask.privateOwnerNote = redactTicketText(privateOwnerNote, 600);
      }

      let wokeToQueued = false;
      if (!DURABLE_TERMINAL_STATUSES.has(job.status)) {
        job.eventInbox.push({
          eventId: `ev_${crypto.randomBytes(6).toString('hex')}`,
          type: ask.targetRole === 'owner' ? 'owner_answer' : 'requester_answer',
          askId: ask.askId,
          answer: ask.answer,
          receivedAtMs: nowMs,
        });
        // Only unpause on answer if job is waiting, paused due to silent_ask, or answered by Owner (N1 / R3)!
        // An owner pause or statutory lock stays paused while safely preserving the answer in eventInbox.
        const canUnpause = job.status === 'waiting'
          || (job.status === 'paused' && (job.pausedReason === 'silent_ask' || isOwner));
        if (canUnpause) {
          job.status = 'queued';
          job.waitingFor = null;
          job.pauseRequested = false;
          job.pausedByRole = null;
          job.pausedReason = null;
          job.wake.nextReviewAtMs = nowMs;
          job.wake.nextReviewAt = new Date(nowMs).toISOString();
          wokeToQueued = true;
        }
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
      }

      return { ok: true, wokeToQueued, ask: structuredClone(ask), job: structuredClone(job) };
    });
  }

  function submitSteering({
    jobId,
    sourceEventId,
    actorId,
    actorRole = null,
    actorChannel = null,
    baseIntentRev = null,
    commandKind = 'clarify',
    payload = {},
    requestedCapabilities = [],
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };

      // Normalize commandKind once at top (P0-3: 'CANCEL' -> 'cancel')
      const cmd = String(commandKind || '').trim().toLowerCase();
      // Check permission BEFORE returning any dedupe hit (P2)
      const perm = evaluateSteeringPermission({ job, actorId, actorRole, actorChannel, commandKind: cmd, requestedCapabilities });

      const evtId = String(sourceEventId || `st_${crypto.randomBytes(6).toString('hex')}`).trim();
      const dedupeKey = `${job.jobId}:${evtId}`;
      if (state.steering.has(dedupeKey)) {
        if (!perm.allowed) {
          return { ok: false, code: perm.code, reason: perm.reason };
        }
        return { ok: true, deduplicated: true, steering: structuredClone(state.steering.get(dedupeKey)), job: structuredClone(job) };
      }

      if (!perm.allowed) {
        const rejectedRec = {
          steerId: `str_${crypto.randomBytes(6).toString('hex')}`,
          jobId: job.jobId,
          sourceEventId: evtId,
          actorPrincipalId: String(actorId || ''),
          actorRole: perm.effectiveRole || 'stranger',
          baseIntentRev: baseIntentRev ?? job.intentRev,
          commandKind: cmd,
          status: perm.requiresNewApproval ? 'needs_reapproval' : 'rejected',
          code: perm.code,
          payload: redactTicketPayload(payload),
          createdAtMs: nowMs,
        };
        state.steering.set(dedupeKey, rejectedRec);
        return {
          ok: false,
          code: perm.code,
          requiresNewApproval: Boolean(perm.requiresNewApproval),
          unauthorizedCapabilities: perm.unauthorizedCapabilities || [],
          reason: perm.reason,
          steering: structuredClone(rejectedRec),
        };
      }

      if (DURABLE_TERMINAL_STATUSES.has(job.status)) {
        return { ok: false, code: 'JOB_ALREADY_TERMINAL', status: job.status, job: structuredClone(job) };
      }

      if (cmd === 'amend' && baseIntentRev != null && Number(baseIntentRev) !== Number(job.intentRev)) {
        return {
          ok: false,
          code: 'INTENT_REV_CONFLICT',
          expectedIntentRev: job.intentRev,
          receivedIntentRev: baseIntentRev,
        };
      }

      const rec = {
        steerId: `str_${crypto.randomBytes(6).toString('hex')}`,
        jobId: job.jobId,
        sourceEventId: evtId,
        actorPrincipalId: String(actorId || ''),
        actorRole: perm.effectiveRole,
        baseIntentRev: baseIntentRev ?? job.intentRev,
        commandKind: cmd,
        status: 'received',
        ackReceivedAtMs: nowMs,
        ackAppliedAtMs: null,
        payload: redactTicketPayload(payload),
        createdAtMs: nowMs,
      };
      state.steering.set(dedupeKey, rec);

      if (cmd === 'cancel') {
        const hasFlying = hasUnresolvedEffects(job);
        job.cancelRequested = true;
        for (const a of state.asks.values()) {
          if (a.jobId === job.jobId && (a.status === 'open' || a.status === 'paused')) a.status = 'cancelled';
        }
        if (!hasFlying && job.status !== 'running') {
          job.status = 'cancelled';
          job.waitingFor = null;
          job.lease = null;
          job.wake.nextReviewAtMs = null;
          job.wake.nextReviewAt = null;
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
        } else {
          if (job.status !== 'running') {
            job.status = 'reconciling';
            job.waitingFor = null;
            job.wake.nextReviewAtMs = nowMs + 15_000;
            job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
          }
          job.steeringPending.push(dedupeKey);
        }
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return {
          ok: true,
          cancelState: job.status === 'cancelled' ? 'cancelled' : 'cancel_requested',
          steering: structuredClone(rec),
          job: structuredClone(job),
        };
      }

      if (cmd === 'pause') {
        const alreadyLocked = job.pausedByRole === 'owner' || job.pausedReason === 'statutory';
        if (alreadyLocked && perm.effectiveRole !== 'owner') {
          rec.status = 'rejected';
          rec.errorCode = 'OWNER_PAUSE_LOCKED';
          return {
            ok: false,
            code: 'OWNER_PAUSE_LOCKED',
            reason: 'Only the workspace owner may modify a job locked by an owner or statutory pause.',
            steering: structuredClone(rec),
            job: structuredClone(job),
          };
        }
        // Monotonic lock precedence: statutory > owner > approver/requester (never downgrade statutory or owner!)
        if (perm.effectiveRole === 'owner') {
          job.pausedByRole = 'owner';
          if (job.pausedReason !== 'statutory') job.pausedReason = 'steering';
        } else if (!alreadyLocked) {
          job.pausedByRole = perm.effectiveRole;
          job.pausedReason = 'steering';
        }
        if (job.status === 'waiting' || job.status === 'queued' || job.status === 'paused') {
          job.status = 'paused';
          job.waitingFor = null;
          job.pauseRequested = false;
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
        } else {
          job.pauseRequested = true;
          job.steeringPending.push(dedupeKey);
        }
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, steering: structuredClone(rec), job: structuredClone(job) };
      }

      if (cmd === 'resume') {
        job.pauseRequested = false;
        let wokeToQueued = false;
        if (job.status === 'paused') {
          job.pausedByRole = null;
          job.pausedReason = null;
          // If an unresolved paused owner ask exists, re-open wait on owner_approval instead of bypassing it
          if (hasBlockingOwnerAsk(job.jobId)) {
            job.status = 'waiting';
            job.waitingFor = 'owner_approval';
          } else {
            job.status = 'queued';
            job.wake.nextReviewAtMs = nowMs;
            job.wake.nextReviewAt = new Date(nowMs).toISOString();
            wokeToQueued = true;
          }
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
        } else if (perm.effectiveRole === 'owner' || (job.pausedByRole !== 'owner' && job.pausedReason !== 'statutory')) {
          // Owner (or authorized actor) cancelling a pending pauseRequested on a running job clears stale lock metadata (FABLE P2)
          job.pausedByRole = null;
          job.pausedReason = null;
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
        }
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, wokeToQueued, steering: structuredClone(rec), job: structuredClone(job) };
      }

      // `clarify` or `amend`
      if (cmd === 'amend') {
        job.intentRev += 1;
        for (const a of state.asks.values()) {
          if (a.jobId === job.jobId && a.status === 'open' && a.targetRole !== 'owner' && a.intentRev < job.intentRev) {
            a.status = 'superseded';
          }
        }
      }
      job.steeringPending.push(dedupeKey);
      let wokeToQueued = false;
      // NEVER let clarify/amend bypass owner_approval or authority wait gates (P0-4)
      if (job.status === 'waiting' && job.waitingFor !== 'owner_approval' && job.waitingFor !== 'authority') {
        job.status = 'queued';
        job.waitingFor = null;
        job.wake.nextReviewAtMs = nowMs;
        job.wake.nextReviewAt = new Date(nowMs).toISOString();
        wokeToQueued = true;
      }
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();
      return { ok: true, wokeToQueued, steering: structuredClone(rec), job: structuredClone(job) };
    });
  }

  function ackSteeringApplied({ jobId, steerIds = [], nowMs = clock() } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };
      const idSet = new Set(steerIds.map(String));
      const applied = [];
      for (const key of job.steeringPending) {
        const rec = state.steering.get(key);
        if (rec && rec.status === 'received' && (idSet.size === 0 || idSet.has(rec.steerId))) {
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
          applied.push(rec.steerId);
        }
      }
      job.steeringPending = job.steeringPending.filter((k) => state.steering.get(k)?.status === 'received');
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();
      return { ok: true, applied };
    });
  }

  function completeJob({
    jobId,
    revision,
    jobEpoch,
    leaseToken,
    summary,
    deliverables = [],
    verifiedCriteria = [],
    activeMsDelta = 0,
    usdDelta = 0,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      const lv = verifyLease(job, { revision, jobEpoch, leaseToken, nowMs });
      if (!lv.ok) return lv;

      // Reject closing a newer intent revision with stale slice output
      const unappliedSteer = job.steeringPending.filter((k) => state.steering.get(k)?.status === 'received');
      if (unappliedSteer.length > 0) {
        return {
          ok: false,
          code: 'PENDING_STEERING_DRAIN_REQUIRED',
          reason: 'Cannot complete job before draining and applying pending requester steering.',
        };
      }

      // Never terminalize a job while remote side-effect intents remain unresolved (B2)
      if (hasUnresolvedEffects(job)) {
        return {
          ok: false,
          code: 'UNRESOLVED_EFFECTS_PENDING',
          reason: 'Cannot complete job while remote effect intents are still unresolved.',
        };
      }

      // Check immutable doneCriteria if declared at job creation
      const requiredCriteria = Array.isArray(job.checkpoint.doneCriteria) ? job.checkpoint.doneCriteria : [];
      if (requiredCriteria.length > 0) {
        const verifiedSet = new Set((Array.isArray(verifiedCriteria) ? verifiedCriteria : []).map(String));
        const missing = requiredCriteria.filter((c) => !verifiedSet.has(c));
        if (missing.length > 0) {
          return {
            ok: false,
            code: 'DONE_CRITERIA_UNMET',
            missingCriteria: missing,
            reason: `Cannot complete job; unmet doneCriteria: ${missing.join(', ')}`,
          };
        }
      }

      applyUsageDelta(job, { activeMsDelta, usdDelta, nowMs });
      ackInboxEvents(job);
      job.budget.restartsForCurrentSlice = 0;
      job.status = 'completed';
      job.waitingFor = null;
      job.lease = null;
      job.wake.probeName = null;
      job.wake.wakeOn = [];
      job.wake.nextReviewAtMs = null;
      job.wake.nextReviewAt = null;
      job.finalReport = {
        summary: redactTicketText(summary || '', 3000),
        deliverables: Array.isArray(deliverables) ? redactTicketPayload(deliverables) : [],
        verifiedCriteria: Array.isArray(verifiedCriteria) ? verifiedCriteria.map(String) : [],
        completedAt: new Date(nowMs).toISOString(),
      };
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();

      enqueueOutboxInternal({
        jobId: job.jobId,
        clientMessageId: `final:${job.jobId}:rev${job.intentRev}`,
        kind: 'final_result',
        channel: job.audienceRoom.channel,
        chatId: job.audienceRoom.chatId,
        threadId: job.audienceRoom.threadId,
        payload: {
          summary: job.finalReport.summary,
          deliverables: job.finalReport.deliverables,
          mentionPrincipalId: job.principals.requester.principalId,
        },
        nowMs,
        urgent: true,
      });

      return { ok: true, job: structuredClone(job) };
    });
  }

  function failJob({
    jobId,
    revision,
    jobEpoch,
    leaseToken,
    code = 'FAILED',
    reason = 'Job failed',
    activeMsDelta = 0,
    usdDelta = 0,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      const lv = verifyLease(job, { revision, jobEpoch, leaseToken, nowMs });
      if (!lv.ok) return lv;
      // Never terminalize a job while remote side-effect intents remain unresolved (B2)
      if (hasUnresolvedEffects(job)) {
        return {
          ok: false,
          code: 'UNRESOLVED_EFFECTS_PENDING',
          reason: 'Cannot fail job while remote effect intents are still unresolved.',
        };
      }
      applyUsageDelta(job, { activeMsDelta, usdDelta, nowMs });
      ackInboxEvents(job);
      job.status = 'failed';
      job.waitingFor = null;
      job.lease = null;
      job.wake.nextReviewAtMs = null;
      job.wake.nextReviewAt = null;
      job.failureCode = String(code || 'FAILED');
      job.failureReason = redactTicketText(reason || 'Job failed', 1000);
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();
      enqueueOutboxInternal({
        jobId: job.jobId,
        clientMessageId: `fail:${job.jobId}:rev${job.revision}`,
        kind: 'final_result',
        channel: job.audienceRoom.channel,
        chatId: job.audienceRoom.chatId,
        threadId: job.audienceRoom.threadId,
        payload: { status: 'failed', code: job.failureCode, reason: job.failureReason },
        nowMs,
        urgent: true,
      });
      return { ok: true, job: structuredClone(job) };
    });
  }

  function recordNegativeProbe({
    jobId,
    nextReviewAtMs,
    tempoTier = null,
    statusNote = '',
    expectedWaitGeneration = null,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job || job.status !== 'waiting') return { ok: false, code: 'JOB_NOT_WAITING' };
      if (expectedWaitGeneration != null && Number(expectedWaitGeneration) !== Number(job.waitGeneration)) {
        return { ok: false, code: 'STALE_WAIT_GENERATION', expected: job.waitGeneration, received: expectedWaitGeneration };
      }
      job.wake.negativeProbes = Number(job.wake.negativeProbes || 0) + 1;
      job.wake.nextReviewAtMs = Number(nextReviewAtMs);
      job.wake.nextReviewAt = new Date(nextReviewAtMs).toISOString();
      if (tempoTier) job.tempoTier = tempoTier;
      job.checkpoint.lastProbeNote = redactTicketText(statusNote || '', 240);
      job.checkpoint.lastProbeAtMs = nowMs;
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();
      // Edit-in-Place ONLY (never emits new chat push messages on negative probes!)
      if (job.statusCardMessageId) {
        enqueueOutboxInternal({
          jobId: job.jobId,
          clientMessageId: `probe_edit:${job.jobId}:g${job.waitGeneration}:n${job.wake.negativeProbes}`,
          kind: 'progress_edit',
          channel: job.audienceRoom.channel,
          chatId: job.audienceRoom.chatId,
          threadId: job.audienceRoom.threadId,
          editMessageId: job.statusCardMessageId,
          payload: {
            editOnly: true,
            negativeProbes: job.wake.negativeProbes,
            nextReviewAt: job.wake.nextReviewAt,
            note: job.checkpoint.lastProbeNote,
          },
          nowMs,
        });
      }
      return { ok: true, job: structuredClone(job) };
    });
  }

  /**
   * Periodic Reaper & Startup Recovery (`boot()` + ongoing sweep).
   * Enforces Liveness Invariant across all non-terminal jobs:
   *   1. Reclaims expired `running` leases (moving any unresolved effect to `reconciling`).
   *   2. Ages stale `dispatched` intents in `reconciling` and emits `reconcilingDue`.
   *   3. Repairs orphaned `waiting` jobs missing `nextReviewAtMs`.
   *   4. Enforces horizon expiry (`statutoryLock` escalates once even if already paused; reconciles flying effects).
   *   5. Drives Default-Unless-Vetoed and 2-Nudge-1-Park, keeping `job.wake.nextReviewAtMs` in sync.
   */
  function reap({ nowMs = clock(), reconcileStaleMs = 120_000, maxReconcileRounds = 10 } = {}) {
    let dirty = false;
    return withFileLock(() => {
      const report = {
        reclaimedLeases: [],
        movedToReconciling: [],
        reconcilingDue: [],
        reconcileExhausted: [],
        escalatedCrashLoops: [],
        repairedOrphans: [],
        expiredJobs: [],
        statutoryEscalations: [],
        defaultedAsks: [],
        defaultedJobIds: [],
        nudgedAsks: [],
        pausedSilentAsks: [],
      };

      for (const job of state.jobs.values()) {
        if (DURABLE_TERMINAL_STATUSES.has(job.status)) continue;

        // 1. Horizon check
        if (job.budget.expiresAtMs && nowMs >= Number(job.budget.expiresAtMs)) {
          if (job.budget.statutoryLock) {
            if (job.budget.statutoryEscalatedForExpiryMs !== job.budget.expiresAtMs) {
              job.status = 'paused';
              job.waitingFor = null;
              job.lease = null;
              job.pausedByRole = 'system';
              job.pausedReason = 'statutory';
              job.budget.statutoryEscalatedForExpiryMs = job.budget.expiresAtMs;
              job.revision += 1;
              job.updatedAtMs = nowMs;
              job.updatedAt = new Date(nowMs).toISOString();
              const target = job.budget.statutoryEscalationTarget || job.principals.ownerIds[0] || job.audienceRoom.chatId;
              enqueueOutboxInternal({
                jobId: job.jobId,
                clientMessageId: `statutory_reap:${job.jobId}:${job.budget.expiresAtMs}`,
                kind: 'owner_dm',
                channel: 'owner_dm',
                chatId: target,
                payload: { code: 'STATUTORY_HORIZON_ESCALATE', jobId: job.jobId, goal: job.checkpoint.immutableGoal },
                nowMs,
                urgent: true,
              });
              report.statutoryEscalations.push(job.jobId);
              dirty = true;
            }
            continue;
          }
          // Non-statutory horizon expiry: reconcile flying remote effects before terminal cancel (H5 / R2 / N2)
          if (hasUnresolvedEffects(job)) {
            if (job.status !== 'reconciling' || !job.cancelRequested) {
              job.cancelRequested = true;
              job.status = 'reconciling';
              job.waitingFor = null;
              job.lease = null;
              job.wake.nextReviewAtMs = nowMs + 15_000;
              job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
              // Cancel any open/paused asks so step 4 never clobbers reconciling into silent_ask paused
              for (const a of state.asks.values()) {
                if (a.jobId === job.jobId && (a.status === 'open' || a.status === 'paused')) {
                  a.status = 'cancelled';
                }
              }
              job.revision += 1;
              job.updatedAtMs = nowMs;
              job.updatedAt = new Date(nowMs).toISOString();
              report.movedToReconciling.push(job.jobId);
              dirty = true;
              continue;
            }
            // Already reconciling for horizon expiry -> fall through to step 2b so ageing + onReconcileDue fire!
          } else {
            job.status = 'cancelled';
            job.waitingFor = null;
            job.lease = null;
            job.wake.nextReviewAtMs = null;
            job.wake.nextReviewAt = null;
            job.failureCode = 'HORIZON_EXPIRED';
            job.revision += 1;
            job.updatedAtMs = nowMs;
            job.updatedAt = new Date(nowMs).toISOString();
            enqueueOutboxInternal({
              jobId: job.jobId,
              clientMessageId: `horizon_expired:${job.jobId}`,
              kind: 'final_result',
              channel: job.audienceRoom.channel,
              chatId: job.audienceRoom.chatId,
              threadId: job.audienceRoom.threadId,
              payload: { status: 'cancelled', code: 'HORIZON_EXPIRED' },
              nowMs,
              urgent: true,
            });
            report.expiredJobs.push(job.jobId);
            dirty = true;
            continue;
          }
        }

        // 2. Expired running lease (worker crash / zombie)
        if (job.status === 'running' && (!job.lease || nowMs >= Number(job.lease.expiresAtMs))) {
          job.lease = null;
          job.budget.reservedUsd = 0;
          dirty = true;
          if (hasUnresolvedEffects(job)) {
            job.status = 'reconciling';
            job.waitingFor = null;
            job.wake.nextReviewAtMs = nowMs + 15_000;
            job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
            job.revision += 1;
            job.updatedAtMs = nowMs;
            job.updatedAt = new Date(nowMs).toISOString();
            report.movedToReconciling.push(job.jobId);
            continue;
          }
          job.budget.restartsForCurrentSlice = Number(job.budget.restartsForCurrentSlice || 0) + 1;
          if (job.budget.restartsForCurrentSlice > Number(job.budget.maxRestartsPerSlice || DEFAULT_JOB_BUDGET.maxRestartsPerSlice)) {
            job.status = 'failed';
            job.failureCode = 'MAX_SLICE_RESTARTS_EXCEEDED';
            job.failureReason = 'Worker crashed repeatedly on the same logical slice.';
            job.wake.nextReviewAtMs = null;
            job.wake.nextReviewAt = null;
            job.revision += 1;
            job.updatedAtMs = nowMs;
            job.updatedAt = new Date(nowMs).toISOString();
            enqueueOutboxInternal({
              jobId: job.jobId,
              clientMessageId: `crash_loop:${job.jobId}:rev${job.revision}`,
              kind: 'final_result',
              channel: job.audienceRoom.channel,
              chatId: job.audienceRoom.chatId,
              threadId: job.audienceRoom.threadId,
              payload: { status: 'failed', code: 'MAX_SLICE_RESTARTS_EXCEEDED' },
              nowMs,
              urgent: true,
            });
            report.escalatedCrashLoops.push(job.jobId);
          } else {
            job.status = 'queued';
            job.wake.nextReviewAtMs = nowMs;
            job.wake.nextReviewAt = new Date(nowMs).toISOString();
            job.revision += 1;
            job.updatedAtMs = nowMs;
            job.updatedAt = new Date(nowMs).toISOString();
            report.reclaimedLeases.push(job.jobId);
          }
          continue;
        }

        // 2b. Reconciling liveness: age stale dispatched intents & surface due jobs for host polling (P1-3)
        if (job.status === 'reconciling') {
          if (!hasUnresolvedEffects(job)) {
            job.status = job.cancelRequested ? 'cancelled' : 'queued';
            job.wake.nextReviewAtMs = job.status === 'queued' ? nowMs : null;
            job.wake.nextReviewAt = job.status === 'queued' ? new Date(nowMs).toISOString() : null;
            job.revision += 1;
            job.updatedAtMs = nowMs;
            job.updatedAt = new Date(nowMs).toISOString();
            if (job.status === 'queued') report.reclaimedLeases.push(job.jobId);
            dirty = true;
            continue;
          }
          const dueAt = Number(job.wake?.nextReviewAtMs || 0);
          if (!dueAt || nowMs >= dueAt) {
            for (const k of Object.keys(job.effectIntents)) {
              const it = job.effectIntents[k];
              // Age ANY stale unresolved intent (dispatched | accepted | running) to `unknown` so Async 202 jobs also hit bounded exit (B2/R2)
              if (
                it
                && UNRESOLVED_EFFECT_STATUSES.has(it.status)
                && it.status !== 'unknown'
                && (nowMs - Number(it.updatedAtMs || it.createdAtMs || 0)) >= reconcileStaleMs
              ) {
                it.status = 'unknown';
                it.updatedAtMs = nowMs;
                dirty = true;
              }
            }
            job.reconcileRounds = Number(job.reconcileRounds || 0) + 1;
            const maxRounds = Math.max(1, Number(maxReconcileRounds || 10));
            const allAgedUnknown = Object.keys(job.effectIntents).every((k) => {
              const st = job.effectIntents[k]?.status;
              return !UNRESOLVED_EFFECT_STATUSES.has(st) || st === 'unknown';
            });
            if (job.cancelRequested && job.reconcileRounds >= maxRounds && allAgedUnknown) {
              // Bounded exit for permanently unconfirmable effects on cancelled/expired jobs (N2)
              const unknownOps = Object.keys(job.effectIntents).filter((k) => job.effectIntents[k]?.status === 'unknown');
              job.status = 'cancelled';
              job.waitingFor = null;
              job.lease = null;
              job.wake.nextReviewAtMs = null;
              job.wake.nextReviewAt = null;
              job.failureCode = 'RECONCILE_EXHAUSTED_UNKNOWN_EFFECT';
              job.revision += 1;
              job.updatedAtMs = nowMs;
              job.updatedAt = new Date(nowMs).toISOString();
              enqueueOutboxInternal({
                jobId: job.jobId,
                clientMessageId: `reconcile_exhausted:${job.jobId}`,
                kind: 'owner_dm',
                channel: 'owner_dm',
                chatId: job.principals.ownerIds[0] || job.audienceRoom.chatId,
                payload: {
                  code: 'RECONCILE_EXHAUSTED_UNKNOWN_EFFECT',
                  jobId: job.jobId,
                  unknownOperationIds: unknownOps,
                  reconcileRounds: job.reconcileRounds,
                },
                nowMs,
                urgent: true,
              });
              report.reconcileExhausted.push(job.jobId);
              report.expiredJobs.push(job.jobId);
              dirty = true;
              continue;
            }
            job.wake.nextReviewAtMs = nowMs + 60_000;
            job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
            report.reconcilingDue.push(job.jobId);
            dirty = true;
          }
          continue;
        }

        // 3. Liveness invariant on actionable waiting jobs: timer/external/companion MUST have finite nextReviewAtMs
        if (
          job.status === 'waiting'
          && job.waitingFor !== 'authority'
          && job.waitingFor !== 'owner_approval'
          && job.waitingFor !== 'requester'
          && (!job.wake || !Number.isFinite(Number(job.wake.nextReviewAtMs)))
        ) {
          job.status = 'queued';
          job.waitingFor = null;
          job.wake.nextReviewAtMs = nowMs;
          job.wake.nextReviewAt = new Date(nowMs).toISOString();
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          report.repairedOrphans.push(job.jobId);
          dirty = true;
        }
      }

      // 4. Silent requester handling: Default-Unless-Vetoed & 2-Nudge-1-Park
      for (const ask of state.asks.values()) {
        if (ask.status !== 'open') continue;
        const job = state.jobs.get(ask.jobId);
        if (!job || DURABLE_TERMINAL_STATUSES.has(job.status)) {
          ask.status = 'cancelled';
          dirty = true;
          continue;
        }
        // Only process asks whose job is actually waiting (or silent_ask-paused):
        // NEVER clobber running, reconciling, queued, or owner/statutory-paused jobs (N1 / R3 / CARBON R3)!
        if (!(job.status === 'waiting' || (job.status === 'paused' && job.pausedReason === 'silent_ask'))) {
          continue;
        }
        // Default-Unless-Vetoed (requester asks only; never auto-approve owner escalations!)
        if (ask.targetRole === 'requester' && ask.defaultOption && ask.defaultActionAtMs && nowMs >= ask.defaultActionAtMs) {
          ask.status = 'answered';
          ask.answer = { value: ask.defaultOption, via: 'default_unless_vetoed' };
          ask.answeredBy = 'system:default_unless_vetoed';
          ask.answeredAtMs = nowMs;
          job.eventInbox.push({
            eventId: `ev_${crypto.randomBytes(6).toString('hex')}`,
            type: 'requester_answer',
            askId: ask.askId,
            answer: ask.answer,
            receivedAtMs: nowMs,
          });
          if (job.status === 'waiting' || (job.status === 'paused' && job.pausedReason === 'silent_ask')) {
            job.status = 'queued';
            job.waitingFor = null;
            job.pausedByRole = null;
            job.pausedReason = null;
            job.wake.nextReviewAtMs = nowMs;
            job.wake.nextReviewAt = new Date(nowMs).toISOString();
            report.defaultedJobIds.push(job.jobId);
          }
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          report.defaultedAsks.push(ask.askId);
          dirty = true;
          continue;
        }

        // 2-Nudge-1-Park (respecting quietHours AND syncing job.wake.nextReviewAtMs to avoid 5ms hot loop!)
        if (ask.nextNudgeAtMs && nowMs >= ask.nextNudgeAtMs) {
          if (isWithinQuietHours(nowMs, quietHours)) {
            ask.nextNudgeAtMs = nextNotificationWindowMs(nowMs, quietHours, { urgent: false });
            const nextDue = ask.defaultActionAtMs
              ? Math.min(ask.defaultActionAtMs, ask.nextNudgeAtMs)
              : ask.nextNudgeAtMs;
            job.wake.nextReviewAtMs = nextDue;
            job.wake.nextReviewAt = new Date(nextDue).toISOString();
            dirty = true;
            continue;
          }
          if (ask.nudgeCount < ask.maxNudges) {
            ask.nudgeCount += 1;
            ask.nextNudgeAtMs = nowMs + ask.nudgeDelaySec * 1000;
            const nextDue = ask.defaultActionAtMs
              ? Math.min(ask.defaultActionAtMs, ask.nextNudgeAtMs)
              : ask.nextNudgeAtMs;
            job.wake.nextReviewAtMs = nextDue;
            job.wake.nextReviewAt = new Date(nextDue).toISOString();
            enqueueOutboxInternal({
              jobId: job.jobId,
              clientMessageId: `ask_nudge:${ask.askId}:n${ask.nudgeCount}`,
              kind: ask.targetRole === 'owner' ? 'owner_dm' : 'ask',
              channel: ask.targetRole === 'owner' ? 'owner_dm' : job.audienceRoom.channel,
              chatId: ask.targetRole === 'owner' ? ask.recipientPrincipalId : job.audienceRoom.chatId,
              threadId: ask.targetRole === 'owner' ? null : job.audienceRoom.threadId,
              payload: { askId: ask.askId, nudge: ask.nudgeCount, maxNudges: ask.maxNudges, question: ask.question },
              nowMs,
            });
            report.nudgedAsks.push(ask.askId);
            dirty = true;
          } else if (ask.defaultActionAtMs && nowMs < ask.defaultActionAtMs) {
            // Do NOT prematurely pause before a longer Default-Unless-Vetoed window fires (C3)!
            ask.nextNudgeAtMs = null;
            job.wake.nextReviewAtMs = ask.defaultActionAtMs;
            job.wake.nextReviewAt = new Date(ask.defaultActionAtMs).toISOString();
            dirty = true;
          } else {
            ask.status = 'paused';
            ask.nextNudgeAtMs = null;
            job.status = 'paused';
            job.waitingFor = null;
            job.pausedByRole = 'system';
            job.pausedReason = 'silent_ask';
            job.wake.nextReviewAtMs = null;
            job.wake.nextReviewAt = null;
            job.revision += 1;
            job.updatedAtMs = nowMs;
            job.updatedAt = new Date(nowMs).toISOString();
            enqueueOutboxInternal({
              jobId: job.jobId,
              clientMessageId: `ask_pause:${ask.askId}`,
              kind: ask.targetRole === 'owner' ? 'owner_dm' : 'progress_edit',
              channel: ask.targetRole === 'owner' ? 'owner_dm' : job.audienceRoom.channel,
              chatId: ask.targetRole === 'owner' ? ask.recipientPrincipalId : job.audienceRoom.chatId,
              threadId: ask.targetRole === 'owner' ? null : job.audienceRoom.threadId,
              payload: { askId: ask.askId, pausedNeedsInput: true },
              nowMs,
            });
            report.pausedSilentAsks.push(ask.askId);
            dirty = true;
          }
        }
      }

      return report;
    }, { shouldPersist: () => dirty });
  }

  function getNextDueAtMs() {
    let minMs = null;
    const consider = (ts) => {
      if (ts !== null && ts !== undefined && Number.isFinite(Number(ts))) {
        const n = Number(ts);
        if (minMs === null || n < minMs) minMs = n;
      }
    };
    for (const job of state.jobs.values()) {
      if (DURABLE_TERMINAL_STATUSES.has(job.status)) continue;
      if (job.status === 'running') {
        consider(job.lease?.expiresAtMs);
      } else if (job.status === 'reconciling') {
        consider(job.wake?.nextReviewAtMs);
      } else if (job.status === 'waiting') {
        // Schedule ONLY actionable waiting timers: exclude human/authority waits AND event-only companion sleeps (R1 / N2)
        if (
          job.waitingFor === 'timer'
          || job.waitingFor === 'external'
          || (job.waitingFor === 'companion' && (Boolean(job.wake?.probeName) || Boolean(job.wake?.hasExplicitTimer)))
        ) {
          consider(job.wake?.nextReviewAtMs);
        }
      }
      // Retire past horizon deadline once reconciling cancellation is already underway (R2 / H1 / H5)
      if (
        job.budget?.expiresAtMs
        && !(job.status === 'reconciling' && job.cancelRequested)
        && (!job.budget.statutoryLock || job.budget.statutoryEscalatedForExpiryMs !== job.budget.expiresAtMs)
      ) {
        consider(job.budget.expiresAtMs);
      }
    }
    for (const ask of state.asks.values()) {
      if (ask.status !== 'open') continue;
      const ownerJob = state.jobs.get(ask.jobId);
      if (!ownerJob || DURABLE_TERMINAL_STATUSES.has(ownerJob.status)) continue;
      if (!(ownerJob.status === 'waiting' || (ownerJob.status === 'paused' && ownerJob.pausedReason === 'silent_ask'))) continue;
      consider(ask.nextNudgeAtMs);
      if (ask.targetRole !== 'owner') consider(ask.defaultActionAtMs);
    }
    return minMs;
  }

  function claimPendingOutbox({ workerId = 'outbox-1', leaseMs = 30_000, limit = 20, nowMs = clock() } = {}) {
    let dirty = false;
    return withFileLock(() => {
      const claimed = [];
      const cap = Math.max(1, Math.min(100, Number(limit || 20)));
      const effLease = Math.max(5_000, Number(leaseMs || 30_000));
      // Serialize in-flight progress_edit deliveries per status card so a newer edit never overtakes an older in-flight edit (H11)
      const inFlightCards = new Set();
      for (const rec of state.outbox.values()) {
        if (
          rec.deliveryState === 'pending'
          && rec.kind === 'progress_edit'
          && rec.editMessageId != null
          && rec.claimExpiresAtMs
          && nowMs < Number(rec.claimExpiresAtMs)
        ) {
          inFlightCards.add(`${rec.jobId}:${rec.editMessageId}`);
        }
      }
      for (const rec of state.outbox.values()) {
        if (claimed.length >= cap) break;
        if (rec.deliveryState !== 'pending') continue;
        if (rec.deliverAfterMs && nowMs < Number(rec.deliverAfterMs)) continue;
        if (rec.claimExpiresAtMs && nowMs < Number(rec.claimExpiresAtMs)) continue;
        let cardKey = null;
        if (rec.kind === 'progress_edit' && rec.editMessageId != null) {
          cardKey = `${rec.jobId}:${rec.editMessageId}`;
          if (inFlightCards.has(cardKey)) continue;
        }
        rec.claimedBy = String(workerId);
        rec.claimToken = `clm_${crypto.randomBytes(8).toString('hex')}`;
        rec.claimExpiresAtMs = nowMs + effLease;
        rec.updatedAt = new Date(nowMs).toISOString();
        if (cardKey) inFlightCards.add(cardKey);
        claimed.push(structuredClone(rec));
        dirty = true;
      }
      return claimed;
    }, { shouldPersist: () => dirty });
  }

  return {
    filePath: absPath,
    createJob,
    claimJob,
    parkJob,
    enqueueWake,
    recordEffectIntent,
    recordEffectReceipt,
    openAsk,
    answerAsk,
    submitSteering,
    ackSteeringApplied,
    completeJob,
    failJob,
    recordNegativeProbe,
    reap,
    boot: ({ nowMs = clock() } = {}) => reap({ nowMs }),
    enqueueOutbox: (opts) => withFileLock(() => enqueueOutboxInternal(opts)),
    claimPendingOutbox,
    markOutboxDelivery(clientMessageId, { deliveryState = 'sent', externalMessageId = null, statusCard = false, claimToken = null, nowMs = clock() } = {}) {
      return withFileLock(() => {
        const rec = state.outbox.get(String(clientMessageId || ''));
        if (!rec) return { ok: false, code: 'OUTBOX_NOT_FOUND' };
        // Never allow a late ack to transition a superseded edit to sent (H11)
        if (rec.deliveryState === 'superseded') {
          return { ok: false, code: 'OUTBOX_SUPERSEDED', record: structuredClone(rec) };
        }
        // Claim-token fencing runs BEFORE monotonic-sent short-circuit so mismatched tokens always fail closed (H11)
        const claimActive = Boolean(rec.claimToken && rec.claimExpiresAtMs && nowMs < Number(rec.claimExpiresAtMs));
        if (claimActive && claimToken !== rec.claimToken) {
          return { ok: false, code: 'OUTBOX_CLAIM_TOKEN_MISMATCH', claimedBy: rec.claimedBy };
        }
        if (claimToken != null && rec.claimToken !== claimToken) {
          return { ok: false, code: 'OUTBOX_CLAIM_TOKEN_MISMATCH', claimedBy: rec.claimedBy };
        }
        // Monotonic delivery: never let a stale retry overwrite an already-sent message (H11)
        if (rec.deliveryState === 'sent' && deliveryState !== 'sent') {
          return { ok: true, ignoredStale: true, record: structuredClone(rec) };
        }
        rec.deliveryState = deliveryState;
        rec.claimedBy = null;
        rec.claimToken = null;
        rec.claimExpiresAtMs = null;
        if (externalMessageId != null) rec.externalMessageId = String(externalMessageId);
        rec.updatedAt = new Date(nowMs).toISOString();
        if (statusCard && externalMessageId) {
          const job = state.jobs.get(rec.jobId);
          if (job) job.statusCardMessageId = String(externalMessageId);
        }
        return { ok: true, record: structuredClone(rec) };
      });
    },
    getJob: (jobId) => {
      hydrateFromDisk();
      const j = state.jobs.get(String(jobId || ''));
      return j ? structuredClone(j) : null;
    },
    listJobs: ({ status = null, agentId = null, chatId = null } = {}) => {
      hydrateFromDisk();
      return [...state.jobs.values()]
        .filter((j) => (!status || j.status === status) && (!agentId || j.agentId === agentId) && (!chatId || j.audienceRoom?.chatId === String(chatId)))
        .map((j) => structuredClone(j));
    },
    getAsk: (askId) => {
      hydrateFromDisk();
      const a = state.asks.get(String(askId || ''));
      return a ? structuredClone(a) : null;
    },
    listAsks: ({ jobId = null, status = null } = {}) => {
      hydrateFromDisk();
      return [...state.asks.values()]
        .filter((a) => (!jobId || a.jobId === jobId) && (!status || a.status === status))
        .map((a) => structuredClone(a));
    },
    listOutbox: ({ jobId = null, deliveryState = null } = {}) => {
      hydrateFromDisk();
      return [...state.outbox.values()]
        .filter((o) => (!jobId || o.jobId === jobId) && (!deliveryState || o.deliveryState === deliveryState))
        .map((o) => structuredClone(o));
    },
    getNextDueAtMs,
    assertTransition,
  };
}
