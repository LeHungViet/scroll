// SCROLL 2.5 -- Channel-Agnostic Crash-Proof Turn Recovery WAL (`@agentpro/scroll/chat`).
//
// Reusable across ANY chat adapter (Telegram, Slack, Discord, Zalo, WhatsApp, Web, RIVER)
// and ANY agent without hardcoded channel names, model vendors, or domain prose.
//
// Guarantees:
//   1. Write-Ahead Journal on disk (`pending-turns-<channel>-<accountId>.json`, atomic 0o600)
//      persisted BEFORE provider execution so mid-turn crashes/reboots never drop context.
//   2. 3-stage self-healing recovery on transient provider errors:
//      Stage 1 inline retry -> Stage 2 deferred background retry -> Stage 3 startup catch-up replay.
//   3. 5-layer anti-duplicate & anti-crash-loop protection on startup replay:
//      TTL expiry, crash-loop cap persisted BEFORE replay, newer inbound check,
//      live turn sequence check, and session history assistant-reply check.
//   4. Automatic Context Carryover: if the user sends a follow-up message before recovery fires,
//      the unanswered prior message (and reply metadata) is folded into the new turn's context
//      and preserved in the new WAL entry (double-crash safe).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TURN_RECOVERY_CONFIG = Object.freeze({
  enabled: true,
  ttlMs: 15 * 60 * 1000,
  maxEntries: 50,
  inlineRetryDelaysMs: [2_000, 4_000],
  deferredRetryDelaysMs: [18_000, 45_000],
  maxStartupReplays: 1,
  startupDelayMs: 4_500,
  startupStaggerMs: 800,
});

export const TRANSIENT_PROVIDER_ERROR_RE = /codex_rpc_timeout|codex.*timeout|initialize:\d+ms|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|fetch failed|socket hang up|process exited|app-server.*closed|app-server.*not running|stream.*aborted|rate.?limit|overloaded|502\b|503\b|504\b|429\b/i;

export function isTransientProviderError(err, extraMatchers = null) {
  const msg = String(err?.message || err || '');
  if (!msg) return false;
  if (TRANSIENT_PROVIDER_ERROR_RE.test(msg)) return true;
  if (Array.isArray(extraMatchers)) {
    for (const m of extraMatchers) {
      if (m instanceof RegExp && m.test(msg)) return true;
      if (typeof m === 'function' && m(err, msg)) return true;
    }
  }
  return false;
}

export const DEFAULT_RECOVERY_CUES = Object.freeze({
  en: Object.freeze({
    deferredCue:
      '[Turn Recovery — transient connection retry] Read the incoming message together with the prior conversation history above and answer directly and naturally. Do NOT ask the user to resend and do NOT mention internal timeouts or technical errors.',
    startupCue:
      '[Turn Recovery — resumed after service restart] Read the user message together with all prior conversation history (session transcript, room context, and any replied-to message) and reply directly and naturally. Do NOT ask the user to resend and do NOT mention restarts or technical errors.',
    formatCarryover({ senderName, text, replyNote }) {
      const who = senderName || 'User';
      const lines = [
        `[Prior unanswered message interrupted by a temporary connection drop (${who}): "${String(text || '').slice(0, 1200)}"]`,
        ...(replyNote ? [String(replyNote).slice(0, 600)] : []),
        'Read both the unanswered message above and the latest message below together and give one complete, natural reply — do not drop the earlier question and do not mention technical errors.',
      ];
      return lines.join('\n');
    },
  }),
  vi: Object.freeze({
    deferredCue:
      '[Tự động khôi phục sau nghẽn kết nối tạm thời] Hãy đọc tin nhắn vừa nhận cùng mạch chat cũ phía trên và trả lời thẳng ngay câu hỏi của người dùng — TUYỆT ĐỐI không hỏi lại, không yêu cầu nhắn lại và không nhắc tới lỗi kỹ thuật.',
    startupCue:
      '[Tự động khôi phục sau khi hệ thống khởi động lại / gián đoạn kết nối] Đọc kỹ tin nhắn của người dùng cùng toàn bộ mạch chat cũ trong lịch sử (sessions / bối cảnh nhóm / tin được reply) và trả lời thẳng ngay, tự nhiên như bình thường — TUYỆT ĐỐI không hỏi lại, không yêu cầu nhắn lại và không nhắc tới việc khởi động lại hay lỗi kỹ thuật.',
    formatCarryover({ senderName, text, replyNote }) {
      const who = senderName || 'Người dùng';
      const lines = [
        `[Tin nhắn trước đó chưa kịp trả lời do gián đoạn kết nối (${who}): "${String(text || '').slice(0, 1200)}"]`,
        ...(replyNote ? [String(replyNote).slice(0, 600)] : []),
        'Hãy đọc gộp cả ý chưa kịp trả lời đó cùng tin nhắn mới nhất dưới đây và trả lời trọn vẹn, tự nhiên — không để sót câu hỏi trước và không nhắc lỗi kỹ thuật.',
      ];
      return lines.join('\n');
    },
  }),
});

const INTERNAL_RETRY_CUE_RE = /^\[(?:Turn Recovery|Tự động khôi phục)/i;
const REPLY_CONTEXT_BLOCK_RE = /\[(?:Trả lời tin|Reply to|Replying to|Replied message)/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeToken(v, fallback = 'default') {
  const s = String(v || '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return s || fallback;
}

export function resolveRecoveryCues(lang = 'en', customCues = null) {
  const langKey = /^vi\b/i.test(String(lang || '')) ? 'vi' : 'en';
  const base = DEFAULT_RECOVERY_CUES[langKey] || DEFAULT_RECOVERY_CUES.en;
  if (!customCues || typeof customCues !== 'object') return base;
  return {
    deferredCue: typeof customCues.deferredCue === 'string' && customCues.deferredCue.trim()
      ? customCues.deferredCue
      : base.deferredCue,
    startupCue: typeof customCues.startupCue === 'string' && customCues.startupCue.trim()
      ? customCues.startupCue
      : base.startupCue,
    formatCarryover: typeof customCues.formatCarryover === 'function'
      ? customCues.formatCarryover
      : base.formatCarryover,
  };
}

export function resolveTurnRecoveryConfig(globalCfg = {}, agentCfg = {}) {
  const g = (globalCfg && typeof globalCfg === 'object') ? (globalCfg.turnRecovery || globalCfg) : {};
  const a = (agentCfg && typeof agentCfg === 'object') ? (agentCfg.turnRecovery || agentCfg) : {};
  const merged = {
    ...DEFAULT_TURN_RECOVERY_CONFIG,
    ...(typeof g === 'object' ? g : {}),
    ...(typeof a === 'object' ? a : {}),
  };
  return Object.freeze({
    enabled: merged.enabled !== false,
    ttlMs: Math.max(1_000, Number(merged.ttlMs ?? DEFAULT_TURN_RECOVERY_CONFIG.ttlMs)),
    maxEntries: Math.max(1, Number(merged.maxEntries ?? DEFAULT_TURN_RECOVERY_CONFIG.maxEntries)),
    inlineRetryDelaysMs: Array.isArray(merged.inlineRetryDelaysMs)
      ? merged.inlineRetryDelaysMs.map((n) => Math.max(0, Number(n) || 0))
      : [...DEFAULT_TURN_RECOVERY_CONFIG.inlineRetryDelaysMs],
    deferredRetryDelaysMs: Array.isArray(merged.deferredRetryDelaysMs)
      ? merged.deferredRetryDelaysMs.map((n) => Math.max(0, Number(n) || 0))
      : [...DEFAULT_TURN_RECOVERY_CONFIG.deferredRetryDelaysMs],
    maxStartupReplays: Math.max(0, Number(merged.maxStartupReplays ?? DEFAULT_TURN_RECOVERY_CONFIG.maxStartupReplays)),
    startupDelayMs: Math.max(0, Number(merged.startupDelayMs ?? DEFAULT_TURN_RECOVERY_CONFIG.startupDelayMs)),
    startupStaggerMs: Math.max(0, Number(merged.startupStaggerMs ?? DEFAULT_TURN_RECOVERY_CONFIG.startupStaggerMs)),
  });
}

export function stripRecoveryCues(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b) => typeof b === 'string' && b.trim() && !INTERNAL_RETRY_CUE_RE.test(b.trim()))
    .slice(-12)
    .map((b) => b.slice(0, 4000));
}

export function sanitizeRecoveryAttachment(att) {
  if (!att || typeof att !== 'object') return null;
  const out = {};
  for (const key of ['type', 'mime', 'mimeType', 'fileName', 'name', 'localPath', 'path', 'size', 'transcript', 'caption', 'width', 'height', 'duration', 'url']) {
    if (att[key] !== undefined && att[key] !== null) out[key] = att[key];
  }
  return Object.keys(out).length ? out : null;
}

export function filterExistingRecoveryAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  return attachments.filter((att) => {
    if (!att || typeof att !== 'object') return false;
    const p = att.localPath || att.path;
    if (!p) return true;
    try { return fs.existsSync(String(p)); } catch { return false; }
  });
}

/**
 * Channel-agnostic message ID comparator:
 * supports Telegram ints, Discord 64-bit snowflakes, Slack float timestamps, and opaque UUIDs.
 */
export function isNewerMessageId(candidateId, baselineId, { candidateAtMs = null, baselineAtMs = null } = {}) {
  if (candidateId == null || baselineId == null) return false;
  const a = String(candidateId).trim();
  const b = String(baselineId).trim();
  if (!a || !b || a === b) return false;
  if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) {
    try { return BigInt(a) > BigInt(b); } catch { /* fall through */ }
  }
  if (/^\d+(?:\.\d+)?$/.test(a) && /^\d+(?:\.\d+)?$/.test(b)) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na > nb;
  }
  if (Number.isFinite(candidateAtMs) && Number.isFinite(baselineAtMs)) {
    return candidateAtMs >= baselineAtMs;
  }
  return true;
}

export function hasAssistantReplyAfter(historyRows, receivedAtMs) {
  if (!Array.isArray(historyRows) || !historyRows.length) return false;
  const threshold = Number(receivedAtMs || 0) - 1000;
  for (let i = historyRows.length - 1; i >= 0; i--) {
    const row = historyRows[i];
    if (!row || row.role !== 'assistant' || row.groundingHeld) continue;
    const rowTs = typeof row.ts === 'number' ? row.ts : Date.parse(String(row.ts || ''));
    if (Number.isFinite(rowTs) && rowTs >= threshold) return true;
    if (Number.isFinite(rowTs) && rowTs < threshold) break;
  }
  return false;
}

export function readPendingTurnJournal(filePath, { ttlMs = DEFAULT_TURN_RECOVERY_CONFIG.ttlMs, nowMs = Date.now() } = {}) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const raw = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const cutoff = nowMs - Math.max(1_000, Number(ttlMs || DEFAULT_TURN_RECOVERY_CONFIG.ttlMs));
    return raw.filter((e) => (
      e &&
      typeof e === 'object' &&
      String(e.conversationId || e.chatId || '').trim() !== '' &&
      e.messageId != null &&
      Number.isFinite(Number(e.receivedAt)) &&
      Number(e.receivedAt) >= cutoff
    ));
  } catch {
    return [];
  }
}

export function writePendingTurnJournal(filePath, entries, { maxEntries = DEFAULT_TURN_RECOVERY_CONFIG.maxEntries } = {}) {
  if (!filePath) return;
  const list = Array.isArray(entries)
    ? [...entries]
        .sort((a, b) => Number(a?.updatedAt || a?.receivedAt || 0) - Number(b?.updatedAt || b?.receivedAt || 0))
        .slice(-Math.max(1, Number(maxEntries || DEFAULT_TURN_RECOVERY_CONFIG.maxEntries)))
    : [];
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: list }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch { /* best-effort */ }
}

export function createTurnRecoveryController({
  stateDir = null,
  channel = 'chat',
  accountId = 'default',
  config = {},
  lang = 'en',
  cues = null,
  isTransientError = isTransientProviderError,
  logger = console,
} = {}) {
  const cfg = resolveTurnRecoveryConfig(config);
  const resolvedCues = resolveRecoveryCues(lang, cues);
  const channelId = safeToken(channel, 'chat');
  const acctId = safeToken(accountId, 'default');
  const journalPath = stateDir
    ? path.join(path.resolve(stateDir), `pending-turns-${channelId}-${acctId}.json`)
    : null;

  const pendingTimers = new Map();
  const startupTimers = new Set();
  const latestTurnSeqByScope = new Map();
  const latestRawDmByScope = new Map();
  let stopped = false;

  function scopeKeyFor(conversationId, threadId = null) {
    return `${channelId}:${acctId}:${String(conversationId || '')}:${threadId != null ? String(threadId) : 'root'}`;
  }

  function listPending({ nowMs = Date.now() } = {}) {
    if (!cfg.enabled || !journalPath) return [];
    return readPendingTurnJournal(journalPath, { ttlMs: cfg.ttlMs, nowMs });
  }

  function getPending({ conversationId, threadId = null, nowMs = Date.now() } = {}) {
    if (!cfg.enabled || !journalPath) return null;
    const scope = scopeKeyFor(conversationId, threadId);
    return listPending({ nowMs }).find((e) => e.scopeKey === scope) || null;
  }

  function upsertEntry(entry) {
    if (!cfg.enabled || !journalPath || !entry?.scopeKey) return;
    const entries = readPendingTurnJournal(journalPath, { ttlMs: cfg.ttlMs });
    const filtered = entries.filter((e) => e.scopeKey !== entry.scopeKey);
    filtered.push(entry);
    writePendingTurnJournal(journalPath, filtered, { maxEntries: cfg.maxEntries });
  }

  function removeEntry({ conversationId, threadId = null, onlyIfMessageId = null } = {}) {
    if (!cfg.enabled || !journalPath || !fs.existsSync(journalPath)) return;
    const scope = scopeKeyFor(conversationId, threadId);
    const entries = readPendingTurnJournal(journalPath, { ttlMs: cfg.ttlMs });
    const next = entries.filter((e) => {
      if (e.scopeKey !== scope) return true;
      if (onlyIfMessageId != null && String(e.messageId) !== String(onlyIfMessageId)) return true;
      return false;
    });
    if (next.length !== entries.length) {
      writePendingTurnJournal(journalPath, next, { maxEntries: cfg.maxEntries });
    }
  }

  function cancelPendingTimer({ conversationId, threadId = null } = {}) {
    const scope = scopeKeyFor(conversationId, threadId);
    const existing = pendingTimers.get(scope);
    if (existing?.timer) clearTimeout(existing.timer);
    pendingTimers.delete(scope);
  }

  function observeIncoming({ conversationId, threadId = null, messageId, isGroup = false, isCommand = false, receivedAt = Date.now() } = {}) {
    if (!cfg.enabled || isGroup || isCommand || !conversationId || messageId == null) return;
    const scope = scopeKeyFor(conversationId, threadId);
    const prev = latestRawDmByScope.get(scope);
    if (!prev || isNewerMessageId(messageId, prev.messageId, { candidateAtMs: receivedAt, baselineAtMs: prev.at })) {
      latestRawDmByScope.set(scope, { messageId, at: receivedAt });
    }
  }

  function buildEntry(turnInput, {
    status = 'inflight',
    deferredAttempt = 0,
    startupReplayCount = 0,
    lastError = null,
    receivedAt = Date.now(),
    extraContextBlocks = [],
  } = {}) {
    const cid = String(turnInput.conversationId || turnInput.chatId || '');
    const tid = turnInput.threadId ?? null;
    const now = Date.now();
    const baseCtx = stripRecoveryCues(turnInput.contextBlocks);
    const mergedCtx = extraContextBlocks.length ? [...baseCtx, ...extraContextBlocks].slice(-12) : baseCtx;
    return {
      scopeKey: scopeKeyFor(cid, tid),
      channel: channelId,
      accountId: acctId,
      conversationId: cid,
      chatId: cid,
      threadId: tid,
      messageId: turnInput.messageId,
      messageIds: Array.isArray(turnInput.messageIds) ? turnInput.messageIds.slice(-20) : [turnInput.messageId],
      isGroup: Boolean(turnInput.isGroup),
      roomTitle: turnInput.roomTitle || turnInput.chatTitle || null,
      chatTitle: turnInput.chatTitle || turnInput.roomTitle || null,
      sender: turnInput.sender ? {
        id: turnInput.sender.id ?? null,
        channelId: turnInput.sender.channelId ?? null,
        name: turnInput.sender.name ?? null,
      } : null,
      participants: Array.isArray(turnInput.participants) ? turnInput.participants.slice(0, 8) : null,
      text: String(turnInput.text || '').slice(0, 8000),
      attachments: Array.isArray(turnInput.attachments)
        ? turnInput.attachments.map(sanitizeRecoveryAttachment).filter(Boolean).slice(0, 10)
        : [],
      contextBlocks: mergedCtx,
      freshThreadContextBlocks: Array.isArray(turnInput.freshThreadContextBlocks)
        ? stripRecoveryCues(turnInput.freshThreadContextBlocks)
        : null,
      triggerKind: turnInput.triggerKind || (turnInput.isGroup ? 'hard' : 'dm'),
      rotateProviderThread: Boolean(turnInput.rotateProviderThread),
      delegatedTools: Array.isArray(turnInput.delegatedTools) ? turnInput.delegatedTools.slice(0, 40) : null,
      metadata: turnInput.metadata && typeof turnInput.metadata === 'object' ? turnInput.metadata : null,
      status,
      receivedAt: Number(receivedAt || now),
      updatedAt: now,
      deferredAttempt: Number(deferredAttempt || 0),
      startupReplayCount: Number(startupReplayCount || 0),
      lastError: lastError ? String(lastError).slice(0, 240) : null,
    };
  }

  function safeGetHistory(getHistory, conversationId) {
    try {
      return typeof getHistory === 'function' ? getHistory(String(conversationId)) : [];
    } catch {
      return [];
    }
  }

  function beginTurn({
    conversationId,
    threadId = null,
    messageId,
    messageIds,
    isGroup = false,
    roomTitle = null,
    chatTitle = null,
    sender = null,
    participants = null,
    text = '',
    attachments = [],
    contextBlocks = [],
    freshThreadContextBlocks = null,
    triggerKind = null,
    rotateProviderThread = false,
    delegatedTools = null,
    metadata = null,
    getHistory = null,
    recoverable = true,
  } = {}) {
    const cid = String(conversationId || '');
    const scope = scopeKeyFor(cid, threadId);
    const nextSeq = (latestTurnSeqByScope.get(scope) || 0) + 1;
    latestTurnSeqByScope.set(scope, nextSeq);
    cancelPendingTimer({ conversationId: cid, threadId });

    let carryoverBlock = null;
    let supersededEntry = null;
    if (cfg.enabled && cid && messageId != null) {
      const prev = getPending({ conversationId: cid, threadId });
      if (
        prev &&
        isNewerMessageId(messageId, prev.messageId, { candidateAtMs: Date.now(), baselineAtMs: prev.receivedAt }) &&
        !hasAssistantReplyAfter(safeGetHistory(getHistory, cid), prev.receivedAt)
      ) {
        supersededEntry = prev;
        const prevText = String(prev.text || '').trim();
        const currText = String(text || '').trim();
        if (prevText && prevText !== currText) {
          const replyNote = (Array.isArray(prev.contextBlocks) ? prev.contextBlocks : [])
            .find((b) => typeof b === 'string' && REPLY_CONTEXT_BLOCK_RE.test(b));
          carryoverBlock = resolvedCues.formatCarryover({
            senderName: prev.sender?.name || null,
            text: prevText,
            replyNote: replyNote || null,
          });
          logger?.info?.(
            `[scroll:turn-recovery:${channelId}:${acctId}] folded unanswered turn (msgId=${prev.messageId}) into live turn (msgId=${messageId}) for ${cid}`,
          );
        }
        if (!recoverable) {
          removeEntry({ conversationId: cid, threadId, onlyIfMessageId: prev.messageId });
        }
      }

      if (recoverable) {
        upsertEntry(buildEntry(
          {
            conversationId: cid,
            threadId,
            messageId,
            messageIds,
            isGroup,
            roomTitle,
            chatTitle,
            sender,
            participants,
            text,
            attachments,
            contextBlocks,
            freshThreadContextBlocks,
            triggerKind,
            rotateProviderThread,
            delegatedTools,
            metadata,
          },
          {
            status: 'inflight',
            deferredAttempt: 0,
            startupReplayCount: 0,
            extraContextBlocks: carryoverBlock ? [carryoverBlock] : [],
          },
        ));
      }
    }

    return {
      turnSeq: nextSeq,
      scopeKey: scope,
      carryoverBlock,
      supersededEntry,
    };
  }

  async function runWithInlineRetry({ fn, signal = null, isRecoveryReplay = false, onRetry = null } = {}) {
    const delays = cfg.enabled ? cfg.inlineRetryDelaysMs : [];
    const maxAttempts = cfg.enabled
      ? (isRecoveryReplay ? Math.min(2, 1 + delays.length) : (1 + delays.length))
      : 1;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      try {
        return await fn(attempt);
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        lastErr = err;
        const canRetry = cfg.enabled && isTransientError(err) && (attempt + 1 < maxAttempts);
        if (!canRetry) throw err;
        const delayMs = Math.max(0, Number(delays[attempt] ?? 2_000));
        if (typeof onRetry === 'function') {
          try { onRetry({ attempt: attempt + 1, maxAttempts, delayMs, err }); } catch { /* ignore */ }
        }
        if (delayMs > 0) await sleep(delayMs);
      }
    }
    throw lastErr;
  }

  function completeTurn({ conversationId, threadId = null, messageId = null } = {}) {
    if (!cfg.enabled || !conversationId) return;
    removeEntry({ conversationId, threadId, onlyIfMessageId: messageId });
  }

  function handleTurnFailure({
    err,
    turnInput,
    turnSeq,
    deferredAttempt = 0,
    isStartupRecovery = false,
    isRecoverable = true,
    onDeferredRetry = null,
    onExhausted = null,
  } = {}) {
    if (err?.name === 'AbortError') {
      return { action: 'aborted' };
    }
    const cid = String(turnInput?.conversationId || turnInput?.chatId || '');
    const tid = turnInput?.threadId ?? null;
    const msgId = turnInput?.messageId ?? null;
    const scope = scopeKeyFor(cid, tid);
    const transient = isTransientError(err);

    if (
      cfg.enabled &&
      isRecoverable &&
      cid &&
      msgId != null &&
      transient &&
      deferredAttempt < cfg.deferredRetryDelaysMs.length &&
      typeof onDeferredRetry === 'function'
    ) {
      const waitMs = Math.max(10, Number(cfg.deferredRetryDelaysMs[deferredAttempt] ?? 18_000));
      const expectedSeq = Number(turnSeq ?? (latestTurnSeqByScope.get(scope) || 0));
      const existing = getPending({ conversationId: cid, threadId: tid });
      const entry = buildEntry(turnInput, {
        status: 'retry_pending',
        deferredAttempt: deferredAttempt + 1,
        startupReplayCount: existing && String(existing.messageId) === String(msgId)
          ? Number(existing.startupReplayCount || 0)
          : (isStartupRecovery ? cfg.maxStartupReplays : 0),
        receivedAt: existing && String(existing.messageId) === String(msgId)
          ? existing.receivedAt
          : Number(turnInput?.receivedAt || Date.now()),
        lastError: err?.message || err,
      });
      upsertEntry(entry);
      cancelPendingTimer({ conversationId: cid, threadId: tid });
      logger?.warn?.(
        `[scroll:turn-recovery:${channelId}:${acctId}] scheduling deferred recovery #${deferredAttempt + 1} for ${entry.roomTitle || cid} in ${waitMs}ms`,
      );
      const timer = setTimeout(async () => {
        pendingTimers.delete(scope);
        if (stopped) return;
        if ((latestTurnSeqByScope.get(scope) || 0) !== expectedSeq) return;
        try {
          await onDeferredRetry({
            entry,
            deferredAttempt: deferredAttempt + 1,
            recoveryCue: resolvedCues.deferredCue,
            expectedSeq,
            isStartupRecovery,
          });
        } catch (recErr) {
          logger?.warn?.(
            `[scroll:turn-recovery:${channelId}:${acctId}] deferred recovery callback failed (${entry.roomTitle || cid}):`,
            recErr?.message || recErr,
          );
        }
      }, waitMs);
      if (typeof timer.unref === 'function') timer.unref();
      pendingTimers.set(scope, { timer, seq: expectedSeq });
      return { action: 'deferred', waitMs, deferredAttempt: deferredAttempt + 1, entry };
    }

    if (cfg.enabled && isRecoverable && cid && msgId != null) {
      if (transient && !isStartupRecovery) {
        const existing = getPending({ conversationId: cid, threadId: tid });
        upsertEntry(buildEntry(turnInput, {
          status: 'exhausted_transient',
          deferredAttempt,
          startupReplayCount: existing && String(existing.messageId) === String(msgId)
            ? Number(existing.startupReplayCount || 0)
            : 0,
          receivedAt: existing && String(existing.messageId) === String(msgId)
            ? existing.receivedAt
            : Number(turnInput?.receivedAt || Date.now()),
          lastError: err?.message || err,
        }));
      } else {
        removeEntry({ conversationId: cid, threadId: tid, onlyIfMessageId: msgId });
      }
    }

    if (typeof onExhausted === 'function') {
      try { onExhausted({ err, transient, turnInput }); } catch { /* ignore */ }
    }
    return { action: transient ? 'exhausted_transient' : 'permanent_error', transient };
  }

  function scheduleStartupRecovery({ isPaused = null, getHistory = null, onReplay } = {}) {
    stopped = false;
    if (!cfg.enabled || !journalPath || cfg.maxStartupReplays <= 0 || typeof onReplay !== 'function') {
      return { scheduled: 0 };
    }
    const valid = readPendingTurnJournal(journalPath, { ttlMs: cfg.ttlMs });
    const replayable = valid.filter((e) => (
      (e.status === 'inflight' || e.status === 'retry_pending' || e.status === 'exhausted_transient') &&
      Number(e.startupReplayCount || 0) < cfg.maxStartupReplays
    ));
    if (fs.existsSync(journalPath) && replayable.length !== valid.length) {
      writePendingTurnJournal(journalPath, replayable, { maxEntries: cfg.maxEntries });
    }
    if (!replayable.length) return { scheduled: 0 };

    logger?.info?.(
      `[scroll:turn-recovery:${channelId}:${acctId}] found ${replayable.length} interrupted turn(s) in WAL; scheduling startup catch-up in ${cfg.startupDelayMs}ms`,
    );
    const timer = setTimeout(async () => {
      startupTimers.delete(timer);
      for (let idx = 0; idx < replayable.length; idx++) {
        if (stopped || (typeof isPaused === 'function' && isPaused())) break;
        const snapshot = replayable[idx];
        const cid = String(snapshot.conversationId || snapshot.chatId || '');
        const tid = snapshot.threadId ?? null;
        const scope = scopeKeyFor(cid, tid);
        try {
          // Guard 1: Re-read disk WAL — skip if completed or superseded
          const current = getPending({ conversationId: cid, threadId: tid });
          if (!current || String(current.messageId) !== String(snapshot.messageId)) continue;
          if (Number(current.startupReplayCount || 0) >= cfg.maxStartupReplays) {
            removeEntry({ conversationId: cid, threadId: tid, onlyIfMessageId: current.messageId });
            continue;
          }
          if ((Date.now() - Number(current.receivedAt || 0)) > cfg.ttlMs) {
            removeEntry({ conversationId: cid, threadId: tid, onlyIfMessageId: current.messageId });
            continue;
          }
          // Guard 2: Yield if a newer non-command DM raw message arrived (waiting in debouncer)
          if (!current.isGroup) {
            const newerDm = latestRawDmByScope.get(scope);
            if (newerDm && isNewerMessageId(newerDm.messageId, current.messageId, { candidateAtMs: newerDm.at, baselineAtMs: current.receivedAt })) {
              continue;
            }
          }
          // Guard 3: Yield if a live turn already ran for this scope since boot
          if ((latestTurnSeqByScope.get(scope) || 0) > 0) continue;
          // Guard 4: Skip if session history already has a non-held assistant reply after receivedAt
          if (hasAssistantReplyAfter(safeGetHistory(getHistory, cid), current.receivedAt)) {
            logger?.info?.(
              `[scroll:turn-recovery:${channelId}:${acctId}] skipped startup replay for ${current.roomTitle || cid} (msgId=${current.messageId}): already answered in history`,
            );
            removeEntry({ conversationId: cid, threadId: tid, onlyIfMessageId: current.messageId });
            continue;
          }

          // Guard 5 (Crash-Loop Proof): Persist incremented startupReplayCount BEFORE running onReplay!
          upsertEntry({
            ...current,
            status: 'replaying',
            startupReplayCount: Number(current.startupReplayCount || 0) + 1,
            updatedAt: Date.now(),
          });

          const expectedSeq = latestTurnSeqByScope.get(scope) || 0;
          const liveAttachments = filterExistingRecoveryAttachments(current.attachments);
          const baseCtx = stripRecoveryCues(current.contextBlocks);
          logger?.info?.(
            `[scroll:turn-recovery:${channelId}:${acctId}] replaying interrupted turn for ${current.roomTitle || cid} (msgId=${current.messageId}, age=${Math.round((Date.now() - current.receivedAt) / 1000)}s)`,
          );
          const outcome = await onReplay({
            entry: { ...current, attachments: liveAttachments, contextBlocks: baseCtx },
            recoveryCue: resolvedCues.startupCue,
            expectedSeq,
          });
          if (outcome !== 'deferred' && outcome !== 'aborted') {
            removeEntry({ conversationId: cid, threadId: tid, onlyIfMessageId: current.messageId });
          }
        } catch (replayErr) {
          logger?.warn?.(
            `[scroll:turn-recovery:${channelId}:${acctId}] startup replay failed (${snapshot.roomTitle || cid}, msgId=${snapshot.messageId}):`,
            replayErr?.message || replayErr,
          );
          removeEntry({ conversationId: cid, threadId: tid, onlyIfMessageId: snapshot.messageId });
        }
        if (idx + 1 < replayable.length && !stopped && cfg.startupStaggerMs > 0) {
          await sleep(cfg.startupStaggerMs);
        }
      }
    }, Math.max(0, cfg.startupDelayMs));
    if (typeof timer.unref === 'function') timer.unref();
    startupTimers.add(timer);
    return { scheduled: replayable.length };
  }

  function isCurrentSeq({ conversationId, threadId = null, expectedSeq }) {
    const scope = scopeKeyFor(conversationId, threadId);
    return !stopped && (latestTurnSeqByScope.get(scope) || 0) === Number(expectedSeq || 0);
  }

  function stop() {
    stopped = true;
    for (const entry of pendingTimers.values()) {
      if (entry?.timer) clearTimeout(entry.timer);
    }
    pendingTimers.clear();
    for (const t of startupTimers) clearTimeout(t);
    startupTimers.clear();
  }

  return {
    get enabled() { return cfg.enabled; },
    get config() { return cfg; },
    get channel() { return channelId; },
    get accountId() { return acctId; },
    get journalPath() { return journalPath; },
    cues: resolvedCues,
    scopeKeyFor,
    listPending,
    getPending,
    observeIncoming,
    cancelPendingTimer,
    beginTurn,
    runWithInlineRetry,
    completeTurn,
    handleTurnFailure,
    scheduleStartupRecovery,
    isCurrentSeq,
    stop,
  };
}
