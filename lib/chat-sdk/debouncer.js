// SCROLL 2.5 -- Channel-agnostic Burst Message Debouncer.
// Coalesces rapid multi-bubble messages per room/conversation key into a single LLM turn.
// Fast-paths slash commands (/admin, /clear, /start, etc.) immediately with 0 delay.

export function createMessageDebouncer({
  quietMs = 1500,
  maxWaitMs = 5000,
  onFlush,
  onError = null,
  immediatePrefix = '/',
} = {}) {
  if (typeof onFlush !== 'function') {
    throw new Error('createMessageDebouncer: onFlush callback is required');
  }
  const buckets = new Map();
  const reportError = (err, key) => {
    if (typeof onError === 'function') {
      try { onError(err, key); } catch { /* isolate */ }
    }
  };

  function clearBucketTimers(bucket) {
    if (bucket.quietTimer) {
      clearTimeout(bucket.quietTimer);
      bucket.quietTimer = null;
    }
    if (bucket.maxTimer) {
      clearTimeout(bucket.maxTimer);
      bucket.maxTimer = null;
    }
  }

  function flushKey(key) {
    const bucket = buckets.get(key);
    if (!bucket) return Promise.resolve();
    buckets.delete(key);
    clearBucketTimers(bucket);
    const items = bucket.items;
    if (!items.length) return Promise.resolve();
    const last = items[items.length - 1];
    const combinedText = items.map((m) => String(m.text || '').trim()).filter(Boolean).join('\n');
    const attachments = items.flatMap((m) => (Array.isArray(m.attachments) ? m.attachments : []));
    // Preserve first non-null replyTo / threadId across burst messages so follow-up pings don't erase quoted context
    const firstReplyTo = items.find((m) => m.replyTo != null)?.replyTo ?? null;
    const firstThreadId = items.find((m) => m.threadId != null)?.threadId ?? null;
    const merged = {
      ...last,
      ...(firstReplyTo != null ? { replyTo: firstReplyTo } : {}),
      ...(firstThreadId != null ? { threadId: firstThreadId } : {}),
      text: combinedText,
      attachments,
      burstCount: items.length,
      messageIds: items.map((m) => m.messageId).filter(Boolean),
    };
    return Promise.resolve().then(() => onFlush(merged));
  }

  function clearKey(key) {
    const bucket = buckets.get(key);
    if (!bucket) return 0;
    clearBucketTimers(bucket);
    buckets.delete(key);
    return bucket.items.length;
  }

  function clearByPrefix(prefix) {
    const p = String(prefix || '');
    if (!p) return 0;
    let dropped = 0;
    for (const [k, bucket] of [...buckets.entries()]) {
      if (k.startsWith(p)) {
        clearBucketTimers(bucket);
        buckets.delete(k);
        dropped += bucket.items.length;
      }
    }
    return dropped;
  }

  function push(key, item, { immediate = false } = {}) {
    const text = String(item?.text || '').trim();
    const isSlash = Boolean(immediatePrefix && text.startsWith(immediatePrefix));
    if (immediate || isSlash || quietMs <= 0) {
      const prev = buckets.has(key) ? flushKey(key) : Promise.resolve();
      return prev.then(() => Promise.resolve(onFlush({
        ...item,
        text,
        attachments: Array.isArray(item?.attachments) ? item.attachments : [],
        burstCount: 1,
        messageIds: item?.messageId ? [item.messageId] : [],
      })));
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { items: [], quietTimer: null, maxTimer: null, firstAt: Date.now() };
      buckets.set(key, bucket);
      if (maxWaitMs > 0) {
        bucket.maxTimer = setTimeout(() => { flushKey(key).catch((err) => reportError(err, key)); }, maxWaitMs);
        if (typeof bucket.maxTimer.unref === 'function') bucket.maxTimer.unref();
      }
    }
    bucket.items.push(item);
    if (bucket.quietTimer) clearTimeout(bucket.quietTimer);
    bucket.quietTimer = setTimeout(() => { flushKey(key).catch((err) => reportError(err, key)); }, quietMs);
    if (typeof bucket.quietTimer.unref === 'function') bucket.quietTimer.unref();
    return Promise.resolve();
  }

  async function flushAll() {
    const keys = [...buckets.keys()];
    for (const k of keys) await flushKey(k);
  }

  function close() {
    for (const [, bucket] of buckets) clearBucketTimers(bucket);
    buckets.clear();
  }

  return {
    push,
    flushKey,
    clearKey,
    clearByPrefix,
    flushAll,
    close,
    get pendingCount() { return buckets.size; },
  };
}
