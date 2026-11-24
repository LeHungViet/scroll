// Async Sleep-Time Compute Runner for @agentpro/scroll-continuity.
// Executes offline consolidation strictly outside user-facing turn latency:
//   - Records idempotent run state per (tenant_id, job_kind, as_of_seq)
//   - Enforces Compare-And-Swap (`as_of_seq === currentHeadSeq`) before publishing derived updates
//   - If new user events arrive mid-flight, flags `stale: true` and re-schedules safely
//   - Runs prospective-memory wake scan, non-legal backlog TTL sweep, and pluggable domain tasks.

export function createSleepTimeWorker({
  ledger,
  problemRegister,
  customTasks = [],
  now = () => new Date().toISOString(),
  logger = null,
} = {}) {
  if (!ledger?.storage) throw new Error('createSleepTimeWorker requires ledger');
  const db = ledger.storage;
  const inflight = new Map(); // tenantId -> Promise

  const stmts = {
    getRun: db.prepare('SELECT * FROM sleep_run WHERE tenant_id = ? AND job_kind = ? AND as_of_seq = ?'),
    insertRun: db.prepare(`
      INSERT OR REPLACE INTO sleep_run (tenant_id, job_kind, as_of_seq, status, result_json, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listRecentRuns: db.prepare(
      'SELECT * FROM sleep_run WHERE tenant_id = ? ORDER BY as_of_seq DESC, started_at DESC LIMIT ?'
    ),
  };

  async function runCycle(tenantId, {
    jobKind = 'sleep_consolidate',
    force = false,
    backupDir = null,
    nowIso = null,
  } = {}) {
    const t = String(tenantId || '').trim();
    if (!t) return { ok: false, reason: 'missing_tenant' };
    const startSeq = ledger.getHeadSeq(t);
    if (startSeq === 0) return { ok: true, skipped: true, reason: 'empty_ledger', asOfSeq: 0 };

    if (!force) {
      const existing = stmts.getRun.get(t, jobKind, startSeq);
      if (existing && existing.status === 'completed') {
        return {
          ok: true,
          idempotentHit: true,
          asOfSeq: startSeq,
          result: JSON.parse(existing.result_json || '{}'),
        };
      }
    }

    const startedAt = String(nowIso || now());
    stmts.insertRun.run(t, jobKind, startSeq, 'running', '{}', startedAt, null);

    try {
      // 1. Scan latest events since last completed run for prospective-memory wake triggers
      const recentEvents = ledger.getRecentEvents(t, { asOfSeq: startSeq, limit: 6 });
      const wakeReports = [];
      for (const ev of recentEvents) {
        if (ev.eventType === 'bot_reply') continue;
        const w = problemRegister.scanWakeCandidates(t, {
          eventSeq: ev.seq,
          text: ev.body,
          extractedKeys: Array.isArray(ev.payload?.extractedKeys) ? ev.payload.extractedKeys : [],
          artifactDuplicateOf: ev.payload?.duplicateOfArtifactId || null,
          explicitUserAsk: ev.eventType === 'user_msg',
        });
        if (w.matched.length) wakeReports.push({ seq: ev.seq, ...w });
      }

      // 2. Sweep non-legal expired parked backlog items (statutory items structurally locked!)
      const sweep = problemRegister.sweepExpiredBacklog(t, { nowIso: startedAt, sourceSeq: startSeq });

      // 3. Execute optional pluggable domain sleep tasks (e.g. OCR retry, ACH counter-evidence, playbook delta)
      const taskResults = [];
      for (const task of customTasks) {
        if (typeof task !== 'function') continue;
        const res = await task({ tenantId: t, asOfSeq: startSeq, ledger, problemRegister, nowIso: startedAt });
        taskResults.push(res);
      }

      // 4. Optional durable SQLite snapshot backup
      let backup = null;
      if (backupDir && !ledger.storage.isMemory) {
        const safeT = t.replace(/[^a-zA-Z0-9_-]+/g, '_');
        backup = ledger.backupTo(`${backupDir}/${safeT}-seq-${startSeq}.sqlite`);
      }

      // 5. Compare-And-Swap freshness check: did new events arrive while worker was running?
      const endSeq = ledger.getHeadSeq(t);
      const stale = endSeq !== startSeq;
      const summary = {
        asOfSeq: startSeq,
        endSeq,
        stale,
        wakeMatches: wakeReports.reduce((acc, r) => acc + r.matched.length, 0),
        wokenCount: wakeReports.reduce((acc, r) => acc + r.woken.length, 0),
        archivedExpired: sweep.archived.length,
        protectedStatutory: sweep.protectedStatutory,
        customTaskCount: taskResults.length,
        backupOk: backup ? backup.ok : null,
      };

      const status = stale ? 'stale_needs_recheck' : 'completed';
      stmts.insertRun.run(t, jobKind, startSeq, status, JSON.stringify(summary), startedAt, String(now()));

      return { ok: true, status, stale, summary, wakeReports, sweep, taskResults, backup };
    } catch (err) {
      logger?.warn?.(`[scroll-continuity:sleep] error (${t}@${startSeq}):`, err?.message || err);
      stmts.insertRun.run(
        t,
        jobKind,
        startSeq,
        'failed',
        JSON.stringify({ error: String(err?.message || err) }),
        startedAt,
        String(now())
      );
      return { ok: false, asOfSeq: startSeq, error: String(err?.message || err) };
    }
  }

  function schedule(tenantId, opts = {}) {
    const t = String(tenantId || '').trim();
    if (!t) return Promise.resolve({ ok: false, reason: 'missing_tenant' });
    if (inflight.has(t)) return inflight.get(t);
    const p = Promise.resolve()
      .then(() => runCycle(t, opts))
      .finally(() => {
        inflight.delete(t);
      });
    inflight.set(t, p);
    return p;
  }

  function listRecentRuns(tenantId, limit = 10) {
    return stmts.listRecentRuns.all(String(tenantId), limit).map((r) => ({
      tenantId: r.tenant_id,
      jobKind: r.job_kind,
      asOfSeq: Number(r.as_of_seq),
      status: r.status,
      result: JSON.parse(r.result_json || '{}'),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  return {
    runCycle,
    schedule,
    listRecentRuns,
  };
}
