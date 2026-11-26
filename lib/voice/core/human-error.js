// Conversational Voice Core v2 \u2014 Human Error v2
// Three realistic human chat mechanisms (gated by role preset, affect stance, and protected-fact shield):
//   1. Natural IME / keyboard texture (lowercase casual opening, colloquial ending, or safe IME slip)
//   2. editMessageText repair plan (send raw slip -> 1.8\u20133.4s -> edit to clean word when capabilities.edit=true)
//   3. Early-send append (split natural trailing afterthought into a delayed second bubble)
//
// HARD-LOCKED TO 0% whenever:
//   - config.human_error.locked === true (service / teammate roles) OR enabled === false
//   - stance === 'listen' | 'execute' OR hardGuard != null
//   - text contains ANY protected token: numbers, amounts, codes, dates, URLs, quotes, code blocks, or lists

const PROTECTED_RE = /[\p{N}\x60<>\[\]@"'\u201c\u201d\u2018\u2019/\\]|https?:|\b[\p{L}\p{N}-]+\.[a-z]{2,}\b|(?:^|\n)\s*[-\u2013\u2014\u2022*#>|]\s|[{}|*_~#%$\u20ab\u20ac\u00a3\u00a5]/iu;
const CLAIM_TOKEN_RE = /https?:\/\/[^\s]+|\b\d[\d.,/-]*\b|\b(?=[A-Z0-9_-]*\d)(?=[A-Z0-9_-]*[A-Z])[A-Z0-9_-]{3,}\b/g;

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

export function claimsUnchanged(beforeText, afterText) {
  const pick = (s) => (String(s ?? '').match(CLAIM_TOKEN_RE) || []).sort();
  const a = pick(beforeText);
  const b = pick(afterText);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const DEFAULT_TYPOS = Object.freeze({
  really: 'realy',
  though: 'tho',
  probably: 'prolly',
  because: 'bc',
  already: 'alr',
});

const DEFAULT_AFTERTHOUGHT_RE = /^(.{12,}?)[,.]\s+((?:btw|oh also|almost forgot|by the way)\b.+)$/i;

export function applyHumanError(bubbles, {
  config,
  stance = 'collaborate',
  hardGuard = null,
  capabilities = {},
  localePack = null,
  seed = 'turn',
} = {}) {
  const input = Array.isArray(bubbles) ? bubbles.map(String) : [String(bubbles ?? '')];
  const untouched = {bubbles: input, applied: null, editPlan: null, appendDelayMs: null};
  const errCfg = config && config.human_error;
  if (!errCfg || errCfg.locked === true || errCfg.enabled !== true) return untouched;
  if (hardGuard || stance === 'listen' || stance === 'execute') return untouched;

  const joined = input.join('\n');
  if (!joined.trim() || joined.length > 260 || PROTECTED_RE.test(joined)) return untouched;

  const hePack = (localePack && localePack.humanError) || {};
  const typos = {...DEFAULT_TYPOS, ...(hePack.typos || {})};
  const openings = hePack.casualOpenings || ['Actually', 'Honestly', 'Fair enough', 'Wait'];
  const endings = hePack.casualEndings || {};
  const afterthoughtRe = hePack.afterthoughtRe || DEFAULT_AFTERTHOUGHT_RE;

  const hash = fnv1a(`${seed}\0${joined}`);
  const roll = (hash % 1000) / 1000; // [0, 1)
  const pickIdx = Math.floor(hash / 1000);

  // Mechanism 1: Early-send append split (when single bubble has a trailing afterthought)
  if (capabilities.bubbles !== false && input.length === 1 && errCfg.appendRate > 0 && roll < errCfg.appendRate) {
    const m = input[0].match(afterthoughtRe);
    if (m) {
      const split = [m[1].trim(), m[2].trim()];
      if (claimsUnchanged(joined, split.join('\n'))) {
        return {
          bubbles: split,
          applied: 'early_send_append',
          editPlan: null,
          appendDelayMs: 1400 + (pickIdx % 1200),
        };
      }
    }
  }

  // Mechanism 2: IME / typo + editMessageText repair plan (preferred when capabilities.edit === true)
  const corrThreshold = errCfg.correctionRate;
  if (input.length === 1 && corrThreshold > 0 && roll < corrThreshold) {
    const wordRe = /[\p{L}\p{M}]+/gu;
    const matches = [...input[0].matchAll(wordRe)].filter(m => Object.hasOwn(typos, m[0]));
    if (matches.length) {
      const chosen = matches[pickIdx % matches.length];
      const origWord = chosen[0];
      const slippedWord = typos[origWord];
      const slipped = input[0].slice(0, chosen.index) + slippedWord + input[0].slice(chosen.index + origWord.length);
      if (claimsUnchanged(joined, slipped)) {
        if (capabilities.edit === true) {
          return {
            bubbles: [input[0]], // final canonical text after edit
            applied: 'edit_message_repair',
            editPlan: {
              mode: 'send_then_edit',
              initialText: slipped,
              editedText: input[0],
              editDelayMs: 1800 + (pickIdx % 1600),
            },
            appendDelayMs: null,
          };
        }
        // Fallback when channel cannot edit (e.g. Zalo): follow-up correction bubble
        return {
          bubbles: [slipped, `*${origWord}`],
          applied: 'followup_correction',
          editPlan: null,
          appendDelayMs: 1200,
        };
      }
    }
  }

  // Mechanism 3: Natural casual texture (lowercase opening OR colloquial ending \u2014 max 1 edit)
  if (errCfg.textureRate > 0 && roll < errCfg.textureRate) {
    const candidates = [];
    for (let i = 0; i < input.length; i++) {
      const part = input[i];
      if (openings.some(op => part.startsWith(op) && /^([^\p{L}\p{M}]|$)/u.test(part.slice(op.length)))) {
        const low = part[0].toLowerCase() + part.slice(1);
        if (low !== part) candidates.push({index: i, text: low, kind: 'lowercase_opening'});
      }
      const endM = /([\p{L}\p{M}]+)[.!?\u2026]*\s*$/u.exec(part);
      if (endM && Object.hasOwn(endings, endM[1])) {
        const swapped = part.slice(0, endM.index) + endings[endM[1]] + part.slice(endM.index + endM[1].length);
        if (swapped !== part) candidates.push({index: i, text: swapped, kind: 'colloquial_ending'});
      }
    }
    if (candidates.length) {
      const choice = candidates[pickIdx % candidates.length];
      const next = input.map((p, idx) => (idx === choice.index ? choice.text : p));
      if (claimsUnchanged(joined, next.join('\n'))) {
        return {bubbles: next, applied: choice.kind, editPlan: null, appendDelayMs: null};
      }
    }
  }

  return untouched;
}
