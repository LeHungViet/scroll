#!/usr/bin/env node
// SCROLL 2.15 -- Multi-Companion Remote Tool Router, Declarative Group-Safe Scope,
// and Generic Runtime Companion Capability Prompt (`lib/remote-tool-transport.js`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeCompanionBinding,
  isRemoteToolAllowedInContext,
  buildCompanionCapabilitiesPrompt,
  createMultiRemoteToolClient,
  createToolRegistry,
  describeToolCatalog,
} from '../index.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log('SCROLL v2.15 multi-companion routing & group-safe policy tests:');

await test('normalizeCompanionBinding upgrades legacy single deviceId & deduplicates multi deviceIds', () => {
  const legacy = normalizeCompanionBinding({ enabled: true, deviceId: 'dev-a', updatedAt: '2026-11-27T00:00:00Z' });
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.deviceId, 'dev-a');
  assert.deepEqual(legacy.deviceIds, ['dev-a']);

  const multi = normalizeCompanionBinding({
    enabled: true,
    deviceId: 'dev-b',
    deviceIds: ['dev-a', 'dev-b', 'dev-a', '  '],
  });
  assert.equal(multi.enabled, true);
  assert.equal(multi.deviceId, 'dev-a');
  assert.deepEqual(multi.deviceIds, ['dev-a', 'dev-b']);

  const empty = normalizeCompanionBinding({ enabled: true, deviceIds: [] });
  assert.equal(empty.enabled, false);
  assert.equal(empty.deviceId, null);
  assert.deepEqual(empty.deviceIds, []);
});

await test('isRemoteToolAllowedInContext enforces fail-closed non-owner, DM owner, and declarative group-safe scope', () => {
  const safeRead = { name: 'vm_status', risk: 'read_only', ownerGroupSafe: true };
  const safeBrowse = { name: 'vm_browser', risk: 'reversible_write', groupScope: 'owner_in_group' };
  const dmOnly = { name: 'vm_shell', risk: 'reversible_write', ownerGroupSafe: false };
  const defaultScope = { name: 'ledger_read', risk: 'read_only' };
  const forgedHighRiskFinancial = { name: 'vm_submit', risk: 'financial', ownerGroupSafe: true };
  const forgedHighRiskExternal = { name: 'mail_send', risk: 'external_comm', groupScope: 'owner_in_group' };
  const forgedHighRiskDestructive = { name: 'disk_wipe', risk: 'destructive', ownerGroupSafe: true };

  // Non-owner is ALWAYS denied (DM or group)
  for (const spec of [safeRead, safeBrowse, dmOnly, defaultScope]) {
    assert.equal(isRemoteToolAllowedInContext(spec, { isGroup: false, isOwner: false }), false);
    assert.equal(isRemoteToolAllowedInContext(spec, { isGroup: true, isOwner: false }), false);
  }

  // Owner DM allows all allowlisted specs (local Companion Host enforces HITL on high-risk)
  for (const spec of [safeRead, safeBrowse, dmOnly, defaultScope, forgedHighRiskFinancial]) {
    assert.equal(isRemoteToolAllowedInContext(spec, { isGroup: false, isOwner: true }), true);
  }

  // Owner in Group: ONLY explicitly ownerGroupSafe/owner_in_group AND non-high-risk
  assert.equal(isRemoteToolAllowedInContext(safeRead, { isGroup: true, isOwner: true }), true);
  assert.equal(isRemoteToolAllowedInContext(safeBrowse, { isGroup: true, isOwner: true }), true);
  assert.equal(isRemoteToolAllowedInContext(dmOnly, { isGroup: true, isOwner: true }), false);
  assert.equal(isRemoteToolAllowedInContext(defaultScope, { isGroup: true, isOwner: true }), false);

  // Machine-enforced high-risk block in group even if spec tries to mark ownerGroupSafe=true
  assert.equal(isRemoteToolAllowedInContext(forgedHighRiskFinancial, { isGroup: true, isOwner: true }), false);
  assert.equal(isRemoteToolAllowedInContext(forgedHighRiskExternal, { isGroup: true, isOwner: true }), false);
  assert.equal(isRemoteToolAllowedInContext(forgedHighRiskDestructive, { isGroup: true, isOwner: true }), false);
});

await test('createMultiRemoteToolClient routes tools across N companions deterministically with online precedence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v215-'));
  const ledgerPath = path.join(tmpDir, 'remote-calls.jsonl');
  const calls = [];

  const router = createMultiRemoteToolClient({
    deploymentId: 'dep_test_1',
    ledgerPath,
    devices: [
      {
        deviceId: 'host-workstation',
        platform: 'darwin',
        online: true,
        toolSpecs: [
          { name: 'vm_status', risk: 'read_only', group: 'vm-tools', ownerGroupSafe: true },
          { name: 'vm_browser', risk: 'reversible_write', group: 'vm-tools', ownerGroupSafe: true },
          { name: 'shared_probe', risk: 'read_only' },
        ],
        sendRequest: async (env) => {
          calls.push({ dev: 'host-workstation', tool: env.tool, args: env.args });
          return { ok: true, epoch: env.epoch, output: { from: 'host-workstation', tool: env.tool } };
        },
      },
      {
        deviceId: 'host-always-on',
        platform: 'darwin',
        online: true,
        toolSpecs: [
          { name: 'ledger_summary', risk: 'read_only', group: 'ledger-tools' },
          { name: 'shared_probe', risk: 'read_only' },
        ],
        sendRequest: async (env) => {
          calls.push({ dev: 'host-always-on', tool: env.tool, args: env.args });
          return { ok: true, epoch: env.epoch, output: { from: 'host-always-on', tool: env.tool } };
        },
      },
      {
        deviceId: 'host-sleeping',
        platform: 'win32',
        online: false,
        toolSpecs: [
          { name: 'sleeping_only_tool', risk: 'read_only' },
        ],
        sendRequest: async () => ({ ok: true, epoch: 1, output: {} }),
      },
    ],
  });

  assert.equal(router.deviceId, 'host-workstation');
  assert.deepEqual(router.deviceIds, ['host-workstation', 'host-always-on', 'host-sleeping']);
  assert.deepEqual(router.onlineDeviceIds, ['host-workstation', 'host-always-on']);

  // Distinct tools route straight to owning devices
  const r1 = await router.invoke('vm_browser', { method: 'status' });
  assert.equal(r1.ok, true);
  assert.equal(r1.deviceId, 'host-workstation');
  assert.equal(r1.output.from, 'host-workstation');

  const r2 = await router.invoke('ledger_summary', { period: '2026-11' });
  assert.equal(r2.ok, true);
  assert.equal(r2.deviceId, 'host-always-on');
  assert.equal(r2.output.from, 'host-always-on');

  // Overlapping tool picks first-listed online device deterministically
  const r3 = await router.invoke('shared_probe', {});
  assert.equal(r3.ok, true);
  assert.equal(r3.deviceId, 'host-workstation');

  // Explicit deviceId override routes internal helper (e.g. companion_read_media) to exact device
  const r4 = await router.invoke('companion_read_media', { path: '/tmp/shot.png' }, { deviceId: 'host-always-on' });
  assert.equal(r4.ok, true);
  assert.equal(r4.deviceId, 'host-always-on');
  assert.equal(r4.output.from, 'host-always-on');

  // Offline device tool returns ERR_COMPANION_OFFLINE cleanly
  const r5 = await router.invoke('sleeping_only_tool', {});
  assert.equal(r5.ok, false);
  assert.match(r5.error, /^ERR_COMPANION_OFFLINE:host-sleeping/);

  // Unknown tool returns ERR_REMOTE_TOOL_UNROUTED
  const r6 = await router.invoke('nonexistent_tool', {});
  assert.equal(r6.ok, false);
  assert.match(r6.error, /^ERR_REMOTE_TOOL_UNROUTED:nonexistent_tool/);

  // registerOn wires merged online tools onto a ToolRegistry
  const reg = createToolRegistry();
  const registered = router.registerOn(reg);
  assert.ok(registered.includes('vm_browser'));
  assert.ok(registered.includes('ledger_summary'));
  assert.ok(!registered.includes('sleeping_only_tool'));

  // describeToolCatalog preserves per-tool deviceId and groupScope
  const cat = describeToolCatalog({
    companionTools: router.listToolSpecs(),
    companionEnabled: true,
    companionOnline: true,
    deviceId: router.deviceId,
  });
  const vmBucket = cat.companion.find((b) => b.groupId === 'vm-tools');
  const ledgerBucket = cat.companion.find((b) => b.groupId === 'ledger-tools');
  assert.equal(vmBucket?.deviceId, 'host-workstation');
  assert.equal(vmBucket?.scope, 'owner_in_group');
  assert.equal(ledgerBucket?.deviceId, 'host-always-on');
  assert.equal(ledgerBucket?.scope, 'owner_dm');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

await test('buildCompanionCapabilitiesPrompt injects generic live capabilities per turn scope', () => {
  const devices = [
    { deviceId: 'dev-workstation', platform: 'darwin', online: true },
    { deviceId: 'dev-server', platform: 'linux', online: false },
  ];
  const tools = [
    { name: 'vm_status', group: 'vm-box', groupName: 'Windows Sandbox', groupSummary: 'Isolated desktop VM', risk: 'read_only', ownerGroupSafe: true, deviceId: 'dev-workstation' },
    { name: 'vm_shell', group: 'vm-box', groupName: 'Windows Sandbox', risk: 'reversible_write', ownerGroupSafe: false, deviceId: 'dev-workstation' },
    { name: 'vm_submit', group: 'vm-box', groupName: 'Windows Sandbox', risk: 'financial', ownerGroupSafe: true, deviceId: 'dev-workstation' },
    { name: 'companion_read_media', group: 'internal', risk: 'read_only', ownerGroupSafe: true, deviceId: 'dev-workstation' },
  ];

  // Non-owner sees nothing
  assert.equal(buildCompanionCapabilitiesPrompt({ devices, tools, turnCtx: { isGroup: true, isOwner: false } }), '');
  assert.equal(buildCompanionCapabilitiesPrompt({ devices, tools, turnCtx: { isGroup: false, isOwner: false } }), '');

  // Owner in Group sees ONLY ownerGroupSafe non-high-risk tools + offline device notice
  const groupPrompt = buildCompanionCapabilitiesPrompt({ devices, tools, turnCtx: { isGroup: true, isOwner: true } });
  assert.match(groupPrompt, /Owner-Authorized Group Scope/);
  assert.match(groupPrompt, /vm_status/);
  assert.doesNotMatch(groupPrompt, /vm_shell/);
  assert.doesNotMatch(groupPrompt, /vm_submit/);
  assert.doesNotMatch(groupPrompt, /companion_read_media/);
  assert.match(groupPrompt, /dev-server.*OFFLINE/);

  // Owner DM sees both vm_status and vm_shell (and vm_submit)
  const dmPrompt = buildCompanionCapabilitiesPrompt({ devices, tools, turnCtx: { isGroup: false, isOwner: true } });
  assert.match(dmPrompt, /Owner Direct Scope/);
  assert.match(dmPrompt, /vm_status/);
  assert.match(dmPrompt, /vm_shell/);
});

console.log(`ALL ${passed} SCROLL v2.15 multi-companion tests passed.`);
