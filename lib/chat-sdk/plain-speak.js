// SCROLL 2.5 -- Channel-Agnostic PlainSpeak Engine (`@agentpro/scroll/chat`).
//
// Eliminates unnatural AI translationese ("calques") and audience-mismatched technical jargon
// across ANY chat agent and ANY channel (Telegram, Zalo, Slack, Discord, WhatsApp, Web, RIVER)
// with ZERO hardcoded prose or domain rules inside core code.
//
// Architecture (data-driven & machine-enforced):
//   1. Declarative JSON Pack Schema (`schemaVersion: 1`, composable across core + domain + custom packs)
//      with 3 distinct tiers (A: hard AI calques, B: tech/ops jargon, C: domain gloss terms)
//      and 3 explicit actions (`swap` 0-token safe only, `hint` pre-gen + optional rewrite, `gloss` keep term + short gloss).
//   2. 0-token Audience Register Detector (`casual_human` | `client_plain` | `expert_peer`) +
//      User Mirroring Guard (never corrects or rewrites terms the user themselves just typed).
//   3. Region-C Pre-Gen Guidance (100% §13 prefixHash / Codex thread-reuse invariant!).
//   4. Protected-Span Masker (code blocks, inline code, URLs, quotes, numbers/amounts/dates/codes/law IDs,
//      pack `protectedTerms`) + 0-token `action="swap"` filter gated by §43 `verifyClaimsInvariant`.
//   5. Bounded 1x Ephemeral Self-Rewrite Gate (`ephemeral: true`, no tools, never mutates main thread,
//      strict length ratio + §43 `verifyClaimsInvariant` + negation/condition preservation + net hit reduction).
//   6. Prompt-Injection-Safe Telemetry (`jargon-watch-<accountId>.jsonl`): logs ONLY whitelisted pack term IDs,
//      tier, register, and structured flags — NEVER stores raw untrusted user text for future prompt loading.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyClaimsInvariant } from '../grounding.js';

export const PLAIN_SPEAK_REGISTERS = Object.freeze(['casual_human', 'client_plain', 'expert_peer']);
export const PLAIN_SPEAK_TIERS = Object.freeze(['A', 'B', 'C']);
export const PLAIN_SPEAK_ACTIONS = Object.freeze(['swap', 'hint', 'gloss']);

export const DEFAULT_PLAIN_SPEAK_CONFIG = Object.freeze({
  enabled: true,
  mode: 'live', // 'live' | 'shadow' | 'off'
  defaultRegister: 'casual_human',
  forceRegister: null,
  locale: 'en',
  dateOrder: 'dmy',
  rewriteEnabled: true,
  rewriteMaxChars: 1200,
  rewriteTimeoutMs: 4_500,
  rewriteMaxTurnLatencyMs: 6_000,
  rewriteTierBMinHits: 2,
  rewriteMinRatio: 0.45,
  rewriteMaxRatio: 1.55,
  maxPreGenExamples: 4,
  telemetryEnabled: true,
  telemetryMaxBytes: 512 * 1024,
});

// Default neutral English/Vietnamese pre-gen templates (overridable via pack.promptTemplates or config.templates)
export const DEFAULT_PLAIN_SPEAK_TEMPLATES = Object.freeze({
  en: Object.freeze({
    header: 'Before using technical jargon or stiff phrasing, ask: would the person reading this naturally say it that way?',
    registers: Object.freeze({
      casual_human: 'casual_human: speak like a sharp, relatable colleague; swap stiff or technical phrasing for everyday words.',
      client_plain: 'client_plain: prefer everyday wording; keep legally required terms accurate and add a brief 4–6 word plain explanation on first use.',
      expert_peer: 'expert_peer: domain terms are fine when the user uses them first, but still avoid unnatural literal translations or robotic filler.',
    }),
    footer: 'Keep the same sharpness and brevity. Never over-explain.',
    rewriteSystem: [
      'You are a precision plain-language copy editor.',
      'Rewrite ONLY the flagged stiff/technical/calque phrases into natural everyday phrasing matching the original tone and length.',
      'STRICT INVARIANTS:',
      '1. Preserve EVERY number, currency amount, percentage, date, time, code, tax ID, account number, form ID, URL, and proper name VERBATIM.',
      '2. Preserve EVERY subject, negation ("not/never/không/chưa"), condition ("if/unless/nếu/trừ khi"), commitment, and `[[bubble]]` separator.',
      '3. Do NOT add new facts, apologies, or extra explanations. Keep length close to the original.',
      '4. Return ONLY the rewritten message text with no markdown fences or commentary.',
    ].join('\n'),
  }),
  vi: Object.freeze({
    header: 'Trước khi dùng một từ kỹ thuật hay cụm dịch từ tiếng Anh, tự hỏi 1 giây: người đang nghe có tự nói câu này ngoài đời không?',
    registers: Object.freeze({
      casual_human: 'casual_human: nói như đồng nghiệp thân nói chuyện ngoài đời; đổi từ kỹ thuật/dịch máy sang cách nói gần gũi tự nhiên.',
      client_plain: 'client_plain: ưu tiên lời đời thường dễ hiểu; giữ đúng thuật ngữ pháp lý/nghiệp vụ bắt buộc và kèm giải thích gọn 4–6 chữ ở lần đầu.',
      expert_peer: 'expert_peer: dùng từ chuyên môn thoải mái nếu chính người dùng đang dùng trước, nhưng vẫn bỏ tuyệt đối cụm dịch máy ngượng.',
    }),
    footer: 'Đổi từ cho gần gũi, giữ nguyên độ sắc và nhịp ngắn gọn. Không giải thích thừa.',
    rewriteSystem: [
      'Bạn là biên tập viên lời chat tiếng Việt tự nhiên.',
      'CHỈ sửa các cụm từ kỹ thuật hoặc dịch máy bị gắn cờ sang cách nói tiếng Việt đời thường, gần gũi, giữ nguyên giọng điệu và độ ngắn của bản gốc.',
      'BẤT BIẾN TUYỆT ĐỐI:',
      '1. Giữ NGUYÊN VẸN 100% mọi con số, số tiền, tỷ lệ %, ngày giờ, mã số thuế, số tài khoản, tên biểu mẫu, điều luật, tên riêng và đường link.',
      '2. Giữ nguyên chủ thể, phủ định (không/chưa/cấm/đừng), điều kiện (nếu/trừ khi), cam kết và dấu tách `[[bubble]]`.',
      '3. KHÔNG thêm thông tin mới, KHÔNG giải thích dài dòng, KHÔNG bọc ngoặc kép hay markdown.',
      '4. Chỉ trả về đúng nội dung tin nhắn đã sửa gọn.',
    ].join('\n'),
  }),
});

// Protected-span matchers (INV-PS-1 & INV-PS-2: masked BEFORE any scan/swap and restored verbatim AFTER!)
const PROTECTED_SPAN_PATTERNS = [
  /```[\s\S]*?```/g, // fenced code blocks
  /`[^`\n]+`/g, // inline code
  /\[[^\]\n]{1,120}\]\(https?:\/\/[^\s)]+\)/gi, // markdown links
  /\bhttps?:\/\/[^\s<>"')\]`]+/gi, // raw URLs
  /<replied_message>[\s\S]*?<\/replied_message>/gi, // replied message XML spans
  /"[^"\n]{1,240}"/g, // ASCII double quotes
  /“[^”\n]{1,240}”/g, // curly double quotes
  /«[^»\n]{1,240}»/g, // guillemets
  /(?<![\p{L}\p{N}_])\/[a-z][a-z0-9_-]{1,32}\b/giu, // slash commands e.g. /distill, /latch
  /(?<![\p{L}\p{N}_])@[A-Za-z0-9_]{3,40}\b/g, // @handles
  /\b(?:TT|NĐ|NQ|QĐ|CV|VBHN|Luật)\s*\d+(?:\/\d{4}(?:\/[A-ZĐ0-9-]+)?)?/giu, // VN legal citations
  /\b\d{2}\/[A-ZĐ0-9-]{2,14}\b/gu, // tax/form codes e.g. 01/GTGT, 01/KHBS, 02/TB-TĐT
  /\b[A-Z]\d-\d{2}\/[A-ZĐ]{2,6}\b/gu, // treasury forms e.g. C1-11/NS
  /\bTK\s*\d{3,4}[A-Z0-9]*\b/giu, // accounting account codes e.g. TK 332, TK 1331
  /\[[A-Z0-9]{1,4}\]/g, // tax return line indices e.g. [43], [B4]
  /\b\d{10}(?:-\d{3})?\b/g, // 10/13-digit tax IDs
];

// Extended structured token extractors for INV-PS-1 (covers VN form/legal/account/percent/time beyond base §43)
const EXTENDED_INVARIANT_PATTERNS = [
  ['form_code', /\b(?:\d{2}\/[A-ZĐ0-9-]{2,14}|[A-Z]\d-\d{2}\/[A-ZĐ]{2,6})\b/gu],
  ['legal_ref', /\b(?:TT|NĐ|NQ|QĐ|CV|VBHN|Luật)\s*\d+\/\d{4}(?:\/[A-ZĐ0-9-]+)?/giu],
  ['acct_code', /\bTK\s*\d{3,4}[A-Z0-9]*\b/giu],
  ['line_idx', /\[[A-Z0-9]{1,4}\]/g],
  ['percent', /\b\d+(?:[.,]\d+)?\s*%/g],
  ['clock_time', /\b(?:[01]?\d|2[0-3])(?:[:h][0-5]\d)\b/gi],
];

function extractExtendedTokenMultiset(text) {
  const s = String(text || '').normalize('NFC');
  const bag = new Map();
  for (const [kind, re] of EXTENDED_INVARIANT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const key = `${kind}:${m[0].replace(/\s+/g, '').toUpperCase()}`;
      bag.set(key, (bag.get(key) || 0) + 1);
    }
  }
  return bag;
}

/**
 * INV-PS-1: Hard Extended Claims Invariant combining base §43 `verifyClaimsInvariant`
 * with exact multiset preservation of VN tax form codes, legal refs, TK account codes,
 * tax-return line brackets (`[43]`), percentages, and clock times.
 */
export function verifyExtendedPlainSpeakInvariant(rawBaseline, candidate, { dateOrder = 'dmy' } = {}) {
  const base = verifyClaimsInvariant(rawBaseline, candidate, { dateOrder });
  if (!base.ok) return { ok: false, reason: 'base_claims_invariant', base };
  const before = extractExtendedTokenMultiset(rawBaseline);
  const after = extractExtendedTokenMultiset(candidate);
  const allKeys = new Set([...before.keys(), ...after.keys()]);
  const diffs = [];
  for (const k of allKeys) {
    const b = before.get(k) || 0;
    const a = after.get(k) || 0;
    if (b !== a) diffs.push({ token: k, before: b, after: a });
  }
  if (diffs.length) {
    return { ok: false, reason: 'extended_token_drift', diffs };
  }
  return { ok: true };
}

// Negation & modal safety anchors checked on LLM rewrites (prevents silent meaning flips!)
const NEGATION_RE = /(?<![\p{L}\p{N}])(?:không|chưa|chẳng|đừng|cấm|miễn|trừ\s+khi|not|never|don't|cannot|can't|won't|unless|except)(?![\p{L}\p{N}])/giu;

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTerm(s) {
  return String(s || '').normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function buildWordBoundaryRegex(term) {
  const clean = String(term || '').normalize('NFC').trim();
  if (!clean) return null;
  const escaped = escapeRegex(clean).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_/-])${escaped}(?![\\p{L}\\p{M}\\p{N}_/-])`, 'giu');
}

function safeCompilePatterns(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (item instanceof RegExp) {
      out.push(item);
    } else if (typeof item === 'string' && item.trim()) {
      try { out.push(new RegExp(item, 'iu')); } catch { /* skip bad pattern */ }
    }
  }
  return out;
}

export function validatePlainSpeakPack(pack) {
  const errors = [];
  const warnings = [];
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return { ok: false, errors: ['pack must be a plain object'], warnings };
  }
  if (pack.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion: ${pack.schemaVersion} (expected 1)`);
  }
  if (!String(pack.id || '').trim()) {
    errors.push('pack.id is required');
  }
  if (!String(pack.locale || '').trim()) {
    errors.push('pack.locale is required');
  }
  if (!Array.isArray(pack.entries)) {
    errors.push('pack.entries must be an array');
    return { ok: false, errors, warnings };
  }
  for (let i = 0; i < pack.entries.length; i++) {
    const e = pack.entries[i];
    if (!e || typeof e !== 'object') {
      errors.push(`entries[${i}] must be an object`);
      continue;
    }
    if (!String(e.term || '').trim()) errors.push(`entries[${i}].term is required`);
    if (!PLAIN_SPEAK_TIERS.includes(String(e.tier || '').toUpperCase())) {
      errors.push(`entries[${i}].tier must be A|B|C`);
    }
    if (!PLAIN_SPEAK_ACTIONS.includes(String(e.action || '').toLowerCase())) {
      errors.push(`entries[${i}].action must be swap|hint|gloss`);
    }
    if (String(e.tier || '').toUpperCase() === 'C' && String(e.action || '').toLowerCase() === 'swap') {
      errors.push(`entries[${i}]: Tier C domain/legal terms must NEVER use action="swap" (use "gloss" or "hint")`);
    }
    if (String(e.action || '').toLowerCase() === 'swap' && typeof e.plain !== 'string') {
      errors.push(`entries[${i}]: action="swap" requires string field "plain" (can be "" to delete filler)`);
    }
    if (String(e.action || '').toLowerCase() === 'swap' && String(e.term || '').trim().split(/\s+/).length === 1 && String(e.term || '').trim().length <= 4) {
      warnings.push(`entries[${i}]: short single-word swap ("${e.term}") carries polysemy risk`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function loadPlainSpeakPackFromFile(filePath) {
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  const parsed = JSON.parse(raw);
  const check = validatePlainSpeakPack(parsed);
  if (!check.ok) {
    throw new Error(`Invalid PlainSpeak pack (${path.basename(filePath)}): ${check.errors.join('; ')}`);
  }
  return parsed;
}

export function mergePlainSpeakPacks(packs = []) {
  const byTerm = new Map();
  const protectedTerms = new Set();
  const expertPatterns = [];
  const clientPlainPatterns = [];
  const confusionFeedbackPatterns = [];
  const packIds = [];
  let locale = 'en';

  for (const rawPack of packs || []) {
    if (!rawPack) continue;
    const pack = typeof rawPack === 'string' ? loadPlainSpeakPackFromFile(rawPack) : rawPack;
    const chk = validatePlainSpeakPack(pack);
    if (!chk.ok) {
      throw new Error(`Invalid PlainSpeak pack (${pack?.id || 'inline'}): ${chk.errors.join('; ')}`);
    }
    packIds.push(String(pack.id));
    if (pack.locale) locale = String(pack.locale);
    for (const pt of pack.protectedTerms || []) {
      const clean = String(pt || '').trim();
      if (clean) protectedTerms.add(clean);
    }
    if (pack.registerSignals && typeof pack.registerSignals === 'object') {
      expertPatterns.push(...safeCompilePatterns(pack.registerSignals.expertPatterns));
      clientPlainPatterns.push(...safeCompilePatterns(pack.registerSignals.clientPlainPatterns));
      confusionFeedbackPatterns.push(...safeCompilePatterns(pack.registerSignals.confusionFeedbackPatterns));
    }
    for (const entry of pack.entries || []) {
      const norm = normalizeTerm(entry.term);
      if (!norm) continue;
      const tier = String(entry.tier).toUpperCase();
      const action = String(entry.action).toLowerCase();
      const defaultRegs = tier === 'A'
        ? ['casual_human', 'client_plain', 'expert_peer']
        : (tier === 'C' ? ['client_plain'] : ['casual_human', 'client_plain']);
      const registers = Array.isArray(entry.registers) && entry.registers.length
        ? entry.registers.filter((r) => PLAIN_SPEAK_REGISTERS.includes(r))
        : defaultRegs;
      const regex = buildWordBoundaryRegex(entry.term);
      if (!regex) continue;
      const excludePatterns = safeCompilePatterns(entry.excludePatterns);
      byTerm.set(norm, {
        term: String(entry.term).normalize('NFC').trim(),
        normTerm: norm,
        plain: typeof entry.plain === 'string' ? entry.plain.normalize('NFC') : '',
        tier,
        action,
        registers: new Set(registers),
        example: typeof entry.example === 'string' ? entry.example.trim() : null,
        excludePatterns,
        regex,
        packId: String(pack.id),
      });
    }
  }

  // Sort longer terms first so multi-word calques match before substrings
  const entries = [...byTerm.values()].sort((a, b) => b.term.length - a.term.length);
  const protectedRegexes = [...protectedTerms]
    .sort((a, b) => b.length - a.length)
    .map((t) => buildWordBoundaryRegex(t))
    .filter(Boolean);

  return {
    packIds,
    locale,
    entries,
    protectedTerms: [...protectedTerms],
    protectedRegexes,
    expertPatterns,
    clientPlainPatterns,
    confusionFeedbackPatterns,
  };
}

export function maskProtectedSpans(text, extraProtectedRegexes = []) {
  const src = String(text ?? '');
  const tokens = [];
  const stash = (match) => {
    const idx = tokens.length;
    tokens.push(match);
    return `\uE000PS${idx}\uE001`;
  };
  let masked = src;
  for (const re of PROTECTED_SPAN_PATTERNS) {
    re.lastIndex = 0;
    masked = masked.replace(re, stash);
  }
  for (const re of extraProtectedRegexes || []) {
    re.lastIndex = 0;
    masked = masked.replace(re, stash);
  }
  return {
    masked,
    restore(str) {
      return String(str ?? '').replace(/\uE000PS(\d+)\uE001/g, (_, idx) => tokens[Number(idx)] ?? '');
    },
  };
}

export function resolvePlainSpeakConfig(globalCfg = {}, agentCfg = {}) {
  const g = (globalCfg && typeof globalCfg === 'object') ? (globalCfg.plainSpeak || globalCfg) : {};
  const a = (agentCfg && typeof agentCfg === 'object') ? (agentCfg.plainSpeak || agentCfg) : {};
  const merged = {
    ...DEFAULT_PLAIN_SPEAK_CONFIG,
    ...(typeof g === 'object' ? g : {}),
    ...(typeof a === 'object' ? a : {}),
  };
  const mode = ['live', 'shadow', 'off'].includes(String(merged.mode || '').toLowerCase())
    ? String(merged.mode).toLowerCase()
    : 'live';
  const defaultRegister = PLAIN_SPEAK_REGISTERS.includes(merged.defaultRegister)
    ? merged.defaultRegister
    : 'casual_human';
  const forceRegister = PLAIN_SPEAK_REGISTERS.includes(merged.forceRegister)
    ? merged.forceRegister
    : null;
  return Object.freeze({
    enabled: merged.enabled !== false && mode !== 'off',
    mode,
    defaultRegister,
    forceRegister,
    locale: String(merged.locale || 'en'),
    dateOrder: String(merged.dateOrder || 'dmy'),
    rewriteEnabled: merged.rewriteEnabled !== false,
    rewriteMaxChars: Math.max(120, Number(merged.rewriteMaxChars ?? DEFAULT_PLAIN_SPEAK_CONFIG.rewriteMaxChars)),
    rewriteTimeoutMs: Math.max(500, Number(merged.rewriteTimeoutMs ?? DEFAULT_PLAIN_SPEAK_CONFIG.rewriteTimeoutMs)),
    rewriteMaxTurnLatencyMs: Math.max(1_000, Number(merged.rewriteMaxTurnLatencyMs ?? DEFAULT_PLAIN_SPEAK_CONFIG.rewriteMaxTurnLatencyMs)),
    rewriteTierBMinHits: Math.max(1, Number(merged.rewriteTierBMinHits ?? DEFAULT_PLAIN_SPEAK_CONFIG.rewriteTierBMinHits)),
    rewriteMinRatio: Math.max(0.2, Number(merged.rewriteMinRatio ?? DEFAULT_PLAIN_SPEAK_CONFIG.rewriteMinRatio)),
    rewriteMaxRatio: Math.min(3.0, Number(merged.rewriteMaxRatio ?? DEFAULT_PLAIN_SPEAK_CONFIG.rewriteMaxRatio)),
    maxPreGenExamples: Math.max(0, Number(merged.maxPreGenExamples ?? DEFAULT_PLAIN_SPEAK_CONFIG.maxPreGenExamples)),
    telemetryEnabled: merged.telemetryEnabled !== false,
    telemetryMaxBytes: Math.max(16_384, Number(merged.telemetryMaxBytes ?? DEFAULT_PLAIN_SPEAK_CONFIG.telemetryMaxBytes)),
  });
}

function countNegations(text) {
  const m = String(text || '').match(NEGATION_RE);
  return m ? m.length : 0;
}

function preserveCaseReplacement(matched, replacement) {
  if (!replacement) return '';
  if (!matched) return replacement;
  const first = matched[0];
  const isUpper = first === first.toLocaleUpperCase() && first !== first.toLocaleLowerCase();
  if (!isUpper) return replacement;
  return replacement[0].toLocaleUpperCase() + replacement.slice(1);
}

export function createPlainSpeakEngine({
  packs = [],
  config = {},
  stateDir = null,
  accountId = 'default',
  templates = null,
  logger = console,
} = {}) {
  const cfg = resolvePlainSpeakConfig(config);
  const compiled = mergePlainSpeakPacks(packs);
  const langKey = /^vi\b/i.test(String(cfg.locale || compiled.locale || 'en')) ? 'vi' : 'en';
  const baseTpl = DEFAULT_PLAIN_SPEAK_TEMPLATES[langKey] || DEFAULT_PLAIN_SPEAK_TEMPLATES.en;
  const tpl = templates && typeof templates === 'object'
    ? {
        header: templates.header || baseTpl.header,
        registers: { ...baseTpl.registers, ...(templates.registers || {}) },
        footer: templates.footer || baseTpl.footer,
        rewriteSystem: templates.rewriteSystem || baseTpl.rewriteSystem,
      }
    : baseTpl;

  const safeAcct = String(accountId || 'default').replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  const telemetryPath = (stateDir && cfg.telemetryEnabled)
    ? path.join(path.resolve(stateDir), `jargon-watch-${safeAcct}.jsonl`)
    : null;

  function detectRegister({
    incomingText = '',
    recentUserTexts = [],
    defaultRegister = cfg.defaultRegister,
  } = {}) {
    const curr = String(incomingText || '').normalize('NFC');
    const recentJoined = [curr, ...(Array.isArray(recentUserTexts) ? recentUserTexts.slice(-2) : [])]
      .map((s) => String(s || '').normalize('NFC'))
      .join('\n');

    // INV-PS-4 Mirroring guard: track pack terms the caller used across current + last 2 user turns (3-turn window!)
    const userUsedTerms = new Set();
    for (const entry of compiled.entries) {
      entry.regex.lastIndex = 0;
      if (entry.regex.test(recentJoined)) userUsedTerms.add(entry.normTerm);
    }

    // Detect confusion feedback from user (e.g. "chấm mù?", "là cái gì?", "nói dễ hiểu đi")
    const confusionSignal = compiled.confusionFeedbackPatterns.some((re) => {
      re.lastIndex = 0;
      return re.test(curr);
    });

    if (cfg.forceRegister) {
      return { register: cfg.forceRegister, userUsedTerms, confusionSignal, reason: 'forced' };
    }

    let expertHits = 0;
    for (const re of compiled.expertPatterns) {
      re.lastIndex = 0;
      const m = recentJoined.match(new RegExp(re.source, 'giu'));
      if (m) expertHits += m.length;
    }
    let clientPlainHits = 0;
    for (const re of compiled.clientPlainPatterns) {
      re.lastIndex = 0;
      if (re.test(recentJoined)) clientPlainHits += 1;
    }

    if (expertHits >= 2 && !confusionSignal) {
      return { register: 'expert_peer', userUsedTerms, confusionSignal, reason: `expert_signals:${expertHits}` };
    }
    if (defaultRegister === 'client_plain' || clientPlainHits >= 1) {
      return { register: 'client_plain', userUsedTerms, confusionSignal, reason: clientPlainHits >= 1 ? 'client_domain_signal' : 'default_client_plain' };
    }
    return { register: defaultRegister || 'casual_human', userUsedTerms, confusionSignal, reason: 'default' };
  }

  /**
   * Region-C ONLY Pre-Gen Guidance (100% §13 prefixHash invariant!).
   */
  function buildPreGenCue({ register = cfg.defaultRegister, userUsedTerms = new Set() } = {}) {
    if (!cfg.enabled) return '';
    const regLine = tpl.registers[register] || tpl.registers.casual_human;
    const lines = [
      `[PlainSpeak · ${register}] ${tpl.header}`,
      `- ${regLine}`,
    ];
    if (cfg.maxPreGenExamples > 0 && compiled.entries.length > 0) {
      const examples = [];
      for (const e of compiled.entries) {
        if (!e.registers.has(register)) continue;
        if (userUsedTerms.has(e.normTerm)) continue;
        if (e.tier === 'A' && e.plain) {
          examples.push(`"${e.term}" -> "${e.plain}"`);
        } else if (register !== 'expert_peer' && e.tier === 'B' && e.plain && examples.length < cfg.maxPreGenExamples) {
          examples.push(`"${e.term}" -> "${e.plain}"`);
        }
        if (examples.length >= cfg.maxPreGenExamples) break;
      }
      if (examples.length) {
        lines.push(`Ví dụ đổi từ gần gũi: ${examples.join('; ')}.`);
      }
    }
    if (register === 'client_plain') {
      const hasTierC = compiled.entries.some((e) => e.tier === 'C');
      if (hasTierC) {
        lines.push(langKey === 'vi'
          ? 'Thuật ngữ chuyên ngành/pháp lý bắt buộc (vd khấu trừ, tạm nộp, kết chuyển, phân bổ) thì giữ nguyên tên đúng nhưng lần đầu kèm 4–6 chữ giải thích đời thường.'
          : 'Keep legally required domain terms accurate and pair first mention with a 4–6 word everyday gloss.');
      }
    }
    lines.push(tpl.footer);
    return lines.join('\n');
  }

  function auditText(text, { register = cfg.defaultRegister, userUsedTerms = new Set() } = {}) {
    const src = String(text ?? '');
    if (!src.trim() || !compiled.entries.length) {
      return { hits: [], tierAHits: [], tierBHits: [], tierCHits: [], totalHits: 0, needsRewrite: false };
    }
    const { masked } = maskProtectedSpans(src, compiled.protectedRegexes);
    const tierAHits = [];
    const tierBHits = [];
    const tierCHits = [];
    for (const entry of compiled.entries) {
      if (!entry.registers.has(register)) continue;
      if (userUsedTerms.has(entry.normTerm)) continue;
      entry.regex.lastIndex = 0;
      const m = entry.regex.exec(masked);
      if (!m) continue;
      // Context exclusion guard (e.g. "có cơ sở kinh doanh")
      if (entry.excludePatterns.length) {
        const winStart = Math.max(0, m.index - 24);
        const winEnd = Math.min(masked.length, m.index + m[0].length + 32);
        const windowStr = masked.slice(winStart, winEnd);
        if (entry.excludePatterns.some((ex) => { ex.lastIndex = 0; return ex.test(windowStr); })) {
          continue;
        }
      }
      const hit = {
        term: entry.term,
        matched: m[0],
        plain: entry.plain,
        tier: entry.tier,
        action: entry.action,
        packId: entry.packId,
      };
      if (entry.tier === 'A') tierAHits.push(hit);
      else if (entry.tier === 'B') tierBHits.push(hit);
      else if (entry.tier === 'C') tierCHits.push(hit);
    }
    const hits = [...tierAHits, ...tierBHits, ...tierCHits];
    // Rewrite triggers on ANY remaining Tier A calque (action='hint' or unswapped)
    // OR >= rewriteTierBMinHits Tier B jargon terms in non-expert registers
    const actionableTierA = tierAHits.filter((h) => h.action === 'hint' || h.action === 'swap');
    const needsRewrite = actionableTierA.length >= 1
      || (register !== 'expert_peer' && tierBHits.length >= cfg.rewriteTierBMinHits);
    return {
      hits,
      tierAHits,
      tierBHits,
      tierCHits,
      totalHits: tierAHits.length + tierBHits.length,
      needsRewrite,
    };
  }

  /**
   * 0-token Deterministic Post-Filter:
   * Strictly applies ONLY `action === "swap"` outside protected spans + skipping `userUsedTerms`,
   * and ALWAYS verifies §43 `verifyClaimsInvariant(rawBaseline, candidate)`.
   */
  function applyDeterministicFilter(text, {
    rawBaseline = null,
    register = cfg.defaultRegister,
    userUsedTerms = new Set(),
    dateOrder = cfg.dateOrder,
  } = {}) {
    const src = String(text ?? '');
    const baseline = rawBaseline != null ? String(rawBaseline) : src;
    if (!cfg.enabled || !src.trim() || !compiled.entries.length) {
      return { text: src, applied: [], changed: false, invariantOk: true };
    }
    const { masked, restore } = maskProtectedSpans(src, compiled.protectedRegexes);
    let working = masked;
    const applied = [];

    for (const entry of compiled.entries) {
      if (entry.action !== 'swap') continue;
      if (!entry.registers.has(register)) continue;
      if (userUsedTerms.has(entry.normTerm)) continue;
      entry.regex.lastIndex = 0;
      if (!entry.regex.test(working)) continue;
      entry.regex.lastIndex = 0;
      let hitCount = 0;
      working = working.replace(entry.regex, (matched, offset, full) => {
        if (entry.excludePatterns.length) {
          const win = full.slice(Math.max(0, offset - 24), Math.min(full.length, offset + matched.length + 32));
          if (entry.excludePatterns.some((ex) => { ex.lastIndex = 0; return ex.test(win); })) {
            return matched;
          }
        }
        hitCount += 1;
        return preserveCaseReplacement(matched, entry.plain);
      });
      if (hitCount > 0) {
        applied.push({ term: entry.term, plain: entry.plain, count: hitCount, tier: entry.tier });
      }
    }

    if (!applied.length) {
      return { text: src, applied: [], changed: false, invariantOk: true };
    }

    // Clean leftover punctuation/spaces when filler phrases were deleted (`plain === ""`)
    let restored = restore(working)
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/(^|\n)[ \t]*[,;:\-–—]+[ \t]+/g, '$1')
      .replace(/[ \t]+([,.;!?])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    // Re-capitalize first letter of a line if leading filler deletion exposed lowercase start
    restored = restored.replace(/(^|\n)([\p{Ll}])/gu, (_, lead, ch) => `${lead}${ch.toLocaleUpperCase()}`);

    // INV-PS-1 Hard Extended Invariant Gate: NEVER allow any claim/number/date/form/TK/percent/time/URL drift!
    const inv = verifyExtendedPlainSpeakInvariant(baseline, restored, { dateOrder });
    if (!inv.ok) {
      return { text: src, applied: [], changed: false, invariantOk: false, invariantFailure: inv };
    }
    return { text: restored, applied, changed: restored !== src, invariantOk: true };
  }

  function recordTelemetry({
    register,
    mode = cfg.mode,
    appliedSwaps = [],
    audit = null,
    rewritten = false,
    rewriteRejectedReason = null,
    confusionSignal = false,
    channel = 'chat',
  } = {}) {
    if (!telemetryPath) return;
    if (!appliedSwaps.length && !audit?.hits?.length && !confusionSignal) return;
    // Prompt-injection-safe structured record: ONLY pack term IDs & counters, NEVER raw user prose!
    const row = {
      ts: new Date().toISOString(),
      channel: String(channel || 'chat').slice(0, 32),
      register,
      mode,
      swaps: appliedSwaps.map((s) => ({ term: s.term, tier: s.tier, count: s.count })),
      flagged: (audit?.hits || []).map((h) => ({ term: h.term, tier: h.tier, action: h.action })),
      rewritten: Boolean(rewritten),
      ...(rewriteRejectedReason ? { rewriteRejectedReason } : {}),
      ...(confusionSignal ? { confusionSignal: true } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(telemetryPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(telemetryPath) && fs.statSync(telemetryPath).size > cfg.telemetryMaxBytes) {
        const rotated = `${telemetryPath}.prev`;
        try { fs.renameSync(telemetryPath, rotated); } catch { /* ignore */ }
      }
      fs.appendFileSync(telemetryPath, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  /**
   * Full post-grounding reply pipeline:
   *   1. 0-token deterministic swap (action="swap" only, protected spans, §43 verified)
   *   2. Audit remaining calques / jargon
   *   3. Optional bounded 1x ephemeral rewrite (only in `live` mode, strict §43 + length + negation + hit-reduction gates)
   *   4. Prompt-injection-safe telemetry logging
   */
  async function processOutgoing({
    rawReply,
    register = cfg.defaultRegister,
    userUsedTerms = new Set(),
    confusionSignal = false,
    provider = null,
    model = null,
    channel = 'chat',
    dateOrder = cfg.dateOrder,
    skipRewrite = false,
    turnDurationMs = 0,
    groundingSelfHealed = false,
    triggerKind = null,
    verifyGrounded = null,
  } = {}) {
    const original = String(rawReply ?? '');
    if (!cfg.enabled || !original.trim()) {
      return { text: original, changed: false, register, mode: cfg.mode, swaps: [], auditBefore: null, rewritten: false };
    }

    // INV-PS-4: In `expert_peer` register, skip deterministic swaps on Tier B/C (Tier A calques still audited & swapped if action="swap")
    const filtered = applyDeterministicFilter(original, {
      rawBaseline: original,
      register,
      userUsedTerms,
      dateOrder,
    });
    const postFilterText = cfg.mode === 'live' ? filtered.text : original;
    const auditBefore = auditText(postFilterText, { register, userUsedTerms });

    let finalText = postFilterText;
    let rewritten = false;
    let rewriteRejectedReason = null;

    // INV-PS-3: Max 1 post-gen LLM pass per turn (`groundingSelfHealed` XOR `plainSpeakRewrite`);
    // skip rewrite if turn already exceeded `rewriteMaxTurnLatencyMs`, or during `active_latch`, or `expert_peer`!
    const budgetAllowsRewrite = !groundingSelfHealed
      && triggerKind !== 'active_latch'
      && register !== 'expert_peer'
      && (Number(turnDurationMs || 0) <= cfg.rewriteMaxTurnLatencyMs);

    const shouldAttemptRewrite = Boolean(
      cfg.mode === 'live' &&
      cfg.rewriteEnabled &&
      !skipRewrite &&
      budgetAllowsRewrite &&
      auditBefore.needsRewrite &&
      postFilterText.length <= cfg.rewriteMaxChars &&
      provider &&
      provider.ready &&
      typeof provider.generate === 'function',
    );

    if (shouldAttemptRewrite) {
      const flaggedList = [...auditBefore.tierAHits, ...auditBefore.tierBHits]
        .slice(0, 6)
        .map((h) => `- "${h.term}" -> gợi ý gần gũi: "${h.plain || '(lược bỏ tự nhiên)'}"`)
        .join('\n');
      const rewritePrompt = [
        `REGISTER: ${register}`,
        `FLAGGED_PHRASES_TO_SIMPLIFY:\n${flaggedList}`,
        `ORIGINAL_MESSAGE:\n${postFilterText}`,
      ].join('\n\n');
      try {
        const res = await provider.generate(rewritePrompt, {
          model: model || undefined,
          system: tpl.rewriteSystem,
          effort: 'low',
          serviceTier: 'fast',
          ephemeral: true,
          tools: undefined,
          timeoutMs: cfg.rewriteTimeoutMs,
        });
        const candidate = String(res?.text || '').trim().replace(/^```(?:\w+)?\s*|\s*```$/g, '').trim();
        if (!candidate) {
          rewriteRejectedReason = 'empty_output';
        } else {
          const ratio = candidate.length / Math.max(1, postFilterText.length);
          const inv = verifyExtendedPlainSpeakInvariant(original, candidate, { dateOrder });
          const origNeg = countNegations(postFilterText);
          const candNeg = countNegations(candidate);
          const origBubbles = (postFilterText.match(/\[\[bubble\]\]/g) || []).length;
          const candBubbles = (candidate.match(/\[\[bubble\]\]/g) || []).length;
          const auditAfter = auditText(candidate, { register, userUsedTerms });
          let groundingPass = true;
          if (typeof verifyGrounded === 'function') {
            try {
              const gChk = verifyGrounded(candidate);
              if (gChk && gChk.ok === false) groundingPass = false;
            } catch { groundingPass = false; }
          }

          if (ratio < cfg.rewriteMinRatio || ratio > cfg.rewriteMaxRatio) {
            rewriteRejectedReason = `length_ratio:${ratio.toFixed(2)}`;
          } else if (!inv.ok) {
            rewriteRejectedReason = `invariant_failed:${inv.reason}`;
          } else if (!groundingPass) {
            rewriteRejectedReason = 'grounding_recheck_failed';
          } else if (Math.abs(candNeg - origNeg) > 1 || (origNeg > 0 && candNeg === 0)) {
            rewriteRejectedReason = `negation_drift:${origNeg}->${candNeg}`;
          } else if (origBubbles > 0 && candBubbles !== origBubbles) {
            rewriteRejectedReason = `bubble_marker_drift:${origBubbles}->${candBubbles}`;
          } else if (auditAfter.totalHits >= auditBefore.totalHits) {
            rewriteRejectedReason = `no_jargon_reduction:${auditBefore.totalHits}->${auditAfter.totalHits}`;
          } else {
            finalText = candidate;
            rewritten = true;
          }
        }
      } catch (err) {
        rewriteRejectedReason = `provider_error:${String(err?.message || err).slice(0, 60)}`;
        logger?.warn?.(`[scroll:plain-speak:${safeAcct}] ephemeral rewrite skipped (${rewriteRejectedReason})`);
      }
    }

    recordTelemetry({
      register,
      mode: cfg.mode,
      appliedSwaps: filtered.applied,
      audit: auditBefore,
      rewritten,
      rewriteRejectedReason,
      confusionSignal,
      channel,
    });

    return {
      text: finalText,
      changed: finalText !== original,
      register,
      mode: cfg.mode,
      swaps: filtered.applied,
      auditBefore,
      rewritten,
      rewriteRejectedReason,
    };
  }

  return {
    get enabled() { return cfg.enabled; },
    get config() { return cfg; },
    get packIds() { return [...compiled.packIds]; },
    get entryCount() { return compiled.entries.length; },
    get telemetryPath() { return telemetryPath; },
    detectRegister,
    buildPreGenCue,
    auditText,
    applyDeterministicFilter,
    processOutgoing,
  };
}
