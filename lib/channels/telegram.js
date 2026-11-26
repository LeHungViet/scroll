// SCROLL 2.11 -- Multi-Tenant Telegram Transport Adapter (`@agentpro/scroll/channels`).
// Zero-dep, pure ASCII source, Node >= 20.
//
// Shared Bot API client & update normalizer usable by both single-tenant `@agentpro/scroll-telegram`
// and multi-tenant SaaS platforms (e.g. dedicated @BotFather tokens & shared shard bots).
import { deliverBubbles, startTypingKeepalive } from './engine.js';

export function createTelegramClient({
  token,
  apiBaseUrl = 'https://api.telegram.org',
  fetchImpl = globalThis.fetch,
  timeoutMs = 35_000,
} = {}) {
  if (!token) throw new Error('ERR_TELEGRAM_TOKEN_REQUIRED');
  const base = String(apiBaseUrl).replace(/\/+$/, '');

  async function call(method, payload = null, { timeoutMs: reqTimeout = timeoutMs, signal = null } = {}) {
    const url = `${base}/bot${token}/${method}`;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, reqTimeout);
    if (typeof timer.unref === 'function') timer.unref();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const opts = { method: payload ? 'POST' : 'GET', signal: ctrl.signal };
      if (payload) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(payload);
      }
      const res = await fetchImpl(url, opts);
      const data = await res.json().catch(() => ({ ok: false, error_code: res.status, description: `HTTP ${res.status}` }));
      if (!res.ok || data.ok === false) {
        const codeNum = Number(data.error_code || res.status || 0);
        const err = new Error(data.description || `telegram_${method}_http_${res.status}`);
        err.status = res.status;
        err.telegramCode = codeNum;
        err.error_code = codeNum;
        err.isConflict = codeNum === 409;
        err.isInvalidToken = codeNum === 401 || codeNum === 404;
        if (data.parameters?.retry_after) {
          err.retryAfterMs = Number(data.parameters.retry_after) * 1000;
        }
        throw err;
      }
      return data.result;
    } catch (err) {
      if (timedOut && !signal?.aborted) {
        const te = new Error(`telegram_${method}_timeout_${reqTimeout}ms`);
        te.code = 'TELEGRAM_TIMEOUT';
        te.retryable = true;
        throw te;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function sendMediaBuffer(method, field, {
    chatId,
    data,
    filename = 'file.bin',
    mimeType = 'application/octet-stream',
    caption = '',
    replyToMessageId = null,
    threadId = null,
  } = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(field, new Blob([buf], { type: mimeType }), filename);
    if (caption) form.append('caption', String(caption).slice(0, 1024));
    if (threadId != null) form.append('message_thread_id', String(Number(threadId)));
    if (replyToMessageId) {
      form.append('reply_parameters', JSON.stringify({
        message_id: Number(replyToMessageId),
        allow_sending_without_reply: true,
      }));
    }
    const res = await fetchImpl(`${base}/bot${token}/${method}`, { method: 'POST', body: form });
    const parsed = await res.json().catch(() => ({ ok: false, error_code: res.status, description: `HTTP ${res.status}` }));
    if (!res.ok || parsed.ok === false) {
      const err = new Error(parsed.description || `telegram_${method}_http_${res.status}`);
      err.telegramCode = Number(parsed.error_code || res.status || 0);
      throw err;
    }
    return parsed.result;
  }

  return {
    call,
    async getMe(opts) {
      const me = await call('getMe', null, opts);
      return {
        ...me,
        botId: me?.id != null ? String(me.id) : null,
        botUsername: me?.username || null,
        botName: me?.first_name || me?.username || null,
        canReadGroupMessages: typeof me?.can_read_all_group_messages === 'boolean'
          ? me.can_read_all_group_messages
          : null,
      };
    },
    getUpdates: ({ offset = null, timeout = 25, limit = 50, allowedUpdates = ['message', 'edited_message', 'callback_query'] } = {}, opts) =>
      call('getUpdates', {
        ...(offset != null ? { offset } : {}),
        timeout,
        limit,
        allowed_updates: allowedUpdates,
      }, { timeoutMs: Math.max(timeoutMs, (timeout + 15) * 1000), ...(opts || {}) }),
    sendMessage: ({ chatId, text, replyToMessageId = null, threadId = null, replyMarkup = null, parseMode = null } = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text: String(text || ''),
        ...(threadId != null ? { message_thread_id: Number(threadId) } : {}),
        ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    sendChatAction: ({ chatId, action = 'typing', threadId = null } = {}) =>
      call('sendChatAction', {
        chat_id: chatId,
        action,
        ...(threadId != null ? { message_thread_id: Number(threadId) } : {}),
      }).catch(() => null),
    sendPhotoBuffer: (opts) => sendMediaBuffer('sendPhoto', 'photo', opts),
    sendDocumentBuffer: (opts) => sendMediaBuffer('sendDocument', 'document', opts),
    getFile: (fileId) => call('getFile', { file_id: String(fileId) }),
    async downloadFile(filePath, { maxBytes = 20 * 1024 * 1024 } = {}) {
      const url = `${base}/file/bot${token}/${String(filePath).replace(/^\/+/, '')}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`ERR_TELEGRAM_DOWNLOAD:${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`ERR_TELEGRAM_FILE_TOO_LARGE:${buf.length}`);
      return buf;
    },
    startTyping: ({ chatId, threadId = null, intervalMs = 4000, enabled = true } = {}) =>
      startTypingKeepalive(() => call('sendChatAction', {
        chat_id: chatId,
        action: 'typing',
        ...(threadId != null ? { message_thread_id: Number(threadId) } : {}),
      }), { intervalMs, enabled }),
    deliverReply: ({ chatId, text, bubbles = null, replyToMessageId = null, threadId = null, smartSplit = true, minDelayMs = 800, maxDelayMs = 1800 } = {}) =>
      deliverBubbles({
        text,
        bubbles,
        smartSplit,
        minDelayMs,
        maxDelayMs,
        sendTyping: () => call('sendChatAction', {
          chat_id: chatId,
          action: 'typing',
          ...(threadId != null ? { message_thread_id: Number(threadId) } : {}),
        }).catch(() => null),
        sendChunk: (chunk, { index }) => call('sendMessage', {
          chat_id: chatId,
          text: chunk,
          ...(threadId != null ? { message_thread_id: Number(threadId) } : {}),
          ...(index === 0 && replyToMessageId
            ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } }
            : {}),
        }),
      }),
  };
}

/**
 * Normalizes a raw Telegram Update (`message` or `edited_message`) into a clean channel envelope.
 */
export function normalizeTelegramUpdate(update, { botId = null, botUsername = null } = {}) {
  const isEdit = Boolean(!update?.message && update?.edited_message);
  const msg = update?.message || update?.edited_message || null;
  if (!msg || !msg.chat) return null;

  const chatType = String(msg.chat.type || 'private');
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const chatId = String(msg.chat.id);
  const chatTitle = String(
    msg.chat.title
    || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ')
    || msg.chat.username
    || '',
  ).trim();
  const senderId = msg.from?.id != null ? String(msg.from.id) : '';
  const senderName = String(
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
    || msg.from?.username
    || senderId
    || 'User',
  ).trim();
  const threadId = msg.message_thread_id != null ? Number(msg.message_thread_id) : null;
  const messageId = msg.message_id != null ? Number(msg.message_id) : null;
  const messageDateMs = msg.date ? Number(msg.date) * 1000 : null;
  const text = String(msg.text || msg.caption || '').trim();

  const replyToUserId = msg.reply_to_message?.from?.id != null ? String(msg.reply_to_message.from.id) : null;
  const isReplyToBot = Boolean(
    (botId && replyToUserId && String(botId) === replyToUserId)
    || (botUsername && msg.reply_to_message?.from?.username
      && String(msg.reply_to_message.from.username).toLowerCase() === String(botUsername).replace(/^@+/, '').toLowerCase()),
  );

  const cleanUser = String(botUsername || '').replace(/^@+/, '').toLowerCase();
  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  const isExplicitMention = Boolean(
    cleanUser && (
      text.toLowerCase().includes(`@${cleanUser}`)
      || entities.some((e) => e?.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${cleanUser}`)
    ),
  );

  return {
    updateId: update.update_id ?? null,
    isEdit,
    isGroup,
    chatType,
    chatId,
    chatTitle,
    threadId,
    messageId,
    messageDateMs,
    senderId,
    senderName,
    text,
    replyToUserId,
    replyToText: String(msg.reply_to_message?.text || msg.reply_to_message?.caption || '').trim(),
    isReplyToBot,
    isExplicitMention,
    raw: msg,
  };
}
