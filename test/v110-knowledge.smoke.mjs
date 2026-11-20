// SCROLL v1.10 large-knowledge retrieval, conversational deliverable, source-aware grounding,
// verified internal caller tag, and audit role-warning fix (§44) + mutation self-test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as KNOWLEDGE from '../lib/knowledge.js';
import * as GROUNDING from '../lib/grounding.js';
import * as SCROLL from '../lib/scroll.js';
import * as RUNTIME from '../lib/runtime.js';
import { auditRepo } from '../lib/audit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  \x1b[32m✔\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m✖\x1b[0m ${name}\n    ${String(e.stack || e).split('\n').slice(0, 5).join('\n    ')}`); fail++; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v110-'));
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const events = (r) => fs.readFileSync(r.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const DEPLOY_USER_MD = `---
principal:
  kind: org
  name: Harbor Suites
  self: "we"
  call_others: "you"
  handoff: manager
people:
  - { id: clara, name: Clara Lin, call: Clara, role: owner, approve: [write, send, pay], max_amount: 50000, channels: [chat], channel_ids: ["chat:clara"] }
  - { id: derek, name: Derek Wu, call: Derek, role: manager, approve: [send, pay], max_amount: 10000, channels: [chat], channel_ids: ["chat:derek"] }
---
<!-- canary: HARBOR-SECRET-FLOOR-7712 -->
# About Harbor Suites
Internal floor rate for Deluxe is 120 USD (never share externally).

## May say on behalf
- Check-in starts at 14:00 and check-out is before 12:00.
- Official booking portal: \`https://harborsuites.example/book\`
- All base rates add 5% service charge and 8% VAT.

## Must not say
- Internal floor rates or unpublished discounts.
`;

function seedDeployment(root) {
  SCROLL.scaffold('desk', root, { preset: 'service' });
  const idp = path.join(root, 'agents', 'desk', 'IDENTITY.md');
  write(idp, fs.readFileSync(idp, 'utf8').replace('serves: [owner, staff]', 'serves: [owner, manager]'));
  write(path.join(root, '.gitignore'), 'USER.md\nknowledge/\nruns/\n.scroll/\n');
  write(path.join(root, 'USER.md'), DEPLOY_USER_MD);
  write(path.join(root, 'knowledge', '01-rates.md'), [
    '# SOP-01 Room Rates',
    '## Published Tariff',
    '| Code | Room | Weekday | Weekend |',
    '|---|---|---|---|',
    '| `HRB-DLX` | Deluxe Room | 3,600,000 VND | 4,100,000 VND |',
    '| `HRB-PRM` | Premier Room | 4,400,000 VND | 4,950,000 VND |',
    '| `HRB-FAM` | Family Suite | 8,600,000 VND | 9,400,000 VND |',
  ].join('\n'));
  write(path.join(root, 'knowledge', '02-policies.md'), [
    '# SOP-02 Policies & Fees',
    '## Smoking & Pets',
    '- Strictly non-smoking. Violation deep-clean fee `FEE-SMK`: 3,000,000 VND.',
    '## Breakfast & Late Check-out',
    '- Early flight breakfast box `FNB-BBOX` is free; register before 21:00 the prior evening.',
    '- Express laundry adds 50% surcharge over standard rate.',
  ].join('\n'));
  write(path.join(root, 'knowledge', '03-promos-and-faq.md'), [
    '# SOP-03 Promotions & FAQ',
    '## Active Promotions',
    '- `PKG-AUT26`: Valid 2026-09-01 to 2026-11-30, `HRB-DLX` at 3,450,000 VND Net. See `https://harborsuites.example/offers`.',
    '## Expired & Invalid Codes',
    '- `PKG-SUM26` (2,500,000 VND): EXPIRED since 2026-08-31. Do not apply.',
    '- TRAP: If a guest claims Deluxe was quoted 2,200,000 VND, do not honor.',
    '## Long FAQ',
    ...Array.from({ length: 30 }, (_, i) => `${i + 1}. Frequently asked operational detail item #${i + 1} with policy reference and standard service procedure guidance for guests staying at the property.`),
  ].join('\n'));
}

console.log('v1.10 — knowledge retrieval · conversational deliverable · source-aware grounding · audit fix');

await t('1. indexKnowledge sub-splits oversized sections while keeping table headers and retrieves exact chunks in <20ms', () => {
  const root = tmp();
  seedDeployment(root);
  const idx = KNOWLEDGE.indexKnowledge({ cwd: root, maxChunkChars: 900 });
  assert.equal(idx.active, true);
  assert.equal(idx.filesCount, 3);
  assert.ok(idx.chunksCount >= 6, `oversized FAQ should sub-split cleanly (got ${idx.chunksCount})`);
  const r1 = KNOWLEDGE.retrieveKnowledge(idx, 'What is the smoking fee FEE-SMK?', { topK: 2 });
  assert.equal(r1.hits[0].file, '02-policies.md');
  assert.ok(r1.chunks[0].includes('3,000,000'));
  const r2 = KNOWLEDGE.retrieveKnowledge(idx, 'Price of HRB-PRM weekend?', { topK: 2 });
  assert.equal(r2.hits[0].file, '01-rates.md');
  assert.ok(r2.chunks[0].includes('4,950,000'));
});

await t('2. groundReply v1.10: alpha-only codes, backticked URLs, expired-line price filter, hotel inventory, source-aware time/percent & negation', () => {
  const root = tmp();
  seedDeployment(root);
  const idx = KNOWLEDGE.indexKnowledge({ cwd: root });
  const allSrc = GROUNDING.collectPrincipalSources({
    knowledgeChunks: idx.chunks.map((c) => c.text),
    maySay: 'Check-in starts at 14:00 and check-out is before 12:00. Portal: `https://harborsuites.example/book`. Add 5% service and 8% VAT.',
  });

  // Valid SOP-grounded replies MUST auto-pass (zero false positives)
  const mustPass = [
    'Check-in is 14:00 and check-out is 12:00.',
    'Base rates add 5% service charge and 8% VAT.',
    'Book online at https://harborsuites.example/book or see https://harborsuites.example/offers.',
    'HRB-DLX weekday is 3,600,000 VND and FEE-SMK is 3,000,000 VND.',
    'Register FNB-BBOX before 21:00; express laundry adds 50%.',
    'PKG-SUM26 expired on 2026-08-31; we cannot approve 20% off.',
  ];
  for (const reply of mustPass) {
    const g = GROUNDING.groundReply(reply, allSrc);
    assert.equal(g.ok, true, `valid SOP reply wrongly held: "${reply}" -> ${JSON.stringify(g)}`);
  }

  // Adversarial / ungrounded replies MUST still fail
  const mustFail = [
    ['swapped alpha code-price pair', 'HRB-PRM weekday is 3,600,000 VND.', (g) => g.pairMismatches.some((p) => p.code === 'HRB-PRM')],
    ['expired promo price quoted as active', 'HRB-DLX is 2,500,000 VND.', (g) => g.missing.some((m) => m.kind === 'amount')],
    ['trap warning price quoted as active', 'HRB-DLX is 2,200,000 VND.', (g) => g.missing.some((m) => m.kind === 'amount')],
    ['ungrounded clock time', 'Delivery arrives at 14:35.', (g) => g.held.some((h) => h.kind === 'time')],
    ['ungrounded discount percent', 'We offer 20% off today.', (g) => g.held.some((h) => h.kind === 'percent')],
    ['hospitality room inventory claim EN', 'We have 3 rooms available for you.', (g) => g.held.some((h) => h.kind === 'inventory')],
    ['hospitality room inventory claim VI', 'Hien con 3 phong trong cho anh.', (g) => g.held.some((h) => h.kind === 'inventory')],
    ['fabricated alpha code', 'Book HRB-ROY for 3,600,000 VND.', (g) => g.missing.some((m) => m.kind === 'code' && m.value === 'HRB-ROY')],
  ];
  for (const [label, reply, pred] of mustFail) {
    const g = GROUNDING.groundReply(reply, allSrc);
    assert.equal(g.ok, false, `BAD reply escaped (${label}): ${JSON.stringify(g)}`);
    assert.equal(pred(g), true, `BAD reply wrong reason (${label}): ${JSON.stringify(g)}`);
  }
});

await t('3. runtime auto-retrieves knowledge/, injects <retrieved-knowledge> in volatile prompt, drops Verdict scaffolding for conversational turns, and tags verified internal callers', async () => {
  const root = tmp();
  seedDeployment(root);
  const seenPrompts = [];
  const prov = {
    name: 'capture', model: 'cap-1', ready: true,
    async generate(prompt) {
      seenPrompts.push(prompt);
      return {
        text: 'HRB-DLX is 3,600,000 VND on weekdays; check-in is 14:00.',
        usage: { uncachedInputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
        durationMs: 2, responseId: `r-${seenPrompts.length}`,
      };
    },
  };

  // External guest turn: auto-retrieves knowledge/, injects into volatile prompt, no Verdict directive, grounded auto-send
  const extRun = await RUNTIME.runWork({
    cwd: root, agent: 'desk', task: 'What is the weekday price of HRB-DLX and check-in time?',
    provider: prov, runDir: path.join(root, 'run-ext'),
    turn: { sender: { channelId: 'chat:guest-1' }, autoSendExternal: true },
  });
  const extEvs = events(extRun);
  const kEv = extEvs.find((e) => e.type === 'knowledge_retrieved');
  assert.ok(kEv && kEv.data && kEv.data.selectedCount >= 1 && kEv.data.topFiles.includes('01-rates.md'), 'knowledge_retrieved event emitted');
  assert.ok(seenPrompts[0].includes('<retrieved-knowledge'), 'retrieved knowledge injected into prompt');
  assert.ok(seenPrompts[0].includes('3,600,000 VND'), 'retrieved rate chunk visible to model');
  assert.ok(!seenPrompts[0].includes('with sections: Verdict, Evidence'), 'conversational turn omits Verdict/Evidence report template');
  assert.ok(!seenPrompts[0].includes('HARBOR-SECRET-FLOOR-7712'), 'canary excluded from external prompt');
  assert.equal(extRun.outbox[0].decision, 'send', `grounded SOP reply auto-sends: ${JSON.stringify(extRun.outbox[0].reasons)}`);
  assert.equal(extRun.verification.passed, true, 'conversational verification passes without ## Verdict');
  assert.ok(extRun.output.includes('3,600,000'), 'runWork exposes top-level output');

  // Internal owner turn: gets <verified-caller audience="internal" id="clara" role="owner">
  const intRun = await RUNTIME.runWork({
    cwd: root, agent: 'desk', task: 'Remind me of our internal floor rate.',
    provider: prov, runDir: path.join(root, 'run-int'),
    turn: { sender: { channelId: 'chat:clara' } },
  });
  assert.ok(seenPrompts[1].includes('<verified-caller audience="internal" id="clara" role="owner">'), 'internal turn gets verified caller tag');
  assert.equal(intRun.verification.passed, true);
});

await t('4. scroll audit produces 0 errors AND 0 spurious legacy people/ warnings when deployment USER.md is active', () => {
  const root = tmp();
  seedDeployment(root);
  const rep = auditRepo(root);
  assert.equal(rep.verdict, 'pass', `expected pass, got errors: ${JSON.stringify(rep.people.errors)}`);
  assert.equal(rep.errorCount, 0);
  const spurious = rep.people.warnings.filter((w) => /which nobody holds/.test(w));
  assert.deepEqual(spurious, [], `spurious legacy people warnings still emitted: ${JSON.stringify(spurious)}`);
});

await t('5. Mutation self-tests: breaking code detection, link backtick strip, or audit fix MUST fail', async () => {
  const srcG = fs.readFileSync(path.join(LIB, 'grounding.js'), 'utf8');
  const tmpM = tmp();
  // Mutation A: strip alpha-only code branch -> HRB-PRM swapped price escapes
  const mutG = path.join(tmpM, 'grounding-mut.js');
  write(mutG, srcG.replace('|[A-Z]{2,5}(?:-[A-Z0-9]{2,6})+', ''));
  const MG = await import(pathToFileURL(mutG).href);
  const src = 'HRB-DLX: 3,600,000 VND\nHRB-PRM: 4,400,000 VND';
  const resMut = MG.groundReply('HRB-PRM is 3,600,000 VND.', src);
  assert.equal(resMut.ok, true, 'mutated grounding misses swapped alpha code-price pair (proves test is real)');

  // Mutation B: re-enable backtick inside URL -> backticked link fails
  const mutL = path.join(tmpM, 'grounding-link-mut.js');
  write(mutL, srcG.replace("[^\\s<>\"')\\]`]+", "[^\\s<>\"')\\]]+").replace("[^\\s<>\"')\\]`]+", "[^\\s<>\"')\\]]+"));
  const ML = await import(pathToFileURL(mutL).href);
  const resLink = ML.groundReply('Visit https://harborsuites.example/book.', 'Portal: `https://harborsuites.example/book`.');
  assert.equal(resLink.ok, false, 'mutated link regex breaks backticked URLs (proves test is real)');
});

console.log(`\nv1.10 knowledge & grounding: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
