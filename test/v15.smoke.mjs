// v1.5 smoke — Trackable · Self-Driving · Honest-on-Failure:
// ledger (cross-run human table), planner (self-planning work), per-task try-budget + fail-continue, proof recorded.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLoop, validateLoop, parseLoop } from '../lib/loop.js';
import { parseLedger } from '../lib/ledger.js';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); console.log('  \x1b[32m✔\x1b[0m', name); pass++; } catch (e) { console.log('  \x1b[31m✖\x1b[0m', name, '—', e.message); fail++; } };
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v15-'));

// WORK.md (1 task) — built with concatenation to avoid backtick-in-template issues.
const TASK = '```task\nid: t1\ntitle: t1\nstatus: todo\nowner: lead\nobjective: x\noutput_format: md\nboundaries: [y]\nblockedBy: []\nfinal: true\n```\n';
const WORK_MD = '---\ncontroller: lead\n---\n' + TASK;

// custom runWork stub — control pass/fail + proof to exercise the new branches.
function stub({ passes = true, proof = null } = {}) {
  return async ({ runDir }) => {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'digest.md'), '# d');
    const r = { status: 'completed', verification: { passed: passes }, metrics: { costUsd: 0.01 } };
    if (proof) r.proof = proof;
    return r;
  };
}
function writeLoop(root, loopFm) { fs.writeFileSync(path.join(root, 'LOOP.md'), loopFm); fs.writeFileSync(path.join(root, 'WORK.md'), WORK_MD); }

// 1 — validateLoop new optional fields (type-checked)
await t('validateLoop: ledger/planner/max_tries_per_task optional + type-checked', () => {
  const ok = parseLoop('---\nid: x\ncontroller: l\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 1 }\nledger: local://runs/ledger.csv\nplanner: node plan.mjs\nmax_tries_per_task: 3\n---\n');
  assert.deepEqual(validateLoop(ok.frontmatter), []);
  const bad = parseLoop('---\nid: x\ncontroller: l\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 1 }\nmax_tries_per_task: 0\n---\n');
  assert.ok(validateLoop(bad.frontmatter).some((e) => /max_tries_per_task/.test(e)), 'rejects max_tries_per_task < 1');
  assert.equal(parseLedger('local://runs/ledger.csv').scheme, 'local');
  assert.equal(parseLedger('notion://abc').scheme, 'notion');
});

// 2 — ledger local CSV: header + one row per output
await t('ledger local:// CSV gets header + one row per output', async () => {
  const root = mkroot();
  writeLoop(root, '---\nid: lg\ncontroller: lead\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 2 }\nledger: local://runs/ledger.csv\n---\n# g\n');
  await runLoop('LOOP.md', { cwd: root, maxRuns: 2, runWork: stub({ passes: true }) });
  const lines = fs.readFileSync(path.join(root, 'runs', 'ledger.csv'), 'utf8').trim().split('\n');
  assert.ok(lines[0].startsWith('ts,loop,iteration,task,status'), 'header present');
  assert.equal(lines.length, 3, 'header + 2 rows');
  assert.ok(lines[1].includes(',done,'), 'status done for a passing output');
});

// 3 — per-task try-budget + FAIL-CONTINUE (no halt_on): retry MAXT, mark failed, continue
await t('retry + fail-continue: fails are retried MAXT then marked failed and the loop CONTINUES', async () => {
  const root = mkroot();
  writeLoop(root, '---\nid: rc\ncontroller: lead\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 2 }\nmax_tries_per_task: 2\nledger: local://runs/ledger.csv\n---\n# g\n');
  const summary = await runLoop('LOOP.md', { cwd: root, maxRuns: 2, runWork: stub({ passes: false }) });
  assert.equal(summary.iterations, 2, 'continued through both iterations (NOT halted by verify_fail)');
  assert.ok(summary.runs.every((r) => r.taskStatus === 'failed' && r.tries === 2), 'each output failed after exactly 2 tries');
  const lines = fs.readFileSync(path.join(root, 'runs', 'ledger.csv'), 'utf8').trim().split('\n');
  assert.ok(lines.slice(1).every((l) => l.includes(',failed,')), 'failed outputs ARE recorded in the ledger');
});

// 4 — halt_on verify_fail still halts, but AFTER retries
await t('halt_on verify_fail: halts after retries exhausted (backward-compat)', async () => {
  const root = mkroot();
  writeLoop(root, '---\nid: h\ncontroller: lead\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 3, halt_on: [verify_fail] }\nmax_tries_per_task: 2\n---\n# g\n');
  const summary = await runLoop('LOOP.md', { cwd: root, maxRuns: 3, runWork: stub({ passes: false }) });
  assert.ok(/verify_fail/.test(String(summary.stopped)), 'halted on verify_fail');
  assert.equal(summary.iterations, 1, 'halted after the first task (post-retries)');
});

// 5 — proof recorded in ledger
await t('proof: runWork proof path is recorded in the ledger row', async () => {
  const root = mkroot();
  fs.writeFileSync(path.join(root, 'proof.png'), 'x');
  writeLoop(root, '---\nid: p\ncontroller: lead\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 1 }\nledger: local://runs/ledger.csv\n---\n# g\n');
  await runLoop('LOOP.md', { cwd: root, once: true, runWork: stub({ passes: true, proof: 'proof.png' }) });
  assert.ok(fs.readFileSync(path.join(root, 'runs', 'ledger.csv'), 'utf8').includes('proof.png'), 'proof path in ledger');
});

// 6 — planner runs BEFORE the loop to generate work (self-planning)
await t('planner: runs the planner command to generate work before iterating', async () => {
  const root = mkroot();
  const PLAN = "import fs from 'node:fs';\n" +
    "const task='```task\\nid: t1\\ntitle: t1\\nstatus: todo\\nowner: lead\\nobjective: x\\noutput_format: md\\nboundaries: [y]\\nblockedBy: []\\nfinal: true\\n```\\n';\n" +
    "fs.writeFileSync('WORK.md','---\\ncontroller: lead\\n---\\n'+task);\n";
  fs.writeFileSync(path.join(root, 'plan.mjs'), PLAN);
  fs.writeFileSync(path.join(root, 'LOOP.md'), '---\nid: pl\ncontroller: lead\nplanner: node plan.mjs\nwork_source: { type: work_file, query: WORK.md }\nstop_conditions: { max_runs: 1 }\n---\n# g\n');
  // NOTE: no WORK.md exists yet — the planner MUST create it.
  const summary = await runLoop('LOOP.md', { cwd: root, once: true, runWork: stub({ passes: true }) });
  assert.ok(fs.existsSync(path.join(root, 'WORK.md')), 'planner created WORK.md');
  assert.equal(summary.iterations, 1, 'planner-generated work ran');
});

console.log(`\nv1.5: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
