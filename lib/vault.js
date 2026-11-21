// SCROLL 2.5 -- §20.2 / D15 Zero-Dependency Encrypted Local Secret Vault & Fail-Closed Resolver.
//
// Resolves `${vault:KEY}` placeholders fail-closed from:
//   1. An optional encrypted local vault file (`.scroll/vault.enc`, AES-256-GCM + scrypt)
//   2. Explicit caller-provided `env` map (e.g., process.env)
//
// Unlike earlier versions that silently substituted empty strings on missing keys, SCROLL 2.5
// throws `vault_secret_missing:<KEY>` by default so misconfigured connectors fail closed before spawn.
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VAULT_PLACEHOLDER_RE = /\$\{vault:([A-Za-z0-9_.-]+)\}/g;

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 16384, r: 8, p: 1 });
}

function writeAtomicSecure(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* ignore */ }
  fs.renameSync(tmp, filePath);
}

export function createSecretVault({
  filePath = null,
  masterKey = null,
} = {}) {
  const absPath = filePath ? path.resolve(filePath) : null;
  let cache = null;

  function resolvePassphrase(overrideKey) {
    const k = overrideKey || masterKey || process.env.SCROLL_VAULT_KEY || null;
    if (!k) throw new Error('vault_master_key_required: pass masterKey or set SCROLL_VAULT_KEY');
    return String(k);
  }

  function loadAll(overrideKey = null) {
    if (!absPath || !fs.existsSync(absPath)) {
      cache = {};
      return { ...cache };
    }
    const raw = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    if (raw.format !== 'scroll-vault-v1' || raw.alg !== 'aes-256-gcm') {
      throw new Error('vault_invalid_format');
    }
    const salt = Buffer.from(raw.salt, 'base64');
    const iv = Buffer.from(raw.iv, 'base64');
    const tag = Buffer.from(raw.tag, 'base64');
    const ct = Buffer.from(raw.ciphertext, 'base64');
    const key = deriveKey(resolvePassphrase(overrideKey), salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain);
    cache = parsed && typeof parsed === 'object' ? parsed : {};
    return { ...cache };
  }

  function saveAll(secrets, overrideKey = null) {
    if (!absPath) throw new Error('vault_file_path_required');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(resolvePassphrase(overrideKey), salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plain = Buffer.from(JSON.stringify(secrets, null, 2), 'utf8');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = {
      format: 'scroll-vault-v1',
      alg: 'aes-256-gcm',
      kdf: 'scrypt',
      updatedAt: new Date().toISOString(),
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ct.toString('base64'),
    };
    writeAtomicSecure(absPath, JSON.stringify(envelope, null, 2) + '\n');
    cache = { ...secrets };
    return { ok: true, keys: Object.keys(secrets).length };
  }

  function get(name, overrideKey = null) {
    const data = cache || loadAll(overrideKey);
    return Object.prototype.hasOwnProperty.call(data, name) ? data[name] : undefined;
  }

  function set(name, value, overrideKey = null) {
    const data = cache ? { ...cache } : loadAll(overrideKey);
    data[String(name)] = String(value);
    return saveAll(data, overrideKey);
  }

  function remove(name, overrideKey = null) {
    const data = cache ? { ...cache } : loadAll(overrideKey);
    const existed = Object.prototype.hasOwnProperty.call(data, name);
    delete data[String(name)];
    if (existed) saveAll(data, overrideKey);
    return { ok: true, removed: existed };
  }

  function listKeys(overrideKey = null) {
    const data = cache || loadAll(overrideKey);
    return Object.keys(data).sort();
  }

  return {
    filePath: absPath,
    get,
    set,
    remove,
    listKeys,
    reload: (k) => { cache = null; return loadAll(k); },
  };
}

export function resolveVaultPlaceholders(val, {
  env = process.env,
  vault = null,
  failClosed = true,
} = {}) {
  if (typeof val !== 'string') return val;
  return val.replace(VAULT_PLACEHOLDER_RE, (_, key) => {
    let found;
    if (vault && typeof vault.get === 'function') {
      try { found = vault.get(key); } catch { found = undefined; }
    }
    if (found === undefined && env && Object.prototype.hasOwnProperty.call(env, key) && env[key] !== '') {
      found = env[key];
    }
    if (found === undefined || found === null) {
      if (failClosed) throw new Error(`vault_secret_missing:${key}`);
      return '';
    }
    return String(found);
  });
}

export function extractVaultKeys(val) {
  if (typeof val !== 'string') return [];
  const keys = [];
  let m;
  const re = new RegExp(VAULT_PLACEHOLDER_RE.source, 'g');
  while ((m = re.exec(val)) !== null) keys.push(m[1]);
  return keys;
}
