// Conversational Voice Core v2 \u2014 Unified Portable Engine
// Zero legacy-host/Zalo/Telegram dependencies. Exposes the 2 official SCROLL v1.9 hook methods:
//   1. beforeTurn({ incoming, history, recentAssistantTexts, nowMs, nowDate }) -> { guidance, state, behavior }
//   2. shapeOutgoing({ text, rawText, bubbles, incoming, state, capabilities, nowDate, seed }) -> { text, bubbles, delivery, humanError }

import {ROLE_PRESETS, PERSONA_PRESETS, INITIATIVE_LEVELS, normalizeVoiceConfig, renderPersonaGuidance} from './persona.js';
import {STANCES, createAffectState, extractAffectSignal, updateAffectState, renderAffectCue} from './affect.js';
import {renderAntiEssayGuidance, detectRepeatedOpening, hasTherapistCliche, stripEssayMarkdown} from './anti-essay.js';
import {applyHumanError, claimsUnchanged} from './human-error.js';
import {analyzeIncomingBehavior, planDelivery} from './behavior.js';
import {
  VOICE_GENDERS, VOICE_ROLES, VOICE_PRESETS, VOICE_PRESET_IDS,
  isValidVoicePreset, listVoicePresets, resolveVoicePreset,
  renderVoicePresetSystem, toCharacterSettings, toScrollVoiceConfig,
} from './preset-catalog.js';
import {detectCustomerRapport, detectSubtext, extractTopicAnchors, selectCallbackAnchor, renderEqIntelligenceCue, selectCompanionReaction} from './eq-engine.js';
import {
  MODE_ESCALATION_MODES, MODE_ESCALATION_IDS, ESCALATION_PAIRS,
  isValidModeEscalation, extractGroupContextLines, classifyEscalationSignals,
  countPlayfulRoomMomentum, evaluateModeEscalation,
} from './mode-escalation.js';

export {
  ROLE_PRESETS, PERSONA_PRESETS, INITIATIVE_LEVELS, normalizeVoiceConfig, renderPersonaGuidance,
  STANCES, createAffectState, extractAffectSignal, updateAffectState, renderAffectCue,
  renderAntiEssayGuidance, detectRepeatedOpening, hasTherapistCliche, stripEssayMarkdown,
  applyHumanError, claimsUnchanged,
  analyzeIncomingBehavior, planDelivery,
  VOICE_GENDERS, VOICE_ROLES, VOICE_PRESETS, VOICE_PRESET_IDS,
  isValidVoicePreset, listVoicePresets, resolveVoicePreset,
  renderVoicePresetSystem, toCharacterSettings, toScrollVoiceConfig,
  detectCustomerRapport, detectSubtext, extractTopicAnchors, selectCallbackAnchor, renderEqIntelligenceCue, selectCompanionReaction,
  MODE_ESCALATION_MODES, MODE_ESCALATION_IDS, ESCALATION_PAIRS,
  isValidModeEscalation, extractGroupContextLines, classifyEscalationSignals,
  countPlayfulRoomMomentum, evaluateModeEscalation,
};

const MAX_GUIDANCE_CHARS = 650;

// Create a stateful voice controller scoped to one conversation (or inject external stateStore)
export function createVoiceEngine({
  config = {},
  localePack = null,
  capabilities = {bubbles: true, typing: true, reaction: true, edit: true},
  stateStore = null,
} = {}) {
  const effectiveConfig = config?.voicePreset
    ? {...toScrollVoiceConfig(config.voicePreset, config.advanced), ...config}
    : config;
  const resolvedPreset = config?.voicePreset ? resolveVoicePreset(config.voicePreset, config.advanced) : null;
  const normalized = normalizeVoiceConfig(effectiveConfig);
  const memStates = new Map();

  const getState = (convKey, nowMs) => {
    if (stateStore && typeof stateStore.get === 'function') return stateStore.get(convKey) || createAffectState(nowMs);
    return memStates.get(convKey) || createAffectState(nowMs);
  };
  const setState = (convKey, state) => {
    if (stateStore && typeof stateStore.set === 'function') stateStore.set(convKey, state);
    else memStates.set(convKey, state);
  };

  function beforeTurn({
    conversationId = 'default',
    incoming = '',
    recentAssistantTexts = [],
    nowMs = Date.now(),
    nowDate = new Date(nowMs),
  } = {}) {
    const prevState = getState(conversationId, nowMs);
    const nextState = updateAffectState(prevState, incoming, {
      nowMs,
      sensitivity: normalized.adaptive_affect.sensitivity,
      halfLifeMin: normalized.adaptive_affect.decay_half_life_min,
      localePack,
    });
    setState(conversationId, nextState);

    const behavior = analyzeIncomingBehavior(incoming, {
      nowDate,
      urgent: nextState.urgent,
      capabilities,
    });

    // Prioritize high-signal dynamic cues (affect + anti-essay/anti-repeat) before persona baseline
    // so the 650-char volatile budget never truncates live emotional or anti-repeat corrections.
    const segments = [
      renderAffectCue(nextState),
      renderAntiEssayGuidance({
        stance: nextState.stance,
        recentAssistantTexts,
        localePack,
      }),
      renderPersonaGuidance(normalized, {
        stance: nextState.stance,
        quietTurn: nextState.urgent || behavior.isCommand,
        suppressFollowUp: behavior.suppressFollowUp,
      }),
    ].filter(Boolean);

    let guidance = segments.join(' ').replace(/\s+/g, ' ').trim();
    if (guidance.length > MAX_GUIDANCE_CHARS) {
      // Truncate cleanly at sentence boundary under 650 chars
      const cut = guidance.slice(0, MAX_GUIDANCE_CHARS);
      const lastDot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      guidance = (lastDot > 240 ? cut.slice(0, lastDot + 1) : cut).trim();
    }

    return {guidance, state: nextState, behavior};
  }

  function shapeOutgoing({
    conversationId = 'default',
    text = '',
    rawText = null,
    bubbles = null,
    incoming = '',
    state = null,
    nowMs = Date.now(),
    nowDate = new Date(nowMs),
    seed = 'turn',
  } = {}) {
    const activeState = state || getState(conversationId, nowMs);
    const sourceRaw = rawText ?? text;
    const baseBubbles = (Array.isArray(bubbles) && bubbles.length ? bubbles : [text])
      .map(b => stripEssayMarkdown(b, {stance: activeState.stance}))
      .filter(Boolean);

    const errRes = applyHumanError(baseBubbles.length ? baseBubbles : [sourceRaw], {
      config: normalized,
      stance: activeState.stance,
      hardGuard: activeState.hardGuard,
      capabilities,
      localePack,
      seed,
    });

    const delivery = planDelivery({
      incomingText: incoming,
      bubbles: errRes.bubbles,
      stance: activeState.stance,
      capabilities,
      nowDate,
      urgent: activeState.urgent,
      editPlan: errRes.editPlan,
      appendDelayMs: errRes.appendDelayMs,
    });

    const finalBubbles = delivery.action === 'react' ? [] : delivery.bubbles;
    const finalText = finalBubbles.join('\n');
    const invariantOk = delivery.action === 'react' ? true : claimsUnchanged(sourceRaw, finalText);

    return {
      text: invariantOk ? finalText : sourceRaw,
      bubbles: invariantOk ? finalBubbles : [sourceRaw],
      reaction: delivery.reaction,
      edits: delivery.editPlan,
      delivery,
      humanError: errRes.applied,
      invariantOk,
    };
  }

  return {
    config: normalized,
    preset: resolvedPreset,
    systemPrompt: resolvedPreset ? renderVoicePresetSystem(resolvedPreset) : '',
    beforeTurn,
    shapeOutgoing,
    getState: (id = 'default') => getState(id, Date.now()),
  };
}

export {analyzeVietnameseNaturalness} from './naturalness.js';
export {
  HUMOR_MOVES,
  VERBAL_CRAFT_MOVES,
  ICON_PALETTE,
  ALL_EMOTICON_RE,
  ALL_EMOJI_RE,
  extractIcons,
  normalizeIconFamily,
  selectHumorMove,
  selectIconPaletteHint,
  selectMovePlaybookCue,
  VN_CULTURAL_IDIOMS,
  FLIRTY_EXPRESSION_BANK,
  WARM_EQ_EXPRESSION_BANK,
  ASSISTANT_EXPRESSION_BANK,
  SALES_EXPRESSION_BANK,
  selectCulturalIdiomHint,
  selectLengthCadence,
  detectRepeatedSingleOpener,
  detectRepeatedSignaturePhrase,
  detectDisallowedOpener,
  detectBluntMasculineOpener,
  VIET_DAILY_SLANG_CUE,
  resolveVoiceDnaSlice,
  renderVoiceDnaCue,
} from './style-system.js';
