// SCROLL 2.20 -- sec 61 Zero-Exposure Secret Handles (`SecretProvider`, extending `lib/vault.js`).
// Zero-dependency, vendor-neutral, pure ASCII OSS core (Node >= 20).
//
// Security invariants:
//   1. Owner DM ONLY: any `$secret` resolution from a group turn or group-originated slice
//      is hard-blocked (`ERR_SECRET_FORBIDDEN_IN_GROUP`).
//   2. Declared `secret_args` ONLY: `$secret` handles passed in undeclared arguments fail closed.
//   3. Machine-measured `secret_destination`: runtime-supplied browser/HTTP `activeOrigin`
//      must match the secret's `allowedDomains` (blocks phishing redirects).
//   4. Step-up modes: `none`, `per_job_origin` (1 owner grant per jobId+origin), and `each_use`
//      (single-use token burned on resolution; financial-tier elevation).
//   5. Two-way reverse redaction (`redactSecretsDeep`): scrubs plaintext, URL-encoded, and Base64
//      forms of every resolved secret back to `[secret:<name>]` across logs, checkpoints & outputs.
import crypto from 'node:crypto';
import { createSecretVault } from './vault.js';

export const SECRET_HANDLE_SCHEMA = 'scroll-secret-handle/v1';
export const SECRET_STEP_UP_MODES = Object.freeze(['none', 'per_job_origin', 'each_use']);

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

export function redactSecretsDeep(value, activeSecrets = [], depth = 0) {
  if (depth > 12 || value === null || value === undefined) return value;
  const pairs = [];
  for (const s of Array.isArray(activeSecrets) ? activeSecrets : []) {
    if (!s || !s.value || String(s.value).length < 3) continue;
    const raw = String(s.value);
    const label = `[secret:${String(s.name || 'redacted')}]`;
    const variants = new Set([
      raw,
      encodeURIComponent(raw),
      Buffer.from(raw, 'utf8').toString('base64'),
    ]);
    for (const v of variants) {
      if (v && v.length >= 3) pairs.push({ re: new RegExp(escapeRegExp(v), 'g'), label });
    }
  }
  if (pairs.length === 0) return value;

  const scrubStr = (str) => {
    let out = str;
    for (const p of pairs) out = out.replace(p.re, p.label);
    return out;
  };

  if (typeof value === 'string') return scrubStr(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, activeSecrets, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactSecretsDeep(v, activeSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

function findHandles(value, currentPath = '', out = []) {
  if (value === null || value === undefined) return out;
  if (isSecretHandle(value)) {
    out.push({ path: currentPath, handle: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findHandles(v, `${currentPath}[${i}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      findHandles(v, currentPath ? `${currentPath}.${k}` : k, out);
    }
  }
  return out;
}

function setAtPath(root, dotPath, newVal) {
  const parts = dotPath.split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = newVal;
}

export function createVaultSecretProvider({
  vault = null,
  vaultFilePath = null,
  masterKey = null,
  tenantId = 'default',
  clock = () => Date.now(),
} = {}) {
  const backingVault = vault || (vaultFilePath ? createSecretVault({ filePath: vaultFilePath, masterKey }) : null);
  const memSecrets = new Map(); // fallback when no file vault is configured (e.g. unit tests)
  const policies = new Map();   // `${tenantId}:${name}` -> { allowedDomains, stepUp, ownerOnly }
  const jobOriginGrants = new Map(); // `${tenantId}:${name}:${jobId}:${origin}` -> { approvedBy, expiresAtMs }
  const eachUseTokens = new Map();   // token -> { tenantId, name, approvedBy, expiresAtMs, used }

  const nsKey = (name) => `tenant:${String(tenantId)}:${String(name).trim()}`;
  const polKey = (name) => `${String(tenantId)}:${String(name).trim()}`;

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
    const serialized = JSON.stringify(payload);
    if (backingVault) {
      backingVault.set(nsKey(cleanName), serialized);
    } else {
      memSecrets.set(nsKey(cleanName), serialized);
    }
    policies.set(polKey(cleanName), {
      name: cleanName,
      tenantId: String(tenantId),
      allowedDomains: Array.isArray(allowedDomains) ? allowedDomains.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : [],
      stepUp,
      ownerOnly: ownerOnly !== false,
    });
    return { ok: true, name: cleanName, stepUp, allowedDomains: policies.get(polKey(cleanName)).allowedDomains };
  }

  function readRawFields(name) {
    const k = nsKey(name);
    const raw = backingVault ? backingVault.get(k) : memSecrets.get(k);
    if (raw === undefined || raw === null) return null;
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
    const key = `${String(tenantId)}:${String(name).trim()}:${String(jobId).trim()}:${norm.origin}`;
    const expiresAtMs = clock() + Math.max(60_000, Number(ttlMs || 0));
    jobOriginGrants.set(key, { approvedBy: String(approvedBy), expiresAtMs });
    return { ok: true, key, origin: norm.origin, expiresAtMs };
  }

  function issueEachUseToken({ name, approvedBy = 'owner', ttlMs = 120_000 } = {}) {
    const token = `su_${crypto.randomBytes(12).toString('hex')}`;
    const expiresAtMs = clock() + Math.max(5_000, Number(ttlMs || 120_000));
    eachUseTokens.set(token, {
      tenantId: String(tenantId),
      name: String(name).trim(),
      approvedBy: String(approvedBy),
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
    const handles = findHandles(args);
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
    const nowMs = clock();

    const resolvedArgs = structuredClone(args);
    const resolvedSecrets = [];

    for (const { path: argPath, handle } of handles) {
      const topArg = argPath.split('.')[0].replace(/\[\d+\]$/, '');
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
      const pol = policies.get(polKey(secretName));
      if (!pol) {
        return { ok: false, code: 'ERR_SECRET_NOT_FOUND', errorClass: 'refused', secretName };
      }

      // 3. Machine-measured `secret_destination` origin check (blocks phishing!)
      if (pol.allowedDomains.length > 0 || toolSpec?.secret_destination) {
        if (!activeOrigin || !matchesAllowedDomain(activeOrigin, pol.allowedDomains, { matchMode })) {
          return {
            ok: false,
            code: 'SECRET_DESTINATION_MISMATCH',
            errorClass: 'refused',
            secretName,
            activeOrigin,
            reason: `Active origin "${activeOrigin || 'missing'}" does not match allowedDomains for secret "${secretName}".`,
          };
        }
      }

      // 4. Step-up verification
      if (pol.stepUp === 'each_use') {
        const tok = ctx.stepUpToken ? eachUseTokens.get(String(ctx.stepUpToken)) : null;
        if (!tok || tok.used || tok.tenantId !== String(tenantId) || tok.name !== secretName || nowMs >= tok.expiresAtMs) {
          return {
            ok: false,
            code: 'ERR_STEP_UP_EACH_USE_REQUIRED',
            errorClass: 'needs_owner',
            elevatedTier: 'financial',
            secretName,
            reason: `Secret "${secretName}" requires a fresh single-use financial step-up approval token.`,
          };
        }
        tok.used = true; // burn single-use token
      } else if (pol.stepUp === 'per_job_origin') {
        const norm = normalizeOrigin(activeOrigin);
        const gKey = norm && ctx.jobId ? `${String(tenantId)}:${secretName}:${String(ctx.jobId)}:${norm.origin}` : '';
        const grant = gKey ? jobOriginGrants.get(gKey) : null;
        if (!grant || nowMs >= grant.expiresAtMs) {
          return {
            ok: false,
            code: 'ERR_STEP_UP_PER_JOB_ORIGIN_REQUIRED',
            errorClass: 'needs_owner',
            secretName,
            origin: norm?.origin || null,
            reason: `Secret "${secretName}" requires owner per_job_origin grant for job=${ctx.jobId || 'none'} origin=${norm?.origin || 'none'}.`,
          };
        }
      }

      const fields = readRawFields(secretName);
      if (!fields || !Object.prototype.hasOwnProperty.call(fields, field)) {
        return { ok: false, code: 'ERR_SECRET_FIELD_MISSING', errorClass: 'refused', secretName, field };
      }
      const plaintext = String(fields[field]);
      setAtPath(resolvedArgs, argPath, plaintext);
      resolvedSecrets.push({ name: secretName, field, value: plaintext });
    }

    return {
      ok: true,
      hasSecrets: true,
      resolvedArgs,
      resolvedSecrets: resolvedSecrets.map((s) => ({ name: s.name, field: s.field })),
      redactOutput: (out) => redactSecretsDeep(out, resolvedSecrets),
    };
  }

  return {
    tenantId: String(tenantId),
    putSecret,
    grantPerJobOrigin,
    issueEachUseToken,
    resolveToolArgs,
    listPolicies: () => [...policies.values()].map((p) => ({ ...p })),
  };
}
