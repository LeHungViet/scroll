// SCROLL 2.11 -- Canonical Host Introspection (`scroll-introspection/v2`),
// 4-Tier Public-Neutral Tool Catalog (`scroll-tool-catalog/v2`), Single-Source
// Personality Schema, Channel Trigger Describer, & Real Parity Gate (`verifyIntrospectionParity`).
// Zero-dep, pure ASCII source (public-repo-gate compliant), Node >= 20.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeChannelPolicy, GROUP_POLICIES } from './chat-sdk/group-policy.js';
import { resolveEconomyConfig } from './turn-budget.js';

function readJsonSafe(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// -- 1. Canonical Personality Schema & Presets (Single Source of Truth) -------
// Vietnamese labels use pure ASCII \uXXXX escapes so public-repo-gate stays 0-leak.
export const PERSONALITY_TRAITS = Object.freeze([
  Object.freeze({
    key: 'assertiveness',
    displayKey: 'assertiveness',
    polarity: 'positive',
    min: 1,
    max: 5,
    labels: Object.freeze({ vi: 'Ch\u00ednh ki\u1ebfn', en: 'Assertiveness', ko: '\uc8fc\uc7a5 \uac15\ub3c4', id: 'Ketegasan' }),
    descriptions: Object.freeze({
      vi: 'M\u1ee9c \u0111\u1ed9 Bot m\u1ea1nh d\u1ea1n g\u00f3p \u00fd ho\u1eb7c ph\u1ea3n bi\u1ec7n khi th\u1ea5y ph\u01b0\u01a1ng \u00e1n ch\u01b0a t\u1ed1i \u01b0u.',
      en: 'How directly the agent shares opinions or pushes back on suboptimal plans.',
      ko: '\ub354 \ub098\uc740 \ub300\uc548\uc774 \uc788\uc744 \ub54c \uc5d0\uc774\uc804\ud2b8\uac00 \uc9c1\uc811 \uc758\uacac\uc744 \uc81c\uc2dc\ud558\ub294 \uc815\ub3c4.',
      id: 'Seberapa langsung agen memberi masukan atau koreksi saat rencana kurang optimal.',
    }),
    levels: Object.freeze({
      vi: Object.freeze(['L\u1eafng nghe nh\u1eb9', 'G\u00f3p \u00fd m\u1ec1m', 'N\u00f3i r\u00f5 \u00fd', 'G\u00f3p \u00fd th\u1eb3ng', 'Ch\u1ed1t d\u1ee9t kho\u00e1t']),
      en: Object.freeze(['Soft listener', 'Gentle nudge', 'Clear view', 'Direct advice', 'Decisive lead']),
    }),
  }),
  Object.freeze({
    key: 'reserve',
    displayKey: 'openness',
    polarity: 'inverted',
    min: 1,
    max: 5,
    labels: Object.freeze({ vi: 'C\u1edfi m\u1edf', en: 'Openness', ko: '\uce5c\uadfc\ud568', id: 'Keterbukaan' }),
    descriptions: Object.freeze({
      vi: 'M\u1ee9c \u0111\u1ed9 tho\u1ea3i m\u00e1i, g\u1ea7n g\u0169i khi tr\u00f2 chuy\u1ec7n. C\u00e0ng cao Bot c\u00e0ng c\u1edfi m\u1edf, t\u1ef1 nhi\u00ean; c\u00e0ng th\u1ea5p Bot c\u00e0ng \u0111i\u1ec1m t\u0129nh, gi\u1eef kho\u1ea3ng c\u00e1ch.',
      en: 'How relaxed and open the tone feels. Higher is warmer and more open; lower is more composed and reserved.',
      ko: '\ub300\ud654 \ubd84\uc704\uae30\uc758 \ud3b8\uc548\ud568\uacfc \uac1c\ubc29\uc131. \ub192\uc744\uc218\ub85d \uce5c\uadfc\ud558\uace0 \ub0ae\uc744\uc218\ub85d \ucc28\ubd84\ud569\ub2c8\ub2e4.',
      id: 'Seberapa santai dan akrab gaya bicara agen. Semakin tinggi semakin terbuka.',
    }),
    levels: Object.freeze({
      vi: Object.freeze(['\u0110i\u1ec1m t\u0129nh, gi\u1eef k\u1ebd', 'Ch\u1ecdn l\u1ecdc', 'V\u1eeba \u0111\u1ee7', 'Th\u00e2n t\u1ef1 nhi\u00ean', 'R\u1ea5t c\u1edfi m\u1edf']),
      en: Object.freeze(['Composed', 'Selective', 'Balanced', 'Friendly', 'Very open']),
    }),
  }),
  Object.freeze({
    key: 'wit',
    displayKey: 'wit',
    polarity: 'positive',
    min: 1,
    max: 5,
    labels: Object.freeze({ vi: 'D\u00ed d\u1ecfm', en: 'Wit', ko: '\uc704\ud2b8', id: 'Humoris' }),
    descriptions: Object.freeze({
      vi: 'M\u1ee9c \u0111\u1ed9 pha tr\u00f2 nh\u1eb9 nh\u00e0ng v\u00e0 h\u00f3m h\u1ec9nh trong tr\u00f2 chuy\u1ec7n h\u00e0ng ng\u00e0y.',
      en: 'How frequently the agent uses light humor or clever phrasing.',
      ko: '\uc77c\uc0c1 \ub300\ud654\uc5d0\uc11c \uac00\ubcbc\uc6b4 \uc720\uba38\uc640 \uc7ac\uce58\ub97c \uc0ac\uc6a9\ud558\ub294 \uc815\ub3c4.',
      id: 'Seberapa sering agen menyelipkan humor ringan yang natural.',
    }),
    levels: Object.freeze({
      vi: Object.freeze(['Nghi\u00eam t\u00fac', 'Vui nh\u1eb9', 'C\u00f3 duy\u00ean', 'Ch\u1ee7 \u0111\u1ed9ng vui', 'H\u00f3m h\u1ec9nh']),
      en: Object.freeze(['Serious', 'Light smile', 'Charming', 'Playful', 'Sharp wit']),
    }),
  }),
  Object.freeze({
    key: 'warmth',
    displayKey: 'warmth',
    polarity: 'positive',
    min: 1,
    max: 5,
    labels: Object.freeze({ vi: '\u1ea4m \u00e1p', en: 'Warmth', ko: '\ub530\ub73b\ud568', id: 'Kehangatan' }),
    descriptions: Object.freeze({
      vi: 'M\u1ee9c \u0111\u1ed9 \u00e2n c\u1ea7n, quan t\u00e2m v\u00e0 \u0111\u1ed3ng h\u00e0nh c\u1ea3m x\u00fac v\u1edbi b\u1ea1n.',
      en: 'How caring, empathetic, and encouraging the agent sounds.',
      ko: '\uc0ac\uc6a9\uc790\uc5d0\uac8c \uacf5\uac10\ud558\uace0 \ubc30\ub824\ud558\ub294 \uc815\ub3c4.',
      id: 'Seberapa peduli dan empatik nada bicara agen.',
    }),
    levels: Object.freeze({
      vi: Object.freeze(['L\u1ecbch s\u1ef1 g\u1ecdn', 'Chu \u0111\u00e1o', 'Quan t\u00e2m', 'Ch\u00e2n th\u00e0nh', '\u0110\u1ed3ng h\u00e0nh s\u00e2u']),
      en: Object.freeze(['Polite brief', 'Attentive', 'Caring', 'Warm & close', 'Deep empathy']),
    }),
  }),
]);

export const PERSONALITY_PRESETS = Object.freeze({
  'nhe-nhang': Object.freeze({
    id: 'nhe-nhang',
    labels: Object.freeze({ vi: 'Nh\u1eb9 nh\u00e0ng', en: 'Gentle', ko: '\ubd80\ub4dc\ub7ec\uc6c0', id: 'Ramah' }),
    traits: Object.freeze({ assertiveness: 2, reserve: 2, wit: 2, warmth: 4 }),
    initiative: 1,
    adaptiveLevel: 2,
  }),
  'ca-tinh': Object.freeze({
    id: 'ca-tinh',
    labels: Object.freeze({ vi: 'C\u00e1 t\u00ednh', en: 'Expressive', ko: '\uac1c\uc131 \uc788\uc74c', id: 'Ekspresif' }),
    traits: Object.freeze({ assertiveness: 4, reserve: 2, wit: 4, warmth: 4 }),
    initiative: 2,
    adaptiveLevel: 2,
  }),
  'kho-chieu-co-duyen': Object.freeze({
    id: 'kho-chieu-co-duyen',
    labels: Object.freeze({ vi: 'C\u00f3 duy\u00ean', en: 'Witty Charm', ko: '\uc7ac\uce58 \uc788\uc74c', id: 'Menarik' }),
    traits: Object.freeze({ assertiveness: 4, reserve: 3, wit: 4, warmth: 3 }),
    initiative: 2,
    adaptiveLevel: 2,
  }),
  'thang-than-cong-viec': Object.freeze({
    id: 'thang-than-cong-viec',
    labels: Object.freeze({ vi: 'Th\u1eb3ng th\u1eafn', en: 'Direct Pro', ko: '\uc9c1\uc124\uc801', id: 'Tegas Pro' }),
    traits: Object.freeze({ assertiveness: 5, reserve: 4, wit: 1, warmth: 2 }),
    initiative: 1,
    adaptiveLevel: 2,
  }),
});

export const PERSONALITY_SCHEMA = Object.freeze({
  schema: 'scroll-personality/v1',
  traits: PERSONALITY_TRAITS,
  initiative: Object.freeze({
    min: 0,
    max: 3,
    labels: Object.freeze({ vi: '\u0110\u1ed9 ch\u1ee7 \u0111\u1ed9ng', en: 'Initiative', ko: '\uc8fc\ub3c4\uc131', id: 'Inisiatif' }),
    levels: Object.freeze({
      vi: Object.freeze(['Ch\u1ec9 \u0111\u00e1p', 'B\u1eaft nh\u1ecbp', 'B\u1eaft chuy\u1ec7n', 'R\u00f4m r\u1ea3']),
      en: Object.freeze(['Reply only', 'Join flow', 'Follow up', 'Proactive']),
    }),
  }),
  adaptiveLevel: Object.freeze({
    min: 0,
    max: 3,
    labels: Object.freeze({ vi: '\u0110\u1ed9 nh\u1ea1y c\u1ea3m x\u00fac', en: 'Emotion Sensitivity', ko: '\uac10\uc815 \ubbfc\uac10\ub3c4', id: 'Kepekaan Emosi' }),
    levels: Object.freeze({
      vi: Object.freeze(['\u1ed4n \u0111\u1ecbnh', 'Nh\u1eb9', 'Theo m\u1ea1ch', 'Nh\u1ea1y s\u1edbm']),
      en: Object.freeze(['Steady', 'Light', 'Context-aware', 'High empathy']),
    }),
  }),
  presets: PERSONALITY_PRESETS,
});

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function describePersonality(weights = null) {
  const presetId = (weights && typeof weights.preset === 'string' && PERSONALITY_PRESETS[weights.preset])
    ? weights.preset
    : 'ca-tinh';
  const basePreset = PERSONALITY_PRESETS[presetId];
  const rawTraits = (weights && typeof weights.traits === 'object' && weights.traits) ? weights.traits : {};
  const traits = {};
  const displayTraits = {};
  for (const spec of PERSONALITY_TRAITS) {
    const raw = clampInt(rawTraits[spec.key], spec.min, spec.max, basePreset.traits[spec.key]);
    traits[spec.key] = raw;
    displayTraits[spec.displayKey] = spec.polarity === 'inverted'
      ? (spec.max + spec.min - raw)
      : raw;
  }
  return {
    schema: PERSONALITY_SCHEMA.schema,
    preset: presetId,
    traits,
    displayTraits,
    initiative: clampInt(weights?.initiative, 0, 3, basePreset.initiative),
    adaptiveLevel: clampInt(weights?.adaptiveLevel, 0, 3, basePreset.adaptiveLevel),
    voiceMode: typeof weights?.voiceMode === 'string' ? weights.voiceMode : 'auto',
    humanError: Boolean(weights?.humanError),
    schemaDef: PERSONALITY_SCHEMA,
  };
}

// -- 2. Canonical Channel Trigger Describer -----------------------------------
export function extractPolicyTriggerLabels(channelPolicy = null) {
  const norm = normalizeChannelPolicy(channelPolicy || {});
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s.length <= 2 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1));
  };
  for (const pat of norm.mentionPatterns) {
    const cleaned = String(pat || '')
      .replace(/\\b/g, '')
      .replace(/\\s[+*?]?/g, ' ')
      .replace(/\[([^\]]+)\]/g, (_, cls) => cls[0] || '')
      .replace(/[\\^$?*+()|{}[\]]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && cleaned.length <= 32) push(cleaned);
  }
  for (const lbl of norm.softAliasLabels) {
    push(lbl);
  }
  return out.slice(0, 12);
}

export function describeChannelPolicy(packPolicy = null, {
  groupPolicyOverride = null,
  botUsername = null,
  passiveObserver = true,
} = {}) {
  const norm = normalizeChannelPolicy(packPolicy || {});
  const hasValidOverride = typeof groupPolicyOverride === 'string' && GROUP_POLICIES.includes(groupPolicyOverride);
  const effectiveGroupPolicy = hasValidOverride ? groupPolicyOverride : norm.groupPolicy;
  const source = hasValidOverride
    ? 'override'
    : (packPolicy && typeof packPolicy.groupPolicy === 'string' ? 'pack' : 'default');
  return {
    groupPolicy: effectiveGroupPolicy,
    source,
    allowGroups: norm.allowGroups !== false,
    debounceQuietMs: norm.debounceQuietMs,
    debounceMaxWaitMs: norm.debounceMaxWaitMs,
    mentionLabels: extractPolicyTriggerLabels(norm),
    mentionPatternCount: norm.mentionPatterns.length,
    softAliasCount: norm.softAliasPatterns.length,
    respondsOnReply: true,
    passiveObserver: Boolean(passiveObserver),
    botUsername: botUsername ? String(botUsername).replace(/^@+/, '') : null,
  };
}

// -- 3. Public-Neutral 4-Tier Canonical Tool Catalog (`scroll-tool-catalog/v2`)
// ZERO private agent names, ZERO SaaS product names, ZERO non-ASCII prose in OSS core!
// Hosts pass `hostGroupDefinitions` (with localized labels/descriptions) and Companions
// self-declare `{ group, groupName, groupSummary, scope, risk }` on every tool descriptor.
export const CORE_TOOL_GROUPS = Object.freeze([
  Object.freeze({
    id: 'scroll-core',
    name: 'SCROLL Core',
    techName: 'SCROLL',
    tier: 'core',
    priority: 1,
    kind: 'runtime',
    scope: 'owner_dm',
    label: 'Unified cross-channel memory, layered knowledge retrieval, skills, pending tickets, and scheduled automations',
    match: (n) => n === 'automations' || n.startsWith('memory_') || n.startsWith('knowledge_') || n.startsWith('skill_') || n.startsWith('ticket_'),
  }),
  Object.freeze({
    id: 'local-knowledge',
    name: 'Local Knowledge Folders',
    techName: 'local-knowledge',
    tier: 'external',
    priority: 15,
    kind: 'bridge',
    scope: 'owner_dm',
    requiresCompanion: true,
    label: 'Read-only search and retrieval over mounted local document folders',
    match: (n) => n.startsWith('local_kb_'),
  }),
  Object.freeze({
    id: 'google-workspace',
    name: 'Google Workspace',
    techName: 'google-workspace',
    tier: 'external',
    priority: 10,
    kind: 'bridge',
    scope: 'owner_dm',
    label: 'Read and manage Google Calendar, Mail, and Drive workspace items',
    match: (n) => n.startsWith('calendar_') || n.startsWith('gmail_') || n.startsWith('gdrive_') || n.startsWith('gws_') || n.startsWith('google_'),
  }),
]);

// Backwards-compatible alias (clean, vendor-neutral)
export const ECOSYSTEM_TOOL_GROUPS = CORE_TOOL_GROUPS;

function compileGroupMatchers(extraGroups = []) {
  const byId = new Map();
  const list = [];
  const addGroup = (raw) => {
    if (!raw || !raw.id) return;
    const id = String(raw.id).trim();
    const matchFn = typeof raw.match === 'function'
      ? raw.match
      : (Array.isArray(raw.prefixes) && raw.prefixes.length
          ? (n) => raw.prefixes.some((p) => n === p || n.startsWith(p))
          : (Array.isArray(raw.tools) && raw.tools.length
              ? (n) => raw.tools.includes(n)
              : () => false));
    const entry = {
      id,
      name: String(raw.name || id),
      techName: String(raw.techName || id),
      tier: ['core', 'host', 'pack', 'external', 'botroom', 'integration'].includes(raw.tier) ? raw.tier : 'external',
      priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 50,
      kind: String(raw.kind || 'bridge'),
      scope: String(raw.scope || 'owner_dm'),
      risk: String(raw.risk || 'reversible_write'),
      label: String(raw.label || raw.summary || id),
      requiresCompanion: Boolean(raw.requiresCompanion),
      defaultVisible: Boolean(raw.defaultVisible),
      match: matchFn,
    };
    byId.set(id, entry);
    list.push(entry);
  };

  for (const g of CORE_TOOL_GROUPS) addGroup(g);
  for (const g of Array.isArray(extraGroups) ? extraGroups : []) addGroup(g);
  return { byId, list };
}

/**
 * Classifies a tool descriptor using declarative metadata FIRST (`tool.group`, `tool.tier`,
 * `tool.groupName`, `tool.groupSummary`), then host/pack group definitions, then SCROLL core groups.
 */
export function classifyToolDescriptor(tool, { groupRegistry = null } = {}) {
  const name = typeof tool === 'string' ? tool : String(tool?.name || '').trim();
  if (!name) return null;
  const reg = groupRegistry || compileGroupMatchers([]);
  const declaredGroupId = typeof tool === 'object' && tool?.group ? String(tool.group).trim() : null;

  if (declaredGroupId && reg.byId.has(declaredGroupId)) {
    const base = reg.byId.get(declaredGroupId);
    return {
      ...base,
      name: (typeof tool === 'object' && tool.groupName) ? String(tool.groupName) : base.name,
      label: (typeof tool === 'object' && tool.groupSummary) ? String(tool.groupSummary) : base.label,
      scope: (typeof tool === 'object' && tool.scope) ? String(tool.scope) : base.scope,
      declared: true,
    };
  }
  if (declaredGroupId) {
    return {
      id: declaredGroupId,
      name: (typeof tool === 'object' && tool.groupName) ? String(tool.groupName) : declaredGroupId,
      techName: (typeof tool === 'object' && tool.techName) ? String(tool.techName) : declaredGroupId,
      tier: (typeof tool === 'object' && ['core', 'host', 'pack', 'external', 'botroom', 'integration'].includes(tool.tier))
        ? tool.tier
        : 'external',
      priority: 90,
      kind: (typeof tool === 'object' && tool.kind) ? String(tool.kind) : 'bridge',
      scope: (typeof tool === 'object' && tool.scope) ? String(tool.scope) : 'owner_dm',
      label: (typeof tool === 'object' && tool.groupSummary)
        ? String(tool.groupSummary)
        : String(tool?.description || declaredGroupId),
      declared: true,
    };
  }

  // Search host/pack-provided groups before core fallback so host overrides win cleanly
  for (let i = reg.list.length - 1; i >= 0; i--) {
    if (reg.list[i].match(name)) {
      return { ...reg.list[i], declared: false };
    }
  }
  return null;
}

export function introspectPackMcp(packDir) {
  if (!packDir) return [];
  const servers = new Map();
  const mcpJson = readJsonSafe(path.join(packDir, '.mcp.json'), null);
  if (mcpJson?.mcpServers && typeof mcpJson.mcpServers === 'object') {
    for (const [name, cfg] of Object.entries(mcpJson.mcpServers)) {
      const toolNames = cfg?.tools && typeof cfg.tools === 'object' ? Object.keys(cfg.tools) : [];
      servers.set(name, {
        id: `pack:${name}`,
        groupId: name,
        name,
        techName: name,
        tier: 'pack',
        label: cfg?.url || [cfg?.command, ...(Array.isArray(cfg?.args) ? cfg.args : [])].filter(Boolean).join(' ') || 'Pack MCP',
        source: 'pack-mcp',
        scope: 'owner_dm',
        status: cfg?.url ? 'configured' : 'local-only',
        toolsCount: toolNames.length,
        tools: toolNames,
      });
    }
  }
  const lockJson = readJsonSafe(path.join(packDir, '.scroll', 'mcp.lock.json'), null);
  if (lockJson?.tools && typeof lockJson.tools === 'object') {
    for (const rec of Object.values(lockJson.tools)) {
      const sName = String(rec?.server || '').trim();
      const tName = String(rec?.tool || '').trim();
      if (!sName) continue;
      if (!servers.has(sName)) {
        servers.set(sName, {
          id: `pack:${sName}`,
          groupId: sName,
          name: sName,
          techName: sName,
          tier: 'pack',
          label: 'SCROLL mcp.lock.json',
          source: 'pack-mcp',
          scope: 'owner_dm',
          status: 'pinned',
          toolsCount: 0,
          tools: [],
        });
      }
      const entry = servers.get(sName);
      if (tName && !entry.tools.includes(tName)) {
        entry.tools.push(tName);
        entry.toolsCount = entry.tools.length;
      }
    }
  }
  return [...servers.values()];
}

function normalizeTier(rawTier) {
  if (rawTier === 'core') return 'core';
  if (rawTier === 'host' || rawTier === 'botroom') return 'host';
  if (rawTier === 'pack') return 'pack';
  return 'external';
}

export function describeToolCatalog({
  runtimeTools = null,
  runtimeToolDescriptors = null,
  hostGroupDefinitions = [],
  packManifest = null,
  packDir = null,
  companionTools = [],
  companionEnabled = false,
  companionOnline = false,
  deviceId = null,
  remoteMcpServers = [],
  toolGroupPolicy = null,
  modelCapabilities = null,
  ignoreToolNames = ['system_action_run', 'companion_read_media'],
} = {}) {
  const ignoreSet = new Set(ignoreToolNames);
  const disabledSet = new Set(
    Array.isArray(toolGroupPolicy?.disabledGroups)
      ? toolGroupPolicy.disabledGroups.map((g) => String(g || '').trim()).filter(Boolean)
      : [],
  );

  // Merge pack-declared toolGroups + host-supplied group definitions into canonical matcher registry
  const packToolGroups = Array.isArray(packManifest?.toolGroups)
    ? packManifest.toolGroups.map((g) => ({ ...g, tier: g.tier || 'pack' }))
    : [];
  const reg = compileGroupMatchers([...(Array.isArray(hostGroupDefinitions) ? hostGroupDefinitions : []), ...packToolGroups]);

  // 1. Classify live runtime tools (core + host native + pack capability tools)
  const rawRuntimeItems = Array.isArray(runtimeToolDescriptors) && runtimeToolDescriptors.length
    ? runtimeToolDescriptors
    : (Array.isArray(runtimeTools) && runtimeTools.length
        ? runtimeTools.map((t) => (typeof t === 'string' ? { name: t } : t))
        : ['automations', 'memory_recent_chats', 'memory_search', 'knowledge_read', 'skill_view'].map((name) => ({ name })));

  const runtimeBuckets = new Map();
  const cloudActiveToolNames = new Set();
  const unclassifiedRuntimeTools = [];

  for (const rawTool of rawRuntimeItems) {
    const name = typeof rawTool === 'string' ? rawTool : String(rawTool?.name || '').trim();
    if (!name || ignoreSet.has(name)) continue;
    const grp = classifyToolDescriptor(rawTool, { groupRegistry: reg });
    if (!grp) {
      unclassifiedRuntimeTools.push(name);
      continue;
    }
    const disabled = disabledSet.has(grp.id);
    if (!disabled) cloudActiveToolNames.add(name);
    if (!runtimeBuckets.has(grp.id)) {
      runtimeBuckets.set(grp.id, {
        id: `runtime:${grp.id}`,
        groupId: grp.id,
        name: grp.name,
        techName: grp.techName || grp.id,
        tier: normalizeTier(grp.tier),
        priority: grp.priority,
        label: grp.label,
        source: normalizeTier(grp.tier) === 'pack' ? 'pack-runtime' : 'runtime-mcp',
        scope: grp.scope || 'owner_dm',
        deviceId: null,
        enabled: !disabled,
        toggleable: grp.id !== 'scroll-core',
        status: disabled ? 'disabled' : 'online',
        toolsCount: 0,
        tools: [],
      });
    }
    const b = runtimeBuckets.get(grp.id);
    if (!b.tools.includes(name)) {
      b.tools.push(name);
      b.toolsCount = b.tools.length;
    }
  }

  const allRuntimeGroups = [...runtimeBuckets.values()].sort((a, b) => a.priority - b.priority);
  const core = allRuntimeGroups.filter((g) => g.tier === 'core');
  const hostNative = allRuntimeGroups.filter((g) => g.tier === 'host');
  const packRuntime = allRuntimeGroups.filter((g) => g.tier === 'pack');

  // 2. Classify Companion tools with automatic Cloud-vs-Companion collision detection & shadowing!
  const companionBuckets = new Map();
  const unclassifiedTools = [...unclassifiedRuntimeTools];
  const shadowedTools = [];
  const collisions = [];
  const seenCompanionNames = new Set();

  for (const t of Array.isArray(companionTools) ? companionTools : []) {
    const name = typeof t === 'string' ? t : String(t?.name || '').trim();
    if (!name || ignoreSet.has(name) || seenCompanionNames.has(name)) continue;
    seenCompanionNames.add(name);

    // Cloud Native takes precedence over identical Companion tool names (e.g. send_telegram_message)
    if (cloudActiveToolNames.has(name)) {
      shadowedTools.push({ name, shadowedBy: 'cloud-native', reason: 'cloud_precedence' });
      continue;
    }

    const grp = classifyToolDescriptor(t, { groupRegistry: reg });
    const toolDeviceId = (t && typeof t === 'object' && t.deviceId) ? String(t.deviceId) : (deviceId || null);
    const toolScope = (t && typeof t === 'object' && (t.ownerGroupSafe === true || t.groupScope === 'owner_in_group'))
      ? 'owner_in_group'
      : (grp?.scope || 'owner_dm');
    if (grp) {
      const disabled = disabledSet.has(grp.id);
      if (!companionBuckets.has(grp.id)) {
        companionBuckets.set(grp.id, {
          id: `companion:${grp.id}`,
          groupId: grp.id,
          name: grp.name,
          techName: grp.techName || grp.id,
          tier: normalizeTier(grp.tier),
          priority: grp.priority,
          label: grp.label,
          source: grp.kind === 'mcp' ? 'companion-mcp' : 'companion-bridge',
          scope: toolScope,
          deviceId: toolDeviceId,
          deviceIds: toolDeviceId ? [toolDeviceId] : [],
          enabled: !disabled,
          toggleable: true,
          status: disabled ? 'disabled' : (companionOnline ? 'online' : 'offline'),
          toolsCount: 0,
          tools: [],
        });
      }
      const b = companionBuckets.get(grp.id);
      if (toolDeviceId && !b.deviceIds.includes(toolDeviceId)) b.deviceIds.push(toolDeviceId);
      if (toolScope === 'owner_in_group') b.scope = 'owner_in_group';
      if (!b.tools.includes(name)) {
        b.tools.push(name);
        b.toolsCount = b.tools.length;
      }
    } else {
      unclassifiedTools.push(name);
    }
  }

  const companion = [...companionBuckets.values()]
    .sort((a, b) => (a.tier === b.tier ? a.priority - b.priority : (a.tier === 'host' ? -1 : 1)));

  if (unclassifiedTools.length > 0) {
    companion.push({
      id: 'companion:other',
      groupId: 'other',
      name: 'Unclassified Tools',
      techName: 'unclassified',
      tier: 'external',
      priority: 999,
      label: 'Tools without a declared group metadata entry',
      source: 'companion-bridge',
      scope: 'owner_dm',
      deviceId: deviceId || null,
      enabled: true,
      toggleable: false,
      status: companionOnline ? 'online' : 'offline',
      toolsCount: unclassifiedTools.length,
      tools: unclassifiedTools,
    });
  }

  const packMcp = introspectPackMcp(packDir);
  const pack = [...packRuntime, ...packMcp];

  // 3. Build hostDefaults from hostGroupDefinitions where `defaultVisible === true` (plus scroll-core)
  const liveByGroup = new Map();
  for (const item of [...core, ...hostNative, ...pack, ...companion]) {
    if (item.groupId && !liveByGroup.has(item.groupId)) liveByGroup.set(item.groupId, item);
  }

  const defaultSpecs = [
    reg.byId.get('scroll-core'),
    ...reg.list.filter((g) => g.id !== 'scroll-core' && g.defaultVisible),
  ].filter(Boolean);

  const hostDefaults = [];
  const defaultIdSet = new Set();
  for (const spec of defaultSpecs) {
    if (defaultIdSet.has(spec.id)) continue;
    defaultIdSet.add(spec.id);
    const live = liveByGroup.get(spec.id);
    const disabled = disabledSet.has(spec.id);
    if (live) {
      hostDefaults.push({
        ...live,
        name: spec.name,
        techName: spec.techName,
        label: spec.label,
        enabled: !disabled,
        toggleable: spec.id !== 'scroll-core',
        status: disabled ? 'disabled' : live.status,
      });
    } else {
      hostDefaults.push({
        id: `default:${spec.id}`,
        groupId: spec.id,
        name: spec.name,
        techName: spec.techName,
        tier: normalizeTier(spec.tier),
        label: spec.label,
        source: spec.requiresCompanion ? 'companion-bridge' : 'host-native',
        scope: spec.scope || 'owner_dm',
        deviceId: deviceId || null,
        enabled: !disabled,
        toggleable: spec.id !== 'scroll-core',
        status: disabled
          ? 'disabled'
          : (spec.requiresCompanion && (!companionEnabled || !companionOnline) ? 'standby' : 'not_connected'),
        toolsCount: 0,
        tools: [],
      });
    }
  }

  const remoteMcp = (Array.isArray(remoteMcpServers) ? remoteMcpServers : []).map((s) => ({
    id: `remote-mcp:${s.id || s.name}`,
    groupId: `mcp:${s.id || s.name}`,
    name: String(s.name || s.url || 'MCP Server'),
    techName: String(s.presetKey || 'mcp'),
    tier: 'external',
    label: String(s.url || ''),
    source: 'remote-mcp',
    scope: 'owner_dm',
    deviceId: null,
    enabled: s.enabled !== false,
    toggleable: true,
    status: s.enabled === false ? 'disabled' : (s.lastStatus === 'ok' ? 'online' : 'configured'),
    toolsCount: Number(s.toolsCount || (Array.isArray(s.tools) ? s.tools.length : 0)),
    tools: Array.isArray(s.tools) ? s.tools.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean) : [],
  }));

  const integrations = [
    ...companion.filter((c) => !defaultIdSet.has(c.groupId)),
    ...packMcp.filter((p) => !defaultIdSet.has(p.groupId)),
  ];

  // Collect all catalogued runtime + active companion tool names for 1-to-1 Parity verification
  const cataloguedToolNames = new Set();
  for (const grp of [...core, ...hostNative, ...pack, ...companion]) {
    for (const tn of grp.tools || []) cataloguedToolNames.add(tn);
  }
  for (const s of shadowedTools) cataloguedToolNames.add(s.name);

  return {
    schema: 'scroll-tool-catalog/v2',
    // New canonical 4-tier views
    core,
    host: hostNative,
    hostDefaults,
    pack,
    external: {
      companion: integrations,
      remoteMcp,
    },
    modelCapabilities: modelCapabilities || null,
    disabledGroups: [...disabledSet],
    shadowedTools,
    collisions,
    cataloguedToolNames: [...cataloguedToolNames],
    // Backwards-compatible aliases
    runtime: [...core, ...hostNative],
    companion,
    botroomDefaults: hostDefaults,
    integrations,
    unclassifiedTools,
  };
}

// -- 4. Scientific Capability Gap Analyzer ------------------------------------
const KNOWN_MCP_HINTS = Object.freeze([
  { id: 'notion', rx: /\bnotion\b/i, label: 'Notion MCP', toolRx: /^notion_/i },
  { id: 'linear', rx: /\blinear\b/i, label: 'Linear MCP', toolRx: /^linear_/i },
  { id: 'github', rx: /\bgithub\b/i, label: 'GitHub MCP', toolRx: /^github_/i },
]);

export function computeCapabilityGaps({
  skillsReport = null,
  remoteMcpServers = [],
  companionTools = [],
} = {}) {
  const gaps = [];
  const visible = Array.isArray(skillsReport?.visible) ? skillsReport.visible : [];
  const gated = Array.isArray(skillsReport?.gated) ? skillsReport.gated : [];
  const enabledRemote = (Array.isArray(remoteMcpServers) ? remoteMcpServers : []).filter((s) => s?.enabled !== false);
  const compNames = (Array.isArray(companionTools) ? companionTools : []).map((t) => String(typeof t === 'string' ? t : t?.name || ''));

  const seenGapIds = new Set();
  for (const sk of visible) {
    const reqList = Array.isArray(sk.requires) ? sk.requires : [];
    const probeText = `${sk.name || ''} ${reqList.join(' ')}`;
    for (const hint of KNOWN_MCP_HINTS) {
      if (!hint.rx.test(probeText)) continue;
      const hasRemote = enabledRemote.some((s) => hint.rx.test(`${s.name || ''} ${s.url || ''}`));
      const hasComp = compNames.some((n) => hint.toolRx.test(n));
      if (!hasRemote && !hasComp && !seenGapIds.has(`gap:${hint.id}`)) {
        seenGapIds.add(`gap:${hint.id}`);
        gaps.push({
          id: `gap:${hint.id}`,
          skill: sk.name,
          missing: hint.label,
          presetId: hint.id,
        });
      }
    }
  }
  for (const g of gated) {
    gaps.push({
      id: `gap:skill:${g.name}`,
      skill: g.name,
      missing: Array.isArray(g.unmet) && g.unmet.length ? g.unmet.join(', ') : (g.reason || g.state || 'unmet'),
      presetId: null,
    });
  }
  return gaps;
}

// -- 5. Effective Model Inheritance Resolver ----------------------------------
export function resolveEffectiveModel({
  identityModel = null,
  identityEconomy = null,
  overrides = null,
} = {}) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const idM = identityModel && typeof identityModel === 'object' ? identityModel : {};
  const idE = identityEconomy && typeof identityEconomy === 'object' ? identityEconomy : {};

  const primaryOverride = ov.model && ov.model !== 'auto' ? String(ov.model) : null;
  const primaryPack = idM.primary ? String(idM.primary) : null;
  const primary = primaryOverride || primaryPack || 'auto';
  const primarySource = primaryOverride ? 'override' : (primaryPack ? 'pack' : 'default');

  const fallbackExplicitOff = ov.fallbackModel === 'none';
  const fallbackOverride = !fallbackExplicitOff && ov.fallbackModel && ov.fallbackModel !== 'auto' ? String(ov.fallbackModel) : null;
  const fallbackPack = !fallbackExplicitOff && idM.fallback ? String(idM.fallback) : null;
  const fallback = fallbackExplicitOff ? null : (fallbackOverride || fallbackPack || null);
  const fallbackSource = fallbackExplicitOff || fallbackOverride ? 'override' : (fallbackPack ? 'pack' : 'default');

  const escalation = (ov.modelEscalation === 'auto' && fallback && fallback !== primary)
    ? 'auto'
    : 'off';
  const escalationSource = ov.modelEscalation ? 'override' : 'default';

  const effort = ov.reasoningEffort ? String(ov.reasoningEffort) : 'medium';
  const effortSource = ov.reasoningEffort ? 'override' : 'default';

  const effortRouting = (ov.effortRouting === 'auto' || ov.effortRouting === 'fixed')
    ? ov.effortRouting
    : (idE.effort_routing === 'auto' ? 'auto' : 'fixed');
  const effortRoutingSource = (ov.effortRouting === 'auto' || ov.effortRouting === 'fixed')
    ? 'override'
    : (idE.effort_routing ? 'pack' : 'default');

  return {
    primary,
    primarySource,
    fallback,
    fallbackSource,
    escalation,
    escalationSource,
    effort,
    effortSource,
    effortRouting,
    effortRoutingSource,
  };
}

// -- 6. Canonical Host Snapshot Assembler (`scroll-introspection/v2`) ---------
export function describeHostSnapshot({
  hostStatus = {},
  runtime = null,
  workspace = null,
  packsDir = null,
  overrides = null,
  weights = null,
  voice = null,
  groupPolicyOverride = null,
  botUsername = null,
  remoteMcpServers = [],
  companion = null,
  availableCompanions = [],
  extraRuntimeTools = null,
  runtimeToolDescriptors = null,
  runtimeToolsActual = null,
  hostGroupDefinitions = [],
  toolGroupPolicy = null,
  modelCapabilities = null,
  profileStatus = null,
  lastTurnRouting = null,
  recentTurnRoutings = [],
  scrollVersion = null,
} = {}) {
  const activePack = hostStatus.activePack || workspace?.getBinding?.()?.activePack || null;
  const chatRt = runtime?.chat || runtime || null;
  const fm = (chatRt?.agent?.frontmatter && typeof chatRt.agent.frontmatter === 'object')
    ? chatRt.agent.frontmatter
    : {};
  const econ = resolveEconomyConfig(fm.economy || null);
  const pinnedSkills = Array.isArray(fm.skills) ? fm.skills.map(String) : [];
  const pinnedSet = new Set(pinnedSkills);

  const identity = {
    name: String(fm.name || activePack?.agentName || ''),
    title: String(fm.title || ''),
    version: String(fm.version || ''),
    language: String(fm.language || 'vi'),
    model: {
      primary: fm.model?.primary ? String(fm.model.primary) : null,
      fallback: fm.model?.fallback ? String(fm.model.fallback) : null,
    },
    economy: {
      mode: econ.mode,
      effortRouting: econ.effortRouting,
      links: econ.links,
      processNarration: econ.processNarration,
      echoGuard: econ.echoGuard,
      maxCharsBrief: econ.maxCharsBrief,
    },
    capabilities: Array.isArray(fm.capabilities) ? fm.capabilities.map(String) : [],
    pinnedSkills,
    security: {
      approval: fm.security?.approval && typeof fm.security.approval === 'object' ? fm.security.approval : {},
      egressAllow: Array.isArray(fm.security?.egress_allow) ? fm.security.egress_allow.map(String) : [],
    },
  };

  let domainPacks = [];
  let packManifest = null;
  if (activePack?.packDir) {
    packManifest = readJsonSafe(path.join(activePack.packDir, 'pack.manifest.json'), null);
    if (Array.isArray(packManifest?.domainPacks)) {
      domainPacks = packManifest.domainPacks.map((dp) => ({
        id: String(dp.id || ''),
        version: String(dp.version || ''),
        fileCount: Number(dp.fileCount || 0),
      }));
    }
  }

  const packMeta = packManifest ? {
    packId: packManifest.packId || activePack?.packId || null,
    version: packManifest.version || activePack?.version || null,
    capabilities: Array.isArray(packManifest.capabilities) ? packManifest.capabilities : [],
    uiMeta: packManifest.uiMeta || null,
    uiPanels: Array.isArray(packManifest.uiPanels) ? packManifest.uiPanels : [],
    toolGroups: Array.isArray(packManifest.toolGroups) ? packManifest.toolGroups : [],
    voice: packManifest.voice || null,
    defaultCapabilities: packManifest.defaultCapabilities || null,
    defaultWeights: packManifest.defaultWeights || null,
  } : null;

  let skillsReport = { sources: [], visible: [], gated: [], invalid: [] };
  const sr = chatRt?.skillsRegistry || chatRt?.skills || null;
  if (sr && typeof sr.report === 'function') {
    try {
      const rep = sr.report();
      const descOf = (s) => {
        if (s?.description) return String(s.description).trim().slice(0, 180);
        const item = typeof sr.get === 'function' ? sr.get(s.name) : null;
        return String(item?.description || '').trim().slice(0, 180);
      };
      skillsReport = {
        sources: Array.isArray(rep?.sources)
          ? rep.sources.map((s) => ({ id: s.id, kind: s.kind, trust: s.trust, exists: Boolean(s.exists) }))
          : [],
        visible: Array.isArray(rep?.visible)
          ? rep.visible.map((s) => ({
              name: s.name,
              description: descOf(s),
              source: s.source || s.kind || 'pack',
              pinned: pinnedSet.has(s.name),
              state: s.state || 'visible',
              security: typeof s.security === 'object' ? (s.security?.verdict || 'clean') : (s.security || 'clean'),
              compat: s.compat || 'native',
              requires: Array.isArray(s.requires)
                ? s.requires.map((r) => (typeof r === 'string' ? r : (r?.cap || r?.ref))).filter(Boolean)
                : [],
            }))
          : [],
        gated: Array.isArray(rep?.gated)
          ? rep.gated.map((s) => ({
              name: s.name,
              source: s.source || s.kind || 'pack',
              state: s.state || 'hidden',
              reason: String(s.reason || ''),
              unmet: Array.isArray(s.unmet) ? s.unmet : [],
              security: typeof s.security === 'object' ? (s.security?.verdict || 'clean') : (s.security || 'clean'),
            }))
          : [],
        invalid: Array.isArray(rep?.invalid)
          ? rep.invalid.map((s) => ({ name: s.name, errors: s.errors || [] }))
          : [],
      };
    } catch { /* ignore */ }
  }

  let packSkills = [];
  if (activePack?.packDir && activePack?.agentName) {
    const skillsDir = path.join(activePack.packDir, 'agents', activePack.agentName, 'skills');
    if (fs.existsSync(skillsDir)) {
      try {
        packSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name)
          .sort();
      } catch { /* ignore */ }
    }
  }

  let availableVersions = [];
  if (packsDir && activePack?.packId) {
    const pDir = path.join(packsDir, activePack.packId);
    if (fs.existsSync(pDir)) {
      try {
        availableVersions = fs.readdirSync(pDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(pDir, d.name, 'pack.manifest.json')))
          .map((d) => d.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      } catch { /* ignore */ }
    }
  }

  const effectiveToolPolicy = toolGroupPolicy || workspace?.readToolPolicy?.() || { disabledGroups: [] };
  const compInfo = companion && typeof companion === 'object' ? companion : { enabled: false, deviceId: null, online: false, tools: [] };
  const compTools = Array.isArray(compInfo.tools) ? compInfo.tools : [];
  const mcpInventory = describeToolCatalog({
    runtimeTools: extraRuntimeTools,
    runtimeToolDescriptors,
    hostGroupDefinitions,
    packManifest,
    packDir: activePack?.packDir || null,
    companionTools: compInfo.enabled ? compTools : [],
    companionEnabled: Boolean(compInfo.enabled),
    companionOnline: Boolean(compInfo.online),
    deviceId: compInfo.deviceId || null,
    remoteMcpServers,
    toolGroupPolicy: effectiveToolPolicy,
    modelCapabilities,
  });

  const capabilityGaps = computeCapabilityGaps({
    skillsReport,
    remoteMcpServers,
    companionTools: compInfo.enabled ? compTools : [],
  });

  const effectiveModel = resolveEffectiveModel({
    identityModel: identity.model,
    identityEconomy: fm.economy || null,
    overrides,
  });

  const channels = describeChannelPolicy(hostStatus.channelPolicy || null, {
    groupPolicyOverride,
    botUsername,
    passiveObserver: true,
  });

  const effectiveWeights = weights || workspace?.readWeightsOverride?.() || packManifest?.defaultWeights || null;
  const personality = describePersonality(effectiveWeights);
  const layeredKb = workspace?.getLayeredKnowledge ? workspace.getLayeredKnowledge() : null;
  const resolvedProfileStatus = profileStatus || {
    hasUserMd: Boolean(workspace?.readUserMd?.()),
  };

  return {
    schema: 'scroll-introspection/v2',
    scrollVersion: scrollVersion || null,
    enabled: true,
    ...hostStatus,
    identity,
    packMeta,
    effectiveModel,
    modelCapabilities: modelCapabilities || null,
    lastTurnRouting: lastTurnRouting || null,
    recentTurnRoutings: Array.isArray(recentTurnRoutings) ? recentTurnRoutings : [],
    channels,
    personality,
    voice: voice || null,
    profileStatus: resolvedProfileStatus,
    toolGroupPolicy: effectiveToolPolicy,
    runtimeToolsActual: Array.isArray(runtimeToolsActual) ? runtimeToolsActual : null,
    domainPacks,
    skillsReport,
    mcpInventory,
    capabilityGaps,
    companion: {
      enabled: Boolean(compInfo.enabled),
      deviceId: compInfo.deviceId || null,
      deviceIds: Array.isArray(compInfo.deviceIds)
        ? compInfo.deviceIds
        : (compInfo.deviceId ? [compInfo.deviceId] : []),
      devices: Array.isArray(compInfo.devices) ? compInfo.devices : [],
      online: Boolean(compInfo.online),
      lastSeenAt: compInfo.lastSeenAt || null,
      platform: compInfo.platform || null,
      tools: compTools,
      toolCount: compTools.length,
    },
    availableCompanions: Array.isArray(availableCompanions) ? availableCompanions : [],
    packSkills,
    availableVersions,
    ...(layeredKb ? { knowledge: { active: layeredKb.active, chunks: layeredKb.chunks.length, layers: layeredKb.layers } } : {}),
  };
}

// -- 7. Automated Zero-Drift Parity Gate v2 (`verifyIntrospectionParity`) -----
export function verifyIntrospectionParity(snapshot) {
  const checks = [];
  const warnings = [];
  const failures = [];

  const pass = (id, detail) => checks.push({ id, status: 'pass', detail });
  const warn = (id, detail) => { checks.push({ id, status: 'warn', detail }); warnings.push({ id, detail }); };
  const fail = (id, detail) => { checks.push({ id, status: 'fail', detail }); failures.push({ id, detail }); };

  if (!snapshot || typeof snapshot !== 'object') {
    fail('snapshot.present', 'Missing introspection snapshot');
    return {
      ok: false,
      schema: 'scroll-parity-report/v2',
      checkedAt: new Date().toISOString(),
      summary: { passed: 0, warnings: 0, failures: 1 },
      checks,
      warnings,
      failures,
    };
  }

  // 1. Pack bound cleanly
  if (snapshot.activePack?.packId && snapshot.activePack?.version) {
    pass('pack.bound', `${snapshot.activePack.packId}@${snapshot.activePack.version}`);
  } else {
    fail('pack.bound', 'No active signed pack bound');
  }

  // 2. 1-to-1 Runtime Tool Parity (catches phantom/missing tools like doc_create!)
  if (Array.isArray(snapshot.runtimeToolsActual)) {
    const catalogSet = new Set(snapshot.mcpInventory?.cataloguedToolNames || []);
    const missingFromCatalog = snapshot.runtimeToolsActual.filter((n) => !catalogSet.has(n));
    if (missingFromCatalog.length === 0) {
      pass('tools.runtime_parity', `All ${snapshot.runtimeToolsActual.length} live runtime tools accounted for in catalog`);
    } else {
      fail('tools.runtime_parity', `Live runtime tools missing from catalog: ${missingFromCatalog.join(', ')}`);
    }
  }

  // 3. Zero unclassified live tools
  const unclassified = snapshot.mcpInventory?.unclassifiedTools || [];
  if (unclassified.length === 0) {
    pass('tools.classified', `All live tools classified cleanly (${snapshot.companion?.toolCount || 0} companion tools)`);
  } else {
    fail('tools.classified', `Unclassified tools fell into 'other': ${unclassified.join(', ')}`);
  }

  // 4. Zero duplicate group IDs across defaults & integrations + shadowed collisions reported cleanly
  const defIds = new Set((snapshot.mcpInventory?.hostDefaults || snapshot.mcpInventory?.botroomDefaults || []).map((x) => x.groupId));
  const overlap = (snapshot.mcpInventory?.integrations || []).filter((x) => x.groupId && defIds.has(x.groupId));
  const shadowedCount = (snapshot.mcpInventory?.shadowedTools || []).length;
  if (overlap.length === 0) {
    pass(
      'tools.no_duplicates',
      `${defIds.size} host defaults + ${(snapshot.mcpInventory?.integrations || []).length} external groups (0 overlap${shadowedCount ? `, ${shadowedCount} cloud-shadowed` : ''})`,
    );
  } else {
    fail('tools.no_duplicates', `Duplicate tool groups across defaults & integrations: ${overlap.map((x) => x.groupId).join(', ')}`);
  }

  // 5. Effective model & runner capability match
  const em = snapshot.effectiveModel;
  if (em && em.primary && em.primarySource && em.escalationSource) {
    pass('model.resolved', `primary=${em.primary} (${em.primarySource}), fallback=${em.fallback || 'none'} (${em.fallbackSource}), escalation=${em.escalation}`);
  } else {
    fail('model.resolved', 'Missing effectiveModel provenance');
  }

  if (snapshot.modelCapabilities && Array.isArray(snapshot.modelCapabilities.supportedCapabilities)) {
    const supported = new Set(snapshot.modelCapabilities.supportedCapabilities);
    const mismatches = [];
    for (const cap of ['webSearch', 'imageGeneration', 'vision']) {
      if (snapshot.modelCapabilities[cap] === true && !supported.has(cap)) {
        mismatches.push(cap);
      }
    }
    if (mismatches.length > 0) {
      warn('capabilities.runner_match', `Enabled on runner (${snapshot.modelCapabilities.activeRunner || 'unknown'}) without native support: ${mismatches.join(', ')}`);
    } else {
      pass('capabilities.runner_match', `Runner (${snapshot.modelCapabilities.activeRunner || 'auto'}) matches enabled model capabilities`);
    }
  }

  // 6. Channel trigger labels extracted when pack has mention patterns
  const ch = snapshot.channels;
  if (ch && ch.groupPolicy) {
    if ((ch.mentionPatternCount > 0 || ch.softAliasCount > 0) && (!Array.isArray(ch.mentionLabels) || ch.mentionLabels.length === 0)) {
      fail('channels.triggers', 'Pack declares mentionPatterns/softAliases but mentionLabels is empty');
    } else {
      pass('channels.triggers', `groupPolicy=${ch.groupPolicy} (${ch.source}), labels=[${(ch.mentionLabels || []).join(', ')}]`);
    }
  } else {
    fail('channels.triggers', 'Missing canonical channels description');
  }

  // 7. Zero invalid skills
  const invSkills = snapshot.skillsReport?.invalid || [];
  if (invSkills.length === 0) {
    pass('skills.valid', `${(snapshot.skillsReport?.visible || []).length} visible, ${(snapshot.skillsReport?.gated || []).length} gated, 0 invalid`);
  } else {
    fail('skills.valid', `Invalid skills: ${invSkills.map((s) => s.name).join(', ')}`);
  }

  // 8. Personality schema & Voice runtime parity
  const pers = snapshot.personality;
  if (pers?.schema === 'scroll-personality/v1' && pers.displayTraits?.openness >= 1 && pers.displayTraits?.openness <= 5) {
    const vInfo = snapshot.voice?.effectiveMode ? `, voice=${snapshot.voice.effectiveMode}` : '';
    pass('personality.schema', `preset=${pers.preset}, reserve=${pers.traits?.reserve} -> openness=${pers.displayTraits.openness}/5${vInfo}`);
  } else {
    fail('personality.schema', 'Personality schema or openness polarity projection missing');
  }

  // 9. Companion online health notice (warning only, not a failure when opt-in disabled)
  if (snapshot.companion?.enabled && !snapshot.companion?.online) {
    warn('companion.online', `Companion ${snapshot.companion.deviceId || ''} is enabled but currently offline`);
  } else {
    pass('companion.online', snapshot.companion?.enabled ? `Companion ${snapshot.companion.deviceId} online` : 'Companion disabled (cloud-only)');
  }

  return {
    ok: failures.length === 0,
    schema: 'scroll-parity-report/v2',
    checkedAt: new Date().toISOString(),
    summary: {
      passed: checks.filter((c) => c.status === 'pass').length,
      warnings: warnings.length,
      failures: failures.length,
    },
    checks,
    warnings,
    failures,
  };
}
