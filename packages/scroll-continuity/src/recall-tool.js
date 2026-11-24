// Enabling Context Working Desk + Unbounded `continuity_recall` Tool for @agentpro/scroll-continuity.
// Anti-Strangulation Design:
//   - Pre-loads a fast, structured working desk (mandatory B-tree goals/statutory/blockers + 1-2 typed hops + ACT-R tie-break).
//   - ALWAYS includes a compact 1-line index of parked items so the model never suffers tunnel vision.
//   - Exposes an unbounded `continuity_recall` tool so the model can self-direct deep lookups at any time.
import { computeActrScore } from './ledger-store.js';

export function buildWorkingDesk({
  ledger,
  problemRegister,
  impedance,
  tenantId,
  query = '',
  chatId = null,
  activeSpeakerId = null,
  asOfSeq = null,
  validAt = null,
  maxNodes = 12,
  maxQuotes = 6,
  nowMs = Date.now(),
} = {}) {
  const headSeq = asOfSeq != null ? Number(asOfSeq) : ledger.getHeadSeq(tenantId);
  const reg = problemRegister.listRegister(tenantId, { asOfSeq: headSeq, validAt });

  // 1. Mandatory B-tree layer: NEVER dropped by ACT-R decay!
  const mandatoryMap = new Map();
  for (const n of [...reg.statutory, ...reg.goals]) {
    mandatoryMap.set(n.nodeId, { ...n, selectionSource: 'mandatory_btree', score: 100 });
  }

  // Pull active blockers & contradictions attached to mandatory nodes
  const seedIds = [...mandatoryMap.keys()];
  const activeEdges = ledger.listEdges(tenantId, {
    asOfSeq: headSeq,
    validAt,
    edgeTypes: ['blocks', 'contradicts', 'may_match'],
    statuses: ['active', 'candidate'],
  });
  for (const e of activeEdges) {
    if (e.edgeType === 'blocks' || e.edgeType === 'contradicts') {
      seedIds.push(e.srcNodeId, e.dstNodeId);
    }
  }

  // 2. Normalized ID / FTS5 candidates + 1-2 typed hops
  const ftsHits = query ? ledger.searchFts(tenantId, query, { asOfSeq: headSeq, limit: 10 }) : [];
  for (const hit of ftsHits) {
    if (hit.docKind === 'node') seedIds.push(hit.docId);
  }
  const neighborhood = seedIds.length
    ? ledger.getNeighborhood(tenantId, seedIds, { hops: 2, asOfSeq: headSeq, validAt })
    : { nodes: [], edges: [] };

  // 3. Rank remaining candidates with ACT-R tie-breaker (independent confirmations ONLY)
  const selected = new Map(mandatoryMap);
  const optionalCandidates = [];
  for (const n of [...reg.active, ...neighborhood.nodes]) {
    if (selected.has(n.nodeId)) continue;
    if (n.priorityTier === 'PARKED_DORMANT' && n.status === 'parked') continue;
    if (['resolved', 'achieved', 'superseded', 'silent_archived'].includes(n.status)) continue;
    const ftsBonus = ftsHits.some((h) => h.docKind === 'node' && h.docId === n.nodeId) ? 5 : 0;
    const hopBonus = n.hopDistance === 1 ? 3 : (n.hopDistance === 2 ? 1.5 : 0);
    const actr = computeActrScore(n.confirmTimestamps, nowMs);
    optionalCandidates.push({
      ...n,
      selectionSource: ftsBonus ? 'fts_and_hop' : 'graph_hop',
      score: Number((ftsBonus + hopBonus + actr).toFixed(4)),
    });
  }
  optionalCandidates.sort((a, b) => b.score - a.score);
  for (const c of optionalCandidates) {
    if (selected.size >= maxNodes) break;
    selected.set(c.nodeId, c);
  }

  const selectedNodes = [...selected.values()];

  // 4. Verified quotes / evidence excerpts from support provenance & FTS event hits (capped at maxQuotes)
  const quoteSeqs = new Set();
  for (const n of selectedNodes) {
    for (const s of n.supports || []) {
      if (s.sourceSeq) quoteSeqs.add(s.sourceSeq);
    }
  }
  for (const h of ftsHits) {
    if (h.docKind === 'event' && h.sourceSeq) quoteSeqs.add(h.sourceSeq);
  }
  const allRecent = ledger.getRecentEvents(tenantId, { chatId, asOfSeq: headSeq, limit: 20 });
  const quotes = [];
  for (const ev of allRecent) {
    if (quotes.length >= maxQuotes) break;
    if (quoteSeqs.has(ev.seq) || ev.eventType === 'document' || ev.eventType === 'tool_result') {
      quotes.push({
        seq: ev.seq,
        speaker: ev.senderName || ev.senderId || 'unknown',
        eventType: ev.eventType,
        occurredAt: ev.occurredAt,
        text: ev.body.slice(0, 220),
      });
    }
  }

  // 5. Anti-Strangulation 1-line parked index (visible if model spots an unexpected link, non-intrusive by default)
  const parkedIndex = reg.parked.map((p) => ({
    nodeId: p.nodeId,
    title: p.title,
    status: p.status,
    reopenCondition: p.reopenCondition,
    wakeCues: p.wakeCues,
  }));

  // 6. Peer / Client Style Impedance summary (Soft prior)
  const styleSummary = impedance
    ? impedance.renderRoomStyleSummary(tenantId, { activeSpeakerId, currentText: query, nowMs })
    : '';
  const activePolicy = (impedance && activeSpeakerId)
    ? impedance.resolveResponsePolicy(tenantId, activeSpeakerId, { currentText: query, nowMs })
    : null;

  // Render clean XML-tagged working desk for prompt injection
  const lines = [`<continuity_working_desk tenant="${tenantId}" as_of_seq="${headSeq}">`];
  if (reg.goals.length) {
    lines.push('[NORTH_STAR_GOALS]');
    for (const g of reg.goals.slice(0, 3)) {
      lines.push(`- (${g.status}${g.dueAt ? ` · due ${g.dueAt}` : ''}) ${g.title}${g.summary ? `: ${g.summary}` : ''}`);
    }
  }
  if (reg.statutory.length) {
    lines.push('[MANDATORY_DEADLINES_AND_CONSEQUENCES]');
    for (const s of reg.statutory.slice(0, 4)) {
      lines.push(`- [${s.epistemicLevel}] (${s.status}${s.dueAt ? ` · due ${s.dueAt}` : ''}) ${s.title}${s.summary ? `: ${s.summary}` : ''}`);
    }
  }
  const activeOthers = selectedNodes.filter((n) =>
    !reg.goals.some((g) => g.nodeId === n.nodeId)
    && !reg.statutory.some((s) => s.nodeId === n.nodeId)
  );
  if (activeOthers.length) {
    lines.push('[ACTIVE_WORKSTREAMS_EVIDENCE_AND_CONSTRAINTS]');
    for (const n of activeOthers) {
      lines.push(`- [${n.kind}/${n.epistemicLevel}] (${n.status}) ${n.title}${n.summary ? `: ${n.summary}` : ''}`);
    }
  }
  if (neighborhood.edges.length) {
    const keyEdges = neighborhood.edges.filter((e) => ['blocks', 'contradicts', 'may_match', 'settles'].includes(e.edgeType)).slice(0, 8);
    if (keyEdges.length) {
      lines.push('[DECISION_LINKS]');
      for (const e of keyEdges) {
        lines.push(`- ${e.srcNodeId} --${e.edgeType}(${e.status})--> ${e.dstNodeId}${e.reason ? ` (${e.reason})` : ''}`);
      }
    }
  }
  if (parkedIndex.length) {
    lines.push(`[PARKED_BACKLOG_INDEX (silent unless newly linked or asked — use continuity_recall for details): ${parkedIndex.map((p) => p.title).join(' | ')}]`);
  }
  if (styleSummary) {
    lines.push('[PEER_STYLE_SOFT_PRIOR]');
    lines.push(styleSummary);
  }
  if (quotes.length) {
    lines.push('[PROVENANCE_EXCERPTS]');
    for (const q of quotes) {
      lines.push(`- #seq${q.seq} (${q.speaker}): ${q.text}`);
    }
  }
  lines.push('</continuity_working_desk>');

  const verifiedGroundingLines = selectedNodes
    .filter((n) => n.epistemicLevel === 'document_evidence' || n.epistemicLevel === 'verified_fact' || n.epistemicLevel === 'business_settlement')
    .map((n) => `${n.title}: ${n.summary}`);

  return {
    tenantId,
    asOfSeq: headSeq,
    goals: reg.goals,
    statutory: reg.statutory,
    selectedNodes,
    edges: neighborhood.edges,
    parkedIndex,
    quotes,
    activePolicy,
    contextBlock: lines.join('\n'),
    verifiedGroundingText: verifiedGroundingLines.join('\n'),
  };
}

export function createContinuityRecallTool({
  ledger,
  problemRegister,
  toolName = 'continuity_recall',
  resolveTenantId,
} = {}) {
  return {
    name: toolName,
    description:
      'Self-directed deep recall over the lossless bi-temporal event ledger, artifacts, parked backlog items, and 2-hop decision graph. Use whenever the pre-loaded working desk lacks older details or you want to verify what was known at a specific point in time.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords, reference numbers, dates, or topic.' },
        includeParked: { type: 'boolean', description: 'Include silently parked backlog items.' },
        asOfSeq: { type: 'integer', description: 'Optional historical sequence cutoff for time-travel inspection.' },
        validAt: { type: 'string', description: 'Optional ISO date filter for valid-time lookup.' },
        limit: { type: 'integer', description: 'Max results to return (default 12).' },
      },
      required: ['query'],
    },
    async execute(args = {}, ctx = {}) {
      const tenantId = typeof resolveTenantId === 'function' ? resolveTenantId(ctx, args) : (args.tenantId || ctx.tenantId || 'default');
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 12));
      const asOfSeq = args.asOfSeq != null ? Number(args.asOfSeq) : ledger.getHeadSeq(tenantId);
      const hits = ledger.searchFts(tenantId, args.query || '', { asOfSeq, limit });
      const nodeIds = hits.filter((h) => h.docKind === 'node').map((h) => h.docId);
      const neighborhood = nodeIds.length
        ? ledger.getNeighborhood(tenantId, nodeIds, { hops: 2, asOfSeq, validAt: args.validAt || null })
        : { nodes: [], edges: [] };
      const parked = args.includeParked
        ? problemRegister.listRegister(tenantId, { asOfSeq, validAt: args.validAt || null }).parked
        : [];
      const artifacts = ledger.listArtifacts(tenantId, { asOfSeq, limit: 10 })
        .filter((a) => !args.query || (a.ocrText || '').toLowerCase().includes(String(args.query).toLowerCase()));

      return {
        ok: true,
        tenantId,
        asOfSeq,
        ftsHits: hits,
        graphNodes: neighborhood.nodes.slice(0, limit),
        graphEdges: neighborhood.edges.slice(0, limit * 2),
        parkedItems: parked,
        matchingArtifacts: artifacts.slice(0, 6),
      };
    },
  };
}

// Universal POMR Goal & Pragmatic Backlog management tool for ANY long-running agent (assistants, coordinators, advisors).
export function createContinuityTrackTool({
  ledger,
  problemRegister,
  toolName = 'continuity_track',
  resolveTenantId,
} = {}) {
  return {
    name: toolName,
    description:
      'Track North-Star goals, active workstreams, mandatory deadlines, or silently park low-priority side items with wake_cues so they auto-reconnect later without nagging. Also lists or resolves tracked items.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set_goal', 'track_item', 'park_item', 'resolve_item', 'list_register'],
          description: 'Operation to perform on the continuity register.',
        },
        nodeId: { type: 'string', description: 'Optional existing nodeId for update/park/resolve.' },
        businessKey: { type: 'string', description: 'Optional stable key to deduplicate the same goal/item.' },
        title: { type: 'string', description: 'Short clear title of the goal or item.' },
        summary: { type: 'string', description: 'Current concrete state or context.' },
        dueAt: { type: 'string', description: 'Optional ISO deadline date (YYYY-MM-DD).' },
        hasLegalConsequence: { type: 'boolean', description: 'True for hard legal/penalty deadlines (locks SMR=0%).' },
        wakeCues: { type: 'array', items: { type: 'string' }, description: 'Keywords that automatically wake a parked item.' },
        reopenCondition: { type: 'string', description: 'Condition that reopens a parked item.' },
        autoExpireDays: { type: 'integer', description: 'Days until a non-legal parked item silently archives (default 30).' },
      },
      required: ['action'],
    },
    async execute(args = {}, ctx = {}) {
      const tenantId = typeof resolveTenantId === 'function' ? resolveTenantId(ctx, args) : (args.tenantId || ctx.tenantId || 'default');
      const action = String(args.action || 'list_register');
      if (action === 'list_register') {
        const reg = problemRegister.listRegister(tenantId);
        return {
          ok: true,
          tenantId,
          goals: reg.goals.map((g) => ({ nodeId: g.nodeId, title: g.title, status: g.status, dueAt: g.dueAt })),
          statutory: reg.statutory.map((s) => ({ nodeId: s.nodeId, title: s.title, status: s.status, dueAt: s.dueAt })),
          active: reg.active.map((a) => ({ nodeId: a.nodeId, title: a.title, status: a.status })),
          parked: reg.parked.map((p) => ({ nodeId: p.nodeId, title: p.title, wakeCues: p.wakeCues, reopenCondition: p.reopenCondition })),
        };
      }

      let headSeq = ledger.getHeadSeq(tenantId);
      if (headSeq === 0) {
        headSeq = ledger.appendEvent(tenantId, {
          eventType: 'system_track',
          body: String(args.title || args.summary || action),
        }).event.seq;
      }
      const sup = [{ sourceSeq: headSeq, sourceType: 'tool_output', excerptRef: `${toolName}:${action}` }];

      if (action === 'set_goal') {
        const existing = args.businessKey ? ledger.findNodeByBusinessKey(tenantId, args.businessKey) : null;
        const res = problemRegister.registerProblem(tenantId, {
          nodeId: args.nodeId || existing?.nodeId,
          kind: 'goal',
          businessKey: args.businessKey || null,
          title: args.title || existing?.title || 'Active Goal',
          summary: args.summary || existing?.summary || '',
          dueAt: args.dueAt ?? existing?.dueAt ?? null,
          knownFromSeq: headSeq,
          supports: sup,
        });
        return { ok: true, action, node: { nodeId: res.node.nodeId, tier: res.node.priorityTier, status: res.node.status, title: res.node.title } };
      }

      if (action === 'track_item') {
        const existing = args.businessKey ? ledger.findNodeByBusinessKey(tenantId, args.businessKey) : null;
        const res = problemRegister.registerProblem(tenantId, {
          nodeId: args.nodeId || existing?.nodeId,
          kind: args.hasLegalConsequence ? 'obligation' : 'workstream',
          businessKey: args.businessKey || null,
          title: args.title || existing?.title || 'Tracked Workstream',
          summary: args.summary || existing?.summary || '',
          dueAt: args.dueAt ?? existing?.dueAt ?? null,
          hasLegalConsequence: Boolean(args.hasLegalConsequence),
          userAskingNow: true,
          knownFromSeq: headSeq,
          supports: sup,
        });
        return { ok: true, action, node: { nodeId: res.node.nodeId, tier: res.node.priorityTier, status: res.node.status, title: res.node.title } };
      }

      if (action === 'park_item') {
        const expireDays = Math.max(1, Math.min(180, Number(args.autoExpireDays) || 30));
        const autoExpireAt = new Date(Date.now() + expireDays * 86_400_000).toISOString();
        if (args.nodeId) {
          const parked = problemRegister.parkProblem(tenantId, args.nodeId, {
            sourceSeq: headSeq,
            sourceType: 'tool_output',
            reopenCondition: args.reopenCondition || null,
            wakeCues: Array.isArray(args.wakeCues) ? args.wakeCues : [],
            autoExpireAt,
          });
          return { ok: true, action, node: { nodeId: parked.nodeId, tier: parked.priorityTier, status: parked.status, title: parked.title } };
        }
        const res = problemRegister.registerProblem(tenantId, {
          kind: 'parked_item',
          businessKey: args.businessKey || null,
          title: args.title || 'Parked Side Item',
          summary: args.summary || '',
          hasLegalConsequence: false,
          userAskingNow: false,
          wakeCues: Array.isArray(args.wakeCues) ? args.wakeCues : [],
          reopenCondition: args.reopenCondition || null,
          autoExpireAt,
          knownFromSeq: headSeq,
          supports: sup,
        });
        return { ok: true, action, node: { nodeId: res.node.nodeId, tier: res.node.priorityTier, status: res.node.status, title: res.node.title } };
      }

      if (action === 'resolve_item') {
        const target = args.nodeId
          ? ledger.getNodeAt(tenantId, args.nodeId)
          : (args.businessKey ? ledger.findNodeByBusinessKey(tenantId, args.businessKey) : null);
        if (!target) return { ok: false, error: 'node_not_found' };
        const updated = ledger.upsertNodeRevision(tenantId, {
          nodeId: target.nodeId,
          kind: target.kind,
          businessKey: target.businessKey,
          priorityTier: target.priorityTier,
          title: target.title,
          summary: args.summary || target.summary,
          status: target.kind === 'goal' ? 'achieved' : 'resolved',
          epistemicLevel: target.epistemicLevel,
          knownFromSeq: headSeq,
          hasLegalConsequence: target.hasLegalConsequence,
          dueAt: target.dueAt,
          supports: sup,
        });
        return { ok: true, action, node: { nodeId: updated.nodeId, status: updated.status, title: updated.title } };
      }

      return { ok: false, error: `unsupported_action:${action}` };
    },
  };
}
