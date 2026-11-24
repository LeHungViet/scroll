// 7-Metric Vertical Consulting Bench + 3-Stage Automated Regression Gate for @agentpro/scroll-advisory.
// Metrics:
//   1. NGCR  - North-Star Goal Convergence Rate
//   2. VoI-QE / RQR - Decision-Flip Question Efficiency & Redundant Question Rate
//   3. PBP-F1 / SMR - Pragmatic Backlog Parking F1 & Statutory Miss Rate (MUST be 0.0%!)
//   4. EGR   - Environment & Portal Grounding Rate
//   5. BTVA  - Bi-Temporal Validity Accuracy
//   6. CSIA  - Client Style Impedance Alignment
//   7. CLTR  - Single-Shot Cross-Client Learning Transfer Rate

export function runStaticSafetyLinter({ cortex, continuity, tenantIds = [] } = {}) {
  const issues = [];

  // 1. Check overlapping contradictory T1 rules with same citation/title
  if (cortex?.storage) {
    const rules = cortex.storage.prepare('SELECT * FROM cortex_t1_rule').all();
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const a = rules[i];
        const b = rules[j];
        if (a.domain === b.domain && a.title === b.title && a.summary !== b.summary) {
          const aEnd = a.valid_to || '9999-12-31';
          const bEnd = b.valid_to || '9999-12-31';
          const overlaps = a.valid_from < bEnd && b.valid_from < aEnd;
          if (overlaps) {
            issues.push({
              code: 'OVERLAPPING_CONTRADICTORY_T1_RULES',
              ruleA: a.rule_id,
              ruleB: b.rule_id,
            });
          }
        }
      }
    }
  }

  // 2. Check that ZERO statutory items have an auto_expire_at or missing has_legal_consequence lock
  if (continuity?.ledger) {
    for (const tid of tenantIds) {
      const nodes = continuity.ledger.listNodes(tid, { tiers: ['STATUTORY_PENALTY'] });
      for (const n of nodes) {
        if (!n.hasLegalConsequence || n.autoExpireAt) {
          issues.push({
            code: 'STATUTORY_LOCK_MISSING',
            tenantId: tid,
            nodeId: n.nodeId,
          });
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function computeSevenMetricScorecard(observations = {}) {
  const {
    goalsConverged = 0,
    goalsTotal = 1,
    redundantQuestions = 0,
    totalQuestions = 1,
    decisionFlipQuestions = 0,
    backlogTruePositives = 0,
    backlogFalsePositives = 0,
    backlogFalseNegatives = 0,
    statutoryMissed = 0,
    statutoryTotal = 1,
    groundedEnvSteps = 0,
    totalEnvSteps = 1,
    biTemporalCorrect = 0,
    biTemporalTotal = 1,
    styleAlignedTurns = 0,
    styleTotalTurns = 1,
    transferSolvedClientB = 0,
    transferTotalClientB = 1,
  } = observations;

  const ngcr = goalsConverged / Math.max(1, goalsTotal);
  const voiQe = decisionFlipQuestions / Math.max(1, totalQuestions);
  const rqr = redundantQuestions / Math.max(1, totalQuestions);
  const prec = backlogTruePositives / Math.max(1, backlogTruePositives + backlogFalsePositives);
  const rec = backlogTruePositives / Math.max(1, backlogTruePositives + backlogFalseNegatives);
  const pbpF1 = (prec + rec) > 0 ? (2 * prec * rec) / (prec + rec) : 1;
  const smr = statutoryMissed / Math.max(1, statutoryTotal);
  const egr = groundedEnvSteps / Math.max(1, totalEnvSteps);
  const btva = biTemporalCorrect / Math.max(1, biTemporalTotal);
  const csia = styleAlignedTurns / Math.max(1, styleTotalTurns);
  const cltr = transferSolvedClientB / Math.max(1, transferTotalClientB);

  return {
    NGCR: Number(ngcr.toFixed(4)),
    VoI_QE: Number(voiQe.toFixed(4)),
    RQR: Number(rqr.toFixed(4)),
    PBP_F1: Number(pbpF1.toFixed(4)),
    SMR: Number(smr.toFixed(4)),
    EGR: Number(egr.toFixed(4)),
    BTVA: Number(btva.toFixed(4)),
    CSIA: Number(csia.toFixed(4)),
    CLTR: Number(cltr.toFixed(4)),
  };
}

// 3-Stage Automated Regression Gate:
//   Stage 1: Static Linter
//   Stage 2: Golden Shadow Replay (SMR MUST be 0.0%, max drop <= 1.5% vs baseline)
//   Stage 3: Canary Shadow Divergence check
export function evaluateThreeStageRegressionGate({
  linterResult,
  baselineScorecard,
  candidateScorecard,
  canaryDivergences = [],
  maxDropTolerance = 0.015,
} = {}) {
  const failures = [];

  if (!linterResult?.ok) {
    failures.push({ stage: 1, reason: 'static_linter_failed', issues: linterResult?.issues || [] });
  }

  if (Number(candidateScorecard?.SMR || 0) > 0) {
    failures.push({ stage: 2, reason: 'statutory_miss_rate_nonzero', smr: candidateScorecard.SMR });
  }

  const higherIsBetter = ['NGCR', 'VoI_QE', 'PBP_F1', 'EGR', 'BTVA', 'CSIA', 'CLTR'];
  if (baselineScorecard && candidateScorecard) {
    for (const metric of higherIsBetter) {
      if (typeof baselineScorecard[metric] !== 'number' || typeof candidateScorecard[metric] !== 'number') continue;
      const drop = baselineScorecard[metric] - candidateScorecard[metric];
      if (drop > maxDropTolerance) {
        failures.push({
          stage: 2,
          reason: `metric_regression:${metric}`,
          baseline: baselineScorecard[metric],
          candidate: candidateScorecard[metric],
          drop: Number(drop.toFixed(4)),
        });
      }
    }
    if (
      typeof baselineScorecard.RQR === 'number'
      && typeof candidateScorecard.RQR === 'number'
      && (candidateScorecard.RQR - baselineScorecard.RQR) > maxDropTolerance
    ) {
      failures.push({
        stage: 2,
        reason: 'metric_regression:RQR',
        baseline: baselineScorecard.RQR,
        candidate: candidateScorecard.RQR,
      });
    }
  }

  const severeCanary = (canaryDivergences || []).filter((d) => d?.severity === 'high');
  if (severeCanary.length) {
    failures.push({ stage: 3, reason: 'canary_high_severity_divergence', count: severeCanary.length });
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
