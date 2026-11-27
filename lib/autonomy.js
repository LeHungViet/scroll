// SCROLL 2.18 / 2.19 -- sec 59 Autonomy Configuration, 4-Branch Error Dispositions,
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
  recovery_rounds: 2,
  resume_on_restart: true,
  default_horizon_days: DEFAULT_JOB_BUDGET.horizonDays,
  default_max_slices: DEFAULT_JOB_BUDGET.maxSlices,
  default_max_active_minutes: DEFAULT_JOB_BUDGET.maxActiveMinutes,
  quiet_hours: null,
  timezone: 'UTC',
});

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
]));

export function validateAutonomyConfig(raw) {
  const errors = [];
  if (raw === null || raw === undefined) return { ok: true, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['IDENTITY: autonomy must be a mapping/object (§59)'] };
  }
  if (raw.on_turn_exhausted !== undefined && !AUTONOMY_MODES.includes(String(raw.on_turn_exhausted))) {
    errors.push(`IDENTITY: autonomy.on_turn_exhausted "${raw.on_turn_exhausted}" must be one of: ${AUTONOMY_MODES.join(', ')} (§59)`);
  }
  if (raw.recovery_rounds !== undefined) {
    const r = Number(raw.recovery_rounds);
    if (!Number.isInteger(r) || r < 0 || r > 5) {
      errors.push('IDENTITY: autonomy.recovery_rounds must be an integer 0..5 (§59)');
    }
  }
  if (raw.default_horizon_days !== undefined) {
    const d = Number(raw.default_horizon_days);
    if (!Number.isFinite(d) || d < 1 || d > HARD_JOB_BUDGET_CEILING.horizonDays) {
      errors.push(`IDENTITY: autonomy.default_horizon_days must be 1..${HARD_JOB_BUDGET_CEILING.horizonDays} (§59)`);
    }
  }
  if (raw.default_max_slices !== undefined) {
    const s = Number(raw.default_max_slices);
    if (!Number.isInteger(s) || s < 1 || s > HARD_JOB_BUDGET_CEILING.maxSlices) {
      errors.push(`IDENTITY: autonomy.default_max_slices must be 1..${HARD_JOB_BUDGET_CEILING.maxSlices} (§59)`);
    }
  }
  if (raw.default_max_active_minutes !== undefined) {
    const m = Number(raw.default_max_active_minutes);
    if (!Number.isFinite(m) || m < 1 || m > HARD_JOB_BUDGET_CEILING.maxActiveMinutes) {
      errors.push(`IDENTITY: autonomy.default_max_active_minutes must be 1..${HARD_JOB_BUDGET_CEILING.maxActiveMinutes} (§59)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function resolveAutonomyConfig(raw = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AUTONOMY_CONFIG };
  }
  const mode = AUTONOMY_MODES.includes(String(raw.on_turn_exhausted || 'off'))
    ? String(raw.on_turn_exhausted || 'off')
    : 'off';
  const recovery = Number.isInteger(Number(raw.recovery_rounds))
    ? Math.max(0, Math.min(5, Number(raw.recovery_rounds)))
    : DEFAULT_AUTONOMY_CONFIG.recovery_rounds;
  return {
    on_turn_exhausted: mode,
    recovery_rounds: recovery,
    resume_on_restart: raw.resume_on_restart !== false,
    default_horizon_days: Math.max(1, Math.min(HARD_JOB_BUDGET_CEILING.horizonDays, Number(raw.default_horizon_days || DEFAULT_JOB_BUDGET.horizonDays))),
    default_max_slices: Math.max(1, Math.min(HARD_JOB_BUDGET_CEILING.maxSlices, Math.round(Number(raw.default_max_slices || DEFAULT_JOB_BUDGET.maxSlices)))),
    default_max_active_minutes: Math.max(1, Math.min(HARD_JOB_BUDGET_CEILING.maxActiveMinutes, Number(raw.default_max_active_minutes || DEFAULT_JOB_BUDGET.maxActiveMinutes))),
    quiet_hours: raw.quiet_hours || null,
    timezone: String(raw.timezone || 'UTC'),
  };
}

/**
 * Maps any tool error or result into 4 deterministic action dispositions (Council YAGNI):
 *   - `abort_job`       : hard stops (refused, policy denied, budget exceeded, phishing mismatch)
 *   - `park_waiting`    : offline companion, needs owner approval, needs requester input
 *   - `retry_backoff`   : transient network, rate limit, timeout
 *   - `feed_llm_repair` : invalid_args, not_found, stale anchor (ERR_REOBSERVE_REQUIRED)
 */
export function classifyToolErrorDisposition(errOrResult) {
  const code = String(errOrResult?.code || errOrResult?.errorCode || '').trim();
  const msg = String(errOrResult?.error || errOrResult?.message || (typeof errOrResult === 'string' ? errOrResult : '')).trim();
  const combined = `${code} ${msg}`;

  // 1. Hard stops -> NEVER retry automatically!
  if (
    /BUDGET_EXCEEDED|MAX_USD_REACHED|DAILY_USD_CAP|MAX_SLICES_REACHED/i.test(combined)
  ) {
    return { disposition: 'abort_job', errorClass: 'budget_exceeded', retryable: false, parkWaitingFor: null, reason: msg || code };
  }
  if (
    /REFUSED|DENIED|FORBIDDEN|SECRET_DESTINATION_MISMATCH|ERR_SECRET_FORBIDDEN|ERR_GROUP_ORIGIN_FORBIDDEN|ERR_PATH_OUTSIDE_SANDBOX|ERR_TOOL_NOT_ALLOWLISTED|ERR_LOCAL_APPROVAL_DENIED|AGENT_CANNOT_SELF_APPROVE|AGENT_CANNOT_ANSWER|SPEC_HASH_MISMATCH|AUTHORITY_REVOKED/i.test(combined)
    || errOrResult?.status === 'denied'
    || errOrResult?.errorClass === 'refused'
  ) {
    return { disposition: 'abort_job', errorClass: 'refused', retryable: false, parkWaitingFor: null, reason: msg || code };
  }

  // 2. Park waiting (external/human/device dependencies)
  if (/ERR_COMPANION_OFFLINE|ERR_COMPANION_PAUSED|ECONNREFUSED|DEVICE_OFFLINE/i.test(combined) || errOrResult?.errorClass === 'companion_offline') {
    return { disposition: 'park_waiting', errorClass: 'companion_offline', retryable: false, parkWaitingFor: 'companion', reason: msg || code };
  }
  if (/NEEDS_OWNER|OWNER_APPROVAL_REQUIRED|ERR_LOCAL_APPROVAL_REQUIRED|CAPTCHA/i.test(combined) || errOrResult?.errorClass === 'needs_owner') {
    return { disposition: 'park_waiting', errorClass: 'needs_owner', retryable: false, parkWaitingFor: 'owner_approval', reason: msg || code };
  }
  if (/NEEDS_REQUESTER|MISSING_BUSINESS_INPUT/i.test(combined) || errOrResult?.errorClass === 'needs_requester') {
    return { disposition: 'park_waiting', errorClass: 'needs_requester', retryable: false, parkWaitingFor: 'requester', reason: msg || code };
  }

  // 3. Transient retryable errors
  if (/429|502|503|504|RATE_LIMIT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ERR_REMOTE_TOOL_TIMEOUT|TRANSIENT/i.test(combined) || errOrResult?.errorClass === 'transient') {
    return { disposition: 'retry_backoff', errorClass: 'transient', retryable: true, parkWaitingFor: null, reason: msg || code };
  }

  // 4. LLM-repairable errors (invalid args, missing resource, stale UI anchors)
  if (/ERR_REOBSERVE_REQUIRED|STALE_ELEMENT|TAB_NOT_FOUND/i.test(combined)) {
    return { disposition: 'feed_llm_repair', errorClass: 'stale_anchor', retryable: true, parkWaitingFor: null, reason: msg || code };
  }
  if (/INVALID_ARG|VALIDATION|SCHEMA|REQUIRED|BAD_REQUEST|400/i.test(combined) || errOrResult?.errorClass === 'invalid_args') {
    return { disposition: 'feed_llm_repair', errorClass: 'invalid_args', retryable: true, parkWaitingFor: null, reason: msg || code };
  }
  if (/NOT_FOUND|404|ENOENT/i.test(combined) || errOrResult?.errorClass === 'not_found') {
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
    const status = tr?.ok === false ? 'error' : (tr?.status || 'ok');
    const note = tr?.summary || tr?.error || '';
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
  const lastObservedAtMs = cp.lastObservedAtMs != null ? Number(cp.lastObservedAtMs) : null;
  const lastWokeAtMs = cp.lastWokeAtMs != null ? Number(cp.lastWokeAtMs) : null;
  const usesVolatileHandle = Boolean(
    args && typeof args === 'object' && (
      args.tabId !== undefined || args.element_index !== undefined || args.ref !== undefined
      || args.x !== undefined || args.y !== undefined || args.selector !== undefined
    ),
  );

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
 * SCROLL 2.19 -- Batches all quiet Marathon jobs (> 24h without status change) per room
 * into ONE concise Morning Digest outside `quietHours` (zero multi-message spam).
 */
export function buildMorningDigest({
  jobs = [],
  chatId = null,
  nowMs = Date.now(),
  quietHours = null,
  minQuietAgeMs = 24 * 60 * 60 * 1000,
} = {}) {
  if (isWithinQuietHours(nowMs, quietHours)) {
    return { shouldSend: false, reason: 'quiet_hours_active', items: [], text: '' };
  }
  const eligible = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || j.status !== 'waiting') return false;
    if (chatId != null && String(j.audienceRoom?.chatId || '') !== String(chatId)) return false;
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
    return {
      jobId: j.jobId,
      goal: redactTicketText(j.checkpoint?.immutableGoal || '', 100),
      milestone: j.checkpoint?.milestone || j.waitingFor || 'monitoring',
      day: dayNum,
      horizonDays: horizon,
      waitingFor: j.waitingFor === 'owner_approval' ? 'owner_approval_neutral' : j.waitingFor,
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

/**
 * SCROLL 2.19 -- Candidate-Only Natural Language Wake Cue Matcher.
 * IMPORTANT (Council D8 / Astra + Carbon): Wake cues ONLY rank candidates; they NEVER
 * directly answer an ask or steer a job without deterministic `senderId`, `askId`/`jobId`,
 * and `intentRev` authority verification!
 */
export function matchWakeCueCandidates({
  text = '',
  senderId = null,
  chatId = null,
  replyToMessageId = null,
  openAsks = [],
  jobs = [],
} = {}) {
  const cleanText = String(text || '').trim().toLowerCase();
  const cleanSender = senderId != null ? String(senderId).trim() : '';
  const cleanChat = chatId != null ? String(chatId).trim() : '';
  const cleanReply = replyToMessageId != null ? String(replyToMessageId).trim() : '';
  const candidates = [];

  const jobMap = new Map((Array.isArray(jobs) ? jobs : []).filter((j) => j?.jobId).map((j) => [j.jobId, j]));

  for (const ask of Array.isArray(openAsks) ? openAsks : []) {
    if (!ask || ask.status !== 'open') continue;
    const job = jobMap.get(ask.jobId);
    if (!job) continue;
    if (cleanChat && job.audienceRoom?.chatId && String(job.audienceRoom.chatId) !== cleanChat) continue;

    // Authority filter FIRST: strangers NEVER become valid wake candidates!
    const owners = new Set((job.principals?.ownerIds || []).map(String));
    const isOwner = cleanSender && owners.has(cleanSender);
    const isRecipient = cleanSender && (
      cleanSender === String(ask.recipientPrincipalId || '')
      || (ask.recipientExternalId && cleanSender === String(ask.recipientExternalId))
    );
    if (ask.targetRole === 'owner' && !isOwner) continue;
    if (ask.targetRole === 'requester' && !isRecipient && !isOwner) continue;

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
    // Option label or id match
    for (const opt of Array.isArray(ask.options) ? ask.options : []) {
      const id = String(opt?.id || '').toLowerCase();
      const label = String(opt?.label || '').toLowerCase();
      if ((id && cleanText.includes(id)) || (label && label.length >= 3 && cleanText.includes(label))) {
        score += 0.5;
        reasons.push(`option_match:${id || label}`);
        break;
      }
    }
    // Keyword overlap with question
    const qWords = String(ask.question || '').toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
    const hits = qWords.filter((w) => cleanText.includes(w)).length;
    if (hits >= 2) {
      score += Math.min(0.4, hits * 0.12);
      reasons.push(`lexical_overlap:${hits}`);
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
  // Ambiguity guard: if >=2 open asks for the same authorized actor match closely, force disambiguation!
  const ambiguous = candidates.length >= 2 && Math.abs(candidates[0].score - candidates[1].score) < 0.2;
  return {
    candidates,
    ambiguous,
    topCandidate: !ambiguous && candidates.length > 0 && !candidates[0].requiresConfirmation ? candidates[0] : null,
  };
}
