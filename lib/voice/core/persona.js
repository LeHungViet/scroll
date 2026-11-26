// Conversational Voice Core v2 \u2014 Persona & Conversational Initiative
// Grounded in:
//   - Wiggins / Leary Interpersonal Circumplex (IPC: Agency x Communion)
//   - DeYoung Big Five Aspect Scales (BFAS) & Pragmatics (Playfulness, Directness)
//   - Communication Accommodation Theory (CAT \u2014 Giles)
//
// 100% English canonical schema. ZERO bare numbers ever enter prompt text: every numeric
// axis is deterministically translated into concrete behavioral prose.

export const ROLE_PRESETS = Object.freeze({
  assistant: Object.freeze({
    role: 'assistant',
    speaks_as: 'self',
    personaPreset: 'candid-peer',
    ipc: Object.freeze({agency: 4, communion: 4}),
    pragmatics: Object.freeze({playfulness: 3, directness: 4}),
    conversational_initiative: Object.freeze({level: 2, domains: Object.freeze(['personal', 'work'])}),
    adaptive_affect: Object.freeze({model: 'circumplex_va', sensitivity: 3, decay_half_life_min: 45}),
    human_error: Object.freeze({enabled: true, locked: false, textureRate: 0.28, correctionRate: 0.05, appendRate: 0.08}),
    style: Object.freeze({bubbles: 3, max_chars: 450, emoji: 2, follow_up: 1}),
  }),
  service: Object.freeze({
    role: 'service',
    speaks_as: 'org',
    personaPreset: 'warm-supportive',
    ipc: Object.freeze({agency: 3, communion: 5}),
    pragmatics: Object.freeze({playfulness: 1, directness: 4}),
    conversational_initiative: Object.freeze({level: 0, domains: Object.freeze(['work'])}),
    adaptive_affect: Object.freeze({model: 'circumplex_va', sensitivity: 2, decay_half_life_min: 30}),
    human_error: Object.freeze({enabled: false, locked: true, textureRate: 0, correctionRate: 0, appendRate: 0}),
    style: Object.freeze({bubbles: 2, max_chars: 300, emoji: 0, follow_up: 0}),
  }),
  proxy: Object.freeze({
    role: 'proxy',
    speaks_as: 'owner',
    personaPreset: 'candid-peer',
    ipc: Object.freeze({agency: 3, communion: 3}),
    pragmatics: Object.freeze({playfulness: 2, directness: 4}),
    conversational_initiative: Object.freeze({level: 0, domains: Object.freeze(['personal', 'work'])}),
    adaptive_affect: Object.freeze({model: 'circumplex_va', sensitivity: 2, decay_half_life_min: 45}),
    human_error: Object.freeze({enabled: true, locked: false, textureRate: 0.15, correctionRate: 0, appendRate: 0.04}),
    style: Object.freeze({bubbles: 2, max_chars: 280, emoji: 1, follow_up: 0}),
  }),
  teammate: Object.freeze({
    role: 'teammate',
    speaks_as: 'self',
    personaPreset: 'executive-direct',
    ipc: Object.freeze({agency: 4, communion: 3}),
    pragmatics: Object.freeze({playfulness: 2, directness: 5}),
    conversational_initiative: Object.freeze({level: 1, domains: Object.freeze(['work'])}),
    adaptive_affect: Object.freeze({model: 'circumplex_va', sensitivity: 2, decay_half_life_min: 30}),
    human_error: Object.freeze({enabled: false, locked: true, textureRate: 0, correctionRate: 0, appendRate: 0}),
    style: Object.freeze({bubbles: 1, max_chars: 400, emoji: 1, follow_up: 0}),
  }),
});

export const PERSONA_PRESETS = Object.freeze({
  'warm-supportive': Object.freeze({agency: 2, communion: 5, playfulness: 2, directness: 3}),
  'candid-peer': Object.freeze({agency: 4, communion: 4, playfulness: 3, directness: 4}),
  'sharp-witty': Object.freeze({agency: 5, communion: 3, playfulness: 4, directness: 5}),
  'executive-direct': Object.freeze({agency: 4, communion: 2, playfulness: 1, directness: 5}),
});

export const INITIATIVE_LEVELS = Object.freeze([
  Object.freeze({
    level: 0,
    key: 'responsive',
    guidance: 'Answer what was asked and yield the floor cleanly; do not add unprompted side topics or filler questions.',
  }),
  Object.freeze({
    level: 1,
    key: 'acknowledging',
    guidance: 'Answer directly and add at most one brief grounded remark when natural, then stop.',
  }),
  Object.freeze({
    level: 2,
    key: 'elaborative',
    guidance: 'Stay on the active thread with a concrete observation or one natural follow-up when the mood is open.',
  }),
  Object.freeze({
    level: 3,
    key: 'proactive',
    guidance: 'Engage actively like a sharp peer: contribute an angle of your own and keep the exchange moving when non-urgent.',
  }),
]);

export const VALID_DOMAINS = new Set(['personal', 'work']);

// Behavioral translations (never emit bare numbers into prompts)
const AGENCY_WORDING = [
  'Stay deferential and supportive; let the other person steer the direction.',
  'Offer gentle suggestions while keeping the other person firmly in the lead.',
  'Share a clear take when helpful without pushing back unnecessarily.',
  'Speak with grounded conviction like a capable peer; give your own view instead of echoing.',
  'Lead decisively with a sharp independent point of view; push back candidly when an idea has holes.',
];

const COMMUNION_WORDING = [
  'Keep interpersonal distance clean, poised, and matter-of-fact.',
  'Stay polite and steady without forced warmth or extra chatter.',
  'Maintain natural, approachable peer warmth without over-performing friendliness.',
  'Show genuine, relaxed warmth and attentiveness like a trusted close colleague.',
  'Prioritize warm, welcoming care and clear reassurance in every reply.',
];

const PLAYFULNESS_WORDING = [
  'Keep wording completely literal and straight; no jokes or teasing.',
  'Stay mostly grounded; allow a light smile only when the other person jokes first.',
  'Use occasional dry, understated wit when the mood is light, never forced.',
  'Bring crisp, playful banter on open turns while dropping humor immediately on serious topics.',
  'Lean into witty, lively repartee on casual turns, still yielding immediately to serious cues.',
];

const DIRECTNESS_WORDING = [
  'Soften critiques with diplomatic framing and gentle transitions.',
  'Balance tact with clarity; give context before landing a tough point.',
  'Be clear and natural, neither overly blunt nor padded with disclaimers.',
  'Put the main point first in plain language; skip throat-clearing and hedging.',
  'Be bottom-line first and tightly clipped; cut every redundant qualifier.',
];

function clampInt(n, min, max, label) {
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function normalizeVoiceConfig(input = {}) {
  const roleKey = input.role || 'assistant';
  if (!Object.hasOwn(ROLE_PRESETS, roleKey)) {
    throw new RangeError(`Unknown role preset "${roleKey}". Valid: ${Object.keys(ROLE_PRESETS).join(', ')}`);
  }
  const base = ROLE_PRESETS[roleKey];
  const personaPreset = input.personaPreset ?? base.personaPreset;
  if (!Object.hasOwn(PERSONA_PRESETS, personaPreset)) {
    throw new RangeError(`Unknown personaPreset "${personaPreset}". Valid: ${Object.keys(PERSONA_PRESETS).join(', ')}`);
  }
  const arch = PERSONA_PRESETS[personaPreset];
  const ipcIn = input.ipc || {};
  const pragIn = input.pragmatics || {};
  const initIn = input.conversational_initiative || {};
  const affIn = input.adaptive_affect || {};
  const errIn = input.human_error || {};

  const ipc = {
    agency: clampInt(ipcIn.agency ?? (input.personaPreset ? arch.agency : base.ipc.agency), 1, 5, 'ipc.agency'),
    communion: clampInt(ipcIn.communion ?? (input.personaPreset ? arch.communion : base.ipc.communion), 1, 5, 'ipc.communion'),
  };
  const pragmatics = {
    playfulness: clampInt(pragIn.playfulness ?? (input.personaPreset ? arch.playfulness : base.pragmatics.playfulness), 1, 5, 'pragmatics.playfulness'),
    directness: clampInt(pragIn.directness ?? (input.personaPreset ? arch.directness : base.pragmatics.directness), 1, 5, 'pragmatics.directness'),
  };
  const initLevel = clampInt(initIn.level ?? base.conversational_initiative.level, 0, 3, 'conversational_initiative.level');
  const rawDomains = initIn.domains ?? [...base.conversational_initiative.domains];
  if (!Array.isArray(rawDomains) || rawDomains.some(d => !VALID_DOMAINS.has(d))) {
    throw new RangeError('conversational_initiative.domains must be a subset of ["personal", "work"]');
  }

  // Hard-lock human_error on service and teammate roles
  const locked = base.human_error.locked === true;
  const human_error = locked
    ? {enabled: false, locked: true, textureRate: 0, correctionRate: 0, appendRate: 0}
    : {
      enabled: errIn.enabled ?? base.human_error.enabled,
      locked: false,
      textureRate: Math.max(0, Math.min(0.5, Number(errIn.textureRate ?? base.human_error.textureRate))),
      correctionRate: Math.max(0, Math.min(0.1, Number(errIn.correctionRate ?? base.human_error.correctionRate))),
      appendRate: Math.max(0, Math.min(0.15, Number(errIn.appendRate ?? base.human_error.appendRate))),
    };

  const sensitivity = clampInt(affIn.sensitivity ?? base.adaptive_affect.sensitivity, 0, 3, 'adaptive_affect.sensitivity');
  const decayHalfLifeMin = Number(affIn.decay_half_life_min ?? base.adaptive_affect.decay_half_life_min);
  if (!Number.isFinite(decayHalfLifeMin) || decayHalfLifeMin <= 0) {
    throw new RangeError('adaptive_affect.decay_half_life_min must be a positive number');
  }

  return {
    role: roleKey,
    speaks_as: input.speaks_as ?? base.speaks_as,
    personaPreset,
    ipc,
    pragmatics,
    conversational_initiative: {level: initLevel, domains: [...new Set(rawDomains)]},
    adaptive_affect: {model: 'circumplex_va', sensitivity, decay_half_life_min: decayHalfLifeMin},
    human_error,
    style: {...base.style, ...(input.style || {})},
  };
}

// Translate IPC + pragmatics + initiative into concrete wording (zero bare numbers)
export function renderPersonaGuidance(config, {stance = 'collaborate', quietTurn = false, suppressFollowUp = false} = {}) {
  const lines = [];
  if (config.speaks_as === 'owner') {
    lines.push('Match the principal\'s own recent wording and rhythm; do not invent an independent persona.');
  } else {
    lines.push(AGENCY_WORDING[config.ipc.agency - 1]);
    lines.push(COMMUNION_WORDING[config.ipc.communion - 1]);
    lines.push(DIRECTNESS_WORDING[config.pragmatics.directness - 1]);
    if (stance === 'banter' || stance === 'collaborate') {
      lines.push(PLAYFULNESS_WORDING[config.pragmatics.playfulness - 1]);
    }
  }

  if (quietTurn || suppressFollowUp || stance === 'listen' || stance === 'execute' || !config.conversational_initiative.domains.length) {
    lines.push(INITIATIVE_LEVELS[0].guidance);
  } else {
    lines.push(INITIATIVE_LEVELS[config.conversational_initiative.level].guidance);
  }
  return lines.join(' ');
}
