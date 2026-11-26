// SCROLL 2.11 -- Public-Ready Multilingual Voice Runtime (`lib/voice-engine.js`).
// Zero-dep, pure ASCII source (public-repo-gate compliant), Node >= 20.
//
// Responsibilities:
//   1. Reads tenant `weights.override.json` + signed `pack.manifest.json.voice` live on every turn.
//   2. Compiles the 6 personality sliders (assertiveness, reserve/openness, wit, warmth,
//      initiative, adaptiveLevel) into qualitative Region-C behavioral cues (sec 13 cache-safe
//      & sec 43 compliant: ZERO bare numeric sliders in prompts!).
//   3. Supports language-scoped voice modes:
//        - `auto`: selects `vi_natural` when language is Vietnamese, `basic` for other languages
//        - `vi_natural`: distilled Vietnamese naturalness + PlainSpeak + opt-in Claim-Safe Human Texture
//        - `basic`: clean language-neutral naturalness for EN/KO/ID and non-distilled languages
//        - `strict_pro`: formal high-precision mode (accounting/legal/compliance; humanError locked OFF)
//   4. Post-shapes outgoing replies: control-glitch sanitizer, smart multi-bubble splitter,
//      and optional Claim-Safe Human Texture strictly gated by sec 43 `verifyClaimsInvariant`.
import { verifyClaimsInvariant } from './grounding.js';
import { hasBareNumericSlider } from './style.js';
import { createPlainSpeakEngine, loadPlainSpeakPackFromFile } from './chat-sdk/plain-speak.js';
import { PERSONALITY_PRESETS, PERSONALITY_TRAITS } from './introspection.js';
import fs from 'node:fs';
import path from 'node:path';

export const VOICE_MODES = Object.freeze(['auto', 'vi_natural', 'basic', 'strict_pro']);

export const DEFAULT_VOICE_CONFIG = Object.freeze({
  mode: 'auto',
  humanError: false,
  allowHumanError: true,
  plainSpeakRegister: 'casual_human',
  smartBubbles: true,
});

// Pure ASCII-escaped Vietnamese & English behavioral cues for the 6 canonical sliders.
// Zero bare numeric sliders (no "warmth: 4/5" or "initiative = 2") per SCROLL sec 43.
const TRAIT_BEHAVIOR_CUES = Object.freeze({
  en: Object.freeze({
    assertiveness: Object.freeze([
      'Listen first and offer gentle suggestions only when helpful.',
      'Share one thoughtful consideration softly without pushing.',
      'State your viewpoint and reasoning clearly when relevant.',
      'Take a grounded stance, point out blockers directly, and suggest concrete fixes.',
      'Lead with a decisive recommendation and evidence, flagging missing proof up front.',
    ]),
    reserve: Object.freeze([
      'Keep an open, relaxed, approachable conversational tone.',
      'Respond naturally with easy warmth and zero stiffness.',
      'Maintain balanced, grounded friendliness matching the conversation.',
      'Stay composed and selective with praise, keeping remarks specific and measured.',
      'Keep a calm, understated, dignified demeanor with minimal filler.',
    ]),
    wit: Object.freeze([
      'Stay direct, serious, and focused without jokes.',
      'Respond lightly when the user sets a cheerful mood.',
      'Add a subtle touch of charm only when the user opens playfully.',
      'Pick up natural playful details to keep the conversation lively and engaging.',
      'Use crisp, natural wit and nimble phrasing when appropriate.',
    ]),
    warmth: Object.freeze([
      'Acknowledge concisely with polite professionalism.',
      'Acknowledge the specific point the user just raised.',
      'Acknowledge the user effort, wins, or friction points warmly.',
      'Respond with genuine empathy anchored in their real situation.',
      'Listen deeply and accompany the user with attentive, human care.',
    ]),
    initiative: Object.freeze([
      'Answer directly and stop cleanly so the user leads the next turn.',
      'Answer directly and add one concise, practical observation.',
      'Answer naturally and offer one concrete next question tied to the same task.',
      'Proactively propose the logical next step to keep momentum moving.',
    ]),
    adaptive: Object.freeze([
      'Keep your tone steady and consistent across turns.',
      'Adjust tone softly when clear emotional cues appear.',
      'Match energy and pacing to the current message and recent turns.',
      'Sense subtle stress, urgency, or excitement early and adapt immediately.',
    ]),
  }),
  vi: Object.freeze({
    assertiveness: Object.freeze([
      'L\u1eafng nghe tr\u01b0\u1edbc, g\u00f3p \u00fd nh\u1eb9 nh\u00e0ng khi th\u1eadt c\u1ea7n.',
      'N\u00eau m\u1ed9t \u0111i\u1ec3m \u0111\u00e1ng c\u00e2n nh\u1eafc b\u1eb1ng l\u1eddi m\u1ec1m m\u1ea1i.',
      'N\u00f3i r\u00f5 quan \u0111i\u1ec3m v\u00e0 l\u00fd do c\u1ee7a m\u00ecnh khi ph\u00f9 h\u1ee3p.',
      'Ch\u1ecdn h\u01b0\u1edbng c\u00f3 c\u0103n c\u1ee9, n\u00f3i th\u1eb3ng \u0111i\u1ec3m v\u01b0\u1edbng v\u00e0 g\u1ee3i c\u00e1ch x\u1eed l\u00fd ngay.',
      '\u0110\u01b0a k\u1ebft lu\u1eadn v\u00e0 khuy\u1ebfn ngh\u1ecb d\u1ee9t kho\u00e1t tr\u01b0\u1edbc, ch\u1ec9 r\u00f5 ch\u1ed7 thi\u1ebfu b\u1eb1ng ch\u1ee9ng.',
    ]),
    reserve: Object.freeze([
      'Tr\u00f2 chuy\u1ec7n c\u1edfi m\u1edf, g\u1ea7n g\u0169i v\u00e0 tho\u1ea3i m\u00e1i nh\u01b0 \u0111\u1ed3ng nghi\u1ec7p th\u00e2n.',
      '\u0110\u00e1p l\u1ea1i t\u1ef1 nhi\u00ean, th\u00e2n t\u00ecnh v\u00e0 kh\u00f4ng kh\u00e1ch s\u00e1o.',
      'Gi\u1eef s\u1ef1 th\u00e2n thi\u1ec7n v\u1eeba \u0111\u1ee7 theo \u0111\u00fang m\u1ea1ch n\u00f3i chuy\u1ec7n.',
      'Gi\u1eef ch\u1eebng m\u1ef1c, khen ch\u1ecdn l\u1ecdc v\u00e0 ch\u1ec9 n\u00f3i c\u1ee5 th\u1ec3 \u0111i\u1ec1u \u0111\u00e1ng ghi nh\u1eadn.',
      'Gi\u1eef phong th\u00e1i \u0111i\u1ec1m t\u0129nh, ki\u1ec7m l\u1eddi th\u1eeba v\u00e0 \u0111\u00fang chu\u1ea9n m\u1ef1c.',
    ]),
    wit: Object.freeze([
      'Tr\u1ef1c ti\u1ebfp, nghi\u00eam t\u00fac v\u00e0 g\u1ecdn g\u00e0ng, kh\u00f4ng pha tr\u00f2.',
      'H\u01b0\u1edfng \u1ee9ng vui nh\u1eb9 khi ng\u01b0\u1eddi d\u00f9ng \u0111ang tho\u1ea3i m\u00e1i.',
      'Th\u00eam ch\u00fat duy\u00ean nh\u1eb9 khi ng\u01b0\u1eddi d\u00f9ng m\u1edf l\u1eddi \u0111\u00f9a.',
      'Ch\u1ee7 \u0111\u1ed9ng b\u1eaft chi ti\u1ebft c\u00f3 duy\u00ean \u0111\u1ec3 kh\u00f4ng kh\u00ed tr\u00f2 chuy\u1ec7n sinh \u0111\u1ed9ng.',
      'Linh ho\u1ea1t, h\u00f3m h\u1ec9nh t\u1ef1 nhi\u00ean khi b\u1ed1i c\u1ea3nh cho ph\u00e9p.',
    ]),
    warmth: Object.freeze([
      'Ghi nh\u1eadn ng\u1eafn g\u1ecdn, l\u1ecbch s\u1ef1 chu\u1ea9n m\u1ef1c.',
      'Ghi nh\u1eadn c\u1ee5 th\u1ec3 \u0111\u00fang \u00fd ng\u01b0\u1eddi d\u00f9ng v\u1eeba n\u00eau.',
      'Ghi nh\u1eadn n\u1ed7 l\u1ef1c, ni\u1ec1m vui ho\u1eb7c v\u01b0\u1edbng m\u1eafc m\u1ed9t c\u00e1ch chu \u0111\u00e1o.',
      '\u0110\u00e1p ch\u00e2n th\u00e0nh, g\u1ea7n g\u0169i v\u00e0o \u0111\u00fang tr\u1ea3i nghi\u1ec7m th\u1ef1c t\u1ebf.',
      'L\u1eafng nghe s\u00e2u, tinh t\u1ebf v\u00e0 \u0111\u1ed3ng h\u00e0nh \u1ea5m \u00e1p nh\u01b0 ng\u01b0\u1eddi c\u1ed9ng s\u1ef1 tin c\u1eady.',
    ]),
    initiative: Object.freeze([
      '\u0110\u00e1p th\u1eb3ng \u00fd v\u1eeba h\u1ecfi r\u1ed3i d\u1eebng g\u1ecdn, \u0111\u1ec3 ng\u01b0\u1eddi d\u00f9ng d\u1eabn chuy\u1ec7n.',
      '\u0110\u00e1p th\u1eb3ng v\u00e0 g\u00f3p th\u00eam m\u1ed9t nh\u1eadn x\u00e9t ng\u1eafn h\u1eefu \u00edch.',
      '\u0110\u00e1p t\u1ef1 nhi\u00ean v\u00e0 g\u1ee3i m\u1ed9t \u00fd n\u1ed1i c\u1ee5 th\u1ec3 trong c\u00f9ng \u0111\u1ea7u vi\u1ec7c.',
      'Ch\u1ee7 \u0111\u1ed9ng \u0111\u1ec1 xu\u1ea5t b\u01b0\u1edbc ti\u1ebfp theo r\u00f5 r\u00e0ng \u0111\u1ec3 \u0111\u1ea9y vi\u1ec7c ch\u1ea1y nhanh.',
    ]),
    adaptive: Object.freeze([
      'Gi\u1eef nh\u1ecbp gi\u1ecdng \u1ed5n \u0111\u1ecbnh xuy\u00ean su\u1ed1t.',
      '\u0110i\u1ec1u ch\u1ec9nh nh\u1eb9 khi c\u00f3 t\u00edn hi\u1ec7u c\u1ea3m x\u00fac r\u00f5 r\u00e0ng.',
      'B\u1eaft nh\u1ecbp theo tin hi\u1ec7n t\u1ea1i v\u00e0 v\u00e0i l\u01b0\u1ee3t g\u1ea7n nh\u1ea5t.',
      'Nh\u1ea1y s\u1edbm v\u1edbi d\u1ea5u hi\u1ec7u \u00e1p l\u1ef1c, v\u1ed9i v\u00e0ng hay h\u00e0o h\u1ee9ng \u0111\u1ec3 \u0111\u1ed5i nh\u1ecbp ngay.',
    ]),
  }),
});

// Built-in public PlainSpeak packs (100% generic, zero internal/company terms).
export const BUILTIN_PLAIN_SPEAK_PACKS = Object.freeze({
  vi: Object.freeze({
    schemaVersion: 1,
    id: 'scroll-plain-speak-core-vi',
    locale: 'vi',
    protectedTerms: ['API', 'MCP', 'URL', 'PDF', 'CSV', 'XML', 'JSON', 'SQL', 'OTP'],
    registerSignals: {
      expertPatterns: [
        '\\b(?:webhook|endpoint|schema|token|payload|migration|latency|throughput|regex|diff)\\b',
        '\\b(?:kh\\u1ea5u tr\\u1eeb|k\\u1ebft chuy\\u1ec3n|quy\\u1ebft to\\u00e1n|b\\u00fat to\\u00e1n|c\\u00e2n \\u0111\\u1ed1i)\\b',
      ],
      clientPlainPatterns: [
        '\\b(?:d\\u1ec5 hi\\u1ec3u|gi\\u1ea3i th\\u00edch ng\\u1eafn|l\\u00e0 g\\u00ec|kh\\u00f4ng hi\\u1ec3u)\\b',
      ],
      confusionFeedbackPatterns: [
        '\\b(?:l\\u00e0 sao|l\\u00e0 c\\u00e1i g\\u00ec|n\\u00f3i d\\u1ec5 hi\\u1ec3u|kh\\u00f3 hi\\u1ec3u)\\b',
      ],
    },
    entries: [
      { term: 'ch\u1eafc ch\u1eafn r\u1ed3i!', plain: '', tier: 'A', action: 'swap' },
      { term: 't\u1ea5t nhi\u00ean r\u1ed3i!', plain: '', tier: 'A', action: 'swap' },
      { term: 'r\u1ea5t vui \u0111\u01b0\u1ee3c h\u1ed7 tr\u1ee3 b\u1ea1n', plain: '', tier: 'A', action: 'swap' },
      { term: 'c\u1ea3m \u01a1n b\u1ea1n \u0111\u00e3 chia s\u1ebb', plain: '', tier: 'A', action: 'swap' },
      { term: 'd\u01b0\u1edbi \u0111\u00e2y l\u00e0 c\u00e2u tr\u1ea3 l\u1eddi', plain: '', tier: 'A', action: 'swap' },
      { term: 't\u00f3m l\u1ea1i l\u00e0 nh\u01b0 v\u1eady', plain: 't\u00f3m g\u1ecdn l\u00e0', tier: 'A', action: 'swap' },
      { term: 't\u1ed1i \u01b0u h\u00f3a tr\u1ea3i nghi\u1ec7m', plain: 'l\u00e0m m\u01b0\u1ee3t h\u01a1n', tier: 'A', action: 'hint' },
      { term: '\u0111\u1ed9 tr\u1ec5 h\u1ec7 th\u1ed1ng', plain: 't\u1ed1c \u0111\u1ed9 ph\u1ea3n h\u1ed3i', tier: 'B', action: 'hint' },
      { term: 'ng\u1eef c\u1ea3nh h\u1ed9i tho\u1ea1i', plain: 'm\u1ea1ch n\u00f3i chuy\u1ec7n', tier: 'B', action: 'hint' },
    ],
  }),
  en: Object.freeze({
    schemaVersion: 1,
    id: 'scroll-plain-speak-core-en',
    locale: 'en',
    protectedTerms: ['API', 'MCP', 'URL', 'PDF', 'CSV', 'XML', 'JSON', 'SQL', 'OTP'],
    registerSignals: {
      expertPatterns: ['\\b(?:webhook|endpoint|schema|payload|migration|latency|throughput|regex)\\b'],
      clientPlainPatterns: ['\\b(?:plain english|simply|what does .* mean)\\b'],
      confusionFeedbackPatterns: ['\\b(?:confused|too technical|explain simply)\\b'],
    },
    entries: [
      { term: 'Certainly!', plain: '', tier: 'A', action: 'swap' },
      { term: 'Absolutely!', plain: '', tier: 'A', action: 'swap' },
      { term: 'I would be happy to help you with that.', plain: '', tier: 'A', action: 'swap' },
      { term: 'Great question!', plain: '', tier: 'A', action: 'swap' },
      { term: 'delve into', plain: 'look into', tier: 'A', action: 'hint' },
    ],
  }),
});

const SERIOUS_CUES_RE = /(?:^|[\s,.!?])(?:g\u1ea5p|kh\u1ea9n|l\u1ed7i|s\u1ef1 c\u1ed1|b\u1ef1c|sai r\u1ed3i|kh\u00f4ng \u0111\u00fang|th\u00f4i|\u0111\u1ec3 sau|urgent|asap|broken|wrong|stop|error|failed|outage|incident)(?=$|[\s,.!?])/iu;
const PLAYFUL_CUES_RE = /(?:\bhaha\b|\bhihi\b|\bhehe\b|\blol\b|\blmao\b|:\){2,}|[\u{1F602}\u{1F923}\u{1F604}\u{1F606}\u{1F605}\u{1F601}])/iu;
const SHORT_GROUP_SUMMON_RE = /^\s*(?:@[a-z0-9_]+\s+)?(?:em|e|b\u00e9|be|b\u1ea1n|bot|hey|yo)?\s*(?:\u01a1i|oi|ei|n\u00e8|ne|nh\u00e9|nhe)?\s*(?:cho \u00fd ki\u1ebfn|xem gi\u00fap|ngh\u0129 sao|sao r\u1ed3i|th\u1ea5y sao|thoughts\??|wdyt\??|check this)?\s*[?!.]*\s*$/iu;

// Control glitch scripts (unexpected CJK/Thai/Arabic/Devanagari tokens leaking into Latin/Vietnamese replies)
const GLITCH_SCRIPT_RE = /[\u3040-\u30FF\u3400-\u9FFF\u0E00-\u0E7F\u0600-\u06FF\u0900-\u097F]+/gu;

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeLangCode(lang) {
  const s = String(lang || 'en').trim().toLowerCase();
  if (s.startsWith('vi')) return 'vi';
  if (s.startsWith('ko')) return 'ko';
  if (s.startsWith('id')) return 'id';
  return 'en';
}

function normalizeVoiceMode(raw, fallback = 'auto') {
  const s = String(raw || '').trim().toLowerCase();
  return VOICE_MODES.includes(s) ? s : fallback;
}

/**
 * Resolves the effective voice & personality profile from pack defaults + tenant overrides.
 * Supports canonical `PERSONALITY_SCHEMA` weights and safely maps legacy pack weights.
 */
export function resolveVoiceProfile({
  language = 'vi',
  weights = null,
  packVoice = null,
  packDefaultWeights = null,
  domainPacks = [],
} = {}) {
  const lang = normalizeLangCode(language);
  const pv = packVoice && typeof packVoice === 'object' ? packVoice : {};
  const w = weights && typeof weights === 'object' ? weights : {};
  const pdw = packDefaultWeights && typeof packDefaultWeights === 'object' ? packDefaultWeights : {};

  const hasDistilledViPack = Array.isArray(domainPacks)
    && domainPacks.some((dp) => /vn-human-comm|vi-voice|vietnamese-voice/i.test(String(dp?.id || dp || '')));

  const presetCandidate = typeof w.preset === 'string' && PERSONALITY_PRESETS[w.preset]
    ? w.preset
    : (typeof pdw.preset === 'string' && PERSONALITY_PRESETS[pdw.preset] ? pdw.preset : 'ca-tinh');
  const basePreset = PERSONALITY_PRESETS[presetCandidate];
  const rawTraits = (w.traits && typeof w.traits === 'object')
    ? w.traits
    : ((pdw.traits && typeof pdw.traits === 'object') ? pdw.traits : {});

  const traits = {};
  const displayTraits = {};
  for (const spec of PERSONALITY_TRAITS) {
    const raw = clampInt(rawTraits[spec.key], spec.min, spec.max, basePreset.traits[spec.key]);
    traits[spec.key] = raw;
    displayTraits[spec.displayKey] = spec.polarity === 'inverted' ? (spec.max + spec.min - raw) : raw;
  }

  const initiative = clampInt(w.initiative ?? pdw.initiative, 0, 3, basePreset.initiative);
  const adaptiveLevel = clampInt(w.adaptiveLevel ?? pdw.adaptiveLevel, 0, 3, basePreset.adaptiveLevel);

  const allowHumanError = pv.allowHumanError !== false;
  const requestedMode = normalizeVoiceMode(w.voiceMode ?? pv.defaultMode ?? 'auto', 'auto');
  let effectiveMode = requestedMode;
  if (effectiveMode === 'auto') {
    effectiveMode = lang === 'vi' ? 'vi_natural' : 'basic';
  }
  const humanErrorRequested = typeof w.humanError === 'boolean'
    ? w.humanError
    : Boolean(pv.defaultHumanError);
  const humanErrorEnabled = Boolean(
    allowHumanError
    && effectiveMode === 'vi_natural'
    && humanErrorRequested,
  );
  const plainSpeakRegister = ['casual_human', 'client_plain', 'expert_peer'].includes(String(pv.plainSpeakDefaultRegister || ''))
    ? String(pv.plainSpeakDefaultRegister)
    : (effectiveMode === 'strict_pro' ? 'client_plain' : 'casual_human');

  const distilledLanguage = effectiveMode === 'vi_natural' ? 'vi' : null;
  const availableModes = [
    { id: 'auto', distilled: lang === 'vi' },
    { id: 'vi_natural', distilled: true, hasDomainPack: hasDistilledViPack },
    { id: 'basic', distilled: false },
    { id: 'strict_pro', distilled: false },
  ];

  return {
    schema: 'scroll-voice/v1',
    language: lang,
    requestedMode,
    effectiveMode,
    distilledLanguage,
    hasDistilledViPack,
    allowHumanError,
    humanError: humanErrorEnabled,
    plainSpeakRegister,
    smartBubbles: pv.smartBubbles !== false,
    preset: presetCandidate,
    traits,
    displayTraits,
    initiative,
    adaptiveLevel,
    availableModes,
  };
}

/**
 * Compiles personality sliders + voice mode into qualitative Region-C guidance.
 * Guaranteed sec 43 compliant (zero bare numeric sliders).
 */
export function compilePersonalityCues(profile, {
  userText = '',
  recentUserTexts = [],
  isGroup = false,
} = {}) {
  const p = profile && typeof profile === 'object' ? profile : resolveVoiceProfile();
  const useVi = p.effectiveMode === 'vi_natural' || (p.language === 'vi' && p.effectiveMode !== 'basic');
  const bank = useVi ? TRAIT_BEHAVIOR_CUES.vi : TRAIT_BEHAVIOR_CUES.en;
  const sample = String(userText || '').slice(0, 400);
  const recentJoined = [sample, ...(Array.isArray(recentUserTexts) ? recentUserTexts.slice(-2) : [])].join(' ');
  const isSerious = SERIOUS_CUES_RE.test(sample) || (p.adaptiveLevel >= 2 && SERIOUS_CUES_RE.test(recentJoined));
  const isPlayful = !isSerious && p.adaptiveLevel >= 1 && PLAYFUL_CUES_RE.test(sample);
  const isShortGroupSummon = Boolean(isGroup && sample.length <= 80 && SHORT_GROUP_SUMMON_RE.test(sample));

  const lines = [];
  if (p.effectiveMode === 'vi_natural') {
    lines.push('[Voice Mode: Vietnamese Natural]');
    lines.push(
      'N\u00f3i ti\u1ebfng Vi\u1ec7t t\u1ef1 nhi\u00ean nh\u01b0 ng\u01b0\u1eddi Vi\u1ec7t nh\u1eafn chat ngo\u00e0i \u0111\u1eddi: tr\u00e1nh v\u0103n d\u1ecbch m\u00e1y, tr\u00e1nh r\u00e0o \u0111\u00f3n h\u1ecdc thu\u1eadt hay v\u0103n m\u1eabu AI; n\u00f3i th\u1eb3ng v\u00e0o \u00fd ch\u00ednh.',
    );
    if (p.smartBubbles) {
      lines.push(
        'Khi c\u00f3 t\u1eeb hai \u00fd r\u00f5 r\u1ec7t tr\u1edf l\u00ean (kh\u00f4ng ph\u1ea3i b\u1ea3ng hay code), c\u00f3 th\u1ec3 t\u00e1ch g\u1ecdn b\u1eb1ng d\u00f2ng tr\u1ed1ng th\u00e0nh 2-3 nh\u1ecbp tin ng\u1eafn d\u1ec5 \u0111\u1ecdc.',
      );
    }
  } else if (p.effectiveMode === 'strict_pro') {
    lines.push('[Voice Mode: High-Precision Professional]');
    lines.push(
      useVi
        ? 'Gi\u1eef phong th\u00e1i chuy\u00ean gia ch\u00ednh x\u00e1c: \u0111\u01b0a k\u1ebft lu\u1eadn v\u00e0 c\u0103n c\u1ee9 tr\u01b0\u1edbc, kh\u00f4ng d\u00f9ng ti\u1ebfng l\u00f3ng hay vi\u1ebft t\u1eaft su\u1ed3ng s\u00e3, b\u1ea3o to\u00e0n nguy\u00ean v\u1eb9n m\u1ecdi con s\u1ed1 v\u00e0 m\u00e3 hi\u1ec7u.'
        : 'Maintain high-precision professional tone: lead with conclusions and verified facts, avoid slang or casual shortcuts, preserve every number and citation verbatim.',
    );
  } else {
    lines.push('[Voice Mode: Natural Basic]');
    lines.push(
      'Reply naturally and concisely in the exact language of the user, avoiding robotic filler, stiff phrasing, or unnecessary preambles.',
    );
  }

  const traitCues = [
    bank.assertiveness[clampInt(p.traits?.assertiveness, 1, 5, 3) - 1],
    bank.reserve[clampInt(p.traits?.reserve, 1, 5, 2) - 1],
    isSerious ? bank.wit[0] : bank.wit[clampInt(p.traits?.wit, 1, 5, 2) - 1],
    bank.warmth[clampInt(p.traits?.warmth, 1, 5, 3) - 1],
    isSerious ? bank.initiative[0] : bank.initiative[clampInt(p.initiative, 0, 3, 1)],
    bank.adaptive[clampInt(p.adaptiveLevel, 0, 3, 2)],
  ].filter(Boolean);

  lines.push(...traitCues.map((c) => `- ${c}`));

  if (isSerious) {
    lines.push(
      useVi
        ? '- M\u1ea1ch hi\u1ec7n t\u1ea1i nghi\u00eam t\u00fac ho\u1eb7c c\u1ea7n x\u1eed l\u00fd g\u1ea5p: b\u1ecf h\u1eb3n \u0111\u00f9a vui v\u00e0 icon, \u0111i th\u1eb3ng v\u00e0o gi\u1ea3i ph\u00e1p.'
        : '- Current turn is serious or urgent: skip humor/emojis and go straight to the solution.',
    );
  } else if (isPlayful) {
    lines.push(
      useVi
        ? '- Ng\u01b0\u1eddi d\u00f9ng \u0111ang tho\u1ea3i m\u00e1i vui v\u1ebb: b\u1eaft nh\u1ecbp t\u1ef1 nhi\u00ean v\u00e0 nh\u1eb9 nh\u00e0ng.'
        : '- User tone is light and playful: match their warmth naturally.',
    );
  }

  if (isShortGroupSummon) {
    lines.push(
      useVi
        ? '- \u0110ang \u0111\u01b0\u1ee3c g\u1ecdi nhanh trong nh\u00f3m: b\u1eaft s\u00f3ng ngay m\u1ea1ch tr\u00f2 chuy\u1ec7n g\u1ea7n nh\u1ea5t ph\u00eda tr\u00ean, kh\u00f4ng h\u1ecfi ng\u01b0\u1ee3c m\u00e1y m\u00f3c.'
        : '- Short group summon detected: immediately respond using the recent room context above without robotic disclaimers.',
    );
  }

  const out = lines.join('\n').trim();
  if (hasBareNumericSlider(out)) {
    throw new Error('ERR_VOICE_BARE_NUMERIC_SLIDER_FORBIDDEN');
  }
  return { text: out, isSerious, isPlayful, isShortGroupSummon };
}

/**
 * Strips unexpected non-Latin/non-Vietnamese glitch tokens (e.g. stray CJK/Thai/Arabic)
 * unless the user prompt itself contained that script.
 */
export function sanitizeControlGlitches(text, { userText = '', language = 'vi' } = {}) {
  const src = String(text ?? '');
  if (!src) return src;
  const lang = normalizeLangCode(language);
  if (lang === 'ko') return src;
  if (GLITCH_SCRIPT_RE.test(String(userText || ''))) return src;
  GLITCH_SCRIPT_RE.lastIndex = 0;
  if (!GLITCH_SCRIPT_RE.test(src)) return src;
  GLITCH_SCRIPT_RE.lastIndex = 0;
  const cleaned = src
    .replace(GLITCH_SCRIPT_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .trim();
  return cleaned || src;
}

/**
 * Splits a reply into 1..maxBubbles natural chat bubbles without breaking code fences,
 * markdown lists, or tables, and safely chunks long outputs (> maxChunkChars) on boundaries.
 */
export function splitSmartBubbles(text, {
  smartBubbles = true,
  maxBubbles = 3,
  minSplitChars = 160,
  maxChunkChars = 3900,
} = {}) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [''];

  const hardChunk = (chunk) => {
    const s = String(chunk || '').trim();
    if (s.length <= maxChunkChars) return [s];
    const out = [];
    let rest = s;
    while (rest.length > maxChunkChars) {
      let cut = rest.lastIndexOf('\n\n', maxChunkChars);
      if (cut < Math.floor(maxChunkChars * 0.45)) cut = rest.lastIndexOf('\n', maxChunkChars);
      if (cut < Math.floor(maxChunkChars * 0.45)) cut = rest.lastIndexOf('. ', maxChunkChars);
      if (cut < Math.floor(maxChunkChars * 0.45)) cut = rest.lastIndexOf(' ', maxChunkChars);
      if (cut < Math.floor(maxChunkChars * 0.3)) cut = maxChunkChars;
      else if (rest[cut] === '.') cut += 1;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  };

  // Explicit `[[bubble]]` markers always split cleanly
  if (raw.includes('[[bubble]]')) {
    const explicit = raw.split(/\s*\[\[bubble\]\]\s*/g).map((s) => s.trim()).filter(Boolean);
    if (explicit.length) {
      const capped = explicit.length > maxBubbles
        ? [...explicit.slice(0, maxBubbles - 1), explicit.slice(maxBubbles - 1).join('\n\n')]
        : explicit;
      return capped.flatMap(hardChunk);
    }
  }

  if (!smartBubbles || raw.length < minSplitChars || /```/.test(raw) || /^\s*\|.+\|\s*$/m.test(raw)) {
    return hardChunk(raw);
  }

  const paragraphs = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) {
    return hardChunk(raw);
  }
  // Keep bullet/numbered lists together with their intro paragraph
  const isListPara = (p) => /^(?:[-*\u2022]|\d+[.)])\s+/.test(p);
  const grouped = [];
  for (const para of paragraphs) {
    if (grouped.length > 0 && isListPara(para)) {
      grouped[grouped.length - 1] = `${grouped[grouped.length - 1]}\n\n${para}`;
    } else {
      grouped.push(para);
    }
  }

  if (grouped.length < 2) {
    return hardChunk(grouped[0] || raw);
  }
  const capped = grouped.length > maxBubbles
    ? [...grouped.slice(0, maxBubbles - 1), grouped.slice(maxBubbles - 1).join('\n\n')]
    : grouped;
  return capped.flatMap(hardChunk);
}

/**
 * Opt-in Claim-Safe conversational texture for `vi_natural` mode.
 * Strictly disabled for `strict_pro`, serious/high-stakes turns, or packs with `allowHumanError: false`.
 * Always verified by SCROLL sec 43 `verifyClaimsInvariant` — zero numbers, dates, codes, or URLs can drift.
 */
export function applyClaimSafeHumanTexture(text, {
  enabled = false,
  allowHumanError = true,
  effectiveMode = 'basic',
  isSerious = false,
  isHighStakes = false,
  dateOrder = 'dmy',
} = {}) {
  const original = String(text ?? '');
  if (!enabled || !allowHumanError || effectiveMode !== 'vi_natural' || isSerious || isHighStakes) {
    return { text: original, applied: false };
  }
  if (!original || original.length > 360 || /```|https?:\/\/|\bTK\s*\d/i.test(original)) {
    return { text: original, applied: false };
  }
  // Safe micro-texture: soften overly rigid trailing periods on short single-sentence casual chats only
  let cand = original;
  if (!cand.includes('\n') && cand.length <= 120 && /[^\d.?!:)]$/.test(cand) === false && /[^.\d]\.$/.test(cand)) {
    cand = cand.slice(0, -1);
  }
  if (cand === original) {
    return { text: original, applied: false };
  }
  const inv = verifyClaimsInvariant(original, cand, { dateOrder });
  if (!inv.ok) {
    return { text: original, applied: false, invariantFallback: true };
  }
  return { text: cand, applied: true };
}

function loadPackPlainSpeakPacks(packDir, agentName, lang) {
  const packs = [];
  const builtin = BUILTIN_PLAIN_SPEAK_PACKS[lang === 'vi' ? 'vi' : 'en'];
  if (builtin) packs.push(builtin);
  if (packDir && agentName) {
    const candidate = path.join(packDir, 'agents', agentName, 'plain-speak.json');
    if (fs.existsSync(candidate)) {
      try {
        packs.push(loadPlainSpeakPackFromFile(candidate));
      } catch { /* ignore malformed optional pack file */ }
    }
  }
  return packs;
}

/**
 * Creates integrated `voiceHooks` + `plainSpeak` engine for `ScrollAgentHost`.
 * Re-reads `workspace.readWeightsOverride()` live on every turn so UI slider/mode changes
 * take effect immediately with zero host restart!
 */
export function createHostVoiceRuntime({
  workspace = null,
  packDir = null,
  agentName = null,
  packManifest = null,
  language = 'vi',
  stateDir = null,
  accountId = 'default',
  getExtraWeights = null,
} = {}) {
  const packVoice = packManifest?.voice && typeof packManifest.voice === 'object' ? packManifest.voice : null;
  const packDefaultWeights = packManifest?.defaultWeights && typeof packManifest.defaultWeights === 'object'
    ? packManifest.defaultWeights
    : null;
  const domainPacks = Array.isArray(packManifest?.domainPacks) ? packManifest.domainPacks : [];

  function readCurrentProfile(overrideWeights = null) {
    const wsWeights = workspace && typeof workspace.readWeightsOverride === 'function'
      ? workspace.readWeightsOverride()
      : null;
    const extraWeights = typeof getExtraWeights === 'function' ? getExtraWeights() : null;
    const merged = {
      ...(wsWeights && typeof wsWeights === 'object' ? wsWeights : {}),
      ...(extraWeights && typeof extraWeights === 'object' ? extraWeights : {}),
      ...(overrideWeights && typeof overrideWeights === 'object' ? overrideWeights : {}),
    };
    return resolveVoiceProfile({
      language,
      weights: Object.keys(merged).length ? merged : null,
      packVoice,
      packDefaultWeights,
      domainPacks,
    });
  }

  let activeProfile = readCurrentProfile();
  let plainSpeakEngine = null;

  function rebuildPlainSpeak(profile) {
    try {
      const packs = loadPackPlainSpeakPacks(packDir, agentName, profile.language);
      plainSpeakEngine = createPlainSpeakEngine({
        packs,
        config: {
          enabled: true,
          mode: 'live',
          locale: profile.effectiveMode === 'vi_natural' ? 'vi' : profile.language,
          defaultRegister: profile.plainSpeakRegister,
          rewriteEnabled: false, // 0-extra-LLM deterministic swap + Region-C pre-gen cue for fast SaaS latency
        },
        stateDir,
        accountId,
      });
    } catch {
      plainSpeakEngine = null;
    }
    return plainSpeakEngine;
  }

  rebuildPlainSpeak(activeProfile);

  function reload(overrideWeights = null) {
    activeProfile = readCurrentProfile(overrideWeights);
    rebuildPlainSpeak(activeProfile);
    return activeProfile;
  }

  const voiceHooks = {
    async beforeTurn({ text = '', history = [], isGroup = false } = {}) {
      activeProfile = readCurrentProfile();
      const recentUserTexts = (Array.isArray(history) ? history : [])
        .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
        .slice(-3)
        .map((h) => h.content);
      const compiled = compilePersonalityCues(activeProfile, {
        userText: text,
        recentUserTexts,
        isGroup: Boolean(isGroup),
      });
      return {
        stableSystemBlock: '',
        volatileTurnBlock: compiled.text,
        voiceProfile: activeProfile,
        isSerious: compiled.isSerious,
        isPlayful: compiled.isPlayful,
        isShortGroupSummon: compiled.isShortGroupSummon,
        userText: String(text || ''),
      };
    },

    async shapeOutgoing({ text = '', rawText = '', isGroup = false, turnBudget = null, voiceBefore = null } = {}) {
      const profile = voiceBefore?.voiceProfile || activeProfile;
      const baseText = String(text || rawText || '').trim();
      if (!baseText) return { text: baseText, bubbles: [baseText], meta: { voiceMode: profile.effectiveMode } };

      const deglitched = sanitizeControlGlitches(baseText, {
        userText: voiceBefore?.userText || '',
        language: profile.language,
      });
      const textured = applyClaimSafeHumanTexture(deglitched, {
        enabled: profile.humanError,
        allowHumanError: profile.allowHumanError,
        effectiveMode: profile.effectiveMode,
        isSerious: Boolean(voiceBefore?.isSerious),
        isHighStakes: Boolean(turnBudget?.isHighStakes),
      });
      const bubbles = splitSmartBubbles(textured.text, {
        smartBubbles: profile.smartBubbles,
        maxBubbles: isGroup ? 2 : 3,
      });
      const finalJoined = bubbles.join('\n\n');
      return {
        text: finalJoined,
        bubbles,
        meta: {
          voiceMode: profile.effectiveMode,
          distilledLanguage: profile.distilledLanguage,
          humanErrorApplied: Boolean(textured.applied),
          bubblesCount: bubbles.length,
        },
      };
    },
  };

  return {
    voiceHooks,
    get plainSpeak() { return plainSpeakEngine; },
    describeVoice: (overrideWeights = null) => readCurrentProfile(overrideWeights),
    reload,
  };
}
