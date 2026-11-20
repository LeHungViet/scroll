// SCROLL — grounding / provenance pre-check (v1.4) + reply grounding (v1.9 §43).
//
// Why: blocks hallucination at the ACTION and REPLY boundary.
//   - Action grounding (v1.4): before a financial or destructive tool runs, declared params must
//     trace to prior sources.
//   - Reply grounding (v1.9): before an external reply leaves, every amount, product code, date,
//     and link must trace to PRINCIPAL-authored sources ONLY (retrieved knowledge chunks, USER.md
//     "May say on behalf", tool outputs — NEVER customer messages). Same-line code-to-amount pairs
//     must match; risky unverified claims (percentages, clock times, relative dates, inventory
//     claims, spelled-out numbers) are held for human review.
//
// Deliberately DETERMINISTIC, zero dependencies, pure ASCII source. Node >= 20.

// Build the corpus a parameter may be grounded against (internal action grounding).
export function collectSources({ depSummaries = [], objective = '', steer = '', priorOutputs = [], extra = [] } = {}) {
  return [objective, steer, ...depSummaries, ...priorOutputs, ...extra].filter(Boolean).join('\n');
}

// v1.9 §43: build the corpus an EXTERNAL REPLY may be grounded against.
// Principal-authored text ONLY — customer chat history is intentionally excluded so a customer
// cannot inject a price ("you quoted 90k") and make the bot's echo look grounded.
export function collectPrincipalSources({ knowledgeChunks = [], maySay = '', toolOutputs = [], extra = [] } = {}) {
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  return [...arr(knowledgeChunks), maySay, ...arr(toolOutputs), ...arr(extra)].filter(Boolean).join('\n');
}

// Normalize for action-param matching: lowercase, collapse to alphanumerics.
function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function digitsOnly(s) { return String(s).replace(/[^0-9]/g, ''); }
function looksNumeric(v) { return /[0-9]/.test(String(v)) && /^[0-9.,\s]*[0-9][0-9.,\s]*(?:[a-z]{0,4})$/i.test(String(v).trim()); }

// Is a single value present in the source corpus?
export function isGrounded(value, sourcesText) {
  if (value == null || value === '') return true;
  const src = String(sourcesText || '');
  const nv = norm(value);
  if (nv && norm(src).includes(nv)) return true;
  if (looksNumeric(value)) {
    const dv = digitsOnly(value);
    if (dv && digitsOnly(src).includes(dv)) return true;
  }
  return false;
}

// params: array of { name, value } OR a plain object { name: value }.
export function checkGrounding(params, sourcesText) {
  const list = Array.isArray(params)
    ? params
    : Object.entries(params || {}).map(([name, value]) => ({ name, value }));
  const traced = [], missing = [];
  for (const { name, value } of list) {
    if (isGrounded(value, sourcesText)) traced.push(name);
    else missing.push(name);
  }
  return { ok: missing.length === 0, traced, missing };
}

// ── v1.9 §43: claims inside a free-text reply ──────────────────────────────────────────────────
export const REPLY_KINDS = ['amount', 'code', 'date', 'link'];

// Fold diacritics to ASCII so international currencies/phrases match without raw non-ASCII in code
function foldAscii(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D');
}

// "1.500.000", "1,500.50", "1,2", 1500 -> number
export function parseAmount(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (x == null) return null;
  let s = String(x).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) {
    const dec = dot > comma ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (dot >= 0 || comma >= 0) {
    const parts = s.split(dot >= 0 ? '.' : ',');
    s = (parts.length > 2 || parts[parts.length - 1].length === 3) ? parts.join('') : parts.join('.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const NUM = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const MULT = {
  k: 1e3, thousand: 1e3, nghin: 1e3, ngan: 1e3,
  tr: 1e6, trieu: 1e6, m: 1e6, million: 1e6,
};
// Currency suffixes (uses Unicode escapes \u0111 / \u20ab / \u20ac / \u00a3 for pure ASCII source)
const SUFFIX_CUR = String.raw`(?:dong|\u0111|\u20ab|vnd|usd|eur|\u20ac|\u00a3|dollars?|bucks?|k|thousand|nghin|ngan|million|trieu|tr)`;
const END = String.raw`(?![\p{L}\p{N}])`;
const START = String.raw`(?<![\p{L}\p{N}.,/:-])`;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;

const RE = {
  link: /\bhttps?:\/\/[^\s<>"')\]`]+|\bwww\.[^\s<>"')\]`]+/giu,
  dateIso: new RegExp(`${START}(\\d{4})-(\\d{1,2})-(\\d{1,2})${END}`, 'gu'),
  dateNum: new RegExp(`${START}(\\d{1,2})([/-])(\\d{1,2})(?:\\2(\\d{4}|\\d{2}))?${END}|${START}(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${END}`, 'gu'),
  dateFoldedVi: new RegExp(`ngay\\s+(\\d{1,2})\\s*(?:thang|/)\\s*(\\d{1,2})(?:\\s*(?:nam|/)\\s*(\\d{4}))?${END}`, 'giu'),
  dateEn1: new RegExp(`${START}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}(?:,?\\s+(\\d{4}))?${END}`, 'giu'),
  dateEn2: new RegExp(`${START}${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${END}`, 'giu'),
  amountPre: new RegExp(`(?:US\\$|\\$|\u20ac|\u00a3)\\s?(${NUM})${END}`, 'gu'),
  amountSuf: new RegExp(`${START}(${NUM})\\s?(${SUFFIX_CUR})${END}`, 'giu'),
  amountSep: new RegExp(`${START}(\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?)${END}`, 'gu'),
  amountBare: new RegExp(`${START}(\\d{4,})${END}`, 'gu'),
  code: /(?<![\p{L}\p{N}_-])(?:(?=[A-Z0-9_-]*\d)(?=[A-Z0-9_-]*[A-Z])[A-Z0-9]+(?:[-_][A-Z0-9]+)*|[A-Z]{2,5}(?:-[A-Z0-9]{2,6})+)(?![\p{L}\p{N}_-])/gu,
};

// Lines explicitly marked as expired/invalid/trap examples must NOT authorize quoted amounts (§44)
const EXCLUDED_AMOUNT_LINE_RE = /\b(?:expired|invalid|do\s+not\s+honor|do\s+not\s+apply|do\s+not\s+promise|never\s+offer|trap|da\s+het\s+han|het\s+han\s+tu|gia\s+mao|khong\s+ton\s+tai|tuyet\s+doi\s+khong\s+ap\s+dung|khong\s+tu\s+hua|bay\s+gia)\b/i;
const NEGATED_CLAIM_RE = /\b(?:cannot|can't|unable\s+to|not\s+offer|not\s+approve|no\s+discount|chua\s+the|khong\s+the|khong\s+ap\s+dung|khong\s+giam|chua\s+duoc\s+duyet|khong\s+duyet)\b/i;
const DISCOUNT_PERCENT_RE = /\b(?:discount|off|promo|coupon|voucher|giam(?:\s+gia|\s+ngay|\s+them)?|chiet\s+khau|uu\s+dai)\b/i;

// Risky / ungroundable claim classes held for human review (§43, source-aware time/percent in v1.10 §44)
const HOLD_PATTERNS = [
  { kind: 'percent', re: /\b\d+(?:[.,]\d+)?\s*(?:%|(?:percent|pct|phan\s+tram)\b)/gi },
  { kind: 'time', re: /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:am|pm))?\b|\b(?:1[0-2]|[1-9])\s*(?:am|pm)\b|\b(?:[01]?\d|2[0-3])h(?:[0-5]\d)?\b/gi },
  { kind: 'relative_date', re: /\b(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|week)|next\s+(?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+\d+\s+(?:hours?|days?|weeks?)|hom\s+nay|ngay\s+mai|ngay\s+kia|chieu\s+nay|toi\s+nay|tuan\s+sau|thang\s+sau)\b/i },
  { kind: 'inventory', re: /\b(?:in\s+stock|out\s+of\s+stock|backordered|sold\s+out|only\s+\d+\s+(?:left|remaining|in\s+stock|rooms?|seats?|tables?|slots?)|still\s+available\s+in\s+stock|\d+\s+(?:rooms?|seats?|tables?|slots?)\s+(?:left|remaining|available)|con\s+hang|het\s+hang|ton\s+kho|con\s+(?:phong\s+trong|cho\s+trong)|con\s+\d+\s+(?:cai|chiec|suat|hop|phong(?:\s+trong)?|cho(?:\s+trong)?|ban(?:\s+trong)?|ve|ghe|slot))\b/i },
  { kind: 'written_number', re: /\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\s+(?:dollars?|bucks?|usd|eur|vnd|off|each|per)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|fifty)\s+(?:hundred|thousand|million)\b|\b(?:mot|hai|ba|bon|nam|sau|bay|tam|chin|muoi)\s+(?:chuc|tram|nghin|ngan|trieu)\b/i },
];

const monthNo = (s) => MONTHS.indexOf(String(s).toLowerCase().slice(0, 3)) + 1;
const fullYear = (y) => (y == null ? null : (String(y).length === 2 ? 2000 + Number(y) : Number(y)));
const okDate = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
const mask = (s, i, len) => s.slice(0, i) + ' '.repeat(len) + s.slice(i + len);

// Extract structured claims: links -> dates -> amounts -> codes (masked sequentially to prevent overlap).
export function extractClaims(text, { kinds = REPLY_KINDS, dateOrder = 'dmy' } = {}) {
  const raw = String(text ?? '');
  let s = raw;
  const claims = [];
  const take = (re, fn, target = null) => {
    const src = target ?? s;
    for (const m of [...src.matchAll(re)]) {
      const c = fn(m);
      if (c) claims.push({ ...c, text: m[0], index: m.index });
      if (c !== false && !target) s = mask(s, m.index, m[0].length);
    }
  };
  take(RE.link, (m) => ({ kind: 'link', value: m[0].replace(/[.,;:!?]+$/, '') }));
  const date = (y, m, d) => (okDate(m, d) ? { kind: 'date', value: { y: fullYear(y), m, d } } : null);
  take(RE.dateIso, (m) => date(m[1], +m[2], +m[3]));
  // Check folded Vietnamese "ngay DD thang MM" without mutating character offsets
  {
    const folded = foldAscii(s);
    for (const m of [...folded.matchAll(RE.dateFoldedVi)]) {
      const c = date(m[3], +m[2], +m[1]);
      if (c) {
        claims.push({ ...c, text: raw.slice(m.index, m.index + m[0].length), index: m.index });
        s = mask(s, m.index, m[0].length);
      }
    }
  }
  take(RE.dateEn1, (m) => date(m[3], monthNo(m[2]), +m[1]));
  take(RE.dateEn2, (m) => date(m[3], monthNo(m[1]), +m[2]));
  take(RE.dateNum, (m) => {
    if (m[5]) return date(m[7], +m[6], +m[5]);
    const a = +m[1], b = +m[3];
    return dateOrder === 'mdy' ? date(m[4], a, b) : date(m[4], b, a);
  });
  const amount = (rawVal, mult = 1) => { const v = parseAmount(rawVal); return v == null ? null : { kind: 'amount', value: v * mult }; };
  take(RE.amountPre, (m) => amount(m[1]));
  // Match amountSuf on folded string so diacritic currency words normalize cleanly
  {
    const folded = foldAscii(s);
    for (const m of [...folded.matchAll(RE.amountSuf)]) {
      const suf = String(m[2]).toLowerCase();
      const c = amount(m[1], MULT[suf] || 1);
      if (c) {
        claims.push({ ...c, text: raw.slice(m.index, m.index + m[0].length), index: m.index });
        s = mask(s, m.index, m[0].length);
      }
    }
  }
  take(RE.amountSep, (m) => amount(m[1]));
  take(RE.amountBare, (m) => { const n = Number(m[1]); return n >= 1900 && n <= 2100 ? false : amount(m[1]); });
  take(RE.code, (m) => (m[0].length >= 3 ? { kind: 'code', value: m[0].toUpperCase() } : false));
  return claims.filter((c) => kinds.includes(c.kind)).sort((a, b) => a.index - b.index);
}

function normPercentToken(s) {
  const m = String(s ?? '').match(/(\d+(?:[.,]\d+)?)/);
  return m ? String(parseAmount(m[1])) : null;
}

function normTimeToken(s) {
  const raw = String(s ?? '').trim().toLowerCase();
  const hm = raw.match(/^([01]?\d|2[0-3])[:h]([0-5]\d)?\s*(am|pm)?$/);
  if (hm) {
    let hr = Number(hm[1]);
    const min = hm[2] ? Number(hm[2]) : 0;
    if (hm[3] === 'pm' && hr < 12) hr += 12;
    if (hm[3] === 'am' && hr === 12) hr = 0;
    return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  const ap = raw.match(/^(1[0-2]|[1-9])\s*(am|pm)$/);
  if (ap) {
    let hr = Number(ap[1]);
    if (ap[2] === 'pm' && hr < 12) hr += 12;
    if (ap[2] === 'am' && hr === 12) hr = 0;
    return `${String(hr).padStart(2, '0')}:00`;
  }
  return raw;
}

// Index source text including same-line code -> amount pairs (§43) and source-grounded times/percents (§44)
export function indexSources(text, { dateOrder = 'dmy' } = {}) {
  const src = String(text ?? '');
  const idx = {
    amounts: new Set(), codes: new Set(), dates: [], links: new Set(),
    codeAmounts: new Map(), times: new Set(), percents: new Set(),
  };
  const lines = src.split('\n');
  const activeLines = [];
  for (const line of lines) {
    const foldedLine = foldAscii(line);
    const isExcludedPricingLine = EXCLUDED_AMOUNT_LINE_RE.test(foldedLine);
    // Dates, links, and codes still register (so the agent can accurately explain an expiry date/code)
    for (const c of extractClaims(line, { kinds: isExcludedPricingLine ? ['date', 'link', 'code'] : REPLY_KINDS, dateOrder })) {
      if (c.kind === 'date') idx.dates.push(c.value);
      else if (c.kind === 'link') idx.links.add(c.value);
      else if (c.kind === 'amount') idx.amounts.add(c.value);
    }
    for (const t of line.match(/[\p{L}\p{N}_-]+/gu) || []) idx.codes.add(t.toUpperCase());
    if (isExcludedPricingLine) continue;
    activeLines.push(line);

    // Line-level pairing: only bind code -> amount when a line names exactly 1 code
    // (prevents multi-code FAQ prose lines from polluting a single SKU's published tariff row)
    const lc = extractClaims(line, { kinds: ['code', 'amount'], dateOrder });
    const codes = [...new Set(lc.filter((c) => c.kind === 'code').map((c) => c.value))];
    const amts = lc.filter((c) => c.kind === 'amount').map((c) => c.value);
    if (codes.length === 1 && amts.length) {
      const code = codes[0];
      if (!idx.codeAmounts.has(code)) idx.codeAmounts.set(code, new Set());
      for (const a of amts) idx.codeAmounts.get(code).add(a);
    }
  }
  const activeText = foldAscii(activeLines.join('\n'));
  const numRe = new RegExp(`${START}(${NUM})(?:\\s?(${SUFFIX_CUR}))?${END}`, 'giu');
  for (const m of activeText.matchAll(numRe)) {
    const v = parseAmount(m[1]); if (v == null) continue;
    idx.amounts.add(v);
    const mult = m[2] && MULT[String(m[2]).toLowerCase()];
    if (mult) idx.amounts.add(v * mult);
  }
  for (const m of activeText.matchAll(HOLD_PATTERNS[0].re)) {
    const p = normPercentToken(m[0]);
    if (p) idx.percents.add(p);
  }
  for (const m of activeText.matchAll(HOLD_PATTERNS[1].re)) {
    const t = normTimeToken(m[0]);
    if (t) idx.times.add(t);
  }
  return idx;
}

function traced(c, idx) {
  if (c.kind === 'amount') return idx.amounts.has(c.value);
  if (c.kind === 'code') return idx.codes.has(c.value);
  if (c.kind === 'link') return idx.links.has(c.value);
  if (c.kind === 'date') return idx.dates.some((d) => d.m === c.value.m && d.d === c.value.d && (d.y == null || c.value.y == null || d.y === c.value.y));
  return false;
}

// Detect same-line / same-sentence code-to-amount mismatches against source lines
function findPairMismatches(text, idx, dateOrder) {
  const mismatches = [];
  const clauses = String(text ?? '').split(/[\n;!?]+|(?:\.\s+)/);
  for (const clause of clauses) {
    const lc = extractClaims(clause, { kinds: ['code', 'amount'], dateOrder });
    const codes = lc.filter((c) => c.kind === 'code');
    const amts = lc.filter((c) => c.kind === 'amount');
    if (codes.length !== 1 || !amts.length) continue;
    const code = codes[0].value;
    const allowed = idx.codeAmounts.get(code);
    if (!allowed || allowed.size === 0) continue;
    for (const a of amts) {
      if (!allowed.has(a.value)) {
        mismatches.push({ kind: 'pair_mismatch', code, amount: a.value, text: `${codes[0].text} <-> ${a.text}`, expected: [...allowed] });
      }
    }
  }
  return mismatches;
}

// Detect hold-trigger classes (percentages, clock times, relative dates, inventory, written numbers)
// When `sourceIndex` is supplied (v1.10 §44), clock times and percentages verbatim in principal
// sources (e.g., published check-in 14:00 or 8% VAT) pass without false-positive holds, and
// explicit refusals of customer-demanded percentages ("cannot approve 20%") are not false-held.
export function detectHoldClaims(text, sourceIndex = null) {
  const folded = foldAscii(text);
  const held = [];
  for (const { kind, re } of HOLD_PATTERNS) {
    if (kind === 'percent') {
      for (const m of folded.matchAll(re)) {
        const prefix = folded.slice(Math.max(0, m.index - 45), m.index);
        if (NEGATED_CLAIM_RE.test(prefix)) continue;
        const window = folded.slice(Math.max(0, m.index - 35), Math.min(folded.length, m.index + m[0].length + 25));
        const isDiscountClaim = DISCOUNT_PERCENT_RE.test(window);
        const tok = normPercentToken(m[0]);
        if (!isDiscountClaim && sourceIndex && sourceIndex.percents && tok && sourceIndex.percents.has(tok)) continue;
        held.push({ kind, text: m[0] });
        break;
      }
    } else if (kind === 'time') {
      for (const m of folded.matchAll(re)) {
        const tok = normTimeToken(m[0]);
        if (sourceIndex && sourceIndex.times && tok && sourceIndex.times.has(tok)) continue;
        held.push({ kind, text: m[0] });
        break;
      }
    } else {
      const m = folded.match(re);
      if (m) held.push({ kind, text: m[0] });
    }
  }
  return held;
}

// Does every claim in an external reply trace to principal sources, with matching code-amount pairs
// and zero unverified hold triggers? Returns { ok, claims, missing, pairMismatches, held }.
export function groundReply(text, sourcesText, {
  kinds = REPLY_KINDS,
  dateOrder = 'dmy',
  checkPairs = true,
  checkHoldTriggers = true,
} = {}) {
  const ks = kinds.filter((k) => REPLY_KINDS.includes(k));
  const idx = indexSources(sourcesText, { dateOrder });
  const claims = extractClaims(text, { kinds: ks, dateOrder }).map((c) => ({ kind: c.kind, value: c.value, text: c.text, traced: traced(c, idx) }));
  const missing = claims.filter((c) => !c.traced);
  const pairMismatches = checkPairs ? findPairMismatches(text, idx, dateOrder) : [];
  const held = checkHoldTriggers ? detectHoldClaims(text, idx) : [];
  const ok = missing.length === 0 && pairMismatches.length === 0 && held.length === 0;
  return { ok, claims, missing, pairMismatches, held };
}

// §6b / §43 invariant: formatting / voice shaping MUST preserve the exact multiset of
// (amount, code, date, link) claims between rawText and shapedText.
function claimKey(c) {
  if (c.kind === 'date') return `date:${c.value.y ?? '*'}-${c.value.m}-${c.value.d}`;
  return `${c.kind}:${c.value}`;
}
export function verifyClaimsInvariant(beforeText, afterText, { dateOrder = 'dmy' } = {}) {
  const before = extractClaims(beforeText, { kinds: REPLY_KINDS, dateOrder }).map(claimKey).sort();
  const after = extractClaims(afterText, { kinds: REPLY_KINDS, dateOrder }).map(claimKey).sort();
  const ok = before.length === after.length && before.every((v, i) => v === after[i]);
  return { ok, before, after };
}
