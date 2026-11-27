// SCROLL 2.17 -- sec 58 Event-Driven Job Wake Bus & Host-Registered 0-LLM Probe Dispatcher.
// Zero-dependency, pure ASCII, Node >= 20.
//
// Features:
//   - Immediate event-driven wake on inbox commit (<5s gate) rather than polling-only 20s tick.
//   - Exact next-due timer scheduling (`MIN(nextReviewAtMs)`), with 20s sweep strictly as safety net.
//   - Host-registered named 0-LLM probes ONLY (reusing `precheckHandlers` Map contract; zero SSRF / raw path probing).
//   - Seamless Dual-Speed Sprint (30s->3m) vs Marathon (15m->4h) cadence backoff on negative probes.
//   - Missed-wake coalescing (N overdue ticks collapse into 1 wake).
import {
  computeTempoTier,
  computeNextProbeDelaySec,
} from './durable-jobs.js';

export function createJobWakeBus({
  store,
  precheckHandlers = null,
  onJobQueued = null,
  clock = () => Date.now(),
  safetySweepMs = 20_000,
} = {}) {
  if (!store || typeof store.listJobs !== 'function') {
    throw new Error('ERR_DURABLE_JOB_STORE_REQUIRED');
  }

  const probes = precheckHandlers instanceof Map ? precheckHandlers : new Map();
  let dueTimer = null;
  let safetyTimer = null;
  let running = false;

  function registerProbe(name, fn) {
    const key = String(name || '').trim();
    if (!key || typeof fn !== 'function') throw new Error('ERR_INVALID_PROBE_REGISTRATION');
    // Guard against registering raw URLs or file paths as probe names
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
    const delay = Math.max(5, Math.min(60 * 60 * 1000, nextMs - clock()));
    dueTimer = setTimeout(() => {
      dueTimer = null;
      tick().catch(() => {}).finally(() => scheduleNextTimer());
    }, delay);
    if (typeof dueTimer.unref === 'function') dueTimer.unref();
  }

  async function notifyDispatched(jobId, reason) {
    if (typeof onJobQueued === 'function') {
      await Promise.resolve(onJobQueued({ jobId, reason, ts: clock() })).catch(() => {});
    }
  }

  /**
   * Publish an external or companion event immediately (e.g. `companion.online`,
   * `remote_job_done`, `webhook`, `ticket_approved`). Writes into durable inbox and
   * dispatches matching jobs immediately without waiting for the 20s sweep.
   */
  async function publishEvent(event = {}, { nowMs = clock() } = {}) {
    const ev = event && typeof event === 'object' ? event : {};
    const type = String(ev.type || '').trim();
    if (!type) return { ok: false, code: 'EVENT_TYPE_REQUIRED', woken: [], buffered: [] };

    const woken = [];
    const buffered = [];
    const candidates = ev.jobId
      ? [store.getJob(ev.jobId)].filter(Boolean)
      : store.listJobs().filter((j) => j.status === 'waiting' || j.status === 'running' || j.status === 'reconciling');

    for (const job of candidates) {
      const wakeList = Array.isArray(job.wake?.wakeOn) ? job.wake.wakeOn : [];
      const matchesExplicit = wakeList.some((w) => {
        if (!w || w.type !== type) return false;
        if (w.operationId && ev.operationId && String(w.operationId) !== String(ev.operationId)) return false;
        if (w.deviceId && ev.deviceId && String(w.deviceId) !== String(ev.deviceId)) return false;
        if (w.askId && ev.askId && String(w.askId) !== String(ev.askId)) return false;
        return true;
      });
      const matchesCompanionOnline = type === 'companion_online' && job.status === 'waiting' && job.waitingFor === 'companion';
      const matchesTargetJob = Boolean(ev.jobId && ev.jobId === job.jobId);

      if (!matchesExplicit && !matchesCompanionOnline && !matchesTargetJob) continue;

      const res = store.enqueueWake({
        jobId: job.jobId,
        reason: `event:${type}`,
        event: ev,
        nowMs,
      });
      if (res.ok && res.woke) {
        woken.push(job.jobId);
        await notifyDispatched(job.jobId, `event:${type}`);
      } else if (res.ok && res.buffered) {
        buffered.push(job.jobId);
      }
    }

    scheduleNextTimer();
    return { ok: true, woken, buffered };
  }

  /**
   * Evaluate due waiting jobs and run Periodic Reaper.
   * For jobs with a Host-registered `probeName`, runs the 0-LLM deterministic probe first:
   *   - Negative probe -> reschedules with Dual-Speed Sprint/Marathon backoff, 0 LLM calls.
   *   - Positive probe -> moves job `waiting -> queued` (coalescing any missed ticks into 1 wake).
   */
  async function tick({ nowMs = clock(), maxBatch = 50 } = {}) {
    const reapReport = store.reap({ nowMs });
    const waitingJobs = store.listJobs({ status: 'waiting' });
    const woken = [];
    const probedNegative = [];
    const probeRejected = [];

    let processed = 0;
    for (const job of waitingJobs) {
      if (processed >= maxBatch) break;
      const dueMs = Number(job.wake?.nextReviewAtMs);
      if (!Number.isFinite(dueMs) || nowMs < dueMs) continue;
      processed += 1;

      // Jobs parked waiting on authority or human answer do NOT auto-wake on timer unless an ask defaulted (handled by reap)
      if (job.waitingFor === 'requester' || job.waitingFor === 'owner_approval' || job.waitingFor === 'authority') {
        continue;
      }

      const probeName = job.wake?.probeName ? String(job.wake.probeName).trim() : null;
      if (probeName) {
        const probeFn = probes.get(probeName);
        if (typeof probeFn !== 'function') {
          // Strict anti-SSRF / anti-file-probe guard: NEVER execute unregistered probes!
          probeRejected.push({ jobId: job.jobId, probeName, code: 'ERR_PROBE_NOT_REGISTERED' });
          continue;
        }
        const pr = await Promise.resolve(probeFn({
          jobId: job.jobId,
          probeName,
          probeArgs: job.wake.probeArgs || {},
          checkpoint: job.checkpoint,
          nowMs,
        }));
        const ready = pr === true || (pr && typeof pr === 'object' && pr.ready === true);
        if (!ready) {
          const nextNeg = Number(job.wake.negativeProbes || 0) + 1;
          const nextTempo = computeTempoTier({
            createdAtMs: job.createdAtMs,
            nowMs,
            hasYielded: true,
          });
          const nextDelaySec = computeNextProbeDelaySec({
            tempoTier: nextTempo,
            negativeProbes: nextNeg - 1,
            pollAfterSec: pr && typeof pr === 'object' ? pr.pollAfterSec : null,
            etaMs: (pr && typeof pr === 'object' && pr.etaMs) ? pr.etaMs : job.wake.etaMs,
            nowMs,
            slaDeadlineMs: job.wake.slaDeadlineMs,
          });
          store.recordNegativeProbe({
            jobId: job.jobId,
            nextReviewAtMs: nowMs + nextDelaySec * 1000,
            tempoTier: nextTempo,
            statusNote: (pr && typeof pr === 'object' && pr.note) ? pr.note : 'probe_not_ready',
            nowMs,
          });
          probedNegative.push({
            jobId: job.jobId,
            probeName,
            tempoTier: nextTempo,
            nextDelaySec,
            zeroLlm: true,
          });
          continue;
        }
        // Positive probe -> wake job once with probe evidence
        const res = store.enqueueWake({
          jobId: job.jobId,
          reason: `probe:${probeName}`,
          event: { type: 'probe_ready', probeName, data: (pr && typeof pr === 'object') ? pr.data : true },
          expectedWaitGeneration: job.waitGeneration,
          nowMs,
        });
        if (res.ok && res.woke) {
          woken.push(job.jobId);
          await notifyDispatched(job.jobId, `probe:${probeName}`);
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
        await notifyDispatched(job.jobId, 'timer_due');
      }
    }

    // Notify any jobs re-queued by reaper (e.g., expired leases or defaulted asks)
    for (const jid of [...reapReport.reclaimedLeases, ...reapReport.repairedOrphans]) {
      await notifyDispatched(jid, 'reaper_requeued');
    }

    scheduleNextTimer();
    return {
      reap: reapReport,
      woken,
      probedNegative,
      probeRejected,
    };
  }

  function start() {
    if (running) return;
    running = true;
    scheduleNextTimer();
    safetyTimer = setInterval(() => {
      tick().catch(() => {});
    }, Math.max(1000, Number(safetySweepMs || 20_000)));
    if (typeof safetyTimer.unref === 'function') safetyTimer.unref();
  }

  function stop() {
    running = false;
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
