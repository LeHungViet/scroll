// SCROLL 2.18 / 2.19 / 2.20.1 -- sec 59 Autonomy Configuration, 4-Branch Error Dispositions,
// Work Ledger Handoff, Re-Observe First CV/Browser Gate, Morning Digest & Wake Cue Matching.
// Zero-dependency, vendor-neutral, pure ASCII OSS core (Node >= 20).
import { redactTicketText } from './tickets.js';
import {
  DEFAULT_JOB_BUDGET,
  HARD_JOB_BUDGET_CEILING,
  isWithinQuietHours,
} from './durable-jobs.js';

export const AUTONOMY_MODES = Object.freeze(['off', 'ask', 'continue_in_background']);

export const ERROR_DISPOSITIONS = Object.freeze([
  'retry_backoff',
  'park_waiting',
  'feed_llm_repair',
  'abort_job',
]);

export const DEFAULT_AUTONOMY_CONFIG = Object.freeze({
  on_turn_exhausted: 'off',
  mode: 'off',
  recovery_rounds: 2,
  resume_on_restart: true,
  default_horizon_days: DEFAULT_JOB_BUDGET.horizonDays,
  default_max_slices: DEFAULT_JOB_BUDGET.maxSlices,
  default_max_active_minutes: DEFAULT_JOB_BUDGET.maxActiveMinutes,
  default_max_usd_per_job: DEFAULT_JOB_BUDGET.maxUsd,
  quiet_hours: null,
  timezone: 'UTC',
});

const ALLOWED_AUTONOMY_KEYS = new Set([
  'on_turn_exhausted',
  'mode',
  'recovery_rounds',
  'resume_on_restart',
  'default_horizon_days',
  'max_wall_hours',
  'default_max_slices',
  'max_slices',
  'default_max_active_minutes',
  'max_active_minutes',
  'default_max_usd_per_job',
  'max_usd_per_job',
  'quiet_hours',
  'timezone',
]);

export const DEFAULT_GUI_OBSERVE_TOOLS = Object.freeze(new Set([
  'perceive',
  'observe',
  'cua_observe',
  'screenshot',
  'scanPage',
  'a11yTree',
  'elementTree',
  'getPageText',
  'getPageIdentity',
  'browser_observe',
  'browser_screenshot',
]));

export const DEFAULT_GUI_MUTATION_TOOLS = Object.freeze(new Set([
  'do',
  'cua_act',
  'click',
  'type',
  'fill',
  'submit',
  'press',
  'drag',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_fill_secret',
  'browser_submit',
  'gui_click',
  'gui_type',
  'desktop_click',
  'desktop_type',
]));

export function validateAutonomyConfig(raw) {
  const errors = [];
  if (raw === null || raw === undefined) return { ok: true, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['IDENTITY: autonomy must be a mapping/object (sec 59)'] };
  }
  for (const k of Object.keys(raw)) {
    if (!ALLOWED_AUTONOMY_KEYS.has(k)) {
      errors.push(`IDENTITY: unknown autonomy key "${k}" (sec 59)`);
    }
  }
  const rawMode = raw.on_turn_exhausted ?? raw.mode;
  if (rawMode !== undefined && !AUTONOMY_MODES.includes(String(rawMode))) {
    errors.push(`IDENTITY: autonomy mode "${rawMode}" must be one of: ${AUTONOMY_MODES.join(', ')} (sec 59)`);
  }
  if (raw.recovery_rounds !== undefined) {
    const r = Number(raw.recovery_rounds);
    if (!Number.isInteger(r) || r < 0 || r > 5) {
      errors.push('IDENTITY: autonomy.recovery_rounds must be an integer 0..5 (sec 59)');
    }
  }
  if (raw.default_horizon_days !== undefined) {
    const d = Number(raw.default_horizon_days);
    if (!Number.isFinite(d) || d < 1 || d > HARD_JOB_BUDGET_CEILING.horizonDays) {
      errors.push(`IDENTITY: autonomy.default_horizon_days must be 1..${HARD_JOB_BUDGET_CEILING.horizonDays} (sec 59)`);
    }
  }
  if (raw.max_wall_hours !== undefined) {
    const h = Number(raw.max_wall_hours);
    if (!Number.isFinite(h) || h < 1 || h > HARD_JOB_BUDGET_CEILING.horizonDays * 24) {
      errors.push(`IDENTITY: autonomy.max_wall_hours must be 1..${HARD_JOB_BUDGET_CEILING.horizonDays * 24} (sec 59)`);
    }
  }
  const rawSlices = raw.default_max_slices ?? raw.max_slices;
  if (rawSlices !== undefined) {
    const s = Number(rawSlices);
    if (!Number.isInteger(s) || s < 1 || s > HARD_JOB_BUDGET_CEILING.maxSlices) {
      errors.push(`IDENTITY: autonomy.default_max_slices must be 1..${HARD_JOB_BUDGET_CEILING.maxSlices} (sec 59)`);
    }
  }
  const rawActive = raw.default_max_active_minutes ?? raw.max_active_minutes;
  if (rawActive !== undefined) {
    const m = Number(rawActive);
    if (!Number.isFinite(m) || m < 1 || m > HARD_JOB_BUDGET_CEILING.maxActiveMinutes) {
      errors.push(`IDENTITY: autonomy.default_max_active_minutes must be 1..${HARD_JOB_BUDGET_CEILING.maxActiveMinutes} (sec 59)`);
    }
  }
  const rawUsd = raw.default_max_usd_per_job ?? raw.max_usd_per_job;
  if (rawUsd !== undefined) {
    const u = Number(rawUsd);
    if (!Number.isFinite(u) || u <= 0 || u > HARD_JOB_BUDGET_CEILING.maxUsd) {
      errors.push(`IDENTITY: autonomy.max_usd_per_job must be >0 and <=${HARD_JOB_BUDGET_CEILING.maxUsd} (sec 59)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function resolveAutonomyConfig(raw = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AUTONOMY_CONFIG };
  }
  const rawMode = raw.on_turn_exhausted ?? raw.mode ?? 'off';
  const mode = AUTONOMY_MODES.includes(String(rawMode)) ? String(rawMode) : 'off';
  const recovery = Number.isInteger(Number(raw.recovery_rounds))
    ? Math.max(0, Math.min(5, Number(raw.recovery_rounds)))
    : DEFAULT_AUTONOMY_CONFIG.recovery_rounds;
  const horizonFromHours = raw.max_wall_hours !== undefined && Number.isFinite(Number(raw.max_wall_hours))
    ? Math.ceil(Number(raw.max_wall_hours) / 24)
    : null;
  const rawHorizon = raw.default_horizon_days ?? horizonFromHours ?? DEFAULT_JOB_BUDGET.horizonDays;
  const rawSlices = raw.default_max_slices ?? raw.max_slices ?? DEFAULT_JOB_BUDGET.maxSlices;
  const rawActive = raw.default_max_active_minutes ?? raw.max_active_minutes ?? DEFAULT_JOB_BUDGET.maxActiveMinutes;
  const rawUsd = raw.default_max_usd_per_job ?? raw.max_usd_per_job ?? DEFAULT_JOB_BUDGET.maxUsd;

  return {
    on_turn_exhausted: mode,
    mode,
    recovery_rounds: recovery,
    resume_on_restart: raw.resume_on_restart !== false,
    default_horizon_days: Math.max(1, Math.min(HARD_JOB_BUDGET_CEILING.horizonDays, Number(rawHorizon))),
    default_max_slices: Math.max(1, Math.min(HARD_JOB_BUDGET_CEILING.maxSlices, Math.round(Number(rawSlices)))),
    default_max_active_minutes: Math.max(1, Math.min(HARD_JOB_BUDGET_CEILING.maxActiveMinutes, Number(rawActive))),
    default_max_usd_per_job: Math.max(0.01, Math.min(HARD_JOB_BUDGET_CEILING.maxUsd, Number(rawUsd))),
    quiet_hours: raw.quiet_hours || null,
    timezone: String(raw.timezone || 'UTC'),
  };
}

/**
 * Maps any tool error or result into 4 deterministic action dispositions (Council YAGNI):
 *   - `abort_job`       : hard stops (refused, policy denied, budget exceeded, phishing mismatch)
 *   - `park_waiting`    : offline companion (incl. ECONNREFUSED), needs owner approval/step-up, needs requester input
 *   - `retry_backoff`   : transient network, rate limit, timeout
 *   - `feed_llm_repair` : invalid_args, not_found, stale anchor (ERR_REOBSERVE_REQUIRED)
 */
export function classifyToolErrorDisposition(errOrResult) {
  const code = String(errOrResult?.code || errOrResult?.errorCode || '').trim();
  const msg = String(errOrResult?.error || errOrResult?.message || (typeof errOrResult === 'string' ? errOrResult : '')).trim();
  const combined = `${code} ${msg}`;
  const explicitClass = String(errOrResult?.errorClass || '').trim().toLowerCase();

  // 0. Honor explicit structured errorClass first (prevents substring hijacking, C1)
  if (explicitClass === 'budget_exceeded') {
    return { disposition: 'abort_job', errorClass: 'budget_exceeded', retryable: false, parkWaitingFor: null, reason: msg || code };
  }
  if (explicitClass === 'companion_offline') {
    return { disposition: 'park_waiting', errorClass: 'companion_offline', retryable: false, parkWaitingFor: 'companion', reason: msg || code };
  }
  if (explicitClass === 'needs_owner') {
    return { disposition: 'park_waiting', errorClass: 'needs_owner', retryable: false, parkWaitingFor: 'owner_approval', reason: msg || code };
  }
  if (explicitClass === 'needs_requester') {
    return { disposition: 'park_waiting', errorClass: 'needs_requester', retryable: false, parkWaitingFor: 'requester', reason: msg || code };
  }
  if (explicitClass === 'refused') {
    return { disposition: 'abort_job', errorClass: 'refused', retryable: false, parkWaitingFor: null, reason: msg || code };
  }
  if (explicitClass === 'transient') {
    return { disposition: 'retry_backoff', errorClass: 'transient', retryable: true, parkWaitingFor: null, reason: msg || code };
  }

  // 1. Companion offline / sleeping desktop MUST be checked BEFORE generic `refused` (ECONNREFUSED contains REFUSED! C1)
  if (/\b(?:ERR_COMPANION_OFFLINE|ERR_COMPANION_PAUSED|ECONNREFUSED|DEVICE_OFFLINE)\b/i.test(combined)) {
    return { disposition: 'park_waiting', errorClass: 'companion_offline', retryable: false, parkWaitingFor: 'companion', reason: msg || code };
  }

  // 2. Hard stops -> NEVER retry automatically!
  if (/\b(?:BUDGET_EXCEEDED|MAX_USD_REACHED|DAILY_USD_CAP|MAX_SLICES_REACHED)\b/i.test(combined)) {
    return { disposition: 'abort_job', errorClass: 'budget_exceeded', retryable: false, parkWaitingFor: null, reason: msg || code };
  }
  if (
    /\b(?:REFUSED|DENIED|FORBIDDEN|SECRET_DESTINATION_MISMATCH|ERR_SECRET_FORBIDDEN(?:_IN_GROUP)?|ERR_GROUP_ORIGIN_FORBIDDEN|ERR_PATH_OUTSIDE_SANDBOX|ERR_TOOL_NOT_ALLOWLISTED|ERR_LOCAL_APPROVAL_DENIED|AGENT_CANNOT_SELF_APPROVE|AGENT_CANNOT_ANSWER|SPEC_HASH_MISMATCH|AUTHORITY_REVOKED)\b/i.test(combined)
    || errOrResult?.status === 'denied'
  ) {
    return { disposition: 'abort_job', errorClass: 'refused', retryable: false, parkWaitingFor: null, reason: msg || code };
  }

  // 3. Park waiting (owner step-up/approval, requester business input) (C8)
  if (/\b(?:NEEDS_OWNER|OWNER_APPROVAL_REQUIRED|ERR_LOCAL_APPROVAL_REQUIRED|(?:ERR_)?STEP_UP_(?:[A-Z_]+_)?REQUIRED|APPROVAL_GRANT_REQUIRED|REAPPROVAL_REQUIRED|CAPTCHA)\b/i.test(combined)) {
    return { disposition: 'park_waiting', errorClass: 'needs_owner', retryable: false, parkWaitingFor: 'owner_approval', reason: msg || code };
  }
  if (/\b(?:NEEDS_REQUESTER|MISSING_BUSINESS_INPUT)\b/i.test(combined)) {
    return { disposition: 'park_waiting', errorClass: 'needs_requester', retryable: false, parkWaitingFor: 'requester', reason: msg || code };
  }

  // 4. Transient retryable errors
  if (/\b(?:429|502|503|504|RATE_LIMIT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ERR_REMOTE_TOOL_TIMEOUT|TRANSIENT)\b/i.test(combined)) {
    return { disposition: 'retry_backoff', errorClass: 'transient', retryable: true, parkWaitingFor: null, reason: msg || code };
  }

  // 5. LLM-repairable errors (invalid args, missing resource, stale UI anchors)
  if (/\b(?:ERR_REOBSERVE_REQUIRED|STALE_ELEMENT|TAB_NOT_FOUND)\b/i.test(combined)) {
    return { disposition: 'feed_llm_repair', errorClass: 'stale_anchor', retryable: true, parkWaitingFor: null, reason: msg || code };
  }
  if (/\b(?:INVALID_ARG|VALIDATION|SCHEMA|MISSING_REQUIRED|REQUIRED_ARG|REQUIRED_FIELD|BAD_REQUEST|400)\b/i.test(combined) || explicitClass === 'invalid_args') {
    return { disposition: 'feed_llm_repair', errorClass: 'invalid_args', retryable: true, parkWaitingFor: null, reason: msg || code };
  }
  if (/\b(?:NOT_FOUND|404|ENOENT)\b/i.test(combined) || explicitClass === 'not_found') {
    return { disposition: 'feed_llm_repair', errorClass: 'not_found', retryable: true, parkWaitingFor: null, reason: msg || code };
  }

  // Default: feed back to LLM within recovery_rounds budget
  return { disposition: 'feed_llm_repair', errorClass: 'failed', retryable: true, parkWaitingFor: null, reason: msg || code || 'unknown_tool_error' };
}

/**
 * Builds a bounded continuation work ledger (<= 25 lines) with line 0 permanently locked
 * to `[GOAL] <immutableGoal>` so multi-day continuations never drift from the original objective.
 */
export function buildContinuationWorkLedger({
  immutableGoal,
  doneCriteria = [],
  toolTraces = [],
  attachments = [],
  existingLines = [],
  maxLines = 25,
} = {}) {
  const cap = Math.max(3, Math.min(25, Number(maxLines || 25)));
  const goalLine = `[GOAL] ${redactTicketText(String(immutableGoal || '').trim(), 240)}`;
  const body = [];

  if (Array.isArray(doneCriteria) && doneCriteria.length > 0) {
    body.push(`[CRITERIA] ${doneCriteria.map((c) => redactTicketText(c, 80)).join('; ')}`);
  }

  for (const ln of Array.isArray(existingLines) ? existingLines : []) {
    const clean = String(ln || '').trim();
    if (!clean || clean.startsWith('[GOAL]') || clean.startsWith('[CRITERIA]')) continue;
    body.push(redactTicketText(clean, 220));
  }

  for (const tr of Array.isArray(toolTraces) ? toolTraces : []) {
    const name = tr?.name || 'tool';
    const resObj = tr?.result && typeof tr.result === 'object' ? tr.result : null;
    const isErr = tr?.ok === false || resObj?.ok === false || Boolean(resObj?.error);
    const status = isErr ? 'error' : (resObj?.status || tr?.status || 'ok');
    const note = resObj?.error || resObj?.reason || tr?.summary || tr?.error || '';
    body.push(`[TOOL] ${name}: ${status}${note ? ` -- ${redactTicketText(note, 140)}` : ''}`);
  }

  for (const att of Array.isArray(attachments) ? attachments : []) {
    if (!att) continue;
    const id = att.mediaId || att.id || att.fileRef || 'artifact';
    const name = att.filename || att.name || 'file';
    body.push(`[ARTIFACT] ${id}: ${redactTicketText(name, 100)}`);
  }

  // Preserve line 0 forever; keep most recent progress lines within `cap`
  const tail = body.slice(-(cap - 1));
  return [goalLine, ...tail];
}

/**
 * sec 62b: Deterministic Re-Observe First gate for multi-day CV & Browser tasks.
 * After any sleep/gap > `staleAfterMs` (default 5 min) or after a slice wake (`lastWokeAtMs`),
 * mutating GUI/browser actions are BLOCKED until an observation call has occurred post-wake.
 */
export function validateReObserveBeforeGuiAction({
  checkpoint = null,
  toolName = '',
  args = {},
  guiMutationTools = DEFAULT_GUI_MUTATION_TOOLS,
  nowMs = Date.now(),
  staleAfterMs = 5 * 60 * 1000,
} = {}) {
  const name = String(toolName || '').trim();
  const isMutation = guiMutationTools instanceof Set
    ? guiMutationTools.has(name)
    : (Array.isArray(guiMutationTools) ? guiMutationTools.includes(name) : DEFAULT_GUI_MUTATION_TOOLS.has(name));

  if (!isMutation) {
    return { allowed: true, code: 'NOT_GUI_MUTATION' };
  }

  const cp = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
  const hasRawObs = cp.lastObservedAtMs !== null && cp.lastObservedAtMs !== undefined;
  const lastObservedAtMs = hasRawObs ? Number(cp.lastObservedAtMs) : null;
  const lastWokeAtMs = cp.lastWokeAtMs != null && Number.isFinite(Number(cp.lastWokeAtMs)) ? Number(cp.lastWokeAtMs) : null;
  const usesVolatileHandle = Boolean(
    args && typeof args === 'object' && (
      args.tabId !== undefined || args.element_index !== undefined || args.ref !== undefined
      || args.x !== undefined || args.y !== undefined || args.selector !== undefined
    ),
  );

  // Reject non-finite or suspicious future timestamps (P2)
  if (hasRawObs && (!Number.isFinite(lastObservedAtMs) || lastObservedAtMs > nowMs + 5000)) {
    return {
      allowed: false,
      code: 'ERR_REOBSERVE_REQUIRED',
      reason: `UI observation timestamp is invalid or in the future; re-observe before ${name}.`,
      reacquireAnchors: cp.reacquireAnchors || null,
    };
  }

  // Never observed at all on a resumed/checkpointed slice
  if (lastObservedAtMs === null) {
    if (lastWokeAtMs !== null || usesVolatileHandle) {
      return {
        allowed: false,
        code: 'ERR_REOBSERVE_REQUIRED',
        reason: `Must run an observe/perceive tool to re-ground UI anchors before mutating via ${name}.`,
        reacquireAnchors: cp.reacquireAnchors || null,
      };
    }
    return { allowed: true, code: 'FRESH_TURN' };
  }

  // Woke up after sleep/restart and has NOT re-observed since waking
  if (lastWokeAtMs !== null && lastObservedAtMs < lastWokeAtMs) {
    const gapMs = Math.max(0, lastWokeAtMs - lastObservedAtMs);
    if (gapMs >= staleAfterMs || usesVolatileHandle) {
      return {
        allowed: false,
        code: 'ERR_REOBSERVE_REQUIRED',
        reason: `UI observation predates wake by ${Math.round(gapMs / 1000)}s; re-observe from reacquireAnchors before calling ${name}.`,
        reacquireAnchors: cp.reacquireAnchors || null,
      };
    }
  }

  // Observation itself is stale (> staleAfterMs old)
  if ((nowMs - lastObservedAtMs) > staleAfterMs) {
    return {
      allowed: false,
      code: 'ERR_REOBSERVE_REQUIRED',
      reason: `UI observation is stale (${Math.round((nowMs - lastObservedAtMs) / 1000)}s old > ${Math.round(staleAfterMs / 1000)}s); re-observe before ${name}.`,
      reacquireAnchors: cp.reacquireAnchors || null,
    };
  }

  return { allowed: true, code: 'OK' };
}

export function isGuiObserveTool(toolName, observeTools = DEFAULT_GUI_OBSERVE_TOOLS) {
  const name = String(toolName || '').trim();
  return observeTools instanceof Set
    ? observeTools.has(name)
    : (Array.isArray(observeTools) ? observeTools.includes(name) : DEFAULT_GUI_OBSERVE_TOOLS.has(name));
}

/**
 * SCROLL 2.19 / 2.20.1 -- Batches all quiet Marathon jobs (> 24h without status change) per room
 * into ONE concise Morning Digest outside `quietHours` (zero multi-message spam, fail-closed room scope).
 */
export function buildMorningDigest({
  jobs = [],
  chatId = null,
  isGroup = null,
  nowMs = Date.now(),
  quietHours = null,
  minQuietAgeMs = 24 * 60 * 60 * 1000,
} = {}) {
  const cleanChat = chatId != null ? String(chatId).trim() : '';
  if (!cleanChat) {
    return { shouldSend: false, reason: 'chat_id_required', items: [], text: '' };
  }
  if (isWithinQuietHours(nowMs, quietHours)) {
    return { shouldSend: false, reason: 'quiet_hours_active', items: [], text: '' };
  }
  const eligible = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || j.status !== 'waiting') return false;
    if (String(j.audienceRoom?.chatId || '').trim() !== cleanChat) return false;
    const ageMs = nowMs - Number(j.createdAtMs || nowMs);
    const lastPush = Number(j.lastProgressPushAtMs || j.createdAtMs || 0);
    return ageMs >= minQuietAgeMs && (nowMs - lastPush) >= minQuietAgeMs;
  });

  if (eligible.length === 0) {
    return { shouldSend: false, reason: 'no_eligible_marathon_jobs', items: [], text: '' };
  }

  const items = eligible.map((j) => {
    const dayNum = Math.max(1, Math.ceil((nowMs - Number(j.createdAtMs || nowMs)) / (24 * 60 * 60 * 1000)));
    const horizon = Number(j.budget?.horizonDays || DEFAULT_JOB_BUDGET.horizonDays);
    const groupRoom = isGroup !== null ? Boolean(isGroup) : Boolean(j.audienceRoom?.isGroup);
    const isAdminWait = j.waitingFor === 'owner_approval' || j.waitingFor === 'authority';
    const safeWaitingFor = (groupRoom && isAdminWait) ? 'owner_approval_neutral' : j.waitingFor;
    const safeMilestone = (groupRoom && isAdminWait)
      ? 'awaiting administrator authorization'
      : redactTicketText(j.checkpoint?.milestone || 'monitoring', 100);
    return {
      jobId: j.jobId,
      goal: redactTicketText(j.checkpoint?.immutableGoal || '', 100),
      milestone: safeMilestone,
      day: dayNum,
      horizonDays: horizon,
      waitingFor: safeWaitingFor,
      nextReviewAt: j.wake?.nextReviewAt || null,
    };
  });

  const lines = [
    `Active long-running tasks digest (${items.length}):`,
    ...items.map((it, idx) => `${idx + 1}. ${it.goal} -- Day ${it.day}/${it.horizonDays} (${it.milestone})`),
  ];

  return {
    shouldSend: true,
    reason: 'ok',
    count: items.length,
    items,
    text: lines.join('\n'),
  };
}

function foldCueText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0110\u0111]/g, 'd')
    .toLowerCase()
    .trim();
}

function escapeRe(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HANDOFF_DONE_CUE_RE = /\b(?:done|paid|verified|completed|approved|confirmed|submitted|xong|da\s+xong|da\s+thanh\s+toan|da\s+duyet|ok\s+roi)\b/i;

function matchesApproverOnJob(job, cleanSender) {
  if (!cleanSender || !job?.principals?.approver) return false;
  const ap = job.principals.approver;
  if (typeof ap === 'string') return cleanSender === ap.trim();
  if (typeof ap === 'object') {
    return (ap.principalId && cleanSender === String(ap.principalId).trim())
      || (ap.externalId && cleanSender === String(ap.externalId).trim());
  }
  return false;
}

/**
 * SCROLL 2.19 / 2.20.1 -- Candidate-Only Natural Language Wake Cue Matcher.
 * Fail-closed when `chatId` or `senderId` is omitted; supports Owner DM replies to escalations,
 * paused asks, designated approvers, Vietnamese NFD keywords, and word-bounded option IDs.
 */
export function matchWakeCueCandidates({
  text = '',
  senderId = null,
  chatId = null,
  replyToMessageId = null,
  openAsks = [],
  jobs = [],
} = {}) {
  const cleanText = foldCueText(text);
  const cleanSender = senderId != null ? String(senderId).trim() : '';
  const cleanChat = chatId != null ? String(chatId).trim() : '';
  const cleanReply = replyToMessageId != null ? String(replyToMessageId).trim() : '';

  // Fail closed without verified room & sender context (H12)
  if (!cleanChat || !cleanSender) {
    return { candidates: [], ambiguous: false, topCandidate: null };
  }

  const candidates = [];
  const jobMap = new Map((Array.isArray(jobs) ? jobs : []).filter((j) => j?.jobId).map((j) => [j.jobId, j]));

  for (const ask of Array.isArray(openAsks) ? openAsks : []) {
    // Accept both `open` and `paused` (2-Nudge-1-Park) asks (C3)
    if (!ask || (ask.status !== 'open' && ask.status !== 'paused')) continue;
    const job = jobMap.get(ask.jobId);
    if (!job) continue;

    // Authority filter FIRST: strangers NEVER become valid wake candidates!
    const owners = new Set((job.principals?.ownerIds || []).map(String));
    const isOwner = owners.has(cleanSender);
    const isApprover = !isOwner && matchesApproverOnJob(job, cleanSender);
    const isRecipient = cleanSender === String(ask.recipientPrincipalId || '')
      || (ask.recipientExternalId && cleanSender === String(ask.recipientExternalId));

    if (ask.targetRole === 'owner' && !isOwner && !isApprover) continue;
    if (ask.targetRole === 'requester' && !isRecipient && !isOwner && !isApprover) continue;

    // Room check: allow Owner/Approver DM reply (`chatId === senderId` or `'owner_dm'`) for owner escalations (C9)
    const jobChat = String(job.audienceRoom?.chatId || '').trim();
    const isOwnerDmReply = ask.targetRole === 'owner' && (isOwner || isApprover) && (cleanChat === cleanSender || cleanChat === 'owner_dm');
    if (!isOwnerDmReply && (!jobChat || jobChat !== cleanChat)) continue;

    let score = 0;
    const reasons = [];
    if (cleanReply && (cleanReply === String(job.statusCardMessageId || '') || cleanReply === String(ask.externalMessageId || ''))) {
      score += 0.9;
      reasons.push('direct_reply_to_ask_or_card');
    }
    if (cleanText.includes(String(ask.askId).toLowerCase()) || cleanText.includes(String(job.jobId).toLowerCase())) {
      score += 0.8;
      reasons.push('explicit_id_reference');
    }

    // Option label or id match (word-bounded for short option IDs to prevent 'a'/'1' false positives, C9)
    for (const opt of Array.isArray(ask.options) ? ask.options : []) {
      const id = foldCueText(opt?.id || '');
      const label = foldCueText(opt?.label || '');
      const idMatched = id && (
        id.length <= 3
          ? new RegExp(`(?:^|[^a-z0-9])${escapeRe(id)}(?:$|[^a-z0-9])`).test(cleanText)
          : cleanText.includes(id)
      );
      const labelMatched = label && label.length >= 3 && cleanText.includes(label);
      if (idMatched || labelMatched) {
        score += 0.5;
        reasons.push(`option_match:${id || label}`);
        break;
      }
    }

    // Keyword overlap with NFD-folded question (works for Vietnamese + English, C9)
    const qWords = foldCueText(ask.question || '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    const hits = qWords.filter((w) => cleanText.includes(w)).length;
    if (hits >= 2) {
      score += Math.min(0.4, hits * 0.12);
      reasons.push(`lexical_overlap:${hits}`);
    }

    // Standalone handoff confirmation cue ("done", "paid", "xong") -> candidate only (<0.75, requiresConfirmation: true)
    if (score === 0 && HANDOFF_DONE_CUE_RE.test(cleanText)) {
      score += 0.55;
      reasons.push('handoff_cue_candidate');
    }

    if (score > 0) {
      candidates.push({
        kind: 'ask_answer_candidate',
        askId: ask.askId,
        jobId: ask.jobId,
        intentRev: ask.intentRev,
        authorizedActor: cleanSender,
        score: +Math.min(1, score).toFixed(3),
        reasons,
        requiresConfirmation: score < 0.75,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const ambiguous = candidates.length >= 2 && Math.abs(candidates[0].score - candidates[1].score) < 0.2;
  return {
    candidates,
    ambiguous,
    topCandidate: !ambiguous && candidates.length > 0 && !candidates[0].requiresConfirmation ? candidates[0] : null,
  };
}

/**
 * SCROLL 2.19 -- Deterministic cadence, fairness, and reliability metrics snapshot
 * over active durable jobs, outbox records, and Fair-Share physical resource stats.
 */
export function computeDurableJobMetrics({
  jobs = [],
  outbox = [],
  fairShareStats = null,
  nowMs = Date.now(),
} = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const byStatus = {};
  const byTempo = { micro: 0, sprint: 0, marathon: 0 };
  let zeroLlmProbesSaved = 0;
  let totalActiveMinutes = 0;
  let totalUsd = 0;
  let oldestQueuedAgeMs = 0;

  for (const j of list) {
    if (!j) continue;
    byStatus[j.status] = (byStatus[j.status] || 0) + 1;
    if (j.tempoTier && byTempo[j.tempoTier] !== undefined) byTempo[j.tempoTier] += 1;
    zeroLlmProbesSaved += Math.max(0, Number(j.wake?.negativeProbes || 0));
    totalActiveMinutes += Math.max(0, Number(j.budget?.usedActiveMinutes || 0));
    totalUsd += Math.max(0, Number(j.budget?.usedUsd || 0));
    if (j.status === 'queued' && Number.isFinite(Number(j.wake?.nextReviewAtMs))) {
      oldestQueuedAgeMs = Math.max(oldestQueuedAgeMs, Math.max(0, nowMs - Number(j.wake.nextReviewAtMs)));
    }
  }

  const outList = Array.isArray(outbox) ? outbox : [];
  const outboxUnknownCount = outList.filter((o) => o?.deliveryState === 'delivery_unknown').length;
  const outboxPendingCount = outList.filter((o) => o?.deliveryState === 'pending').length;

  return {
    totalJobs: list.length,
    byStatus,
    byTempo,
    zeroLlmProbesSaved,
    totalActiveMinutes: +totalActiveMinutes.toFixed(2),
    totalUsd: +totalUsd.toFixed(4),
    reconcilingCount: byStatus.reconciling || 0,
    oldestQueuedAgeMs,
    oldestEligibleAgeMs: Math.max(oldestQueuedAgeMs, Number(fairShareStats?.oldestEligibleAgeMs || 0)),
    outboxPendingCount,
    outboxUnknownCount,
    fairShare: fairShareStats || null,
  };
}
