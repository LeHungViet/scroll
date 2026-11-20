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
};

// Fold diacritics to ASCII so accented languages match cleanly without non-ASCII literals in code
export function foldAscii(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D');
}

// Common English + ASCII-folded Vietnamese function words (pure ASCII)
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'not', 'can', 'you',
  'your', 'have', 'has', 'had', 'will', 'would', 'should', 'could', 'about', 'into', 'when', 'what',
  'where', 'which', 'how', 'who', 'why', 'please', 'thanks', 'thank',
  'va', 'cua', 'cho', 'voi', 'trong', 'nhung', 'cac', 'mot', 'nay', 'khi', 'thi', 'la', 'co',
  'khong', 'duoc', 'de', 'tu', 'den', 'theo', 'hoac', 'neu', 'nhu', 've', 'tai', 'tren', 'duoi',
  'sau', 'truoc', 'anh', 'chi', 'em', 'oi', 'nhe', 'nha', 'da', 'vang', 'toi', 'minh', 'ben',
  'nao', 'bao', 'nhieu', 'the', 'sao', 'hay', 'cung', 'phai', 'can', 'muon', 'hoi', 'xem', 'thu',
  'giup',
]);

// Matches alphanumeric codes (SKU-A100, MICE-H2) AND uppercase hyphenated alpha codes (AUR-DLX, FDP-STD)
const CODE_TOKEN_RE = /(?<![A-Za-z0-9_-])(?:(?=[A-Z0-9_-]*\d)(?=[A-Z0-9_-]*[A-Z])[A-Z0-9]{2,}(?:[-_][A-Z0-9]+)*|[A-Z]{2,5}(?:-[A-Z0-9]{2,6})+)(?![A-Za-z0-9_-])/g;

function tokenize(text) {
  const folded = foldAscii(text).toLowerCase();
  const raw = folded.match(/[a-z0-9]+/g) || [];
  return raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
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
  };
}

function walkKnowledgeFiles(rootDir, extensions) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const exts = new Set(extensions.map((e) => String(e).toLowerCase()));
  (function walk(dir, relBase) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) out.push({ full, rel });
    }
  })(rootDir, '');
  return out;
}

export function indexKnowledge({ cwd = process.cwd(), dir = null, config = null, maxChunkChars = null } = {}) {
  const cfg = knowledgeConfig({ cwd, dir, config });
  const chunkCap = Math.max(400, Number(maxChunkChars || cfg.maxChunkChars));
  const files = walkKnowledgeFiles(cfg.dir, cfg.extensions);
  const chunks = [];
  const h = crypto.createHash('sha256');
  let totalBytes = 0;
  let totalWords = 0;
  let totalCorpusChars = 0;

  for (const { full, rel } of files) {
    const raw = fs.readFileSync(full, 'utf8').replace(/\r\n?/g, '\n');
    h.update(`${rel}\0`).update(raw);
    totalBytes += Buffer.byteLength(raw, 'utf8');
    totalCorpusChars += raw.length;
    totalWords += raw.trim() ? raw.trim().split(/\s+/).length : 0;

    const lines = raw.split('\n');
    const docTitle = (lines.find((l) => /^#\s+/.test(l)) || rel).replace(/^#\s+/, '').trim();

    let curH2 = '';
    let curH3 = '';
    let buf = [];

    const pushChunk = (heading, bodyText) => {
      const clean = bodyText.trim();
      if (!clean || clean.length < 30) return;
      const text = `[Source: ${rel} | ${heading}]\n${clean}`;
      const tokens = tokenize(`${docTitle} ${heading} ${clean}`);
      const headingTokens = new Set(tokenize(`${docTitle} ${heading}`));
      const codes = new Set(extractCodes(text));
      const tf = new Map();
      for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);
      chunks.push({
        id: `${rel}#${chunks.length + 1}`,
        file: rel,
        docTitle,
        heading,
        text,
        folded: foldAscii(text).toLowerCase(),
        chars: text.length,
        tokensCount: tokens.length || 1,
        tf,
        headingTokens,
        codes,
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
      if (/^##\s+/.test(line)) { flush(); curH2 = line.replace(/^##\s+/, '').trim(); curH3 = ''; buf = [line]; }
      else if (/^###\s+/.test(line)) { flush(); curH3 = line.replace(/^###\s+/, '').trim(); buf = [line]; }
      else buf.push(line);
    }
    flush();
  }

  const N = chunks.length || 1;
  const df = new Map();
  let sumLen = 0;
  for (const ch of chunks) {
    sumLen += ch.tokensCount;
    for (const tok of ch.tf.keys()) df.set(tok, (df.get(tok) || 0) + 1);
  }
  const avgLen = sumLen / N;
  const idf = new Map();
  for (const [tok, count] of df.entries()) {
    idf.set(tok, Math.log(1 + (N - count + 0.5) / (count + 0.5)));
  }

  return {
    active: chunks.length > 0,
    dir: cfg.dir,
    hash: files.length ? h.digest('hex').slice(0, 16) : null,
    filesCount: files.length,
    totalBytes,
    totalWords,
    totalCorpusChars,
    chunksCount: chunks.length,
    chunks,
    avgLen,
    idf,
    cfg,
  };
}

export function retrieveKnowledge(index, query, {
  topK = null,
  maxChars = null,
  prevQuery = '',
  synonyms = null,
} = {}) {
  const t0 = performance.now();
  if (!index || !index.active) {
    return { query: String(query ?? ''), hits: [], chunks: [], selectedChars: 0, totalCorpusChars: 0, durationMs: 0 };
  }
  const limitK = Math.max(1, Number(topK || index.cfg?.topK || KNOWLEDGE_DEFAULTS.topK));
  const charCap = Math.max(600, Number(maxChars || index.cfg?.maxChars || KNOWLEDGE_DEFAULTS.maxChars));

  let expanded = String(query ?? '');
  if (Array.isArray(synonyms) && synonyms.length) {
    const foldedQ = foldAscii(expanded).toLowerCase();
    for (const rule of synonyms) {
      if (rule && rule.pattern instanceof RegExp && rule.pattern.test(foldedQ) && rule.terms) {
        expanded += ' ' + String(rule.terms);
      }
    }
  }

  const qTokens = tokenize(expanded);
  const prevTokens = prevQuery ? tokenize(prevQuery).slice(0, 12) : [];
  const qBigrams = [];
  for (let i = 0; i < qTokens.length - 1; i++) qBigrams.push(`${qTokens[i]} ${qTokens[i + 1]}`);
  const qCodes = extractCodes(`${expanded} ${prevQuery}`);
  const k1 = 1.5;
  const b = 0.75;

  const scored = [];
  for (const ch of index.chunks) {
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
      if (f > 0) score += (index.idf.get(tok) || 0.5) * 0.25;
    }
    for (const code of qCodes) {
      if (ch.codes.has(code)) score += 12.0;
    }
    for (const bg of qBigrams) {
      if (ch.folded.includes(bg)) score += 1.6;
    }
    if (score > 0) scored.push({ chunk: ch, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const selected = [];
  let usedChars = 0;
  for (const item of scored) {
    if (selected.length >= limitK) break;
    if (selected.length > 0 && usedChars + item.chunk.chars > charCap) continue;
    selected.push(item);
    usedChars += item.chunk.chars;
  }

  const durationMs = +(performance.now() - t0).toFixed(2);
  const hits = selected.map((s) => ({
    id: s.chunk.id,
    file: s.chunk.file,
    heading: s.chunk.heading,
    score: +s.score.toFixed(2),
    chars: s.chunk.chars,
    text: s.chunk.text,
  }));
  return {
    query: String(query ?? ''),
    hits,
    chunks: hits.map((h) => h.text),
    selectedChars: usedChars,
    totalCorpusChars: index.totalCorpusChars,
    durationMs,
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
    format: (chunks) => formatKnowledgeBlock(chunks, { hash: index.hash }),
  };
}
