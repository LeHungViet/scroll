// SCROLL v1.9 loader smoke — hard-rules.md reaches every runtime and build path (§6, §13)
// + context_loaded reports { files, chars }.
//
// Why: previously 5 paths dropped hard-rules.md (compact/lean prefix in runtime.js;
// claude-subagent, codex, gemini and voice targets in buildAgent). Every path must carry
// hard-rules.md and any allowed context block, and removing hard-rules from any single path
// must kill a mutant.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as SCROLL from '../lib/scroll.js';
import * as RUNTIME from '../lib/runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  \x1b[32m✔\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m✖\x1b[0m ${name}\n    ${String(e.stack || e).split('\n').slice(0, 5).join('\n    ')}`); fail++; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v19-loader-'));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const events = (r) => fs.readFileSync(r.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const RULE_MARKER = 'NEVER_LEAK_SECRETS_HR_991';
const USER_BLOCK = '<principal snapshot="abcd1234">\nAllowed principal note for this turn.\n</principal>';

function mkAgent(root, name = 'warden', runtimes = ['cowork', 'claude-subagent', 'codex', 'gemini', 'voice']) {
  const dir = path.join(root, 'agents', name);
  write(path.join(dir, 'IDENTITY.md'), [
    '---',
    `name: ${name}`,
    `title: ${name}`,
    'version: 1.0.0',
    'language: en',
    `runtimes: [${runtimes.join(', ')}]`,
    'model: { primary: mock-1 }',
    'capabilities: [fs.read]',
    'serves: [owner]',
    '---',
    `${name} identity summary.`,
  ].join('\n'));
  write(path.join(dir, 'SOUL.md'), `${name} writes concisely and checks facts.\n`);
  write(path.join(dir, 'TOOLS.md'), 'fs.read:\n  description: read files\n');
  write(path.join(dir, 'hard-rules.md'), `# Hard rules\n- ${RULE_MARKER}: refuse unverified external writes.\n`);
  return dir;
}

function capture() {
  const prompts = [];
  return {
    prompts,
    provider: {
      name: 'capture', model: 'capture-1', ready: true,
      async generate(prompt) {
        prompts.push(prompt);
        return {
          text: '## Verdict\nDone [S1].\n\n## Evidence\n- verified [S1]\n\n## Next actions\n- proceed',
          usage: { uncachedInputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
          durationMs: 1, responseId: 'cap-1',
        };
      },
    },
  };
}

console.log('v1.9 — loader: hard-rules on every path · context_loaded {files, chars}');

await t('runtime leanSingle path loads hard-rules.md and emits context_loaded { files, chars }', async () => {
  const root = tmp(); mkAgent(root, 'warden');
  const cap = capture();
  const r = await RUNTIME.runWork({
    cwd: root, agent: 'warden', task: 'Summarize status [S1].',
    provider: cap.provider, runDir: path.join(root, 'run-lean'),
  });
  assert.equal(r.status, 'completed');
  assert.equal(cap.prompts.length, 1);
  assert.ok(cap.prompts[0].includes(RULE_MARKER), 'leanSingle prompt must include hard-rules.md');
  const cl = events(r).find((e) => e.type === 'context_loaded');
  assert.ok(cl, 'context_loaded event emitted');
  assert.equal(cl.data.lean, true);
  assert.ok(Array.isArray(cl.data.files) && cl.data.files.includes('hard-rules.md'), `context_loaded.files missing hard-rules.md: ${JSON.stringify(cl.data)}`);
  assert.ok(cl.data.files.includes('SOUL.md'), 'context_loaded.files includes SOUL.md');
  assert.ok(typeof cl.data.chars === 'number' && cl.data.chars > RULE_MARKER.length, 'context_loaded.chars reports prefix size');
});

await t('runtime explicit compactPrefix path loads hard-rules.md', async () => {
  const root = tmp(); mkAgent(root, 'warden');
  const work = '---\ncontroller: warden\n---\n```task\nid: a\ntitle: a\nstatus: todo\nowner: warden\nobjective: step a [S1]\noutput_format: md\nboundaries: [stay brief]\nblockedBy: []\n```\n```task\nid: b\ntitle: b\nstatus: todo\nowner: warden\nobjective: step b [S1]\noutput_format: md\nboundaries: [stay brief]\nblockedBy: [a]\nfinal: true\n```\n';
  write(path.join(root, 'WORK.md'), work);
  const cap = capture();
  const r = await RUNTIME.runWork({
    cwd: root, workFile: 'WORK.md', compactPrefix: true,
    provider: cap.provider, runDir: path.join(root, 'run-compact'),
  });
  assert.equal(r.status, 'completed');
  assert.equal(cap.prompts.length, 2);
  for (const p of cap.prompts) assert.ok(p.includes(RULE_MARKER), 'compactPrefix prompt must include hard-rules.md');
  const cls = events(r).filter((e) => e.type === 'context_loaded');
  assert.equal(cls.length, 2);
  for (const cl of cls) {
    assert.ok(cl.data.files.includes('hard-rules.md'), 'every compact context_loaded lists hard-rules.md');
    assert.ok(cl.data.chars > 0);
  }
});

await t('runtime full prefix path loads hard-rules.md and reports all loaded files in context_loaded', async () => {
  const root = tmp(); mkAgent(root, 'warden');
  const work = '---\ncontroller: warden\n---\n```task\nid: a\ntitle: a\nstatus: todo\nowner: warden\nobjective: full check [S1]\noutput_format: md\nboundaries: [cite]\nblockedBy: []\nfinal: true\n```\n';
  write(path.join(root, 'WORK.md'), work);
  const cap = capture();
  const r = await RUNTIME.runWork({
    cwd: root, workFile: 'WORK.md', compactPrefix: false,
    provider: cap.provider, runDir: path.join(root, 'run-full'),
  });
  assert.equal(r.status, 'completed');
  assert.ok(cap.prompts[0].includes(RULE_MARKER), 'full prompt must include hard-rules.md');
  const cl = events(r).find((e) => e.type === 'context_loaded');
  assert.ok(cl.data.files.includes('IDENTITY.md'));
  assert.ok(cl.data.files.includes('SOUL.md'));
  assert.ok(cl.data.files.includes('TOOLS.md'));
  assert.ok(cl.data.files.includes('hard-rules.md'));
  assert.ok(cl.data.chars > RULE_MARKER.length);
});

await t('buildAgent includes hard-rules.md (and optional allowed userBlock) across ALL 5 text targets', () => {
  const root = tmp(); mkAgent(root, 'warden');
  const { written } = SCROLL.buildAgent('warden', root, { userBlock: USER_BLOCK });
  const expectedFiles = [
    'agents/warden/.build/cowork/YourRole.md',
    'agents/warden/.build/claude-subagent/warden.md',
    'agents/warden/.build/codex/warden.prompt.md',
    'agents/warden/.build/gemini/warden.prompt.md',
    'agents/warden/.build/voice/warden.prompt.md',
  ];
  for (const relPath of expectedFiles) {
    assert.ok(written.includes(relPath), `missing built file ${relPath}`);
    const body = fs.readFileSync(path.join(root, relPath), 'utf8');
    assert.ok(body.includes(RULE_MARKER), `${relPath} must include hard-rules.md`);
    assert.ok(body.includes('Allowed principal note'), `${relPath} must include optional userBlock when supplied`);
  }
});

await t('loadAgent respects custom IDENTITY.hard_rules path inside agent dir and blocks traversal', () => {
  const root = tmp();
  const dir = mkAgent(root, 'custom');
  write(path.join(dir, 'rules', 'strict.md'), 'CUSTOM_HARD_RULE_777\n');
  const idp = path.join(dir, 'IDENTITY.md');
  write(idp, fs.readFileSync(idp, 'utf8').replace('serves: [owner]', 'serves: [owner]\nhard_rules: ./rules/strict.md'));
  const a = SCROLL.loadAgent('custom', root);
  assert.ok(a.hardRules.includes('CUSTOM_HARD_RULE_777'));
  // traversal outside agent dir must fall back safely and never read outside
  write(path.join(root, 'secret.txt'), 'OUTSIDE_SECRET_999');
  write(idp, fs.readFileSync(idp, 'utf8').replace('./rules/strict.md', '../../secret.txt'));
  const a2 = SCROLL.loadAgent('custom', root);
  assert.ok(!String(a2.hardRules || '').includes('OUTSIDE_SECRET_999'), 'hard_rules traversal blocked');
});

// ── mutation self-test: dropping hard-rules from ANY path must be killed ────────────────────
const absImports = (src) => src.replace(/(from |import\()'\.\/([a-z-]+\.js)'/g, (_, k, f) => `${k}'${pathToFileURL(path.join(LIB, f)).href}'`);
const SRC = {
  runtime: absImports(fs.readFileSync(path.join(LIB, 'runtime.js'), 'utf8')),
  scroll: absImports(fs.readFileSync(path.join(LIB, 'scroll.js'), 'utf8')),
};
async function mutant(file, find, replace) {
  assert.ok(SRC[file].includes(find), `mutation anchor not found in ${file}: ${find}`);
  const f = path.join(tmp(), `${file}-mut-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(f, SRC[file].replace(find, replace));
  return import(pathToFileURL(f).href);
}

const KILLERS = [
  ['runtime', 'compact path keeps hard-rules',
    "addCtx('hard-rules.md', agent && agent.hardRules ? agent.hardRules : ''),",
    "'',",
    async (M) => {
      const root = tmp(); mkAgent(root, 'warden'); const cap = capture();
      await M.runWork({ cwd: root, agent: 'warden', task: 'Tiny check [S1].', provider: cap.provider, runDir: path.join(root, 'run') });
      return cap.prompts[0].includes(RULE_MARKER);
    }],
  ['runtime', 'full path keeps hard-rules',
    "addCtx('hard-rules.md', agent && agent.hardRules ? agent.hardRules : ''), // full-hr",
    "'', // full-hr",
    async (M) => {
      const root = tmp(); mkAgent(root, 'warden'); const cap = capture();
      await M.runWork({ cwd: root, agent: 'warden', task: 'Full check [S1].', compactPrefix: false, provider: cap.provider, runDir: path.join(root, 'run') });
      return cap.prompts[0].includes(RULE_MARKER);
    }],
  ['scroll', 'cowork target keeps hard-rules',
    "a.hardRules ? '\\n## Hard rules\\n' + a.hardRules : '', // cowork-hr",
    "'' , // cowork-hr",
    (M) => {
      const root = tmp(); mkAgent(root, 'warden', ['cowork']); M.buildAgent('warden', root);
      return fs.readFileSync(path.join(root, 'agents/warden/.build/cowork/YourRole.md'), 'utf8').includes(RULE_MARKER);
    }],
  ['scroll', 'claude-subagent target keeps hard-rules',
    "a.hardRules ? '\\n## Hard rules\\n' + a.hardRules : '', // subagent-hr",
    "'' , // subagent-hr",
    (M) => {
      const root = tmp(); mkAgent(root, 'warden', ['claude-subagent']); M.buildAgent('warden', root);
      return fs.readFileSync(path.join(root, 'agents/warden/.build/claude-subagent/warden.md'), 'utf8').includes(RULE_MARKER);
    }],
  ['scroll', 'codex/gemini/voice targets keep hard-rules',
    "a.hardRules ? '\\n## Hard rules\\n' + a.hardRules : '', // generic-hr",
    "'' , // generic-hr",
    (M) => {
      const root = tmp(); mkAgent(root, 'warden', ['codex', 'gemini', 'voice']); M.buildAgent('warden', root);
      return ['codex', 'gemini', 'voice'].every((rt) =>
        fs.readFileSync(path.join(root, `agents/warden/.build/${rt}/warden.prompt.md`), 'utf8').includes(RULE_MARKER));
    }],
];

await t(`mutation self-test: ${KILLERS.length} planted loader bugs, each must be killed`, async () => {
  const survivors = [];
  for (const [file, name, find, rep, check] of KILLERS) {
    const real = file === 'runtime' ? RUNTIME : SCROLL;
    assert.equal(await check(real), true, `check "${name}" must pass on real code`);
    if ((await check(await mutant(file, find, rep))) === true) survivors.push(name);
  }
  console.log(`    killed ${KILLERS.length - survivors.length}/${KILLERS.length}${survivors.length ? ' · survived: ' + survivors.join(', ') : ''}`);
  assert.deepEqual(survivors, [], `surviving mutants: ${survivors.join(', ')}`);
});

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) process.exit(1);
