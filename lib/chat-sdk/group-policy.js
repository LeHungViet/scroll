// SCROLL 2.8 -- Channel-Agnostic Group Trigger & Debounce Policy.
// Single source of truth shared by `@agentpro/scroll`, `@agentpro/scroll/chat`,
// `@agentpro/scroll-telegram`, and any Managed Host (e.g., Bot Room).
//
// Reads cleanly from signed Agent Pack `manifest.channelPolicy` (zero hardcode in hosts).

export const GROUP_POLICIES = Object.freeze(['mention', 'all', 'off']);

export const DEFAULT_CHANNEL_POLICY = Object.freeze({
  groupPolicy: 'mention',
  allowGroups: true,
  mentionPatterns: Object.freeze([]),
  softAliasPatterns: Object.freeze([]),
  softAliasLabels: Object.freeze([]),
  debounceQuietMs: 3000,
  debounceMaxWaitMs: 12_000,
  debounceFastPathPattern: null,
});

function cleanPatternList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item instanceof RegExp) {
      out.push(item.source);
    } else if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    }
  }
  return out;
}

function cleanStringList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileRegexList(patterns) {
  const out = [];
  for (const raw of patterns || []) {
    if (raw instanceof RegExp) {
      out.push(raw);
      continue;
    }
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      out.push(new RegExp(raw, 'iu'));
    } catch {
      try {
        out.push(new RegExp(raw, 'i'));
      } catch {
        // Ignore malformed pattern rather than crashing the host loop.
      }
    }
  }
  return out;
}

export function normalizeChannelPolicy(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawPolicy = String(src.groupPolicy || DEFAULT_CHANNEL_POLICY.groupPolicy).trim().toLowerCase();
  const groupPolicy = GROUP_POLICIES.includes(rawPolicy) ? rawPolicy : 'mention';
  const allowGroups = src.allowGroups === false ? false : true;
  const quietNum = Number(src.debounceQuietMs);
  const maxWaitNum = Number(src.debounceMaxWaitMs);
  const debounceQuietMs = Number.isFinite(quietNum) && quietNum >= 0
    ? Math.min(60_000, Math.round(quietNum))
    : DEFAULT_CHANNEL_POLICY.debounceQuietMs;
  const debounceMaxWaitMs = Number.isFinite(maxWaitNum) && maxWaitNum >= 0
    ? Math.max(debounceQuietMs, Math.min(120_000, Math.round(maxWaitNum)))
    : Math.max(debounceQuietMs, DEFAULT_CHANNEL_POLICY.debounceMaxWaitMs);

  let debounceFastPathPattern = null;
  if (src.debounceFastPathPattern instanceof RegExp) {
    debounceFastPathPattern = src.debounceFastPathPattern.source;
  } else if (typeof src.debounceFastPathPattern === 'string' && src.debounceFastPathPattern.trim()) {
    debounceFastPathPattern = src.debounceFastPathPattern.trim();
  }

  return {
    groupPolicy,
    allowGroups,
    mentionPatterns: cleanPatternList(src.mentionPatterns),
    softAliasPatterns: cleanPatternList(src.softAliasPatterns),
    softAliasLabels: cleanStringList(src.softAliasLabels),
    debounceQuietMs,
    debounceMaxWaitMs,
    debounceFastPathPattern,
  };
}

export function compileGroupPolicy(raw = {}) {
  const norm = normalizeChannelPolicy(raw);
  const mentionRegexes = compileRegexList(norm.mentionPatterns);
  const softAliasRegexes = compileRegexList(norm.softAliasPatterns);
  let fastPathRegex = null;
  if (norm.debounceFastPathPattern) {
    const compiled = compileRegexList([norm.debounceFastPathPattern]);
    fastPathRegex = compiled[0] || null;
  }
  return Object.freeze({
    ...norm,
    mentionRegexes: Object.freeze(mentionRegexes),
    softAliasRegexes: Object.freeze(softAliasRegexes),
    fastPathRegex,
  });
}

export function stripBotMention(text, botUsername = '') {
  const raw = String(text ?? '');
  const uname = String(botUsername || '').replace(/^@+/, '').trim();
  if (!uname || !raw) return raw.trim();
  const rx = new RegExp(`(?:^|(?<=\\s))@${escapeRegExp(uname)}(?=$|[\\s,:;.!?])`, 'ig');
  const stripped = raw.replace(rx, '').replace(/\s+([,:;.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return stripped || raw.trim();
}

export function evaluateGroupTrigger({
  policy = DEFAULT_CHANNEL_POLICY,
  isGroup = false,
  text = '',
  botUsername = '',
  botUserId = '',
  replyToUserId = '',
  replyToUsername = '',
  replyToIsBot = false,
  hasPendingBurst = false,
} = {}) {
  if (!isGroup) {
    return { trigger: true, reason: 'dm', triggerKind: 'dm' };
  }

  const compiled = Array.isArray(policy?.mentionRegexes)
    ? policy
    : compileGroupPolicy(policy);

  const rawText = String(text || '');
  const trimmed = rawText.trim();
  const uname = String(botUsername || '').replace(/^@+/, '').trim().toLowerCase();

  if (compiled.allowGroups === false || compiled.groupPolicy === 'off') {
    return { trigger: false, reason: 'group_off', triggerKind: null };
  }

  // Slash commands: /cmd or /cmd@bot_username
  const slashMatch = /^\/([a-z0-9_]+)(?:@([A-Za-z0-9_]+))?\b/i.exec(trimmed);
  if (slashMatch) {
    const targetBot = slashMatch[2] ? slashMatch[2].toLowerCase() : '';
    if (!targetBot || (uname && targetBot === uname)) {
      return { trigger: true, reason: 'slash_command', triggerKind: 'slash_command' };
    }
    return { trigger: false, reason: 'other_bot_command', triggerKind: null };
  }

  if (compiled.groupPolicy === 'all') {
    return { trigger: true, reason: 'group_all', triggerKind: 'hard' };
  }

  // Reply directly to THIS bot's own message (never triggers on replies to other bots in the same group!)
  const hasThisBotId = Boolean(botUserId && replyToUserId && String(replyToUserId) === String(botUserId));
  const hasThisBotUsername = Boolean(
    !botUserId
    && replyToIsBot
    && uname
    && replyToUsername
    && String(replyToUsername).replace(/^@+/, '').toLowerCase() === uname,
  );
  if (hasThisBotId || hasThisBotUsername) {
    return { trigger: true, reason: 'reply_to_bot', triggerKind: 'hard' };
  }

  // Explicit @botUsername mention (whole handle token so @jen does not match @jenny)
  if (uname) {
    const atRe = new RegExp(`(?:^|[^a-z0-9_])@${escapeRegExp(uname)}(?=$|[^a-z0-9_])`, 'i');
    if (atRe.test(rawText)) {
      return { trigger: true, reason: 'at_mention', triggerKind: 'hard' };
    }
  }

  // Hard mention patterns from pack/config (e.g. \bjen\b, \ban\s*tam\b)
  for (const pat of compiled.mentionRegexes) {
    if (pat.test(rawText)) {
      return { trigger: true, reason: 'pattern_mention', triggerKind: 'hard' };
    }
  }

  // Soft alias patterns from pack/config (e.g. "em J", "AT oi")
  for (const pat of compiled.softAliasRegexes) {
    if (pat.test(rawText)) {
      return { trigger: true, reason: 'soft_alias_mention', triggerKind: 'soft_mention' };
    }
  }

  // Multi-bubble burst continuation from the same sender inside the active debounce window
  if (hasPendingBurst) {
    return { trigger: true, reason: 'burst_followup', triggerKind: 'burst_followup' };
  }

  return { trigger: false, reason: 'no_mention', triggerKind: null };
}
