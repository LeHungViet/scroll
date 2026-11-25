// SCROLL — machine-enforced `style:` block & voice-hook safety checks (v1.9 §43).
//
// Only keys with deterministic code enforcement are allowed inside `IDENTITY.style`:
//   bubbles    (integer >= 1): max outgoing message bubbles
//   max_chars  (integer >= 20): hard character ceiling (1 regenerate, else hold)
//   emoji      (integer >= 0): max emoji characters allowed (0 strips all emojis)
//   follow_up  (integer >= 0): max trailing follow-up questions allowed (0 strips filler follow-ups)
//
// Any other key (e.g. warmth, humor, tone) fails `scroll check` — prose tone belongs in SOUL.md
// or a voice plugin that translates settings into concrete wording without bare numeric sliders.
//
// Deterministic, zero dependencies, pure ASCII source. Node >= 20.
import { extractClaims, verifyClaimsInvariant } from './grounding.js';

export const ENFORCED_STYLE_KEYS = new Set(['bubbles', 'max_chars', 'emoji', 'follow_up']);
export const SPEAKS_AS_VALUES = new Set(['self', 'owner', 'org']);

// §51 (SCROLL 2.7) — machine-enforced `economy:` block inside `IDENTITY.md` frontmatter
export const ECONOMY_MODES = new Set(['outcome_only', 'balanced', 'detailed', 'off']);
export const ECONOMY_EFFORT_ROUTING = new Set(['fixed', 'auto']);
export const ECONOMY_LINK_MODES = new Set(['on_request', 'inline', 'always']);
export const ECONOMY_PROCESS_MODES = new Set(['suppress', 'allow']);
export const ECONOMY_ECHO_MODES = new Set(['strict', 'normal', 'off']);
export const ENFORCED_ECONOMY_KEYS = new Set([
  'mode',
  'effort_routing',
  'links',
  'process_narration',
  'echo_guard',
  'default_follow_up',
  'compress_llm',
  'max_chars_brief',
]);

export function validateEconomy(economy) {
  const errors = [];
  if (economy === undefined || economy === null) return { errors };
  if (typeof economy !== 'object' || Array.isArray(economy)) {
    return { errors: ['IDENTITY: economy must be a map { mode, effort_routing, links, process_narration, echo_guard, default_follow_up, compress_llm, max_chars_brief } (§51)'] };
  }
  for (const [k, v] of Object.entries(economy)) {
    if (!ENFORCED_ECONOMY_KEYS.has(k)) {
      errors.push(`IDENTITY: economy.${k} has no machine enforcement in code — allowed keys: [${[...ENFORCED_ECONOMY_KEYS].join(', ')}] (§51)`);
      continue;
    }
    if (k === 'mode' && !ECONOMY_MODES.has(String(v))) {
      errors.push(`IDENTITY: economy.mode "${v}" must be one of: ${[...ECONOMY_MODES].join(', ')} (§51)`);
    } else if (k === 'effort_routing' && !ECONOMY_EFFORT_ROUTING.has(String(v))) {
      errors.push(`IDENTITY: economy.effort_routing "${v}" must be one of: ${[...ECONOMY_EFFORT_ROUTING].join(', ')} (§51)`);
    } else if (k === 'links' && !ECONOMY_LINK_MODES.has(String(v))) {
      errors.push(`IDENTITY: economy.links "${v}" must be one of: ${[...ECONOMY_LINK_MODES].join(', ')} (§51)`);
    } else if (k === 'process_narration' && !ECONOMY_PROCESS_MODES.has(String(v))) {
      errors.push(`IDENTITY: economy.process_narration "${v}" must be one of: ${[...ECONOMY_PROCESS_MODES].join(', ')} (§51)`);
    } else if (k === 'echo_guard' && !ECONOMY_ECHO_MODES.has(String(v))) {
      errors.push(`IDENTITY: economy.echo_guard "${v}" must be one of: ${[...ECONOMY_ECHO_MODES].join(', ')} (§51)`);
    } else if (k === 'default_follow_up') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 2) {
        errors.push('IDENTITY: economy.default_follow_up must be an integer 0..2 (§51)');
      }
    } else if (k === 'compress_llm') {
      if (typeof v !== 'boolean') {
        errors.push('IDENTITY: economy.compress_llm must be a boolean (§51)');
      }
    } else if (k === 'max_chars_brief') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 80) {
        errors.push('IDENTITY: economy.max_chars_brief must be an integer >= 80 (§51)');
      }
    }
  }
  return { errors };
}

// Matches Unicode emoji pictographs/symbols (ASCII-safe Unicode property escape)
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// Detects bare numeric sliders leaked into prompt text (e.g. "warmth: 4/5", "humor = 3")
const BARE_SLIDER_RE = /\b(?:warmth|humor|playfulness|directness|agency|communion|initiative|verbosity|formality|empathy|tone)\s*[:=]\s*\d+(?:\s*\/\s*\d+)?\b/i;

export function hasBareNumericSlider(text) {
  return BARE_SLIDER_RE.test(String(text ?? ''));
}

export function validateStyle(style) {
  const errors = [];
  if (style === undefined || style === null) return { errors };
  if (typeof style !== 'object' || Array.isArray(style)) {
    return { errors: ['IDENTITY: style must be a map { bubbles, max_chars, emoji, follow_up }'] };
  }
  for (const [k, v] of Object.entries(style)) {
    if (!ENFORCED_STYLE_KEYS.has(k)) {
      errors.push(`IDENTITY: style.${k} has no machine enforcement in code — only [${[...ENFORCED_STYLE_KEYS].join(', ')}] are allowed; move qualitative tone to SOUL.md or a voice plugin`);
      continue;
    }
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      errors.push(`IDENTITY: style.${k} must be an integer`);
      continue;
    }
    if (k === 'bubbles' && v < 1) errors.push('IDENTITY: style.bubbles must be >= 1');
    if (k === 'max_chars' && v < 20) errors.push('IDENTITY: style.max_chars must be >= 20');
    if ((k === 'emoji' || k === 'follow_up') && v < 0) errors.push(`IDENTITY: style.${k} must be >= 0`);
  }
  return { errors };
}

function stripRedundantMarkdown(text) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  // Unwrap bold/italic markers without touching numbers, codes, or links
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  // Strip leading markdown heading hashes while preserving line text
  s = s.replace(/^#{1,6}\s+/gm, '');
  return s.trim();
}

function capEmojis(text, maxEmoji) {
  if (maxEmoji == null) return text;
  let seen = 0;
  return text.replace(EMOJI_RE, (m) => {
    seen++;
    return seen <= maxEmoji ? m : '';
  }).replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}

// Strip trailing filler follow-up questions when follow_up === 0, ONLY if removing them
// drops ZERO structured claims (amounts, codes, dates, links), while preserving internal line breaks.
function capFollowUps(text, maxFollowUp) {
  if (maxFollowUp == null) return text;
  const src = String(text ?? '').trim();
  if (!src || !src.includes('?')) return src;
  const lines = src.split('\n');
  const outLines = [];
  let questionsKept = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      outLines.push('');
      continue;
    }
    // Keep bullet/list lines intact; only check trailing question sentences on prose lines
    if (/^[-•*]\s+|^\d+[.)]\s+/.test(trimmed)) {
      outLines.push(trimmed);
      continue;
    }
    const parts = trimmed.split(/(?<=[.!?])\s+/);
    const keptParts = [];
    for (const rawPart of parts) {
      const p = rawPart.trim();
      if (!p) continue;
      if (p.endsWith('?')) {
        const hasClaim = extractClaims(p).length > 0;
        if (!hasClaim && (outLines.length > 0 || keptParts.length > 0) && questionsKept >= maxFollowUp) continue;
        questionsKept++;
      }
      keptParts.push(p);
    }
    if (keptParts.length) outLines.push(keptParts.join(' '));
  }
  return outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitAndCapBubbles(text, maxBubbles) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [''];
  // Split bubbles on paragraph breaks (\n\n) first so multi-line bullet lists stay intact inside one bubble.
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).join('\n'))
    .filter(Boolean);
  const rawChunks = paragraphs.length > 1
    ? paragraphs
    : (normalized.includes('\n- ') || normalized.includes('\n• ') || normalized.includes('\n* ')
        ? [paragraphs[0]]
        : normalized.split('\n').map((x) => x.trim()).filter(Boolean));
  if (!rawChunks.length) return [''];
  if (!maxBubbles || rawChunks.length <= maxBubbles) return rawChunks;
  // Merge overflow chunks into the last allowed bubble with '\n' (NEVER space ' ' — preserves bullet line breaks!)
  const kept = rawChunks.slice(0, maxBubbles - 1);
  const tail = rawChunks.slice(maxBubbles - 1).join('\n');
  kept.push(tail);
  return kept;
}

// Machine-enforce `IDENTITY.style` on a reply without ever altering numbers, codes, dates, or links.
export function enforceStyle(rawText, style = {}) {
  const original = String(rawText ?? '').trim();
  const s = style && typeof style === 'object' ? style : {};
  let cleaned = stripRedundantMarkdown(original);
  if (typeof s.emoji === 'number') cleaned = capEmojis(cleaned, s.emoji);
  if (typeof s.follow_up === 'number') cleaned = capFollowUps(cleaned, s.follow_up);
  const bubbles = splitAndCapBubbles(cleaned, typeof s.bubbles === 'number' ? s.bubbles : null);
  const text = bubbles.join('\n');
  const inv = verifyClaimsInvariant(original, text);
  // Fail-safe: if formatting ever perturbed a claim, fall back to original text split cleanly
  const safeBubbles = inv.ok ? bubbles : splitAndCapBubbles(original, typeof s.bubbles === 'number' ? s.bubbles : null);
  const safeText = safeBubbles.join('\n');
  const overMaxChars = typeof s.max_chars === 'number' && safeText.length > s.max_chars;
  return {
    text: safeText,
    bubbles: safeBubbles,
    chars: safeText.length,
    overMaxChars,
    needsRegenerate: overMaxChars,
    invariantOk: verifyClaimsInvariant(original, safeText).ok,
  };
}
