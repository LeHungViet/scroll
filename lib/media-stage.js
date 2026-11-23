// SCROLL 2.5 — Unified Multimodal Media Staging, MCP Media Extraction & Built-in Extractors
// Zero runtime dependencies. Node >= 20 built-ins only (+ optional system ffmpeg/pdftotext/python3).
//
// Solves ALL multimodal & tool-output gaps across EVERY channel & EVERY provider:
//   1. MCP `image` / `audio` / `resource` (blob) extraction -> saves real files to `stateDir/staging/mcp-media/`
//      (`0o600`, auto-pruned TTL), strips huge base64 strings before `applySpillToFileLimit` & JSONL logs,
//      and surfaces `savedMediaPaths[]` + `mediaItems[]` for native model vision/audio (`inputImage`/`inputAudio`).
//   2. Inbound user media normalization (`image`, `audio`/`voice`, `video`/`video_note`, `document`, `sticker`/`animation`).
//   3. Built-in optional zero-dep extractors (`createDefaultMultimodalHooks`):
//      - Plain text / CSV / JSON / XML / YAML / MD / HTML
//      - PDF (`pdftotext` or Python `fitz`/PyMuPDF + scanned-page PNG fallback)
//      - DOCX (`python-docx`) & XLSX (`openpyxl`)
//      - Video (`ffprobe` + `ffmpeg` keyframe PNGs + audio track extraction)
//   4. Binary file guard so `read_file` never dumps binary garbage into LLM context.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_STAGE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_INLINE_AUDIO_BYTES = 8 * 1024 * 1024;

export const BINARY_FILE_EXTS = Object.freeze(new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.xlsm', '.ppt', '.pptx',
  '.zip', '.gz', '.tar', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.bmp', '.ico', '.tiff',
  '.mp3', '.mp4', '.ogg', '.oga', '.opus', '.wav', '.m4a', '.aac', '.flac',
  '.mov', '.avi', '.mkv', '.webm', '.m4v',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.sqlite', '.db',
]));

const MIME_TO_EXT = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/bmp': '.bmp',
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/webm': '.webm',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/zip': '.zip',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/html': '.html',
});

const EXT_TO_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
});

const lastPruneByDir = new Map();

export function guessExtFromMime(mimeType, fallbackName = '') {
  const cleanMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (cleanMime && MIME_TO_EXT[cleanMime]) return MIME_TO_EXT[cleanMime];
  const extFromName = path.extname(String(fallbackName || '')).toLowerCase();
  if (extFromName && /^\.[a-z0-9]{1,8}$/.test(extFromName)) return extFromName;
  if (cleanMime.startsWith('image/')) return '.png';
  if (cleanMime.startsWith('audio/')) return '.ogg';
  if (cleanMime.startsWith('video/')) return '.mp4';
  return '.bin';
}

export function guessMimeFromPath(filePath, fallbackMime = 'application/octet-stream') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return EXT_TO_MIME[ext] || fallbackMime;
}

export function sniffBufferMime(buf, declaredMime = null) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return declaredMime || 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buf.subarray(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return 'audio/mpeg';
  if (buf.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.length >= 12 ? buf.subarray(8, 12).toString('ascii') : '';
    if (/^M4A/i.test(brand)) return 'audio/mp4';
    return declaredMime && /^audio\//i.test(declaredMime) ? declaredMime : 'video/mp4';
  }
  if (buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04) {
    if (declaredMime && /wordprocessingml|spreadsheetml|presentationml/i.test(declaredMime)) return declaredMime;
    return declaredMime || 'application/zip';
  }
  return declaredMime || 'application/octet-stream';
}

export function isBinaryBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  const n = Math.min(buf.length, 1024);
  let nonText = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) nonText++;
  }
  return (nonText / n) > 0.25;
}

export function isBinaryFilePath(filePath, mimeType = null) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (BINARY_FILE_EXTS.has(ext)) return true;
  if (mimeType && !/^text\/|json|xml|yaml|csv|javascript|typescript|markdown/i.test(String(mimeType))) {
    if (/^(?:application\/(?:pdf|zip|octet-stream|vnd\.|msword)|image\/|audio\/|video\/)/i.test(String(mimeType))) {
      return true;
    }
  }
  return false;
}

export function resolveMediaStagingDir(stateDir = null, subdir = 'mcp-media') {
  const safeSub = String(subdir || 'mcp-media').replace(/[^A-Za-z0-9._-]/g, '_');
  if (stateDir && String(stateDir).trim()) {
    return path.resolve(String(stateDir), 'staging', safeSub);
  }
  return path.join(os.tmpdir(), 'scroll-media-staging', safeSub);
}

export function pruneExpiredStagedMedia(dir, ttlMs = DEFAULT_MEDIA_TTL_MS, nowMs = Date.now()) {
  if (!dir) return 0;
  const prev = lastPruneByDir.get(dir) || 0;
  if (nowMs - prev < 10 * 60 * 1000) return 0;
  lastPruneByDir.set(dir, nowMs);
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = nowMs - Math.max(60_000, Number(ttlMs || DEFAULT_MEDIA_TTL_MS));
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const fp = path.join(dir, ent.name);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(fp, { force: true });
          removed++;
        }
      } catch { /* ignore */ }
    }
  } catch { /* best-effort */ }
  return removed;
}

export function persistMediaBuffer(buf, {
  stagingDir = null,
  prefix = 'media',
  mimeType = null,
  fileName = '',
  maxBytes = DEFAULT_MAX_STAGE_BYTES,
} = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  if (buf.length > maxBytes) {
    return { skipped: true, reason: `media_too_large:${buf.length}>${maxBytes}`, bytes: buf.length };
  }
  const detectedMime = sniffBufferMime(buf, mimeType);
  const ext = guessExtFromMime(detectedMime, fileName);
  const dir = stagingDir || resolveMediaStagingDir(null, 'mcp-media');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneExpiredStagedMedia(dir);
  const safePrefix = String(prefix || 'media').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
  const baseStem = fileName
    ? path.basename(String(fileName), path.extname(String(fileName))).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)
    : safePrefix;
  const finalName = `${Date.now()}-${baseStem || safePrefix}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const finalPath = path.join(dir, finalName);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, buf, { mode: 0o600 });
  fs.renameSync(tmpPath, finalPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return {
    filePath: finalPath,
    bytes: buf.length,
    mimeType: detectedMime,
    ext,
    sha256,
  };
}

/**
 * Extract ALL MCP 2025-06 media blocks (`image`, `audio`, `resource` blob, `resource_link`)
 * from an MCP tool result into real staged files (`0o600`), strip huge base64 strings from
 * serialized output (prevents `applySpillToFileLimit` & JSONL bloat), and return structured
 * `mediaItems[]` so Codex / Anthropic / Gemini / OpenAI see/hear them natively.
 */
export function extractMcpToolMedia(mcpResult, {
  stagingDir = null,
  toolName = 'mcp',
  maxInlineImageBytes = DEFAULT_MAX_INLINE_IMAGE_BYTES,
  maxInlineAudioBytes = DEFAULT_MAX_INLINE_AUDIO_BYTES,
} = {}) {
  if (!mcpResult || typeof mcpResult !== 'object') {
    return { output: mcpResult, mediaItems: [], savedMediaPaths: [] };
  }
  const content = Array.isArray(mcpResult.content)
    ? mcpResult.content
    : (Array.isArray(mcpResult.raw?.content) ? mcpResult.raw.content : null);
  if (!content || !content.length) {
    return { output: mcpResult, mediaItems: [], savedMediaPaths: [] };
  }

  const textParts = [];
  const mediaItems = [];
  const savedMediaPaths = [];
  const mediaSummary = [];
  let hadNonTextBlock = false;

  const stageBinary = (b64Str, rawMime, fallbackName = '', forcedKind = null) => {
    const cleanB64 = String(b64Str || '').replace(/^data:[^;]+;base64,/i, '').trim();
    if (!cleanB64) return;
    let buf;
    try {
      buf = Buffer.from(cleanB64, 'base64');
    } catch {
      return;
    }
    if (!buf.length) return;
    const saved = persistMediaBuffer(buf, {
      stagingDir,
      prefix: toolName,
      mimeType: rawMime,
      fileName: fallbackName,
    });
    const finalMime = saved?.mimeType || rawMime || 'application/octet-stream';
    const kind = forcedKind
      || (/^image\//i.test(finalMime) ? 'image' : (/^audio\//i.test(finalMime) ? 'audio' : 'file'));
    if (saved && saved.filePath) {
      savedMediaPaths.push(saved.filePath);
    }
    mediaSummary.push({
      kind,
      mimeType: finalMime,
      bytes: buf.length,
      ...(saved?.filePath ? { filePath: saved.filePath } : {}),
      ...(saved?.skipped ? { skipped: saved.reason } : {}),
    });
    if (kind === 'image' && buf.length <= maxInlineImageBytes) {
      mediaItems.push({
        kind: 'image',
        mimeType: finalMime,
        base64: cleanB64,
        dataUrl: `data:${finalMime};base64,${cleanB64}`,
        filePath: saved?.filePath || null,
        bytes: buf.length,
      });
    } else if (kind === 'audio' && buf.length <= maxInlineAudioBytes) {
      mediaItems.push({
        kind: 'audio',
        mimeType: finalMime,
        base64: cleanB64,
        dataUrl: `data:${finalMime};base64,${cleanB64}`,
        filePath: saved?.filePath || null,
        bytes: buf.length,
      });
    }
  };

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const t = String(item.type || '').toLowerCase();
    if (t === 'text') {
      if (typeof item.text === 'string' && item.text.trim()) textParts.push(item.text.trim());
    } else if (t === 'image') {
      hadNonTextBlock = true;
      if (item.data) {
        stageBinary(item.data, item.mimeType || 'image/png', '', 'image');
      } else if (item.url || item.imageUrl) {
        const u = String(item.url || item.imageUrl);
        mediaItems.push({ kind: 'image', mimeType: item.mimeType || 'image/png', url: u, dataUrl: u });
        mediaSummary.push({ kind: 'image', url: u });
      }
    } else if (t === 'audio') {
      hadNonTextBlock = true;
      if (item.data) {
        stageBinary(item.data, item.mimeType || 'audio/ogg', '', 'audio');
      } else if (item.url || item.audioUrl) {
        const u = String(item.url || item.audioUrl);
        mediaItems.push({ kind: 'audio', mimeType: item.mimeType || 'audio/mpeg', url: u, dataUrl: u });
        mediaSummary.push({ kind: 'audio', url: u });
      }
    } else if (t === 'resource' && item.resource && typeof item.resource === 'object') {
      hadNonTextBlock = true;
      const r = item.resource;
      const rName = r.uri ? path.basename(String(r.uri).split('?')[0]) : '';
      if (typeof r.text === 'string' && r.text.trim()) {
        textParts.push(`[Resource ${r.uri || rName || 'embedded'}]\n${r.text.slice(0, 12_000)}`);
      } else if (r.blob) {
        stageBinary(r.blob, r.mimeType || guessMimeFromPath(rName), rName);
      }
    } else if (t === 'resource_link') {
      hadNonTextBlock = true;
      textParts.push(`[Resource link: ${item.name || item.uri || 'link'} (${item.mimeType || 'unknown'}) ${item.uri || ''}]`.trim());
    }
  }

  if (!hadNonTextBlock) {
    // Pure text MCP response: preserve original lean shape without copying huge `raw` duplicates
    const cleanText = textParts.join('\n').trim() || String(mcpResult.text || '');
    return {
      output: {
        ok: mcpResult.ok !== false && !mcpResult.isError,
        isError: Boolean(mcpResult.isError),
        text: cleanText,
      },
      mediaItems: [],
      savedMediaPaths: [],
    };
  }

  const baseText = textParts.join('\n').trim();
  const pathNote = savedMediaPaths.length
    ? `Saved media file(s) ready to inspect or send via send_telegram_file(filePath): ${savedMediaPaths.join(', ')}`
    : '';
  const combinedText = [baseText, pathNote].filter(Boolean).join('\n');

  const leanOutput = {
    ok: mcpResult.ok !== false && !mcpResult.isError,
    isError: Boolean(mcpResult.isError),
    text: combinedText,
    ...(savedMediaPaths.length ? { savedMediaPaths, savedImagePath: savedMediaPaths[0] } : {}),
    mediaSummary,
  };

  return { output: leanOutput, mediaItems, savedMediaPaths };
}

/**
 * Default zero-dep multimodal hooks using optional system binaries (`pdftotext`, `ffmpeg`, `ffprobe`,
 * Python `fitz`/`docx`/`openpyxl`) when installed on host. Gracefully degrades anywhere they're absent.
 */
export function createDefaultMultimodalHooks({
  stateDir = null,
  maxDocChars = 14_000,
  maxVideoFrames = 4,
  maxVideoAudioSeconds = 180,
  sttHandler = null,
} = {}) {
  const stagingDir = resolveMediaStagingDir(stateDir, 'inbound-extracted');

  async function extractDocument(att) {
    const filePath = att?.path ? String(att.path) : '';
    const fileName = att?.name || (filePath ? path.basename(filePath) : 'document');
    if (!filePath || !fs.existsSync(filePath)) return null;
    const ext = path.extname(fileName || filePath).toLowerCase();
    const mime = String(att?.mimeType || guessMimeFromPath(filePath)).toLowerCase();

    // 1. Plain UTF-8 text / structured text files
    if (
      /\.(?:txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|html|htm|log|js|ts|py|sql|sh|ini|conf)$/i.test(ext) ||
      /^text\//i.test(mime) ||
      /json|xml|yaml|csv/i.test(mime)
    ) {
      try {
        const raw = fs.readFileSync(filePath);
        if (!isBinaryBuffer(raw)) {
          return { text: raw.toString('utf8').slice(0, maxDocChars), images: [] };
        }
      } catch { /* fall through */ }
    }

    // 2. PDF -> `pdftotext` first, then Python `fitz` (PyMuPDF), with PNG page render fallback for scanned PDFs!
    if (ext === '.pdf' || mime === 'application/pdf') {
      try {
        const { stdout } = await execFileAsync('pdftotext', ['-layout', filePath, '-'], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
        const clean = String(stdout || '').trim();
        if (clean.length >= 30) {
          return { text: clean.slice(0, maxDocChars), images: [] };
        }
      } catch { /* try fitz */ }
      try {
        fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
        const pyScript = [
          'import sys, json, os, fitz',
          'p, outdir, maxc = sys.argv[1], sys.argv[2], int(sys.argv[3])',
          'doc = fitz.open(p)',
          'texts = []',
          'for i, page in enumerate(doc):',
          '    if i >= 20: break',
          '    t = page.get_text("text").strip()',
          '    if t: texts.append(f"--- Page {i+1} ---\\n" + t)',
          'joined = "\\n\\n".join(texts)',
          'imgs = []',
          'if len(joined) < 40:',
          '    for i in range(min(2, len(doc))):',
          '        pix = doc[i].get_pixmap(dpi=140)',
          '        outp = os.path.join(outdir, f"pdf_{os.getpid()}_{i+1}.png")',
          '        pix.save(outp)',
          '        imgs.append(outp)',
          'print(json.dumps({"pages": len(doc), "text": joined[:maxc], "images": imgs}))',
        ].join('\n');
        const { stdout } = await execFileAsync('python3', ['-c', pyScript, filePath, stagingDir, String(maxDocChars)], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
        const parsed = JSON.parse(String(stdout || '{}').trim());
        const imgs = (Array.isArray(parsed.images) ? parsed.images : [])
          .filter((p) => p && fs.existsSync(p))
          .map((p) => ({ path: p, mimeType: 'image/png', caption: `${fileName} (scanned page)` }));
        if (parsed.text || imgs.length) {
          return {
            text: parsed.text || `[Scanned PDF: ${fileName} (${parsed.pages || '?'} pages) — rendered first ${imgs.length} page(s) as images for visual reading]`,
            images: imgs,
          };
        }
      } catch { /* ignore if fitz missing */ }
    }

    // 3. DOCX -> `python-docx`
    if (ext === '.docx' || mime.includes('wordprocessingml')) {
      try {
        const pyScript = [
          'import sys, docx',
          'd = docx.Document(sys.argv[1])',
          'out = [p.text.strip() for p in d.paragraphs if p.text and p.text.strip()]',
          'for tbl in d.tables[:10]:',
          '    for row in tbl.rows[:40]:',
          '        cells = [c.text.strip().replace("\\n", " ") for c in row.cells]',
          '        if any(cells): out.append(" | ".join(cells))',
          'print("\\n".join(out)[:int(sys.argv[2])])',
        ].join('\n');
        const { stdout } = await execFileAsync('python3', ['-c', pyScript, filePath, String(maxDocChars)], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
        const clean = String(stdout || '').trim();
        if (clean) return { text: clean, images: [] };
      } catch { /* ignore */ }
    }

    // 4. XLSX / XLSM -> `openpyxl`
    if (ext === '.xlsx' || ext === '.xlsm' || mime.includes('spreadsheetml')) {
      try {
        const pyScript = [
          'import sys, openpyxl',
          'wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)',
          'out = []',
          'for name in wb.sheetnames[:6]:',
          '    ws = wb[name]',
          '    out.append(f"=== Sheet: {name} ===")',
          '    for idx, row in enumerate(ws.iter_rows(values_only=True)):',
          '        if idx >= 80: break',
          '        vals = ["" if v is None else str(v).strip() for v in row[:20]]',
          '        if any(vals): out.append(" | ".join(vals))',
          'print("\\n".join(out)[:int(sys.argv[2])])',
        ].join('\n');
        const { stdout } = await execFileAsync('python3', ['-c', pyScript, filePath, String(maxDocChars)], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
        const clean = String(stdout || '').trim();
        if (clean) return { text: clean, images: [] };
      } catch { /* ignore */ }
    }

    return null;
  }

  async function processVideo(att) {
    const filePath = att?.path ? String(att.path) : '';
    const fileName = att?.name || (filePath ? path.basename(filePath) : 'video.mp4');
    if (!filePath || !fs.existsSync(filePath)) return null;
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
    pruneExpiredStagedMedia(stagingDir);

    let durationSec = Number(att?.duration || 0);
    let hasAudio = false;
    let dims = '';
    try {
      const { stdout } = await execFileAsync(
        'ffprobe',
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      const meta = JSON.parse(String(stdout || '{}'));
      if (!durationSec && meta?.format?.duration) durationSec = Math.round(Number(meta.format.duration));
      for (const s of meta?.streams || []) {
        if (s.codec_type === 'audio') hasAudio = true;
        if (s.codec_type === 'video' && s.width && s.height) dims = `${s.width}x${s.height}`;
      }
    } catch { /* ffprobe optional */ }

    const runId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const images = [];
    try {
      const nFrames = Math.max(1, Math.min(maxVideoFrames, durationSec > 0 && durationSec <= 4 ? 2 : maxVideoFrames));
      const fpsExpr = durationSec > 0 ? `${Math.max(0.05, nFrames / Math.max(1, durationSec)).toFixed(3)}` : '0.5';
      const outPattern = path.join(stagingDir, `vid-${runId}-f%02d.jpg`);
      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', filePath, '-vf', `fps=${fpsExpr},scale='min(1024,iw)':-2`, '-frames:v', String(nFrames), '-q:v', '4', outPattern],
        { timeout: 25_000 },
      );
      for (let i = 1; i <= nFrames; i++) {
        const fp = path.join(stagingDir, `vid-${runId}-f${String(i).padStart(2, '0')}.jpg`);
        if (fs.existsSync(fp)) {
          images.push({ path: fp, mimeType: 'image/jpeg', caption: `${fileName} frame ${i}/${nFrames}` });
        }
      }
    } catch { /* ffmpeg optional */ }

    let audio = null;
    if (hasAudio && (durationSec === 0 || durationSec <= maxVideoAudioSeconds)) {
      try {
        const audioPath = path.join(stagingDir, `vid-${runId}-audio.mp3`);
        await execFileAsync(
          'ffmpeg',
          ['-y', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-t', String(maxVideoAudioSeconds), audioPath],
          { timeout: 25_000 },
        );
        if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 256) {
          audio = { path: audioPath, mimeType: 'audio/mpeg', name: `${fileName}.mp3` };
        }
      } catch { /* audio extract optional */ }
    }

    const summary = `[Video attached: ${fileName}${durationSec ? ` (${durationSec}s${dims ? `, ${dims}` : ''})` : ''} — extracted ${images.length} keyframe(s)${audio ? ' + audio track' : ''}; file path: ${filePath}]`;
    return { summary, images, audio };
  }

  async function transcribeAudio(att) {
    if (typeof sttHandler === 'function') {
      return sttHandler(att);
    }
    return null;
  }

  return {
    stagingDir,
    extractDocument,
    processVideo,
    transcribeAudio,
  };
}
