// SCROLL 2.0 smoke + mutation test -- §46 AuthProvider & Persistent Codex App-Server RPC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPkceChallenge,
  buildAuthorizationUrl,
  exchangeAuthCode,
  startDeviceAuth,
  pollDeviceToken,
  createAuthStore,
} from '../lib/auth.js';
import { createCodexAppServerClient } from '../lib/codex-app-server.js';
import { pickProvider } from '../lib/providers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v20-auth-'));
let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    console.log('  \x1b[32m✔\x1b[0m', name);
    pass++;
  } catch (e) {
    console.log('  \x1b[31m✖\x1b[0m', name, '--', e.message);
    fail++;
  }
}

console.log('SCROLL 2.0 -- §46 AuthProvider & Codex App-Server');

await t('PKCE S256 challenge & authorization URL build cleanly', () => {
  const pkce = createPkceChallenge();
  assert.ok(pkce.verifier.length >= 43);
  assert.ok(pkce.challenge.length >= 43);
  assert.equal(pkce.method, 'S256');
  const url = buildAuthorizationUrl({
    provider: 'openai',
    clientId: 'client-123',
    redirectUri: 'http://127.0.0.1:8787/cb',
    challenge: pkce.challenge,
    state: pkce.state,
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('client_id'), 'client-123');
  assert.equal(u.searchParams.get('state'), pkce.state);
});

await t('OAuth code exchange + RFC 8628 Device Flow poll handles authorization_pending & slow_down', async () => {
  let pollCalls = 0;
  const mockFetch = async (url, opts) => {
    const body = new URLSearchParams(opts.body);
    const grant = body.get('grant_type');
    if (url.includes('deviceauth')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          device_code: 'dev-xyz',
          user_code: 'ABCD-1234',
          verification_uri: 'https://auth.example.test/device',
          expires_in: 600,
          interval: 1,
        }),
      };
    }
    if (grant === 'authorization_code') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'tok-pkce-1', refresh_token: 'ref-1', expires_in: 3600 }),
      };
    }
    pollCalls++;
    if (pollCalls === 1) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'authorization_pending' }) };
    }
    if (pollCalls === 2) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'slow_down' }) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'tok-device-ok', refresh_token: 'ref-dev', expires_in: 1800 }),
    };
  };

  const pkceTok = await exchangeAuthCode({
    provider: 'openai',
    clientId: 'cid',
    code: 'code-1',
    verifier: 'ver-1',
    redirectUri: 'http://127.0.0.1:8787/cb',
    fetchImpl: mockFetch,
  });
  assert.equal(pkceTok.accessToken, 'tok-pkce-1');

  const dev = await startDeviceAuth({ provider: 'openai', clientId: 'cid', fetchImpl: mockFetch });
  assert.equal(dev.userCode, 'ABCD-1234');
  const polled = await pollDeviceToken({
    provider: 'openai',
    clientId: 'cid',
    deviceCode: dev.deviceCode,
    intervalMs: 10,
    timeoutMs: 5000,
    fetchImpl: mockFetch,
    sleepImpl: async () => {},
  });
  assert.equal(polled.accessToken, 'tok-device-ok');
  assert.equal(pollCalls, 3);
});

await t('AuthStore 0600 persistence, secret redaction, OAuth auto-refresh, and 429 multi-account failover', async () => {
  let now = Date.parse('2026-11-21T10:00:00Z');
  let refreshCount = 0;
  const mockFetch = async () => {
    refreshCount++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: `refreshed-tok-${refreshCount}`,
        refresh_token: 'ref-next',
        expires_in: 3600,
      }),
    };
  };
  const authPath = path.join(tmp, 'auth.json');
  const store = createAuthStore({ filePath: authPath, clock: () => now, fetchImpl: mockFetch, defaultCooldownMs: 30_000 });
  store.upsertProfile({
    id: 'acct-primary',
    provider: 'openai',
    type: 'oauth',
    accessToken: 'expired-tok-00001111',
    refreshToken: 'refresh-secret-9999',
    expiresAt: new Date(now + 30_000).toISOString(), // within 120s skew -> auto refresh
    priority: 1,
  });
  store.upsertProfile({
    id: 'acct-backup',
    provider: 'openai',
    type: 'api_key',
    apiKey: 'sk-backup-key-88887777',
    priority: 2,
  });

  // File permissions 0600 & redacted list
  const mode = fs.statSync(authPath).mode & 0o777;
  assert.equal(mode, 0o600);
  const listed = store.listProfiles({ provider: 'openai' });
  assert.equal(listed.length, 2);
  assert.ok(!listed[0].refreshToken.includes('9999') || listed[0].refreshToken.includes('...'));
  assert.ok(listed[1].apiKey.includes('...'));

  // Auto-refresh on acquire
  const cred1 = await store.acquireCredential('openai');
  assert.equal(cred1.profileId, 'acct-primary');
  assert.equal(cred1.token, 'refreshed-tok-1');
  assert.equal(refreshCount, 1);

  // Failover on HTTP 429 from primary -> backup
  const seen = [];
  const res = await store.withFailover('openai', async (cred) => {
    seen.push(cred.profileId);
    if (cred.profileId === 'acct-primary') {
      const e = new Error('HTTP 429 Too Many Requests');
      e.status = 429;
      throw e;
    }
    return `ok-via-${cred.profileId}`;
  });
  assert.deepEqual(seen, ['acct-primary', 'acct-backup']);
  assert.equal(res.result, 'ok-via-acct-backup');
  assert.equal(store.getProfile('acct-primary').inCooldown, true);
  assert.equal(store.getProfile('acct-backup').inCooldown, false);

  // After cooldown passes, primary is ready again
  now += 35_000;
  assert.equal(store.getProfile('acct-primary').inCooldown, false);
});

await t('Persistent Codex App-Server JSON-RPC client: initialize, account/read, model/list auto-resolve, streaming deltas, interrupt', async () => {
  const mockServerScript = path.join(tmp, 'mock-codex-app-server.mjs');
  fs.writeFileSync(mockServerScript, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let turnSeq = 0;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { server: 'mock-codex', version: '0.166.0' } });
  } else if (msg.method === 'account/read') {
    send({ jsonrpc: '2.0', id: msg.id, result: { account: { type: 'chatgpt', email: 'pilot@example.test' }, requiresOpenaiAuth: true } });
  } else if (msg.method === 'account/rateLimits/read') {
    send({ jsonrpc: '2.0', id: msg.id, result: { remaining: 95, limit: 100 } });
  } else if (msg.method === 'model/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { data: [{ id: 'gpt-6.1-terra', isDefault: true }, { id: 'gpt-6.2-sol' }] } });
  } else if (msg.method === 'thread/start') {
    if (!msg.params.model) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'model is required' } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thr-001', model: msg.params.model } } });
  } else if (msg.method === 'turn/start') {
    const tid = 'turn-' + (++turnSeq);
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: tid } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: msg.params.threadId, turn: { id: tid } } });
    const txt = (msg.params.input || []).map((x) => x.text || '').join(' ');
    if (txt.includes('SIMULATE_SLOW')) {
      setTimeout(() => {}, 10000);
      return;
    }
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, delta: 'Hello ' } });
      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: msg.params.threadId, delta: 'world!' } });
      send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: msg.params.threadId, tokenUsage: { last: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 12, totalTokens: 132 } } } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: tid, status: 'completed' } } });
    }, 15);
  } else if (msg.method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id: msg.id, result: { interrupted: true } });
  }
});
`);

  const client = createCodexAppServerClient({
    command: process.execPath,
    args: [mockServerScript],
    timeoutMs: 5000,
  });
  try {
    const acct = await client.readAccount();
    assert.equal(acct.account.type, 'chatgpt');
    const limits = await client.readRateLimits();
    assert.equal(limits.remaining, 95);

    const provider = pickProvider('codex-app-server', { client });
    const deltas = [];
    const res = await provider.generate('ping', {
      system: 'Be concise',
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(res.text, 'Hello world!');
    assert.deepEqual(deltas, ['Hello ', 'world!']);
    assert.equal(res.model, 'gpt-6.1-terra'); // auto-resolved from model/list!
    assert.equal(res.usage.cachedInputTokens, 40);
    assert.equal(res.usage.uncachedInputTokens, 80);

    // AbortSignal interrupts slow turn cleanly
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    await assert.rejects(
      () => provider.generate('SIMULATE_SLOW', { signal: ac.signal }),
      (err) => err.name === 'AbortError'
    );
  } finally {
    await client.close();
  }
});

await t('OpenAI-compatible provider routes through AuthStore failover + SSE streaming', async () => {
  const store = createAuthStore({ filePath: path.join(tmp, 'compat-auth.json') });
  store.upsertProfile({ id: 'p1', provider: 'openai', type: 'api_key', apiKey: 'k1', priority: 1 });
  store.upsertProfile({ id: 'p2', provider: 'openai', type: 'api_key', apiKey: 'k2', priority: 2 });

  const mockFetch = async (_url, opts) => {
    if (opts.headers.Authorization === 'Bearer k1') {
      return { ok: false, status: 429, headers: new Headers(), text: async () => '{"error":{"message":"rate limit"}}' };
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"cmpl-1","choices":[{"delta":{"content":"Streamed "}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"cmpl-1","choices":[{"delta":{"content":"OK"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stream,
    };
  };

  const p = pickProvider('openai-compatible', { baseUrl: 'https://proxy.example.test/v1', authStore: store, fetchImpl: mockFetch });
  const deltas = [];
  const out = await p.generate('hello', { onDelta: (d) => deltas.push(d) });
  assert.equal(out.text, 'Streamed OK');
  assert.deepEqual(deltas, ['Streamed ', 'OK']);
  assert.equal(out.authProfileId, 'p2');
});

await t('Mutation self-test: disabling cooldown check breaks 429 failover isolation', async () => {
  const store = createAuthStore({ filePath: path.join(tmp, 'mut-auth.json') });
  store.upsertProfile({ id: 'only', provider: 'openai', type: 'api_key', apiKey: 'k-only' });
  store.reportRateLimit('only', { retryAfterMs: 60_000 });
  // Must reject acquisition when the only profile is cooling down
  await assert.rejects(
    () => store.acquireCredential('openai'),
    (err) => err.code === 'ALL_IN_COOLDOWN'
  );
  // Mutation proof: allowing cooling fallback overrides the guard
  const forced = await store.acquireCredential('openai', { allowCoolingFallback: true });
  assert.equal(forced.profileId, 'only');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '\x1b[32m✔ all green\x1b[0m' : '\x1b[31m✖ failures\x1b[0m'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
