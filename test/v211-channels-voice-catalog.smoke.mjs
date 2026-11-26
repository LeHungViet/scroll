// SCROLL 2.11 -- Unified Channels Core, Multilingual Voice Runtime, & 4-Tier Canonical Tool Catalog Smoke Tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generatePackSigningKeyPair,
  buildAgentPack,
  verifyAgentPack,
  createPackRegistry,
  openTenantWorkspace,
  createPrincipalProvider,
  createScrollAgentHost,
  describeToolCatalog,
  verifyIntrospectionParity,
  hasBareNumericSlider,
} from '../index.js';
import {
  resolveVoiceProfile,
  compilePersonalityCues,
  sanitizeControlGlitches,
  splitSmartBubbles,
  applyClaimSafeHumanTexture,
} from '../lib/voice-engine.js';
import {
  createChannelEngine,
  guardGroupError,
  hasLeakedInternalError,
  deliverBubbles,
  startTypingKeepalive,
  normalizeTelegramUpdate,
} from '../lib/channels/index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2714 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2716 ${name}\n    ${err?.stack || err}`);
    failed++;
  }
}

console.log('SCROLL 2.11 -- Unified Channels, Multilingual Voice Runtime & 4-Tier Tool Catalog');

await test('1. Voice runtime resolves vi_natural vs basic vs strict_pro & enforces humanError safety lock', () => {
  const viAuto = resolveVoiceProfile({ language: 'vi', weights: { preset: 'ca-tinh', traits: { warmth: 5, reserve: 1 } } });
  assert.equal(viAuto.effectiveMode, 'vi_natural');
  assert.equal(viAuto.distilledLanguage, 'vi');
  assert.equal(viAuto.displayTraits.openness, 5);
  assert.equal(viAuto.humanError, false);

  const enAuto = resolveVoiceProfile({ language: 'en' });
  assert.equal(enAuto.effectiveMode, 'basic');
  assert.equal(enAuto.distilledLanguage, null);

  const lockedStrict = resolveVoiceProfile({
    language: 'vi',
    packVoice: { defaultMode: 'strict_pro', allowHumanError: false },
    weights: { humanError: true, voiceMode: 'vi_natural' },
  });
  assert.equal(lockedStrict.allowHumanError, false);
  assert.equal(lockedStrict.humanError, false, 'allowHumanError=false must hard-lock humanError OFF');

  const cue = compilePersonalityCues(viAuto, { userText: 'Cho minh hoi lich hom nay' });
  assert.ok(cue.text.includes('[Voice Mode: Vietnamese Natural]'));
  assert.equal(hasBareNumericSlider(cue.text), false, 'Region-C voice cue must never emit bare numeric sliders');
});

await test('2. Voice post-shapers: glitch sanitizer, smart multi-bubble & Claim-Safe Human Texture', () => {
  const deglitched = sanitizeControlGlitches('Chao ban \u4e2d\u6587 nhe!', { userText: 'Chao ban', language: 'vi' });
  assert.ok(!deglitched.includes('\u4e2d\u6587'));

  const longMulti = 'First complete point with concrete details about the project schedule and milestones for next week.\n\nSecond distinct point covering the action items and owners so everyone stays aligned cleanly.';
  const bubbles = splitSmartBubbles(longMulti, { smartBubbles: true, maxBubbles: 3, minSplitChars: 120 });
  assert.equal(bubbles.length, 2);

  const shortReply = 'Done, saved it for you.';
  assert.equal(splitSmartBubbles(shortReply, { smartBubbles: true }).length, 1);

  const taxText = 'So tien thue GTGT phai nop la 12,500,000 VND truoc 20/12/2026.';
  const tex = applyClaimSafeHumanTexture(taxText, {
    enabled: true,
    allowHumanError: true,
    effectiveMode: 'vi_natural',
    isHighStakes: true,
  });
  assert.equal(tex.text, taxText, 'High-stakes reply must stay 100% verbatim');
});

await test('3. Unified Channel Engine: group silence, edited_message once-guard, 2-tier Passive Observer & Zero-Leak Shield', async () => {
  let clockMs = 1_700_000_000_000;
  const observed = [];
  const ownerAlerts = [];
  const engine = createChannelEngine({
    now: () => clockMs,
    onObserveMemory: (obs) => observed.push(obs),
    onOwnerAlert: (a) => ownerAlerts.push(a),
  });

  const policy = { groupPolicy: 'mention', mentionPatterns: ['\\bhelper\\b'] };

  // Silent group message -> observed passively (ring + memory hook)
  const r1 = engine.evaluateIncoming({
    botKey: 'tn1:bot1',
    chatId: '-1001',
    chatTitle: 'Ops Room',
    messageId: 10,
    senderId: 'u1',
    senderName: 'Alice',
    text: 'We moved the launch to Friday 10:00.',
    isGroup: true,
    policy,
  });
  assert.equal(r1.shouldReply, false);
  assert.equal(r1.observed, true);
  assert.equal(observed.length, 1);

  // Fresh edit adds @mention -> triggers ONCE and carries <recent-group-context>
  const r2 = engine.evaluateIncoming({
    botKey: 'tn1:bot1',
    chatId: '-1001',
    chatTitle: 'Ops Room',
    messageId: 11,
    messageDateMs: clockMs - 5_000,
    senderId: 'u2',
    senderName: 'Bob',
    text: '@helper_bot thoughts on the launch?',
    botUsername: 'helper_bot',
    isGroup: true,
    isEdit: true,
    isMentioned: true,
    policy,
  });
  assert.equal(r2.shouldReply, true);
  assert.ok(r2.groupContextCapsule.includes('Friday 10:00'));

  // Mark replied -> second edit on same messageId MUST be ignored!
  engine.markMessageReplied('tn1:bot1', '-1001', 11);
  const r3 = engine.evaluateIncoming({
    botKey: 'tn1:bot1',
    chatId: '-1001',
    messageId: 11,
    messageDateMs: clockMs - 5_000,
    senderId: 'u2',
    text: '@helper_bot edited again',
    botUsername: 'helper_bot',
    isGroup: true,
    isEdit: true,
    isMentioned: true,
    policy,
  });
  assert.equal(r3.shouldReply, false);
  assert.equal(r3.reason, 'edit_already_replied');

  // Zero-Leak Group Error Shield blocks stack trace in group & alerts owner DM
  assert.equal(hasLeakedInternalError('TypeError: cannot read x at fn (a.js:1:2)'), true);
  const shielded = engine.guardGroupError({
    error: new Error('ERR_INTERNAL_CRASH: secret stack'),
    isGroup: true,
    language: 'en',
    botName: 'Helper',
  });
  assert.equal(shielded.shielded, true);
  assert.ok(!shielded.text.includes('ERR_INTERNAL_CRASH'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ownerAlerts.length, 1);

  // Typing keepalive disabled -> 0 calls (0% phantom typing)
  let typed = 0;
  const stopOff = startTypingKeepalive(() => { typed++; }, { enabled: false });
  stopOff();
  assert.equal(typed, 0);

  // Smart multi-bubble delivery
  const delivered = [];
  await deliverBubbles({
    bubbles: ['First bubble', 'Second bubble'],
    minDelayMs: 0,
    sendChunk: async (chunk) => { delivered.push(chunk); },
  });
  assert.deepEqual(delivered, ['First bubble', 'Second bubble']);

  // Telegram update normalizer handles edited_message + forum threadId
  const norm = normalizeTelegramUpdate({
    update_id: 99,
    edited_message: {
      message_id: 42,
      date: 1700000000,
      message_thread_id: 777,
      chat: { id: -10055, type: 'supergroup', title: 'Forum' },
      from: { id: 500, first_name: 'Sam' },
      text: 'Hey @helper_bot check this',
    },
  }, { botUsername: 'helper_bot' });
  assert.equal(norm.isEdit, true);
  assert.equal(norm.threadId, 777);
  assert.equal(norm.isExplicitMention, true);
});

await test('4. 4-tier Tool Catalog v2 + Cloud precedence shadowing + Parity Gate v2 + live ScrollAgentHost voice reload', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v211-'));
  try {
    const srcDir = path.join(tmp, 'src');
    const agentDir = path.join(srcDir, 'agents', 'alpha');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), '---\nname: alpha\ntitle: "Alpha"\nversion: 1.0.0\nlanguage: vi\n---\n# Alpha\n');
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), '# Soul\nHelpful.\n');

    const keys = generatePackSigningKeyPair();
    const packsDir = path.join(tmp, 'packs');
    const built = buildAgentPack({
      sourceDir: srcDir,
      agentName: 'alpha',
      packId: 'alpha',
      version: '1.0.0',
      outDir: path.join(packsDir, 'alpha', '1.0.0'),
      privateKeyPem: keys.privateKeyPem,
      uiMeta: { displayName: 'Alpha', avatarKey: 'alpha', roles: { vi: 'Tro ly', en: 'Assistant' } },
      defaultWeights: { preset: 'nhe-nhang', traits: { assertiveness: 2, reserve: 2, wit: 2, warmth: 4 }, initiative: 1, adaptiveLevel: 2 },
      defaultCapabilities: { model: 'auto', reasoningEffort: 'medium', webSearch: true, imageGeneration: false, vision: true },
      voice: { defaultMode: 'auto', allowHumanError: true, defaultHumanError: false },
      toolGroups: [
        { id: 'alpha-tools', name: 'Alpha Domain', prefixes: ['alpha_'] },
        { id: 'alpha-ext', name: 'Alpha Companion Ext', tier: 'external', prefixes: ['legacy_ext_'] },
      ],
      uiPanels: ['alpha-workbench'],
    });
    const verified = verifyAgentPack({ packDir: built.packDir, publicKeyPem: keys.publicKeyPem, requireSignature: true });
    assert.equal(verified.ok, true, verified.errors.join(', '));
    assert.deepEqual(verified.manifest.uiPanels, ['alpha-workbench']);

    const registry = createPackRegistry({ packsRootDir: packsDir, publicKeyPem: keys.publicKeyPem });
    const ws = openTenantWorkspace({
      tenantsRootDir: path.join(tmp, 'tenants'),
      tenantId: 'tn_v211',
      deploymentId: 'dep_v211',
      packRegistry: registry,
      initialPack: { packId: 'alpha', version: '1.0.0' },
    });

    const capturedPrompts = [];
    const host = await createScrollAgentHost({
      placement: 'cloud',
      workspace: ws,
      packRegistry: registry,
      principalProvider: createPrincipalProvider({ ownerPrincipalId: 'owner_tn_v211' }),
      provider: {
        name: 'mock',
        model: 'mock-1',
        ready: true,
        supportsTools: true,
        async generate(prompt, opts) {
          capturedPrompts.push(String(prompt || '') + '\n' + JSON.stringify(opts?.messages || []));
          return { text: 'Ok, done cleanly.', toolCalls: [], usage: {} };
        },
      },
    });

    // Save new weights override + reloadVoice -> next turn receives updated behavioral cues!
    ws.writeWeightsOverride({
      preset: 'thang-than-cong-viec',
      traits: { assertiveness: 5, reserve: 5, wit: 1, warmth: 2 },
      initiative: 0,
      adaptiveLevel: 1,
      voiceMode: 'strict_pro',
    });
    const reloaded = host.reloadVoice();
    assert.equal(reloaded.effectiveMode, 'strict_pro');
    await host.handleTurn({ surface: 'web', senderId: 'tn_v211', text: 'Check quarterly tax deadline' });
    assert.ok(capturedPrompts[0].includes('[Voice Mode: High-Precision Professional]'), 'Live weights override must reach turn prompt');

    // Tool policy persists per deployment
    host.setToolPolicy({ disabledGroups: ['ledger-books'] });
    assert.deepEqual(host.getToolPolicy().disabledGroups, ['ledger-books']);

    // Cloud precedence shadows duplicate Companion tool + runtimeToolsActual catches phantom tools
    const hostGroups = [
      { id: 'doc-studio', name: 'Document Studio', tier: 'host', priority: 5, defaultVisible: true, prefixes: ['doc_'] },
      { id: 'channel-delivery', name: 'Channel Delivery', tier: 'host', priority: 6, defaultVisible: true, tools: ['send_telegram_message', 'send_chat_media'] },
    ];
    const snapOk = host.describe({
      packsDir,
      hostGroupDefinitions: hostGroups,
      runtimeToolDescriptors: [
        { name: 'memory_search', group: 'scroll-core', tier: 'core' },
        { name: 'doc_create', group: 'doc-studio', tier: 'host' },
        { name: 'send_telegram_message', group: 'channel-delivery', tier: 'host' },
        { name: 'alpha_lookup', group: 'alpha-tools', tier: 'pack' },
      ],
      runtimeToolsActual: ['memory_search', 'doc_create', 'send_telegram_message', 'alpha_lookup'],
      companion: {
        enabled: true,
        deviceId: 'mac-1',
        online: true,
        tools: [
          { name: 'send_telegram_message', group: 'tg-legacy', groupName: 'Legacy TG' },
          { name: 'ledger_read', group: 'ledger-books', groupName: 'Ledger Books' },
          { name: 'legacy_ext_ping' },
          { name: 'legacy_ext_ping' },
        ],
      },
      modelCapabilities: {
        webSearch: true,
        imageGeneration: true,
        vision: true,
        activeRunner: 'anthropic-api',
        supportedCapabilities: ['vision'],
      },
    });

    assert.equal(snapOk.mcpInventory.shadowedTools.length, 1, 'Duplicate Companion send_telegram_message must be shadowed by Cloud');
    assert.equal(snapOk.mcpInventory.pack[0].groupId, 'alpha-tools');
    assert.equal(snapOk.mcpInventory.integrations.find((g) => g.groupId === 'ledger-books').status, 'disabled');
    const extGrp = snapOk.mcpInventory.integrations.find((g) => g.groupId === 'alpha-ext');
    assert.ok(extGrp && extGrp.tier === 'external' && extGrp.toolsCount === 1, 'Pack external toolGroups must classify & deduplicate legacy Companion tools');
    const pOk = verifyIntrospectionParity(snapOk);
    assert.equal(pOk.ok, true, JSON.stringify(pOk.failures));
    assert.ok(pOk.warnings.some((w) => w.id === 'capabilities.runner_match'), 'Must warn when imageGeneration/webSearch enabled on unsupported runner');

    // Phantom tool missing from catalog MUST fail parity gate!
    const snapMissing = host.describe({
      packsDir,
      hostGroupDefinitions: hostGroups,
      runtimeToolDescriptors: [{ name: 'memory_search', group: 'scroll-core', tier: 'core' }],
      runtimeToolsActual: ['memory_search', 'doc_create'],
    });
    const pBad = verifyIntrospectionParity(snapMissing);
    assert.equal(pBad.ok, false);
    assert.ok(pBad.failures.some((f) => f.id === 'tools.runtime_parity' && f.detail.includes('doc_create')));

    await host.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.error(`\n\u2716 ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n\u2714 all green: ${passed} passed, 0 failed`);
