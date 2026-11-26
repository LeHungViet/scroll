// SCROLL 2.9 -- Canonical Introspection (`host.describe()`), Declarative Tool Catalog,
// Single-Source Personality Schema, Live Event Stream (`state.changed` / `turn.routed`),
// & Automated Parity Gate (`verifyIntrospectionParity`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PERSONALITY_SCHEMA,
  PERSONALITY_PRESETS,
  describePersonality,
  describeChannelPolicy,
  describeToolCatalog,
  resolveEffectiveModel,
  verifyIntrospectionParity,
  generatePackSigningKeyPair,
  buildAgentPack,
  createPackRegistry,
  openTenantWorkspace,
  createPrincipalProvider,
  createScrollAgentHost,
} from '../index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✖ ${name}\n    ${err?.stack || err}`);
    failed++;
  }
}

console.log('SCROLL 2.9 -- Canonical Introspection, Declarative Tool Catalog & Parity Gate');

await test('1. Personality single-source schema projects reserve <-> openness cleanly', () => {
  const open = describePersonality({
    preset: 'ca-tinh',
    traits: { assertiveness: 4, reserve: 1, wit: 4, warmth: 5 },
    initiative: 3,
    adaptiveLevel: 3,
  });
  assert.equal(open.schema, 'scroll-personality/v1');
  assert.equal(open.traits.reserve, 1);
  assert.equal(open.displayTraits.openness, 5);
  assert.equal(PERSONALITY_SCHEMA.traits.find((t) => t.key === 'reserve').polarity, 'inverted');
  assert.equal(PERSONALITY_PRESETS['ca-tinh'].traits.reserve, 2);

  const reserved = describePersonality({ traits: { reserve: 5 } });
  assert.equal(reserved.displayTraits.openness, 1);
});

await test('2. Channel policy describer extracts human trigger labels with provenance', () => {
  const ch = describeChannelPolicy({
    groupPolicy: 'mention',
    mentionPatterns: ['\\bjen\\b', '\\bjennie\\b'],
    softAliasLabels: ['J', 'Zen', 'Jenny'],
    debounceQuietMs: 3500,
  }, { botUsername: '@Jen_003_bot' });
  assert.equal(ch.groupPolicy, 'mention');
  assert.equal(ch.source, 'pack');
  assert.deepEqual(ch.mentionLabels, ['Jen', 'Jennie', 'J', 'Zen', 'Jenny']);
  assert.equal(ch.botUsername, 'Jen_003_bot');
  assert.equal(ch.respondsOnReply, true);
  assert.equal(ch.passiveObserver, true);

  const overridden = describeChannelPolicy({ groupPolicy: 'mention' }, { groupPolicyOverride: 'all' });
  assert.equal(overridden.groupPolicy, 'all');
  assert.equal(overridden.source, 'override');
});

await test('3. Declarative 4-tier tool catalog separates host defaults from external integrations (0 overlap)', () => {
  const hostGroups = [
    { id: 'doc-studio', name: 'Document Studio', techName: 'Document Studio', tier: 'host', priority: 5, kind: 'runtime', defaultVisible: true, prefixes: ['doc_'] },
    { id: 'desktop-gui', name: 'Desktop Control', techName: 'Desktop GUI', tier: 'host', priority: 10, kind: 'mcp', requiresCompanion: true, defaultVisible: true, prefixes: ['river_cua_'] },
    { id: 'web-browser', name: 'Real Browser', techName: 'Browser', tier: 'host', priority: 20, kind: 'bridge', requiresCompanion: true, defaultVisible: true, prefixes: ['dragon_'] },
  ];
  const catalog = describeToolCatalog({
    hostGroupDefinitions: hostGroups,
    runtimeToolDescriptors: [
      { name: 'memory_search', group: 'scroll-core', tier: 'core' },
      { name: 'doc_create', group: 'doc-studio', tier: 'host' },
    ],
    companionEnabled: true,
    companionOnline: true,
    deviceId: 'mac-demo',
    companionTools: [
      { name: 'ledger_summary', risk: 'read_only', group: 'ledger-books', groupName: 'Ledger Books', groupSummary: 'Read accounting books' },
      { name: 'river_cua_observe', risk: 'read_only', group: 'desktop-gui', tier: 'host' },
      { name: 'dragon_browser', risk: 'reversible_write' },
      { name: 'calendar_create_event', risk: 'reversible_write' },
      { name: 'custom_erp_sync', risk: 'reversible_write', group: 'erp-sync', groupName: 'ERP Sync', groupSummary: 'Sync orders to ERP' },
    ],
  });

  const defIds = catalog.hostDefaults.map((d) => d.groupId);
  assert.deepEqual(defIds, ['scroll-core', 'doc-studio', 'desktop-gui', 'web-browser']);
  assert.equal(catalog.hostDefaults.find((d) => d.groupId === 'doc-studio').status, 'online');
  assert.equal(catalog.hostDefaults.find((d) => d.groupId === 'desktop-gui').status, 'online');
  assert.equal(catalog.integrations[0].groupId, 'google-workspace', 'Google Workspace must rank first in external integrations');
  assert.ok(catalog.integrations.some((i) => i.groupId === 'erp-sync' && i.name === 'ERP Sync'), 'Declarative custom group must work without host code');
  assert.equal(catalog.unclassifiedTools.length, 0);
});

await test('4. Effective model resolver tracks inheritance provenance (Pack -> Override -> Default)', () => {
  const m1 = resolveEffectiveModel({
    identityModel: { primary: 'gpt-6.1-terra', fallback: 'gpt-6.2-astra' },
    overrides: { reasoningEffort: 'ultra', modelEscalation: 'auto' },
  });
  assert.equal(m1.primary, 'gpt-6.1-terra');
  assert.equal(m1.primarySource, 'pack');
  assert.equal(m1.fallback, 'gpt-6.2-astra');
  assert.equal(m1.fallbackSource, 'pack');
  assert.equal(m1.escalation, 'auto');

  const m2 = resolveEffectiveModel({
    identityModel: { primary: 'gpt-6.1-terra', fallback: 'gpt-6.2-astra' },
    overrides: { fallbackModel: 'none' },
  });
  assert.equal(m2.fallback, null);
  assert.equal(m2.fallbackSource, 'override');
  assert.equal(m2.escalation, 'off');
});

await test('5. ScrollAgentHost E2E: host.describe(), live event bus, lastTurnRouting persistence & parity gate', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v290-'));
  try {
    const srcDir = path.join(tmp, 'src-agent');
    const agentDir = path.join(srcDir, 'agents', 'demo');
    fs.mkdirSync(path.join(agentDir, 'skills', 'demo-skill'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), [
      '---',
      'name: demo',
      'title: "Demo Assistant"',
      'version: 1.0.0',
      'model:',
      '  primary: gpt-6.1-terra',
      '  fallback: gpt-6.2-astra',
      'capabilities: [memory.read, memory.write]',
      '---',
      '# Demo Agent',
    ].join('\n'));
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), '# Soul\nHelpful and concise.\n');
    fs.writeFileSync(path.join(agentDir, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo helper\n---\n# Demo\n');

    const keys = generatePackSigningKeyPair();
    const packsDir = path.join(tmp, 'packs');
    buildAgentPack({
      sourceDir: srcDir,
      agentName: 'demo',
      packId: 'demo',
      version: '1.0.0',
      outDir: path.join(packsDir, 'demo', '1.0.0'),
      privateKeyPem: keys.privateKeyPem,
      channelPolicy: {
        groupPolicy: 'mention',
        mentionPatterns: ['\\bdemo\\b'],
        softAliasLabels: ['DM'],
      },
    });

    const registry = createPackRegistry({ packsRootDir: packsDir, publicKeyPem: keys.publicKeyPem });
    const ws = openTenantWorkspace({
      tenantsRootDir: path.join(tmp, 'tenants'),
      tenantId: 'tn_test',
      deploymentId: 'dep_test',
      packRegistry: registry,
      initialPack: { packId: 'demo', version: '1.0.0' },
    });

    const principal = createPrincipalProvider({
      stateFile: path.join(ws.getPaths().runtimeDir, 'principals.json'),
      ownerPrincipalId: 'owner_tn_test',
    });

    const host = await createScrollAgentHost({
      placement: 'cloud',
      workspace: ws,
      packRegistry: registry,
      principalProvider: principal,
      provider: {
        name: 'mock',
        model: 'gpt-6.1-terra',
        supportsTools: true,
        async generate() { return { text: 'ok', toolCalls: [], usage: {} }; },
      },
    });

    const seenEvents = [];
    const unsub1 = host.on('turn.routed', (e) => seenEvents.push({ type: 'turn.routed', ...e }));
    const unsub2 = host.on('state.changed', (e) => seenEvents.push({ type: 'state.changed', ...e }));

    host.recordTurnRouting({
      surface: 'web',
      selectedModel: 'gpt-6.2-astra',
      primaryModel: 'gpt-6.1-terra',
      fallbackModel: 'gpt-6.2-astra',
      escalated: true,
      effectiveEffort: 'ultra',
      toolsUsed: ['calendar_create_event'],
      durationMs: 910,
    });
    host.notifyStateChanged('config_updated');

    assert.equal(seenEvents.length, 2);
    assert.equal(seenEvents[0].type, 'turn.routed');
    assert.equal(seenEvents[0].escalated, true);
    assert.equal(seenEvents[1].type, 'state.changed');
    unsub1();
    unsub2();

    const snap = host.describe({
      packsDir,
      overrides: { model: 'gpt-6.1-terra', reasoningEffort: 'ultra', fallbackModel: 'gpt-6.2-astra', modelEscalation: 'auto' },
      weights: { preset: 'ca-tinh', traits: { assertiveness: 4, reserve: 1, wit: 4, warmth: 5 }, initiative: 3, adaptiveLevel: 3 },
      botUsername: 'demo_bot',
      companion: {
        enabled: true,
        deviceId: 'mac-demo',
        online: true,
        tools: [
          { name: 'desktop_observe', risk: 'read_only', group: 'desktop-gui', groupName: 'Desktop GUI', groupSummary: 'Inspect desktop UI' },
          { name: 'calendar_create_event', risk: 'reversible_write' },
        ],
      },
    });

    const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal(snap.schema, 'scroll-introspection/v2');
    assert.equal(snap.scrollVersion, pkgVersion);
    assert.ok(snap.skillsReport.visible.some((s) => s.name === 'demo-skill' && /Demo helper/.test(s.description)), 'skillsRegistry report must surface demo-skill with description');
    assert.equal(snap.effectiveModel.fallback, 'gpt-6.2-astra');
    assert.equal(snap.effectiveModel.escalation, 'auto');
    assert.equal(snap.lastTurnRouting.selectedModel, 'gpt-6.2-astra');
    assert.deepEqual(snap.lastTurnRouting.toolsUsed, ['calendar_create_event']);
    assert.deepEqual(snap.channels.mentionLabels, ['Demo', 'DM']);
    assert.equal(snap.personality.displayTraits.openness, 5);

    const parityOk = verifyIntrospectionParity(snap);
    assert.equal(parityOk.ok, true, JSON.stringify(parityOk.failures));

    // Parity gate MUST fail closed if an unclassified mystery tool enters Companion!
    const snapBad = host.describe({
      packsDir,
      companion: {
        enabled: true,
        deviceId: 'mac-demo',
        online: true,
        tools: [{ name: 'unregistered_mystery_fn', risk: 'read_only' }],
      },
    });
    const parityBad = verifyIntrospectionParity(snapBad);
    assert.equal(parityBad.ok, false, 'Parity gate must fail on unclassified tool');
    assert.ok(parityBad.failures.some((f) => f.id === 'tools.classified'));

    await host.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.error(`\n✖ ${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n✔ all green: ${passed} passed, 0 failed`);
