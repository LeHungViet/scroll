// SCROLL 2.7 (§51) — Turn Intent & Response Economy Contract Router (`lib/turn-budget.js`).
//
// Decouples thinking depth ("brain" = provider effort) from surface output discipline
// ("mouth" = AnswerContract). By default (`effort_routing: 'fixed'`), thinking effort stays at
// the agent's configured level (high/ultra) so intelligence never regresses on terse-but-hard
// prompts; optional `effort_routing: 'auto'` enforces a strict 6-gate fail-high allowlist +
// mid-turn deterministic escalation ladder.
//
// Zero dependencies, deterministic (<0.5ms), channel-agnostic, §13 Region-C cache-safe. Node >= 20.

export const TURN_SHAPES = Object.freeze([
  'ack_confirm',
  'action_exec',
  'status_yn',
  'lookup_brief',
  'provenance_pull',
  'complex_analysis',
]);

export const DEFAULT_ECONOMY_CONFIG = Object.freeze({
  mode: 'balanced', // 'outcome_only' | 'balanced' | 'detailed' | 'off'
  effort_routing: 'fixed', // 'fixed' (keep high/ultra by default) | 'auto' (opt-in fail-high)
  links: 'on_request', // 'on_request' | 'inline' | 'always'
  process_narration: 'suppress', // 'suppress' | 'allow'
  echo_guard: 'strict', // 'strict' | 'normal' | 'off'
  default_follow_up: 0,
  compress_llm: true,
  max_chars_brief: 420,
});

function foldAscii(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function stripLeadingMentions(text) {
  return String(text ?? '')
    .replace(/(?:^|\s)@[A-Za-z0-9_]{2,64}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PROVENANCE_PULL_RE = /\b(?:nguon\s+(?:o\s+)?dau|cho\s+(?:anh|chi|minh|em)?\s*(?:xin\s+)?link|gui\s+link|link\s+dau|trich\s+dan|xem\s+quy\s+dinh|van\s+ban\s+nao|dieu\s+luat\s+nao|lam\s+kieu\s+gi|lam\s+bang\s+cach\s+nao|giai\s+thich\s+ky|chi\s+tiet\s+hon|noi\s+ro\s+hon|source\s+link|where\s+is\s+the\s+source|how\s+did\s+you|more\s+details?|expand\s+on)\b/i;

const EXPLICIT_LINK_INTENT_RE = /\b(?:link\b|url\b|duong\s+dan\b|meeting\s+link|join\s+link|zoom\s+link|meet\s+link)/i;

const COMPLEX_ANALYSIS_RE = /\b(?:phan\s+tich|so\s+sanh|phuong\s+an|xem\s+(?:lai\s+)?pa\b|danh\s+gia\s+lai|xem\s+lai\s+phuong\s+an|chi\s+tiet|tung\s+buoc|huong\s+dan\s+(?:cach|chi\s+tiet|tung\s+buoc)|cu\s+the\s+luon|viet\s+bao\s+cao|lap\s+ke\s+hoach|giai\s+trinh|doi\s+chieu\s+ky|step[- ]by[- ]step|detailed|compare|analyze|proposal|full\s+report)\b/i;

const PUSHBACK_RE = /\b(?:khong\s+on|k\s+on|ko\s+on|chua\s+on|sai\s+roi|nham\s+roi|nham\s+cho|khong\s+dung|k\s+dung|chui\s+(?:anh|a|em|e)|ngu\s+the|quan\s+tam\s+lam\s+gi|lam\s+an\s+kieu\s+gi|check\s+lai\s+ky|xem\s+lai\s+di|wrong|not\s+right|recheck|that's\s+wrong)\b/i;

const ACTION_EXEC_RE = /^(?:(?:ok|oke|uk|u|uh|the|vay|thoi|o)\s*,?\s*)?(?:(?:em|e|bot)\s+)?(?:xoa|nop|cap\s+nhat|gui|mo\s+lai|mo|tao|sua|chinh|doi|huy|chay|quet|luu|dang|up|push|submit|delete|remove|send|open|update|create|fix|run|export)\b/i;

const ACK_CONFIRM_RE = /^(?:(?:ok|oke|okie|uk|u|uh|chuan|dung\s+roi|tot|ngon|tuyet|cam\s+on|thanks?|thank\s+you|got\s+it|sounds?\s+good|noted|alo+|hello+|hi+|hey+|chao)(?:\s+(?:em|e|anh|a|nha|nhe|roi|r|ne))?(?:[.!,\s]|$)|(?:lam\s+(?:gi|j)|tu\s+nay|lan\s+sau|bao\s+cao\s+hang\s+ngay|moi\s+lan)\b.{0,90}\b(?:nho|ghi\s+nho|gui\s+anh|report|buoc\s+lam|lam\s+the\s+nhe)\b|.*\b(?:ghi\s+nho|nho\s+buoc\s+lam|nho\s+nhe|nho\s+nha|remember\s+to|always\s+send)\b)/i;

const SHORT_APPROVAL_RE = /^(?:ok|oke|okie|uk|u|uh|duyet|chot|chuan|dong\s+y|duoc|dc|lam\s+di|trien\s+di|nop\s+di|gui\s+di|submit|go|yes|approve|approved|lgtm)(?:\s+(?:em|e|nha|nhe|di|luon|roi|r|a))?[.!,\s]*$/i;

const PENDING_PROPOSAL_RE = /\b(?:duyet|de\s+xuat|du\s+thao|ban\s+nhap|du\s+kien|xac\s+nhan|bao\s+cao|nop|submit|yesterday.?s\s+tasks|today.?s\s+plan|em\s+chuyen|em\s+bo\s+sung|gui\s+anh\s+duyet|anh\s+duyet|proposed|draft|ready\s+to|shall\s+i|should\s+i)\b/i;

const STATUS_YN_RE = /\b(?:chua\??$|xong\s+chua|nop\s+(?:len\s+)?chua|sao\s+(?:roi|r)\??$|co\s+phai\b|co\s+duoc\b|co\s+dc\b|co\s+can\b|duoc\s+(?:khong|ko|k)\b|dc\s+(?:khong|ko|k)\b|phai\s+khong|(?:khong|ko|k)\s*\??$|is\s+it\s+done|have\s+you|do\s+i\s+need|can\s+i|should\s+i)\b/i;

const HIGH_STAKES_DOMAIN_RE = /\b(?:thue|bhxh|mst|etax|htkk|to\s+khai|quyet\s+toan|cuong\s+che|phat|no\s+thue|hoa\s+don|hop\s+dong|chuyen\s+tien|chuyen\s+khoan|xoa|delete|drop|production|deploy|mat\s+khau|password|token|secret|contract|invoice|tax|payroll|salary)\b/i;

const EFFORT_LADDER = ['low', 'medium', 'high', 'ultra'];

function effortRank(e) {
  const idx = EFFORT_LADDER.indexOf(String(e || '').toLowerCase());
  return idx >= 0 ? idx : 2;
}

export function resolveEconomyConfig(frontmatterEconomy = null, runtimeOverride = null) {
  const fm = frontmatterEconomy && typeof frontmatterEconomy === 'object' ? frontmatterEconomy : {};
  const ov = runtimeOverride && typeof runtimeOverride === 'object' ? runtimeOverride : {};
  const mode = String(ov.mode ?? fm.mode ?? DEFAULT_ECONOMY_CONFIG.mode);
  const isOutcomeOnly = mode === 'outcome_only';
  return {
    mode,
    effort_routing: String(ov.effort_routing ?? fm.effort_routing ?? DEFAULT_ECONOMY_CONFIG.effort_routing),
    links: String(ov.links ?? fm.links ?? (isOutcomeOnly ? 'on_request' : 'inline')),
    process_narration: String(ov.process_narration ?? fm.process_narration ?? (isOutcomeOnly ? 'suppress' : 'allow')),
    echo_guard: String(ov.echo_guard ?? fm.echo_guard ?? (isOutcomeOnly ? 'strict' : 'normal')),
    default_follow_up: Number(ov.default_follow_up ?? fm.default_follow_up ?? (isOutcomeOnly ? 0 : 1)),
    compress_llm: Boolean(ov.compress_llm ?? fm.compress_llm ?? DEFAULT_ECONOMY_CONFIG.compress_llm),
    max_chars_brief: Math.max(80, Number(ov.max_chars_brief ?? fm.max_chars_brief ?? DEFAULT_ECONOMY_CONFIG.max_chars_brief)),
  };
}

export function isPushbackSignal(text) {
  return PUSHBACK_RE.test(foldAscii(stripLeadingMentions(text)));
}

export function classifyTurnBudget({
  text = '',
  history = [],
  attachments = [],
  isGroup = false,
  economy = null,
  style = null,
  configuredEffort = null,
  pushbackTurnsLeft = 0,
} = {}) {
  const cfg = resolveEconomyConfig(economy);
  const cleaned = stripLeadingMentions(text);
  const folded = foldAscii(cleaned);
  const len = cleaned.length;
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
  const hasUrl = /https?:\/\//i.test(cleaned);
  const hasQuestionMark = cleaned.includes('?');
  const questionCount = (cleaned.match(/\?/g) || []).length;
  const isPushback = PUSHBACK_RE.test(folded);
  const isHighStakes = HIGH_STAKES_DOMAIN_RE.test(folded);
  const styleMaxChars = Number(style?.max_chars || 2800);

  const lastAssistantMsg = Array.isArray(history)
    ? [...history].reverse().find((m) => m && m.role === 'assistant' && typeof m.content === 'string')
    : null;
  const prevWasProposal = Boolean(
    lastAssistantMsg && (
      PENDING_PROPOSAL_RE.test(foldAscii(lastAssistantMsg.content)) ||
      lastAssistantMsg.content.trim().endsWith('?')
    )
  );

  let shape = 'lookup_brief';
  let reason = 'default_brief_lookup';

  if (PROVENANCE_PULL_RE.test(folded)) {
    shape = 'provenance_pull';
    reason = 'explicit_provenance_or_detail_pull';
  } else if (
    hasAttachments ||
    COMPLEX_ANALYSIS_RE.test(folded) ||
    isPushback ||
    len >= 150 ||
    questionCount >= 2
  ) {
    shape = 'complex_analysis';
    reason = hasAttachments
      ? 'attachments_present'
      : (isPushback ? 'user_pushback_requires_deep_review' : 'explicit_complex_or_long_prompt');
  } else if (!hasQuestionMark && !hasUrl && len <= 45 && prevWasProposal && SHORT_APPROVAL_RE.test(folded)) {
    shape = 'action_exec';
    reason = 'approval_of_pending_proposal';
  } else if (!hasQuestionMark && !hasUrl && len <= 135 && ACK_CONFIRM_RE.test(folded) && !ACTION_EXEC_RE.test(folded)) {
    shape = 'ack_confirm';
    reason = 'short_ack_or_rule_note';
  } else if (len <= 70 && STATUS_YN_RE.test(folded)) {
    shape = 'status_yn';
    reason = 'short_status_or_yes_no';
  } else if (!hasQuestionMark && len <= 110 && ACTION_EXEC_RE.test(folded)) {
    shape = 'action_exec';
    reason = 'imperative_action_command';
  }

  // Build surface AnswerContract decoupled from thinking effort
  const briefTarget = Math.min(styleMaxChars, cfg.max_chars_brief);
  let targetMaxChars = briefTarget;
  let hardMaxChars = Math.min(styleMaxChars, Math.round(briefTarget * 1.32));
  let allowedFollowUps = cfg.default_follow_up;
  let links = cfg.links;
  let outcomeOnly = cfg.mode === 'outcome_only';
  let suppressProcessNarration = cfg.process_narration === 'suppress';
  let suppressUnsolicitedTutorial = cfg.mode === 'outcome_only';
  let echoGuard = cfg.echo_guard;
  let allowWorkLedgerPull = false;

  const lastUserMsg = Array.isArray(history)
    ? [...history].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string')
    : null;
  const userRequestedLink = EXPLICIT_LINK_INTENT_RE.test(folded)
    || Boolean(len <= 80 && lastUserMsg && EXPLICIT_LINK_INTENT_RE.test(foldAscii(lastUserMsg.content)));

  if (shape === 'ack_confirm') {
    targetMaxChars = Math.min(styleMaxChars, 75);
    hardMaxChars = Math.min(styleMaxChars, 115);
    allowedFollowUps = 0;
    links = userRequestedLink ? 'inline' : 'none';
    outcomeOnly = true;
    suppressProcessNarration = true;
    suppressUnsolicitedTutorial = true;
  } else if (shape === 'action_exec') {
    targetMaxChars = Math.min(styleMaxChars, 135);
    hardMaxChars = Math.min(styleMaxChars, 210);
    allowedFollowUps = 0;
    links = userRequestedLink ? 'inline' : 'none';
    outcomeOnly = true;
    suppressProcessNarration = true;
    suppressUnsolicitedTutorial = true;
  } else if (shape === 'status_yn') {
    targetMaxChars = Math.min(styleMaxChars, 220);
    hardMaxChars = Math.min(styleMaxChars, 310);
    allowedFollowUps = 0;
    links = userRequestedLink ? 'inline' : (cfg.links === 'always' ? 'always' : 'on_request');
    outcomeOnly = true;
    suppressUnsolicitedTutorial = true;
  } else if (shape === 'lookup_brief') {
    targetMaxChars = briefTarget;
    hardMaxChars = Math.min(styleMaxChars, Math.round(briefTarget * 1.32));
    allowedFollowUps = cfg.mode === 'outcome_only' ? 0 : cfg.default_follow_up;
    links = userRequestedLink ? 'inline' : (cfg.links === 'always' ? 'always' : 'on_request');
    suppressUnsolicitedTutorial = cfg.mode === 'outcome_only';
  } else if (shape === 'provenance_pull') {
    targetMaxChars = Math.min(styleMaxChars, 900);
    hardMaxChars = Math.min(styleMaxChars, 1300);
    allowedFollowUps = 0;
    links = 'inline';
    outcomeOnly = false;
    suppressProcessNarration = false;
    suppressUnsolicitedTutorial = false;
    allowWorkLedgerPull = true;
  } else if (shape === 'complex_analysis') {
    const complexCap = cfg.mode === 'outcome_only' ? 880 : 1200;
    targetMaxChars = Math.min(styleMaxChars, complexCap);
    hardMaxChars = Math.min(styleMaxChars, Math.round(complexCap * 1.35));
    allowedFollowUps = Math.min(1, Number(style?.follow_up ?? 1));
    links = cfg.links === 'always' ? 'always' : (cfg.mode === 'outcome_only' ? 'on_request' : 'inline');
    suppressUnsolicitedTutorial = false;
  }

  // Effort governance: DEFAULT = 'fixed' (keep configured high/ultra effort — zero intelligence loss!)
  // Opt-in 'auto' uses a strict 6-gate fail-high allowlist: ONLY trivial pure ack_confirm downgrades.
  let effectiveEffort = configuredEffort || null;
  let effortPolicy = 'fixed_keep_configured';
  if (cfg.effort_routing === 'auto' && configuredEffort) {
    const recentErr = Array.isArray(history) && history.slice(-2).some((m) =>
      m && m.role === 'assistant' && /\b(?:loi|chua\s+xac\s+minh|bi\s+chan|held|error|failed)\b/i.test(foldAscii(m.content || ''))
    );
    const sixGatesGreen = (
      shape === 'ack_confirm' &&
      !hasAttachments &&
      !hasUrl &&
      !hasQuestionMark &&
      !isPushback &&
      !isHighStakes &&
      !isGroup &&
      !recentErr &&
      Number(pushbackTurnsLeft || 0) <= 0 &&
      len > 0 &&
      len <= 70
    );
    if (sixGatesGreen) {
      effectiveEffort = 'low';
      effortPolicy = 'auto_allowlist_trivial_ack';
    } else {
      effectiveEffort = configuredEffort;
      effortPolicy = 'auto_fail_high_preserved';
    }
  }

  return {
    enabled: cfg.mode !== 'off',
    mode: cfg.mode,
    shape,
    reason,
    targetMaxChars,
    hardMaxChars,
    allowedFollowUps,
    links,
    outcomeOnly,
    suppressProcessNarration,
    suppressUnsolicitedTutorial,
    echoGuard,
    allowWorkLedgerPull,
    isPushback,
    isHighStakes,
    effectiveEffort,
    effortPolicy,
    configuredEffort: configuredEffort || null,
  };
}

// Mid-turn deterministic escalation ladder for opt-in `effort_routing: 'auto'`
export function escalateEffortForRound({
  currentEffort = null,
  configuredEffort = null,
  toolCalled = false,
  toolMutating = false,
  toolError = false,
  roundIndex = 0,
  groundingRetry = false,
} = {}) {
  const maxFloor = configuredEffort || 'ultra';
  if (!currentEffort) return maxFloor;
  let target = currentEffort;
  if (toolError || groundingRetry || toolMutating || roundIndex >= 1) {
    target = maxFloor;
  } else if (toolCalled && effortRank(currentEffort) < effortRank('high')) {
    target = effortRank(maxFloor) >= effortRank('high') ? 'high' : maxFloor;
  }
  return effortRank(target) > effortRank(currentEffort) ? target : currentEffort;
}

// Compact Region-C AnswerContract directive (preserves 100% Region-A prefixHash §13!)
export function renderAnswerContractCue(contract, { locale = 'vi', workLedger = null } = {}) {
  if (!contract || !contract.enabled || contract.mode === 'detailed' || contract.mode === 'off') {
    return '';
  }
  const rules = [];
  if (locale === 'vi') {
    if (contract.reason === 'approval_of_pending_proposal') {
      rules.push('Người dùng vừa DUYỆT đề xuất/bản nháp ở lượt trước: THỰC HIỆN NGAY hành động đã đề xuất (gửi/nộp/cập nhật) nếu chưa làm, sau đó báo ngắn gọn kết quả.');
    }
    rules.push(`Mục tiêu độ dài: <= ${contract.targetMaxChars} ký tự (tối đa ${contract.hardMaxChars}); đi thẳng vào đúng điều người dùng hỏi.`);
    if (contract.echoGuard === 'strict' && (contract.shape === 'ack_confirm' || contract.shape === 'action_exec')) {
      rules.push(contract.shape === 'ack_confirm'
        ? 'CẤM nhắc lại hay tóm tắt lại lời người dùng vừa dặn (xác nhận gọn 1 câu).'
        : 'CẤM nhắc lại hay tóm tắt lại lời người dùng vừa dặn; báo gọn kết quả thực hiện.');
    }
    if (contract.suppressProcessNarration) {
      rules.push('CHỈ báo kết quả cuối cùng; KHÔNG kể cách làm, công cụ đã dùng, thao tác trung gian hay trạng thái chưa làm mà không ai hỏi.');
    }
    if (contract.suppressUnsolicitedTutorial) {
      rules.push('KHÔNG tự hướng dẫn từng bước (1/2/3), KHÔNG xả ngoại lệ hay chủ đề phụ chưa được hỏi.');
    }
    if (contract.links === 'none' || contract.links === 'on_request') {
      rules.push('KHÔNG gắn URL hay "Nguồn: ..." trừ khi người dùng hỏi xin nguồn/link.');
    }
    if (contract.allowedFollowUps === 0) {
      rules.push('Xong ý chính thì DỪNG, KHÔNG gắn câu hỏi gợi mở cuối tin.');
    }
  } else {
    rules.push(`Target length: <= ${contract.targetMaxChars} chars (hard max ${contract.hardMaxChars}); answer ONLY what was asked.`);
    if (contract.echoGuard === 'strict' && (contract.shape === 'ack_confirm' || contract.shape === 'action_exec')) {
      rules.push('Do NOT repeat or paraphrase the user instruction back.');
    }
    if (contract.suppressProcessNarration) {
      rules.push('Report outcome ONLY; do NOT narrate tool calls, tabs, intermediate steps, or unasked non-actions.');
    }
    if (contract.suppressUnsolicitedTutorial) {
      rules.push('Do NOT dump unasked step-by-step tutorials, edge cases, or secondary topics.');
    }
    if (contract.links === 'none' || contract.links === 'on_request') {
      rules.push('Omit unsolicited citation/source URLs unless asked (ALWAYS include actionable links such as meeting, doc, or calendar URLs when relevant).');
    }
    if (contract.allowedFollowUps === 0) {
      rules.push('Stop once answered; no trailing follow-up question.');
    }
  }

  const lines = [`[SCROLL 2.7 Output Contract · shape=${contract.shape}]\n${rules.join(' ')}`];
  if (contract.allowWorkLedgerPull && workLedger) {
    const ledgerParts = [];
    if (Array.isArray(workLedger.toolNames) && workLedger.toolNames.length) {
      ledgerParts.push(`tools: ${workLedger.toolNames.join(', ')}`);
    }
    if (Array.isArray(workLedger.urls) && workLedger.urls.length) {
      ledgerParts.push(`urls: ${workLedger.urls.slice(0, 6).join(' | ')}`);
    }
    if (ledgerParts.length) {
      lines.push(`[Previous Turn Work Ledger (pull-on-demand)]\n${ledgerParts.join('\n')}`);
    }
  }
  return lines.join('\n');
}
