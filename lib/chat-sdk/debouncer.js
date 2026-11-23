// SCROLL 2.5 -- Channel-agnostic Burst Message Debouncer.
// Coalesces rapid multi-bubble messages per room/conversation key into a single LLM turn.
// Fast-paths slash commands (/admin, /clear, /start, etc.) immediately with 0 delay.

export function createMessageDebouncer({
  quietMs = 1500,
  maxWaitMs = 5000,
  onFlush,
  onError = null,
  immediatePrefix = '/',
  fastPathPattern = null,
} = {}) {
  if (typeof onFlush !== 'function') {
    throw new Error('createMessageDebouncer: onFlush callback is required');
  }
  const buckets = new Map();
  const fastPathRe = fastPathPattern instanceof RegExp
    ? fastPathPattern
    : (typeof fastPathPattern === 'string' && fastPathPattern ? new RegExp(fastPathPattern, 'iu') : null);
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
    // Preserve first non-null replyTo / threadId AND every distinct per-message replyTo across burst items
    // so multi-bubble replies to different bot messages (e.g. #327->#325 and #328->#326) never lose parent context!
    const firstReplyTo = items.find((m) => m.replyTo != null)?.replyTo ?? null;
    const firstThreadId = items.find((m) => m.threadId != null)?.threadId ?? null;
    const mergedReplyTos = [];
    const seenReplyKeys = new Set();
    const pushReplyRef = (ref, fallbackChildText = '', fallbackChildMsgId = null) => {
      if (!ref || typeof ref !== 'object') return;
      const parentId = ref.messageId ?? ref.replyTo?.messageId ?? null;
      const replyObj = ref.replyTo ? ref.replyTo : ref;
      const childText = String(ref.childText ?? fallbackChildText ?? '').trim().slice(0, 240);
      const childMessageId = ref.childMessageId ?? fallbackChildMsgId ?? null;
      const dedupeKey = `${parentId || ''}:${childMessageId || ''}:${replyObj.text || ''}`;
      if (seenReplyKeys.has(dedupeKey)) return;
      seenReplyKeys.add(dedupeKey);
      mergedReplyTos.push({
        ...replyObj,
        ...(childMessageId != null ? { childMessageId } : {}),
        ...(childText ? { childText } : {}),
      });
    };
    for (const m of items) {
      if (Array.isArray(m.replyTos) && m.replyTos.length) {
        for (const r of m.replyTos) pushReplyRef(r);
      } else if (m.replyTo != null) {
        pushReplyRef(m.replyTo, m.text, m.messageId);
      }
    }
    // Trigger priority across coalesced burst: hard > dm > soft_mention > active_latch > burst_followup
    const rank = { hard: 5, dm: 5, slash_command: 5, soft_mention: 3, active_latch: 2, burst_followup: 1 };
    let bestTriggerKind = last.triggerKind || null;
    let bestTriggerReason = last.triggerReason || null;
    let bestRank = rank[bestTriggerKind] || 0;
    for (const it of items) {
      const r = rank[it.triggerKind] || 0;
      if (r > bestRank) {
        bestRank = r;
        bestTriggerKind = it.triggerKind;
        bestTriggerReason = it.triggerReason || bestTriggerReason;
      }
    }
    const mergedMessageIds = items.flatMap((m) => {
      if (Array.isArray(m.messageIds) && m.messageIds.length) return m.messageIds;
      return m.messageId != null ? [m.messageId] : [];
    }).filter((v, idx, arr) => v != null && arr.indexOf(v) === idx);
    const merged = {
      ...last,
      ...(firstReplyTo != null ? { replyTo: firstReplyTo } : {}),
      ...(mergedReplyTos.length ? { replyTos: mergedReplyTos } : {}),
      ...(firstThreadId != null ? { threadId: firstThreadId } : {}),
      ...(bestTriggerKind ? { triggerKind: bestTriggerKind } : {}),
      ...(bestTriggerReason ? { triggerReason: bestTriggerReason } : {}),
      text: combinedText,
      attachments,
      burstCount: items.reduce((n, m) => n + Math.max(1, Number(m.burstCount || 1)), 0),
      messageIds: mergedMessageIds,
      burstItems: items.map((m) => ({
        messageId: m.messageId ?? null,
        text: String(m.text || '').trim(),
        senderId: m.sender?.id ?? null,
        hasAttachments: Array.isArray(m.attachments) && m.attachments.length > 0,
        ...(m.replyTo != null ? { replyTo: m.replyTo } : {}),
      })),
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

  function push(key, item, { immediate = false, quietMs: callQuietMs = null, maxWaitMs: callMaxWaitMs = null } = {}) {
    const text = String(item?.text || '').trim();
    const effQuietMs = callQuietMs != null && Number.isFinite(Number(callQuietMs)) ? Math.max(0, Number(callQuietMs)) : quietMs;
    const effMaxWaitMs = callMaxWaitMs != null && Number.isFinite(Number(callMaxWaitMs)) ? Math.max(0, Number(callMaxWaitMs)) : maxWaitMs;
    const isSlash = Boolean(immediatePrefix && text.startsWith(immediatePrefix));
    const isFastPath = Boolean(fastPathRe && text && !buckets.has(key) && fastPathRe.test(text));
    if (immediate || isSlash || isFastPath || effQuietMs <= 0) {
      const prev = buckets.has(key) ? flushKey(key) : Promise.resolve();
      const ids = Array.isArray(item?.messageIds) && item.messageIds.length
        ? item.messageIds
        : (item?.messageId ? [item.messageId] : []);
      return prev.then(() => Promise.resolve(onFlush({
        ...item,
        text,
        attachments: Array.isArray(item?.attachments) ? item.attachments : [],
        burstCount: Math.max(1, Number(item?.burstCount || 1)),
        messageIds: ids,
      })));
    }

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { items: [], quietTimer: null, maxTimer: null, firstAt: Date.now(), maxWaitMs: effMaxWaitMs };
      buckets.set(key, bucket);
      if (effMaxWaitMs > 0) {
        bucket.maxTimer = setTimeout(() => { flushKey(key).catch((err) => reportError(err, key)); }, effMaxWaitMs);
        if (typeof bucket.maxTimer.unref === 'function') bucket.maxTimer.unref();
      }
    } else if (callMaxWaitMs != null && effMaxWaitMs > bucket.maxWaitMs) {
      // Allow explicit WAIT_MORE extension up to new cap
      bucket.maxWaitMs = effMaxWaitMs;
      if (bucket.maxTimer) clearTimeout(bucket.maxTimer);
      const remaining = Math.max(250, effMaxWaitMs - (Date.now() - bucket.firstAt));
      bucket.maxTimer = setTimeout(() => { flushKey(key).catch((err) => reportError(err, key)); }, remaining);
      if (typeof bucket.maxTimer.unref === 'function') bucket.maxTimer.unref();
    }
    bucket.items.push(item);
    if (bucket.quietTimer) clearTimeout(bucket.quietTimer);
    bucket.quietTimer = setTimeout(() => { flushKey(key).catch((err) => reportError(err, key)); }, effQuietMs);
    if (typeof bucket.quietTimer.unref === 'function') bucket.quietTimer.unref();
    return Promise.resolve();
  }

  function peek(key) {
    const b = buckets.get(key);
    return b ? [...b.items] : [];
  }

  async function flushAll() {
    const keys = [...buckets.keys()];
    for (const k of keys) await flushKey(k);
  }

  function close() {
    for (const [, bucket] of buckets) clearBucketTimers(bucket);
    buckets.clear();
  }

  function hasPending(key) {
    const b = buckets.get(key);
    return Boolean(b && b.items.length > 0);
  }

  return {
    push,
    peek,
    hasPending,
    flushKey,
    clearKey,
    clearByPrefix,
    flushAll,
    close,
    get pendingCount() { return buckets.size; },
  };
}
