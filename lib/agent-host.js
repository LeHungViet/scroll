// SCROLL 2.8 -- sec 56 Placement-Agnostic Managed Agent Host (`ScrollAgentHost`).
// Zero-dep, pure ASCII, Node >= 20.
//
// Unites immutable Agent Packs (sec 52), isolated Tenant Workspaces (sec 53), Cross-Surface
// Principal Identity (sec 54), opt-in Companion Remote Tools (sec 55), and SCROLL Chat Runtime
// under ONE contract across `cloud`, `local-node`, and `cloud+companion` placements:
//   - Single-writer fencing `epoch` (rejects split-brain turns/crons from stale hosts)
//   - Per-deployment ordered serial queue + durable `eventId` deduplication
//   - Zero-loss in-place pack upgrade & rollback preserving tenant memory/USER.md/weights
//   - Deduped scheduled cron ticks with `skip` / `catchup` missed-run policies
//   - PII-redacted telemetry export for offline distillation and evaluation pipelines
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createScrollChatRuntime } from './chat-sdk/index.js';
import { normalizeChannelPolicy } from './chat-sdk/group-policy.js';
import { createScopedMemoryTracker } from './memory-tracker.js';

export const HOST_PLACEMENTS = new Set(['cloud', 'local-node', 'cloud+companion']);

const REDACT_RULES = [
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, rep: '[REDACTED_EMAIL]' },
  { re: /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?){2,3}\d{3,4}\b/g, rep: '[REDACTED_PHONE]' },
  { re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, rep: '[REDACTED_TOKEN]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, rep: '[REDACTED_TOKEN]' },
  { re: /\b\d{8,11}:[A-Za-z0-9_-]{30,}\b/g, rep: '[REDACTED_BOT_TOKEN]' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/gi, rep: 'Bearer [REDACTED_TOKEN]' },
  { re: new RegExp('/' + 'U' + 'sers/[^\\s"\'/]+', 'g'), rep: '/[REDACTED_HOME]' },
  { re: new RegExp('/' + 'h' + 'ome/[^\\s"\'/]+', 'g'), rep: '/[REDACTED_HOME]' },
];

export function redactTelemetryText(text) {
  let out = String(text ?? '');
  for (const r of REDACT_RULES) {
    out = out.replace(r.re, r.rep);
  }
  return out;
}

function readJsonSafe(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomicJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
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

export async function createScrollAgentHost({
  placement = 'cloud',
  workspace,
  packRegistry = null,
  principalProvider = null,
  provider = null,
  providerName = 'auto',
  providerOpts = {},
  model = null,
  effort = null,
  serviceTier = null,
  authStore = null,
  remoteClient = null,
  companionPlatforms = [],
  defaultTimezone = null,
  getTimezone = null,
  ownerIds = [],
  runtimeOptions = {},
  scheduler = null,
  maxDedupeEntries = 2000,
  now = () => new Date(),
} = {}) {
  if (!HOST_PLACEMENTS.has(placement)) {
    throw new Error(`ERR_INVALID_HOST_PLACEMENT:${placement}`);
  }
  if (!workspace || typeof workspace.getBinding !== 'function' || typeof workspace.getPaths !== 'function') {
    throw new Error('ERR_WORKSPACE_REQUIRED');
  }

  const paths = workspace.getPaths();
  const eventDedupeFile = path.join(paths.runtimeDir, 'event-dedupe.json');
  const cronDedupeFile = path.join(paths.runtimeDir, 'cron-dedupe.json');
  const telemetryFile = path.join(paths.runtimeDir, 'host-telemetry.jsonl');

  const eventDedupe = readJsonSafe(eventDedupeFile, { order: [], results: {} });
  const cronDedupe = readJsonSafe(cronDedupeFile, { keys: {} });

  let runtime = null;
  let memoryTracker = null;
  let activeRemoteClient = remoteClient || null;
  let activeCompanionPlatforms = Array.isArray(companionPlatforms) ? [...companionPlatforms] : [];
  let closed = false;
  let serialTail = Promise.resolve();

  function enqueue(fn) {
    const run = serialTail.catch(() => {}).then(fn);
    serialTail = run.catch(() => {});
    return run;
  }

  function recordEventDedupe(eventId, result) {
    if (!eventId) return;
    if (!Object.prototype.hasOwnProperty.call(eventDedupe.results, eventId)) {
      eventDedupe.order.push(eventId);
    }
    eventDedupe.results[eventId] = {
      storedAt: now().toISOString(),
      result,
    };
    while (eventDedupe.order.length > maxDedupeEntries) {
      const oldest = eventDedupe.order.shift();
      delete eventDedupe.results[oldest];
    }
    writeAtomicJson(eventDedupeFile, eventDedupe);
  }

  function checkAndSyncEpoch(incomingEpoch) {
    const binding = workspace.getBinding();
    const curEpoch = Number(binding.epoch || 1);
    if (incomingEpoch == null) return { ok: true, epoch: curEpoch };
    const req = Number(incomingEpoch);
    if (!Number.isInteger(req) || req < curEpoch) {
      return {
        ok: false,
        error: 'ERR_STALE_EPOCH',
        expectedEpoch: curEpoch,
        receivedEpoch: req,
      };
    }
    if (req > curEpoch) {
      workspace.advanceEpoch(req);
      return { ok: true, epoch: req };
    }
    return { ok: true, epoch: curEpoch };
  }

  function resolveEffectiveOwners() {
    const set = new Set((Array.isArray(ownerIds) ? ownerIds : []).map(String));
    if (principalProvider?.ownerPrincipalId) set.add(String(principalProvider.ownerPrincipalId));
    return [...set];
  }

  async function bootRuntime() {
    const binding = workspace.getBinding();
    const pack = binding.activePack;
    if (!pack || !pack.packDir || !pack.agentName) {
      throw new Error('ERR_WORKSPACE_ACTIVE_PACK_MISSING');
    }

    const layeredKb = workspace.getLayeredKnowledge();
    const effectiveOwners = resolveEffectiveOwners();
    const agentDir = path.join(pack.packDir, 'agents', pack.agentName);

    memoryTracker = createScopedMemoryTracker({
      rootDir: paths.memoryDir,
      workdir: pack.packDir,
      agentDir,
      ownerIds: effectiveOwners,
      channel: 'unified',
      crossSurfaceUser: Boolean(principalProvider),
      ...(runtimeOptions.memoryOptions || {}),
    });

    runtime = await createScrollChatRuntime({
      ...runtimeOptions,
      agentName: pack.agentName,
      deploymentDir: pack.packDir,
      stateDir: paths.runtimeDir,
      accountId: workspace.deploymentId,
      ownerIds: effectiveOwners,
      provider,
      providerName,
      providerOpts,
      model,
      effort,
      serviceTier,
      authStore,
      scheduler,
      userFile: paths.userFile,
      knowledgeIndex: layeredKb,
      memoryTracker,
      crossSurfaceUser: Boolean(principalProvider),
      groundingMode: runtimeOptions.groundingMode || 'balanced',
      defaultTimezone,
      getTimezone,
      extraPlatforms: activeCompanionPlatforms,
      now,
      acquireLock: false,
    });

    if (activeRemoteClient && runtime.tools && typeof activeRemoteClient.registerOn === 'function') {
      activeRemoteClient.registerOn(runtime.tools);
    }

    return { binding, pack, layeredKb };
  }

  await bootRuntime();

  function setCompanionPlatforms(platforms = []) {
    activeCompanionPlatforms = Array.isArray(platforms) ? [...platforms] : [];
    if (runtime && typeof runtime.setExtraPlatforms === 'function') {
      return runtime.setExtraPlatforms(activeCompanionPlatforms);
    }
    return { changed: false, platforms: [] };
  }

  function attachRemoteClient(client, { platforms = null } = {}) {
    activeRemoteClient = client || null;
    if (activeRemoteClient && runtime?.tools && typeof activeRemoteClient.registerOn === 'function') {
      activeRemoteClient.registerOn(runtime.tools);
    }
    if (Array.isArray(platforms)) {
      setCompanionPlatforms(platforms);
    } else if (!activeRemoteClient && platforms === null) {
      setCompanionPlatforms([]);
    }
  }

  function resolveHostTimezone(opts = {}) {
    if (runtime && typeof runtime.resolveTimezone === 'function') {
      return runtime.resolveTimezone(opts);
    }
    return { timezone: defaultTimezone || 'UTC', source: defaultTimezone ? 'host' : 'fallback' };
  }

  async function handleTurn({
    eventId = null,
    epoch = null,
    surface = 'web',
    conversationId = null,
    senderId = null,
    senderName = null,
    text = '',
    isGroup = false,
    attachments = [],
    timezone = null,
    extra = {},
  } = {}) {
    if (closed) throw new Error('ERR_HOST_CLOSED');
    return enqueue(async () => {
      const epochCheck = checkAndSyncEpoch(epoch);
      if (!epochCheck.ok) {
        return {
          ok: false,
          error: epochCheck.error,
          expectedEpoch: epochCheck.expectedEpoch,
          receivedEpoch: epochCheck.receivedEpoch,
        };
      }

      if (eventId && Object.prototype.hasOwnProperty.call(eventDedupe.results, eventId)) {
        const cached = eventDedupe.results[eventId].result;
        appendJsonl(telemetryFile, {
          ts: now().toISOString(),
          kind: 'turn_deduped',
          deploymentId: workspace.deploymentId,
          eventId,
          epoch: epochCheck.epoch,
          surface: String(surface),
        });
        return { ...cached, deduplicated: true };
      }

      const identity = principalProvider
        ? principalProvider.resolveTurnIdentity({
            surface,
            senderId,
            senderName,
            roomId: conversationId,
            isGroup,
          })
        : {
            linked: false,
            surface: String(surface || 'web'),
            principalId: null,
            isOwner: false,
            trust: 'external',
            memoryUserId: senderId != null ? String(senderId) : 'anonymous',
            crossSurfaceUser: false,
            memoryChannel: String(surface || 'web'),
            effectiveSender: {
              id: senderId != null ? String(senderId) : 'anonymous',
              channelId: `${surface}:${senderId ?? 'anonymous'}`,
              name: senderName || null,
              isOwner: false,
            },
          };

      const effectiveConvId = conversationId || `${identity.surface}:${identity.effectiveSender.id}`;
      const t0 = performance.now();
      const binding = workspace.getBinding();

      const turnOut = await runtime.sendTurn({
        ...extra,
        conversationId: effectiveConvId,
        text: String(text ?? ''),
        channel: identity.surface || identity.memoryChannel,
        isGroup: Boolean(isGroup),
        attachments,
        timezone: timezone || extra?.timezone || null,
        sender: identity.effectiveSender,
      });

      const durationMs = +(performance.now() - t0).toFixed(2);
      const result = {
        ok: true,
        deduplicated: false,
        eventId: eventId || null,
        epoch: epochCheck.epoch,
        packVersion: binding.activePack.version,
        packSha256: binding.activePack.sha256,
        identity: {
          linked: identity.linked,
          principalId: identity.principalId,
          trust: identity.trust,
          isOwner: identity.isOwner,
          memoryUserId: identity.memoryUserId,
        },
        text: turnOut.text,
        bubbles: turnOut.bubbles || [turnOut.text],
        toolTraces: turnOut.toolTraces || [],
        knowledgeHits: turnOut.knowledgeHits || [],
        usage: turnOut.usage || null,
        durationMs,
      };

      if (eventId) {
        recordEventDedupe(eventId, {
          ok: true,
          eventId,
          epoch: result.epoch,
          packVersion: result.packVersion,
          packSha256: result.packSha256,
          identity: result.identity,
          text: result.text,
          bubbles: result.bubbles,
        });
      }

      appendJsonl(telemetryFile, {
        ts: now().toISOString(),
        kind: 'turn',
        deploymentId: workspace.deploymentId,
        eventId: eventId || null,
        epoch: epochCheck.epoch,
        surface: identity.surface,
        trust: identity.trust,
        isGroup: Boolean(isGroup),
        packId: binding.activePack.packId,
        packVersion: binding.activePack.version,
        packSha256: binding.activePack.sha256,
        promptPreview: String(text ?? '').slice(0, 160),
        replyPreview: String(turnOut.text ?? '').slice(0, 160),
        toolCount: (turnOut.toolTraces || []).length,
        usage: turnOut.usage || null,
        durationMs,
      });

      return result;
    });
  }

  async function upgradePack(opts = {}) {
    if (closed) throw new Error('ERR_HOST_CLOSED');
    return enqueue(async () => {
      if (runtime) {
        await runtime.close();
        runtime = null;
      }
      const switched = await workspace.switchPack(opts);
      await bootRuntime();
      appendJsonl(telemetryFile, {
        ts: now().toISOString(),
        kind: 'pack_upgraded',
        deploymentId: workspace.deploymentId,
        fromVersion: switched.previousPack?.version || null,
        toVersion: switched.activePack.version,
        sha256: switched.activePack.sha256,
      });
      return switched;
    });
  }

  async function rollbackPack() {
    if (closed) throw new Error('ERR_HOST_CLOSED');
    return enqueue(async () => {
      const t0 = performance.now();
      if (runtime) {
        await runtime.close();
        runtime = null;
      }
      const rb = workspace.rollbackPack();
      await bootRuntime();
      const totalMs = +(performance.now() - t0).toFixed(3);
      appendJsonl(telemetryFile, {
        ts: now().toISOString(),
        kind: 'pack_rolled_back',
        deploymentId: workspace.deploymentId,
        fromVersion: rb.rolledBackFrom?.version || null,
        toVersion: rb.activePack.version,
        sha256: rb.activePack.sha256,
        durationMs: rb.durationMs,
      });
      return { ...rb, totalReloadMs: totalMs };
    });
  }

  async function runScheduledTick({
    jobId,
    scheduledAt,
    epoch = null,
    missedPolicy = 'skip',
    staleAfterMs = 15 * 60_000,
    prompt = null,
    conversationId = null,
    run = null,
  } = {}) {
    if (closed) throw new Error('ERR_HOST_CLOSED');
    if (!jobId || !scheduledAt) throw new Error('ERR_SCHEDULED_TICK_ARGS_REQUIRED');
    return enqueue(async () => {
      const epochCheck = checkAndSyncEpoch(epoch);
      if (!epochCheck.ok) {
        return {
          ok: false,
          error: epochCheck.error,
          expectedEpoch: epochCheck.expectedEpoch,
          receivedEpoch: epochCheck.receivedEpoch,
        };
      }

      const schedIso = new Date(scheduledAt).toISOString();
      const dedupeKey = `${workspace.deploymentId}:${jobId}:${schedIso}`;
      if (Object.prototype.hasOwnProperty.call(cronDedupe.keys, dedupeKey)) {
        return { ok: true, deduplicated: true, skipped: false, jobId, scheduledAt: schedIso, cached: cronDedupe.keys[dedupeKey] };
      }

      const lagMs = now().getTime() - Date.parse(schedIso);
      if (missedPolicy === 'skip' && lagMs > Number(staleAfterMs || 0)) {
        const rec = { status: 'skipped_missed', lagMs, ts: now().toISOString() };
        cronDedupe.keys[dedupeKey] = rec;
        writeAtomicJson(cronDedupeFile, cronDedupe);
        return { ok: true, deduplicated: false, skipped: true, reason: 'missed_policy_skip', lagMs, jobId, scheduledAt: schedIso };
      }

      let output;
      if (typeof run === 'function') {
        output = await Promise.resolve(run({ jobId, scheduledAt: schedIso, epoch: epochCheck.epoch, runtime }));
      } else {
        output = await runtime.sendTurn({
          conversationId: conversationId || `cron:${jobId}`,
          text: String(prompt || jobId),
          channel: 'cron',
          isGroup: false,
          sender: {
            id: principalProvider?.ownerPrincipalId || 'scheduler',
            name: 'Scheduler',
            isOwner: true,
          },
        });
      }

      const rec = {
        status: 'executed',
        epoch: epochCheck.epoch,
        ts: now().toISOString(),
        text: typeof output?.text === 'string' ? output.text : null,
      };
      cronDedupe.keys[dedupeKey] = rec;
      writeAtomicJson(cronDedupeFile, cronDedupe);
      appendJsonl(telemetryFile, {
        ts: now().toISOString(),
        kind: 'cron_tick',
        deploymentId: workspace.deploymentId,
        jobId,
        scheduledAt: schedIso,
        epoch: epochCheck.epoch,
        missedPolicy,
      });
      return { ok: true, deduplicated: false, skipped: false, jobId, scheduledAt: schedIso, epoch: epochCheck.epoch, output };
    });
  }

  function exportTelemetry({ since = null, redactPii = true } = {}) {
    const sinceMs = since ? Date.parse(since) : null;
    const rows = readJsonlSafe(telemetryFile).filter((r) => {
      if (sinceMs == null || Number.isNaN(sinceMs)) return true;
      return Date.parse(r.ts || '') >= sinceMs;
    });

    let turns = 0;
    let dedupedTurns = 0;
    let cronTicks = 0;
    let totalDurationMs = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const sanitizedEvents = rows.map((r) => {
      if (r.kind === 'turn') {
        turns += 1;
        totalDurationMs += Number(r.durationMs || 0);
        totalInputTokens += Number(r.usage?.uncachedInputTokens || 0) + Number(r.usage?.cachedInputTokens || 0);
        totalOutputTokens += Number(r.usage?.outputTokens || 0);
      } else if (r.kind === 'turn_deduped') {
        dedupedTurns += 1;
      } else if (r.kind === 'cron_tick') {
        cronTicks += 1;
      }
      if (!redactPii) return r;
      const clone = { ...r };
      if (typeof clone.promptPreview === 'string') clone.promptPreview = redactTelemetryText(clone.promptPreview);
      if (typeof clone.replyPreview === 'string') clone.replyPreview = redactTelemetryText(clone.replyPreview);
      return clone;
    });

    const binding = workspace.getBinding();
    return {
      schema: 'scroll-host-telemetry/v1',
      exportedAt: now().toISOString(),
      placement,
      tenantId: workspace.tenantId,
      deploymentId: workspace.deploymentId,
      activePack: binding.activePack,
      epoch: binding.epoch,
      redacted: Boolean(redactPii),
      summary: {
        turns,
        dedupedTurns,
        cronTicks,
        avgDurationMs: turns ? +(totalDurationMs / turns).toFixed(2) : 0,
        totalInputTokens,
        totalOutputTokens,
      },
      events: sanitizedEvents,
    };
  }

  function getChannelPolicy() {
    const binding = workspace.getBinding();
    const packDir = binding?.activePack?.packDir || null;
    const manifest = packDir ? readJsonSafe(path.join(packDir, 'pack.manifest.json'), null) : null;
    return normalizeChannelPolicy(manifest?.channelPolicy || {});
  }

  function getStatus() {
    const binding = workspace.getBinding();
    return {
      placement,
      closed,
      tenantId: workspace.tenantId,
      deploymentId: workspace.deploymentId,
      epoch: binding.epoch,
      activePack: binding.activePack,
      previousPack: binding.previousPack,
      channelPolicy: getChannelPolicy(),
      hasRemoteClient: Boolean(activeRemoteClient),
      remoteDeviceId: activeRemoteClient?.deviceId || null,
      cacheStats: runtime?.getCacheStats ? runtime.getCacheStats() : null,
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    await serialTail.catch(() => {});
    if (runtime) {
      await runtime.close();
      runtime = null;
    }
  }

  return {
    get runtime() { return runtime; },
    get memoryTracker() { return memoryTracker; },
    workspace,
    principalProvider,
    packRegistry,
    attachRemoteClient,
    setCompanionPlatforms,
    resolveTimezone: resolveHostTimezone,
    handleTurn,
    upgradePack,
    rollbackPack,
    runScheduledTick,
    exportTelemetry,
    getChannelPolicy,
    getStatus,
    close,
  };
}
