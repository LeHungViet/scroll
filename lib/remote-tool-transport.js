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
    signal = null,
  } = {}) {
    const spec = specMap.get(String(toolName)) || null;
    const effectiveRisk = String(riskTier || spec?.risk || 'reversible_write');
    const id = callId || `rc_${crypto.randomBytes(6).toString('hex')}`;
    const epoch = Number(getEpoch());
    const effTimeout = Math.max(50, Number(timeoutMs ?? spec?.timeoutMs ?? defaultTimeoutMs));
    const issuedAt = now().toISOString();

    const envelope = {
      schema: REMOTE_CALL_SCHEMA,
      callId: id,
      deploymentId: String(deploymentId),
      deviceId: String(deviceId),
      epoch,
      tool: String(toolName),
      args: args && typeof args === 'object' ? args : {},
      riskTier: effectiveRisk,
      deadlineMs: effTimeout,
      issuedAt,
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
    invoke,
    registerOn,
    listToolSpecs: () => [...specMap.values()],
    getCallState: (callId) => (calls.has(callId) ? { ...calls.get(callId) } : null),
    getLedger: () => [...calls.values()],
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
  allowlist = [],
  allowedPaths = [],
  desktopTools = [],
  requireApproval = null,
  approvalTiers = ['external_comm', 'financial', 'destructive'],
  desktopMutex = null,
  auditPath = null,
  handlers = {},
  initialEpoch = 0,
  now = () => new Date(),
} = {}) {
  if (!deviceId) throw new Error('ERR_DEVICE_ID_REQUIRED');

  const absAudit = auditPath ? path.resolve(String(auditPath)) : null;
  const allowSet = new Set((Array.isArray(allowlist) ? allowlist : []).map(String));
  const desktopSet = new Set((Array.isArray(desktopTools) ? desktopTools : []).map(String));
  const approvalTierSet = new Set((Array.isArray(approvalTiers) ? approvalTiers : []).map(String));
  const canonicalRoots = (Array.isArray(allowedPaths) ? allowedPaths : [])
    .filter(Boolean)
    .map((p) => resolveCanonicalPath(p));
  const mutex = desktopMutex || createDesktopMutex();
  const auditEntries = readJsonlSafe(absAudit);

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

    // 4. Local Tool Allowlist
    if (!tool || !allowSet.has(tool)) {
      return deny('ERR_TOOL_NOT_ALLOWLISTED', tool || 'empty');
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

    // 7. Exclusive Desktop Mutex for GUI / mouse / keyboard tools
    let lease = null;
    const needsDesktop = desktopSet.has(tool) || Boolean(env.desktop);
    if (needsDesktop) {
      try {
        lease = await mutex.acquire({
          holderId: `${deploymentId}:${callId}`,
          tool,
          leaseMs: Math.max(1000, Number(env.deadlineMs || 30_000)),
          timeoutMs: Math.max(1000, Number(env.deadlineMs || 30_000)),
        });
      } catch (err) {
        return deny(err?.code || 'ERR_DESKTOP_MUTEX_FAILED', String(err?.message || err));
      }
    }

    try {
      const output = await Promise.resolve(handler(env.args || {}, {
        callId,
        deploymentId,
        deviceId: String(deviceId),
        epoch,
        riskTier,
        approvedBy,
      }));
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
      if (lease && typeof lease.release === 'function') {
        lease.release();
      }
    }
  }

  return {
    deviceId: String(deviceId),
    handleEnvelope,
    setPaused: (v) => { paused = Boolean(v); return paused; },
    isPaused: () => paused,
    getLastEpoch: () => lastEpoch,
    getAuditLog: () => [...auditEntries],
    desktopMutex: mutex,
  };
}
