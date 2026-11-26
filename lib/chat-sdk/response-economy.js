// SCROLL 2.7 (§51) — Channel-Agnostic Response Economy Engine (`@agentpro/scroll/chat`).
//
// Completes the Gricean triad in SCROLL:
//   - Quality  -> `lib/grounding.js` (zero hallucination)
//   - Manner   -> `lib/chat-sdk/plain-speak.js` (human naturalness, zero jargon)
//   - Quantity -> `lib/chat-sdk/response-economy.js` (outcome-only, zero echo, zero unsolicited bloat)
//
// Architecture (zero-dep, deterministic-first, claim-safe):
//   1. 0-token 4-signal structural scorer (<2ms):
//        S1 Budget Overshoot · S2 User-Echo/Parroting · S3 Process Narration · S4 Unsolicited Expansion / Settled-Topic Re-Ask
//   2. 0-token surgical deterministic trimmer (unsolicited citations/URLs, trailing process tags, trailing filler `?`)
//      strictly gated by §51 `verifyCompressionInvariant` (subset-only claims + negation polarity guard).
//   3. Bounded 1x ephemeral minimalist compressor (`effort: 'low'`, `serviceTier: 'fast'`, `ephemeral: true`)
//      sharing the single post-gen LLM pass budget with Grounding Self-Heal & PlainSpeak (INV-EC-1).
//   4. Pull-on-Demand Work Ledger extractor + prompt-injection-safe telemetry (`economy-watch-<accountId>.jsonl`).

import fs from 'node:fs';
import path from 'node:path';
import { verifyCompressionInvariant } from '../grounding.js';
import { resolveEconomyConfig } from '../turn-budget.js';

export const DEFAULT_RESPONSE_ECONOMY_RUNTIME = Object.freeze({
  enabled: true,
  mode: 'live', // 'live' | 'shadow' | 'off'
  locale: 'vi',
  dateOrder: 'dmy',
  compressTimeoutMs: 4_500,
  compressMaxTurnLatencyMs: 14_000,
  compressMaxInputChars: 3_200,
  telemetryEnabled: true,
  telemetryMaxBytes: 512 * 1024,
});

function foldAscii(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

const STOPWORDS = new Set([
  'anh', 'chi', 'em', 'e', 'a', 'minh', 'ban', 'tao', 'may', 'oi', 'nhe', 'nha', 'ne', 'da',
  'la', 'thi', 'ma', 'va', 'voi', 'vs', 'cho', 'cua', 'nay', 'kia', 'do', 'day', 'nay', 'nhu',
  'roi', 'r', 'di', 'ra', 'vao', 'len', 'xuong', 'lai', 'cung', 'se', 'dang', 'van', 'co',
  'khong', 'ko', 'k', 'chua', 'duoc', 'dc', 'ok', 'oke', 'the', 'nay', 'gi', 'j', 'nao', 'sao',
  'mot', 'hai', 'ba', 'cac', 'nhung', 'tu', 'o', 'tren', 'duoi', 'trong', 'ngoai', 'het', 'luon',
  'the', 'is', 'are', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'that', 'this', 'it', 'you', 'me',
]);

function contentTokens(text) {
  const folded = foldAscii(text).replace(/(?:^|\s)@[a-z0-9_]{2,64}\b/g, ' ');
  return (folded.match(/[a-z0-9]{2,}/g) || []).filter((t) => !STOPWORDS.has(t));
}

export function computeUserEchoScore(userText, replyText) {
  const uToks = contentTokens(userText);
  const rToks = contentTokens(replyText);
  if (uToks.length < 2 || rToks.length < 3) return { overlap: 0, matchedTokens: [] };
  const rSet = new Set(rToks);
  const matched = [...new Set(uToks.filter((t) => rSet.has(t)))];
  const uniqueU = new Set(uToks).size;
  const overlap = +(matched.length / Math.max(1, uniqueU)).toFixed(3);
  return { overlap, matchedTokens: matched };
}

const ECHO_PHRASE_RE = /\b(?:tu\s+nay\b.{0,50}\b(?:em|e)\s+se|da\s+luu\s+quy\s+trinh\b.{0,30}\bmoi\s+lan\s+se|nho\s+roi\s*,?\s*tu\s+nay|from\s+now\s+on\s+i\s+will|i\s+have\s+saved\s+this\s+workflow\s+and\s+will)\b/i;

const PROCESS_NARRATION_PATTERNS = [
  /\b(?:em|e)\s+vua\s+(?:chon\s+lai\s+tab|mo\s+lai\s+tab|bam\s+vao|kiem\s+tra\s+lai\s+hai\s+o|doc\s+lai\s+phien)\b/i,
  /\bda\s+giao\s+[a-z0-9_-]{2,24}\s+(?:dien\s+tiep|xu\s+ly\s+tiep|kiem\s+tra\s+lai)\b/i,
  /\b(?:em|e)\s+dang\s+(?:xoa|dien|cap\s+nhat|mo|kiem\s+tra)\b.{0,55}\b(?:giu\s+nguyen|xong\s+(?:em|e)\s+bao|truoc\s+khi)\b/i,
  /\b(?:em|e)\s+chua\s+(?:sua\s+gi\s+tren\s+trang|ghi\s+(?:gi\s+)?vao\s+bang(?:\s+chung)?|dua\s+gi\s+len|xac\s+minh\s+duoc\s+cach\s+giu\s+dong)\b/i,
  /\bco\s+(?:mot|1)\s+(?:diem|van\s+de|rui\s+ro|luu\s+y)\s+(?:nho\s+)?can\s+(?:kiem\s+tra|xac\s+nhan|luu\s+y)(?:\s+truoc)?\s*:/i,
  /\bban\s+tieng\s+[a-z]+\s+van\s+dang\s+o\s+day\s*,\s*chua\s+duoc\s+dua\s+vao\b/i,
  /\bnguon\s*:\s*phien\s+[“"'`]/i,
  /\b(?:anh|file)\s+[^\n]{0,30}\bvua\s+gui\s+o\s+tren\s+(?:nhe|nha|a)\b/i,
  /\bi\s+(?:just\s+switched\s+to\s+the\s+tab|have\s+delegated\s+.{2,30}\s+to\s+fill|haven't\s+edited\s+anything\s+on\s+the\s+page)\b/i,
];

const SETTLED_USER_RE = /\b(?:da\s+nop|nop\s+(?:xong|roi)|hoan\s+thanh\s+(?:nop|dong|viec)|da\s+thanh\s+toan|da\s+xong|already\s+paid|already\s+submitted|already\s+done)\b/i;
const PROOF_REASK_RE = /\b(?:chuyen\s+(?:em|e)\s+anh|gui\s+(?:em|e)\s+(?:anh|chung\s+tu|sao\s+ke)|ngay\s+anh\s+chuyen\s+tien|send\s+(?:me\s+)?(?:the\s+)?receipt|proof\s+of\s+payment)\b/i;

const MD_LINK_RE = /\[([^\]\n]{1,140})\]\((https?:\/\/[^\s)]+)\)/gi;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"')\]`]+/gi;
const ACTIONABLE_URL_HOST_RE = /^(?:(?:[a-z0-9-]+\.)*(?:zoom\.us|webex\.com|notion\.so|notion\.site|calendly\.com|figma\.com|linear\.app|github\.com|gitlab\.com|loom\.com|miro\.com|trello\.com|airtable\.com)|meet\.google\.com|calendar\.google\.com|docs\.google\.com|drive\.google\.com|sheets\.google\.com|slides\.google\.com|forms\.gle|teams\.microsoft\.com|teams\.live\.com|meet\.jit\.si|whereby\.com|gather\.town|cal\.com|doc\.ishow\.pro|docs\.agentpro\.tech|app\.notion\.com|app\.botroom\.dev|t\.me)$/i;

export function isActionableDeliverableUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').replace(/[.,;:!?)]+$/, ''));
    return ACTIONABLE_URL_HOST_RE.test(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
const NUMBERED_LIST_RE = /(?:^|\n)\s*[123]\.\s+\S/g;
const UI_CLICK_PATH_RE = /(?:\u2192|->).{1,45}(?:\u2192|->)|\bvao\s+[^\n]{2,30}\s*(?:\u2192|->)/i;

export function detectSettledTopicReask(recentUserTexts = [], replyText = '') {
  if (!Array.isArray(recentUserTexts) || !recentUserTexts.length) return false;
  const settledMsgs = recentUserTexts.filter((t) => SETTLED_USER_RE.test(foldAscii(t)));
  if (!settledMsgs.length) return false;
  const replyFold = foldAscii(replyText);
  if (!PROOF_REASK_RE.test(replyFold)) return false;
  const settledToks = new Set(settledMsgs.flatMap((m) => contentTokens(m)));
  const overlap = contentTokens(replyText).filter((t) => settledToks.has(t));
  return overlap.length >= 1;
}

export function auditResponseEconomy({
  userText = '',
  replyText = '',
  contract = null,
  recentUserTexts = [],
} = {}) {
  const reply = String(replyText ?? '').trim();
  const c = contract || {
    enabled: true,
    shape: 'lookup_brief',
    targetMaxChars: 420,
    hardMaxChars: 560,
    allowedFollowUps: 0,
    links: 'on_request',
    suppressProcessNarration: true,
    suppressUnsolicitedTutorial: true,
    echoGuard: 'strict',
  };
  if (!c.enabled || !reply) {
    return {
      ok: true,
      score: 0,
      violations: [],
      needsDeterministicTrim: false,
      needsLlmCompress: false,
      metrics: { replyChars: reply.length, targetMaxChars: c.targetMaxChars, expansionRatio: 0, echoOverlap: 0 },
    };
  }

  const foldedReply = foldAscii(reply);
  const violations = [];
  let score = 0;

  // S1: Budget Overshoot
  const ratio = +(reply.length / Math.max(1, c.targetMaxChars)).toFixed(2);
  if (reply.length > c.hardMaxChars) {
    violations.push({ code: 'budget_overshoot_hard', severity: 'p0', detail: `${reply.length}c > hard ${c.hardMaxChars}c (${ratio}x target)` });
    score += 45;
  } else if (reply.length > Math.round(c.targetMaxChars * 1.2)) {
    violations.push({ code: 'budget_overshoot_soft', severity: 'p1', detail: `${reply.length}c > target ${c.targetMaxChars}c` });
    score += 22;
  }

  // S2: User-Echo / Parroting
  const echo = computeUserEchoScore(userText, reply);
  const hasEchoPhrase = ECHO_PHRASE_RE.test(foldedReply);
  if (
    c.echoGuard !== 'off' &&
    (c.shape === 'ack_confirm' || c.shape === 'action_exec' || hasEchoPhrase) &&
    (hasEchoPhrase || (echo.overlap >= (c.echoGuard === 'strict' ? 0.42 : 0.6) && reply.length > 48))
  ) {
    violations.push({
      code: 'user_echo_parroting',
      severity: 'p0',
      detail: `overlap=${echo.overlap}${hasEchoPhrase ? ' + parrot_template' : ''}`,
    });
    score += 40;
  }

  // S3: Process Narration & Negative-Status Leakage
  if (c.suppressProcessNarration) {
    const matchedProc = PROCESS_NARRATION_PATTERNS.find((re) => re.test(foldedReply));
    if (matchedProc) {
      violations.push({ code: 'process_narration', severity: 'p0', detail: String(matchedProc.exec(foldedReply)?.[0] || '').slice(0, 80) });
      score += 35;
    }
  }

  // S4a: Unsolicited Links (never flag actionable deliverable URLs like Google Meet/Zoom/Doc-Colab/Notion)
  const mdLinks = [...reply.matchAll(MD_LINK_RE)].filter((m) => !isActionableDeliverableUrl(m[2]));
  const bareUrls = [...reply.replace(MD_LINK_RE, '').matchAll(BARE_URL_RE)].filter((m) => !isActionableDeliverableUrl(m[0]));
  const unsolicitedLinksCount = (c.links === 'none' || c.links === 'on_request') ? (mdLinks.length + bareUrls.length) : 0;
  if (unsolicitedLinksCount > 0) {
    violations.push({ code: 'unsolicited_links', severity: 'p1', detail: `${unsolicitedLinksCount} unsolicited URL(s)` });
    score += 20;
  }

  // S4b: Unsolicited Numbered Tutorial / Click Path
  const numberedMatches = reply.match(NUMBERED_LIST_RE) || [];
  const hasNumberedList = numberedMatches.length >= 2;
  const hasUiPath = UI_CLICK_PATH_RE.test(foldedReply);
  if (c.suppressUnsolicitedTutorial && (hasNumberedList || hasUiPath)) {
    violations.push({ code: 'unsolicited_tutorial', severity: 'p0', detail: hasNumberedList ? `${numberedMatches.length} numbered sections` : 'ui_click_path' });
    score += 35;
  }

  // S4c: Unsolicited Trailing Follow-Up Question
  const lines = reply.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';
  const hasTrailingQuestion = lastLine.endsWith('?') && reply.length > 90 && !/^(?:anh|chị|bạn)\s+muốn\s+em\s+kiểm\s+tra\s+cuộc\s+trò\s+chuyện\s+nào/i.test(reply);
  if (c.allowedFollowUps === 0 && hasTrailingQuestion) {
    violations.push({ code: 'unsolicited_follow_up', severity: 'p1', detail: lastLine.slice(0, 80) });
    score += 18;
  }

  // S4d: Settled-Topic Re-Ask
  if (detectSettledTopicReask(recentUserTexts, reply)) {
    violations.push({ code: 'settled_topic_reask', severity: 'p0', detail: 're-asked proof/status for an item user already marked completed' });
    score += 40;
  }

  score = Math.min(100, score);
  const codes = new Set(violations.map((v) => v.code));
  const needsDeterministicTrim = Boolean(
    codes.has('unsolicited_links') ||
    codes.has('unsolicited_follow_up') ||
    codes.has('process_narration')
  );
  const needsLlmCompress = Boolean(
    codes.has('budget_overshoot_hard') ||
    codes.has('user_echo_parroting') ||
    codes.has('unsolicited_tutorial') ||
    codes.has('settled_topic_reask') ||
    codes.has('process_narration') ||
    score >= 35
  );

  return {
    ok: violations.length === 0,
    score,
    violations,
    needsDeterministicTrim,
    needsLlmCompress,
    metrics: {
      replyChars: reply.length,
      targetMaxChars: c.targetMaxChars,
      hardMaxChars: c.hardMaxChars,
      expansionRatio: ratio,
      echoOverlap: echo.overlap,
      unsolicitedLinksCount,
      hasNumberedList,
      hasTrailingQuestion,
    },
  };
}

// Trailing non-action / source-tag / obvious-state sentences safe to strip deterministically
const TRAILING_PROCESS_SENTENCE_RE = /(?:(?:\s*\[\[bubble\]\]\s*|\s*\n+\s*|\s*[.!?]+\s*))(?:\b(?:ngu\u1ed3n\s*:\s*phi\u00ean|(?:em|e)\s+ch\u01b0a\s+(?:ghi|s\u1eeda|\u0111\u01b0a)\s+g\u00ec|\u0111\u00e2y\s+l\u00e0\s+n\u1ed9i\s+dung\s+d\u1ef1\s+ki\u1ebfn,\s*(?:em|e)\s+ch\u01b0a\s+ghi|\u1ea3nh\s+[^\n]{0,30}\bv\u1eeba\s+g\u1eedi\s+\u1edf\s+tr\u00ean)[^\n]*)$/iu;

export function extractUrls(text) {
  const urls = new Set();
  for (const m of String(text ?? '').matchAll(MD_LINK_RE)) urls.add(m[2]);
  for (const m of String(text ?? '').matchAll(BARE_URL_RE)) urls.add(m[0].replace(/[.,;:!?]+$/, ''));
  return [...urls];
}

export function applyDeterministicEconomyTrim({
  replyText = '',
  contract = null,
  dateOrder = 'dmy',
} = {}) {
  const original = String(replyText ?? '').trim();
  if (!original || !contract || !contract.enabled) {
    return { text: original, changed: false, applied: [], droppedLinks: [] };
  }

  let working = original;
  const applied = [];
  const droppedLinks = [];

  // 1. Strip unsolicited citation links `[Nguồn: ...](https://...)` or `[Label](https://...)`
  // NEVER strip actionable deliverable URLs (Google Meet, Zoom, Teams, Docs, Notion, Calendar, iShow Doc...)
  // and NEVER strip a URL directly introduced by a colon (`...: https://...`) which would leave a broken sentence!
  if (contract.links === 'none' || contract.links === 'on_request') {
    const beforeUrls = extractUrls(working);
    if (beforeUrls.length) {
      let stripped = working
        // Drop standalone citation tags like `[Nguồn: Cổng Chính phủ](https://...)` or `[Cổng ...](https://...)`
        .replace(/\s*\[\s*(?:ngu\u1ed3n\s*:\s*)?[^\]\n]{2,80}\]\((https?:\/\/[^\s)]+)\)/giu, (full, url) => {
          if (isActionableDeliverableUrl(url)) return full;
          droppedLinks.push(url);
          return '';
        })
        // Drop unsolicited bare citation URLs (preserve actionable deliverable URLs & colon-introduced URLs)
        .replace(/\s*\(?\bhttps?:\/\/[^\s<>"')\]`]+\)?/gi, (full, offset, src) => {
          const urls = extractUrls(full);
          if (urls.some((u) => isActionableDeliverableUrl(u))) return full;
          const prefix = String(src || '').slice(Math.max(0, offset - 3), offset);
          if (/:\s*$/.test(prefix)) return full;
          for (const u of urls) droppedLinks.push(u);
          return '';
        })
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.;!?])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (stripped !== working && stripped.length >= 16) {
        const inv = verifyCompressionInvariant(original, stripped, { dateOrder, requireShorter: true, maxRatio: 0.99 });
        if (inv.ok) {
          working = stripped;
          applied.push('strip_unsolicited_links');
        }
      }
    }
  }

  // 2. Strip trailing process/non-action/source-tag lines when substantive answer remains
  if (contract.suppressProcessNarration && TRAILING_PROCESS_SENTENCE_RE.test(working)) {
    const stripped = working
      .replace(TRAILING_PROCESS_SENTENCE_RE, '')
      .replace(/(?:\s*\[\[bubble\]\]\s*)+$/iu, '')
      .trim();
    if (stripped !== working && stripped.length >= 20) {
      const inv = verifyCompressionInvariant(original, stripped, { dateOrder, requireShorter: true, maxRatio: 0.99 });
      if (inv.ok) {
        working = stripped;
        applied.push('strip_trailing_process_line');
      }
    }
  }

  // 3. Strip trailing unsolicited follow-up question when allowedFollowUps === 0
  if (contract.allowedFollowUps === 0) {
    const parts = working.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2 && parts[parts.length - 1].endsWith('?')) {
      const candidate = parts.slice(0, -1).join('\n').trim();
      if (candidate.length >= 24) {
        const inv = verifyCompressionInvariant(original, candidate, { dateOrder, requireShorter: true, maxRatio: 0.99 });
        if (inv.ok) {
          working = candidate;
          applied.push('strip_unsolicited_follow_up');
        }
      }
    } else if (parts.length === 1 && working.endsWith('?') && working.length > 90) {
      const sents = working.split(/(?<=[.!])\s+/);
      if (sents.length >= 2 && sents[sents.length - 1].endsWith('?')) {
        const candidate = sents.slice(0, -1).join(' ').trim();
        if (candidate.length >= 24) {
          const inv = verifyCompressionInvariant(original, candidate, { dateOrder, requireShorter: true, maxRatio: 0.99 });
          if (inv.ok) {
            working = candidate;
            applied.push('strip_unsolicited_follow_up');
          }
        }
      }
    }
  }

  return {
    text: working,
    changed: applied.length > 0 && working !== original,
    applied,
    droppedLinks: [...new Set(droppedLinks)],
  };
}

const COMPRESS_SYSTEM_VI = [
  'Bạn là biên tập viên rút gọn tin nhắn chat theo chuẩn tối giản người thật (SCROLL 2.7 Response Economy).',
  'MỤC TIÊU: Cắt sạch phần giải thích thừa, kể cách làm/công cụ, nhại lại lời người dùng, hướng dẫn 1/2/3 không ai hỏi, link không ai xin và câu hỏi gợi mở thừa — CHỈ giữ đúng kết quả hoặc câu trả lời trực diện cho điều người dùng vừa hỏi.',
  'BẤT BIẾN TUYỆT ĐỐI:',
  '1. MỌI con số, số tiền, tỷ lệ %, ngày tháng, mã biểu mẫu, điều luật còn giữ lại PHẢI giữ nguyên văn 100% như bản gốc — TUYỆT ĐỐI KHÔNG bịa thêm hay sửa số.',
  '2. KHÔNG lật phủ định (không/chưa/cấm/trừ khi) của kết luận chính.',
  '3. Giữ giọng chat tự nhiên gần gũi (xưng hô như bản gốc), KHÔNG markdown **đậm**, KHÔNG dấu chấm phẩy ;, KHÔNG thêm lời xin lỗi hay giải trình mới.',
  '4. Chỉ trả về duy nhất nội dung tin nhắn đã rút gọn.',
].join('\n');

const COMPRESS_SYSTEM_EN = [
  'You are a precision minimalist chat editor (SCROLL 2.7 Response Economy).',
  'GOAL: Cut process narration, tool play-by-play, user-instruction echoing, unsolicited tutorials/edge-cases, unrequested URLs, and filler follow-up questions — keep ONLY the direct outcome or answer to what the user asked.',
  'STRICT INVARIANTS:',
  '1. Every retained number, amount, percentage, date, code, or citation MUST remain 100% verbatim from the draft — NEVER fabricate or alter facts.',
  '2. NEVER flip polarity or negations (not/never/cannot).',
  '3. Keep natural human chat tone, no markdown bold/headers, no new apologies or commentary.',
  '4. Return ONLY the compressed message text.',
].join('\n');

export function createResponseEconomyEngine(userConfig = {}) {
  const runtimeCfg = { ...DEFAULT_RESPONSE_ECONOMY_RUNTIME, ...(userConfig || {}) };
  const economyCfg = resolveEconomyConfig(userConfig?.economy || userConfig);
  const telemetryPath = runtimeCfg.telemetryPath || (
    runtimeCfg.stateDir && runtimeCfg.telemetryEnabled
      ? path.join(path.resolve(runtimeCfg.stateDir), 'telemetry', `economy-watch-${String(runtimeCfg.accountId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_')}.jsonl`)
      : null
  );

  function recordTelemetry(row) {
    if (!telemetryPath || !runtimeCfg.telemetryEnabled) return;
    try {
      fs.mkdirSync(path.dirname(telemetryPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(telemetryPath) && fs.statSync(telemetryPath).size > runtimeCfg.telemetryMaxBytes) {
        try { fs.renameSync(telemetryPath, `${telemetryPath}.prev`); } catch { /* ignore */ }
      }
      fs.appendFileSync(telemetryPath, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  async function processOutgoing({
    rawReply = '',
    userText = '',
    recentUserTexts = [],
    contract = null,
    provider = null,
    model = null,
    channel = 'chat',
    dateOrder = runtimeCfg.dateOrder,
    turnDurationMs = 0,
    postGenLlmAlreadyUsed = false,
    triggerKind = null,
    verifyGrounded = null,
    toolNames = [],
  } = {}) {
    const original = String(rawReply ?? '').trim();
    const effectiveContract = contract || { enabled: economyCfg.mode !== 'off', mode: economyCfg.mode };
    if (!runtimeCfg.enabled || runtimeCfg.mode === 'off' || !effectiveContract.enabled || !original) {
      return {
        text: original,
        changed: false,
        usedLlmPass: false,
        deterministicApplied: [],
        auditBefore: null,
        auditAfter: null,
        workLedger: null,
      };
    }

    const auditBefore = auditResponseEconomy({
      userText,
      replyText: original,
      contract: effectiveContract,
      recentUserTexts,
    });

    const trimmed = runtimeCfg.mode === 'live'
      ? applyDeterministicEconomyTrim({ replyText: original, contract: effectiveContract, dateOrder })
      : { text: original, changed: false, applied: [], droppedLinks: [] };

    const postTrimText = trimmed.text;
    const auditAfterTrim = trimmed.changed
      ? auditResponseEconomy({ userText, replyText: postTrimText, contract: effectiveContract, recentUserTexts })
      : auditBefore;

    let finalText = postTrimText;
    let usedLlmPass = false;
    let compressRejectedReason = null;

    // INV-EC-1: Max 1 post-gen LLM pass total per turn (never stack on groundingSelfHealed!)
    const budgetAllowsCompress = !postGenLlmAlreadyUsed
      && triggerKind !== 'active_latch'
      && (Number(turnDurationMs || 0) <= runtimeCfg.compressMaxTurnLatencyMs);

    const shouldAttemptLlmCompress = Boolean(
      runtimeCfg.mode === 'live' &&
      economyCfg.compress_llm &&
      budgetAllowsCompress &&
      auditAfterTrim.needsLlmCompress &&
      postTrimText.length <= runtimeCfg.compressMaxInputChars &&
      provider &&
      provider.ready &&
      typeof provider.generate === 'function',
    );

    if (shouldAttemptLlmCompress) {
      const violationSummary = auditAfterTrim.violations
        .map((v) => `- ${v.code}: ${v.detail}`)
        .join('\n');
      const prompt = [
        `TURN_SHAPE: ${effectiveContract.shape} (target <= ${effectiveContract.targetMaxChars} chars, allowedFollowUps=${effectiveContract.allowedFollowUps}, links=${effectiveContract.links})`,
        `USER_MESSAGE:\n${String(userText || '').slice(0, 350)}`,
        `VIOLATIONS_TO_FIX:\n${violationSummary}`,
        `DRAFT_REPLY:\n${postTrimText}`,
      ].join('\n\n');
      try {
        const res = await provider.generate(prompt, {
          model: model || undefined,
          system: runtimeCfg.locale === 'en' ? COMPRESS_SYSTEM_EN : COMPRESS_SYSTEM_VI,
          effort: 'low',
          serviceTier: 'fast',
          ephemeral: true,
          tools: undefined,
          timeoutMs: runtimeCfg.compressTimeoutMs,
        });
        const candidate = String(res?.text || '').trim().replace(/^```(?:\w+)?\s*|\s*```$/g, '').trim();
        if (!candidate) {
          compressRejectedReason = 'empty_output';
        } else {
          const inv = verifyCompressionInvariant(original, candidate, {
            dateOrder,
            minChars: 6,
            requireShorter: true,
            maxRatio: 0.92,
          });
          if (!inv.ok) {
            compressRejectedReason = inv.reason || 'compression_invariant_failed';
          } else {
            let groundingOk = true;
            if (typeof verifyGrounded === 'function') {
              const g = verifyGrounded(candidate);
              if (g && g.ok === false) groundingOk = false;
            }
            if (!groundingOk) {
              compressRejectedReason = 'grounding_failed';
            } else {
              const auditCand = auditResponseEconomy({
                userText,
                replyText: candidate,
                contract: effectiveContract,
                recentUserTexts,
              });
              if (auditCand.score <= auditAfterTrim.score) {
                finalText = candidate;
                usedLlmPass = true;
              } else {
                compressRejectedReason = 'score_not_improved';
              }
            }
          }
        }
      } catch (err) {
        compressRejectedReason = `provider_error:${String(err?.message || err).slice(0, 60)}`;
      }
    }

    const auditAfter = finalText === postTrimText
      ? auditAfterTrim
      : auditResponseEconomy({ userText, replyText: finalText, contract: effectiveContract, recentUserTexts });

    const allUrls = [...new Set([...extractUrls(original), ...trimmed.droppedLinks])];
    const workLedger = (allUrls.length || (Array.isArray(toolNames) && toolNames.length) || finalText !== original)
      ? {
          ts: new Date().toISOString(),
          shape: effectiveContract.shape,
          toolNames: [...new Set((toolNames || []).filter(Boolean))],
          urls: allUrls.slice(0, 8),
          rawChars: original.length,
          finalChars: finalText.length,
        }
      : null;

    if (!auditBefore.ok || finalText !== original || compressRejectedReason) {
      recordTelemetry({
        ts: new Date().toISOString(),
        channel: String(channel || 'chat').slice(0, 32),
        mode: runtimeCfg.mode,
        shape: effectiveContract.shape,
        rawChars: original.length,
        finalChars: finalText.length,
        targetMaxChars: effectiveContract.targetMaxChars,
        compressionRatio: +(finalText.length / Math.max(1, original.length)).toFixed(3),
        echoOverlap: auditBefore.metrics.echoOverlap,
        violationsBefore: auditBefore.violations.map((v) => v.code),
        violationsAfter: auditAfter.violations.map((v) => v.code),
        deterministicApplied: trimmed.applied,
        usedLlmPass,
        ...(compressRejectedReason ? { compressRejectedReason } : {}),
      });
    }

    return {
      text: finalText,
      changed: finalText !== original,
      usedLlmPass,
      compressRejectedReason,
      deterministicApplied: trimmed.applied,
      auditBefore,
      auditAfter,
      workLedger,
    };
  }

  return {
    enabled: runtimeCfg.enabled && runtimeCfg.mode !== 'off' && economyCfg.mode !== 'off',
    mode: runtimeCfg.mode,
    economyConfig: economyCfg,
    processOutgoing,
  };
}
