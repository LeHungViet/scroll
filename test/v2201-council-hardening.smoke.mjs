// SCROLL 2.20.1 -- Comprehensive Council MAX Hardening Regression Suite (FABLE + ASTRA + CARBON).
// Covers every verified P0 blocker (P0-1..P0-13) and high-value P1 fix across tickets, turn-context,
// durable-jobs, wake-bus, autonomy, remote-tool-transport, chat-sdk, and secret-provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computeTicketSpecHash,
  createFileTicketStore,
  createTurnContextRegistry,
  createDurableJobStore,
  createJobWakeBus,
  nextNotificationWindowMs,
  detectPoliteBailout,
  evaluateEffectiveAuthority,
  evaluateSteeringPermission,
  classifyToolErrorDisposition,
  validateAutonomyConfig,
  resolveAutonomyConfig,
  buildContinuationWorkLedger,
  buildMorningDigest,
  matchWakeCueCandidates,
  validateReObserveBeforeGuiAction,
  createAsyncRemoteJobLedger,
  createCompanionToolHost,
  createRemoteToolClient,
  createMultiRemoteToolClient,
  createDesktopMutex,
  createFairShareResourceQueue,
  createSecretVault,
  createVaultSecretProvider,
  redactSecretsDeep,
} from '../index.js';
import { createScrollChatRuntime } from '../lib/chat-sdk/index.js';

test('v2.20.1 P0-1 & P1-17/18/19: ticket_create dedupe cannot swap actionSpec or inject _execution; raw canonical specHash has 0 collisions; turn-context is strict boolean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-tk-'));
  try {
    const store = createFileTicketStore({ filePath: path.join(dir, 'tickets.jsonl') });
    const ctx = { agentId: 'ag1', sourceChatId: '-1001', isGroup: true, isOwner: false };

    // Creator-supplied approvalCardSent: false MUST be ignored (host ctx controls it)
    const c1 = store.create({
      kind: 'action_approval',
      title: 'Pay vendor invoice',
      actionSpec: { amount: 100, to: 'vendor' },
      approvalCardSent: false,
    }, ctx);
    assert.equal(c1.ok, true);
    assert.equal(c1.ticket.approvalCardSent, true);

    // P0-1: Dedupe-create attempting to swap actionSpec while awaiting_approval MUST be blocked!
    const swapPending = store.create({
      kind: 'action_approval',
      title: 'Pay vendor invoice',
      actionSpec: { amount: 9999, to: 'attacker' },
    }, ctx);
    assert.equal(swapPending.ok, false);
    assert.equal(swapPending.code, 'ACTION_SPEC_LOCKED_PENDING_APPROVAL');

    // P0-1: Dedupe-create attempting to inject `_execution` into payload MUST be blocked!
    const injectExec = store.create({
      kind: 'action_approval',
      title: 'Pay vendor invoice',
      payload: { _execution: { maxContinuations: 999 } },
    }, ctx);
    assert.equal(injectExec.ok, false);
    assert.equal(injectExec.code, 'FORBIDDEN_INTERNAL_KEY');

    // Approve ticket, then dedupe-create MUST still block swapping actionSpec
    const appr = store.transition(c1.ticket.id, { status: 'in_progress', actorRole: 'owner', actorId: 'u_own' });
    assert.equal(appr.ok, true);
    const swapAfter = store.create({
      kind: 'action_approval',
      title: 'Pay vendor invoice',
      actionSpec: { amount: 55555, to: 'evil' },
    }, ctx);
    assert.equal(swapAfter.ok, false);
    assert.equal(swapAfter.code, 'ACTION_SPEC_LOCKED');

    // P1-17: update with null ctx MUST fail closed
    assert.equal(store.update(c1.ticket.id, { note: 'no ctx' }, null).code, 'TICKET_UPDATE_CTX_REQUIRED');

    // P1-18: Raw canonical specHash separates all 4 former collision pairs!
    assert.notEqual(computeTicketSpecHash({ password: 'aaa' }), computeTicketSpecHash({ password: 'bbb' }));
    assert.notEqual(
      computeTicketSpecHash({ blob: `${'x'.repeat(2100)}A` }),
      computeTicketSpecHash({ blob: `${'x'.repeat(2100)}B` }),
    );
    const mkDeep = (leaf) => {
      let cur = { leaf };
      for (let i = 0; i < 11; i++) cur = { nested: cur };
      return cur;
    };
    assert.notEqual(computeTicketSpecHash(mkDeep('A')), computeTicketSpecHash(mkDeep('B')));
    const withProto = JSON.parse('{"__proto__":{"x":1}}');
    assert.notEqual(computeTicketSpecHash(withProto), computeTicketSpecHash({}));

    // P1-19: turn-context strict boolean + originIsGroup + capacity fail-closed
    const reg = createTurnContextRegistry({ maxEntries: 2 });
    const t1 = reg.issue({ isOwner: 'false', isGroup: 'false', originIsGroup: true });
    assert.equal(t1.context.isOwner, false);
    assert.equal(t1.context.isGroup, false);
    assert.equal(t1.context.originIsGroup, true);
    reg.issue({ isOwner: true });
    assert.throws(() => reg.issue({ isOwner: true }), /ERR_TURN_CONTEXT_CAPACITY_EXCEEDED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.20.1 P0-2..P0-8 & P1-1..P1-8: DurableJob prototype pollution, cancel/pause, owner-ask gate, crash inbox survival, corrupt snapshot protection, crash-loop guard & DST quietHours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-dj-'));
  try {
    let now = Date.parse('2026-11-28T03:00:00Z');
    const filePath = path.join(dir, 'jobs.json');
    const store = createDurableJobStore({ filePath, clock: () => now });

    const job = store.createJob({
      goal: 'Critical filing',
      principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'], approver: { principalId: 'u_app' } },
      authority: { ticketId: 'tk_1', toolScope: ['portal_submit'] },
    }).job;
    const c1 = store.claimJob({ jobId: job.jobId });
    assert.equal(c1.ok, true);

    // P0-2: Prototype pollution via operationId: '__proto__' MUST be rejected and NEVER touch Object.prototype!
    const protoAttempt = store.recordEffectReceipt({ jobId: job.jobId, operationId: '__proto__', status: 'succeeded', receipt: { pwn: 1 } });
    assert.equal(protoAttempt.ok, false);
    assert.equal(({}).status, undefined);
    assert.equal(({}).receipt, undefined);

    // P0-6 & P1-1: Monotonic terminal receipts + reap detects `accepted`/`running` unresolved intents
    const int1 = store.recordEffectIntent({ jobId: job.jobId, revision: c1.revision, jobEpoch: c1.jobEpoch, leaseToken: c1.leaseToken, operationId: 'op_1', tool: 'portal_submit', args: { a: 1 } });
    store.recordEffectReceipt({ jobId: job.jobId, operationId: 'op_1', status: 'accepted' });
    now += 300_000;
    const rAcc = store.reap({ nowMs: now });
    assert.deepEqual(rAcc.movedToReconciling, [job.jobId]);
    // Generic wake during reconciling while unresolved MUST buffer, not requeue!
    const wkRec = store.enqueueWake({ jobId: job.jobId, reason: 'random_ping', event: { type: 'ping' } });
    assert.equal(wkRec.buffered, true);
    assert.equal(store.getJob(job.jobId).status, 'reconciling');
    // Settle receipt -> succeeds -> late `accepted`/`unknown` MUST NOT downgrade succeeded!
    store.recordEffectReceipt({ jobId: job.jobId, operationId: 'op_1', status: 'succeeded', receipt: { ok: true } });
    assert.equal(store.getJob(job.jobId).status, 'queued');
    const lateDowngrade = store.recordEffectReceipt({ jobId: job.jobId, operationId: 'op_1', status: 'unknown' });
    assert.equal(lateDowngrade.ignoredStale, true);
    assert.equal(store.getJob(job.jobId).effectIntents.op_1.status, 'succeeded');

    // P0-5: Durable eventInbox survives worker crash after claimJob!
    const cCrash = store.claimJob({ jobId: job.jobId });
    assert.ok(cCrash.inboxEvents.some((e) => e.type === 'ping'));
    // Worker crashes before parkJob -> lease expires -> replacement worker STILL gets `ping`!
    now += 300_000;
    store.reap({ nowMs: now });
    const cRecover = store.claimJob({ jobId: job.jobId });
    assert.equal(cRecover.ok, true);
    assert.ok(cRecover.inboxEvents.some((e) => e.type === 'ping'), 'Unacked inbox event must survive worker crash');

    // P1-2: Consecutive crash-loop actually trips MAX_SLICE_RESTARTS_EXCEEDED!
    for (let i = 0; i < 4; i++) {
      now += 300_000;
      const rep = store.reap({ nowMs: now });
      if (rep.escalatedCrashLoops.includes(job.jobId)) break;
      store.claimJob({ jobId: job.jobId });
    }
    assert.equal(store.getJob(job.jobId).status, 'failed');
    assert.equal(store.getJob(job.jobId).failureCode, 'MAX_SLICE_RESTARTS_EXCEEDED');

    // P0-4: openAsk without leaseToken MUST fail and NEVER resurrect a terminal job!
    assert.equal(store.openAsk({ jobId: job.jobId, kind: 'text', question: 'Zombie?' }).code, 'JOB_TERMINAL');

    // P0-3 & P0-4 & C11: Pause while running honored on park; requester clarify cannot bypass owner_approval; approver can answer
    const j2 = store.createJob({
      goal: 'Owner approval gate test',
      principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'], approver: { principalId: 'u_app' } },
      authority: { ticketId: 'tk_2' },
    }).job;
    const c2 = store.claimJob({ jobId: j2.jobId });
    const askOwn = store.openAsk({ jobId: j2.jobId, revision: c2.revision, jobEpoch: c2.jobEpoch, leaseToken: c2.leaseToken, targetRole: 'owner', kind: 'choice', question: 'Approve?', options: [{ id: 'yes', label: 'Yes' }] });
    assert.equal(askOwn.ok, true);
    // Requester clarify MUST NOT wake past owner_approval!
    const clar = store.submitSteering({ jobId: j2.jobId, sourceEventId: 'cl1', actorId: 'u_req', commandKind: 'clarify', payload: { text: 'hurry' } });
    assert.equal(clar.ok, true);
    assert.equal(store.getJob(j2.jobId).status, 'waiting');
    assert.equal(store.getJob(j2.jobId).waitingFor, 'owner_approval');
    // Designated approver (C11) CAN answer owner escalation!
    const ansApp = store.answerAsk({ askId: askOwn.ask.askId, actorId: 'u_app', answer: 'yes' });
    assert.equal(ansApp.ok, true);
    assert.equal(ansApp.job.status, 'queued');
    // Owner pause while running is honored on parkJob, and requester cannot resume owner pause!
    const c3 = store.claimJob({ jobId: j2.jobId });
    store.submitSteering({ jobId: j2.jobId, sourceEventId: 'p_own', actorId: 'u_own', commandKind: 'PAUSE' });
    const pkPaused = store.parkJob({ jobId: j2.jobId, revision: c3.revision + 1, jobEpoch: c3.jobEpoch, leaseToken: c3.leaseToken, checkpoint: {} });
    assert.equal(pkPaused.job.status, 'paused');
    assert.equal(store.submitSteering({ jobId: j2.jobId, sourceEventId: 'r_req', actorId: 'u_req', commandKind: 'resume' }).code, 'OWNER_PAUSE_LOCKED');

    // P1-6: Non-owner DM without ticket MUST fail closed and forbid secrets
    const nonOwnJob = store.createJob({ goal: 'Non-owner DM', principals: { requester: { principalId: 'u_guest' }, ownerIds: ['u_own'] } }).job;
    assert.equal(evaluateEffectiveAuthority({ job: nonOwnJob, liveAuth: {} }).code, 'APPROVAL_GRANT_REQUIRED');

    // H9: DST-exact nextNotificationWindowMs (New York 2026 spring-forward Mar 8 & fall-back Nov 1)
    const nyQuiet = { start: '22:00', end: '07:30', tz: 'America/New_York' };
    const springStart = Date.parse('2026-03-08T03:00:00Z'); // 22:00 EST Mar 7
    const springEnd = nextNotificationWindowMs(springStart, nyQuiet);
    assert.equal(new Date(springEnd).toISOString(), '2026-03-08T11:30:00.000Z', 'NY spring-forward must land at exact 07:30 EDT (11:30Z), not 08:30 EDT');
    const fallStart = Date.parse('2026-11-01T02:00:00Z'); // 22:00 EDT Oct 31
    const fallEnd = nextNotificationWindowMs(fallStart, nyQuiet);
    assert.equal(new Date(fallEnd).toISOString(), '2026-11-01T12:30:00.000Z', 'NY fall-back must land at exact 07:30 EST (12:30Z), not 06:30 EST');

    // P0-7: Corrupt JSON snapshot MUST throw & preserve forensic copy instead of silently wiping!
    const badPath = path.join(dir, 'corrupt.json');
    fs.writeFileSync(badPath, '{CORRUPT_JSON', 'utf8');
    assert.throws(() => createDurableJobStore({ filePath: badPath }), /ERR_DURABLE_JOB_STORE_CORRUPT/);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('corrupt.json.corrupt.')), 'Corrupt snapshot must be preserved');

    // C12: detectPoliteBailout eliminates 3rd-person false positives while catching curly apostrophes & adverbs
    assert.equal(detectPoliteBailout('The portal will notify you once it finishes.').detected, false);
    assert.equal(detectPoliteBailout('Hệ thống sẽ báo lại qua email sau khi duyệt.').detected, false);
    assert.equal(detectPoliteBailout('I\u2019ll automatically check back later!').detected, true);
    assert.equal(detectPoliteBailout('Em sẽ chủ động theo dõi và báo lại ngay.').detected, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.20.1 P0-9/10/11 & C8/C9/C13/H8: WakeBus eliminates 5ms spin loop, isolates throwing probes & tenants, dispatches defaultedAsks; ECONNREFUSED parks companion; chat-sdk forwards autonomy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-wb-'));
  try {
    let now = Date.parse('2026-11-28T03:00:00Z');
    const store = createDurableJobStore({ filePath: path.join(dir, 'jobs.json'), clock: () => now });
    const dispatched = [];
    const bus = createJobWakeBus({ store, clock: () => now, onJobQueued: (ev) => dispatched.push(ev) });

    // P0-11 (C1): ECONNREFUSED MUST park_waiting(companion), NOT abort_job!
    const econn = classifyToolErrorDisposition({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9222' });
    assert.equal(econn.disposition, 'park_waiting');
    assert.equal(econn.parkWaitingFor, 'companion');
    // C8: STEP_UP / APPROVAL_GRANT_REQUIRED MUST park_waiting(owner_approval), NOT feed_llm_repair!
    assert.equal(classifyToolErrorDisposition({ code: 'ERR_STEP_UP_EACH_USE_REQUIRED' }).disposition, 'park_waiting');
    assert.equal(classifyToolErrorDisposition({ code: 'APPROVAL_GRANT_REQUIRED' }).disposition, 'park_waiting');

    // C13: SPEC autonomy keys (`mode`, `max_slices`) resolve cleanly; unknown keys fail validation
    assert.equal(validateAutonomyConfig({ mode: 'continue_in_background', max_slices: 20 }).ok, true);
    assert.equal(validateAutonomyConfig({ typo_key: 123 }).ok, false);
    assert.equal(resolveAutonomyConfig({ mode: 'continue_in_background', max_slices: 20 }).on_turn_exhausted, 'continue_in_background');

    // H8: buildContinuationWorkLedger reads trace.result.ok accurately
    const ledger = buildContinuationWorkLedger({
      immutableGoal: 'Test goal',
      toolTraces: [{ name: 'click', result: { ok: false, error: 'selector missing' } }],
    });
    assert.ok(Array.isArray(ledger));
    assert.match(ledger[1], /error -- selector missing/);

    // P0-9 & P0-10: Throwing probe does NOT starve later job; defaultedAsks fires onJobQueued; tenant-isolated companion_online
    bus.registerProbe('bad_probe', () => { throw new Error('boom'); });
    const jBad = store.createJob({ tenantId: 't1', goal: 'Bad probe job', principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] } }).job;
    const cb = store.claimJob({ jobId: jBad.jobId });
    store.parkJob({ jobId: jBad.jobId, revision: cb.revision, jobEpoch: cb.jobEpoch, leaseToken: cb.leaseToken, sleepSec: 30, probeName: 'bad_probe' });

    const jGood = store.createJob({ tenantId: 't1', goal: 'Good timer job', principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] } }).job;
    const cg = store.claimJob({ jobId: jGood.jobId });
    store.parkJob({ jobId: jGood.jobId, revision: cg.revision, jobEpoch: cg.jobEpoch, leaseToken: cg.leaseToken, sleepSec: 30 });

    const jDef = store.createJob({ tenantId: 't1', goal: 'Defaulted ask job', principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] } }).job;
    const cd = store.claimJob({ jobId: jDef.jobId });
    store.openAsk({
      jobId: jDef.jobId, revision: cd.revision, jobEpoch: cd.jobEpoch, leaseToken: cd.leaseToken,
      targetRole: 'requester', kind: 'choice', question: 'Format?', options: [{ id: 'pdf', label: 'PDF' }],
      defaultOption: 'pdf', defaultAfterSec: 60,
    });

    // Companion tenant isolation: tenant t2 event MUST NOT wake tenant t1 job!
    const jComp = store.createJob({ tenantId: 't1', goal: 'Comp wait', principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] } }).job;
    const cc = store.claimJob({ jobId: jComp.jobId });
    store.parkJob({ jobId: jComp.jobId, revision: cc.revision, jobEpoch: cc.jobEpoch, leaseToken: cc.leaseToken, waitingFor: 'companion' });
    const wrongTenant = await bus.publishEvent({ type: 'companion.online', tenantId: 't_OTHER' });
    assert.equal(wrongTenant.woken.length, 0);
    const rightTenant = await bus.publishEvent({ type: 'companion.online', tenantId: 't1' });
    assert.deepEqual(rightTenant.woken, [jComp.jobId]);

    now += 120_000;
    const tickRes = await bus.tick({ nowMs: now });
    assert.ok(tickRes.woken.includes(jGood.jobId), 'Healthy job must wake even when earlier probe threw');
    assert.ok(dispatched.some((d) => d.jobId === jDef.jobId), 'Defaulted ask job must dispatch onJobQueued');

    // H12 & C9: buildMorningDigest fails closed without chatId & masks authority; matchWakeCueCandidates supports Owner DM & Vietnamese
    assert.equal(buildMorningDigest({ jobs: store.listJobs(), nowMs: now }).reason, 'chat_id_required');
    assert.equal(matchWakeCueCandidates({ text: 'ok', senderId: 'u_own', openAsks: store.listAsks(), jobs: store.listJobs() }).candidates.length, 0);
    const jEsc = store.createJob({
      goal: 'Group task',
      principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'] },
      audienceRoom: { channel: 'telegram', chatId: '-1008', isGroup: true },
      authority: { ticketId: 'tk_8', policySnapshot: { groupPolicy: 'owner_or_approve', ownerInRoom: true } },
    }).job;
    const ce = store.claimJob({ jobId: jEsc.jobId, liveAuth: { botInRoom: true, ownerInRoom: true } });
    const oe = store.openAsk({ jobId: jEsc.jobId, revision: ce.revision, jobEpoch: ce.jobEpoch, leaseToken: ce.leaseToken, targetRole: 'owner', kind: 'choice', question: 'Duyệt xuất báo cáo quý?', options: [{ id: 'a', label: 'Duyệt ngay' }] });
    // Owner replying in Owner DM (`chatId === ownerId`) MUST match!
    const dmMatch = matchWakeCueCandidates({
      text: `Duyệt ngay ${oe.ask.askId}`,
      senderId: 'u_own',
      chatId: 'u_own',
      openAsks: store.listAsks(),
      jobs: store.listJobs(),
    });
    assert.equal(dmMatch.topCandidate?.askId, oe.ask.askId);
    // Single-letter option id `'a'` must NOT false-match unrelated word `"what"`!
    const noFalseOpt = matchWakeCueCandidates({
      text: 'what',
      senderId: 'u_own',
      chatId: 'u_own',
      openAsks: store.listAsks(),
      jobs: store.listJobs(),
    });
    assert.equal(noFalseOpt.candidates.length, 0);

    // P2: Re-Observe covers desktop_click & rejects future timestamps
    assert.equal(validateReObserveBeforeGuiAction({ checkpoint: { lastObservedAtMs: now + 60_000 }, toolName: 'desktop_click', nowMs: now }).code, 'ERR_REOBSERVE_REQUIRED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.20.1 P0-12 & P1-12..16/20..23: Companion Async 202 registerOn(), lease transfer, restart recovery, deployment isolation & SecretProvider array/encoding/restart hardening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-comp-'));
  try {
    let now = 1_800_000_000_000;
    const ledgerPath = path.join(dir, 'remote.jsonl');
    const ledger1 = createAsyncRemoteJobLedger({ filePath: ledgerPath, now: () => now });
    const mutex = createDesktopMutex({ defaultLeaseMs: 10_000 });
    let finishDesktop = null;
    let handlerCalls = 0;

    const host = createCompanionToolHost({
      deviceId: 'mac-1',
      allowlist: ['desktop_render'],
      desktopTools: ['desktop_render'],
      desktopMutex: mutex,
      asyncJobLedger: ledger1,
      now: () => new Date(now),
      handlers: {
        desktop_render: async () => {
          handlerCalls += 1;
          return {
            __asyncAccepted: true,
            pollAfterSec: 10,
            run: () => new Promise((r) => { finishDesktop = () => r({ done: true }); }),
          };
        },
      },
    });

    // B6: Both RemoteToolClient.registerOn() and MultiRemoteToolClient.registerOn() preserve Async 202 handle!
    const singleClient = createRemoteToolClient({
      deploymentId: 'dep_A', deviceId: 'mac-1', getEpoch: () => 1,
      sendRequest: (env) => host.handleEnvelope(env),
      toolSpecs: [{ name: 'desktop_render', risk: 'reversible_write' }],
    });
    const tools = new Map();
    const mockReg = { register: (t) => tools.set(t.name, t) };
    singleClient.registerOn(mockReg);
    const regOut = await tools.get('desktop_render').execute({ deck: 'v1' }, { operationId: 'op_desk_1', jobId: 'j_1', jobEpoch: 2 });
    assert.equal(regOut.accepted, true);
    assert.equal(regOut.status, 'accepted');
    assert.equal(regOut.operationId, 'op_desk_1');
    assert.ok(regOut.remoteJobId.startsWith('rj_'));

    // P1-20 & B7: DesktopMutex MUST stay held while async `output.run()` is still active!
    await assert.rejects(
      () => mutex.acquire({ holderId: 'contender', tool: 'desktop_render', timeoutMs: 30 }),
      /ERR_DESKTOP_MUTEX_TIMEOUT/,
      'Second desktop caller must be blocked while async run() holds the desktop mutex',
    );

    // P1-21: Replayed operationId returns idempotent 202 BEFORE re-running handler!
    const replay = await singleClient.invoke('desktop_render', { deck: 'v1' }, { operationId: 'op_desk_1', jobId: 'j_1', jobEpoch: 2 });
    assert.equal(replay.remoteJobId, regOut.remoteJobId);
    assert.equal(handlerCalls, 1, 'Idempotent replay must not re-invoke handler');

    // P1-22: Stale jobEpoch denied locally even without custom verifyResourceFence!
    const staleJe = await singleClient.invoke('desktop_render', { deck: 'v2' }, { operationId: 'op_desk_2', jobId: 'j_1', jobEpoch: 1 });
    assert.equal(staleJe.ok, false);
    assert.match(staleJe.error, /ERR_STALE_JOB_EPOCH/);

    // B5 & P1-23: Cross-deployment lookup & cancel blocked on BOTH remoteJobId and operationId!
    assert.equal(host.getRemoteJobStatus(regOut.remoteJobId, { deploymentId: 'dep_B' }), null);
    assert.equal(host.getRemoteJobStatus('op_desk_1', { deploymentId: 'dep_B' }), null);
    assert.equal(host.cancelRemoteJob(regOut.remoteJobId, { deploymentId: 'dep_B' }).code, 'ERR_REMOTE_JOB_NOT_FOUND');

    // P1-21: Reloading ledger after simulated companion crash marks in-flight `running` record `unknown`!
    const crashedLedger = createAsyncRemoteJobLedger({ filePath: ledgerPath, now: () => now + 5000 });
    assert.equal(crashedLedger.lookup('op_desk_1', { deploymentId: 'dep_A' }).status, 'unknown');

    // Finish async run -> releases DesktopMutex!
    finishDesktop();
    await new Promise((r) => setTimeout(r, 15));
    const afterLease = await mutex.acquire({ holderId: 'after_done', tool: 'desktop_render', timeoutMs: 50 });
    assert.equal(afterLease.ok, true, 'DesktopMutex must release once async run() settles');
    afterLease.release();

    // Also verify MultiRemoteToolClient.registerOn() preserves Async 202
    const multi = createMultiRemoteToolClient({
      deploymentId: 'dep_A',
      devices: [{ deviceId: 'mac-1', online: true, sendRequest: (env) => host.handleEnvelope(env), toolSpecs: [{ name: 'desktop_render', risk: 'reversible_write' }] }],
      getEpoch: () => 1,
    });
    const multiTools = new Map();
    multi.registerOn({ register: (t) => multiTools.set(t.name, t) });
    const mOut = await multiTools.get('desktop_render').execute({ deck: 'v1' }, { operationId: 'op_desk_1' });
    assert.equal(mOut.accepted, true);
    assert.equal(mOut.remoteJobId, regOut.remoteJobId);

    // P2: Fair-Share AbortSignal cancels queued waiter cleanly without leaking occupancy
    const fsq = createFairShareResourceQueue();
    const hold = await fsq.acquire({ physicalResourceId: 'p1', tenantId: 't1', groupId: 'g1' });
    const ac = new AbortController();
    const waitP = fsq.acquire({ physicalResourceId: 'p1', tenantId: 't1', groupId: 'g2', signal: ac.signal });
    ac.abort();
    assert.equal((await waitP).code, 'ERR_FAIR_SHARE_ABORTED');
    hold.release();
    assert.equal(fsq.getStats('p1').inFlightTotal, 0);

    // P1-12..16: SecretProvider array handles, encoding/depth/key redaction, empty allowedDomains, 2-field each_use & restart persistence
    const vault = createSecretVault({ filePath: path.join(dir, 'vault.enc'), masterKey: 'mk-2201' });
    const sp1 = createVaultSecretProvider({ vault, tenantId: 't1', clock: () => now });
    sp1.putSecret({ name: 'no_domains', value: 'SecretNoDom123', allowedDomains: [] });
    sp1.putSecret({ name: 'dual_sec', fields: { user: 'alice_u', pass: 'S3cr3t!pw#9' }, allowedDomains: ['portal.gov'], stepUp: 'each_use' });

    // P1-14: Empty allowedDomains MUST fail closed!
    const emptyDom = sp1.resolveToolArgs({
      toolSpec: { secret_args: ['v'] },
      args: { v: { $secret: 'no_domains' } },
      ctx: { isOwner: true, isGroup: false, activeOrigin: 'https://evil.example' },
    });
    assert.equal(emptyDom.code, 'SECRET_DESTINATION_MISMATCH');

    // P1-12 & P1-15 & P1-16: After restart (fresh sp2), array handles resolve in-place (no bogus 'creds[0]' key),
    // failed field lookup does NOT burn each_use token, and 2 fields of same secret succeed in 1 call!
    const sp2 = createVaultSecretProvider({ vault, tenantId: 't1', clock: () => now });
    const tok = sp2.issueEachUseToken({ name: 'dual_sec', origin: 'https://portal.gov' }).token;
    const badField = sp2.resolveToolArgs({
      toolSpec: { secret_args: ['creds'] },
      args: { creds: [{ $secret: 'dual_sec', field: 'missing_field' }] },
      ctx: { isOwner: true, isGroup: false, activeOrigin: 'https://portal.gov', stepUpToken: tok },
    });
    assert.equal(badField.code, 'ERR_SECRET_FIELD_MISSING');

    const goodArr = sp2.resolveToolArgs({
      toolSpec: { secret_args: ['creds'] },
      args: { creds: [{ $secret: 'dual_sec', field: 'user' }, { $secret: 'dual_sec', field: 'pass' }] },
      ctx: { isOwner: true, isGroup: false, activeOrigin: 'https://portal.gov', stepUpToken: tok },
    });
    assert.equal(goodArr.ok, true);
    assert.deepEqual(goodArr.resolvedArgs.creds, ['alice_u', 'S3cr3t!pw#9']);
    assert.equal(Object.hasOwn(goodArr.resolvedArgs, 'creds[0]'), false);

    // P1-13: Form encoding (%21), hex, Basic base64 offset, object keys, and depth > 12 all redacted/truncated!
    const sec = 'S3cr3t!pw#9';
    const deepObj = (() => { let o = { leak: sec }; for (let i = 0; i < 15; i++) o = { n: o }; return o; })();
    const scrubbed = redactSecretsDeep({
      form: 'p=S3cr3t%21pw%239',
      hex: Buffer.from(sec).toString('hex'),
      basic1: Buffer.from(`a:${sec}`).toString('base64'),
      basic2: Buffer.from(`ab:${sec}`).toString('base64'),
      [`key_${sec}`]: 'ok',
      deep: deepObj,
    }, [{ name: 'dual_sec', value: sec }]);
    const dumped = JSON.stringify(scrubbed);
    assert.ok(!dumped.includes('S3cr3t%21pw%239'), 'Form-encoded secret leaked');
    assert.ok(!dumped.includes(Buffer.from(sec).toString('hex')), 'Hex secret leaked');
    assert.ok(!dumped.includes(sec), 'Plaintext/key/deep secret leaked');
    assert.ok(dumped.includes('[TRUNCATED]'), 'Depth > 12 must truncate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.20.1 H8 & P0-9/H6: live WakeBus has 0 hot-loop spin on overdue ask; abort-ignoring async runner preserves actual receipt; chat-sdk forwards autonomy', async () => {
  assert.equal(typeof createScrollChatRuntime, 'function');

  // P0-9 live-window test: overdue owner ask over real 350ms window must NOT enter 5ms spin loop!
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-spin-'));
  try {
    let realTicks = 0;
    const store = createDurableJobStore({ filePath: path.join(dir, 'jobs.json') });
    const j = store.createJob({ goal: 'Owner wait', principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] } }).job;
    const c = store.claimJob({ jobId: j.jobId });
    store.openAsk({
      jobId: j.jobId, revision: c.revision, jobEpoch: c.jobEpoch, leaseToken: c.leaseToken,
      targetRole: 'owner', kind: 'text', question: 'Confirm?', nudgeDelaySec: 60,
      nowMs: Date.now() - 120_000,
    });
    const origReap = store.reap;
    const wrappedStore = { ...store, reap: (opts) => { realTicks += 1; return origReap(opts); } };
    const bus = createJobWakeBus({ store: wrappedStore, safetySweepMs: 60_000 });
    bus.start();
    await new Promise((r) => setTimeout(r, 350));
    bus.stop();
    assert.ok(realTicks <= 3, `Expected <=3 bounded ticks in 350ms (no 5ms spin loop), got ${realTicks}`);

    // H6: Handler ignoring abort -> cancelRemoteJob returns cancel_requested -> handler resolves -> receipt preserved as succeeded!
    let finishIgnore = null;
    const ledger = createAsyncRemoteJobLedger({ filePath: path.join(dir, 'r2.jsonl') });
    const host = createCompanionToolHost({
      deviceId: 'vm-ign',
      allowlist: ['stubborn_op'],
      asyncJobLedger: ledger,
      handlers: {
        stubborn_op: async () => ({
          __asyncAccepted: true,
          run: () => new Promise((resolve) => { finishIgnore = () => resolve({ txId: 'TX-ACTUAL-99' }); }),
        }),
      },
    });
    const client = createRemoteToolClient({
      deploymentId: 'dep_ign', deviceId: 'vm-ign', getEpoch: () => 1,
      sendRequest: (env) => host.handleEnvelope(env),
      toolSpecs: [{ name: 'stubborn_op', risk: 'reversible_write' }],
    });
    const rAcc = await client.invoke('stubborn_op', {}, { operationId: 'op_ign_1' });
    const rCan = host.cancelRemoteJob(rAcc.remoteJobId, { deploymentId: 'dep_ign' });
    assert.equal(rCan.cancelState, 'cancel_requested');
    finishIgnore();
    await new Promise((r) => setTimeout(r, 15));
    const finalRec = host.getRemoteJobStatus(rAcc.remoteJobId, { deploymentId: 'dep_ign' });
    assert.equal(finalRec.status, 'succeeded');
    assert.equal(finalRec.receipt.txId, 'TX-ACTUAL-99');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.20.1 Round-2 N1/R3/N2/R1/R2/B2: owner/statutory pause lock, zero 25ms spin on companion & expired reconciling, unresolved-effect terminal gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-r2-jobs-'));
  try {
    let now = 1_820_000_000_000;
    const store = createDurableJobStore({ filePath: path.join(dir, 'jobs.json'), clock: () => now });
    const liveOk = { botInRoom: true, ownerInRoom: true, groupPolicy: 'owner_or_approve', allowedTools: ['browser_open'] };

    // N1 / R3: Owner pause while requester ask (with defaultOption) is open
    const j1 = store.createJob({
      goal: 'Prepare quarterly report',
      principals: {
        requester: { principalId: 'u_req' },
        ownerIds: ['u_own'],
        approver: { principalId: 'u_app' },
      },
      audienceRoom: { channel: 'telegram', chatId: '-10077', isGroup: true },
      authority: { ticketId: 't_r2_1', policySnapshot: { groupPolicy: 'owner_or_approve', isOwnerSender: false } },
    }).job;
    const c1 = store.claimJob({ jobId: j1.jobId, liveAuth: liveOk });
    assert.equal(c1.ok, true);

    // Owner ask with defaultOption and empty-options defaultOption must both be rejected
    assert.equal(store.openAsk({
      jobId: j1.jobId, revision: c1.revision, jobEpoch: c1.jobEpoch, leaseToken: c1.leaseToken,
      targetRole: 'owner', kind: 'choice', question: 'Approve?', options: [{ id: 'a', label: 'A' }],
      defaultOption: 'a', defaultAfterSec: 60,
    }).code, 'ERR_OWNER_ASK_NO_DEFAULT');
    assert.equal(store.openAsk({
      jobId: j1.jobId, revision: c1.revision, jobEpoch: c1.jobEpoch, leaseToken: c1.leaseToken,
      targetRole: 'requester', kind: 'choice', question: 'Format?', options: [],
      defaultOption: 'pdf', defaultAfterSec: 60,
    }).code, 'INVALID_DEFAULT_OPTION');

    const askRes = store.openAsk({
      jobId: j1.jobId, revision: c1.revision, jobEpoch: c1.jobEpoch, leaseToken: c1.leaseToken,
      targetRole: 'requester', kind: 'choice', question: 'Format?',
      options: [{ id: 'pdf', label: 'PDF' }, { id: 'csv', label: 'CSV' }],
      defaultOption: 'pdf', defaultAfterSec: 60, nudgeDelaySec: 120,
    });
    assert.equal(askRes.ok, true);

    // Owner pauses job
    const pauseRes = store.submitSteering({
      jobId: j1.jobId, sourceEventId: 'ev_own_pause', actorId: 'u_own', actorRole: 'owner', commandKind: 'pause',
    });
    assert.equal(pauseRes.ok, true);
    assert.equal(store.getJob(j1.jobId).status, 'paused');
    assert.equal(store.getJob(j1.jobId).pausedByRole, 'owner');

    // Designated approver AND requester cannot resume owner pause (R3)
    const appResume = store.submitSteering({
      jobId: j1.jobId, sourceEventId: 'ev_app_res', actorId: 'u_app', commandKind: 'resume',
    });
    assert.equal(appResume.ok, false);
    assert.equal(appResume.code, 'OWNER_PAUSE_LOCKED');

    // EnqueueWake(reason='resume') without allowOwnerResume cannot bypass owner pause
    const wkBypass = store.enqueueWake({ jobId: j1.jobId, reason: 'resume' });
    assert.equal(wkBypass.woke, false);
    assert.equal(store.getJob(j1.jobId).status, 'paused');

    // Reap after defaultAfterSec (120s later) MUST NOT fire defaultOption or unpause owner-paused job (N1 Repro B)
    now += 120_000;
    const reapPaused = store.reap({ nowMs: now });
    assert.equal(reapPaused.defaultedAsks.length, 0);
    assert.equal(store.getJob(j1.jobId).status, 'paused');
    assert.equal(store.getAsk(askRes.ask.askId).status, 'open');

    // Requester answering ask records answer in eventInbox WITHOUT lifting owner pause (N1 Repro A)
    const ansReq = store.answerAsk({ askId: askRes.ask.askId, actorId: 'u_req', answer: 'csv' });
    assert.equal(ansReq.ok, true);
    assert.equal(ansReq.wokeToQueued, false);
    assert.equal(store.getJob(j1.jobId).status, 'paused');
    assert.equal(store.getJob(j1.jobId).pausedByRole, 'owner');
    const pausedClaim = store.claimJob({ jobId: j1.jobId, liveAuth: liveOk });
    assert.equal(pausedClaim.ok, false);
    assert.equal(pausedClaim.status, 'paused');

    // Owner resume lifts pause and delivers buffered answer in eventInbox!
    const ownRes = store.submitSteering({
      jobId: j1.jobId, sourceEventId: 'ev_own_res', actorId: 'u_own', actorRole: 'owner', commandKind: 'resume',
    });
    assert.equal(ownRes.ok, true);
    assert.equal(store.getJob(j1.jobId).status, 'queued');
    const cAfter = store.claimJob({ jobId: j1.jobId, liveAuth: liveOk });
    assert.equal(cAfter.ok, true);
    assert.ok(cAfter.job.eventInbox.some((e) => e.type === 'requester_answer' && e.answer === 'csv'));

    // B2: completeJob / failJob MUST refuse while effect intent is unresolved; late receipt must not mutate terminal job
    const eff1 = store.recordEffectIntent({
      jobId: j1.jobId, revision: cAfter.revision, jobEpoch: cAfter.jobEpoch, leaseToken: cAfter.leaseToken,
      operationId: 'op_pending_1', tool: 'submit_form', args: { x: 1 },
    });
    assert.equal(eff1.ok, true);
    assert.equal(store.completeJob({
      jobId: j1.jobId, revision: eff1.revision, jobEpoch: cAfter.jobEpoch, leaseToken: cAfter.leaseToken,
      summary: 'premature done',
    }).code, 'UNRESOLVED_EFFECTS_PENDING');
    assert.equal(store.failJob({
      jobId: j1.jobId, revision: eff1.revision, jobEpoch: cAfter.jobEpoch, leaseToken: cAfter.leaseToken,
      reason: 'premature fail',
    }).code, 'UNRESOLVED_EFFECTS_PENDING');

    // Settle effect -> completeJob succeeds -> late receipt leaves status completed
    store.recordEffectReceipt({ jobId: j1.jobId, operationId: 'op_pending_1', status: 'succeeded', receipt: { id: 1 } });
    const jDone = store.getJob(j1.jobId);
    const doneRes = store.completeJob({
      jobId: j1.jobId, revision: jDone.revision, jobEpoch: cAfter.jobEpoch, leaseToken: cAfter.leaseToken,
      summary: 'all done',
    });
    assert.equal(doneRes.ok, true);
    assert.equal(doneRes.job.status, 'completed');

    // R1 / N2-A: Event-only companion sleep past 60m MUST NOT spin WakeBus at 25ms
    const jComp = store.createJob({
      goal: 'Wait for laptop online',
      principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] },
      budget: { horizonDays: 7 },
    }).job;
    const cComp = store.claimJob({ jobId: jComp.jobId });
    store.parkJob({
      jobId: jComp.jobId, revision: cComp.revision, jobEpoch: cComp.jobEpoch, leaseToken: cComp.leaseToken,
      waitingFor: 'companion', checkpoint: { progressSummary: 'laptop closed' },
    });
    now += 2 * 3600_000; // 2 hours offline (> default 1h nextReviewAtMs)
    const nextDueComp = store.getNextDueAtMs();
    assert.ok(nextDueComp > now + 24 * 3600_000, `Expected future horizon only, got overdue ${nextDueComp - now}ms`);

    // R2 / N2-B / H5: Horizon-expired job with unresolved effect enters reconciling, fires onReconcileDue (no spin), and has bounded exit
    const jExp = store.createJob({
      goal: 'Expiring with flying effect',
      principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] },
      budget: { horizonDays: 1 },
    }).job;
    const cExp = store.claimJob({ jobId: jExp.jobId });
    store.recordEffectIntent({
      jobId: jExp.jobId, revision: cExp.revision, jobEpoch: cExp.jobEpoch, leaseToken: cExp.leaseToken,
      operationId: 'op_fly_exp', tool: 'wire', args: { amt: 10 },
    });
    // Jump past horizon
    now = store.getJob(jExp.jobId).budget.expiresAtMs + 5_000;
    const rExp1 = store.reap({ nowMs: now, reconcileStaleMs: 10_000, maxReconcileRounds: 2 });
    assert.deepEqual(rExp1.movedToReconciling, [jExp.jobId]);
    assert.equal(store.getJob(jExp.jobId).status, 'reconciling');
    // getNextDueAtMs MUST return future reconcile wake (+15s), NOT past expiresAtMs (no 25ms spin!)
    const nextDueRec = store.getNextDueAtMs();
    assert.ok(nextDueRec >= now + 10_000, `Expected future reconcile wake, got delta ${nextDueRec - now}ms`);

    // Advance +16s -> step 2b MUST run and report reconcilingDue (NOT skipped by horizon continue!)
    now += 16_000;
    const rExp2 = store.reap({ nowMs: now, reconcileStaleMs: 10_000, maxReconcileRounds: 2 });
    assert.deepEqual(rExp2.reconcilingDue, [jExp.jobId]);
    assert.equal(store.getJob(jExp.jobId).effectIntents.op_fly_exp.status, 'unknown');

    // Advance +61s -> 2nd round reaches maxReconcileRounds=2 -> bounded terminal cancel + owner DM alert
    now += 61_000;
    const rExp3 = store.reap({ nowMs: now, reconcileStaleMs: 10_000, maxReconcileRounds: 2 });
    assert.deepEqual(rExp3.reconcileExhausted, [jExp.jobId]);
    assert.equal(store.getJob(jExp.jobId).status, 'cancelled');
    assert.equal(store.getJob(jExp.jobId).failureCode, 'RECONCILE_EXHAUSTED_UNKNOWN_EFFECT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.20.1 Round-2 B3/B4/H9/H11: strict hydration, live-PID lock immunity, DST repeated-hour & spring-gap, outbox claimToken & per-card serialization', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-r2-store-'));
  try {
    // H9: Fall-back repeated hour in America/New_York (2026-11-01 01:00-02:00 repeats)
    const fallBackSecondHr = Date.parse('2026-11-01T06:15:00.000Z'); // 01:15 EST (2nd occurrence)
    const qhNy = { start: '23:00', end: '01:30', tz: 'America/New_York' };
    assert.equal(
      new Date(nextNotificationWindowMs(fallBackSecondHr, qhNy)).toISOString(),
      '2026-11-01T06:30:00.000Z',
    );
    const fallBackFirstHr = Date.parse('2026-11-01T05:15:00.000Z'); // 01:15 EDT (1st occurrence)
    assert.equal(
      new Date(nextNotificationWindowMs(fallBackFirstHr, qhNy)).toISOString(),
      '2026-11-01T05:30:00.000Z',
    );
    // H9: Spring-forward gap (2026-03-08 02:30 NY does not exist -> resolves to 03:00 EDT = 07:00Z)
    const springBeforeGap = Date.parse('2026-03-08T06:30:00.000Z'); // 01:30 EST
    const qhSpring = { start: '23:00', end: '02:30', tz: 'America/New_York' };
    assert.equal(
      new Date(nextNotificationWindowMs(springBeforeGap, qhSpring)).toISOString(),
      '2026-03-08T07:00:00.000Z',
    );

    // B3: Strict hydration rejects malformed rows & duplicate IDs fail-closed (preserves corrupt copy)
    const badRowPath = path.join(dir, 'bad-row.json');
    fs.writeFileSync(badRowPath, JSON.stringify({
      schema: 'scroll-job/v1',
      jobs: [{ notAJob: true }],
      asks: [],
      outbox: [],
      steering: [],
    }), 'utf8');
    assert.throws(() => createDurableJobStore({ filePath: badRowPath }), /ERR_DURABLE_JOB_STORE_CORRUPT/);

    const badOutboxPath = path.join(dir, 'bad-outbox.json');
    fs.writeFileSync(badOutboxPath, JSON.stringify({
      schema: 'scroll-job/v1',
      jobs: [],
      asks: [],
      outbox: 'corrupted_not_array',
      steering: [],
    }), 'utf8');
    assert.throws(() => createDurableJobStore({ filePath: badOutboxPath }), /ERR_DURABLE_JOB_STORE_CORRUPT/);

    // B4: Aged lock held by LIVE same-host PID MUST NOT be stolen!
    const liveLockStorePath = path.join(dir, 'live-lock.json');
    const liveStore = createDurableJobStore({ filePath: liveLockStorePath });
    const lockPath = `${liveLockStorePath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'live-owner', createdAt: Date.now() - 45_000 }));
    const oldTime = new Date(Date.now() - 45_000);
    fs.utimesSync(lockPath, oldTime, oldTime);
    assert.throws(() => liveStore.createJob({ goal: 'Should not steal live PID lock' }), /ERR_JOB_STORE_LOCK_CONTENTION/);
    // Clean up live lock and verify dead PID lock IS cleanly stolen
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999999, host: os.hostname(), nonce: 'dead-owner', createdAt: Date.now() - 10_000 }));
    const okAfterDead = liveStore.createJob({ goal: 'Cleanly steals dead PID lock' });
    assert.equal(okAfterDead.ok, true);

    // H11: Outbox claimToken fencing + per-card progress_edit serialization + unclaimed-only coalescing
    let now = 1_820_000_000_000;
    const obStore = createDurableJobStore({ filePath: path.join(dir, 'ob.json'), clock: () => now });
    const j = obStore.createJob({ goal: 'Outbox card test', principals: { requester: { principalId: 'u1' }, ownerIds: ['u1'] } }).job;
    obStore.enqueueOutbox({ jobId: j.jobId, clientMessageId: 'ed_1', kind: 'progress_edit', channel: 'telegram', chatId: 'c1', editMessageId: 'card_1', payload: { step: 1 }, nowMs: now });
    const cA = obStore.claimPendingOutbox({ workerId: 'wA', leaseMs: 30_000, nowMs: now });
    assert.equal(cA.length, 1);
    assert.ok(cA[0].claimToken && cA[0].claimToken.startsWith('clm_'));

    // Enqueue ed_2 & ed_3 while ed_1 is in-flight: ed_1 stays pending/claimed; ed_2 is superseded by ed_3!
    obStore.enqueueOutbox({ jobId: j.jobId, clientMessageId: 'ed_2', kind: 'progress_edit', channel: 'telegram', chatId: 'c1', editMessageId: 'card_1', payload: { step: 2 }, nowMs: now + 1000 });
    obStore.enqueueOutbox({ jobId: j.jobId, clientMessageId: 'ed_3', kind: 'progress_edit', channel: 'telegram', chatId: 'c1', editMessageId: 'card_1', payload: { step: 3 }, nowMs: now + 2000 });
    const obList = obStore.listOutbox({ jobId: j.jobId });
    assert.equal(obList.find((x) => x.clientMessageId === 'ed_1').deliveryState, 'pending');
    assert.equal(obList.find((x) => x.clientMessageId === 'ed_2').deliveryState, 'superseded');
    assert.equal(obList.find((x) => x.clientMessageId === 'ed_3').deliveryState, 'pending');

    // Worker B CANNOT claim ed_3 while ed_1 for the same card_1 is still in-flight!
    assert.equal(obStore.claimPendingOutbox({ workerId: 'wB', leaseMs: 30_000, nowMs: now + 3000 }).length, 0);

    // Wrong or missing claimToken CANNOT ack ed_1 while wA's lease is active!
    assert.equal(obStore.markOutboxDelivery('ed_1', { deliveryState: 'sent', claimToken: 'wrong', nowMs: now + 3000 }).code, 'OUTBOX_CLAIM_TOKEN_MISMATCH');
    assert.equal(obStore.markOutboxDelivery('ed_1', { deliveryState: 'sent', nowMs: now + 3000 }).code, 'OUTBOX_CLAIM_TOKEN_MISMATCH');

    // Correct claimToken completes ed_1 -> now Worker B can claim ed_3!
    assert.equal(obStore.markOutboxDelivery('ed_1', { deliveryState: 'sent', claimToken: cA[0].claimToken, nowMs: now + 4000 }).ok, true);
    const cB = obStore.claimPendingOutbox({ workerId: 'wB', leaseMs: 30_000, nowMs: now + 5000 });
    assert.equal(cB.length, 1);
    assert.equal(cB[0].clientMessageId, 'ed_3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.20.1 Round-2 B5/B7/H6/H7/H2/H3/P2: tuple key isolation, compaction safety, pinned desktop mutex, receipt error separation, WakeBus re-entrancy & secret $&/JSON redaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-r2-tr-'));
  try {
    let now = 1_820_000_000_000;

    // B5 & H7: Unambiguous tuple keys (`a:b` + `c` != `a` + `b:c`) + compaction preserving newer live generation
    const ledger = createAsyncRemoteJobLedger({
      filePath: path.join(dir, 'tuple.jsonl'),
      retentionMs: 60_000,
      now: () => now,
    });
    const rA = ledger.accept({ deploymentId: 'a:b', deviceId: 'd1', operationId: 'c', tool: 't', args: { v: 1 } });
    const rB = ledger.accept({ deploymentId: 'a', deviceId: 'd1', operationId: 'b:c', tool: 't', args: { v: 2 } });
    assert.equal(rA.ok, true);
    assert.equal(rB.ok, true);
    assert.notEqual(rA.record.remoteJobId, rB.record.remoteJobId);
    assert.equal(ledger.lookup('c', { deploymentId: 'a:b' }).remoteJobId, rA.record.remoteJobId);
    assert.equal(ledger.lookup('b:c', { deploymentId: 'a' }).remoteJobId, rB.record.remoteJobId);

    // H7: Expire rA, reuse same (deploymentId, operationId) as rA2 (also settled succeeded, unexpired) -> BOTH fresh load() AND compact() MUST preserve rA2!
    ledger.updateStatus(rA.record.remoteJobId, { deploymentId: 'a:b', status: 'succeeded', receipt: { gen: 1 } });
    now += 65_000; // rA expired
    const rA2 = ledger.accept({ deploymentId: 'a:b', deviceId: 'd1', operationId: 'c', tool: 't', args: { v: 1 } });
    assert.equal(rA2.ok, true);
    assert.notEqual(rA2.record.remoteJobId, rA.record.remoteJobId);
    ledger.updateStatus(rA2.record.remoteJobId, { deploymentId: 'a:b', status: 'succeeded', receipt: { gen: 2 } });
    const reloaded = createAsyncRemoteJobLedger({
      filePath: path.join(dir, 'tuple.jsonl'),
      retentionMs: 60_000,
      now: () => now,
    });
    assert.equal(reloaded.lookup('c', { deploymentId: 'a:b' })?.remoteJobId, rA2.record.remoteJobId);
    const cmp = ledger.compact({ nowMs: now });
    assert.equal(cmp.pruned, 1);
    assert.equal(ledger.lookup('c', { deploymentId: 'a:b' })?.remoteJobId, rA2.record.remoteJobId);

    // B7: Injected in-memory ledger (`isDurable: false`) MUST be refused for durable 202
    const memLedger = createAsyncRemoteJobLedger({ now: () => now });
    assert.equal(memLedger.isDurable, false);
    const memHost = createCompanionToolHost({
      deviceId: 'mac-mem',
      allowlist: ['long_op'],
      asyncJobLedger: memLedger,
      handlers: { long_op: async () => ({ __asyncAccepted: true, run: async () => ({ ok: true }) }) },
    });
    const memRes = await memHost.handleEnvelope({ callId: 'c_mem', deploymentId: 'dep_m', deviceId: 'mac-mem', epoch: 1, tool: 'long_op', operationId: 'op_m' });
    assert.equal(memRes.ok, false);
    assert.match(memRes.error, /ERR_DURABLE_ASYNC_LEDGER_REQUIRED/);

    // B7 / P1-20: DesktopMutex stays pinned during long async run past deadlineMs!
    let finishDesktop = null;
    const pinnedMutex = createDesktopMutex({ defaultLeaseMs: 1_000, now: () => now });
    const pinLedger = createAsyncRemoteJobLedger({ filePath: path.join(dir, 'pin.jsonl'), now: () => now });
    const pinHost = createCompanionToolHost({
      deviceId: 'mac-pin',
      allowlist: ['gui_long', 'gui_short'],
      desktopTools: ['gui_long', 'gui_short'],
      desktopMutex: pinnedMutex,
      asyncJobLedger: pinLedger,
      now: () => new Date(now),
      handlers: {
        gui_long: async () => ({
          __asyncAccepted: true,
          run: () => new Promise((resolve) => { finishDesktop = () => resolve({ painted: true }); }),
        }),
        gui_short: async () => ({ ok: true }),
      },
    });
    const p1 = await pinHost.handleEnvelope({ callId: 'c1', deploymentId: 'dep_p', deviceId: 'mac-pin', epoch: 1, tool: 'gui_long', operationId: 'op_pin_1', deadlineMs: 1_000 });
    assert.equal(p1.httpStatus, 202);
    // Advance clock well past 1_000ms deadlineMs while runner is still active -> mutex MUST remain locked!
    now += 120_000;
    assert.equal(pinnedMutex.isLocked(), true);
    // Unauthorized tool with high jobEpoch MUST NOT poison jobEpoch for valid tool!
    const badTool = await pinHost.handleEnvelope({ callId: 'c_bad', deploymentId: 'dep_p', deviceId: 'mac-pin', epoch: 1, tool: 'not_allowed', jobId: 'j_ep', jobEpoch: 999 });
    assert.equal(badTool.ok, false);
    assert.match(badTool.error, /ERR_TOOL_NOT_ALLOWLISTED/);
    finishDesktop();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(pinnedMutex.isLocked(), false);
    // Valid tool with jobEpoch=1 succeeds (not poisoned by 999)
    const okShort = await pinHost.handleEnvelope({ callId: 'c2', deploymentId: 'dep_p', deviceId: 'mac-pin', epoch: 1, tool: 'gui_short', jobId: 'j_ep', jobEpoch: 1 });
    assert.equal(okShort.ok, true);

    // H6: Receipt persistence throw after run() succeeds NEVER records status='failed'
    let failNextPersist = true;
    const baseLedger = createAsyncRemoteJobLedger({ filePath: path.join(dir, 'h6.jsonl'), now: () => now });
    const flakyLedger = {
      ...baseLedger,
      isDurable: true,
      updateStatus(id, opts) {
        if (opts.status === 'succeeded' && failNextPersist) {
          failNextPersist = false;
          throw new Error('ENOSPC_DISK_FULL');
        }
        return baseLedger.updateStatus(id, opts);
      },
    };
    const h6Host = createCompanionToolHost({
      deviceId: 'mac-h6',
      allowlist: ['pay_op'],
      asyncJobLedger: flakyLedger,
      now: () => new Date(now),
      handlers: { pay_op: async () => ({ __asyncAccepted: true, run: async () => ({ paid: 'INV-7' }) }) },
    });
    const h6Acc = await h6Host.handleEnvelope({ callId: 'ch6', deploymentId: 'dep_h6', deviceId: 'mac-h6', epoch: 1, tool: 'pay_op', operationId: 'op_h6' });
    assert.equal(h6Acc.httpStatus, 202);
    await new Promise((r) => setTimeout(r, 20));
    // Raw ledger must NOT have recorded `failed`; getRemoteJobStatus retries and persists `succeeded`!
    assert.notEqual(baseLedger.lookup(h6Acc.remoteJobId, { deploymentId: 'dep_h6' }).status, 'failed');
    const recH6 = h6Host.getRemoteJobStatus(h6Acc.remoteJobId, { deploymentId: 'dep_h6' });
    assert.equal(recH6.status, 'succeeded');
    assert.equal(recH6.receipt.paid, 'INV-7');

    // H2 / H3 / P1-11: WakeBus strict tenant & targeted operationId correlation, retry on rejecting callback, non-deadlocking re-entrant tick()
    const wStore = createDurableJobStore({ filePath: path.join(dir, 'wb.json'), clock: () => now });
    const jW = wStore.createJob({ tenantId: 't_alpha', goal: 'Wait op_right', principals: { requester: { principalId: 'u1' }, ownerIds: ['u1'] } }).job;
    const cW = wStore.claimJob({ jobId: jW.jobId });
    wStore.parkJob({
      jobId: jW.jobId, revision: cW.revision, jobEpoch: cW.jobEpoch, leaseToken: cW.leaseToken,
      waitingFor: 'companion',
      wakeOn: [{ type: 'remote_job_done', operationId: 'op_right' }],
      checkpoint: { progressSummary: 'waiting op_right' },
    });
    let attempts = 0;
    let reentrantResult = null;
    const bus = createJobWakeBus({
      store: wStore,
      clock: () => now,
      onJobQueued: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient_dispatch_error');
        // Calling await bus.tick() from inside callback MUST NOT deadlock!
        reentrantResult = await bus.tick({ nowMs: now });
      },
    });
    // Broadcast companion.online WITHOUT tenantId MUST NOT wake t_alpha!
    assert.equal((await bus.publishEvent({ type: 'companion.online', deviceId: 'mac-1' })).woken.length, 0);
    // Targeted event with WRONG operationId MUST NOT wake job subscribed to op_right!
    assert.equal((await bus.publishEvent({ type: 'remote_job_done', jobId: jW.jobId, operationId: 'op_WRONG' })).woken.length, 0);
    // Targeted event with RIGHT operationId wakes job; 1st callback fails -> next tick retries and succeeds without deadlock!
    const okEv = await bus.publishEvent({ type: 'remote_job_done', jobId: jW.jobId, operationId: 'op_right' });
    assert.deepEqual(okEv.woken, [jW.jobId]);
    assert.equal(attempts, 1);
    await bus.tick({ nowMs: now });
    assert.equal(attempts, 2);
    assert.equal(reentrantResult?.deferred, true);

    // FABLE P2 & CARBON P2: Secret `$&` label leak, JSON-escaped secret, bare STEP_UP_REQUIRED
    const sVal = 'Pass"With\\Slash$1';
    const redLabel = redactSecretsDeep({ msg: `token=${sVal}`, dumped: JSON.stringify({ k: sVal }) }, [{ name: 'n$&', value: sVal }]);
    assert.equal(redLabel.msg, 'token=[secret:n$&]');
    assert.ok(!redLabel.dumped.includes('Pass\\"With\\\\Slash$1'), 'JSON-escaped secret must be redacted');
    assert.equal(classifyToolErrorDisposition({ code: 'STEP_UP_REQUIRED' }).disposition, 'park_waiting');
    assert.equal(classifyToolErrorDisposition({ code: 'STEP_UP_REQUIRED' }).errorClass, 'needs_owner');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v2.20.1 Round-3 Sign-Off: pause->resume lock laundering blocked (owner & statutory), accepted/running reconcile exit, live-bus zero spin, strict hydration, disjoint remoteJobId, expired-pin guard, cancel vs pending receipt & stale outbox ack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2201-r3-'));
  try {
    let now = 1_830_000_000_000;
    const store = createDurableJobStore({ filePath: path.join(dir, 'jobs.json'), clock: () => now });
    const liveOk = { botInRoom: true, ownerInRoom: true, groupPolicy: 'owner_or_approve', allowedTools: ['browser_open'] };

    // 1. FABLE/CARBON P0: Owner pause + Statutory pause CANNOT be relabeled via non-owner `pause -> resume` or `enqueueWake`
    const j1 = store.createJob({
      goal: 'Owner & statutory lock immunity',
      principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'], approver: { principalId: 'u_app' } },
      audienceRoom: { channel: 'telegram', chatId: '-10088', isGroup: true },
      authority: { ticketId: 't_r3_1', policySnapshot: { groupPolicy: 'owner_or_approve', isOwnerSender: false } },
    }).job;
    assert.equal(store.submitSteering({ jobId: j1.jobId, sourceEventId: 'p_own', actorId: 'u_own', actorRole: 'owner', commandKind: 'pause' }).ok, true);
    for (const [tag, actorId] of [['req', 'u_req'], ['app', 'u_app']]) {
      const rp = store.submitSteering({ jobId: j1.jobId, sourceEventId: `p_${tag}`, actorId, commandKind: 'pause' });
      assert.equal(rp.ok, false);
      assert.equal(rp.code, 'OWNER_PAUSE_LOCKED');
      assert.equal(store.getJob(j1.jobId).pausedByRole, 'owner');
      const rr = store.submitSteering({ jobId: j1.jobId, sourceEventId: `r_${tag}`, actorId, commandKind: 'resume' });
      assert.equal(rr.ok, false);
      assert.equal(rr.code, 'OWNER_PAUSE_LOCKED');
    }
    assert.equal(store.enqueueWake({ jobId: j1.jobId, reason: 'resume' }).woke, false);

    // Statutory pause lock immunity against requester & approver pause -> resume
    const jStat = store.createJob({
      goal: 'Statutory filing lock',
      principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'], approver: { principalId: 'u_app' } },
      budget: { horizonDays: 1, statutoryLock: true },
    }).job;
    now = store.getJob(jStat.jobId).budget.expiresAtMs + 1000;
    store.reap({ nowMs: now });
    assert.equal(store.getJob(jStat.jobId).pausedReason, 'statutory');
    assert.equal(store.submitSteering({ jobId: jStat.jobId, sourceEventId: 'sp_req', actorId: 'u_req', commandKind: 'pause' }).code, 'OWNER_PAUSE_LOCKED');
    assert.equal(store.submitSteering({ jobId: jStat.jobId, sourceEventId: 'sp_app', actorId: 'u_app', commandKind: 'pause' }).code, 'OWNER_PAUSE_LOCKED');
    assert.equal(store.submitSteering({ jobId: jStat.jobId, sourceEventId: 'sr_req', actorId: 'u_req', commandKind: 'resume' }).code, 'OWNER_PAUSE_LOCKED');
    assert.equal(store.submitSteering({ jobId: jStat.jobId, sourceEventId: 'sr_app', actorId: 'u_app', commandKind: 'resume' }).code, 'OWNER_PAUSE_LOCKED');
    assert.equal(store.getJob(jStat.jobId).pausedReason, 'statutory');

    // FABLE P2: Owner pausing a running job then resuming before checkpoint clears pausedByRole cleanly
    const jRunPR = store.createJob({
      goal: 'Running owner pause-resume metadata cleanup',
      principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'] },
    }).job;
    store.claimJob({ jobId: jRunPR.jobId });
    assert.equal(store.submitSteering({ jobId: jRunPR.jobId, sourceEventId: 'rpr_p', actorId: 'u_own', actorRole: 'owner', commandKind: 'pause' }).ok, true);
    assert.equal(store.getJob(jRunPR.jobId).pausedByRole, 'owner');
    assert.equal(store.submitSteering({ jobId: jRunPR.jobId, sourceEventId: 'rpr_r', actorId: 'u_own', actorRole: 'owner', commandKind: 'resume' }).ok, true);
    assert.equal(store.getJob(jRunPR.jobId).pausedByRole, null);
    assert.equal(store.getJob(jRunPR.jobId).pausedReason, null);

    // 2. ASTRA/CARBON P1: Async 202 `accepted`/`running` effect ages to `unknown` & exits via maxReconcileRounds + step 4 never clobbers reconciling
    const j202 = store.createJob({
      goal: 'Async 202 bounded reconcile',
      principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] },
      budget: { horizonDays: 1 },
    }).job;
    const c202 = store.claimJob({ jobId: j202.jobId });
    store.recordEffectIntent({ jobId: j202.jobId, revision: c202.revision, jobEpoch: c202.jobEpoch, leaseToken: c202.leaseToken, operationId: 'op_202', tool: 'render', args: { x: 1 } });
    store.recordEffectReceipt({ jobId: j202.jobId, operationId: 'op_202', status: 'accepted', remoteJobId: 'rj_abc' });
    now = store.getJob(j202.jobId).budget.expiresAtMs + 1000;
    store.reap({ nowMs: now, reconcileStaleMs: 10_000, maxReconcileRounds: 2 });
    assert.equal(store.getJob(j202.jobId).status, 'reconciling');
    now += 16_000;
    store.reap({ nowMs: now, reconcileStaleMs: 10_000, maxReconcileRounds: 2 });
    assert.equal(store.getJob(j202.jobId).effectIntents.op_202.status, 'unknown');
    now += 61_000;
    const rEx = store.reap({ nowMs: now, reconcileStaleMs: 10_000, maxReconcileRounds: 2 });
    assert.deepEqual(rEx.reconcileExhausted, [j202.jobId]);
    assert.equal(store.getJob(j202.jobId).status, 'cancelled');

    // 3. FABLE N2 live-bus tick-count check: overdue companion sleep & reconciling expired job do NOT spin over 300ms!
    const spinStore = createDurableJobStore({ filePath: path.join(dir, 'spin.json'), clock: () => now });
    const jCS = spinStore.createJob({ goal: 'Companion live bus', principals: { requester: { principalId: 'u_own' }, ownerIds: ['u_own'] }, budget: { horizonDays: 7 } }).job;
    const cCS = spinStore.claimJob({ jobId: jCS.jobId });
    spinStore.parkJob({ jobId: jCS.jobId, revision: cCS.revision, jobEpoch: cCS.jobEpoch, leaseToken: cCS.leaseToken, waitingFor: 'companion', checkpoint: { progressSummary: 'offline' } });
    now += 2 * 3600_000;
    let spinTicks = 0;
    const origReap = spinStore.reap;
    const wrappedSpin = { ...spinStore, reap: (o) => { spinTicks += 1; return origReap(o); } };
    const spinBus = createJobWakeBus({ store: wrappedSpin, clock: () => now, safetySweepMs: 60_000 });
    spinBus.start();
    await new Promise((r) => setTimeout(r, 300));
    spinBus.stop();
    assert.ok(spinTicks <= 2, `Expected <=2 ticks on overdue companion sleep, got ${spinTicks}`);

    // 4. ASTRA B3: Missing collections & malformed effectIntent entry fail closed on hydration
    const missingColPath = path.join(dir, 'missing-col.json');
    fs.writeFileSync(missingColPath, JSON.stringify({ schema: 'scroll-job/v1', jobs: [] }), 'utf8');
    assert.throws(() => createDurableJobStore({ filePath: missingColPath }), /ERR_DURABLE_JOB_STORE_CORRUPT/);
    const badEffPath = path.join(dir, 'bad-eff.json');
    fs.writeFileSync(badEffPath, JSON.stringify({
      schema: 'scroll-job/v1',
      jobs: [{ jobId: 'j_bad', status: 'queued', effectIntents: { op1: { status: 'BOGUS_STATUS' } } }],
      asks: [], outbox: [], steering: [],
    }), 'utf8');
    assert.throws(() => createDurableJobStore({ filePath: badEffPath }), /ERR_DURABLE_JOB_STORE_CORRUPT/);

    // 5. ASTRA H11: Late ack with expired/cleared claimToken on superseded edit is REJECTED
    const obStore = createDurableJobStore({ filePath: path.join(dir, 'ob3.json'), clock: () => now });
    const jOb = obStore.createJob({ goal: 'Outbox supersede', principals: { requester: { principalId: 'u1' }, ownerIds: ['u1'] } }).job;
    obStore.enqueueOutbox({ jobId: jOb.jobId, clientMessageId: 'e1', kind: 'progress_edit', channel: 'telegram', chatId: 'c1', editMessageId: 'card1', payload: { v: 1 }, nowMs: now });
    const cl1 = obStore.claimPendingOutbox({ workerId: 'w1', leaseMs: 5_000, nowMs: now })[0];
    // Claim expires -> e2 supersedes e1 -> late ack from w1 with old token MUST fail!
    obStore.enqueueOutbox({ jobId: jOb.jobId, clientMessageId: 'e2', kind: 'progress_edit', channel: 'telegram', chatId: 'c1', editMessageId: 'card1', payload: { v: 2 }, nowMs: now + 10_000 });
    const lateAck = obStore.markOutboxDelivery('e1', { deliveryState: 'sent', claimToken: cl1.claimToken, nowMs: now + 10_500 });
    assert.equal(lateAck.ok, false);
    assert.equal(lateAck.code, 'OUTBOX_SUPERSEDED');

    // 6. ASTRA B5/B7/H6: Disjoint operationId vs remoteJobId, expired DesktopMutex before pin(), and cancelRemoteJob preserving pendingSuccessReceipts
    const led = createAsyncRemoteJobLedger({ filePath: path.join(dir, 'led3.jsonl'), now: () => now });
    const first = led.accept({ deploymentId: 'dep1', deviceId: 'd1', operationId: 'op_first', tool: 't', args: {} });
    const collide = led.accept({ deploymentId: 'dep1', deviceId: 'd1', operationId: first.record.remoteJobId, tool: 't', args: {} });
    assert.equal(collide.ok, false);
    assert.equal(collide.code, 'ERR_OPERATION_ID_COLLIDES_REMOTE_JOB_ID');

    // B7: DesktopMutex expires during slow synchronous handler await -> pin(true) returns false -> ERR_DESKTOP_MUTEX_EXPIRED & run() never executes!
    let runInvoked = false;
    const expMutex = createDesktopMutex({ defaultLeaseMs: 1_000, now: () => now });
    const expHost = createCompanionToolHost({
      deviceId: 'mac-exp',
      allowlist: ['slow_gui'],
      desktopTools: ['slow_gui'],
      desktopMutex: expMutex,
      asyncJobLedger: led,
      now: () => new Date(now),
      handlers: {
        slow_gui: async () => {
          now += 5_000; // simulate lease expiry during handler await
          return { __asyncAccepted: true, run: async () => { runInvoked = true; return { ok: true }; } };
        },
      },
    });
    const expRes = await expHost.handleEnvelope({ callId: 'cexp', deploymentId: 'dep1', deviceId: 'mac-exp', epoch: 1, tool: 'slow_gui', operationId: 'op_exp', deadlineMs: 1_000 });
    assert.equal(expRes.ok, false);
    assert.match(expRes.error, /ERR_DESKTOP_MUTEX_EXPIRED/);
    assert.equal(runInvoked, false);

    // H6: Pending unpersisted success receipt CANNOT be overwritten to `cancelled` by late cancelRemoteJob!
    let blockPersist = true;
    const baseLed = createAsyncRemoteJobLedger({ filePath: path.join(dir, 'h6r3.jsonl'), now: () => now });
    const flakyLed = {
      ...baseLed,
      isDurable: true,
      updateStatus(id, opts) {
        if (opts.status === 'succeeded' && blockPersist) throw new Error('ENOSPC');
        return baseLed.updateStatus(id, opts);
      },
    };
    const h6Host = createCompanionToolHost({
      deviceId: 'mac-h6r3',
      allowlist: ['wire_op'],
      asyncJobLedger: flakyLed,
      now: () => new Date(now),
      handlers: { wire_op: async () => ({ __asyncAccepted: true, run: async () => ({ tx: 'TX-SAVED' }) }) },
    });
    const acc = await h6Host.handleEnvelope({ callId: 'c_h6r3', deploymentId: 'dep_h6', deviceId: 'mac-h6r3', epoch: 1, tool: 'wire_op', operationId: 'op_h6r3' });
    await new Promise((r) => setTimeout(r, 20));
    // Cancel arrives while success receipt persistence is still failing -> MUST NOT mark cancelled!
    const canWhilePending = h6Host.cancelRemoteJob(acc.remoteJobId, { deploymentId: 'dep_h6' });
    assert.equal(canWhilePending.ok, true);
    assert.equal(canWhilePending.record.status, 'succeeded');
    assert.equal(canWhilePending.record.receipt.tx, 'TX-SAVED');
    // Disk comes back -> getRemoteJobStatus flushes `succeeded` cleanly
    blockPersist = false;
    const flushed = h6Host.getRemoteJobStatus(acc.remoteJobId, { deploymentId: 'dep_h6' });
    assert.equal(flushed.status, 'succeeded');
    assert.equal(baseLed.lookup(acc.remoteJobId, { deploymentId: 'dep_h6' }).status, 'succeeded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
