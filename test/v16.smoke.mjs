// SCROLL v1.6 smoke — §28 effect confirmation · §29 ungraded-is-not-pass · §30 fixture provenance.
//
// Each test encodes the exact failure the section exists to prevent, not just the happy path:
//   §28 — a write returns "ok" while the state never changed  → MUST be caught, not trusted
//   §29 — nothing was measured                                → MUST NOT read as pass
//   §30 — the precondition was hand-built                     → MUST be flagged, not counted as proof
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirmEffect, evalExpect, readPath, rejectUnknownFields, isWriteTier, confirmRequired } from '../lib/effects.js';
import { parseGoldCase, parseFixture, PROVENANCE } from '../lib/eval.js';
import { auditRepo } from '../lib/audit.js';

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  \x1b[32m✔\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m✖\x1b[0m ${name}\n    ${e.message}`); fail++; }
};

console.log('v1.6 — effect confirmation · ungraded ≠ pass · fixture provenance');

// ── §28 ──────────────────────────────────────────────────────────────────────
await t('§28 path + expect predicates are deterministic', () => {
  assert.equal(readPath({ a: { b: 7 } }, '$.a.b').value, 7);
  assert.equal(readPath({ items: [{ id: 'x' }] }, '$.items[0].id').value, 'x');
  assert.equal(evalExpect("$.status == 'issued'", { status: 'issued' }).ok, true);
  assert.equal(evalExpect("$.status == 'issued'", { status: 'draft' }).ok, false);
  assert.equal(evalExpect('$.n != 3', { n: 4 }).ok, true);
  assert.equal(evalExpect('$.id exists', { id: null }).ok, false);
  assert.equal(evalExpect("$.tags contains 'a'", { tags: ['a', 'b'] }).ok, true);
  assert.ok(evalExpect('nonsense', {}).error, 'unsupported predicate must error, not silently pass');
});

await t('§28 THE BUG: write says ok but state never changed → effect_unconfirmed + fail', async () => {
  // The interface accepted the call, dropped the field, and answered 200 {ok:true}.
  // The read-back is the only thing that can tell the truth.
  const events = [];
  const res = await confirmEffect({
    tool: 'set_schedule', tier: 'reversible_write',
    confirm: { probe: 'get_schedule', expect: "$.time == '07:00'" },
    invoke: async () => ({ time: null }),        // ← the write silently did nothing
    emit: (ev, d) => events.push([ev, d]),
  });
  assert.equal(res.ok, false, 'a write whose effect is absent MUST NOT be reported as success');
  assert.equal(res.unconfirmed, true);
  assert.ok(/read-back mismatch/.test(res.reason), res.reason);
  assert.equal(events[0][0], 'effect_unconfirmed');
});

await t('§28 write that really landed → effect_confirmed', async () => {
  const events = [];
  const res = await confirmEffect({
    tool: 'set_schedule', tier: 'reversible_write',
    confirm: { probe: 'get_schedule', expect: "$.time == '07:00'" },
    invoke: async () => ({ time: '07:00' }),
    emit: (ev, d) => events.push([ev, d]),
  });
  assert.equal(res.ok, true);
  assert.equal(events[0][0], 'effect_confirmed');
});

await t('§28 financial/destructive without confirm → fail-closed; read_only untouched', async () => {
  const fin = await confirmEffect({ tool: 'issue_invoice', tier: 'financial', confirm: null });
  assert.equal(fin.ok, false, 'a financial write with no confirm MUST be blocked');
  assert.equal(confirmRequired('financial'), true);
  assert.equal(confirmRequired('destructive'), true);
  assert.equal(confirmRequired('reversible_write'), false);
  const ro = await confirmEffect({ tool: 'lookup', tier: 'read_only' });
  assert.equal(ro.ok, true); assert.equal(ro.checked, false);
  assert.equal(isWriteTier('read_only'), false);
  assert.equal(isWriteTier('external_comm'), true);
  // Unknown tier → treated as destructive (deny-by-default, §21).
  assert.equal(isWriteTier('nonsense-tier'), true);
});

await t('§28 corollary: unknown input field is rejected, never dropped', () => {
  const r = rejectUnknownFields({ id: 1, personaId: 'x', schedule: {}, fieldNobodyKnows: 9 },
    ['schedule'], ['id', 'personaId']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.rejected, ['fieldNobodyKnows']);
  const ok = rejectUnknownFields({ id: 1, schedule: {} }, ['schedule'], ['id']);
  assert.equal(ok.ok, true); assert.deepEqual(ok.rejected, []);
});

// ── §29 ──────────────────────────────────────────────────────────────────────
await t('§29 a case with no assertions is ungraded, never a pass', () => {
  const gc = parseGoldCase(['---', 'id: c1', '---', '## Input', 'hi'].join('\n'), 'c1.md');
  assert.equal(gc.checks.length, 0);   // runEvals marks this verdict:'ungraded' and excludes it from ok
});

await t('§29 ungraded is excluded from ok — it is neither pass nor fail', () => {
  // Mirrors the reducer in runEvals: ok = graded.length > 0 && every graded === 'pass'
  const reduce = (cases) => {
    const graded = cases.filter((c) => !c.skipped && c.verdict !== 'ungraded');
    return { ok: graded.length > 0 && graded.every((c) => c.verdict === 'pass'),
      ungraded: cases.filter((c) => c.skipped || c.verdict === 'ungraded').length };
  };
  assert.deepEqual(reduce([{ verdict: 'pass' }, { verdict: 'ungraded' }]), { ok: true, ungraded: 1 });
  // The whole point: a suite where NOTHING was measured must not read as green.
  assert.deepEqual(reduce([{ verdict: 'ungraded' }, { skipped: true }]), { ok: false, ungraded: 2 });
  assert.deepEqual(reduce([{ verdict: 'pass' }, { verdict: 'fail' }]), { ok: false, ungraded: 0 });
});

// ── §30 ──────────────────────────────────────────────────────────────────────
await t('§30 provenance parsing + required companions', () => {
  assert.deepEqual(PROVENANCE, ['product-path', 'recorded', 'synthetic']);
  assert.ok(parseFixture({}).issues.length, 'missing provenance must be flagged');
  assert.ok(parseFixture({ fixture: { provenance: 'made-up' } }).issues.length);
  assert.ok(parseFixture({ fixture: { provenance: 'product-path' } }).issues.length, 'product-path needs setup');
  assert.equal(parseFixture({ fixture: { provenance: 'product-path', setup: 'scroll run arm' } }).issues.length, 0);
  assert.ok(parseFixture({ fixture: { provenance: 'synthetic' } }).issues.length, 'synthetic needs justification');
  assert.equal(parseFixture({ fixture: { provenance: 'synthetic', justification: 'no sandbox' } }).issues.length, 0);
});

await t('§30 THE BUG: a suite built only on hand-made fixtures gets flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v16-'));
  const ag = path.join(dir, 'agents', 'demo');
  fs.mkdirSync(path.join(ag, 'evals'), { recursive: true });
  fs.writeFileSync(path.join(ag, 'IDENTITY.md'),
    ['---', 'name: demo', 'version: 0.1.0', 'runtimes: [cowork]', 'model: { primary: m }', 'capabilities: []', '---', '# demo'].join('\n'));
  fs.writeFileSync(path.join(ag, 'SOUL.md'), '# soul\n');
  const caseMd = (id) => ['---', `id: ${id}`, 'fixture:', '  provenance: synthetic',
    '  justification: hand-built', '---', '## Input', 'x', '```checks', '- op: contains', '  value: y', '```'].join('\n');
  for (const id of ['c1', 'c2', 'c3']) fs.writeFileSync(path.join(ag, 'evals', `${id}.md`), caseMd(id));

  const rep = auditRepo(dir, { name: 'demo' });
  const w = rep.agents[0].warnings.join(' | ');
  assert.ok(/every gold case uses a hand-built fixture/.test(w),
    'an all-synthetic suite leaves the arm/setup path unverified — audit must say so. got: ' + w);
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('§28 audit flags a financial tool with no confirm in .mcp.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v16b-'));
  const ag = path.join(dir, 'agents', 'demo');
  fs.mkdirSync(path.join(ag, 'evals'), { recursive: true });
  fs.writeFileSync(path.join(ag, 'IDENTITY.md'),
    ['---', 'name: demo', 'version: 0.1.0', 'runtimes: [cowork]', 'model: { primary: m }', 'capabilities: []', '---', '# demo'].join('\n'));
  fs.writeFileSync(path.join(ag, 'SOUL.md'), '# soul\n');
  fs.writeFileSync(path.join(ag, '.mcp.json'), JSON.stringify({
    mcpServers: { billing: { command: 'x', tools: {
      issue_invoice: { risk: 'financial' },                                        // ← no confirm
      lookup_invoice: { risk: 'read_only' },
      refund: { risk: 'financial', confirm: { probe: 'get_refund', expect: '$.ok == true' } },
    } } },
  }, null, 2));
  const rep = auditRepo(dir, { name: 'demo' });
  const w = rep.agents[0].warnings.join(' | ');
  assert.ok(/issue_invoice.*no `confirm`/.test(w), 'financial write without confirm must warn. got: ' + w);
  assert.ok(!/refund:/.test(w), 'a tool WITH confirm must not warn');
  assert.ok(!/lookup_invoice/.test(w), 'a read must not warn');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\nv1.6: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
