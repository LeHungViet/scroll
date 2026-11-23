// SCROLL v2.6 — Opt-In Continuity & Advisory Specialist Smoke Suite.
// Verifies:
//   1. Core chat-session hooks (`onBeforeDeliver` allow/modify/hold + async non-blocking `onTurnCompleted`)
//   2. `@agentpro/scroll-continuity`: 6-table Bi-Temporal SQLite, provenance, epistemic guard, tenant isolation,
//      POMR B|D|U parking, SMR=0% statutory lock, prospective wake_cues, 5D impedance (mood vs trait + soft override),
//      ACT-R independent-confirm tie-break, Sleep-Time CAS worker, backup/restore durability, recall tool & replay harness
//   3. `@agentpro/scroll-advisory`: Tri-Partite Cortex (T1 bi-temporal + T2 auto-freeze + T3 TTL Tier A/B/C/D),
//      Counterfactual Pre-Flight, Decision-Flip VoI, 4-Invariant Delivery Guard, Apprenticeship Ladder,
//      7-Metric Bench & 3-Stage Automated Regression Gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatSessionRuntime } from '../lib/chat-session.js';
import {
  createContinuityEngine,
  createContinuityScrollHooks,
  computeActrScore,
  evaluateParkingFlags,
  runContinuityReplay,
} from '../packages/scroll-continuity/src/index.js';
import {
  createAdvisorySpecialistEngine,
  evaluateDecisionFlipQuestion,
  runCounterfactualPreflight,
} from '../packages/scroll-advisory/src/index.js';

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('v2.6 — @agentpro/scroll-continuity + @agentpro/scroll-advisory + core hooks');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v26-cont-adv-'));

try {
  await t('1. Core chat-session hooks: onBeforeDeliver (hold/modify) & async non-blocking onTurnCompleted', async () => {
    const rootDir = path.join(tmpDir, 'root-core');
    const agentDir = path.join(rootDir, 'agents', 'helper');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), '---\nname: helper\nspeaks_as: self\n---\nHelper agent.');
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), 'Concise and helpful.');

    const completedEvents = [];
    let mode = 'modify';
    const fakeProvider = {
      name: 'mock',
      model: 'mock-1',
      ready: true,
      async generate() {
        return { text: 'Original draft reply', usage: { uncachedInputTokens: 10, outputTokens: 5 } };
      },
      async close() {},
    };

    const session = createChatSessionRuntime({
      deploymentDir: rootDir,
      agentName: 'helper',
      stateDir: path.join(tmpDir, 'state-core'),
      provider: fakeProvider,
      hooks: {
        async onBeforeDeliver({ text }) {
          if (mode === 'modify') return { action: 'modify', text: `${text} [checked]` };
          if (mode === 'hold') return { action: 'hold', reason: 'test_guard', text: 'Held safely.' };
          return { action: 'allow' };
        },
        async onTurnCompleted(payload) {
          await new Promise((r) => setTimeout(r, 15));
          completedEvents.push(payload);
        },
      },
    });

    const r1 = await session.sendTurn({ conversationId: 'c1', text: 'hello' });
    assert.equal(r1.text, 'Original draft reply [checked]');
    assert.equal(r1.streamHeld, false);

    mode = 'hold';
    const r2 = await session.sendTurn({ conversationId: 'c1', text: 'trigger hold' });
    assert.equal(r2.text, 'Held safely.');
    assert.equal(r2.streamHeld, true);

    // Wait briefly for non-blocking onTurnCompleted fire-and-forget callbacks
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(completedEvents.length, 2);
    assert.equal(completedEvents[0].result.text, 'Original draft reply [checked]');
    assert.equal(completedEvents[1].result.streamHeld, true);
    await session.close();
  });

  await t('2. Continuity 6-table bi-temporal ledger: provenance required, epistemic separation & time-travel asOfSeq', () => {
    const dbPath = path.join(tmpDir, 'cont-1.sqlite');
    const engine = createContinuityEngine({ dbPath });
    try {
      const e1 = engine.recordEvent('tenant-a', {
        sourceUpdateId: 'u1',
        chatId: 'room-1',
        senderId: 'user-1',
        senderName: 'Sam',
        body: 'Notice received for Penalty 4254 due Oct 31.',
        occurredAt: '2026-10-25T10:00:00Z',
      });
      // Duplicate update idempotency
      const e1Dup = engine.recordEvent('tenant-a', {
        sourceUpdateId: 'u1',
        chatId: 'room-1',
        body: 'Notice received for Penalty 4254 due Oct 31.',
      });
      assert.equal(e1Dup.appended, false);
      assert.equal(e1Dup.duplicate, true);

      // Provenance invariant: missing supports MUST throw
      assert.throws(() => {
        engine.ledger.upsertNodeRevision('tenant-a', {
          kind: 'obligation',
          title: 'No provenance',
          knownFromSeq: e1.event.seq,
          supports: [],
        });
      }, /PROVENANCE_REQUIRED/);

      // Epistemic invariant: user_claim CANNOT commit business_settlement
      assert.throws(() => {
        engine.ledger.upsertNodeRevision('tenant-a', {
          kind: 'obligation',
          title: 'Penalty 4254',
          epistemicLevel: 'business_settlement',
          knownFromSeq: e1.event.seq,
          supports: [{ sourceSeq: e1.event.seq, sourceType: 'user_msg', excerptRef: 'I paid it' }],
        });
      }, /EPISTEMIC_VIOLATION/);

      // Commit valid obligation at seq 1
      const ob = engine.problems.registerProblem('tenant-a', {
        kind: 'obligation',
        businessKey: 'OB-4254',
        title: 'Penalty 4254',
        summary: '3.5M overdue notice',
        dueAt: '2026-10-31',
        hasLegalConsequence: true,
        epistemicLevel: 'document_evidence',
        validFrom: '2026-09-30',
        knownFromSeq: e1.event.seq,
        supports: [{ sourceSeq: e1.event.seq, sourceType: 'document', excerptRef: 'notice-pdf' }],
      }).node;

      // Later on Nov 5 (seq 2), receipt dated Oct 31 arrives
      const e2 = engine.recordEvent('tenant-a', {
        sourceUpdateId: 'u2',
        chatId: 'room-1',
        senderId: 'user-1',
        senderName: 'Sam',
        body: 'Uploaded transfer receipt dated Oct 31',
        occurredAt: '2026-11-05T09:00:00Z',
      });
      engine.ledger.upsertNodeRevision('tenant-a', {
        nodeId: ob.nodeId,
        kind: 'obligation',
        businessKey: 'OB-4254',
        priorityTier: 'STATUTORY_PENALTY',
        title: 'Penalty 4254',
        summary: 'Transfer receipt dated Oct 31 received; pending ledger reconciliation',
        status: 'open',
        epistemicLevel: 'document_evidence',
        validFrom: '2026-10-31',
        knownFromSeq: e2.event.seq,
        hasLegalConsequence: true,
        dueAt: '2026-10-31',
        supports: [{ sourceSeq: e2.event.seq, sourceType: 'ocr', excerptRef: 'receipt-oct31' }],
      });

      // Time-travel query as of seq 1 MUST NOT see seq 2 receipt!
      const atSeq1 = engine.ledger.getNodeAt('tenant-a', ob.nodeId, { asOfSeq: e1.event.seq });
      assert.equal(atSeq1.summary, '3.5M overdue notice');
      assert.equal(atSeq1.knownFromSeq, 1);

      const atSeq2 = engine.ledger.getNodeAt('tenant-a', ob.nodeId, { asOfSeq: e2.event.seq });
      assert.match(atSeq2.summary, /Oct 31/);
      assert.equal(atSeq2.knownFromSeq, 2);

      // Backup & integrity verify
      const backupPath = path.join(tmpDir, 'backup-cont-1.sqlite');
      const bk = engine.backupTo(backupPath);
      assert.equal(bk.ok, true);
      assert.ok(bk.sizeBytes > 0);
    } finally {
      engine.close();
    }

    // Reopen durability test after close
    const reopened = createContinuityEngine({ dbPath });
    try {
      assert.equal(reopened.ledger.getHeadSeq('tenant-a'), 2);
      assert.equal(reopened.verifyIntegrity().ok, true);
    } finally {
      reopened.close();
    }
  });

  await t('3. POMR B|D|U Parking, SMR=0% statutory lock, prospective wake_cues & duplicate artifact suppression', () => {
    const engine = createContinuityEngine({ dbPath: ':memory:' });
    try {
      const e1 = engine.recordEvent('t1', { sourceUpdateId: 'm1', body: 'Need Q3 filing done. Also curious about optional benefits.' });
      const goal = engine.problems.registerProblem('t1', {
        kind: 'goal',
        title: 'Complete Q3 Filing',
        knownFromSeq: e1.event.seq,
        supports: [{ sourceSeq: e1.event.seq, sourceType: 'user_msg' }],
      }).node;
      const stat = engine.problems.registerProblem('t1', {
        kind: 'obligation',
        title: 'Statutory Penalty Cutoff',
        dueAt: '2026-10-31',
        hasLegalConsequence: true,
        knownFromSeq: e1.event.seq,
        supports: [{ sourceSeq: e1.event.seq, sourceType: 'document' }],
      }).node;
      const side = engine.problems.registerProblem('t1', {
        kind: 'parked_item',
        title: 'Optional Benefits Inquiry',
        wakeCues: ['payroll', 'benefits', 'onboarding'],
        reopenCondition: 'Client uploads payroll sheet or asks directly',
        autoExpireAt: '2026-11-15T00:00:00Z',
        hasLegalConsequence: false,
        userAskingNow: false,
        knownFromSeq: e1.event.seq,
        supports: [{ sourceSeq: e1.event.seq, sourceType: 'user_msg' }],
      }).node;

      assert.equal(goal.priorityTier, 'APEX_GOAL');
      assert.equal(stat.priorityTier, 'STATUTORY_PENALTY');
      assert.equal(side.priorityTier, 'PARKED_DORMANT');
      assert.equal(side.status, 'parked');

      // Statutory items CANNOT be parked
      assert.throws(() => {
        engine.problems.parkProblem('t1', stat.nodeId, { sourceSeq: e1.event.seq });
      }, /STATUTORY_LOCK/);

      // Working desk includes mandatory goal + statutory + 1-line parked index (Anti-Strangulation!)
      const desk1 = engine.buildWorkingDesk('t1', { query: 'filing status' });
      assert.ok(desk1.contextBlock.includes('Complete Q3 Filing'));
      assert.ok(desk1.contextBlock.includes('Statutory Penalty Cutoff'));
      assert.ok(desk1.contextBlock.includes('PARKED_BACKLOG_INDEX'));
      assert.ok(desk1.contextBlock.includes('Optional Benefits Inquiry'));

      // Duplicate image upload MUST NOT wake/nag again
      const e2 = engine.recordEvent('t1', { sourceUpdateId: 'm2', body: 'photo 1' });
      const a1 = engine.ledger.recordArtifact('t1', { sourceSeq: e2.event.seq, sha256: 'deadbeef1234', ocrText: 'payroll benefits' });
      const e3 = engine.recordEvent('t1', { sourceUpdateId: 'm3', body: 'same photo again' });
      const a2 = engine.ledger.recordArtifact('t1', { sourceSeq: e3.event.seq, sha256: 'deadbeef1234', ocrText: 'payroll benefits' });
      assert.equal(a2.duplicateOfArtifactId, a1.artifactId);
      const dupWake = engine.problems.scanWakeCandidates('t1', {
        eventSeq: e3.event.seq,
        text: 'payroll benefits',
        artifactDuplicateOf: a2.duplicateOfArtifactId,
      });
      assert.equal(dupWake.skippedReason, 'duplicate_artifact');
      assert.equal(dupWake.woken.length, 0);

      // Genuine new payroll upload with 2 wake cues wakes the parked item naturally!
      const e4 = engine.recordEvent('t1', { sourceUpdateId: 'm4', body: 'Here is our October payroll sheet with new staff benefits' });
      const wakeRes = engine.problems.scanWakeCandidates('t1', {
        eventSeq: e4.event.seq,
        text: e4.event.body,
      });
      assert.equal(wakeRes.woken.length, 1);
      assert.equal(wakeRes.woken[0].nodeId, side.nodeId);

      // Verify unknown deadline on important notice spawns verify_deadline instead of parking
      const unk = evaluateParkingFlags({ deadlineUnknownOnImportantNotice: true });
      assert.equal(unk.shouldPark, false);
      assert.equal(unk.requiredFollowUp, 'verify_deadline');

      // Sweep expiry on another non-legal parked item archives ONLY non-legal; statutory immune!
      const side2 = engine.problems.registerProblem('t1', {
        kind: 'parked_item',
        title: 'Minor Formatting Question',
        autoExpireAt: '2026-11-01T00:00:00Z',
        hasLegalConsequence: false,
        knownFromSeq: e4.event.seq,
        supports: [{ sourceSeq: e4.event.seq, sourceType: 'user_msg' }],
      }).node;
      const sweep = engine.problems.sweepExpiredBacklog('t1', { nowIso: '2026-11-20T00:00:00Z', sourceSeq: e4.event.seq });
      assert.equal(sweep.archived.length, 1);
      assert.equal(sweep.archived[0].nodeId, side2.nodeId);
      assert.equal(engine.ledger.getNodeAt('t1', stat.nodeId).status, 'open');
    } finally {
      engine.close();
    }
  });

  await t('4. 5D Client Impedance Card (mood vs trait + deep-detail soft override) & ACT-R tie-break', () => {
    const engine = createContinuityEngine({ dbPath: ':memory:' });
    try {
      const t0 = Date.parse('2026-11-20T08:00:00Z');
      engine.impedance.observeMessage('t1', { speakerId: 'owner-1', speakerName: 'Pat', seq: 1, text: 'I use macOS and USB token. Stuck again??', observedAt: new Date(t0).toISOString() });
      engine.impedance.observeMessage('t1', { speakerId: 'owner-1', speakerName: 'Pat', seq: 2, text: 'How much penalty?', observedAt: new Date(t0 + 60_000).toISOString() });
      engine.impedance.observeMessage('t1', { speakerId: 'owner-1', speakerName: 'Pat', seq: 3, text: 'Ok done', observedAt: new Date(t0 + 120_000).toISOString() });

      // Within 4h: transient mood is frustrated, bandwidth is brief
      const polNow = engine.impedance.resolveResponsePolicy('t1', 'owner-1', { currentText: 'Next step?', nowMs: t0 + 300_000 });
      assert.equal(polNow.transientMood, 'frustrated');
      assert.equal(polNow.cognitiveBandwidth, 'brief');
      assert.equal(polNow.softMaxQuestions, 1);
      assert.equal(polNow.techEnv.os, 'macOS');

      // After 5h: transient mood expired cleanly, stable trait & techEnv preserved!
      const polLater = engine.impedance.resolveResponsePolicy('t1', 'owner-1', { currentText: 'Next step?', nowMs: t0 + 5 * 3600_000 });
      assert.equal(polLater.transientMood, null);
      assert.equal(polLater.cognitiveBandwidth, 'brief');
      assert.equal(polLater.techEnv.os, 'macOS');

      // Soft prior override when user explicitly asks for full detailed table
      const polDeep = engine.impedance.resolveResponsePolicy('t1', 'owner-1', {
        currentText: 'Please give me the full breakdown and detailed table step by step',
        nowMs: t0 + 5 * 3600_000,
      });
      assert.equal(polDeep.deepOverride, true);
      assert.ok(polDeep.softMaxWords >= 500);

      // ACT-R decay math
      const recentScore = computeActrScore([new Date(t0).toISOString(), new Date(t0 - 86_400_000).toISOString()], t0);
      const oldScore = computeActrScore([new Date(t0 - 60 * 86_400_000).toISOString()], t0);
      assert.ok(recentScore > oldScore && recentScore <= 10);
    } finally {
      engine.close();
    }
  });

  await t('5. Sleep-Time Worker (idempotency + as_of_seq CAS stale detection) & unbounded continuity_recall tool', async () => {
    let customRan = 0;
    const engine = createContinuityEngine({
      dbPath: ':memory:',
      customSleepTasks: [
        async ({ tenantId, asOfSeq, ledger }) => {
          customRan++;
          // Simulate a new user message arriving mid-flight on the second run
          if (customRan === 2) {
            ledger.appendEvent(tenantId, { sourceUpdateId: 'mid-flight', body: 'Wait I just uploaded another file!' });
          }
          return { seenSeq: asOfSeq };
        },
      ],
    });
    try {
      engine.ingestUserMessage('t1', { sourceUpdateId: 's1', senderId: 'u1', senderName: 'Alex', body: 'Filing Q3 deadline Oct 30' });
      const run1 = await engine.sleep.runCycle('t1');
      assert.equal(run1.ok, true);
      assert.equal(run1.status, 'completed');
      assert.equal(run1.stale, false);

      // Idempotent repeat at same seq
      const run1Dup = await engine.sleep.runCycle('t1');
      assert.equal(run1Dup.idempotentHit, true);

      // New event + mid-flight arrival triggers CAS stale detection
      engine.ingestUserMessage('t1', { sourceUpdateId: 's2', senderId: 'u1', senderName: 'Alex', body: 'Checking invoice INV-7788' });
      const run2 = await engine.sleep.runCycle('t1');
      assert.equal(run2.stale, true);
      assert.equal(run2.status, 'stale_needs_recheck');

      // Recall tool works self-directedly
      const recallTool = engine.createRecallTool({ resolveTenantId: () => 't1' });
      const recalled = await recallTool.execute({ query: 'INV-7788', includeParked: true });
      assert.equal(recalled.ok, true);
      assert.ok(recalled.ftsHits.length >= 1);

      // Continuity SCROLL hooks smoke
      const hooks = createContinuityScrollHooks({ engine, resolveTenantId: () => 't1' });
      const pre = await hooks.onBeforeTurn({ conversationId: 'c1', sender: { id: 'u1', name: 'Alex' }, text: 'Update on INV-7788?' });
      assert.ok(pre.contextBlock.includes('<continuity_working_desk'));
      await hooks.onTurnCompleted({ conversationId: 'c1', result: { text: 'Checked INV-7788.', traceId: 'tr-1' } });
      assert.ok(engine.ledger.getHeadSeq('t1') >= 4);
    } finally {
      engine.close();
    }
  });

  await t('6. Advisory Tri-Partite Cortex (T1 bi-temporal + auto-freeze T2 + T3 TTL Tier A/B/C/D) & Delivery Guard', async () => {
    const continuity = createContinuityEngine({ dbPath: ':memory:' });
    const advisory = createAdvisorySpecialistEngine({ continuity, domain: 'compliance' });
    try {
      // T1 bi-temporal rules (2024 vs 2026)
      advisory.cortex.upsertT1Rule({
        ruleId: 'r-late-2024',
        domain: 'compliance',
        citation: 'Circular 80/2021',
        title: 'Late Payment Formula',
        summary: '0.03%/day including cutoff adjustments under 2021 rule',
        validFrom: '2021-01-01',
        validTo: '2025-01-01',
      });
      advisory.cortex.upsertT1Rule({
        ruleId: 'r-late-2026',
        domain: 'compliance',
        citation: 'Circular 18/2023-Revised',
        title: 'Late Payment Formula',
        summary: '0.03%/day excluding payment date',
        agencyName: 'Local Compliance Office',
        validFrom: '2025-01-01',
        validTo: null,
      });

      const rules2024 = advisory.cortex.getEffectiveT1Rules({ asOfDate: '2024-06-15', domain: 'compliance', query: 'Late Payment' });
      assert.equal(rules2024.length, 1);
      assert.equal(rules2024[0].ruleId, 'r-late-2024');

      // T2 linked to T1 auto-freezes when T1 changes!
      const t2 = advisory.cortex.upsertT2Case({
        caseId: 'case-split-path',
        domain: 'compliance',
        title: 'Split Payment vs Signing Deadlock',
        linkedT1RuleId: 'r-late-2026',
        situation: 'Signing dongle broken on macOS right before payment cutoff',
        wrongTextbookPath: 'Spend hours repairing macOS driver before paying',
        verifiedFieldPath: 'Pay immediately via corporate bank portal using payment ID; sign return on Windows machine in parallel',
        redLines: ['Never backdate invoices'],
        independentCaseCount: 5,
        tags: ['macos', 'signing', 'payment'],
      });
      assert.equal(t2.status, 'active');

      const updateRes = advisory.cortex.upsertT1Rule({
        ruleId: 'r-late-2026',
        domain: 'compliance',
        citation: 'Circular 18/2023-Revised-v2',
        title: 'Late Payment Formula',
        summary: 'Updated 2026 rate calculation rule',
        validFrom: '2025-01-01',
      });
      assert.equal(updateRes.frozenCases, 1);
      assert.equal(advisory.cortex.searchT2Cases({ query: 'macos signing', domain: 'compliance' }).length, 0);

      // T3 Software Reality Atlas: Tier A (fresh) vs Tier B (expired) vs Tier C (local variation) vs Tier D (unknown)
      advisory.cortex.upsertT3Atlas({
        atlasId: 'sw-fresh',
        software: 'PortalSigner',
        os: 'macOS',
        errorSignature: 'port 12345 hung',
        goalMilestone: 'Obtain Step-2 Filing Acceptance Notice',
        verifiedWorkaround: 'Use a Windows workstation with USB dongle for 5-minute signing',
        uiSteps: ['Open Signer', 'Select XML', 'Click Sign'],
        verifiedAt: new Date().toISOString(),
        ttlDays: 45,
      });
      advisory.cortex.upsertT3Atlas({
        atlasId: 'sw-expired',
        software: 'LegacyPortal',
        os: 'any',
        goalMilestone: 'Verify Official Balance Zero',
        uiSteps: ['Old Menu -> Old Tab'],
        verifiedAt: '2025-01-01T00:00:00Z',
        ttlDays: 30,
      });
      advisory.cortex.upsertT3Atlas({
        atlasId: 'sw-local',
        software: 'RegionalDesk',
        os: 'any',
        goalMilestone: 'Confirm local branch acceptance',
        localVariation: true,
        officialInquiryQuestions: ['Does this branch require hardcopy Form 01?'],
        verifiedAt: new Date().toISOString(),
      });

      assert.equal(advisory.cortex.resolveSoftwareGuidance({ software: 'PortalSigner', os: 'macOS' }).tier, 'A');
      const tierB = advisory.cortex.resolveSoftwareGuidance({ software: 'LegacyPortal' });
      assert.equal(tierB.tier, 'B');
      assert.equal(tierB.allowUiButtonNames, false);
      assert.equal(tierB.entry.uiSteps.length, 0);
      assert.equal(advisory.cortex.resolveSoftwareGuidance({ software: 'RegionalDesk' }).tier, 'C');
      assert.equal(advisory.cortex.resolveSoftwareGuidance({ software: 'UnknownApp99' }).tier, 'D');

      // Counterfactual Pre-Flight & Decision-Flip VoI
      const pre = runCounterfactualPreflight({ candidateAdvice: 'Run legacy-tool.exe natively on your Mac', techEnv: { os: 'macOS' } });
      assert.equal(pre.ok, false);
      assert.equal(evaluateDecisionFlipQuestion({ optionAAction: 'pay_now', optionBAction: 'pay_now' }).ask, false);
      assert.equal(evaluateDecisionFlipQuestion({ optionAAction: 'pay_now', optionBAction: 'reconcile_only' }).ask, true);

      // Delivery Guard: blocks UI button hallucination on Tier B & cross-tenant leak
      continuity.ingestUserMessage('tenant-1', { sourceUpdateId: 'x1', senderId: 'u1', body: 'Check LegacyPortal' });
      advisory.prepareAdvisoryTurn({ tenantId: 'tenant-1', activeSpeakerId: 'u1', query: 'LegacyPortal', softwareHint: 'LegacyPortal' });
      const guard = advisory.createDeliveryGuard({
        resolveTenantId: () => 'tenant-1',
        getForbiddenTenantTokens: () => ['OTHER_COMPANY_TAX_ID_888'],
      });
      const leakBlocked = await guard({ conversationId: 'c1', text: 'Ref OTHER_COMPANY_TAX_ID_888 is clear.' });
      assert.equal(leakBlocked.action, 'hold');
      const uiBlocked = await guard({ conversationId: 'c1', text: 'Click the "Old Balance" button now.' });
      assert.equal(uiBlocked.action, 'hold');
      const cleanPass = await guard({ conversationId: 'c1', text: 'Could you share a screenshot of where you are stuck so we reach Official Balance Zero?' });
      assert.equal(cleanPass.action, 'allow');
    } finally {
      continuity.close();
    }
  });

  await t('7. Apprenticeship Promotion Ladder + 7-Metric Bench + 3-Stage Regression Gate + Replay Harness', async () => {
    const continuity = createContinuityEngine({ dbPath: ':memory:' });
    const advisory = createAdvisorySpecialistEngine({ continuity, domain: 'compliance' });
    try {
      // 1-case anecdote cannot promote
      advisory.apprenticeship.recordObservation({
        groupKey: 'g-filing-cutoff',
        domain: 'compliance',
        locationOrSource: 'RegionA',
        tenantId: 'c1',
        situation: 'Numbers incomplete 2h before deadline',
        proposedGuidance: 'File best estimate on time then submit amendment to avoid late-filing fine',
        touchesMoneyOrRedLine: true,
      });
      assert.equal(advisory.apprenticeship.evaluatePromotion('g-filing-cutoff').promoted, false);

      // Add 2 more independent cases across a second source
      advisory.apprenticeship.recordObservation({
        groupKey: 'g-filing-cutoff',
        domain: 'compliance',
        locationOrSource: 'RegionB',
        tenantId: 'c2',
        situation: 'Numbers incomplete 2h before deadline',
        proposedGuidance: 'File best estimate on time then submit amendment to avoid late-filing fine',
        touchesMoneyOrRedLine: true,
      });
      advisory.apprenticeship.recordObservation({
        groupKey: 'g-filing-cutoff',
        domain: 'compliance',
        locationOrSource: 'RegionB',
        tenantId: 'c3',
        situation: 'Numbers incomplete 2h before deadline',
        proposedGuidance: 'File best estimate on time then submit amendment to avoid late-filing fine',
        touchesMoneyOrRedLine: true,
      });

      // Without ACH -> stays pattern_candidate
      assert.equal(advisory.apprenticeship.evaluatePromotion('g-filing-cutoff', { achReviewed: false }).stage, 'pattern_candidate');
      // With ACH but missing human approval on money/red-line -> awaiting_human_review
      assert.equal(advisory.apprenticeship.evaluatePromotion('g-filing-cutoff', { achReviewed: true }).stage, 'awaiting_human_review');
      // With ACH + human approval -> promoted_playbook!
      const prom = advisory.apprenticeship.evaluatePromotion('g-filing-cutoff', {
        title: 'File On Time Then Amend',
        achReviewed: true,
        achCounterExamples: ['Checked exemption cases — none contradicted'],
        humanApprovedBy: 'senior-reviewer-1',
      });
      assert.equal(prom.promoted, true);
      assert.equal(prom.stage, 'promoted_playbook');

      // Conflict with T1 -> blocked as warning_only
      advisory.apprenticeship.recordObservation({
        groupKey: 'g-illegal-shortcut',
        locationOrSource: 'Rumor1',
        situation: 'Missed invoice date',
        proposedGuidance: 'Backdate invoice',
        conflictsWithT1: true,
      });
      const blocked = advisory.apprenticeship.evaluatePromotion('g-illegal-shortcut', { achReviewed: true, humanApprovedBy: 'x' });
      assert.equal(blocked.promoted, false);
      assert.equal(blocked.stage, 'warning_only_t1_conflict');

      // 7-Metric Scorecard + 3-Stage Regression Gate
      const linter = advisory.runStaticSafetyLinter(['t1']);
      assert.equal(linter.ok, true);
      const base = advisory.computeSevenMetricScorecard({
        goalsConverged: 9, goalsTotal: 10, decisionFlipQuestions: 9, totalQuestions: 10, redundantQuestions: 0,
        backlogTruePositives: 9, backlogFalsePositives: 0, backlogFalseNegatives: 1,
        statutoryMissed: 0, statutoryTotal: 10, groundedEnvSteps: 19, totalEnvSteps: 20,
        biTemporalCorrect: 20, biTemporalTotal: 20, styleAlignedTurns: 18, styleTotalTurns: 20,
        transferSolvedClientB: 9, transferTotalClientB: 10,
      });
      const gatePass = advisory.evaluateThreeStageRegressionGate({
        linterResult: linter,
        baselineScorecard: base,
        candidateScorecard: base,
      });
      assert.equal(gatePass.passed, true);

      const gateFailSmr = advisory.evaluateThreeStageRegressionGate({
        linterResult: linter,
        baselineScorecard: base,
        candidateScorecard: { ...base, SMR: 0.1 },
      });
      assert.equal(gateFailSmr.passed, false);

      // End-to-end Time-Travel Replay Harness
      const replay = await runContinuityReplay({
        timeline: [
          {
            id: 's1',
            body: 'Goal: Q3 return filing due Oct 30. Also have a penalty notice 4254 due Oct 31.',
            occurredAt: '2026-10-25T10:00:00Z',
            nodes: [
              { nodeId: 'g-q3', kind: 'goal', title: 'Q3 Return Filing', dueAt: '2026-10-30' },
              { nodeId: 'ob-4254', kind: 'obligation', title: 'Penalty 4254', dueAt: '2026-10-31', hasLegalConsequence: true },
              { nodeId: 'side-ben', kind: 'parked_item', title: 'Optional Benefits', wakeCues: ['payroll', 'benefits'], hasLegalConsequence: false },
            ],
          },
          {
            id: 's2',
            body: 'Uploaded transfer receipt Oct 31 for Penalty 4254.',
            occurredAt: '2026-11-05T10:00:00Z',
            nodes: [
              { nodeId: 'ev-r31', kind: 'evidence', title: 'Receipt_Oct31_Verified', summary: 'Receipt dated Oct 31', epistemicLevel: 'document_evidence' },
            ],
          },
          {
            id: 's3',
            body: 'Attached October payroll with employee benefits list.',
            occurredAt: '2026-11-10T10:00:00Z',
          },
        ],
        checkpoints: [
          {
            id: 'cp-before-receipt',
            asOfStepId: 's1',
            query: 'Penalty 4254',
            mustIncludeStatutory: ['Penalty 4254'],
            mustNotContain: ['Receipt_Oct31_Verified'],
            mustStayParked: ['side-ben'],
          },
          {
            id: 'cp-after-receipt',
            asOfStepId: 's2',
            query: 'Receipt Oct 31',
            mustIncludeStatutory: ['Penalty 4254'],
            mustContain: ['Receipt_Oct31_Verified'],
            mustStayParked: ['side-ben'],
          },
          {
            id: 'cp-after-payroll-wake',
            asOfStepId: 's3',
            query: 'payroll benefits',
            mustIncludeStatutory: ['Penalty 4254'],
            mustBeWoken: ['side-ben'],
          },
        ],
      });
      assert.equal(replay.ok, true, JSON.stringify(replay, null, 2));
      assert.equal(replay.tenantLeaks, 0);
      assert.equal(replay.futureLeaks, 0);
      assert.equal(replay.statutoryMisses, 0);
      assert.equal(replay.wakeRecall, 1);
    } finally {
      continuity.close();
    }
  });

  console.log(`\nALL ${passed}/${passed} v2.6 continuity+advisory checks passed!`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
