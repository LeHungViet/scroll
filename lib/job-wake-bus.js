// SCROLL 2.17 / 2.20.1 -- sec 58 Event-Driven Job Wake Bus & Host-Registered 0-LLM Probe Dispatcher.
// Zero-dependency, pure ASCII, Node >= 20.
//
// Features:
//   - Immediate event-driven wake on inbox commit (<5s gate) rather than polling-only 20s tick.
//   - Exact next-due timer scheduling (`MIN(nextDueAt)` over actionable deadlines only; zero 5ms hot loop).
//   - Host-registered named 0-LLM probes ONLY (reusing `precheckHandlers` Map contract; zero SSRF / raw path probing).
//   - Per-probe try/catch + timeout isolation, tick re-entrancy coalescing, waitGeneration & stop() fencing.
//   - Seamless Dual-Speed Sprint (30s->3m) vs Marathon (15m->4h) cadence backoff on negative probes.
//   - Missed-wake coalescing + tenant/agent-scoped event correlation + reliable dispatch for queued/defaulted jobs.
import {
  computeTempoTier,
  computeNextProbeDelaySec,
} from './durable-jobs.js';

function isCompanionOnlineType(type) {
  return type === 'companion_online' || type === 'companion.online';
}

function matchesWakeType(wType, evType) {
  return wType === evType || (isCompanionOnlineType(wType) && isCompanionOnlineType(evType));
}

function matchesWakeRule(w, ev, type) {
  if (!w || typeof w !== 'object') return false;
  const wType = String(w.type || '');
  if (!matchesWakeType(wType, type)) return false;
  // Strict correlation: if subscription requires operationId/deviceId/askId/deploymentId/tenantId, event MUST match!
  if (w.operationId && String(ev.operationId || '') !== String(w.operationId)) return false;
  if (w.deviceId && String(ev.deviceId || '') !== String(w.deviceId)) return false;
  if (w.askId && String(ev.askId || '') !== String(w.askId)) return false;
  if (w.deploymentId && String(ev.deploymentId || '') !== String(w.deploymentId)) return false;
  if (w.tenantId && String(ev.tenantId || '') !== String(w.tenantId)) return false;
  return true;
}

export function createJobWakeBus({
  store,
  precheckHandlers = null,
  onJobQueued = null,
  onReconcileDue = null,
  clock = () => Date.now(),
  safetySweepMs = 20_000,
  probeTimeoutMs = 15_000,
} = {}) {
  if (!store || typeof store.listJobs !== 'function') {
    throw new Error('ERR_DURABLE_JOB_STORE_REQUIRED');
  }

  const probes = precheckHandlers instanceof Map ? precheckHandlers : new Map();
  let dueTimer = null;
  let safetyTimer = null;
  let running = false;
  let busGeneration = 0;
  let tickActive = false;
  let tickInFlight = null;
  let activeCallbackDepth = 0;
  let pendingRescan = false;
  let pendingRescanOpts = null;
  const dispatchingJobs = new Set(); // jobId currently inside onJobQueued (prevents re-entrant double dispatch)
  const notifiedQueuedRev = new Map(); // jobId -> revision last successfully dispatched to onJobQueued

  function registerProbe(name, fn) {
    const key = String(name || '').trim();
    if (!key || typeof fn !== 'function') throw new Error('ERR_INVALID_PROBE_REGISTRATION');
    if (/^https?:\/\//i.test(key) || key.includes('/') || key.includes('\\') || key.includes('..')) {
      throw new Error(`ERR_UNSAFE_PROBE_NAME:${key}`);
    }
    probes.set(key, fn);
    return key;
  }

  function hasProbe(name) {
    return probes.has(String(name || '').trim());
  }

  function scheduleNextTimer() {
    if (!running) return;
    if (dueTimer) {
      clearTimeout(dueTimer);
      dueTimer = null;
    }
    const nextMs = store.getNextDueAtMs();
    if (nextMs === null) return;
    // Floor at 25ms when strictly overdue to prevent micro-spin while staying sub-second responsive
    const rawDelta = nextMs - clock();
    const delay = Math.max(25, Math.min(60 * 60 * 1000, rawDelta));
    const gen = busGeneration;
    dueTimer = setTimeout(() => {
      dueTimer = null;
      if (!running || gen !== busGeneration) return;
      tick().catch(() => {}).finally(() => {
        if (running && gen === busGeneration) scheduleNextTimer();
      });
    }, delay);
    if (typeof dueTimer.unref === 'function') dueTimer.unref();
  }

  async function notifyDispatched(jobId, reason, rev = null, expectedGen = busGeneration) {
    if (expectedGen !== busGeneration) return false;
    if (rev !== null && notifiedQueuedRev.get(jobId) === rev) return true;
    if (dispatchingJobs.has(jobId)) return true;
    if (typeof onJobQueued !== 'function') {
      if (rev !== null) notifiedQueuedRev.set(jobId, rev);
      return true;
    }
    dispatchingJobs.add(jobId);
    activeCallbackDepth += 1;
    try {
      await Promise.resolve(onJobQueued({ jobId, reason, ts: clock() }));
      if (rev !== null && expectedGen === busGeneration) {
        notifiedQueuedRev.set(jobId, rev);
      }
      return true;
    } catch {
      // Leave revision un-notified so the next tick retries delivery cleanly (H2)
      return false;
    } finally {
      activeCallbackDepth -= 1;
      dispatchingJobs.delete(jobId);
    }
  }

  async function runProbeBounded(probeFn, ctx) {
    const timeout = Math.max(100, Number(probeTimeoutMs || 15_000));
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => probeFn(ctx)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ERR_PROBE_TIMEOUT')), timeout);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Publish an external or companion event immediately (e.g. `companion_online` / `companion.online`,
   * `remote_job_done`, `webhook`, `ticket_approved`). Writes into durable inbox and dispatches
   * matching jobs immediately with strict tenant/agent/correlation isolation.
   */
  async function publishEvent(event = {}, { nowMs = clock() } = {}) {
    const ev = event && typeof event === 'object' ? event : {};
    const type = String(ev.type || '').trim();
    if (!type) return { ok: false, code: 'EVENT_TYPE_REQUIRED', woken: [], buffered: [] };

    const gen = busGeneration;
    const woken = [];
    const buffered = [];
    const candidates = ev.jobId
      ? [store.getJob(ev.jobId)].filter(Boolean)
      : store.listJobs().filter((j) => j.status === 'waiting' || j.status === 'running' || j.status === 'reconciling');

    for (const job of candidates) {
      const hasTargetJobId = Boolean(ev.jobId && String(ev.jobId) === String(job.jobId));
      // Strict tenant & agent isolation:
      // - Broadcast events (no jobId) MUST carry matching tenantId (and matching agentId if set on event) (H3, P1-11)
      // - Targeted events (with jobId) must also never violate provided tenantId/agentId
      if (!hasTargetJobId) {
        if (!ev.tenantId || String(ev.tenantId) !== String(job.tenantId || '')) continue;
        if (ev.agentId && job.agentId && String(ev.agentId) !== String(job.agentId)) continue;
      } else {
        if (ev.tenantId && job.tenantId && String(ev.tenantId) !== String(job.tenantId)) continue;
        if (ev.agentId && job.agentId && String(ev.agentId) !== String(job.agentId)) continue;
      }

      const wakeList = Array.isArray(job.wake?.wakeOn) ? job.wake.wakeOn : [];
      const matchingTypeRules = wakeList.filter((w) => w && typeof w === 'object' && matchesWakeType(String(w.type || ''), type));
      const matchesExplicit = wakeList.some((w) => matchesWakeRule(w, ev, type));
      const matchesCompanionOnline = isCompanionOnlineType(type)
        && job.status === 'waiting'
        && job.waitingFor === 'companion'
        && (wakeList.length === 0 || matchesExplicit);
      // Even on a targeted jobId event, if the job subscribed to this event type with correlation IDs
      // (operationId/deviceId/askId/deploymentId), enforce that correlation before waking (H3)!
      const matchesTargetJob = hasTargetJobId && (matchingTypeRules.length === 0 || matchesExplicit);

      if (!matchesExplicit && !matchesCompanionOnline && !matchesTargetJob) continue;

      const res = store.enqueueWake({
        jobId: job.jobId,
        reason: `event:${type}`,
        event: ev,
        expectedWaitGeneration: job.status === 'waiting' ? job.waitGeneration : null,
        nowMs,
      });
      if (res.ok && (res.woke || res.alreadyQueued)) {
        woken.push(job.jobId);
        await notifyDispatched(job.jobId, `event:${type}`, res.job?.revision ?? null, gen);
      } else if (res.ok && res.buffered) {
        buffered.push(job.jobId);
      }
    }

    scheduleNextTimer();
    return { ok: true, woken, buffered };
  }

  async function runTickBody({ nowMs = clock(), maxBatch = 50 } = {}) {
    const gen = busGeneration;
    const reapReport = store.reap({ nowMs });
    const waitingJobs = store.listJobs({ status: 'waiting' });
    const woken = [];
    const probedNegative = [];
    const probeRejected = [];

    // Clear notified cache for jobs no longer queued
    for (const jid of [...notifiedQueuedRev.keys()]) {
      const cur = store.getJob(jid);
      if (!cur || cur.status !== 'queued') notifiedQueuedRev.delete(jid);
    }

    let processed = 0;
    for (const job of waitingJobs) {
      if (gen !== busGeneration) break;
      if (processed >= maxBatch) break;

      // Skip human/authority waits without burning maxBatch (H1, P0-9)
      if (job.waitingFor === 'requester' || job.waitingFor === 'owner_approval' || job.waitingFor === 'authority') {
        continue;
      }

      const dueMs = Number(job.wake?.nextReviewAtMs);
      if (!Number.isFinite(dueMs) || nowMs < dueMs) continue;

      const probeName = job.wake?.probeName ? String(job.wake.probeName).trim() : null;
      // Companion sleeps wait on companion_online unless explicit probe or explicit timer was set (C7)
      if (job.waitingFor === 'companion' && !probeName && !job.wake?.hasExplicitTimer) {
        continue;
      }

      processed += 1;

      if (probeName) {
        const probeFn = probes.get(probeName);
        if (typeof probeFn !== 'function') {
          // Strict anti-SSRF guard + backoff so unregistered probe NEVER spins at 5ms! (H1, P1-10)
          probeRejected.push({ jobId: job.jobId, probeName, code: 'ERR_PROBE_NOT_REGISTERED' });
          store.recordNegativeProbe({
            jobId: job.jobId,
            nextReviewAtMs: nowMs + 300_000,
            statusNote: `ERR_PROBE_NOT_REGISTERED:${probeName}`,
            expectedWaitGeneration: job.waitGeneration,
            nowMs,
          });
          continue;
        }

        const outcome = await runProbeBounded(probeFn, {
          jobId: job.jobId,
          probeName,
          probeArgs: job.wake.probeArgs || {},
          checkpoint: job.checkpoint,
          nowMs,
        });
        if (gen !== busGeneration) break;

        const pr = outcome.ok ? outcome.result : { ready: false, note: `probe_error:${outcome.error}` };
        const ready = outcome.ok && (pr === true || (pr && typeof pr === 'object' && pr.ready === true));
        if (!ready) {
          const nextNeg = Number(job.wake.negativeProbes || 0) + 1;
          const computedTempo = computeTempoTier({
            createdAtMs: job.createdAtMs,
            nowMs,
            requestedSleepSec: job.wake.requestedSleepSec || 0,
            hasYielded: true,
          });
          // Never downgrade an already-Marathon job back to Sprint on negative probe
          const nextTempo = job.tempoTier === 'marathon' ? 'marathon' : computedTempo;
          const nextDelaySec = computeNextProbeDelaySec({
            tempoTier: nextTempo,
            negativeProbes: nextNeg - 1,
            pollAfterSec: pr && typeof pr === 'object' ? pr.pollAfterSec : null,
            etaMs: (pr && typeof pr === 'object' && pr.etaMs) ? pr.etaMs : job.wake.etaMs,
            nowMs,
            slaDeadlineMs: job.wake.slaDeadlineMs,
          });
          const negRes = store.recordNegativeProbe({
            jobId: job.jobId,
            nextReviewAtMs: nowMs + nextDelaySec * 1000,
            tempoTier: nextTempo,
            statusNote: (pr && typeof pr === 'object' && pr.note) ? pr.note : 'probe_not_ready',
            expectedWaitGeneration: job.waitGeneration,
            nowMs,
          });
          if (negRes.ok) {
            probedNegative.push({
              jobId: job.jobId,
              probeName,
              tempoTier: nextTempo,
              nextDelaySec,
              zeroLlm: true,
              probeErrored: !outcome.ok,
            });
          }
          continue;
        }

        const res = store.enqueueWake({
          jobId: job.jobId,
          reason: `probe:${probeName}`,
          event: { type: 'probe_ready', probeName, data: (pr && typeof pr === 'object') ? pr.data : true },
          expectedWaitGeneration: job.waitGeneration,
          nowMs,
        });
        if (res.ok && res.woke) {
          woken.push(job.jobId);
          await notifyDispatched(job.jobId, `probe:${probeName}`, res.job?.revision ?? null, gen);
        }
        continue;
      }

      // Timer-only wake (coalesces any missed periods into exactly 1 wake)
      const res = store.enqueueWake({
        jobId: job.jobId,
        reason: 'timer_due',
        event: { type: 'timer_due', coalescedAtMs: nowMs },
        expectedWaitGeneration: job.waitGeneration,
        nowMs,
      });
      if (res.ok && res.woke) {
        woken.push(job.jobId);
        await notifyDispatched(job.jobId, 'timer_due', res.job?.revision ?? null, gen);
      }
    }

    // Notify ALL jobs transitioned to queued by reaper (including defaultedAsks! P0-10 / H10 / C4)
    const reaperQueued = [
      ...(reapReport.reclaimedLeases || []),
      ...(reapReport.repairedOrphans || []),
      ...(reapReport.defaultedJobIds || []),
    ];
    for (const jid of new Set(reaperQueued)) {
      const cur = store.getJob(jid);
      if (cur && cur.status === 'queued') {
        await notifyDispatched(jid, 'reaper_requeued', cur.revision, gen);
      }
    }

    // Also notify any externally queued jobs (e.g. via direct answerAsk / submitSteering) once per revision
    for (const qj of store.listJobs({ status: 'queued' })) {
      if (gen !== busGeneration) break;
      if (notifiedQueuedRev.get(qj.jobId) !== qj.revision) {
        await notifyDispatched(qj.jobId, 'queued_sweep', qj.revision, gen);
      }
    }

    // Notify host reconciliation hook for due reconciling jobs
    if (typeof onReconcileDue === 'function' && Array.isArray(reapReport.reconcilingDue)) {
      for (const jid of reapReport.reconcilingDue) {
        if (gen !== busGeneration) break;
        activeCallbackDepth += 1;
        try {
          await Promise.resolve(onReconcileDue({ jobId: jid, ts: nowMs })).catch(() => {});
        } finally {
          activeCallbackDepth -= 1;
        }
      }
    }

    scheduleNextTimer();
    return {
      reap: reapReport,
      woken,
      probedNegative,
      probeRejected,
    };
  }

  function tick(opts = {}) {
    if (tickActive || tickInFlight) {
      // Never self-deadlock if a callback inside the active tick calls `await bus.tick()` (H2)
      if (activeCallbackDepth > 0) {
        pendingRescan = true;
        pendingRescanOpts = opts;
        return Promise.resolve({
          deferred: true,
          reap: null,
          woken: [],
          probedNegative: [],
          probeRejected: [],
        });
      }
      return tickInFlight;
    }
    tickActive = true;
    const gen = busGeneration;
    // Defer body entry via Promise.resolve().then(...) so `tickInFlight` is ALWAYS assigned before callbacks execute
    tickInFlight = Promise.resolve()
      .then(() => runTickBody(opts))
      .finally(() => {
        tickActive = false;
        tickInFlight = null;
        if (pendingRescan && gen === busGeneration) {
          const nextOpts = pendingRescanOpts || {};
          pendingRescan = false;
          pendingRescanOpts = null;
          queueMicrotask(() => {
            if (gen === busGeneration) tick(nextOpts).catch(() => {});
          });
        }
      });
    return tickInFlight;
  }

  function start() {
    if (running) return;
    busGeneration += 1;
    running = true;
    scheduleNextTimer();
    const gen = busGeneration;
    safetyTimer = setInterval(() => {
      if (!running || gen !== busGeneration) return;
      tick().catch(() => {});
    }, Math.max(1000, Number(safetySweepMs || 20_000)));
    if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
  }

  function stop() {
    running = false;
    busGeneration += 1;
    if (dueTimer) { clearTimeout(dueTimer); dueTimer = null; }
    if (safetyTimer) { clearInterval(safetyTimer); safetyTimer = null; }
  }

  return {
    registerProbe,
    hasProbe,
    listProbes: () => [...probes.keys()].sort(),
    publishEvent,
    tick,
    scheduleNextTimer,
    start,
    stop,
  };
}
