// SCROLL 2.0 -- §46 Unified AuthProvider (OAuth 2.0 PKCE, Device Code Flow, API key, Proxy, multi-account failover).
//
// Zero runtime dependencies. Node >= 20 built-ins only.
// Stores credentials atomically with mode 0600 outside git repos; redacts secrets on list/inspect.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

export const AUTH_SCHEMA = 'scroll-auth/1';

export const OAUTH_PROVIDERS = {
  openai: {
    id: 'openai',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    deviceCodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    supportsCodexAppServer: true,
  },
  google: {
    id: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    deviceCodeUrl: 'https://oauth2.googleapis.com/device/code',
    scopes: ['openid', 'email', 'profile'],
    supportsCodexAppServer: false,
  },
};

function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// RFC 7636 PKCE S256 challenge generator
export function createPkceChallenge() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64Url(crypto.randomBytes(16));
  return { verifier, challenge, method: 'S256', state };
}

export function buildAuthorizationUrl({
  authorizeUrl,
  provider = null,
  clientId,
  redirectUri,
  scope = null,
  challenge,
  state,
  extraParams = {},
} = {}) {
  const preset = provider ? OAUTH_PROVIDERS[provider] : null;
  const base = authorizeUrl || (preset && preset.authorizeUrl);
  if (!base) throw new Error('buildAuthorizationUrl: authorizeUrl or known provider is required');
  if (!clientId) throw new Error('buildAuthorizationUrl: clientId is required');
  if (!redirectUri) throw new Error('buildAuthorizationUrl: redirectUri is required');
  const url = new URL(base);
  const scopes = Array.isArray(scope)
    ? scope.join(' ')
    : (scope || (preset ? preset.scopes.join(' ') : 'openid'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', String(clientId));
  url.searchParams.set('redirect_uri', String(redirectUri));
  if (scopes) url.searchParams.set('scope', scopes);
  if (challenge) {
    url.searchParams.set('code_challenge', String(challenge));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (state) url.searchParams.set('state', String(state));
  for (const [k, v] of Object.entries(extraParams || {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function parseTokenPayload(json, nowMs) {
  const accessToken = json.access_token || json.accessToken || null;
  if (!accessToken) throw new Error('oauth_token_missing_access_token');
  const expiresIn = Number(json.expires_in || json.expiresIn || 3600);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(nowMs + expiresIn * 1000).toISOString()
    : null;
  return {
    accessToken,
    refreshToken: json.refresh_token || json.refreshToken || null,
    tokenType: json.token_type || json.tokenType || 'Bearer',
    scope: json.scope || null,
    idToken: json.id_token || null,
    expiresAt,
  };
}

async function postForm(url, params, { fetchImpl = globalThis.fetch, headers = {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') body.set(k, String(v));
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
    body: body.toString(),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json, text };
}

export async function exchangeAuthCode({
  tokenUrl,
  provider = null,
  clientId,
  clientSecret = null,
  code,
  verifier = null,
  redirectUri,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
} = {}) {
  const preset = provider ? OAUTH_PROVIDERS[provider] : null;
  const endpoint = tokenUrl || (preset && preset.tokenUrl);
  if (!endpoint) throw new Error('exchangeAuthCode: tokenUrl or known provider is required');
  if (!clientId || !code || !redirectUri) {
    throw new Error('exchangeAuthCode: clientId, code, and redirectUri are required');
  }
  const r = await postForm(endpoint, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }, { fetchImpl });
  if (!r.ok) {
    const err = new Error(r.json?.error_description || r.json?.error || `oauth_exchange_failed:${r.status}`);
    err.status = r.status;
    err.oauthError = r.json?.error || null;
    throw err;
  }
  return parseTokenPayload(r.json, clock());
}

// RFC 8628 Device Authorization Grant
export async function startDeviceAuth({
  deviceCodeUrl,
  provider = null,
  clientId,
  scope = null,
  extraParams = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const preset = provider ? OAUTH_PROVIDERS[provider] : null;
  const endpoint = deviceCodeUrl || (preset && preset.deviceCodeUrl);
  if (!endpoint) throw new Error('startDeviceAuth: deviceCodeUrl or known provider is required');
  if (!clientId) throw new Error('startDeviceAuth: clientId is required');
  const scopes = Array.isArray(scope)
    ? scope.join(' ')
    : (scope || (preset ? preset.scopes.join(' ') : 'openid'));
  const r = await postForm(endpoint, {
    client_id: clientId,
    scope: scopes,
    ...extraParams,
  }, { fetchImpl });
  if (!r.ok) {
    const err = new Error(r.json?.error_description || r.json?.error || `device_auth_start_failed:${r.status}`);
    err.status = r.status;
    throw err;
  }
  const j = r.json || {};
  return {
    deviceCode: j.device_code || j.deviceCode,
    userCode: j.user_code || j.userCode,
    verificationUri: j.verification_uri || j.verificationUri || j.verification_url || null,
    verificationUriComplete: j.verification_uri_complete || j.verificationUriComplete || null,
    expiresIn: Number(j.expires_in || 600),
    interval: Number(j.interval || 5),
  };
}

export async function pollDeviceToken({
  tokenUrl,
  provider = null,
  clientId,
  deviceCode,
  intervalMs = 5000,
  timeoutMs = 300_000,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => Date.now(),
} = {}) {
  const preset = provider ? OAUTH_PROVIDERS[provider] : null;
  const endpoint = tokenUrl || (preset && preset.tokenUrl);
  if (!endpoint || !clientId || !deviceCode) {
    throw new Error('pollDeviceToken: tokenUrl, clientId, and deviceCode are required');
  }
  const deadline = clock() + timeoutMs;
  let waitMs = Math.max(10, Number(intervalMs) || 5000);
  while (clock() < deadline) {
    const r = await postForm(endpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    }, { fetchImpl });
    if (r.ok) return parseTokenPayload(r.json, clock());
    const code = r.json?.error || '';
    if (code === 'authorization_pending') {
      await sleepImpl(waitMs);
      continue;
    }
    if (code === 'slow_down') {
      waitMs += 5000;
      await sleepImpl(waitMs);
      continue;
    }
    const err = new Error(r.json?.error_description || code || `device_poll_failed:${r.status}`);
    err.status = r.status;
    err.oauthError = code || null;
    throw err;
  }
  const err = new Error('device_auth_timeout');
  err.oauthError = 'expired_token';
  throw err;
}

function redactSecret(val) {
  if (!val) return null;
  const s = String(val);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function sanitizeProfile(p, includeSecrets) {
  const copy = { ...p };
  if (!includeSecrets) {
    if (copy.accessToken) copy.accessToken = redactSecret(copy.accessToken);
    if (copy.refreshToken) copy.refreshToken = redactSecret(copy.refreshToken);
    if (copy.apiKey) copy.apiKey = redactSecret(copy.apiKey);
    if (copy.clientSecret) copy.clientSecret = redactSecret(copy.clientSecret);
    if (copy.extraHeaders && typeof copy.extraHeaders === 'object') {
      const safe = {};
      for (const [k, v] of Object.entries(copy.extraHeaders)) {
        safe[k] = /auth|key|token|secret/i.test(k) ? redactSecret(v) : v;
      }
      copy.extraHeaders = safe;
    }
  }
  return copy;
}

function writeAtomicSecure(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    const fd = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* fsync optional on virtual filesystems */ }
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* ignore on non-POSIX */ }
}

function isRateLimitError(err) {
  if (!err) return false;
  if (Number(err.status) === 429) return true;
  const msg = String(err.message || err).toLowerCase();
  return /429|rate.?limit|quota|too many requests|resource_exhausted/.test(msg);
}

function isAuthError(err) {
  if (!err) return false;
  const st = Number(err.status);
  if (st === 401 || st === 403) return true;
  const msg = String(err.message || err).toLowerCase();
  return /401|403|unauthorized|invalid_token|invalid_grant|expired_token|authentication/.test(msg);
}

export async function runLoopbackOAuthCallback({
  host = '127.0.0.1',
  port = 0,
  callbackPath = '/callback',
  expectedState = null,
  timeoutMs = 180_000,
} = {}) {
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let settled = false;
  let timer = null;

  const finish = (err, val) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    try { server.close(); } catch { /* ignore */ }
    if (err) rejectResult(err);
    else resolveResult(val);
  };

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');
      const oauthErrorDesc = url.searchParams.get('error_description');
      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Authentication failed</h2><p>You may close this window.</p></body></html>');
        const err = new Error(oauthErrorDesc || oauthError);
        err.oauthError = oauthError;
        finish(err);
        return;
      }
      if (expectedState && state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Invalid OAuth state</h2></body></html>');
        finish(new Error('oauth_state_mismatch'));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Missing authorization code</h2></body></html>');
        finish(new Error('oauth_missing_code'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Authentication received</h2><p>You may close this window and return to SCROLL.</p></body></html>');
      finish(null, { code, state });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Error');
      finish(err);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const redirectUri = `http://${host}:${actualPort}${callbackPath}`;
  timer = setTimeout(() => finish(new Error('oauth_loopback_timeout')), Math.max(1000, Number(timeoutMs || 180_000)));
  if (timer.unref) timer.unref();

  return {
    redirectUri,
    port: actualPort,
    waitForCode: () => resultPromise,
    close: () => finish(new Error('oauth_loopback_closed')),
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function withAuthFileLock(absPath, fn, { timeoutMs = 6000, staleMs = 30_000 } = {}) {
  if (!absPath) return fn();
  const lockPath = `${absPath}.lock`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o700 });
  const ownerToken = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: ownerToken, ts: Date.now() }) + '\n');
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // Serialize stale-lock reaping behind an exclusive `.reap` lock so two concurrent waiters
      // can NEVER double-unlink a freshly acquired lock from a third writer!
      const reapPath = `${lockPath}.reap`;
      let reapFd = null;
      try {
        reapFd = fs.openSync(reapPath, 'wx', 0o600);
        try { fs.writeFileSync(reapFd, JSON.stringify({ pid: process.pid, token: ownerToken, ts: Date.now() }) + '\n'); } catch { /* ignore */ }
      } catch (reapErr) {
        if (reapErr?.code === 'EEXIST') {
          try {
            let reapStale = false;
            try {
              const rInfo = JSON.parse(fs.readFileSync(reapPath, 'utf8'));
              if (rInfo?.pid && !isPidAlive(Number(rInfo.pid))) reapStale = true;
            } catch {
              const rst = fs.statSync(reapPath);
              if (Date.now() - rst.mtimeMs > Math.max(5_000, staleMs)) reapStale = true;
            }
            if (reapStale) {
              // Atomic rename before unlink: only ONE waiter wins the rename; a freshly recreated `.reap` is never unlinked!
              const retired = `${reapPath}.stale.${ownerToken}`;
              fs.renameSync(reapPath, retired);
              try { fs.rmSync(retired, { force: true }); } catch { /* ignore */ }
            }
          } catch { /* another waiter already reclaimed or lock refreshed */ }
        }
      }
      if (reapFd !== null) {
        try {
          let reaped = false;
          try {
            const raw = fs.readFileSync(lockPath, 'utf8');
            const info = JSON.parse(raw);
            if (info.pid && !isPidAlive(Number(info.pid))) {
              fs.rmSync(lockPath, { force: true });
              reaped = true;
            }
          } catch {
            try {
              const st = fs.statSync(lockPath);
              if (Date.now() - st.mtimeMs > staleMs) {
                fs.rmSync(lockPath, { force: true });
                reaped = true;
              }
            } catch { /* already gone */ }
          }
          if (reaped) continue;
        } finally {
          try { fs.closeSync(reapFd); } catch { /* ignore */ }
          try { fs.rmSync(reapPath, { force: true }); } catch { /* ignore */ }
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`auth_lock_timeout:${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 40)));
    }
  }
  try {
    return await fn();
  } finally {
    // Compare owner token before releasing so we NEVER delete another process's lockfile
    try {
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (cur && cur.token === ownerToken) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch { /* ignore */ }
  }
}

export function createAuthStore({
  filePath = null,
  clock = () => Date.now(),
  fetchImpl = globalThis.fetch,
  defaultCooldownMs = 60_000,
  maxCooldownMs = 900_000,
} = {}) {
  const absPath = filePath ? path.resolve(filePath) : null;

  function emptyState() {
    return { schema: AUTH_SCHEMA, defaults: {}, profiles: {} };
  }

  function load() {
    if (!absPath || !fs.existsSync(absPath)) return emptyState();
    const raw = fs.readFileSync(absPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      schema: parsed.schema || AUTH_SCHEMA,
      defaults: parsed.defaults && typeof parsed.defaults === 'object' ? { ...parsed.defaults } : {},
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? { ...parsed.profiles } : {},
    };
  }

  let memState = load();

  function persist(changedProfileId = null) {
    if (!absPath) return;
    // Merge-before-write: preserve newer profile rotations written by concurrent processes
    if (fs.existsSync(absPath)) {
      try {
        const disk = load();
        for (const [id, dp] of Object.entries(disk.profiles || {})) {
          if (id === changedProfileId) continue;
          const mp = memState.profiles[id];
          if (!mp) continue;
          const diskTs = Date.parse(dp?.updatedAt || 0);
          const memTs = Date.parse(mp?.updatedAt || 0);
          if (Number.isFinite(diskTs) && Number.isFinite(memTs) && diskTs > memTs) {
            memState.profiles[id] = dp;
          }
        }
      } catch { /* ignore unreadable disk snapshot */ }
    }
    writeAtomicSecure(absPath, memState);
  }

  function reload() {
    memState = load();
    return memState;
  }

  function listProfiles({ provider = null, includeSecrets = false } = {}) {
    const items = Object.values(memState.profiles)
      .filter((p) => !provider || p.provider === provider)
      .sort((a, b) => (Number(a.priority || 100) - Number(b.priority || 100)) || String(a.id).localeCompare(String(b.id)));
    return items.map((p) => ({
      ...sanitizeProfile(p, includeSecrets),
      isDefault: memState.defaults[p.provider] === p.id,
      inCooldown: Boolean(p.cooldownUntil && Date.parse(p.cooldownUntil) > clock()),
    }));
  }

  function getProfile(id, { includeSecrets = false } = {}) {
    const p = memState.profiles[id];
    if (!p) return null;
    return {
      ...sanitizeProfile(p, includeSecrets),
      isDefault: memState.defaults[p.provider] === p.id,
      inCooldown: Boolean(p.cooldownUntil && Date.parse(p.cooldownUntil) > clock()),
    };
  }

  function upsertProfile(profile) {
    if (!profile || !profile.id || !profile.provider) {
      throw new Error('upsertProfile: id and provider are required');
    }
    const id = String(profile.id).trim();
    const type = profile.type || (profile.apiKey ? 'api_key' : (profile.baseUrl ? 'proxy' : 'oauth'));
    if (!['oauth', 'api_key', 'proxy', 'codex_app_server'].includes(type)) {
      throw new Error(`upsertProfile: unsupported type "${type}"`);
    }
    const prev = memState.profiles[id] || {};
    const next = {
      ...prev,
      ...profile,
      id,
      provider: String(profile.provider).trim(),
      type,
      priority: Number.isFinite(Number(profile.priority)) ? Number(profile.priority) : (prev.priority ?? 100),
      disabled: profile.disabled === true,
      failures: Number.isFinite(Number(profile.failures)) ? Number(profile.failures) : (prev.failures ?? 0),
      updatedAt: new Date(clock()).toISOString(),
    };
    memState.profiles[id] = next;
    if (!memState.defaults[next.provider] || profile.isDefault === true) {
      memState.defaults[next.provider] = id;
    }
    persist();
    return sanitizeProfile(next, false);
  }

  function removeProfile(id) {
    const prev = memState.profiles[id];
    if (!prev) return { ok: false, removed: false };
    delete memState.profiles[id];
    if (memState.defaults[prev.provider] === id) {
      const replacement = Object.values(memState.profiles).find((p) => p.provider === prev.provider);
      if (replacement) memState.defaults[prev.provider] = replacement.id;
      else delete memState.defaults[prev.provider];
    }
    persist();
    return { ok: true, removed: true };
  }

  function setDefault(provider, profileId) {
    const p = memState.profiles[profileId];
    if (!p || p.provider !== provider) {
      throw new Error(`setDefault: profile "${profileId}" not found for provider "${provider}"`);
    }
    memState.defaults[provider] = profileId;
    persist();
    return { ok: true, provider, profileId };
  }

  const inflightRefreshes = new Map();

  async function refreshTokenIfNeeded(profileId, { skewMs = 120_000, force = false } = {}) {
    if (inflightRefreshes.has(profileId) && !force) {
      return inflightRefreshes.get(profileId);
    }
    const task = withAuthFileLock(absPath, async () => {
      // Compare-before-write: reload from disk inside lock in case another process already refreshed!
      if (absPath && fs.existsSync(absPath)) {
        try { memState = load(); } catch { /* keep in-memory state if unreadable */ }
      }
      const p = memState.profiles[profileId];
      if (!p) throw new Error(`refreshTokenIfNeeded: unknown profile "${profileId}"`);
      if (p.type !== 'oauth') return { refreshed: false, profile: p };
      const nowMs = clock();
      const expMs = p.expiresAt ? Date.parse(p.expiresAt) : Infinity;
      const needsRefresh = force || !p.accessToken || (Number.isFinite(expMs) && expMs - nowMs <= skewMs);
      if (!needsRefresh) return { refreshed: false, profile: p };
      if (!p.refreshToken) {
        if (!force && p.accessToken && expMs > nowMs) return { refreshed: false, profile: p };
        const err = new Error(`oauth_refresh_token_missing:${profileId}`);
        err.status = 401;
        throw err;
      }
      const preset = OAUTH_PROVIDERS[p.provider] || null;
      const tokenUrl = p.tokenUrl || (preset && preset.tokenUrl);
      if (!tokenUrl) throw new Error(`oauth_token_url_missing:${profileId}`);
      const r = await postForm(tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: p.refreshToken,
        client_id: p.clientId || '',
        client_secret: p.clientSecret || '',
      }, { fetchImpl });
      if (!r.ok) {
        const code = r.json?.error || '';
        const permanent = code === 'invalid_grant' || code === 'unauthorized_client' || r.status === 401 || r.status === 403;
        reportAuthFailure(profileId, { error: r.json?.error_description || code || `refresh_failed:${r.status}`, permanent });
        const err = new Error(r.json?.error_description || code || `refresh_failed:${r.status}`);
        err.status = r.status;
        err.oauthError = code || null;
        throw err;
      }
      const tok = parseTokenPayload(r.json, clock());
      p.accessToken = tok.accessToken;
      if (tok.refreshToken) p.refreshToken = tok.refreshToken;
      p.expiresAt = tok.expiresAt;
      p.tokenType = tok.tokenType || 'Bearer';
      p.failures = 0;
      p.cooldownUntil = null;
      p.lastError = null;
      p.updatedAt = new Date(clock()).toISOString();
      persist();
      return { refreshed: true, profile: p };
    });
    inflightRefreshes.set(profileId, task);
    try {
      return await task;
    } finally {
      if (inflightRefreshes.get(profileId) === task) {
        inflightRefreshes.delete(profileId);
      }
    }
  }

  function reportRateLimit(profileId, { retryAfterMs = null, error = 'rate_limited' } = {}) {
    const p = memState.profiles[profileId];
    if (!p) return null;
    p.failures = Number(p.failures || 0) + 1;
    const backoff = retryAfterMs != null && Number.isFinite(Number(retryAfterMs))
      ? Math.max(1000, Number(retryAfterMs))
      : Math.min(maxCooldownMs, defaultCooldownMs * Math.pow(2, Math.min(4, p.failures - 1)));
    p.cooldownUntil = new Date(clock() + backoff).toISOString();
    p.lastError = String(error || 'rate_limited').slice(0, 300);
    p.updatedAt = new Date(clock()).toISOString();
    persist();
    return { profileId, cooldownUntil: p.cooldownUntil, failures: p.failures };
  }

  function reportAuthFailure(profileId, { error = 'auth_failed', permanent = false } = {}) {
    const p = memState.profiles[profileId];
    if (!p) return null;
    p.failures = Number(p.failures || 0) + 1;
    p.lastError = String(error || 'auth_failed').slice(0, 300);
    if (permanent) {
      p.disabled = true;
    } else {
      p.cooldownUntil = new Date(clock() + Math.min(maxCooldownMs, defaultCooldownMs * 2)).toISOString();
    }
    p.updatedAt = new Date(clock()).toISOString();
    persist();
    return { profileId, disabled: p.disabled, cooldownUntil: p.cooldownUntil };
  }

  function reportSuccess(profileId) {
    const p = memState.profiles[profileId];
    if (!p) return null;
    if (p.failures || p.cooldownUntil || p.lastError) {
      p.failures = 0;
      p.cooldownUntil = null;
      p.lastError = null;
      p.updatedAt = new Date(clock()).toISOString();
      persist();
    }
    return { profileId, ok: true };
  }

  function rankCandidates(provider, { preferredProfileId = null, excludeIds = new Set() } = {}) {
    const nowMs = clock();
    const defId = memState.defaults[provider] || null;
    const all = Object.values(memState.profiles).filter((p) => p.provider === provider && !p.disabled && !excludeIds.has(p.id));
    const score = (p) => {
      let s = Number(p.priority ?? 100);
      if (preferredProfileId && p.id === preferredProfileId) s -= 10000;
      else if (defId && p.id === defId) s -= 1000;
      return s;
    };
    const ready = all.filter((p) => !p.cooldownUntil || Date.parse(p.cooldownUntil) <= nowMs).sort((a, b) => score(a) - score(b));
    if (ready.length) return { ready, fallbackCooling: [] };
    const cooling = all.sort((a, b) => (Date.parse(a.cooldownUntil || 0) - Date.parse(b.cooldownUntil || 0)) || (score(a) - score(b)));
    return { ready: [], fallbackCooling: cooling };
  }

  async function acquireCredential(provider, { preferredProfileId = null, excludeIds = new Set(), skewMs = 120_000, allowCoolingFallback = false } = {}) {
    const { ready, fallbackCooling } = rankCandidates(provider, { preferredProfileId, excludeIds });
    const candidates = ready.length ? ready : (allowCoolingFallback ? fallbackCooling : []);
    if (!candidates.length) {
      const err = new Error(fallbackCooling.length
        ? `auth_all_profiles_in_cooldown:${provider}`
        : `auth_no_profile:${provider}`);
      err.code = fallbackCooling.length ? 'ALL_IN_COOLDOWN' : 'NO_PROFILE';
      err.nextAvailableAt = fallbackCooling[0]?.cooldownUntil || null;
      throw err;
    }
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        if (candidate.type === 'oauth') {
          await refreshTokenIfNeeded(candidate.id, { skewMs });
        }
        const live = memState.profiles[candidate.id];
        const token = live.type === 'oauth' ? live.accessToken : (live.apiKey || live.accessToken || null);
        const headers = { ...(live.extraHeaders || {}) };
        if (token && !headers.Authorization && live.type !== 'codex_app_server') {
          headers.Authorization = `${live.tokenType || 'Bearer'} ${token}`;
        }
        return {
          profileId: live.id,
          provider: live.provider,
          type: live.type,
          label: live.label || live.id,
          token,
          baseUrl: live.baseUrl || null,
          headers,
          expiresAt: live.expiresAt || null,
        };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error(`auth_acquire_failed:${provider}`);
  }

  async function withFailover(provider, fn, { preferredProfileId = null, maxAttempts = 4 } = {}) {
    const tried = new Set();
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let cred;
      try {
        cred = await acquireCredential(provider, {
          preferredProfileId: attempt === 0 ? preferredProfileId : null,
          excludeIds: tried,
        });
      } catch (e) {
        throw lastErr || e;
      }
      tried.add(cred.profileId);
      try {
        const result = await fn(cred);
        reportSuccess(cred.profileId);
        return { result, profileId: cred.profileId, attempts: attempt + 1 };
      } catch (err) {
        lastErr = err;
        if (isRateLimitError(err)) {
          reportRateLimit(cred.profileId, { retryAfterMs: err.retryAfterMs ?? null, error: err.message });
          continue;
        }
        if (isAuthError(err)) {
          reportAuthFailure(cred.profileId, { error: err.message, permanent: err.oauthError === 'invalid_grant' });
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error(`auth_failover_exhausted:${provider}`);
  }

  return {
    filePath: absPath,
    reload,
    listProfiles,
    getProfile,
    upsertProfile,
    removeProfile,
    setDefault,
    refreshTokenIfNeeded,
    acquireCredential,
    reportRateLimit,
    reportAuthFailure,
    reportSuccess,
    withFailover,
  };
}
