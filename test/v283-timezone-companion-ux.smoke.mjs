#!/usr/bin/env node
// SCROLL 2.8.3 Smoke Test -- Global IANA Timezone Sync, Companion Platform Skill Gating,
// Bullet-Newline Preservation, Proposal-Approval Action Routing, Cron History Mirroring,
// and Signed Pack Skill Scripts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidIanaTimezone,
  normalizeTimezone,
  getUtcOffsetLabel,
  resolveTimezone,
  formatCurrentTimeCue,
  parseUserMd,
  validateUserMd,
  openUser,
  openSkills,
  enforceStyle,
  classifyTurnBudget,
  renderAnswerContractCue,
  generatePackSigningKeyPair,
  buildAgentPack,
  verifyAgentPack,
  createPackRegistry,
  openTenantWorkspace,
  createPrincipalProvider,
  createScrollAgentHost,
} from '../index.js';

let passed = 0;
async function check(name, fn) {
  await fn();
  console.log(`  ✔ ${name}`);
  passed++;
}

console.log('SCROLL 2.8.3 -- Global Timezone, Companion Platforms, & Chat UX Smoke Tests');

await check('1. lib/timezone.js: IANA validation, DST offsets, 5-level cascade (zero hardcoded country)', async () => {
  assert.equal(isValidIanaTimezone('Asia/Tokyo'), true);
  assert.equal(isValidIanaTimezone('America/New_York'), true);
  assert.equal(isValidIanaTimezone('Europe/London'), true);
  assert.equal(isValidIanaTimezone('Asia/Ho_Chi_Minh'), true);
  assert.equal(isValidIanaTimezone('Mars/Olympus'), false);
  assert.equal(normalizeTimezone('  Asia/Seoul  '), 'Asia/Seoul');
  assert.equal(normalizeTimezone('Not/AZone'), null);

  // DST-aware UTC offsets
  const winterNy = getUtcOffsetLabel(new Date('2026-01-15T12:00:00Z'), 'America/New_York');
  const summerNy = getUtcOffsetLabel(new Date('2026-07-15T12:00:00Z'), 'America/New_York');
  assert.equal(winterNy, 'UTC-05:00');
  assert.equal(summerNy, 'UTC-04:00');
  assert.equal(getUtcOffsetLabel(new Date('2026-11-25T05:00:00Z'), 'Asia/Tokyo'), 'UTC+09:00');

  // Strict 5-level cascade -> falls back to UTC, never a hardcoded country
  assert.deepEqual(
    resolveTimezone({
      turnTimezone: 'America/Los_Angeles',
      speakerTimezone: 'Asia/Seoul',
      principalTimezone: 'Asia/Ho_Chi_Minh',
      agentTimezone: 'Europe/Berlin',
      hostTimezone: 'Asia/Tokyo',
    }),
    { timezone: 'America/Los_Angeles', source: 'turn' },
  );
  assert.deepEqual(
    resolveTimezone({
      turnTimezone: 'Invalid/Zone',
      speakerTimezone: 'Asia/Seoul',
      principalTimezone: 'Asia/Ho_Chi_Minh',
    }),
    { timezone: 'Asia/Seoul', source: 'speaker' },
  );
  assert.deepEqual(
    resolveTimezone({ principalTimezone: 'Europe/Paris', hostTimezone: 'UTC' }),
    { timezone: 'Europe/Paris', source: 'principal' },
  );
  assert.deepEqual(resolveTimezone({}), { timezone: 'UTC', source: 'fallback' });

  const cue = formatCurrentTimeCue(new Date('2026-11-25T05:00:00Z'), { timezone: 'Asia/Seoul' });
  assert.equal(cue, '[Current time: Wed, 2026-11-25 14:00 · Asia/Seoul (UTC+09:00)]');
});

await check('2. USER.md principal.timezone validation & openUser().principalTimezone()', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v283-user-'));
  try {
    const validRaw = [
      '---',
      'principal:',
      '  kind: org',
      '  name: Acme Global',
      '  timezone: America/New_York',
      'people:',
      '  - { id: alice, name: "Alice", call: "Alice", role: owner, timezone: Asia/Tokyo, channel_ids: ["web:alice"] }',
      '---',
      'Global operations.',
    ].join('\n');
    const parsed = parseUserMd(validRaw);
    const val = validateUserMd(parsed);
    assert.deepEqual(val.errors, []);
    assert.deepEqual(val.warnings, []);

    const badRaw = validRaw.replace('America/New_York', 'Invalid/Place');
    const badVal = validateUserMd(parseUserMd(badRaw));
    assert.ok(badVal.errors.some((e) => e.includes('principal.timezone')));

    const userPath = path.join(tmp, 'USER.md');
    fs.writeFileSync(userPath, validRaw, 'utf8');
    const u = openUser({ cwd: tmp, file: userPath });
    assert.equal(u.valid, true);
    assert.equal(u.principalTimezone(), 'America/New_York');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check('3. skills.js + agent-host.js: companionPlatforms dynamically unlocks platforms:[macos] on Linux hosts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v283-plat-'));
  try {
    const skillDir = path.join(tmp, 'agents', 'demo', 'skills', 'mac-gui');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: mac-gui',
      'description: Control native macOS apps via Companion.',
      'metadata:',
      '  scroll:',
      '    platforms: [macos]',
      '---',
      'Use macOS Companion.',
    ].join('\n'));

    // Simulated Linux cloud host with NO companion -> gated
    const reg = openSkills({ cwd: tmp, agent: 'demo', platform: 'linux', compatFile: false });
    assert.deepEqual(reg.names(), []);
    assert.equal(reg.report().gated.length, 1);

    // Attach macOS Companion (`darwin`) -> unlocked dynamically!
    const unlocked = reg.setExtraPlatforms(['darwin'], { rebuild: true });
    assert.equal(unlocked.platformChanged, true);
    assert.deepEqual(reg.names(), ['mac-gui']);
    assert.equal(reg.report().gated.length, 0);

    // Detach Companion -> cleanly gated again!
    const relocked = reg.setExtraPlatforms([], { rebuild: true });
    assert.equal(relocked.platformChanged, true);
    assert.deepEqual(reg.names(), []);
    assert.equal(reg.report().gated.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await check('4. style.js & turn-budget.js: preserve bullet newlines + classify approval of pending proposal as action_exec', async () => {
  const bullets = 'Daily report:\n- Item 1: Shipped GA\n- Item 2: Reviewed SQM\n- Item 3: Fixed HRM\n- Item 4: Deployed';
  const styled = enforceStyle(bullets, { max_bubbles: 3, max_chars: 2000, follow_up: 0 });
  assert.ok(styled.text.includes('\n- Item 2:'), `Bullets must keep newlines! Got: ${JSON.stringify(styled.text)}`);
  assert.ok(styled.text.includes('\n- Item 4:'), `4th bullet must keep newline! Got: ${JSON.stringify(styled.text)}`);

  const budgetAfterProposal = classifyTurnBudget({
    text: 'Ok',
    history: [{ role: 'assistant', content: 'Here is your draft report for today:\n- Task A\n\nReady to submit?' }],
    economy: { mode: 'outcome_only' },
  });
  assert.equal(budgetAfterProposal.shape, 'action_exec');
  assert.equal(budgetAfterProposal.reason, 'approval_of_pending_proposal');
  const cue = renderAnswerContractCue(budgetAfterProposal, { locale: 'vi' });
  assert.ok(cue.includes('DUYỆT') && !cue.includes('xác nhận gọn 1 câu'));

  const budgetPlainAck = classifyTurnBudget({
    text: 'Ok',
    history: [{ role: 'assistant', content: 'Done, updated the spreadsheet.' }],
    economy: { mode: 'outcome_only' },
  });
  assert.equal(budgetPlainAck.shape, 'ack_confirm');
});

await check('5. ScrollAgentHost E2E: live Region-C clock follows speaker -> principal -> turn tz + recordAssistantMessage + signed pack .py script', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v283-host-'));
  try {
    const srcDir = path.join(tmp, 'src');
    const agentDir = path.join(srcDir, 'agents', 'nova');
    const skillDir = path.join(agentDir, 'skills', 'doc-gen');
    fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), [
      '---',
      'name: nova',
      'role: Global assistant',
      'language: en',
      'economy:',
      '  mode: outcome_only',
      '---',
      'You are Nova.',
    ].join('\n'));
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), 'Be sharp and concise.');
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: doc-gen',
      'description: Generate structured documents using scripts/make_doc.py',
      '---',
      'See [scripts/make_doc.py](scripts/make_doc.py).',
    ].join('\n'));
    fs.writeFileSync(path.join(skillDir, 'scripts', 'make_doc.py'), 'print("hello world")\n');

    const { privateKeyPem, publicKeyPem } = generatePackSigningKeyPair();
    const packDir = path.join(tmp, 'packs', 'nova', '1.0.0');
    const built = buildAgentPack({
      sourceDir: srcDir,
      agentName: 'nova',
      packId: 'nova',
      version: '1.0.0',
      outDir: packDir,
      includeKnowledge: false,
      privateKeyPem,
    });
    assert.equal(built.ok, true);
    const ver = verifyAgentPack({ packDir, expectedSha256: built.sha256, publicKeyPem, requireSignature: true });
    assert.equal(ver.ok, true);

    const reg = createPackRegistry({ packsRootDir: path.join(tmp, 'packs'), publicKeyPem, requireSignature: true });
    const ws = openTenantWorkspace({
      tenantsRootDir: path.join(tmp, 'tenants'),
      tenantId: 'tn_global',
      deploymentId: 'dep_nova',
      packRegistry: reg,
      initialPack: { packId: 'nova', version: '1.0.0' },
    });
    fs.writeFileSync(ws.getPaths().userFile, [
      '---',
      'principal:',
      '  kind: org',
      '  name: Global Corp',
      '  timezone: Europe/London',
      'people:',
      '  - { id: owner, name: "Boss", role: owner, timezone: Asia/Tokyo, channel_ids: ["web:owner", "telegram:101"] }',
      '---',
      'Global operations.',
    ].join('\n'));

    const pp = createPrincipalProvider({ stateDir: ws.getPaths().runtimeDir, ownerPrincipalId: 'owner' });
    pp.linkIdentity({ surface: 'telegram', externalId: '101', principalId: 'owner' });

    const seenUserMsgs = [];
    const mockProvider = {
      name: 'mock',
      model: 'mock-1',
      ready: true,
      supportsTools: true,
      async generate(_prompt, opts = {}) {
        const lastUser = [...(opts.messages || [])].reverse().find((m) => m.role === 'user');
        seenUserMsgs.push({
          all: opts.messages || [],
          lastUser: String(lastUser?.content || ''),
        });
        return { text: 'Done.', toolCalls: [], usage: { inputTokens: 10, outputTokens: 4 } };
      },
    };

    const fixedNow = () => new Date('2026-11-25T05:00:00.000Z');
    const host = await createScrollAgentHost({
      placement: 'cloud',
      workspace: ws,
      packRegistry: reg,
      principalProvider: pp,
      provider: mockProvider,
      ownerIds: ['owner'],
      now: fixedNow,
    });

    // Verify signed pack .py script passed openSkills validation cleanly
    assert.deepEqual(host.runtime.chat.skillsRegistry.names(), ['doc-gen']);
    assert.equal(host.runtime.chat.skillsRegistry.report().invalid.length, 0);

    // Mirror an out-of-band cron draft into telegram:101
    host.runtime.recordAssistantMessage('telegram:101', 'Draft report:\n- Item 1\nReady to submit?', { source: 'cron' });

    // Owner (speaker timezone = Asia/Tokyo) replies "Ok" on Telegram
    await host.handleTurn({
      surface: 'telegram',
      conversationId: 'telegram:101',
      senderId: '101',
      senderName: 'Boss',
      text: 'Ok',
    });
    const m1 = seenUserMsgs[0];
    assert.ok(m1.lastUser.includes('[Current time: Wed, 2026-11-25 14:00 · Asia/Tokyo (UTC+09:00)]'), `Expected Asia/Tokyo clock! Got: ${m1.lastUser}`);
    assert.ok(m1.all.some((m) => m.role === 'assistant' && String(m.content).includes('Draft report:')), 'Mirrored cron draft must appear in history!');
    assert.ok(m1.lastUser.includes('shape=action_exec'), 'Approval after mirrored proposal must classify as action_exec!');

    // Explicit per-turn override (e.g. web client traveling in America/New_York) overrides speaker timezone!
    await host.handleTurn({
      surface: 'web',
      conversationId: 'web:owner',
      senderId: 'owner',
      senderName: 'Boss',
      text: 'What time is it?',
      timezone: 'America/New_York',
    });
    const m2 = seenUserMsgs[1];
    assert.ok(m2.lastUser.includes('[Current time: Wed, 2026-11-25 00:00 · America/New_York (UTC-05:00)]'), `Expected America/New_York override! Got: ${m2.lastUser}`);

    // Host-level timezone resolves to principal.timezone (Europe/London) when no speaker/turn override
    assert.deepEqual(host.resolveTimezone(), { timezone: 'Europe/London', source: 'principal' });

    await host.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n✔ all green: ${passed} passed, 0 failed`);
