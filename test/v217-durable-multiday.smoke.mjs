// SCROLL 2.17 -- Durable Multi-Day Job Kernel (§57), Dual-Speed Wake Bus (§58),
// Requester/Group Authority (§63), and Fair-Share + Post-Mutex Fencing (§62a).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DURABLE_JOB_STATUSES,
  SCROLL_DURABLE_JOB_TOOL_SCHEMAS,
  BUILTIN_TIER_FLOOR,
  CORE_TOOL_GROUPS,
  createDurableJobStore,
  createJobWakeBus,
  createFairShareResourceQueue,
  createCompanionToolHost,
  createDesktopMutex,
  computeTempoTier,
  computeNextProbeDelaySec,
  isWithinQuietHours,
  detectPoliteBailout,
  evaluateEffectiveAuthority,
  projectJobForAudience,
} from '../index.js';

function tmpJobStore(clock, quietHours = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v217-'));
  return {
    dir,
    store: createDurableJobStore({ filePath: path.join(dir, 'jobs.json'), clock, quietHours }),
  };
}

test('SCROLL 2.17: 8 core statuses, scroll-core registration & tier floors verified', () => {
  assert.deepEqual(DURABLE_JOB_STATUSES, [
    'queued', 'running', 'waiting', 'reconciling', 'paused', 'completed', 'failed', 'cancelled',
  ]);
  const core = CORE_TOOL_GROUPS.find((g) => g.id === 'scroll-core');
  for (const s of SCROLL_DURABLE_JOB_TOOL_SCHEMAS) {
    assert.equal(core.match(s.name), true, `scroll-core must match ${s.name}`);
    assert.ok(BUILTIN_TIER_FLOOR[s.name], `BUILTIN_TIER_FLOOR must declare ${s.name}`);
  }
});

test('SCROLL 2.17: CAS claim, stale-epoch fencing, effectIntent crash -> reconciling & Day-29 idempotency', () => {
  let now = 1_800_000_000_000;
  const { dir, store } = tmpJobStore(() => now);
  try {
    const created = store.createJob({
      tenantId: 't1',
      agentId: 'ag1',
      origin: { type: 'ticket', refId: 'tk_1', dedupeKey: 'tk:1' },
      goal: 'Submit monthly compliance package and deliver verified receipt',
      doneCriteria: ['receipt_verified'],
      principals: { requester: { principalId: 'u_req', name: 'Req' }, ownerIds: ['u_own'] },
      audienceRoom: { channel: 'telegram', chatId: '-1001', threadId: '55', isGroup: true },
      authority: { ticketId: 'tk_1', toolScope: ['portal_submit', 'send_chat_media'], policySnapshot: { groupPolicy: 'owner_or_approve', ownerInRoom: true } },
      budget: { horizonDays: 30, maxSlices: 100 },
    });
    assert.equal(created.ok, true);
    const jobId = created.job.jobId;

    // Duplicate origin key returns same job idempotently
    const dup = store.createJob({
      tenantId: 't1',
      agentId: 'ag1',
      origin: { type: 'ticket', refId: 'tk_1', dedupeKey: 'tk:1' },
      goal: 'Duplicate attempt',
    });
    assert.equal(dup.deduplicated, true);
    assert.equal(dup.job.jobId, jobId);

    // Two workers race to claim -> only worker A wins
    const liveGroupOk = { botInRoom: true, ownerInRoom: true };
    const claimA = store.claimJob({ jobId, workerId: 'wA', leaseMs: 60_000, liveAuth: liveGroupOk });
    const claimB = store.claimJob({ jobId, workerId: 'wB', leaseMs: 60_000, liveAuth: liveGroupOk });
    assert.equal(claimA.ok, true);
    assert.equal(claimA.jobEpoch, 1);
    assert.equal(claimB.ok, false);
    assert.equal(claimB.code, 'JOB_NOT_CLAIMABLE');

    // Write effectIntent BEFORE dispatch
    const intent1 = store.recordEffectIntent({
      jobId,
      revision: claimA.revision,
      jobEpoch: claimA.jobEpoch,
      leaseToken: claimA.leaseToken,
      operationId: 'op_submit_day1',
      tool: 'portal_submit',
      args: { filingId: 'F-48' },
    });
    assert.equal(intent1.ok, true);
    assert.equal(intent1.idempotent, false);

    // Worker A crashes before saving receipt; Reaper detects expired lease with unreceipted effect -> reconciling!
    now += 120_000;
    const reaped = store.reap({ nowMs: now });
    assert.deepEqual(reaped.movedToReconciling, [jobId]);
    assert.equal(store.getJob(jobId).status, 'reconciling');

    // Stale worker A wakes up late and tries to park -> REJECTED!
    const latePark = store.parkJob({
      jobId,
      revision: intent1.revision,
      jobEpoch: claimA.jobEpoch,
      leaseToken: claimA.leaseToken,
      checkpoint: { progressSummary: 'stale write' },
    });
    assert.equal(latePark.ok, false);

    // Reconciler confirms Day-1 receipt succeeded, wakes job, Day-29 replay sees idempotent receipt & refuses conflicting args
    store.recordEffectReceipt({ jobId, operationId: 'op_submit_day1', status: 'succeeded', receipt: { confirmation: 'CONF-48' } });
    store.enqueueWake({ jobId, reason: 'reconciled' });
    now += 28 * 24 * 60 * 60 * 1000; // jump to Day 29
    const claimDay29 = store.claimJob({ jobId, workerId: 'wC', leaseMs: 60_000, liveAuth: liveGroupOk });
    assert.equal(claimDay29.ok, true);
    assert.equal(claimDay29.jobEpoch, 2);

    const replay = store.recordEffectIntent({
      jobId,
      revision: claimDay29.revision,
      jobEpoch: claimDay29.jobEpoch,
      leaseToken: claimDay29.leaseToken,
      operationId: 'op_submit_day1',
      tool: 'portal_submit',
      args: { filingId: 'F-48' },
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.intent.status, 'succeeded');

    const conflict = store.recordEffectIntent({
      jobId,
      revision: claimDay29.revision,
      jobEpoch: claimDay29.jobEpoch,
      leaseToken: claimDay29.leaseToken,
      operationId: 'op_submit_day1',
      tool: 'portal_submit',
      args: { filingId: 'F-DIFFERENT' },
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'ERR_EFFECT_CONFLICT');

    // Completing without required doneCriteria is blocked; with criteria succeeds and preserves immutableGoal
    const badDone = store.completeJob({
      jobId,
      revision: claimDay29.revision,
      jobEpoch: claimDay29.jobEpoch,
      leaseToken: claimDay29.leaseToken,
      summary: 'Done early',
      verifiedCriteria: [],
    });
    assert.equal(badDone.ok, false);
    assert.equal(badDone.code, 'DONE_CRITERIA_UNMET');

    const okDone = store.completeJob({
      jobId,
      revision: claimDay29.revision,
      jobEpoch: claimDay29.jobEpoch,
      leaseToken: claimDay29.leaseToken,
      summary: 'Submitted and verified CONF-48',
      verifiedCriteria: ['receipt_verified'],
    });
    assert.equal(okDone.ok, true);
    assert.equal(okDone.job.status, 'completed');
    assert.equal(okDone.job.checkpoint.immutableGoal, 'Submit monthly compliance package and deliver verified receipt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCROLL 2.17: Dual-Speed Sprint/Marathon, callback-before-park, 0-LLM Host probe, SSRF guard & quietHours', async () => {
  let now = Date.parse('2026-11-28T15:05:00Z'); // 22:05 Asia/Ho_Chi_Minh (inside quietHours!)
  const quietHours = { start: '22:00', end: '07:30', tz: 'Asia/Ho_Chi_Minh' };
  assert.equal(isWithinQuietHours(now, quietHours), true);

  const { dir, store } = tmpJobStore(() => now, quietHours);
  try {
    const dispatched = [];
    const bus = createJobWakeBus({
      store,
      onJobQueued: (ev) => dispatched.push(ev),
      clock: () => now,
    });

    // Reject unsafe probe registration (raw URL / path)
    assert.throws(() => bus.registerProbe('https://evil.internal/probe', () => true), /ERR_UNSAFE_PROBE_NAME/);
    assert.throws(() => bus.registerProbe('/etc/passwd', () => true), /ERR_UNSAFE_PROBE_NAME/);

    let readyFlag = false;
    let probeCalls = 0;
    bus.registerProbe('export_status', () => {
      probeCalls += 1;
      return { ready: readyFlag, note: readyFlag ? 'ready' : 'still_exporting' };
    });

    // Sprint job created at 22:05 local time STILL EXECUTES immediately (quietHours only suppresses human notifications)
    const liveOk = { botInRoom: true, ownerInRoom: true };
    const j = store.createJob({
      goal: 'Export 30-minute video render and deliver',
      principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'] },
      audienceRoom: { channel: 'telegram', chatId: '-1001', isGroup: true },
      authority: { ticketId: 'tk_sprint_1', policySnapshot: { groupPolicy: 'owner_or_approve', ownerInRoom: true } },
    }).job;
    const c1 = store.claimJob({ jobId: j.jobId, workerId: 'w1', liveAuth: liveOk });
    assert.equal(c1.ok, true);

    // Park with Sprint probe (30s -> 60s -> 120s -> 180s)
    const p1 = store.parkJob({
      jobId: j.jobId,
      revision: c1.revision,
      jobEpoch: c1.jobEpoch,
      leaseToken: c1.leaseToken,
      waitingFor: 'external',
      sleepSec: 30,
      probeName: 'export_status',
      checkpoint: { milestone: 'rendering', progressSummary: 'Submitted render' },
    });
    assert.equal(p1.ok, true);
    assert.equal(p1.job.tempoTier, 'sprint');

    // 4 negative probes in Sprint: 0 LLM calls, fast ladder 30s -> 60s -> 120s -> 180s
    const delays = [];
    for (let i = 0; i < 4; i++) {
      now = store.getJob(j.jobId).wake.nextReviewAtMs + 1000;
      const t = await bus.tick({ nowMs: now });
      assert.equal(t.woken.length, 0);
      assert.equal(t.probedNegative.length, 1);
      assert.equal(t.probedNegative[0].zeroLlm, true);
      delays.push(t.probedNegative[0].nextDelaySec);
    }
    assert.deepEqual(delays, [30, 60, 120, 180]);
    assert.equal(probeCalls, 4);
    assert.equal(store.getJob(j.jobId).budget.usedSlices, 1, 'Negative 0-LLM probes must consume 0 slices');

    // Jump past 2 hours -> automatically shifts to Marathon cadence (15m -> 30m -> 1h -> 4h)
    now += 2.5 * 60 * 60 * 1000;
    const tMar = await bus.tick({ nowMs: now });
    assert.equal(tMar.probedNegative[0].tempoTier, 'marathon');
    assert.equal(computeTempoTier({ createdAtMs: j.createdAtMs, nowMs: now, hasYielded: true }), 'marathon');
    assert.equal(computeNextProbeDelaySec({ tempoTier: 'marathon', negativeProbes: 0 }), 900);

    // Positive probe wakes immediately
    readyFlag = true;
    now = store.getJob(j.jobId).wake.nextReviewAtMs + 1000;
    const tWake = await bus.tick({ nowMs: now });
    assert.deepEqual(tWake.woken, [j.jobId]);

    // Callback-before-park race: event arrives while job is still `running`, then parkJob immediately wakes!
    const c2 = store.claimJob({ jobId: j.jobId, workerId: 'w2', liveAuth: liveOk });
    const earlyEv = await bus.publishEvent({ type: 'remote_job_done', jobId: j.jobId, operationId: 'op_fast' });
    assert.deepEqual(earlyEv.buffered, [j.jobId]);
    const p2 = store.parkJob({
      jobId: j.jobId,
      revision: c2.revision,
      jobEpoch: c2.jobEpoch,
      leaseToken: c2.leaseToken,
      waitingFor: 'external',
      wakeOn: [{ type: 'remote_job_done', operationId: 'op_fast' }],
      checkpoint: { milestone: 'post_fast' },
    });
    assert.equal(p2.ok, true);
    assert.equal(p2.immediateWake, true);
    assert.equal(p2.job.status, 'queued');

    // Unregistered probe rejected (anti-SSRF)
    const c3 = store.claimJob({ jobId: j.jobId, workerId: 'w3', liveAuth: liveOk });
    store.parkJob({
      jobId: j.jobId,
      revision: c3.revision,
      jobEpoch: c3.jobEpoch,
      leaseToken: c3.leaseToken,
      sleepSec: 30,
      probeName: 'http://169.254.169.254/latest/meta-data',
      checkpoint: {},
    });
    now += 60_000;
    const tSsrf = await bus.tick({ nowMs: now });
    assert.equal(tSsrf.probeRejected.length, 1);
    assert.equal(tSsrf.probeRejected[0].code, 'ERR_PROBE_NOT_REGISTERED');

    // Anti-bailout detector catches polite future promises without job_yield
    const bail = detectPoliteBailout('Khi nào xử lý xong mình sẽ kiểm tra lại và báo ngay nhé!', {
      toolTraces: [{ name: 'vm_render', result: { status: 'processing' } }],
      hasJobYield: false,
    });
    assert.equal(bail.detected, true);
    assert.equal(bail.code, 'POLITE_BAILOUT_BLOCKED');
    assert.equal(detectPoliteBailout('Khi nào xử lý xong mình sẽ báo ngay!', { hasJobYield: true }).detected, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCROLL 2.17: §63 3-principal Group Authority, Permission Drift, ask_requester vs escalate_owner (0s park) & Steering', () => {
  let now = 1_800_000_000_000;
  const { dir, store } = tmpJobStore(() => now);
  try {
    const job = store.createJob({
      goal: 'Compile Q4 team report from workspace',
      principals: {
        requester: { principalId: 'u_req', externalId: 'tg:5521', name: 'Requester A' },
        ownerIds: ['u_owner'],
      },
      audienceRoom: { channel: 'telegram', chatId: '-10077', threadId: '90', isGroup: true },
      authority: {
        ticketId: 'tk_77',
        specHash: 'sha256:abc',
        toolScope: ['browser_read', 'doc_create'],
        policySnapshot: { groupPolicy: 'owner_or_approve', ownerInRoom: true, ownerGroupSafe: true },
      },
    }).job;

    // 1. Live re-authorization catches permission drift (bot removed, owner left, policy tightened, agent paused)
    assert.equal(evaluateEffectiveAuthority({ job, liveAuth: { botInRoom: false } }).code, 'BOT_REMOVED');
    assert.equal(evaluateEffectiveAuthority({ job, liveAuth: { botInRoom: true, ownerInRoom: false } }).code, 'OWNER_LEFT_ROOM');
    assert.equal(evaluateEffectiveAuthority({ job, liveAuth: { botInRoom: true, ownerInRoom: true, groupPolicy: 'owner_dm_only' } }).code, 'POLICY_RESTRICTED');
    assert.equal(evaluateEffectiveAuthority({ job, liveAuth: { agentPaused: true } }).code, 'AGENT_PAUSED');

    // Claiming when owner left group parks job in waiting(authority) and sends owner DM outbox
    const driftClaim = store.claimJob({ jobId: job.jobId, liveAuth: { botInRoom: true, ownerInRoom: false } });
    assert.equal(driftClaim.ok, false);
    assert.equal(driftClaim.code, 'OWNER_LEFT_ROOM');
    assert.equal(driftClaim.waitingFor, 'authority');

    // Restore owner presence -> claim succeeds with secret/captcha forbidden for group origin
    const liveAuthWithHash = { botInRoom: true, ownerInRoom: true, liveSpecHash: 'sha256:abc', allowedTools: ['browser_read', 'doc_create', 'secret_fill'] };
    const authOk = evaluateEffectiveAuthority({
      job,
      liveAuth: liveAuthWithHash,
    });
    assert.equal(authOk.allowed, true);
    assert.equal(authOk.forbidSecrets, true);
    assert.ok(!authOk.effectiveTools.includes('secret_fill'));

    store.enqueueWake({ jobId: job.jobId, reason: 'owner_returned' });
    const c1 = store.claimJob({ jobId: job.jobId, liveAuth: liveAuthWithHash });
    assert.equal(c1.ok, true);

    // 2. ask_requester parks immediately (inlineWaitSec=0), blocks agent self-answer & stranger answer
    const ask = store.openAsk({
      jobId: job.jobId,
      revision: c1.revision,
      jobEpoch: c1.jobEpoch,
      leaseToken: c1.leaseToken,
      targetRole: 'requester',
      kind: 'choice',
      question: 'Weekly or monthly breakdown?',
      options: [{ id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }],
    });
    assert.equal(ask.ok, true);
    assert.equal(ask.inlineWaitSec, 0);
    assert.equal(ask.job.status, 'waiting');
    assert.equal(ask.job.waitingFor, 'requester');
    assert.equal(ask.job.lease, null);

    // Agent cannot answer own ask
    assert.equal(store.answerAsk({ askId: ask.ask.askId, actorId: 'ag_1', actorRole: 'agent', answer: 'weekly' }).code, 'AGENT_CANNOT_ANSWER');
    // Stranger in group cannot answer requester's ask
    assert.equal(store.answerAsk({ askId: ask.ask.askId, actorId: 'u_stranger', actorRole: 'member', answer: 'monthly' }).code, 'ASK_RECIPIENT_MISMATCH');
    // Exact requester answers -> wakes job
    const ansOk = store.answerAsk({ askId: ask.ask.askId, actorId: 'tg:5521', actorRole: 'requester', answer: 'weekly' });
    assert.equal(ansOk.ok, true);
    assert.equal(ansOk.job.status, 'queued');

    // 3. escalate_owner routes ONLY to Owner DM + neutral projection in group (no private DM notes leaked!)
    const c2 = store.claimJob({ jobId: job.jobId, liveAuth: liveAuthWithHash });
    const esc = store.openAsk({
      jobId: job.jobId,
      revision: c2.revision,
      jobEpoch: c2.jobEpoch,
      leaseToken: c2.leaseToken,
      targetRole: 'owner',
      kind: 'handoff',
      question: 'Approve elevated export tool?',
    });
    assert.equal(esc.ok, true);
    assert.equal(esc.ask.privacy, 'owner_dm_only');
    const groupProj = projectJobForAudience(esc.job, { isOwner: false, isGroup: true, chatId: '-10077' });
    assert.equal(groupProj.waitingFor, 'owner_approval_neutral');
    assert.match(groupProj.neutralNotice, /administrator authorization/);
    assert.equal(projectJobForAudience(esc.job, { isOwner: false, isGroup: true, chatId: '-99999' }), null);

    // Owner answers with private DM note -> never enters job eventInbox
    const ownAns = store.answerAsk({
      askId: esc.ask.askId,
      actorId: 'u_owner',
      actorRole: 'owner',
      answer: { approved: false },
      privateOwnerNote: 'SECRET_OWNER_NOTE_CLIENT_UNPAID',
    });
    assert.equal(ownAns.ok, true);
    assert.ok(!JSON.stringify(ownAns.job.eventInbox).includes('SECRET_OWNER_NOTE_CLIENT_UNPAID'));

    // 4. Steering matrix: stranger blocked, requester in-scope amend allowed, out-of-scope amend needs reapproval
    assert.equal(store.submitSteering({ jobId: job.jobId, sourceEventId: 'e1', actorId: 'u_stranger', commandKind: 'cancel' }).code, 'STEERING_DENIED_STRANGER');
    const escScope = store.submitSteering({
      jobId: job.jobId,
      sourceEventId: 'e2',
      actorId: 'u_req',
      commandKind: 'amend',
      requestedCapabilities: ['send_external_email'],
      payload: { text: 'Also email all customers' },
    });
    assert.equal(escScope.ok, false);
    assert.equal(escScope.code, 'REAPPROVAL_REQUIRED');
    assert.equal(escScope.requiresNewApproval, true);

    const okAmend = store.submitSteering({
      jobId: job.jobId,
      sourceEventId: 'e3',
      actorId: 'u_req',
      commandKind: 'amend',
      requestedCapabilities: ['doc_create'],
      payload: { text: 'Include summary tab' },
    });
    assert.equal(okAmend.ok, true);
    assert.equal(okAmend.job.intentRev, 2);

    // Statutory lock escalates instead of silently expiring on deadline
    const statJob = store.createJob({
      goal: 'Statutory tax filing',
      principals: { requester: { principalId: 'u_owner' }, ownerIds: ['u_owner'] },
      budget: { horizonDays: 1, statutoryLock: true },
    }).job;
    now += 2 * 24 * 60 * 60 * 1000;
    const statReap = store.reap({ nowMs: now });
    assert.deepEqual(statReap.statutoryEscalations, [statJob.jobId]);
    assert.equal(store.getJob(statJob.jobId).status, 'paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCROLL 2.17: §62a Companion checks resourceFence AFTER DesktopMutex & Fair-Share DRR prevents starvation', async () => {
  let ownerStillInRoom = true;
  let handlerExecuted = 0;
  const mutex = createDesktopMutex({ defaultLeaseMs: 10_000 });
  const fsQueue = createFairShareResourceQueue({ maxPerGroupInFlight: 1, maxPerGroupQueued: 10 });

  const host = createCompanionToolHost({
    deviceId: 'mac-pro-1',
    physicalResourceId: 'phys-mac-1',
    allowlist: ['gui_click', 'captcha_handoff'],
    desktopTools: ['gui_click'],
    disallowGroupOriginTools: ['captcha_handoff'],
    desktopMutex: mutex,
    fairShareQueue: fsQueue,
    verifyResourceFence: () => (ownerStillInRoom
      ? { allowed: true }
      : { allowed: false, code: 'ERR_OWNER_LEFT_DURING_WAIT', reason: 'owner_left_group' }),
    handlers: {
      gui_click: async () => { handlerExecuted += 1; return { clicked: true }; },
      captcha_handoff: async () => ({ handedOff: true }),
    },
  });

  // Group-origin call to captcha_handoff is blocked at Companion boundary
  const capDenied = await host.handleEnvelope({
    callId: 'c_cap',
    deploymentId: 'd1',
    deviceId: 'mac-pro-1',
    epoch: 1,
    tool: 'captcha_handoff',
    originIsGroup: true,
    riskTier: 'reversible_write',
  });
  assert.equal(capDenied.ok, false);
  assert.match(capDenied.error, /ERR_GROUP_ORIGIN_FORBIDDEN/);

  // Hold DesktopMutex while group call waits; owner leaves group BEFORE mutex releases -> post-wait fence MUST block execution!
  const hold = await mutex.acquire({ holderId: 'other', tool: 'gui_click', leaseMs: 5000 });
  const waitingCall = host.handleEnvelope({
    callId: 'c_wait',
    deploymentId: 'd1',
    deviceId: 'mac-pro-1',
    epoch: 1,
    tool: 'gui_click',
    originIsGroup: true,
    groupId: 'grp-A',
    riskTier: 'reversible_write',
  });
  await new Promise((r) => setTimeout(r, 15));
  ownerStillInRoom = false;
  hold.release();
  const res = await waitingCall;
  assert.equal(res.ok, false);
  assert.match(res.error, /ERR_OWNER_LEFT_DURING_WAIT/);
  assert.equal(handlerExecuted, 0, 'Handler must NEVER execute when fence revokes during mutex wait');

  // Fair-Share DRR: Group A floods 4 queued requests, Group B sends 1 -> Group B gets served before Group A drains!
  const q = createFairShareResourceQueue({ maxPerGroupInFlight: 1, maxPerGroupQueued: 10 });
  const first = await q.acquire({ physicalResourceId: 'phys-1', tenantId: 't1', groupId: 'grp-A' });
  const order = [];
  const pA2 = q.acquire({ physicalResourceId: 'phys-1', tenantId: 't1', groupId: 'grp-A' }).then((l) => { order.push('A2'); return l; });
  const pA3 = q.acquire({ physicalResourceId: 'phys-1', tenantId: 't1', groupId: 'grp-A' }).then((l) => { order.push('A3'); return l; });
  const pB1 = q.acquire({ physicalResourceId: 'phys-1', tenantId: 't1', groupId: 'grp-B' }).then((l) => { order.push('B1'); return l; });
  first.release();
  const l1 = await Promise.race([pA2, pB1]);
  l1.release();
  const l2 = await (order[0] === 'B1' ? pA2 : pB1);
  l2.release();
  const l3 = await pA3;
  l3.release();
  // Group B MUST have been served in position 1 or 2 (strictly before A3!)
  assert.ok(order.indexOf('B1') < order.indexOf('A3'), `Expected B1 before A3, got ${order.join(',')}`);
});
