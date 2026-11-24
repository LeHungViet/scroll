// POMR Problem Register & Pragmatic Backlog Parking Engine for @agentpro/scroll-continuity.
// Combines Aviation CRM (`STATUTORY_PENALTY` -> `APEX_GOAL` -> `CRITICAL_ACTIVE` -> `PARKED_DORMANT`),
// the human-readable 3-flag Parking Rule (`B` blocks goal, `D` deadline/consequence, `U` user asking now),
// Event-Based Prospective Memory (`wake_cues` + 2-tier Auto-Reconnect `may_match` -> `ready`),
// and the HARD LOCK `SMR = 0.0%`: items with legal/penalty consequences can NEVER silently expire.

function normalizeToken(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evaluateParkingFlags({
  blocksActiveGoal = false,
  hasVerifiedDeadline = false,
  hasLegalConsequence = false,
  deadlineUnknownOnImportantNotice = false,
  userAskingNow = false,
  isApexGoal = false,
  hasActionableNextStep = true,
} = {}) {
  const B = Boolean(blocksActiveGoal || isApexGoal);
  const D = Boolean(hasVerifiedDeadline || hasLegalConsequence);
  const U = Boolean(userAskingNow);

  if (deadlineUnknownOnImportantNotice && !D) {
    return {
      B,
      D: true,
      U,
      recommendedTier: 'CRITICAL_ACTIVE',
      recommendedStatus: 'open',
      shouldPark: false,
      requiredFollowUp: 'verify_deadline',
      reason: 'Important notice has unknown deadline; must verify deadline before parking.',
    };
  }

  if (isApexGoal) {
    return {
      B: true,
      D,
      U,
      recommendedTier: 'APEX_GOAL',
      recommendedStatus: 'active',
      shouldPark: false,
      requiredFollowUp: null,
      reason: 'North-star apex goal stays anchored.',
    };
  }

  if (D && hasLegalConsequence) {
    return {
      B,
      D: true,
      U,
      recommendedTier: 'STATUTORY_PENALTY',
      recommendedStatus: hasActionableNextStep ? 'open' : 'waiting',
      shouldPark: false,
      requiredFollowUp: null,
      reason: 'Statutory/penalty consequence locked active (SMR=0%).',
    };
  }

  if (B || D || U) {
    return {
      B,
      D,
      U,
      recommendedTier: 'CRITICAL_ACTIVE',
      recommendedStatus: hasActionableNextStep ? 'open' : 'waiting',
      shouldPark: false,
      requiredFollowUp: null,
      reason: `Active due to flags (${[B && 'B', D && 'D', U && 'U'].filter(Boolean).join('+')}).`,
    };
  }

  return {
    B: false,
    D: false,
    U: false,
    recommendedTier: 'PARKED_DORMANT',
    recommendedStatus: 'parked',
    shouldPark: true,
    requiredFollowUp: null,
    reason: 'All flags B=0, D=0, U=0; parked silently until wake_cues or user revisit.',
  };
}

export function createProblemRegister({ ledger, now = () => new Date().toISOString() } = {}) {
  if (!ledger) throw new Error('createProblemRegister requires ledger');

  function getActiveGoalIds(tenantId, { asOfSeq = null } = {}) {
    const goals = ledger.listNodes(tenantId, {
      asOfSeq,
      kinds: ['goal'],
      excludeStatuses: ['achieved', 'superseded', 'resolved', 'silent_archived'],
    });
    return new Set(goals.map((g) => g.nodeId));
  }

  function blocksAnyActiveGoal(tenantId, nodeId, { asOfSeq = null } = {}) {
    const goalIds = getActiveGoalIds(tenantId, { asOfSeq });
    if (!goalIds.size) return false;
    const edges = ledger.listEdges(tenantId, { asOfSeq, edgeTypes: ['blocks'], statuses: ['active'] });
    return edges.some((e) => e.srcNodeId === nodeId && goalIds.has(e.dstNodeId));
  }

  function registerProblem(tenantId, item = {}) {
    const asOfSeq = item.knownFromSeq ?? ledger.getHeadSeq(tenantId);
    const dynamicBlocks = item.nodeId ? blocksAnyActiveGoal(tenantId, item.nodeId, { asOfSeq }) : false;
    const evalRes = evaluateParkingFlags({
      blocksActiveGoal: Boolean(item.blocksActiveGoal || dynamicBlocks),
      hasVerifiedDeadline: Boolean(item.dueAt),
      hasLegalConsequence: Boolean(item.hasLegalConsequence || item.priorityTier === 'STATUTORY_PENALTY'),
      deadlineUnknownOnImportantNotice: Boolean(item.deadlineUnknownOnImportantNotice),
      userAskingNow: Boolean(item.userAskingNow),
      isApexGoal: item.kind === 'goal' || item.priorityTier === 'APEX_GOAL',
      hasActionableNextStep: item.hasActionableNextStep !== false,
    });

    const tier = item.forceTier || evalRes.recommendedTier;
    const status = item.status || evalRes.recommendedStatus;
    const hasLegal = Boolean(item.hasLegalConsequence || tier === 'STATUTORY_PENALTY');
    const autoExpireAt = hasLegal ? null : (item.autoExpireAt ?? null);

    const saved = ledger.upsertNodeRevision(tenantId, {
      nodeId: item.nodeId,
      kind: item.kind || (tier === 'PARKED_DORMANT' ? 'parked_item' : 'workstream'),
      businessKey: item.businessKey || null,
      priorityTier: tier,
      title: item.title,
      summary: item.summary || '',
      payload: {
        ...(item.payload || {}),
        parkingFlags: { B: evalRes.B, D: evalRes.D, U: evalRes.U },
        requiredFollowUp: evalRes.requiredFollowUp,
        parkReason: evalRes.shouldPark ? (item.parkReason || evalRes.reason) : null,
      },
      status,
      epistemicLevel: item.epistemicLevel || 'user_claim',
      validFrom: item.validFrom ?? null,
      validTo: item.validTo ?? null,
      knownFromSeq: asOfSeq,
      dueAt: item.dueAt ?? null,
      hasLegalConsequence: hasLegal,
      reopenCondition: item.reopenCondition ?? null,
      wakeCues: item.wakeCues || [],
      autoExpireAt,
      ownerId: item.ownerId ?? null,
      supports: item.supports,
      independentConfirm: item.independentConfirm !== false,
    });

    if (item.blocksGoalNodeId && saved.nodeId !== item.blocksGoalNodeId) {
      ledger.addEdge(tenantId, {
        srcNodeId: saved.nodeId,
        dstNodeId: item.blocksGoalNodeId,
        edgeType: 'blocks',
        status: 'active',
        reason: item.blockReason || 'blocks active apex goal',
        knownFromSeq: asOfSeq,
        supports: item.supports,
      });
    }

    return { node: saved, evaluation: evalRes };
  }

  function parkProblem(tenantId, nodeId, {
    sourceSeq,
    sourceType = 'system_rule',
    parkReason = 'B=0, D=0, U=0',
    reopenCondition = null,
    wakeCues = [],
    autoExpireAt = null,
  } = {}) {
    const existing = ledger.getNodeAt(tenantId, nodeId);
    if (!existing) throw new Error(`Cannot park unknown node ${nodeId}`);
    if (existing.hasLegalConsequence || existing.priorityTier === 'STATUTORY_PENALTY') {
      const err = new Error('STATUTORY_LOCK: Cannot silently park an item with legal or penalty consequences');
      err.code = 'STATUTORY_LOCK';
      throw err;
    }
    if (blocksAnyActiveGoal(tenantId, nodeId)) {
      const err = new Error('GOAL_BLOCKER_LOCK: Cannot park an item that blocks an active apex goal');
      err.code = 'GOAL_BLOCKER_LOCK';
      throw err;
    }
    return ledger.upsertNodeRevision(tenantId, {
      nodeId,
      kind: existing.kind,
      businessKey: existing.businessKey,
      priorityTier: 'PARKED_DORMANT',
      title: existing.title,
      summary: existing.summary,
      payload: { ...(existing.payload || {}), parkReason },
      status: 'parked',
      epistemicLevel: existing.epistemicLevel,
      validFrom: existing.validFrom,
      validTo: existing.validTo,
      knownFromSeq: sourceSeq || ledger.getHeadSeq(tenantId),
      dueAt: existing.dueAt,
      hasLegalConsequence: false,
      reopenCondition: reopenCondition ?? existing.reopenCondition,
      wakeCues: wakeCues.length ? wakeCues : existing.wakeCues,
      autoExpireAt: autoExpireAt ?? existing.autoExpireAt,
      ownerId: existing.ownerId,
      supports: [{ sourceSeq: sourceSeq || ledger.getHeadSeq(tenantId), sourceType, excerptRef: parkReason }],
      independentConfirm: false,
    });
  }

  // Two-tier Prospective-Memory Auto-Reconnect:
  //   - Strong match (businessKey / exact ref match OR >=2 distinct wakeCues OR explicit user ask) -> candidate/ready
  //   - Duplicate artifact sha256 -> ignored so we NEVER nag twice for the same uploaded photo/file!
  function scanWakeCandidates(tenantId, {
    eventSeq,
    text = '',
    extractedKeys = [],
    artifactDuplicateOf = null,
    explicitUserAsk = false,
    evidenceNodeId = null,
  } = {}) {
    if (artifactDuplicateOf) {
      return { matched: [], woken: [], skippedReason: 'duplicate_artifact' };
    }
    const normText = normalizeToken(text);
    const normKeys = new Set((extractedKeys || []).map(normalizeToken).filter(Boolean));
    const parkedNodes = ledger.listNodes(tenantId, {
      asOfSeq: eventSeq,
      tiers: ['PARKED_DORMANT'],
      statuses: ['parked', 'candidate'],
    });

    const matched = [];
    const woken = [];
    for (const node of parkedNodes) {
      // Never immediately self-wake an item on the exact same event that parked it!
      if (node.knownFromSeq >= eventSeq) continue;
      const bkey = normalizeToken(node.businessKey || '');
      const strongKeyHit = Boolean(bkey && (normKeys.has(bkey) || (bkey.length >= 4 && normText.includes(bkey))));

      const cueHits = [];
      for (const cue of node.wakeCues || []) {
        const nc = normalizeToken(cue);
        if (nc.length >= 2 && normText.includes(nc)) {
          cueHits.push(cue);
        }
      }

      const strongCueMatch = strongKeyHit || cueHits.length >= 2 || (explicitUserAsk && cueHits.length >= 1);
      const weakCueMatch = !strongCueMatch && cueHits.length === 1;
      if (!strongCueMatch && !weakCueMatch) continue;

      const nextStatus = strongCueMatch ? 'ready' : 'candidate';
      const nextTier = strongCueMatch ? 'CRITICAL_ACTIVE' : 'PARKED_DORMANT';
      const reason = strongKeyHit
        ? `strong_key:${node.businessKey}`
        : `wake_cues:[${cueHits.join(',')}]`;

      const updated = ledger.upsertNodeRevision(tenantId, {
        nodeId: node.nodeId,
        kind: node.kind,
        businessKey: node.businessKey,
        priorityTier: nextTier,
        title: node.title,
        summary: node.summary,
        payload: {
          ...(node.payload || {}),
          lastWakeReason: reason,
          lastWakeSeq: eventSeq,
          wakeCueHits: cueHits,
        },
        status: nextStatus,
        epistemicLevel: node.epistemicLevel,
        validFrom: node.validFrom,
        validTo: node.validTo,
        knownFromSeq: eventSeq,
        dueAt: node.dueAt,
        hasLegalConsequence: node.hasLegalConsequence,
        reopenCondition: node.reopenCondition,
        wakeCues: node.wakeCues,
        autoExpireAt: node.autoExpireAt,
        ownerId: node.ownerId,
        supports: [{ sourceSeq: eventSeq, sourceType: 'user_msg', excerptRef: reason }],
        independentConfirm: true,
      });

      if (evidenceNodeId && evidenceNodeId !== node.nodeId) {
        try {
          ledger.addEdge(tenantId, {
            srcNodeId: evidenceNodeId,
            dstNodeId: node.nodeId,
            edgeType: 'may_match',
            status: strongCueMatch ? 'active' : 'candidate',
            reason,
            knownFromSeq: eventSeq,
            supports: [{ sourceSeq: eventSeq, sourceType: 'system_rule', excerptRef: reason }],
          });
        } catch { /* ignore if evidence node not registered */ }
      }

      const entry = { nodeId: node.nodeId, title: node.title, nextStatus, nextTier, reason, cueHits, strongKeyHit };
      matched.push(entry);
      if (nextStatus === 'ready') woken.push({ ...entry, node: updated });
    }

    return { matched, woken };
  }

  // Silent expiry sweep: ONLY archives non-legal parked items past `auto_expire_at`.
  // Statutory/legal consequence items are structurally immune (SMR = 0.0%).
  function sweepExpiredBacklog(tenantId, { nowIso = null, sourceSeq = null } = {}) {
    const cutoff = String(nowIso || now());
    const seq = sourceSeq || ledger.getHeadSeq(tenantId);
    if (!seq) return { archived: [], protectedStatutory: 0 };

    const parked = ledger.listNodes(tenantId, {
      asOfSeq: seq,
      tiers: ['PARKED_DORMANT'],
      statuses: ['parked'],
    });

    const archived = [];
    let protectedStatutory = 0;
    for (const node of parked) {
      if (node.hasLegalConsequence || node.priorityTier === 'STATUTORY_PENALTY') {
        protectedStatutory++;
        continue;
      }
      if (node.autoExpireAt && String(node.autoExpireAt) <= cutoff) {
        ledger.upsertNodeRevision(tenantId, {
          nodeId: node.nodeId,
          kind: node.kind,
          businessKey: node.businessKey,
          priorityTier: 'PARKED_DORMANT',
          title: node.title,
          summary: node.summary,
          payload: { ...(node.payload || {}), archivedReason: 'ttl_expired_non_legal' },
          status: 'silent_archived',
          epistemicLevel: node.epistemicLevel,
          validFrom: node.validFrom,
          validTo: node.validTo,
          knownFromSeq: seq,
          dueAt: node.dueAt,
          hasLegalConsequence: false,
          reopenCondition: node.reopenCondition,
          wakeCues: node.wakeCues,
          autoExpireAt: node.autoExpireAt,
          ownerId: node.ownerId,
          supports: [{ sourceSeq: seq, sourceType: 'system_rule', excerptRef: 'ttl_expired_non_legal' }],
          independentConfirm: false,
        });
        archived.push({ nodeId: node.nodeId, title: node.title });
      }
    }
    return { archived, protectedStatutory };
  }

  function listRegister(tenantId, { asOfSeq = null, validAt = null } = {}) {
    const all = ledger.listNodes(tenantId, {
      asOfSeq,
      validAt,
      excludeStatuses: ['resolved', 'achieved', 'superseded', 'silent_archived'],
    });
    const statutory = all.filter((n) => n.priorityTier === 'STATUTORY_PENALTY' || n.hasLegalConsequence);
    const goals = all.filter((n) => n.priorityTier === 'APEX_GOAL' || n.kind === 'goal');
    const active = all.filter((n) =>
      n.priorityTier === 'CRITICAL_ACTIVE'
      && !statutory.some((s) => s.nodeId === n.nodeId)
      && !goals.some((g) => g.nodeId === n.nodeId)
    );
    const parked = all.filter((n) => n.priorityTier === 'PARKED_DORMANT');
    return { statutory, goals, active, parked };
  }

  return {
    evaluateParkingFlags,
    registerProblem,
    parkProblem,
    scanWakeCandidates,
    sweepExpiredBacklog,
    listRegister,
  };
}
