// Conversational Voice Core v2 \u2014 Anti-Essay, Anti-Therapist-Bot & Dynamic Few-Shot Exemplars
// Directly fixes the observed regression on emotional/casual turns:
//   - Bans **bold** walls, numbered advice lists, and clinical therapist-bot meta-questions
//   - Detects repeated opening stems across recent assistant turns (anti-repeat)
//   - Injects 1\u20132 concise, PII-free few-shot exemplars matched to active stance (within char cap)

const THERAPIST_CLICHE_RE = /(?:what\s+makes\s+you\s+most\s+afraid|how\s+does\s+that\s+make\s+you\s+feel|let's\s+unpack\s+that|your\s+feelings\s+are\s+valid|\u0111i\u1ec1u\s+g\u00ec\s+l\u00e0m\s+(?:anh|em|b\u1ea1n)\s+s\u1ee3\s+nh\u1ea5t|c\u1ea3m\s+x\u00fac\s+c\u1ee7a\s+(?:anh|em|b\u1ea1n)\s+ho\u00e0n\s+to\u00e0n\s+h\u1ee3p\s+l\u00fd)/iu;

const DEFAULT_EXEMPLARS = Object.freeze({
  listen: [
    'Example (stay grounded, no lecture): "That sounds genuinely exhausting. You do not have to untangle all of it tonight\u2014just put it down for a bit and breathe."',
  ],
  banter: [
    'Example (light, natural): "Bold move claiming that before coffee even kicked in."',
  ],
  collaborate: [
    'Example (direct partner): "Skip option B\u2014too many moving parts. Ship the smaller cut first and see what actually breaks."',
  ],
  execute: [
    'Example (crisp execution): "Done. Restarted the worker and confirmed the queue is draining."',
  ],
});

function openingStem(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^[*#>\-\u2022\s]+/, '')
    .toLowerCase();
  const words = cleaned.match(/[\p{L}\p{N}']+/gu) || [];
  return words.slice(0, 2).join(' ');
}

export function detectRepeatedOpening(recentAssistantTexts = []) {
  const stems = recentAssistantTexts
    .filter(x => typeof x === 'string' && x.trim())
    .slice(-3)
    .map(openingStem)
    .filter(Boolean);
  if (stems.length < 2) return null;
  const last = stems[stems.length - 1];
  const count = stems.filter(s => s === last).length;
  return count >= 2 ? last : null;
}

export function renderAntiEssayGuidance({stance = 'collaborate', recentAssistantTexts = [], localePack = null} = {}) {
  const parts = [];
  if (stance === 'listen' || stance === 'banter') {
    parts.push('Write as natural chat prose: no bold markdown, no numbered lists, no therapist clich\u00e9s.');
  }
  const repeated = detectRepeatedOpening(recentAssistantTexts);
  if (repeated) {
    parts.push(`Vary your opening phrasing; do not start again with "${repeated}".`);
  }
  const pool = (localePack && localePack.exemplars && localePack.exemplars[stance]) || DEFAULT_EXEMPLARS[stance] || [];
  if (pool.length) {
    parts.push(pool[0]);
  }
  return parts.join(' ');
}

export function hasTherapistCliche(text) {
  return THERAPIST_CLICHE_RE.test(String(text ?? ''));
}

// Post-processor: strips **bold** / headings on casual & emotional stances while preserving
// every number, code, date, and link untouched.
export function stripEssayMarkdown(text, {stance = 'collaborate'} = {}) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  if (stance === 'listen' || stance === 'banter') {
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    s = s.replace(/__([^_\n]+)__/g, '$1');
    s = s.replace(/^#{1,6}\s+/gm, '');
  }
  return s.trim();
}
