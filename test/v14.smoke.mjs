// v1.4 smoke — the harness + loop-engineering layer: risk-tiered permissions enforced at the
// action boundary, grounding pre-check, per-language token budgeting, comprehension digest,
// worktree-lite isolation, real crash-resume, and the OUTER loop (scroll loop / LOOP.md).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWork } from '../lib/runtime.js';
import { runLoop, validateLoop, parseLoop } from '../lib/loop.js';
import { resolveTier, normalizeTier, policyForTier, evaluateAction, needsGrounding } from '../lib/permissions.js';
import { checkGrounding, isGrounded } from '../lib/grounding.js';
import { buildDigest } from '../lib/digest.js';
import { estimateCost, langMultiplier } from '../lib/scroll.js';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); console.log('  \x1b[32m✔\x1b[0m', name); pass++; } catch (e) { console.log('  \x1b[31m✖\x1b[0m', name, '—', e.message); fail++; } };
function mkroot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v14-')); }
function writeAgent(root, name, extraFm = '') {
  const dir = path.join(root, 'agents', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), `---\nname: ${name}\ntitle: ${name}\nversion: 1.0.0\nruntimes: [cowork]\nmodel: { primary: mock-1 }\ncapabilities: [fs.read]\nlanguage: ${extraFm || 'en'}\n---\n${name} agent.`);
  fs.writeFileSync(path.join(dir, 'SOUL.md'), `${name} reasons carefully and cites sources.`);
}
const events = (r) => fs.readFileSync(r.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const types = (evs) => new Set(evs.map((e) => e.type));

// ── permissions (unit) ──────────────────────────────────────────────────────
await t('resolveTier: .mcp.json > identity > glob > fallback destructive', () => {
  assert.equal(resolveTier('issue_invoice', { mcpTools: { issue_invoice: { risk: 'financial' } } }).tier, 'financial');
  assert.equal(resolveTier('fs.write', { riskDefaults: { 'fs.write': 'reversible_write' } }).tier, 'reversible_write');
  assert.equal(resolveTier('mcp.gmail.send', { riskDefaults: { 'mcp.*': 'external_comm' } }).tier, 'external_comm');
  assert.equal(resolveTier('totally_unknown', {}).tier, 'destructive'); // fail-safe
});

await t('normalizeTier: legacy irreversible→destructive, unknown→null', () => {
  assert.equal(normalizeTier('irreversible'), 'destructive');
  assert.equal(normalizeTier('reversible'), 'reversible_write');
  assert.equal(normalizeTier('financial'), 'financial');
  assert.equal(normalizeTier('nonsense'), null);
});

await t('policy matrix + evaluateAction: allow / await / deny', () => {
  assert.equal(policyForTier('read_only'), 'auto');
  assert.equal(policyForTier('financial'), 'must-approve');
  assert.equal(evaluateAction({ tier: 'read_only', policy: 'auto' }).decision, 'allow');
  assert.equal(evaluateAction({ tier: 'destructive', policy: 'must-approve', approved: false }).decision, 'await');
  assert.equal(evaluateAction({ tier: 'destructive', policy: 'must-approve', approved: true }).decision, 'allow');
  // grounding failure DENIES even when "approved" (deny precedes approval)
  assert.equal(evaluateAction({ tier: 'financial', policy: 'must-approve', approved: true, groundingRequired: true, grounded: false }).decision, 'deny');
  assert.ok(needsGrounding('financial') && needsGrounding('destructive') && !needsGrounding('read_only'));
});

// ── grounding (unit) ────────────────────────────────────────────────────────
await t('grounding: numeric + code formats, pass and fail', () => {
  assert.ok(isGrounded('1,500,000', 'invoice total 1500000 VND'));     // digits match across punctuation
  assert.ok(isGrounded('SKU-9', 'item sku 9 ... SKU-9 in stock'));      // code substring
  const ok = checkGrounding({ amount: '1.500.000', code: 'SKU-9' }, 'SKU-9 for 1500000 dong');
  assert.equal(ok.ok, true); assert.deepEqual(ok.missing, []);
  const bad = checkGrounding({ code: 'SKU-FAKE-999' }, 'only SKU-9 exists here');
  assert.equal(bad.ok, false); assert.deepEqual(bad.missing, ['code']);
});

// ── runtime: risk tiers enforced at the action boundary ─────────────────────
await t('tier external_comm (soft-hold) executes and is logged', async () => {
  const root = mkroot(); writeAgent(root, 'sender');
  const r = await runWork({ cwd: root, task: 'Post an update to the channel.', agent: 'sender', risk: 'external_comm', providerName: 'mock', runDir: path.join(root, 'run') });
  const pd = events(r).find((e) => e.type === 'permission_decision');
  assert.ok(pd && pd.data.tier === 'external_comm' && pd.data.decision === 'allow', 'external_comm allowed');
  assert.equal(r.status, 'completed');
});

await t('tier destructive (must-approve) with NO approval blocks before the action', async () => {
  const root = mkroot(); writeAgent(root, 'ops');
  const r = await runWork({ cwd: root, task: 'Drop the production table.', agent: 'ops', risk: 'destructive', autoApprove: false, providerName: 'mock', runDir: path.join(root, 'run') });
  const ty = types(events(r));
  assert.ok(ty.has('gate_blocked'), 'gate_blocked');
  assert.ok(!ty.has('provider_call_started'), 'no provider call when blocked');
  // a machine-readable approval request was written to control/approvals/
  assert.ok(fs.existsSync(path.join(root, 'run', 'control', 'approvals')) , 'approvals dir created');
});

// ── runtime: grounding pre-check on financial actions ───────────────────────
await t('financial action: grounded params → allowed (approved)', async () => {
  const root = mkroot(); writeAgent(root, 'biller');
  const r = await runWork({ cwd: root, task: 'Issue an invoice for SKU-9 totaling 1500000 VND.', agent: 'biller',
    risk: 'financial', ground: { code: 'SKU-9', amount: '1500000' }, autoApprove: true, providerName: 'mock', runDir: path.join(root, 'run') });
  const gc = events(r).find((e) => e.type === 'grounding_checked');
  assert.ok(gc && gc.data.passed === true, 'grounding passed');
  assert.equal(r.status, 'completed');
});

await t('financial action: a FABRICATED param → denied, never executes (even if approved)', async () => {
  const root = mkroot(); writeAgent(root, 'biller');
  const r = await runWork({ cwd: root, task: 'Issue an invoice for SKU-9 totaling 1500000 VND.', agent: 'biller',
    risk: 'financial', ground: { code: 'SKU-HALLUCINATED-42' }, autoApprove: true, providerName: 'mock', runDir: path.join(root, 'run') });
  const ty = types(events(r));
  assert.ok(ty.has('grounding_failed'), 'grounding_failed emitted');
  assert.ok(ty.has('gate_blocked'), 'blocked');
  assert.ok(!ty.has('provider_call_started'), 'fabricated invoice never runs');
});

// ── per-language token budgeting ─────────────────────────────────────────────
await t('per-language: vi multiplies the estimate; cost gate reports language', async () => {
  assert.equal(langMultiplier('vi'), 1.8);
  assert.equal(langMultiplier('en'), 1);
  const en = estimateCost('x'.repeat(400), 2, { language: 'en' });
  const vi = estimateCost('x'.repeat(400), 2, { language: 'vi' });
  assert.ok(vi.single > en.single, 'vi estimate exceeds en');
  const root = mkroot(); writeAgent(root, 'viet', 'vi');
  const r = await runWork({ cwd: root, task: 'Tóm tắt thị trường.', agent: 'viet', providerName: 'mock', runDir: path.join(root, 'run') });
  const cg = events(r).find((e) => e.type === 'cost_gate');
  assert.equal(cg.data.language, 'vi', 'cost gate picked up IDENTITY.language');
});

// ── comprehension digest ─────────────────────────────────────────────────────
await t('digest: every run writes a human-readable digest.md with the required sections', async () => {
  const root = mkroot(); writeAgent(root, 'case');
  const r = await runWork({ cwd: root, task: 'Summarize a topic into a verdict with assumptions and next actions.', agent: 'case', providerName: 'mock', runDir: path.join(root, 'run') });
  assert.ok(r.digestPath && fs.existsSync(r.digestPath), 'digest.md exists');
  const d = fs.readFileSync(r.digestPath, 'utf8');
  for (const h of ['Run digest', 'What it did', 'Dangerous actions touched', 'What it cost', 'Needs your attention']) assert.ok(d.includes(h), `digest has "${h}"`);
  assert.ok(types(events(r)).has('digest_written'), 'digest_written event');
});

await t('digest: dangerous tier + grounding failure surface in the digest (Vietnamese)', () => {
  const evs = [
    { type: 'task_contract', data: { taskId: 'pay', objective: 'pay vendor' } },
    { type: 'permission_decision', data: { tier: 'financial', tool: 'pay', decision: 'deny' } },
    { type: 'grounding_failed', data: { taskId: 'pay', missing: ['amount'] } },
    { type: 'paused', data: { metrics: { billableTokenEquivalent: 10, costUsd: 0.001, durationMs: 5, providerCalls: 0 } } },
  ];
  const md = buildDigest(evs, { language: 'vi' });
  assert.ok(md.includes('Tóm tắt lượt chạy'), 'vietnamese heading');
  assert.ok(/financial/.test(md) && /TỪ CHỐI/.test(md), 'flags the denied financial action');
});

// ── worktree-lite isolation ──────────────────────────────────────────────────
await t('parallel tasks get isolated working dirs (no shared scratch)', async () => {
  const root = mkroot();
  for (const a of ['m', 'n', 'lead']) writeAgent(root, a);
  const work = `---\ncontroller: lead\n---\n\`\`\`task\nid: a\ntitle: a\nstatus: todo\nowner: m\nobjective: research A [S1]\noutput_format: md\nboundaries: [x]\nblockedBy: []\nparallel: true\n\`\`\`\n\`\`\`task\nid: b\ntitle: b\nstatus: todo\nowner: n\nobjective: research B [S2]\noutput_format: md\nboundaries: [x]\nblockedBy: []\nparallel: true\n\`\`\`\n\`\`\`task\nid: c\ntitle: c\nstatus: todo\nowner: lead\nobjective: merge [S1][S2]\noutput_format: md\nboundaries: [x]\nblockedBy: [a, b]\nfinal: true\n\`\`\`\n`;
  fs.writeFileSync(path.join(root, 'WORK.md'), work);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run') });
  const iso = events(r).filter((e) => e.type === 'isolated_scratch');
  assert.ok(iso.length >= 2, 'each parallel task isolated');
  const dirs = new Set(iso.map((e) => e.data.dir));
  assert.equal(dirs.size, iso.length, 'isolated dirs are distinct (no collision)');
  assert.equal(r.status, 'completed');
});

// ── real crash-resume ────────────────────────────────────────────────────────
await t('crash-resume: interrupt mid-run, resume from checkpoint, finish WITHOUT re-billing', async () => {
  const root = mkroot(); writeAgent(root, 'case');
  const work = `---\ncontroller: case\n---\n\`\`\`task\nid: a\ntitle: a\nstatus: todo\nowner: case\nobjective: step one [S1]\noutput_format: md\nboundaries: [x]\nblockedBy: []\n\`\`\`\n\`\`\`task\nid: b\ntitle: b\nstatus: todo\nowner: case\nobjective: step two [S1]\noutput_format: md\nboundaries: [x]\nblockedBy: [a]\nfinal: true\n\`\`\`\n`;
  fs.writeFileSync(path.join(root, 'WORK.md'), work);
  const runDir = path.join(root, 'run');
  // first run interrupted after the first task (cap maxIterations:1 → pause with a done, b pending)
  const r1 = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir, caps: { maxIterations: 1 } });
  assert.equal(r1.status, 'paused', 'paused mid-run');
  assert.equal(r1.metrics.tasksCompleted, 1, 'one task done before the crash');
  assert.equal(r1.metrics.providerCalls, 1, 'one provider call so far');
  // resume the SAME run dir
  const r2 = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir, resume: true });
  assert.ok(types(events(r2)).has('resumed'), 'resumed event');
  assert.equal(r2.status, 'completed', 'completes after resume');
  assert.equal(r2.metrics.providerCalls, 1, 'resume re-billed ONLY the remaining task (a was not re-run)');
  assert.equal(r2.metrics.tasksCompleted, 2, 'all tasks done after resume');
});

// ── the OUTER loop ───────────────────────────────────────────────────────────
await t('LOOP.md validation: a loop with no stop condition is refused', () => {
  const bad = parseLoop('---\nid: x\ncontroller: lead\nwork_source: { type: work_file, query: WORK.md }\n---\n');
  const errs = validateLoop(bad.frontmatter);
  assert.ok(errs.some((e) => /stop_conditions/.test(e)), 'must reject missing stop condition');
  const good = parseLoop('---\nid: x\ncontroller: lead\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 1 }\n---\n');
  assert.deepEqual(validateLoop(good.frontmatter), []);
});

await t('scroll loop: runs the inner loop, respects stop conditions, writes a digest', async () => {
  const root = mkroot(); writeAgent(root, 'lead');
  fs.writeFileSync(path.join(root, 'WORK.md'), `---\ncontroller: lead\n---\n\`\`\`task\nid: t1\ntitle: t1\nstatus: todo\nowner: lead\nobjective: summarize [S1]\noutput_format: md\nboundaries: [cite S1]\nblockedBy: []\nfinal: true\n\`\`\`\n`);
  fs.writeFileSync(path.join(root, 'LOOP.md'), `---\nid: nightly\ncontroller: lead\nschedule: { interval_ms: 100 }\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 2 }\nbudget: { per_run: { max_usd: 1 } }\ndigest: required\nlanguage: en\n---\n# Goal\nrun nightly\n`);
  const summary = await runLoop('LOOP.md', { cwd: root, maxRuns: 2, providerName: 'mock', runWork });
  assert.equal(summary.iterations, 2, 'ran exactly max_runs iterations');
  assert.ok(summary.runs.every((x) => x.status === 'completed'), 'each inner run completed');
  assert.ok(summary.runs.every((x) => x.digest), 'each iteration produced a digest');
  // a third call must stop immediately (max_runs reached, persisted in loop state)
  const again = await runLoop('LOOP.md', { cwd: root, maxRuns: 5, providerName: 'mock', runWork });
  assert.ok(/max_runs/.test(String(again.stopped)), 'stops on the persisted max_runs');
});

await t('scroll loop --dry-run plans without spending', async () => {
  const root = mkroot(); writeAgent(root, 'lead');
  fs.writeFileSync(path.join(root, 'WORK.md'), `---\ncontroller: lead\n---\n\`\`\`task\nid: t1\ntitle: t1\nstatus: todo\nowner: lead\nobjective: x [S1]\noutput_format: md\nboundaries: [y]\nblockedBy: []\nfinal: true\n\`\`\`\n`);
  fs.writeFileSync(path.join(root, 'LOOP.md'), `---\nid: dry\ncontroller: lead\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 1 }\n---\n# Goal\n`);
  const summary = await runLoop('LOOP.md', { cwd: root, once: true, dryRun: true, runWork });
  assert.ok(summary.runs[0].dryRun === true, 'dry-run planned, did not execute');
});

console.log(`\nv1.4: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
