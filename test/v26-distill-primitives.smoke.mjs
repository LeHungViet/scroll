// SCROLL v2.6 -- Smoke & 2-way mutation tests for generic distillation primitives:
//   1. Bi-temporal knowledge filtering, supersession closure, 1-hop lineage, TTL decay, RRF fusion
//   2. Atomic SHA-256 promotion lifecycle (stage -> gate -> shadow -> promote -> rollback)
//   3. 2-way runMutationCheck + gold-case temporal frontmatter parsing
//   4. Provider jsonSchema pass-through & fail-closed ERR_PII_PROVIDER_UNAVAILABLE
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openKnowledge,
  isBiTemporalActive,
  computeFreshness,
  fuseRankings,
  stageCandidate,
  recordGateResult,
  startShadow,
  promoteCandidate,
  rollbackActive,
  getActiveManifest,
  parseGoldCase,
  runMutationCheck,
  pickProvider,
  enforcePiiProviderPolicy,
  isLocalEndpointUrl,
} from '../index.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v26-distill-'));
let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log(`  PASS ${name}`);
  });
}

try {
  // 1. Bi-temporal + supersession + 1-hop lineage + TTL decay
  const kbDir = path.join(tmpRoot, 'knowledge');
  fs.mkdirSync(kbDir, { recursive: true });
  const records = [
    {
      id: 'REG-2020/A1',
      clausePath: 'REG-2020/A1',
      artifactType: 'standard',
      sourceTier: 'T0',
      title: 'Legacy Threshold Rule 2020',
      validFrom: '2020-01-01',
      validTo: '2026-01-01',
      knownFrom: '2020-01-01',
      body: 'Cash payment threshold for non-cash verification is 20000000 units under legacy REG-2020.',
      codes: ['REG-2020'],
    },
    {
      id: 'REG-2026/A1',
      clausePath: 'REG-2026/A1',
      artifactType: 'standard',
      sourceTier: 'T0',
      title: 'Updated Threshold Rule 2026',
      validFrom: '2026-01-01',
      knownFrom: '2025-10-01',
      supersedes: ['REG-2020/A1'],
      body: 'Cash payment threshold for non-cash verification is 5000000 units under REG-2026.',
      codes: ['REG-2026'],
    },
    {
      id: 'REG-2026/A1-EX1',
      clausePath: 'REG-2026/A1-EX1',
      artifactType: 'standard',
      sourceTier: 'T0',
      title: 'Exception for Small Aggregate Purchases',
      validFrom: '2026-01-01',
      knownFrom: '2025-10-01',
      exceptions: ['REG-2026/A1'],
      body: 'Multiple same-day purchases from one vendor aggregate toward the 5000000 unit non-cash limit.',
    },
    {
      id: 'GAP-PORTAL-01',
      clausePath: 'GAP-PORTAL-01',
      artifactType: 'reality_gap',
      sourceTier: 'T2',
      title: 'Portal Timeout Reality Gap',
      observedAt: '2026-01-01',
      ttlDays: 30,
      body: 'Portal submission times out during peak filing windows despite 24/7 SLA.',
    },
  ];
  fs.writeFileSync(
    path.join(kbDir, 'rules.bitemporal.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8'
  );

  await test('bi-temporal asOf selects exact valid regime (2025 vs 2026) and expands 1-hop exception', () => {
    const kb = openKnowledge({ cwd: tmpRoot });
    const res2025 = kb.retrieve('cash payment threshold non-cash', { asOf: '2025-06-15', topK: 2 });
    assert.equal(res2025.hits[0].id, 'REG-2020/A1');
    assert.ok(!res2025.hits.some((h) => h.id === 'REG-2026/A1'));

    const res2026 = kb.retrieve('cash payment threshold non-cash', { asOf: '2026-03-15', topK: 1 });
    assert.equal(res2026.hits[0].id, 'REG-2026/A1');
    assert.ok(!res2026.hits.some((h) => h.id === 'REG-2020/A1'));
    assert.ok(res2026.hits.some((h) => h.id === 'REG-2026/A1-EX1' && h.lineageVia === 'exception_for'));

    // knownAt before announcement date hides future rule
    assert.equal(isBiTemporalActive(records[1], { asOf: '2026-03-15', knownAt: '2025-05-01' }), false);
    assert.equal(isBiTemporalActive(records[1], { asOf: '2026-03-15', knownAt: '2025-11-01' }), true);
  });

  await test('TTL freshness flags stale reality gaps and RRF fuseRankings merges multiple rankers', () => {
    const fresh = computeFreshness(records[3], { nowDate: '2026-01-15' });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.weight, 1.0);
    const stale = computeFreshness(records[3], { nowDate: '2026-03-15' });
    assert.equal(stale.stale, true);
    assert.ok(stale.weight < 0.5);

    const fused = fuseRankings([
      { weight: 0.55, rankedIds: ['A', 'B', 'C'] },
      { weight: 0.45, rankedIds: ['B', 'A', 'D'] },
    ]);
    assert.equal(fused.length, 4);
    assert.ok(fused[0].id === 'A' || fused[0].id === 'B');
  });

  // 2. Atomic SHA-256 promotion lifecycle + rollback
  await test('promotion lifecycle enforces gate -> shadow -> promote -> 1ms rollback and blocks tamper', () => {
    const stateDir = path.join(tmpRoot, 'state');
    const snap1 = path.join(tmpRoot, 'snap1');
    const snap2 = path.join(tmpRoot, 'snap2');
    fs.mkdirSync(snap1, { recursive: true });
    fs.mkdirSync(snap2, { recursive: true });
    fs.writeFileSync(path.join(snap1, 'a.txt'), 'v1-content\n');
    fs.writeFileSync(path.join(snap2, 'a.txt'), 'v2-content\n');

    const t0 = new Date('2026-11-01T00:00:00Z');
    const s1 = stageCandidate({ stateDir, candidateId: 'c1', snapshotDir: snap1, now: t0 });
    assert.equal(s1.ok, true);

    // Promote before gate must fail
    const badProm = promoteCandidate({ stateDir, candidateId: 'c1', now: t0 });
    assert.equal(badProm.ok, false);

    // Gate fail when mutation kill incomplete
    const failGate = recordGateResult({
      stateDir,
      candidateId: 'c1',
      evalReport: { ok: true, passed: 100, total: 100, p0PassRate: 1.0, regressions: 0 },
      mutationReport: { ok: false, killed: 11, total: 12, killRate: 11 / 12 },
      now: t0,
    });
    assert.equal(failGate.ok, false);

    // Gate pass + shadow + premature promote blocked + ready promote succeeds
    const passGate = recordGateResult({
      stateDir,
      candidateId: 'c1',
      evalReport: { ok: true, passed: 100, total: 100, p0PassRate: 1.0, regressions: 0 },
      mutationReport: { ok: true, killed: 12, total: 12, killRate: 1.0 },
      now: t0,
    });
    assert.equal(passGate.ok, true);
    assert.equal(startShadow({ stateDir, candidateId: 'c1', minShadowHours: 48, now: t0 }).ok, true);
    const earlyProm = promoteCandidate({ stateDir, candidateId: 'c1', now: new Date('2026-11-02T00:00:00Z') });
    assert.equal(earlyProm.ok, false);
    const okProm1 = promoteCandidate({ stateDir, candidateId: 'c1', now: new Date('2026-11-03T01:00:00Z') });
    assert.equal(okProm1.ok, true);
    assert.equal(getActiveManifest(stateDir).candidateId, 'c1');

    // Stage & promote c2, then rollback to c1
    stageCandidate({ stateDir, candidateId: 'c2', snapshotDir: snap2, now: t0 });
    recordGateResult({
      stateDir,
      candidateId: 'c2',
      evalReport: { ok: true, passed: 100, total: 100, p0PassRate: 1.0, regressions: 0 },
      mutationReport: { ok: true, killed: 12, total: 12, killRate: 1.0 },
      now: t0,
    });
    assert.equal(promoteCandidate({ stateDir, candidateId: 'c2', allowBypassShadow: true, now: t0 }).ok, true);
    assert.equal(getActiveManifest(stateDir).candidateId, 'c2');

    const rb = rollbackActive({ stateDir, now: t0 });
    assert.equal(rb.ok, true);
    assert.equal(getActiveManifest(stateDir).candidateId, 'c1');

    // Tamper detection after stage
    stageCandidate({ stateDir, candidateId: 'c3', snapshotDir: snap2, now: t0 });
    fs.writeFileSync(path.join(snap2, 'a.txt'), 'tampered!\n');
    const tamperGate = recordGateResult({
      stateDir,
      candidateId: 'c3',
      evalReport: { ok: true, passed: 100, total: 100 },
      mutationReport: { ok: true, killed: 12, total: 12, killRate: 1.0 },
      now: t0,
    });
    assert.equal(tamperGate.ok, false);
    assert.equal(tamperGate.error, 'snapshot_hash_mismatch_after_stage');
  });

  // 3. Gold case temporal metadata + 2-way runMutationCheck
  await test('parseGoldCase temporal fields & 2-way runMutationCheck catches surviving mutant', async () => {
    const gc = parseGoldCase([
      '---',
      'id: temporal-01',
      'as_of: 2026-03-15',
      'known_at: 2026-03-15',
      'split: gate',
      'tier: p0',
      'category: threshold',
      '---',
      '## Input',
      'Check threshold',
      '```checks',
      '- { op: contains, value: "5000000" }',
      '```',
    ].join('\n'));
    assert.equal(gc.asOf, '2026-03-15');
    assert.equal(gc.split, 'gate');
    assert.equal(gc.tier, 'p0');

    const evalGate = (cand) => ({ ok: cand.rate === 0.08 && cand.validFrom === '2026-01-01', reasons: ['bad'] });
    const mutPass = await runMutationCheck({
      evaluateFn: evalGate,
      cleanCandidate: { rate: 0.08, validFrom: '2026-01-01' },
      mutations: [
        { id: 'flip-rate', mutate: (c) => ({ ...c, rate: 0.10 }) },
        { id: 'shift-date', mutate: (c) => ({ ...c, validFrom: '2025-01-01' }) },
      ],
    });
    assert.equal(mutPass.ok, true);
    assert.equal(mutPass.killRate, 1);

    // A weak gate that ignores `validFrom` must FAIL runMutationCheck
    const weakGate = (cand) => ({ ok: cand.rate === 0.08 });
    const mutFail = await runMutationCheck({
      evaluateFn: weakGate,
      cleanCandidate: { rate: 0.08, validFrom: '2026-01-01' },
      mutations: [
        { id: 'flip-rate', mutate: (c) => ({ ...c, rate: 0.10 }) },
        { id: 'shift-date', mutate: (c) => ({ ...c, validFrom: '2025-01-01' }) },
      ],
    });
    assert.equal(mutFail.ok, false);
    assert.equal(mutFail.killed, 1);
  });

  // 4. Provider jsonSchema pass-through & fail-closed PII policy
  await test('provider enforces ERR_PII_PROVIDER_UNAVAILABLE on remote cloud and passes jsonSchema locally', async () => {
    assert.equal(isLocalEndpointUrl('http://127.0.0.1:8080/v1'), true);
    assert.equal(isLocalEndpointUrl('http://100.70.168.26:8080/v1'), true);
    assert.equal(isLocalEndpointUrl('https://api.openai.com/v1'), false);

    assert.throws(
      () => enforcePiiProviderPolicy({ providerName: 'openai', baseUrl: 'https://api.openai.com/v1', piiClassification: 'restricted', fallback: 'never' }),
      (e) => e && e.code === 'ERR_PII_PROVIDER_UNAVAILABLE'
    );

    let capturedBody = null;
    const localProv = pickProvider('openai-compatible', {
      baseUrl: 'http://127.0.0.1:8088/v1',
      model: 'local-test',
      fetchImpl: async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        const payload = {
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        };
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify(payload),
          json: async () => payload,
        };
      },
    });
    const out = await localProv.generate('extract', {
      piiClassification: 'restricted',
      fallback: 'never',
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    assert.equal(out.text, '{"ok":true}');
    assert.equal(capturedBody.response_format.type, 'json_schema');
    assert.equal(capturedBody.response_format.json_schema.strict, true);
  });

  console.log(`v26-distill-primitives: ${passed} passed`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
