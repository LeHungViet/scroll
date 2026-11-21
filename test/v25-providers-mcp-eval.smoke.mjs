// SCROLL 2.5 -- Automated 4-Provider Parity, Streamable HTTP MCP, Compaction Recovery, & Multi-Turn pass^k Evals (G11, G12, G15).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  scaffold,
  pickProvider,
  createAuthStore,
  runLoopbackOAuthCallback,
  createMcpHttpClient,
  createMcpManager,
  createToolRegistry,
  createChatSessionRuntime,
  buildProviderMessages,
  runChatEvals,
} from '../index.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✔ ${name}`); pass++; }
  catch (e) { console.error(`  ✖ ${name} -- ${e?.stack || e}`); fail++; }
}

function makeSseResponse(chunks, headers = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream', ...headers }),
    body: stream,
    text: async () => chunks.join(''),
    json: async () => ({}),
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v25-prov-'));
console.log('SCROLL 2.5 -- 4-Provider Parity, Streamable HTTP MCP, Compaction/400 Recovery, & pass^k Evals (G11, G12, G15)');

// ── G11: Anthropic SSE + parallel tool coalescing + thinking + images + authStore ──
await t('G11: Anthropic real SSE streams deltas, coalesces parallel tool_result into 1 user turn, preserves thinkingBlocks & images', async () => {
  const capturedBodies = [];
  const authStore = createAuthStore();
  authStore.upsertProfile({ id: 'anth-1', provider: 'anthropic', type: 'api_key', apiKey: 'sk-ant-test-key' });

  let callNum = 0;
  const mockFetch = async (_url, opts) => {
    callNum++;
    capturedBodies.push(JSON.parse(opts.body));
    if (callNum === 1) {
      return makeSseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"cache_read_input_tokens":40}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Planning two calls"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_abc123"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"tool_a"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_2","name":"tool_b"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"y\\":2}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":25}}\n\n',
      ]);
    }
    return makeSseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":120,"cache_read_input_tokens":80}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"All "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done!"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
    ]);
  };

  const prov = pickProvider('anthropic', { authStore, fetchImpl: mockFetch });
  assert.equal(prov.ready, true);
  assert.equal(prov.supportsTools, true);

  const deltas = [];
  const r1 = await prov.generate('Run both', {
    system: 'Be helpful',
    messages: [{ role: 'user', content: 'Run both' }],
    images: [{ base64: 'AQID', mimeType: 'image/png' }],
    tools: [
      { name: 'tool_a', description: 'A', parameters: { type: 'object', properties: { x: { type: 'number' } } } },
      { name: 'tool_b', description: 'B', parameters: { type: 'object', properties: { y: { type: 'number' } } } },
    ],
    onDelta: (d) => deltas.push(d),
  });
  assert.equal(r1.toolCalls.length, 2);
  assert.equal(r1.thinkingBlocks.length, 1);
  assert.equal(r1.thinkingBlocks[0].signature, 'sig_abc123');
  assert.equal(r1.usage.cachedInputTokens, 40);
  // Check image block was sent on first request
  assert.ok(Array.isArray(capturedBodies[0].messages[0].content));
  assert.ok(capturedBodies[0].messages[0].content.some((b) => b.type === 'image'));

  // Round 2: send 2 consecutive role:'tool' messages -> MUST coalesce into 1 role:'user' turn!
  const r2 = await prov.generate('', {
    system: 'Be helpful',
    messages: [
      { role: 'user', content: 'Run both' },
      { role: 'assistant', content: '', toolCalls: r1.toolCalls, thinkingBlocks: r1.thinkingBlocks },
      { role: 'tool', toolCallId: 'tu_1', name: 'tool_a', content: '{"a":1}' },
      { role: 'tool', toolCallId: 'tu_2', name: 'tool_b', content: '{"b":2}' },
    ],
    onDelta: (d) => deltas.push(d),
  });
  assert.equal(r2.text, 'All done!');
  assert.deepEqual(deltas, ['All ', 'done!']);
  const msgs2 = capturedBodies[1].messages;
  assert.equal(msgs2.length, 3, '2 parallel tool_results MUST coalesce into 1 single user turn (3 total messages, not 4)');
  assert.equal(msgs2[2].role, 'user');
  assert.equal(msgs2[2].content.length, 2);
  assert.equal(msgs2[2].content[0].type, 'tool_result');
  assert.equal(msgs2[2].content[1].type, 'tool_result');
  assert.ok(msgs2[1].content.some((b) => b.type === 'thinking' && b.signature === 'sig_abc123'), 'thinking block preserved across round');
});

// ── G11: Gemini SSE + parallel function calling + thoughtSignature + cachedContent conflict safety ──
await t('G11: Gemini real SSE streams non-thought text, preserves thoughtSignature across parallel function calls, & avoids cachedContent+tools conflict', async () => {
  const captured = [];
  let callNum = 0;
  const mockFetch = async (url, opts) => {
    callNum++;
    captured.push({ url, body: JSON.parse(opts.body) });
    if (callNum === 1) {
      return makeSseResponse([
        'data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"secret chain of thought"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"weather","args":{"city":"Hanoi"}},"thoughtSignature":"sig_gem_1"},{"functionCall":{"name":"time","args":{"tz":"ICT"}},"thoughtSignature":"sig_gem_2"}]}}],"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":60,"candidatesTokenCount":12,"totalTokenCount":112}}\n\n',
      ]);
    }
    return makeSseResponse([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hanoi is "}]}}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"28C."}]}}],"usageMetadata":{"promptTokenCount":130,"cachedContentTokenCount":90,"candidatesTokenCount":4,"totalTokenCount":134}}\n\n',
    ]);
  };

  const prov = pickProvider('gemini', { apiKey: 'AIza-test', cachedContent: 'cachedContents/abc', fetchImpl: mockFetch });
  const deltas = [];
  const r1 = await prov.generate('Weather and time?', {
    system: 'Concise assistant',
    messages: [{ role: 'user', content: 'Weather and time?' }],
    tools: [
      { name: 'weather', description: 'Get weather', parameters: { type: 'object', additionalProperties: false, properties: { city: { type: 'string' } } } },
      { name: 'time', description: 'Get time', parameters: { type: 'object', properties: { tz: { type: 'string' } } } },
    ],
    onDelta: (d) => deltas.push(d),
  });
  assert.equal(r1.text, '', 'thought:true text MUST NOT leak into visible text');
  assert.equal(deltas.length, 0, 'thought:true text MUST NOT stream to onDelta');
  assert.equal(r1.toolCalls.length, 2);
  assert.equal(r1.toolCalls[0].thoughtSignature, 'sig_gem_1');
  assert.equal(r1.usage.cachedInputTokens, 60);
  // Safe fallback when dynamic tools present with cachedContent -> avoids HTTP 400 conflict!
  assert.equal(captured[0].body.cachedContent, undefined, 'must not combine cachedContent with dynamic tools');
  assert.ok(captured[0].body.tools?.[0]?.functionDeclarations?.length === 2);
  assert.equal(captured[0].body.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined, 'additionalProperties stripped for Gemini');

  const r2 = await prov.generate('', {
    system: 'Concise assistant',
    messages: [
      { role: 'user', content: 'Weather and time?' },
      { role: 'assistant', content: '', toolCalls: r1.toolCalls, rawParts: r1.rawParts },
      { role: 'tool', toolCallId: r1.toolCalls[0].id, name: 'weather', content: '{"temp":28}' },
      { role: 'tool', toolCallId: r1.toolCalls[1].id, name: 'time', content: '{"hour":21}' },
    ],
    onDelta: (d) => deltas.push(d),
  });
  assert.equal(r2.text, 'Hanoi is 28C.');
  assert.deepEqual(deltas, ['Hanoi is ', '28C.']);
  const c2 = captured[1].body.contents;
  assert.equal(c2.length, 3, '2 parallel functionResponse parts coalesced into 1 user turn');
  assert.equal(c2[1].parts.some((p) => p.thoughtSignature === 'sig_gem_1'), true, 'thoughtSignature preserved on round 2');
  assert.equal(c2[2].parts.length, 2);
});

// ── G11: OpenAI SSE include_usage + Retry-After + supportsTools fail-closed + OAuth lock & loopback ──
await t('G11: OpenAI SSE sends stream_options.include_usage, parses Retry-After, supportsTools fails closed, & OAuth loopback works', async () => {
  let reqBody = null;
  const prov = pickProvider('openai', {
    apiKey: 'sk-test',
    fetchImpl: async (_url, opts) => {
      reqBody = JSON.parse(opts.body);
      return makeSseResponse([
        'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"Hello "}}]}\n\n',
        'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"world"}}]}\n\n',
        'data: {"id":"chatcmpl_1","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":4,"total_tokens":54,"prompt_tokens_details":{"cached_tokens":30}}}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
  });
  const chunks = [];
  const res = await prov.generate('Hi', { messages: [{ role: 'user', content: 'Hi' }], onDelta: (d) => chunks.push(d) });
  assert.equal(reqBody.stream_options?.include_usage, true);
  assert.equal(res.text, 'Hello world');
  assert.equal(res.usage.cachedInputTokens, 30);
  assert.equal(res.usage.outputTokens, 4);

  // Retry-After on 429
  const prov429 = pickProvider('openai', {
    apiKey: 'sk-test',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '7' }),
      text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
    }),
  });
  await assert.rejects(
    () => prov429.generate('Hi', { messages: [{ role: 'user', content: 'Hi' }], onDelta: () => {} }),
    (err) => err.status === 429 && err.retryAfterMs === 7000
  );

  // Fail-closed supportsTools === false
  const dir = path.join(tmpRoot, 'g11-notools');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('notools', dir);
  const noToolProv = { name: 'cli-only', model: 'cli-1', ready: true, supportsTools: false, async generate() { return { text: 'hi', usage: {} }; } };
  const rt = createChatSessionRuntime({
    agentName: 'notools',
    cwd: dir,
    stateDir: path.join(dir, 'state'),
    provider: noToolProv,
    tools: createToolRegistry({ cwd: dir }),
  });
  try {
    await assert.rejects(() => rt.sendTurn({ conversationId: 'c', text: 'hi' }), /provider_does_not_support_tools:cli-only/);
  } finally {
    await rt.close();
  }

  // Loopback OAuth callback server
  const cb = await runLoopbackOAuthCallback({ expectedState: 'st_xyz', timeoutMs: 5000 });
  const waitP = cb.waitForCode();
  const r = await fetch(`${cb.redirectUri}?code=auth_code_99&state=st_xyz`);
  assert.equal(r.status, 200);
  const got = await waitP;
  assert.equal(got.code, 'auth_code_99');
  assert.equal(got.state, 'st_xyz');
});

// ── G11: Streamable HTTP MCP (POST + SSE + Mcp-Session-Id + 404 re-init + Promise.allSettled isolation) ──
await t('G11: Streamable HTTP MCP handles Mcp-Session-Id, SSE response, HTTP 404 session re-init, & Promise.allSettled fault isolation', async () => {
  let currentSession = 'sess_v1';
  let expiredOnce = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body || '{}');
    if (msg.method === 'initialize') {
      currentSession = expiredOnce ? 'sess_v2' : 'sess_v1';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': currentSession });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-mcp', version: '1.0' } } }));
      return;
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    // Simulate expired session once on first tools/call -> client MUST auto-reinitialize and succeed!
    if (msg.method === 'tools/call' && !expiredOnce) {
      expiredOnce = true;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session_expired' }));
      return;
    }
    if (msg.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': currentSession });
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo_http', description: 'Echo via Streamable HTTP', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] } })}\n\n`);
      return;
    }
    if (msg.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': currentSession });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo:${msg.params.arguments.msg}:${req.headers['mcp-session-id']}` }] } }));
      return;
    }
    res.writeHead(400);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = path.join(tmpRoot, 'g11-mcp-http');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      goodhttp: { transport: 'http', url: `http://127.0.0.1:${port}/mcp` },
      deadserver: { transport: 'http', url: 'http://127.0.0.1:1/unreachable' },
    },
  }));

  const mgr = createMcpManager({ cwd: dir });
  try {
    const conn = await mgr.connectAll();
    assert.equal(conn.some((c) => c.server === 'goodhttp'), true, 'healthy HTTP MCP server connects');
    assert.equal(mgr.getFailedServers().length, 1, 'unreachable MCP server isolated via Promise.allSettled');
    const listed = mgr.listDiscoveredTools();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'echo_http');
    const called = await mgr.callTool('goodhttp', 'echo_http', { msg: 'hello' });
    assert.equal(called.content[0].text, 'echo:hello:sess_v2', 'HTTP 404 triggered automatic re-init to sess_v2');
  } finally {
    await mgr.closeAll();
    server.close();
  }
});

// ── G12: Compaction role-alternation fix & 400 context_length_exceeded auto-recovery ──
await t('G12: buildProviderMessages eliminates consecutive user turns & 400 context_length_exceeded auto-compacts and retries once', async () => {
  const merged = buildProviderMessages([
    { role: 'system', kind: 'compaction', content: '[Summary of earlier chat]' },
    { role: 'user', content: 'Turn A' },
    { role: 'assistant', content: 'Reply A' },
  ], 'Turn B');
  assert.equal(merged.length, 3);
  assert.equal(merged[0].role, 'user');
  assert.match(merged[0].content, /Summary of earlier chat[\s\S]*Turn A/);
  assert.equal(merged[1].role, 'assistant');
  assert.equal(merged[2].role, 'user');

  const dir = path.join(tmpRoot, 'g12-overflow');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('compbot', dir);
  let calls = 0;
  const prov = {
    name: 'mock',
    model: 'mock-1',
    ready: true,
    supportsTools: true,
    async generate(_prompt, { messages }) {
      calls++;
      if (calls === 4) {
        const err = new Error('maximum context length exceeded (prompt is too long)');
        err.status = 400;
        err.code = 'CONTEXT_LENGTH_EXCEEDED';
        throw err;
      }
      return { text: `ok(msgs=${messages.length})`, toolCalls: [], usage: { uncachedInputTokens: 50, cachedInputTokens: 0, outputTokens: 10, providerTotalTokens: 60 }, durationMs: 2 };
    },
  };
  const rt = createChatSessionRuntime({
    agentName: 'compbot',
    cwd: dir,
    stateDir: path.join(dir, 'state'),
    provider: prov,
    compactAtChars: 999_999,
    keepRecentTurns: 4,
  });
  try {
    await rt.sendTurn({ conversationId: 'ov1', text: 'Message 1' });
    await rt.sendTurn({ conversationId: 'ov1', text: 'Message 2' });
    await rt.sendTurn({ conversationId: 'ov1', text: 'Message 3' });
    // Call #4 throws 400 context_length_exceeded -> auto-compacts -> Call #5 succeeds!
    const t4 = await rt.sendTurn({ conversationId: 'ov1', text: 'Message 4 triggers overflow' });
    assert.equal(calls, 5, 'overflow triggered compact + single retry');
    assert.equal(t4.compacted, true);
    assert.match(t4.text, /^ok\(msgs=/);
    assert.equal(rt.getHistory('ov1')[0].kind, 'compaction');
  } finally {
    await rt.close();
  }
});

// ── G15: Multi-turn Chat Eval Harness with pass^k ──
await t('G15: runChatEvals computes exact pass^k across k trials (1.0 on full pass, <1.0 on flaky trial)', async () => {
  const dir = path.join(tmpRoot, 'g15-eval');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('evalbot', dir);

  const stableReport = await runChatEvals('evalbot', {
    cwd: dir,
    trials: 3,
    providerFactory: () => pickProvider('mock', {
      scriptedTurns: [
        () => ({ text: 'Hello! Ticket #42 opened.' }),
        () => ({ text: 'Ticket #42 status is resolved.' }),
      ],
    }),
    cases: [{
      id: 'ticket-flow',
      turns: [
        { text: 'Open ticket', checks: [{ op: 'contains', value: '#42' }] },
        { text: 'Check status', checks: [{ op: 'icontains', value: 'resolved' }] },
      ],
    }],
  });
  assert.equal(stableReport.ok, true);
  assert.equal(stableReport.cases[0].passPowK, 1);
  assert.equal(stableReport.cases[0].allTrialsPassed, true);

  // Flaky agent passing 2 of 3 trials -> pass^3 = (2/3)^3 = 0.2963 -> FAIL!
  const flakyReport = await runChatEvals('evalbot', {
    cwd: dir,
    trials: 3,
    providerFactory: ({ trial }) => pickProvider('mock', {
      scriptedTurns: [() => ({ text: trial === 1 ? 'wrong output' : 'expected token OK' })],
    }),
    cases: [{
      id: 'flaky-case',
      minPassPowK: 0.9,
      turns: [{ text: 'Go', checks: [{ op: 'contains', value: 'expected token OK' }] }],
    }],
  });
  assert.equal(flakyReport.ok, false);
  assert.equal(flakyReport.cases[0].passedTrials, 2);
  assert.ok(flakyReport.cases[0].passPowK < 0.35);
  assert.equal(flakyReport.cases[0].verdict, 'fail');
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${fail ? '✖ failures:' : '✔ all green:'} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
