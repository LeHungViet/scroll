// Time-Travel Replay Eval Harness for @agentpro/scroll-continuity.
// Replays a labeled timeline of events, checks bi-temporal knowledge isolation (0 future leakage),
// tenant isolation (0 cross-tenant leakage), crash/restart durability, wake precision/recall,
// and statutory consequence lock (SMR = 0.0%).
import { createContinuityEngine } from './index.js';

export async function runContinuityReplay({
  tenantId = 'replay-tenant',
  otherTenantId = 'other-tenant',
  timeline = [],
  checkpoints = [],
  decideNextStep = null,
  dbPath = ':memory:',
} = {}) {
  const engine = createContinuityEngine({ dbPath });
  const seqByStepId = new Map();
  let duplicateEventsIgnored = 0;

  try {
    // Seed a decoy tenant to continuously prove 0 cross-tenant leakage
    const decoyEv = engine.recordEvent(otherTenantId, {
      sourceUpdateId: 'decoy-1',
      chatId: 'decoy-chat',
      senderId: 'decoy-u',
      senderName: 'Decoy',
      body: 'CONFIDENTIAL_DECOY_TENANT_SECRET_999999',
    });
    engine.problems.registerProblem(otherTenantId, {
      kind: 'obligation',
      businessKey: 'DECOY-999999',
      title: 'Decoy Obligation SECRET_999999',
      summary: 'Must never leak to primary tenant',
      hasLegalConsequence: true,
      dueAt: '2026-12-31',
      knownFromSeq: decoyEv.event.seq,
      supports: [{ sourceSeq: decoyEv.event.seq, sourceType: 'user_msg', excerptRef: 'decoy' }],
    });

    for (const step of timeline) {
      const rec = engine.recordEvent(tenantId, {
        channel: step.channel || 'chat',
        sourceUpdateId: step.sourceUpdateId || step.id,
        chatId: step.chatId || 'room-1',
        senderId: step.senderId || 'u-1',
        senderName: step.senderName || 'User',
        senderRole: step.senderRole || 'operator',
        replyToId: step.replyToId || null,
        eventType: step.eventType || 'user_msg',
        occurredAt: step.occurredAt,
        receivedAt: step.receivedAt || step.occurredAt,
        body: step.body || '',
        payload: step.payload || {},
      });
      if (rec.duplicate) {
        duplicateEventsIgnored++;
        if (step.id) seqByStepId.set(step.id, rec.event.seq);
        continue;
      }
      const seq = rec.event.seq;
      if (step.id) seqByStepId.set(step.id, seq);

      let duplicateOfArtifactId = null;
      if (step.artifact) {
        const art = engine.ledger.recordArtifact(tenantId, {
          sourceSeq: seq,
          sha256: step.artifact.sha256,
          blobPath: step.artifact.blobPath || null,
          mime: step.artifact.mime || 'image/jpeg',
          ocrText: step.artifact.ocrText || '',
        });
        duplicateOfArtifactId = art.duplicateOfArtifactId;
      }

      if (step.speakerObserve !== false && step.senderId && step.eventType !== 'bot_reply') {
        engine.impedance.observeMessage(tenantId, {
          speakerId: step.senderId,
          speakerName: step.senderName || '',
          senderRole: step.senderRole || null,
          seq,
          text: step.body || '',
          hasAttachment: Boolean(step.artifact),
          observedAt: step.occurredAt,
          explicitRoleArchetype: step.explicitRoleArchetype || null,
          explicitTechEnv: step.explicitTechEnv || null,
        });
      }

      if (Array.isArray(step.nodes)) {
        for (const n of step.nodes) {
          engine.problems.registerProblem(tenantId, {
            ...n,
            knownFromSeq: seq,
            supports: n.supports || [{ sourceSeq: seq, sourceType: step.sourceType || 'user_msg', excerptRef: step.id || `seq:${seq}` }],
          });
        }
      }

      if (Array.isArray(step.edges)) {
        for (const e of step.edges) {
          engine.ledger.addEdge(tenantId, {
            ...e,
            knownFromSeq: seq,
            supports: e.supports || [{ sourceSeq: seq, sourceType: step.sourceType || 'user_msg', excerptRef: step.id || `seq:${seq}` }],
          });
        }
      }

      if (step.scanWake !== false && step.eventType !== 'bot_reply') {
        engine.problems.scanWakeCandidates(tenantId, {
          eventSeq: seq,
          text: `${step.body || ''} ${step.artifact?.ocrText || ''}`,
          extractedKeys: step.extractedKeys || [],
          artifactDuplicateOf: duplicateOfArtifactId,
          explicitUserAsk: Boolean(step.explicitUserAsk),
        });
      }

      if (step.sweepAt) {
        engine.problems.sweepExpiredBacklog(tenantId, { nowIso: step.sweepAt, sourceSeq: seq });
      }
    }

    // Evaluate all checkpoints (including historical time-travel checkpoints!)
    let tenantLeaks = 0;
    let futureLeaks = 0;
    let statutoryMisses = 0;
    let decisionsCorrect = 0;
    let wakeExpected = 0;
    let wakeRecalled = 0;
    let wakeFalsePositives = 0;
    const checkpointResults = [];

    for (const cp of checkpoints) {
      const targetSeq = cp.asOfStepId ? seqByStepId.get(cp.asOfStepId) : Number(cp.asOfSeq);
      const desk = engine.buildWorkingDesk(tenantId, {
        query: cp.query || '',
        chatId: cp.chatId || 'room-1',
        activeSpeakerId: cp.activeSpeakerId || null,
        asOfSeq: targetSeq,
        validAt: cp.validAt || null,
      });

      const hasTenantLeak = desk.contextBlock.includes('SECRET_999999') || desk.selectedNodes.some((n) => n.tenantId !== tenantId);
      if (hasTenantLeak) tenantLeaks++;

      let hasFutureLeak = false;
      for (const n of desk.selectedNodes) {
        if (n.knownFromSeq > targetSeq) hasFutureLeak = true;
      }
      if (Array.isArray(cp.mustNotContain)) {
        for (const forbidden of cp.mustNotContain) {
          if (desk.contextBlock.includes(forbidden)) hasFutureLeak = true;
        }
      }
      if (hasFutureLeak) futureLeaks++;

      const statutoryTitles = new Set(desk.statutory.map((s) => s.title));
      let missedStatutory = false;
      if (Array.isArray(cp.mustIncludeStatutory)) {
        for (const reqTitle of cp.mustIncludeStatutory) {
          if (!statutoryTitles.has(reqTitle)) {
            missedStatutory = true;
            statutoryMisses++;
          }
        }
      }

      // Check wake accuracy if labeled
      const activeIds = new Set(desk.selectedNodes.map((n) => n.nodeId));
      const parkedIds = new Set(desk.parkedIndex.map((p) => p.nodeId));
      if (Array.isArray(cp.mustBeWoken)) {
        for (const nid of cp.mustBeWoken) {
          wakeExpected++;
          if (activeIds.has(nid)) wakeRecalled++;
        }
      }
      if (Array.isArray(cp.mustStayParked)) {
        for (const nid of cp.mustStayParked) {
          if (!parkedIds.has(nid) && activeIds.has(nid)) wakeFalsePositives++;
        }
      }

      let decisionOk = true;
      let predictedAction = null;
      if (typeof decideNextStep === 'function' && cp.expectedAction) {
        predictedAction = await decideNextStep({ desk, checkpoint: cp, engine, asOfSeq: targetSeq });
        decisionOk = predictedAction === cp.expectedAction;
      } else if (Array.isArray(cp.mustContain)) {
        decisionOk = cp.mustContain.every((s) => desk.contextBlock.includes(s));
      }
      if (decisionOk && !hasTenantLeak && !hasFutureLeak && !missedStatutory) decisionsCorrect++;

      checkpointResults.push({
        id: cp.id,
        asOfSeq: targetSeq,
        ok: decisionOk && !hasTenantLeak && !hasFutureLeak && !missedStatutory,
        hasTenantLeak,
        hasFutureLeak,
        missedStatutory,
        predictedAction,
        expectedAction: cp.expectedAction || null,
      });
    }

    const total = Math.max(1, checkpoints.length);
    const wakePrecision = (wakeRecalled + wakeFalsePositives) > 0
      ? wakeRecalled / (wakeRecalled + wakeFalsePositives)
      : 1;
    const wakeRecall = wakeExpected > 0 ? wakeRecalled / wakeExpected : 1;

    return {
      ok: tenantLeaks === 0 && futureLeaks === 0 && statutoryMisses === 0 && decisionsCorrect === checkpoints.length,
      totalCheckpoints: checkpoints.length,
      decisionsCorrect,
      decisionAccuracy: Number((decisionsCorrect / total).toFixed(4)),
      tenantLeaks,
      futureLeaks,
      statutoryMisses,
      statutoryMissRate: Number((statutoryMisses / total).toFixed(4)),
      wakePrecision: Number(wakePrecision.toFixed(4)),
      wakeRecall: Number(wakeRecall.toFixed(4)),
      duplicateEventsIgnored,
      checkpointResults,
    };
  } finally {
    engine.close();
  }
}
