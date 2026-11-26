// Conversational Voice Core v2 \u2014 Vietnamese Naturalness & AI-ness Evaluator
// Quantifies the exact failure modes observed in Vietnamese LLM chat:
//   1. Excessive subject pronouns ("em / anh / t\u00f4i / b\u1ea1n") vs natural Vietnamese pro-drop
//   2. Repetitive pronoun sentence openings ("Em ngh\u0129...", "Em bi\u1ebft r\u1ed3i...", "Anh k\u1ec3 em...")
//   3. English-to-Vietnamese translationese ("c\u00f3 c\u01a1 s\u1edf", "gi\u00e1 tr\u1ecb th\u1ef1c", "kh\u00f4ng c\u00f3 ngh\u0129a", ...)
//   4. Robotic AI disclaimers ("ch\u01b0a ki\u1ec3m ch\u1ee9ng \u0111\u01b0\u1ee3c", "kh\u00f4ng c\u00f3 cu\u1ed9c s\u1ed1ng ri\u00eang", ...)

const WORD_RE = /[\p{L}\p{M}]+/gu;
const PRONOUN_SET = new Set(['em', 'anh', 't\u00f4i', 'toi', 'b\u1ea1n', 'ban', 'm\u00ecnh', 'minh']);
const PRONOUN_START_RE = /^(?:[\u201c"'(\u2022\-*\s]*)?(?:em|anh|t\u00f4i|b\u1ea1n|m\u00ecnh)(?=$|[\s,.!?\u2026])/iu;
const PARTICLE_END_RE = /(?:^|[^\p{L}\p{M}])(nh\u1ec9|nha|nh\u00e9|n\u00e8|\u0111\u1ea5y|th\u1ebf|nh\u1ec3|ha)(?=[.!?\u2026\s]*$)/iu;

const TRANSLATIONESE_PATTERNS = [
  /c\u00f3\s+c\u01a1\s+s\u1edf/iu,
  /gi\u00e1\s+tr\u1ecb\s+th\u1ef1c/iu,
  /kh\u00f4ng\s+c\u00f3\s+ngh\u0129a(?:\s+l\u00e0)?/iu,
  /m\u1ed9t\s+c\u00e1ch\s+(?:hi\u1ec7u\s+qu\u1ea3|r\u00f5\s+r\u00e0ng|t\u1ef1\s+nhi\u00ean)/iu,
  /\u0111i\u1ec1u\s+quan\s+tr\u1ecdng\s+l\u00e0/iu,
  /c\u1ee5\s+th\u1ec3\s+c\u1ee7a\s+(?:anh|b\u1ea1n)/iu,
  /t\u00e2m\s+tr\u1ea1ng\s+(?:anh|b\u1ea1n)\s+c\u00f3\s+kh\u00e1\s+h\u01a1n/iu,
  /n\u1ed7i\s+lo\s+\u0111\u00f3/iu,
  /c\u1ea3m\s+x\u00fac\s+c\u1ee7a\s+(?:anh|b\u1ea1n)/iu,
  /\u0111\u00e1ng\s+ch\u00fa\s+\u00fd\s+th\u1eadt/iu,
  /ch\u1ea5m\s+m\u00f9/iu,
  /(?:b\u1eaft\s+sai|ch\u1ec7ch|tr\u1eadt|l\u1ec7ch|gi\u1eef|\u0111\u00fang)\s+nh\u1ecbp/iu,
  /\u0111\u01b0\u1eddng\s+c\u01a1\s+s\u1edf/iu,
  /tr\u1ea3i\s+nghi\u1ec7m\s+li\u1ec1n\s+m\u1ea1ch/iu,
  /\u0111i\u1ec3m\s+ch\u1ea1m/iu,
  /v\u00f2ng\s+ph\u1ea3n\s+h\u1ed3i/iu,
];

const DISCLAIMER_PATTERNS = [
  /ch\u01b0a\s+(?:t\u1ef1\s+)?ki\u1ec3m\s+ch\u1ee9ng\s+\u0111\u01b0\u1ee3c/iu,
  /kh\u00f4ng\s+c\u00f3\s+cu\u1ed9c\s+s\u1ed1ng\s+ri\u00eang/iu,
  /l\u00e0\s+(?:m\u1ed9t\s+)?(?:tr\u1ee3\s+l\u00fd\s+)?ai\b/iu,
  /l\u00e0\s+m\u00f4\s+h\u00ecnh\s+ng\u00f4n\s+ng\u1eef/iu,
];

function splitSentences(text) {
  return String(text ?? '')
    .replace(/\[\[bubble\]\]/g, '\n')
    .split(/(?:[\r\n]+|[.!?\u2026]+\s+)/u)
    .map(s => s.trim())
    .filter(s => (s.match(WORD_RE) || []).length >= 2);
}

export function analyzeVietnameseNaturalness(input) {
  const turns = (Array.isArray(input) ? input : [input])
    .map(t => String(t ?? '').normalize('NFC').trim())
    .filter(Boolean);

  let totalWords = 0;
  let pronounCount = 0;
  let totalSentences = 0;
  let pronounStartSentences = 0;
  let questionTurns = 0;
  const particleCounts = new Map();
  const translationeseMatches = [];
  const disclaimerMatches = [];

  for (const turn of turns) {
    const words = turn.toLocaleLowerCase('vi-VN').match(WORD_RE) || [];
    totalWords += words.length;
    for (const w of words) {
      if (PRONOUN_SET.has(w)) pronounCount++;
    }
    if (turn.includes('?')) questionTurns++;
    const sentences = splitSentences(turn);
    totalSentences += sentences.length;
    for (const s of sentences) {
      if (PRONOUN_START_RE.test(s)) pronounStartSentences++;
      const pm = s.match(PARTICLE_END_RE);
      if (pm) {
        const key = pm[1].toLocaleLowerCase('vi-VN');
        particleCounts.set(key, (particleCounts.get(key) || 0) + 1);
      }
    }
    for (const re of TRANSLATIONESE_PATTERNS) {
      const m = turn.match(re);
      if (m) translationeseMatches.push(m[0]);
    }
    for (const re of DISCLAIMER_PATTERNS) {
      const m = turn.match(re);
      if (m) disclaimerMatches.push(m[0]);
    }
  }

  const pronounDensity = totalWords ? Number(((pronounCount / totalWords) * 100).toFixed(1)) : 0;
  const pronounStartRate = totalSentences ? Number(((pronounStartSentences / totalSentences) * 100).toFixed(1)) : 0;
  const questionTurnRate = turns.length ? Number(((questionTurns / turns.length) * 100).toFixed(1)) : 0;
  let topParticle = null;
  let topParticleCount = 0;
  for (const [k, v] of particleCounts.entries()) {
    if (v > topParticleCount) { topParticle = k; topParticleCount = v; }
  }
  const particleRepeatRate = turns.length ? Number(((topParticleCount / turns.length) * 100).toFixed(1)) : 0;

  // Risk score 0..100 (lower = more native human Vietnamese chat)
  const densityPenalty = Math.max(0, pronounDensity - 7) * 3.5;
  const startPenalty = Math.max(0, pronounStartRate - 25) * 0.65;
  const particlePenalty = turns.length >= 4 && particleRepeatRate >= 35 ? Math.round((particleRepeatRate - 30) * 0.5) : 0;
  const transPenalty = translationeseMatches.length * 14;
  const discPenalty = disclaimerMatches.length * 20;
  const aiRiskScore = Math.min(100, Math.round(densityPenalty + startPenalty + particlePenalty + transPenalty + discPenalty));

  const verdict = aiRiskScore <= 20 ? 'natural' : aiRiskScore <= 45 ? 'slightly_stiff' : 'ai_heavy';

  return {
    turns: turns.length,
    totalWords,
    pronounCount,
    pronounDensity,       // target <= 8%
    totalSentences,
    pronounStartSentences,
    pronounStartRate,     // target <= 30%
    questionTurnRate,     // target ~35-55% (not 80%+ interview loop)
    topParticle,
    topParticleCount,
    particleRepeatRate,   // target < 30%
    translationeseHits: translationeseMatches.length,
    translationeseMatches,
    disclaimerHits: disclaimerMatches.length,
    disclaimerMatches,
    aiRiskScore,
    verdict,
  };
}
