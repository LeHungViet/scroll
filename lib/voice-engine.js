// SCROLL 2.12 -- Public-Ready Multilingual Voice Platform v4 (`lib/voice-engine.js`).
// Zero-dep, pure ASCII source (public-repo-gate compliant), Node >= 20.
//
// Two-Layer Architecture:
//   Layer 1 (Public Core in SCROLL):
//     - Language-agnostic conversational voice core (`affect`, `anti-essay`, `behavior`,
//       `persona`, `preset-catalog` [3 Genders x 7 Roles], `eq-engine`, `mode-escalation`,
//       `style-system`, `human-error` v2 with 3 claim-safe mechanisms).
//     - Pluggable PII-free distilled locale packs (`vi-VN` pack + `voice-dna-bundle`,
//       `move-playbook-pack`, `style-bank`, `plain-speak-core-vi`, `plain-speak-accounting-vi`).
//   Layer 2 (Agent Packs & Tenant Overrides):
//     - Pack manifest declares default voice gender, role, mode, plainSpeakPack, and humanError.
//     - Any user on any host can choose Gender (Female/Male/Neutral), Role Archetype,
//       Personality Sliders, Voice Mode, and Claim-Safe Human Error v2 with zero hardcoding.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyClaimsInvariant } from './grounding.js';
import { hasBareNumericSlider } from './style.js';
import { createPlainSpeakEngine, loadPlainSpeakPackFromFile } from './chat-sdk/plain-speak.js';
import { PERSONALITY_PRESETS, PERSONALITY_TRAITS } from './introspection.js';
import {
  VOICE_GENDERS,
  VOICE_ROLES,
  VOICE_PRESETS,
  VOICE_PRESET_IDS,
  isValidVoicePreset,
  listVoicePresets,
  resolveVoicePreset,
  renderVoicePresetSystem,
  toScrollVoiceConfig,
  createAffectState,
  updateAffectState,
  renderAffectCue,
  renderAntiEssayGuidance,
  stripEssayMarkdown,
  applyHumanError,
  claimsUnchanged,
  analyzeIncomingBehavior,
  planDelivery,
  detectCustomerRapport,
  detectSubtext,
  extractTopicAnchors,
  selectCallbackAnchor,
  renderEqIntelligenceCue,
  selectCompanionReaction,
  evaluateModeEscalation,
  extractIcons,
  selectHumorMove,
  selectIconPaletteHint,
  selectMovePlaybookCue,
  selectLengthCadence,
  detectRepeatedSingleOpener,
  detectDisallowedOpener,
  detectBluntMasculineOpener,
  resolveVoiceDnaSlice,
  renderVoiceDnaCue,
} from './voice/core/index.js';
import { viVNPack } from './voice/locales/vi-VN/pack.js';

export {
  VOICE_GENDERS,
  VOICE_ROLES,
  VOICE_PRESETS,
  VOICE_PRESET_IDS,
  isValidVoicePreset,
  listVoicePresets,
  resolveVoicePreset,
  renderVoicePresetSystem,
  applyHumanError,
  claimsUnchanged,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VOICE_DATA_DIR = path.join(__dirname, 'voice', 'data');

export const VOICE_MODES = Object.freeze(['auto', 'vi_natural', 'basic', 'strict_pro']);

export const DEFAULT_VOICE_CONFIG = Object.freeze({
  mode: 'auto',
  gender: 'female',
  role: 'assistant',
  humanError: false,
  allowHumanError: true,
  plainSpeakRegister: 'casual_human',
  plainSpeakPack: 'core-vi',
  smartBubbles: true,
});

// Lazy-cached PII-free distilled Vietnamese voice intelligence bundles
let _cachedData = null;
function loadVoiceDataBundles() {
  if (_cachedData) return _cachedData;
  const readJson = (name) => {
    const fp = path.join(VOICE_DATA_DIR, name);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      return null;
    }
  };
  _cachedData = {
    voiceDnaBundle: readJson('voice-dna-bundle.json'),
    movePlaybook: readJson('move-playbook-pack.json'),
    styleBank: readJson('style-bank.json'),
    plainSpeakCoreVi: readJson('plain-speak-core-vi.json'),
    plainSpeakAccountingVi: readJson('plain-speak-accounting-vi.json'),
  };
  return _cachedData;
}

/**
 * Returns the canonical JSON-serializable Voice Platform v4 catalog
 * (3 genders x 7 roles x 16 presets + voice modes) so UIs never hardcode options.
 */
export function getVoiceCatalog() {
  const genders = Object.values(VOICE_GENDERS).map((g) => ({
    id: g.id,
    label: g.label,
    shortLabel: g.shortLabel,
  }));
  const roles = Object.values(VOICE_ROLES).map((r) => ({
    id: r.id,
    group: r.group,
    title: r.title,
    shortTitle: r.shortTitle,
    description: r.description,
    genders: [...r.genders],
    defaultHumanError: {
      texturePercent: Number(r.humanError?.texturePercent ?? 0),
      correctionPercent: Number(r.humanError?.correctionPercent ?? 0),
      locked: Boolean(r.humanError?.locked),
    },
  }));
  const presets = listVoicePresets().map((p) => ({
    id: p.id,
    genderId: p.gender.id,
    roleId: p.role.id,
    title: `${p.role.shortTitle} (${p.gender.shortLabel})`,
    roleTitle: p.role.title,
    description: p.role.description,
    humanError: {
      texturePercent: Number(p.role.humanError?.texturePercent ?? 0),
      correctionPercent: Number(p.role.humanError?.correctionPercent ?? 0),
      locked: Boolean(p.role.humanError?.locked),
    },
  }));
  return {
    schema: 'scroll-voice-catalog/v1',
    genders,
    roles,
    presets,
    modes: [...VOICE_MODES],
  };
}

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

function resolveCanonicalPreset(requestedGender, requestedRole, requestedPreset) {
  let gender = typeof requestedGender === 'string' && Object.hasOwn(VOICE_GENDERS, requestedGender)
    ? requestedGender
    : null;
  let role = typeof requestedRole === 'string' && Object.hasOwn(VOICE_ROLES, requestedRole)
    ? requestedRole
    : null;
  if (typeof requestedPreset === 'string' && isValidVoicePreset(requestedPreset)) {
    const [pGender, ...rest] = requestedPreset.split('.');
    const pRole = rest.join('.');
    if (!gender && Object.hasOwn(VOICE_GENDERS, pGender)) gender = pGender;
    if (!role && Object.hasOwn(VOICE_ROLES, pRole)) role = pRole;
  }
  role = role || 'assistant';
  const roleDef = VOICE_ROLES[role] || VOICE_ROLES.assistant;
  if (!gender || !roleDef.genders.includes(gender)) {
    gender = roleDef.genders[0] || 'female';
  }
  const presetId = `${gender}.${role}`;
  const validPresetId = isValidVoicePreset(presetId) ? presetId : 'female.assistant';
  const resolved = resolveVoicePreset(validPresetId);
  return {
    voiceGender: resolved.genderId,
    voiceRole: resolved.roleId,
    voicePreset: resolved.id,
    resolvedPreset: resolved,
  };
}

/**
 * Resolves the effective Voice Platform v4 profile from pack defaults + tenant overrides.
 * Supports Gender (female/male/neutral), Role Archetype (7 roles), 6 sliders, Voice Mode,
 * and Claim-Safe Human Error v2 rates.
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
  const hasTaxDomainPack = Array.isArray(domainPacks)
    && domainPacks.some((dp) => /accounting|tax|bhxh/i.test(String(dp?.id || dp || '')));

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

  const canonical = resolveCanonicalPreset(
    w.voiceGender ?? pv.defaultGender ?? pdw.voiceGender ?? null,
    w.voiceRole ?? pv.defaultRole ?? pdw.voiceRole ?? null,
    w.voicePreset ?? pv.defaultVoicePreset ?? pdw.voicePreset ?? null,
  );

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

  // Resolve Human Error v2 rates from role archetype (with gentle safe fallback for roles whose legacy preset was 0%)
  const roleHe = canonical.resolvedPreset?.role?.humanError || {};
  const baseTex = roleHe.texturePercent > 0 ? roleHe.texturePercent : 18;
  const baseCor = roleHe.correctionPercent > 0 ? roleHe.correctionPercent : 4;
  const texturePercent = humanErrorEnabled
    ? clampInt(w.humanErrorTexturePercent, 0, 50, baseTex)
    : 0;
  const correctionPercent = humanErrorEnabled
    ? clampInt(w.humanErrorCorrectionPercent, 0, 10, baseCor)
    : 0;
  const appendPercent = humanErrorEnabled ? Math.min(24, Math.max(10, Math.round(texturePercent * 0.6))) : 0;

  const plainSpeakRegister = ['casual_human', 'client_plain', 'expert_peer'].includes(String(pv.plainSpeakDefaultRegister || ''))
    ? String(pv.plainSpeakDefaultRegister)
    : (effectiveMode === 'strict_pro' ? 'client_plain' : 'casual_human');
  const plainSpeakPack = typeof pv.plainSpeakPack === 'string' && pv.plainSpeakPack.trim()
    ? pv.plainSpeakPack.trim()
    : (hasTaxDomainPack ? 'accounting-vi' : 'core-vi');

  const distilledLanguage = effectiveMode === 'vi_natural' ? 'vi' : null;
  const availableModes = [
    { id: 'auto', distilled: lang === 'vi' },
    { id: 'vi_natural', distilled: true, hasDomainPack: hasDistilledViPack },
    { id: 'basic', distilled: false },
    { id: 'strict_pro', distilled: false },
  ];

  return {
    schema: 'scroll-voice/v2',
    language: lang,
    requestedMode,
    effectiveMode,
    distilledLanguage,
    hasDistilledViPack,
    voiceGender: canonical.voiceGender,
    voiceRole: canonical.voiceRole,
    voicePreset: canonical.voicePreset,
    allowHumanError,
    humanError: humanErrorEnabled,
    humanErrorRates: {
      texturePercent,
      correctionPercent,
      appendPercent,
    },
    plainSpeakRegister,
    plainSpeakPack,
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
        'Khi c\u00f3 t\u1eeb hai \u00fd r\u00f5 r\u1ec7t tr\u1edf l\u00ean (kh\u00f4ng ph\u1ea3i b\u1ea3ng hay code), c\u00f3 th\u1ec3 t\u00e1ch g\u1ecdn b\u1eb1ng [[bubble]] ho\u1eb7c d\u00f2ng tr\u1ed1ng th\u00e0nh nh\u1ecbp tin ng\u1eafn d\u1ec5 \u0111\u1ecdc.',
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
 * Full Claim-Safe Human Error v2 wrapper (delegates to canonical `lib/voice/core/human-error.js`
 * + `vi-VN` locale pack, strictly verified by SCROLL sec 43 `verifyClaimsInvariant`).
 *
 * Three authentic human chat mechanisms (hard-locked 0% on numbers, money, dates, codes,
 * URLs, lists, code fences, serious/listen/execute stances, or `strict_pro`):
 *   1. `early_send_append`: natural trailing afterthought split into delayed second bubble
 *   2. `edit_message_repair` / `followup_correction`: subtle Telex/IME slip -> auto-repair
 *      via Telegram `editMessageText` (1.8-3.4s) or `*correct_word` fallback
 *   3. `lowercase_opening` / `colloquial_ending` + soft trailing-dot drop on short casual lines
 */
export function applyClaimSafeHumanTexture(text, {
  enabled = false,
  allowHumanError = true,
  effectiveMode = 'basic',
  isSerious = false,
  isHighStakes = false,
  stance = 'collaborate',
  hardGuard = null,
  capabilities = { edit: false, bubbles: true },
  rates = null,
  seed = 'turn',
  dateOrder = 'dmy',
} = {}) {
  const inputBubbles = Array.isArray(text) ? text.map(String) : [String(text ?? '')];
  const originalJoined = inputBubbles.join('\n');
  const untouched = {
    text: originalJoined,
    bubbles: inputBubbles,
    applied: false,
    kind: null,
    editPlan: null,
    appendDelayMs: null,
  };
  if (!enabled || !allowHumanError || effectiveMode !== 'vi_natural' || isSerious || isHighStakes) {
    return untouched;
  }
  if (!originalJoined.trim()) return untouched;

  const textureRate = Math.max(0, Math.min(0.5, Number(rates?.texturePercent ?? 22) / 100));
  const correctionRate = Math.max(0, Math.min(0.15, Number(rates?.correctionPercent ?? 5) / 100));
  const appendRate = Math.max(0, Math.min(0.3, Number(rates?.appendPercent ?? 14) / 100));

  const res = applyHumanError(inputBubbles, {
    config: {
      human_error: {
        enabled: true,
        locked: false,
        textureRate,
        correctionRate,
        appendRate,
      },
    },
    stance,
    hardGuard,
    capabilities,
    localePack: viVNPack,
    seed,
  });

  if (res.applied) {
    const outBubbles = Array.isArray(res.bubbles) && res.bubbles.length ? res.bubbles : inputBubbles;
    const outJoined = outBubbles.join('\n');
    const inv = verifyClaimsInvariant(originalJoined, outJoined, { dateOrder });
    const invInit = res.editPlan?.initialText
      ? verifyClaimsInvariant(originalJoined, res.editPlan.initialText, { dateOrder })
      : { ok: true };
    if (!inv.ok || !invInit.ok) {
      return { ...untouched, invariantFallback: true };
    }
    return {
      text: outJoined,
      bubbles: outBubbles,
      applied: true,
      kind: res.applied,
      editPlan: res.editPlan || null,
      appendDelayMs: res.appendDelayMs || null,
    };
  }

  // Fallback gentle micro-texture on short single-sentence casual chats when hash missed the 3 main hooks
  if (
    inputBubbles.length === 1
    && !originalJoined.includes('\n')
    && originalJoined.length <= 120
    && !/[\d`<>[\]@"'/\\]|https?:|\bTK\s*\d/i.test(originalJoined)
    && /[^.\d]\.$/.test(originalJoined)
  ) {
    const softened = originalJoined.slice(0, -1);
    const inv = verifyClaimsInvariant(originalJoined, softened, { dateOrder });
    if (inv.ok) {
      return {
        text: softened,
        bubbles: [softened],
        applied: true,
        kind: 'soft_trailing_dot',
        editPlan: null,
        appendDelayMs: null,
      };
    }
  }

  return untouched;
}

function loadPackPlainSpeakPacks(packDir, agentName, profile) {
  const bundles = loadVoiceDataBundles();
  const packs = [];
  if (profile.language === 'vi' || profile.effectiveMode === 'vi_natural') {
    if (bundles.plainSpeakCoreVi) packs.push(bundles.plainSpeakCoreVi);
    else if (BUILTIN_PLAIN_SPEAK_PACKS.vi) packs.push(BUILTIN_PLAIN_SPEAK_PACKS.vi);
    if (profile.plainSpeakPack === 'accounting-vi' && bundles.plainSpeakAccountingVi) {
      packs.push(bundles.plainSpeakAccountingVi);
    }
  } else if (BUILTIN_PLAIN_SPEAK_PACKS.en) {
    packs.push(BUILTIN_PLAIN_SPEAK_PACKS.en);
  }
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

function buildStableSystemBlock(profile, resolvedPreset) {
  const parts = [];
  if (resolvedPreset) {
    const presetSys = renderVoicePresetSystem(resolvedPreset);
    if (presetSys && !hasBareNumericSlider(presetSys)) {
      parts.push(presetSys);
    }
  }
  if (profile.effectiveMode === 'vi_natural') {
    const allowAbbrev = Boolean(profile.humanError && !['service'].includes(profile.voiceRole));
    parts.push([
      '## Quy t\u1eafc gi\u1ecdng chat ti\u1ebfng Vi\u1ec7t t\u1ef1 nhi\u00ean (SCROLL Voice Platform v4)',
      '1. N\u00f3i g\u1ecdn nh\u01b0 ng\u01b0\u1eddi th\u1eadt nh\u1eafn tin: \u00fd \u0111\u01a1n g\u00f3i trong 1 tin ng\u1eafn; khi c\u00f3 2-3 \u00fd r\u00f5 r\u1ec7t ch\u1ee7 \u0111\u1ed9ng t\u00e1ch g\u1ecdn b\u1eb1ng [[bubble]] \u0111\u1ee9ng ri\u00eang 1 d\u00f2ng — kh\u00f4ng \u0111\u1ed5 t\u01b0\u1eddng ch\u1eef d\u00e0i.',
      '2. C\u00f3 quan \u0111i\u1ec3m r\u00f5 r\u00e0ng, tuy\u1ec7t \u0111\u1ed1i kh\u00f4ng nh\u1ea1i l\u1ea1i c\u00e2u h\u1ecfi hay r\u00e0o \u0111\u00f3n robot ("C\u1ea3m \u01a1n anh \u0111\u00e3 h\u1ecfi...", "Em hi\u1ec3u anh lo..."). V\u00e0o th\u1eb3ng k\u1ebft lu\u1eadn ngay ch\u1eef \u0111\u1ea7u.',
      allowAbbrev
        ? '3. M\u1eb7c \u0111\u1ecbnh t\u1ec9nh l\u01b0\u1ee3c ch\u1ee7 ng\u1eef t\u1ef1 nhi\u00ean; \u0111\u01b0\u1ee3c d\u00f9ng vi\u1ebft t\u1eaft nh\u1eb9 \u0111\u1eddi th\u01b0\u1eddng (\u0111c, k, nhg, r, j) trong chat tho\u1ea3i m\u00e1i nh\u01b0ng gi\u1eef ch\u1eef chu\u1ea9n 100% \u1edf s\u1ed1 li\u1ec7u, ng\u00e0y gi\u1edd, m\u00e3 s\u1ed1, \u0111i\u1ec1u lu\u1eadt. Kh\u00f4ng t\u1ef1 c\u1ed1 t\u00ecnh g\u00f5 sai (t\u1ea7ng giao nh\u1eadn t\u1ef1 x\u1eed l\u00fd Human Error an to\u00e0n).'
        : '3. T\u1ec9nh l\u01b0\u1ee3c ch\u1ee7 ng\u1eef t\u1ef1 nhi\u00ean, gi\u1eef ti\u1ebfng Vi\u1ec7t r\u00f5 ch\u1eef kh\u00f4ng vi\u1ebft t\u1eaft chat hay l\u1ed7i ch\u00ednh t\u1ea3, tr\u00e1nh v\u0103n d\u1ecbch m\u00e1y v\u00e0 kh\u00f4ng l\u1eb7p \u0111u\u00f4i "nh\u00e9/\u1ea1" li\u00ean ti\u1ebfp.',
      '4. Kh\u00f4ng d\u00f9ng **in \u0111\u1eadm**, *in nghi\u00eang*, ti\u00eau \u0111\u1ec1 ### hay d\u1ea5u ; trong chat th\u01b0\u1eddng. Gi\u1eef 100% ch\u00ednh x\u00e1c m\u1ecdi con s\u1ed1, m\u00e3 hi\u1ec7u, URL.',
    ].join('\n'));
    if (!['service', 'sales'].includes(profile.voiceRole) && Array.isArray(viVNPack.proDropFewShots) && viVNPack.proDropFewShots.length) {
      parts.push(`M\u1eabu chat ti\u1ebfng Vi\u1ec7t t\u1ef1 nhi\u00ean:\n${viVNPack.proDropFewShots.slice(0, 3).join('\n')}`);
    }
  }
  const out = parts.join('\n\n').trim();
  return hasBareNumericSlider(out) ? '' : out;
}

/**
 * Creates integrated Voice Platform v4 `voiceHooks` + `plainSpeak` engine for `ScrollAgentHost`.
 * Re-reads `workspace.readWeightsOverride()` live on every turn so UI gender/role/slider/mode
 * changes take effect immediately with zero host restart!
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
  const bundles = loadVoiceDataBundles();

  // Bounded per-conversation affect/escalation/anchor state (max 500 conversations)
  const convStates = new Map();
  const MAX_CONV_STATES = 500;
  function getConvState(convKey, nowMs) {
    let st = convStates.get(convKey);
    if (!st) {
      if (convStates.size >= MAX_CONV_STATES) {
        const oldest = convStates.keys().next().value;
        if (oldest !== undefined) convStates.delete(oldest);
      }
      st = {
        affect: createAffectState(nowMs),
        escalation: null,
        rapport: null,
        anchors: [],
        turnCounter: 0,
        lastMove: null,
      };
      convStates.set(convKey, st);
    }
    return st;
  }

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
      const packs = loadPackPlainSpeakPacks(packDir, agentName, profile);
      plainSpeakEngine = createPlainSpeakEngine({
        packs,
        config: {
          enabled: true,
          mode: 'live',
          locale: profile.effectiveMode === 'vi_natural' ? 'vi' : profile.language,
          defaultRegister: profile.plainSpeakRegister,
          rewriteEnabled: false,
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
    async beforeTurn({ conversationId = 'default', text = '', history = [], isGroup = false, sender = null } = {}) {
      activeProfile = readCurrentProfile();
      const nowMs = Date.now();
      const convKey = String(conversationId || 'default');
      const conv = getConvState(convKey, nowMs);
      const isViNatural = activeProfile.effectiveMode === 'vi_natural';
      const localePack = isViNatural ? viVNPack : null;

      const histArr = Array.isArray(history) ? history : [];
      const recentUserTexts = histArr
        .filter((h) => h && h.role === 'user' && typeof h.content === 'string')
        .slice(-3)
        .map((h) => h.content);
      const recentAssistantTexts = histArr
        .filter((h) => h && h.role === 'assistant' && typeof h.content === 'string')
        .slice(-4)
        .map((h) => h.content);

      // 1. Affect & Behavior Analysis
      const sensitivity = activeProfile.adaptiveLevel >= 3 ? 'high' : activeProfile.adaptiveLevel <= 1 ? 'low' : 'medium';
      const affectState = updateAffectState(conv.affect, text, {
        nowMs,
        sensitivity,
        localePack,
      });
      conv.affect = affectState;
      conv.turnCounter += 1;

      const basePreset = resolveVoicePreset(activeProfile.voicePreset);
      const isFormalPreset = ['service', 'sales'].includes(activeProfile.voiceRole) || activeProfile.effectiveMode === 'strict_pro';

      // 2. Dynamic Mode Escalation (playful <-> work <-> serious)
      let escalation = null;
      let activePreset = basePreset;
      let effectiveRates = { ...activeProfile.humanErrorRates };
      if (isViNatural && !isFormalPreset) {
        try {
          escalation = evaluateModeEscalation({
            basePreset,
            baseProfileKey: basePreset?.role?.profile || 'vui-ve',
            baseHumanError: activeProfile.humanErrorRates,
            modeEscalation: 'auto',
            adaptiveLevel: activeProfile.adaptiveLevel,
            isGroup: Boolean(isGroup),
            isOwnerSpeaking: Boolean(sender?.isOwner !== false),
            input: text,
            recentUserTexts,
            affectState,
            prevState: conv.escalation,
            nowMs,
          });
          if (escalation?.state) conv.escalation = escalation.state;
          if (escalation?.escalated && escalation.activePreset) {
            activePreset = escalation.activePreset;
            if (activeProfile.humanError && escalation.escalatedHumanError) {
              effectiveRates = {
                texturePercent: Number(escalation.escalatedHumanError.texturePercent ?? effectiveRates.texturePercent),
                correctionPercent: Number(escalation.escalatedHumanError.correctionPercent ?? effectiveRates.correctionPercent),
                appendPercent: effectiveRates.appendPercent,
              };
            }
          }
        } catch { /* fail open */ }
      }

      // 3. EQ Engine (Subtext, Topic Anchors, Customer Rapport)
      const callbackAnchor = selectCallbackAnchor(conv.anchors, { currentText: text, nowMs, turnCounter: conv.turnCounter });
      conv.anchors = extractTopicAnchors(text, conv.anchors, nowMs);
      const customerRapport = isFormalPreset
        ? detectCustomerRapport(text, {
            priorRapport: conv.rapport,
            roleId: activeProfile.voiceRole,
            valence: affectState.valence,
            hardGuard: affectState.hardGuard,
            nowMs,
          })
        : null;
      if (customerRapport) conv.rapport = customerRapport;

      const behavior = analyzeIncomingBehavior(text, {
        nowDate: new Date(nowMs),
        urgent: Boolean(affectState.urgent),
        capabilities: { reaction: !isFormalPreset, edit: true, bubbles: activeProfile.smartBubbles, typing: true },
      });

      // 4. Compile Region A (stableSystemBlock) & Region C (volatileTurnBlock)
      const stableSystemBlock = buildStableSystemBlock(activeProfile, basePreset);
      const compiled = compilePersonalityCues(activeProfile, {
        userText: text,
        recentUserTexts,
        isGroup: Boolean(isGroup),
      });

      const volatileParts = [compiled.text];
      const affectCue = renderAffectCue(affectState);
      if (affectCue) volatileParts.push(affectCue);

      const antiEssay = renderAntiEssayGuidance({
        stance: affectState.stance,
        recentAssistantTexts,
        localePack,
      });
      if (antiEssay) volatileParts.push(antiEssay);

      if (isViNatural) {
        try {
          const eqCue = renderEqIntelligenceCue({
            input: text,
            roleId: activePreset?.roleId || activeProfile.voiceRole,
            genderId: activePreset?.genderId || activeProfile.voiceGender,
            stance: affectState.stance,
            valence: affectState.valence,
            hardGuard: affectState.hardGuard,
            isGroup: Boolean(isGroup),
            callbackAnchor,
            customerRapport,
          });
          if (eqCue) volatileParts.push(eqCue);
        } catch { /* fail open */ }

        // Voice DNA slice by exact (role, gender) from distilled 190KB bundle!
        try {
          const dnaSource = bundles.voiceDnaBundle || bundles.styleBank;
          if (dnaSource) {
            const dnaSlice = resolveVoiceDnaSlice(dnaSource, {
              roleId: activePreset?.roleId || activeProfile.voiceRole,
              genderId: activePreset?.genderId || activeProfile.voiceGender,
              cohort: activePreset?.role?.stylePolicy?.dnaCohort || null,
            });
            const dnaCue = renderVoiceDnaCue(dnaSlice || dnaSource, {
              stance: affectState.stance,
              isGroup: Boolean(isGroup),
              roleId: activePreset?.roleId || activeProfile.voiceRole,
              genderId: activePreset?.genderId || activeProfile.voiceGender,
            });
            if (dnaCue) volatileParts.push(dnaCue);
          }
        } catch { /* fail open */ }

        // Distilled EQ Move Playbook cue
        try {
          if (bundles.movePlaybook) {
            const mpCue = selectMovePlaybookCue(bundles.movePlaybook, text, {
              stance: affectState.stance,
              isGroup: Boolean(isGroup),
              roleId: activePreset?.roleId || activeProfile.voiceRole,
              genderId: activePreset?.genderId || activeProfile.voiceGender,
              lastMove: conv.lastMove,
            });
            if (mpCue?.cue) {
              volatileParts.push(mpCue.cue);
              if (mpCue.id) conv.lastMove = mpCue.id;
            } else if (typeof mpCue === 'string' && mpCue.trim()) {
              volatileParts.push(mpCue.trim());
            }
          }
        } catch { /* fail open */ }

        // Style guards (repeated opener, gender-disallowed opener, icon palette, length cadence)
        try {
          const lastAsst = recentAssistantTexts.at(-1) || '';
          const repOpener = detectRepeatedSingleOpener(recentAssistantTexts);
          if (repOpener) volatileParts.push(`Tr\u00e1nh l\u1eb7p t\u1eeb m\u1edf \u0111\u1ea7u "${repOpener}" nh\u01b0 l\u01b0\u1ee3t tr\u01b0\u1edbc.`);
          if (activeProfile.voiceGender === 'female' && detectBluntMasculineOpener(lastAsst)) {
            volatileParts.push('Gi\u1eef n\u00e9t m\u1ec1m m\u1ea1i n\u1eef t\u00ednh, tr\u00e1nh m\u1edf c\u00e2u c\u1ed9c l\u1ed1c.');
          } else if (detectDisallowedOpener(lastAsst, activePreset?.gender)) {
            volatileParts.push('M\u1edf c\u00e2u t\u1ef1 nhi\u00ean, tr\u00e1nh t\u1eeb m\u1edf \u0111\u1ea7u c\u1ed9c.');
          }
          const iconHint = selectIconPaletteHint({
            preset: activePreset,
            stance: affectState.stance,
            recentIcons: extractIcons(lastAsst),
            seed: `${convKey}:${conv.turnCounter}`,
          });
          if (iconHint) volatileParts.push(iconHint);
          const cadenceHint = selectLengthCadence({
            input: text,
            stance: affectState.stance,
            isGroup: Boolean(isGroup),
            turnCounter: conv.turnCounter,
          });
          if (cadenceHint) volatileParts.push(cadenceHint);
        } catch { /* fail open */ }
      }

      // Filter any accidental bare numeric slider strings (SCROLL sec 43) and cap volatile block
      const safeVolatile = volatileParts
        .map((p) => String(p || '').trim())
        .filter((p) => p && !hasBareNumericSlider(p))
        .join('\n')
        .slice(0, 2200);

      return {
        stableSystemBlock,
        volatileTurnBlock: safeVolatile,
        voiceProfile: activeProfile,
        activePreset,
        effectiveRates,
        affectState,
        escalation,
        behavior,
        turnCounter: conv.turnCounter,
        isSerious: compiled.isSerious || Boolean(affectState.urgent) || affectState.stance === 'listen',
        isPlayful: compiled.isPlayful || affectState.stance === 'banter',
        isShortGroupSummon: compiled.isShortGroupSummon,
        userText: String(text || ''),
      };
    },

    async shapeOutgoing({
      conversationId = 'default',
      text = '',
      rawText = '',
      isGroup = false,
      channel = 'web',
      turnBudget = null,
      voiceBefore = null,
    } = {}) {
      const profile = voiceBefore?.voiceProfile || activeProfile;
      const baseText = String(text || rawText || '').trim();
      if (!baseText) {
        return {
          text: baseText,
          bubbles: [baseText],
          meta: { voiceMode: profile.effectiveMode, voicePreset: profile.voicePreset },
        };
      }

      const stance = voiceBefore?.affectState?.stance || (voiceBefore?.isSerious ? 'listen' : 'collaborate');
      const deglitched = sanitizeControlGlitches(baseText, {
        userText: voiceBefore?.userText || '',
        language: profile.language,
      });
      const cleaned = profile.effectiveMode === 'strict_pro'
        ? deglitched
        : (stripEssayMarkdown(deglitched, { stance }) || deglitched);

      const baseBubbles = splitSmartBubbles(cleaned, {
        smartBubbles: profile.smartBubbles,
        maxBubbles: isGroup ? 2 : 3,
      });

      const isTelegram = String(channel || '').toLowerCase() === 'telegram';
      const rates = voiceBefore?.effectiveRates || profile.humanErrorRates;
      const textured = applyClaimSafeHumanTexture(baseBubbles, {
        enabled: profile.humanError,
        allowHumanError: profile.allowHumanError,
        effectiveMode: profile.effectiveMode,
        isSerious: Boolean(voiceBefore?.isSerious),
        isHighStakes: Boolean(turnBudget?.isHighStakes),
        stance,
        hardGuard: voiceBefore?.affectState?.hardGuard || null,
        capabilities: { edit: isTelegram, bubbles: profile.smartBubbles !== false },
        rates,
        seed: `${conversationId}:${voiceBefore?.turnCounter || 0}:${baseText.slice(0, 32)}`,
      });

      const finalBubbles = textured.bubbles && textured.bubbles.length ? textured.bubbles : baseBubbles;
      const finalJoined = finalBubbles.join('\n\n');

      let reaction = null;
      try {
        if (
          profile.effectiveMode === 'vi_natural'
          && !voiceBefore?.isSerious
          && !['service'].includes(profile.voiceRole)
        ) {
          reaction = selectCompanionReaction({
            input: voiceBefore?.userText || '',
            stance,
            valence: voiceBefore?.affectState?.valence ?? 0,
            roleId: profile.voiceRole,
            genderId: profile.voiceGender,
            seed: `${conversationId}:${voiceBefore?.turnCounter || 0}`,
          }) || null;
        }
      } catch { /* fail open */ }

      const bubblePlans = finalBubbles.map((part, idx) => ({
        text: part,
        delayMs: idx === 0
          ? 0
          : (textured.appendDelayMs && idx === finalBubbles.length - 1
              ? textured.appendDelayMs
              : Math.min(1800, Math.max(600, 450 + part.length * 10))),
      }));

      return {
        text: finalJoined,
        bubbles: finalBubbles,
        meta: {
          voiceMode: profile.effectiveMode,
          voicePreset: profile.voicePreset,
          voiceGender: profile.voiceGender,
          voiceRole: profile.voiceRole,
          distilledLanguage: profile.distilledLanguage,
          humanErrorApplied: Boolean(textured.applied),
          humanErrorKind: textured.kind || null,
          humanErrorRates: rates,
          editPlan: textured.editPlan || null,
          appendDelayMs: textured.appendDelayMs || null,
          bubblePlans,
          reaction,
          stance,
          escalated: Boolean(voiceBefore?.escalation?.escalated),
          bubblesCount: finalBubbles.length,
        },
      };
    },
  };

  return {
    voiceHooks,
    get plainSpeak() { return plainSpeakEngine; },
    describeVoice: (overrideWeights = null) => ({
      ...readCurrentProfile(overrideWeights),
      catalog: getVoiceCatalog(),
    }),
    reload,
  };
}
