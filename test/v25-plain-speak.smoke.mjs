// SCROLL 2.5.11 -- Channel-Agnostic PlainSpeak Engine Gate (ASTRA/FABLE/CARBON Council Invariants INV-PS-1..5 & §13/§43).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffold } from '../index.js';
import {
  createScrollChatRuntime,
  createPlainSpeakEngine,
  validatePlainSpeakPack,
  verifyExtendedPlainSpeakInvariant,
} from '../lib/chat-sdk/index.js';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
    pass++;
  } catch (e) {
    console.error(`  ✖ ${name} -- ${e?.stack || e}`);
    fail++;
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v25-plainspeak-'));
console.log('SCROLL 2.5.11 -- Channel-Agnostic PlainSpeak Engine & Council Invariants (INV-PS-1..5)');

const SAMPLE_VI_PACK = {
  schemaVersion: 1,
  id: 'core-vi-test',
  locale: 'vi',
  domain: 'core',
  protectedTerms: ['01/KHBS', 'TK 332', 'TT 99/2025/TT-BTC'],
  registerSignals: {
    expertPatterns: ['\\b(?:rls|webhook|sql|mutex|tk\\s*\\d{3,4}|01\\/khbs|\\[43\\])\\b'],
    clientPlainPatterns: ['\\b(?:hộ\\s+kinh\\s+doanh|nộp\\s+thuế|xuất\\s+hóa\\s+đơn)\\b'],
    confusionFeedbackPatterns: ['\\blà\\s+(?:cái\\s+)?gì\\b', '\\bchấm\\s+mù\\?'],
  },
  entries: [
    { term: 'chấm mù', plain: 'che tên rồi chấm', tier: 'A', action: 'hint' },
    { term: 'nhằm mục đích', plain: 'để', tier: 'A', action: 'swap' },
    { term: 'điều đáng chú ý là', plain: '', tier: 'A', action: 'swap' },
    { term: 'có cơ sở', plain: 'có lý do rõ ràng', tier: 'A', action: 'hint', excludePatterns: ['có\\s+cơ\\s+sở\\s+(?:kinh\\s+doanh|sản\\s+xuất|hạ\\s+tầng)'] },
    { term: 'độ trễ', plain: 'chậm mấy giây', tier: 'B', action: 'hint' },
    { term: 'ngữ cảnh', plain: 'đầu đuôi câu chuyện', tier: 'B', action: 'hint' },
    { term: 'khấu trừ đầu vào', plain: 'trừ thuế đã trả lúc mua', tier: 'C', action: 'gloss' },
  ],
};

await t('Pack schema validator rejects Tier C swap & enforces structured data packs', () => {
  assert.equal(validatePlainSpeakPack(SAMPLE_VI_PACK).ok, true);
  const badTierC = validatePlainSpeakPack({
    schemaVersion: 1,
    id: 'bad',
    locale: 'vi',
    entries: [{ term: 'tạm nộp', plain: 'nộp trước', tier: 'C', action: 'swap' }],
  });
  assert.equal(badTierC.ok, false, 'Tier C legal/domain terms must NEVER allow action="swap"');
});

await t('INV-PS-1 & INV-PS-2: Extended legal/form/TK/percent/time invariant, protected spans & polysemy exclusion', () => {
  // Extended invariant catches legal form code / TK / [43] / percent / time drift missed by basic checks
  assert.equal(
    verifyExtendedPlainSpeakInvariant('Nộp 01/KHBS và ghi TK 332 chỉ tiêu [43] mức 10% lúc 14:30', 'Nộp tờ khai bổ sung và ghi phải trả chỉ tiêu [43] mức 10% lúc 14:30').ok,
    false,
    'Dropping 01/KHBS or TK 332 MUST fail extended invariant',
  );
  assert.equal(
    verifyExtendedPlainSpeakInvariant('Nộp 01/KHBS và ghi TK 332 chỉ tiêu [43] mức 10% lúc 14:30', 'Nộp 01/KHBS, ghi TK 332 ở mục [43], thuế 10% trước 14:30').ok,
    true,
    'Preserving all structured legal/form/TK/percent/time tokens passes extended invariant',
  );

  const engine = createPlainSpeakEngine({ packs: [SAMPLE_VI_PACK], config: { locale: 'vi' } });

  // Safe 0-token swap works outside protected spans, while preserving inline code, quotes, URLs, and legal citations!
  const f1 = engine.applyDeterministicFilter(
    'Điều đáng chú ý là anh gửi file `nhằm mục đích` và "nhằm mục đích" nhằm mục đích nộp 01/KHBS tại https://example.com/nhằm',
  );
  assert.equal(f1.invariantOk, true);
  assert.ok(f1.text.includes('`nhằm mục đích`'), 'Inline code must NEVER be touched');
  assert.ok(f1.text.includes('"nhằm mục đích"'), 'Quoted text must NEVER be touched');
  assert.ok(f1.text.includes('để nộp 01/KHBS'), 'Unprotected filler swapped cleanly to "để"');
  assert.ok(!f1.text.toLowerCase().startsWith('điều đáng chú ý là'), 'Leading filler removed cleanly');

  // Polysemy exclusion: "có cơ sở kinh doanh tại Hà Nội" must NOT be flagged!
  const polyAudit = engine.auditText('Công ty anh có cơ sở kinh doanh tại Hà Nội.');
  assert.equal(polyAudit.tierAHits.length, 0, 'Polysemy exclusion must protect "có cơ sở kinh doanh"');
});

await t('INV-PS-3 & INV-PS-4 & INV-PS-5: 1x bounded rewrite with grounding/negation/ratio gates, caller mirroring, expert_peer passthrough & write-only telemetry', async () => {
  const stateDir = path.join(tmpRoot, 'ps-state');
  const engine = createPlainSpeakEngine({
    packs: [SAMPLE_VI_PACK],
    stateDir,
    accountId: 'jen03',
    config: { locale: 'vi', rewriteEnabled: true, rewriteTimeoutMs: 2000 },
  });

  // 1. Direct calque ("chấm mù") triggers 1x ephemeral rewrite -> cleanly simplifies to everyday Vietnamese!
  let rewriteCalls = 0;
  const goodRes = await engine.processOutgoing({
    rawReply: 'Cùng một đề, anh chấm mù, bên nào viết tốt hơn thì thắng',
    register: 'casual_human',
    provider: {
      ready: true,
      async generate(_p, opts) {
        rewriteCalls += 1;
        assert.equal(opts.ephemeral, true, 'Rewrite MUST be ephemeral (never pollutes main thread)');
        assert.equal(opts.tools, undefined, 'Rewrite MUST have zero tools');
        return { text: 'Cùng một đề, anh che tên rồi chấm, bên nào viết tốt hơn thì thắng' };
      },
    },
    channel: 'telegram',
  });
  assert.equal(rewriteCalls, 1);
  assert.equal(goodRes.rewritten, true);
  assert.ok(goodRes.text.includes('che tên rồi chấm'));
  assert.ok(!goodRes.text.includes('chấm mù'));

  // 2. Rewrite that hallucinates/mutates a tax code or flips negation MUST be rejected and reverted!
  const badTaxRes = await engine.processOutgoing({
    rawReply: 'Anh không cần chấm mù khi nộp 01/KHBS cho TK 332 trước 17:00',
    register: 'client_plain',
    provider: {
      ready: true,
      async generate() {
        return { text: 'Anh cần che tên rồi chấm khi nộp tờ khai bổ sung trước 17:00' }; // dropped 01/KHBS, TK 332, AND flipped negation!
      },
    },
  });
  assert.equal(badTaxRes.rewritten, false, 'Mutating legal code or flipping negation MUST reject rewrite');
  assert.ok(badTaxRes.text.includes('01/KHBS') && badTaxRes.text.includes('TK 332') && badTaxRes.text.includes('không'));

  // 3. INV-PS-3 XOR guard: if groundingSelfHealed OR active_latch OR turnDurationMs > 6000 -> ZERO rewrite call!
  let skippedCalls = 0;
  const skipProvider = { ready: true, async generate() { skippedCalls += 1; return { text: 'nope' }; } };
  await engine.processOutgoing({ rawReply: 'Anh chấm mù đi', register: 'casual_human', groundingSelfHealed: true, provider: skipProvider });
  await engine.processOutgoing({ rawReply: 'Anh chấm mù đi', register: 'casual_human', triggerKind: 'active_latch', provider: skipProvider });
  await engine.processOutgoing({ rawReply: 'Anh chấm mù đi', register: 'casual_human', turnDurationMs: 7500, provider: skipProvider });
  assert.equal(skippedCalls, 0, 'INV-PS-3 budget/XOR/active_latch guards must skip rewrite cleanly');

  // 4. INV-PS-4: 3-turn caller mirroring & expert_peer passthrough
  const regExpert = engine.detectRegister({
    incomingText: 'Check giúp anh RLS webhook với TK 1331 trên 01/KHBS nhé',
    recentUserTexts: ['Đo độ trễ giúp anh'],
  });
  assert.equal(regExpert.register, 'expert_peer');
  assert.equal(regExpert.userUsedTerms.has('độ trễ'), true, '3-turn mirroring remembers caller terms');
  const auditMirrored = engine.auditText('Độ trễ webhook đang ổn.', { register: 'casual_human', userUsedTerms: regExpert.userUsedTerms });
  assert.equal(auditMirrored.tierBHits.length, 0, 'Never flag/rewrite a term the user themselves used');

  // 5. INV-PS-5: Telemetry file is write-only structured JSONL containing ZERO raw user prose / MST / URLs!
  const telRaw = fs.readFileSync(engine.telemetryPath, 'utf8');
  assert.ok(telRaw.includes('"term":"chấm mù"'));
  assert.ok(!telRaw.includes('Cùng một đề'), 'Telemetry MUST NOT log raw message prose');
});

await t('§13 Region-A prefixHash Byte-Stability inside createScrollChatRuntime across register switches', async () => {
  const work = path.join(tmpRoot, 'deploy');
  const stateDir = path.join(tmpRoot, 'chat-state');
  fs.mkdirSync(work, { recursive: true });
  scaffold('demo', work);

  const engine = createPlainSpeakEngine({
    packs: [SAMPLE_VI_PACK],
    stateDir,
    accountId: 'demo',
    config: { locale: 'vi', rewriteEnabled: true },
  });

  let callIdx = 0;
  const seenPrompts = [];
  const rt = await createScrollChatRuntime({
    agentName: 'demo',
    deploymentDir: work,
    stateDir,
    plainSpeak: engine,
    provider: {
      name: 'mock-ps',
      model: 'mock-1',
      ready: true,
      async generate(prompt, opts) {
        callIdx += 1;
        seenPrompts.push({ prompt, messages: JSON.stringify(opts?.messages || []), system: opts?.system || '', ephemeral: Boolean(opts?.ephemeral) });
        if (opts?.ephemeral) {
          return { text: 'Anh che tên rồi chấm, bên nào viết tốt hơn thì thắng.' };
        }
        return { text: 'Nhằm mục đích công bằng, anh chấm mù, bên nào viết tốt hơn thì thắng.' };
      },
      async close() {},
    },
  });

  // Turn 1: casual_human register -> swaps "Nhằm mục đích" -> "Để" + rewrites "chấm mù" -> "che tên rồi chấm"!
  const t1 = await rt.sendTurn({
    conversationId: 'room-1',
    text: 'Thử so sánh giúp anh đi',
    sender: { id: 'u1', name: 'Eric' },
    channel: 'zalo',
  });
  assert.ok(t1.text.includes('che tên rồi chấm'), `Expected plain Vietnamese rewrite, got: ${t1.text}`);
  assert.ok(!t1.text.includes('chấm mù'));
  assert.equal(t1.plainSpeak?.rewritten, true);

  // Turn 2: expert_peer register in SAME room -> Region A prefixHash MUST remain 100% BYTE-IDENTICAL!
  const t2 = await rt.sendTurn({
    conversationId: 'room-1',
    text: 'Check RLS webhook và 01/KHBS với TK 1331',
    sender: { id: 'u1', name: 'Eric' },
    channel: 'zalo',
  });
  assert.equal(t1.prefixHash, t2.prefixHash, '§13 HARD INVARIANT: PlainSpeak register switch MUST NEVER mutate Region A prefixHash!');
  assert.ok(seenPrompts[0].messages.includes('[PlainSpeak · casual_human]'), 'Pre-gen cue injected strictly in Region C');
  assert.ok(!seenPrompts[0].system.includes('[PlainSpeak'), 'Region A systemPrompt stays 100% clean');
  assert.equal(t2.plainSpeak?.register, 'expert_peer');
  await rt.close();
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nSCROLL v2.5.11 PlainSpeak Gate: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
