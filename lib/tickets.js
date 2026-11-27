// SCROLL 2.13 -- Universal Agent Ticket & Approval Queue Protocol (`scroll-ticket/v1`).
// Zero-dependency, vendor-neutral, pure ASCII OSS core.
//
// Responsibilities owned by SCROLL:
//   1. Canonical ticket contract (`scroll-ticket/v1`): 4 kinds, 6 statuses, 4 priorities.
//   2. Secret redaction before any ticket payload or receipt is persisted.
//   3. 24-hour idempotency key derivation to prevent duplicate pending cards.
//   4. Machine-enforced state transition & approval authority gate (never delegated to LLM prose).
//   5. Strict audience projection so public/group callers never see DM notes or other groups' tickets.
//   6. Generic owner-presence group action gate (`evaluateGroupOwnerActionGate`).
//   7. Canonical 4-tool schema (`ticket_create`, `ticket_update`, `ticket_list`, `ticket_transition`)
//      plus a lightweight file-backed reference store for standalone hosts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TICKET_SCHEMA = 'scroll-ticket/v1';

export const TICKET_KINDS = Object.freeze([
  'action_approval',
  'handoff',
  'bug_feedback',
  'follow_up',
]);

export const TICKET_STATUSES = Object.freeze([
  'open',
  'awaiting_approval',
  'in_progress',
  'done',
  'rejected',
  'expired',
]);

export const TICKET_PRIORITIES = Object.freeze([
  'low',
  'normal',
  'high',
  'urgent',
]);

export const TICKET_APPROVER_ROLES = Object.freeze([
  'owner',
  'admin',
  'any_member',
]);

export const TICKET_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const TICKET_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// SCROLL 2.16 -- Post-approval execution modes & bounded continuation caps.
export const TICKET_EXECUTION_MODES = Object.freeze([
  'mcp_tool',
  'agent_turn',
  'manual',
]);
export const TICKET_DEFAULT_MAX_CONTINUATIONS = 12;
export const TICKET_MAX_CONTINUATIONS_LIMIT = 24;
export const TICKET_MIN_RECHECK_SEC = 10;
export const TICKET_MAX_RECHECK_SEC = 600;
export const TICKET_WAIT_MAX_SEC = 45;
export const TICKET_MAX_EXECUTION_MS = 45 * 60 * 1000;
export const TICKET_MAX_CONSECUTIVE_ERRORS = 3;
export const TICKET_EXECUTION_OWNERS = Object.freeze(['legacy', 'durable']);

function canonicalizeForHash(value, seen = new Set()) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => canonicalizeForHash(v, seen));
    const out = Object.create(null);
    for (const k of Object.keys(value).sort()) {
      Object.defineProperty(out, k, {
        value: canonicalizeForHash(value[k], seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Deterministic SHA-256 digest of a ticket's executable `actionSpec` (SCROLL 2.16.1 / 2.20.1).
 * Hashes raw canonical null-prototype structure without truncation or redaction collisions.
 */
export function computeTicketSpecHash(actionSpec) {
  if (!actionSpec || typeof actionSpec !== 'object') return null;
  const canonical = JSON.stringify(canonicalizeForHash(actionSpec));
  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Strips or detects forbidden internal keys (`_*`, such as `_execution`, `_internal`) in caller patches.
 * Prevents untrusted `ticket_update(payloadPatch)` calls from tampering with runtime budget state.
 */
export function findForbiddenInternalKeys(value, prefix = '', out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => findForbiddenInternalKeys(item, `${prefix}[${idx}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (String(k).startsWith('_')) {
      out.push(full);
    } else if (v && typeof v === 'object') {
      findForbiddenInternalKeys(v, full, out);
    }
  }
  return out;
}

export function sanitizeTicketPayloadPatch(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => sanitizeTicketPayloadPatch(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (String(k).startsWith('_')) continue;
      out[k] = sanitizeTicketPayloadPatch(v, depth + 1);
    }
    return redactTicketPayload(out);
  }
  return redactTicketPayload(value);
}

/**
 * Machine-enforced guard for `ticket_update` (SCROLL 2.16.1).
 * Enforces room/agent/status binding, blocks `_*` internal key injection, and locks `actionSpec`
 * once approved or once an approval card has been sent for non-owner callers.
 */
export function validateTicketUpdate({
  ticket,
  patch = {},
  ctx = null,
} = {}) {
  if (!ticket || typeof ticket !== 'object') {
    return { allowed: false, code: 'TICKET_NOT_FOUND', reason: 'Missing ticket object.' };
  }
  const p = patch && typeof patch === 'object' ? patch : {};
  const forbiddenKeys = findForbiddenInternalKeys(p.payloadPatch);
  if (forbiddenKeys.length > 0) {
    return {
      allowed: false,
      code: 'FORBIDDEN_INTERNAL_KEY',
      reason: `payloadPatch cannot write internal underscore keys: ${forbiddenKeys.join(', ')}`,
      forbiddenKeys,
    };
  }

  const status = normalizeTicketStatus(ticket.status, 'open');
  if (['done', 'rejected', 'expired'].includes(status)) {
    return {
      allowed: false,
      code: 'TICKET_TERMINAL',
      reason: `Cannot update ticket in terminal status "${status}".`,
    };
  }

  const c = ctx && typeof ctx === 'object' ? ctx : null;
  if (!c) {
    return {
      allowed: false,
      code: 'TICKET_UPDATE_CTX_REQUIRED',
      reason: 'ticket_update requires an explicit verified caller context.',
    };
  }
  const actorRole = String(c.actorRole || (c.isOwner === true ? 'owner' : 'agent')).trim().toLowerCase();
  const isOwnerDm = Boolean(c.isOwner === true && c.isGroup !== true);

  if (c.agentId && ticket.agentId && String(c.agentId).trim() !== String(ticket.agentId).trim() && !isOwnerDm) {
    return {
      allowed: false,
      code: 'TICKET_AGENT_MISMATCH',
      reason: 'Caller agent does not own this ticket.',
    };
  }

  if (!isOwnerDm) {
    const callerChat = c.sourceChatId != null ? String(c.sourceChatId).trim() : (c.chatId != null ? String(c.chatId).trim() : '');
    const ticketChat = ticket.sourceChatId != null ? String(ticket.sourceChatId).trim() : '';
    if (!callerChat || !ticketChat || callerChat !== ticketChat) {
      return {
        allowed: false,
        code: 'TICKET_ROOM_MISMATCH',
        reason: 'Cross-room ticket_update is blocked outside Owner DM.',
      };
    }
  }

  if (p.actionSpec !== undefined && p.actionSpec !== null) {
    const incomingHash = computeTicketSpecHash(p.actionSpec);
    const currentHash = ticket.approvedSpecHash || ticket.specHash || computeTicketSpecHash(ticket.actionSpec);
    if (ticket.approvedBy || status === 'in_progress') {
      return {
        allowed: false,
        code: 'ACTION_SPEC_LOCKED',
        reason: 'actionSpec is frozen after approval or execution start.',
      };
    }
    if (status === 'awaiting_approval' && ticket.approvalCardSent !== false && actorRole !== 'owner' && incomingHash !== currentHash) {
      return {
        allowed: false,
        code: 'ACTION_SPEC_LOCKED_PENDING_APPROVAL',
        reason: 'Non-owner callers cannot mutate actionSpec after the approval card has been issued.',
      };
    }
  }

  return { allowed: true, code: 'OK' };
}

/**
 * Machine-enforced scope check for `ticket_transition` & post-approval execution (SCROLL 2.16.1).
 * Prevents ticket A's execution turn from modifying ticket B's checkpoint or status.
 */
export function validateTicketTransitionScope({
  ticket,
  actorRole = 'agent',
  agentId = null,
  approvedTicketId = null,
} = {}) {
  if (!ticket || typeof ticket !== 'object') {
    return { allowed: false, code: 'TICKET_NOT_FOUND', reason: 'Missing ticket object.' };
  }
  const role = String(actorRole || 'agent').trim().toLowerCase();
  if (role === 'owner') return { allowed: true, code: 'OK' };

  if (agentId && ticket.agentId && String(agentId).trim() !== String(ticket.agentId).trim()) {
    return {
      allowed: false,
      code: 'TICKET_AGENT_MISMATCH',
      reason: 'Transition denied: agentId does not match ticket owner.',
    };
  }
  if (role === 'agent' && approvedTicketId) {
    const bound = String(approvedTicketId).trim();
    if (bound !== String(ticket.id || '').trim() && bound !== String(ticket.ticketCode || '').trim()) {
      return {
        allowed: false,
        code: 'TICKET_SCOPE_MISMATCH',
        reason: `Agent turn bound to ${bound} cannot transition unrelated ticket ${ticket.ticketCode || ticket.id}.`,
      };
    }
  }
  if (ticket.approvedBy && ticket.approvedSpecHash && ticket.actionSpec) {
    const liveHash = computeTicketSpecHash(ticket.actionSpec);
    if (liveHash !== ticket.approvedSpecHash) {
      return {
        allowed: false,
        code: 'SPEC_HASH_MISMATCH',
        reason: 'Ticket actionSpec no longer matches approvedSpecHash.',
      };
    }
  }
  return { allowed: true, code: 'OK' };
}

/**
 * Explicit exit gate for autonomous ticket/job turns (SCROLL 2.16.1).
 * Prevents hosts from auto-closing a ticket as `done` when a turn returns plain text
 * without an explicit verified completion receipt or checkpoint.
 */
export function evaluateTicketTurnExit({
  explicitDone = false,
  hasVerifiedReceipt = false,
  hasCheckpoint = false,
  hasOpenAsk = false,
  hasFailure = false,
  implicitYieldCount = 0,
  maxImplicitYields = 2,
  recoverCount = 0,
  maxRecoveries = 2,
} = {}) {
  if (explicitDone) {
    if (!hasVerifiedReceipt) {
      const nextRecover = (Number.isFinite(Number(recoverCount)) ? Math.max(0, Number(recoverCount)) : 0) + 1;
      const capRecover = Number.isFinite(Number(maxRecoveries)) ? Math.max(1, Number(maxRecoveries)) : 2;
      if (nextRecover > capRecover) {
        return {
          action: 'escalate_owner',
          code: 'RECEIPT_RECOVERY_EXHAUSTED',
          recoverCount: nextRecover,
          allowAutoClose: false,
        };
      }
      return { action: 'recover', code: 'RECEIPT_REQUIRED', recoverCount: nextRecover, allowAutoClose: false };
    }
    return { action: 'complete', code: 'VERIFIED_DONE', allowAutoClose: false };
  }
  if (hasCheckpoint) return { action: 'yield', code: 'EXPLICIT_CHECKPOINT', allowAutoClose: false };
  if (hasOpenAsk) return { action: 'wait_ask', code: 'OPEN_ASK', allowAutoClose: false };
  if (hasFailure) return { action: 'fail', code: 'EXPLICIT_FAILURE', allowAutoClose: false };

  // Bare end_turn without explicit exit contract: NEVER auto-close as done!
  const prevImplicit = Number.isFinite(Number(implicitYieldCount)) ? Math.max(0, Number(implicitYieldCount)) : 0;
  const maxAllowed = Number.isFinite(Number(maxImplicitYields)) ? Math.max(1, Number(maxImplicitYields)) : 2;
  const nextImplicit = prevImplicit + 1;
  if (nextImplicit > maxAllowed) {
    return {
      action: 'escalate_owner',
      code: 'EXPLICIT_EXIT_CONTRACT_BREACH',
      implicitYieldCount: nextImplicit,
      allowAutoClose: false,
    };
  }
  return {
    action: 'implicit_yield',
    code: 'EXPLICIT_EXIT_REQUIRED',
    implicitYieldCount: nextImplicit,
    allowAutoClose: false,
  };
}

const KIND_SET = new Set(TICKET_KINDS);
const STATUS_SET = new Set(TICKET_STATUSES);
const PRIORITY_SET = new Set(TICKET_PRIORITIES);
const APPROVER_SET = new Set(TICKET_APPROVER_ROLES);

const SECRET_KEY_RE = /(?:pass(?:word|wd|code)?|otp|pin_?code|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|authorization|private[_-]?key|cookie|session[_-]?token)/i;

const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  /\b(?:sk|pk|rk|ghp|gho|glpat|xoxb|xoxp|AIza)[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:password|passwd|mat\s*khau|otp)\s*[:=]\s*\S+/gi,
];

export function redactTicketText(input, maxLen = 4000) {
  let out = String(input ?? '');
  for (const re of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '[REDACTED]');
  }
  return out.length > maxLen ? `${out.slice(0, maxLen)}...` : out;
}

export function redactTicketPayload(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactTicketText(value, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 60).map((item) => redactTicketPayload(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactTicketPayload(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function normalizeTicketKind(raw, fallback = 'follow_up') {
  const s = String(raw || '').trim().toLowerCase();
  if (KIND_SET.has(s)) return s;
  if (s === 'approval' || s === 'action') return 'action_approval';
  if (s === 'escalation' || s === 'escalate') return 'handoff';
  if (s === 'bug' || s === 'feature_request' || s === 'feedback' || s === 'praise') return 'bug_feedback';
  return fallback;
}

export function normalizeTicketStatus(raw, fallback = 'open') {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'doing') return 'in_progress';
  if (s === 'resolved') return 'done';
  if (s === 'dismissed' || s === 'cancelled') return 'rejected';
  if (STATUS_SET.has(s)) return s;
  return fallback;
}

export function normalizeTicketPriority(raw, fallback = 'normal') {
  const s = String(raw || '').trim().toLowerCase();
  return PRIORITY_SET.has(s) ? s : fallback;
}

export function normalizeApproverRole(raw, kind = 'follow_up') {
  const s = String(raw || '').trim().toLowerCase();
  if (APPROVER_SET.has(s)) return s;
  return kind === 'action_approval' ? 'owner' : 'any_member';
}

export function generateTicketCode(prefix = 'TK') {
  const cleanPrefix = String(prefix || 'TK').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'TK';
  const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${cleanPrefix}-${hex}`;
}

export function buildTicketIdempotencyKey({
  agentId = '',
  sourceChatId = '',
  kind = 'follow_up',
  dedupeKey = '',
  title = '',
} = {}) {
  const basis = String(dedupeKey || title || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
  if (!basis) return null;
  const raw = `${String(agentId || '').trim()}|${String(sourceChatId || '').trim()}|${normalizeTicketKind(kind)}|${basis}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

/**
 * Deterministic state machine and approval authority gate.
 * Enforced in code; agents can NEVER self-approve `awaiting_approval` tickets or close human handoffs.
 */
export function canTransitionTicket({
  ticket,
  nextStatus,
  actorRole = 'agent',
  actorId = null,
  hasReceipt = false,
} = {}) {
  if (!ticket || typeof ticket !== 'object') {
    return { allowed: false, code: 'TICKET_NOT_FOUND', reason: 'Missing ticket object.' };
  }
  const from = normalizeTicketStatus(ticket.status, 'open');
  const to = normalizeTicketStatus(nextStatus, '');
  if (!to || !STATUS_SET.has(to)) {
    return { allowed: false, code: 'INVALID_STATUS', reason: `Invalid target status: ${nextStatus}` };
  }
  const role = String(actorRole || 'agent').trim().toLowerCase();
  const kind = normalizeTicketKind(ticket.kind, 'follow_up');
  const approverRole = normalizeApproverRole(ticket.approverRole, kind);

  // Owners hold full lifecycle control across all ticket kinds and states.
  if (role === 'owner') {
    return { allowed: true, from, to, via: 'owner_authority' };
  }

  // System timers & post-approval runtime finalizer (never self-approves awaiting_approval).
  if (role === 'system') {
    if (from === 'awaiting_approval' && to === 'expired') {
      return { allowed: true, from, to, via: 'system_expiry' };
    }
    if (from === 'in_progress' && to === 'done' && ticket.approvedBy && hasReceipt) {
      return { allowed: true, from, to, via: 'system_post_approval_receipt' };
    }
    return { allowed: false, code: 'SYSTEM_TRANSITION_DENIED', reason: `System cannot move ${from} -> ${to}.` };
  }

  // Agents have strictly bounded transitions and ZERO approval power.
  if (role === 'agent') {
    if (from === 'awaiting_approval') {
      return {
        allowed: false,
        code: 'AGENT_CANNOT_SELF_APPROVE',
        reason: 'Agents cannot approve, reject, or bypass awaiting_approval tickets.',
      };
    }
    if (to === 'rejected' || to === 'expired') {
      return {
        allowed: false,
        code: 'AGENT_CANNOT_DECIDE',
        reason: 'Only authorized humans may reject tickets.',
      };
    }
    if (kind === 'handoff' && to === 'done') {
      return {
        allowed: false,
        code: 'AGENT_CANNOT_CLOSE_HANDOFF',
        reason: 'Human handoff tickets must be closed by an owner or assigned operator.',
      };
    }
    if (to === 'done') {
      if (kind === 'action_approval') {
        if (!ticket.approvedBy) {
          return {
            allowed: false,
            code: 'APPROVAL_REQUIRED',
            reason: 'action_approval ticket cannot be marked done without human approval.',
          };
        }
        if (!hasReceipt) {
          return {
            allowed: false,
            code: 'RECEIPT_REQUIRED',
            reason: 'action_approval ticket requires a recorded execution receipt before closing as done.',
          };
        }
        return { allowed: true, from, to, via: 'agent_post_approval_receipt' };
      }
      return {
        allowed: false,
        code: 'AGENT_CLOSE_RESTRICTED',
        reason: 'Only verified post-approval action tickets may be closed automatically by an agent.',
      };
    }
    if (from === 'open' && to === 'in_progress') {
      return { allowed: true, from, to, via: 'agent_work_start' };
    }
    if (from === 'in_progress' && to === 'in_progress') {
      if (kind === 'action_approval' && !ticket.approvedBy) {
        return {
          allowed: false,
          code: 'APPROVAL_REQUIRED',
          reason: 'action_approval ticket cannot be checkpointed without human approval.',
        };
      }
      return { allowed: true, from, to, via: 'agent_checkpoint' };
    }
    return {
      allowed: false,
      code: 'AGENT_TRANSITION_DENIED',
      reason: `Agent cannot transition ${kind} ticket from ${from} -> ${to}.`,
    };
  }

  // Human members / admins
  if (role === 'admin' || role === 'member') {
    if (from === 'awaiting_approval') {
      if (approverRole === 'owner') {
        return {
          allowed: false,
          code: 'OWNER_APPROVAL_REQUIRED',
          reason: 'This ticket requires explicit Owner approval.',
        };
      }
      if (approverRole === 'admin' && role !== 'admin') {
        return {
          allowed: false,
          code: 'ADMIN_APPROVAL_REQUIRED',
          reason: 'This ticket requires Admin or Owner approval.',
        };
      }
      if (to === 'in_progress' || to === 'done' || to === 'rejected') {
        return { allowed: true, from, to, via: `${role}_approval` };
      }
    }
    if (['open', 'in_progress', 'done'].includes(from) && ['open', 'in_progress', 'done'].includes(to)) {
      return { allowed: true, from, to, via: `${role}_workflow`, actorId };
    }
    if (role === 'admin' && to === 'rejected') {
      return { allowed: true, from, to, via: 'admin_reject' };
    }
    return {
      allowed: false,
      code: 'MEMBER_TRANSITION_DENIED',
      reason: `Role ${role} cannot transition ticket from ${from} -> ${to}.`,
    };
  }

  return { allowed: false, code: 'UNKNOWN_ACTOR_ROLE', reason: `Unsupported actorRole: ${actorRole}` };
}

/**
 * Audience-safe projection for `ticket_list`:
 * - Owner DM receives full records across the workspace.
 * - Group/external callers ONLY receive tickets belonging to the exact `chatId`,
 *   with internal notes, action specs, and execution secrets stripped.
 */
export function projectTicketForAudience(ticket, { isOwner = false, isGroup = false, chatId = null } = {}) {
  if (!ticket || typeof ticket !== 'object') return null;
  if (isOwner && !isGroup) {
    return { ...ticket };
  }
  const reqChat = chatId !== null && chatId !== undefined ? String(chatId).trim() : '';
  const ticketChat = ticket.sourceChatId !== null && ticket.sourceChatId !== undefined ? String(ticket.sourceChatId).trim() : '';
  if (!reqChat || !ticketChat || reqChat !== ticketChat) {
    return null;
  }
  return {
    id: ticket.id,
    ticketCode: ticket.ticketCode,
    kind: ticket.kind,
    status: ticket.status,
    priority: ticket.priority,
    title: ticket.title,
    requesterName: ticket.requesterName || null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    expiresAt: ticket.expiresAt || null,
  };
}

/**
 * Generic owner-presence action gate for high-impact actions requested in multi-user rooms.
 * Policies:
 *   - `owner_or_approve` (default): Owner in room commanding directly -> allow (+ audit ticket);
 *     non-owner in room with owner present -> require_approval (`action_approval` ticket);
 *     room without owner -> deny (`handoff` ticket only).
 *   - `always_approve`: Every group request (even from owner) requires explicit ticket approval.
 *   - `owner_dm_only`: Disallow completely inside any group.
 */
export function evaluateGroupOwnerActionGate({
  isGroup = false,
  isOwnerSender = false,
  ownerInRoom = false,
  policy = 'owner_or_approve',
} = {}) {
  if (!isGroup) {
    if (isOwnerSender) {
      return {
        decision: 'allow',
        mode: 'owner_dm',
        recordAuditTicket: true,
        reason: 'Direct owner conversation.',
      };
    }
    return {
      decision: 'require_approval',
      mode: 'external_dm_approval',
      suggestedTicketKind: 'action_approval',
      approverRole: 'owner',
      reason: 'External direct message requires owner approval.',
    };
  }

  const normPolicy = String(policy || 'owner_or_approve').trim().toLowerCase();
  if (normPolicy === 'owner_dm_only') {
    return {
      decision: 'deny',
      mode: 'group_blocked',
      suggestedTicketKind: 'handoff',
      reason: 'This action is restricted to Owner DM.',
    };
  }

  if (!ownerInRoom) {
    return {
      decision: 'deny',
      mode: 'owner_not_in_room',
      suggestedTicketKind: 'handoff',
      reason: 'Owner is not verified as a member of this group.',
    };
  }

  if (normPolicy === 'always_approve') {
    return {
      decision: 'require_approval',
      mode: 'owner_in_room_explicit_approval',
      suggestedTicketKind: 'action_approval',
      approverRole: 'owner',
      reason: 'Policy requires explicit approval ticket even when owner is present.',
    };
  }

  if (isOwnerSender) {
    return {
      decision: 'allow',
      mode: 'owner_in_room_direct',
      recordAuditTicket: true,
      reason: 'Owner is verified in this room and issued the command directly.',
    };
  }

  return {
    decision: 'require_approval',
    mode: 'owner_in_room_approval',
    suggestedTicketKind: 'action_approval',
    approverRole: 'owner',
    reason: 'Owner is present in this room; create an action_approval ticket for 1-tap owner sign-off.',
  };
}

export const SCROLL_TICKET_TOOL_SCHEMAS = Object.freeze([
  Object.freeze({
    name: 'ticket_create',
    description: 'Create a structured pending ticket in the workspace unified work queue (Tasks/Tickets). Use kind="action_approval" when an action needs owner approval before execution, kind="handoff" for human operator takeover, kind="bug_feedback" for product bugs/ideas, and kind="follow_up" for tracked follow-ups. Automatically deduplicates matching open tickets within 24h and redacts secrets.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'reversible_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: TICKET_KINDS,
          description: 'Ticket kind: action_approval | handoff | bug_feedback | follow_up.',
        },
        title: { type: 'string', description: 'Short actionable ticket title (<= 140 chars).' },
        summary: { type: 'string', description: 'Clear context for the assignee/approver (never include passwords/OTPs).' },
        priority: { type: 'string', enum: TICKET_PRIORITIES, description: 'Urgency level (default: normal).' },
        dedupeKey: { type: 'string', description: 'Optional stable key (e.g. requester email or issue slug) to update an existing open ticket within 24h instead of creating a duplicate.' },
        approverRole: { type: 'string', enum: TICKET_APPROVER_ROLES, description: 'Who may approve an action_approval ticket (default: owner).' },
        app: { type: 'string', description: 'Optional product/app identifier.' },
        screen: { type: 'string', description: 'Optional screen/route name.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
        actionSpec: {
          type: 'object',
          description: 'Optional structured action to run automatically after approval: { connector?, tool, args, previewSummary }.',
          properties: {
            connector: { type: 'string' },
            tool: { type: 'string' },
            args: { type: 'object' },
            previewSummary: { type: 'string' },
          },
        },
        payload: { type: 'object', description: 'Optional structured metadata (automatically secret-redacted).' },
      },
      required: ['kind', 'title'],
    },
  }),
  Object.freeze({
    name: 'ticket_update',
    description: 'Append newly received details (such as a requester email, screenshot note, or clarification) to an existing open or awaiting_approval ticket instead of opening a duplicate ticket.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'reversible_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket ID or ticketCode (e.g. TK-1234ABCD or FB-1234ABCD).' },
        note: { type: 'string', description: 'Additional detail or update note to append (secrets redacted).' },
        title: { type: 'string', description: 'Optional updated concise title.' },
        actionSpec: { type: 'object', description: 'Optional updated actionSpec once missing parameters (e.g. email/role) are collected.' },
        payloadPatch: { type: 'object', description: 'Optional metadata fields to merge into ticket payload.' },
      },
      required: ['ticketId'],
    },
  }),
  Object.freeze({
    name: 'ticket_list',
    description: 'List tickets visible in the current conversation scope. In Owner DM returns workspace tickets; in multi-user groups returns ONLY public status of tickets created in that same group.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'public_safe',
    risk: 'read_only',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...TICKET_STATUSES, 'active', 'all'], description: 'Filter by status (default: active).' },
        kind: { type: 'string', enum: [...TICKET_KINDS, 'all'], description: 'Optional kind filter.' },
        limit: { type: 'number', description: 'Max tickets to return (default: 15, max: 50).' },
      },
    },
  }),
  Object.freeze({
    name: 'ticket_transition',
    description: 'Transition a ticket status (e.g. checkpoint a long-running task with recheckAfterSec, or record a verified completion receipt when closing an approved ticket as done). Self-approval and closing human handoffs are machine-blocked.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'owner_dm',
    risk: 'reversible_write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket ID or ticketCode.' },
        status: { type: 'string', enum: TICKET_STATUSES, description: 'Target status.' },
        note: { type: 'string', description: 'Short explanation, checkpoint update, or completion summary.' },
        receipt: { type: 'object', description: 'Verified tool execution receipt (required when closing action_approval as done).' },
        checkpoint: {
          type: 'object',
          description: 'Optional checkpoint for long-running in_progress tickets so the host can wake the agent automatically after recheckAfterSec without blocking other chats.',
          properties: {
            step: { type: 'string', description: 'Short machine/human step label, e.g. "waiting_export" or "verifying_output".' },
            progressSummary: { type: 'string', description: 'Concise summary of what has already been completed so far.' },
            nextAction: { type: 'string', description: 'Exact check or next action to take on the next wake-up.' },
            recheckAfterSec: { type: 'number', description: 'Seconds until the host automatically wakes the agent to recheck (10..600).' },
            state: { type: 'object', description: 'Optional small JSON state to preserve across wake-ups (e.g. tabId, filePath, jobId; secrets auto-redacted).' },
          },
        },
      },
      required: ['ticketId', 'status'],
    },
  }),
]);

/**
 * Turn-scoped execution helper tools for post-approval autonomous ticket execution (SCROLL 2.16).
 * Kept separate from `SCROLL_TICKET_TOOL_SCHEMAS` for strict backward compatibility while sharing
 * the `scroll-core` tool group.
 */
export const SCROLL_TICKET_EXECUTION_TOOL_SCHEMAS = Object.freeze([
  Object.freeze({
    name: 'ticket_reply_room',
    description: 'Send a brief, natural, in-persona message directly to the originating chat/group of the currently approved ticket (for example, acknowledging that the owner approved and you are starting a multi-step task). Call at most once before starting slow work; never spam intermediate technical steps.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'approved_ticket_turn',
    risk: 'external_comm',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Natural message in your own voice to send to the ticket room.' },
      },
      required: ['text'],
    },
  }),
  Object.freeze({
    name: 'ticket_wait',
    description: 'Pause cleanly for 1 to 45 seconds while an external UI, upload, or short operation settles before inspecting progress again. For waits longer than 45 seconds, use ticket_transition(status="in_progress", checkpoint={ recheckAfterSec, ... }) instead so other conversations stay responsive.',
    group: 'scroll-core',
    tier: 'core',
    scope: 'owner_or_ticket',
    risk: 'read_only',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Seconds to wait (clamped to 1..45).' },
        reason: { type: 'string', description: 'Brief reason for waiting (e.g. "Waiting for upload to finish").' },
      },
      required: ['seconds'],
    },
  }),
]);

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Generic channel target parser (zero hardcoded channel names).
 * Supports `<surface>_group`, `<surface>_dm`, and `<surface>` uniformly.
 */
export function parseTicketChannelTarget(sourceChannel = 'web', sourceChatId = null, meta = null) {
  const raw = String(sourceChannel || 'web').trim().toLowerCase() || 'web';
  let surface = raw;
  let isGroup = Boolean(meta && typeof meta === 'object' && meta.isGroup);
  if (raw.endsWith('_group') && raw.length > 6) {
    surface = raw.slice(0, -6);
    isGroup = true;
  } else if (raw.endsWith('_dm') && raw.length > 3) {
    surface = raw.slice(0, -3);
    isGroup = false;
  }
  const chatId = sourceChatId !== null && sourceChatId !== undefined && String(sourceChatId).trim()
    ? String(sourceChatId).trim()
    : null;
  const conversationId = chatId ? `${surface}:${chatId}` : null;
  return {
    sourceChannel: raw,
    surface,
    isGroup,
    chatId,
    conversationId,
  };
}

/**
 * Deterministic post-approval execution planner (SCROLL 2.16).
 * Decides whether approval triggers:
 *   - `mcp_tool`: deterministic single-tool external MCP execution
 *   - `agent_turn`: wake the owning agent for autonomous multi-step execution
 *   - `manual`: human-only completion with no automated agent runtime
 */
export function resolveTicketApprovalPlan(ticket, { hasAgentRuntime = false } = {}) {
  const kind = normalizeTicketKind(ticket?.kind, 'follow_up');
  const actionSpec = ticket?.actionSpec && typeof ticket.actionSpec === 'object' ? ticket.actionSpec : null;
  const explicitMode = String(actionSpec?.mode || '').trim().toLowerCase();
  const target = parseTicketChannelTarget(ticket?.sourceChannel, ticket?.sourceChatId, ticket?.meta);
  const maxContinuations = clampInt(
    actionSpec?.maxContinuations,
    TICKET_DEFAULT_MAX_CONTINUATIONS,
    1,
    TICKET_MAX_CONTINUATIONS_LIMIT,
  );

  if (explicitMode === 'manual') {
    return {
      mode: 'manual',
      nextStatus: 'done',
      wakeAgent: false,
      executeMcpTool: false,
      sendStaticApprovalNotice: true,
      requiresReceipt: false,
      maxContinuations: 0,
      target,
      reason: 'explicit_manual_mode',
    };
  }

  if (actionSpec && actionSpec.tool && explicitMode !== 'agent_turn') {
    return {
      mode: 'mcp_tool',
      nextStatus: 'in_progress',
      wakeAgent: false,
      executeMcpTool: true,
      sendStaticApprovalNotice: false,
      requiresReceipt: true,
      maxContinuations: 0,
      target,
      reason: 'declarative_mcp_tool',
    };
  }

  if (hasAgentRuntime && ticket?.agentId && (kind === 'action_approval' || explicitMode === 'agent_turn')) {
    return {
      mode: 'agent_turn',
      nextStatus: 'in_progress',
      wakeAgent: true,
      executeMcpTool: false,
      sendStaticApprovalNotice: false,
      requiresReceipt: true,
      maxContinuations,
      target,
      reason: 'agent_autonomous_execution',
    };
  }

  return {
    mode: 'manual',
    nextStatus: 'done',
    wakeAgent: false,
    executeMcpTool: false,
    sendStaticApprovalNotice: true,
    requiresReceipt: false,
    maxContinuations: 0,
    target,
    reason: 'manual_or_no_agent_runtime',
  };
}

/**
 * Validates and secret-redacts a checkpoint payload for long-running ticket execution.
 */
export function normalizeTicketCheckpoint(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const step = redactTicketText(String(raw.step || 'in_progress').trim() || 'in_progress', 120);
  const progressSummary = redactTicketText(String(raw.progressSummary || raw.summary || '').trim(), 600);
  const nextAction = redactTicketText(String(raw.nextAction || '').trim(), 600);
  const rawSec = Number(raw.recheckAfterSec);
  const recheckAfterSec = Number.isFinite(rawSec) && rawSec > 0
    ? clampInt(rawSec, 30, TICKET_MIN_RECHECK_SEC, TICKET_MAX_RECHECK_SEC)
    : null;
  const nextRecheckAt = recheckAfterSec !== null ? nowMs + (recheckAfterSec * 1000) : null;
  const state = raw.state && typeof raw.state === 'object' ? redactTicketPayload(raw.state) : null;
  return {
    step,
    progressSummary,
    nextAction,
    recheckAfterSec,
    nextRecheckAt,
    state,
    updatedAt: nowMs,
  };
}

/**
 * Deterministic stop-condition guard for checkpointed ticket continuations.
 * Prevents unbounded background polling loops.
 */
export function evaluateTicketContinuationBudget({ execution = null, nowMs = Date.now() } = {}) {
  const exec = execution && typeof execution === 'object' ? execution : {};
  const continuationsUsed = Math.max(0, Number(exec.continuationsUsed || 0));
  const maxContinuations = clampInt(
    exec.maxContinuations,
    TICKET_DEFAULT_MAX_CONTINUATIONS,
    1,
    TICKET_MAX_CONTINUATIONS_LIMIT,
  );
  const startedAt = Number(exec.startedAt || 0) || nowMs;
  const maxExecutionMs = Math.max(60_000, Number(exec.maxExecutionMs || TICKET_MAX_EXECUTION_MS));
  // SCROLL 2.16.1: Prefer active compute duration (`activeElapsedMs`) when provided so
  // sleep/recheck waits on 45-90m Sprint tasks are not charged as active wall time.
  const hasActiveClock = exec.activeElapsedMs !== undefined && exec.activeElapsedMs !== null && Number.isFinite(Number(exec.activeElapsedMs));
  const elapsedMs = hasActiveClock
    ? Math.max(0, Number(exec.activeElapsedMs))
    : Math.max(0, nowMs - startedAt);
  const consecutiveErrors = Math.max(0, Number(exec.consecutiveErrors || 0));
  const maxConsecutiveErrors = Math.max(1, Number(exec.maxConsecutiveErrors || TICKET_MAX_CONSECUTIVE_ERRORS));

  if (continuationsUsed >= maxContinuations) {
    return {
      allowed: false,
      code: 'MAX_CONTINUATIONS_REACHED',
      reason: `Ticket reached continuation cap (${continuationsUsed}/${maxContinuations}).`,
      continuationsUsed,
      maxContinuations,
      elapsedMs,
      maxExecutionMs,
      consecutiveErrors,
      maxConsecutiveErrors,
    };
  }
  if (elapsedMs >= maxExecutionMs) {
    return {
      allowed: false,
      code: 'MAX_EXECUTION_TIME_REACHED',
      reason: `Ticket exceeded max execution window (${Math.round(elapsedMs / 60_000)}m / ${Math.round(maxExecutionMs / 60_000)}m).`,
      continuationsUsed,
      maxContinuations,
      elapsedMs,
      maxExecutionMs,
      consecutiveErrors,
      maxConsecutiveErrors,
    };
  }
  if (consecutiveErrors >= maxConsecutiveErrors) {
    return {
      allowed: false,
      code: 'MAX_CONSECUTIVE_ERRORS_REACHED',
      reason: `Ticket halted after ${consecutiveErrors} consecutive execution failures.`,
      continuationsUsed,
      maxContinuations,
      elapsedMs,
      maxExecutionMs,
      consecutiveErrors,
      maxConsecutiveErrors,
    };
  }
  return {
    allowed: true,
    code: 'OK',
    reason: 'Within continuation budget.',
    continuationsUsed,
    maxContinuations,
    elapsedMs,
    maxExecutionMs,
    consecutiveErrors,
    maxConsecutiveErrors,
  };
}

/**
 * Builds the structured, persona-preserving execution brief when waking an agent
 * after owner approval (`phase: "approved_start"`) or on a checkpoint recheck (`phase: "continue"`).
 */
export function buildTicketApprovalTurnPrompt(ticket, {
  approvedBy = 'owner',
  decisionNote = '',
  phase = 'approved_start',
  attempt = 1,
  maxContinuations = TICKET_DEFAULT_MAX_CONTINUATIONS,
  checkpoint = null,
  attachments = [],
} = {}) {
  const code = String(ticket?.ticketCode || ticket?.id || 'UNKNOWN').trim();
  const title = redactTicketText(ticket?.title || '', 200);
  const note = redactTicketText(ticket?.note || ticket?.summary || '', 2000);
  const requester = redactTicketText(ticket?.requesterName || '', 80);
  const target = parseTicketChannelTarget(ticket?.sourceChannel, ticket?.sourceChatId, ticket?.meta);
  const roomLabel = redactTicketText(ticket?.sourceChatTitle || target.sourceChannel, 120);
  const cleanDecision = redactTicketText(decisionNote || ticket?.decisionNote || '', 300);

  const safeMeta = {};
  if (ticket?.meta && typeof ticket.meta === 'object') {
    for (const [k, v] of Object.entries(ticket.meta)) {
      if (k.startsWith('_')) continue;
      safeMeta[k] = v;
    }
  }
  const hasMeta = Object.keys(safeMeta).length > 0;

  const lines = [
    phase === 'continue'
      ? `[APPROVED TICKET CONTINUATION -- ${code} (check ${attempt}/${maxContinuations})]`
      : `[APPROVED TICKET EXECUTION -- ${code}]`,
    `Owner authorization verified in code: approvedBy=${redactTicketText(approvedBy, 80)}`,
    ...(cleanDecision ? [`Owner note: ${cleanDecision}`] : []),
    `Ticket: ${code} -- ${title}`,
    ...(requester ? [`Requester: ${requester}`] : []),
    `Target room: ${roomLabel} (${target.sourceChannel}${target.isGroup ? ', multi-user group' : ''})`,
    ...(note ? [`Details:\n${note}`] : []),
    ...(hasMeta ? [`Metadata: ${JSON.stringify(redactTicketPayload(safeMeta))}`] : []),
  ];

  const fileList = Array.isArray(attachments) ? attachments.filter((a) => a && (a.filename || a.mediaId)) : [];
  if (fileList.length > 0) {
    lines.push('Linked files available for this ticket (use `inbound_files` to read or stage onto Companion):');
    for (let i = 0; i < Math.min(8, fileList.length); i++) {
      const f = fileList[i];
      const kb = f.sizeBytes ? `${Math.max(1, Math.round(Number(f.sizeBytes) / 1024))} KB` : 'size unknown';
      lines.push(`- ${f.fileRef || `file_${i + 1}`}: ${redactTicketText(f.filename || 'file', 140)} (${f.mimeType || 'binary'}, ${kb}${f.mediaId ? `, mediaId=${f.mediaId}` : ''})`);
    }
  }

  if (phase === 'continue' && checkpoint && typeof checkpoint === 'object') {
    lines.push(
      'Previous checkpoint:',
      `- step: ${redactTicketText(checkpoint.step || 'in_progress', 120)}`,
      ...(checkpoint.progressSummary ? [`- progressSummary: ${redactTicketText(checkpoint.progressSummary, 600)}`] : []),
      ...(checkpoint.nextAction ? [`- nextAction: ${redactTicketText(checkpoint.nextAction, 600)}`] : []),
      ...(checkpoint.state ? [`- state: ${JSON.stringify(redactTicketPayload(checkpoint.state))}`] : []),
    );
  }

  lines.push('Execution protocol:');
  lines.push('1. This ticket is ALREADY approved by the owner. Execute the task directly with your authorized tools -- do NOT ask for approval again.');
  if (phase === 'approved_start') {
    lines.push('2. Speak naturally in your own persona/voice (never copy robotic ticket templates). If this work involves multi-step or slow computer/browser operations, call `ticket_reply_room` ONCE right at the start with a brief, natural message letting the requester know approval is confirmed and you are starting now, then process the rest silently without intermediate chatter.');
    lines.push('   If the task completes quickly in one turn, skip `ticket_reply_room` and simply return your final natural response.');
  } else {
    lines.push('2. You already acknowledged this ticket earlier -- do NOT greet or re-announce approval again. Silently inspect the live state and continue from `nextAction` without duplicating side effects.');
  }
  lines.push(`3. For short waits up to ${TICKET_WAIT_MAX_SEC}s (UI load, upload settle), call \`ticket_wait({ seconds, reason })\`.`);
  lines.push(`4. For longer background jobs (generation, rendering, exports taking > ${TICKET_WAIT_MAX_SEC}s), call \`ticket_transition({ ticketId: "${code}", status: "in_progress", note, checkpoint: { step, progressSummary, nextAction, recheckAfterSec, state } })\` and finish this turn cleanly -- the host will wake you automatically after \`recheckAfterSec\` seconds without sending intermediate text to the room.`);
  lines.push(`5. ONLY when the work is truly complete, attach/send any deliverable files via \`send_chat_media\` (or \`doc_create\`), call \`ticket_transition({ ticketId: "${code}", status: "done", note, receipt: { ok: true, summary } })\`, and write your concise, natural final reply to the room.`);
  lines.push('6. If blocked by an unrecoverable issue, be honest and concise; do not mark the ticket done and never leak internal tokens, stack traces, or private DM notes into a multi-user group.');

  return lines.join('\n');
}

export function buildTicketGuidancePrompt({
  enabled = true,
  isGroup = false,
  isOwnerSender = false,
  ownerInRoom = false,
} = {}) {
  if (!enabled) return '';
  const lines = [
    '## Unified Ticket Protocol (scroll-ticket/v1)',
    '- Use `ticket_create` to file structured requests into the workspace Work Queue (`action_approval`, `handoff`, `bug_feedback`, `follow_up`).',
    '- If the user provides follow-up details (e.g. email, workspace name, screenshot context) for an already-open ticket, call `ticket_update` with the existing `ticketCode` instead of creating a duplicate ticket.',
    '- Never include passwords, OTPs, or secret tokens in ticket fields, and never claim a ticket was created or approved unless the tool returned `ok: true`.',
  ];
  if (isGroup) {
    if (ownerInRoom && isOwnerSender) {
      lines.push('- Current room verification: `ownerInRoom=true`, speaker is verified `owner`. Authorized owner-gated actions may execute directly and should record a completed audit ticket.');
    } else if (ownerInRoom) {
      lines.push('- Current room verification: `ownerInRoom=true`, speaker is a non-owner member/guest. For owner-gated actions (such as account provisioning), gather the required parameters and open `ticket_create(kind="action_approval")` for 1-tap owner approval -- do NOT execute before approval.');
    } else {
      lines.push('- Current room verification: `ownerInRoom=false`. Owner-gated actions are blocked in this group; provide self-serve instructions or open a `handoff` ticket only.');
    }
  }
  return lines.join('\n');
}

/**
 * Lightweight standalone JSONL ticket store for non-SQLite SCROLL hosts (CLI, W24, tests).
 */
export function createFileTicketStore({ filePath }) {
  if (!filePath) throw new Error('createFileTicketStore requires filePath');
  const resolved = path.resolve(filePath);

  function loadAll() {
    if (!fs.existsSync(resolved)) return [];
    const lines = fs.readFileSync(resolved, 'utf8').split('\n').filter(Boolean);
    const byId = new Map();
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id) byId.set(rec.id, rec);
      } catch {
        // Skip malformed line
      }
    }
    return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function saveRecord(rec) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, `${JSON.stringify(rec)}\n`, 'utf8');
    return rec;
  }

  return {
    create(input = {}, ctx = {}) {
      const now = Date.now();
      const kind = normalizeTicketKind(input.kind, 'follow_up');
      const status = kind === 'action_approval' ? 'awaiting_approval' : 'open';
      const idempotencyKey = buildTicketIdempotencyKey({
        agentId: ctx.agentId || input.agentId,
        sourceChatId: ctx.sourceChatId || input.sourceChatId,
        kind,
        dedupeKey: input.dedupeKey,
        title: input.title,
      });
      const existing = idempotencyKey
        ? loadAll().find((t) =>
            t.idempotencyKey === idempotencyKey &&
            ['open', 'awaiting_approval', 'in_progress'].includes(t.status) &&
            (now - (t.createdAt || 0)) <= TICKET_DEDUPE_WINDOW_MS)
        : null;
      if (existing) {
        if (input.payload) {
          const forbidden = findForbiddenInternalKeys(input.payload);
          if (forbidden.length > 0) {
            return {
              ok: false,
              code: 'FORBIDDEN_INTERNAL_KEY',
              reason: `Deduplicated ticket_create payload cannot write internal keys: ${forbidden.join(', ')}`,
            };
          }
        }
        let nextActionSpec = existing.actionSpec;
        let nextSpecHash = existing.specHash || computeTicketSpecHash(existing.actionSpec);
        if (input.actionSpec !== undefined && input.actionSpec !== null) {
          const incomingRedacted = redactTicketPayload(input.actionSpec);
          const incomingHash = computeTicketSpecHash(incomingRedacted);
          const specChanged = incomingHash !== nextSpecHash;
          if (specChanged) {
            if (existing.status !== 'open' || existing.approvedBy || existing.approvalCardSent !== false) {
              return {
                ok: false,
                code: existing.approvedBy || existing.status === 'in_progress'
                  ? 'ACTION_SPEC_LOCKED'
                  : 'ACTION_SPEC_LOCKED_PENDING_APPROVAL',
                reason: 'Cannot mutate actionSpec via deduplicated ticket_create on pending/approved ticket.',
              };
            }
            const guard = validateTicketUpdate({
              ticket: existing,
              patch: { actionSpec: incomingRedacted },
              ctx: {
                agentId: ctx.agentId || input.agentId || existing.agentId,
                sourceChatId: ctx.sourceChatId || input.sourceChatId || existing.sourceChatId,
                isOwner: ctx.isOwner === true,
                isGroup: ctx.isGroup === true,
                actorRole: ctx.actorRole || (ctx.isOwner === true ? 'owner' : 'agent'),
              },
            });
            if (!guard.allowed) return { ok: false, code: guard.code, reason: guard.reason };
            nextActionSpec = incomingRedacted;
            nextSpecHash = incomingHash;
          }
        }
        const nextNote = input.summary ? [existing.summary, redactTicketText(input.summary, 1000)].filter(Boolean).join('\n\n') : existing.summary;
        const updated = {
          ...existing,
          summary: nextNote,
          actionSpec: nextActionSpec,
          specHash: nextSpecHash,
          payload: input.payload ? { ...(existing.payload || {}), ...sanitizeTicketPayloadPatch(input.payload) } : existing.payload,
          updatedAt: now,
        };
        saveRecord(updated);
        return { ok: true, deduplicated: true, ticket: updated };
      }
      const prefix = kind === 'bug_feedback' ? 'FB' : 'TK';
      const redactedSpec = input.actionSpec ? redactTicketPayload(input.actionSpec) : null;
      const specHash = computeTicketSpecHash(redactedSpec);
      const ticket = {
        schema: TICKET_SCHEMA,
        id: `tk_${crypto.randomUUID()}`,
        ticketCode: generateTicketCode(prefix),
        kind,
        status,
        priority: normalizeTicketPriority(input.priority, 'normal'),
        title: redactTicketText(input.title || 'Pending ticket', 140),
        summary: redactTicketText(input.summary || '', 2000),
        agentId: ctx.agentId || input.agentId || null,
        sourceChannel: ctx.sourceChannel || input.sourceChannel || 'cli',
        sourceChatId: ctx.sourceChatId || input.sourceChatId || null,
        requesterName: ctx.requesterName || input.requesterName || null,
        requesterPrincipalId: ctx.requesterPrincipalId || input.requesterPrincipalId || null,
        approverRole: normalizeApproverRole(input.approverRole, kind),
        approvedBy: null,
        approvedAt: null,
        decisionNote: null,
        actionSpec: redactedSpec,
        specHash,
        approvedSpecHash: null,
        approvalCardSent: Boolean(ctx?.approvalCardSent ?? (kind === 'action_approval')),
        executionOwner: 'legacy',
        durableJobId: null,
        executionReceipt: null,
        payload: input.payload ? sanitizeTicketPayloadPatch(input.payload) : {},
        idempotencyKey,
        expiresAt: kind === 'action_approval' ? now + TICKET_DEFAULT_EXPIRY_MS : null,
        createdAt: now,
        updatedAt: now,
      };
      saveRecord(ticket);
      return { ok: true, deduplicated: false, ticket };
    },

    find(idOrCode) {
      const key = String(idOrCode || '').trim();
      return loadAll().find((t) => t.id === key || t.ticketCode === key) || null;
    },

    update(idOrCode, patch = {}, ctx = null) {
      const cur = this.find(idOrCode);
      if (!cur) return { ok: false, code: 'TICKET_NOT_FOUND' };
      const guard = validateTicketUpdate({ ticket: cur, patch, ctx });
      if (!guard.allowed) return { ok: false, code: guard.code, reason: guard.reason };
      const now = Date.now();
      const nextActionSpec = patch.actionSpec ? redactTicketPayload(patch.actionSpec) : cur.actionSpec;
      const nextSpecHash = patch.actionSpec ? computeTicketSpecHash(nextActionSpec) : (cur.specHash || computeTicketSpecHash(cur.actionSpec));
      const updated = {
        ...cur,
        title: patch.title ? redactTicketText(patch.title, 140) : cur.title,
        summary: patch.note ? [cur.summary, redactTicketText(patch.note, 1000)].filter(Boolean).join('\n\n') : cur.summary,
        actionSpec: nextActionSpec,
        specHash: nextSpecHash,
        payload: patch.payloadPatch ? { ...(cur.payload || {}), ...sanitizeTicketPayloadPatch(patch.payloadPatch) } : cur.payload,
        updatedAt: now,
      };
      saveRecord(updated);
      return { ok: true, ticket: updated };
    },

    transition(idOrCode, { status, actorRole = 'agent', actorId = null, agentId = null, approvedTicketId = null, note = null, receipt = null } = {}) {
      const cur = this.find(idOrCode);
      if (!cur) return { ok: false, code: 'TICKET_NOT_FOUND' };
      const scopeCheck = validateTicketTransitionScope({
        ticket: cur,
        actorRole,
        agentId,
        approvedTicketId,
      });
      if (!scopeCheck.allowed) return { ok: false, code: scopeCheck.code, reason: scopeCheck.reason };
      const check = canTransitionTicket({
        ticket: cur,
        nextStatus: status,
        actorRole,
        actorId,
        hasReceipt: Boolean(receipt),
      });
      if (!check.allowed) return { ok: false, code: check.code, reason: check.reason };
      const now = Date.now();
      const isApproval = cur.status === 'awaiting_approval' && ['in_progress', 'done'].includes(check.to) && actorRole !== 'agent';
      const frozenSpecHash = isApproval
        ? (cur.specHash || computeTicketSpecHash(cur.actionSpec))
        : cur.approvedSpecHash;
      const updated = {
        ...cur,
        status: check.to,
        approvedBy: isApproval ? (actorId || actorRole) : cur.approvedBy,
        approvedAt: isApproval ? now : cur.approvedAt,
        approvedSpecHash: frozenSpecHash || null,
        decisionNote: note ? redactTicketText(note, 500) : cur.decisionNote,
        executionReceipt: receipt ? redactTicketPayload(receipt) : cur.executionReceipt,
        updatedAt: now,
      };
      saveRecord(updated);
      return { ok: true, ticket: updated };
    },

    assignExecutionOwner(idOrCode, { executionOwner = 'durable', durableJobId = null } = {}) {
      const cur = this.find(idOrCode);
      if (!cur) return { ok: false, code: 'TICKET_NOT_FOUND' };
      if (!TICKET_EXECUTION_OWNERS.includes(executionOwner)) {
        return { ok: false, code: 'INVALID_EXECUTION_OWNER' };
      }
      if (cur.executionOwner === executionOwner && (!durableJobId || cur.durableJobId === durableJobId)) {
        return { ok: true, idempotent: true, ticket: cur };
      }
      if (cur.executionOwner === 'durable' && executionOwner === 'durable' && cur.durableJobId && cur.durableJobId !== durableJobId) {
        return { ok: false, code: 'EXECUTION_OWNER_CONFLICT', existingDurableJobId: cur.durableJobId };
      }
      const updated = {
        ...cur,
        executionOwner,
        durableJobId: durableJobId || cur.durableJobId || null,
        updatedAt: Date.now(),
      };
      saveRecord(updated);
      return { ok: true, idempotent: false, ticket: updated };
    },

    list({ status = 'active', kind = 'all', limit = 15, audience = { isOwner: true, isGroup: false, chatId: null } } = {}) {
      const now = Date.now();
      const cap = Math.min(50, Math.max(1, Number(limit) || 15));
      const out = [];
      for (const t of loadAll()) {
        const eff = t.status === 'awaiting_approval' && t.expiresAt && now > t.expiresAt
          ? { ...t, status: 'expired' }
          : t;
        if (kind && kind !== 'all' && eff.kind !== normalizeTicketKind(kind)) continue;
        if (status === 'active' && !['open', 'awaiting_approval', 'in_progress'].includes(eff.status)) continue;
        if (status !== 'active' && status !== 'all' && eff.status !== normalizeTicketStatus(status)) continue;
        const projected = projectTicketForAudience(eff, audience);
        if (projected) out.push(projected);
        if (out.length >= cap) break;
      }
      return out;
    },
  };
}
