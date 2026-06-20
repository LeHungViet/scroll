// Runtime smoke test — drives `scroll run` end to end with the mock provider,
// in isolated temp dirs (no repo CLAUDE.md), asserting the real mechanics:
// deterministic advance, single-controller, cost gate, blackboard, caps/breaker,
// cache accounting, verify-before-done, event stream.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWork, parseWork } from '../lib/runtime.js';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); console.log('  \x1b[32m✔\x1b[0m', name); pass++; } catch (e) { console.log('  \x1b[31m✖\x1b[0m', name, '—', e.message); fail++; } };

function mkroot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-rt-')); }
function writeAgent(root, name) {
  const dir = path.join(root, 'agents', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), `---\nname: ${name}\ntitle: ${name}\nversion: 1.0.0\nruntimes: [cowork]\nmodel: { primary: mock-1 }\ncapabilities: [fs.read]\n---\n${name} agent.`);
  fs.writeFileSync(path.join(dir, 'SOUL.md'), `${name} thinks carefully and cites sources.`);
}
const events = (r) => fs.readFileSync(r.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const types = (evs) => new Set(evs.map((e) => e.type));

const MULTI_WORK = `---
controller: case
---
\`\`\`task
id: research-market
title: market
status: todo
owner: marcus
objective: Summarize the market using [S1] and [S2].
output_format: markdown
source_guidance: [S1, S2]
blockedBy: []
parallel: true
\`\`\`
\`\`\`task
id: research-econ
title: econ
status: todo
owner: taylor
objective: Summarize unit economics using [S3].
output_format: markdown
source_guidance: [S3]
blockedBy: []
parallel: true
\`\`\`
\`\`\`task
id: synthesize
title: memo
status: todo
owner: case
objective: Combine findings into a go/no-go memo citing [S1][S2][S3].
output_format: markdown
blockedBy: [research-market, research-econ]
final: true
\`\`\`
`;

await t('parseWork reads controller + tasks + deps', () => {
  const w = parseWork(MULTI_WORK);
  assert.equal(w.controller, 'case');
  assert.equal(w.tasks.length, 3);
  const syn = w.tasks.find((x) => x.id === 'synthesize');
  assert.deepEqual(syn.blockedBy, ['research-market', 'research-econ']);
  assert.equal(syn.final, true);
});

await t('multi-agent run: completes, multi cost-gate, blackboard, verify, events', async () => {
  const root = mkroot();
  for (const a of ['marcus', 'taylor', 'case']) writeAgent(root, a);
  fs.writeFileSync(path.join(root, 'WORK.md'), MULTI_WORK);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run1') });
  assert.equal(r.status, 'completed', 'status');
  assert.equal(r.decision, 'multi', 'cost gate should choose multi (2 parallel, >1 agent)');
  assert.ok(r.spawnedAgents >= 2, 'spawnedAgents >= 2');
  assert.equal(r.verification.passed, true, 'verify passed');
  assert.equal(r.metrics.tasksCompleted, 3, 'all 3 tasks done');
  const ty = types(events(r));
  for (const need of ['run_started', 'work_contract', 'cost_gate', 'cap_set', 'task_contract', 'provider_call_completed', 'blackboard_write', 'checkpoint_written', 'output_saved', 'verification', 'completed']) {
    assert.ok(ty.has(need), `missing event: ${need}`);
  }
  // single controller guard present
  const wc = events(r).find((e) => e.type === 'work_contract');
  assert.equal(wc.data.controllerCount, 1);
  assert.equal(wc.data.ownerCountPerTaskMax, 1);
  // blackboard files for the two research tasks exist and are non-empty
  for (const id of ['research-market', 'research-econ', 'synthesize']) {
    const p = path.join(root, 'run1', 'blackboard', `${id}.md`);
    assert.ok(fs.existsSync(p) && fs.statSync(p).size > 0, `blackboard ${id}`);
  }
  // final output is the synthesis, non-empty, cites sources
  const out = fs.readFileSync(r.outPath, 'utf8');
  assert.ok(/\[S1\]/.test(out), 'final output cites a source');
});

await t('verify happens BEFORE completed (ordering)', async () => {
  const root = mkroot();
  fs.writeFileSync(path.join(root, 'WORK.md'), MULTI_WORK);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run') });
  const evs = events(r);
  const vi = evs.findIndex((e) => e.type === 'verification');
  const ci = evs.findIndex((e) => e.type === 'completed');
  assert.ok(vi >= 0 && ci >= 0 && vi < ci, 'verification must precede completed');
});

await t('single-task run: cost-gate chooses single, 1 agent', async () => {
  const root = mkroot();
  writeAgent(root, 'case');
  const r = await runWork({ cwd: root, task: 'Summarize the topic into a verdict with assumptions and next actions.', agent: 'case', providerName: 'mock', runDir: path.join(root, 'run') });
  assert.equal(r.decision, 'single');
  assert.equal(r.spawnedAgents, 1);
  assert.equal(r.status, 'completed');
  assert.equal(r.verification.passed, true);
});

await t('cost-gate negative: small/non-parallel work stays single (T08-style)', async () => {
  const root = mkroot();
  const work = `---\ncontroller: case\n---\n\`\`\`task\nid: a\ntitle: a\nstatus: todo\nowner: case\nobjective: tiny task [S1]\nblockedBy: []\n\`\`\`\n\`\`\`task\nid: b\ntitle: b\nstatus: todo\nowner: case\nobjective: another tiny task [S1]\nblockedBy: [a]\n\`\`\`\n`;
  fs.writeFileSync(path.join(root, 'WORK.md'), work);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run') });
  assert.equal(r.decision, 'single', 'no parallel read + single agent → single');
  assert.equal(r.spawnedAgents, 1);
});

await t('hard caps: circuit breaker pauses the run', async () => {
  const root = mkroot();
  fs.writeFileSync(path.join(root, 'WORK.md'), MULTI_WORK);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run'), caps: { maxIterations: 0 } });
  assert.equal(r.status, 'paused', 'should pause on cap breach');
  assert.ok(types(events(r)).has('circuit_breaker'), 'circuit_breaker emitted');
  assert.ok(fs.existsSync(path.join(root, 'run', 'PAUSED')), 'PAUSED marker written');
  assert.equal(r.metrics.tasksCompleted, 0, 'no tasks ran');
});

await t('cache accounting: reused stable prefix bills cached tokens', async () => {
  const root = mkroot();
  writeAgent(root, 'case');
  // two serial tasks, same owner → identical stable prefix → 2nd call cached
  const work = `---\ncontroller: case\n---\n\`\`\`task\nid: a\ntitle: a\nstatus: todo\nowner: case\nobjective: step one [S1]\nblockedBy: []\n\`\`\`\n\`\`\`task\nid: b\ntitle: b\nstatus: todo\nowner: case\nobjective: step two [S1]\nblockedBy: [a]\nfinal: true\n\`\`\`\n`;
  fs.writeFileSync(path.join(root, 'WORK.md'), work);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run') });
  assert.ok(r.metrics.cacheHitPct > 0, `expected cache hit > 0, got ${r.metrics.cacheHitPct}`);
  assert.ok(types(events(r)).has('cache_path_checked'), 'cache_path_checked emitted');
});

await t('lean path: single small task sets lean flag (slim prefix)', async () => {
  const root = mkroot();
  writeAgent(root, 'case');
  const r = await runWork({ cwd: root, task: 'Summarize the topic into a short verdict with assumptions and next actions.', agent: 'case', providerName: 'mock', runDir: path.join(root, 'run') });
  const cl = events(r).find((e) => e.type === 'context_loaded');
  assert.equal(cl.data.lean, true, 'single small task should use lean path');
  assert.equal(r.status, 'completed');
  // a multi-task run must NOT be lean
  const root2 = mkroot();
  fs.writeFileSync(path.join(root2, 'WORK.md'), MULTI_WORK);
  const r2 = await runWork({ cwd: root2, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root2, 'run') });
  assert.equal(events(r2).find((e) => e.type === 'context_loaded').data.lean, false, 'multi-task run is not lean');
});

await t('resume self-test: interrupt + resume from checkpoint, measured evidence', async () => {
  const root = mkroot();
  fs.writeFileSync(path.join(root, 'WORK.md'), MULTI_WORK);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run'), resumeSelftest: true });
  const evs = events(r);
  assert.ok(types(evs).has('interrupt_simulated'), 'interrupt_simulated emitted');
  const cr = evs.find((e) => e.type === 'checkpoint_resume_checked');
  assert.ok(cr, 'checkpoint_resume_checked emitted');
  assert.equal(cr.data.passed, true, 'resume passed');
  assert.equal(cr.data.completedAfterResume, true, 'completed after resume');
  assert.equal(r.status, 'completed');
  assert.equal(r.metrics.tasksCompleted, 3);
});

await t('HITL gate: risky task requests + approves BEFORE the action', async () => {
  const root = mkroot();
  writeAgent(root, 'case');
  const r = await runWork({ cwd: root, task: 'Write a file and call shell; irreversible actions need approval.', agent: 'case', providerName: 'mock', runDir: path.join(root, 'run'), risk: 'irreversible', autoApprove: true });
  const evs = events(r);
  const gr = evs.find((e) => e.type === 'gate_requested');
  assert.ok(gr && gr.data.approvedBeforeAction === true, 'gate_requested.approvedBeforeAction true');
  const gaIdx = evs.findIndex((e) => e.type === 'gate_approved');
  const callIdx = evs.findIndex((e) => e.type === 'provider_call_started');
  assert.ok(gaIdx >= 0 && callIdx >= 0 && gaIdx < callIdx, 'approval must precede the action (provider call)');
  assert.equal(r.status, 'completed');
});

await t('HITL gate: risky task with NO approval is blocked before action', async () => {
  const root = mkroot();
  writeAgent(root, 'case');
  const r = await runWork({ cwd: root, task: 'delete production data', agent: 'case', providerName: 'mock', runDir: path.join(root, 'run'), risk: 'irreversible', autoApprove: false });
  const ty = types(events(r));
  assert.ok(ty.has('gate_blocked'), 'gate_blocked emitted when not approved');
  assert.ok(!ty.has('provider_call_started'), 'no provider call when blocked');
});

await t('efficiency: sub-tasks routed to cheaper model + trimmed tokens; synthesis gets full budget', async () => {
  const root = mkroot();
  for (const a of ['marcus', 'taylor', 'case']) writeAgent(root, a);
  fs.writeFileSync(path.join(root, 'WORK.md'), MULTI_WORK);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run'), subModel: 'cheap-1', intermediateMaxTokens: 120, maxTokens: 800 });
  const starts = events(r).filter((e) => e.type === 'provider_call_started');
  const sub = starts.filter((e) => e.data.role === 'sub');
  const syn = starts.filter((e) => e.data.role === 'synthesis');
  assert.ok(sub.length >= 2, 'the two research tasks are sub-tasks');
  assert.equal(syn.length, 1, 'exactly one synthesis task');
  assert.ok(sub.every((e) => e.data.model === 'cheap-1'), 'sub-tasks routed to the cheaper model');
  assert.ok(sub.every((e) => e.data.maxTokens === 120), 'sub-tasks use trimmed maxTokens');
  assert.equal(syn[0].data.maxTokens, 800, 'synthesis uses the full budget');
  assert.equal(r.status, 'completed');
});

await t('deterministic step: mechanical task runs with NO provider call (0 tokens)', async () => {
  const root = mkroot();
  writeAgent(root, 'researcher'); writeAgent(root, 'lead');
  const work = `---\ncontroller: lead\n---\n\`\`\`task\nid: r1\ntitle: research\nstatus: todo\nowner: researcher\nobjective: find facts [S1]\nblockedBy: []\n\`\`\`\n\`\`\`task\nid: merge\ntitle: merge findings\nstatus: todo\nowner: lead\ndeterministic: true\nop: merge\nblockedBy: [r1]\nfinal: true\n\`\`\`\n`;
  fs.writeFileSync(path.join(root, 'WORK.md'), work);
  const r = await runWork({ cwd: root, workFile: 'WORK.md', providerName: 'mock', runDir: path.join(root, 'run') });
  const evs = events(r);
  assert.ok(types(evs).has('deterministic_step'), 'deterministic_step emitted');
  assert.equal(evs.filter((e) => e.type === 'provider_call_started' && e.data.taskId === 'merge').length, 0, 'deterministic task makes no provider call');
  assert.equal(evs.filter((e) => e.type === 'provider_call_started').length, 1, 'only the LLM task calls the provider');
  assert.equal(r.metrics.providerCalls, 1, 'provider calls = 1 (merge was free)');
  assert.equal(r.status, 'completed');
});

await t('compact-prefix: run completes with SOUL-only prefix', async () => {
  const root = mkroot(); writeAgent(root, 'case');
  const r = await runWork({ cwd: root, task: 'Summarize a topic into a verdict with assumptions and next actions', agent: 'case', providerName: 'mock', runDir: path.join(root, 'run'), compactPrefix: true });
  assert.equal(r.status, 'completed');
  assert.equal(r.verification.passed, true);
});

console.log(`\nruntime: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
