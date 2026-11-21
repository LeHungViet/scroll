// SCROLL 2.0 -- Channel-Agnostic Scoped Memory Tracker & Prompt Caching v2 Smoke Suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createScopedMemoryTracker,
  buildScopedMemoryPolicy,
  createChatSessionRuntime,
  createToolRegistry,
  openKnowledge,
  pickProvider,
} from '../index.js';

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err?.stack || err}`);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSampleAgent(rootDir, name = 'helper') {
  const agentDir = path.join(rootDir, 'agents', name);
  fs.mkdirSync(path.join(agentDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), [
    '---',
    `name: ${name}`,
    'title: Helper Agent',
    '---',
    'A concise assistant.',
  ].join('\n'));
  fs.writeFileSync(path.join(agentDir, 'SOUL.md'), 'Be clear, direct, and honest.');
  fs.writeFileSync(path.join(agentDir, 'hard-rules.md'), '- Never fabricate data.');
  fs.writeFileSync(path.join(agentDir, 'memory', 'lessons.md'), '# Procedural Lessons\n- Always verify facts before stating them.\n');
  fs.mkdirSync(path.join(rootDir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'knowledge', 'rates.md'), [
    '# Rates',
    '## Alpha Plan',
    'Alpha Plan AL-100 costs $49 per month.',
    '## Beta Plan',
    'Beta Plan BT-200 costs $199 per month.',
  ].join('\n'));
  return agentDir;
}

console.log('SCROLL 2.0 -- Memory Tracker (Channel-Agnostic) & Prompt Caching v2');

await t('1. Channel-agnostic 3-axis memory works across Slack & Web with strict isolation + crossSurfaceUser', async () => {
  const tmp = makeTempDir('scroll-mem-agnostic-');
  const agentDir = makeSampleAgent(tmp, 'ops');

  // Channel-isolated mode (default: slack)
  const slackTracker = createScopedMemoryTracker({
    rootDir: path.join(tmp, 'mem-slack'),
    agentDir,
    ownerIds: ['U_OWNER'],
    channel: 'slack',
    autoSweepEveryTurns: 0,
  });

  // Owner DM on Slack
  const dmCtx = await slackTracker.recordAndLoad({
    conversationId: 'D100',
    text: 'I prefer concise bullet updates every morning.',
    sender: { id: 'U_OWNER', name: 'Owner' },
    isGroup: false,
    channel: 'slack',
    messageId: 'm1',
  });
  const dmSave = slackTracker.rememberScoped({
    scope: 'user',
    key: 'pref.updates',
    value: 'concise bullet updates every morning',
    quote: 'concise bullet updates every morning',
    ctx: { sender: { id: 'U_OWNER' }, memoryContext: dmCtx.context, turnClassification: { isGroup: false } },
  });
  assert.equal(dmSave.ok, true);
  assert.equal(dmSave.axis, 'user');

  // Slack Room A vs Room B isolation
  const roomACtx = await slackTracker.recordAndLoad({
    conversationId: 'C_ROOM_A',
    chatTitle: 'Launch Room A',
    text: 'Alex handles backend release schedule for Room A.',
    sender: { id: 'U_ALEX', name: 'Alex' },
    isGroup: true,
    channel: 'slack',
    messageId: 'm2',
  });
  const roomASave = slackTracker.rememberScoped({
    scope: 'member',
    key: 'role.focus',
    value: 'backend release schedule for Room A',
    quote: 'backend release schedule for Room A',
    ctx: { sender: { id: 'U_ALEX', name: 'Alex' }, memoryContext: roomACtx.context, turnClassification: { isGroup: true } },
  });
  assert.equal(roomASave.ok, true);

  const roomBCtx = await slackTracker.recordAndLoad({
    conversationId: 'C_ROOM_B',
    chatTitle: 'Design Room B',
    text: 'Hello everyone in Room B.',
    sender: { id: 'U_ALEX', name: 'Alex' },
    isGroup: true,
    channel: 'slack',
    messageId: 'm3',
  });
  // Room A memory & Owner DM memory MUST NEVER leak into Room B!
  assert.equal(roomBCtx.memoryBlock.includes('concise bullet updates'), false);
  assert.equal(roomBCtx.memoryBlock.includes('backend release schedule'), false);

  // Cross-surface mode: same userId shares DM memory across Web and CLI
  const crossTracker = createScopedMemoryTracker({
    rootDir: path.join(tmp, 'mem-cross'),
    agentDir,
    ownerIds: ['U_OWNER'],
    channel: 'web',
    crossSurfaceUser: true,
    autoSweepEveryTurns: 0,
  });
  const webTurn = await crossTracker.recordAndLoad({
    conversationId: 'web-sess-1',
    text: 'My timezone is UTC+0 London.',
    sender: { id: 'U_OWNER', name: 'Owner' },
    isGroup: false,
    channel: 'web',
    messageId: 'w1',
  });
  const webSave = crossTracker.rememberScoped({
    scope: 'user',
    key: 'profile.timezone',
    value: 'UTC+0 London',
    quote: 'UTC+0 London',
    ctx: { sender: { id: 'U_OWNER' }, memoryContext: webTurn.context, turnClassification: { isGroup: false } },
  });
  assert.equal(webSave.ok, true);

  const cliTurn = await crossTracker.recordAndLoad({
    conversationId: 'cli-sess-9',
    text: 'What timezone am I in?',
    sender: { id: 'U_OWNER', name: 'Owner' },
    isGroup: false,
    channel: 'cli',
    messageId: 'c1',
  });
  assert.equal(cliTurn.subjectSid, webTurn.subjectSid);
  assert.match(cliTurn.stableMemoryBlock, /UTC\+0 London/);

  // Policy helper check
  const pol = buildScopedMemoryPolicy();
  assert.equal(pol.capsule_turns, 0);
  assert.equal(pol.min_quote_tokens, 2);
});

await t('2. ToolRegistry.listSchemas() sorts tools deterministically by name', async () => {
  const tmp = makeTempDir('scroll-tools-sort-');
  const reg = createToolRegistry({ cwd: tmp });
  reg.register({ name: 'zebra_tool', description: 'Z', risk: 'read_only', execute: async () => ({}) });
  reg.register({ name: 'alpha_tool', description: 'A', risk: 'read_only', execute: async () => ({}) });
  reg.register({ name: 'middle_tool', description: 'M', risk: 'read_only', execute: async () => ({}) });
  const names = reg.listSchemas().map((s) => s.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted);
});

await t('3. ChatSessionRuntime §13 keeps systemPrompt byte-identical while RAG, Voice cues, and dynamic memory change', async () => {
  const tmp = makeTempDir('scroll-cache-prefix-');
  makeSampleAgent(tmp, 'concierge');
  const kb = openKnowledge({ cwd: tmp });

  const captured = [];
  const fakeProvider = {
    name: 'mock',
    model: 'mock-cache-1',
    ready: true,
    async generate(prompt, opts) {
      captured.push({ prompt, system: opts.system, messages: opts.messages, cacheKey: opts.cacheKey, cacheTtl: opts.cacheTtl });
      return {
        text: 'Acknowledged.',
        toolCalls: [],
        usage: { uncachedInputTokens: 100, cachedInputTokens: captured.length > 1 ? 80 : 0, outputTokens: 10, providerTotalTokens: 110 },
        durationMs: 2,
        responseId: `r-${captured.length}`,
      };
    },
  };

  let turnNo = 0;
  let memTurnNo = 0;
  const runtime = createChatSessionRuntime({
    agentName: 'concierge',
    cwd: tmp,
    stateDir: path.join(tmp, 'state'),
    provider: fakeProvider,
    knowledgeIndex: kb,
    cacheTtl: '1h',
    memoryTracker: {
      async recordAndLoad() {
        memTurnNo++;
        return {
          stableMemoryBlock: '<!-- Frozen Memory -->\n- profile.name: Casey',
          dynamicMemoryBlock: memTurnNo === 1 ? '<peer>Peer A</peer>' : '<peer>Peer B</peer>',
        };
      },
    },
    voiceHooks: {
      async beforeTurn() {
        turnNo++;
        return {
          stableSystemBlock: 'Base persona preset: warm and concise.',
          volatileTurnBlock: turnNo === 1 ? 'Turn cue: playful mood' : 'Turn cue: calm analytical mood',
          extraContextBlocks: [turnNo === 1 ? '[group buffer A]' : '[group buffer B]'],
        };
      },
    },
  });

  const t1 = await runtime.sendTurn({ conversationId: 'room-1', text: 'Tell me about Alpha Plan AL-100', contextBlocks: ['ctx-1'] });
  const t2 = await runtime.sendTurn({ conversationId: 'room-1', text: 'Now tell me about Beta Plan BT-200', contextBlocks: ['ctx-2'] });

  assert.equal(captured.length, 2);
  // Region A (systemPrompt) MUST be 100% byte-identical across turns!
  assert.equal(captured[0].system, captured[1].system);
  assert.equal(t1.prefixHash, t2.prefixHash);
  assert.equal(captured[0].cacheKey, 'concierge:room-1');
  assert.equal(captured[0].cacheTtl, '1h');

  // Volatile blocks MUST NOT appear in systemPrompt; they MUST appear in the final user message!
  assert.equal(captured[0].system.includes('AL-100'), false);
  assert.equal(captured[0].system.includes('playful mood'), false);
  assert.equal(captured[0].system.includes('Peer A'), false);
  assert.equal(captured[0].system.includes('ctx-1'), false);
  assert.equal(captured[0].system.includes('Base persona preset: warm and concise.'), true);
  assert.equal(captured[0].system.includes('profile.name: Casey'), true);

  const lastMsg1 = captured[0].messages.at(-1).content;
  const lastMsg2 = captured[1].messages.at(-1).content;
  assert.match(lastMsg1, /AL-100/);
  assert.match(lastMsg1, /playful mood/);
  assert.match(lastMsg1, /Peer A/);
  assert.match(lastMsg1, /ctx-1/);
  assert.match(lastMsg2, /BT-200/);
  assert.match(lastMsg2, /calm analytical mood/);
  assert.match(lastMsg2, /Peer B/);
  assert.match(lastMsg2, /ctx-2/);

  const stats = runtime.getCacheStats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  await runtime.close();
});

await t('4. Anthropic provider emits 3 cache_control breakpoints + extended 1h TTL beta header', async () => {
  let reqUrl = null;
  let reqHeaders = null;
  let reqBody = null;
  const provider = pickProvider('anthropic', {
    apiKey: 'sk-ant-test',
    fetchImpl: async (url, opts) => {
      reqUrl = url;
      reqHeaders = opts.headers;
      reqBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            id: 'msg_1',
            content: [{ type: 'text', text: 'Cached OK' }],
            usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1800, output_tokens: 5 },
          });
        },
      };
    },
  });

  const out = await provider.generate('Turn 2 question', {
    system: 'Stable system instructions',
    cacheTtl: '1h',
    tools: [
      { name: 'a_tool', description: 'First', parameters: { type: 'object', properties: {} } },
      { name: 'z_tool', description: 'Last', parameters: { type: 'object', properties: {} } },
    ],
    messages: [
      { role: 'user', content: 'Turn 1 question' },
      { role: 'assistant', content: 'Turn 1 reply' },
      { role: 'user', content: 'Turn 2 question' },
    ],
  });

  assert.equal(reqUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(reqHeaders['anthropic-beta'], 'extended-cache-ttl-2025-04-11');
  // Breakpoint 1: system
  assert.deepEqual(reqBody.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  // Breakpoint 2: last tool only
  assert.equal(reqBody.tools[0].cache_control, undefined);
  assert.deepEqual(reqBody.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  // Breakpoint 3: penultimate message (Turn 1 assistant reply), NOT the last message
  assert.equal(reqBody.messages[0].content, 'Turn 1 question');
  assert.deepEqual(reqBody.messages[1].content, [{ type: 'text', text: 'Turn 1 reply', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  assert.equal(reqBody.messages[2].content, 'Turn 2 question');
  assert.equal(out.usage.cachedInputTokens, 1800);
});

await t('5. OpenAI sends prompt_cache_key + 24h retention on api.openai.com; omits on third-party proxy unless explicit', async () => {
  const bodies = [];
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          id: 'chatcmpl_1',
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 768 }, completion_tokens: 10, total_tokens: 1010 },
        });
      },
    };
  };

  const openai = pickProvider('openai', { apiKey: 'sk-test', fetchImpl: mockFetch });
  const r1 = await openai.generate('hi', {
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    cacheKey: 'agent:room-9',
    cacheTtl: '24h',
  });
  assert.equal(bodies[0].prompt_cache_key, 'agent:room-9');
  assert.equal(bodies[0].prompt_cache_retention, '24h');
  assert.equal(r1.usage.cachedInputTokens, 768);

  // Third-party proxy should NOT receive OpenAI-specific fields automatically
  const proxy = pickProvider('openai-compatible', { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'local', fetchImpl: mockFetch });
  await proxy.generate('hi', { system: 'sys', messages: [{ role: 'user', content: 'hi' }], cacheKey: 'agent:room-9', cacheTtl: '24h' });
  assert.equal(bodies[1].prompt_cache_key, undefined);
  assert.equal(bodies[1].prompt_cache_retention, undefined);

  // Explicit promptCacheKey opts in even on custom proxy
  await proxy.generate('hi', { system: 'sys', messages: [{ role: 'user', content: 'hi' }], promptCacheKey: 'explicit-key' });
  assert.equal(bodies[2].prompt_cache_key, 'explicit-key');
});

await t('6. Gemini supports explicit cachedContent handle without conflicting systemInstruction', async () => {
  let reqBody = null;
  const gemini = pickProvider('gemini', {
    apiKey: 'gem-test',
    fetchImpl: async (_url, opts) => {
      reqBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Gemini OK' }] } }],
            usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 420, candidatesTokenCount: 8, totalTokenCount: 508 },
          });
        },
      };
    },
  });
  const res = await gemini.generate('hello', { system: 'ignored when cachedContent set', cachedContent: 'cachedContents/abc123' });
  assert.equal(reqBody.cachedContent, 'cachedContents/abc123');
  assert.equal(reqBody.systemInstruction, undefined);
  assert.equal(res.usage.cachedInputTokens, 420);
});

await t('7. Codex App-Server persistent threadId reuse sends only incremental turn, resets on /clear & retries stale thread', async () => {
  const tmp = makeTempDir('scroll-codex-thread-');
  makeSampleAgent(tmp, 'bot');

  const calls = [];
  let seq = 0;
  let failNextReuse = false;
  const fakeCodex = {
    name: 'codex-app-server',
    model: 'gpt-5-codex',
    ready: true,
    async generate(prompt, opts) {
      calls.push({ threadId: opts.threadId || null, ephemeral: opts.ephemeral, msgCount: opts.messages?.length || 0, system: opts.system });
      if (failNextReuse && opts.threadId) {
        failNextReuse = false;
        throw new Error('thread_not_found: evicted');
      }
      const tid = opts.threadId || `thr_${++seq}`;
      return {
        text: `Reply #${calls.length}`,
        toolCalls: [],
        threadId: tid,
        usage: { uncachedInputTokens: opts.threadId ? 40 : 400, cachedInputTokens: opts.threadId ? 360 : 0, outputTokens: 12, providerTotalTokens: 412 },
        durationMs: 3,
        responseId: `resp_${calls.length}`,
      };
    },
  };

  const runtime = createChatSessionRuntime({
    agentName: 'bot',
    cwd: tmp,
    stateDir: path.join(tmp, 'state'),
    provider: fakeCodex,
  });

  // Turn 1: creates persistent thread (ephemeral: false)
  const r1 = await runtime.sendTurn({ conversationId: 'chat-1', text: 'First turn' });
  assert.equal(r1.threadReused, false);
  assert.equal(calls[0].threadId, null);
  assert.equal(calls[0].ephemeral, false);
  assert.equal(calls[0].msgCount, 1);

  // Turn 2: reuses thr_1 and sends ONLY the 1 new user message (NOT 3 messages!)
  const r2 = await runtime.sendTurn({ conversationId: 'chat-1', text: 'Second turn' });
  assert.equal(r2.threadReused, true);
  assert.equal(calls[1].threadId, 'thr_1');
  assert.equal(calls[1].msgCount, 1);

  // Turn 3: stale thread error -> falls back seamlessly to new persistent thread with FULL history (5 msgs)!
  failNextReuse = true;
  const r3 = await runtime.sendTurn({ conversationId: 'chat-1', text: 'Third turn after server restart' });
  assert.equal(r3.threadReused, false);
  assert.equal(calls[2].threadId, 'thr_1'); // attempted reuse
  assert.equal(calls[3].threadId, null); // fresh thread retry
  assert.equal(calls[3].msgCount, 5); // 4 history msgs + 1 current turn

  // Turn 4: reuses new thr_2 cleanly
  const r4 = await runtime.sendTurn({ conversationId: 'chat-1', text: 'Fourth turn' });
  assert.equal(r4.threadReused, true);
  assert.equal(calls[4].threadId, 'thr_2');
  assert.equal(calls[4].msgCount, 1);

  // /clear resets the persistent thread
  runtime.clearSession('chat-1');
  const r5 = await runtime.sendTurn({ conversationId: 'chat-1', text: 'Fresh after clear' });
  assert.equal(r5.threadReused, false);
  assert.equal(calls[5].threadId, null);
  assert.equal(calls[5].msgCount, 1);

  const stats = runtime.getCacheStats();
  assert.equal(stats.threadReuses, 2);
  assert.ok(stats.threadResets >= 2);
  await runtime.close();
});

console.log(`\nv20-memory-caching.smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
