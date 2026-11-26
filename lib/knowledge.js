// SCROLL — deployment knowledge indexer & retriever (v1.10 §44).
//
// Why: large deployment knowledge bases (manuals, SOPs, tariffs, FAQs) cannot be dumped raw into
// every prompt — full-dump multiplies token cost and weakens reply grounding through cross-document
// number collisions. This module provides deterministic, zero-dependency section chunking and
// hybrid lexical retrieval (Unicode-folded BM25 + heading boost + bigram boost + exact code boost)
// over the deployment-root `knowledge/` folder (outside `agents/`, per §41).
//
// Pure ASCII source, zero dependencies, Node >= 20.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const KNOWLEDGE_DEFAULTS = {
  dir: 'knowledge',
  maxChunkChars: 1600,
  topK: 4,
  maxChars: 6000,
  extensions: ['.md', '.txt'],
  structuredExtensions: ['.bitemporal.jsonl', '.records.jsonl'],
  defaultVisibility: 'public',
};

export const KNOWLEDGE_VISIBILITY_LEVELS = Object.freeze(['public', 'internal', 'owner_only']);
const VISIBILITY_RANK = { public: 0, internal: 1, owner_only: 2 };
const AUDIENCE_MAX_RANK = { external: 0, internal: 1, owner: 2 };

export function normalizeVisibility(raw, fallback = 'public') {
  const s = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'public' || s === 'guest' || s === 'external') return 'public';
  if (s === 'internal' || s === 'team' || s === 'staff') return 'internal';
  if (s === 'owner_only' || s === 'owner' || s === 'private' || s === 'secret') return 'owner_only';
  return VISIBILITY_RANK[fallback] != null ? fallback : 'public';
}

export function isVisibilityAllowed(docVisibility, audience = 'owner') {
  const docRank = VISIBILITY_RANK[normalizeVisibility(docVisibility, 'public')] ?? 0;
  const maxRank = AUDIENCE_MAX_RANK[String(audience || 'owner').trim().toLowerCase()] ?? 0;
  return docRank <= maxRank;
}

export function resolveTurnKnowledgeAudience(turnClassification = null, sender = null) {
  const isOwnerFlag = sender?.isOwner === true;
  if (!turnClassification || typeof turnClassification !== 'object') {
    return isOwnerFlag ? 'owner' : 'external';
  }
  const isGroup = Boolean(turnClassification.isGroup);
  const roles = Array.isArray(turnClassification.speakerRoles)
    ? turnClassification.speakerRoles.map((r) => String(r || '').trim().toLowerCase())
    : [];
  const singleRole = String(turnClassification.speakerRole || turnClassification.person?.role || '').trim().toLowerCase();
  const isOwner = isOwnerFlag || singleRole === 'owner' || roles.includes('owner');

  if (isGroup) {
    // §42 lowest-trust group wall: external/mixed groups only see public; internal-only team groups cap at internal (never owner_only)
    if (turnClassification.contentAudience === 'internal') return 'internal';
    return 'external';
  }

  // Private 1-on-1 DM: verified owner (via principal provider or USER.md) sees owner_only
  if (isOwner) return 'owner';
  if (turnClassification.contentAudience === 'internal' || turnClassification.speakerTrust === 'internal') {
    return 'internal';
  }
  return 'external';
}

export function parseKnowledgeFrontmatter(raw) {
  const src = String(raw ?? '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src };
  const head = m[1];
  const body = src.slice(m[0].length);
  const meta = {};
  for (const line of head.split('\n')) {
    const kv = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1].trim();
    let val = kv[2].trim();
    if (!val) continue;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      try { val = JSON.parse(val); } catch { val = val.slice(1, -1); }
    } else if (val.startsWith('[') && val.endsWith(']')) {
      try {
        const arr = JSON.parse(val);
        if (Array.isArray(arr)) val = arr.map((x) => String(x || '').trim()).filter(Boolean);
      } catch {
        val = val.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      }
    }
    meta[key] = val;
  }
  return { meta, body };
}

function isoDateOnly(d) {
  if (!d) return null;
  const s = String(d).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function isBiTemporalActive(meta = {}, { asOf = null, knownAt = null } = {}) {
  const refAsOf = isoDateOnly(asOf);
  const refKnown = isoDateOnly(knownAt);
  if (refAsOf) {
    const vf = isoDateOnly(meta.validFrom || meta.valid_from);
    const vt = isoDateOnly(meta.validTo || meta.valid_to);
    if (vf && refAsOf < vf) return false;
    if (vt && refAsOf >= vt) return false;
  }
  if (refKnown) {
    const kf = isoDateOnly(meta.knownFrom || meta.known_from);
    const kt = isoDateOnly(meta.knownTo || meta.known_to);
    if (kf && refKnown < kf) return false;
    if (kt && refKnown >= kt) return false;
  }
  return true;
}

export function computeFreshness(meta = {}, { nowDate = null } = {}) {
  const ttlDays = Number(meta.ttlDays ?? meta.ttl_days ?? 0);
  const obs = isoDateOnly(meta.lastConfirmedAt || meta.last_confirmed_at || meta.observedAt || meta.observed_at);
  if (!ttlDays || !obs) return { hasTtl: false, stale: false, ageDays: null, weight: 1.0 };
  const refIso = isoDateOnly(nowDate) || new Date().toISOString().slice(0, 10);
  const ageDays = Math.floor((Date.parse(`${refIso}T00:00:00Z`) - Date.parse(`${obs}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(ageDays)) return { hasTtl: true, stale: false, ageDays: null, weight: 1.0 };
  if (ageDays > ttlDays) return { hasTtl: true, stale: true, ageDays, weight: 0.35 };
  return { hasTtl: true, stale: false, ageDays: Math.max(0, ageDays), weight: 1.0 };
}

// Pure mathematical Weighted Reciprocal Rank Fusion (RRF) for pluggable hybrid retrieval.
export function fuseRankings(rankings = [], { k = 60 } = {}) {
  const rrfK = Math.max(1, Number(k || 60));
  const scores = new Map();
  for (const entry of rankings) {
    if (!entry || !Array.isArray(entry.rankedIds)) continue;
    const weight = Number(entry.weight ?? 1.0);
    if (!(weight > 0)) continue;
    for (let idx = 0; idx < entry.rankedIds.length; idx++) {
      const id = String(entry.rankedIds[idx]);
      scores.set(id, (scores.get(id) || 0) + weight / (rrfK + idx + 1));
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score: +score.toFixed(6) }))
    .sort((a, b) => b.score - a.score);
}

// Fold diacritics to ASCII so accented languages match cleanly without non-ASCII literals in code
export function foldAscii(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D');
}

// Common English + unambiguous ASCII-folded Vietnamese function words (pure ASCII).
// Avoid words whose ASCII-folded form collides with domain nouns (e.g. hoi=hoi nghi,
// bao=bao gia, thu=thu cung/phu thu, nha=nha hang, sao=5 sao, da=da).
const STOPWORDS = new Set([
  'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'not', 'can', 'you',
  'your', 'have', 'has', 'had', 'will', 'would', 'should', 'could', 'about', 'into', 'when', 'what',
  'where', 'which', 'how', 'who', 'why', 'please', 'thanks', 'thank',
  'va', 'cua', 'cho', 'voi', 'trong', 'nhung', 'cac', 'mot', 'nay', 'khi', 'thi', 'la', 'co',
  'khong', 'duoc', 'de', 'tu', 'den', 'theo', 'hoac', 'neu', 'nhu', 've', 'tai', 'tren', 'duoi',
  'sau', 'truoc', 'anh', 'chi', 'em', 'oi', 'nhe', 'vang', 'toi', 'minh', 'ben',
  'nao', 'nhieu', 'cung', 'thoi',
]);

// Matches alphanumeric codes (SKU-A100, MICE-H2) AND uppercase hyphenated alpha codes (AUR-DLX, FDP-STD)
const CODE_TOKEN_RE = /(?<![A-Za-z0-9_-])(?:(?=[A-Z0-9_-]*\d)(?=[A-Z0-9_-]*[A-Z])[A-Z0-9]{2,}(?:[-_][A-Z0-9]+)*|[A-Z]{2,5}(?:-[A-Z0-9]{2,6})+)(?![A-Za-z0-9_-])/g;

function extractNormalizedAmounts(folded) {
  const out = [];
  // Grouped thousands: 2,250,000 or 2.250.000 -> 2250000
  for (const m of folded.matchAll(/\b(\d{1,3}(?:[.,]\d{3})+)\b/g)) {
    out.push(m[1].replace(/[.,]/g, ''));
  }
  // Million shorthand: 2,25 trieu / 2.25tr / 3,45tr -> 2250000 / 3450000
  for (const m of folded.matchAll(/\b(\d{1,3})(?:[.,](\d{1,2}))?\s*(?:trieu|tr)\b/g)) {
    const val = Math.round(Number(`${m[1]}.${m[2] || '0'}`) * 1_000_000);
    if (Number.isFinite(val) && val >= 100_000) out.push(String(val));
  }
  // Thousand shorthand: 150k / 500k -> 150000 / 500000
  for (const m of folded.matchAll(/\b(\d{1,4})k\b/g)) {
    const val = Number(m[1]) * 1_000;
    if (Number.isFinite(val) && val >= 10_000) out.push(String(val));
  }
  return out;
}

function tokenize(text) {
  const folded = foldAscii(text).toLowerCase();
  const raw = folded.match(/[a-z0-9]+/g) || [];
  const base = raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const amounts = extractNormalizedAmounts(folded);
  return amounts.length ? [...base, ...amounts] : base;
}

function extractCodes(text) {
  const m = String(text ?? '').match(CODE_TOKEN_RE) || [];
  return [...new Set(m.map((c) => c.toUpperCase()))];
}

export function knowledgeConfig({ cwd = process.cwd(), dir = null, config = null } = {}) {
  const k = (config && typeof config.knowledge === 'object' && config.knowledge) ? config.knowledge : {};
  const rawDir = dir || k.dir || KNOWLEDGE_DEFAULTS.dir;
  return {
    cwd,
    dir: path.isAbsolute(rawDir) ? rawDir : path.resolve(cwd, rawDir),
    maxChunkChars: Number(k.max_chunk_chars || KNOWLEDGE_DEFAULTS.maxChunkChars),
    topK: Number(k.top_k || KNOWLEDGE_DEFAULTS.topK),
    maxChars: Number(k.max_chars || KNOWLEDGE_DEFAULTS.maxChars),
    extensions: Array.isArray(k.extensions) && k.extensions.length ? k.extensions : KNOWLEDGE_DEFAULTS.extensions,
    structuredExtensions: Array.isArray(k.structured_extensions) && k.structured_extensions.length
      ? k.structured_extensions
      : KNOWLEDGE_DEFAULTS.structuredExtensions,
  };
}

function readFolderMeta(dir) {
  const metaFile = path.join(dir, '.kb-meta.json');
  if (!fs.existsSync(metaFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function walkKnowledgeFiles(rootDir, extensions, structuredExtensions = [], defaultVisibility = 'public') {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const exts = new Set(extensions.map((e) => String(e).toLowerCase()));
  const sExts = structuredExtensions.map((e) => String(e).toLowerCase());
  (function walk(dir, relBase, inheritedVis) {
    const folderMeta = readFolderMeta(dir);
    const curVis = folderMeta?.visibility ? normalizeVisibility(folderMeta.visibility, inheritedVis) : inheritedVis;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel, curVis);
      else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (sExts.some((se) => lower.endsWith(se))) {
          out.push({ full, rel, folder: relBase, kind: 'structured_jsonl', inheritedVisibility: curVis });
        } else if (exts.has(path.extname(lower))) {
          out.push({ full, rel, folder: relBase, kind: 'text', inheritedVisibility: curVis });
        }
      }
    }
  })(rootDir, '', normalizeVisibility(defaultVisibility, 'public'));
  return out;
}

function normalizeStringList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || '').trim()).filter(Boolean);
}

function formatStructuredRecordText(rec, rel) {
  const id = String(rec.clausePath || rec.clause_path || rec.id || 'record');
  const title = String(rec.title || rec.heading || id);
  const typeTag = String(rec.artifactType || rec.artifact_type || 'standard');
  const tierTag = rec.sourceTier || rec.source_tier ? ` | ${rec.sourceTier || rec.source_tier}` : '';
  const vf = isoDateOnly(rec.validFrom || rec.valid_from);
  const vt = isoDateOnly(rec.validTo || rec.valid_to);
  const dateTag = vf || vt ? ` | valid:${vf || '*'}..${vt || 'open'}` : '';
  const body = String(rec.body || rec.content || rec.text || '').trim();
  const header = `[Source: ${rel} | ${typeTag}${tierTag}${dateTag} | ${id}] ${title}`;
  return body ? `${header}\n${body}` : header;
}

export function indexKnowledge({
  cwd = process.cwd(),
  dir = null,
  config = null,
  maxChunkChars = null,
  records = null,
  normalizer = null,
  defaultVisibility = KNOWLEDGE_DEFAULTS.defaultVisibility,
} = {}) {
  const cfg = knowledgeConfig({ cwd, dir, config });
  const chunkCap = Math.max(400, Number(maxChunkChars || cfg.maxChunkChars));
  const effDefaultVis = normalizeVisibility(defaultVisibility, KNOWLEDGE_DEFAULTS.defaultVisibility);
  const files = walkKnowledgeFiles(cfg.dir, cfg.extensions, cfg.structuredExtensions, effDefaultVis);
  const chunks = [];
  const filesMeta = [];
  const filesByPath = new Map();
  const h = crypto.createHash('sha256');
  let totalBytes = 0;
  let totalWords = 0;
  let totalCorpusChars = 0;

  const tokenizeWithHook = (s) => {
    const base = typeof normalizer === 'function' ? String(normalizer(s) ?? s) : String(s ?? '');
    return tokenize(base);
  };

  const pushStructuredRecord = (rec, rel, idx, inheritedVis = effDefaultVis) => {
    if (!rec || typeof rec !== 'object') return;
    const text = formatStructuredRecordText(rec, rel);
    if (text.length < 20) return;
    const clausePath = String(rec.clausePath || rec.clause_path || rec.id || `${rel}#${idx + 1}`).trim();
    const heading = String(rec.title || rec.heading || clausePath).trim();
    const aliasText = normalizeStringList(rec.aliases || rec.keywords).join(' ');
    const visibility = normalizeVisibility(rec.visibility, inheritedVis);
    const tokens = tokenizeWithHook(`${heading} ${clausePath} ${aliasText} ${text}`);
    const headingTokens = new Set(tokenizeWithHook(`${heading} ${clausePath} ${aliasText}`));
    const codes = new Set([
      ...extractCodes(`${clausePath} ${text}`),
      ...normalizeStringList(rec.codes).map((c) => c.toUpperCase()),
    ]);
    const tf = new Map();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
    const meta = {
      clausePath,
      artifactType: String(rec.artifactType || rec.artifact_type || 'standard'),
      sourceTier: rec.sourceTier || rec.source_tier || null,
      source: rec.source || null,
      sourceUrl: rec.sourceUrl || rec.source_url || null,
      visibility,
      validFrom: isoDateOnly(rec.validFrom || rec.valid_from),
      validTo: isoDateOnly(rec.validTo || rec.valid_to),
      knownFrom: isoDateOnly(rec.knownFrom || rec.known_from),
      knownTo: isoDateOnly(rec.knownTo || rec.known_to),
      observedAt: isoDateOnly(rec.observedAt || rec.observed_at),
      lastConfirmedAt: isoDateOnly(rec.lastConfirmedAt || rec.last_confirmed_at),
      ttlDays: Number(rec.ttlDays ?? rec.ttl_days ?? 0) || 0,
      supersedes: normalizeStringList(rec.supersedes),
      amends: normalizeStringList(rec.amends),
      exceptions: normalizeStringList(rec.exceptions),
      scope: rec.scope && typeof rec.scope === 'object' ? rec.scope : null,
    };
    totalCorpusChars += text.length;
    totalWords += text.split(/\s+/).filter(Boolean).length;
    chunks.push({
      id: String(rec.id || clausePath),
      file: rel,
      folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
      docTitle: heading,
      heading,
      visibility,
      text,
      folded: foldAscii(`${aliasText} ${text}`).toLowerCase(),
      headingFolded: foldAscii(`${heading} ${clausePath} ${aliasText}`).toLowerCase(),
      chars: text.length,
      tokensCount: tokens.length || 1,
      tf,
      headingTokens,
      codes,
      structured: true,
      meta,
    });
  };

  for (const { full, rel, folder, kind, inheritedVisibility } of files) {
    const rawFile = fs.readFileSync(full, 'utf8').replace(/\r\n?/g, '\n');
    const bytes = Buffer.byteLength(rawFile, 'utf8');
    h.update(`${rel}\0${inheritedVisibility}\0`).update(rawFile);
    totalBytes += bytes;

    if (kind === 'structured_jsonl') {
      const startChunks = chunks.length;
      const jsonLines = rawFile.split('\n');
      for (let i = 0; i < jsonLines.length; i++) {
        const line = jsonLines[i].trim();
        if (!line) continue;
        try {
          pushStructuredRecord(JSON.parse(line), rel, i, inheritedVisibility);
        } catch { /* skip malformed jsonl line */ }
      }
      const fMeta = {
        file: rel,
        fullPath: full,
        folder: folder || '',
        title: rel.split('/').pop() || rel,
        visibility: inheritedVisibility,
        kind: 'structured_jsonl',
        bytes,
        chars: rawFile.length,
        chunksCount: chunks.length - startChunks,
        sourceUrl: null,
        sourceType: 'structured',
        syncedAt: null,
        headings: [],
      };
      filesMeta.push(fMeta);
      filesByPath.set(rel, fMeta);
      continue;
    }

    const { meta: fm, body: raw } = parseKnowledgeFrontmatter(rawFile);
    const fileVis = normalizeVisibility(fm.visibility, inheritedVisibility);
    const fileSourceUrl = fm.source_url || fm.sourceUrl || null;
    const fileSourceType = fm.source_type || fm.sourceType || null;
    const fileSyncedAt = fm.synced_at || fm.syncedAt || null;
    const fileValidFrom = isoDateOnly(fm.valid_from || fm.validFrom);
    const fileValidTo = isoDateOnly(fm.valid_to || fm.validTo);

    totalCorpusChars += raw.length;
    totalWords += raw.trim() ? raw.trim().split(/\s+/).length : 0;

    const lines = raw.split('\n');
    const h1Title = (lines.find((l) => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim();
    const docTitle = String(fm.title || h1Title || rel).trim();
    const headings = [];
    const startChunks = chunks.length;

    let curH2 = '';
    let curH3 = '';
    let buf = [];

    const pushChunk = (heading, bodyText) => {
      const clean = bodyText.trim();
      if (!clean || clean.length < 30) return;
      const text = `[Source: ${rel} | ${heading}]\n${clean}`;
      const tokens = tokenizeWithHook(`${docTitle} ${heading} ${clean}`);
      const headingTokens = new Set(tokenizeWithHook(`${docTitle} ${heading}`));
      const codes = new Set(extractCodes(text));
      const tf = new Map();
      for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
      chunks.push({
        id: `${rel}#${chunks.length + 1}`,
        file: rel,
        folder: folder || '',
        docTitle,
        heading,
        visibility: fileVis,
        text,
        folded: foldAscii(text).toLowerCase(),
        headingFolded: foldAscii(`${docTitle} ${heading}`).toLowerCase(),
        chars: text.length,
        tokensCount: tokens.length || 1,
        tf,
        headingTokens,
        codes,
        structured: false,
        meta: {
          clausePath: null,
          artifactType: 'markdown',
          sourceTier: null,
          source: rel,
          sourceUrl: fileSourceUrl,
          sourceType: fileSourceType,
          syncedAt: fileSyncedAt,
          visibility: fileVis,
          validFrom: fileValidFrom,
          validTo: fileValidTo,
          knownFrom: null,
          knownTo: null,
          observedAt: null,
          lastConfirmedAt: null,
          ttlDays: 0,
          supersedes: [],
          amends: [],
          exceptions: [],
          scope: null,
        },
      });
    };

    const flush = () => {
      const body = buf.join('\n').trim();
      if (!body || body.length < 30) return;
      const heading = [curH2, curH3].filter(Boolean).join(' > ') || docTitle;
      if (body.length <= chunkCap) {
        pushChunk(heading, body);
        return;
      }
      // Sub-split oversized sections/tables/FAQ lists while repeating active Markdown table header
      const secLines = body.split('\n');
      let tableHeader = null;
      let part = [];
      let partLen = 0;
      let partIdx = 1;
      for (let i = 0; i < secLines.length; i++) {
        const line = secLines[i];
        if (i + 1 < secLines.length && /^\|.*\|$/.test(line.trim()) && /^\|[\s:|-]+\|$/.test(secLines[i + 1].trim())) {
          tableHeader = [line, secLines[i + 1]];
        } else if (!/^\|/.test(line.trim())) {
          tableHeader = null;
        }
        if (partLen + line.length + 1 > chunkCap && part.length >= 2) {
          pushChunk(`${heading} (part ${partIdx})`, part.join('\n'));
          partIdx++;
          part = (tableHeader && /^\|/.test(line.trim())) ? [...tableHeader, line] : [line];
          partLen = part.reduce((s, l) => s + l.length + 1, 0);
        } else {
          part.push(line);
          partLen += line.length + 1;
        }
      }
      if (part.length) pushChunk(`${heading} (part ${partIdx})`, part.join('\n'));
    };

    for (const line of lines) {
      if (/^##\s+/.test(line)) {
        flush();
        curH2 = line.replace(/^##\s+/, '').trim();
        curH3 = '';
        if (curH2 && headings.length < 60) headings.push(curH2);
        buf = [line];
      } else if (/^###\s+/.test(line)) {
        flush();
        curH3 = line.replace(/^###\s+/, '').trim();
        if (curH3 && headings.length < 60) headings.push(curH2 ? `${curH2} > ${curH3}` : curH3);
        buf = [line];
      } else {
        buf.push(line);
      }
    }
    flush();

    const fMeta = {
      file: rel,
      fullPath: full,
      folder: folder || '',
      title: docTitle,
      visibility: fileVis,
      kind: 'text',
      bytes,
      chars: raw.length,
      chunksCount: chunks.length - startChunks,
      sourceUrl: fileSourceUrl,
      sourceType: fileSourceType,
      syncedAt: fileSyncedAt,
      headings,
    };
    filesMeta.push(fMeta);
    filesByPath.set(rel, fMeta);
  }

  if (Array.isArray(records) && records.length) {
    h.update('inline_records\0').update(JSON.stringify(records));
    for (let i = 0; i < records.length; i++) {
      pushStructuredRecord(records[i], 'inline.bitemporal.jsonl', i);
    }
  }

  const N = chunks.length || 1;
  const df = new Map();
  let sumLen = 0;
  const byId = new Map();
  const byClausePath = new Map();
  const amendedBy = new Map();
  const exceptionsFor = new Map();

  for (const ch of chunks) {
    sumLen += ch.tokensCount;
    for (const tok of ch.tf.keys()) df.set(tok, (df.get(tok) || 0) + 1);
    byId.set(ch.id, ch);
    if (ch.meta?.clausePath) {
      byClausePath.set(ch.meta.clausePath, ch);
    }
    for (const target of ch.meta?.amends || []) {
      if (!amendedBy.has(target)) amendedBy.set(target, []);
      amendedBy.get(target).push(ch.id);
    }
    for (const target of ch.meta?.exceptions || []) {
      if (!exceptionsFor.has(target)) exceptionsFor.set(target, []);
      exceptionsFor.get(target).push(ch.id);
    }
  }
  const avgLen = sumLen / N;
  const idf = new Map();
  for (const [tok, count] of df.entries()) {
    idf.set(tok, Math.log(1 + (N - count + 0.5) / (count + 0.5)));
  }

  return {
    active: chunks.length > 0 || filesMeta.length > 0,
    dir: cfg.dir,
    hash: (files.length || (Array.isArray(records) && records.length)) ? h.digest('hex').slice(0, 16) : null,
    filesCount: files.length,
    files: filesMeta,
    filesByPath,
    totalBytes,
    totalWords,
    totalCorpusChars,
    chunksCount: chunks.length,
    chunks,
    byId,
    byClausePath,
    amendedBy,
    exceptionsFor,
    avgLen,
    idf,
    cfg,
  };
}

function normalizeFolderFilter(folder) {
  return String(folder || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function matchesFolderFilter(filePath, folderFilter) {
  if (!folderFilter) return true;
  const f = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return f === folderFilter || f.startsWith(`${folderFilter}/`);
}

export function retrieveKnowledge(index, query, {
  topK = null,
  maxChars = null,
  prevQuery = '',
  synonyms = null,
  asOf = null,
  knownAt = null,
  nowDate = null,
  artifactTypes = null,
  includeLineage = true,
  normalizer = null,
  extraRankings = null,
  audience = 'owner',
  folder = null,
} = {}) {
  const t0 = performance.now();
  if (!index || !index.active) {
    return { query: String(query ?? ''), hits: [], chunks: [], selectedChars: 0, totalCorpusChars: 0, durationMs: 0 };
  }
  const limitK = Math.max(1, Number(topK || index.cfg?.topK || KNOWLEDGE_DEFAULTS.topK));
  const charCap = Math.max(600, Number(maxChars || index.cfg?.maxChars || KNOWLEDGE_DEFAULTS.maxChars));
  const folderFilter = normalizeFolderFilter(folder);

  // Stage 1: §42 visibility wall + folder scope + bi-temporal active filter + supersession closure
  const typeFilter = Array.isArray(artifactTypes) && artifactTypes.length ? new Set(artifactTypes) : null;
  const temporalActive = [];
  const supersededTargets = new Set();
  for (const ch of index.chunks) {
    if (!isVisibilityAllowed(ch.visibility || ch.meta?.visibility || 'public', audience)) continue;
    if (folderFilter && !matchesFolderFilter(ch.file, folderFilter)) continue;
    if (ch.structured && (asOf || knownAt)) {
      if (!isBiTemporalActive(ch.meta, { asOf, knownAt })) continue;
    }
    if (!ch.structured && (asOf || knownAt) && (ch.meta?.validFrom || ch.meta?.validTo)) {
      if (!isBiTemporalActive(ch.meta, { asOf, knownAt })) continue;
    }
    if (ch.structured && (asOf || knownAt) && Array.isArray(ch.meta?.supersedes)) {
      for (const s of ch.meta.supersedes) supersededTargets.add(s);
    }
    temporalActive.push(ch);
  }
  const eligible = temporalActive.filter((ch) => {
    if (typeFilter && !typeFilter.has(ch.meta?.artifactType || 'markdown')) return false;
    if (ch.structured && (asOf || knownAt)) {
      if (supersededTargets.has(ch.id) || (ch.meta?.clausePath && supersededTargets.has(ch.meta.clausePath))) {
        return false;
      }
    }
    return true;
  });

  let expanded = typeof normalizer === 'function' ? String(normalizer(query) ?? query ?? '') : String(query ?? '');
  if (Array.isArray(synonyms) && synonyms.length) {
    const foldedQ = foldAscii(expanded).toLowerCase();
    for (const rule of synonyms) {
      if (rule && rule.pattern instanceof RegExp && rule.pattern.test(foldedQ) && rule.terms) {
        expanded += ' ' + String(rule.terms);
      }
    }
  }

  const qTokens = tokenize(expanded);
  const isShortFollowUp = qTokens.length <= 6;
  const prevTokens = (prevQuery && isShortFollowUp) ? tokenize(prevQuery).slice(0, 12) : [];
  const qBigrams = [];
  for (let i = 0; i < qTokens.length - 1; i++) qBigrams.push(`${qTokens[i]} ${qTokens[i + 1]}`);
  const curCodes = extractCodes(expanded);
  const prevCodes = (prevQuery && curCodes.length === 0 && isShortFollowUp) ? extractCodes(prevQuery) : [];
  const k1 = 1.5;
  const b = 0.75;

  const scored = [];
  for (const ch of eligible) {
    let score = 0;
    for (const tok of qTokens) {
      const f = ch.tf.get(tok) || 0;
      if (f > 0) {
        const w = index.idf.get(tok) || 0.5;
        score += w * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (ch.tokensCount / index.avgLen))));
        if (ch.headingTokens.has(tok)) score += w * 1.1;
      }
    }
    for (const tok of prevTokens) {
      const f = ch.tf.get(tok) || 0;
      if (f > 0) score += (index.idf.get(tok) || 0.5) * 0.2;
    }
    for (const code of curCodes) {
      if (ch.codes.has(code)) score += 12.0;
    }
    for (const code of prevCodes) {
      if (ch.codes.has(code)) score += 3.0;
    }
    for (const bg of qBigrams) {
      if (ch.folded.includes(bg)) score += 1.6;
      if (ch.headingFolded && ch.headingFolded.includes(bg)) score += 2.8;
    }
    if (score > 0) {
      const freshness = ch.structured ? computeFreshness(ch.meta, { nowDate: nowDate || asOf }) : { stale: false, weight: 1.0 };
      score *= freshness.weight;
      scored.push({ chunk: ch, score, freshness });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // Optional hybrid ranking fusion via Weighted RRF
  let ranked = scored;
  if (Array.isArray(extraRankings) && extraRankings.length && scored.length) {
    const eligibleById = new Map(eligible.map((c) => [c.id, c]));
    const lexRanking = { weight: 0.55, rankedIds: scored.slice(0, 48).map((s) => s.chunk.id) };
    const fused = fuseRankings([lexRanking, ...extraRankings], { k: 60 });
    ranked = fused
      .map((f) => {
        const ch = eligibleById.get(f.id);
        if (!ch) return null;
        const freshness = ch.structured ? computeFreshness(ch.meta, { nowDate: nowDate || asOf }) : { stale: false, weight: 1.0 };
        return { chunk: ch, score: f.score * 100 * freshness.weight, freshness };
      })
      .filter(Boolean);
  }

  const selected = [];
  const selectedIds = new Set();
  let usedChars = 0;
  const eligibleIdSet = new Set(eligible.map((c) => c.id));

  for (const item of ranked) {
    if (selected.length >= limitK) break;
    if (selected.length > 0 && usedChars + item.chunk.chars > charCap) continue;
    selected.push(item);
    selectedIds.add(item.chunk.id);
    usedChars += item.chunk.chars;
  }

  // 1-hop lineage expansion for active `amends[]` and `exceptions[]`
  if (includeLineage && selected.length && (index.amendedBy?.size || index.exceptionsFor?.size || index.byClausePath?.size)) {
    const lineageCandidates = [];
    for (const s of selected) {
      const ch = s.chunk;
      const keys = [ch.id, ch.meta?.clausePath].filter(Boolean);
      for (const key of keys) {
        for (const relId of index.amendedBy?.get(key) || []) lineageCandidates.push({ id: relId, via: 'amended_by' });
        for (const relId of index.exceptionsFor?.get(key) || []) lineageCandidates.push({ id: relId, via: 'exception_for' });
      }
      for (const target of [...(ch.meta?.amends || []), ...(ch.meta?.exceptions || [])]) {
        const tChunk = index.byClausePath?.get(target) || index.byId?.get(target);
        if (tChunk) lineageCandidates.push({ id: tChunk.id, via: 'references' });
      }
    }
    for (const lc of lineageCandidates) {
      if (selectedIds.has(lc.id) || !eligibleIdSet.has(lc.id)) continue;
      const targetChunk = index.byId?.get(lc.id);
      if (!targetChunk) continue;
      if (usedChars + targetChunk.chars > charCap) continue;
      selected.push({
        chunk: targetChunk,
        score: 0.01,
        freshness: computeFreshness(targetChunk.meta, { nowDate: nowDate || asOf }),
        lineageVia: lc.via,
      });
      selectedIds.add(targetChunk.id);
      usedChars += targetChunk.chars;
    }
  }

  const durationMs = +(performance.now() - t0).toFixed(2);
  const hits = selected.map((s) => ({
    id: s.chunk.id,
    file: s.chunk.file,
    folder: s.chunk.folder || '',
    heading: s.chunk.heading,
    visibility: s.chunk.visibility || s.chunk.meta?.visibility || 'public',
    ...(s.chunk.meta?.sourceUrl ? { sourceUrl: s.chunk.meta.sourceUrl } : {}),
    score: +s.score.toFixed(2),
    chars: s.chunk.chars,
    text: s.chunk.text,
    ...(s.chunk.structured ? {
      clausePath: s.chunk.meta.clausePath,
      artifactType: s.chunk.meta.artifactType,
      sourceTier: s.chunk.meta.sourceTier,
      validFrom: s.chunk.meta.validFrom,
      validTo: s.chunk.meta.validTo,
      stale: Boolean(s.freshness?.stale),
    } : {}),
    ...(s.lineageVia ? { lineageVia: s.lineageVia } : {}),
  }));
  return {
    query: String(query ?? ''),
    asOf: isoDateOnly(asOf),
    knownAt: isoDateOnly(knownAt),
    hits,
    chunks: hits.map((h) => h.text),
    selectedChars: usedChars,
    totalCorpusChars: index.totalCorpusChars,
    durationMs,
  };
}

export function listKnowledgeFiles(index, {
  folder = '',
  query = '',
  audience = 'owner',
  limit = 100,
} = {}) {
  const all = Array.isArray(index?.files) ? index.files : [];
  const folderFilter = normalizeFolderFilter(folder);
  const qFolded = foldAscii(String(query || '').trim()).toLowerCase();
  const cap = Math.min(500, Math.max(1, Number(limit || 100)));

  const visible = [];
  const folderCounts = new Map();
  for (const f of all) {
    if (!isVisibilityAllowed(f.visibility || 'public', audience)) continue;
    if (folderFilter && !matchesFolderFilter(f.file, folderFilter)) continue;
    if (qFolded) {
      const hay = foldAscii(`${f.file} ${f.title || ''} ${(f.headings || []).join(' ')}`).toLowerCase();
      if (!hay.includes(qFolded)) continue;
    }
    const fFolder = f.folder || '';
    folderCounts.set(fFolder, (folderCounts.get(fFolder) || 0) + 1);
    visible.push({
      file: f.file,
      folder: fFolder,
      title: f.title,
      visibility: f.visibility || 'public',
      chars: f.chars,
      chunksCount: f.chunksCount,
      headings: Array.isArray(f.headings) ? f.headings.slice(0, 12) : [],
      ...(f.sourceUrl ? { sourceUrl: f.sourceUrl } : {}),
      ...(f.sourceType ? { sourceType: f.sourceType } : {}),
      ...(f.syncedAt ? { syncedAt: f.syncedAt } : {}),
    });
  }

  const folders = [...folderCounts.entries()]
    .map(([name, count]) => ({ folder: name || '/', count }))
    .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));

  return {
    total: visible.length,
    totalFiles: visible.length,
    truncated: visible.length > cap,
    folders,
    files: visible.slice(0, cap),
  };
}

function extractMarkdownSection(body, sectionQuery) {
  const needle = foldAscii(String(sectionQuery || '').trim()).toLowerCase();
  if (!needle) return { matched: false, heading: null, text: body };
  const lines = String(body || '').split('\n');
  let startIdx = -1;
  let startLevel = 0;
  let matchedHeading = null;
  for (let i = 0; i < lines.length; i++) {
    const hm = /^(#{1,4})\s+(.+)$/.exec(lines[i]);
    if (!hm) continue;
    const lvl = hm[1].length;
    const hText = hm[2].trim();
    if (startIdx >= 0) {
      if (lvl <= startLevel) {
        return { matched: true, heading: matchedHeading, text: lines.slice(startIdx, i).join('\n').trim() };
      }
    } else if (foldAscii(hText).toLowerCase().includes(needle)) {
      startIdx = i;
      startLevel = lvl;
      matchedHeading = hText;
    }
  }
  if (startIdx >= 0) {
    return { matched: true, heading: matchedHeading, text: lines.slice(startIdx).join('\n').trim() };
  }
  return { matched: false, heading: null, text: body };
}

export function readKnowledgeFile(index, filePath, {
  section = null,
  offsetChars = 0,
  maxChars = 12_000,
  audience = 'owner',
} = {}) {
  const rel = String(filePath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) {
    return { ok: false, error: 'ERR_INVALID_KNOWLEDGE_PATH' };
  }
  let entry = index?.filesByPath?.get(rel) || null;
  if (!entry && Array.isArray(index?.files)) {
    const low = rel.toLowerCase();
    entry = index.files.find((f) => f.file.toLowerCase() === low) || null;
  }
  if (!entry) {
    return { ok: false, error: 'ERR_KNOWLEDGE_NOT_FOUND', file: rel };
  }
  if (!isVisibilityAllowed(entry.visibility || 'public', audience)) {
    return { ok: false, error: 'ERR_KNOWLEDGE_ACCESS_DENIED', file: rel };
  }
  if (!entry.fullPath || !fs.existsSync(entry.fullPath)) {
    return { ok: false, error: 'ERR_KNOWLEDGE_NOT_FOUND', file: rel };
  }
  const rawFile = fs.readFileSync(entry.fullPath, 'utf8').replace(/\r\n?/g, '\n');
  const { body } = entry.kind === 'structured_jsonl' ? { body: rawFile } : parseKnowledgeFrontmatter(rawFile);
  let targetText = body.trim();
  let matchedHeading = null;
  if (section) {
    const sec = extractMarkdownSection(targetText, section);
    if (sec.matched) {
      targetText = sec.text;
      matchedHeading = sec.heading;
    }
  }
  const offset = Math.max(0, Number(offsetChars || 0));
  const cap = Math.min(32_000, Math.max(400, Number(maxChars || 12_000)));
  const slice = targetText.slice(offset, offset + cap);
  const truncated = offset + slice.length < targetText.length;
  return {
    ok: true,
    file: entry.file,
    folder: entry.folder || '',
    title: entry.title,
    visibility: entry.visibility || 'public',
    ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
    ...(matchedHeading ? { section: matchedHeading } : {}),
    headings: Array.isArray(entry.headings) ? entry.headings : [],
    totalChars: targetText.length,
    offsetChars: offset,
    truncated,
    nextOffset: truncated ? offset + slice.length : null,
    text: slice,
  };
}

export function formatKnowledgeBlock(chunks, { hash = null } = {}) {
  const list = Array.isArray(chunks) ? chunks.map(String).filter(Boolean) : [];
  if (!list.length) return '';
  const attr = hash ? ` snapshot="${hash}"` : '';
  return `<retrieved-knowledge${attr}>\n${list.join('\n\n')}\n</retrieved-knowledge>`;
}

export function openKnowledge(opts = {}) {
  const index = indexKnowledge(opts);
  return {
    ...index,
    retrieve: (query, rOpts = {}) => retrieveKnowledge(index, query, rOpts),
    listFiles: (lOpts = {}) => listKnowledgeFiles(index, lOpts),
    readFile: (file, rOpts = {}) => readKnowledgeFile(index, file, rOpts),
    stats: () => ({
      active: index.active,
      hash: index.hash,
      filesCount: index.filesCount,
      chunksCount: index.chunksCount,
      totalBytes: index.totalBytes,
      totalWords: index.totalWords,
      totalCorpusChars: index.totalCorpusChars,
    }),
    format: (chunks) => formatKnowledgeBlock(chunks, { hash: index.hash }),
  };
}
