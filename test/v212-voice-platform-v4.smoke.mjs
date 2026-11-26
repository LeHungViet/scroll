// SCROLL 2.12 smoke test: Full Voice Platform v4 (3 Genders x 7 Roles, EQ, Voice DNA,
// Move Playbook, Distilled PlainSpeak, and Claim-Safe Human Error v2 with 3 mechanisms).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVoiceCatalog,
  resolveVoiceProfile,
  applyClaimSafeHumanTexture,
  createHostVoiceRuntime,
} from '../lib/voice-engine.js';

test('SCROLL 2.12 Voice Platform v4: catalog, genders x roles, Human Error v2 3 mechanisms & claim-safe 0% lock', async () => {
  const cat = getVoiceCatalog();
  assert.equal(cat.genders.length, 3, 'Must expose female, male, neutral genders');
  assert.equal(cat.roles.length, 7, 'Must expose all 7 canonical roles');
  assert.ok(cat.presets.length >= 14, 'Must expose full gender x role preset catalog');

  // 1. Male teammate vs Female assistant vs Neutral service resolve distinct canonical presets
  const femaleAsst = resolveVoiceProfile({
    language: 'vi',
    weights: { voiceGender: 'female', voiceRole: 'assistant', voiceMode: 'auto', humanError: true },
  });
  assert.equal(femaleAsst.voicePreset, 'female.assistant');
  assert.equal(femaleAsst.effectiveMode, 'vi_natural');
  assert.equal(femaleAsst.humanError, true);
  assert.equal(femaleAsst.humanErrorRates.texturePercent, 22);
  assert.equal(femaleAsst.humanErrorRates.correctionPercent, 5);

  const maleSales = resolveVoiceProfile({
    language: 'vi',
    weights: { voiceGender: 'male', voiceRole: 'sales', voiceMode: 'vi_natural', humanError: true },
  });
  assert.equal(maleSales.voicePreset, 'male.sales');
  assert.equal(maleSales.humanErrorRates.texturePercent, 34);
  assert.equal(maleSales.humanErrorRates.correctionPercent, 8);

  const maleTeam = resolveVoiceProfile({
    language: 'vi',
    weights: { voiceGender: 'male', voiceRole: 'teammate', voiceMode: 'vi_natural', humanError: true },
  });
  assert.equal(maleTeam.voicePreset, 'male.teammate');
  assert.equal(maleTeam.humanErrorRates.texturePercent, 18);
  assert.equal(maleTeam.humanErrorRates.correctionPercent, 4);

  // Non-distilled English language in auto mode falls back cleanly to basic mode with humanError OFF
  const enAuto = resolveVoiceProfile({
    language: 'en',
    weights: { voiceGender: 'male', voiceRole: 'assistant', voiceMode: 'auto', humanError: true },
  });
  assert.equal(enAuto.effectiveMode, 'basic');
  assert.equal(enAuto.humanError, false);

  // strict_pro locks humanError OFF
  const strictPro = resolveVoiceProfile({
    language: 'vi',
    weights: { voiceMode: 'strict_pro', humanError: true },
  });
  assert.equal(strictPro.humanError, false);

  // 2. Human Error v2 mechanisms: edit_message_repair, followup_correction, early_send_append, casual texture
  let sawEditPlan = false;
  let sawFollowup = false;
  let sawAppend = false;
  let sawTexture = false;
  for (let i = 0; i < 60; i++) {
    const r0 = applyClaimSafeHumanTexture('Th\u1eadt ra h\u00f4m nay c\u0169ng vui nha', {
      enabled: true,
      effectiveMode: 'vi_natural',
      capabilities: { edit: true, bubbles: true },
      rates: { texturePercent: 50, correctionPercent: 0, appendPercent: 0 },
      seed: `seed-tex-${i}`,
    });
    if (r0.applied && ['lowercase_opening', 'colloquial_ending'].includes(r0.kind)) sawTexture = true;

    const r1 = applyClaimSafeHumanTexture('Ch\u1eafc h\u00f4m nay c\u0169ng \u0111\u01b0\u1ee3c nhi\u1ec1u vi\u1ec7c th\u00eam nha', {
      enabled: true,
      effectiveMode: 'vi_natural',
      capabilities: { edit: true, bubbles: true },
      rates: { texturePercent: 45, correctionPercent: 15, appendPercent: 0 },
      seed: `seed-edit-${i}`,
    });
    if (r1.kind === 'edit_message_repair' && r1.editPlan?.mode === 'send_then_edit') sawEditPlan = true;

    const r2 = applyClaimSafeHumanTexture('Ch\u1eafc h\u00f4m nay c\u0169ng \u0111\u01b0\u1ee3c nhi\u1ec1u vi\u1ec7c th\u00eam nha', {
      enabled: true,
      effectiveMode: 'vi_natural',
      capabilities: { edit: false, bubbles: true },
      rates: { texturePercent: 45, correctionPercent: 15, appendPercent: 0 },
      seed: `seed-edit-${i}`,
    });
    if (r2.kind === 'followup_correction' && r2.bubbles.length === 2 && r2.bubbles[1].startsWith('*')) sawFollowup = true;

    const r3 = applyClaimSafeHumanTexture('Em v\u1eeba xem qua ph\u1ea7n n\u00e0y r\u1ed3i nha, \u00e0 qu\u00ean l\u00e1t n\u1eefa nh\u1eafc em g\u1eedi b\u1ea3n nh\u00e1p lu\u00f4n', {
      enabled: true,
      effectiveMode: 'vi_natural',
      capabilities: { edit: true, bubbles: true },
      rates: { texturePercent: 45, correctionPercent: 10, appendPercent: 30 },
      seed: `seed-app-${i}`,
    });
    if (r3.kind === 'early_send_append' && r3.bubbles.length === 2 && r3.appendDelayMs > 0) sawAppend = true;
  }
  assert.equal(sawTexture, true, 'Must fire lowercase_opening / colloquial_ending casual texture');
  assert.equal(sawEditPlan, true, 'Must fire Telegram send_then_edit Telex repair');
  assert.equal(sawFollowup, true, 'Must fire *correction followup on non-edit channels');
  assert.equal(sawAppend, true, 'Must fire early_send_append delayed second bubble');

  // 3. Hard-lock 0% on numbers, money, tax codes, URLs, serious turns
  const protectedSamples = [
    'Thu\u1ebf GTGT qu\u00fd 4 l\u00e0 15.000.000\u0111 theo TT99/2025 nha',
    'Xem t\u1ea1i https://app.botroom.dev/ nha',
    'M\u00e3 h\u1ed3 s\u01a1 INV-2026-001 \u0111\u00e3 duy\u1ec7t r\u1ed3i.',
  ];
  for (const sample of protectedSamples) {
    const res = applyClaimSafeHumanTexture(sample, {
      enabled: true,
      effectiveMode: 'vi_natural',
      capabilities: { edit: true, bubbles: true },
      rates: { texturePercent: 50, correctionPercent: 15, appendPercent: 30 },
      seed: 'seed-lock',
    });
    assert.equal(res.applied, false, `Protected message must remain 100% untouched: ${sample}`);
    assert.equal(res.text, sample);
  }

  // 4. Full HostVoiceRuntime beforeTurn (Region A stable + Region C volatile) & shapeOutgoing
  const rt = createHostVoiceRuntime({
    language: 'vi',
    packManifest: {
      voice: { defaultMode: 'auto', defaultGender: 'female', defaultRole: 'assistant', allowHumanError: true, defaultHumanError: true },
      defaultWeights: { preset: 'ca-tinh', traits: { assertiveness: 4, reserve: 1, wit: 4, warmth: 5 }, initiative: 3, adaptiveLevel: 3 },
      domainPacks: [{ id: 'vn-human-comm-eq-subtext' }],
    },
  });
  const before = await rt.voiceHooks.beforeTurn({
    conversationId: 'conv-1',
    text: 'Nay h\u01a1i m\u1ec7t qu\u00e1 em \u01a1i, ch\u1ea1y t\u1eeb s\u00e1ng t\u1edbi gi\u1edd',
    history: [],
    isGroup: false,
  });
  assert.ok(before.stableSystemBlock.length > 100, 'Must emit Region A Voice Preset & VN naturalness block');
  assert.ok(before.volatileTurnBlock.length > 50, 'Must emit Region C Affect + EQ + Voice DNA + Playbook cues');

  const shaped = await rt.voiceHooks.shapeOutgoing({
    conversationId: 'conv-1',
    text: 'Nghe o\u1ea3i th\u1eadt s\u1ef1.\n\nT\u1ed1i nay ngh\u1ec9 s\u1edbm \u0111i anh, mai t\u00ednh ti\u1ebfp.',
    channel: 'telegram',
    voiceBefore: before,
  });
  assert.ok(shaped.bubbles.length >= 1);
  assert.equal(shaped.meta.voicePreset, 'female.assistant');
  assert.equal(shaped.meta.voiceGender, 'female');
  assert.equal(shaped.meta.voiceRole, 'assistant');
  assert.ok(rt.describeVoice().catalog.genders.length === 3);
});
