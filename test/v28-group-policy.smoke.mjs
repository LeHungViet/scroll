#!/usr/bin/env node
// SCROLL 2.8.1 -- Group Trigger Policy & Signed Pack ChannelPolicy Smoke Test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHANNEL_POLICY,
  normalizeChannelPolicy,
  compileGroupPolicy,
  stripBotMention,
  evaluateGroupTrigger,
  generatePackSigningKeyPair,
  buildAgentPack,
  verifyAgentPack,
  createPackRegistry,
  openTenantWorkspace,
  createPrincipalProvider,
  createScrollAgentHost,
} from '../index.js';

function testPolicyEvaluation() {
  const policy = compileGroupPolicy({
    groupPolicy: 'mention',
    mentionPatterns: ['\\bhelper\\b', '\\bassistant\\b', '[invalid-regex'],
    softAliasPatterns: ['\\bhey\\s+h\\b', '^\\s*h\\s*[,:?!]'],
    softAliasLabels: ['H'],
    debounceQuietMs: 3500,
    debounceMaxWaitMs: 12000,
  });

  assert.equal(policy.groupPolicy, 'mention');
  assert.equal(policy.mentionRegexes.length, 2, 'invalid regex skipped safely');
  assert.equal(policy.softAliasRegexes.length, 2);

  // DM always triggers
  assert.equal(evaluateGroupTrigger({ policy, isGroup: false, text: 'random chatter' }).trigger, true);

  // Group plain chatter ignored
  const plain = evaluateGroupTrigger({
    policy,
    isGroup: true,
    text: 'what is for lunch today?',
    botUsername: 'helper_bot',
    botUserId: '1001',
  });
  assert.equal(plain.trigger, false);
  assert.equal(plain.reason, 'no_mention');

  // Exact @mention triggers, prefix collision @helper_bot_2 does NOT
  assert.equal(
    evaluateGroupTrigger({ policy, isGroup: true, text: 'hi @helper_bot check this', botUsername: 'helper_bot', botUserId: '1001' }).reason,
    'at_mention',
  );
  assert.equal(
    evaluateGroupTrigger({ policy, isGroup: true, text: 'hi @helper_bot_2 check this', botUsername: 'helper_bot', botUserId: '1001' }).trigger,
    false,
  );

  // Reply to THIS bot triggers; reply to ANOTHER bot in the same group does NOT
  assert.equal(
    evaluateGroupTrigger({ policy, isGroup: true, text: 'thanks, also check Q3', botUsername: 'helper_bot', botUserId: '1001', replyToUserId: '1001', replyToIsBot: true }).reason,
    'reply_to_bot',
  );
  assert.equal(
    evaluateGroupTrigger({ policy, isGroup: true, text: 'thanks, also check Q3', botUsername: 'helper_bot', botUserId: '1001', replyToUserId: '2002', replyToIsBot: true }).trigger,
    false,
  );

  // Pattern mention & soft alias mention
  assert.equal(
    evaluateGroupTrigger({ policy, isGroup: true, text: 'Helper please summarize', botUsername: 'helper_bot', botUserId: '1001' }).reason,
    'pattern_mention',
  );
  const soft = evaluateGroupTrigger({ policy, isGroup: true, text: 'H, check the report', botUsername: 'helper_bot', botUserId: '1001' });
  assert.equal(soft.trigger, true);
  assert.equal(soft.reason, 'soft_alias_mention');
  assert.equal(soft.triggerKind, 'soft_mention');

  // Slash commands targeted at self vs another bot
  assert.equal(
    evaluateGroupTrigger({ policy, isGroup: true, text: '/status@helper_bot', botUsername: 'helper_bot', botUserId: '1001' }).reason,
    'slash_command',
  );
  assert.equal(
    evaluateGroupTrigger({ policy, isGroup: true, text: '/status@other_bot', botUsername: 'helper_bot', botUserId: '1001' }).reason,
    'other_bot_command',
  );

  // Burst follow-up inside active debounce window
  const burst = evaluateGroupTrigger({
    policy,
    isGroup: true,
    text: 'and attach the latest PDF too',
    botUsername: 'helper_bot',
    botUserId: '1001',
    hasPendingBurst: true,
  });
  assert.equal(burst.trigger, true);
  assert.equal(burst.reason, 'burst_followup');

  // Policy off / all / allowGroups=false
  assert.equal(evaluateGroupTrigger({ policy: { groupPolicy: 'off' }, isGroup: true, text: '@helper_bot hi', botUsername: 'helper_bot' }).trigger, false);
  assert.equal(evaluateGroupTrigger({ policy: { groupPolicy: 'all', allowGroups: false }, isGroup: true, text: 'hi' }).trigger, false);
  assert.equal(evaluateGroupTrigger({ policy: { groupPolicy: 'all' }, isGroup: true, text: 'hello room' }).reason, 'group_all');

  // Strip @mention cleanly
  assert.equal(stripBotMention('@helper_bot check Q3', 'helper_bot'), 'check Q3');
  assert.equal(stripBotMention('please @helper_bot, check Q3', 'helper_bot'), 'please, check Q3'.replace(' ,', ','));
  assert.equal(stripBotMention('@helper_bot', 'helper_bot'), '@helper_bot');

  // Defaults sane
  assert.equal(DEFAULT_CHANNEL_POLICY.groupPolicy, 'mention');
  assert.equal(normalizeChannelPolicy(null).groupPolicy, 'mention');
}

async function testSignedPackChannelPolicy() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v28-gpol-'));
  try {
    const src = path.join(tmp, 'src');
    const agentDir = path.join(src, 'agents', 'demo');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), '# Demo Agent\nHelpful assistant.\n');
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), 'Clear, concise, polite.\n');

    const keys = generatePackSigningKeyPair();
    const packsRoot = path.join(tmp, 'packs');

    // 1. Pack WITH channelPolicy (Ed25519 signed)
    const packDir1 = path.join(packsRoot, 'demo', '1.0.0');
    const built = buildAgentPack({
      sourceDir: src,
      agentName: 'demo',
      packId: 'demo',
      version: '1.0.0',
      outDir: packDir1,
      includeKnowledge: false,
      channelPolicy: {
        groupPolicy: 'mention',
        mentionPatterns: ['\\bdemo\\b'],
        softAliasPatterns: ['^\\s*d\\s*,'],
        debounceQuietMs: 3500,
        debounceMaxWaitMs: 12000,
      },
      privateKeyPem: keys.privateKeyPem,
    });
    assert.equal(built.signed, true);
    assert.deepEqual(built.manifest.channelPolicy.mentionPatterns, ['\\bdemo\\b']);

    const verified = verifyAgentPack({
      packDir: packDir1,
      publicKeyPem: keys.publicKeyPem,
      requireSignature: true,
    });
    assert.equal(verified.ok, true, `Expected clean verify, got: ${verified.errors.join(', ')}`);

    // 2. Host surfaces getChannelPolicy() from active signed pack
    const registry = createPackRegistry({
      packsRootDir: packsRoot,
      publicKeyPem: keys.publicKeyPem,
      requireSignature: true,
    });
    const ws = openTenantWorkspace({
      tenantsRootDir: path.join(tmp, 'tenants'),
      tenantId: 'tenant-a',
      deploymentId: 'dep-demo',
      packRegistry: registry,
      initialPack: { packId: 'demo', version: '1.0.0' },
    });
    const host = await createScrollAgentHost({
      workspace: ws,
      packRegistry: registry,
      principalProvider: createPrincipalProvider({ filePath: path.join(ws.getPaths().runtimeDir, 'principals.json'), ownerPrincipalId: 'owner:a' }),
      provider: {
        name: 'stub',
        model: 'stub',
        ready: true,
        supportsTools: false,
        async generate() { return { text: 'ok', toolCalls: [], usage: {}, durationMs: 1, model: 'stub' }; },
      },
    });
    const hp = host.getChannelPolicy();
    assert.equal(hp.groupPolicy, 'mention');
    assert.deepEqual(hp.mentionPatterns, ['\\bdemo\\b']);
    assert.equal(host.getStatus().channelPolicy.debounceQuietMs, 3500);
    await host.close();

    // 3. Tampering channelPolicy MUST invalidate Ed25519 signature!
    const mPath = path.join(packDir1, 'pack.manifest.json');
    const tampered = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    tampered.channelPolicy.groupPolicy = 'all';
    fs.writeFileSync(mPath, JSON.stringify(tampered, null, 2) + '\n');
    const badVerify = verifyAgentPack({
      packDir: packDir1,
      publicKeyPem: keys.publicKeyPem,
      requireSignature: true,
    });
    assert.equal(badVerify.ok, false, 'Tampered channelPolicy must fail signature verification');
    assert.ok(badVerify.errors.some((e) => e.includes('SIGNATURE')), `Expected signature error, got ${badVerify.errors}`);

    // 4. Backwards compatibility: pack WITHOUT channelPolicy still signs & verifies cleanly
    const packDir2 = path.join(packsRoot, 'demo', '0.9.0');
    buildAgentPack({
      sourceDir: src,
      agentName: 'demo',
      packId: 'demo',
      version: '0.9.0',
      outDir: packDir2,
      includeKnowledge: false,
      privateKeyPem: keys.privateKeyPem,
    });
    const legacyVerify = verifyAgentPack({
      packDir: packDir2,
      publicKeyPem: keys.publicKeyPem,
      requireSignature: true,
    });
    assert.equal(legacyVerify.ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

testPolicyEvaluation();
await testSignedPackChannelPolicy();
console.log('ALL v28-group-policy smoke tests PASSED');
