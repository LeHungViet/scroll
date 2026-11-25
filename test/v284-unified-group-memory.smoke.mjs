#!/usr/bin/env node
// SCROLL 2.8.4 Smoke Test -- Unified Owner Group Activity Capsule, `memory_recent_chats` Tool,
// `searchScoped` sid Deduplication, and Strict Group/Guest Isolation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScopedMemoryTracker, createToolRegistry } from '../index.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  console.log(`  ✔ ${name}`);
  passed++;
}

console.log('SCROLL 2.8.4 -- Unified Owner Group Activity Capsule & memory_recent_chats');

await check('1. Passive group messages immediately appear in Owner DM <recent-group-activity> capsule (0 tool calls)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v284-mem-'));
  try {
    const mt = createScopedMemoryTracker({
      rootDir: path.join(tmp, 'memory'),
      ownerIds: ['owner_1', '386592888'],
      channel: 'unified',
      crossSurfaceUser: true,
    });

    // Passive group messages observed WITHOUT mentioning the bot (Telegram group)
    mt.observeMessage({
      chatId: '-5293424742',
      chatTitle: 'Viet <> SJ | with EA',
      isGroup: true,
      senderId: '6545386534',
      senderName: 'Sangjin Park',
      messageId: 12927,
      text: 'Is tomorrow 2pm okay?',
      surface: 'telegram',
    });
    mt.observeMessage({
      chatId: '-5293424742',
      chatTitle: 'Viet <> SJ | with EA',
      isGroup: true,
      senderId: '6545386534',
      senderName: 'Sangjin Park',
      messageId: 12928,
      text: 'In Vietnam time',
      surface: 'telegram',
    });
    mt.observeMessage({
      chatId: '-5293424742',
      chatTitle: 'Viet <> SJ | with EA',
      isGroup: true,
      senderId: '386592888',
      senderName: 'Viet Le',
      messageId: 12929,
      text: 'Sure',
      surface: 'telegram',
    });

    // 23 seconds later: Owner opens Web DM and asks without naming the group!
    const dmLoad = await mt.recordAndLoad({
      conversationId: 'web:tn_1',
      sender: { id: 'owner_1', name: 'Viet Le' },
      isGroup: false,
      text: 'Save meeting with Sangjin for me',
      channel: 'web',
    });

    assert.ok(dmLoad.dynamicMemoryBlock.includes('<recent-group-activity>'), 'Owner DM MUST receive <recent-group-activity>!');
    assert.ok(dmLoad.dynamicMemoryBlock.includes('Viet <> SJ | with EA'), 'Group title must appear in capsule');
    assert.ok(dmLoad.dynamicMemoryBlock.includes('Is tomorrow 2pm okay?'), 'Passive group message must appear verbatim');
    assert.ok(dmLoad.dynamicMemoryBlock.includes('In Vietnam time'), 'Follow-up message without keyword must appear verbatim');
    assert.ok(dmLoad.dynamicMemoryBlock.includes('Sure'), 'Confirmation must appear verbatim');
    assert.ok(!dmLoad.stableMemoryBlock.includes('Is tomorrow 2pm okay?'), 'Must stay in Region-C dynamic block (sec 13 cache-safe)');

    // STRICT ISOLATION: non-owner DM MUST NEVER see <recent-group-activity> or <tracked-groups-index>!
    const guestLoad = await mt.recordAndLoad({
      conversationId: 'telegram:999999',
      sender: { id: '999999', name: 'External Guest' },
      isGroup: false,
      text: 'What did Sangjin say?',
      channel: 'telegram',
    });
    assert.ok(!guestLoad.memoryBlock.includes('<recent-group-activity>'), 'Guest DM must NEVER see group activity');
    assert.ok(!guestLoad.memoryBlock.includes('Sangjin'), 'Guest DM must NEVER leak group messages');

    // STRICT ISOLATION: another group chat MUST NEVER see Group A's messages!
    const otherGrpLoad = await mt.recordAndLoad({
      conversationId: '-111111',
      chatTitle: 'Other Room',
      sender: { id: '888888', name: 'Teammate' },
      isGroup: true,
      text: 'Hello team',
      channel: 'telegram',
    });
    assert.ok(!otherGrpLoad.memoryBlock.includes('<recent-group-activity>'));
    assert.ok(!otherGrpLoad.memoryBlock.includes('Sangjin'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check('2. memory_recent_chats tool: list + fuzzy groupQuery read + strict cross-group isolation', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v284-tool-'));
  try {
    const mt = createScopedMemoryTracker({
      rootDir: path.join(tmp, 'memory'),
      ownerIds: ['owner_1'],
      channel: 'unified',
      crossSurfaceUser: true,
    });
    mt.observeMessage({
      chatId: '-5293424742',
      chatTitle: 'Viet <> SJ | with EA',
      isGroup: true,
      senderId: '6545386534',
      senderName: 'Sangjin Park',
      messageId: 12927,
      text: 'Is tomorrow 2pm okay?',
      surface: 'telegram',
    });
    mt.observeMessage({
      chatId: '-5293424742',
      chatTitle: 'Viet <> SJ | with EA',
      isGroup: true,
      senderId: '386592888',
      senderName: 'Viet Le',
      messageId: 12929,
      text: 'Sure',
      surface: 'telegram',
    });

    const tools = createToolRegistry({ cwd: tmp });
    mt.registerTools(tools);
    const ownerCtx = {
      sender: { id: 'owner_1', isOwner: true },
      turnClassification: { isGroup: false, isOwner: true },
      memoryContext: { axis: 'user', userId: 'owner_1', chatId: 'web:tn_1' },
    };

    const listed = await tools.executeTool('memory_recent_chats', { action: 'list' }, ownerCtx);
    assert.equal(listed.output.ok, true);
    assert.equal(listed.output.groups[0].chatId, '-5293424742');
    assert.equal(listed.output.groups[0].title, 'Viet <> SJ | with EA');

    // Fuzzy query by member name "Sangjin" OR title abbreviation "SJ"
    const byMember = await tools.executeTool('memory_recent_chats', { action: 'read', groupQuery: 'Sangjin' }, ownerCtx);
    assert.equal(byMember.output.ok, true);
    assert.equal(byMember.output.count, 2);
    assert.ok(byMember.output.messages[0].text.includes('Is tomorrow 2pm okay?'));
    assert.ok(byMember.output.messages[1].text.includes('Sure'));

    const byAbbr = await tools.executeTool('memory_recent_chats', { action: 'read', groupQuery: 'SJ' }, ownerCtx);
    assert.equal(byAbbr.output.ok, true);
    assert.equal(byAbbr.output.chatId, '-5293424742');

    // Cross-group access denied from another group
    const otherGroupCtx = {
      sender: { id: '888888', isOwner: false },
      turnClassification: { isGroup: true, isOwner: false },
      memoryContext: { axis: 'group', userId: '888888', chatId: '-111111' },
    };
    const denied = await tools.executeTool('memory_recent_chats', { action: 'read', chatId: '-5293424742' }, otherGroupCtx);
    assert.equal(denied.output.ok, false);
    assert.equal(denied.output.error, 'cross_group_access_denied');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check('3. searchScoped deduplicates shared Owner sid aliases (no 2x duplicate DM hits crowding out groups)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v284-dedupe-'));
  try {
    const mt = createScopedMemoryTracker({
      rootDir: path.join(tmp, 'memory'),
      ownerIds: ['owner_1', '386592888'],
      channel: 'unified',
      crossSurfaceUser: true,
    });
    // Record Owner DM under BOTH aliases pointing to the SAME sid
    const u1 = mt.ensureUser('owner_1', 'Viet Le');
    mt.registry.users['386592888'] = { ...u1, userId: '386592888' };
    await mt.recordAndLoad({
      conversationId: 'web:tn_1',
      sender: { id: 'owner_1', name: 'Viet Le' },
      isGroup: false,
      text: 'Meeting with Sangjin tomorrow',
      channel: 'web',
    });

    const res = await mt.searchScoped({
      query: 'Sangjin',
      axis: 'all',
      limit: 8,
      ctx: {
        sender: { id: 'owner_1', isOwner: true },
        turnClassification: { isGroup: false },
        memoryContext: { axis: 'user', userId: 'owner_1' },
      },
    });
    const refs = res.hits.map((h) => h.ref);
    assert.equal(refs.length, new Set(refs).size, `Duplicate refs returned for shared sid! Got: ${JSON.stringify(refs)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n✔ all green: ${passed} passed, 0 failed`);
