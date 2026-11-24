// SCROLL 2.8 -- §52-§56 Managed Agent Host, Immutable Packs, Tenant Workspace,
// Cross-Surface Principal Provider, & Opt-In Companion Remote Tool Transport Smoke Suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  scaffold,
  pickProvider,
  generatePackSigningKeyPair,
  buildAgentPack,
  verifyAgentPack,
  createPackRegistry,
  openTenantWorkspace,
  createPrincipalProvider,
  createDesktopMutex,
  createRemoteToolClient,
  createCompanionToolHost,
  verifyCompanionAudit,
  createScrollAgentHost,
  redactTelemetryText,
} from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✖ ${name} -- ${err?.stack || err}`);
    fail++;
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v28-host-'));
console.log('SCROLL 2.8 -- §52-§56 Immutable Packs, Workspace Isolation, Principal Provider, Companion Transport, & ScrollAgentHost');

function createFixtureAgentRepo(dir, agentName, { versionNote = 'v1', extraSoul = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  scaffold(agentName, dir);
  const agentDir = path.join(dir, 'agents', agentName);
  fs.writeFileSync(path.join(agentDir, 'SOUL.md'), `# Soul (${versionNote})\nBe concise and accurate.\n${extraSoul}\n`);
  fs.writeFileSync(path.join(agentDir, 'hard-rules.md'), `# Hard Rules\n- Never fabricate numbers.\n`);
  // Private/runtime artifacts that MUST NEVER enter an Agent Pack:
  fs.writeFileSync(path.join(dir, 'USER.md'), '# Principal\nPrivate owner preferences.\n');
  fs.writeFileSync(path.join(agentDir, 'USER.md'), '# Nested private USER\n');
  fs.mkdirSync(path.join(agentDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory', 'lessons.md'), '# Private lessons\nSecret note.\n');
  fs.mkdirSync(path.join(dir, 'books'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'books', 'ledger.beancount'), '2026-01-01 * "Private Ledger"\n');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-proj-1234567890abcdefghijklmnop\n');
  // Clean shared knowledge + private personal folder to exclude:
  fs.mkdirSync(path.join(dir, 'knowledge', 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge', 'public', 'tariffs.md'), '# Tariff Schedule\nStandard plan SKU-P100 costs 1,500,000 VND per month.\n');
  fs.mkdirSync(path.join(dir, 'knowledge', 'private-notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'knowledge', 'private-notes', 'diary.md'), 'Personal confidential diary entry.\n');
  return dir;
}

function createFixtureDomainPack(dir) {
  const compiled = path.join(dir, 'compiled');
  fs.mkdirSync(path.join(compiled, 'readable'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 'scroll-domain-pack/v1',
    id: 'tax-rules',
    version: '1.0.0',
  }, null, 2));
  fs.writeFileSync(path.join(compiled, 'pack.bitemporal.jsonl'), JSON.stringify({
    id: 'tax-vat-01',
    clausePath: 'VAT/ART-8',
    title: 'Standard VAT Rate',
    artifactType: 'statute',
    validFrom: '2025-01-01',
    body: 'Standard value added tax rate code VAT-STD is 10 percent unless reduced under special resolution.',
  }) + '\n');
  fs.writeFileSync(path.join(compiled, 'synonyms.json'), JSON.stringify([
    { pattern: 'gtgt', terms: 'VAT value added tax VAT-STD' },
  ]));
  fs.writeFileSync(path.join(compiled, 'readable', 'overview.md'), '# Tax Overview\nQuarterly filing deadline is the last day of the first month of the next quarter.\n');
  return dir;
}

const keyPair = generatePackSigningKeyPair();
const packsRoot = path.join(tmpRoot, 'packs');
const domainPackDir = createFixtureDomainPack(path.join(tmpRoot, 'domain-pack-tax'));

// ── 1. §52 PackResolver: Allowlist, Ed25519 sign/verify, leak rejection, Domain Pack, RO KB cache ──
let packV1 = null;
let packV2 = null;
let packV3Schema2 = null;

await t('§52 PackResolver: strict allowlist excludes USER.md/memory/.env/books & signs/verifies with Ed25519 + Domain Pack', () => {
  const srcV1 = createFixtureAgentRepo(path.join(tmpRoot, 'src-v1'), 'advisor', { versionNote: 'v1.0.0' });
  packV1 = buildAgentPack({
    sourceDir: srcV1,
    agentName: 'advisor',
    packId: 'advisor',
    version: '1.0.0',
    outDir: path.join(packsRoot, 'advisor', '1.0.0'),
    knowledgeExclude: ['private-notes'],
    domainPacks: [{ id: 'tax-rules', dir: domainPackDir, version: '1.0.0' }],
    capabilities: ['chat', 'knowledge', 'domain_pack'],
    defaultWeights: { conciseness: 85, formality: 60 },
    privateKeyPem: keyPair.privateKeyPem,
  });

  assert.equal(packV1.ok, true);
  assert.equal(packV1.signed, true);
  assert.ok(!fs.existsSync(path.join(packV1.packDir, 'USER.md')));
  assert.ok(!fs.existsSync(path.join(packV1.packDir, 'agents', 'advisor', 'USER.md')));
  assert.ok(!fs.existsSync(path.join(packV1.packDir, 'agents', 'advisor', 'memory')));
  assert.ok(!fs.existsSync(path.join(packV1.packDir, 'books')));
  assert.ok(!fs.existsSync(path.join(packV1.packDir, '.env')));
  assert.ok(!fs.existsSync(path.join(packV1.packDir, 'knowledge', 'private-notes')));
  assert.ok(fs.existsSync(path.join(packV1.packDir, 'domain-packs', 'tax-rules', 'compiled', 'pack.bitemporal.jsonl')));

  const verified = verifyAgentPack({
    packDir: packV1.packDir,
    expectedSha256: packV1.sha256,
    publicKeyPem: keyPair.publicKeyPem,
    requireSignature: true,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.verifiedSignature, true);

  // Wrong public key MUST fail
  const otherKeys = generatePackSigningKeyPair();
  const badKey = verifyAgentPack({ packDir: packV1.packDir, publicKeyPem: otherKeys.publicKeyPem, requireSignature: true });
  assert.equal(badKey.ok, false);
  assert.ok(badKey.errors.includes('ERR_PACK_SIGNATURE_INVALID'));

  // Build v1.1.0 (minor upgrade) & v2.0.0 (major schema bump)
  const srcV2 = createFixtureAgentRepo(path.join(tmpRoot, 'src-v2'), 'advisor', { versionNote: 'v1.1.0', extraSoul: 'Always cite exact codes.' });
  packV2 = buildAgentPack({
    sourceDir: srcV2,
    agentName: 'advisor',
    packId: 'advisor',
    version: '1.1.0',
    outDir: path.join(packsRoot, 'advisor', '1.1.0'),
    knowledgeExclude: ['private-notes'],
    domainPacks: [{ id: 'tax-rules', dir: domainPackDir, version: '1.0.0' }],
    privateKeyPem: keyPair.privateKeyPem,
  });

  const srcV3 = createFixtureAgentRepo(path.join(tmpRoot, 'src-v3'), 'advisor', { versionNote: 'v2.0.0' });
  packV3Schema2 = buildAgentPack({
    sourceDir: srcV3,
    agentName: 'advisor',
    packId: 'advisor',
    version: '2.0.0',
    stateSchemaVersion: 2,
    outDir: path.join(packsRoot, 'advisor', '2.0.0'),
    knowledgeExclude: ['private-notes'],
    privateKeyPem: keyPair.privateKeyPem,
  });
});

await t('§52 PackResolver: hard-rejects secrets, host paths, private IPs, canary strings & detects tampering', () => {
  const dirtySrc = createFixtureAgentRepo(path.join(tmpRoot, 'src-dirty'), 'leaky');
  const fakeHome = '/' + 'U' + 'sers/alice/secret-project';
  fs.writeFileSync(path.join(dirtySrc, 'agents', 'leaky', 'SOUL.md'), `Token sk-proj-9999999999abcdefghijklmno at ${fakeHome} ip 100.88.1.22 canary-xyz`);
  const dirtyOut = path.join(tmpRoot, 'dirty-out');

  assert.throws(
    () => buildAgentPack({
      sourceDir: dirtySrc,
      agentName: 'leaky',
      outDir: dirtyOut,
      version: '1.0.0',
      canaryStrings: ['canary-xyz'],
    }),
    (err) => err.code === 'ERR_PACK_LEAK_DETECTED' && err.findings.length >= 4,
  );
  assert.ok(!fs.existsSync(dirtyOut), 'failed leak build must not leave partial output dir');

  // Tamper test on a copy of packV1
  const tamperDir = path.join(tmpRoot, 'tampered-pack');
  fs.cpSync(packV1.packDir, tamperDir, { recursive: true });
  fs.appendFileSync(path.join(tamperDir, 'agents', 'advisor', 'SOUL.md'), '\nInjected line');
  const tampered = verifyAgentPack({ packDir: tamperDir, publicKeyPem: keyPair.publicKeyPem });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.errors.some((e) => e.startsWith('ERR_PACK_FILE_TAMPERED:')));

  // Extra unexpected file test
  const extraDir = path.join(tmpRoot, 'extra-file-pack');
  fs.cpSync(packV1.packDir, extraDir, { recursive: true });
  fs.writeFileSync(path.join(extraDir, 'agents', 'advisor', 'ROGUE.md'), 'rogue');
  const extraRes = verifyAgentPack({ packDir: extraDir });
  assert.equal(extraRes.ok, false);
  assert.ok(extraRes.errors.some((e) => e.startsWith('ERR_PACK_UNEXPECTED_FILE:')));
});

await t('§52 PackRegistry: shares single read-only BM25 index across tenants & supports Domain Pack synonyms', () => {
  const registry = createPackRegistry({
    packsRootDir: packsRoot,
    publicKeyPem: keyPair.publicKeyPem,
    requireSignature: true,
  });
  const kb1 = registry.getSharedKnowledge({ packId: 'advisor', version: '1.0.0' });
  const kb2 = registry.getSharedKnowledge({ packId: 'advisor', version: '1.0.0', expectedSha256: packV1.sha256 });
  assert.equal(kb1, kb2, 'two tenants on same pack SHA must share the exact same RO KB instance');
  assert.equal(kb1.readOnly, true);
  assert.equal(registry.cacheStats().kbCacheHits, 1);

  // Domain pack synonym `gtgt` expands to `VAT-STD`
  const vatRes = kb1.retrieve('thue gtgt bao nhieu?');
  assert.ok(vatRes.hits.length >= 1, 'domain pack synonym retrieval must return VAT record');
  assert.ok(vatRes.chunks.some((c) => c.includes('VAT-STD')));
});

await t('§52 CLI: scroll pack keygen / build / verify work end-to-end', () => {
  const cli = path.join(REPO, 'bin', 'scroll.js');
  const cliWork = path.join(tmpRoot, 'cli-pack-work');
  createFixtureAgentRepo(cliWork, 'botcli');
  const keyDir = path.join(cliWork, 'keys');
  const rKey = spawnSync(process.execPath, [cli, 'pack', 'keygen', '--out', keyDir, '--json'], { cwd: cliWork, encoding: 'utf8' });
  assert.equal(rKey.status, 0, rKey.stderr);

  const outPack = path.join(cliWork, 'built-pack');
  const rBuild = spawnSync(process.execPath, [
    cli, 'pack', 'build', 'botcli',
    '--out', outPack,
    '--version', '1.0.0',
    '--exclude', 'private-notes',
    '--sign-key', path.join(keyDir, 'pack-signing.key.pem'),
    '--json',
  ], { cwd: cliWork, encoding: 'utf8' });
  assert.equal(rBuild.status, 0, `${rBuild.stdout}\n${rBuild.stderr}`);

  const rVerify = spawnSync(process.execPath, [
    cli, 'pack', 'verify', outPack,
    '--public-key', path.join(keyDir, 'pack-signing.pub.pem'),
    '--require-signature',
    '--json',
  ], { cwd: cliWork, encoding: 'utf8' });
  assert.equal(rVerify.status, 0, `${rVerify.stdout}\n${rVerify.stderr}`);
  const parsed = JSON.parse(rVerify.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verifiedSignature, true);
});

// ── 2. §53 WorkspaceResolver: Isolation, Layered KB, Upgrade & Instant Rollback ──
await t('§53 WorkspaceResolver: blocks path traversal, layers tenant user-docs above pack KB, upgrades & rolls back cleanly', async () => {
  const registry = createPackRegistry({
    packsRootDir: packsRoot,
    publicKeyPem: keyPair.publicKeyPem,
    requireSignature: true,
  });
  const tenantsRoot = path.join(tmpRoot, 'tenants');

  assert.throws(
    () => openTenantWorkspace({ tenantsRootDir: tenantsRoot, tenantId: '../escape', deploymentId: 'd1', packRegistry: registry, initialPack: { packId: 'advisor', version: '1.0.0' } }),
    (err) => err.code === 'ERR_PATH_ESCAPE',
  );

  const ws = openTenantWorkspace({
    tenantsRootDir: tenantsRoot,
    tenantId: 'tenant-alpha',
    deploymentId: 'dep-advisor-1',
    packRegistry: registry,
    initialPack: { packId: 'advisor', version: '1.0.0' },
  });

  ws.writeUserMd('---\nprincipal:\n  name: Tenant Owner\n---\nAlways answer in bullet points.\n');
  ws.writeWeightsOverride({ conciseness: 95 });
  fs.writeFileSync(path.join(ws.getPaths().domainStateDir, 'custom-book.txt'), 'LEDGER_OK_2026');
  fs.writeFileSync(path.join(ws.getPaths().userDocsDir, 'override.md'), '# Tenant Tariff Override\nStandard plan SKU-P100 special tenant rate is 990,000 VND per month.\n');

  const layered = ws.getLayeredKnowledge();
  const qRes = layered.retrieve('SKU-P100 rate');
  assert.ok(qRes.hits.length >= 2);
  assert.equal(qRes.hits[0].layer, 'tenant:user-docs', 'tenant user-docs must outrank shared pack KB');

  // Minor upgrade 1.0.0 -> 1.1.0
  const up = await ws.switchPack({ packId: 'advisor', version: '1.1.0' });
  assert.equal(up.ok, true);
  assert.equal(up.activePack.version, '1.1.0');
  assert.equal(up.previousPack.version, '1.0.0');
  assert.match(ws.readUserMd(), /Tenant Owner/);
  assert.equal(ws.readWeightsOverride().conciseness, 95);
  assert.equal(fs.readFileSync(path.join(ws.getPaths().domainStateDir, 'custom-book.txt'), 'utf8'), 'LEDGER_OK_2026');

  // Major schema upgrade 1 -> 2 without migrate MUST reject
  await assert.rejects(
    () => ws.switchPack({ packId: 'advisor', version: '2.0.0' }),
    (err) => err.code === 'ERR_SCHEMA_MIGRATION_REQUIRED',
  );

  // Failed major migration MUST restore domain-state snapshot
  await assert.rejects(
    () => ws.switchPack({
      packId: 'advisor',
      version: '2.0.0',
      migrate: async ({ paths }) => {
        fs.writeFileSync(path.join(paths.domainStateDir, 'custom-book.txt'), 'CORRUPTED');
        throw new Error('simulated_migration_crash');
      },
    }),
    /simulated_migration_crash/,
  );
  assert.equal(fs.readFileSync(path.join(ws.getPaths().domainStateDir, 'custom-book.txt'), 'utf8'), 'LEDGER_OK_2026');

  // Instant rollback 1.1.0 -> 1.0.0
  const rb = ws.rollbackPack();
  assert.equal(rb.ok, true);
  assert.equal(rb.activePack.version, '1.0.0');
  assert.ok(rb.durationMs < 200, `rollback should be near-instant, got ${rb.durationMs}ms`);
  assert.match(ws.readUserMd(), /Tenant Owner/);
});

// ── 3. §54 PrincipalProvider: Cross-Surface Identity & Isolation ──
await t('§54 PrincipalProvider: unifies verified owner across surfaces & isolates unlinked external senders', () => {
  const pp = createPrincipalProvider({
    storePath: path.join(tmpRoot, 'principals.json'),
    ownerPrincipalId: 'principal_owner_1',
  });
  pp.linkIdentity({ principalId: 'principal_owner_1', surface: 'web', externalId: 'u_web_01', label: 'Owner Web' });
  pp.linkIdentity({ principalId: 'principal_owner_1', surface: 'telegram', externalId: '777001', label: 'Owner TG' });

  const webOwner = pp.resolveTurnIdentity({ surface: 'web', senderId: 'u_web_01', isGroup: false });
  const tgOwner = pp.resolveTurnIdentity({ surface: 'telegram', senderId: '777001', isGroup: false });
  assert.equal(webOwner.principalId, 'principal_owner_1');
  assert.equal(tgOwner.principalId, 'principal_owner_1');
  assert.equal(webOwner.memoryUserId, tgOwner.memoryUserId);
  assert.equal(webOwner.isOwner, true);
  assert.equal(tgOwner.crossSurfaceUser, true);
  assert.equal(webOwner.memoryChannel, 'unified');

  // Unlinked external users with same numeric ID across different surfaces MUST stay isolated
  const extTg = pp.resolveTurnIdentity({ surface: 'telegram', senderId: '555', isGroup: false });
  const extZalo = pp.resolveTurnIdentity({ surface: 'zalo', senderId: '555', isGroup: false });
  assert.equal(extTg.isOwner, false);
  assert.equal(extTg.trust, 'external');
  assert.equal(extTg.crossSurfaceUser, false);
  assert.notEqual(extTg.memoryUserId, extZalo.memoryUserId);
  assert.notEqual(extTg.memoryUserId, webOwner.memoryUserId);

  // Hijack protection
  assert.throws(
    () => pp.linkIdentity({ principalId: 'attacker_id', surface: 'telegram', externalId: '777001' }),
    (err) => err.code === 'ERR_IDENTITY_ALREADY_BOUND',
  );
});

// ── 4. §55 RemoteToolTransport: Companion Security, Desktop Mutex, & Unknown-State Ledger ──
await t('§55 RemoteToolTransport: local allowlist, path sandbox, kill switch, HITL, Desktop Mutex, & post-dispatch unknown state', async () => {
  const sandboxRoot = path.join(tmpRoot, 'companion-sandbox');
  const outsideFile = path.join(tmpRoot, 'outside-secret.txt');
  fs.mkdirSync(sandboxRoot, { recursive: true });
  fs.writeFileSync(path.join(sandboxRoot, 'ok.txt'), 'SAFE_DATA');
  fs.writeFileSync(outsideFile, 'TOP_SECRET');

  const auditFile = path.join(tmpRoot, 'companion-audit.jsonl');
  const mutex = createDesktopMutex({ defaultLeaseMs: 2000 });
  const desktopTimeline = [];
  let approvalDecision = false;

  const host = createCompanionToolHost({
    deviceId: 'mac-office-01',
    allowlist: ['local_read', 'local_gui', 'local_submit_tax'],
    allowedPaths: [sandboxRoot],
    desktopTools: ['local_gui'],
    desktopMutex: mutex,
    auditPath: auditFile,
    requireApproval: async () => (approvalDecision ? { approved: true, by: 'owner_touchid' } : { approved: false, reason: 'user_rejected' }),
    handlers: {
      local_read: async ({ path: fp }) => ({ content: fs.readFileSync(fp, 'utf8') }),
      local_gui: async ({ actor }) => {
        desktopTimeline.push(`start:${actor}`);
        await new Promise((r) => setTimeout(r, 40));
        desktopTimeline.push(`end:${actor}`);
        return { clicked: actor };
      },
      local_submit_tax: async ({ period }) => ({ submitted: period }),
    },
  });

  let curEpoch = 2;
  const ledgerFile = path.join(tmpRoot, 'remote-calls.jsonl');
  const client = createRemoteToolClient({
    deploymentId: 'dep-tax-1',
    deviceId: 'mac-office-01',
    getEpoch: () => curEpoch,
    ledgerPath: ledgerFile,
    sendRequest: (env) => host.handleEnvelope(env),
    toolSpecs: [
      { name: 'local_read', risk: 'read_only' },
      { name: 'local_gui', risk: 'reversible_write' },
      { name: 'local_submit_tax', risk: 'financial' },
    ],
  });

  // Valid inside sandbox
  const okRead = await client.invoke('local_read', { path: path.join(sandboxRoot, 'ok.txt') });
  assert.equal(okRead.ok, true);
  assert.equal(okRead.output.content, 'SAFE_DATA');

  // Path escape MUST be denied by local Companion Host
  const esc = await client.invoke('local_read', { path: outsideFile });
  assert.equal(esc.ok, false);
  assert.match(esc.error, /ERR_PATH_OUTSIDE_SANDBOX/);

  // Non-allowlisted tool MUST be denied
  const unallowed = await client.invoke('shell_exec', { cmd: 'rm -rf /' });
  assert.equal(unallowed.ok, false);
  assert.match(unallowed.error, /ERR_TOOL_NOT_ALLOWLISTED/);

  // Stale epoch MUST be denied
  curEpoch = 1;
  const stale = await client.invoke('local_read', { path: path.join(sandboxRoot, 'ok.txt') });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /ERR_STALE_EPOCH/);
  curEpoch = 2;

  // Local HITL gate: denied -> then approved
  const deniedTax = await client.invoke('local_submit_tax', { period: 'Q4' }, { riskTier: 'financial' });
  assert.equal(deniedTax.ok, false);
  assert.match(deniedTax.error, /ERR_LOCAL_APPROVAL_DENIED/);
  approvalDecision = true;
  const okTax = await client.invoke('local_submit_tax', { period: 'Q4' }, { riskTier: 'financial' });
  assert.equal(okTax.ok, true);
  assert.equal(okTax.output.submitted, 'Q4');

  // Desktop Mutex: two concurrent GUI calls MUST NOT overlap!
  const [gA, gB] = await Promise.all([
    client.invoke('local_gui', { actor: 'agentA' }),
    client.invoke('local_gui', { actor: 'agentB' }),
  ]);
  assert.equal(gA.ok, true);
  assert.equal(gB.ok, true);
  assert.deepEqual(desktopTimeline, ['start:agentA', 'end:agentA', 'start:agentB', 'end:agentB']);

  // Kill switch pauses immediately
  host.setPaused(true);
  const pausedRes = await client.invoke('local_read', { path: path.join(sandboxRoot, 'ok.txt') });
  assert.equal(pausedRes.ok, false);
  assert.match(pausedRes.error, /ERR_COMPANION_PAUSED/);
  host.setPaused(false);

  // Post-dispatch transport drop on side-effecting tool -> `unknown` (`retrySafe: false`)
  const flakyClient = createRemoteToolClient({
    deploymentId: 'dep-tax-1',
    deviceId: 'mac-office-01',
    getEpoch: () => 2,
    ledgerPath: path.join(tmpRoot, 'flaky-calls.jsonl'),
    sendRequest: async () => { throw new Error('websocket_dropped_mid_flight'); },
  });
  const unknownCall = await flakyClient.invoke('local_submit_tax', { period: 'Q4' }, { riskTier: 'financial' });
  assert.equal(unknownCall.ok, false);
  assert.equal(unknownCall.status, 'unknown');
  assert.equal(unknownCall.retrySafe, false);
  assert.equal(flakyClient.getCallState(unknownCall.callId).status, 'unknown');

  const roFail = await flakyClient.invoke('local_read', { path: 'x' }, { riskTier: 'read_only' });
  assert.equal(roFail.status, 'failed');
  assert.equal(roFail.retrySafe, true);

  // Verify hash-chained local audit log & tamper detection
  const auditOk = verifyCompanionAudit(auditFile);
  assert.equal(auditOk.ok, true);
  assert.ok(auditOk.count >= 8);
  fs.appendFileSync(auditFile, '{"seq":99,"prevHash":"bad","hash":"bad"}\n');
  assert.equal(verifyCompanionAudit(auditFile).ok, false);
});

// ── 5. §56 ScrollAgentHost: Unified Host, Epoch Fencing, Event Dedupe, Upgrade/Rollback, Cron, Telemetry ──
await t('§56 ScrollAgentHost: end-to-end cloud+companion host with epoch fencing, dedupe, live upgrade/rollback, cron, & PII redaction', async () => {
  const registry = createPackRegistry({
    packsRootDir: packsRoot,
    publicKeyPem: keyPair.publicKeyPem,
    requireSignature: true,
  });
  const ws = openTenantWorkspace({
    tenantsRootDir: path.join(tmpRoot, 'host-tenants'),
    tenantId: 'tenant-beta',
    deploymentId: 'dep-unified-1',
    packRegistry: registry,
    initialPack: { packId: 'advisor', version: '1.0.0' },
  });
  ws.writeUserMd('---\nprincipal:\n  name: Beta Owner\n---\nShort answers.\n');

  const pp = createPrincipalProvider({
    storePath: path.join(ws.getPaths().runtimeDir, 'principals.json'),
    ownerPrincipalId: 'owner_beta',
    initialLinks: [
      { principalId: 'owner_beta', surface: 'web', externalId: 'web_1', role: 'owner' },
      { principalId: 'owner_beta', surface: 'telegram', externalId: 'tg_1', role: 'owner' },
    ],
  });

  const companionHost = createCompanionToolHost({
    deviceId: 'mac-beta',
    allowlist: ['check_desktop_status'],
    handlers: {
      check_desktop_status: async () => ({ vm: 'running', queue: 0 }),
    },
  });
  const remoteClient = createRemoteToolClient({
    deploymentId: ws.deploymentId,
    deviceId: 'mac-beta',
    getEpoch: () => ws.getBinding().epoch,
    ledgerPath: path.join(ws.getPaths().runtimeDir, 'remote-calls.jsonl'),
    sendRequest: (env) => companionHost.handleEnvelope(env),
    toolSpecs: [{
      name: 'check_desktop_status',
      description: 'Check opt-in companion desktop VM status',
      risk: 'read_only',
      parameters: { type: 'object', properties: {} },
    }],
  });

  let providerCalls = 0;
  const mockProvider = pickProvider('mock', {
    scriptedTurns: [
      () => { providerCalls++; return { text: 'Confirmed for web turn.' }; },
      () => { providerCalls++; return { text: 'Confirmed for telegram turn.' }; },
      () => { providerCalls++; return { text: 'Upgraded v1.1 reply.' }; },
      () => { providerCalls++; return { text: 'Rolled back v1.0 reply.' }; },
      () => { providerCalls++; return { text: 'Daily digest complete.' }; },
    ],
  });

  const host = await createScrollAgentHost({
    placement: 'cloud+companion',
    workspace: ws,
    packRegistry: registry,
    principalProvider: pp,
    provider: mockProvider,
    remoteClient,
  });

  try {
    // 1. Companion remote tool is registered on SCROLL runtime
    assert.equal(host.runtime.tools.has('check_desktop_status'), true);

    // 2. Turn with eventId + epoch=2 advances workspace epoch
    const r1 = await host.handleTurn({
      eventId: 'evt-100',
      epoch: 2,
      surface: 'web',
      senderId: 'web_1',
      text: 'Contact alice@example.com or +84912345678 about SKU-P100',
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.deduplicated, false);
    assert.equal(r1.identity.principalId, 'owner_beta');
    assert.equal(r1.identity.isOwner, true);
    assert.equal(providerCalls, 1);

    // 3. Duplicate eventId MUST NOT invoke provider a second time!
    const r1Dup = await host.handleTurn({
      eventId: 'evt-100',
      epoch: 2,
      surface: 'web',
      senderId: 'web_1',
      text: 'Contact alice@example.com or +84912345678 about SKU-P100',
    });
    assert.equal(r1Dup.ok, true);
    assert.equal(r1Dup.deduplicated, true);
    assert.equal(r1Dup.text, r1.text);
    assert.equal(providerCalls, 1, 'duplicate eventId must not call provider again');

    // 4. Stale epoch=1 MUST be rejected with ERR_STALE_EPOCH!
    const rStale = await host.handleTurn({
      eventId: 'evt-101',
      epoch: 1,
      surface: 'telegram',
      senderId: 'tg_1',
      text: 'Old split-brain message',
    });
    assert.equal(rStale.ok, false);
    assert.equal(rStale.error, 'ERR_STALE_EPOCH');
    assert.equal(providerCalls, 1);

    // 5. Cross-surface Telegram turn resolves to same principal
    const r2 = await host.handleTurn({
      eventId: 'evt-102',
      epoch: 2,
      surface: 'telegram',
      senderId: 'tg_1',
      text: 'Follow up from Telegram',
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.identity.principalId, 'owner_beta');
    assert.equal(providerCalls, 2);

    // 6. Live in-place Pack upgrade 1.0.0 -> 1.1.0 & instant rollback -> 1.0.0
    const up = await host.upgradePack({ packId: 'advisor', version: '1.1.0' });
    assert.equal(up.activePack.version, '1.1.0');
    assert.equal(host.runtime.tools.has('check_desktop_status'), true, 'remote tools re-attached after upgrade');
    const r3 = await host.handleTurn({ eventId: 'evt-103', epoch: 2, surface: 'web', senderId: 'web_1', text: 'After upgrade' });
    assert.equal(r3.packVersion, '1.1.0');

    const rb = await host.rollbackPack();
    assert.equal(rb.activePack.version, '1.0.0');
    const r4 = await host.handleTurn({ eventId: 'evt-104', epoch: 2, surface: 'web', senderId: 'web_1', text: 'After rollback' });
    assert.equal(r4.packVersion, '1.0.0');

    // 7. Cron tick dedupe + missedPolicy skip vs catchup + stale epoch fencing
    const oldSched = new Date(Date.now() - 3_600_000).toISOString();
    const skippedCron = await host.runScheduledTick({
      jobId: 'morning-brief',
      scheduledAt: oldSched,
      epoch: 2,
      missedPolicy: 'skip',
      staleAfterMs: 60_000,
    });
    assert.equal(skippedCron.ok, true);
    assert.equal(skippedCron.skipped, true);

    const freshSched = new Date().toISOString();
    const runCron = await host.runScheduledTick({
      jobId: 'morning-brief',
      scheduledAt: freshSched,
      epoch: 2,
      missedPolicy: 'catchup',
      prompt: 'Send daily digest',
    });
    assert.equal(runCron.ok, true);
    assert.equal(runCron.deduplicated, false);
    assert.equal(providerCalls, 5);

    const dupCron = await host.runScheduledTick({
      jobId: 'morning-brief',
      scheduledAt: freshSched,
      epoch: 2,
      missedPolicy: 'catchup',
      prompt: 'Send daily digest',
    });
    assert.equal(dupCron.ok, true);
    assert.equal(dupCron.deduplicated, true);
    assert.equal(providerCalls, 5);

    // 8. Export PII-redacted telemetry
    const tel = host.exportTelemetry({ redactPii: true });
    assert.equal(tel.redacted, true);
    assert.equal(tel.summary.turns, 4);
    assert.equal(tel.summary.dedupedTurns, 1);
    assert.equal(tel.summary.cronTicks, 1);
    const serialized = JSON.stringify(tel);
    assert.ok(!serialized.includes('alice@example.com'), 'email must be redacted in telemetry');
    assert.ok(!serialized.includes('+84912345678'), 'phone must be redacted in telemetry');
    assert.ok(redactTelemetryText('sk-proj-1234567890abcdefghij').includes('[REDACTED_TOKEN]'));
  } finally {
    await host.close();
  }
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${fail ? '✖ failures:' : '✔ all green:'} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
