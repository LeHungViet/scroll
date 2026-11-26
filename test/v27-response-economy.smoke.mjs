// SCROLL 2.7 (§51) Smoke & 2-Way Mutation Test Suite — Response Economy & Outcome-Only Runtime
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkAgent,
  auditRepo,
  verifyCompressionInvariant,
  validateEconomy,
  classifyTurnBudget,
  escalateEffortForRound,
  renderAnswerContractCue,
  createChatSessionRuntime,
} from '../index.js';
import {
  auditResponseEconomy,
  applyDeterministicEconomyTrim,
  createResponseEconomyEngine,
  createPlainSpeakEngine,
} from '../lib/chat-sdk/index.js';

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

async function main() {
  // 1. Machine-enforced `IDENTITY.economy` schema validation (2-way)
  ok(validateEconomy({
    mode: 'outcome_only',
    effort_routing: 'fixed',
    links: 'on_request',
    process_narration: 'suppress',
    echo_guard: 'strict',
    default_follow_up: 0,
    compress_llm: true,
    max_chars_brief: 380,
  }).errors.length === 0, 'valid economy config passes');
  ok(validateEconomy({ mode: 'magic' }).errors.length === 1, 'invalid economy.mode rejected');
  ok(validateEconomy({ tone_slider: 5 }).errors.length === 1, 'unknown economy key rejected');
  ok(validateEconomy({ effort_routing: 'random' }).errors.length === 1, 'invalid effort_routing rejected');

  // 2. Subset-Safe Compression Invariant (`verifyCompressionInvariant`) — 2-way mutation test!
  const bloatedTax = [
    'Phải anh. Hộ kinh doanh thuê nhân viên hợp đồng từ đủ 1 tháng thì thường phải đóng bảo hiểm bắt buộc cho họ, không phụ thuộc doanh thu hộ trên hay dưới 1 tỷ đồng một năm.',
    'Thông thường, hộ đóng 21,5% và nhân viên đóng 10,5% trên mức lương làm căn cứ đóng, gồm BHXH, BHYT và bảo hiểm thất nghiệp. Một số trường hợp như làm bán thời gian, thử việc hoặc đã hưởng lương hưu cần xét riêng theo từng hồ sơ cụ thể. [Nguồn: Cổng BHXH](https://example.gov.vn/doc-2026.pdf)',
    'Anh muốn em tính bảng lương mẫu không?',
  ].join('\n');
  const cleanTax = 'Phải anh, cứ ký hợp đồng từ 1 tháng trở lên là phải đóng (hộ 21,5%, nhân viên 10,5%), không phụ thuộc doanh thu 1 tỷ.';
  ok(verifyCompressionInvariant(bloatedTax, cleanTax, { requireShorter: true }).ok === true, 'subset compression dropping unsolicited URL & caveat PASSES');

  // Hostile mutations MUST fail RED!
  const mutatedRate = 'Phải anh, hộ đóng 20%, nhân viên 10,5% cho hợp đồng từ 1 tháng.';
  const invMutRate = verifyCompressionInvariant(bloatedTax, mutatedRate, { requireShorter: true });
  ok(invMutRate.ok === false && invMutRate.reason === 'fabricated_or_mutated_claim', 'mutated percent 21,5% -> 20% FAILS RED');

  const fabricatedAmt = 'Phải anh, đóng tối thiểu 500.000đ mỗi tháng.';
  ok(verifyCompressionInvariant(bloatedTax, fabricatedAmt).ok === false, 'fabricated amount 500.000đ FAILS RED');

  const flippedNeg = verifyCompressionInvariant('Chưa nộp anh nhé. Bản tiếng Anh vẫn đang ở đây.', 'Đã nộp bản tiếng Anh rồi anh.');
  ok(flippedNeg.ok === false && flippedNeg.reason === 'negation_polarity_flipped', 'flipped negation Chưa -> Đã FAILS RED');

  const dungVsDung = verifyCompressionInvariant(
    'Đã lưu quy trình r. Mỗi lần sẽ bám đúng mẫu, gửi anh duyệt và kèm ảnh sau khi cập nhật.',
    'Đã lưu rồi anh.',
    { requireShorter: true },
  );
  ok(dungVsDung.ok === true, 'Unicode negation guard does NOT confuse "đúng" (correct) with "đừng" (do not)');

  const expanded = verifyCompressionInvariant(
    'Xóa rồi anh.',
    'Xóa rồi anh, em đã kiểm tra rất kỹ toàn bộ bảng và giữ nguyên các dòng quan trọng.',
    { requireShorter: true },
  );
  ok(expanded.ok === false && expanded.reason === 'not_shorter', 'expansion rejected when requireShorter=true');

  // 3. Turn Intent Router + Decoupled Brain Effort (`fixed` default vs opt-in `auto` 6-gate allowlist)
  const econFixed = { mode: 'outcome_only', effort_routing: 'fixed', links: 'on_request', echo_guard: 'strict', process_narration: 'suppress' };
  const ackFixed = classifyTurnBudget({ text: 'Ok em. Báo cáo hàng ngày kiểu này e ghi nhớ bước làm nhé.', economy: econFixed, configuredEffort: 'ultra' });
  ok(ackFixed.shape === 'ack_confirm', 'classifies rule-reminder ack as ack_confirm');
  ok(ackFixed.effectiveEffort === 'ultra', 'effort_routing=fixed NEVER downgrades ultra effort');
  ok(ackFixed.targetMaxChars <= 75 && ackFixed.allowedFollowUps === 0, 'ack_confirm locks tight surface budget');

  const delCmd = classifyTurnBudget({ text: 'E xoá đi', economy: { ...econFixed, effort_routing: 'auto' }, configuredEffort: 'ultra' });
  ok(delCmd.shape === 'action_exec', 'classifies "E xoá đi" as action_exec');
  ok(delCmd.effectiveEffort === 'ultra', 'auto fail-high NEVER downgrades mutating delete command');

  const pushback = classifyTurnBudget({ text: '@bot a thấy k ổn. E xem pa lại', economy: { ...econFixed, effort_routing: 'auto' }, configuredEffort: 'ultra' });
  ok(pushback.shape === 'complex_analysis' && pushback.isPushback === true, 'classifies pushback as complex_analysis');
  ok(pushback.effectiveEffort === 'ultra', 'auto fail-high preserves ultra on pushback');

  const trivialAckAuto = classifyTurnBudget({ text: 'Ok em, nhớ bước làm nhé.', economy: { ...econFixed, effort_routing: 'auto' }, configuredEffort: 'ultra', isGroup: false });
  ok(trivialAckAuto.shape === 'ack_confirm' && trivialAckAuto.effectiveEffort === 'low', 'auto allowlist only steps down trivial DM ack');

  ok(escalateEffortForRound({ currentEffort: 'low', configuredEffort: 'ultra', toolCalled: true }) === 'high', 'tool call escalates low -> high');
  ok(escalateEffortForRound({ currentEffort: 'high', configuredEffort: 'ultra', toolError: true }) === 'ultra', 'tool error escalates high -> ultra');
  ok(escalateEffortForRound({ currentEffort: 'low', configuredEffort: 'ultra', groundingRetry: true }) === 'ultra', 'grounding retry escalates low -> ultra');

  const ynTax = classifyTurnBudget({ text: 'Hộ cá thể có phải đóng bhxh k', economy: econFixed, configuredEffort: 'ultra' });
  ok(ynTax.shape === 'status_yn' && ynTax.links === 'on_request' && ynTax.allowedFollowUps === 0, 'short Y/N policy question gets tight status_yn contract');

  const briefLookup = classifyTurnBudget({ text: 'Yêu cầu kê khai chủ sở hữu hưởng lợi như nào', economy: econFixed, configuredEffort: 'ultra' });
  ok(briefLookup.shape === 'lookup_brief' && briefLookup.suppressUnsolicitedTutorial === true, 'brief lookup suppresses unsolicited 1/2/3 tutorial');

  const pullSrc = classifyTurnBudget({ text: 'Gửi link nguồn xem nào', economy: econFixed, configuredEffort: 'ultra' });
  ok(pullSrc.shape === 'provenance_pull' && pullSrc.allowWorkLedgerPull === true && pullSrc.links === 'inline', 'provenance_pull unlocks links and Work Ledger');

  // 4. 0-Token Economy Auditor & Deterministic Trimmer
  const echoAudit = auditResponseEconomy({
    userText: 'Làm j mấy tác vụ này cũng gửi ảnh report anh',
    replyText: 'Nhớ rồi, từ nay làm các tác vụ kiểu này xong em sẽ gửi ảnh kèm báo cáo để anh kiểm tra. Ảnh bảng vừa gửi ở trên nhé anh',
    contract: ackFixed,
  });
  ok(echoAudit.ok === false, 'flags user-echo + process narration');
  ok(echoAudit.violations.some((v) => v.code === 'user_echo_parroting'), 'detects user_echo_parroting');
  ok(echoAudit.violations.some((v) => v.code === 'process_narration'), 'detects trailing obvious-image process narration');
  ok(echoAudit.needsLlmCompress === true, 'triggers bounded 1x LLM compression');

  const settledAudit = auditResponseEconomy({
    userText: 'Mày còn cần gì nữa?',
    recentUserTexts: ['Có nộp rồi. Phạt nộp tờ khai muộn tao nộp rồi', 'Nộp xong vào ngày 31/10 rồi'],
    replyText: 'Anh chuyển e ảnh giao dịch chuyển tiền phạt ngày 31/10 để đối chiếu nhé.',
    contract: briefLookup,
  });
  ok(settledAudit.violations.some((v) => v.code === 'settled_topic_reask'), 'detects re-asking proof on settled topic');

  const detTrim = applyDeterministicEconomyTrim({ replyText: bloatedTax, contract: ynTax });
  ok(detTrim.changed === true, 'deterministic trimmer strips unsolicited URL and trailing follow-up');
  ok(!detTrim.text.includes('https://example.gov.vn'), 'URL stripped from outgoing text');
  ok(!detTrim.text.endsWith('?'), 'unsolicited follow-up stripped');
  ok(detTrim.droppedLinks.includes('https://example.gov.vn/doc-2026.pdf'), 'dropped URL saved for Pull-on-Demand Work Ledger');
  ok(detTrim.text.includes('21,5%') && detTrim.text.includes('10,5%'), 'core rates preserved verbatim');

  // 5. Full ChatSessionRuntime E2E: auto-loads IDENTITY.economy, §13 prefixHash cache invariance,
  //    shared 1x post-gen LLM budget, clean compressed history, Pull-on-Demand Work Ledger, and scroll audit!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v27-'));
  try {
    const agentDir = path.join(tmpDir, 'agents', 'demo');
    fs.mkdirSync(path.join(agentDir, 'evals'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'IDENTITY.md'), [
      '---',
      'name: demo',
      'title: "Demo Minimalist Agent"',
      'version: 1.0.0',
      'runtimes: [codex]',
      'model:',
      '  primary: mock-ultra',
      'capabilities: [fs.read]',
      'language: vi',
      'style:',
      '  bubbles: 3',
      '  max_chars: 2800',
      '  emoji: 2',
      '  follow_up: 0',
      'economy:',
      '  mode: outcome_only',
      '  effort_routing: fixed',
      '  links: on_request',
      '  process_narration: suppress',
      '  echo_guard: strict',
      '  default_follow_up: 0',
      '  compress_llm: true',
      '  max_chars_brief: 380',
      '---',
      '# Demo Agent',
    ].join('\n'));
    // Deliberately bloated SOUL.md (>12KB) + conflicting Source Tagging to verify `scroll audit` catches both!
    fs.writeFileSync(path.join(agentDir, 'SOUL.md'), [
      '# Soul',
      'Concise helper.',
      '### Source Tagging',
      'mọi thông tin factual phải có nguồn: Tool -> Link',
      'x'.repeat(13000),
    ].join('\n'));
    fs.writeFileSync(path.join(agentDir, 'TOOLS.md'), '# Tools\n');
    fs.writeFileSync(path.join(agentDir, 'hard-rules.md'), '# Hard Rules\n1. Never fabricate.\n');

    const chk = checkAgent('demo', tmpDir);
    ok(chk.errors.length === 0, `checkAgent passes with economy frontmatter: ${chk.errors.join('; ')}`);

    const aud = auditRepo(tmpDir, { name: 'demo' });
    const demoWarn = aud.agents[0]?.warnings || [];
    ok(demoWarn.some((w) => w.includes('SOUL.md is') && w.includes('§51')), 'scroll audit warns on bloated SOUL.md > 12KB');
    ok(demoWarn.some((w) => w.includes('Source Tagging') && w.includes('§51')), 'scroll audit warns on SOUL Source Tagging vs economy.links conflict');

    // Mock provider: tracks effort, ephemeral compression call, and Region-A prefixHash invariance
    const calls = [];
    let ephemeralCalls = 0;
    const mockProvider = {
      name: 'mock',
      model: 'mock-ultra',
      ready: true,
      supportsTools: true,
      async generate(prompt, opts = {}) {
        if (opts.ephemeral) {
          ephemeralCalls++;
          ok(opts.effort === 'low', 'ephemeral compressor runs at effort=low');
          if (String(prompt).includes('TURN_SHAPE: ack_confirm')) {
            return { text: 'Nhớ rồi anh.', usage: { outputTokens: 5 } };
          }
          return { text: cleanTax, usage: { outputTokens: 30 } };
        }
        calls.push({ prompt, system: opts.system, effort: opts.effort });
        if (calls.length === 1) {
          return { text: bloatedTax, usage: { outputTokens: 150 } };
        }
        if (calls.length === 2) {
          return {
            text: 'Nhớ rồi, từ nay làm các tác vụ kiểu này xong em sẽ gửi ảnh kèm báo cáo để anh kiểm tra. Ảnh bảng vừa gửi ở trên nhé anh',
            usage: { outputTokens: 60 },
          };
        }
        // Turn 3: provenance_pull should see the previous Work Ledger URL in Region C!
        const lastMsg = Array.isArray(opts.messages) && opts.messages.length
          ? String(opts.messages[opts.messages.length - 1]?.content || '')
          : String(prompt || '');
        ok(lastMsg.includes('https://example.gov.vn/doc-2026.pdf'), 'provenance_pull injects Pull-on-Demand Work Ledger URL in Region C');
        return { text: 'Link nguồn đây anh: https://example.gov.vn/doc-2026.pdf', usage: { outputTokens: 20 } };
      },
    };

    let shapeHookBaselineOk = false;
    const psEngine = createPlainSpeakEngine({ enabled: true, mode: 'live', locale: 'vi', packs: [] });
    const stateDir = path.join(tmpDir, 'state');
    const rt = createChatSessionRuntime({
      agentName: 'demo',
      deploymentDir: tmpDir,
      stateDir,
      provider: mockProvider,
      plainSpeak: psEngine,
      voiceHooks: {
        async shapeOutgoing({ rawText }) {
          shapeHookBaselineOk = rawText.length < 180;
          return { text: rawText, bubbles: [rawText], meta: { shaped: true } };
        },
      },
    });

    // Turn 1: bloated 501c grounded reply on status_yn -> trimmed & compressed cleanly while keeping ultra effort!
    const t1 = await rt.sendTurn({
      conversationId: 'c1',
      text: 'Có phải đóng bảo hiểm cho nhân viên k',
      effort: 'ultra',
      extraPrincipalSources: [bloatedTax],
    });
    ok(calls[0].effort === 'ultra', 'main provider call kept effort=ultra');
    ok(t1.text.length < bloatedTax.length, 'Turn 1 compressed cleanly');
    ok(!t1.text.includes('https://example.gov.vn'), 'Turn 1 omitted unsolicited link');
    ok(t1.voiceMeta?.claimsInvariantFallback !== true, 'shapeOutgoing NOT rolled back after legitimate subset compression!');
    ok(shapeHookBaselineOk === true, 'shapeOutgoing received compressed baseline');
    ok(rt.getLastWorkLedger('c1')?.urls?.includes('https://example.gov.vn/doc-2026.pdf'), 'Work Ledger saved stripped URL');

    // Turn 2: ack_confirm echo -> compressed by 1x ephemeral pass into "Nhớ rồi anh." & Region-A prefixHash unchanged!
    const t2 = await rt.sendTurn({
      conversationId: 'c1',
      text: 'Làm j mấy tác vụ này cũng gửi ảnh report anh',
      effort: 'ultra',
    });
    ok(t2.prefixHash === t1.prefixHash, '§13 Region-A prefixHash 100% invariant across different turn shapes');
    ok(t2.text === 'Nhớ rồi anh.', `Turn 2 echo compressed to crisp ack (got: ${t2.text})`);
    ok(ephemeralCalls >= 1, 'bounded ephemeral compressor fired on echo violation');

    // Verify history persisted ONLY clean compressed replies (breaks self-poisoning!)
    const hist = rt.getHistory('c1').filter((m) => m.role === 'assistant');
    ok(hist.length === 2 && hist[1].content === 'Nhớ rồi anh.', 'session history persists clean compressed reply');

    // Turn 3: Pull-on-Demand provenance request retrieves saved URL!
    const t3 = await rt.sendTurn({
      conversationId: 'c1',
      text: 'Gửi link nguồn xem nào',
      effort: 'ultra',
      extraPrincipalSources: ['https://example.gov.vn/doc-2026.pdf'],
    });
    ok(t3.turnBudget.shape === 'provenance_pull', 'Turn 3 classified as provenance_pull');
    ok(t3.text.includes('https://example.gov.vn/doc-2026.pdf'), 'Turn 3 delivered URL on demand');

    // Verify telemetry file written with zero raw prose leak
    const telPath = path.join(stateDir, 'telemetry', 'economy-watch-demo.jsonl');
    ok(fs.existsSync(telPath), 'economy telemetry written');
    const telLines = fs.readFileSync(telPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(telLines.length >= 2 && typeof telLines[0].compressionRatio === 'number', 'telemetry rows contain structured compression metrics');

    await rt.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Regression: NEVER strip actionable deliverable URLs (Google Meet, iShow Doc, Notion) or colon-introduced links,
  // and inherit link intent from previous user turn on short follow-ups ("cho e quyền đó" after "có link họp chưa")!
  const meetReply = 'Anh SJ vừa gửi link trong nhóm rồi. Anh vào họp ở đây nhé: https://meet.google.com/rmv-sefu-hgm';
  const meetTrim = applyDeterministicEconomyTrim({
    replyText: meetReply,
    contract: { enabled: true, links: 'on_request', suppressProcessNarration: true, allowedFollowUps: 0 },
  });
  ok(meetTrim.text.includes('https://meet.google.com/rmv-sefu-hgm'), 'actionable Google Meet link MUST NOT be stripped');
  const docReply = 'Em gửi anh tài liệu đề xuất tại đây: https://doc.ishow.pro/s/abc12345';
  const docTrim = applyDeterministicEconomyTrim({
    replyText: docReply,
    contract: { enabled: true, links: 'none', suppressProcessNarration: true, allowedFollowUps: 0 },
  });
  ok(docTrim.text.includes('https://doc.ishow.pro/s/abc12345'), 'actionable iShow Doc link MUST NOT be stripped');
  const followUpBudget = classifyTurnBudget({
    text: 'cho e quyền đó',
    history: [
      { role: 'user', content: 'hỏi anh SJ trong group có link họp chưa để anh họp' },
      { role: 'assistant', content: 'Em chưa gửi được vào nhóm vì cần xác nhận quyền gửi tin nhắn, anh nhé.' },
    ],
    economy: { mode: 'outcome_only', links: 'on_request' },
  });
  const followLinks = followUpBudget.answerContract?.links ?? followUpBudget.links;
  ok(followLinks === 'inline', `short follow-up after link request must inherit links=inline (got: ${followLinks})`);

  console.log(`PASS v27-response-economy.smoke (${passed} checks)`);
}

main().catch((err) => {
  console.error('FAIL v27-response-economy.smoke:', err);
  process.exit(1);
});
