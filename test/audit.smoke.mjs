// Audit smoke test — `scroll audit` catches coding-agent deviations + binds a pass to a content hash.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffold } from '../lib/scroll.js';
import { auditRepo, verifyAgainstRecord } from '../lib/audit.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  \x1b[32m✔\x1b[0m', name); pass++; } catch (e) { console.log('  \x1b[31m✖\x1b[0m', name, '—', e.message); fail++; } };
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-audit-'));

t('clean scaffolded agent → PASS (warns on <3 evals, zero errors)', () => {
  const root = mkroot(); scaffold('atlas', root);
  const r = auditRepo(root);
  assert.equal(r.verdict, 'pass', `expected pass, errorCount=${r.errorCount}`);
  assert.equal(r.errorCount, 0);
  assert.ok(r.agents[0].warnings.some((w) => /eval/.test(w)), 'warns about <3 gold evals');
});

t('banned infra dependency → FAIL', () => {
  const root = mkroot(); scaffold('atlas', root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { langchain: '^0.1.0' } }));
  const r = auditRepo(root);
  assert.equal(r.verdict, 'fail');
  assert.ok(r.conventions.some((c) => c.rule === 'banned-infra' && c.severity === 'error'), 'flags banned-infra as error');
});

t('persona-in-code + hardcoded model → warnings (not a hard fail)', () => {
  const root = mkroot(); scaffold('atlas', root);
  fs.writeFileSync(path.join(root, 'app.js'), 'const systemPrompt = `You are an assistant that...`;\nconst model = "claude-3-5-haiku-latest";\n');
  const r = auditRepo(root);
  assert.ok(r.conventions.some((c) => c.rule === 'prompt-in-code'), 'flags prompt-in-code');
  assert.ok(r.conventions.some((c) => c.rule === 'hardcoded-model'), 'flags hardcoded-model');
  assert.equal(r.verdict, 'pass', 'warnings only → still pass (linter triage, not a gate)');
});

t('agents/ folder is NOT scanned for conventions (persona lives there legitimately)', () => {
  const root = mkroot(); scaffold('atlas', root);
  // SOUL.md legitimately contains "You are…" persona text — must not be flagged as prompt-in-code
  fs.writeFileSync(path.join(root, 'agents', 'atlas', 'SOUL.md'), 'You are Atlas, a careful synthesizer.');
  const r = auditRepo(root);
  assert.ok(!r.conventions.some((c) => /agents\//.test(c.file)), 'agents/ excluded from convention scan');
});

t('--verify: hash-bound record catches drift + missing record', () => {
  const root = mkroot(); scaffold('atlas', root);
  const r1 = auditRepo(root);
  fs.mkdirSync(path.join(root, '.scroll'), { recursive: true });
  fs.writeFileSync(path.join(root, '.scroll', 'audit.json'), JSON.stringify(r1, null, 2));
  assert.ok(verifyAgainstRecord(root, auditRepo(root)).ok, 'unchanged → verify ok');
  // edit an agent file after the audit → hash drift → verify must fail
  fs.appendFileSync(path.join(root, 'agents', 'atlas', 'SOUL.md'), '\nedited after audit');
  const v2 = verifyAgainstRecord(root, auditRepo(root));
  assert.ok(!v2.ok && /changed/.test(v2.reason), `drift caught: ${v2.reason}`);
  // a repo that never ran audit → no record → not trustworthy
  const root2 = mkroot(); scaffold('x', root2);
  const v3 = verifyAgainstRecord(root2, auditRepo(root2));
  assert.ok(!v3.ok && /never run|no .scroll/i.test(v3.reason), `missing record caught: ${v3.reason}`);
});

console.log(`\naudit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
