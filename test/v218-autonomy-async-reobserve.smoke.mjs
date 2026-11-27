// SCROLL 2.18 -- Autonomy Continuation (§59), 4-Branch Dispositions, Companion Async 202
// (`scroll-remote-job/v1`, §62b), Re-Observe First CV/Browser Gate, Default-Unless-Vetoed,
// 2-Nudge-1-Park, and Cancel-vs-Dispatch Race Arbitration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  validateAutonomyConfig,
  resolveAutonomyConfig,
  classifyToolErrorDisposition,
  buildContinuationWorkLedger,
  validateReObserveBeforeGuiAction,
  isGuiObserveTool,
  createAsyncRemoteJobLedger,
  createCompanionToolHost,
  createRemoteToolClient,
  createDurableJobStore,
  createChatSessionRuntime,
  createToolRegistry,
} from '../index.js';

test('SCROLL 2.18: IDENTITY.autonomy defaults to off, validates bounds, and classifies 4 error dispositions', () => {
  const def = resolveAutonomyConfig(null);
  assert.equal(def.on_turn_exhausted, 'off');
  assert.equal(def.recovery_rounds, 2);

  assert.equal(validateAutonomyConfig({ on_turn_exhausted: 'continue_in_background', recovery_rounds: 3, default_horizon_days: 14 }).ok, true);
  assert.equal(validateAutonomyConfig({ on_turn_exhausted: 'invalid_mode' }).ok, false);
  assert.equal(validateAutonomyConfig({ default_horizon_days: 99 }).ok, false);

  // 4 dispositions: hard abort vs park_waiting vs retry_backoff vs feed_llm_repair
  assert.equal(classifyToolErrorDisposition({ code: 'SECRET_DESTINATION_MISMATCH' }).disposition, 'abort_job');
  assert.equal(classifyToolErrorDisposition({ status: 'denied', error: 'ERR_LOCAL_APPROVAL_DENIED' }).disposition, 'abort_job');
  assert.equal(classifyToolErrorDisposition({ code: 'BUDGET_EXCEEDED' }).disposition, 'abort_job');

  const off = classifyToolErrorDisposition({ error: 'ERR_COMPANION_OFFLINE:mac-1' });
  assert.equal(off.disposition, 'park_waiting');
  assert.equal(off.parkWaitingFor, 'companion');

  assert.equal(classifyToolErrorDisposition({ error: 'HTTP 429 RATE_LIMIT' }).disposition, 'retry_backoff');
  assert.equal(classifyToolErrorDisposition({ code: 'ERR_REOBSERVE_REQUIRED' }).disposition, 'feed_llm_repair');
  assert.equal(classifyToolErrorDisposition({ error: '404 NOT_FOUND' }).disposition, 'feed_llm_repair');

  // Work ledger caps at 25 lines and permanently locks line 0 to [GOAL]
  const manyTraces = Array.from({ length: 40 }, (_, i) => ({ name: `step_${i}`, ok: true, summary: `done ${i}` }));
  const ledger = buildContinuationWorkLedger({
    immutableGoal: 'Complete quarterly audit reconciliation',
    doneCriteria: ['xlsx_attached'],
    toolTraces: manyTraces,
    maxLines: 25,
  });
  assert.equal(ledger.length, 25);
  assert.equal(ledger[0], '[GOAL] Complete quarterly audit reconciliation');
});

test('SCROLL 2.18: §62b Re-Observe First blocks stale GUI mutations after sleep until post-wake observe', () => {
  const now = 1_800_000_000_000;
  // Woke 10 minutes after last observe -> click with stale tabId MUST be blocked
  const staleCp = {
    lastObservedAtMs: now - 10 * 60 * 1000,
    lastWokeAtMs: now - 5_000,
    reacquireAnchors: { url: 'https://portal.example/list', expectedTitle: 'Submissions' },
  };
  const blocked = validateReObserveBeforeGuiAction({
    checkpoint: staleCp,
    toolName: 'browser_click',
    args: { tabId: 7, element_index: 12 },
    nowMs: now,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'ERR_REOBSERVE_REQUIRED');
  assert.equal(blocked.reacquireAnchors.url, 'https://portal.example/list');

  // Non-GUI tools remain allowed
  assert.equal(validateReObserveBeforeGuiAction({ checkpoint: staleCp, toolName: 'job_status', nowMs: now }).allowed, true);
  assert.equal(isGuiObserveTool('perceive'), true);
  assert.equal(isGuiObserveTool('cua_observe'), true);

  // Once post-wake observe updates lastObservedAtMs -> GUI click succeeds
  const freshCp = { ...staleCp, lastObservedAtMs: now - 1_000 };
  assert.equal(validateReObserveBeforeGuiAction({ checkpoint: freshCp, toolName: 'browser_click', args: { selector: '#ok' }, nowMs: now }).allowed, true);
});

test('SCROLL 2.18: §62b Companion Async 202 (scroll-remote-job/v1) never maps 202 to completed, survives lost ACK & cancels cleanly', async () => {
  let now = 1_800_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v218-async-'));
  try {
    const ledger = createAsyncRemoteJobLedger({
      filePath: path.join(dir, 'remote-jobs.jsonl'),
      now: () => now,
    });
    const doneEvents = [];
    let releaseRender = null;

    const host = createCompanionToolHost({
      deviceId: 'vm-win11',
      allowlist: ['vm_render_deck'],
      asyncJobLedger: ledger,
      onAsyncJobDone: (ev) => doneEvents.push(ev),
      now: () => new Date(now),
      handlers: {
        vm_render_deck: async (args) => ({
          __asyncAccepted: true,
          pollAfterSec: 15,
          run: () => new Promise((resolve) => {
            releaseRender = () => resolve({ ok: true, outputPath: `/out/${args.deck}.pptx` });
          }),
        }),
      },
    });

    const client = createRemoteToolClient({
      deploymentId: 'dep_1',
      deviceId: 'vm-win11',
      getEpoch: () => 1,
      sendRequest: (env) => host.handleEnvelope(env),
      toolSpecs: [{ name: 'vm_render_deck', risk: 'reversible_write', timeoutMs: 120_000 }],
    });

    // 1. Dispatch returns 202 Accepted -> client returns status='accepted' (NEVER 'completed'!)
    const res = await client.invoke('vm_render_deck', { deck: 'q4' }, { operationId: 'op_render_1' });
    assert.equal(res.ok, true);
    assert.equal(res.accepted, true);
    assert.equal(res.status, 'accepted');
    assert.ok(res.remoteJobId.startsWith('rj_'));

    // 2. Replaying same (operationId, same args) returns same remoteJobId idempotently; different args -> conflict!
    const replay = await client.invoke('vm_render_deck', { deck: 'q4' }, { operationId: 'op_render_1' });
    assert.equal(replay.remoteJobId, res.remoteJobId);
    const conflict = await client.invoke('vm_render_deck', { deck: 'DIFFERENT' }, { operationId: 'op_render_1' });
    assert.equal(conflict.ok, false);
    assert.match(conflict.error, /ERR_OPERATION_CONFLICT/);

    // 3. Even if host lost the 202 ACK (doesn't know remoteJobId), lookup by operationId recovers state!
    assert.equal(host.getRemoteJobStatus('op_render_1', { deploymentId: 'dep_1' }).status, 'running');

    // 4. Finish background render -> transitions to succeeded and pushes completion event; receipt retained on Day 30!
    releaseRender();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(doneEvents.length, 1);
    assert.equal(doneEvents[0].status, 'succeeded');
    now += 30 * 24 * 60 * 60 * 1000;
    const day30 = host.getRemoteJobStatus('op_render_1', { deploymentId: 'dep_1' });
    assert.equal(day30.status, 'succeeded');
    assert.equal(day30.receipt.outputPath, '/out/q4.pptx');

    // 5. Cancel an in-flight async remote job cleanly
    const res2 = await client.invoke('vm_render_deck', { deck: 'cancel_me' }, { operationId: 'op_render_2' });
    assert.equal(res2.status, 'accepted');
    const cancelled = host.cancelRemoteJob(res2.remoteJobId);
    assert.equal(cancelled.ok, true);
    assert.equal(host.getRemoteJobStatus(res2.remoteJobId).status, 'cancelled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCROLL 2.18: Default-Unless-Vetoed, 2-Nudge-1-Park (respecting quietHours), and Cancel-vs-Dispatch race', () => {
  let now = Date.parse('2026-11-28T03:00:00Z'); // 10:00 Asia/Ho_Chi_Minh (daytime)
  const quietHours = { start: '22:00', end: '07:30', tz: 'Asia/Ho_Chi_Minh' };
  const store = createDurableJobStore({ clock: () => now, quietHours });

  // 1. Default-Unless-Vetoed auto-answers safe requester choice after 20 minutes
  const j1 = store.createJob({
    goal: 'Export weekly report',
    principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'] },
  }).job;
  const c1 = store.claimJob({ jobId: j1.jobId });
  const a1 = store.openAsk({
    jobId: j1.jobId,
    revision: c1.revision,
    jobEpoch: c1.jobEpoch,
    leaseToken: c1.leaseToken,
    targetRole: 'requester',
    kind: 'choice',
    question: 'Export weekly or both tabs?',
    defaultOption: 'both_tabs',
    defaultAfterSec: 1200,
  });
  assert.equal(a1.ok, true);
  now += 1205 * 1000;
  const r1 = store.reap({ nowMs: now });
  assert.deepEqual(r1.defaultedAsks, [a1.ask.askId]);
  assert.equal(store.getJob(j1.jobId).status, 'queued');
  assert.equal(store.getAsk(a1.ask.askId).answer.value, 'both_tabs');

  // 2. 2-Nudge-1-Park for hard questions without default
  const j2 = store.createJob({
    goal: 'Need client contract code',
    principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'] },
  }).job;
  const c2 = store.claimJob({ jobId: j2.jobId });
  const a2 = store.openAsk({
    jobId: j2.jobId,
    revision: c2.revision,
    jobEpoch: c2.jobEpoch,
    leaseToken: c2.leaseToken,
    targetRole: 'requester',
    kind: 'text',
    question: 'Please provide contract ID',
    nudgeDelaySec: 3600,
  });
  now += 3605 * 1000;
  assert.deepEqual(store.reap({ nowMs: now }).nudgedAsks, [a2.ask.askId]);
  now += 3605 * 1000;
  assert.deepEqual(store.reap({ nowMs: now }).nudgedAsks, [a2.ask.askId]);
  now += 3605 * 1000;
  assert.deepEqual(store.reap({ nowMs: now }).pausedSilentAsks, [a2.ask.askId]);
  assert.equal(store.getJob(j2.jobId).status, 'paused');

  // 3. Cancel racing with in-flight effect -> enters cancel_requested / reconciling until settled!
  const j3 = store.createJob({
    goal: 'Submit form',
    principals: { requester: { principalId: 'u_req' }, ownerIds: ['u_own'] },
  }).job;
  const c3 = store.claimJob({ jobId: j3.jobId });
  store.recordEffectIntent({
    jobId: j3.jobId,
    revision: c3.revision,
    jobEpoch: c3.jobEpoch,
    leaseToken: c3.leaseToken,
    operationId: 'op_in_flight',
    tool: 'submit_form',
    args: { id: 1 },
  });
  const can = store.submitSteering({ jobId: j3.jobId, sourceEventId: 'can1', actorId: 'u_req', commandKind: 'cancel' });
  assert.equal(can.ok, true);
  assert.equal(can.cancelState, 'cancel_requested');
  assert.notEqual(store.getJob(j3.jobId).status, 'cancelled');

  // Once in-flight effect receipt settles -> transitions cleanly to cancelled
  store.recordEffectReceipt({ jobId: j3.jobId, operationId: 'op_in_flight', status: 'cancelled' });
  assert.equal(store.getJob(j3.jobId).status, 'cancelled');
});

test('SCROLL 2.18: chat-session hands off exhausted turn when autonomy=continue_in_background', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v218-chat-'));
  try {
    const agentDir = path.join(dir, 'agents', 'demo');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), '---\nname: demo\nversion: 1.0.0\nruntimes: [codex]\nmodel: mock\ncapabilities: [web.search]\n---\n');
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), 'Concise assistant.');

    const tools = createToolRegistry();
    tools.register({
      name: 'ping_step',
      description: 'Run one step',
      risk: 'read_only',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ status: 'processing' }),
    });

    const alwaysToolProvider = {
      name: 'mock',
      model: 'mock',
      supportsTools: true,
      ready: () => ({ ok: true }),
      async generate(prompt, opts) {
        if (!opts?.tools) {
          return { text: 'Synthesized default summary.', toolCalls: [], usage: { uncachedInputTokens: 5, outputTokens: 5 } };
        }
        return {
          text: '',
          toolCalls: [{ id: `tc_${Math.random()}`, name: 'ping_step', args: {} }],
          usage: { uncachedInputTokens: 10, outputTokens: 10 },
        };
      },
    };

    const handoffs = [];
    const runtime = createChatSessionRuntime({
      agentName: 'demo',
      deploymentDir: dir,
      stateDir: path.join(dir, 'state'),
      provider: alwaysToolProvider,
      tools,
      maxToolRounds: 2,
      autonomy: { on_turn_exhausted: 'continue_in_background' },
      onTurnExhausted: (payload) => {
        handoffs.push(payload);
        return { ok: true, jobId: 'job_escalated_1', ackText: 'Handed off to background job job_escalated_1.' };
      },
      acquireLock: false,
    });

    const out = await runtime.sendTurn({
      conversationId: 'dm:owner',
      text: 'Analyze 50 documents across the portal',
      sender: { id: 'owner_1', isOwner: true },
    });
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].workLedger[0], '[GOAL] Analyze 50 documents across the portal');
    assert.match(out.text, /job_escalated_1/);

    // Control check: default autonomy='off' does NOT hand off and runs standard synthesis
    const offHandoffs = [];
    const runtimeOff = createChatSessionRuntime({
      agentName: 'demo',
      deploymentDir: dir,
      stateDir: path.join(dir, 'state-off'),
      provider: alwaysToolProvider,
      tools,
      maxToolRounds: 2,
      onTurnExhausted: (p) => { offHandoffs.push(p); return { ok: true, jobId: 'should_not_fire' }; },
      acquireLock: false,
    });
    const outOff = await runtimeOff.sendTurn({
      conversationId: 'dm:owner-off',
      text: 'Quick check',
      sender: { id: 'owner_1', isOwner: true },
    });
    assert.equal(offHandoffs.length, 0);
    assert.match(outOff.text, /Synthesized default summary/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
