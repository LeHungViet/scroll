// Public facade for `@agentpro/scroll-advisory` — Opt-in Vertical Specialist layer on top of `@agentpro/scroll-continuity`.
import { createDomainCortexStore } from './cortex-store.js';
import {
  evaluateDecisionFlipQuestion,
  runCounterfactualPreflight,
  renderConsultingLensBlock,
  createAdvisoryDeliveryGuard,
} from './navigator.js';
import { createApprenticeshipLadder } from './apprenticeship.js';
import {
  runStaticSafetyLinter,
  computeSevenMetricScorecard,
  evaluateThreeStageRegressionGate,
} from './specialist-bench.js';
import { createSoftwareAtlasHarvester, defaultHttpProbe } from './atlas-harvester.js';

export {
  createDomainCortexStore,
  evaluateDecisionFlipQuestion,
  runCounterfactualPreflight,
  renderConsultingLensBlock,
  createAdvisoryDeliveryGuard,
  createApprenticeshipLadder,
  runStaticSafetyLinter,
  computeSevenMetricScorecard,
  evaluateThreeStageRegressionGate,
  createSoftwareAtlasHarvester,
  defaultHttpProbe,
};

export function createAdvisorySpecialistEngine({
  continuity,
  cortexStorage = null,
  cortexDbPath = ':memory:',
  domain = 'general',
  now = () => new Date().toISOString(),
} = {}) {
  if (!continuity) throw new Error('createAdvisorySpecialistEngine requires a @agentpro/scroll-continuity engine');
  const cortex = createDomainCortexStore({
    storage: cortexStorage || continuity.ledger.storage,
    dbPath: cortexDbPath,
    now,
  });
  const apprenticeship = createApprenticeshipLadder({ cortex, now });
  const lastSoftwareByTenant = new Map();

  function prepareAdvisoryTurn({
    tenantId,
    chatId = null,
    activeSpeakerId = null,
    query = '',
    softwareHint = '',
    asOfDate = null,
    asOfSeq = null,
  } = {}) {
    const desk = continuity.buildWorkingDesk(tenantId, {
      query,
      chatId,
      activeSpeakerId,
      asOfSeq,
    });
    const activePolicy = desk.activePolicy;
    const t2Cases = cortex.searchT2Cases({ query, domain });
    const t1Rules = cortex.getEffectiveT1Rules({ asOfDate, domain, query });
    const softwareTarget = softwareHint || query;
    const t3Resolution = softwareTarget
      ? cortex.resolveSoftwareGuidance({
          software: softwareHint,
          os: activePolicy?.techEnv?.os || null,
          query,
        })
      : null;
    if (t3Resolution) {
      lastSoftwareByTenant.set(String(tenantId), t3Resolution);
    }

    const lensBlock = renderConsultingLensBlock({
      desk,
      t2Cases,
      t1Rules,
      t3Resolution,
      activePolicy,
    });

    return {
      desk,
      t2Cases,
      t1Rules,
      t3Resolution,
      lensBlock,
      contextBlocks: [desk.contextBlock, lensBlock],
      verifiedGroundingText: [
        desk.verifiedGroundingText,
        ...t1Rules.slice(0, 3).map((r) => `${r.citation}: ${r.summary}`),
        ...t2Cases.slice(0, 3).map((c) => `${c.title}: ${c.verifiedFieldPath}`),
      ].filter(Boolean).join('\n'),
    };
  }

  function createDeliveryGuard(opts = {}) {
    return createAdvisoryDeliveryGuard({
      continuity,
      cortex,
      getLastSoftwareResolution: (tid) => lastSoftwareByTenant.get(String(tid)) || null,
      ...opts,
    });
  }

  return {
    continuity,
    cortex,
    apprenticeship,
    prepareAdvisoryTurn,
    createDeliveryGuard,
    runCounterfactualPreflight,
    evaluateDecisionFlipQuestion,
    runStaticSafetyLinter: (tenantIds = []) => runStaticSafetyLinter({ cortex, continuity, tenantIds }),
    computeSevenMetricScorecard,
    evaluateThreeStageRegressionGate,
  };
}
