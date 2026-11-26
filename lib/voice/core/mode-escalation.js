// Conversational Voice Core v4 \u2014 Contextual Mode Escalation (Elastic Role Shift)
// Temporarily shifts the active voice role within explicit directed pairs when conversational
// momentum crosses hysteresis thresholds, and snaps back instantly to the Base Role on work,
// facts, serious/safety turns, scope boundaries, or idle decay.
// Base preset settings are NEVER mutated; shift state is ephemeral and strictly per-chatId.

import {isValidVoicePreset, resolveVoicePreset} from './preset-catalog.js';

export const MODE_ESCALATION_MODES = Object.freeze({
  off: Object.freeze({
    id: 'off',
    title: 'Kh\u00f3a vai g\u1ed1c',
    description: 'Lu\u00f4n gi\u1eef nguy\u00ean vai g\u1ed1c \u0111ang ch\u1ecdn, kh\u00f4ng t\u1ef1 n\u00e2ng ho\u1eb7c h\u1ea1 sang vai kh\u00e1c.',
  }),
  auto: Object.freeze({
    id: 'auto',
    title: 'T\u1ef1 nhi\u00ean (C\u1eb7p an to\u00e0n)',
    description: 'T\u1ef1 n\u00e2ng/h\u1ea1 nh\u1ecbp t\u1ea1m trong c\u00e1c c\u1eb7p an to\u00e0n (Tr\u1ee3 l\u00fd \u2194 B\u1ea1n vui t\u01b0\u01a1i/T\u00e2m l\u00fd, \u0110\u1ed3ng nghi\u1ec7p \u2192 Tr\u1ee3 l\u00fd, T\u01b0 v\u1ea5n \u2194 CSKH); kh\u00f3a T\u00ecnh t\u1ee9.',
  }),
  open: Object.freeze({
    id: 'open',
    title: 'Linh ho\u1ea1t (DM ri\u00eang)',
    description: 'M\u1edf th\u00eam n\u00e2ng nh\u1ecbp B\u1ea1n vui t\u01b0\u01a1i \u2192 B\u1ea1n t\u00ecnh t\u1ee9 tinh t\u1ebf khi chat ri\u00eang 1-1 (tuy\u1ec7t \u0111\u1ed1i c\u1ea5m trong Group).',
  }),
});

export const MODE_ESCALATION_IDS = Object.freeze(Object.keys(MODE_ESCALATION_MODES));

// Directed allowed transition graph. Service NEVER escalates into companion-*.
export const ESCALATION_PAIRS = Object.freeze({
  assistant: Object.freeze(['companion-lively', 'companion-warm']),
  teammate: Object.freeze(['assistant']),
  'companion-lively': Object.freeze(['companion-warm', 'assistant', 'companion-flirty']),
  'companion-flirty': Object.freeze(['companion-warm', 'assistant']),
  'companion-warm': Object.freeze(['assistant']),
  sales: Object.freeze(['service']),
  service: Object.freeze(['sales']),
});

const BOT_MENTION_STRIP_RE = /(?:^|(?<=[\s(\["'\u201c\u2018]))@[A-Za-z][A-Za-z0-9_]{2,63}\b/gu;

const PLAYFUL_ROOM_RE = /(?:[:;=][-^']?\){2,}|\^_?\^|(?<![\p{L}\p{N}]):D(?![\p{L}\p{N}])|[\u{1f604}\u{1f602}\u{1f923}\u{1f606}\u{1f601}\u{1f61c}\u{1f61d}\u{1f609}\u{1f60f}]|\b(?:haha+|hehe+|hihi+|h\u00ed\s*h\u00ed|kaka+|lmao|lol|rofl|tr\u00eau|\u0111\u00f9a|troll|ch\u1ecdc|t\u1ebfu|c\u01b0\u1eddi\s*x\u1ec9u|vui\s*qu\u00e1|vui\s*gh\u00ea|x\u00f4m(?:\s*t\u1ee5)?|qu\u1ea9y|nh\u1eadu|khao|tr\u1ed1n\s*k\u00e8o|c\u00e0\s*kh\u1ecba|ch\u00e9m\s*gi\u00f3|t\u00e1n\s*g\u1eabu|m\u1eafc\s*c\u01b0\u1eddi|b\u00f3\s*tay|\u1ea3o\s*th\u1eadt|ch\u1ecbu\s*lu\u00f4n|x\u1ea3\s*h\u01a1i|\u0103n\s*m\u1eebng|ship\s*xong|tan\s*h\u1ecdp|cu\u1ed1i\s*tu\u1ea7n\s*qu\u1ea9y)\b)/iu;

const EXPLICIT_BANTER_PIVOT_RE = /(?<![\p{L}\p{N}])(?:(?:b\u1ecdn\s+)?(?:anh|a|ch\u1ecb|em|e|t\u1ee5i\s+m\u00ecnh|m\u1ecdi\s+ng\u01b0\u1eddi)?\s*(?:tr\u00eau|\u0111\u00f9a|troll|ch\u1ecdc|c\u00e0\s*kh\u1ecba)\s*(?:th\u00f4i|ch\u00fat|x\u00edu|m\u00e0|\u0111\u1ea5y|\u0111\u00f3|t\u00ed|t\u00fd)|sao\s+(?:t\u1ef1\s+d\u01b0ng|t\u1ef1\s+nhi\u00ean|l\u1ea1i)\s+.{0,16}(?:nghi\u00eam\s+t\u00fac|c\u0103ng(?:\s+th\u1eb3ng)?)\s*(?:th\u1ebf|v\u1eady|qu\u00e1)|(?:l\u00e0m\s+)?(?:g\u00ec|j)\s+m\u00e0\s+(?:nghi\u00eam\s+t\u00fac|c\u0103ng(?:\s+th\u1eb3ng)?)\s*(?:th\u1ebf|v\u1eady|qu\u00e1)?|c\u0103ng\s+th\u1eb3ng\s+(?:th\u1ebf|v\u1eady|qu\u00e1)|th\u1ea3\s+l\u1ecfng\s+(?:\u0111i|ra|n\u00e0o))(?![\p{L}\p{N}])/iu;

const WORK_OR_FACT_RE = /(?:https?:\/\/|\b(?:l\u1ecbch\s*h\u1ecdp|\u0111\u1eb7t\s*l\u1ecbch|ch\u1ed1t\s*l\u1ecbch|nh\u1eafc\s*l\u1ecbch|nh\u1eafc\s*vi\u1ec7c|deadline|h\u1ea1n\s*ch\u00f3t|so\u1ea1n\s*(?:mail|email|tin|th\u01b0)|g\u1eedi\s*(?:mail|email|kh\u00e1ch|\u0111\u1ed1i\s*t\u00e1c)|b\u00e1o\s*c\u00e1o|t\u1ed5ng\s*h\u1ee3p|fact[- ]?check|tra\s*c\u1ee9u|ki\u1ec3m\s*tra|h\u1ee3p\s*\u0111\u1ed3ng|h\u00f3a\s*\u0111\u01a1n|chuy\u1ec3n\s*kho\u1ea3n|thanh\s*to\u00e1n|b\u00e1o\s*gi\u00e1|t\u00e0i\s*ch\u00ednh|thu\u1ebf|\u0111\u0103ng\s*ki\u1ec3m|\u0111\u0103ng\s*k\u00fd|\u0111ky|th\u1ee7\s*t\u1ee5c|gi\u1ea5y\s*t\u1edd|cron|deploy|server|production|fix\s*bug|review\s*code|pull\s*request|kh\u00e1ch\s*h\u00e0ng|\u0111\u1ed1i\s*t\u00e1c|chi\s*nh\u00e1nh|doanh\s*thu|c\u00f4ng\s*n\u1ee3|k\u1ebf\s*to\u00e1n|nh\u00e2n\s*s\u1ef1|ph\u00e1p\s*l\u00fd|ng\u00e2n\s*s\u00e1ch)\b|\b\d+(?:[.,]\d+)?\s*(?:tr|tri\u1ec7u|ngh\u00ecn|ng\u00e0n|t\u1ef7|k|\u0111|vnd|usd|%)\b|\b\d{1,2}\s*[/-]\s*\d{1,2}(?:[/-]\d{2,4})?\b|\b\d{1,2}h\d{0,2}\b)/iu;

const WORK_TASK_REQUEST_RE = /(?:https?:\/\/|\b(?:ch\u1ed1t\s*l\u1ecbch|\u0111\u1eb7t\s*l\u1ecbch|nh\u1eafc\s*(?:l\u1ecbch|vi\u1ec7c|anh)|so\u1ea1n\s*(?:mail|email|tin|th\u01b0)|g\u1eedi\s*(?:mail|email)|b\u00e1o\s*c\u00e1o|t\u1ed5ng\s*h\u1ee3p|fact[- ]?check|tra\s*(?:c\u1ee9u|gi\u00fap)|check\s*(?:gi\u00fap|h\u1ed9|l\u1ea1i|xem\s*(?:l\u1ecbch|h\u1ea1n|gi\u00e1|\u0111\u01a1n|thu\u1ebf|mail|server|cron))|ki\u1ec3m\s*tra\s*(?:gi\u00fap|h\u1ed9|l\u1ea1i|l\u1ecbch|h\u1ea1n|gi\u00e1|\u0111\u01a1n|thu\u1ebf)|t\u00ednh\s*(?:gi\u00fap|h\u1ed9|ti\u1ec1n|thu\u1ebf|chi\s*ph\u00ed)|\u0111\u1eb7t\s*h\u1eb9n|deadline|h\u1ee3p\s*\u0111\u1ed3ng|h\u00f3a\s*\u0111\u01a1n|chuy\u1ec3n\s*kho\u1ea3n|b\u00e1o\s*gi\u00e1|th\u1ee7\s*t\u1ee5c|\u0111\u0103ng\s*ki\u1ec3m|l\u00e0m\s*l\u1ea1i\s*\u0111ky|fix\s*bug|deploy|cron)\b)/iu;

const SAD_HEAVY_RE = /\b(?:bu\u1ed3n\s*qu\u00e1|m\u1ec7t\s*(?:qu\u00e1|m\u1ecfi)|\u00e1p\s*l\u1ef1c|ki\u1ec7t\s*s\u1ee9c|\u0111u\u1ed1i|ch\u1ea1nh\s*l\u00f2ng|c\u0103ng\s*th\u1eb3ng|stress|m\u1ea5t\s*ng\u1ee7|c\u00f4\s*\u0111\u01a1n|tr\u1ed1ng\s*r\u1ed7ng|n\u1ea3n\s*qu\u00e1|c\u00f3\s*tang|qua\s*\u0111\u1eddi|nh\u1eadp\s*vi\u1ec7n|c\u1ea5p\s*c\u1ee9u|ho\u1ea3ng|t\u00e2m\s*s\u1ef1|(?:n\u00f3i|h\u1ecfi|b\u00e0n|tr\u1ea3\s*l\u1eddi)\s+nghi\u00eam\s*t\u00fac|nghi\u00eam\s*t\u00fac\s+(?:nha|nh\u00e9|\u0111i|l\u1ea1i|ch\u00fat)|\u0111\u1eebng\s*\u0111\u00f9a)\b|[\u{1f622}\u{1f62d}\u{1f61e}\u{1f614}\u{1f629}\u{1f62b}\u{1f97a}\u{1f494}]/iu;

// Tasteful affectionate/romantic cues (strictly non-explicit, DM-only when mode === 'open')
const FLIRTY_PULL_RE = /\b(?:nh\u1edb\s*(?:em|e|gi\u1ecdng)|th\u01b0\u01a1ng\s*(?:em|e|anh\s*k)|mu\u1ed1n\s*(?:\u00f4m|n\u1ef1ng|g\u1eb7p\s*(?:em|e))|ng\u1ecdt\s*qu\u00e1|c\u01b0ng\s*qu\u00e1|xinh\s*qu\u00e1|m\u00ea\s*(?:em|e)|cu\u1ed1n\s*(?:qu\u00e1|th\u1eadt)|th\u1ea3\s*th\u00ednh|chi\u1ec1u\s*anh|n\u1ef1ng\s*anh|\u00f4m\s*anh|d\u1ed7\s*anh)\b|[\u{1f970}\u{1f60d}\u2764\ufe0f]/iu;

const SERVICE_ISSUE_RE = /\b(?:khi\u1ebfu\s*n\u1ea1i|s\u1ef1\s*c\u1ed1|h\u1ecfng|b\u1ecb\s*l\u1ed7i|tr\u1ec5\s*\u0111\u01a1n|ch\u1eadm\s*qu\u00e1|ho\u00e0n\s*ti\u1ec1n|\u0111\u1ec1n\s*b\u00f9|b\u1ea3o\s*h\u00e0nh|th\u1ea5t\s*v\u1ecdng|kh\u00f4ng\s*h\u00e0i\s*l\u00f2ng|ph\u00e0n\s*n\u00e0n|m\u1ea5t\s*\u0111\u1ed3|\u0111\u1ed5i\s*tr\u1ea3|h\u1ee7y\s*\u0111\u01a1n|h\u1ee7y\s*ph\u00f2ng|sai\s*h\u00f3a\s*\u0111\u01a1n|t\u00ednh\s*nh\u1ea7m|l\u1ed7i\s*thanh\s*to\u00e1n|qu\u00e1\s*t\u1ec7|b\u1ef1c\s*m\u00ecnh)\b/iu;

const SALES_INTENT_RE = /\b(?:b\u00e1o\s*gi\u00e1|\u0111\u1eb7t\s*(?:g\u00f3i|\u0111o\u00e0n|th\u00eam)|n\u00e2ng\s*c\u1ea5p|upgrade|mua\s*th\u00eam|\u01b0u\s*\u0111\u00e3i|gi\u1ea3m\s*gi\u00e1|chi\u1ebft\s*kh\u1ea5u|ch\u1ed1t\s*g\u00f3i|ch\u1ecdn\s*g\u00f3i|g\u00f3i\s*n\u00e0o|k\u00fd\s*h\u1ee3p\s*\u0111\u1ed3ng|m\u1edf\s*r\u1ed9ng|so\s*g\u00f3i|t\u01b0\s*v\u1ea5n\s*g\u00f3i)\b/iu;

const SHIFT_CUES = Object.freeze({
  'assistant->companion-lively': 'Kh\u00f4ng kh\u00ed \u0111ang \u0111\u00f9a c\u1ee3t x\u00f4m t\u1ee5 \u2014 tr\u01b0\u1ee3t ngay sang gi\u1ecdng vui t\u01b0\u01a1i, tung h\u1ee9ng t\u1ef1 nhi\u00ean, d\u00ed d\u1ecfm h\u1ebft m\u00ecnh (kh\u00f4ng xin l\u1ed7i r\u1eadp khu\u00f4n); v\u1eabn ch\u1ed1t vi\u1ec7c s\u1eafc g\u1ecdn ngay khi m\u1ea1ch quay l\u1ea1i c\u00f4ng vi\u1ec7c.',
  'assistant->companion-warm': 'Anh \u0111ang c\u00f3 chuy\u1ec7n n\u1eb7ng l\u00f2ng \u2014 t\u1ea1m h\u1ea1 sang gi\u1ecdng B\u1ea1n t\u00e2m l\u00fd tr\u1ea7m \u1ea5m, l\u1eafng nghe ch\u00e2n th\u00e0nh, b\u1ecf h\u1eb3n l\u1eddi tr\u00eau \u0111\u00f9a hay gi\u1ecdng h\u00e0nh ch\u00ednh.',
  'teammate->assistant': 'Kh\u00f4ng kh\u00ed \u0111ang x\u1ea3 h\u01a1i tho\u1ea3i m\u00e1i \u2014 t\u1ea1m n\u1edbi nh\u1eb9 sang t\u00f4ng Tr\u1ee3 l\u00fd th\u00e2n thi\u1ec7n; l\u1eadp t\u1ee9c quay l\u1ea1i gi\u1ecdng \u0110\u1ed3ng nghi\u1ec7p th\u1eb3ng th\u1eafn khi v\u00e0o c\u00f4ng vi\u1ec7c.',
  'companion-lively->companion-warm': 'M\u1ea1ch v\u1eeba tr\u00f9ng xu\u1ed1ng \u2014 t\u1ea1m h\u1ea1 sang gi\u1ecdng B\u1ea1n t\u00e2m l\u00fd \u1ea5m \u00e1p, l\u1eafng nghe s\u00e2u, b\u1ecf l\u1eddi tr\u00eau \u0111\u00f9a.',
  'companion-lively->assistant': 'L\u01b0\u1ee3t n\u00e0y \u0111ang c\u1ea7n x\u1eed l\u00fd vi\u1ec7c/tra c\u1ee9u \u2014 t\u1ea1m quay v\u1ec1 gi\u1ecdng Tr\u1ee3 l\u00fd g\u1ecdn, ch\u00ednh x\u00e1c d\u1eef ki\u1ec7n v\u00e0 r\u00f5 r\u00e0ng; xong vi\u1ec7c t\u1ef1 quay l\u1ea1i m\u1ea1ch b\u1ea1n b\u00e8.',
  'companion-lively->companion-flirty': 'M\u1ea1ch ri\u00eang 1-1 \u0111ang ng\u1ecdt v\u00e0 th\u00e2n m\u1eadt \u2014 t\u1ea1m n\u00e2ng sang s\u1eafc th\u00e1i B\u1ea1n t\u00ecnh t\u1ee9 tinh t\u1ebf, \u1ea5m \u00e1p v\u00e0 cu\u1ed1n h\u00fat; t\u1ef1 h\u1ea1 ngay khi \u0111\u1ed5i chuy\u1ec7n.',
  'companion-flirty->companion-warm': 'Anh \u0111ang m\u1ec7t ho\u1eb7c n\u1eb7ng l\u00f2ng \u2014 t\u1ea1m h\u1ea1 l\u1eeda sang gi\u1ecdng B\u1ea1n t\u00e2m l\u00fd v\u1ed7 v\u1ec1, \u1ea5m \u00e1p v\u00e0 l\u1eafng nghe th\u1eadt l\u00f2ng.',
  'companion-flirty->assistant': 'L\u01b0\u1ee3t n\u00e0y \u0111ang c\u1ea7n ch\u1ed1t vi\u1ec7c/tra c\u1ee9u \u2014 t\u1ea1m chuy\u1ec3n sang gi\u1ecdng Tr\u1ee3 l\u00fd r\u00f5 r\u00e0ng, ch\u00ednh x\u00e1c d\u1eef ki\u1ec7n; xong vi\u1ec7c t\u1ef1 quay l\u1ea1i m\u1ea1ch ri\u00eang.',
  'companion-warm->assistant': 'L\u01b0\u1ee3t n\u00e0y \u0111ang c\u1ea7n x\u1eed l\u00fd vi\u1ec7c c\u1ee5 th\u1ec3 \u2014 t\u1ea1m quay v\u1ec1 gi\u1ecdng Tr\u1ee3 l\u00fd g\u1ecdn v\u00e0 chu\u1ea9n d\u1eef ki\u1ec7n.',
  'sales->service': 'Kh\u00e1ch \u0111ang g\u1eb7p v\u01b0\u1edbng m\u1eafc/ph\u1ea3n \u00e1nh \u2014 t\u1ea1m chuy\u1ec3n sang vai CSKH \u01b0u ti\u00ean xoa d\u1ecbu v\u00e0 x\u1eed l\u00fd tri\u1ec7t \u0111\u1ec3, kh\u00f4ng ch\u00e0o b\u00e1n th\u00eam.',
  'service->sales': 'Kh\u00e1ch \u0111ang ch\u1ee7 \u0111\u1ed9ng h\u1ecfi g\u00f3i/b\u00e1o gi\u00e1/n\u00e2ng c\u1ea5p \u2014 t\u1ea1m m\u1edf vai T\u01b0 v\u1ea5n \u0111\u1ecdc \u0111\u00fang nhu c\u1ea7u th\u1ef1c t\u1ebf, kh\u00f4ng ch\u00e8o k\u00e9o.',
});

export function isValidModeEscalation(mode) {
  return typeof mode === 'string' && Object.hasOwn(MODE_ESCALATION_MODES, mode);
}

export function extractGroupContextLines(promptText) {
  if (typeof promptText !== 'string' || !promptText) return [];
  const legacyStart = /\[Chat messages since your last reply[^\]]*\]\s*/iu.exec(promptText);
  if (legacyStart) {
    const afterStart = promptText.slice(legacyStart.index + legacyStart[0].length);
    const endIdx = afterStart.search(/\[Current message[^\]]*\]/iu);
    const block = (endIdx >= 0 ? afterStart.slice(0, endIdx) : afterStart).slice(0, 2400);
    return block
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^\[[^\]]{1,80}\]\s*/u, '').replace(/^[^:\n]{1,40}:\s+/u, '').replace(BOT_MENTION_STRIP_RE, '').trim())
      .filter(line => line.length >= 2)
      .slice(-6);
  }
  // GCI v2 universal room-line parser: `#12630 [21:02] Hung Nguyen(id=634278109): :))))`
  const gciMatches = [];
  for (const rawLine of promptText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const gm = /^#\d+\s+\[\d{1,2}:\d{2}\]\s+([^:\n]{1,120}):\s*(.+)$/u.exec(line);
    if (!gm) continue;
    const header = gm[1];
    // Never self-feed banter from bot's own previous replies
    if (/\[BOT\]|\((?:you|em)\)/iu.test(header)) continue;
    const cleaned = gm[2]
      .replace(/\s*\[tr\u00edch:\s*"[^"]*"\]/gu, '')
      .replace(/\s*\[t\u1ec7p:[^\]]*\]/gu, '')
      .replace(BOT_MENTION_STRIP_RE, '')
      .trim();
    if (cleaned.length >= 2) gciMatches.push(cleaned);
  }
  if (gciMatches.length) return gciMatches.slice(-8);

  const modernStart = /Conversation context\s*\([^)]*\):[^\n]*\n/iu.exec(promptText);
  if (!modernStart) return [];
  const tail = promptText.slice(modernStart.index + modernStart[0].length, modernStart.index + modernStart[0].length + 6000);
  const out = [];
  for (const rawLine of tail.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      if (out.length > 0) break;
      continue;
    }
    if (line.startsWith('#session:')) continue;
    if (line.startsWith('Current message:') || line.startsWith('legacy-host assembled context')) break;
    const m = /^#\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+GMT[+-]\d+(?::\d{2})?\s+(?:->#\d+\s+)?(?:\[reply target\]\s+)?([^:\n]{1,64}):\s*(.+)$/u.exec(line);
    if (!m || /\(you\)$/iu.test(m[1])) continue;
    const cleaned = m[2].replace(BOT_MENTION_STRIP_RE, '').trim();
    if (cleaned.length >= 2) out.push(cleaned);
  }
  return out.slice(-6);
}

function cleanLine(text) {
  return String(text ?? '').replace(BOT_MENTION_STRIP_RE, '').replace(/\s+/gu, ' ').trim();
}

export function classifyEscalationSignals(text) {
  const cleaned = cleanLine(text);
  if (!cleaned) {
    return {
      playful: false, explicitBanterPivot: false, work: false, taskRequest: false,
      sad: false, flirty: false, serviceIssue: false, salesIntent: false,
    };
  }
  const explicitBanterPivot = EXPLICIT_BANTER_PIVOT_RE.test(cleaned);
  const sad = !explicitBanterPivot && SAD_HEAVY_RE.test(cleaned);
  const work = WORK_OR_FACT_RE.test(cleaned);
  const taskRequest = WORK_TASK_REQUEST_RE.test(cleaned);
  const serviceIssue = SERVICE_ISSUE_RE.test(cleaned);
  const salesIntent = SALES_INTENT_RE.test(cleaned) && !serviceIssue;
  const playful = !sad && !work && !serviceIssue && (explicitBanterPivot || PLAYFUL_ROOM_RE.test(cleaned));
  const flirty = !sad && !work && !serviceIssue && FLIRTY_PULL_RE.test(cleaned);
  return {playful, explicitBanterPivot, work, taskRequest, sad, flirty, serviceIssue, salesIntent};
}

export function countPlayfulRoomMomentum(recentTexts = [], currentText = '') {
  const currentNorm = cleanLine(currentText).toLowerCase();
  let count = 0;
  const seen = new Set();
  for (const raw of recentTexts.slice(-12)) {
    const line = cleanLine(raw);
    if (!line) continue;
    const key = line.toLowerCase();
    if (key === currentNorm || seen.has(key)) continue;
    seen.add(key);
    const sig = classifyEscalationSignals(line);
    if (sig.playful) count += 1;
  }
  return count;
}

function isAllowedTarget(baseRoleId, targetRoleId, {genderId, mode, isGroup, isOwnerSpeaking}) {
  const allowed = ESCALATION_PAIRS[baseRoleId];
  if (!allowed || !allowed.includes(targetRoleId)) return false;
  if (!isValidVoicePreset(`${genderId}.${targetRoleId}`)) return false;
  if (targetRoleId === 'companion-flirty') {
    if (isGroup || mode !== 'open' || !isOwnerSpeaking) return false;
  }
  if (baseRoleId === 'assistant' && targetRoleId === 'companion-warm' && isGroup) {
    return false;
  }
  if (baseRoleId === 'service' && targetRoleId.startsWith('companion')) {
    return false;
  }
  return true;
}

function computeEscalatedHumanError(basePreset, targetPreset, baseCharacterHumanError) {
  if (!targetPreset) return null;
  if (targetPreset.humanError?.locked) {
    return {texturePercent: 0, correctionPercent: 0};
  }
  const baseRates = baseCharacterHumanError || basePreset?.humanError || {texturePercent: 0, correctionPercent: 0};
  const targetRates = targetPreset.humanError || {texturePercent: 0, correctionPercent: 0};
  // Lifting assistant/teammate -> companion-lively boosts expressiveness naturally
  if (targetPreset.roleId === 'companion-lively') {
    return {
      texturePercent: Math.min(50, Math.max(baseRates.texturePercent ?? 0, targetRates.texturePercent ?? 48)),
      correctionPercent: Math.min(10, Math.max(baseRates.correctionPercent ?? 0, targetRates.correctionPercent ?? 10)),
    };
  }
  // Tightening companion -> assistant lowers error rates for crisp task execution
  if (targetPreset.roleId === 'assistant') {
    return {
      texturePercent: Math.min(baseRates.texturePercent ?? 22, targetRates.texturePercent ?? 22),
      correctionPercent: Math.min(baseRates.correctionPercent ?? 5, targetRates.correctionPercent ?? 5),
    };
  }
  return {
    texturePercent: Math.min(50, Math.max(0, targetRates.texturePercent ?? 0)),
    correctionPercent: Math.min(10, Math.max(0, targetRates.correctionPercent ?? 0)),
  };
}

export function evaluateModeEscalation({
  basePreset = null,
  baseProfileKey = 'than-thien',
  baseHumanError = null,
  modeEscalation = 'auto',
  adaptiveLevel = 2,
  isGroup = false,
  isOwnerSpeaking = false,
  input = '',
  recentUserTexts = [],
  roomRecentTexts = [],
  promptText = '',
  affectState = null,
  prevState = null,
  nowMs = Date.now(),
} = {}) {
  const mode = isValidModeEscalation(modeEscalation) ? modeEscalation : 'auto';
  if (!basePreset) {
    return {escalated: false, baseRoleId: null, activeRoleId: null, activePreset: null, reason: null, cue: '', escalatedHumanError: null, state: null};
  }
  const baseRoleId = basePreset.roleId;
  const genderId = basePreset.genderId;

  const baseResult = (nextState = null, meta = {}) => ({
    escalated: false,
    baseRoleId,
    activeRoleId: baseRoleId,
    activePreset: basePreset,
    reason: null,
    cue: '',
    escalatedHumanError: null,
    roomPlayfulCount: Number(meta.roomPlayfulCount ?? 0),
    roomBanterActive: Boolean(meta.roomBanterActive),
    state: nextState || {
      baseRoleId,
      activeRoleId: baseRoleId,
      reason: null,
      enteredAtMs: null,
      updatedAtMs: nowMs,
      ttlMin: 0,
      banterStreak: 0,
      listenStreak: 0,
      flirtyStreak: 0,
      quietTurns: 0,
    },
  });

  if (mode === 'off' || adaptiveLevel === 0) {
    return baseResult();
  }

  const affect = affectState || {stance: 'collaborate', valence: 0, arousal: 0, urgent: false, hardGuard: null};
  const sig = classifyEscalationSignals(input);
  const groupLines = isGroup ? extractGroupContextLines(promptText) : [];
  const roomTexts = [...recentUserTexts, ...(Array.isArray(roomRecentTexts) ? roomRecentTexts : []), ...groupLines];
  const roomPlayfulCount = countPlayfulRoomMomentum(roomTexts, input);

  // Reset streaks if baseRole changed or long idle gap (> 30 min)
  const sameBase = prevState && prevState.baseRoleId === baseRoleId;
  const elapsedMin = sameBase && prevState.updatedAtMs
    ? Math.max(0, (nowMs - prevState.updatedAtMs) / 60000)
    : Infinity;
  const activeExpired = !sameBase || elapsedMin >= (prevState?.ttlMin || 25);

  const prevBanter = sameBase && elapsedMin < 20 ? Number(prevState.banterStreak ?? 0) : 0;
  const prevListen = sameBase && elapsedMin < 25 ? Number(prevState.listenStreak ?? 0) : 0;
  const prevFlirty = sameBase && elapsedMin < 20 ? Number(prevState.flirtyStreak ?? 0) : 0;
  const prevQuiet = sameBase && !activeExpired ? Number(prevState.quietTurns ?? 0) : 0;

  const isPlayfulTurn = !sig.work && !sig.taskRequest && !sig.sad && !affect.urgent && !affect.hardGuard
    && affect.stance !== 'listen' && affect.stance !== 'execute'
    && (sig.playful || (affect.stance === 'banter' && affect.valence >= 0.30));

  const isListenTurn = !sig.work && !sig.taskRequest && !affect.urgent
    && (affect.stance === 'listen' || sig.sad || ['crisis', 'bereavement', 'medical'].includes(affect.hardGuard));

  const isWorkSnapTurn = Boolean(
    sig.work || sig.taskRequest || affect.stance === 'execute' || affect.urgent || affect.hardGuard === 'commitment'
  );

  // Hot-room banter carryover (handles deadpan teasing without emoji in playful groups for ANY non-formal agent,
  // while snapping back immediately on any work/fact/sad/serviceIssue/crisis/serious turn!)
  const isNonFormalBase = !['service', 'sales'].includes(baseRoleId) && baseProfileKey !== 'nghiem-tuc';
  const roomBanterActive = Boolean(
    isGroup && isNonFormalBase && roomPlayfulCount >= 2
    && !isWorkSnapTurn && !isListenTurn && !sig.serviceIssue
    && !affect.hardGuard && !affect.urgent && affect.valence > -0.25
  );

  const isFlirtyTurn = !isGroup && isOwnerSpeaking && !isWorkSnapTurn && !isListenTurn
    && affect.valence >= 0.05 && sig.flirty;

  const banterStreak = (isPlayfulTurn || roomBanterActive) ? Math.min(8, prevBanter + 1) : (isWorkSnapTurn || isListenTurn ? 0 : 0);
  const listenStreak = isListenTurn ? Math.min(8, prevListen + 1) : 0;
  const flirtyStreak = isFlirtyTurn ? Math.min(8, prevFlirty + 1) : 0;

  let currentActive = (!activeExpired && prevState?.activeRoleId && prevState.activeRoleId !== baseRoleId)
    ? prevState.activeRoleId
    : baseRoleId;
  let reason = currentActive !== baseRoleId ? (prevState?.reason ?? null) : null;
  let enteredAtMs = currentActive !== baseRoleId ? (prevState?.enteredAtMs ?? nowMs) : null;
  let ttlMin = currentActive !== baseRoleId ? (prevState?.ttlMin ?? 25) : 0;
  let quietTurns = prevQuiet;

  // Step 1: Validate / Instant Snap-back for an active escalation
  if (currentActive !== baseRoleId) {
    const scopeStillAllowed = isAllowedTarget(baseRoleId, currentActive, {genderId, mode, isGroup, isOwnerSpeaking});
    let shouldExit = !scopeStillAllowed;

    if (!shouldExit) {
      if (currentActive === 'companion-lively' || (baseRoleId === 'teammate' && currentActive === 'assistant')) {
        if (isWorkSnapTurn || isListenTurn || affect.valence <= -0.15) {
          shouldExit = true;
        } else if (!isPlayfulTurn && roomPlayfulCount === 0) {
          quietTurns += 1;
          if (quietTurns >= 2) shouldExit = true;
        } else {
          quietTurns = 0;
        }
      } else if (currentActive === 'assistant') {
        // Task shift from companion-* snaps back on the very next non-work turn!
        if (!sig.taskRequest && !sig.work && affect.stance !== 'execute' && !affect.urgent && affect.hardGuard !== 'commitment') {
          shouldExit = true;
        }
      } else if (currentActive === 'companion-warm') {
        if (isWorkSnapTurn || affect.valence >= 0.15 || affect.stance === 'banter') {
          shouldExit = true;
        } else if (!isListenTurn) {
          quietTurns += 1;
          if (quietTurns >= 2) shouldExit = true;
        } else {
          quietTurns = 0;
        }
      } else if (currentActive === 'companion-flirty') {
        if (isWorkSnapTurn || isListenTurn || affect.valence <= -0.15) {
          shouldExit = true;
        } else if (!isFlirtyTurn && !isPlayfulTurn) {
          quietTurns += 1;
          if (quietTurns >= 2) shouldExit = true;
        } else {
          quietTurns = 0;
        }
      } else if (baseRoleId === 'sales' && currentActive === 'service') {
        if (sig.salesIntent && !sig.serviceIssue && affect.valence >= 0) {
          shouldExit = true;
        } else if (!sig.serviceIssue && !isListenTurn) {
          quietTurns += 1;
          if (quietTurns >= 2) shouldExit = true;
        } else {
          quietTurns = 0;
        }
      } else if (baseRoleId === 'service' && currentActive === 'sales') {
        if (sig.serviceIssue || isListenTurn || affect.valence < 0) {
          shouldExit = true;
        } else if (!sig.salesIntent) {
          quietTurns += 1;
          if (quietTurns >= 2) shouldExit = true;
        } else {
          quietTurns = 0;
        }
      }
    }

    if (shouldExit) {
      currentActive = baseRoleId;
      reason = null;
      enteredAtMs = null;
      ttlMin = 0;
      quietTurns = 0;
    }
  }

  // Step 2: Evaluate Entering a New Escalation (Hysteresis \u2014 slow up, fast down)
  if (currentActive === baseRoleId) {
    const enter = (targetRoleId, nextReason, nextTtlMin) => {
      if (!isAllowedTarget(baseRoleId, targetRoleId, {genderId, mode, isGroup, isOwnerSpeaking})) return false;
      currentActive = targetRoleId;
      reason = nextReason;
      enteredAtMs = nowMs;
      ttlMin = nextTtlMin;
      quietTurns = 0;
      return true;
    };

    if (baseRoleId === 'assistant') {
      if (isListenTurn && (listenStreak >= 2 || affect.valence <= -0.50 || ['crisis', 'bereavement', 'medical'].includes(affect.hardGuard))) {
        enter('companion-warm', 'dm_sustained_listen', 30);
      } else if (baseProfileKey !== 'nghiem-tuc' && (isPlayfulTurn || roomBanterActive)) {
        const instantPivot = Boolean(sig.explicitBanterPivot);
        const groupHot = isGroup && (instantPivot || roomBanterActive || roomPlayfulCount >= 1 || banterStreak >= 2);
        const dmSustained = !isGroup && isPlayfulTurn && (instantPivot || banterStreak >= 2 || (roomPlayfulCount >= 1 && sig.playful));
        if (groupHot || dmSustained) {
          const nextReason = instantPivot
            ? 'explicit_banter_pivot'
            : (roomBanterActive && !isPlayfulTurn
                ? 'group_banter_carryover'
                : (isGroup ? 'group_banter_momentum' : 'dm_banter_momentum'));
          enter('companion-lively', nextReason, 25);
        }
      }
    } else if (baseRoleId === 'teammate') {
      if (isPlayfulTurn && (banterStreak >= 2 || (isGroup && roomPlayfulCount >= 2))) {
        enter('assistant', 'team_wind_down', 20);
      }
    } else if (baseRoleId === 'companion-lively') {
      if (sig.taskRequest || affect.stance === 'execute' || affect.hardGuard === 'commitment') {
        enter('assistant', 'task_shift', 10);
      } else if (isListenTurn && (affect.valence <= -0.25 || ['crisis', 'bereavement', 'medical'].includes(affect.hardGuard))) {
        enter('companion-warm', 'emotional_deescalation', 25);
      } else if (isFlirtyTurn && flirtyStreak >= 2) {
        enter('companion-flirty', 'dm_romantic_momentum', 20);
      }
    } else if (baseRoleId === 'companion-flirty') {
      if (sig.taskRequest || affect.stance === 'execute' || affect.hardGuard === 'commitment') {
        enter('assistant', 'task_shift', 10);
      } else if (isListenTurn && (affect.valence <= -0.20 || ['crisis', 'bereavement', 'medical'].includes(affect.hardGuard))) {
        enter('companion-warm', 'emotional_care_shift', 25);
      }
    } else if (baseRoleId === 'companion-warm') {
      if (sig.taskRequest || affect.stance === 'execute' || affect.hardGuard === 'commitment') {
        enter('assistant', 'task_shift', 10);
      }
    } else if (baseRoleId === 'sales') {
      if (sig.serviceIssue || isListenTurn) {
        enter('service', 'customer_issue_support', 20);
      }
    } else if (baseRoleId === 'service') {
      if (sig.salesIntent && !sig.serviceIssue && !isListenTurn && affect.valence >= 0) {
        enter('sales', 'customer_purchase_intent', 20);
      }
    }
  }

  const nextState = {
    baseRoleId,
    activeRoleId: currentActive,
    reason,
    enteredAtMs,
    updatedAtMs: nowMs,
    ttlMin,
    banterStreak,
    listenStreak,
    flirtyStreak,
    quietTurns,
  };

  if (currentActive === baseRoleId) {
    return baseResult(nextState, { roomPlayfulCount, roomBanterActive });
  }

  const targetPresetId = `${genderId}.${currentActive}`;
  const targetPreset = resolveVoicePreset(targetPresetId);
  const cue = SHIFT_CUES[`${baseRoleId}->${currentActive}`] || '';
  const escalatedHumanError = computeEscalatedHumanError(basePreset, targetPreset, baseHumanError);

  return {
    escalated: true,
    baseRoleId,
    activeRoleId: currentActive,
    activePreset: targetPreset,
    targetPresetId,
    reason,
    cue,
    escalatedHumanError,
    roomPlayfulCount,
    roomBanterActive,
    state: nextState,
  };
}
