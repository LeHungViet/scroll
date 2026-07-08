// SCROLL v1.6 — per-task engine routing + arg builders (Team Code upgrade).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWork, runWork } from '../lib/runtime.js';
import { codexArgs, grokArgs } from '../lib/providers.js';

const WORK = `---
controller: lead
---
# team-code pipeline

\`\`\`task
id: build
title: Build the feature
status: todo
owner: engineer
engine: mock
effort: xhigh
sandbox: write
workdir: .
timeout_ms: 1200000
objective: Implement the spec.
output_format: code
boundaries: [do not edit acceptance tests]
blockedBy: []
\`\`\`

\`\`\`task
id: qa
title: QA the build
status: todo
owner: qa
engine: mock
effort: max
objective: Verify the build against acceptance criteria.
output_format: decision-ready markdown
boundaries: [read-only]
blockedBy: [build]
final: true
\`\`\`
`;

test('parseWork picks up v1.6 fields (engine/effort/sandbox/workdir/timeout_ms)', () => {
  const w = parseWork(WORK);
  assert.equal(w.tasks.length, 2);
  const [build, qa] = w.tasks;
  assert.equal(build.engine, 'mock');
  assert.equal(build.effort, 'xhigh');
  assert.equal(build.sandbox, 'write');
  assert.equal(build.workdir, '.');
  assert.equal(build.timeout_ms, 1200000);
  assert.equal(qa.engine, 'mock');
  assert.equal(qa.effort, 'max');
  assert.equal(qa.sandbox, null);
});

test('codexArgs: write + xhigh → workspace-write, explicit effort, stdin prompt', () => {
  const args = codexArgs({ sandbox: 'write', effort: 'xhigh', model: 'gpt-5.5' });
  assert.ok(args.includes('workspace-write'));
  assert.ok(!args.includes('read-only'));
  const ci = args.indexOf('-c');
  assert.ok(ci > -1 && args[ci + 1] === 'model_reasoning_effort="xhigh"');
  assert.equal(args.at(-1), '-'); // prompt via stdin
  assert.ok(args.includes('gpt-5.5'));
});

test('codexArgs: default stays read-only (backward compatible)', () => {
  const args = codexArgs({});
  assert.ok(args.includes('read-only'));
  assert.ok(!args.includes('workspace-write'));
  assert.ok(args.includes('--ephemeral'));
});

test('grokArgs: default = read-first QA profile (dontAsk, deny Write, workspace sandbox)', () => {
  const args = grokArgs({ effort: 'high' });
  assert.ok(args.includes('--no-auto-update'));
  assert.ok(args.includes('dontAsk'));
  assert.ok(args.includes('workspace'));
  const di = args.indexOf('--deny');
  assert.ok(di > -1 && args[di + 1] === 'Write');
  assert.ok(!args.includes('acceptEdits'));
  const ei = args.indexOf('--effort');
  assert.ok(ei > -1 && args[ei + 1] === 'high');
});

test('grokArgs: sandbox write → acceptEdits, no deny list', () => {
  const args = grokArgs({ sandbox: 'write' });
  assert.ok(args.includes('acceptEdits'));
  assert.ok(!args.includes('--deny'));
});

test('runWork routes per-task engine and records it in events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v16-'));
  fs.writeFileSync(path.join(dir, 'WORK.md'), WORK);
  const res = await runWork({ cwd: dir, workFile: 'WORK.md', providerName: 'mock' });
  assert.equal(res.status, 'completed');
  const events = fs.readFileSync(res.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const calls = events.filter((e) => e.type === 'provider_call_started');
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.data.engine, 'mock');
  const qaCall = calls.find((c) => c.data.taskId === 'qa');
  assert.equal(qaCall.data.effort, 'max');
});
