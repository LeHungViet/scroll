// Conversational Voice Core v2 \u2014 Adaptive Affect Control
// Grounded in:
//   - Russell's Circumplex Model of Affect (Valence [-1,+1] x Arousal [-1,+1])
//   - Exponential Time-Decay Affect State (LLMs-CoA 2025): E(t) = lambda^dt * E(t-1) + blend * dS
//   - Hill's Helping Skills / ESConv (ACL 2021): 4 behavioral stances (listen | banter | collaborate | execute)
//   - Implicit dynamic cue injection (Grok pattern): never expose numeric scores or meta-labels to user

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const STANCES = Object.freeze(['listen', 'banter', 'collaborate', 'execute']);

// Layer-0 Hard Guards \u2014 instant deterministic overrides before valence/arousal blending
const BASE_HARD_GUARDS = [
  {
    kind: 'crisis',
    stance: 'listen',
    re: /\b(?:kill\s+myself|end\s+my\s+life|suicid|self[- ]harm|want\s+to\s+die|khong\s+muon\s+song|tu\s+tu)\b/i,
  },
  {
    kind: 'bereavement',
    stance: 'listen',
    re: /\b(?:passed\s+away|funeral|died\s+today|lost\s+my\s+(?:mom|dad|mother|father|grandpa|grandma|friend)|qua\s+doi|dam\s+tang|mat\s+roi)\b/i,
  },
  {
    kind: 'medical',
    stance: 'listen',
    re: /\b(?:emergency\s+room|hospitalized|chest\s+pain|urgent\s+surgery|cap\s+cuu|nhap\s+vien|benh\s+vien)\b/i,
  },
  {
    kind: 'commitment',
    stance: 'execute',
    re: /\b(?:wire\s+transfer|sign\s+contract|legal\s+notice|refund\s+dispute|chuyen\s+khoan|hop\s+dong|khieu\s+nai|boi\s+thuong)\b/i,
  },
];

// Base English Valence x Arousal lexicons (locale packs extend these cleanly)
const BASE_CUES = {
  lowValenceLowArousal: [ // tired, sad, drained, overwhelmed (V-, A-)
    'exhausted', 'tired', 'drained', 'burnout', 'burnt out', 'burned out', 'sad', 'lonely',
    'hopeless', 'overwhelmed', 'heavy', 'empty', 'stressed out', 'depressed', 'numb', 'down',
  ],
  lowValenceHighArousal: [ // anxious, scared, angry, panicked, frustrated (V-, A+)
    'scared', 'afraid', 'anxious', 'panic', 'furious', 'angry', 'pissed', 'frustrated',
    'annoyed', 'terrible', 'disaster', 'broken', 'failing', 'worried sick', 'freaking out',
  ],
  highValenceHighArousal: [ // excited, laughing, joking (V+, A+)
    'haha', 'hehe', 'lmao', 'lol', 'rofl', 'awesome', 'amazing', 'excited', 'hype', 'woohoo', 'nailed it', 'crushed it',
  ],
  highValenceLowArousal: [ // calm, relieved, cozy, grateful (V+, A-)
    'relieved', 'peaceful', 'cozy', 'chill', 'grateful', 'glad', 'nice and quiet', 'finally done',
  ],
  urgentExecute: [
    'urgent', 'asap', 'right now', 'immediately', 'quick', 'brief', 'tldr', 'tl;dr',
    'stop asking', 'just do it', 'bottom line', 'deadline',
  ],
};

const PLAYFUL_EMOJI_RE = /[\u{1f604}\u{1f602}\u{1f923}\u{1f606}\u{1f601}\u{1f605}\u{1f61c}\u{1f609}\u{1f60f}\u{1f970}\u{1f60d}\u2764\ufe0f]/u;
const PLAYFUL_ASCII_RE = /(?:[:;=][-^']?\){2,}|\^_?\^|(?<![\p{L}\p{N}]):D(?![\p{L}\p{N}]))/u;
const SAD_EMOJI_RE = /[\u{1f622}\u{1f62d}\u{1f61e}\u{1f614}\u{1f629}\u{1f62b}\u{1f97a}\u{1f494}]/u;

export function foldText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

export function createAffectState(nowMs = Date.now()) {
  return {valence: 0, arousal: 0, stance: 'collaborate', hardGuard: null, updatedAtMs: nowMs};
}

function mergeCues(localePack) {
  const extra = (localePack && localePack.affectCues) || {};
  return {
    lowValenceLowArousal: [...BASE_CUES.lowValenceLowArousal, ...(extra.lowValenceLowArousal || [])],
    lowValenceHighArousal: [...BASE_CUES.lowValenceHighArousal, ...(extra.lowValenceHighArousal || [])],
    highValenceHighArousal: [...BASE_CUES.highValenceHighArousal, ...(extra.highValenceHighArousal || [])],
    highValenceLowArousal: [...BASE_CUES.highValenceLowArousal, ...(extra.highValenceLowArousal || [])],
    urgentExecute: [...BASE_CUES.urgentExecute, ...(extra.urgentExecute || [])],
    hardGuards: [...BASE_HARD_GUARDS, ...(extra.hardGuards || [])],
  };
}

function hasPhrase(foldedPadded, list) {
  let hits = 0;
  for (const p of list) {
    const f = foldText(p).trim();
    if (!f) continue;
    if (foldedPadded.includes(` ${f} `)) hits++;
  }
  return hits;
}

export function extractAffectSignal(text, localePack = null) {
  const raw = String(text ?? '').trim();
  if (!raw) return {dValence: 0, dArousal: 0, urgent: false, hardGuard: null, hasSignal: false};
  const folded = foldText(raw);
  const padded = ' ' + folded.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const cues = mergeCues(localePack);

  // Layer-0 Hard Guards check first
  for (const g of cues.hardGuards) {
    if (g.re.test(folded) || g.re.test(raw)) {
      return {
        dValence: g.stance === 'listen' ? -0.85 : -0.25,
        dArousal: g.kind === 'crisis' || g.kind === 'commitment' ? 0.6 : -0.3,
        urgent: g.stance === 'execute',
        hardGuard: g,
        hasSignal: true,
      };
    }
  }

  let dV = 0;
  let dA = 0;
  let hasSignal = false;

  const lvLa = hasPhrase(padded, cues.lowValenceLowArousal);
  const lvHa = hasPhrase(padded, cues.lowValenceHighArousal);
  const hvHa = hasPhrase(padded, cues.highValenceHighArousal);
  const hvLa = hasPhrase(padded, cues.highValenceLowArousal);
  const urg = hasPhrase(padded, cues.urgentExecute) > 0;

  if (lvLa > 0) { dV -= Math.min(0.85, 0.55 + (lvLa - 1) * 0.15); dA -= 0.4; hasSignal = true; }
  if (lvHa > 0) { dV -= Math.min(0.85, 0.55 + (lvHa - 1) * 0.15); dA += 0.55; hasSignal = true; }
  if (hvHa > 0) { dV += Math.min(0.8, 0.5 + (hvHa - 1) * 0.15); dA += 0.5; hasSignal = true; }
  if (hvLa > 0) { dV += 0.45; dA -= 0.3; hasSignal = true; }

  if (SAD_EMOJI_RE.test(raw)) { dV -= 0.45; dA -= 0.2; hasSignal = true; }
  if ((PLAYFUL_EMOJI_RE.test(raw) || PLAYFUL_ASCII_RE.test(raw)) && lvLa === 0 && lvHa === 0) { dV += 0.45; dA += 0.35; hasSignal = true; }
  if (/!{2,}/.test(raw)) dA += 0.2;
  if (/\.{3}|\u2026/.test(raw) && dV <= 0) dA -= 0.15;

  return {
    dValence: clamp(dV, -1, 1),
    dArousal: clamp(dA, -1, 1),
    urgent: urg,
    hardGuard: null,
    hasSignal: hasSignal || urg,
  };
}

// Update continuous Russell Circumplex state with Exponential Time-Decay (LLMs-CoA)
export function updateAffectState(prevState, text, {
  nowMs = Date.now(),
  sensitivity = 2,
  halfLifeMin = 45,
  localePack = null,
} = {}) {
  const prev = prevState || createAffectState(nowMs);
  const sig = extractAffectSignal(text, localePack);

  // Layer-0 Hard Guard ALWAYS applies even if sensitivity === 0
  if (sig.hardGuard) {
    return {
      valence: sig.dValence,
      arousal: sig.dArousal,
      stance: sig.hardGuard.stance,
      hardGuard: sig.hardGuard.kind,
      urgent: sig.urgent,
      updatedAtMs: nowMs,
    };
  }

  if (sensitivity === 0) {
    return {
      valence: 0,
      arousal: 0,
      stance: sig.urgent ? 'execute' : 'collaborate',
      hardGuard: null,
      urgent: sig.urgent,
      updatedAtMs: nowMs,
    };
  }

  const elapsedMin = Math.max(0, (nowMs - (prev.updatedAtMs ?? nowMs)) / 60000);
  const decay = Math.pow(0.5, elapsedMin / Math.max(1, halfLifeMin));
  const gain = sensitivity === 1 ? 0.55 : (sensitivity === 2 ? 0.85 : 1.25);

  let nextV = prev.valence * decay;
  let nextA = prev.arousal * decay;
  if (sig.hasSignal) {
    // Fresh explicit signal overrides opposite sign cleanly while reinforcing same-sign mood
    const carry = (Math.sign(prev.valence) === Math.sign(sig.dValence) && prev.valence !== 0) ? 0.45 * decay : 0.12 * decay;
    nextV = clamp(prev.valence * carry + sig.dValence * gain, -1, 1);
    nextA = clamp(prev.arousal * (0.35 * decay) + sig.dArousal * gain, -1, 1);
  }

  const listenThreshold = sensitivity >= 3 ? -0.20 : -0.25;
  const banterValenceThreshold = sensitivity >= 3 ? 0.20 : 0.25;
  const banterArousalThreshold = sensitivity >= 3 ? 0.05 : 0.10;
  let stance = 'collaborate';
  if (sig.urgent) stance = 'execute';
  else if (nextV <= listenThreshold) stance = 'listen';
  else if (nextV >= banterValenceThreshold && nextA >= banterArousalThreshold) stance = 'banter';

  return {
    valence: Number(nextV.toFixed(3)),
    arousal: Number(nextA.toFixed(3)),
    stance,
    hardGuard: null,
    urgent: sig.urgent,
    updatedAtMs: nowMs,
  };
}

// Implicit stance cue (Grok pattern: zero numeric scores or clinical emotion labels in prompt)
const STANCE_CUES = Object.freeze({
  listen: 'The other person is carrying weight right now. Stay close, warm, and genuinely human in two to four plain sentences: never parrot their words back, never lecture, never bold words or use advice bullets, and never ask clinical therapy questions.',
  execute: 'Keep this turn fast, crisp, and purely actionable. Lead with the exact answer or next step and skip all small talk.',
  banter: 'The mood is light and open. Be lively, witty, and playful\u2014riff from a fresh angle (never parrot their sentence back, never paste canned textbook jokes), and keep it breezy.',
  collaborate: 'Respond like a sharp, warm, lively partner: bring your own reaction or angle first (never repeat their message back), concise natural chat sentences, zero corporate filler.',
});

export function renderAffectCue(state) {
  const s = (state && STANCE_CUES[state.stance]) ? state.stance : 'collaborate';
  const extra = state && state.hardGuard === 'crisis'
    ? ' Prioritize immediate care and gentle encouragement to reach a trusted person or local support line; never joke.'
    : '';
  return STANCE_CUES[s] + extra;
}
