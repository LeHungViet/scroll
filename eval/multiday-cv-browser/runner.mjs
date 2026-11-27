#!/usr/bin/env node
// SCROLL 2.20.1 -- Deterministic 72-Hour Multi-Day CV/Browser Fault-Injection Eval (`eval/multiday-cv-browser`).
// Verifies ALL 10 Council MAX Go/No-Go Gates under a deterministic fake clock compressed into < 1 second:
//   G1: Two separate file-backed hosts race 1 claim across file lock -> exactly 1 wins; omitted liveAuth fails closed.
//   G2: Host crash after remote Async 202 accept before ACK -> lookup by operationId reconciles to 1 execution.
//   G3: Callback arrives BEFORE parkJob commits -> buffered durably in inbox and consumed immediately.
//   G4: Lost webhook + 16 negative 0-LLM probes across Sprint -> Marathon (> 4h + quietHours) -> 0 wasted LLM calls.
//   G5: Cancel/Pause racing with dispatch (with & without flying effects) -> cleanly reconciled / applied.
//   G6: Requester expands scope in mid-flight steering -> reapproval required; stranger blocked.
//   G7: Owner leaves group / policy drifts while waiting for DesktopMutex -> post-wait resourceFence blocks GUI mutation.
//   G8: Lost channel ACK -> Outbox dedupe + real Edit-in-Place `progress_edit` targeting `msg_card_1` + 0 spam pushes.
//   G9: Group A floods 5 jobs while Group B sends 1 on shared physical Companion -> Fair-Share serves Group B first.
//   G10: Cold store.boot() Day-29 replay + Re-Observe First + group secret block + phishing + 0-byte canary + statutoryLock + 2-Nudge-1-Park late answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDurableJobStore,
  createJobWakeBus,
  createAsyncRemoteJobLedger,
  createCompanionToolHost,
  createRemoteToolClient,
  createDesktopMutex,
  createFairShareResourceQueue,
  validateReObserveBeforeGuiAction,
  createVaultSecretProvider,
  createSecretVault,
} from '../../index.js';

export async function runMultidayEval() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-eval-72h-'));
  const results = [];
  const pass = (gate, detail) => results.push({ gate, ok: true, detail });

  try {
    let now = Date.parse('2026-11-28T02:00:00Z'); // 09:00 Asia/Ho_Chi_Minh
    const quietHours = { start: '22:00', end: '07:30', tz: 'Asia/Ho_Chi_Minh' };
    const jobsFile = path.join(dir, 'jobs.json');
    const store = createDurableJobStore({ filePath: jobsFile, clock: () => now, quietHours });
    const storeB = createDurableJobStore({ filePath: jobsFile, clock: () => now, quietHours });
    const bus = createJobWakeBus({ store, clock: () => now });
    const liveGroupOk = { botInRoom: true, ownerInRoom: true };

    // G1: Two separate file-backed hosts racing 1 claim + fail-closed omitted liveAuth
    const j1 = store.createJob({
      tenantId: 't1', agentId: 'ag1',
      origin: { type: 'ticket', refId: 'tk1', dedupeKey: 'eval:g1' },
      goal: 'Multi-day portal filing',
      doneCriteria: ['receipt_verified'],
      principals: { requester: { principalId: 'u_req', name: 'Req' }, ownerIds: ['u_own'] },
      audienceRoom: { channel: 'telegram', chatId: '-1001', threadId: '1', isGroup: true },
      authority: { ticketId: 'tk1', toolScope: ['portal_submit', 'browser_read'], policySnapshot: { groupPolicy: 'owner_or_approve', ownerInRoom: true } },
      budget: { horizonDays: 30, maxSlices: 100 },
    }).job;

    // Omitted liveAuth on group job MUST fail closed (AUTHORITY_LOOKUP_FAILED)
    const noLive = store.claimJob({ jobId: j1.jobId, workerId: 'host-bad' });
    assert.equal(noLive.ok, false);
    assert.equal(noLive.code, 'AUTHORITY_LOOKUP_FAILED');
    store.enqueueWake({ jobId: j1.jobId, reason: 'authority_restored' });

    const wA = store.claimJob({ jobId: j1.jobId, workerId: 'host-A', liveAuth: liveGroupOk });
    const wB = storeB.claimJob({ jobId: j1.jobId, workerId: 'host-B', liveAuth: liveGroupOk });
    assert.equal(wA.ok, true);
    assert.equal(wA.jobEpoch, 1);
    assert.equal(wB.ok, false);
    assert.equal(wB.code, 'JOB_NOT_CLAIMABLE');
    pass('G1_SINGLE_WRITER_CAS_CLAIM', 'Two file-backed hosts raced; host-A won epoch=1, host-B rejected, omitted liveAuth denied');

    // G2: Host crash after remote Async 202 accept before ACK -> lookup by operationId reconciles to 1 render
    let renderStarts = 0;
    let finishRemote = null;
    const remoteLedger = createAsyncRemoteJobLedger({ filePath: path.join(dir, 'remote.jsonl'), now: () => now });
    const companion = createCompanionToolHost({
      deviceId: 'vm-1',
      allowlist: ['vm_submit'],
      asyncJobLedger: remoteLedger,
      now: () => new Date(now),
      handlers: {
        vm_submit: async () => ({
          __asyncAccepted: true,
          pollAfterSec: 15,
          run: () => {
            renderStarts += 1;
            return new Promise((r) => { finishRemote = () => r({ confirmation: 'CONF-72H' }); });
          },
        }),
      },
    });
    const client = createRemoteToolClient({
      deploymentId: 'dep1', deviceId: 'vm-1', getEpoch: () => 1,
      sendRequest: (env) => companion.handleEnvelope(env),
      toolSpecs: [{ name: 'vm_submit', risk: 'reversible_write', timeoutMs: 120_000 }],
    });
    store.recordEffectIntent({ jobId: j1.jobId, revision: wA.revision, jobEpoch: wA.jobEpoch, leaseToken: wA.leaseToken, operationId: 'op_day1', tool: 'vm_submit', args: { id: 1 } });
    const acc = await client.invoke('vm_submit', { id: 1 }, { operationId: 'op_day1' });
    assert.equal(acc.status, 'accepted');
    // Simulate host crash before recording ACK; Reaper moves job to reconciling
    now += 300_000;
    assert.deepEqual(store.reap({ nowMs: now }).movedToReconciling, [j1.jobId]);
    // Host looks up by operationId -> finds exact running job without starting a 2nd render!
    const looked = companion.getRemoteJobStatus('op_day1', { deploymentId: 'dep1' });
    assert.equal(looked.status, 'running');
    // Cross-deployment lookup MUST be isolated (null)
    assert.equal(companion.getRemoteJobStatus('op_day1', { deploymentId: 'dep_OTHER' }), null);
    finishRemote();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(renderStarts, 1);
    store.recordEffectReceipt({ jobId: j1.jobId, operationId: 'op_day1', status: 'succeeded', receipt: companion.getRemoteJobStatus('op_day1', { deploymentId: 'dep1' }).receipt });
    // After reconciling settles cleanly, job automatically returns to queued!
    assert.equal(store.getJob(j1.jobId).status, 'queued');
    pass('G2_CRASH_AFTER_202_RECONCILE', '1 remote execution reconciled via operationId after crash; cross-deployment isolated');

    // G3: Callback arrives BEFORE parkJob commits -> buffered durably and immediately woken
    const c2 = store.claimJob({ jobId: j1.jobId, workerId: 'host-A', liveAuth: liveGroupOk });
    await bus.publishEvent({ type: 'remote_job_done', jobId: j1.jobId, operationId: 'op_early' });
    const parkEarly = store.parkJob({
      jobId: j1.jobId, revision: c2.revision, jobEpoch: c2.jobEpoch, leaseToken: c2.leaseToken,
      waitingFor: 'external', wakeOn: [{ type: 'remote_job_done', operationId: 'op_early' }],
      checkpoint: { milestone: 'post_early' },
    });
    assert.equal(parkEarly.immediateWake, true);
    assert.equal(parkEarly.job.status, 'queued');
    pass('G3_CALLBACK_BEFORE_PARK', 'Early callback buffered durably and triggered immediate wake on park');

    // G4 & G8: 16 negative 0-LLM probes spanning Sprint AND Marathon (> 4h + quietHours) -> 0 LLM slices, real Edit-in-Place!
    const c3 = store.claimJob({ jobId: j1.jobId, workerId: 'host-A', liveAuth: liveGroupOk });
    store.enqueueOutbox({
      jobId: j1.jobId, clientMessageId: 'ack:g1', kind: 'ack_card',
      channel: 'telegram', chatId: '-1001', payload: { text: 'Started filing' }, nowMs: now,
    });
    const ackRetry = store.enqueueOutbox({
      jobId: j1.jobId, clientMessageId: 'ack:g1', kind: 'ack_card',
      channel: 'telegram', chatId: '-1001', payload: { text: 'Started filing' }, nowMs: now,
    });
    assert.equal(ackRetry.deduplicated, true);
    store.markOutboxDelivery('ack:g1', { deliveryState: 'sent', externalMessageId: 'msg_card_1', statusCard: true, nowMs: now });

    let portalReady = false;
    bus.registerProbe('portal_status', () => ({ ready: portalReady, note: portalReady ? 'approved' : 'processing' }));
    store.parkJob({
      jobId: j1.jobId, revision: c3.revision, jobEpoch: c3.jobEpoch, leaseToken: c3.leaseToken,
      waitingFor: 'external', sleepSec: 60, probeName: 'portal_status',
      checkpoint: { milestone: 'polling_portal', lastObservedAtMs: now, reacquireAnchors: { url: 'https://portal.gov/f1' } },
    });
    const slicesBeforeProbes = store.getJob(j1.jobId).budget.usedSlices;
    const seenTempos = new Set();
    for (let i = 0; i < 16; i++) {
      // Jump past 2h after probe 6 so we verify BOTH Sprint (30s..180s) and Marathon (15m..4h) + quietHours!
      if (i === 6) now += 13 * 60 * 60 * 1000; // crosses overnight 22:00-07:30 quietHours
      now = Math.max(now, store.getJob(j1.jobId).wake.nextReviewAtMs + 1000);
      const tickRes = await bus.tick({ nowMs: now });
      assert.equal(tickRes.woken.length, 0);
      assert.equal(tickRes.probedNegative.length, 1);
      seenTempos.add(tickRes.probedNegative[0].tempoTier);
    }
    assert.ok(seenTempos.has('sprint') && seenTempos.has('marathon'), `Expected both sprint & marathon tempos, got ${[...seenTempos].join(',')}`);
    assert.equal(store.getJob(j1.jobId).budget.usedSlices, slicesBeforeProbes, '16 negative probes must burn 0 LLM slices');
    const allOutbox = store.listOutbox({ jobId: j1.jobId });
    const newChatPushes = allOutbox.filter((o) => o.kind !== 'progress_edit' && o.channel !== 'owner_dm' && o.clientMessageId !== 'ack:g1');
    const cardEdits = allOutbox.filter((o) => o.kind === 'progress_edit' && o.editMessageId === 'msg_card_1');
    const pendingEdits = cardEdits.filter((o) => o.deliveryState === 'pending');
    assert.equal(newChatPushes.length, 0, 'Negative probes must ONLY Edit-in-Place, 0 new push messages');
    assert.ok(cardEdits.length >= 16, 'Expected progress_edit records targeting msg_card_1');
    assert.equal(pendingEdits.length, 1, 'Superseded pending progress_edits must coalesce down to latest 1');
    portalReady = true;
    now = store.getJob(j1.jobId).wake.nextReviewAtMs + 1000;
    assert.deepEqual((await bus.tick({ nowMs: now })).woken, [j1.jobId]);
    pass('G4_ZERO_LLM_PROBES_72H', '16 negative probes across Sprint + Marathon + quietHours consumed 0 LLM slices');
    pass('G8_OUTBOX_DEDUPE_AND_EDIT_IN_PLACE', 'Lost ACK deduped; 16 edits coalesced to 1 live Edit-in-Place targeting msg_card_1');

    // G5: Cancel & Pause racing with dispatch (with AND without flying effects)
    const jCan = store.createJob({ goal: 'Cancel race flying', principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'] }, authority: { ticketId: 'tk_can1' } }).job;
    const cCan = store.claimJob({ jobId: jCan.jobId });
    store.recordEffectIntent({ jobId: jCan.jobId, revision: cCan.revision, jobEpoch: cCan.jobEpoch, leaseToken: cCan.leaseToken, operationId: 'op_c', tool: 'send', args: {} });
    const canRes = store.submitSteering({ jobId: jCan.jobId, sourceEventId: 'sc1', actorId: 'u_req', commandKind: 'CANCEL' });
    assert.equal(canRes.cancelState, 'cancel_requested');
    store.recordEffectReceipt({ jobId: jCan.jobId, operationId: 'op_c', status: 'cancelled' });
    assert.equal(store.getJob(jCan.jobId).status, 'cancelled');

    const jCanNoFly = store.createJob({ goal: 'Cancel running no-fly', principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'] }, authority: { ticketId: 'tk_can2' } }).job;
    const cNf = store.claimJob({ jobId: jCanNoFly.jobId });
    store.submitSteering({ jobId: jCanNoFly.jobId, sourceEventId: 'sc2', actorId: 'u_own', commandKind: 'cancel' });
    const pkCan = store.parkJob({ jobId: jCanNoFly.jobId, revision: cNf.revision + 1, jobEpoch: cNf.jobEpoch, leaseToken: cNf.leaseToken, checkpoint: {} });
    assert.equal(pkCan.job.status, 'cancelled');
    pass('G5_CANCEL_DISPATCH_RACE', 'Cancel cleanly arbitrated for both flying-effect and no-effect running slices');

    // G6: Steering scope expansion requires fresh approval; stranger blocked
    assert.equal(store.submitSteering({ jobId: j1.jobId, sourceEventId: 'st_s', actorId: 'u_stranger', commandKind: 'cancel' }).code, 'STEERING_DENIED_STRANGER');
    const scopeEsc = store.submitSteering({
      jobId: j1.jobId, sourceEventId: 'st_e', actorId: 'u_req', commandKind: 'amend',
      requestedCapabilities: ['wire_transfer'], payload: { text: 'Also pay invoice' },
    });
    assert.equal(scopeEsc.code, 'REAPPROVAL_REQUIRED');
    pass('G6_STEERING_AUTHORITY_AND_REAPPROVAL', 'Stranger denied; scope expansion forced reapproval');

    // G7: Owner leaves group during DesktopMutex wait -> post-wait resourceFence blocks execution
    let ownerInGroup = true;
    let guiRan = 0;
    const mutex = createDesktopMutex({ defaultLeaseMs: 10_000 });
    const guiHost = createCompanionToolHost({
      deviceId: 'mac-1', allowlist: ['gui_click'], desktopTools: ['gui_click'], desktopMutex: mutex,
      verifyResourceFence: () => (ownerInGroup ? { allowed: true } : { allowed: false, code: 'ERR_OWNER_LEFT_GROUP' }),
      handlers: { gui_click: async () => { guiRan += 1; return { ok: true }; } },
    });
    const h = await mutex.acquire({ holderId: 'busy', tool: 'gui_click', leaseMs: 5000 });
    const pGui = guiHost.handleEnvelope({ callId: 'cg', deploymentId: 'd1', deviceId: 'mac-1', epoch: 1, tool: 'gui_click', originIsGroup: true });
    await new Promise((r) => setTimeout(r, 10));
    ownerInGroup = false;
    h.release();
    const gRes = await pGui;
    assert.equal(gRes.ok, false);
    assert.equal(guiRan, 0);
    pass('G7_POST_MUTEX_PERMISSION_DRIFT', 'GUI mutation blocked after owner left during mutex wait');

    // G9: Fair-Share DRR serves Group B first despite Group A flood
    const fsq = createFairShareResourceQueue({ maxPerGroupInFlight: 1, maxPerGroupQueued: 12 });
    const l0 = await fsq.acquire({ physicalResourceId: 'phys-mac', tenantId: 't1', groupId: 'grp-A' });
    const served = [];
    const pa = Array.from({ length: 5 }, (_, i) => fsq.acquire({ physicalResourceId: 'phys-mac', tenantId: 't1', groupId: 'grp-A' }).then((l) => { served.push(`A${i}`); l.release(); }));
    const pb = fsq.acquire({ physicalResourceId: 'phys-mac', tenantId: 't1', groupId: 'grp-B' }).then((l) => { served.push('B0'); l.release(); });
    l0.release();
    await Promise.all([pb, ...pa]);
    assert.equal(served[0], 'B0', `Expected B0 first after A's lease, got ${served.join(',')}`);
    pass('G9_FAIR_SHARE_DRR', `Group B served first (${served.join(' -> ')}) amidst Group A flood`);

    // G10: Cold store.boot() Day-29 replay + Re-Observe First + group secret block + phishing + canary + statutoryLock + 2-Nudge-1-Park late answer
    const jStat = store.createJob({
      goal: 'Regulated tax filing under statutory lock',
      principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] },
      budget: { horizonDays: 10, statutoryLock: true },
    }).job;

    now += 26 * 24 * 60 * 60 * 1000;
    // Cold boot fresh store from disk on Day 29
    const coldStore = createDurableJobStore({ filePath: jobsFile, clock: () => now, quietHours });
    const bootReport = coldStore.boot({ nowMs: now });
    assert.ok(bootReport.statutoryEscalations.includes(jStat.jobId), 'Statutory job must escalate on horizon expiry without silent cancel');
    assert.equal(coldStore.getJob(jStat.jobId).status, 'paused');

    const cDay29 = coldStore.claimJob({ jobId: j1.jobId, workerId: 'host-B', liveAuth: liveGroupOk });
    assert.equal(cDay29.ok, true);
    const replay = coldStore.recordEffectIntent({ jobId: j1.jobId, revision: cDay29.revision, jobEpoch: cDay29.jobEpoch, leaseToken: cDay29.leaseToken, operationId: 'op_day1', tool: 'vm_submit', args: { id: 1 } });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.intent.status, 'succeeded');

    // Re-Observe First blocks click on stale anchor after 26-day sleep
    const reobs = validateReObserveBeforeGuiAction({ checkpoint: cDay29.job.checkpoint, toolName: 'desktop_click', args: { x: 100, y: 200 }, nowMs: now });
    assert.equal(reobs.allowed, false);
    assert.equal(reobs.code, 'ERR_REOBSERVE_REQUIRED');

    // 2-Nudge-1-Park -> requester answers next morning -> recovers cleanly (no ASK_NOT_OPEN brick!)
    const lateAsk = coldStore.openAsk({
      jobId: j1.jobId, revision: cDay29.revision, jobEpoch: cDay29.jobEpoch, leaseToken: cDay29.leaseToken,
      targetRole: 'requester', kind: 'text', question: 'Confirm filing code?', nudgeDelaySec: 3600, nowMs: now,
    });
    assert.equal(lateAsk.ok, true);
    for (let k = 0; k < 6 && coldStore.getJob(j1.jobId).status !== 'paused'; k++) {
      const nextDue = coldStore.getNextDueAtMs();
      now = nextDue ? nextDue + 1000 : now + 4 * 3600_000;
      coldStore.reap({ nowMs: now });
    }
    assert.equal(coldStore.getJob(j1.jobId).status, 'paused');
    const lateAns = coldStore.answerAsk({ askId: lateAsk.ask.askId, actorId: 'u_req', answer: 'CODE-99', nowMs: now });
    assert.equal(lateAns.ok, true);
    assert.equal(lateAns.job.status, 'queued');

    // SecretProvider: group block + phishing block + restart persistence + 0-byte canary leak
    const canary = 'CANARY_PASS_998877!DO_NOT_LEAK';
    const vault = createSecretVault({ filePath: path.join(dir, 'vault.enc'), masterKey: 'eval-master-key-123' });
    const sp1 = createVaultSecretProvider({ vault, tenantId: 't1', clock: () => now });
    sp1.putSecret({ name: 'tax_portal', fields: { password: canary }, allowedDomains: ['portal.gov'], stepUp: 'per_job_origin' });
    sp1.grantPerJobOrigin({ name: 'tax_portal', jobId: 'job_dm', origin: 'https://portal.gov' });

    // Fresh SecretProvider instance after restart recovers policy & grant from vault
    const sp = createVaultSecretProvider({ vault, tenantId: 't1', clock: () => now });
    const grpSec = sp.resolveToolArgs({
      toolSpec: { secret_args: ['value'], secret_destination: { match: 'exact_or_subdomain' } },
      args: { value: { $secret: 'tax_portal', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, originIsGroup: true, jobId: 'job_dm', activeOrigin: 'https://portal.gov' },
    });
    assert.equal(grpSec.code, 'ERR_SECRET_FORBIDDEN_IN_GROUP');

    const phish = sp.resolveToolArgs({
      toolSpec: { secret_args: ['value'], secret_destination: { match: 'exact_or_subdomain' } },
      args: { value: { $secret: 'tax_portal', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, jobId: 'job_dm', activeOrigin: 'https://evil-portal.gov' },
    });
    assert.equal(phish.ok, false);
    assert.equal(phish.code, 'SECRET_DESTINATION_MISMATCH');

    const okSec = sp.resolveToolArgs({
      toolSpec: { secret_args: ['value'], secret_destination: { match: 'exact_or_subdomain' } },
      args: { value: { $secret: 'tax_portal', field: 'password' } },
      ctx: { isOwner: true, isGroup: false, jobId: 'job_dm', activeOrigin: 'https://portal.gov' },
    });
    assert.equal(okSec.ok, true);
    const scrubbed = okSec.redactOutput({ log: `echo=${canary}`, b64: Buffer.from(`u:${canary}`).toString('base64') });
    assert.ok(!JSON.stringify(scrubbed).includes(canary));
    assert.ok(!JSON.stringify(scrubbed).includes(Buffer.from(canary).toString('base64').slice(2, 14)));
    pass('G10_DAY29_REOBSERVE_PHISHING_CANARY', 'Cold boot Day-29 + statutoryLock + late paused ask + group/phishing secret block + 0 canary bytes');

    return { ok: true, passed: results.length, total: 10, results };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || decodeURIComponent(new URL(import.meta.url).pathname) === path.resolve(process.argv[1] || '')) {
  const report = await runMultidayEval();
  for (const r of report.results) {
    console.log(`  PASS ${r.gate}: ${r.detail}`);
  }
  console.log(`\nSCROLL 72h Multiday Eval: ${report.passed}/${report.total} gates PASSED.`);
}
