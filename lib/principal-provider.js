// SCROLL 2.8 -- sec 54 Cross-Surface Principal Identity & Strict Isolation (`PrincipalProvider`).
// Zero-dep, pure ASCII, Node >= 20.
//
// Maps verified external surface identities (web, telegram, zalo, slack, messenger, voice)
// onto a canonical `principalId` so the same verified user shares DM memory across surfaces,
// while strictly isolating unlinked/external senders so they can never inherit owner trust
// or collide across surfaces.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PRINCIPAL_STORE_SCHEMA = 'scroll-principal-store/v1';

const VALID_ROLES = new Set(['owner', 'internal', 'member']);

function normSurface(surface) {
  return String(surface || 'web').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'web';
}

function normExtId(externalId) {
  const s = String(externalId ?? '').trim();
  if (!s || s === '*' || /[\r\n\0]/.test(s)) {
    throw new Error(`ERR_INVALID_EXTERNAL_ID:${s}`);
  }
  return s;
}

function normPrincipalId(principalId) {
  const s = String(principalId ?? '').trim();
  if (!s || s === '*' || /[\r\n\0\s]/.test(s)) {
    throw new Error(`ERR_INVALID_PRINCIPAL_ID:${s}`);
  }
  return s;
}

function bindingKey(surface, externalId) {
  return `${normSurface(surface)}:${normExtId(externalId)}`;
}

function writeAtomicJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export function createPrincipalProvider({
  storePath = null,
  ownerPrincipalId = null,
  initialLinks = [],
  now = () => new Date(),
} = {}) {
  const absStore = storePath ? path.resolve(String(storePath)) : null;
  const ownerId = ownerPrincipalId ? normPrincipalId(ownerPrincipalId) : null;

  let state = {
    schema: PRINCIPAL_STORE_SCHEMA,
    ownerPrincipalId: ownerId,
    links: {},
  };

  if (absStore && fs.existsSync(absStore)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(absStore, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.links && typeof parsed.links === 'object') {
        state = {
          schema: PRINCIPAL_STORE_SCHEMA,
          ownerPrincipalId: ownerId || parsed.ownerPrincipalId || null,
          links: { ...parsed.links },
        };
      }
    } catch { /* start clean if unreadable */ }
  }

  function persist() {
    if (!absStore) return;
    writeAtomicJson(absStore, state);
  }

  function linkIdentity({
    principalId,
    surface,
    externalId,
    role = null,
    verifiedBy = 'owner',
    label = null,
    force = false,
  } = {}) {
    const pid = normPrincipalId(principalId);
    const surf = normSurface(surface);
    const ext = normExtId(externalId);
    const key = `${surf}:${ext}`;
    const existing = state.links[key];

    if (existing && existing.principalId !== pid && !force) {
      const err = new Error(`ERR_IDENTITY_ALREADY_BOUND:${key}->${existing.principalId}`);
      err.code = 'ERR_IDENTITY_ALREADY_BOUND';
      throw err;
    }

    const effectiveRole = role
      ? (VALID_ROLES.has(String(role)) ? String(role) : 'member')
      : (state.ownerPrincipalId && pid === state.ownerPrincipalId ? 'owner' : 'internal');

    const record = {
      key,
      principalId: pid,
      surface: surf,
      externalId: ext,
      role: effectiveRole,
      verifiedBy: String(verifiedBy || 'owner'),
      verifiedAt: now().toISOString(),
      label: label ? String(label).trim() : null,
    };
    state.links[key] = record;
    persist();
    return { ...record };
  }

  function unlinkIdentity({ surface, externalId } = {}) {
    const key = bindingKey(surface, externalId);
    if (!Object.prototype.hasOwnProperty.call(state.links, key)) {
      return { removed: false, key };
    }
    delete state.links[key];
    persist();
    return { removed: true, key };
  }

  function getPrincipal({ surface, externalId } = {}) {
    if (externalId == null || String(externalId).trim() === '') return null;
    const key = bindingKey(surface, externalId);
    const rec = state.links[key];
    return rec ? { ...rec } : null;
  }

  function listIdentities(principalId = null) {
    const all = Object.values(state.links).map((r) => ({ ...r }));
    if (!principalId) return all;
    const target = normPrincipalId(principalId);
    return all.filter((r) => r.principalId === target);
  }

  function resolveTurnIdentity({
    surface = 'web',
    senderId,
    senderName = null,
    roomId = null,
    isGroup = false,
  } = {}) {
    const surf = normSurface(surface);
    const rawSender = String(senderId ?? '').trim();
    const binding = rawSender ? getPrincipal({ surface: surf, externalId: rawSender }) : null;

    if (binding) {
      const isOwner = Boolean(
        binding.role === 'owner'
        || (state.ownerPrincipalId && binding.principalId === state.ownerPrincipalId),
      );
      const trust = isOwner ? 'owner' : (binding.role === 'internal' ? 'internal' : 'external');
      return {
        linked: true,
        surface: surf,
        principalId: binding.principalId,
        role: binding.role,
        isOwner,
        trust,
        memoryUserId: binding.principalId,
        crossSurfaceUser: true,
        memoryChannel: isGroup ? surf : 'unified',
        roomId: roomId != null ? String(roomId) : null,
        isGroup: Boolean(isGroup),
        effectiveSender: {
          id: binding.principalId,
          channelId: `${surf}:${rawSender}`,
          name: senderName || binding.label || binding.principalId,
          isOwner,
        },
      };
    }

    // Strictly isolated unlinked/external identity -- never collides across surfaces or with owner
    const isolatedId = rawSender ? `ext_${surf}_${rawSender}` : `ext_${surf}_anonymous`;
    return {
      linked: false,
      surface: surf,
      principalId: null,
      role: 'external',
      isOwner: false,
      trust: 'external',
      memoryUserId: isolatedId,
      crossSurfaceUser: false,
      memoryChannel: surf,
      roomId: roomId != null ? String(roomId) : null,
      isGroup: Boolean(isGroup),
      effectiveSender: {
        id: isolatedId,
        channelId: `${surf}:${rawSender || 'anonymous'}`,
        name: senderName || null,
        isOwner: false,
      },
    };
  }

  for (const link of Array.isArray(initialLinks) ? initialLinks : []) {
    if (link && link.principalId && link.surface && link.externalId) {
      linkIdentity({ ...link, force: true });
    }
  }

  return {
    get ownerPrincipalId() { return state.ownerPrincipalId; },
    linkIdentity,
    unlinkIdentity,
    getPrincipal,
    listIdentities,
    resolveTurnIdentity,
  };
}
