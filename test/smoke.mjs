// Smoke test — runs the deterministic core end to end in a temp dir.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffold, checkAgent, buildAgent, scanRegistry, estimateCost, parseFrontmatter } from '../lib/scroll.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-test-'));
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  \x1b[32m✔\x1b[0m', name); pass++; } catch (e) { console.log('  \x1b[31m✖\x1b[0m', name, '—', e.message); fail++; } };

t('scaffold creates an agent folder', () => {
  scaffold('echo', tmp);
  assert.ok(fs.existsSync(path.join(tmp, 'agents/echo/IDENTITY.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'agents/echo/SOUL.md')));
});

t('scaffold patches the name to match the folder', () => {
  const { frontmatter } = parseFrontmatter(fs.readFileSync(path.join(tmp, 'agents/echo/IDENTITY.md'), 'utf8'));
  assert.equal(frontmatter.name, 'echo');
});

t('check passes a scaffolded agent at L1 (ships hard-rules + 3 gold cases)', () => {
  const r = checkAgent('echo', tmp);
  assert.deepEqual(r.errors, [], 'expected no errors, got: ' + r.errors.join('; '));
  assert.equal(r.level, 'L1'); // v1.4: the scaffold is L1-ready out of the box
});

t('build writes runtime renderings', () => {
  const { written } = buildAgent('echo', tmp);
  assert.ok(written.length >= 1);
  assert.ok(fs.existsSync(path.join(tmp, 'agents/echo/.build/cowork/YourRole.md')));
});

t('build is deterministic (same input → same output)', () => {
  const a = fs.readFileSync(path.join(tmp, 'agents/echo/.build/cowork/YourRole.md'), 'utf8');
  buildAgent('echo', tmp);
  const b = fs.readFileSync(path.join(tmp, 'agents/echo/.build/cowork/YourRole.md'), 'utf8');
  assert.equal(a, b);
});

t('check flags an invalid agent (bad version)', () => {
  const idp = path.join(tmp, 'agents/echo/IDENTITY.md');
  const orig = fs.readFileSync(idp, 'utf8');
  fs.writeFileSync(idp, orig.replace('version: 1.0.0', 'version: nope'));
  const r = checkAgent('echo', tmp);
  assert.ok(r.errors.length > 0, 'expected an error for bad semver');
  fs.writeFileSync(idp, orig);
});

t('check flags name/folder mismatch', () => {
  scaffold('atlas', tmp);
  const idp = path.join(tmp, 'agents/atlas/IDENTITY.md');
  fs.writeFileSync(idp, fs.readFileSync(idp, 'utf8').replace('name: atlas', 'name: wrongname'));
  const r = checkAgent('atlas', tmp);
  assert.ok(r.errors.some((e) => /must equal folder name/.test(e)));
});

t('registry lists scaffolded agents', () => {
  const rows = scanRegistry(tmp);
  assert.ok(rows.find((r) => r.name === 'echo'));
});

t('cost estimate returns a single/multi recommendation', () => {
  const e = estimateCost('a short research task', 3);
  assert.equal(typeof e.preferSingle, 'boolean');
  assert.ok(e.single > 0 && e.multi > 0);
});

console.log(`\n${fail === 0 ? '\x1b[32m✔ all green\x1b[0m' : '\x1b[31m✖ failures\x1b[0m'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
