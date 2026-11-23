// SCROLL 2.5.10 -- Channel-Agnostic Crash-Proof Turn Recovery WAL + Multi-Channel & Telegram Daemon Gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scaffold } from '../index.js';
import {
  DEFAULT_TURN_RECOVERY_CONFIG,
  isTransientProviderError,
  resolveRecoveryCues,
  isNewerMessageId,
  readPendingTurnJournal,
  writePendingTurnJournal,
  createTurnRecoveryController,
} from '../lib/chat-sdk/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v25-recovery-'));
fs.mkdirSync(path.join(tmpRoot, 'node_modules', '@agentpro'), { recursive: true });
fs.symlinkSync(ROOT, path.join(tmpRoot, 'node_modules', '@agentpro', 'scroll'), 'dir');
fs.cpSync(path.join(ROOT, 'packages', 'scroll-telegram'), path.join(tmpRoot, 'node_modules', '@agentpro', 'scroll-telegram'), { recursive: true });
const { createTelegramFleetDaemon } = await import(
  pathToFileURL(path.join(tmpRoot, 'node_modules', '@agentpro', 'scroll-telegram', 'src', 'index.js')).href
);

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    pass++;
  } catch (e) {
    console.error(`  ✖ ${name} -- ${e?.stack || e}`);
    fail++;
  }
}

console.log('SCROLL 2.5.10 -- Channel-Agnostic Turn Recovery WAL & Telegram Fleet Recovery Gate');

await t('Multi-channel scope isolation & messageId ordering (Telegram int, Discord 64-bit snowflake, Slack float ts, opaque UUID)', () => {
  assert.equal(isNewerMessageId(101, 100), true);
  assert.equal(isNewerMessageId(99, 100), false);
  assert.equal(isNewerMessageId('1310000000000000002', '1310000000000000001'), true);
  assert.equal(isNewerMessageId('1732345678.002100', '1732345678.001900'), true);
  assert.equal(isNewerMessageId('msg_b', 'msg_a', { candidateAtMs: 2000, baselineAtMs: 1000 }), true);
  assert.equal(isNewerMessageId('msg_a', 'msg_a', { candidateAtMs: 2000, baselineAtMs: 1000 }), false);

  const stateDir = path.join(tmpRoot, 'multi-ch');
  const slack = createTurnRecoveryController({ stateDir, channel: 'slack', accountId: 'ops-bot', lang: 'en' });
  const discord = createTurnRecoveryController({ stateDir, channel: 'discord', accountId: 'ops-bot', lang: 'en' });
  const zalo = createTurnRecoveryController({ stateDir, channel: 'zalo', accountId: 'sales-bot', lang: 'vi' });

  assert.notEqual(slack.journalPath, discord.journalPath);
  assert.notEqual(discord.journalPath, zalo.journalPath);

  slack.beginTurn({ conversationId: 'C123', threadId: '1732345678.000100', messageId: '1732345678.000200', isGroup: true, text: 'Slack thread Q' });
  discord.beginTurn({ conversationId: '987654321098765432', messageId: '1310000000000000001', isGroup: true, text: 'Discord Q' });
  zalo.beginTurn({ conversationId: 'u-42', messageId: 'zalo_uuid_1', isGroup: false, text: 'Hỏi báo giá' });

  assert.equal(slack.listPending().length, 1);
  assert.equal(discord.listPending().length, 1);
  assert.equal(zalo.listPending().length, 1);

  // Follow-up in Zalo folds prior unanswered message using VI cues (zero hardcoded English)
  const z2 = zalo.beginTurn({ conversationId: 'u-42', messageId: 'zalo_uuid_2', isGroup: false, text: 'trả lời em nhé' });
  assert.ok(z2.carryoverBlock && z2.carryoverBlock.includes('Hỏi báo giá'));
  assert.ok(z2.carryoverBlock.includes('Tin nhắn trước đó chưa kịp trả lời'));

  // Follow-up in Slack uses EN cues (zero hardcoded Vietnamese)
  const s2 = slack.beginTurn({ conversationId: 'C123', threadId: '1732345678.000100', messageId: '1732345678.000500', isGroup: true, text: 'any update?' });
  assert.ok(s2.carryoverBlock && s2.carryoverBlock.includes('Slack thread Q'));
  assert.ok(s2.carryoverBlock.includes('Prior unanswered message'));
  // Double-crash proof: carryoverBlock persisted into new WAL entry
  const sEntry = slack.getPending({ conversationId: 'C123', threadId: '1732345678.000100' });
  assert.ok((sEntry.contextBlocks || []).some((b) => b.includes('Slack thread Q')));

  const customCues = resolveRecoveryCues('en', { deferredCue: 'CUSTOM_DEFERRED' });
  assert.equal(customCues.deferredCue, 'CUSTOM_DEFERRED');
  assert.equal(isTransientProviderError(new Error('codex_rpc_timeout:initialize:30000ms')), true);
  assert.equal(isTransientProviderError(new Error('invalid_api_key_401')), false);
  assert.equal(DEFAULT_TURN_RECOVERY_CONFIG.ttlMs, 15 * 60 * 1000);

  slack.stop();
  discord.stop();
  zalo.stop();
});

await t('Telegram Fleet Daemon E2E: Stage 1 inline retry, Stage 2 deferred retry + onReplyDelivered, & Stage 3 crash/restart catch-up WAL', async () => {
  const deployDir = path.join(tmpRoot, 'tg-deploy');
  const stateDir = path.join(tmpRoot, 'tg-state');
  fs.mkdirSync(deployDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  scaffold('helper', deployDir);

  const sentMessages = [];
  const deliveredHooks = [];
  const makeMockFetch = () => async (url, init) => {
    const method = String(url).split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    const reply = (payload) => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });
    if (method === 'getMe') {
      return reply({ ok: true, result: { id: 9001, username: 'helper_bot', can_read_all_group_messages: true } });
    }
    if (method === 'getUpdates') {
      await new Promise((r) => setTimeout(r, 30));
      return reply({ ok: true, result: [] });
    }
    if (method === 'sendMessage') {
      sentMessages.push(body);
      return reply({ ok: true, result: { message_id: 700 + sentMessages.length, text: body.text } });
    }
    return reply({ ok: true, result: true });
  };

  // Run 1: Stage 1 fails 2x then succeeds on 3rd inline attempt; then message #2 fails all inline -> enters Stage 2 deferred -> daemon crashes (stop) before Stage 2 fires!
  let callCount = 0;
  const provider1 = {
    name: 'mock-flaky',
    model: 'mock-1',
    ready: true,
    async generate(prompt) {
      callCount++;
      if (callCount <= 2) throw new Error('codex_rpc_timeout:initialize:30000ms');
      if (callCount === 3) return { text: 'Inline recovered cleanly!', usage: { input: 10, output: 10 } };
      // Message #2 keeps timing out so it stays in WAL across simulated crash
      throw new Error('codex_rpc_timeout:initialize:30000ms');
    },
    async close() {},
  };

  const baseConfig = {
    stateDir,
    ownerIds: ['555'],
    debounceQuietMs: 10,
    debounceMaxWaitMs: 30,
    codexAppServer: { prewarm: false },
    memoryMaintenanceIntervalMs: 0,
    turnRecovery: {
      inlineRetryDelaysMs: [10, 10],
      deferredRetryDelaysMs: [60_000],
      startupDelayMs: 40,
      startupStaggerMs: 10,
    },
    bots: [{
      id: 'helper',
      agentName: 'helper',
      username: 'helper_bot',
      deploymentDir: deployDir,
      token: 'TEST_TOKEN',
      ownerIds: ['555'],
      typingKeepaliveMs: 0,
      delayScale: 0,
    }],
  };

  const d1 = await createTelegramFleetDaemon(baseConfig, {
    fetchImpl: makeMockFetch(),
    providerFactory: async () => provider1,
    plugins: [() => ({ onReplyDelivered: (ev) => deliveredHooks.push(ev) })],
    logger: { info() {}, warn() {}, error() {} },
  });
  const bot1 = d1.bots.get('helper');
  bot1.username = 'helper_bot';
  bot1.botUserId = 9001;

  // Msg 1: inline auto-recovery succeeds transparently
  await d1.handleIncomingMessage(bot1, {
    message_id: 101,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 555, type: 'private' },
    from: { id: 555, first_name: 'Owner' },
    text: 'Check status',
  });
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(callCount, 3, 'Stage 1 must auto-retry inline twice then succeed');
  assert.ok(sentMessages.some((m) => String(m.chat_id) === '555' && m.text.includes('Inline recovered cleanly!')));
  assert.equal(bot1.turnRecovery.listPending().length, 0, 'WAL empty after Stage 1 recovery');

  // Msg 2: group mention fails all inline attempts -> persisted to WAL -> daemon stops/crashes BEFORE 60s deferred retry!
  sentMessages.length = 0;
  await d1.handleIncomingMessage(bot1, {
    message_id: 202,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -9001, type: 'supergroup', title: 'Core Ops' },
    from: { id: 555, first_name: 'Owner' },
    reply_to_message: { message_id: 201, from: { id: 9001, first_name: 'Helper' }, text: 'Previous report summary' },
    text: '@helper_bot give me the full numbers',
  });
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(bot1.turnRecovery.listPending().length, 1, 'Failed turn persisted to WAL');
  assert.equal(d1.getHealth().bots[0].pendingRecovery, 1, 'getHealth exposes pendingRecovery count');
  await d1.stop();

  // Verify WAL survived stop() intact
  const persisted = readPendingTurnJournal(bot1.turnRecovery.journalPath);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].messageId, 202);
  assert.equal(persisted[0].status, 'retry_pending');
  assert.ok((persisted[0].contextBlocks || []).some((b) => b.includes('Previous report summary')), 'WAL persists reply_to context block on disk');

  // Run 2: Fresh daemon boots on SAME stateDir -> Stage 3 startup catch-up replays msg #202 cleanly!
  sentMessages.length = 0;
  deliveredHooks.length = 0;
  let seenStartupPayload = '';
  const provider2 = {
    name: 'mock-healthy',
    model: 'mock-1',
    ready: true,
    async generate(prompt, opts) {
      seenStartupPayload = JSON.stringify({ prompt, messages: opts?.messages || [], system: opts?.system || '' });
      return { text: 'Recovered full numbers after restart: 42 units.', usage: { input: 10, output: 10 } };
    },
    async close() {},
  };
  const d2 = await createTelegramFleetDaemon(baseConfig, {
    fetchImpl: makeMockFetch(),
    providerFactory: async () => provider2,
    plugins: [() => ({ onReplyDelivered: (ev) => deliveredHooks.push(ev) })],
    logger: { info() {}, warn() {}, error() {} },
  });
  await d2.start();
  await new Promise((r) => setTimeout(r, 260));
  const grpReplies = sentMessages.filter((m) => String(m.chat_id) === '-9001');
  assert.equal(grpReplies.length, 1, 'Startup catch-up must deliver recovered reply to group');
  assert.ok(grpReplies[0].text.includes('42 units'));
  assert.equal(grpReplies[0].reply_parameters?.message_id, 202, 'Group recovery replies to original message_id');
  assert.ok(seenStartupPayload.includes('Previous report summary'), 'Startup replay preserves reply_to context');
  assert.ok(seenStartupPayload.includes('Turn Recovery'), 'Startup replay injects Turn Recovery cue');
  assert.equal(deliveredHooks.length, 1, 'onReplyDelivered fires for recovered turns');
  assert.equal(deliveredHooks[0].triggerReason, 'startup_recovery');
  assert.equal(d2.bots.get('helper').turnRecovery.listPending().length, 0, 'WAL cleared after startup catch-up');
  await d2.stop();

  // Run 3: Dedup + Crash-Loop + TTL guards prevent duplicate or runaway replays
  const walFile = d2.bots.get('helper').turnRecovery.journalPath;
  const now = Date.now();
  writePendingTurnJournal(walFile, [
    {
      scopeKey: 'telegram:helper:555:root',
      channel: 'telegram',
      accountId: 'helper',
      conversationId: '555',
      chatId: '555',
      threadId: null,
      messageId: 101,
      isGroup: false,
      text: 'Already answered in Run 1',
      status: 'inflight',
      receivedAt: now - 30_000, // Run 1 assistant reply is AFTER this timestamp!
      updatedAt: now - 30_000,
      startupReplayCount: 0,
    },
    {
      scopeKey: 'telegram:helper:-9002:root',
      channel: 'telegram',
      accountId: 'helper',
      conversationId: '-9002',
      chatId: '-9002',
      threadId: null,
      messageId: 301,
      isGroup: true,
      text: 'Already replayed once',
      status: 'replaying',
      receivedAt: now - 5_000,
      updatedAt: now - 5_000,
      startupReplayCount: 1,
    },
    {
      scopeKey: 'telegram:helper:-9003:root',
      channel: 'telegram',
      accountId: 'helper',
      conversationId: '-9003',
      chatId: '-9003',
      threadId: null,
      messageId: 302,
      isGroup: true,
      text: 'Expired entry',
      status: 'inflight',
      receivedAt: now - 30 * 60_000,
      updatedAt: now - 30 * 60_000,
      startupReplayCount: 0,
    },
  ]);
  let guardCalls = 0;
  const d3 = await createTelegramFleetDaemon(baseConfig, {
    fetchImpl: makeMockFetch(),
    providerFactory: async () => ({
      name: 'mock-guard',
      model: 'mock-1',
      ready: true,
      async generate() { guardCalls++; return { text: 'NO' }; },
      async close() {},
    }),
    logger: { info() {}, warn() {}, error() {} },
  });
  await d3.start();
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(guardCalls, 0, 'Already-answered, crash-loop-capped, and expired WAL entries must NEVER replay');
  assert.equal(readPendingTurnJournal(walFile).length, 0, 'Pruned WAL must be empty');
  await d3.stop();
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nSCROLL v2.5.10 Turn Recovery Gate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
