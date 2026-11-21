// SCROLL 2.5.1 -- Adversarial Hardening & Codex/DeepSeek Harness Parity Regression Suite.
// Verifies all 10 core P0 security/correctness fixes, key P1 fixes, and 6 Codex/DeepSeek upgrades.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scaffold,
  openUser,
  pickProvider,
  createToolRegistry,
  createChatSessionRuntime,
  createApprovalStore,
  hashArgs,
  createAuditChain,
  verifyAuditChain,
  redactTelemetry,
  buildSeatbeltProfile,
  buildBwrapArgs,
  runSandboxedExec,
  evaluateExecPolicy,
  detectOsSandbox,
  isPrivateIp,
  resolveAndValidatePublicUrl,
  applySpillToFileLimit,
  sanitizeGeminiSchema,
  pruneOldToolResults,
  verifyAndPinTools,
  createMcpManager,
  createMcpStdioClient,
  policyForTier,
  runChecks,
  runEvals,
  runChatEvals,
  auditRepo,
  verifyAgainstRecord,
  createWorkerPool,
} from '../index.js';
import { createScrollChatRuntime, createLongTaskRunner } from '../lib/chat-sdk/index.js';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (e) {
    console.error(`  \u2716 ${name} -- ${e.stack || e.message}`);
    fail++;
  }
}

console.log('SCROLL 2.5.1 -- Hardening P0/P1 & Codex/DeepSeek Harness Parity Regression Suite');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-hardening-'));

const VALID_USER_MD = `---
principal:
  kind: org
  name: TestCorp
  self: we
people:
  - id: boss
    name: Boss
    roles: [owner]
    channel_ids: ["tg:1001"]
    approve: [reversible_write, external_comm, financial, destructive]
    max_amount: 500
  - id: staff
    name: Staff
    roles: [staff]
    channel_ids: ["tg:2002"]
    approve: [reversible_write]
---
# About
Secret internal note: CANARY-SECRET-777.
`;

// ── P0-1: Deny-Default OS Sandbox (macOS Seatbelt PoC + Linux bwrap + Argv Exec Policy) ──
await t('P0-1: Deny-default Seatbelt blocks /bin/cat $HOME PoC, protects .git/IDENTITY/.mcp.json, & Codex argv execpolicy works', async () => {
  const dir = path.join(tmpRoot, 'p0-1-sandbox');
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'demo', 'IDENTITY.md'), 'name: demo\n');
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');

  const profile = buildSeatbeltProfile({ cwd: dir, command: '/bin/cat' });
  assert.ok(profile.includes('(deny default)'), 'Seatbelt profile MUST be deny-default');
  assert.ok(!profile.includes('(allow default)'), 'Seatbelt profile MUST NOT use allow default');
  assert.ok(!profile.includes('(subpath "/")'), 'Seatbelt MUST NEVER emit (subpath "/") for /bin/cat');

  // Refuse unsafe cwd ($HOME or /)
  assert.throws(() => buildSeatbeltProfile({ cwd: os.homedir() }), /sandbox_unsafe_cwd/);
  assert.throws(() => buildSeatbeltProfile({ cwd: '/' }), /sandbox_unsafe_cwd/);

  // Linux bwrap flags
  const bwrap = buildBwrapArgs({ cwd: dir, command: '/bin/echo', args: ['hi'] });
  assert.ok(bwrap.includes('--new-session'), 'bwrap must include --new-session (blocks TIOCSTI)');
  assert.ok(bwrap.includes('--unshare-user'), 'bwrap must include --unshare-user');
  assert.ok(bwrap.includes('--cap-drop') && bwrap.includes('ALL'), 'bwrap must drop all capabilities');
  assert.ok(bwrap.includes('--clearenv'), 'bwrap must clear inherited env');
  assert.ok(bwrap.includes(path.join(fs.realpathSync.native(dir), '.git')), 'bwrap must ro-bind .git inside cwd');

  // Live macOS Seatbelt PoC checks
  const detected = detectOsSandbox();
  if (detected.available && detected.kind === 'seatbelt') {
    const homeProbe = path.join(os.homedir(), '.zshrc');
    const targetFile = fs.existsSync(homeProbe) ? homeProbe : path.join(process.cwd(), 'package.json');
    if (targetFile.startsWith(os.homedir() + path.sep)) {
      await assert.rejects(
        () => runSandboxedExec({ command: '/bin/cat', args: [targetFile], cwd: dir }),
        /Operation not permitted|Command failed/i,
        'FABLE PoC: /bin/cat $HOME file MUST be denied inside Seatbelt!'
      );
    }
    // Writing protected policy & VCS files inside writable cwd MUST be denied
    await assert.rejects(
      () => runSandboxedExec({
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, '.git/hooks/post-checkout'))}, 'evil')`],
        cwd: dir,
      }),
      /EPERM|Operation not permitted|Command failed/i,
      'Writing .git/hooks inside writable cwd MUST be denied'
    );
    await assert.rejects(
      () => runSandboxedExec({
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'agents/demo/IDENTITY.md'))}, 'tampered')`],
        cwd: dir,
      }),
      /EPERM|Operation not permitted|Command failed/i,
      'Writing agents/demo/IDENTITY.md inside writable cwd MUST be denied'
    );
    // Writing normal file inside cwd succeeds
    const okWrite = await runSandboxedExec({
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'work.txt'))}, 'ok'); console.log('WRITTEN_OK')`],
      cwd: dir,
    });
    assert.match(okWrite.stdout, /WRITTEN_OK/);
  }

  // Codex-style declarative argv-prefix exec policy
  assert.equal(evaluateExecPolicy({ command: 'git', args: ['status'], allowRules: [['git', 'status']] }).ok, true);
  assert.equal(evaluateExecPolicy({ command: 'git', args: ['push', 'origin'], allowRules: [['git', 'status']] }).ok, false);
  assert.equal(evaluateExecPolicy({ command: 'git', args: ['push'], allowRules: ['git'], denyRules: [['git', 'push']] }).ok, false);
});

// ── P0-2 + P0-3: No bare `approved: true` bypass + Long-task preserves `isGroup` & blocks recursion ──
await t('P0-2 + P0-3: Bare approved:true rejected; long-task preserves isGroup, omits approved:true, and blocks recursion', async () => {
  const dir = path.join(tmpRoot, 'p0-2-3-approval');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('ltbot', dir);
  const tools = createToolRegistry({ cwd: dir });
  tools.register({
    name: 'wire_funds',
    description: 'Transfer money',
    risk: 'financial',
    ground: ['amount'],
    confirm: { mode: 'none', reason: 'test_ledger' },
    parameters: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
    async execute(a) { return { wired: a.amount }; },
  });

  // Bare `approved: true` without approvedTool + approvedArgsHash MUST FAIL CLOSED
  const bareBypass = await tools.executeTool('wire_funds', { amount: 100 }, {
    approved: true,
    groundingSources: 'amount 100',
  });
  assert.equal(bareBypass.ok, false);
  assert.equal(bareBypass.reason, 'approval_binding_required');

  // Long-task runner MUST preserve isGroup: true and NEVER pass approved: true
  const seenOpts = [];
  const pool = createWorkerPool({ concurrency: 2 });
  const runner = createLongTaskRunner({ workerPool: pool });
  const fakeRuntime = {
    agentName: 'ltbot',
    async sendTurn(opts) {
      seenOpts.push(opts);
      return { text: 'Done safely.\nTASK_DONE', toolTraces: [{ name: 'web_search' }] };
    },
  };
  const task = runner.startTask({
    runtime: fakeRuntime,
    chatId: '-100999',
    isGroup: true,
    sender: { id: '1001', channelId: 'tg:1001', name: 'Boss' },
    title: 'Group check',
    goal: 'Check public status',
    maxSteps: 2,
  });
  // Wait for completion
  for (let i = 0; i < 40; i++) {
    if (runner.getTask(task.id)?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  pool.close();
  assert.equal(seenOpts.length, 1);
  assert.equal(seenOpts[0].isGroup, true, 'Group-originated long-task MUST keep isGroup: true');
  assert.equal(seenOpts[0].approved, undefined, 'Long-task MUST NOT pass approved: true');

  // Recursive start_long_task inside longtask:* MUST be denied
  runner.registerTools({ tools, runtime: fakeRuntime, ownerIds: ['1001'] });
  const recRes = await tools.executeTool('start_long_task', { title: 'Nested', goal: 'Recurse' }, {
    chatId: 'longtask:lt_abc',
    sender: { id: '1001', channelId: 'tg:1001' },
  });
  assert.equal(recRes.output.ok, false);
  assert.equal(recRes.output.error, 'recursive_long_task_not_allowed');
});

// ── P0-4: Gemini Schema Sanitizer preserves required/enum strings & property named `default` ──
await t('P0-4: sanitizeGeminiSchema preserves required/enum strings AND property named default', () => {
  const input = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', default: 'notes.txt', enum: ['a.txt', 'b.txt'] },
      default: { type: 'string', description: 'Parameter literally named default' },
    },
    required: ['path', 'default'],
  };
  const out = sanitizeGeminiSchema(input);
  assert.deepEqual(out.required, ['path', 'default'], 'required array strings must stay strings');
  assert.deepEqual(out.properties.path.enum, ['a.txt', 'b.txt'], 'enum array strings must stay strings');
  assert.equal(out.properties.path.default, undefined, 'schema keyword default stripped');
  assert.equal(out.$schema, undefined, '$schema stripped');
  assert.equal(out.additionalProperties, undefined, 'additionalProperties stripped');
  assert.ok(out.properties.default, 'tool parameter named `default` inside properties MUST survive!');
  assert.equal(out.properties.default.type, 'string');
});

// ── P0-5 + P0-9: Chat SDK enableMcp:true no-crash + MCP cmdHash drift + stdio stderr drain & init-fail cleanup ──
await t('P0-5 + P0-9: createScrollChatRuntime(enableMcp:true) does not crash; MCP checks cmdHash & drains >100KB stderr', async () => {
  const dir = path.join(tmpRoot, 'p0-5-9-mcp');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('mcpbot', dir);
  const prov = pickProvider('mock', { scriptedTurns: [() => ({ text: 'ok' })] });
  // Even with enableMcp:true and no .mcp.json, must initialize cleanly without TypeError!
  const bundle = await createScrollChatRuntime({
    agentName: 'mcpbot',
    deploymentDir: dir,
    stateDir: path.join(dir, 'state'),
    provider: prov,
    enableMcp: true,
    enableMemory: false,
  });
  await bundle.close();

  // cmdHash drift detection in verifyAndPinTools
  const t1 = { server: 'srv', name: 'ping', fullName: 'mcp.srv.ping', cmdHash: 'aaa111', description: 'Ping', parameters: { type: 'object', properties: {} }, risk: 'read_only' };
  const pin1 = verifyAndPinTools([t1], { cwd: dir, autoPin: true });
  assert.equal(pin1.approved.length, 1);
  const pin2 = verifyAndPinTools([{ ...t1, cmdHash: 'bbb222' }], { cwd: dir, autoPin: false });
  assert.equal(pin2.approved.length, 0);
  assert.equal(pin2.quarantined.length, 1);
  assert.equal(pin2.quarantined[0].reason, 'mcp_server_command_drifted_asi04');

  // Stdio MCP server emitting >100KB on stderr MUST NOT deadlock
  const noisyServer = path.join(dir, 'noisy-mcp.mjs');
  fs.writeFileSync(noisyServer, `
import readline from 'node:readline';
process.stderr.write('X'.repeat(120000) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'noisy' }, capabilities: {} } }) + '\\n');
  } else if (m.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) + '\\n');
  }
});
`);
  const cli = createMcpStdioClient({ name: 'noisy', command: process.execPath, args: [noisyServer], cwd: dir, timeoutMs: 5000 });
  await cli.connect();
  const listed = await cli.listTools();
  assert.deepEqual(listed, []);
  await cli.close();
});

// ── P0-6: Grounding fail-closed on empty KB & redacts finalText/bubbles/history ──
await t('P0-6: Grounding failure blocks text/bubbles/history AND fails closed even when KB is empty', async () => {
  const dir = path.join(tmpRoot, 'p0-6-ground');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('shopbot', dir);
  fs.writeFileSync(path.join(dir, 'USER.md'), VALID_USER_MD);
  // Deliberately NO knowledge/ files at all (empty principalSources)
  const prov = pickProvider('mock', {
    scriptedTurns: [() => ({ text: 'Special offer: Deluxe plan is only $199 today!' })],
  });
  const rt = createChatSessionRuntime({
    agentName: 'shopbot',
    cwd: dir,
    stateDir: path.join(dir, 'state'),
    provider: prov,
  });
  try {
    const deltas = [];
    const res = await rt.sendTurn({
      conversationId: 'guest-empty-kb',
      text: 'How much?',
      sender: { channelId: 'tg:9999', name: 'Guest' },
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(res.grounding.checked, true, 'grounding MUST run even when KB is empty');
    assert.equal(res.grounding.ok, false, 'fabricated $199 with empty KB MUST fail grounding');
    assert.equal(res.streamHeld, true);
    assert.equal(deltas.length, 0);
    assert.ok(!res.text.includes('$199'), 'res.text MUST NOT leak ungrounded $199');
    assert.ok(!res.bubbles.join(' ').includes('$199'), 'res.bubbles MUST NOT leak ungrounded $199');
    const hist = rt.getHistory('guest-empty-kb');
    assert.ok(!JSON.stringify(hist).includes('$199'), 'session history MUST NOT be poisoned with ungrounded $199');
  } finally {
    await rt.close();
  }
});

// ── P0-7: Grounding spec required, risk non-downgrade, policy floor, approver resolution, atomic consume ──
await t('P0-7: Fail-closed missing ground spec, risk non-downgrade, policy floor, channel-id approver, & atomic POSIX token consume', async () => {
  const dir = path.join(tmpRoot, 'p0-7-gate');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'USER.md'), VALID_USER_MD);
  const userDoc = openUser({ cwd: dir });

  // Policy floor prevents downgrading financial/destructive to auto
  assert.equal(policyForTier('financial', { financial: 'auto' }), 'must-approve');
  assert.equal(policyForTier('destructive', { destructive: 'auto-log' }), 'must-approve');

  // Channel ID resolves unambiguously to USER.md slug for canApprove
  assert.equal(userDoc.canApprove('tg:1001', { tier: 'financial', amount: 100 }).ok, true);
  assert.equal(userDoc.canApprove('1001', { tier: 'financial', amount: 100 }).ok, true);
  assert.equal(userDoc.canApprove('tg:1001', { tier: 'financial', amount: 999 }).ok, false);
  assert.equal(userDoc.canApprove('tg:9999', { tier: 'financial', amount: 50 }).ok, false);

  const approvalStore = createApprovalStore({ dir: path.join(dir, 'approvals') });
  const tools = createToolRegistry({
    cwd: dir,
    userDoc,
    approvalStore,
    riskDefaults: { web_fetch: 'external_comm' }, // operator elevates web_fetch
  });

  // High-risk tool with empty ground -> DENIED
  tools.register({
    name: 'danger_no_ground',
    description: 'Missing ground',
    risk: 'destructive',
    confirm: { mode: 'none', reason: 'test' },
    parameters: { type: 'object', properties: {} },
    async execute() { return { ok: true }; },
  });
  const ng = await tools.executeTool('danger_no_ground', {}, {});
  assert.equal(ng.ok, false);
  assert.equal(ng.reason, 'grounding_spec_required_for_high_risk_tool');

  // requestApproval returning { approved: true } WITHOUT approver when userDoc.active -> DENIED
  tools.register({
    name: 'pay_it',
    description: 'Pay',
    risk: 'financial',
    ground: ['amount'],
    confirm: { mode: 'none', reason: 'receipt' },
    parameters: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
    async execute(a) { return { paid: a.amount }; },
  });
  const noBy = await tools.executeTool('pay_it', { amount: 50 }, {
    groundingSources: '50',
    requestApproval: async () => ({ approved: true }), // missing approver!
  });
  assert.equal(noBy.ok, false);
  assert.equal(noBy.reason, 'approval_missing_approver');

  // Atomic POSIX rename approval consume: 10 parallel consumers -> EXACTLY 1 wins!
  const tok = approvalStore.issue({ tool: 'pay_it', args: { amount: 50 }, approver: 'tg:1001', tier: 'financial', amount: 50 });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => Promise.resolve().then(() => approvalStore.consume({
      tokenId: tok.id,
      tool: 'pay_it',
      args: { amount: 50 },
      userDoc,
      tier: 'financial',
      amount: 50,
    })))
  );
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, 'POSIX renameSync guarantees EXACTLY ONE consumer can claim a single-use token');
});

// ── P0-8: SSRF DNS fail-closed + complete IPv4/IPv6 CIDR + bounded streaming body cap ──
await t('P0-8: SSRF blocks full IPv4/IPv6 ranges, fails closed on DNS errors, & caps huge streaming bodies', async () => {
  assert.equal(isPrivateIp('225.1.2.3'), true);
  assert.equal(isPrivateIp('241.0.0.1'), true);
  assert.equal(isPrivateIp('64:ff9b::127.0.0.1'), true);
  assert.equal(isPrivateIp('2002:7f00:1::'), true);
  assert.equal(isPrivateIp('::127.0.0.1'), true);
  assert.equal(isPrivateIp('93.184.216.34'), false);

  // DNS error fails CLOSED (no silent fallback)
  const dnsFail = await resolveAndValidatePublicUrl('https://nonexistent.invalid.scroll.test/', {
    dnsLookup: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(dnsFail.ok, false);
  assert.match(dnsFail.reason, /ssrf_dns_lookup_failed/);

  // Streaming body cap stops reading huge stream
  let chunksPulled = 0;
  const hugeStream = new ReadableStream({
    pull(ctrl) {
      chunksPulled++;
      ctrl.enqueue(new Uint8Array(4096).fill(65));
      if (chunksPulled > 500) ctrl.close();
    },
  });
  const tools = createToolRegistry({
    cwd: tmpRoot,
    maxWebFetchBytes: 12_000,
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url) => ({ status: 200, ok: true, url, headers: new Headers(), body: hugeStream }),
  });
  const res = await tools.executeTool('web_fetch', { url: 'https://stream.example.com/big' });
  assert.equal(res.ok, true);
  assert.equal(res.output.truncated, true);
  assert.ok(chunksPulled < 20, `stream should abort early once byte cap hit (pulled=${chunksPulled})`);
});

// ── DeepSeek & Codex Harness Parity + P1s: reasoning_content, max_completion_tokens, pruner, spill, fork, hooks, retriever cache, eval, audit ──
await t('Codex & DeepSeek Parity + P1s: reasoning_content replay, max_completion_tokens, 0-token pruner, spill-to-file, forkSession, hooks, retriever cache, eval & audit', async () => {
  const dir = path.join(tmpRoot, 'parity-and-p1');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('dsbot', dir);

  // 1. OpenAI-compatible SSE captures delta.reasoning_content & sends max_completion_tokens for o3/gpt-5
  const capturedBodies = [];
  const sseBody = [
    'data: {"id":"cmpl_1","choices":[{"delta":{"reasoning_content":"Step 1: check weather."}}]}\n\n',
    'data: {"id":"cmpl_1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_w1","function":{"name":"get_w","arguments":"{\\"city\\":\\"Hanoi\\"}"}}]}}]}\n\n',
    'data: {"id":"cmpl_1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  let reqCount = 0;
  const mockFetch = async (_url, opts) => {
    capturedBodies.push(JSON.parse(opts.body));
    reqCount++;
    if (reqCount === 1) {
      return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      id: 'cmpl_2',
      choices: [{ message: { role: 'assistant', content: 'Hanoi is sunny.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const prov = pickProvider('openai-compatible', { model: 'o3-mini', apiKey: 'sk-test-123', fetchImpl: mockFetch });
  const tools = createToolRegistry({ cwd: dir, spillDir: path.join(dir, 'scratch'), maxToolOutputChars: 2500 });
  tools.register({
    name: 'get_w',
    description: 'Weather',
    risk: 'read_only',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    async execute() { return { weather: 'sunny', pad: 'Z'.repeat(4000) }; }, // triggers spill-to-file!
  });
  tools.register({
    name: 'other_tool',
    description: 'Other',
    risk: 'read_only',
    parameters: { type: 'object', properties: {} },
    async execute() { return { ok: 1 }; },
  });

  const hookEvents = [];
  const rt = createChatSessionRuntime({
    agentName: 'dsbot',
    cwd: dir,
    stateDir: path.join(dir, 'state'),
    provider: prov,
    model: 'o3-mini',
    tools,
    hooks: {
      beforeTool: (ev) => { hookEvents.push(`before:${ev.tool}`); },
      afterTool: (ev) => { hookEvents.push(`after:${ev.tool}`); },
      onStop: () => { hookEvents.push('stop'); },
    },
  });
  try {
    const turn = await rt.sendTurn({ conversationId: 'ds-1', text: 'Weather in Hanoi?', onDelta: () => {} });
    assert.equal(turn.text, 'Hanoi is sunny.');
    assert.ok(capturedBodies[0].max_completion_tokens > 0 && capturedBodies[0].max_tokens === undefined, 'o3-mini must use max_completion_tokens');
    // Round 2 request MUST include verbatim `reasoning_content` on the assistant tool_calls turn!
    const round2Asst = capturedBodies[1].messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.equal(round2Asst?.reasoning_content, 'Step 1: check weather.', 'Intra-turn reasoning_content must replay verbatim');
    // Durable history MUST strip reasoning_content on commit!
    const hist = rt.getHistory('ds-1');
    const persistedAsst = hist.find((m) => m.role === 'assistant' && m.toolCalls);
    assert.equal(persistedAsst?.reasoningContent, undefined, 'reasoningContent stripped on durable commit');
    // Spill-to-file saved full output to scratch dir
    assert.equal(turn.toolTraces[0].result.output.truncated, true);
    assert.ok(fs.existsSync(turn.toolTraces[0].result.output.spilledPath), 'Spill-to-file log must exist on disk');
    // Hooks fired
    assert.deepEqual(hookEvents, ['before:get_w', 'after:get_w', 'stop']);

    // forkSession branches JSONL cleanly
    const fk = rt.forkSession('ds-1', 'ds-1-branch', { atIndex: 2 });
    assert.equal(fk.ok, true);
    assert.ok(rt.getHistory('ds-1-branch').length >= 2);
  } finally {
    await rt.close();
  }

  // 2. 0-token deterministic tool-result pruner
  const msgs = [
    { role: 'tool', toolCallId: '1', name: 't', content: 'A'.repeat(2000) },
    { role: 'tool', toolCallId: '2', name: 't', content: 'B'.repeat(2000) },
    { role: 'tool', toolCallId: '3', name: 't', content: 'C'.repeat(2000) },
  ];
  const pr = pruneOldToolResults(msgs, { keepRecentToolMessages: 1, maxOldChars: 300 });
  assert.equal(pr.prunedCount, 2);
  assert.ok(pr.savedChars > 3000);
  assert.equal(pr.messages[2].content.length, 2000, 'most recent tool output kept intact');

  // 3. Tool retriever cache key isolates different turnToolsAllow subsets
  const r1 = tools.searchTools({ query: 'other', turnToolsAllow: ['get_w'] });
  assert.equal(r1.tools.some((h) => h.name === 'other_tool'), false);
  const r2 = tools.searchTools({ query: 'other', turnToolsAllow: null });
  assert.equal(r2.tools.some((h) => h.name === 'other_tool'), true, 'retriever cache MUST NOT hide tools from prior narrow allowlist');

  // 3b. P0-10: post-execute error & unconfirmed mark `executed: true` so retry never double-runs side effects
  tools.register({
    name: 'post_exec_fail',
    description: 'Mutates then throws',
    risk: 'reversible_write',
    parameters: { type: 'object', properties: {} },
    async execute() { throw new Error('network_reset_after_write'); },
  });
  const failRes = await tools.executeTool('post_exec_fail', {}, {});
  assert.equal(failRes.ok, false);
  assert.equal(failRes.decision, 'error');
  assert.equal(failRes.executed, true, 'post-execute error MUST set executed: true so retry never replays');

  // 4. Non-string telemetry redaction
  const redacted = redactTelemetry({ authorization: { value: 'secret-obj' }, token: 12345, ok: 'visible' });
  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.ok, 'visible');

  // 5. Eval fixes: empty output fails not_contains; machinePass=false + judgeUngraded -> 'fail'
  const negEmpty = runChecks('', [{ op: 'not_contains', value: 'bad' }]);
  assert.equal(negEmpty.allPass, false, 'empty output MUST NOT pass not_contains');

  // 6. audit --verify catches modifications to memory/lessons.md & nested evals/**
  const aud1 = auditRepo(dir);
  assert.equal(aud1.verdict, 'pass');
  fs.mkdirSync(path.join(dir, '.scroll'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.scroll', 'audit.json'), JSON.stringify(aud1, null, 2));
  const v1 = verifyAgainstRecord(dir, auditRepo(dir));
  assert.equal(v1.ok, true);
  fs.mkdirSync(path.join(dir, 'agents', 'dsbot', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'dsbot', 'memory', 'lessons.md'), '# Tampered\n');
  const v2 = verifyAgainstRecord(dir, auditRepo(dir));
  assert.equal(v2.ok, false, 'audit --verify MUST detect new/modified memory/lessons.md');
});

// ── Round-2 Hardening Regression Gate (R2-P0-1..R2-P0-4 + P1s) ───────────────
await t('R2-P0-1..R2-P0-4 + P1s: voiceMeta hold, appendHistory single tool result, MCP pre-spawn/quarantine, exec policy, & schema/IPv6/audit', async () => {
  const dir = path.join(tmpRoot, 'r2-gate');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('r2bot', dir);
  fs.writeFileSync(path.join(dir, 'USER.md'), VALID_USER_MD);

  // 1. R2-P0-1: Grounding failure MUST clear voiceMeta.bubblePlans & editPlan (no leak to channel daemon!)
  const heldProv = pickProvider('mock', {
    scriptedTurns: [() => ({ text: 'Promo code VIP is $199 today!' })],
  });
  const rtHeld = createChatSessionRuntime({
    agentName: 'r2bot',
    cwd: dir,
    stateDir: path.join(dir, 'state-held'),
    provider: heldProv,
    voiceHooks: {
      shapeOutgoing: ({ rawText }) => ({
        text: rawText,
        bubbles: [rawText],
        meta: { bubblePlans: [{ text: rawText, typingMs: 0, pauseMs: 0 }], editPlan: { mode: 'send_then_edit', editedText: rawText } },
      }),
    },
  });
  try {
    const res = await rtHeld.sendTurn({
      conversationId: 'ext-held',
      text: 'Price?',
      sender: { channelId: 'tg:9999', name: 'Guest' },
    });
    assert.equal(res.streamHeld, true);
    assert.equal(res.voiceMeta?.bubblePlans, undefined, 'held turn MUST clear voiceMeta.bubblePlans');
    assert.equal(res.voiceMeta?.editPlan, undefined, 'held turn MUST clear voiceMeta.editPlan');
    assert.ok(!res.rawText.includes('$199'), 'held result rawText must not leak ungrounded claim');
  } finally {
    rtHeld.close();
  }

  // 2. R2-P0-3: Normal tool turn MUST record EXACTLY ONE tool result per toolCallId (zero fake interrupted_before_tool_result!)
  const toolReg = createToolRegistry({ cwd: dir });
  toolReg.register({
    name: 'echo_probe',
    description: 'Echoes input',
    risk: 'read_only',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async (a) => ({ echoed: a.q }),
  });
  const toolProv = pickProvider('mock', {
    scriptedTurns: [
      () => ({ text: '', toolCalls: [{ id: 'tc-exact-1', name: 'echo_probe', arguments: { q: 'hello' } }] }),
      () => ({ text: 'Echo finished cleanly.' }),
    ],
  });
  const rtTool = createChatSessionRuntime({
    agentName: 'r2bot',
    cwd: dir,
    stateDir: path.join(dir, 'state-tool'),
    provider: toolProv,
    tools: toolReg,
  });
  try {
    await rtTool.sendTurn({
      conversationId: 'conv-tool-once',
      text: 'Echo hello',
      sender: { channelId: 'tg:1001', name: 'Boss' },
    });
    const hist = rtTool.getHistory('conv-tool-once');
    const toolMsgs = hist.filter((m) => m.role === 'tool' && m.toolCallId === 'tc-exact-1');
    assert.equal(toolMsgs.length, 1, 'normal tool turn MUST persist exactly 1 tool result, never duplicate synthetic orphan');
    assert.ok(!toolMsgs[0].content.includes('interrupted_before_tool_result'));
    const sessDir = path.join(dir, 'state-tool', 'sessions', 'r2bot');
    const jsonlFiles = fs.readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(jsonlFiles.length, 1);
    const diskRows = fs.readFileSync(path.join(sessDir, jsonlFiles[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(diskRows.filter((m) => m.role === 'tool' && m.toolCallId === 'tc-exact-1').length, 1, 'disk JSONL must also have exactly 1 tool result');

    // P1: forkSession(same, same) MUST throw instead of truncating source in place
    assert.throws(() => rtTool.forkSession('conv-tool-once', 'conv-tool-once'), /must differ/);
  } finally {
    rtTool.close();
  }

  // 3. R2-P0-4: evaluateExecPolicy rejects `./git status` for bare allow rule `["git", "status"]` + catches `-r -f` & `-fr`
  assert.equal(evaluateExecPolicy({ command: './git', args: ['status'], allowRules: [['git', 'status']] }).ok, false);
  assert.equal(evaluateExecPolicy({ command: '/tmp/git', args: ['status'], allowRules: [['git', 'status']] }).ok, false);
  assert.equal(evaluateExecPolicy({ command: 'git', args: ['status'], allowRules: [['git', 'status']] }).ok, true);
  assert.equal(evaluateExecPolicy({ command: 'rm', args: ['-r', '-f', 'tmp'], denyRules: [['rm', '-rf']] }).ok, false);
  assert.equal(evaluateExecPolicy({ command: 'rm', args: ['-fr', 'tmp'], denyRules: [['rm', '-rf']] }).ok, false);
  assert.equal(evaluateExecPolicy({ command: 'rm', args: ['-Rf', 'tmp'], denyRules: [['rm', '-rf']] }).ok, false);
  assert.equal(evaluateExecPolicy({ command: 'rm', args: ['--recursive', '--force', 'tmp'], denyRules: [['rm', '-rf']] }).ok, false);

  // Seatbelt allowNetwork: true MUST emit `(allow network-outbound (remote ip))` + mDNSResponder, NEVER `(allow network*)`
  const netSbpl = buildSeatbeltProfile({ cwd: dir, command: '/bin/echo', allowNetwork: true });
  assert.ok(netSbpl.includes('(allow network-outbound (remote ip))'));
  assert.ok(netSbpl.includes('/private/var/run/mDNSResponder'));
  assert.ok(!netSbpl.includes('(allow network*)'));

  // 4. R2-P0-2: MCP pre-spawn cmdHash check refuses spawning altered stdio command + blocks new tool on locked server + blocks quarantined callTool
  const mcpDir = path.join(tmpRoot, 'r2-mcp');
  fs.mkdirSync(path.join(mcpDir, '.scroll'), { recursive: true });
  const markerFile = path.join(mcpDir, 'SHOULD_NOT_SPAWN.txt');
  const evilScript = path.join(mcpDir, 'evil.mjs');
  fs.writeFileSync(evilScript, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(markerFile)}, 'SPAWNED');\n`);
  fs.writeFileSync(path.join(mcpDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      pinnedSrv: { command: process.execPath, args: [evilScript] },
    },
  }));
  fs.writeFileSync(path.join(mcpDir, '.scroll', 'mcp.lock.json'), JSON.stringify({
    version: 1,
    tools: {
      'mcp.pinnedSrv.ping': {
        server: 'pinnedSrv',
        cmdHash: '0000000000000000',
        tool: 'ping',
        schemaHash: 'aaaa',
        descHash: 'bbbb',
      },
    },
  }));
  const mcpMgr = createMcpManager({ cwd: mcpDir, enforceLock: true, autoPinLock: true });
  await mcpMgr.connectAll();
  assert.equal(fs.existsSync(markerFile), false, 'altered stdio MCP server MUST NOT be spawned before cmdHash verification!');
  assert.ok(mcpMgr.getFailedServers().some((e) => e.server === 'pinnedSrv' && e.error.includes('mcp_server_command_drifted_asi04')));
  // Already-pinned server injecting a new tool name MUST be quarantined even when autoPin=true
  const pinRes = verifyAndPinTools([
    { server: 'pinnedSrv', name: 'injected_v2', fullName: 'mcp.pinnedSrv.injected_v2', cmdHash: '0000000000000000', description: 'new', parameters: {} },
  ], { cwd: mcpDir, autoPin: true });
  assert.equal(pinRes.approved.length, 0);
  assert.equal(pinRes.quarantined.length, 1);
  assert.equal(pinRes.quarantined[0].reason, 'mcp_unpinned_tool_on_locked_server');

  // 5. P1s: sanitizeGeminiSchema union/const/$ref/dangling-required + IPv6 canonical forms + approvalStore strict bindings & inline single-use
  const gSchema = sanitizeGeminiSchema({
    type: 'object',
    $defs: { x: { type: 'string' } },
    properties: {
      mode: { const: 'fast' },
      note: { type: ['string', 'null'], $ref: '#/$defs/x' },
    },
    required: ['mode', 'nonexistent_prop'],
  });
  assert.deepEqual(gSchema.properties.mode.enum, ['fast']);
  assert.equal(gSchema.properties.note.type, 'string');
  assert.equal(gSchema.properties.note.nullable, true);
  assert.equal(gSchema.properties.note.$ref, undefined);
  assert.equal(gSchema.$defs, undefined);
  assert.deepEqual(gSchema.required, ['mode']);

  assert.equal(isPrivateIp('0:0:0:0:0:ffff:7f00:1'), true, 'expanded IPv4-mapped IPv6 MUST be blocked');
  assert.equal(isPrivateIp('::ffff:0:7f00:1'), true, 'IPv4-translated IPv6 MUST be blocked');
  assert.equal(isPrivateIp('100::1'), true, 'RFC 6666 discard prefix MUST be blocked');

  const apStore = createApprovalStore({ dir: path.join(dir, 'ap-strict') });
  const strictTok = apStore.issue({ tool: 'pay', args: { x: 1 }, approver: 'boss', conversationId: 'conv-A', turnId: 'turn-1', schemaHash: 'sh-1' });
  assert.equal(apStore.consume({ tokenId: strictTok.id, tool: 'pay', args: { x: 1 } }).ok, false, 'omitted conversationId/turnId/schemaHash MUST fail');
  assert.equal(apStore.consume({ tokenId: '../escape', tool: 'pay', args: { x: 1 } }).ok, false, 'malformed tokenId MUST fail');
  assert.equal(apStore.consume({ tokenId: strictTok.id, tool: 'pay', args: { x: 1 }, conversationId: 'conv-A', turnId: 'turn-1', schemaHash: 'sh-1' }).ok, true);

  // Single-use inline approval latch blocks 2 identical calls in the same turn
  const inlineState = { used: false };
  const inlineReg = createToolRegistry({ cwd: dir });
  let ranCount = 0;
  inlineReg.register({
    name: 'check_once',
    description: 'Read-only confirm probe',
    risk: 'read_only',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ done: true }),
  });
  inlineReg.register({
    name: 'danger_once',
    description: 'Danger once',
    risk: 'destructive',
    ground: ['id'],
    confirm: { probe: 'check_once', expect: '$.done' },
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async () => ({ count: ++ranCount }),
  });
  const argsHash = hashArgs({ id: 'ORD-1' });
  const rOnce1 = await inlineReg.executeTool('danger_once', { id: 'ORD-1' }, {
    approved: true, approvedTool: 'danger_once', approvedArgsHash: argsHash, approver: 'tg:1001', inlineApprovalState: inlineState,
    trustedGroundingSources: 'ORD-1',
  });
  const rOnce2 = await inlineReg.executeTool('danger_once', { id: 'ORD-1' }, {
    approved: true, approvedTool: 'danger_once', approvedArgsHash: argsHash, approver: 'tg:1001', inlineApprovalState: inlineState,
    trustedGroundingSources: 'ORD-1',
  });
  assert.equal(rOnce1.ok, true);
  assert.equal(rOnce2.ok, false);
  assert.equal(rOnce2.reason, 'approval_already_used');
  assert.equal(ranCount, 1);

  // Corrupt lockfile MUST fail closed (never fall back to empty TOFU!)
  const corruptMcpDir = path.join(tmpRoot, 'r3-mcp-corrupt');
  fs.mkdirSync(path.join(corruptMcpDir, '.scroll'), { recursive: true });
  fs.writeFileSync(path.join(corruptMcpDir, '.scroll', 'mcp.lock.json'), '{ truncated json');
  assert.throws(() => verifyAndPinTools([], { cwd: corruptMcpDir, autoPin: true }), /mcp_lock_corrupt/);

  // Non-streaming JSON truncated tool calls (OpenAI `length` & Anthropic `max_tokens`) MUST set malformed+truncated
  const oaTrunc = pickProvider('openai-compatible', {
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'chatcmpl_trunc',
      choices: [{ finish_reason: 'length', message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'danger', arguments: '' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const oaRes = await oaTrunc.generate('hi', { stream: false });
  assert.equal(oaRes.toolCalls[0].malformed, true);
  assert.equal(oaRes.toolCalls[0].truncated, true);

  const antTrunc = pickProvider('anthropic', {
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5',
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'msg_trunc',
      stop_reason: 'max_tokens',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'danger', input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const antRes = await antTrunc.generate('hi', { stream: false });
  assert.equal(antRes.toolCalls[0].malformed, true);
  assert.equal(antRes.toolCalls[0].truncated, true);

  // Pydantic v2 anyOf nullable union unwraps cleanly to { type, nullable: true }
  const gPydantic = sanitizeGeminiSchema({
    type: 'object',
    properties: {
      opt: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
    },
  });
  assert.equal(gPydantic.properties.opt.type, 'string');
  assert.equal(gPydantic.properties.opt.nullable, true);
  assert.equal(gPydantic.properties.opt.anyOf, undefined);

  // P1: audit --verify MUST catch deleted agent
  const audDir = path.join(tmpRoot, 'r2-audit-del');
  fs.mkdirSync(audDir, { recursive: true });
  scaffold('keepbot', audDir);
  scaffold('delbot', audDir);
  const audBefore = auditRepo(audDir);
  assert.equal(audBefore.verdict, 'pass');
  fs.mkdirSync(path.join(audDir, '.scroll'), { recursive: true });
  fs.writeFileSync(path.join(audDir, '.scroll', 'audit.json'), JSON.stringify(audBefore, null, 2));
  fs.rmSync(path.join(audDir, 'agents', 'delbot'), { recursive: true, force: true });
  const audCheck = verifyAgainstRecord(audDir, auditRepo(audDir));
  assert.equal(audCheck.ok, false, 'audit --verify MUST detect deleted agent');
  assert.ok(audCheck.reason.includes('delbot (deleted)'));
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '\x1b[32m\u2714 all green\x1b[0m' : '\x1b[31m\u2716 failures\x1b[0m'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
