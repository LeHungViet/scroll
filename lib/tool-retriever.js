// SCROLL 2.5 -- §47.2 Zero-Dependency Deterministic Tool Retriever, Host JSON Schema Validator,
// and Frozen `<available_tools>` Region A Catalog Builder.
//
// Designed for strict §13 Prompt Cache invariance:
//   - Catalog C (deployment-frozen, speaker-independent) renders `<available_tools>` once.
//   - Visible V (per-turn volatile) filters `tool_search` results inside Region C.
//   - Executable E (per-call) unwraps `tool_invoke`, validates args via `validateToolArgs`,
//     checks `schemaHash` against pinned lockfile, and routes through `executeTool()`.
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import crypto from 'node:crypto';
import { foldAscii } from './knowledge.js';
import { canonicalJson } from './chat-telemetry.js';

const TOOL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'over', 'under',
  'your', 'their', 'about', 'using', 'used', 'tool', 'tools', 'function', 'call', 'get',
  'set', 'run', 'use', 'return', 'returns', 'data', 'info', 'information', 'object',
  'cua', 'cho', 'voi', 'trong', 'ngoai', 'nay', 'kia', 'mot', 'cac', 'nhung', 'duoc',
]);

// Compact bilingual English/Vietnamese operational synonym groups (pure ASCII after foldAscii)
const SYNONYM_GROUPS = [
  ['search', 'find', 'lookup', 'query', 'tim', 'tra', 'kiem'],
  ['read', 'view', 'show', 'inspect', 'fetch', 'doc', 'xem', 'lay'],
  ['write', 'create', 'add', 'insert', 'new', 'tao', 'them', 'ghi'],
  ['update', 'edit', 'modify', 'patch', 'change', 'sua', 'cap', 'doi'],
  ['delete', 'remove', 'erase', 'forget', 'drop', 'xoa', 'huy', 'bo'],
  ['send', 'post', 'notify', 'message', 'reply', 'gui', 'nhan', 'bao'],
  ['mail', 'email', 'inbox', 'gmail', 'outlook', 'thu'],
  ['calendar', 'schedule', 'cron', 'reminder', 'meeting', 'event', 'lich', 'hen', 'nhac'],
  ['browser', 'web', 'page', 'tab', 'click', 'screenshot', 'dom', 'trinh', 'duyet', 'trang'],
  ['deploy', 'release', 'build', 'service', 'server', 'logs', 'trien', 'khai'],
  ['file', 'folder', 'dir', 'directory', 'path', 'document', 'tep', 'thu', 'muc'],
  ['memory', 'remember', 'fact', 'lesson', 'note', 'nho', 'ky', 'uc', 'bai', 'hoc'],
  ['refund', 'invoice', 'payment', 'bill', 'order', 'price', 'hoan', 'tien', 'hoa', 'don', 'gia'],
  ['issue', 'ticket', 'task', 'bug', 'pull', 'request', 'repo', 'commit', 'branch', 'viec'],
  ['database', 'db', 'table', 'sql', 'record', 'row', 'notion', 'page', 'bang'],
  ['photo', 'image', 'picture', 'camera', 'screen', 'anh', 'hinh', 'chup'],
  ['shell', 'exec', 'command', 'terminal', 'bash', 'script', 'lenh', 'chay'],
];

const SYNONYM_MAP = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const term of group) {
    const existing = SYNONYM_MAP.get(term) || new Set();
    for (const peer of group) {
      if (peer !== term) existing.add(peer);
    }
    SYNONYM_MAP.set(term, existing);
  }
}

export function tokenizeIdentifier(text) {
  const split = String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._:/-]+/g, ' ');
  return (foldAscii(split).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length >= 2 && !TOOL_STOPWORDS.has(t));
}

function makeBigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function sanitizeInline(text, maxLen = 80) {
  const cleaned = String(text ?? '')
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, Math.max(8, maxLen - 3)).trim() + '...';
}

function firstSentence(text, maxLen = 80) {
  const s = sanitizeInline(text, maxLen * 2);
  const dot = s.search(/[.!?](?:\s|$)/);
  const base = dot > 8 && dot < maxLen ? s.slice(0, dot + 1) : s;
  return sanitizeInline(base, maxLen);
}

export function computeSchemaHash({ name, description = '', parameters = {} } = {}) {
  return crypto.createHash('sha256')
    .update(canonicalJson({
      name: String(name || ''),
      description: String(description || ''),
      parameters: parameters || { type: 'object', properties: {} },
    }))
    .digest('hex')
    .slice(0, 24);
}

export function computeDescHash(description = '') {
  return crypto.createHash('sha256').update(String(description || '')).digest('hex').slice(0, 16);
}

// ── Zero-Dep Host JSON Schema Subset Validator (for `tool_invoke` safety) ──────
function matchesType(val, expected) {
  if (Array.isArray(expected)) return expected.some((t) => matchesType(val, t));
  if (expected === 'null') return val === null;
  if (expected === 'array') return Array.isArray(val);
  if (expected === 'object') return val !== null && typeof val === 'object' && !Array.isArray(val);
  if (expected === 'integer') return typeof val === 'number' && Number.isInteger(val);
  if (expected === 'number') return typeof val === 'number' && Number.isFinite(val);
  if (expected === 'string') return typeof val === 'string';
  if (expected === 'boolean') return typeof val === 'boolean';
  return true;
}

export function validateToolArgs(args, schema = {}, pathPrefix = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { ok: true, errors };

  const val = args;
  if (schema.type && !matchesType(val, schema.type)) {
    errors.push(`${pathPrefix}: expected type ${JSON.stringify(schema.type)}, got ${val === null ? 'null' : (Array.isArray(val) ? 'array' : typeof val)}`);
    return { ok: false, errors };
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(val)) {
    errors.push(`${pathPrefix}: value must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof val === 'string') {
    if (typeof schema.minLength === 'number' && val.length < schema.minLength) {
      errors.push(`${pathPrefix}: length ${val.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && val.length > schema.maxLength) {
      errors.push(`${pathPrefix}: length ${val.length} > maxLength ${schema.maxLength}`);
    }
  }
  if (typeof val === 'number') {
    if (typeof schema.minimum === 'number' && val < schema.minimum) {
      errors.push(`${pathPrefix}: ${val} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && val > schema.maximum) {
      errors.push(`${pathPrefix}: ${val} > maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(val) && schema.items && typeof schema.items === 'object') {
    for (let i = 0; i < val.length; i++) {
      const sub = validateToolArgs(val[i], schema.items, `${pathPrefix}[${i}]`);
      if (!sub.ok) errors.push(...sub.errors);
    }
  }
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (val[req] === undefined) {
          errors.push(`${pathPrefix}.${req}: required property missing`);
        }
      }
    }
    for (const [k, v] of Object.entries(val)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        const sub = validateToolArgs(v, props[k], `${pathPrefix}.${k}`);
        if (!sub.ok) errors.push(...sub.errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pathPrefix}.${k}: unknown property not allowed`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── Extract Parameter & Enum Tokens for Multi-Field BM25F ──────────────────────
function extractParamTokens(schema) {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const [key, def] of Object.entries(props)) {
    out.push(...tokenizeIdentifier(key));
    if (def && typeof def === 'object') {
      if (def.description) out.push(...tokenizeIdentifier(def.description));
      if (Array.isArray(def.enum)) {
        for (const e of def.enum) out.push(...tokenizeIdentifier(String(e)));
      }
      if (def.properties && typeof def.properties === 'object') {
        for (const subKey of Object.keys(def.properties)) out.push(...tokenizeIdentifier(subKey));
      }
    }
  }
  return out;
}

function inferNamespace(tool) {
  if (tool.namespace) return String(tool.namespace);
  if (tool.server) return `mcp.${tool.server}`;
  const m = /^mcp\.([^.]+)\./.exec(String(tool.name || ''));
  if (m) return `mcp.${m[1]}`;
  return 'builtin';
}

function inferShortName(tool) {
  const n = String(tool.name || '');
  const parts = n.split('.');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('.') : n;
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Multi-Field Weighted BM25F Tool Retriever ──────────────────────────────────
export function buildToolRetriever(toolsList = [], { embedFn = null } = {}) {
  const docs = (toolsList || []).map((t) => {
    const ns = inferNamespace(t);
    const shortName = inferShortName(t);
    const nameTokens = tokenizeIdentifier(`${t.name} ${shortName}`);
    const nsTagTokens = tokenizeIdentifier(`${ns} ${(Array.isArray(t.tags) ? t.tags.join(' ') : '')}`);
    const paramTokens = extractParamTokens(t.parameters);
    const descTokens = tokenizeIdentifier(`${t.shortDescription || ''} ${t.description || ''}`);

    const fieldTf = (arr) => {
      const map = new Map();
      for (const tok of arr) map.set(tok, (map.get(tok) || 0) + 1);
      return map;
    };
    const allTerms = new Set([...nameTokens, ...nsTagTokens, ...paramTokens, ...descTokens]);
    return {
      tool: t,
      nameLower: String(t.name || '').toLowerCase(),
      shortLower: shortName.toLowerCase(),
      namespace: ns,
      nameTf: fieldTf(nameTokens),
      nameLen: nameTokens.length || 1,
      nsTf: fieldTf(nsTagTokens),
      nsLen: nsTagTokens.length || 1,
      paramTf: fieldTf(paramTokens),
      paramLen: paramTokens.length || 1,
      descTf: fieldTf(descTokens),
      descLen: descTokens.length || 1,
      nameBigrams: new Set(makeBigrams(nameTokens)),
      descBigrams: new Set(makeBigrams([...nameTokens, ...descTokens])),
      allTerms,
    };
  });

  const N = Math.max(1, docs.length);
  const df = new Map();
  let sumName = 0, sumNs = 0, sumParam = 0, sumDesc = 0;
  for (const d of docs) {
    sumName += d.nameLen;
    sumNs += d.nsLen;
    sumParam += d.paramLen;
    sumDesc += d.descLen;
    for (const term of d.allTerms) df.set(term, (df.get(term) || 0) + 1);
  }
  const avgName = sumName / N;
  const avgNs = sumNs / N;
  const avgParam = sumParam / N;
  const avgDesc = sumDesc / N;

  const idf = (term) => Math.log(1 + (N - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
  const bm25Field = (tf, len, avgLen, k1 = 1.5, b = 0.75) => {
    if (!tf) return 0;
    return (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / Math.max(1, avgLen))));
  };

  let cachedDocVectors = null;

  function scoreOneQuery(doc, rawQuery) {
    const qLower = String(rawQuery || '').trim().toLowerCase();
    if (!qLower) return 0;
    let score = 0;
    if (doc.nameLower === qLower || doc.shortLower === qLower) {
      score += 14.0;
    } else if (doc.nameLower.includes(qLower) && qLower.length >= 3) {
      score += 6.0;
    }

    const qTokens = tokenizeIdentifier(rawQuery);
    const expanded = new Set();
    for (const qt of qTokens) {
      const w = idf(qt);
      score += 3.0 * w * bm25Field(doc.nameTf.get(qt) || 0, doc.nameLen, avgName);
      score += 2.2 * w * bm25Field(doc.nsTf.get(qt) || 0, doc.nsLen, avgNs);
      score += 1.4 * w * bm25Field(doc.paramTf.get(qt) || 0, doc.paramLen, avgParam);
      score += 1.0 * w * bm25Field(doc.descTf.get(qt) || 0, doc.descLen, avgDesc);
      const syns = SYNONYM_MAP.get(qt);
      if (syns) {
        for (const s of syns) {
          if (!qTokens.includes(s)) expanded.add(s);
        }
      }
    }
    for (const syn of expanded) {
      const w = idf(syn) * 0.55;
      score += 2.0 * w * bm25Field(doc.nameTf.get(syn) || 0, doc.nameLen, avgName);
      score += 1.0 * w * bm25Field(doc.descTf.get(syn) || 0, doc.descLen, avgDesc);
    }

    const qBigrams = makeBigrams(qTokens);
    for (const bg of qBigrams) {
      if (doc.nameBigrams.has(bg)) score += 3.0;
      else if (doc.descBigrams.has(bg)) score += 1.6;
    }
    return score;
  }

  function search({
    query = '',
    queries = null,
    namespace = null,
    risk = 'all',
    limit = 5,
    filterFn = null,
  } = {}) {
    const queryList = Array.isArray(queries) && queries.length
      ? queries.map(String).filter((s) => s.trim())
      : (String(query || '').trim() ? [String(query).trim()] : []);
    const cap = Math.min(10, Math.max(1, Number(limit || 5)));
    const nsFilter = namespace ? String(namespace).toLowerCase() : null;

    const scored = [];
    for (const d of docs) {
      if (nsFilter && d.namespace.toLowerCase() !== nsFilter && !d.namespace.toLowerCase().endsWith(`.${nsFilter}`)) {
        continue;
      }
      if (risk === 'read_only' && d.tool.tier !== 'read_only') continue;
      if (risk === 'write' && d.tool.tier === 'read_only') continue;
      if (typeof filterFn === 'function' && !filterFn(d.tool)) continue;

      let best = 0;
      if (!queryList.length) {
        best = 0.01;
      } else {
        for (const q of queryList) {
          const s = scoreOneQuery(d, q);
          if (s > best) best = s;
        }
      }
      if (best > 0) {
        scored.push({ doc: d, score: best });
      }
    }

    scored.sort((a, b) => (b.score - a.score) || a.doc.nameLower.localeCompare(b.doc.nameLower));
    const namespaces = [...new Set(docs.filter((d) => !filterFn || filterFn(d.tool)).map((d) => d.namespace))].sort();
    return {
      queries: queryList,
      totalMatches: scored.length,
      availableNamespaces: namespaces,
      hits: scored.slice(0, cap).map(({ doc, score }) => ({
        score: Number(score.toFixed(3)),
        namespace: doc.namespace,
        ...doc.tool,
      })),
    };
  }

  async function searchAsync(opts = {}) {
    const lex = search(opts);
    if (typeof embedFn !== 'function' || !docs.length) return lex;
    const qText = Array.isArray(opts.queries) && opts.queries.length
      ? opts.queries.join(' | ')
      : String(opts.query || '').trim();
    if (!qText) return lex;

    try {
      if (!cachedDocVectors) {
        const texts = docs.map((d) => `${d.tool.name} ${d.namespace} ${d.tool.shortDescription || d.tool.description || ''}`);
        cachedDocVectors = await embedFn(texts);
      }
      const [qVec] = await embedFn([qText]);
      if (!Array.isArray(qVec) || !Array.isArray(cachedDocVectors)) return lex;

      const lexByName = new Map(lex.hits.map((h) => [h.name, h.score]));
      const maxLex = Math.max(1, ...lex.hits.map((h) => h.score));
      const fused = [];
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        if (typeof opts.filterFn === 'function' && !opts.filterFn(d.tool)) continue;
        const lScore = (lexByName.get(d.tool.name) || 0) / maxLex;
        const sScore = Math.max(0, cosineSim(qVec, cachedDocVectors[i]));
        const score = 0.65 * lScore + 0.35 * sScore;
        if (score > 0.08) fused.push({ doc: d, score });
      }
      fused.sort((a, b) => (b.score - a.score) || a.doc.nameLower.localeCompare(b.doc.nameLower));
      const cap = Math.min(10, Math.max(1, Number(opts.limit || 5)));
      return {
        ...lex,
        totalMatches: fused.length,
        hits: fused.slice(0, cap).map(({ doc, score }) => ({
          score: Number(score.toFixed(3)),
          namespace: doc.namespace,
          ...doc.tool,
        })),
      };
    } catch {
      return lex;
    }
  }

  return {
    count: docs.length,
    search,
    searchAsync,
  };
}

// ── Frozen `<available_tools>` Region A Renderer (§13 Cache-Safe, ≤ 1,500 tok) ─
export function buildAvailableToolsIndex(deferredTools = [], {
  maxIndexTokens = 1500,
  namespaceDescriptions = {},
} = {}) {
  const sorted = [...(deferredTools || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!sorted.length) {
    return { text: '', hash: 'empty', deferredCount: 0, estimatedTokens: 0, tier: 'none' };
  }

  const byNs = new Map();
  for (const t of sorted) {
    const ns = inferNamespace(t);
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(t);
  }
  const nsKeys = [...byNs.keys()].sort();
  const maxChars = Math.max(800, Number(maxIndexTokens || 1500) * 4);

  const headerLine = 'Additional tools are loaded on demand. Call tool_search({ queries: [...] }) to inspect exact parameter schemas, then call tool_invoke({ name, arguments }).';

  const renderTier = (mode) => {
    const lines = [headerLine];
    for (const ns of nsKeys) {
      const list = byNs.get(ns);
      const nsDesc = namespaceDescriptions[ns] ? ` -- ${sanitizeInline(namespaceDescriptions[ns], 80)}` : '';
      if (mode === 'detailed') {
        lines.push(`## ${sanitizeInline(ns, 48)} (${list.length})${nsDesc}`);
        for (const t of list) {
          const desc = t.shortDescription ? sanitizeInline(t.shortDescription, 80) : firstSentence(t.description || '', 80);
          lines.push(`- ${sanitizeInline(t.name, 64)}: ${desc}`);
        }
      } else if (mode === 'compact') {
        lines.push(`## ${sanitizeInline(ns, 48)} (${list.length} tools)${nsDesc}`);
        const reads = list.filter((x) => x.tier === 'read_only').map((x) => inferShortName(x));
        const writes = list.filter((x) => x.tier !== 'read_only').map((x) => inferShortName(x));
        if (reads.length) {
          const head = reads.slice(0, 4).join(', ');
          lines.push(`  read: ${head}${reads.length > 4 ? ` (+${reads.length - 4})` : ''}`);
        }
        if (writes.length) {
          const head = writes.slice(0, 4).join(', ');
          lines.push(`  write: ${head}${writes.length > 4 ? ` (+${writes.length - 4})` : ''}`);
        }
      } else {
        const keywords = [...new Set(list.flatMap((t) => tokenizeIdentifier(inferShortName(t))).slice(0, 8))].join(', ');
        lines.push(`- ${sanitizeInline(ns, 48)} (${list.length} tools)${nsDesc || (keywords ? `: ${keywords}` : '')}`);
      }
    }
    return lines.join('\n');
  };

  let chosenTier = sorted.length <= 40 ? 'detailed' : (sorted.length <= 150 ? 'compact' : 'namespace');
  let body = renderTier(chosenTier);
  if (body.length > maxChars && chosenTier === 'detailed') {
    chosenTier = 'compact';
    body = renderTier(chosenTier);
  }
  if (body.length > maxChars && chosenTier === 'compact') {
    chosenTier = 'namespace';
    body = renderTier(chosenTier);
  }
  if (body.length > maxChars) {
    body = body.slice(0, maxChars - 36).trim() + '\n... (use tool_search to explore)';
  }

  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  const text = `<available_tools snapshot="${hash}" deferred="${sorted.length}">\n${body}\n</available_tools>`;
  return {
    text,
    hash,
    deferredCount: sorted.length,
    estimatedTokens: Math.ceil(text.length / 4),
    tier: chosenTier,
  };
}
