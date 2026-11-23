// Enabling Consulting Navigator, Counterfactual Pre-Flight & Hard Delivery Guard for @agentpro/scroll-advisory.
// Enforces the Anti-Strangulation Principle:
//   - NEVER locks style, wording, or creative reasoning on novel cases.
//   - Runs counterfactual pre-flight checks against client TechEnvProfile (`WebDreamer` pattern).
//   - Operationalizes VoI via the Decision-Flip Test (no bogus LLM Shannon entropy math).
//   - Enforces ONLY 4 Hard Invariants in `hooks.onBeforeDeliver`:
//       1. Zero cross-tenant leak
//       2. Zero hallucinated UI button paths when Atlas tier is B or D
//       3. Zero conflation of unverified `user_claim` as `business_settlement`
//       4. Optional deterministic arithmetic / domain invariant callback.

export function evaluateDecisionFlipQuestion({ optionAAction = '', optionBAction = '' } = {}) {
  const a = String(optionAAction || '').trim().toLowerCase();
  const b = String(optionBAction || '').trim().toLowerCase();
  if (!a || !b) {
    return { ask: false, reason: 'Incomplete branching actions; verify next concrete action first.' };
  }
  if (a === b) {
    return { ask: false, reason: 'Both answers lead to the exact same next action — skip the question and act immediately.' };
  }
  return { ask: true, reason: 'Answers diverge into distinct concrete actions (positive VoI).' };
}

// WebDreamer-inspired 1-step Counterfactual Pre-Flight against client hard environment constraints
export function runCounterfactualPreflight({
  candidateAdvice = '',
  techEnv = {},
  customChecks = [],
} = {}) {
  const text = String(candidateAdvice || '');
  const os = String(techEnv?.os || '').toLowerCase();
  const blockers = [];

  if (os === 'macos') {
    if (/\b(?:[a-z0-9_-]+\.exe|run\s+.*\.exe\s+natively|install\s+windows-only)\b/iu.test(text)) {
      blockers.push({
        code: 'OS_INCOMPATIBLE_EXE_ON_MAC',
        detail: 'Windows-only .exe software cannot run natively on macOS; propose a real workaround (Windows machine / VM / alternate path).',
      });
    }
  }
  if (techEnv?.portalPatience === 'low' && /(?:reinstall\s+all\s+drivers|reinstall\s+java\s+runtime|full\s+plugin\s+reinstall)/iu.test(text)) {
    blockers.push({
      code: 'HIGH_FRICTION_PORTAL_REPAIR',
      detail: 'Low portal patience user: avoid multi-hour driver troubleshooting when a faster compliant workaround exists.',
    });
  }
  for (const fn of customChecks || []) {
    if (typeof fn !== 'function') continue;
    const hit = fn({ text, techEnv });
    if (hit) blockers.push(hit);
  }

  return {
    ok: blockers.length === 0,
    blockers,
  };
}

export function renderConsultingLensBlock({
  desk = null,
  t2Cases = [],
  t1Rules = [],
  t3Resolution = null,
  activePolicy = null,
} = {}) {
  const lines = ['<advisory_consulting_lens mode="enabling_not_throttling">'];
  lines.push('Order of synthesis: T2 Field Reality decides WHAT to do -> T1 Normative Rules bound legality -> T3 Atlas guides HOW to execute.');
  lines.push('Freedom clause: T2/T3 are verified priors, NOT a cage. For novel edge cases outside T2/T3, reason freely from T1 principles while remaining transparent about certainty.');

  if (t2Cases.length) {
    lines.push('[T2_VERIFIED_FIELD_REALITY]');
    for (const c of t2Cases.slice(0, 3)) {
      lines.push(`- ${c.title} (scope=${c.scope}, cases=${c.independentCaseCount}): Field path = ${c.verifiedFieldPath}${c.wrongTextbookPath ? ` | Avoid textbook trap: ${c.wrongTextbookPath}` : ''}`);
      if (c.redLines?.length) lines.push(`  Red lines (NEVER cross): ${c.redLines.join('; ')}`);
    }
  }

  if (t1Rules.length) {
    lines.push('[T1_EFFECTIVE_NORMATIVE_BOUNDS]');
    for (const r of t1Rules.slice(0, 3)) {
      lines.push(`- ${r.citation} (${r.validFrom}..${r.validTo || 'present'}${r.agencyName ? ` · ${r.agencyName}` : ''}): ${r.summary}`);
    }
  }

  if (t3Resolution) {
    lines.push(`[T3_SOFTWARE_ATLAS_BOUNDARY tier="${t3Resolution.tier}" allow_ui_buttons="${t3Resolution.allowUiButtonNames ? 'yes' : 'no'}"]`);
    lines.push(`- ${t3Resolution.guidance}`);
    if (t3Resolution.tier === 'A' && t3Resolution.entry) {
      if (t3Resolution.entry.verifiedWorkaround) lines.push(`- Verified workaround: ${t3Resolution.entry.verifiedWorkaround}`);
      if (t3Resolution.entry.uiSteps?.length) lines.push(`- Verified UI path: ${t3Resolution.entry.uiSteps.join(' -> ')}`);
    } else if (t3Resolution.tier === 'C' && t3Resolution.officialInquiryQuestions?.length) {
      lines.push(`- Ready-to-send official questions: ${t3Resolution.officialInquiryQuestions.join(' | ')}`);
    }
  }

  lines.push('[5_STEP_INTERNAL_SELF_CHECK (silent before replying)]');
  lines.push('1. Goal Anchor: Does this reply move the client closer to the active North-Star Goal rather than circling on side symptoms?');
  lines.push('2. Anti-Theory & Pre-Flight: Remove steps that change nothing or fail on the client\'s actual OS/device.');
  lines.push('3. B|D|U Backlog Discipline: Keep non-urgent, non-blocking, non-statutory side items silently parked (never nag; statutory deadlines NEVER skipped).');
  lines.push('4. Single Decision-Flip Question: Only ask a question if answer A vs B changes the next concrete action; pick the single highest-branching question.');
  lines.push('5. Natural Peer Voice: Speak like an experienced senior specialist texting a real client; no robotic audit templates or fabricated UI menu clicks.');
  if (activePolicy?.deepOverride) {
    lines.push('Note: Client explicitly requested deep detail on this turn — soft brevity prior is lifted.');
  }
  lines.push('</advisory_consulting_lens>');
  return lines.join('\n');
}

const DEFAULT_UI_MENU_CLAIM_RE = /(?:click\s+(?:the\s+)?["'][^"']+["']\s+button|select\s+menu\s+["'][^"']+["']|navigate\s+to\s+[^.\n]+->)/iu;
const DEFAULT_PREMATURE_SETTLEMENT_RE = /(?:officially\s+settled\s+in\s+full|confirmed\s+zero\s+balance|fully\s+cleared\s+on\s+official\s+ledger)/iu;

// Deterministic Delivery Guard plugged into `@agentpro/scroll` `hooks.onBeforeDeliver`
// Checks ONLY the 4 Hard Invariants — never throttles tone or creative reasoning.
export function createAdvisoryDeliveryGuard({
  continuity,
  cortex = null,
  resolveTenantId = ({ conversationId }) => String(conversationId || 'default'),
  getForbiddenTenantTokens = null,
  getLastSoftwareResolution = null,
  checkArithmetic = null,
  uiMenuClaimRe = DEFAULT_UI_MENU_CLAIM_RE,
  prematureSettlementRe = DEFAULT_PREMATURE_SETTLEMENT_RE,
  messages = null,
} = {}) {
  return async function onBeforeDeliver({
    conversationId,
    text = '',
    toolTraces = [],
  } = {}) {
    const reply = String(text || '');
    if (!reply.trim()) return { action: 'allow', violations: [] };
    const tenantId = resolveTenantId({ conversationId });
    const violations = [];

    // Invariant 1: Zero cross-tenant leakage
    if (typeof getForbiddenTenantTokens === 'function') {
      const forbidden = getForbiddenTenantTokens(tenantId) || [];
      for (const tok of forbidden) {
        if (tok && tok.length >= 6 && reply.includes(tok)) {
          violations.push({ code: 'CROSS_TENANT_LEAK', severity: 'hard', detail: 'Forbidden token from another tenant detected' });
        }
      }
    }

    // Invariant 2: Zero hallucinated UI button paths when Atlas tier is B or D
    const swRes = typeof getLastSoftwareResolution === 'function' ? getLastSoftwareResolution(tenantId) : null;
    if (swRes && !swRes.allowUiButtonNames && (swRes.tier === 'B' || swRes.tier === 'D')) {
      if (uiMenuClaimRe.test(reply)) {
        violations.push({
          code: 'UNVERIFIED_UI_BUTTON_PATH',
          severity: 'hard',
          tier: swRes.tier,
          detail: `Atlas tier ${swRes.tier} forbids citing unverified/expired UI button paths.`,
        });
      }
    }

    // Invariant 3: Epistemic separation — forbid declaring full settlement when ledger only has `user_claim`
    if (continuity && prematureSettlementRe.test(reply)) {
      const obligations = continuity.ledger.listNodes(tenantId, {
        kinds: ['obligation'],
        excludeStatuses: ['resolved', 'superseded'],
      });
      const hasOnlyClaim = obligations.length > 0
        && obligations.every((o) => o.epistemicLevel === 'user_claim');
      if (hasOnlyClaim) {
        violations.push({
          code: 'EPISTEMIC_CLAIM_AS_SETTLEMENT',
          severity: 'hard',
          detail: 'Cannot declare official settlement based solely on an unverified user_claim.',
        });
      }
    }

    // Invariant 4: Optional deterministic arithmetic/domain check
    if (typeof checkArithmetic === 'function') {
      const arith = await checkArithmetic({ tenantId, reply, toolTraces });
      if (arith && arith.ok === false) {
        violations.push({
          code: 'DETERMINISTIC_ARITHMETIC_MISMATCH',
          severity: 'hard',
          detail: arith.detail || 'Arithmetic check failed',
        });
      }
    }

    if (!violations.length) {
      return { action: 'allow', violations: [] };
    }

    if (violations.some((v) => v.code === 'CROSS_TENANT_LEAK')) {
      return {
        action: 'hold',
        reason: 'cross_tenant_leak_prevented',
        violations,
        text: messages?.crossTenantHold || 'Hold: verifying tenant records before sending to prevent cross-account disclosure.',
      };
    }

    const milestone = swRes?.entry?.goalMilestone || 'the target confirmation step';
    return {
      action: 'hold',
      reason: violations[0].code.toLowerCase(),
      violations,
      text: violations[0].code === 'UNVERIFIED_UI_BUTTON_PATH'
        ? (typeof messages?.uiTierBHold === 'function'
            ? messages.uiTierBHold(milestone)
            : `This portal UI changes frequently so I will not guess menu names. Please share a screenshot of your current screen; our goal is to reach ${milestone}.`)
        : (messages?.epistemicHold || 'I have logged your update, and we still need official document/ledger verification before confirming full settlement.'),
    };
  };
}
