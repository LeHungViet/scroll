// Anti-Pollution Apprenticeship Promotion Ladder for @agentpro/scroll-advisory.
// Prevents field anecdotes, single-branch rumors, or law-violating shortcuts from polluting T2 Playbooks:
//   Stage 1: `anecdote` (1 case) -> stored as observation ONLY, NEVER emitted as guidance.
//   Stage 2: `pattern_candidate` (>=3 independent cases across >=2 distinct locations/sources + ACH disconfirming check).
//   Stage 3: `promoted_playbook` (ACE Delta update in T2 Cortex; HITL expert approval required for money/penalty/red-lines).
import crypto from 'node:crypto';

const APPRENTICE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS apprentice_observation (
  obs_id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'general',
  scope TEXT NOT NULL DEFAULT 'single_case',
  location_or_source TEXT NOT NULL,
  tenant_hash TEXT NOT NULL,
  situation TEXT NOT NULL,
  proposed_guidance TEXT NOT NULL,
  linked_t1_rule_id TEXT,
  touches_money_or_redline INTEGER NOT NULL DEFAULT 0,
  conflicts_with_t1 INTEGER NOT NULL DEFAULT 0,
  is_t3_software INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'anecdote',
  ach_counter_examples_json TEXT NOT NULL DEFAULT '[]',
  human_approved_by TEXT,
  promoted_case_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_group ON apprentice_observation(group_key, stage);
`;

export function createApprenticeshipLadder({
  cortex,
  now = () => new Date().toISOString(),
} = {}) {
  if (!cortex?.storage) throw new Error('createApprenticeshipLadder requires cortex');
  const db = cortex.storage;
  db.exec(APPRENTICE_SCHEMA_SQL);

  const stmts = {
    insertObs: db.prepare(`
      INSERT INTO apprentice_observation (
        obs_id, group_key, domain, scope, location_or_source, tenant_hash,
        situation, proposed_guidance, linked_t1_rule_id, touches_money_or_redline,
        conflicts_with_t1, is_t3_software, stage, ach_counter_examples_json,
        human_approved_by, promoted_case_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listGroup: db.prepare('SELECT * FROM apprentice_observation WHERE group_key = ? ORDER BY created_at ASC'),
    markGroupStage: db.prepare(`
      UPDATE apprentice_observation
      SET stage = ?, ach_counter_examples_json = ?, human_approved_by = ?, promoted_case_id = ?
      WHERE group_key = ?
    `),
  };

  function recordObservation({
    groupKey,
    domain = 'general',
    locationOrSource,
    tenantId = 'anon',
    situation,
    proposedGuidance,
    linkedT1RuleId = null,
    touchesMoneyOrRedLine = false,
    conflictsWithT1 = false,
    isT3Software = false,
  } = {}) {
    if (!groupKey || !locationOrSource || !situation || !proposedGuidance) {
      throw new Error('recordObservation requires groupKey, locationOrSource, situation, proposedGuidance');
    }
    const obsId = `obs_${crypto.randomBytes(6).toString('hex')}`;
    const tenantHash = crypto.createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 12);
    stmts.insertObs.run(
      obsId,
      String(groupKey),
      String(domain),
      'single_case',
      String(locationOrSource),
      tenantHash,
      String(situation),
      String(proposedGuidance),
      linkedT1RuleId,
      touchesMoneyOrRedLine ? 1 : 0,
      conflictsWithT1 ? 1 : 0,
      isT3Software ? 1 : 0,
      'anecdote',
      '[]',
      null,
      null,
      String(now())
    );
    return { obsId, groupKey, stage: 'anecdote' };
  }

  function evaluatePromotion(groupKey, {
    title = '',
    wrongTextbookPath = '',
    redLines = [],
    tags = [],
    achReviewed = false,
    achCounterExamples = [],
    humanApprovedBy = null,
    softwareMeta = null,
  } = {}) {
    const rows = stmts.listGroup.all(String(groupKey));
    if (!rows.length) return { promoted: false, reason: 'group_not_found' };

    const anyConflictT1 = rows.some((r) => Number(r.conflicts_with_t1) === 1);
    if (anyConflictT1) {
      stmts.markGroupStage.run('warning_only_t1_conflict', JSON.stringify(achCounterExamples), null, null, String(groupKey));
      return {
        promoted: false,
        stage: 'warning_only_t1_conflict',
        reason: 'Observation conflicts with T1 normative law; stored as warning only and blocked from playbook guidance.',
      };
    }

    const isT3Only = rows.every((r) => Number(r.is_t3_software) === 1);
    if (isT3Only && softwareMeta) {
      // Auto-Curator is allowed for T3 software UI entries (still subject to TTL 30-60d)
      const atlas = cortex.upsertT3Atlas({
        ...softwareMeta,
        verifiedWorkaround: rows[rows.length - 1].proposed_guidance,
        verifier: 'apprentice_t3_curator',
        status: 'verified',
      });
      stmts.markGroupStage.run('promoted_t3_atlas', JSON.stringify(achCounterExamples), 'auto_t3_curator', atlas.atlasId, String(groupKey));
      return { promoted: true, stage: 'promoted_t3_atlas', atlasId: atlas.atlasId };
    }

    const distinctTenants = new Set(rows.map((r) => r.tenant_hash)).size;
    const distinctSources = new Set(rows.map((r) => r.location_or_source)).size;
    const independentCount = Math.max(distinctTenants, rows.length);

    if (rows.length < 3 || distinctSources < 2) {
      return {
        promoted: false,
        stage: 'anecdote',
        reason: `Requires >=3 independent cases across >=2 distinct locations/sources (have ${rows.length} cases, ${distinctSources} sources).`,
      };
    }

    if (!achReviewed) {
      stmts.markGroupStage.run('pattern_candidate', JSON.stringify(achCounterExamples), null, null, String(groupKey));
      return {
        promoted: false,
        stage: 'pattern_candidate',
        reason: 'ACH disconfirming-evidence review required before promoting to T2 Playbook.',
      };
    }

    const touchesSensitive = rows.some((r) => Number(r.touches_money_or_redline) === 1);
    if (touchesSensitive && !humanApprovedBy) {
      stmts.markGroupStage.run('awaiting_human_review', JSON.stringify(achCounterExamples), null, null, String(groupKey));
      return {
        promoted: false,
        stage: 'awaiting_human_review',
        reason: 'Human specialist approval required for rules touching money, penalties, or compliance red lines.',
      };
    }

    const latest = rows[rows.length - 1];
    const created = cortex.upsertT2Case({
      domain: latest.domain,
      title: title || `Field Case: ${groupKey}`,
      scope: distinctSources >= 2 ? 'national' : 'local',
      linkedT1RuleId: latest.linked_t1_rule_id,
      status: 'active',
      situation: latest.situation,
      wrongTextbookPath,
      verifiedFieldPath: latest.proposed_guidance,
      redLines,
      independentCaseCount: independentCount,
      sources: [...new Set(rows.map((r) => r.location_or_source))],
      tags,
    });

    stmts.markGroupStage.run('promoted_playbook', JSON.stringify(achCounterExamples), humanApprovedBy || 'auto_curator', created.caseId, String(groupKey));
    return {
      promoted: true,
      stage: 'promoted_playbook',
      caseId: created.caseId,
      independentCount,
      distinctSources,
    };
  }

  return {
    recordObservation,
    evaluatePromotion,
  };
}
