// Conversational Voice Core v2 \u2014 Channel-Capabilities-Aware Chat Behavior
// Covers:
//   - Fast-path debounce bypass (/commands, urgent cues) vs conversational burst merge window
//   - Reaction-instead-of-reply on bare acknowledgements when capabilities.reaction === true
//   - Proportional reading + typing delays when capabilities.typing === true
//   - Time-of-day rhythm (late night 23:00\u201305:59 calmer & shorter)
//   - Graceful conversation closure detector (suppresses filler follow-ups on goodbyes)

import {foldText} from './affect.js';

const COMMAND_RE = /^\s*\/[a-z0-9_-]+/i;
const BARE_ACK_RE = /^(?:(?:ok+|oke+|okay|k+|kk|uh+|uhm+|um+|yep|yup|uk+|vang|da)(?:[,\s]+(?:cam\s+on|thanks|thx|ty|em|anh|chi|ban|nha|nhe|nhieu|roi|luon))*|(?:got\s*it|noted|cool|nice|thanks|thx|ty|cam\s+on|roi|duoc\s+roi)(?:\s+(?:em|anh|chi|ban|nha|nhe|nhieu))*|[\u{1f44d}\u{1f44c}\u{1f64f}\u2764\ufe0f]+)[.!?\u2026\s]*$/iu;
const CLOSURE_RE = /\b(?:good\s*night|gn\b|sleep\s+well|ttyl|talk\s+later|gotta\s+go|gtg|bye|see\s+ya|heading\s+to\s+bed|ngu\s+ngon|di\s+ngu\s+day|thoi\s+di\s+ngu|tam\s+biet|mai\s+noi\s+tiep)\b/i;

export function analyzeIncomingBehavior(incomingText, {
  nowDate = new Date(),
  urgent = false,
  capabilities = {},
} = {}) {
  const raw = String(incomingText ?? '').trim();
  const folded = foldText(raw);
  const hour = nowDate.getHours();
  const lateNight = hour >= 23 || hour < 6;
  const isCommand = COMMAND_RE.test(raw);
  const isClosure = CLOSURE_RE.test(folded);
  const isBareAck = raw.length <= 24 && BARE_ACK_RE.test(folded) && !raw.includes('?');

  // Fast-path bypass: slash commands & urgent turns never wait on burst debounce
  const debounceMs = (isCommand || urgent) ? 0 : (raw.length <= 40 ? 5500 : 3500);
  const preferReactionOnly = isBareAck && capabilities.reaction === true && !isCommand;

  return {
    isCommand,
    isClosure,
    isBareAck,
    lateNight,
    debounceMs,
    preferReactionOnly,
    reactionEmoji: preferReactionOnly ? (folded.includes('cam on') || folded.includes('thank') || folded.includes('thx') ? '\u{1f64f}' : '\u{1f44d}') : null,
    suppressFollowUp: isClosure || lateNight,
  };
}

export function planDelivery({
  incomingText = '',
  bubbles = [],
  stance = 'collaborate',
  capabilities = {},
  nowDate = new Date(),
  urgent = false,
  editPlan = null,
  appendDelayMs = null,
} = {}) {
  const analysis = analyzeIncomingBehavior(incomingText, {nowDate, urgent, capabilities});
  if (analysis.preferReactionOnly) {
    return {
      action: 'react',
      reaction: analysis.reactionEmoji,
      bubbles: [],
      readDelayMs: 600,
      bubbleDelaysMs: [],
      editPlan: null,
      analysis,
    };
  }

  let outBubbles = (Array.isArray(bubbles) ? bubbles : [String(bubbles ?? '')])
    .map(b => b.trim())
    .filter(Boolean);

  // Late-night or non-bubble channels merge into tighter ceiling
  const maxB = capabilities.bubbles === false ? 1 : (analysis.lateNight ? 2 : outBubbles.length);
  if (outBubbles.length > maxB && maxB >= 1) {
    outBubbles = [...outBubbles.slice(0, maxB - 1), outBubbles.slice(maxB - 1).join(' ')];
  }

  // Reading delay proportional to incoming length (fast on execute/commands)
  const readDelayMs = (analysis.isCommand || stance === 'execute')
    ? 0
    : Math.min(2200, Math.max(400, Math.round(String(incomingText).length * 14)));

  // Per-bubble typing duration when capabilities.typing is supported
  const bubbleDelaysMs = outBubbles.map((b, idx) => {
    if (capabilities.typing !== true) return idx === 0 ? 0 : (appendDelayMs || 600);
    if (idx > 0 && appendDelayMs && idx === outBubbles.length - 1) return appendDelayMs;
    const baseMs = stance === 'execute' ? 450 : 750;
    return Math.min(3200, Math.max(baseMs, Math.round(b.length * 24)));
  });

  return {
    action: 'send',
    reaction: null,
    bubbles: outBubbles,
    readDelayMs,
    bubbleDelaysMs,
    editPlan,
    analysis,
  };
}
