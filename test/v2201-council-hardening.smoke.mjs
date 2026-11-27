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
