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

  // System timers may mark awaiting_approval tickets as expired once past expiry.
  if (role === 'system') {
    if (from === 'awaiting_approval' && to === 'expired') {
      return { allowed: true, from, to, via: 'system_expiry' };
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
    description: 'Transition a ticket status (e.g. start work or record completion receipt after an approved action succeeds). Self-approval and closing human handoffs are machine-blocked.',
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
        note: { type: 'string', description: 'Short explanation or completion summary.' },
        receipt: { type: 'object', description: 'Verified tool execution receipt (required when closing action_approval as done).' },
      },
      required: ['ticketId', 'status'],
    },
  }),
]);

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
      lines.push('- Current room verification: `ownerInRoom=true`, speaker is a non-owner member/guest. For owner-gated actions (such as account provisioning), gather the required parameters and open `ticket_create(kind="action_approval")` for 1-tap owner approval — do NOT execute before approval.');
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
        const nextNote = input.summary ? [existing.summary, redactTicketText(input.summary, 1000)].filter(Boolean).join('\n\n') : existing.summary;
        const updated = {
          ...existing,
          summary: nextNote,
          actionSpec: input.actionSpec ? redactTicketPayload(input.actionSpec) : existing.actionSpec,
          payload: input.payload ? { ...(existing.payload || {}), ...redactTicketPayload(input.payload) } : existing.payload,
          updatedAt: now,
        };
        saveRecord(updated);
        return { ok: true, deduplicated: true, ticket: updated };
      }
      const prefix = kind === 'bug_feedback' ? 'FB' : 'TK';
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
        approverRole: normalizeApproverRole(input.approverRole, kind),
        approvedBy: null,
        approvedAt: null,
        decisionNote: null,
        actionSpec: input.actionSpec ? redactTicketPayload(input.actionSpec) : null,
        executionReceipt: null,
        payload: input.payload ? redactTicketPayload(input.payload) : {},
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

    update(idOrCode, patch = {}) {
      const cur = this.find(idOrCode);
      if (!cur) return { ok: false, code: 'TICKET_NOT_FOUND' };
      const now = Date.now();
      const updated = {
        ...cur,
        title: patch.title ? redactTicketText(patch.title, 140) : cur.title,
        summary: patch.note ? [cur.summary, redactTicketText(patch.note, 1000)].filter(Boolean).join('\n\n') : cur.summary,
        actionSpec: patch.actionSpec ? redactTicketPayload(patch.actionSpec) : cur.actionSpec,
        payload: patch.payloadPatch ? { ...(cur.payload || {}), ...redactTicketPayload(patch.payloadPatch) } : cur.payload,
        updatedAt: now,
      };
      saveRecord(updated);
      return { ok: true, ticket: updated };
    },

    transition(idOrCode, { status, actorRole = 'agent', actorId = null, note = null, receipt = null } = {}) {
      const cur = this.find(idOrCode);
      if (!cur) return { ok: false, code: 'TICKET_NOT_FOUND' };
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
      const updated = {
        ...cur,
        status: check.to,
        approvedBy: isApproval ? (actorId || actorRole) : cur.approvedBy,
        approvedAt: isApproval ? now : cur.approvedAt,
        decisionNote: note ? redactTicketText(note, 500) : cur.decisionNote,
        executionReceipt: receipt ? redactTicketPayload(receipt) : cur.executionReceipt,
        updatedAt: now,
      };
      saveRecord(updated);
      return { ok: true, ticket: updated };
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
