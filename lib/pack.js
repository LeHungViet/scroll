// SCROLL 2.8 -- sec 52 Immutable Versioned Agent Packs (`PackResolver`).
// Zero-dep, pure ASCII, Node >= 20.
//
// Builds, scans, signs (Ed25519), verifies, and caches immutable agent packs using strict
// allowlist extraction so private user state, raw memory, secrets, host paths, or private IPs
// can never leak into a published pack. Supports embedded read-only Domain Packs and shares
// immutable BM25 Knowledge Indexes across tenants keyed by content SHA-256.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openKnowledge, indexKnowledge, retrieveKnowledge, formatKnowledgeBlock } from './knowledge.js';
import { normalizeChannelPolicy } from './chat-sdk/group-policy.js';

export const PACK_SCHEMA = 'scroll-agent-pack/v1';

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

const ALLOWLIST_AGENT_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'TOOLS.md',
  'hard-rules.md',
  'plain-speak.json',
];

const ALLOWLIST_SKILL_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.py', '.sh', '.js', '.mjs']);
const ALLOWLIST_EVAL_EXTS = new Set(['.json', '.jsonl', '.md', '.txt']);
const ALLOWLIST_KNOWLEDGE_EXTS = new Set(['.md', '.txt', '.json', '.jsonl']);
const ALLOWLIST_DOMAIN_PACK_FILES = new Set([
  'manifest.json',
  'pack-manifest.json',
  'synonyms.json',
  'voice-kernel.md',
  'voice-pack.json',
  'discourse-anti-patterns.json',
  'contrastive-micro-pairs.json',
]);

const FORBIDDEN_BASENAMES = new Set([
  'user.md',
  'lessons.md',
  'auth.json',
  'credentials.json',
  'secrets.json',
  '.env',
  'vault.json',
]);

const FORBIDDEN_DIR_NAMES = new Set([
  'memory',
  'sessions',
  'cases',
  'ocr-cache',
  'books',
  'harvest',
  'e2e-run',
  'e2e-runs',
  'chat-state',
  'locks',
  'scratch',
  'node_modules',
  '.git',
]);

const FORBIDDEN_EXTS = new Set([
  '.beancount',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.token',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.env',
]);

// Dynamic host home-directory detectors (constructed without literal host path substrings).
const MAC_HOME_RE = new RegExp('(?:^|[\\s"\'(=`])/' + 'U' + 'sers/[^\\s"\'/]+', 'g');
const LINUX_HOME_RE = new RegExp('(?:^|[\\s"\'(=`])/' + 'h' + 'ome/[^\\s"\'/]+', 'g');
const WIN_HOME_RE = new RegExp('[A-Za-z]:\\\\' + 'U' + 'sers\\\\[^\\s"\'\\\\]+', 'g');

const SECRET_RULES = [
  { id: 'private_key_block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'openai_like_key', re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'github_pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { id: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { id: 'bot_token', re: /\b\d{8,11}:[A-Za-z0-9_-]{30,}\b/g },
  { id: 'bearer_secret', re: /\bBearer\s+[A-Za-z0-9._-]{32,}\b/g },
];

const PRIVATE_IP_RULES = [
  { id: 'cgnat_ip', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'rfc1918_192', re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'rfc1918_10', re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
];

function assertSafeId(value, label) {
  const s = String(value || '').trim();
  if (!s || !SAFE_ID_RE.test(s) || s.includes('..')) {
    throw new Error(`ERR_INVALID_${String(label || 'ID').toUpperCase()}:${s}`);
  }
  return s;
}

function assertValidVersion(version) {
  const s = String(version || '').trim();
  if (!SEMVER_RE.test(s)) {
    throw new Error(`ERR_INVALID_PACK_VERSION:${s}`);
  }
  return s;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function isForbiddenPath(relPath) {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].toLowerCase();
    if (seg.startsWith('.env')) return true;
    if (i < parts.length - 1 && FORBIDDEN_DIR_NAMES.has(seg)) return true;
    if (i === parts.length - 1) {
      if (FORBIDDEN_BASENAMES.has(seg)) return true;
      const ext = path.extname(seg);
      if (FORBIDDEN_EXTS.has(ext)) return true;
    }
  }
  return false;
}

function matchesAnyExclude(relPath, excludes = []) {
  const norm = String(relPath || '').replace(/\\/g, '/');
  for (const ex of excludes) {
    if (!ex) continue;
    if (ex instanceof RegExp) {
      if (ex.test(norm)) return true;
    } else {
      const s = String(ex).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!s) continue;
      if (norm === s || norm.startsWith(`${s}/`) || norm.includes(`/${s}/`)) return true;
    }
  }
  return false;
}

export function scanTextForPackLeaks(text, {
  filePath = '<memory>',
  forbiddenPatterns = [],
  canaryStrings = [],
  allowPrivateIps = false,
} = {}) {
  const content = String(text ?? '');
  const findings = [];

  const runRule = (ruleId, re) => {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    const match = rx.exec(content);
    if (match) {
      findings.push({
        file: filePath,
        rule: ruleId,
        sample: String(match[0]).trim().slice(0, 48),
      });
    }
  };

  for (const r of SECRET_RULES) runRule(r.id, r.re);
  runRule('mac_host_path', MAC_HOME_RE);
  runRule('linux_host_path', LINUX_HOME_RE);
  runRule('win_host_path', WIN_HOME_RE);

  if (!allowPrivateIps) {
    for (const r of PRIVATE_IP_RULES) runRule(r.id, r.re);
  }

  for (let i = 0; i < (forbiddenPatterns || []).length; i++) {
    const pat = forbiddenPatterns[i];
    if (!pat) continue;
    const rx = pat instanceof RegExp
      ? new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : `${pat.flags}g`)
      : new RegExp(String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const m = rx.exec(content);
    if (m) {
      findings.push({
        file: filePath,
        rule: `forbidden_pattern_${i}`,
        sample: String(m[0]).trim().slice(0, 48),
      });
    }
  }

  const lower = content.toLowerCase();
  for (let i = 0; i < (canaryStrings || []).length; i++) {
    const canary = String(canaryStrings[i] || '').trim();
    if (!canary) continue;
    if (lower.includes(canary.toLowerCase())) {
      findings.push({
        file: filePath,
        rule: `canary_${i}`,
        sample: canary.slice(0, 48),
      });
    }
  }

  return findings;
}

function walkPackFiles(rootDir, { excludeManifest = true } = {}) {
  const resolved = path.resolve(String(rootDir || ''));
  if (!fs.existsSync(resolved)) {
    throw new Error(`ERR_PACK_DIR_NOT_FOUND:${resolved}`);
  }
  const files = [];
  (function walk(dir, relBase) {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') && e.name !== '.scroll') continue;
      const full = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, rel);
      } else if (e.isFile()) {
        if (excludeManifest && rel === 'pack.manifest.json') continue;
        files.push({ full, rel });
      }
    }
  })(resolved, '');
  return files;
}

export function computePackContentDigest(packDir) {
  const files = walkPackFiles(packDir, { excludeManifest: true });
  const h = crypto.createHash('sha256');
  let totalBytes = 0;
  const manifestFiles = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const fileSha = crypto.createHash('sha256').update(buf).digest('hex');
    h.update(`${f.rel}\0${fileSha}\n`);
    totalBytes += buf.length;
    manifestFiles.push({ path: f.rel, bytes: buf.length, sha256: fileSha });
  }
  return {
    sha256: h.digest('hex'),
    fileCount: files.length,
    totalBytes,
    files: manifestFiles,
  };
}

function canonicalManifestSigningPayload(manifest) {
  const payload = {
    schema: manifest.schema,
    packId: manifest.packId,
    agentName: manifest.agentName,
    version: manifest.version,
    minScroll: manifest.minScroll,
    stateSchemaVersion: manifest.stateSchemaVersion,
    contentSha256: manifest.contentSha256,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    domainPacks: manifest.domainPacks || [],
    capabilities: manifest.capabilities || [],
    cronTemplates: manifest.cronTemplates || [],
    defaultWeights: manifest.defaultWeights || null,
    migrations: manifest.migrations || [],
    files: manifest.files || [],
  };
  if (manifest.channelPolicy && typeof manifest.channelPolicy === 'object') {
    payload.channelPolicy = manifest.channelPolicy;
  }
  if (manifest.uiMeta && typeof manifest.uiMeta === 'object') {
    payload.uiMeta = manifest.uiMeta;
  }
  if (manifest.defaultCapabilities && typeof manifest.defaultCapabilities === 'object') {
    payload.defaultCapabilities = manifest.defaultCapabilities;
  }
  if (manifest.voice && typeof manifest.voice === 'object') {
    payload.voice = manifest.voice;
  }
  if (Array.isArray(manifest.toolGroups) && manifest.toolGroups.length > 0) {
    payload.toolGroups = manifest.toolGroups;
  }
  if (Array.isArray(manifest.uiPanels) && manifest.uiPanels.length > 0) {
    payload.uiPanels = manifest.uiPanels;
  }
  return JSON.stringify(payload);
}

export function generatePackSigningKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function copyAllowlistedTree(srcDir, dstDir, { allowedExts, excludes = [], relPrefix = '' }) {
  if (!srcDir || !fs.existsSync(srcDir)) return 0;
  let copied = 0;
  (function walk(curSrc, relBase) {
    const ents = fs.readdirSync(curSrc, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const fullRel = relPrefix ? `${relPrefix}/${rel}` : rel;
      if (isForbiddenPath(fullRel) || matchesAnyExclude(rel, excludes) || matchesAnyExclude(fullRel, excludes)) {
        continue;
      }
      const fullSrc = path.join(curSrc, e.name);
      if (e.isDirectory()) {
        walk(fullSrc, rel);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (allowedExts && !allowedExts.has(ext)) continue;
        const fullDst = path.join(dstDir, rel);
        ensureDir(path.dirname(fullDst));
        fs.copyFileSync(fullSrc, fullDst);
        copied++;
      }
    }
  })(srcDir, '');
  return copied;
}

function copyDomainPack(dp, stagingDir) {
  const dpId = assertSafeId(dp.id || path.basename(String(dp.dir || '')), 'DOMAIN_PACK_ID');
  const srcRoot = path.resolve(String(dp.dir || ''));
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`ERR_DOMAIN_PACK_NOT_FOUND:${dpId}:${srcRoot}`);
  }
  const dstRoot = path.join(stagingDir, 'domain-packs', dpId);
  ensureDir(dstRoot);

  let manifestMeta = null;
  const manifestCandidates = [
    path.join(srcRoot, 'manifest.json'),
    path.join(srcRoot, 'compiled', 'pack-manifest.json'),
    path.join(srcRoot, 'pack-manifest.json'),
  ];
  for (const mp of manifestCandidates) {
    if (!fs.existsSync(mp)) continue;
    const raw = fs.readFileSync(mp, 'utf8');
    try {
      manifestMeta = JSON.parse(raw);
    } catch {
      throw new Error(`ERR_DOMAIN_PACK_INVALID_MANIFEST:${dpId}`);
    }
    if (mp === path.join(srcRoot, 'manifest.json')) {
      fs.writeFileSync(path.join(dstRoot, 'manifest.json'), raw, 'utf8');
    }
    break;
  }

  let copiedFiles = manifestMeta ? 1 : 0;
  const compiledDir = path.join(srcRoot, 'compiled');
  const copySource = fs.existsSync(compiledDir) ? compiledDir : srcRoot;
  const targetSub = fs.existsSync(compiledDir) ? path.join(dstRoot, 'compiled') : dstRoot;
  ensureDir(targetSub);

  const ents = fs.readdirSync(copySource, { withFileTypes: true });
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const fullSrc = path.join(copySource, e.name);
    if (e.isDirectory() && e.name === 'readable') {
      copiedFiles += copyAllowlistedTree(fullSrc, path.join(targetSub, 'readable'), {
        allowedExts: new Set(['.md', '.txt']),
        excludes: dp.excludes || [],
        relPrefix: `domain-packs/${dpId}/readable`,
      });
    } else if (e.isFile()) {
      const lower = e.name.toLowerCase();
      const allowed = ALLOWLIST_DOMAIN_PACK_FILES.has(lower)
        || lower.endsWith('.bitemporal.jsonl')
        || lower.endsWith('.records.jsonl');
      if (!allowed || isForbiddenPath(e.name)) continue;
      fs.copyFileSync(fullSrc, path.join(targetSub, e.name));
      copiedFiles++;
    }
  }

  return {
    id: dpId,
    version: String(dp.version || manifestMeta?.version || '1.0.0'),
    schema: manifestMeta?.schema || 'scroll-domain-pack/v1',
    fileCount: copiedFiles,
  };
}

export function buildAgentPack({
  sourceDir,
  agentName,
  outDir,
  packId = null,
  version = '1.0.0',
  minScroll = '2.8.0',
  includeKnowledge = true,
  knowledgeDir = null,
  knowledgeExclude = [],
  domainPacks = [],
  includeMcpLock = true,
  capabilities = [],
  cronTemplates = [],
  defaultWeights = null,
  defaultCapabilities = null,
  uiMeta = null,
  voice = null,
  toolGroups = [],
  uiPanels = [],
  channelPolicy = null,
  stateSchemaVersion = 1,
  migrations = [],
  privateKeyPem = null,
  forbiddenPatterns = [],
  canaryStrings = [],
  allowPrivateIps = false,
  now = new Date(),
} = {}) {
  const safeAgent = assertSafeId(agentName, 'AGENT_NAME');
  const safePackId = assertSafeId(packId || safeAgent, 'PACK_ID');
  const safeVersion = assertValidVersion(version);
  const srcRoot = path.resolve(String(sourceDir || ''));
  const srcAgentDir = path.join(srcRoot, 'agents', safeAgent);
  const identityFile = path.join(srcAgentDir, 'IDENTITY.md');
  if (!fs.existsSync(identityFile)) {
    throw new Error(`ERR_AGENT_IDENTITY_NOT_FOUND:${identityFile}`);
  }

  const finalOutDir = path.resolve(String(outDir || ''));
  ensureDir(path.dirname(finalOutDir));
  const stagingDir = `${finalOutDir}.staging.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  ensureDir(stagingDir);

  try {
    const dstAgentDir = path.join(stagingDir, 'agents', safeAgent);
    ensureDir(dstAgentDir);

    // 1. Strict allowlist copy of agent definition files (never USER.md or memory/)
    for (const fname of ALLOWLIST_AGENT_FILES) {
      const fsrc = path.join(srcAgentDir, fname);
      if (fs.existsSync(fsrc) && fs.statSync(fsrc).isFile()) {
        fs.copyFileSync(fsrc, path.join(dstAgentDir, fname));
      }
    }

    // 2. Allowlisted agent skills/ and evals/
    copyAllowlistedTree(path.join(srcAgentDir, 'skills'), path.join(dstAgentDir, 'skills'), {
      allowedExts: ALLOWLIST_SKILL_EXTS,
      relPrefix: `agents/${safeAgent}/skills`,
    });
    copyAllowlistedTree(path.join(srcAgentDir, 'evals'), path.join(dstAgentDir, 'evals'), {
      allowedExts: ALLOWLIST_EVAL_EXTS,
      relPrefix: `agents/${safeAgent}/evals`,
    });

    // 3. Optional clean shared knowledge/
    if (includeKnowledge) {
      const kbSrc = knowledgeDir ? path.resolve(srcRoot, knowledgeDir) : path.join(srcRoot, 'knowledge');
      if (fs.existsSync(kbSrc)) {
        copyAllowlistedTree(kbSrc, path.join(stagingDir, 'knowledge'), {
          allowedExts: ALLOWLIST_KNOWLEDGE_EXTS,
          excludes: knowledgeExclude,
          relPrefix: 'knowledge',
        });
      }
    }

    // 4. Optional embedded Domain Packs (e.g. compiled bi-temporal JSONL + readable + synonyms)
    const embeddedDomainPacks = [];
    for (const dp of Array.isArray(domainPacks) ? domainPacks : []) {
      if (!dp || !dp.dir) continue;
      embeddedDomainPacks.push(copyDomainPack(dp, stagingDir));
    }

    // 5. Optional pinned MCP descriptor lockfile
    if (includeMcpLock) {
      const lockSrc = path.join(srcRoot, '.scroll', 'mcp.lock.json');
      if (fs.existsSync(lockSrc) && fs.statSync(lockSrc).isFile()) {
        ensureDir(path.join(stagingDir, '.scroll'));
        fs.copyFileSync(lockSrc, path.join(stagingDir, '.scroll', 'mcp.lock.json'));
      }
    }

    // 6. Mandatory zero-leak scan across EVERY staged file before finalizing!
    const stagedFiles = walkPackFiles(stagingDir, { excludeManifest: true });
    const findings = [];
    for (const f of stagedFiles) {
      if (isForbiddenPath(f.rel)) {
        findings.push({ file: f.rel, rule: 'forbidden_entry', sample: f.rel });
        continue;
      }
      const txt = fs.readFileSync(f.full, 'utf8');
      const fileFindings = scanTextForPackLeaks(txt, {
        filePath: f.rel,
        forbiddenPatterns,
        canaryStrings,
        allowPrivateIps,
      });
      findings.push(...fileFindings);
    }

    if (findings.length > 0) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const err = new Error(`ERR_PACK_LEAK_DETECTED:${findings.length} finding(s) (${findings[0].file}:${findings[0].rule})`);
      err.code = 'ERR_PACK_LEAK_DETECTED';
      err.findings = findings;
      throw err;
    }

    // 7. Compute content-addressed SHA-256 digest & optional Ed25519 signature
    const digest = computePackContentDigest(stagingDir);
    const manifest = {
      schema: PACK_SCHEMA,
      packId: safePackId,
      agentName: safeAgent,
      version: safeVersion,
      minScroll: String(minScroll || '2.8.0'),
      stateSchemaVersion: Math.max(1, Number(stateSchemaVersion || 1)),
      builtAt: (now instanceof Date ? now : new Date(now)).toISOString(),
      contentSha256: digest.sha256,
      fileCount: digest.fileCount,
      totalBytes: digest.totalBytes,
      domainPacks: embeddedDomainPacks,
      capabilities: Array.isArray(capabilities) ? [...capabilities] : [],
      cronTemplates: Array.isArray(cronTemplates) ? [...cronTemplates] : [],
      defaultWeights: defaultWeights && typeof defaultWeights === 'object' ? defaultWeights : null,
      ...(defaultCapabilities && typeof defaultCapabilities === 'object' ? { defaultCapabilities } : {}),
      ...(uiMeta && typeof uiMeta === 'object' ? { uiMeta } : {}),
      ...(voice && typeof voice === 'object' ? { voice } : {}),
      ...(Array.isArray(toolGroups) && toolGroups.length > 0 ? { toolGroups: [...toolGroups] } : {}),
      ...(Array.isArray(uiPanels) && uiPanels.length > 0 ? { uiPanels: [...uiPanels] } : {}),
      ...(channelPolicy && typeof channelPolicy === 'object'
        ? { channelPolicy: normalizeChannelPolicy(channelPolicy) }
        : {}),
      migrations: Array.isArray(migrations) ? [...migrations] : [],
      files: digest.files,
      signature: null,
    };

    if (privateKeyPem) {
      const payload = canonicalManifestSigningPayload(manifest);
      const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64');
      manifest.signature = {
        algorithm: 'ed25519',
        value: sig,
      };
    }

    fs.writeFileSync(
      path.join(stagingDir, 'pack.manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    );

    if (fs.existsSync(finalOutDir)) {
      fs.rmSync(finalOutDir, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, finalOutDir);

    return {
      ok: true,
      packDir: finalOutDir,
      manifest,
      sha256: digest.sha256,
      signed: Boolean(manifest.signature),
    };
  } catch (err) {
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    throw err;
  }
}

export function verifyAgentPack({
  packDir,
  expectedSha256 = null,
  publicKeyPem = null,
  requireSignature = false,
  forbiddenPatterns = [],
  canaryStrings = [],
  allowPrivateIps = false,
} = {}) {
  const resolved = path.resolve(String(packDir || ''));
  const errors = [];
  const findings = [];

  if (!fs.existsSync(resolved)) {
    return { ok: false, packDir: resolved, errors: ['ERR_PACK_DIR_NOT_FOUND'], findings: [], verifiedSignature: false };
  }

  const manifestFile = path.join(resolved, 'pack.manifest.json');
  if (!fs.existsSync(manifestFile)) {
    return { ok: false, packDir: resolved, errors: ['ERR_PACK_MANIFEST_MISSING'], findings: [], verifiedSignature: false };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    return { ok: false, packDir: resolved, errors: ['ERR_PACK_MANIFEST_INVALID_JSON'], findings: [], verifiedSignature: false };
  }

  if (manifest.schema !== PACK_SCHEMA) {
    errors.push(`ERR_PACK_SCHEMA_MISMATCH:${manifest.schema}`);
  }
  if (!manifest.packId || !SAFE_ID_RE.test(String(manifest.packId))) {
    errors.push('ERR_PACK_INVALID_ID');
  }
  if (!manifest.agentName || !SAFE_ID_RE.test(String(manifest.agentName))) {
    errors.push('ERR_PACK_INVALID_AGENT_NAME');
  }
  if (!manifest.version || !SEMVER_RE.test(String(manifest.version))) {
    errors.push('ERR_PACK_INVALID_VERSION');
  }

  // Re-walk disk and compare exact file inventory + SHA-256 against manifest
  const diskDigest = computePackContentDigest(resolved);
  const expectedFiles = new Map((Array.isArray(manifest.files) ? manifest.files : []).map((f) => [f.path, f]));
  const diskFiles = new Map(diskDigest.files.map((f) => [f.path, f]));

  for (const [rel, meta] of expectedFiles.entries()) {
    const cur = diskFiles.get(rel);
    if (!cur) {
      errors.push(`ERR_PACK_FILE_MISSING:${rel}`);
    } else if (cur.sha256 !== meta.sha256 || cur.bytes !== meta.bytes) {
      errors.push(`ERR_PACK_FILE_TAMPERED:${rel}`);
    }
  }
  for (const rel of diskFiles.keys()) {
    if (!expectedFiles.has(rel)) {
      errors.push(`ERR_PACK_UNEXPECTED_FILE:${rel}`);
    }
  }

  if (diskDigest.sha256 !== manifest.contentSha256) {
    errors.push(`ERR_PACK_HASH_MISMATCH:expected=${manifest.contentSha256},actual=${diskDigest.sha256}`);
  }
  if (expectedSha256 && diskDigest.sha256 !== String(expectedSha256).trim()) {
    errors.push(`ERR_PACK_EXPECTED_SHA_MISMATCH:expected=${expectedSha256},actual=${diskDigest.sha256}`);
  }

  // Verify optional/required Ed25519 signature
  let verifiedSignature = false;
  if (publicKeyPem || requireSignature) {
    if (!manifest.signature || manifest.signature.algorithm !== 'ed25519' || !manifest.signature.value) {
      errors.push('ERR_PACK_SIGNATURE_MISSING');
    } else if (!publicKeyPem) {
      errors.push('ERR_PACK_PUBLIC_KEY_REQUIRED');
    } else {
      try {
        const payload = canonicalManifestSigningPayload(manifest);
        const okSig = crypto.verify(
          null,
          Buffer.from(payload, 'utf8'),
          publicKeyPem,
          Buffer.from(String(manifest.signature.value), 'base64'),
        );
        if (!okSig) {
          errors.push('ERR_PACK_SIGNATURE_INVALID');
        } else {
          verifiedSignature = true;
        }
      } catch {
        errors.push('ERR_PACK_SIGNATURE_INVALID');
      }
    }
  }

  // Re-run leak & forbidden-entry scan on receiver side (never trust builder)
  for (const f of walkPackFiles(resolved, { excludeManifest: true })) {
    if (isForbiddenPath(f.rel)) {
      findings.push({ file: f.rel, rule: 'forbidden_entry', sample: f.rel });
      continue;
    }
    const txt = fs.readFileSync(f.full, 'utf8');
    findings.push(...scanTextForPackLeaks(txt, {
      filePath: f.rel,
      forbiddenPatterns,
      canaryStrings,
      allowPrivateIps,
    }));
  }
  if (findings.length > 0) {
    errors.push(`ERR_PACK_LEAK_DETECTED:${findings.length}`);
  }

  return {
    ok: errors.length === 0,
    packDir: resolved,
    manifest,
    sha256: diskDigest.sha256,
    verifiedSignature,
    findings,
    errors,
  };
}

function loadDomainPackSynonyms(packDir) {
  const rules = [];
  const dpRoot = path.join(packDir, 'domain-packs');
  if (!fs.existsSync(dpRoot)) return rules;
  for (const ent of fs.readdirSync(dpRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const candidates = [
      path.join(dpRoot, ent.name, 'compiled', 'synonyms.json'),
      path.join(dpRoot, ent.name, 'synonyms.json'),
    ];
    for (const fp of candidates) {
      if (!fs.existsSync(fp)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rules) ? parsed.rules : []);
        for (const r of list) {
          const pat = r && (r.pattern || r.patternSource);
          if (pat && r.terms) {
            try {
              rules.push({ pattern: new RegExp(String(pat), 'i'), terms: String(r.terms) });
            } catch { /* ignore invalid regex entry */ }
          }
        }
      } catch { /* ignore malformed synonyms file */ }
    }
  }
  return rules;
}

function buildSharedPackKnowledge(packDir, sha256) {
  const roots = [];
  const kbDir = path.join(packDir, 'knowledge');
  if (fs.existsSync(kbDir)) roots.push({ label: 'pack:knowledge', dir: kbDir });

  const dpRoot = path.join(packDir, 'domain-packs');
  if (fs.existsSync(dpRoot)) {
    const ents = fs.readdirSync(dpRoot, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const compiled = path.join(dpRoot, e.name, 'compiled');
      roots.push({
        label: `domain-pack:${e.name}`,
        dir: fs.existsSync(compiled) ? compiled : path.join(dpRoot, e.name),
      });
    }
  }

  const synonyms = loadDomainPackSynonyms(packDir);
  const subIndexes = [];
  for (const r of roots) {
    const idx = indexKnowledge({ cwd: packDir, dir: r.dir });
    if (idx.active) subIndexes.push({ label: r.label, index: idx });
  }

  const allChunks = subIndexes.flatMap((s) => s.index.chunks);
  const totalCorpusChars = subIndexes.reduce((acc, s) => acc + s.index.totalCorpusChars, 0);
  const active = allChunks.length > 0;
  const hash = crypto.createHash('sha256')
    .update(`${sha256}:${subIndexes.map((s) => s.index.hash).join(',')}`)
    .digest('hex')
    .slice(0, 16);

  function retrieve(query, opts = {}) {
    const t0 = performance.now();
    if (!active) {
      return {
        query: String(query ?? ''),
        hits: [],
        chunks: [],
        selectedChars: 0,
        totalCorpusChars: 0,
        durationMs: 0,
      };
    }
    const topK = Math.max(1, Number(opts.topK || 4));
    const maxChars = Math.max(500, Number(opts.maxChars || 6000));
    const mergedSynonyms = [...synonyms, ...(Array.isArray(opts.synonyms) ? opts.synonyms : [])];
    const allHits = [];
    for (const s of subIndexes) {
      const res = retrieveKnowledge(s.index, query, {
        ...opts,
        topK: Math.max(topK * 2, 8),
        maxChars: Math.max(maxChars * 2, 12000),
        synonyms: mergedSynonyms,
      });
      for (const h of res.hits) {
        allHits.push({ ...h, sourceLayer: s.label });
      }
    }
    allHits.sort((a, b) => b.score - a.score);
    const selected = [];
    const seen = new Set();
    let usedChars = 0;
    for (const h of allHits) {
      if (selected.length >= topK) break;
      const key = `${h.sourceLayer}:${h.id}`;
      if (seen.has(key)) continue;
      if (selected.length > 0 && usedChars + h.chars > maxChars) continue;
      seen.add(key);
      selected.push(h);
      usedChars += h.chars;
    }
    return {
      query: String(query ?? ''),
      hits: selected,
      chunks: selected.map((h) => h.text),
      selectedChars: usedChars,
      totalCorpusChars,
      durationMs: +(performance.now() - t0).toFixed(2),
    };
  }

  return Object.freeze({
    active,
    readOnly: true,
    packSha256: sha256,
    hash,
    chunks: allChunks,
    totalCorpusChars,
    subIndexCount: subIndexes.length,
    synonymsCount: synonyms.length,
    retrieve,
    format: (chunks) => formatKnowledgeBlock(chunks, { hash }),
  });
}

export function createPackRegistry({
  packsRootDir,
  publicKeyPem = null,
  requireSignature = false,
  forbiddenPatterns = [],
  canaryStrings = [],
  allowPrivateIps = false,
} = {}) {
  const absRoot = path.resolve(String(packsRootDir || ''));
  const verifiedCache = new Map();
  const sharedKbCache = new Map();
  let kbCacheHits = 0;
  let kbCacheMisses = 0;

  function resolvePackPath(packId, version) {
    const safePack = assertSafeId(packId, 'PACK_ID');
    const safeVer = assertValidVersion(version);
    const candidate = path.resolve(absRoot, safePack, safeVer);
    if (!candidate.startsWith(absRoot + path.sep)) {
      throw new Error(`ERR_PACK_PATH_ESCAPE:${packId}/${version}`);
    }
    return candidate;
  }

  function resolvePack({ packId, version, expectedSha256 = null, packDir = null } = {}) {
    const dir = packDir ? path.resolve(String(packDir)) : resolvePackPath(packId, version);
    const verifyRes = verifyAgentPack({
      packDir: dir,
      expectedSha256,
      publicKeyPem,
      requireSignature,
      forbiddenPatterns,
      canaryStrings,
      allowPrivateIps,
    });
    if (!verifyRes.ok) {
      const err = new Error(`ERR_PACK_VERIFICATION_FAILED:${verifyRes.errors.join(',')}`);
      err.code = 'ERR_PACK_VERIFICATION_FAILED';
      err.errors = verifyRes.errors;
      err.findings = verifyRes.findings;
      throw err;
    }
    verifiedCache.set(verifyRes.sha256, verifyRes);
    return verifyRes;
  }

  function getSharedKnowledge({ packId, version, expectedSha256 = null, packDir = null } = {}) {
    if (expectedSha256 && sharedKbCache.has(expectedSha256)) {
      kbCacheHits++;
      return sharedKbCache.get(expectedSha256);
    }
    const resolved = resolvePack({ packId, version, expectedSha256, packDir });
    if (sharedKbCache.has(resolved.sha256)) {
      kbCacheHits++;
      return sharedKbCache.get(resolved.sha256);
    }
    kbCacheMisses++;
    const kb = buildSharedPackKnowledge(resolved.packDir, resolved.sha256);
    sharedKbCache.set(resolved.sha256, kb);
    return kb;
  }

  function listPacks() {
    if (!fs.existsSync(absRoot)) return [];
    const out = [];
    for (const pEnt of fs.readdirSync(absRoot, { withFileTypes: true })) {
      if (!pEnt.isDirectory() || pEnt.name.startsWith('.')) continue;
      const pDir = path.join(absRoot, pEnt.name);
      for (const vEnt of fs.readdirSync(pDir, { withFileTypes: true })) {
        if (!vEnt.isDirectory() || vEnt.name.startsWith('.')) continue;
        const mFile = path.join(pDir, vEnt.name, 'pack.manifest.json');
        if (!fs.existsSync(mFile)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(mFile, 'utf8'));
          out.push({
            packId: m.packId,
            agentName: m.agentName,
            version: m.version,
            sha256: m.contentSha256,
            packDir: path.join(pDir, vEnt.name),
            signed: Boolean(m.signature),
          });
        } catch { /* skip unreadable manifest */ }
      }
    }
    return out.sort((a, b) => `${a.packId}@${a.version}`.localeCompare(`${b.packId}@${b.version}`));
  }

  return {
    packsRootDir: absRoot,
    resolvePack,
    verifyPack: (opts) => verifyAgentPack({ publicKeyPem, requireSignature, forbiddenPatterns, canaryStrings, allowPrivateIps, ...opts }),
    getSharedKnowledge,
    listPacks,
    cacheStats: () => ({
      verifiedPacks: verifiedCache.size,
      sharedKnowledgeIndexes: sharedKbCache.size,
      kbCacheHits,
      kbCacheMisses,
    }),
  };
}
