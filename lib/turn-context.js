// SCROLL 2.16.1 -- Immutable Token-Bound Fail-Closed Turn Context Registry.
// Zero-dep, pure ASCII, Node >= 20.
//
// Eliminates shared mutable `activeTurn` slots per agent so concurrent or overlapping
// interactive group turns and background durable-job slices NEVER leak privileges or
// fall back to Owner DM when a turn completes or clears its context.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_TURN_TIMEOUT_MS = 480_000;
export const DEFAULT_TURN_TOKEN_GRACE_MS = 60_000;
export const BACKGROUND_SLICE_DEFAULT_MS = 150_000;
export const BACKGROUND_SLICE_MAX_MS = 180_000;

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

export function normalizeTurnContext(raw = {}, { nowMs = Date.now(), ttlMs = null } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const turnTimeoutMs = Math.max(10_000, Number(src.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS));
  const minTtl = turnTimeoutMs + DEFAULT_TURN_TOKEN_GRACE_MS;
  const effTtl = Math.max(minTtl, Number(ttlMs || src.ttlMs || minTtl));
  const issuedAt = nowMs;
  const expiresAt = issuedAt + effTtl;
  const surface = String(src.surface || 'web').trim().toLowerCase() || 'web';
  const isGroup = Boolean(src.isGroup);
  const isOwner = Boolean(src.isOwner);
  const ownerInRoom = isGroup ? Boolean(src.ownerInRoom) : isOwner;

  return deepFreeze({
    turnId: String(src.turnId || `trn_${crypto.randomBytes(6).toString('hex')}`),
    agentId: src.agentId ? String(src.agentId).trim() : null,
    tenantId: src.tenantId ? String(src.tenantId).trim() : null,
    surface,
    chatId: src.chatId != null && String(src.chatId).trim() ? String(src.chatId).trim() : null,
    threadId: src.threadId != null && String(src.threadId).trim() ? String(src.threadId).trim() : null,
    isGroup,
    isOwner,
    ownerInRoom,
    isBackgroundSlice: Boolean(src.isBackgroundSlice),
    senderId: src.senderId != null && String(src.senderId).trim() ? String(src.senderId).trim() : null,
    senderName: src.senderName ? String(src.senderName).trim().slice(0, 120) : null,
    approvedTicketId: src.approvedTicketId ? String(src.approvedTicketId).trim() : null,
    approvedSpecHash: src.approvedSpecHash ? String(src.approvedSpecHash).trim() : null,
    jobId: src.jobId ? String(src.jobId).trim() : null,
    jobEpoch: src.jobEpoch != null ? Number(src.jobEpoch) : null,
    allowedTools: Array.isArray(src.allowedTools) ? [...new Set(src.allowedTools.map(String))] : null,
    turnTimeoutMs,
    issuedAt,
    expiresAt,
  });
}

export function computeTurnTokenTtlMs({
  turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  graceMs = DEFAULT_TURN_TOKEN_GRACE_MS,
} = {}) {
  return Math.max(10_000, Number(turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS))
    + Math.max(5_000, Number(graceMs || DEFAULT_TURN_TOKEN_GRACE_MS));
}

export function clampBackgroundSliceMs(rawMs = BACKGROUND_SLICE_DEFAULT_MS) {
  const n = Number(rawMs);
  if (!Number.isFinite(n) || n <= 0) return BACKGROUND_SLICE_DEFAULT_MS;
  return Math.max(15_000, Math.min(BACKGROUND_SLICE_MAX_MS, Math.round(n)));
}

/**
 * Token-bound fail-closed Turn Context Registry.
 * Every turn gets its own cryptographically opaque `turnToken`. Missing, revoked, or expired
 * tokens ALWAYS fail closed (`ok: false`) and NEVER default to Owner DM.
 */
export function createTurnContextRegistry({
  clock = () => Date.now(),
  maxEntries = 4096,
} = {}) {
  const tokens = new Map(); // token -> { context, revoked }
  const als = new AsyncLocalStorage();

  function sweepExpired(nowMs = clock()) {
    for (const [tok, rec] of tokens.entries()) {
      if (rec.revoked || nowMs >= rec.context.expiresAt) {
        tokens.delete(tok);
      }
    }
    while (tokens.size > maxEntries) {
      const oldestKey = tokens.keys().next().value;
      if (oldestKey === undefined) break;
      tokens.delete(oldestKey);
    }
  }

  function issue(rawContext = {}, { ttlMs = null } = {}) {
    const nowMs = clock();
    sweepExpired(nowMs);
    const context = normalizeTurnContext(rawContext, { nowMs, ttlMs });
    const token = `tt_${crypto.randomBytes(16).toString('hex')}`;
    tokens.set(token, { context, revoked: false });
    return { token, context };
  }

  function resolve(token) {
    if (!token || typeof token !== 'string') {
      return { ok: false, code: 'ERR_TURN_CONTEXT_MISSING', context: null };
    }
    const rec = tokens.get(token);
    if (!rec) {
      return { ok: false, code: 'ERR_TURN_CONTEXT_UNKNOWN', context: null };
    }
    if (rec.revoked) {
      return { ok: false, code: 'ERR_TURN_CONTEXT_REVOKED', context: null };
    }
    if (clock() >= rec.context.expiresAt) {
      tokens.delete(token);
      return { ok: false, code: 'ERR_TURN_CONTEXT_EXPIRED', context: null };
    }
    return { ok: true, code: 'OK', context: rec.context };
  }

  function requireContext(token) {
    const res = resolve(token);
    if (!res.ok) {
      const err = new Error(`${res.code}: fail-closed turn context required`);
      err.code = res.code;
      throw err;
    }
    return res.context;
  }

  function revoke(token) {
    const rec = tokens.get(token);
    if (!rec) return false;
    rec.revoked = true;
    tokens.delete(token);
    return true;
  }

  async function runWithContext(rawContext, fn, { ttlMs = null } = {}) {
    const { token, context } = issue(rawContext, { ttlMs });
    try {
      return await als.run({ token, context }, () => fn({ token, context }));
    } finally {
      revoke(token);
    }
  }

  function current() {
    const store = als.getStore();
    if (!store) return { ok: false, code: 'ERR_TURN_CONTEXT_MISSING', context: null };
    return resolve(store.token);
  }

  return {
    issue,
    resolve,
    requireContext,
    revoke,
    runWithContext,
    current,
    size: () => {
      sweepExpired();
      return tokens.size;
    },
  };
}
