// SCROLL 2.9 -- Canonical Host Introspection (`scroll-introspection/v1`),
// Declarative Tool Catalog, Single-Source Personality Schema, Channel Trigger
// Describer, & Automated Parity Gate (`verifyIntrospectionParity`).
// Zero-dep, pure ESM, Node >= 20.
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

// ── 1. Canonical Personality Schema & Presets (Single Source of Truth) ────────
export const PERSONALITY_TRAITS = Object.freeze([
  Object.freeze({
    key: 'assertiveness',
    displayKey: 'assertiveness',
    polarity: 'positive',
    min: 1,
    max: 5,
    labels: Object.freeze({ vi: 'Chính kiến', en: 'Assertiveness' }),
    descriptions: Object.freeze({
      vi: 'Mức độ Bot mạnh dạn góp ý hoặc phản biện khi thấy phương án chưa tối ưu.',
      en: 'How directly the agent shares opinions or pushes back on suboptimal plans.',
    }),
    levels: Object.freeze({
      vi: Object.freeze(['Lắng nghe nhẹ', 'Góp ý mềm', 'Nói rõ ý', 'Góp ý thẳng', 'Chốt dứt khoát']),
      en: Object.freeze(['Soft listener', 'Gentle nudge', 'Clear view', 'Direct advice', 'Decisive lead']),
    }),
  }),
  Object.freeze({
    key: 'reserve',
    displayKey: 'openness',
    polarity: 'inverted',
    min: 1,
    max: 5,
    labels: Object.freeze({ vi: 'Cởi mở', en: 'Openness' }),
    descriptions: Object.freeze({
      vi: 'Mức độ thoải mái, gần gũi khi trò chuyện. Càng cao Bot càng cởi mở, tự nhiên; càng thấp Bot càng điềm tĩnh, giữ khoảng cách.',
      en: 'How relaxed and open the tone feels. Higher is warmer and more open; lower is more composed and reserved.',
    }),
    levels: Object.freeze({
      vi: Object.freeze(['Điềm tĩnh, giữ kẽ', 'Chọn lọc', 'Vừa đủ', 'Thân tự nhiên', 'Rất cởi mở']),
      en: Object.freeze(['Composed', 'Selective', 'Balanced', 'Friendly', 'Very open']),
    }),
  }),
  Object.freeze({
    key: 'wit',
    displayKey: 'wit',
    polarity: 'positive',
    min: 1,
    max: 5,
    labels: Object.freeze({ vi: 'Dí dỏm', en: 'Wit' }),
    descriptions: Object.freeze({
      vi: 'Mức độ pha trò nhẹ nhàng và hóm hỉnh trong trò chuyện hàng ngày.',
      en: 'How frequently the agent uses light humor or clever phrasing.',
    }),
    levels: Object.freeze({
      vi: Object.freeze(['Nghiêm túc', 'Vui nhẹ', 'Có duyên', 'Chủ động vui', 'Hóm hỉnh']),
      en: Object.freeze(['Serious', 'Light smile', 'Charming', 'Playful', 'Sharp wit']),
    }),
  }),
  Object.freeze({
    key: 'warmth',
    displayKey: 'warmth',
    polarity: 'positive',
    min: 1,
    max: 5,
    labels: Object.freeze({ vi: 'Ấm áp', en: 'Warmth' }),
    descriptions: Object.freeze({
      vi: 'Mức độ ân cần, quan tâm và đồng hành cảm xúc với bạn.',
      en: 'How caring, empathetic, and encouraging the agent sounds.',
    }),
    levels: Object.freeze({
      vi: Object.freeze(['Lịch sự gọn', 'Chu đáo', 'Quan tâm', 'Chân thành', 'Đồng hành sâu']),
      en: Object.freeze(['Polite brief', 'Attentive', 'Caring', 'Warm & close', 'Deep empathy']),
    }),
  }),
]);

export const PERSONALITY_PRESETS = Object.freeze({
  'nhe-nhang': Object.freeze({
    id: 'nhe-nhang',
    labels: Object.freeze({ vi: 'Nhẹ nhàng', en: 'Gentle' }),
    traits: Object.freeze({ assertiveness: 2, reserve: 2, wit: 2, warmth: 4 }),
    initiative: 1,
    adaptiveLevel: 2,
  }),
  'ca-tinh': Object.freeze({
    id: 'ca-tinh',
    labels: Object.freeze({ vi: 'Cá tính', en: 'Expressive' }),
    traits: Object.freeze({ assertiveness: 4, reserve: 2, wit: 4, warmth: 4 }),
    initiative: 2,
    adaptiveLevel: 2,
  }),
  'kho-chieu-co-duyen': Object.freeze({
    id: 'kho-chieu-co-duyen',
    labels: Object.freeze({ vi: 'Có duyên', en: 'Witty Charm' }),
    traits: Object.freeze({ assertiveness: 4, reserve: 3, wit: 4, warmth: 3 }),
    initiative: 2,
    adaptiveLevel: 2,
  }),
  'thang-than-cong-viec': Object.freeze({
    id: 'thang-than-cong-viec',
    labels: Object.freeze({ vi: 'Thẳng thắn', en: 'Direct Pro' }),
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
    labels: Object.freeze({ vi: 'Độ chủ động', en: 'Initiative' }),
    levels: Object.freeze({
      vi: Object.freeze(['Chỉ đáp', 'Bắt nhịp', 'Bắt chuyện', 'Rôm rả']),
      en: Object.freeze(['Reply only', 'Join flow', 'Follow up', 'Proactive']),
    }),
  }),
  adaptiveLevel: Object.freeze({
    min: 0,
    max: 3,
    labels: Object.freeze({ vi: 'Độ nhạy cảm xúc', en: 'Emotion Sensitivity' }),
    levels: Object.freeze({
      vi: Object.freeze(['Ổn định', 'Nhẹ', 'Theo mạch', 'Nhạy sớm']),
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
    schemaDef: PERSONALITY_SCHEMA,
  };
}

// ── 2. Canonical Channel Trigger Describer ────────────────────────────────────
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

// ── 3. Canonical Declarative Tool & Ecosystem Catalog ─────────────────────────
export const ECOSYSTEM_TOOL_GROUPS = Object.freeze([
  Object.freeze({
    id: 'scroll-core',
    name: 'Lõi Bot Room',
    techName: 'SCROLL',
    tier: 'botroom',
    priority: 1,
    kind: 'runtime',
    label: 'Bộ nhớ đa kênh, đọc lịch sử nhóm, đặt lịch tự động và gửi ảnh/tệp',
    match: (n) => n === 'automations' || n === 'send_chat_media' || n.startsWith('memory_') || n.startsWith('knowledge_') || n.startsWith('skill_'),
  }),
  Object.freeze({
    id: 'river-cua',
    name: 'Điều khiển màn hình',
    techName: 'RIVER CUA',
    tier: 'botroom',
    priority: 10,
    kind: 'mcp',
    label: 'Xem màn hình, bấm nút và thao tác app trên máy tính khi bạn cho phép',
    requiresCompanion: true,
    match: (n) => n.startsWith('river_cua_') || n.startsWith('cua_'),
  }),
  Object.freeze({
    id: 'dragon-browser',
    name: 'Trình duyệt web thật',
    techName: 'Dragon Browser',
    tier: 'botroom',
    priority: 20,
    kind: 'bridge',
    label: 'Mở web và thao tác trực tiếp trên Chrome đã đăng nhập của bạn',
    requiresCompanion: true,
    match: (n) => n === 'dragon_browser' || n.startsWith('dragon_'),
  }),
  Object.freeze({
    id: 'doc-colab',
    name: 'Tài liệu cộng tác',
    techName: 'Doc-Colab',
    tier: 'botroom',
    priority: 30,
    kind: 'bridge',
    label: 'Tạo đề xuất, báo cáo và gửi link cho bạn duyệt (docs.agentpro.tech)',
    requiresCompanion: false,
    match: (n) => n.startsWith('doc_colab_') || n === 'acct_sync_doc_colab',
  }),
  Object.freeze({
    id: 'mixer',
    name: 'Hội đồng đa AI',
    techName: 'MIXER',
    tier: 'botroom',
    priority: 40,
    kind: 'bridge',
    label: 'Gọi thêm mô hình AI khác để kiểm chéo hoặc xử lý việc phức tạp',
    requiresCompanion: true,
    match: (n) => n.startsWith('mixer_'),
  }),
  Object.freeze({
    id: 'river-ask',
    name: 'Hỏi & duyệt từ xa',
    techName: 'RIVER',
    tier: 'botroom',
    priority: 50,
    kind: 'bridge',
    label: 'Gửi câu hỏi hoặc xin xác nhận khi bạn không ngồi trước máy',
    requiresCompanion: true,
    match: (n) => n === 'river_ask' || n.startsWith('river_ask_'),
  }),
  Object.freeze({
    id: 'google-workspace',
    name: 'Google (Lịch & Workspace)',
    techName: 'google-workspace',
    tier: 'integration',
    priority: 10,
    kind: 'bridge',
    label: 'Xem, tạo, sửa và quản lý lịch hẹn Google Calendar và Workspace',
    match: (n) => n.startsWith('calendar_') || n.startsWith('gmail_') || n.startsWith('gdrive_') || n.startsWith('gws_') || n.startsWith('google_'),
  }),
  Object.freeze({
    id: 'local-pim-mail',
    name: 'Hộp thư & Danh bạ máy',
    techName: 'local-pim-mail',
    tier: 'integration',
    priority: 20,
    kind: 'bridge',
    label: 'Đọc email, danh bạ và theo dõi thông báo quan trọng',
    match: (n) => n.startsWith('local_pim_') || n === 'jen_mail_case_control' || n === 'jen_chat_watch' || n === 'jen_smart_alerts',
  }),
  Object.freeze({
    id: 'telegram-media',
    name: 'Gửi ảnh & tệp Telegram',
    techName: 'telegram-media',
    tier: 'integration',
    priority: 30,
    kind: 'bridge',
    label: 'Gửi ảnh chụp, tài liệu và tin nhắn trực tiếp qua Telegram',
    match: (n) => n.startsWith('send_telegram_'),
  }),
  Object.freeze({
    id: 'an-tam-accounting',
    name: 'Nghiệp vụ Kế toán & Thuế',
    techName: 'an-tam-accounting',
    tier: 'integration',
    priority: 40,
    kind: 'bridge',
    label: 'Kiểm tra hóa đơn, thuế và hồ sơ kế toán doanh nghiệp',
    match: (n) => n.startsWith('acct_'),
  }),
  Object.freeze({
    id: 'win11-tax-vm',
    name: 'Máy ảo Thuế Windows',
    techName: 'win11-tax-vm',
    tier: 'integration',
    priority: 50,
    kind: 'bridge',
    label: 'Chạy phần mềm kê khai và cổng thuế trong máy ảo Windows riêng',
    match: (n) => n.startsWith('win_vm_'),
  }),
  Object.freeze({
    id: 'mac-pro-codex',
    name: 'Tác vụ máy Mac & Lập trình',
    techName: 'mac-pro-codex',
    tier: 'integration',
    priority: 60,
    kind: 'bridge',
    label: 'Chạy tác vụ dài và lệnh an toàn trên máy chủ sở hữu',
    match: (n) => n.startsWith('mac_pro_') || n.startsWith('jen_codex_') || n === 'owner_shell' || n === 'jen_ai_manager',
  }),
  Object.freeze({
    id: 'fava-books',
    name: 'Sổ sách kế toán',
    techName: 'fava-books',
    tier: 'integration',
    priority: 70,
    kind: 'bridge',
    label: 'Tra cứu sổ sách tài chính (Beancount / Fava)',
    match: (n) => n.startsWith('fava_'),
  }),
  Object.freeze({
    id: 'distill-v3',
    name: 'Chưng cất tri thức',
    techName: 'distill-v3',
    tier: 'integration',
    priority: 80,
    kind: 'bridge',
    label: 'Tổng hợp và cập nhật kho kiến thức chuyên môn',
    match: (n) => n.startsWith('ap_distill_') || n.startsWith('ap_knowledge_'),
  }),
]);

const GROUP_BY_ID = new Map(ECOSYSTEM_TOOL_GROUPS.map((g) => [g.id, g]));
const STANDARD_BOTROOM_IDS = ['scroll-core', 'river-cua', 'dragon-browser', 'doc-colab', 'mixer', 'river-ask'];

/**
 * Classifies a tool descriptor using declarative metadata FIRST (`tool.group`,
 * `tool.tier`, `tool.displayName`, `tool.summary`), falling back to SCROLL's
 * canonical ecosystem namespace map.
 */
export function classifyToolDescriptor(tool) {
  const name = typeof tool === 'string' ? tool : String(tool?.name || '').trim();
  if (!name) return null;
  const declaredGroupId = typeof tool === 'object' && tool?.group ? String(tool.group).trim() : null;
  if (declaredGroupId && GROUP_BY_ID.has(declaredGroupId)) {
    const base = GROUP_BY_ID.get(declaredGroupId);
    return {
      ...base,
      name: (typeof tool === 'object' && tool.groupName) ? String(tool.groupName) : base.name,
      label: (typeof tool === 'object' && tool.groupSummary) ? String(tool.groupSummary) : base.label,
      declared: true,
    };
  }
  if (declaredGroupId) {
    return {
      id: declaredGroupId,
      name: (typeof tool === 'object' && tool.groupName) ? String(tool.groupName) : declaredGroupId,
      techName: (typeof tool === 'object' && tool.techName) ? String(tool.techName) : declaredGroupId,
      tier: (typeof tool === 'object' && tool.tier === 'botroom') ? 'botroom' : 'integration',
      priority: 90,
      kind: (typeof tool === 'object' && tool.kind) ? String(tool.kind) : 'bridge',
      label: (typeof tool === 'object' && tool.groupSummary) ? String(tool.groupSummary) : String(tool?.description || declaredGroupId),
      declared: true,
    };
  }
  const matched = ECOSYSTEM_TOOL_GROUPS.find((g) => g.match(name));
  if (matched) return { ...matched, declared: false };
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
        tier: 'integration',
        label: cfg?.url || [cfg?.command, ...(Array.isArray(cfg?.args) ? cfg.args : [])].filter(Boolean).join(' ') || 'Pack MCP',
        source: 'pack-mcp',
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
          tier: 'integration',
          label: 'SCROLL mcp.lock.json',
          source: 'pack-mcp',
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

export function describeToolCatalog({
  runtimeTools = null,
  packDir = null,
  companionTools = [],
  companionEnabled = false,
  companionOnline = false,
  deviceId = null,
  visibleSkills = [],
  ignoreToolNames = ['system_action_run', 'companion_read_media'],
} = {}) {
  const ignoreSet = new Set(ignoreToolNames);
  const coreTools = Array.isArray(runtimeTools) && runtimeTools.length
    ? runtimeTools.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
    : ['automations', 'send_chat_media', 'memory_recent_chats', 'memory_search', 'knowledge_read', 'skill_view'];

  const coreSpec = GROUP_BY_ID.get('scroll-core');
  const runtime = [
    {
      id: 'runtime:scroll-core',
      groupId: 'scroll-core',
      name: coreSpec.name,
      techName: coreSpec.techName,
      tier: 'botroom',
      label: coreSpec.label,
      source: 'runtime-mcp',
      deviceId: null,
      status: 'online',
      toolsCount: coreTools.length,
      tools: coreTools,
    },
  ];

  const buckets = new Map();
  const unclassifiedTools = [];
  for (const t of Array.isArray(companionTools) ? companionTools : []) {
    const name = typeof t === 'string' ? t : String(t?.name || '').trim();
    if (!name || ignoreSet.has(name)) continue;
    const grp = classifyToolDescriptor(t);
    if (grp) {
      if (!buckets.has(grp.id)) buckets.set(grp.id, { ...grp, tools: [] });
      const b = buckets.get(grp.id);
      if (!b.tools.includes(name)) b.tools.push(name);
    } else {
      unclassifiedTools.push(name);
    }
  }

  const companion = [...buckets.values()]
    .sort((a, b) => (a.tier === b.tier ? a.priority - b.priority : a.tier === 'botroom' ? -1 : 1))
    .map((b) => ({
      id: `companion:${b.id}`,
      groupId: b.id,
      name: b.name,
      techName: b.techName || b.id,
      tier: b.tier || 'integration',
      label: b.label,
      source: b.kind === 'mcp' ? 'companion-mcp' : 'companion-bridge',
      deviceId: deviceId || null,
      status: companionOnline ? 'online' : 'offline',
      toolsCount: b.tools.length,
      tools: b.tools,
    }));

  if (unclassifiedTools.length > 0) {
    companion.push({
      id: 'companion:other',
      groupId: 'other',
      name: 'Công cụ máy tính khác',
      techName: 'companion-tools',
      tier: 'integration',
      label: 'Công cụ bổ sung chưa khai báo nhóm từ máy tính đang kết nối',
      source: 'companion-bridge',
      deviceId: deviceId || null,
      status: companionOnline ? 'online' : 'offline',
      toolsCount: unclassifiedTools.length,
      tools: unclassifiedTools,
    });
  }

  const pack = introspectPackMcp(packDir);
  const liveByGroup = new Map();
  for (const item of [...runtime, ...companion, ...pack]) {
    if (item.groupId && !liveByGroup.has(item.groupId)) liveByGroup.set(item.groupId, item);
  }

  const hasSkill = (rx) => (Array.isArray(visibleSkills) ? visibleSkills : []).some((s) => rx.test(String(s?.name || '')));
  const botroomDefaults = [];
  for (const stdId of STANDARD_BOTROOM_IDS) {
    const spec = GROUP_BY_ID.get(stdId);
    const live = liveByGroup.get(stdId);
    if (live) {
      botroomDefaults.push({
        ...live,
        name: spec.name,
        techName: spec.techName,
        label: spec.label,
        tier: 'botroom',
      });
    } else if (stdId === 'doc-colab' && hasSkill(/doc[-_]?colab/i)) {
      botroomDefaults.push({
        id: 'botroom:doc-colab',
        groupId: 'doc-colab',
        name: spec.name,
        techName: spec.techName,
        tier: 'botroom',
        label: spec.label,
        source: 'skill',
        deviceId: null,
        status: 'online',
        toolsCount: 1,
        tools: ['doc-colab'],
      });
    } else {
      botroomDefaults.push({
        id: `botroom:${stdId}`,
        groupId: stdId,
        name: spec.name,
        techName: spec.techName,
        tier: 'botroom',
        label: spec.label,
        source: spec.requiresCompanion ? 'companion-bridge' : 'scroll-ecosystem',
        deviceId: deviceId || null,
        status: spec.requiresCompanion && (!companionEnabled || !companionOnline) ? 'standby' : 'not_connected',
        toolsCount: 0,
        tools: [],
      });
    }
  }

  const defaultIdSet = new Set(STANDARD_BOTROOM_IDS);
  const integrations = [
    ...companion.filter((c) => !defaultIdSet.has(c.groupId)),
    ...pack.filter((p) => !defaultIdSet.has(p.groupId)),
  ];

  return {
    runtime,
    pack,
    companion,
    botroomDefaults,
    integrations,
    unclassifiedTools,
  };
}

// ── 4. Scientific Capability Gap Analyzer ─────────────────────────────────────
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

// ── 5. Effective Model Inheritance Resolver ───────────────────────────────────
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

// ── 6. Canonical Host Snapshot Assembler (`scroll-introspection/v1`) ──────────
export function describeHostSnapshot({
  hostStatus = {},
  runtime = null,
  workspace = null,
  packsDir = null,
  overrides = null,
  weights = null,
  groupPolicyOverride = null,
  botUsername = null,
  remoteMcpServers = [],
  companion = null,
  availableCompanions = [],
  extraRuntimeTools = null,
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
  if (activePack?.packDir) {
    const manifest = readJsonSafe(path.join(activePack.packDir, 'pack.manifest.json'), null);
    if (Array.isArray(manifest?.domainPacks)) {
      domainPacks = manifest.domainPacks.map((dp) => ({
        id: String(dp.id || ''),
        version: String(dp.version || ''),
        fileCount: Number(dp.fileCount || 0),
      }));
    }
  }

  let skillsReport = { sources: [], visible: [], gated: [], invalid: [] };
  const sr = chatRt?.skills;
  if (sr && typeof sr.report === 'function') {
    try {
      const rep = sr.report();
      skillsReport = {
        sources: Array.isArray(rep?.sources) ? rep.sources : [],
        visible: Array.isArray(rep?.visible)
          ? rep.visible.map((s) => ({
              name: s.name,
              description: String(s.description || '').slice(0, 180),
              source: s.source || 'pack',
              pinned: pinnedSet.has(s.name),
              state: s.state || 'ready',
              security: s.security || 'clean',
              compat: s.compat || 'native',
              requires: Array.isArray(s.requires) ? s.requires : [],
            }))
          : [],
        gated: Array.isArray(rep?.gated)
          ? rep.gated.map((s) => ({
              name: s.name,
              source: s.source || 'pack',
              state: s.state || 'gated',
              reason: s.reason || '',
              unmet: Array.isArray(s.unmet) ? s.unmet : [],
              security: s.security || 'clean',
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

  const compInfo = companion && typeof companion === 'object' ? companion : { enabled: false, deviceId: null, online: false, tools: [] };
  const compTools = Array.isArray(compInfo.tools) ? compInfo.tools : [];
  const mcpInventory = describeToolCatalog({
    runtimeTools: extraRuntimeTools,
    packDir: activePack?.packDir || null,
    companionTools: compInfo.enabled ? compTools : [],
    companionEnabled: Boolean(compInfo.enabled),
    companionOnline: Boolean(compInfo.online),
    deviceId: compInfo.deviceId || null,
    visibleSkills: skillsReport.visible,
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

  const personality = describePersonality(weights);
  const layeredKb = workspace?.getLayeredKnowledge ? workspace.getLayeredKnowledge() : null;

  return {
    schema: 'scroll-introspection/v1',
    scrollVersion: scrollVersion || null,
    enabled: true,
    ...hostStatus,
    identity,
    effectiveModel,
    lastTurnRouting: lastTurnRouting || null,
    recentTurnRoutings: Array.isArray(recentTurnRoutings) ? recentTurnRoutings : [],
    channels,
    personality,
    domainPacks,
    skillsReport,
    mcpInventory,
    capabilityGaps,
    companion: {
      enabled: Boolean(compInfo.enabled),
      deviceId: compInfo.deviceId || null,
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

// ── 7. Automated Zero-Drift Parity Gate (`verifyIntrospectionParity`) ─────────
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
      schema: 'scroll-parity-report/v1',
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

  // 2. Zero unclassified live Companion tools
  const unclassified = snapshot.mcpInventory?.unclassifiedTools || [];
  if (unclassified.length === 0) {
    pass('tools.classified', `All live tools classified cleanly (${snapshot.companion?.toolCount || 0} companion tools)`);
  } else {
    fail('tools.classified', `Unclassified tools fell into 'other': ${unclassified.join(', ')}`);
  }

  // 3. Zero duplicate group IDs between botroomDefaults and integrations
  const defIds = new Set((snapshot.mcpInventory?.botroomDefaults || []).map((x) => x.groupId));
  const overlap = (snapshot.mcpInventory?.integrations || []).filter((x) => x.groupId && defIds.has(x.groupId));
  if (overlap.length === 0) {
    pass('tools.no_duplicates', `${defIds.size} Bot Room defaults + ${(snapshot.mcpInventory?.integrations || []).length} integrations (0 overlap)`);
  } else {
    fail('tools.no_duplicates', `Duplicate tool groups across defaults & integrations: ${overlap.map((x) => x.groupId).join(', ')}`);
  }

  // 4. Effective model & escalation provenance present
  const em = snapshot.effectiveModel;
  if (em && em.primary && em.primarySource && em.escalationSource) {
    pass('model.resolved', `primary=${em.primary} (${em.primarySource}), fallback=${em.fallback || 'none'} (${em.fallbackSource}), escalation=${em.escalation}`);
  } else {
    fail('model.resolved', 'Missing effectiveModel provenance');
  }

  // 5. Channel trigger labels extracted when pack has mention patterns
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

  // 6. Zero invalid skills
  const invSkills = snapshot.skillsReport?.invalid || [];
  if (invSkills.length === 0) {
    pass('skills.valid', `${(snapshot.skillsReport?.visible || []).length} visible, ${(snapshot.skillsReport?.gated || []).length} gated, 0 invalid`);
  } else {
    fail('skills.valid', `Invalid skills: ${invSkills.map((s) => s.name).join(', ')}`);
  }

  // 7. Personality schema & polarity parity
  const pers = snapshot.personality;
  if (pers?.schema === 'scroll-personality/v1' && pers.displayTraits?.openness >= 1 && pers.displayTraits?.openness <= 5) {
    pass('personality.schema', `preset=${pers.preset}, reserve=${pers.traits?.reserve} -> openness=${pers.displayTraits.openness}/5`);
  } else {
    fail('personality.schema', 'Personality schema or openness polarity projection missing');
  }

  // 8. Companion online health notice (warning only, not a failure when opt-in disabled)
  if (snapshot.companion?.enabled && !snapshot.companion?.online) {
    warn('companion.online', `Companion ${snapshot.companion.deviceId || ''} is enabled but currently offline`);
  } else {
    pass('companion.online', snapshot.companion?.enabled ? `Companion ${snapshot.companion.deviceId} online` : 'Companion disabled (cloud-only)');
  }

  return {
    ok: failures.length === 0,
    schema: 'scroll-parity-report/v1',
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
