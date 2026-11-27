// SCROLL 2.8 -- sec 55 Opt-In Companion Remote Tool Transport & Desktop Mutex (`RemoteToolTransport`).
// Zero-dep, pure ASCII, Node >= 20.
//
// Enables a cloud-hosted SCROLL agent to invoke opt-in local tools on a user's machine through
// a reverse transport while enforcing ALL security policy on the local Companion Host:
//   - Local kill switch (`setPaused(true)`)
//   - Monotonic fencing `epoch` (rejects stale-host calls)
//   - Strict local tool allowlist & path-root sandbox
//   - Local HITL approval for high-risk tiers (`external_comm`, `financial`, `destructive`)
//   - Per-machine `DesktopMutex` preventing GUI/mouse/keyboard collisions across agents
//   - Durable cloud-side dispatch ledger marking post-dispatch disconnects on side-effecting
//     tools as `unknown` (`retrySafe: false`) to prevent duplicate side effects
//   - Tamper-evident hash-chained local audit log
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REMOTE_CALL_SCHEMA = 'scroll-remote-tool-call/v1';
export const REMOTE_JOB_SCHEMA = 'scroll-remote-job/v1';

export const REMOTE_JOB_STATUSES = Object.freeze([
  'accepted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
]);

export const DEFAULT_REMOTE_JOB_RETENTION_MS = 31 * 24 * 60 * 60 * 1000; // 30d horizon + 1d recovery

function canonicalHash(value) {
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

const REMOTE_JOB_TERMINAL_SET = Object.freeze(new Set(['succeeded', 'failed', 'cancelled']));

/**
 * sec 62b: Durable Companion Async Remote Job Ledger (`scroll-remote-job/v1`).
 * Persists `(tenantId, deploymentId, deviceId, operationId, tool, argsHash, status)` BEFORE
 * returning HTTP 202 Accepted, retains receipts through horizon + recovery window (default 31 days),
 * marks crashed non-terminal jobs `unknown` on reload, strictly scopes lookups by `deploymentId`,
 * and rejects conflicting `tool/deviceId/argsHash` reuse.
 */
export function createAsyncRemoteJobLedger({
  filePath = null,
  retentionMs = DEFAULT_REMOTE_JOB_RETENTION_MS,
  now = () => Date.now(),
} = {}) {
  const absPath = filePath ? path.resolve(String(filePath)) : null;
  const byOpId = new Map();       // `${deploymentId}:${operationId}` -> rec
  const byRemoteJobId = new Map(); // remoteJobId -> rec

  function isExpiredTerminal(rec, nowMs = now()) {
    return Boolean(rec && REMOTE_JOB_TERMINAL_SET.has(rec.status) && rec.expiresAtMs && nowMs >= Number(rec.expiresAtMs));
  }

  function persist(rec) {
    // Write durably BEFORE advancing in-memory indexes (H6)
    appendJsonl(absPath, rec);
    byOpId.set(`${rec.deploymentId}:${rec.operationId}`, rec);
    byRemoteJobId.set(rec.remoteJobId, rec);
  }

  function load() {
    if (!absPath || !fs.existsSync(absPath)) return;
    const nowMs = now();
    const rows = readJsonlSafe(absPath);
    for (const row of rows) {
      if (!row || !row.operationId || !row.remoteJobId) continue;
      byOpId.set(`${row.deploymentId}:${row.operationId}`, row);
      byRemoteJobId.set(row.remoteJobId, row);
    }
    // Crash recovery (P1-21): any record left in `accepted` or `running` when companion died
    // cannot still be running in a freshly booted process -> mark `unknown` durably.
    for (const rec of [...byRemoteJobId.values()]) {
      if (isExpiredTerminal(rec, nowMs)) {
        byOpId.delete(`${rec.deploymentId}:${rec.operationId}`);
        byRemoteJobId.delete(rec.remoteJobId);
        continue;
      }
      if (rec.status === 'accepted' || rec.status === 'running') {
        const recovered = {
          ...rec,
          status: 'unknown',
          error: rec.error || 'ERR_COMPANION_RESTARTED_IN_FLIGHT',
          updatedAtMs: nowMs,
        };
        persist(recovered);
      }
    }
  }
  load();

  function computeIdentityHash({ tool = '', deviceId = 'unknown', args = {} } = {}) {
    return canonicalHash({
      tool: String(tool || ''),
      deviceId: String(deviceId || 'unknown'),
      args: args && typeof args === 'object' ? args : {},
    });
  }

  function accept({
    tenantId = 'default',
    deploymentId,
    deviceId,
    operationId,
    tool,
    args = {},
    pollAfterSec = 15,
  } = {}) {
    const opId = String(operationId || '').trim();
    const depId = String(deploymentId || '').trim();
    if (!opId) return { ok: false, code: 'ERR_OPERATION_ID_REQUIRED' };
    if (!depId) return { ok: false, code: 'ERR_DEPLOYMENT_ID_REQUIRED' };
    const argsHash = computeIdentityHash({ tool, deviceId, args });
    const key = `${depId}:${opId}`;
    const existing = byOpId.get(key);
    const nowMs = now();
    if (existing && !isExpiredTerminal(existing, nowMs)) {
      if (existing.argsHash !== argsHash) {
        return { ok: false, code: 'ERR_OPERATION_CONFLICT', operationId: opId };
      }
      return { ok: true, idempotent: true, record: { ...existing } };
    }
    const rec = {
      schema: REMOTE_JOB_SCHEMA,
      remoteJobId: `rj_${crypto.randomBytes(6).toString('hex')}`,
      operationId: opId,
      tenantId: String(tenantId || 'default'),
      deploymentId: depId,
      deviceId: String(deviceId || 'unknown'),
      tool: String(tool || ''),
      argsHash,
      status: 'accepted',
      cancelRequested: false,
      pollAfterSec: Math.max(5, Math.min(300, Math.round(Number(pollAfterSec || 15)))),
      receipt: null,
      error: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + Math.max(60_000, Number(retentionMs || DEFAULT_REMOTE_JOB_RETENTION_MS)),
    };
    persist(rec);
    return { ok: true, idempotent: false, record: { ...rec } };
  }

  function updateStatus(idOrOp, { deploymentId = null, status, receipt = null, error = null, cancelRequested = null } = {}) {
    const rec = lookup(idOrOp, { deploymentId });
    if (!rec) return { ok: false, code: 'ERR_REMOTE_JOB_NOT_FOUND' };
    if (!REMOTE_JOB_STATUSES.includes(status)) return { ok: false, code: 'ERR_INVALID_REMOTE_JOB_STATUS' };
    if (REMOTE_JOB_TERMINAL_SET.has(rec.status)) {
      return { ok: true, alreadyTerminal: true, record: { ...rec } };
    }
    const updated = {
      ...rec,
      status,
      cancelRequested: cancelRequested !== null ? Boolean(cancelRequested) : Boolean(rec.cancelRequested),
      receipt: receipt !== null && receipt !== undefined ? receipt : rec.receipt,
      error: error !== null && error !== undefined ? String(error) : rec.error,
      updatedAtMs: now(),
    };
    persist(updated);
    return { ok: true, record: { ...updated } };
  }

  function lookup(idOrOp, { deploymentId = null } = {}) {
    const key = String(idOrOp || '').trim();
    const dep = deploymentId != null && String(deploymentId).trim() ? String(deploymentId).trim() : null;
    if (!key || !dep) return null;
    const nowMs = now();
    if (byRemoteJobId.has(key)) {
      const hit = byRemoteJobId.get(key);
      // Strictly enforce deployment isolation on remoteJobId lookups too (B5)
      if (hit.deploymentId !== dep) return null;
      if (isExpiredTerminal(hit, nowMs)) return null;
      return { ...hit };
    }
    const opHit = byOpId.get(`${dep}:${key}`);
    if (opHit && !isExpiredTerminal(opHit, nowMs)) {
      return { ...opHit };
    }
    return null;
  }

  function compact({ nowMs = now() } = {}) {
    let pruned = 0;
    const kept = [];
    for (const rec of [...byRemoteJobId.values()]) {
      if (isExpiredTerminal(rec, nowMs)) {
        byOpId.delete(`${rec.deploymentId}:${rec.operationId}`);
        byRemoteJobId.delete(rec.remoteJobId);
        pruned += 1;
      } else {
        kept.push(rec);
      }
    }
    if (absPath && pruned > 0) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o700 });
      const tmp = `${absPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, absPath);
    }
    return { ok: true, pruned, retained: kept.length };
  }

  return {
    isDurable: Boolean(absPath),
    computeIdentityHash,
    accept,
    updateStatus,
    lookup,
    compact,
  };
}

export const HIGH_RISK_REMOTE_TIERS = Object.freeze(new Set([
  'external_comm',
  'financial',
  'destructive',
]));

/**
 * Two-level Deficit Round-Robin Fair-Share queue keyed by physical resource identity
 * (`physicalResourceId`, e.g. a Mac and a windowed VM on that Mac share one physical resource).
 * Prevents a heavy Group A from starving Group B before entering `DesktopMutex`.
 */
export function createFairShareResourceQueue({
  maxPerGroupInFlight = 1,
  maxPerGroupQueued = 8,
  quantumMs = 15_000,
  agingMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const resources = new Map(); // physicalResourceId -> { inFlightByGroup: Map, queuesByGroup: Map, order: [], deficit: Map, occupiedMs: Map }

  function getRes(physId) {
    const key = String(physId || 'default');
    if (!resources.has(key)) {
      resources.set(key, {
        inFlightTotal: 0,
        inFlightByGroup: new Map(),
        queuesByGroup: new Map(), // `${tenantId}:${groupId}` -> entry[]
        groupOrder: [],
        deficit: new Map(),
        occupiedMsByGroup: new Map(),
        lastServedKey: null,
      });
    }
    return resources.get(key);
  }

  function groupKey(tenantId, groupId) {
    return `${String(tenantId || 'default')}:${String(groupId || 'dm')}`;
  }

  function pump(physId) {
    const r = getRes(physId);
    if (r.inFlightTotal >= 1) return;
    const nowMs = now();

    // Check aging boost first: if any group has an eligible entry older than agingMs, prioritize oldest
    let chosenKey = null;
    let oldestAge = -1;
    for (const gk of r.groupOrder) {
      const q = r.queuesByGroup.get(gk);
      if (!q || q.length === 0) continue;
      if ((r.inFlightByGroup.get(gk) || 0) >= maxPerGroupInFlight) continue;
      const age = nowMs - q[0].enqueuedAt;
      if (age >= agingMs && age > oldestAge) {
        oldestAge = age;
        chosenKey = gk;
      }
    }

    // Standard Deficit Round-Robin selection across non-empty groups
    // Avoid granting two consecutive slots to the same group while peer groups are waiting.
    if (!chosenKey && r.lastServedKey && r.groupOrder.length > 1 && r.groupOrder[0] === r.lastServedKey) {
      r.groupOrder.push(r.groupOrder.shift());
    }
    if (!chosenKey) {
      for (let round = 0; round < r.groupOrder.length * 2; round++) {
        if (r.groupOrder.length === 0) break;
        const gk = r.groupOrder.shift();
        const q = r.queuesByGroup.get(gk);
        if (!q || q.length === 0) {
          r.queuesByGroup.delete(gk);
          r.deficit.delete(gk);
          continue;
        }
        r.groupOrder.push(gk);
        if ((r.inFlightByGroup.get(gk) || 0) >= maxPerGroupInFlight) continue;
        const curDef = (r.deficit.get(gk) || 0) + quantumMs;
        r.deficit.set(gk, curDef);
        if (curDef >= q[0].estimatedMs) {
          r.deficit.set(gk, curDef - q[0].estimatedMs);
          chosenKey = gk;
          break;
        }
      }
    }

    if (!chosenKey) return;
    const q = r.queuesByGroup.get(chosenKey);
    const entry = q.shift();
    if (q.length === 0) {
      r.queuesByGroup.delete(chosenKey);
      r.groupOrder = r.groupOrder.filter((k) => k !== chosenKey);
    }

    const grantedAt = now();
    r.lastServedKey = chosenKey;
    r.inFlightTotal += 1;
    r.inFlightByGroup.set(chosenKey, (r.inFlightByGroup.get(chosenKey) || 0) + 1);
    let released = false;

    entry.resolve({
      ok: true,
      physicalResourceId: String(physId || 'default'),
      groupKey: chosenKey,
      waitedMs: Math.max(0, grantedAt - entry.enqueuedAt),
      release: () => {
        if (released) return false;
        released = true;
        const usedMs = Math.max(1, now() - grantedAt);
        r.occupiedMsByGroup.set(chosenKey, (r.occupiedMsByGroup.get(chosenKey) || 0) + usedMs);
        r.inFlightTotal = Math.max(0, r.inFlightTotal - 1);
        const cur = Math.max(0, (r.inFlightByGroup.get(chosenKey) || 1) - 1);
        if (cur === 0) r.inFlightByGroup.delete(chosenKey);
        else r.inFlightByGroup.set(chosenKey, cur);
        pump(physId);
        return true;
      },
    });
  }

  function acquire({
    physicalResourceId = 'default',
    tenantId = 'default',
    groupId = 'dm',
    estimatedMs = quantumMs,
    signal = null,
  } = {}) {
    if (signal?.aborted) {
      return Promise.resolve({ ok: false, code: 'ERR_FAIR_SHARE_ABORTED' });
    }
    const r = getRes(physicalResourceId);
    const gk = groupKey(tenantId, groupId);
    const q = r.queuesByGroup.get(gk) || [];
    if (q.length >= maxPerGroupQueued) {
      return Promise.resolve({
        ok: false,
        code: 'ERR_FAIR_SHARE_GROUP_QUEUE_FULL',
        groupKey: gk,
        maxPerGroupQueued,
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      const entry = {
        enqueuedAt: now(),
        estimatedMs: Math.max(100, Math.min(quantumMs, Number(estimatedMs || quantumMs))),
        resolve: (val) => {
          if (settled) {
            if (val && typeof val.release === 'function') val.release();
            return;
          }
          settled = true;
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
      };
      const onAbort = signal
        ? () => {
            if (settled) return;
            settled = true;
            const curQ = r.queuesByGroup.get(gk);
            if (curQ) {
              const idx = curQ.indexOf(entry);
              if (idx >= 0) curQ.splice(idx, 1);
              if (curQ.length === 0) {
                r.queuesByGroup.delete(gk);
                r.groupOrder = r.groupOrder.filter((k) => k !== gk);
              }
            }
            resolve({ ok: false, code: 'ERR_FAIR_SHARE_ABORTED' });
          }
        : null;
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });

      if (!r.queuesByGroup.has(gk)) {
        r.queuesByGroup.set(gk, [entry]);
        r.groupOrder.push(gk);
      } else {
        r.queuesByGroup.get(gk).push(entry);
      }
      pump(physicalResourceId);
    });
  }

  function getStats(physicalResourceId = 'default') {
    const r = getRes(physicalResourceId);
    const nowMs = now();
    let oldestEligibleAgeMs = 0;
    const queuedByGroup = {};
    for (const [gk, q] of r.queuesByGroup.entries()) {
      queuedByGroup[gk] = q.length;
      if (q.length > 0) {
        oldestEligibleAgeMs = Math.max(oldestEligibleAgeMs, Math.max(0, nowMs - q[0].enqueuedAt));
      }
    }
    return {
      physicalResourceId: String(physicalResourceId || 'default'),
      inFlightTotal: r.inFlightTotal,
      queuedByGroup,
      occupiedMsByGroup: Object.fromEntries(r.occupiedMsByGroup.entries()),
      oldestEligibleAgeMs,
    };
  }

  return { acquire, getStats };
}

export function normalizeCompanionBinding(raw = null) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const list = [];
  const seen = new Set();
  const pushId = (v) => {
    const clean = String(v || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    list.push(clean);
  };
  if (Array.isArray(obj.deviceIds)) {
    for (const id of obj.deviceIds) pushId(id);
  }
  if (obj.deviceId) pushId(obj.deviceId);
  return {
    enabled: Boolean(obj.enabled) && list.length > 0,
    deviceId: list[0] || null,
    deviceIds: list,
    updatedAt: obj.updatedAt ? String(obj.updatedAt) : null,
  };
}

export function isRemoteToolAllowedInContext(spec, { isGroup = false, isOwner = false } = {}) {
  if (!spec || !spec.name) return false;
  if (!isOwner) return false;
  if (!isGroup) return true;
  const risk = String(spec.risk || 'reversible_write').trim().toLowerCase();
  if (HIGH_RISK_REMOTE_TIERS.has(risk)) return false;
  return spec.ownerGroupSafe === true || spec.groupScope === 'owner_in_group';
}

export function buildCompanionCapabilitiesPrompt({
  devices = [],
  tools = [],
  turnCtx = {},
  internalTools = ['companion_read_media', 'system_action_run'],
} = {}) {
  if (!turnCtx || !turnCtx.isOwner) return '';
  const isGroup = Boolean(turnCtx.isGroup);
  const internalSet = new Set(Array.isArray(internalTools) ? internalTools : []);
  const deviceList = Array.isArray(devices) ? devices.filter((d) => d && d.deviceId) : [];
  const deviceMeta = new Map(deviceList.map((d) => [String(d.deviceId), d]));

  const callable = [];
  const seenNames = new Set();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || !t.name || internalSet.has(t.name) || seenNames.has(t.name)) continue;
    if (!isRemoteToolAllowedInContext(t, { isGroup, isOwner: true })) continue;
    seenNames.add(t.name);
    callable.push(t);
  }

  const offlineDevices = deviceList.filter((d) => !d.online);
  if (callable.length === 0 && offlineDevices.length === 0) return '';

  const grouped = new Map();
  for (const t of callable) {
    const devId = String(t.deviceId || deviceList.find((d) => d.online)?.deviceId || 'companion');
    const grpId = String(t.group || 'companion');
    const key = `${devId}::${grpId}`;
    if (!grouped.has(key)) {
      const dm = deviceMeta.get(devId);
      grouped.set(key, {
        deviceId: devId,
        platform: dm?.platform || null,
        groupId: grpId,
        groupName: String(t.groupName || grpId),
        groupSummary: String(t.groupSummary || ''),
        tools: [],
      });
    }
    const bucket = grouped.get(key);
    if (!bucket.groupSummary && t.groupSummary) bucket.groupSummary = String(t.groupSummary);
    bucket.tools.push(String(t.name));
  }

  const lines = [
    `## Connected Companion Capabilities (${isGroup ? 'Owner-Authorized Group Scope' : 'Owner Direct Scope'})`,
  ];

  for (const b of grouped.values()) {
    const plat = b.platform ? `, ${b.platform}` : '';
    const summary = b.groupSummary ? ` -- ${b.groupSummary.slice(0, 180)}` : '';
    lines.push(`- ${b.groupName} [device: ${b.deviceId}${plat} | online]: \`${b.tools.join('`, `')}\`${summary}`);
  }

  for (const d of offlineDevices) {
    const plat = d.platform ? `, ${d.platform}` : '';
    lines.push(`- Companion device \`${d.deviceId}\`${plat ? ` (${plat.slice(2)})` : ''} is currently OFFLINE (cannot reach its tools until woken).`);
  }

  lines.push(
    '- Rules: The online Companion tools above are REAL and callable in this turn. Call the matching tool directly before claiming you cannot access a local browser, VM, or desktop app.',
    '- If a required Companion device or VM is offline/unreachable, report the exact device/VM status plainly so the owner can wake it -- never claim the capability does not exist.',
    '- Never echo user passwords, OTPs, or secrets in replies, never bypass CAPTCHAs autonomously, and never execute high-risk/financial/submission actions without explicit owner approval.',
  );

  return lines.join('\n');
}

const STRICT_PATH_ARG_KEYS = new Set([
  'path', 'file', 'filepath', 'file_path', 'dir', 'directory', 'cwd', 'root',
]);

const MAYBE_PATH_ARG_KEYS = new Set([
  'target', 'src', 'source', 'dst', 'dest', 'destination', 'out', 'output',
]);

function appendJsonl(filePath, obj) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function readJsonlSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const ln of lines) {
    try { out.push(JSON.parse(ln)); } catch { /* ignore truncated line */ }
  }
  return out;
}

// -- Per-machine exclusive FIFO Desktop Mutex with lease TTL --
export function createDesktopMutex({ defaultLeaseMs = 30_000, now = () => Date.now() } = {}) {
  let holder = null;
  const waiters = [];

  function isExpired() {
    return Boolean(holder && now() >= holder.expiresAt);
  }

  function reclaimIfExpired() {
    if (isExpired()) {
      holder = null;
      pump();
    }
  }

  function pump() {
    if (holder && !isExpired()) return;
    if (holder && isExpired()) holder = null;
    while (waiters.length > 0) {
      const next = waiters.shift();
      if (next.cancelled) continue;
      if (next.timer) clearTimeout(next.timer);
      const token = `dmx_${crypto.randomBytes(6).toString('hex')}`;
      const acquiredAt = now();
      holder = {
        token,
        holderId: next.holderId,
        tool: next.tool,
        acquiredAt,
        expiresAt: acquiredAt + next.leaseMs,
      };
      next.resolve({
        ok: true,
        token,
        waitedMs: Math.max(0, acquiredAt - next.enqueuedAt),
        release: () => releaseByToken(token),
      });
      return;
    }
  }

  function releaseByToken(token) {
    if (holder && holder.token === token) {
      holder = null;
      pump();
      return true;
    }
    return false;
  }

  function acquire({
    holderId = 'unknown',
    tool = 'desktop',
    leaseMs = defaultLeaseMs,
    timeoutMs = 30_000,
    signal = null,
  } = {}) {
    reclaimIfExpired();
    const effLease = Math.max(50, Number(leaseMs || defaultLeaseMs));
    const enqueuedAt = now();

    if (!holder) {
      const token = `dmx_${crypto.randomBytes(6).toString('hex')}`;
      holder = {
        token,
        holderId: String(holderId),
        tool: String(tool),
        acquiredAt: enqueuedAt,
        expiresAt: enqueuedAt + effLease,
      };
      return Promise.resolve({
        ok: true,
        token,
        waitedMs: 0,
        release: () => releaseByToken(token),
      });
    }

    return new Promise((resolve, reject) => {
      const entry = {
        holderId: String(holderId),
        tool: String(tool),
        leaseMs: effLease,
        enqueuedAt,
        cancelled: false,
        timer: null,
        resolve,
      };

      const fail = (code, msg) => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        if (entry.timer) clearTimeout(entry.timer);
        const err = new Error(`${code}:${msg}`);
        err.code = code;
        reject(err);
      };

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => fail('ERR_DESKTOP_MUTEX_TIMEOUT', `${tool}`), timeoutMs);
        if (typeof entry.timer.unref === 'function') entry.timer.unref();
      }
      if (signal) {
        if (signal.aborted) return fail('ERR_DESKTOP_MUTEX_ABORTED', `${tool}`);
        signal.addEventListener('abort', () => fail('ERR_DESKTOP_MUTEX_ABORTED', `${tool}`), { once: true });
      }
      waiters.push(entry);
    });
  }

  function forceRelease(token = null) {
    if (!holder) return false;
    if (token && holder.token !== token) return false;
    holder = null;
    pump();
    return true;
  }

  return {
    acquire,
    forceRelease,
    isLocked: () => {
      reclaimIfExpired();
      return Boolean(holder);
    },
    getHolder: () => {
      reclaimIfExpired();
      return holder ? { ...holder } : null;
    },
  };
}

// -- Cloud-side Remote Tool Client with durable dispatch ledger --
export function createRemoteToolClient({
  deploymentId,
  deviceId,
  getEpoch = () => 1,
  sendRequest,
  ledgerPath = null,
  toolSpecs = [],
  defaultTimeoutMs = 30_000,
  now = () => new Date(),
} = {}) {
  if (!deploymentId) throw new Error('ERR_DEPLOYMENT_ID_REQUIRED');
  if (!deviceId) throw new Error('ERR_DEVICE_ID_REQUIRED');
  if (typeof sendRequest !== 'function') throw new Error('ERR_SEND_REQUEST_REQUIRED');

  const absLedger = ledgerPath ? path.resolve(String(ledgerPath)) : null;
  const specMap = new Map();
  for (const s of Array.isArray(toolSpecs) ? toolSpecs : []) {
    if (s && s.name) specMap.set(String(s.name), s);
  }
  const calls = new Map();

  for (const row of readJsonlSafe(absLedger)) {
    if (row && row.callId) calls.set(row.callId, row);
  }

  function recordState(entry) {
    calls.set(entry.callId, entry);
    appendJsonl(absLedger, entry);
  }

  async function invoke(toolName, args = {}, {
    riskTier = null,
    timeoutMs = null,
    callId = null,
    operationId = null,
    tenantId = null,
    groupId = null,
    originIsGroup = false,
    jobId = null,
    jobEpoch = null,
    resourceFence = null,
    signal = null,
  } = {}) {
    const spec = specMap.get(String(toolName)) || null;
    const effectiveRisk = String(riskTier || spec?.risk || 'reversible_write');
    const id = callId || `rc_${crypto.randomBytes(6).toString('hex')}`;
    const opId = operationId ? String(operationId) : id;
    const epoch = Number(getEpoch());
    const effTimeout = Math.max(50, Number(timeoutMs ?? spec?.timeoutMs ?? defaultTimeoutMs));
    const issuedAt = now().toISOString();

    const envelope = {
      schema: REMOTE_CALL_SCHEMA,
      callId: id,
      operationId: opId,
      deploymentId: String(deploymentId),
      deviceId: String(deviceId),
      epoch,
      tool: String(toolName),
      args: args && typeof args === 'object' ? args : {},
      riskTier: effectiveRisk,
      deadlineMs: effTimeout,
      issuedAt,
      ...(tenantId ? { tenantId: String(tenantId) } : {}),
      ...(groupId ? { groupId: String(groupId) } : {}),
      ...(originIsGroup ? { originIsGroup: true } : {}),
      ...(jobId ? { jobId: String(jobId) } : {}),
      ...(jobEpoch != null ? { jobEpoch: Number(jobEpoch) } : {}),
      ...(resourceFence != null ? { resourceFence } : {}),
    };

    // Durable write BEFORE sending over transport
    recordState({
      callId: id,
      deploymentId: envelope.deploymentId,
      deviceId: envelope.deviceId,
      epoch,
      tool: envelope.tool,
      riskTier: effectiveRisk,
      status: 'dispatched',
      retrySafe: effectiveRisk === 'read_only',
      ts: issuedAt,
    });

    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`ERR_REMOTE_TOOL_TIMEOUT:${envelope.tool}:${effTimeout}ms`);
        err.code = 'ERR_REMOTE_TOOL_TIMEOUT';
        reject(err);
      }, effTimeout);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const response = await Promise.race([
        Promise.resolve(sendRequest(envelope, { signal })),
        timeoutPromise,
      ]);
      if (timer) clearTimeout(timer);

      if (!response || typeof response !== 'object') {
        throw new Error('ERR_INVALID_REMOTE_RESPONSE');
      }
      if (response.epoch != null && Number(response.epoch) !== epoch) {
        const errRes = {
          ok: false,
          status: 'denied',
          retrySafe: false,
          callId: id,
          epoch,
          error: `ERR_STALE_EPOCH_RESPONSE:expected=${epoch},got=${response.epoch}`,
        };
        recordState({ ...errRes, deploymentId: envelope.deploymentId, deviceId: envelope.deviceId, tool: envelope.tool, riskTier: effectiveRisk, ts: now().toISOString() });
        return errRes;
      }

      if (response.ok === true && (response.status === 'accepted' || response.httpStatus === 202)) {
        // CRITICAL (sec 62b): Async 202 Accepted MUST NEVER be collapsed into `completed`!
        const accRes = {
          ok: true,
          accepted: true,
          status: 'accepted',
          retrySafe: false,
          callId: id,
          operationId: response.operationId || opId,
          remoteJobId: response.remoteJobId || null,
          pollAfterSec: Number(response.pollAfterSec || 15),
          epoch,
        };
        recordState({
          callId: id,
          operationId: accRes.operationId,
          remoteJobId: accRes.remoteJobId,
          deploymentId: envelope.deploymentId,
          deviceId: envelope.deviceId,
          epoch,
          tool: envelope.tool,
          riskTier: effectiveRisk,
          status: 'accepted',
          ts: now().toISOString(),
        });
        return accRes;
      }

      if (response.ok === true) {
        const okRes = {
          ok: true,
          status: 'completed',
          retrySafe: false,
          callId: id,
          epoch,
          output: response.output,
        };
        recordState({
          callId: id,
          deploymentId: envelope.deploymentId,
          deviceId: envelope.deviceId,
          epoch,
          tool: envelope.tool,
          riskTier: effectiveRisk,
          status: 'completed',
          ts: now().toISOString(),
        });
        return okRes;
      }

      const terminalStatus = response.status === 'denied' ? 'denied' : 'failed';
      const failRes = {
        ok: false,
        status: terminalStatus,
        retrySafe: Boolean(response.retrySafe && effectiveRisk === 'read_only'),
        callId: id,
        epoch,
        error: String(response.error || 'ERR_REMOTE_TOOL_FAILED'),
      };
      recordState({
        callId: id,
        deploymentId: envelope.deploymentId,
        deviceId: envelope.deviceId,
        epoch,
        tool: envelope.tool,
        riskTier: effectiveRisk,
        status: terminalStatus,
        retrySafe: failRes.retrySafe,
        error: failRes.error,
        ts: now().toISOString(),
      });
      return failRes;
    } catch (err) {
      if (timer) clearTimeout(timer);
      const isReadOnly = effectiveRisk === 'read_only';
      const status = isReadOnly ? 'failed' : 'unknown';
      const out = {
        ok: false,
        status,
        retrySafe: isReadOnly,
        callId: id,
        epoch,
        error: String(err?.message || err),
      };
      recordState({
        callId: id,
        deploymentId: envelope.deploymentId,
        deviceId: envelope.deviceId,
        epoch,
        tool: envelope.tool,
        riskTier: effectiveRisk,
        status,
        retrySafe: isReadOnly,
        error: out.error,
        ts: now().toISOString(),
      });
      return out;
    }
  }

  function registerOn(toolRegistry, { prefix = '' } = {}) {
    if (!toolRegistry || typeof toolRegistry.register !== 'function') {
      throw new Error('ERR_INVALID_TOOL_REGISTRY');
    }
    const registered = [];
    for (const spec of specMap.values()) {
      const regName = prefix ? `${prefix}${spec.name}` : spec.name;
      toolRegistry.register({
        name: regName,
        description: spec.description || `Opt-in remote companion tool: ${spec.name}`,
        risk: spec.risk || 'reversible_write',
        parameters: spec.parameters || { type: 'object', properties: {} },
        async execute(args, ctx) {
          const res = await invoke(spec.name, args, {
            riskTier: spec.risk || 'reversible_write',
            operationId: ctx?.operationId || undefined,
            jobId: ctx?.jobId || undefined,
            jobEpoch: ctx?.jobEpoch ?? undefined,
            originIsGroup: ctx?.originIsGroup === true || ctx?.isGroup === true,
            signal: ctx?.signal || null,
          });
          if (!res.ok) {
            return {
              ok: false,
              remoteStatus: res.status,
              retrySafe: res.retrySafe,
              callId: res.callId,
              error: res.error,
            };
          }
          // Preserve Async 202 Accepted handle so host adapters never receive `undefined` (B6)
          if (res.accepted === true || res.status === 'accepted') {
            return {
              ok: true,
              accepted: true,
              status: 'accepted',
              operationId: res.operationId,
              remoteJobId: res.remoteJobId,
              pollAfterSec: res.pollAfterSec,
              deviceId: String(deviceId),
              callId: res.callId,
            };
          }
          return res.output;
        },
      });
      registered.push(regName);
    }
    return registered;
  }

  return {
    deploymentId: String(deploymentId),
    deviceId: String(deviceId),
    deviceIds: [String(deviceId)],
    invoke,
    registerOn,
    listToolSpecs: () => [...specMap.values()].map((s) => ({ ...s, deviceId: String(deviceId) })),
    getCallState: (callId) => (calls.has(callId) ? { ...calls.get(callId) } : null),
    getLedger: () => [...calls.values()],
  };
}

// -- Multi-Device Cloud-side Remote Tool Router (1 agent -> N opt-in Companions) --
export function createMultiRemoteToolClient({
  deploymentId,
  devices = [],
  getEpoch = () => 1,
  ledgerPath = null,
  defaultTimeoutMs = 30_000,
  now = () => new Date(),
} = {}) {
  if (!deploymentId) throw new Error('ERR_DEPLOYMENT_ID_REQUIRED');
  const rawDevices = Array.isArray(devices) ? devices.filter((d) => d && d.deviceId) : [];

  const clientsByDevice = new Map();
  const deviceStates = [];
  const toolToDevice = new Map(); // toolName -> { deviceId, spec, online }

  for (const dev of rawDevices) {
    const devId = String(dev.deviceId);
    if (clientsByDevice.has(devId)) continue;
    const online = dev.online !== false;
    const specs = Array.isArray(dev.toolSpecs) ? dev.toolSpecs.filter((s) => s && s.name) : [];
    const client = dev.client && typeof dev.client.invoke === 'function'
      ? dev.client
      : (typeof dev.sendRequest === 'function'
          ? createRemoteToolClient({
              deploymentId,
              deviceId: devId,
              getEpoch,
              sendRequest: dev.sendRequest,
              ledgerPath,
              toolSpecs: specs,
              defaultTimeoutMs,
              now,
            })
          : null);
    clientsByDevice.set(devId, {
      deviceId: devId,
      platform: dev.platform ? String(dev.platform) : 'unknown',
      online,
      client,
      toolSpecs: specs.map((s) => ({ ...s, deviceId: devId })),
    });
    deviceStates.push(clientsByDevice.get(devId));
  }

  // Deterministic routing: online devices take precedence over offline devices; within each tier, binding order wins.
  const ordered = [
    ...deviceStates.filter((d) => d.online),
    ...deviceStates.filter((d) => !d.online),
  ];
  for (const dev of ordered) {
    for (const spec of dev.toolSpecs) {
      if (!toolToDevice.has(spec.name)) {
        toolToDevice.set(spec.name, {
          deviceId: dev.deviceId,
          spec,
          online: dev.online,
        });
      }
    }
  }

  const deviceIds = deviceStates.map((d) => d.deviceId);
  const onlineDeviceIds = deviceStates.filter((d) => d.online).map((d) => d.deviceId);
  const primaryDeviceId = onlineDeviceIds[0] || deviceIds[0] || null;

  function resolveToolDevice(toolName) {
    const hit = toolToDevice.get(String(toolName || ''));
    return hit ? { deviceId: hit.deviceId, spec: hit.spec, online: hit.online } : null;
  }

  async function invoke(toolName, args = {}, opts = {}) {
    const name = String(toolName || '');
    const explicitDeviceId = opts?.deviceId ? String(opts.deviceId) : null;
    let targetDevId = explicitDeviceId;
    if (!targetDevId) {
      const route = toolToDevice.get(name);
      targetDevId = route ? route.deviceId : null;
    }
    if (!targetDevId) {
      return {
        ok: false,
        status: 'failed',
        retrySafe: false,
        callId: opts?.callId || null,
        error: `ERR_REMOTE_TOOL_UNROUTED:${name}`,
      };
    }
    const dev = clientsByDevice.get(targetDevId);
    if (!dev || !dev.online || !dev.client) {
      return {
        ok: false,
        status: 'failed',
        retrySafe: false,
        callId: opts?.callId || null,
        deviceId: targetDevId,
        error: `ERR_COMPANION_OFFLINE:${targetDevId}`,
      };
    }
    const res = await dev.client.invoke(name, args, opts);
    return res && typeof res === 'object' ? { ...res, deviceId: targetDevId } : res;
  }

  function listToolSpecs({ includeOffline = false } = {}) {
    const out = [];
    for (const entry of toolToDevice.values()) {
      if (!includeOffline && !entry.online) continue;
      out.push({ ...entry.spec });
    }
    return out;
  }

  function listDevices() {
    return deviceStates.map((d) => ({
      deviceId: d.deviceId,
      platform: d.platform,
      online: d.online,
      toolCount: d.toolSpecs.length,
    }));
  }

  function registerOn(toolRegistry, { prefix = '' } = {}) {
    if (!toolRegistry || typeof toolRegistry.register !== 'function') {
      throw new Error('ERR_INVALID_TOOL_REGISTRY');
    }
    const registered = [];
    for (const spec of listToolSpecs({ includeOffline: false })) {
      const regName = prefix ? `${prefix}${spec.name}` : spec.name;
      toolRegistry.register({
        name: regName,
        description: spec.description || `Opt-in remote companion tool: ${spec.name}`,
        risk: spec.risk || 'reversible_write',
        group: spec.group || undefined,
        groupName: spec.groupName || undefined,
        groupSummary: spec.groupSummary || undefined,
        ownerGroupSafe: spec.ownerGroupSafe === true,
        groupScope: spec.groupScope || undefined,
        deviceId: spec.deviceId || primaryDeviceId,
        parameters: spec.parameters || { type: 'object', properties: {} },
        async execute(args, ctx) {
          const res = await invoke(spec.name, args, {
            riskTier: spec.risk || 'reversible_write',
            deviceId: spec.deviceId,
            operationId: ctx?.operationId || undefined,
            jobId: ctx?.jobId || undefined,
            jobEpoch: ctx?.jobEpoch ?? undefined,
            originIsGroup: ctx?.originIsGroup === true || ctx?.isGroup === true,
            signal: ctx?.signal || null,
          });
          if (!res.ok) {
            return {
              ok: false,
              remoteStatus: res.status,
              retrySafe: res.retrySafe,
              callId: res.callId,
              deviceId: res.deviceId || spec.deviceId,
              error: res.error,
            };
          }
          // Preserve Async 202 Accepted handle on multi-device registration too (B6)
          if (res.accepted === true || res.status === 'accepted') {
            return {
              ok: true,
              accepted: true,
              status: 'accepted',
              operationId: res.operationId,
              remoteJobId: res.remoteJobId,
              pollAfterSec: res.pollAfterSec,
              deviceId: res.deviceId || spec.deviceId,
              callId: res.callId,
            };
          }
          return res.output;
        },
      });
      registered.push(regName);
    }
    return registered;
  }

  return {
    deploymentId: String(deploymentId),
    deviceId: primaryDeviceId,
    deviceIds,
    onlineDeviceIds,
    invoke,
    resolveToolDevice,
    listDevices,
    listToolSpecs,
    registerOn,
    getCallState(callId) {
      for (const dev of deviceStates) {
        const hit = dev.client?.getCallState?.(callId);
        if (hit) return hit;
      }
      return null;
    },
    getLedger() {
      const seen = new Map();
      for (const dev of deviceStates) {
        for (const row of dev.client?.getLedger?.() || []) {
          if (row && row.callId) seen.set(row.callId, row);
        }
      }
      return [...seen.values()];
    },
  };
}

// -- Client-side Companion Tool Host (enforces ALL local machine security) --
function resolveCanonicalPath(raw) {
  const expanded = String(raw || '').trim();
  const abs = path.resolve(expanded);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function collectCandidatePaths(value, parentKey = '', out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    const s = value.trim();
    const k = String(parentKey || '').toLowerCase();
    const looksLikePath = STRICT_PATH_ARG_KEYS.has(k)
      || (MAYBE_PATH_ARG_KEYS.has(k) && (s.includes('/') || s.includes('\\') || s.startsWith('~') || s.includes('..')))
      || s.startsWith('/')
      || s.startsWith('~/')
      || s.startsWith('../')
      || s.includes('/../')
      || /^[A-Za-z]:\\/.test(s);
    if (looksLikePath && s.length > 0) {
      out.push({ key: parentKey || 'arg', value: s });
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCandidatePaths(item, parentKey, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectCandidatePaths(v, k, out);
    }
  }
  return out;
}

function isPathAllowed(rawPath, canonicalAllowedRoots) {
  const candidate = resolveCanonicalPath(rawPath);
  for (const root of canonicalAllowedRoots) {
    if (candidate === root || candidate.startsWith(root + path.sep)) return true;
  }
  return false;
}

export function verifyCompanionAudit(auditPath) {
  const rows = readJsonlSafe(auditPath);
  let prevHash = '0'.repeat(64);
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.seq !== i + 1) errors.push({ seq: row.seq, expected: i + 1, reason: 'seq_mismatch' });
    if (row.prevHash !== prevHash) errors.push({ seq: row.seq, reason: 'prev_hash_mismatch' });
    const { hash, ...body } = row;
    const expected = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (hash !== expected) errors.push({ seq: row.seq, reason: 'hash_mismatch' });
    prevHash = hash;
  }
  return { ok: errors.length === 0, count: rows.length, errors };
}

export function createCompanionToolHost({
  deviceId,
  physicalResourceId = null,
  allowlist = [],
  allowedPaths = [],
  desktopTools = [],
  disallowGroupOriginTools = [],
  requireApproval = null,
  verifyResourceFence = null,
  approvalTiers = ['external_comm', 'financial', 'destructive'],
  desktopMutex = null,
  fairShareQueue = null,
  asyncJobLedger = null,
  onAsyncJobDone = null,
  auditPath = null,
  handlers = {},
  initialEpoch = 0,
  now = () => new Date(),
} = {}) {
  if (!deviceId) throw new Error('ERR_DEVICE_ID_REQUIRED');

  const absAudit = auditPath ? path.resolve(String(auditPath)) : null;
  const allowSet = new Set((Array.isArray(allowlist) ? allowlist : []).map(String));
  const desktopSet = new Set((Array.isArray(desktopTools) ? desktopTools : []).map(String));
  const disallowGroupSet = new Set((Array.isArray(disallowGroupOriginTools) ? disallowGroupOriginTools : []).map(String));
  const approvalTierSet = new Set((Array.isArray(approvalTiers) ? approvalTiers : []).map(String));
  const canonicalRoots = (Array.isArray(allowedPaths) ? allowedPaths : [])
    .filter(Boolean)
    .map((p) => resolveCanonicalPath(p));
  const mutex = desktopMutex || createDesktopMutex();
  const remoteJobs = asyncJobLedger || createAsyncRemoteJobLedger({ now: () => now().getTime() });
  const runningRemoteControllers = new Map(); // remoteJobId -> AbortController
  const maxJobEpochByJobId = new Map();       // jobId -> highest seen jobEpoch (P1-22)
  const auditEntries = readJsonlSafe(absAudit);
  const physId = String(physicalResourceId || deviceId);

  let paused = false;
  let lastEpoch = Math.max(0, Number(initialEpoch || 0));
  let auditSeq = auditEntries.length;
  let prevAuditHash = auditEntries.length ? auditEntries[auditEntries.length - 1].hash : '0'.repeat(64);

  function logAudit(entry) {
    auditSeq += 1;
    const body = {
      seq: auditSeq,
      prevHash: prevAuditHash,
      ts: now().toISOString(),
      deviceId: String(deviceId),
      ...entry,
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const full = { ...body, hash };
    prevAuditHash = hash;
    auditEntries.push(full);
    appendJsonl(absAudit, full);
    return full;
  }

  async function handleEnvelope(envelope) {
    const t0 = performance.now();
    const env = envelope && typeof envelope === 'object' ? envelope : {};
    const callId = String(env.callId || 'unknown');
    const deploymentId = String(env.deploymentId || 'unknown');
    const tool = String(env.tool || '');
    const riskTier = String(env.riskTier || 'reversible_write');
    const epoch = Number(env.epoch || 0);

    const deny = (code, detail = '') => {
      const error = detail ? `${code}:${detail}` : code;
      logAudit({
        callId,
        deploymentId,
        epoch,
        tool,
        riskTier,
        decision: 'denied',
        reason: error,
        durationMs: +(performance.now() - t0).toFixed(2),
      });
      return { ok: false, status: 'denied', retrySafe: false, callId, epoch, error };
    };

    // 1. Local Kill Switch
    if (paused) return deny('ERR_COMPANION_PAUSED', 'kill_switch_active');

    // 2. Device Binding Check
    if (env.deviceId && String(env.deviceId) !== String(deviceId)) {
      return deny('ERR_DEVICE_MISMATCH', `${env.deviceId}!=${deviceId}`);
    }

    // 3. Monotonic Epoch Fencing
    if (!Number.isInteger(epoch) || epoch < lastEpoch) {
      return deny('ERR_STALE_EPOCH', `received=${epoch},min=${lastEpoch}`);
    }
    if (epoch > lastEpoch) lastEpoch = epoch;

    // 3b. Local monotonic per-job epoch fencing even without custom verifyResourceFence (P1-22)
    if (env.jobId && env.jobEpoch != null && Number.isFinite(Number(env.jobEpoch))) {
      const jKey = `${deploymentId}:${String(env.jobId)}`;
      const je = Number(env.jobEpoch);
      const prevJe = maxJobEpochByJobId.get(jKey);
      if (prevJe !== undefined && je < prevJe) {
        return deny('ERR_STALE_JOB_EPOCH', `jobId=${env.jobId},received=${je},min=${prevJe}`);
      }
      maxJobEpochByJobId.set(jKey, prevJe === undefined ? je : Math.max(prevJe, je));
    }

    // 4. Local Tool Allowlist
    if (!tool || !allowSet.has(tool)) {
      return deny('ERR_TOOL_NOT_ALLOWLISTED', tool || 'empty');
    }

    // 4b. Disallow owner-only sensitive tools when invoked from a group-originated slice (sec 63)
    if (env.originIsGroup === true && disallowGroupSet.has(tool)) {
      return deny('ERR_GROUP_ORIGIN_FORBIDDEN', tool);
    }

    const handler = handlers[tool];
    if (typeof handler !== 'function') {
      return deny('ERR_TOOL_HANDLER_MISSING', tool);
    }

    // 5. Local Path-Root Sandbox
    if (canonicalRoots.length > 0) {
      const candidates = collectCandidatePaths(env.args || {});
      for (const c of candidates) {
        if (!isPathAllowed(c.value, canonicalRoots)) {
          return deny('ERR_PATH_OUTSIDE_SANDBOX', `${c.key}=${c.value}`);
        }
      }
    }

    // 5b. Idempotency pre-check BEFORE acquiring DesktopMutex/FairShare or running handler (P1-21 + no self-deadlock on lost-ACK replay!)
    const preOpId = env.operationId ? String(env.operationId).trim() : null;
    if (preOpId) {
      const existingRec = remoteJobs.lookup(preOpId, { deploymentId });
      if (existingRec) {
        const expectedHash = remoteJobs.computeIdentityHash({
          tool,
          deviceId: String(deviceId),
          args: env.args || {},
        });
        if (existingRec.argsHash !== expectedHash) {
          return deny('ERR_OPERATION_CONFLICT', preOpId);
        }
        logAudit({
          callId,
          deploymentId,
          epoch,
          tool,
          riskTier,
          decision: 'idempotent_async_replay',
          remoteJobId: existingRec.remoteJobId,
          operationId: preOpId,
          approvedBy: null,
          ok: true,
          durationMs: +(performance.now() - t0).toFixed(2),
        });
        return {
          ok: true,
          httpStatus: 202,
          schema: REMOTE_JOB_SCHEMA,
          status: 'accepted',
          idempotent: true,
          callId,
          operationId: preOpId,
          remoteJobId: existingRec.remoteJobId,
          pollAfterSec: existingRec.pollAfterSec,
          epoch,
        };
      }
    }

    // 6. Local HITL Approval Gate for sensitive tiers
    let approvedBy = null;
    if (approvalTierSet.has(riskTier)) {
      if (typeof requireApproval !== 'function') {
        return deny('ERR_LOCAL_APPROVAL_REQUIRED', riskTier);
      }
      const decision = await Promise.resolve(requireApproval({
        callId,
        deploymentId,
        deviceId: String(deviceId),
        epoch,
        tool,
        args: env.args || {},
        riskTier,
      }));
      const isApproved = Boolean(decision === true || (decision && decision.approved === true));
      if (!isApproved) {
        return deny('ERR_LOCAL_APPROVAL_DENIED', String(decision?.reason || riskTier));
      }
      approvedBy = (decision && typeof decision === 'object' && (decision.by || decision.approver)) || 'local_owner';
    }

    // 7. Fair-Share Queue + Exclusive Desktop Mutex for GUI / mouse / keyboard tools
    let lease = null;
    let fairShareLease = null;
    const needsDesktop = desktopSet.has(tool) || Boolean(env.desktop);
    if (needsDesktop) {
      if (fairShareQueue && typeof fairShareQueue.acquire === 'function') {
        fairShareLease = await fairShareQueue.acquire({
          physicalResourceId: physId,
          tenantId: env.tenantId || deploymentId,
          groupId: env.groupId || env.chatId || 'dm',
        });
        if (!fairShareLease || !fairShareLease.ok) {
          return deny(fairShareLease?.code || 'ERR_FAIR_SHARE_DENIED', physId);
        }
      }
      try {
        lease = await mutex.acquire({
          holderId: `${deploymentId}:${callId}`,
          tool,
          leaseMs: Math.max(1000, Number(env.deadlineMs || 30_000)),
          timeoutMs: Math.max(1000, Number(env.deadlineMs || 30_000)),
        });
      } catch (err) {
        if (fairShareLease && typeof fairShareLease.release === 'function') fairShareLease.release();
        return deny(err?.code || 'ERR_DESKTOP_MUTEX_FAILED', String(err?.message || err));
      }
    }

    const checkPostWaitFence = async () => {
      if (paused) return { ok: false, code: 'ERR_COMPANION_PAUSED', detail: 'paused_during_wait' };
      if (epoch < lastEpoch) return { ok: false, code: 'ERR_STALE_EPOCH_AFTER_WAIT', detail: `received=${epoch},min=${lastEpoch}` };
      if (typeof verifyResourceFence === 'function') {
        const res = await Promise.resolve(verifyResourceFence({
          callId,
          deploymentId,
          deviceId: String(deviceId),
          physicalResourceId: physId,
          epoch,
          jobId: env.jobId || null,
          jobEpoch: env.jobEpoch ?? null,
          resourceFence: env.resourceFence ?? null,
          originIsGroup: Boolean(env.originIsGroup),
          tool,
        }));
        const allowed = Boolean(res === true || (res && res.allowed === true));
        if (!allowed) {
          return {
            ok: false,
            code: (res && typeof res === 'object' && res.code) || 'ERR_RESOURCE_FENCE_REVOKED',
            detail: (res && typeof res === 'object' && res.reason) || tool,
          };
        }
      }
      return { ok: true };
    };

    let leasesTransferredToAsync = false;
    const releaseLeasesOnce = () => {
      if (lease && typeof lease.release === 'function') {
        const l = lease;
        lease = null;
        l.release();
      }
      if (fairShareLease && typeof fairShareLease.release === 'function') {
        const fsL = fairShareLease;
        fairShareLease = null;
        fsL.release();
      }
    };

    try {
      // CRITICAL (sec 62a): Re-verify pause, host epoch, and live resourceFence AFTER acquiring DesktopMutex!
      const fenceRes = await checkPostWaitFence();
      if (!fenceRes.ok) {
        return deny(fenceRes.code, fenceRes.detail);
      }

      const output = await Promise.resolve(handler(env.args || {}, {
        callId,
        operationId: env.operationId || callId,
        deploymentId,
        deviceId: String(deviceId),
        physicalResourceId: physId,
        epoch,
        riskTier,
        approvedBy,
        checkFence: checkPostWaitFence,
      }));

      // sec 62b: Async 202 Accepted handoff (`scroll-remote-job/v1`)
      if (output && typeof output === 'object' && output.__asyncAccepted === true) {
        // Require durable ledger for recoverable 202 unless explicitly opted into memory mode (B7)
        if (!remoteJobs.isDurable && output.allowMemoryLedger !== true && !asyncJobLedger) {
          return deny('ERR_DURABLE_ASYNC_LEDGER_REQUIRED', tool);
        }
        const opId = String(env.operationId || callId);
        const accepted = remoteJobs.accept({
          tenantId: env.tenantId || deploymentId,
          deploymentId,
          deviceId: String(deviceId),
          operationId: opId,
          tool,
          args: env.args || {},
          pollAfterSec: output.pollAfterSec || 15,
        });
        if (!accepted.ok) {
          return deny(accepted.code, opId);
        }
        const rec = accepted.record;
        if (!accepted.idempotent && typeof output.run === 'function') {
          const ac = new AbortController();
          runningRemoteControllers.set(rec.remoteJobId, ac);
          remoteJobs.updateStatus(rec.remoteJobId, { deploymentId, status: 'running' });
          // Transfer DesktopMutex + FairShare lease ownership to async runner through settlement (B7, P1-20)
          leasesTransferredToAsync = true;
          Promise.resolve()
            .then(() => output.run({
              signal: ac.signal,
              remoteJobId: rec.remoteJobId,
              operationId: opId,
              checkFence: checkPostWaitFence,
            }))
            .then((finalReceipt) => {
              // If handler ignored abort and actually completed, record actual `succeeded` receipt (H6)!
              const done = remoteJobs.updateStatus(rec.remoteJobId, {
                deploymentId,
                status: 'succeeded',
                receipt: finalReceipt,
              });
              if (typeof onAsyncJobDone === 'function' && done.ok) {
                Promise.resolve(onAsyncJobDone({ type: 'remote_job_done', ...done.record })).catch(() => {});
              }
            })
            .catch((err) => {
              const cur = remoteJobs.lookup(rec.remoteJobId, { deploymentId });
              const finalStatus = (ac.signal.aborted || cur?.cancelRequested) ? 'cancelled' : 'failed';
              const fail = remoteJobs.updateStatus(rec.remoteJobId, {
                deploymentId,
                status: finalStatus,
                error: finalStatus === 'cancelled' ? 'cancelled' : String(err?.message || err),
              });
              if (typeof onAsyncJobDone === 'function' && fail.ok) {
                Promise.resolve(onAsyncJobDone({ type: 'remote_job_done', ...fail.record })).catch(() => {});
              }
            })
            .finally(() => {
              runningRemoteControllers.delete(rec.remoteJobId);
              releaseLeasesOnce();
            });
        }
        logAudit({
          callId,
          deploymentId,
          epoch,
          tool,
          riskTier,
          decision: 'accepted_async',
          remoteJobId: rec.remoteJobId,
          operationId: opId,
          approvedBy,
          ok: true,
          durationMs: +(performance.now() - t0).toFixed(2),
        });
        return {
          ok: true,
          httpStatus: 202,
          schema: REMOTE_JOB_SCHEMA,
          status: 'accepted',
          callId,
          operationId: opId,
          remoteJobId: rec.remoteJobId,
          pollAfterSec: rec.pollAfterSec,
          epoch,
        };
      }

      logAudit({
        callId,
        deploymentId,
        epoch,
        tool,
        riskTier,
        decision: 'allowed',
        approvedBy,
        ok: true,
        durationMs: +(performance.now() - t0).toFixed(2),
      });
      return { ok: true, status: 'completed', callId, epoch, output };
    } catch (err) {
      const msg = String(err?.message || err);
      logAudit({
        callId,
        deploymentId,
        epoch,
        tool,
        riskTier,
        decision: 'error',
        approvedBy,
        reason: msg,
        durationMs: +(performance.now() - t0).toFixed(2),
      });
      return {
        ok: false,
        status: 'failed',
        retrySafe: riskTier === 'read_only',
        callId,
        epoch,
        error: msg,
      };
    } finally {
      if (!leasesTransferredToAsync) {
        releaseLeasesOnce();
      }
    }
  }

  return {
    deviceId: String(deviceId),
    physicalResourceId: physId,
    handleEnvelope,
    getRemoteJobStatus: (idOrOp, { deploymentId = null } = {}) => {
      if (!deploymentId) return null;
      return remoteJobs.lookup(idOrOp, { deploymentId });
    },
    cancelRemoteJob: (idOrOp, { deploymentId = null } = {}) => {
      if (!deploymentId) return { ok: false, code: 'ERR_DEPLOYMENT_ID_REQUIRED' };
      const cur = remoteJobs.lookup(idOrOp, { deploymentId });
      if (!cur) return { ok: false, code: 'ERR_REMOTE_JOB_NOT_FOUND' };
      if (REMOTE_JOB_TERMINAL_SET.has(cur.status)) {
        return { ok: true, alreadyTerminal: true, record: cur };
      }
      const ac = runningRemoteControllers.get(cur.remoteJobId);
      if (ac) {
        // Live runner active: mark cancelRequested + abort signal; final status settles when runner exits (H6)
        const mark = remoteJobs.updateStatus(cur.remoteJobId, {
          deploymentId: cur.deploymentId,
          status: cur.status,
          cancelRequested: true,
        });
        ac.abort();
        return { ok: true, cancelState: 'cancel_requested', record: mark.record };
      }
      return remoteJobs.updateStatus(cur.remoteJobId, {
        deploymentId: cur.deploymentId,
        status: 'cancelled',
        cancelRequested: true,
      });
    },
    setPaused: (v) => { paused = Boolean(v); return paused; },
    isPaused: () => paused,
    getLastEpoch: () => lastEpoch,
    getAuditLog: () => [...auditEntries],
    desktopMutex: mutex,
  };
}
