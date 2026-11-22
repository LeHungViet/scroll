// Zero-dependency Telegram Bot API client (Node >= 20 built-in fetch).
// Supports custom apiBaseUrl for local mock-server E2E testing or reverse proxies.
import fs from 'node:fs';
import path from 'node:path';

export function createTelegramApi({
  token,
  apiBaseUrl = 'https://api.telegram.org',
  fetchImpl = globalThis.fetch,
  timeoutMs = 45_000,
} = {}) {
  if (!token) throw new Error('createTelegramApi: token is required');
  const base = String(apiBaseUrl).replace(/\/+$/, '');

  async function call(method, payload = null, { signal = null, timeoutMs: reqTimeout = timeoutMs } = {}) {
    const url = `${base}/bot${token}/${method}`;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, reqTimeout);
    if (typeof timer.unref === 'function') timer.unref();
    const onExternalAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const opts = {
        method: payload ? 'POST' : 'GET',
        signal: ctrl.signal,
      };
      if (payload) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(payload);
      }
      const res = await fetchImpl(url, opts);
      const raw = await res.text();
      let json;
      try { json = JSON.parse(raw); } catch { json = { ok: false, description: raw.slice(0, 300) }; }
      if (!res.ok || json.ok === false) {
        const err = new Error(json.description || `telegram_${method}_http_${res.status}`);
        err.status = res.status;
        err.error_code = json.error_code || res.status;
        err.description = json.description || '';
        if (json.parameters?.retry_after) err.retryAfterMs = Number(json.parameters.retry_after) * 1000;
        throw err;
      }
      return json.result;
    } catch (err) {
      if (timedOut && !signal?.aborted) {
        const te = new Error(`telegram_${method}_timeout_${reqTimeout}ms`);
        te.name = 'TimeoutError';
        te.code = 'TELEGRAM_TIMEOUT';
        te.retryable = true;
        throw te;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }

  function toInlineKeyboard(buttons) {
    if (!Array.isArray(buttons) || !buttons.length) return undefined;
    return { inline_keyboard: buttons };
  }

  return {
    call,
    getMe: (opts) => call('getMe', null, opts),
    getUpdates: ({ offset, timeout = 25, limit = 50, allowedUpdates = ['message', 'edited_message', 'callback_query'] } = {}, opts) =>
      call('getUpdates', {
        ...(offset != null ? { offset } : {}),
        timeout,
        limit,
        allowed_updates: allowedUpdates,
      }, { timeoutMs: Math.max(timeoutMs, (timeout + 15) * 1000), ...(opts || {}) }),
    sendMessage: ({ chatId, text, replyToMessageId = null, buttons = null, parseMode = null, disableNotification = false } = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text: String(text || ''),
        ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
        ...(buttons ? { reply_markup: toInlineKeyboard(buttons) } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(disableNotification ? { disable_notification: true } : {}),
      }),
    editMessageText: async ({ chatId, messageId, text, buttons = null, parseMode = null } = {}) => {
      try {
        return await call('editMessageText', {
          chat_id: chatId,
          message_id: Number(messageId),
          text: String(text || ''),
          ...(buttons ? { reply_markup: toInlineKeyboard(buttons) } : {}),
          ...(parseMode ? { parse_mode: parseMode } : {}),
        });
      } catch (err) {
        if (err?.error_code === 400 && String(err.description || '').includes('message is not modified')) {
          return { unchanged: true };
        }
        throw err;
      }
    },
    sendChatAction: ({ chatId, action = 'typing' } = {}) =>
      call('sendChatAction', { chat_id: chatId, action }).catch(() => null),
    setMessageReaction: ({ chatId, messageId, emoji, isBig = false } = {}) =>
      call('setMessageReaction', {
        chat_id: chatId,
        message_id: Number(messageId),
        reaction: emoji ? [{ type: 'emoji', emoji }] : [],
        is_big: Boolean(isBig),
      }).catch(() => null),
    answerCallbackQuery: ({ callbackQueryId, text = null, showAlert = false } = {}) =>
      call('answerCallbackQuery', {
        callback_query_id: String(callbackQueryId),
        ...(text ? { text: String(text).slice(0, 180) } : {}),
        show_alert: Boolean(showAlert),
      }).catch(() => null),
    getFile: (fileId) => call('getFile', { file_id: String(fileId) }),
    async downloadFile(filePath) {
      const url = `${base}/file/bot${token}/${String(filePath).replace(/^\/+/, '')}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`telegram_download_failed:${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    sendPhoto: ({ chatId, photo, caption = null, replyToMessageId = null } = {}) =>
      call('sendPhoto', {
        chat_id: chatId,
        photo,
        ...(caption ? { caption } : {}),
        ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
      }),
    sendDocument: ({ chatId, document, caption = null, replyToMessageId = null } = {}) =>
      call('sendDocument', {
        chat_id: chatId,
        document,
        ...(caption ? { caption } : {}),
        ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
      }),
    async sendLocalFile({ chatId, filePath, kind = 'document', caption = null, replyToMessageId = null, allowedRoots = null } = {}) {
      const abs = path.resolve(String(filePath || ''));
      if (!fs.existsSync(abs)) throw new Error(`local_file_not_found:${abs}`);
      const real = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
      // Fail-closed: if caller supplies an allowedRoots array (even empty `[]`!), require explicit containment!
      if (Array.isArray(allowedRoots)) {
        const permitted = allowedRoots.length > 0 && allowedRoots.some((root) => {
          if (!root) return false;
          const rr = fs.existsSync(root)
            ? (fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root))
            : path.resolve(root);
          return real === rr || real.startsWith(rr + path.sep);
        });
        if (!permitted) throw new Error(`local_file_outside_allowed_roots:${path.basename(abs)}`);
      }
      // Block symlink swap via O_NOFOLLOW + post-open dev/ino verification against realpath
      const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let buf;
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw new Error(`local_path_not_a_file:${path.basename(real)}`);
        const postReal = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
        const postSt = fs.statSync(postReal);
        if (postReal !== real || postSt.dev !== st.dev || postSt.ino !== st.ino) {
          throw new Error(`local_file_symlink_race:${path.basename(abs)}`);
        }
        buf = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const isPhoto = kind === 'photo' || /\.(?:png|jpe?g|webp|gif)$/i.test(real);
      const method = isPhoto ? 'sendPhoto' : 'sendDocument';
      const field = isPhoto ? 'photo' : 'document';
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append(field, new Blob([buf]), path.basename(real));
      if (caption) form.append('caption', String(caption).slice(0, 1024));
      if (replyToMessageId) {
        form.append('reply_parameters', JSON.stringify({ message_id: Number(replyToMessageId), allow_sending_without_reply: true }));
      }
      const res = await fetchImpl(`${base}/bot${token}/${method}`, { method: 'POST', body: form });
      const raw = await res.text();
      let json;
      try { json = JSON.parse(raw); } catch { json = { ok: false, description: raw.slice(0, 300) }; }
      if (!res.ok || json.ok === false) {
        throw new Error(json.description || `telegram_${method}_http_${res.status}`);
      }
      return json.result;
    },
    setMyCommands: (commands) => call('setMyCommands', { commands }),
  };
}
