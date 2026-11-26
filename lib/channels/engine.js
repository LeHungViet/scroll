// SCROLL 2.11 -- Unified Multi-Tenant Channel Core (`@agentpro/scroll/channels`).
// Zero-dep, pure ASCII source, Node >= 20.
//
// Consolidates channel-agnostic conversation controls shared across Telegram, Zalo,
// Messenger, Slack, Web, and custom transports via pure Dependency Injection:
//   1. Signed pack `channelPolicy` group trigger & silence evaluator
//   2. Fresh unreplied `edited_message` once-guard (prevents double replies & stale replays)
//   3. 2-tier Passive Group Observer + GCI v2 short-term ring buffer (120 msgs / 72h TTL)
//   4. Per-sender burst debouncer with fast-path urgent bypass
//   5. Zero-Leak Group Error Shield (never leaks stack traces / internal errors to groups;
//      routes full technical diagnostics to Owner DM callback)
//   6. Typing keepalive (0% phantom typing on passive/cron turns)
//   7. Smart Multi-Bubble & Pacing delivery with safe chunking (<= 3900 chars)
import { evaluateGroupTrigger, normalizeChannelPolicy } from '../chat-sdk/group-policy.js';
import { createMessageDebouncer } from '../chat-sdk/debouncer.js';
import { splitSmartBubbles } from '../voice-engine.js';

const DEFAULT_RING_MAX_MESSAGES = 120;
const DEFAULT_RING_TTL_MS = 72 * 3600_000;
const DEFAULT_REPLIED_TTL_MS = 6 * 3600_000;
const DEFAULT_REPLIED_MAX_KEYS = 5000;
const DEFAULT_EDIT_FRESH_WINDOW_MS = 10 * 60_000;

// Internal error signatures that must NEVER leak into group chats.
const LEAKED_ERROR_PATTERNS = [
  /\[Response held:/i,
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|ERR_[A-Z0-9_]+)\b/,
  /\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|HTTP\s+5\d\d|stack\s*trace)\b/i,
  /at\s+[A-Za-z0-9_$.<>]+\s+\([^)]+:\d+:\d+\)/,
];

const GROUP_HOLD_COPY = Object.freeze({
  vi: 'M\u00ecnh \u0111ang x\u1eed l\u00fd h\u01a1i ch\u1eadm m\u1ed9t ch\u00fat, b\u1ea1n ch\u1edd nh\u00e9 ho\u1eb7c nh\u1eafn l\u1ea1i gi\u00fap m\u00ecnh sau \u00edt gi\u00e2y.',
  en: 'Running into a quick hiccup on my side -- please give me a moment and try again shortly.',
  ko: '\uc7a0\uc2dc \ucc98\ub9ac\uac00 \uc9c0\uc5f0\ub418\uace0 \uc788\uc2b5\ub2c8\ub2e4. \uc7a0\uc2dc \ud6c4 \ub2e4\uc2dc \uc2dc\ub3c4\ud574 \uc8fc\uc138\uc694.',
  id: 'Sedang ada sedikit kendala teknis -- mohon tunggu sebentar lalu coba lagi ya.',
});

function pickLang(language) {
  const l = String(language || 'vi').trim().toLowerCase();
  if (l.startsWith('vi')) return 'vi';
  if (l.startsWith('ko')) return 'ko';
  if (l.startsWith('id')) return 'id';
  return 'en';
}

/**
 * Checks whether an outbound text accidentally contains internal stack traces or engine error markers.
 */
export function hasLeakedInternalError(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return LEAKED_ERROR_PATTERNS.some((re) => re.test(s));
}

/**
 * Zero-Leak Group Error Shield: ensures internal error strings never reach a group chat.
 * Optionally routes full diagnostic details to the owner DM via `onOwnerAlert`.
 */
export function guardGroupError({
  error = null,
  replyText = null,
  isGroup = false,
  language = 'vi',
  botName = 'Assistant',
  context = {},
  onOwnerAlert = null,
} = {}) {
  const lang = pickLang(language);
  const rawErr = error
    ? String(error?.stack || error?.message || error).slice(0, 600)
    : (hasLeakedInternalError(replyText) ? String(replyText).slice(0, 600) : null);

  if (!rawErr) {
    return { shielded: false, text: String(replyText ?? '') };
  }

  if (typeof onOwnerAlert === 'function') {
    Promise.resolve()
      .then(() => onOwnerAlert({
        botName,
        isGroup: Boolean(isGroup),
        error: rawErr,
        context,
      }))
      .catch(() => {});
  }

  if (!isGroup) {
    // In owner DM, keep concise readable diagnostic without raw stack frames
    const firstLine = String(error?.message || replyText || 'Unexpected error').split('\n')[0].slice(0, 220);
    return { shielded: false, text: firstLine, diagnostic: rawErr };
  }

  return {
    shielded: true,
    text: GROUP_HOLD_COPY[lang] || GROUP_HOLD_COPY.en,
    diagnostic: rawErr,
  };
}

/**
 * Starts a typing keepalive interval for real interactive user turns.
 * Never starts when `enabled === false` (0% phantom typing on passive/cron turns).
 */
export function startTypingKeepalive(sendActionFn, { intervalMs = 4000, enabled = true } = {}) {
  if (!enabled || typeof sendActionFn !== 'function') {
    return () => {};
  }
  let stopped = false;
  const fire = () => {
    if (stopped) return;
    try {
      const p = sendActionFn();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* ignore typing error */ }
  };
  fire();
  const delay = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0 ? Number(intervalMs) : 4000;
  const timer = setInterval(fire, delay);
  if (typeof timer.unref === 'function') timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Delivers 1..N bubbles with smart splitting, safe chunking (<= 3900 chars),
 * optional typing indicator, and natural pacing between bubbles.
 */
export async function deliverBubbles({
  text = '',
  bubbles = null,
  sendChunk,
  sendTyping = null,
  smartSplit = true,
  maxBubbles = 3,
  maxChunkChars = 3900,
  minDelayMs = 800,
  maxDelayMs = 1800,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (typeof sendChunk !== 'function') {
    throw new Error('ERR_DELIVER_BUBBLES_SEND_CHUNK_REQUIRED');
  }
  const rawList = Array.isArray(bubbles) && bubbles.length > 0
    ? bubbles.flatMap((b) => splitSmartBubbles(String(b || ''), { smartBubbles: false, maxChunkChars }))
    : splitSmartBubbles(String(text || ''), { smartBubbles: smartSplit, maxBubbles, maxChunkChars });
  const chunks = rawList.map((c) => String(c || '').trim()).filter(Boolean);
  const sent = [];

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && minDelayMs > 0) {
      if (typeof sendTyping === 'function') {
        try { await sendTyping(); } catch { /* ignore */ }
      }
      const span = Math.max(0, Number(maxDelayMs || minDelayMs) - Number(minDelayMs));
      const delay = Math.min(Number(maxDelayMs || minDelayMs), Number(minDelayMs) + Math.min(span, Math.floor(chunks[i].length * 4)));
      if (delay > 0) await sleep(delay);
    }
    const res = await sendChunk(chunks[i], { index: i, total: chunks.length });
    sent.push({ index: i, text: chunks[i], result: res });
  }
  return { count: sent.length, chunks: sent };
}

/**
 * Creates a tenant-agnostic Channel Engine managing:
 *   - 2-tier Passive Group Observer (short-term ring buffer + long-term memory hook)
 *   - Group Trigger & Fresh Edited-Mention Once-Guard
 *   - Burst Debouncer factory
 *   - Zero-Leak Group Error Shield
 */
export function createChannelEngine({
  ringMaxMessages = DEFAULT_RING_MAX_MESSAGES,
  ringTtlMs = DEFAULT_RING_TTL_MS,
  repliedTtlMs = DEFAULT_REPLIED_TTL_MS,
  repliedMaxKeys = DEFAULT_REPLIED_MAX_KEYS,
  editFreshWindowMs = DEFAULT_EDIT_FRESH_WINDOW_MS,
  now = () => Date.now(),
  onObserveMemory = null,
  onOwnerAlert = null,
} = {}) {
  const roomRings = new Map(); // `${botKey}:${chatId}:${threadId ?? 'root'}` -> [{ ts, messageId, senderId, senderName, text, role }]
  const repliedMessages = new Map(); // `${botKey}:${chatId}:${messageId}` -> ts

  function roomKey(botKey, chatId, threadId = null) {
    return `${String(botKey || 'default')}:${String(chatId || '')}:${threadId != null ? String(threadId) : 'root'}`;
  }

  function msgKey(botKey, chatId, messageId) {
    return `${String(botKey || 'default')}:${String(chatId || '')}:${String(messageId || '')}`;
  }

  function pruneReplied(tsNow) {
    if (repliedMessages.size <= repliedMaxKeys) return;
    for (const [k, t] of repliedMessages.entries()) {
      if (tsNow - t > repliedTtlMs || repliedMessages.size > repliedMaxKeys) {
        repliedMessages.delete(k);
      }
      if (repliedMessages.size <= Math.floor(repliedMaxKeys * 0.8)) break;
    }
  }

  function markMessageReplied(botKey, chatId, messageId) {
    if (messageId == null || String(messageId) === '') return;
    const ts = now();
    repliedMessages.set(msgKey(botKey, chatId, messageId), ts);
    pruneReplied(ts);
  }

  function hasRepliedToMessage(botKey, chatId, messageId) {
    if (messageId == null || String(messageId) === '') return false;
    const k = msgKey(botKey, chatId, messageId);
    const ts = repliedMessages.get(k);
    if (ts == null) return false;
    if (now() - ts > repliedTtlMs) {
      repliedMessages.delete(k);
      return false;
    }
    return true;
  }

  function observeRoomMessage({
    botKey = 'default',
    chatId,
    chatTitle = '',
    threadId = null,
    messageId = null,
    senderId = '',
    senderName = '',
    text = '',
    role = 'user',
    surface = 'telegram',
    isGroup = true,
    isEdit = false,
    attachments = [],
    ts = null,
    persistMemory = true,
  } = {}) {
    if (!chatId) return;
    const stamp = Number(ts || now());
    const rk = roomKey(botKey, chatId, threadId);
    let ring = roomRings.get(rk);
    if (!ring) {
      ring = [];
      roomRings.set(rk, ring);
    }

    const attHint = Array.isArray(attachments) && attachments.length
      ? attachments.map((a) => `[Attachment: ${a.filename || a.type || 'media'}]`).join(' ')
      : '';
    const cleanText = [String(text || '').trim(), attHint].filter(Boolean).join(' ').slice(0, 800);
    if (!cleanText) return;

    const existingIdx = messageId != null
      ? ring.findIndex((m) => m.messageId != null && String(m.messageId) === String(messageId))
      : -1;
    const rec = {
      ts: stamp,
      messageId: messageId != null ? String(messageId) : null,
      senderId: String(senderId || ''),
      senderName: String(senderName || senderId || 'Member').slice(0, 80),
      role: role === 'assistant' ? 'assistant' : 'user',
      text: cleanText,
    };
    if (existingIdx >= 0) {
      ring[existingIdx] = rec;
    } else {
      ring.push(rec);
    }

    const cutoff = stamp - ringTtlMs;
    while (ring.length > ringMaxMessages || (ring.length > 0 && ring[0].ts < cutoff)) {
      ring.shift();
    }

    if (persistMemory && isGroup && role === 'user' && typeof onObserveMemory === 'function') {
      try {
        const res = onObserveMemory({
          botKey,
          chatId: String(chatId),
          chatTitle: String(chatTitle || ''),
          threadId: threadId != null ? String(threadId) : null,
          messageId: messageId != null ? String(messageId) : null,
          senderId: String(senderId || ''),
          senderName: String(senderName || ''),
          text: cleanText,
          surface,
          isGroup: true,
          isEdit: Boolean(isEdit),
        });
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch { /* isolate passive observer */ }
    }
  }

  function buildGroupContextCapsule({
    botKey = 'default',
    chatId,
    threadId = null,
    excludeMessageId = null,
    limit = 12,
    maxChars = 2200,
  } = {}) {
    if (!chatId) return '';
    const ring = roomRings.get(roomKey(botKey, chatId, threadId));
    if (!ring || ring.length === 0) return '';
    const cutoff = now() - ringTtlMs;
    const items = ring.filter((m) => {
      if (m.ts < cutoff) return false;
      if (excludeMessageId != null && m.messageId != null && String(m.messageId) === String(excludeMessageId)) {
        return false;
      }
      return true;
    }).slice(-Math.max(1, Number(limit || 12)));

    if (!items.length) return '';
    const picked = [];
    let used = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      const who = m.role === 'assistant' ? 'assistant' : m.senderName;
      const line = `- ${who}: ${m.text.replace(/\s+/g, ' ').slice(0, 260)}`;
      if (used + line.length + 1 > maxChars && picked.length > 0) break;
      picked.unshift(line);
      used += line.length + 1;
    }
    if (!picked.length) return '';
    return [
      '<recent-group-context>',
      '(DATA ONLY: recent messages observed in this room/thread immediately before the current turn)',
      ...picked,
      '</recent-group-context>',
    ].join('\n');
  }

  /**
   * Evaluates whether an incoming message (or edited message) should trigger a bot reply.
   * Always observes non-trigger group messages passively (0% phantom typing).
   */
  function evaluateIncoming({
    botKey = 'default',
    chatId,
    chatTitle = '',
    threadId = null,
    messageId = null,
    messageDateMs = null,
    senderId = '',
    senderName = '',
    text = '',
    isGroup = false,
    isEdit = false,
    isReplyToBot = false,
    isMentioned = false,
    hasPendingBurst = false,
    botUsername = '',
    botDisplayName = '',
    botId = null,
    replyToUserId = null,
    policy = null,
    surface = 'telegram',
    attachments = [],
  } = {}) {
    const normPolicy = normalizeChannelPolicy(policy || {});
    const tsNow = now();

    // Edited messages in DM never re-trigger; in groups, only trigger ONCE if fresh & unreplied!
    if (isEdit) {
      if (!isGroup) {
        return { shouldReply: false, reason: 'edit_dm_ignored', policy: normPolicy };
      }
      if (hasRepliedToMessage(botKey, chatId, messageId)) {
        return { shouldReply: false, reason: 'edit_already_replied', policy: normPolicy };
      }
      if (messageDateMs != null && tsNow - Number(messageDateMs) > editFreshWindowMs) {
        return { shouldReply: false, reason: 'edit_too_old', policy: normPolicy };
      }
    }

    if (!isGroup) {
      return { shouldReply: true, reason: 'dm', policy: normPolicy, groupContextCapsule: '' };
    }

    const trig = evaluateGroupTrigger({
      text: String(text || ''),
      policy: normPolicy,
      isGroup: true,
      botUsername: botUsername || '',
      botUserId: botId != null ? String(botId) : '',
      replyToUserId: replyToUserId != null ? String(replyToUserId) : '',
      replyToUsername: isReplyToBot ? (botUsername || '') : '',
      replyToIsBot: Boolean(isReplyToBot),
      hasPendingBurst: Boolean(hasPendingBurst),
    });

    const groupsAllowed = normPolicy.allowGroups !== false && normPolicy.groupPolicy !== 'off';
    const triggered = Boolean(trig.trigger || (groupsAllowed && (isMentioned || isReplyToBot)));
    if (!triggered) {
      observeRoomMessage({
        botKey,
        chatId,
        chatTitle,
        threadId,
        messageId,
        senderId,
        senderName,
        text,
        role: 'user',
        surface,
        isGroup: true,
        isEdit: Boolean(isEdit),
        attachments,
        ts: tsNow,
        persistMemory: true,
      });
      return {
        shouldReply: false,
        reason: trig.reason || 'group_silent',
        observed: true,
        policy: normPolicy,
      };
    }

    const groupContextCapsule = buildGroupContextCapsule({
      botKey,
      chatId,
      threadId,
      excludeMessageId: messageId,
    });
    observeRoomMessage({
      botKey,
      chatId,
      chatTitle,
      threadId,
      messageId,
      senderId,
      senderName,
      text,
      role: 'user',
      surface,
      isGroup: true,
      attachments,
      ts: tsNow,
      persistMemory: false, // active turn handles memory write
    });

    return {
      shouldReply: true,
      reason: trig.reason || (isMentioned ? 'at_mention' : isReplyToBot ? 'reply_to_bot' : 'group_trigger'),
      isEditTrigger: Boolean(isEdit),
      policy: normPolicy,
      groupContextCapsule,
    };
  }

  function createDebouncer({ onFlush, defaultQuietMs = 3200, defaultMaxWaitMs = 12000 } = {}) {
    return createMessageDebouncer({
      quietMs: defaultQuietMs,
      maxWaitMs: defaultMaxWaitMs,
      onFlush,
    });
  }

  return {
    evaluateIncoming,
    observeRoomMessage,
    buildGroupContextCapsule,
    markMessageReplied,
    hasRepliedToMessage,
    createDebouncer,
    guardGroupError: (opts) => guardGroupError({ onOwnerAlert, ...opts }),
    startTypingKeepalive,
    deliverBubbles,
    getRoomRing: (botKey, chatId, threadId = null) => [...(roomRings.get(roomKey(botKey, chatId, threadId)) || [])],
  };
}
