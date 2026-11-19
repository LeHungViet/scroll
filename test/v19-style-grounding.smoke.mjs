// SCROLL v1.9 style, voice hooks, presets, and reply grounding smoke (§43):
// 16 Fable grounding cases · speaks_as & machine-enforced style: · claim-preservation invariant ·
// 2 official Voice hooks (beforeTurn volatile suffix + shapeOutgoing post-grounding) ·
// 4 English setup presets (assistant|service|proxy|teammate) · mutation self-test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as GROUNDING from '../lib/grounding.js';
import * as STYLE from '../lib/style.js';
import * as SCROLL from '../lib/scroll.js';
import * as RUNTIME from '../lib/runtime.js';
import { auditRepo } from '../lib/audit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const BIN = path.join(HERE, '..', 'bin', 'scroll.js');
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  \x1b[32m✔\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m✖\x1b[0m ${name}\n    ${String(e.stack || e).split('\n').slice(0, 5).join('\n    ')}`); fail++; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v19-s4-'));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const events = (r) => fs.readFileSync(r.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const RETRIEVED_PRICE_LIST = [
  'SKU-A100: Classic Roast — 45,000 VND',
  'SKU-B200: Reserve Blend — 185,000 VND',
  'Promo valid until 2026-12-01 at https://shop.example/promo',
].join('\n');

const USER_MD = `---
principal:
  kind: org
  name: Cedar Roasters
  self: "I"
  call_others: "you"
  handoff: staff
people:
  - { id: ana, name: Ana Ruiz, call: Ana, role: owner, approve: [send, pay], max_amount: 5000, channels: [chat], channel_ids: ["zalo:ana"] }
  - { id: ben, name: Ben Ode, call: Ben, role: staff, approve: [send], channels: [chat], channel_ids: ["zalo:ben"] }
---
# About Cedar Roasters
Internal notes only.

## May say on behalf
- Shipping policy available at https://shop.example/shipping

## Must not say
- Unpublished discounts or inventory guarantees.
`;

console.log('v1.9 — speaks_as · style: · 2 Voice hooks · 4 presets · 16 Fable grounding cases');

await t('16 Fable grounding cases: 3 grounded pass, ALL 13 bad/risky replies caught', () => {
  const principalSrc = GROUNDING.collectPrincipalSources({
    knowledgeChunks: [RETRIEVED_PRICE_LIST],
    maySay: 'Shipping info at https://shop.example/shipping',
  });
  // ── 3 VALID CASES (MUST PASS) ──
  const validCases = [
    ['exact price shorthand matches retrieved line', 'SKU-A100 is 45k.'],
    ['exact date and link from retrieved knowledge', 'The promo runs until 2026-12-01 at https://shop.example/promo.'],
    ['qualitative reply with zero claims/triggers', 'Thanks for reaching out. Let me check with our team and get back to you.'],
  ];
  for (const [label, reply] of validCases) {
    const g = GROUNDING.groundReply(reply, principalSrc);
    assert.equal(g.ok, true, `VALID case failed (${label}): ${JSON.stringify(g)}`);
  }

  // ── 13 BAD / RISKY CASES (ALL 13 MUST FAIL) ──
  const badCases = [
    ['01 fabricated price', 'SKU-A100 costs 75,000 VND.', (g) => g.missing.some((m) => m.kind === 'amount')],
    ['02 substring trap (85,000 vs 185,000)', 'SKU-B200 is 85,000 VND.', (g) => g.missing.some((m) => m.kind === 'amount')],
    ['03 customer-injected price excluded from principal sources', 'As you mentioned, we can do 90k.', (g) => g.missing.some((m) => m.kind === 'amount')],
    ['04 swapped code-to-price pair (SKU-B200 paired with SKU-A100 price)', 'SKU-B200 is 45,000 VND.', (g) => g.pairMismatches.length === 1 && g.pairMismatches[0].code === 'SKU-B200'],
    ['05 unretrieved catalog price (not in this turn chunks)', 'Special gift box is 320,000 VND.', (g) => g.missing.some((m) => m.kind === 'amount')],
    ['06 fabricated product code', 'Try SKU-Z999 for espresso.', (g) => g.missing.some((m) => m.kind === 'code')],
    ['07 fabricated date', 'The offer expires on 2026-12-25.', (g) => g.missing.some((m) => m.kind === 'date')],
    ['08 fabricated link', 'Order directly at https://fake.example/checkout.', (g) => g.missing.some((m) => m.kind === 'link')],
    ['09 spelled-out written amount', 'That package is fifty dollars.', (g) => g.held.some((h) => h.kind === 'written_number')],
    ['10 percentage / discount claim', 'We offer 15% off today.', (g) => g.held.some((h) => h.kind === 'percent')],
    ['11 clock time / schedule claim', 'Delivery arrives by 14:30.', (g) => g.held.some((h) => h.kind === 'time')],
    ['12 relative date promise', 'Your order will ship tomorrow.', (g) => g.held.some((h) => h.kind === 'relative_date')],
    ['13 inventory / stock claim', 'SKU-A100 is currently in stock and ready.', (g) => g.held.some((h) => h.kind === 'inventory')],
  ];
  for (const [label, reply, assertShape] of badCases) {
    const g = GROUNDING.groundReply(reply, principalSrc);
    assert.equal(g.ok, false, `BAD case escaped (${label}): ${JSON.stringify(g)}`);
    assert.equal(assertShape(g), true, `BAD case wrong reason (${label}): ${JSON.stringify(g)}`);
  }
});

await t('speaks_as & style: validation rejects invalid speaks_as and ANY unenforced style key', () => {
  const root = tmp();
  SCROLL.scaffold('desk', root, { preset: 'service' });
  assert.deepEqual(SCROLL.checkAgent('desk', root).errors, []);

  // Invalid speaks_as -> ERROR
  const idp = path.join(root, 'agents', 'desk', 'IDENTITY.md');
  const orig = fs.readFileSync(idp, 'utf8');
  write(idp, orig.replace('speaks_as: org', 'speaks_as: rogue'));
  assert.ok(SCROLL.checkAgent('desk', root).errors.some((e) => /speaks_as/.test(e)));

  // Unenforced qualitative key in style: -> ERROR
  write(idp, orig.replace('follow_up: 0', 'follow_up: 0, warmth: 4'));
  assert.ok(SCROLL.checkAgent('desk', root).errors.some((e) => /style\.warmth has no machine enforcement/.test(e)));
  write(idp, orig);
});

await t('enforceStyle strips markdown/emojis/filler follow-ups, caps bubbles, preserves claims, and triggers max_chars retry', async () => {
  const raw = '**SKU-A100** is **45,000 VND** \u{1F600}\u{1F525}.\n\nPromo ends 2026-12-01.\n\nDetails at https://shop.example/promo.\n\nWould you like anything else?';
  const res = STYLE.enforceStyle(raw, { bubbles: 2, max_chars: 300, emoji: 0, follow_up: 0 });
  assert.equal(res.invariantOk, true);
  assert.equal(res.bubbles.length, 2, 'merged to <= 2 bubbles');
  assert.ok(!res.text.includes('**'), 'bold markdown stripped');
  assert.ok(!/\p{Extended_Pictographic}/u.test(res.text), 'emojis stripped when emoji=0');
  assert.ok(!res.text.includes('Would you like anything else?'), 'filler follow-up stripped');
  assert.ok(res.text.includes('SKU-A100') && res.text.includes('45,000') && res.text.includes('2026-12-01') && res.text.includes('https://shop.example/promo'), 'all claims preserved');

  // Verify max_chars regenerate once -> still over -> hold
  const root = tmp();
  SCROLL.scaffold('cs', root, { preset: 'service' });
  const idp = path.join(root, 'agents', 'cs', 'IDENTITY.md');
  write(idp, fs.readFileSync(idp, 'utf8').replace('max_chars: 300', 'max_chars: 60'));
  write(path.join(root, 'USER.md'), USER_MD);
  let calls = 0;
  const prov = {
    name: 'verbose', model: 'v-1', ready: true,
    async generate() {
      calls++;
      return {
        text: '## Verdict\nSKU-A100 is 45,000 VND and here is a very long verbose explanation that stays way past sixty characters.',
        usage: { uncachedInputTokens: 10, cachedInputTokens: 0, outputTokens: 20 },
        durationMs: 1, responseId: `v-${calls}`,
      };
    },
  };
  const r = await RUNTIME.runWork({
    cwd: root, agent: 'cs', task: 'Price of SKU-A100?',
    provider: prov, runDir: path.join(root, 'run-maxlen'),
    knowledgeChunks: [RETRIEVED_PRICE_LIST],
    turn: { sender: { channelId: 'zalo:guest' }, autoSendExternal: true },
  });
  assert.equal(calls, 2, 'regenerates at most once on max_chars breach');
  assert.equal(r.outbox[0].decision, 'hold');
  assert.ok(r.outbox[0].reasons.includes('style_max_chars_exceeded'));
});

await t('2 official Voice hooks: beforeTurn stays volatile/cache-safe, rejects bare sliders; shapeOutgoing runs post-grounding + invariant check', async () => {
  const root = tmp();
  SCROLL.scaffold('helper', root, { preset: 'assistant' });
  write(path.join(root, 'USER.md'), USER_MD);
  const seen = [];
  const prov = {
    name: 'cap', model: 'c-1', ready: true,
    async generate(prompt, opts) {
      seen.push({ prompt, cachePrefix: opts.cachePrefix });
      return {
        text: '## Verdict\nSKU-A100 is 45,000 VND [S1].\n\n## Evidence\n- price list [S1]\n\n## Next actions\n- done',
        usage: { uncachedInputTokens: 10, cachedInputTokens: 0, outputTokens: 10 },
        durationMs: 1, responseId: 'vh-1',
      };
    },
  };

  // 1) Good hooks: beforeTurn appends concrete wording AFTER deliverable, cachePrefix unchanged; shapeOutgoing formats cleanly
  const rOk = await RUNTIME.runWork({
    cwd: root, agent: 'helper', task: 'Price of SKU-A100?',
    provider: prov, runDir: path.join(root, 'run-vh-ok'),
    knowledgeChunks: [RETRIEVED_PRICE_LIST],
    turn: { sender: { channelId: 'zalo:guest' }, autoSendExternal: true },
    voiceHooks: {
      beforeTurn: () => ({ guidance: 'Keep the reply crisp and direct. Answer in one short sentence.' }),
      shapeOutgoing: ({ rawText }) => ({ bubbles: ['SKU-A100 is 45,000 VND.'], reaction: 'ok' }),
    },
  });
  assert.ok(!seen[0].cachePrefix.includes('Keep the reply crisp'), 'beforeTurn guidance NEVER mutates stablePrefix cache');
  assert.ok(seen[0].prompt.endsWith('</turn-guidance>'), 'beforeTurn guidance sits at the very end of volatile prompt');
  assert.equal(rOk.outbox[0].decision, 'send');
  assert.equal(rOk.outbox[0].invariantOk, true);
  assert.ok(typeof rOk.outbox[0].shapedHash === 'string' && rOk.outbox[0].shapedHash.length === 16);
  assert.deepEqual(rOk.outbox[0].bubbles, ['SKU-A100 is 45,000 VND.']);

  // 2) Bad beforeTurn with bare numeric slider -> rejected; bad shapeOutgoing mutating price -> invariant_violation + held + reverted
  const rBad = await RUNTIME.runWork({
    cwd: root, agent: 'helper', task: 'Price of SKU-A100?',
    provider: prov, runDir: path.join(root, 'run-vh-bad'),
    knowledgeChunks: [RETRIEVED_PRICE_LIST],
    turn: { sender: { channelId: 'zalo:guest' }, autoSendExternal: true },
    voiceHooks: {
      beforeTurn: () => ({ guidance: 'Use warmth: 4/5 and humor: 3/5.' }),
      shapeOutgoing: () => ({ bubbles: ['SKU-A100 is 40,000 VND.'] }), // mutated price!
    },
  });
  assert.ok(events(rBad).some((e) => e.type === 'voice_hook_rejected' && e.data.reason === 'bare_number_slider_forbidden'));
  assert.ok(!seen[1].prompt.includes('warmth: 4/5'), 'bare numeric slider never enters prompt');
  assert.equal(rBad.outbox[0].decision, 'hold');
  assert.ok(rBad.outbox[0].reasons.includes('invariant_violation'));
  assert.ok(rBad.outbox[0].text.includes('45,000'), 'reverted to uncorrupted rawText');
});

await t('4 English setup presets scaffold cleanly via CLI, pass scroll check L1 and scroll audit', () => {
  const root = tmp();
  const runCli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' });
  const expected = {
    assistant: 'self',
    service: 'org',
    proxy: 'owner',
    teammate: 'self',
  };
  for (const [preset, speaksAs] of Object.entries(expected)) {
    const name = `ag-${preset}`;
    const res = runCli('new', name, '--preset', preset);
    assert.equal(res.status, 0, `scroll new --preset ${preset} failed: ${res.stderr}`);
    const chk = SCROLL.checkAgent(name, root);
    assert.deepEqual(chk.errors, [], `${preset} check errors: ${chk.errors.join('; ')}`);
    assert.equal(chk.level, 'L1');
    const ag = SCROLL.loadAgent(name, root);
    assert.equal(ag.frontmatter.speaks_as, speaksAs);
  }
  const aud = auditRepo(root);
  assert.equal(aud.verdict, 'pass', JSON.stringify(aud));
  // Unknown preset fails cleanly
  assert.notEqual(runCli('new', 'bad', '--preset', 'invalid').status, 0);
});

// ── mutation self-test ──────────────────────────────────────────────────────────────────────
const absImports = (src) => src.replace(/(from |import\()'\.\/([a-z-]+\.js)'/g, (_, k, f) => `${k}'${pathToFileURL(path.join(LIB, f)).href}'`);
const SRC = {
  grounding: absImports(fs.readFileSync(path.join(LIB, 'grounding.js'), 'utf8')),
  style: absImports(fs.readFileSync(path.join(LIB, 'style.js'), 'utf8')),
  scroll: absImports(fs.readFileSync(path.join(LIB, 'scroll.js'), 'utf8')),
  runtime: absImports(fs.readFileSync(path.join(LIB, 'runtime.js'), 'utf8')),
};
async function mutant(file, find, replace) {
  assert.ok(SRC[file].includes(find), `mutation anchor not found in ${file}: ${find}`);
  const f = path.join(tmp(), `${file}-mut-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(f, SRC[file].replace(find, replace));
  return import(pathToFileURL(f).href);
}

const KILLERS = [
  ['grounding', 'same-line code-price pair mismatch caught',
    'if (!allowed.has(a.value)) {',
    'if (false) {',
    (M) => M.groundReply('SKU-B200 is 45,000 VND.', RETRIEVED_PRICE_LIST).ok === false],
  ['grounding', 'hold triggers catch percentages/times/relative dates/inventory',
    'const held = checkHoldTriggers ? detectHoldClaims(text) : [];',
    'const held = [];',
    (M) => M.groundReply('15% off if ordered tomorrow.', RETRIEVED_PRICE_LIST).ok === false],
  ['grounding', 'verifyClaimsInvariant catches mutated amount',
    'const ok = before.length === after.length && before.every((v, i) => v === after[i]);',
    'const ok = true;',
    (M) => M.verifyClaimsInvariant('Price is 45,000 VND.', 'Price is 40,000 VND.').ok === false],
  ['style', 'unenforced style key fails validation',
    'if (!ENFORCED_STYLE_KEYS.has(k)) {',
    'if (false) {',
    (M) => M.validateStyle({ warmth: 4 }).errors.length > 0],
  ['style', 'bare numeric slider detector catches warmth: 4/5',
    'return BARE_SLIDER_RE.test(String(text ?? \'\'));',
    'return false;',
    (M) => M.hasBareNumericSlider('Set warmth: 4/5') === true],
  ['style', 'bubble cap merges overflow bubbles',
    'if (!maxBubbles || rawChunks.length <= maxBubbles) return rawChunks;',
    'return rawChunks;',
    (M) => M.enforceStyle('Line one.\nLine two.\nLine three.', { bubbles: 2 }).bubbles.length === 2],
  ['scroll', 'invalid speaks_as fails checkAgent',
    'if (fm.speaks_as !== undefined && !SPEAKS_AS_VALUES.has(String(fm.speaks_as))) {',
    'if (false) {',
    (M) => {
      const root = tmp(); SCROLL.scaffold('s', root, { preset: 'service' });
      const p = path.join(root, 'agents', 's', 'IDENTITY.md');
      write(p, fs.readFileSync(p, 'utf8').replace('speaks_as: org', 'speaks_as: bad'));
      return M.checkAgent('s', root).errors.length > 0;
    }],
  ['runtime', 'beforeTurn rejects bare numeric sliders',
    'if (hasBareNumericSlider(rawGuidance)) {',
    'if (false) {',
    async (M) => {
      const root = tmp(); SCROLL.scaffold('h', root, { preset: 'assistant' });
      const seen = [];
      const prov = { name: 'c', model: 'c', ready: true, async generate(p) { seen.push(p); return { text: '## Verdict\nOk [S1].\n\n## Evidence\n- x [S1]\n\n## Next actions\n- y', usage: { uncachedInputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, durationMs: 1, responseId: '1' }; } };
      await M.runWork({ cwd: root, agent: 'h', task: 'Hi [S1]', provider: prov, runDir: path.join(root, 'run'), voiceHooks: { beforeTurn: () => ({ guidance: 'humor: 4/5' }) } });
      return !seen[0].includes('humor: 4/5');
    }],
  ['runtime', 'shapeOutgoing invariant violation holds and reverts',
    'if (!inv.ok) {',
    'if (false) {',
    async (M) => {
      const root = tmp(); SCROLL.scaffold('h', root, { preset: 'assistant' }); write(path.join(root, 'USER.md'), USER_MD);
      const prov = { name: 'c', model: 'c', ready: true, async generate() { return { text: '## Verdict\nSKU-A100 is 45,000 VND [S1].\n\n## Evidence\n- x [S1]\n\n## Next actions\n- y', usage: { uncachedInputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, durationMs: 1, responseId: '1' }; } };
      const r = await M.runWork({ cwd: root, agent: 'h', task: 'Price?', provider: prov, runDir: path.join(root, 'run'), knowledgeChunks: [RETRIEVED_PRICE_LIST], turn: { sender: { channelId: 'zalo:g' }, autoSendExternal: true }, voiceHooks: { shapeOutgoing: () => ({ bubbles: ['SKU-A100 is 12,000 VND.'] }) } });
      return r.outbox[0].reasons.includes('invariant_violation');
    }],
  ['runtime', 'groundReply blocks fabricated price on external turn',
    'if (!groundingRes.ok) {',
    'if (false) {',
    async (M) => {
      const root = tmp(); SCROLL.scaffold('h', root, { preset: 'service' }); write(path.join(root, 'USER.md'), USER_MD);
      const prov = { name: 'c', model: 'c', ready: true, async generate() { return { text: '## Verdict\nSKU-A100 is 99,000 VND [S1].\n\n## Evidence\n- x [S1]\n\n## Next actions\n- y', usage: { uncachedInputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, durationMs: 1, responseId: '1' }; } };
      const r = await M.runWork({ cwd: root, agent: 'h', task: 'Price?', provider: prov, runDir: path.join(root, 'run'), knowledgeChunks: [RETRIEVED_PRICE_LIST], turn: { sender: { channelId: 'zalo:g' }, autoSendExternal: true } });
      return r.outbox[0].decision === 'hold';
    }],
];

await t(`mutation self-test: ${KILLERS.length} planted S4 bugs, each must be killed`, async () => {
  const survivors = [];
  for (const [file, name, find, rep, check] of KILLERS) {
    const real = file === 'grounding' ? GROUNDING : file === 'style' ? STYLE : file === 'scroll' ? SCROLL : RUNTIME;
    assert.equal(await check(real), true, `check "${name}" must pass on real code`);
    if ((await check(await mutant(file, find, rep))) === true) survivors.push(name);
  }
  console.log(`    killed ${KILLERS.length - survivors.length}/${KILLERS.length}${survivors.length ? ' · survived: ' + survivors.join(', ') : ''}`);
  assert.deepEqual(survivors, [], `surviving mutants: ${survivors.join(', ')}`);
});

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) process.exit(1);
