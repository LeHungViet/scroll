// SCROLL 2.20.1 -- sec 61 Zero-Exposure Secret Handles (`SecretProvider`, extending `lib/vault.js`).
// Zero-dependency, vendor-neutral, pure ASCII OSS core (Node >= 20).
//
// Security invariants:
//   1. Owner DM ONLY: any `$secret` resolution from a group turn or group-originated slice
//      is hard-blocked (`ERR_SECRET_FORBIDDEN_IN_GROUP`).
//   2. Declared `secret_args` ONLY: `$secret` handles passed in undeclared arguments fail closed.
//   3. Machine-measured `secret_destination`: runtime-supplied browser/HTTP `activeOrigin`
//      must match the secret's non-empty `allowedDomains` (blocks phishing redirects).
//   4. Step-up modes: `none`, `per_job_origin` (persisted owner grant per jobId+origin), and
//      `each_use` (single-use token validated across all handles before burning once per call).
//   5. Two-way reverse redaction (`redactSecretsDeep`): scrubs plaintext, percent/form-encoded,
//      hex, Base64/Base64URL (all 3 byte-alignment offsets), object keys, and truncates past depth 12.
import crypto from 'node:crypto';
import { createSecretVault } from './vault.js';

export const SECRET_HANDLE_SCHEMA = 'scroll-secret-handle/v1';
export const SECRET_STEP_UP_MODES = Object.freeze(['none', 'per_job_origin', 'each_use']);
const MAX_HANDLE_SCAN_DEPTH = 16;
const MAX_REDACT_DEPTH = 12;

export function isSecretHandle(val) {
  return Boolean(
    val
    && typeof val === 'object'
    && !Array.isArray(val)
    && typeof val.$secret === 'string'
    && val.$secret.trim().length > 0
  );
}

export function normalizeOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') return null;
  try {
    const u = new URL(rawOrigin.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return {
      origin: u.origin.toLowerCase(),
      hostname: u.hostname.toLowerCase(),
      protocol: u.protocol.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function matchesAllowedDomain(activeOrigin, allowedDomains = [], { matchMode = 'exact_or_subdomain' } = {}) {
  const parsed = normalizeOrigin(activeOrigin);
  if (!parsed) return false;
  const list = Array.isArray(allowedDomains) ? allowedDomains.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean) : [];
  if (list.length === 0) return false;

  for (const rule of list) {
    // Allow full origin rule (e.g. "https://portal.example.gov") or hostname rule ("portal.example.gov")
    if (rule.startsWith('http://') || rule.startsWith('https://')) {
      const rp = normalizeOrigin(rule);
      if (rp && parsed.origin === rp.origin) return true;
      continue;
    }
    // Require https unless explicitly testing localhost/127.0.0.1
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocal) continue;

    if (parsed.hostname === rule) return true;
    if (matchMode === 'exact_or_subdomain' && parsed.hostname.endsWith(`.${rule}`)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodeFormStrict(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

function collectBase64Variants(rawBuf) {
  const out = [];
  const toUrl = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const add = (s) => {
    if (s && s.length >= 6) {
      out.push(s);
      const u = toUrl(s);
      if (u && u.length >= 6 && u !== s) out.push(u);
    }
  };

  // Offset 0 (standard encoding + unpadded)
  const b0 = rawBuf.toString('base64');
  if (b0.length >= 4) {
    out.push(b0);
    const b0NoPad = b0.replace(/=+$/, '');
    if (b0NoPad.length >= 4) out.push(b0NoPad);
    const u0 = toUrl(b0);
    if (u0.length >= 4) out.push(u0);
  }

  // Offset 0 core (strip last 1-2 chars if trailing bytes may mix with following suffix)
  if (rawBuf.length >= 6) {
    const core0 = b0.slice(0, Math.floor(rawBuf.length / 3) * 4);
    add(core0);
  }

  // Offset 1 (1 prefix byte before secret, e.g. Basic base64(user:pass))
  if (rawBuf.length >= 5) {
    const b1 = Buffer.concat([Buffer.from([0]), rawBuf]).toString('base64').replace(/=+$/, '');
    // First 2 base64 chars depend on prefix byte; trailing 1-2 chars depend on suffix
    const trimEnd = (rawBuf.length + 1) % 3 === 0 ? b1.length : b1.length - 2;
    if (trimEnd - 2 >= 6) add(b1.slice(2, trimEnd));
  }

  // Offset 2 (2 prefix bytes before secret)
  if (rawBuf.length >= 5) {
    const b2 = Buffer.concat([Buffer.from([0, 0]), rawBuf]).toString('base64').replace(/=+$/, '');
    const trimEnd = (rawBuf.length + 2) % 3 === 0 ? b2.length : b2.length - 2;
    if (trimEnd - 3 >= 6) add(b2.slice(3, trimEnd));
  }

  return out;
}

function compileRedactionPairs(activeSecrets) {
  const pairs = [];
  for (const s of Array.isArray(activeSecrets) ? activeSecrets : []) {
    if (!s || !s.value || String(s.value).length < 3) continue;
    const raw = String(s.value);
    const rawBuf = Buffer.from(raw, 'utf8');
    const label = `[secret:${String(s.name || 'redacted')}]`;
    const pct = encodeURIComponent(raw);
    const pctStrict = pct.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const form = encodeFormStrict(raw);
    const hexLower = rawBuf.toString('hex');
    const hexUpper = hexLower.toUpperCase();

    const variants = new Set([
      raw,
      pct,
      pctStrict,
      form,
      hexLower,
      hexUpper,
      ...collectBase64Variants(rawBuf),
    ]);
    // Sort longer variants first so full encodings are replaced before shorter cores
    const sorted = [...variants].filter((v) => v && v.length >= 3).sort((a, b) => b.length - a.length);
    for (const v of sorted) {
      pairs.push({ re: new RegExp(escapeRegExp(v), 'g'), label });
    }
  }
  return pairs;
}

function redactWithPairs(value, pairs, depth) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_REDACT_DEPTH) return '[TRUNCATED]';

  const scrubStr = (str) => {
    let out = str;
    for (const p of pairs) out = out.replace(p.re, p.label);
    return out;
  };

  if (typeof value === 'string') return scrubStr(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactWithPairs(item, pairs, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleanKey = scrubStr(k);
      out[cleanKey] = redactWithPairs(v, pairs, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactSecretsDeep(value, activeSecrets = [], depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_REDACT_DEPTH) return '[TRUNCATED]';
  const pairs = compileRedactionPairs(activeSecrets);
  if (pairs.length === 0) return value;
  return redactWithPairs(value, pairs, depth);
}

function findHandles(value, segments = [], displayPath = '', out = [], depth = 0) {
  if (value === null || value === undefined) return out;
  if (depth > MAX_HANDLE_SCAN_DEPTH) {
    const err = new Error('ERR_SECRET_ARGS_DEPTH_EXCEEDED');
    err.code = 'ERR_SECRET_ARGS_DEPTH_EXCEEDED';
    throw err;
  }
  if (isSecretHandle(value)) {
    out.push({ path: displayPath, segments: [...segments], handle: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findHandles(v, [...segments, i], `${displayPath}[${i}]`, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const nextDisplay = displayPath ? `${displayPath}.${k}` : k;
      findHandles(v, [...segments, k], nextDisplay, out, depth + 1);
    }
  }
  return out;
}

function setAtSegments(root, segments, newVal) {
  if (!Array.isArray(segments) || segments.length === 0) return;
  let cur = root;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = cur[segments[i]];
  }
  cur[segments[segments.length - 1]] = newVal;
}

function encodeCompositeKey(parts) {
  return JSON.stringify(parts.map((p) => String(p)));
}

export function createVaultSecretProvider({
  vault = null,
  vaultFilePath = null,
  masterKey = null,
  tenantId = 'default',
  clock = () => Date.now(),
} = {}) {
  const backingVault = vault || (vaultFilePath ? createSecretVault({ filePath: vaultFilePath, masterKey }) : null);
  const memSecrets = new Map();
  const policies = new Map();
  const jobOriginGrants = new Map();
  const eachUseTokens = new Map();

  const tid = String(tenantId);
  const nsKey = (name) => `sp:val:${encodeCompositeKey([tid, String(name).trim()])}`;
  const polVaultKey = (name) => `sp:pol:${encodeCompositeKey([tid, String(name).trim()])}`;
  const polIndexVaultKey = () => `sp:polidx:${encodeCompositeKey([tid])}`;
  const grantVaultKey = (name, jobId, origin) => `sp:grant:${encodeCompositeKey([tid, String(name).trim(), String(jobId).trim(), origin])}`;

  function vaultSet(k, v) {
    if (backingVault) backingVault.set(k, v);
    else memSecrets.set(k, v);
  }

  function vaultGet(k) {
    const v = backingVault ? backingVault.get(k) : memSecrets.get(k);
    return v === undefined ? null : v;
  }

  function loadPolicy(secretName) {
    const key = encodeCompositeKey([tid, String(secretName).trim()]);
    if (policies.has(key)) return policies.get(key);
    const raw = vaultGet(polVaultKey(secretName));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        policies.set(key, parsed);
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  function loadGrant(secretName, jobId, origin) {
    const key = encodeCompositeKey([tid, String(secretName).trim(), String(jobId).trim(), origin]);
    if (jobOriginGrants.has(key)) return jobOriginGrants.get(key);
    const raw = vaultGet(grantVaultKey(secretName, jobId, origin));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        jobOriginGrants.set(key, parsed);
        return parsed;
      }
    } catch {
      return null;
    }
    return null;
  }

  function recordPolicyNameInIndex(cleanName) {
    let names = [];
    const raw = vaultGet(polIndexVaultKey());
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) names = parsed;
      } catch {
        names = [];
      }
    }
    if (!names.includes(cleanName)) {
      names.push(cleanName);
      vaultSet(polIndexVaultKey(), JSON.stringify(names));
    }
  }

  function putSecret({
    name,
    value = null,
    fields = null,
    allowedDomains = [],
    stepUp = 'none',
    ownerOnly = true,
  } = {}) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('ERR_SECRET_NAME_REQUIRED');
    if (!SECRET_STEP_UP_MODES.includes(stepUp)) {
      throw new Error(`ERR_INVALID_STEP_UP_MODE:${stepUp}`);
    }
    const payload = fields && typeof fields === 'object'
      ? { ...fields }
      : { value: String(value ?? '') };
    vaultSet(nsKey(cleanName), JSON.stringify(payload));

    const pol = {
      name: cleanName,
      tenantId: tid,
      allowedDomains: Array.isArray(allowedDomains) ? allowedDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : [],
      stepUp,
      ownerOnly: ownerOnly !== false,
    };
    const key = encodeCompositeKey([tid, cleanName]);
    policies.set(key, pol);
    vaultSet(polVaultKey(cleanName), JSON.stringify(pol));
    recordPolicyNameInIndex(cleanName);
    return { ok: true, name: cleanName, stepUp, allowedDomains: [...pol.allowedDomains] };
  }

  function readRawFields(name) {
    const raw = vaultGet(nsKey(name));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : { value: String(raw) };
    } catch {
      return { value: String(raw) };
    }
  }

  function grantPerJobOrigin({ name, jobId, origin, approvedBy = 'owner', ttlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const norm = normalizeOrigin(origin);
    if (!norm) return { ok: false, code: 'ERR_INVALID_ORIGIN' };
    const cleanName = String(name || '').trim();
    const cleanJob = String(jobId || '').trim();
    if (!cleanName || !cleanJob) return { ok: false, code: 'ERR_INVALID_GRANT_ARGS' };
    const key = encodeCompositeKey([tid, cleanName, cleanJob, norm.origin]);
    const expiresAtMs = clock() + Math.max(60_000, Number(ttlMs || 0));
    const rec = { approvedBy: String(approvedBy), expiresAtMs };
    jobOriginGrants.set(key, rec);
    vaultSet(grantVaultKey(cleanName, cleanJob, norm.origin), JSON.stringify(rec));
    return { ok: true, key, origin: norm.origin, expiresAtMs };
  }

  function issueEachUseToken({
    name,
    approvedBy = 'owner',
    ttlMs = 120_000,
    jobId = null,
    origin = null,
    argsHash = null,
  } = {}) {
    const normOrigin = origin ? normalizeOrigin(origin)?.origin || null : null;
    if (origin && !normOrigin) return { ok: false, code: 'ERR_INVALID_ORIGIN' };
    const token = `su_${crypto.randomBytes(12).toString('hex')}`;
    const expiresAtMs = clock() + Math.max(5_000, Number(ttlMs || 120_000));
    eachUseTokens.set(token, {
      tenantId: tid,
      name: String(name || '').trim(),
      approvedBy: String(approvedBy),
      jobId: jobId ? String(jobId).trim() : null,
      origin: normOrigin,
      argsHash: argsHash ? String(argsHash).trim() : null,
      expiresAtMs,
      used: false,
    });
    return { ok: true, token, expiresAtMs };
  }

  function resolveToolArgs({
    toolSpec = {},
    args = {},
    ctx = {},
  } = {}) {
    let handles;
    try {
      handles = findHandles(args);
    } catch (err) {
      return {
        ok: false,
        code: err?.code || 'ERR_SECRET_ARGS_INVALID',
        errorClass: 'refused',
        reason: String(err?.message || err),
      };
    }

    if (handles.length === 0) {
      return {
        ok: true,
        hasSecrets: false,
        resolvedArgs: structuredClone(args),
        resolvedSecrets: [],
        redactOutput: (v) => v,
      };
    }

    // 1. HARD BLOCK: Owner DM ONLY -- never resolve secrets in groups or group-origin slices!
    if (ctx.isGroup === true || ctx.originIsGroup === true || ctx.isOwner !== true) {
      return {
        ok: false,
        code: 'ERR_SECRET_FORBIDDEN_IN_GROUP',
        errorClass: 'refused',
        reason: 'Secret handles ($secret) are forbidden in group turns and group-originated jobs.',
      };
    }

    const declaredSecretArgs = new Set(Array.isArray(toolSpec?.secret_args) ? toolSpec.secret_args.map(String) : []);
    const matchMode = toolSpec?.secret_destination?.match || 'exact_or_subdomain';
    const activeOrigin = ctx.activeOrigin || null;
    const normActiveOrigin = normalizeOrigin(activeOrigin);
    const nowMs = clock();

    // Two-pass validation: verify ALL handles, destinations, step-up tokens, and field existence
    // BEFORE mutating or burning any single-use token.
    const planned = [];
    const tokensToBurn = new Set();

    for (const { path: argPath, segments, handle } of handles) {
      const topArg = String(segments[0] ?? '');
      // 2. Declared `secret_args` ONLY
      if (!declaredSecretArgs.has(argPath) && !declaredSecretArgs.has(topArg)) {
        return {
          ok: false,
          code: 'ERR_UNDECLARED_SECRET_ARG',
          errorClass: 'refused',
          argPath,
          reason: `Argument "${argPath}" is not declared in toolSpec.secret_args.`,
        };
      }

      const secretName = String(handle.$secret).trim();
      const field = handle.field ? String(handle.field).trim() : 'value';
      const pol = loadPolicy(secretName);
      if (!pol) {
        return { ok: false, code: 'ERR_SECRET_NOT_FOUND', errorClass: 'refused', secretName };
      }
      if (pol.ownerOnly !== false && ctx.isOwner !== true) {
        return { ok: false, code: 'ERR_SECRET_FORBIDDEN_IN_GROUP', errorClass: 'refused', secretName };
      }

      // 3. Machine-measured `secret_destination` origin check: empty allowedDomains ALWAYS fails closed!
      if (!Array.isArray(pol.allowedDomains) || pol.allowedDomains.length === 0 || !activeOrigin || !matchesAllowedDomain(activeOrigin, pol.allowedDomains, { matchMode })) {
        return {
          ok: false,
          code: 'SECRET_DESTINATION_MISMATCH',
          errorClass: 'refused',
          secretName,
          activeOrigin,
          reason: `Active origin "${activeOrigin || 'missing'}" does not match non-empty allowedDomains for secret "${secretName}".`,
        };
      }

      // 4. Step-up verification (validate first; burn only after full pass succeeds)
      if (pol.stepUp === 'each_use') {
        const tokKey = ctx.stepUpToken ? String(ctx.stepUpToken) : '';
        const tok = tokKey ? eachUseTokens.get(tokKey) : null;
        const jobMatch = !tok?.jobId || tok.jobId === String(ctx.jobId || '').trim();
        const originMatch = !tok?.origin || (normActiveOrigin && tok.origin === normActiveOrigin.origin);
        const argsMatch = !tok?.argsHash || tok.argsHash === String(ctx.argsHash || '').trim();
        if (!tok || tok.used || tok.tenantId !== tid || tok.name !== secretName || nowMs >= tok.expiresAtMs || !jobMatch || !originMatch || !argsMatch) {
          return {
            ok: false,
            code: 'ERR_STEP_UP_EACH_USE_REQUIRED',
            errorClass: 'needs_owner',
            elevatedTier: 'financial',
            secretName,
            reason: `Secret "${secretName}" requires a fresh bound single-use financial step-up approval token.`,
          };
        }
        tokensToBurn.add(tok);
      } else if (pol.stepUp === 'per_job_origin') {
        const grant = normActiveOrigin && ctx.jobId ? loadGrant(secretName, ctx.jobId, normActiveOrigin.origin) : null;
        if (!grant || nowMs >= grant.expiresAtMs) {
          return {
            ok: false,
            code: 'ERR_STEP_UP_PER_JOB_ORIGIN_REQUIRED',
            errorClass: 'needs_owner',
            secretName,
            origin: normActiveOrigin?.origin || null,
            reason: `Secret "${secretName}" requires owner per_job_origin grant for job=${ctx.jobId || 'none'} origin=${normActiveOrigin?.origin || 'none'}.`,
          };
        }
      }

      const fields = readRawFields(secretName);
      if (!fields || !Object.prototype.hasOwnProperty.call(fields, field)) {
        return { ok: false, code: 'ERR_SECRET_FIELD_MISSING', errorClass: 'refused', secretName, field };
      }
      planned.push({ segments, secretName, field, plaintext: String(fields[field]) });
    }

    // Pass 2: Commit -- burn single-use tokens once per call and materialize args
    for (const tok of tokensToBurn) {
      tok.used = true;
    }
    const resolvedArgs = structuredClone(args);
    const resolvedSecrets = [];
    for (const item of planned) {
      setAtSegments(resolvedArgs, item.segments, item.plaintext);
      resolvedSecrets.push({ name: item.secretName, field: item.field, value: item.plaintext });
    }

    return {
      ok: true,
      hasSecrets: true,
      resolvedArgs,
      resolvedSecrets: resolvedSecrets.map((s) => ({ name: s.name, field: s.field })),
      redactOutput: (out) => redactSecretsDeep(out, resolvedSecrets),
    };
  }

  function listPolicies() {
    const rawIdx = vaultGet(polIndexVaultKey());
    if (rawIdx) {
      try {
        const names = JSON.parse(rawIdx);
        if (Array.isArray(names)) {
          for (const n of names) loadPolicy(n);
        }
      } catch {
        // ignore corrupt index
      }
    }
    return [...policies.values()].map((p) => ({ ...p, allowedDomains: [...p.allowedDomains] }));
  }

  return {
    tenantId: tid,
    putSecret,
    grantPerJobOrigin,
    issueEachUseToken,
    resolveToolArgs,
    listPolicies,
  };
}
