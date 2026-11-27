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

const STATUS_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'paused', 'cancelled', 'failed']),
  running: new Set(['waiting', 'reconciling', 'paused', 'completed', 'failed', 'cancelled']),
  waiting: new Set(['queued', 'paused', 'cancelled', 'failed']),
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

export function computeArgsHash(args) {
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
  const expiresAtMs = src.expiresAtMs && Number.isFinite(Number(src.expiresAtMs))
    ? Number(src.expiresAtMs)
    : nowMs + horizonDays * 24 * 60 * 60 * 1000;

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

function localMinutesOfDay(nowMs, tz = 'UTC') {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(nowMs));
    const h = Number(parts.find((p) => p.type === 'hour')?.value || 0) % 24;
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return h * 60 + m;
  } catch {
    const d = new Date(nowMs);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
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
  const cur = localMinutesOfDay(nowMs, tz);
  const end = parseHm(quietHours.end, 7, 30);
  let deltaMin = end - cur;
  if (deltaMin <= 0) deltaMin += 24 * 60;
  return nowMs + deltaMin * 60 * 1000;
}

// -- Anti-Bailout Interceptor (No-Promise-Without-Hook, pure ASCII with NFD accent folding) --
const FUTURE_PROMISE_PATTERNS = [
  /\b(?:will|i'll|we'll)\s+(?:check\s+back|recheck|monitor|follow\s+up|let\s+you\s+know|notify\s+you|update\s+you)\b/i,
  /\bonce\s+(?:it|the\s+\w+)\s+(?:finishes|completes|is\s+ready)\b/i,
  /\bkhi\s+nao\b[\s\S]{0,60}\b(?:xong|co\s+ket\s+qua|hoan\s+tat)\b[\s\S]{0,50}\b(?:bao|nhan|gui|kiem\s+tra)\b/i,
  /\bse\s+(?:tu\s+)?(?:kiem\s+tra\s+lai|theo\s+doi|bao\s+lai|cap\s+nhat\s+lai|bao\s+ngay)\b/i,
];

function foldAscii(str) {
  return String(str || '')
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
  const tracePending = Boolean(hasPendingToolStatus) || (Array.isArray(toolTraces) && toolTraces.some((tr) => {
    const raw = typeof tr === 'string' ? tr : JSON.stringify(tr || {});
    return PENDING_TOOL_STATUS_RE.test(raw);
  }));
  const matchesPromise = FUTURE_PROMISE_PATTERNS.some((re) => re.test(text));
  if (matchesPromise && tracePending) {
    return {
      detected: true,
      code: 'POLITE_BAILOUT_BLOCKED',
      reason: 'Model promised future follow-up after pending tool output without scheduling job_yield.',
    };
  }
  if (matchesPromise && text.length > 0) {
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

export function evaluateEffectiveAuthority({
  job,
  liveAuth = {},
  nowMs = Date.now(),
} = {}) {
  if (!job || typeof job !== 'object') {
    return { allowed: false, code: 'JOB_NOT_FOUND', parkWaitingFor: 'authority' };
  }
  const live = liveAuth && typeof liveAuth === 'object' ? liveAuth : {};
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

  // Verify specHash integrity if ticket-backed
  if (job.authority?.specHash && live.liveSpecHash && job.authority.specHash !== live.liveSpecHash) {
    return { allowed: false, code: 'SPEC_HASH_MISMATCH', reason: 'Ticket specHash changed after approval.', parkWaitingFor: 'authority' };
  }
  if (job.authority?.ticketId && live.ticketRevoked === true) {
    return { allowed: false, code: 'TICKET_REVOKED', reason: 'Backing approval ticket was revoked or rejected.', parkWaitingFor: 'authority' };
  }

  if (isGroup) {
    if (live.botInRoom === false) {
      return { allowed: false, code: 'BOT_REMOVED', reason: 'Bot is no longer a member of the originating group.', parkWaitingFor: 'authority' };
    }
    const effectivePolicy = String(live.groupPolicy || job.authority?.policySnapshot?.groupPolicy || 'owner_or_approve').toLowerCase();
    if (effectivePolicy === 'owner_dm_only') {
      return { allowed: false, code: 'POLICY_RESTRICTED', reason: 'Group policy tightened to owner_dm_only.', parkWaitingFor: 'authority' };
    }
    const ownerInRoom = live.ownerInRoom !== undefined ? Boolean(live.ownerInRoom) : Boolean(job.authority?.policySnapshot?.ownerInRoom);
    if (!ownerInRoom) {
      return { allowed: false, code: 'OWNER_LEFT_ROOM', reason: 'Owner is no longer verified in the originating group.', parkWaitingFor: 'authority' };
    }
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
  }

  // Compute strict intersection: effectiveScope = snapshotScope intersect liveScope
  let effectiveTools = snapshotTools ? [...snapshotTools] : (liveTools ? [...liveTools] : []);
  if (snapshotTools && liveTools) {
    effectiveTools = snapshotTools.filter((t) => liveTools.has(t));
  }
  if (isGroup) {
    effectiveTools = effectiveTools.filter((t) => !GROUP_FORBIDDEN_CAPABILITIES.has(t));
  }

  return {
    allowed: true,
    code: 'OK',
    isGroup,
    effectiveTools,
    forbidSecrets: isGroup,
    forbidCaptchaHandoff: isGroup,
  };
}

// -- sec 63: Requester vs Owner vs Stranger Steering Matrix --
export function evaluateSteeringPermission({
  job,
  actorId,
  actorRole = null,
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
  const isRequester = !isOwner && (
    (cleanActor && req.principalId && cleanActor === String(req.principalId))
    || (cleanActor && req.externalId && cleanActor === String(req.externalId))
  );

  if (isOwner) {
    return { allowed: true, effectiveRole: 'owner', requiresNewApproval: false, code: 'OK' };
  }
  if (!isRequester) {
    return {
      allowed: false,
      effectiveRole: 'stranger',
      code: 'STEERING_DENIED_STRANGER',
      reason: 'Only the task requester or workspace owner may steer, pause, or cancel this job.',
    };
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
    milestone: job.checkpoint?.milestone || null,
    progressSummary: redactTicketText(job.checkpoint?.progressSummary || '', 300),
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
    return JSON.stringify({
      schema: DURABLE_JOB_SCHEMA,
      jobs: [...state.jobs.values()],
      asks: [...state.asks.values()],
      outbox: [...state.outbox.values()],
      steering: [...state.steering.values()],
    }, null, 2) + '\n';
  }

  function hydrateFromDisk() {
    if (!absPath || !fs.existsSync(absPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
      state.jobs.clear();
      state.byOriginKey.clear();
      state.asks.clear();
      state.outbox.clear();
      state.steering.clear();
      for (const j of parsed.jobs || []) {
        if (!j?.jobId) continue;
        state.jobs.set(j.jobId, j);
        const okKey = `${j.tenantId}|${j.agentId}|${j.origin?.dedupeKey || j.jobId}`;
        state.byOriginKey.set(okKey, j.jobId);
      }
      for (const a of parsed.asks || []) {
        if (a?.askId) state.asks.set(a.askId, a);
      }
      for (const o of parsed.outbox || []) {
        if (o?.clientMessageId) state.outbox.set(o.clientMessageId, o);
      }
      for (const s of parsed.steering || []) {
        if (s?.jobId && s?.sourceEventId) state.steering.set(`${s.jobId}:${s.sourceEventId}`, s);
      }
    } catch {
      // ignore corrupted snapshot on cold init
    }
  }

  function withFileLock(fn) {
    if (!absPath) return fn();
    fs.mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o700 });
    let fd = null;
    const deadline = Date.now() + 3000;
    while (fd === null) {
      try {
        fd = fs.openSync(lockFile, 'wx', 0o600);
      } catch (err) {
        if (err.code !== 'EEXIST' || Date.now() > deadline) {
          // Stale lock recovery if older than 5s
          try {
            const st = fs.statSync(lockFile);
            if (Date.now() - st.mtimeMs > 5000) {
              fs.unlinkSync(lockFile);
              continue;
            }
          } catch { /* ignore */ }
          throw new Error('ERR_JOB_STORE_LOCK_CONTENTION');
        }
      }
    }
    try {
      hydrateFromDisk();
      const res = fn();
      const tmp = `${absPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, serializeState(), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, absPath);
      return res;
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
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
    if (revision != null && Number(revision) !== Number(job.revision)) {
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
        effectIntents: {},    // operationId -> { operationId, tool, argsHash, status, receipt, createdAtMs, updatedAtMs }
        eventInbox: [],       // buffered early events arriving before parkJob commits
        steeringPending: [],  // unapplied steering IDs
        cancelRequested: false,
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

      // Live re-authorization check before granting a slice (sec 63)
      if (liveAuth) {
        const authRes = evaluateEffectiveAuthority({ job, liveAuth, nowMs });
        if (!authRes.allowed) {
          job.status = 'waiting';
          job.waitingFor = 'authority';
          job.waitGeneration += 1;
          job.revision += 1;
          job.lease = null;
          job.wake.nextReviewAtMs = nowMs + 60 * 60 * 1000;
          job.wake.nextReviewAt = new Date(job.wake.nextReviewAtMs).toISOString();
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
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          const escTarget = job.budget.statutoryEscalationTarget || job.principals.ownerIds[0] || job.audienceRoom.chatId;
          enqueueOutboxInternal({
            jobId: job.jobId,
            clientMessageId: `statutory_escalate:${job.jobId}:${job.revision}`,
            kind: 'owner_dm',
            channel: 'owner_dm',
            chatId: escTarget,
            payload: { code: 'STATUTORY_HORIZON_ESCALATE', jobId: job.jobId, goal: job.checkpoint.immutableGoal },
            nowMs,
            urgent: true,
          });
          return { ok: false, code: bChk.code, escalated: true, job: structuredClone(job) };
        }
        job.status = bChk.code === 'HORIZON_EXPIRED' ? 'cancelled' : 'failed';
        job.failureCode = bChk.code;
        job.failureReason = bChk.reason;
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
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
      job.budget.restartsForCurrentSlice = 0;
      const effLeaseMs = Math.max(15_000, Math.min(300_000, Number(leaseMs || 150_000)));
      const leaseToken = `ls_${crypto.randomBytes(10).toString('hex')}`;
      job.lease = {
        ownerId: String(workerId),
        leaseToken,
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + effLeaseMs,
        expiresAt: new Date(nowMs + effLeaseMs).toISOString(),
      };
      job.checkpoint.lastWokeAtMs = nowMs;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();

      const inboxEvents = job.eventInbox.splice(0);
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
        inboxEvents,
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

      const tempoTier = computeTempoTier({
        createdAtMs: job.createdAtMs,
        nowMs,
        requestedSleepSec: sleepSec || (wakeAtMs ? Math.max(0, (wakeAtMs - nowMs) / 1000) : 0),
        hasYielded: true,
      });

      const effDelaySec = wakeAtMs
        ? Math.max(10, Math.round((Number(wakeAtMs) - nowMs) / 1000))
        : computeNextProbeDelaySec({
            tempoTier,
            negativeProbes: 0,
            pollAfterSec: sleepSec,
            etaMs: job.wake.etaMs,
            nowMs,
            slaDeadlineMs: job.wake.slaDeadlineMs,
          });
      const nextReviewAtMs = wakeAtMs && Number.isFinite(Number(wakeAtMs))
        ? Math.max(nowMs + 10_000, Number(wakeAtMs))
        : nowMs + effDelaySec * 1000;

      // Update checkpoint while keeping line-0 `immutableGoal` and `doneCriteria` strictly immutable
      const cp = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
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
        lastObservedAtMs: cp.lastObservedAtMs !== undefined ? Number(cp.lastObservedAtMs) : job.checkpoint.lastObservedAtMs,
        workLedger: Array.isArray(cp.workLedger)
          ? [`[GOAL] ${job.checkpoint.immutableGoal}`, ...cp.workLedger.filter((l) => !String(l).startsWith('[GOAL]')).slice(0, 24).map((l) => redactTicketText(l, 220))]
          : job.checkpoint.workLedger,
      };

      job.tempoTier = tempoTier;
      job.waitGeneration += 1;
      job.wake = {
        ...job.wake,
        nextReviewAtMs,
        nextReviewAt: new Date(nextReviewAtMs).toISOString(),
        wakeOn: Array.isArray(wakeOn) ? redactTicketPayload(wakeOn) : [],
        probeName: probeName ? String(probeName).trim() : null,
        probeArgs: probeArgs && typeof probeArgs === 'object' ? redactTicketPayload(probeArgs) : null,
        negativeProbes: 0,
      };
      job.lease = null;
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();

      // If an event already landed in `eventInbox` BEFORE parkJob committed (callback-before-park race),
      // immediately transition to `queued` so the early callback is NEVER lost!
      const matchedEarly = job.eventInbox.length > 0 && (
        job.wake.wakeOn.length === 0
        || job.eventInbox.some((ev) => job.wake.wakeOn.some((w) => w.type === ev.type && (!w.operationId || w.operationId === ev.operationId)))
      );
      if (matchedEarly || job.steeringPending.some((k) => state.steering.get(k)?.status === 'received')) {
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
        job.eventInbox.push({
          ...redactTicketPayload(event),
          receivedAtMs: nowMs,
        });
      }

      // If job is currently running, buffer event safely in `eventInbox` (consumed by parkJob or next slice)
      // without bumping the active worker's CAS `revision` (avoids spurious conflict on callback-before-park).
      if (job.status === 'running') {
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, buffered: true, status: 'running', job: structuredClone(job) };
      }

      if (job.status === 'waiting' || job.status === 'reconciling' || (job.status === 'paused' && reason === 'resume')) {
        job.status = 'queued';
        job.waitingFor = null;
        job.revision += 1;
        job.wake.nextReviewAtMs = nowMs;
        job.wake.nextReviewAt = new Date(nowMs).toISOString();
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, buffered: false, woke: true, job: structuredClone(job) };
      }

      return { ok: true, buffered: false, woke: false, status: job.status, job: structuredClone(job) };
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
      if (!opId) return { ok: false, code: 'OPERATION_ID_REQUIRED' };
      const argsHash = computeArgsHash(args);
      const existing = job.effectIntents[opId];
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
      const intent = job.effectIntents[opId];
      if (!intent) return { ok: false, code: 'EFFECT_INTENT_NOT_FOUND' };

      const normStatus = ['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(status)
        ? status
        : 'unknown';
      intent.status = normStatus;
      if (remoteJobId) intent.remoteJobId = String(remoteJobId);
      if (receipt !== null && receipt !== undefined) intent.receipt = redactTicketPayload(receipt);
      intent.updatedAtMs = nowMs;

      if (normStatus === 'unknown' && !DURABLE_TERMINAL_STATUSES.has(job.status)) {
        job.status = 'reconciling';
        job.lease = null;
      } else if (job.cancelRequested && ['succeeded', 'failed', 'cancelled'].includes(normStatus)) {
        const stillFlying = Object.values(job.effectIntents).some((i) => ['dispatched', 'accepted', 'running', 'unknown'].includes(i.status));
        if (!stillFlying) {
          job.status = 'cancelled';
          job.lease = null;
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
    activeMsDelta = 0,
    usdDelta = 0,
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };
      if (leaseToken != null) {
        const lv = verifyLease(job, { revision, jobEpoch, leaseToken, nowMs });
        if (!lv.ok) return lv;
      }

      const normKind = String(kind || '').trim().toLowerCase();
      if (normKind === 'secret') {
        return { ok: false, code: 'SECRET_ASK_DISABLED_UNTIL_VAULT_PROVIDER', reason: 'ask(kind=secret) is disabled until SecretProvider (v2.20) is active.' };
      }
      if (!ASK_KIND_SET.has(normKind)) {
        return { ok: false, code: 'INVALID_ASK_KIND', reason: `Allowed ask kinds: ${ASK_KINDS.join(', ')}` };
      }

      const normTarget = targetRole === 'owner' ? 'owner' : 'requester';
      const existingOpen = [...state.asks.values()].find((a) => a.jobId === job.jobId && a.status === 'open');
      if (existingOpen) {
        return { ok: false, code: 'ASK_ALREADY_OPEN', existingAskId: existingOpen.askId };
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
        question: redactTicketText(question || '', 1200),
        options: Array.isArray(options) ? redactTicketPayload(options.slice(0, 12)) : [],
        defaultOption: defaultOption ? redactTicketText(defaultOption, 200) : null,
        defaultActionAtMs: defSec ? nowMs + defSec * 1000 : null,
        nudgeCount: 0,
        maxNudges: DEFAULT_MAX_NUDGES,
        nudgeDelaySec: effNudgeSec,
        nextNudgeAtMs: nowMs + effNudgeSec * 1000,
        answer: null,
        answeredBy: null,
        answeredAtMs: null,
        createdAtMs: nowMs,
        createdAt: new Date(nowMs).toISOString(),
      };
      state.asks.set(askId, ask);

      // Atomic park (D5: inlineWaitSec = 0 -> immediate park, release lease!)
      applyUsageDelta(job, { activeMsDelta, usdDelta, nowMs });
      if (checkpoint && typeof checkpoint === 'object') {
        job.checkpoint = {
          ...job.checkpoint,
          version: Number(job.checkpoint.version || 0) + 1,
          immutableGoal: job.checkpoint.immutableGoal,
          doneCriteria: job.checkpoint.doneCriteria,
          milestone: checkpoint.milestone ? redactTicketText(checkpoint.milestone, 120) : job.checkpoint.milestone,
          progressSummary: checkpoint.progressSummary !== undefined ? redactTicketText(checkpoint.progressSummary, 600) : job.checkpoint.progressSummary,
          nextAction: checkpoint.nextAction !== undefined ? redactTicketText(checkpoint.nextAction, 600) : job.checkpoint.nextAction,
        };
      }
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

      // Transactional outbox: Owner escalations go ONLY to Owner DM; Group receives neutral 1-liner
      if (normTarget === 'owner') {
        enqueueOutboxInternal({
          jobId: job.jobId,
          clientMessageId: `ask_owner_dm:${askId}`,
          kind: 'owner_dm',
          channel: 'owner_dm',
          chatId: recipientPrincipalId,
          payload: { askId, kind: normKind, question: ask.question, options: ask.options },
          nowMs,
          urgent: true,
        });
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
        enqueueOutboxInternal({
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
            question: ask.question,
            options: ask.options,
            defaultOption: ask.defaultOption,
          },
          nowMs,
        });
      }

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
      if (ask.status !== 'open') {
        return { ok: false, code: 'ASK_NOT_OPEN', status: ask.status };
      }
      const job = state.jobs.get(ask.jobId);
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };

      const cleanActor = actorId != null ? String(actorId).trim() : '';
      const ownerSet = new Set((job.principals?.ownerIds || []).map(String));
      const isOwner = actorRole === 'owner' || (cleanActor && ownerSet.has(cleanActor));

      if (ask.targetRole === 'owner' && !isOwner) {
        return { ok: false, code: 'OWNER_ONLY_ASK', reason: 'Only workspace owners may answer owner escalations.' };
      }
      if (ask.targetRole === 'requester' && !isOwner) {
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
      // Keep any private owner note strictly on owner-private ask record, NEVER emitted to group outbox!
      if (privateOwnerNote && isOwner) {
        ask.privateOwnerNote = redactTicketText(privateOwnerNote, 600);
      }

      // Wake the job immediately if still on matching intentRev
      if (!DURABLE_TERMINAL_STATUSES.has(job.status)) {
        job.eventInbox.push({
          type: ask.targetRole === 'owner' ? 'owner_answer' : 'requester_answer',
          askId: ask.askId,
          answer: ask.answer,
          // Never expose privateOwnerNote into group-audience job events
          receivedAtMs: nowMs,
        });
        if (job.status === 'waiting') {
          job.status = 'queued';
          job.waitingFor = null;
          job.wake.nextReviewAtMs = nowMs;
          job.wake.nextReviewAt = new Date(nowMs).toISOString();
        }
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
      }

      return { ok: true, ask: structuredClone(ask), job: structuredClone(job) };
    });
  }

  function submitSteering({
    jobId,
    sourceEventId,
    actorId,
    actorRole = null,
    baseIntentRev = null,
    commandKind = 'clarify',
    payload = {},
    requestedCapabilities = [],
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job) return { ok: false, code: 'JOB_NOT_FOUND' };

      const evtId = String(sourceEventId || `st_${crypto.randomBytes(6).toString('hex')}`).trim();
      const dedupeKey = `${job.jobId}:${evtId}`;
      if (state.steering.has(dedupeKey)) {
        return { ok: true, deduplicated: true, steering: structuredClone(state.steering.get(dedupeKey)), job: structuredClone(job) };
      }

      const perm = evaluateSteeringPermission({ job, actorId, actorRole, commandKind, requestedCapabilities });
      if (!perm.allowed) {
        const rejectedRec = {
          steerId: `str_${crypto.randomBytes(6).toString('hex')}`,
          jobId: job.jobId,
          sourceEventId: evtId,
          actorPrincipalId: String(actorId || ''),
          actorRole: perm.effectiveRole || 'stranger',
          baseIntentRev: baseIntentRev ?? job.intentRev,
          commandKind,
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

      // If terminal already, return terminal receipt cleanly (cancel loses to already-committed completion)
      if (DURABLE_TERMINAL_STATUSES.has(job.status)) {
        return { ok: false, code: 'JOB_ALREADY_TERMINAL', status: job.status, job: structuredClone(job) };
      }

      // Optimistic conflict detection on concurrent amends targeting same revision
      if (commandKind === 'amend' && baseIntentRev != null && Number(baseIntentRev) !== Number(job.intentRev)) {
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
        commandKind,
        status: 'received',
        ackReceivedAtMs: nowMs,
        ackAppliedAtMs: null,
        payload: redactTicketPayload(payload),
        createdAtMs: nowMs,
      };
      state.steering.set(dedupeKey, rec);

      if (commandKind === 'cancel') {
        const hasFlying = Object.values(job.effectIntents).some((i) => ['dispatched', 'accepted', 'running', 'unknown'].includes(i.status));
        job.cancelRequested = true;
        // Supersede any open asks
        for (const a of state.asks.values()) {
          if (a.jobId === job.jobId && a.status === 'open') a.status = 'cancelled';
        }
        if (!hasFlying && job.status !== 'running') {
          job.status = 'cancelled';
          job.waitingFor = null;
          job.lease = null;
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
        } else {
          // Effect in flight or worker active: reconcile before confirming cancelled
          if (job.status !== 'running') job.status = 'reconciling';
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

      if (commandKind === 'pause') {
        if (job.status === 'waiting' || job.status === 'queued') {
          job.status = 'paused';
          job.waitingFor = null;
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
        } else {
          job.steeringPending.push(dedupeKey);
        }
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, steering: structuredClone(rec), job: structuredClone(job) };
      }

      if (commandKind === 'resume') {
        if (job.status === 'paused') {
          job.status = 'queued';
          job.wake.nextReviewAtMs = nowMs;
          job.wake.nextReviewAt = new Date(nowMs).toISOString();
          rec.status = 'applied';
          rec.ackAppliedAtMs = nowMs;
        }
        job.revision += 1;
        job.updatedAtMs = nowMs;
        job.updatedAt = new Date(nowMs).toISOString();
        return { ok: true, steering: structuredClone(rec), job: structuredClone(job) };
      }

      // `clarify` or `amend`
      if (commandKind === 'amend') {
        job.intentRev += 1;
        // Supersede asks tied to previous intentRev
        for (const a of state.asks.values()) {
          if (a.jobId === job.jobId && a.status === 'open' && a.intentRev < job.intentRev) {
            a.status = 'superseded';
          }
        }
      }
      job.steeringPending.push(dedupeKey);
      if (job.status === 'waiting') {
        job.status = 'queued';
        job.waitingFor = null;
        job.wake.nextReviewAtMs = nowMs;
        job.wake.nextReviewAt = new Date(nowMs).toISOString();
      }
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();
      return { ok: true, steering: structuredClone(rec), job: structuredClone(job) };
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
      applyUsageDelta(job, { activeMsDelta, usdDelta, nowMs });
      job.status = 'failed';
      job.waitingFor = null;
      job.lease = null;
      job.failureCode = String(code || 'FAILED');
      job.failureReason = redactTicketText(reason || 'Job failed', 1000);
      job.revision += 1;
      job.updatedAtMs = nowMs;
      job.updatedAt = new Date(nowMs).toISOString();
      return { ok: true, job: structuredClone(job) };
    });
  }

  function recordNegativeProbe({
    jobId,
    nextReviewAtMs,
    tempoTier = null,
    statusNote = '',
    nowMs = clock(),
  } = {}) {
    return withFileLock(() => {
      const job = state.jobs.get(String(jobId || ''));
      if (!job || job.status !== 'waiting') return { ok: false, code: 'JOB_NOT_WAITING' };
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
   *   1. Reclaims expired `running` leases (moving unreceipted effects to `reconciling`).
   *   2. Repairs orphaned `waiting` jobs missing `nextReviewAtMs`.
   *   3. Enforces horizon expiry (with `statutoryLock` escalating instead of silently expiring).
   *   4. Drives Default-Unless-Vetoed and 2-Nudge-1-Park for silent requesters.
   */
  function reap({ nowMs = clock() } = {}) {
    return withFileLock(() => {
      const report = {
        reclaimedLeases: [],
        movedToReconciling: [],
        escalatedCrashLoops: [],
        repairedOrphans: [],
        expiredJobs: [],
        statutoryEscalations: [],
        defaultedAsks: [],
        nudgedAsks: [],
        pausedSilentAsks: [],
      };

      for (const job of state.jobs.values()) {
        if (DURABLE_TERMINAL_STATUSES.has(job.status)) continue;

        // 1. Horizon check
        if (job.budget.expiresAtMs && nowMs >= Number(job.budget.expiresAtMs)) {
          if (job.budget.statutoryLock) {
            if (job.status !== 'paused') {
              job.status = 'paused';
              job.lease = null;
              job.revision += 1;
              job.updatedAtMs = nowMs;
              job.updatedAt = new Date(nowMs).toISOString();
              const target = job.budget.statutoryEscalationTarget || job.principals.ownerIds[0] || job.audienceRoom.chatId;
              enqueueOutboxInternal({
                jobId: job.jobId,
                clientMessageId: `statutory_reap:${job.jobId}:${job.revision}`,
                kind: 'owner_dm',
                channel: 'owner_dm',
                chatId: target,
                payload: { code: 'STATUTORY_HORIZON_ESCALATE', jobId: job.jobId, goal: job.checkpoint.immutableGoal },
                nowMs,
                urgent: true,
              });
              report.statutoryEscalations.push(job.jobId);
            }
            continue;
          }
          job.status = 'cancelled';
          job.waitingFor = null;
          job.lease = null;
          job.failureCode = 'HORIZON_EXPIRED';
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          report.expiredJobs.push(job.jobId);
          continue;
        }

        // 2. Expired running lease (worker crash / zombie)
        if (job.status === 'running' && (!job.lease || nowMs >= Number(job.lease.expiresAtMs))) {
          job.lease = null;
          job.budget.reservedUsd = 0;
          const unreceipted = Object.values(job.effectIntents).some((i) => i.status === 'dispatched' || i.status === 'unknown');
          if (unreceipted) {
            job.status = 'reconciling';
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
            job.revision += 1;
            job.updatedAtMs = nowMs;
            job.updatedAt = new Date(nowMs).toISOString();
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

        // 3. Liveness invariant on waiting jobs: MUST have finite nextReviewAtMs
        if (job.status === 'waiting' && (!job.wake || !Number.isFinite(Number(job.wake.nextReviewAtMs)))) {
          job.status = 'queued';
          job.waitingFor = null;
          job.wake.nextReviewAtMs = nowMs;
          job.wake.nextReviewAt = new Date(nowMs).toISOString();
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          report.repairedOrphans.push(job.jobId);
        }
      }

      // 4. Silent requester handling: Default-Unless-Vetoed & 2-Nudge-1-Park
      for (const ask of state.asks.values()) {
        if (ask.status !== 'open') continue;
        const job = state.jobs.get(ask.jobId);
        if (!job || DURABLE_TERMINAL_STATUSES.has(job.status)) {
          ask.status = 'cancelled';
          continue;
        }
        // Default-Unless-Vetoed (requester asks only; never auto-approve owner escalations!)
        if (ask.targetRole === 'requester' && ask.defaultOption && ask.defaultActionAtMs && nowMs >= ask.defaultActionAtMs) {
          ask.status = 'answered';
          ask.answer = { value: ask.defaultOption, via: 'default_unless_vetoed' };
          ask.answeredBy = 'system:default_unless_vetoed';
          ask.answeredAtMs = nowMs;
          job.eventInbox.push({ type: 'requester_answer', askId: ask.askId, answer: ask.answer, receivedAtMs: nowMs });
          if (job.status === 'waiting') {
            job.status = 'queued';
            job.waitingFor = null;
            job.wake.nextReviewAtMs = nowMs;
            job.wake.nextReviewAt = new Date(nowMs).toISOString();
          }
          job.revision += 1;
          job.updatedAtMs = nowMs;
          job.updatedAt = new Date(nowMs).toISOString();
          report.defaultedAsks.push(ask.askId);
          continue;
        }

        // 2-Nudge-1-Park (respecting quietHours)
        if (ask.nextNudgeAtMs && nowMs >= ask.nextNudgeAtMs) {
          if (isWithinQuietHours(nowMs, quietHours)) {
            ask.nextNudgeAtMs = nextNotificationWindowMs(nowMs, quietHours, { urgent: false });
            continue;
          }
          if (ask.nudgeCount < ask.maxNudges) {
            ask.nudgeCount += 1;
            ask.nextNudgeAtMs = nowMs + ask.nudgeDelaySec * 1000;
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
          } else {
            ask.status = 'paused';
            job.status = 'paused';
            job.waitingFor = null;
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
          }
        }
      }

      return report;
    });
  }

  function getNextDueAtMs() {
    let minMs = null;
    for (const job of state.jobs.values()) {
      if (job.status === 'waiting' && Number.isFinite(Number(job.wake?.nextReviewAtMs))) {
        const ts = Number(job.wake.nextReviewAtMs);
        if (minMs === null || ts < minMs) minMs = ts;
      } else if (job.status === 'running' && Number.isFinite(Number(job.lease?.expiresAtMs))) {
        const ts = Number(job.lease.expiresAtMs);
        if (minMs === null || ts < minMs) minMs = ts;
      }
    }
    return minMs;
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
    markOutboxDelivery(clientMessageId, { deliveryState = 'sent', externalMessageId = null, statusCard = false, nowMs = clock() } = {}) {
      return withFileLock(() => {
        const rec = state.outbox.get(String(clientMessageId || ''));
        if (!rec) return { ok: false, code: 'OUTBOX_NOT_FOUND' };
        rec.deliveryState = deliveryState;
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
