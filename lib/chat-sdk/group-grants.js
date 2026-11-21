// SCROLL 2.5 -- Room-Agnostic Owner-Delegated Group Session Grants.
//
// Scoped, time-bounded, auditable, and revocable tool delegation for multi-participant rooms
// (Slack channels, Discord channels, Telegram groups, Web rooms, etc.).
//
// Security invariants:
//   - Only a verified owner (verified by caller/host) may grant or revoke.
//   - Grants are bound to an explicit roomId (NOT assuming Telegram negative numeric IDs!),
//     an explicit `allowedTools` allowlist, and a bounded TTL (5-480 minutes).
//   - Private owner data (USER.md # About, principal memory) is NEVER unlocked by a group grant.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_DELEGATED_GROUP_TOOLS = Object.freeze([
  'web_search',
  'web_fetch',
  'knowledge_search',
  'start_long_task',
  'long_task_status',
  'cancel_long_task',
]);

const DEFAULT_OWNER_DELEGATION_RE = /\b(?:allow\s+(?:bot|agent|assistant)\s+(?:tools?|exec|test|actions?)|grant\s+(?:group|room)\s+tools?)\b/i;

export function matchesOwnerDelegationPhrase(text, extraPatterns = []) {
  const s = String(text || '');
  if (DEFAULT_OWNER_DELEGATION_RE.test(s)) return true;
  for (const pat of extraPatterns || []) {
    if (pat instanceof RegExp && pat.test(s)) return true;
  }
  return false;
}

export function createGroupGrantStore({
  filePath = null,
  defaultAllowedTools = DEFAULT_DELEGATED_GROUP_TOOLS,
  clock = () => Date.now(),
} = {}) {
  const absPath = filePath ? path.resolve(filePath) : null;

  function load() {
    if (!absPath || !fs.existsSync(absPath)) return { grants: {} };
    try {
      const j = JSON.parse(fs.readFileSync(absPath, 'utf8'));
      return { grants: j.grants && typeof j.grants === 'object' ? { ...j.grants } : {} };
    } catch {
      return { grants: {} };
    }
  }

  let state = load();

  function persist() {
    if (!absPath) return;
    fs.mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o700 });
    const tmp = `${absPath}.tmp.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, absPath);
  }

  function grant({
    roomId = null,
    chatId = null,
    isGroup = null,
    grantedBy,
    ttlMinutes = 60,
    allowedTools = defaultAllowedTools,
    note = '',
  } = {}) {
    const id = String(roomId ?? chatId ?? '').trim();
    if (!id) throw new Error('group_grant_requires_room_id');
    // Support explicit boolean `isGroup` for any platform (Slack/Discord/Web/Telegram).
    // If caller omits `isGroup` and passes legacy `chatId` only, allow any non-empty id unless `isGroup === false`.
    if (isGroup === false) {
      throw new Error('group_grant_requires_group_room');
    }
    if (!grantedBy || !String(grantedBy).trim()) {
      throw new Error('group_grant_requires_granted_by');
    }
    const mins = Math.max(5, Math.min(480, Number(ttlMinutes || 60)));
    const nowMs = clock();
    const record = {
      roomId: id,
      chatId: id,
      grantedBy: String(grantedBy),
      allowedTools: [...new Set((allowedTools || defaultAllowedTools).map(String))],
      grantedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + mins * 60_000).toISOString(),
      ttlMinutes: mins,
      note: String(note || '').slice(0, 200),
    };
    state.grants[id] = record;
    persist();
    return { ...record };
  }

  function revoke(roomOrChatId) {
    const key = String(roomOrChatId || '').trim();
    if (!key || !state.grants[key]) return { ok: false, removed: false };
    delete state.grants[key];
    persist();
    return { ok: true, removed: true, roomId: key, chatId: key };
  }

  function getActiveGrant(roomOrChatId) {
    const key = String(roomOrChatId || '').trim();
    const g = state.grants[key];
    if (!g) return null;
    if (Date.parse(g.expiresAt) <= clock()) {
      delete state.grants[key];
      persist();
      return null;
    }
    return {
      ...g,
      roomId: g.roomId || key,
      chatId: g.chatId || key,
      remainingMinutes: Math.max(1, Math.ceil((Date.parse(g.expiresAt) - clock()) / 60_000)),
    };
  }

  function listActiveGrants() {
    const out = [];
    const nowMs = clock();
    let pruned = false;
    for (const [k, g] of Object.entries(state.grants)) {
      if (Date.parse(g.expiresAt) <= nowMs) {
        delete state.grants[k];
        pruned = true;
      } else {
        out.push({
          ...g,
          roomId: g.roomId || k,
          chatId: g.chatId || k,
          remainingMinutes: Math.max(1, Math.ceil((Date.parse(g.expiresAt) - nowMs) / 60_000)),
        });
      }
    }
    if (pruned) persist();
    return out;
  }

  return {
    grant,
    revoke,
    getActiveGrant,
    listActiveGrants,
  };
}
