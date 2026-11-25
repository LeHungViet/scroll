// SCROLL 2.8.5 -- Cost & Budget Governance Hardening Smoke Suite.
// Verifies:
//   1. Tier-aware & per-model pricing (`priority`/`fast` 2x, `flex` 0.5x, exact `@tier` override)
//   2. Multimodal token accounting (`imageOutputTokens`, `audioOutputTokens`, `perMinute`) + provider usage extraction
//   3. Monthly spending caps (`maxMonthlyUsd`), cross-day accumulation, and month rollover
//   4. Background bucket sub-cap isolation (`maxBackgroundDailyUsd` / `bucketCaps`) without starving interactive turns
//   5. Invoice-anchored cap enforcement (`syncExternalInvoice`) + deduplicated graduated `onBudgetAlert` callbacks
//   6. `createChatSessionRuntime` background `standard` tier default, bucket routing, and final-synthesis budget gate
//   7. `createScheduler` 0-LLM `precheck` gate + `budgetGovernor` gate + interval cooldown on skip
//   8. `createScrollAgentHost.runScheduledTick` 0-LLM `precheck` + safe `'standard'` tier & `'background'` bucket
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scaffold,
  DEFAULT_TIER_MULTIPLIERS,
  resolveModelPricing,
  estimateUsageUsd,
  createBudgetGovernor,
  createScheduler,
  createChatSessionRuntime,
  createToolRegistry,
  pickProvider,
  generatePackSigningKeyPair,
  buildAgentPack,
  createPackRegistry,
  openTenantWorkspace,
  createScrollAgentHost,
} from '../index.js';

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (e) {
    console.error(`  \u2716 ${name} -- ${e.stack || e.message}`);
    fail++;
  }
}

console.log('SCROLL 2.8.5 -- Budget Governance, Tier/Multimodal Pricing & 0-LLM Precheck Suite');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-budget-hardening-'));

await t('1. Per-model + serviceTier multipliers (priority/fast 2x, flex 0.5x, exact @tier override)', async () => {
  assert.equal(DEFAULT_TIER_MULTIPLIERS.priority, 2);
  assert.equal(DEFAULT_TIER_MULTIPLIERS.fast, 2);
  assert.equal(DEFAULT_TIER_MULTIPLIERS.flex, 0.5);

  const pricingByModel = {
    'model-alpha': { inputPerM: 1.0, cachedPerM: 0.05, outputPerM: 5.0 },
    'model-beta@priority': { inputPerM: 2.5, cachedPerM: 0.1, outputPerM: 10.0 },
  };
  const usage = { uncachedInputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 100_000 };

  const stdUsd = estimateUsageUsd(usage, undefined, { model: 'model-alpha', serviceTier: 'standard', pricingByModel });
  const priUsd = estimateUsageUsd(usage, undefined, { model: 'model-alpha', serviceTier: 'priority', pricingByModel });
  const fastUsd = estimateUsageUsd(usage, undefined, { model: 'model-alpha', serviceTier: 'fast', pricingByModel });
  const flexUsd = estimateUsageUsd(usage, undefined, { model: 'model-alpha', serviceTier: 'flex', pricingByModel });
  const datedPriUsd = estimateUsageUsd(usage, undefined, { model: 'model-alpha-2026-11-01', serviceTier: 'priority', pricingByModel });

  assert.ok(Math.abs(stdUsd - 1.55) < 1e-6, `expected $1.55 standard, got ${stdUsd}`);
  assert.ok(Math.abs(priUsd - 3.10) < 1e-6, `expected $3.10 priority (2x), got ${priUsd}`);
  assert.ok(Math.abs(fastUsd - 3.10) < 1e-6, `expected $3.10 fast (2x), got ${fastUsd}`);
  assert.ok(Math.abs(flexUsd - 0.775) < 1e-6, `expected $0.775 flex (0.5x), got ${flexUsd}`);
  assert.ok(Math.abs(datedPriUsd - 3.10) < 1e-6, `date-suffixed model should resolve base rate, got ${datedPriUsd}`);

  // Exact @priority entry must NOT be multiplied twice
  const exactRes = resolveModelPricing(undefined, { model: 'model-beta', serviceTier: 'priority', pricingByModel });
  assert.equal(exactRes.exactTierMatch, true);
  assert.equal(exactRes.tierFactor, 1);
  assert.equal(exactRes.inputPerM, 2.5);
});

await t('2. Multimodal token accounting (imageOutputTokens never dropped when textOutputTokens=0) + OpenAI provider extraction', async () => {
  const pricingByModel = {
    'img-gen-1': { inputPerM: 5, imageInputPerM: 8, outputPerM: 30, imageOutputPerM: 30 },
    'img-gen-fallback': { inputPerM: 5, outputPerM: 30 },
    'voice-live-1': { perMinute: 0.05 },
  };
  const imgUsage = {
    uncachedInputTokens: 92,
    cachedInputTokens: 0,
    outputTokens: 1132,
    textOutputTokens: 0,
    imageOutputTokens: 1132,
  };
  const imgUsd = estimateUsageUsd(imgUsage, undefined, { model: 'img-gen-1', pricingByModel });
  assert.ok(Math.abs(imgUsd - 0.03442) < 1e-6, `image output tokens must be billed ($0.03442), got ${imgUsd}`);

  // Even without explicit imageOutputPerM, fallback to outputPerM must bill imageOutputTokens
  const fallbackUsd = estimateUsageUsd(imgUsage, undefined, { model: 'img-gen-fallback', pricingByModel });
  assert.ok(Math.abs(fallbackUsd - 0.03442) < 1e-6, `fallback image output must be $0.03442, got ${fallbackUsd}`);

  // Per-minute billing
  const voiceUsd = estimateUsageUsd({ seconds: 120 }, undefined, { model: 'voice-live-1', pricingByModel });
  assert.ok(Math.abs(voiceUsd - 0.10) < 1e-6, `2 minutes at $0.05/min must be $0.10, got ${voiceUsd}`);

  // Provider extraction preserves output_tokens_details.image_tokens and service_tier
  let capturedBody = null;
  const fakeFetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_img_1',
        service_tier: 'priority',
        output_text: 'done',
        usage: {
          input_tokens: 200,
          input_tokens_details: { cached_tokens: 0, image_tokens: 100 },
          output_tokens: 1132,
          output_tokens_details: { text_tokens: 0, image_tokens: 1132 },
          total_tokens: 1332,
        },
      }),
    };
  };
  const oa = pickProvider('openai', { apiKey: 'test-key-mock', model: 'img-gen-1', fetchImpl: fakeFetch });
  const r = await oa.generate('draw', { serviceTier: 'priority' });
  assert.equal(capturedBody.service_tier, 'priority');
  assert.equal(r.serviceTier, 'priority');
  assert.equal(r.usage.imageInputTokens, 100);
  assert.equal(r.usage.imageOutputTokens, 1132);
  assert.equal(r.usage.textOutputTokens, 0);
  assert.equal(r.usage.serviceTier, 'priority');
});

await t('3. Monthly cap (maxMonthlyUsd) persists across days and resets cleanly on new month', async () => {
  let nowMs = Date.parse('2026-11-10T10:00:00Z');
  const stateFile = path.join(tmpRoot, 'budget-monthly.json');
  const pricing = { inputPerM: 1.0, cachedPerM: 0.1, outputPerM: 1.0 };

  const gov1 = createBudgetGovernor({
    maxDailyUsd: 10,
    maxMonthlyUsd: 5,
    pricing,
    stateFile,
    clock: () => nowMs,
  });
  gov1.recordUsage({ conversationId: 'c1', usage: { uncachedInputTokens: 3_000_000, outputTokens: 0 } }); // $3.00

  // Advance to next day in same month
  nowMs = Date.parse('2026-11-11T10:00:00Z');
  const gov2 = createBudgetGovernor({
    maxDailyUsd: 10,
    maxMonthlyUsd: 5,
    pricing,
    stateFile,
    clock: () => nowMs,
  });
  const okBefore = gov2.checkBeforeCall({ conversationId: 'c1', estimatedInputTokens: 1_000_000 }); // +$1 -> $4 <= $5
  assert.equal(okBefore.ok, true);
  gov2.recordUsage({ conversationId: 'c1', usage: { uncachedInputTokens: 2_100_000, outputTokens: 0 } }); // total $5.10
  const blocked = gov2.checkBeforeCall({ conversationId: 'c1', estimatedInputTokens: 100 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'budget_monthly_usd_exceeded');

  // Advance to next month -> monthly counter resets
  nowMs = Date.parse('2026-12-01T01:00:00Z');
  const okNextMonth = gov2.checkBeforeCall({ conversationId: 'c1', estimatedInputTokens: 500_000 });
  assert.equal(okNextMonth.ok, true);
});

await t('4. Background bucket sub-cap isolates cron/heartbeat without blocking interactive turns', async () => {
  const gov = createBudgetGovernor({
    maxDailyUsd: 10,
    maxBackgroundDailyUsd: 1.0,
    pricing: { inputPerM: 1.0, cachedPerM: 0.1, outputPerM: 1.0 },
  });
  gov.recordUsage({ conversationId: 'cron:hb', bucket: 'heartbeat', usage: { uncachedInputTokens: 1_050_000 } }); // $1.05
  const bgChk = gov.checkBeforeCall({ conversationId: 'cron:hb', bucket: 'background', estimatedInputTokens: 1000 });
  assert.equal(bgChk.ok, false);
  assert.equal(bgChk.reason, 'budget_bucket_daily_usd_exceeded');
  assert.equal(bgChk.bucket, 'background');

  const interactiveChk = gov.checkBeforeCall({ conversationId: 'dm:user1', bucket: 'interactive', estimatedInputTokens: 1000 });
  assert.equal(interactiveChk.ok, true, 'Interactive turns must remain allowed when only background bucket is exhausted');
});

await t('5. Invoice-anchored floor (syncExternalInvoice) + deduplicated 80%/100% onBudgetAlert', async () => {
  const nowMs = Date.parse('2026-11-21T12:00:00Z');
  const alerts = [];
  const gov = createBudgetGovernor({
    maxDailyUsd: 10,
    maxMonthlyUsd: 50,
    alertThresholds: [0.8, 1.0],
    onBudgetAlert: (ev) => alerts.push(ev),
    pricing: { inputPerM: 1.0, cachedPerM: 0.1, outputPerM: 1.0 },
    stateFile: path.join(tmpRoot, 'budget-reconcile.json'),
    clock: () => nowMs,
  });
  // Local ledger under-estimates at $4.00
  gov.recordUsage({ conversationId: 'dm:1', usage: { uncachedInputTokens: 4_000_000 } });
  assert.equal(alerts.length, 0);

  // Provider invoice reveals $8.50 today and $51.00 month-to-date
  const sync1 = gov.syncExternalInvoice({ day: '2026-11-21', dayUsd: 8.5, month: '2026-11', monthUsd: 51.0 });
  assert.equal(sync1.effectiveDailyUsd, 8.5);
  assert.equal(sync1.effectiveMonthlyUsd, 51.0);
  assert.ok(alerts.some((a) => a.period === 'daily' && a.thresholdPct === 80 && a.source === 'reconciled'));
  assert.ok(alerts.some((a) => a.period === 'monthly' && a.thresholdPct === 100 && a.reached === true));

  const alertCountAfterFirst = alerts.length;
  // Re-syncing same invoice must NOT spam duplicate alerts
  gov.syncExternalInvoice({ day: '2026-11-21', dayUsd: 8.5, month: '2026-11', monthUsd: 51.0 });
  assert.equal(alerts.length, alertCountAfterFirst, 'Threshold alerts must be deduplicated');

  // Pre-flight check must now hard-block based on reconciled invoice floor
  const chk = gov.checkBeforeCall({ conversationId: 'dm:1', estimatedInputTokens: 100 });
  assert.equal(chk.ok, false);
  assert.equal(chk.reason, 'budget_monthly_usd_exceeded');
});

await t('6. createChatSessionRuntime downgrades background turns to standard tier, emits budget.alert, and gates final synthesis', async () => {
  const dir = path.join(tmpRoot, 'chat-session-budget');
  fs.mkdirSync(dir, { recursive: true });
  scaffold('helper', dir);

  const seenTiers = [];
  const emittedAlerts = [];
  let callNum = 0;
  const fakeProvider = {
    name: 'mock-openai',
    model: 'model-alpha',
    ready: true,
    supportsTools: true,
    nativeToolManager: false,
    async generate(_prompt, opts) {
      callNum++;
      seenTiers.push({ callNum, tier: opts.serviceTier });
      // Return a tool call on call 3 to test final synthesis gate after maxToolRounds=1
      if (callNum === 3) {
        return {
          text: '',
          toolCalls: [{ id: 'tc1', name: 'ping_tool', arguments: {} }],
          serviceTier: opts.serviceTier,
          usage: { uncachedInputTokens: 100_000, cachedInputTokens: 0, outputTokens: 0 },
          durationMs: 5,
        };
      }
      return {
        text: `reply-${callNum}`,
        toolCalls: [],
        serviceTier: opts.serviceTier,
        usage: { uncachedInputTokens: 400_000, cachedInputTokens: 0, outputTokens: 0 },
        durationMs: 5,
      };
    },
  };

  let hitSynthesisCase = false;
  const tools = createToolRegistry();
  tools.register({
    name: 'ping_tool',
    description: 'read only ping',
    risk: 'read_only',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      // Simulate external invoice sync pushing daily spend over cap right before final synthesis
      if (hitSynthesisCase) {
        rt.budgetGovernor.syncExternalInvoice({ day: rt.budgetGovernor.getSnapshot().day, dayUsd: 2.5 });
      }
      return { pong: true };
    },
  });

  const rt = createChatSessionRuntime({
    agentName: 'helper',
    cwd: dir,
    stateDir: path.join(dir, 'state'),
    provider: fakeProvider,
    model: 'model-alpha',
    tools,
    serviceTier: 'fast',
    maxToolRounds: 1,
    budget: {
      maxDailyUsd: 2.0,
      maxMonthlyUsd: 10.0,
      maxBackgroundDailyUsd: 0.9,
      pricingByModel: { 'model-alpha': { inputPerM: 1.0, cachedPerM: 0.1, outputPerM: 1.0 } },
      alertThresholds: [0.8, 1.0],
      onBudgetAlert: (ev) => emittedAlerts.push(ev),
    },
  });

  // Call 1: background cron turn must downgrade interactive `fast` -> `standard` ($0.40, NOT $0.80!)
  await rt.sendTurn({ conversationId: 'cron:hb', channel: 'cron', text: 'check status' });
  assert.equal(seenTiers[0].tier, 'standard', 'Background cron turn must NOT inherit interactive fast tier');
  const snap1 = rt.budgetGovernor.getSnapshot();
  assert.ok(Math.abs(snap1.byBucket.background - 0.40) < 1e-6, `Expected $0.40 standard cost, got ${snap1.byBucket.background}`);

  // Call 2: interactive turn keeps `fast` tier (2x -> $0.80), total $1.20
  await rt.sendTurn({ conversationId: 'dm:user1', channel: 'telegram', text: 'hello' });
  assert.equal(seenTiers[1].tier, 'fast', 'Interactive turn should preserve configured fast tier');
  const snap2 = rt.budgetGovernor.getSnapshot();
  assert.ok(Math.abs(snap2.totalUsd - 1.20) < 1e-6, `Expected $1.20 total ($0.40 + $0.80), got ${snap2.totalUsd}`);

  // Call 3: round 0 stays under cap ($1.20 + $0.20 = $1.40), tool runs and invoice sync pushes spend to $2.50 (> $2.00 cap)
  // -> final tool-free synthesis call MUST be blocked with BUDGET_EXCEEDED (never invoking provider a 4th time!)
  hitSynthesisCase = true;
  await assert.rejects(
    () => rt.sendTurn({ conversationId: 'dm:user1', channel: 'telegram', text: 'run ping' }),
    (err) => err && err.code === 'BUDGET_EXCEEDED' && err.message === 'budget_daily_usd_exceeded'
  );
  assert.equal(callNum, 3, 'Final synthesis turn must NOT execute when daily budget is exceeded');
  assert.ok(emittedAlerts.some((a) => a.period === 'daily' && a.thresholdPct === 100));
  await rt.close();
});

await t('7. createScheduler enforces 0-LLM precheck gate, interval cooldown, budgetGovernor gate, and standard tier default', async () => {
  let nowMs = Date.parse('2026-11-25T08:00:00Z');
  let handlerCalls = 0;
  let lastCtx = null;
  let hasChanges = false;

  const gov = createBudgetGovernor({
    maxDailyUsd: 10,
    maxBackgroundDailyUsd: 0.5,
    pricing: { inputPerM: 1.0, cachedPerM: 0.1, outputPerM: 1.0 },
    clock: () => nowMs,
  });

  const sched = createScheduler({
    filePath: path.join(tmpRoot, 'sched.json'),
    clock: () => nowMs,
    budgetGovernor: gov,
    defaultServiceTier: 'standard',
  });
  sched.addJob({
    id: 'hb',
    name: 'Zero-LLM Heartbeat',
    everyMs: 30 * 60_000,
    prompt: 'check updates',
    precheckKey: 'mail_and_cal',
  });
  sched.registerPrecheck('mail_and_cal', () => (hasChanges ? { run: true, data: { unread: 2 } } : { run: false, reason: 'nothing_new' }));

  const handler = async (_job, ctx) => {
    handlerCalls++;
    lastCtx = ctx;
    return 'processed';
  };

  // Tick 1: precheck says nothing new -> 0 handler calls, 0 dailyRuns
  const r1 = await sched.tick({ handler });
  assert.equal(handlerCalls, 0);
  assert.equal(r1.triggered.length, 0);
  assert.equal(r1.skipped[0].reason, 'nothing_new');
  assert.equal(sched.getJob('hb').dailyRuns, 0);
  assert.equal(sched.getJob('hb').lastStatus, 'skipped_precheck');

  // Tick 2 (1 minute later): interval cooldown must prevent tight-loop re-checking
  nowMs += 60_000;
  hasChanges = true;
  const r2 = await sched.tick({ handler });
  assert.equal(handlerCalls, 0, 'Skipped interval job must honor everyMs cooldown before re-checking');
  assert.equal(r2.triggered.length, 0);

  // Tick 3 (30 minutes later): precheck passes -> handler runs with standard tier + background bucket + precheckData
  nowMs += 30 * 60_000;
  const r3 = await sched.tick({ handler });
  assert.equal(handlerCalls, 1);
  assert.equal(r3.triggered.length, 1);
  assert.equal(lastCtx.serviceTier, 'standard');
  assert.equal(lastCtx.budgetBucket, 'background');
  assert.deepEqual(lastCtx.precheckData, { unread: 2 });

  // Exhaust background sub-cap -> Tick 4 (30 minutes later) must skip on budget without invoking handler
  gov.recordUsage({ conversationId: 'cron:hb', bucket: 'background', usage: { uncachedInputTokens: 600_000 } }); // $0.60 > $0.50
  nowMs += 30 * 60_000;
  const r4 = await sched.tick({ handler });
  assert.equal(handlerCalls, 1, 'Budget-exhausted scheduled job must NOT invoke handler');
  assert.equal(r4.skipped[0].reason, 'budget_bucket_daily_usd_exceeded');
  assert.equal(sched.getJob('hb').lastStatus, 'skipped_budget');
});

await t('8. createScrollAgentHost.runScheduledTick enforces 0-LLM precheck and standard tier on cron ticks', async () => {
  const baseDir = path.join(tmpRoot, 'host-budget');
  const agentSrc = path.join(baseDir, 'src');
  fs.mkdirSync(agentSrc, { recursive: true });
  scaffold('cronbot', agentSrc);

  const kp = generatePackSigningKeyPair();
  const packsRoot = path.join(baseDir, 'packs');
  buildAgentPack({
    sourceDir: agentSrc,
    agentName: 'cronbot',
    packId: 'cronbot-pack',
    version: '1.0.0',
    outDir: path.join(packsRoot, 'cronbot-pack', '1.0.0'),
    privateKeyPem: kp.privateKeyPem,
  });
  const registry = createPackRegistry({
    packsRootDir: packsRoot,
    publicKeyPem: kp.publicKeyPem,
    requireSignature: true,
  });

  const ws = openTenantWorkspace({
    tenantsRootDir: path.join(baseDir, 'tenants'),
    tenantId: 't-budget',
    deploymentId: 'dep-1',
    packRegistry: registry,
    initialPack: { packId: 'cronbot-pack', version: '1.0.0' },
  });

  const providerCalls = [];
  const fakeProvider = {
    name: 'mock-host-provider',
    model: 'model-alpha',
    ready: true,
    supportsTools: true,
    async generate(_prompt, opts) {
      providerCalls.push({ serviceTier: opts.serviceTier });
      return { text: 'ok', toolCalls: [], usage: { uncachedInputTokens: 100, cachedInputTokens: 0, outputTokens: 10 }, durationMs: 2 };
    },
  };

  const host = await createScrollAgentHost({
    workspace: ws,
    packRegistry: registry,
    provider: fakeProvider,
    runtimeOptions: { serviceTier: 'fast' },
  });

  const t1 = new Date().toISOString();
  const skipped = await host.runScheduledTick({
    jobId: 'hb-host',
    scheduledAt: t1,
    epoch: 1,
    precheck: () => ({ run: false, reason: 'idle_zero_llm' }),
    prompt: 'check inbox',
  });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'idle_zero_llm');
  assert.equal(providerCalls.length, 0, 'Skipped precheck tick must make 0 LLM calls');

  const t2 = new Date(Date.now() + 1000).toISOString();
  const ran = await host.runScheduledTick({
    jobId: 'hb-host',
    scheduledAt: t2,
    epoch: 1,
    precheck: () => ({ run: true }),
    prompt: 'check inbox',
  });
  assert.equal(ran.ok, true);
  assert.equal(ran.skipped, false);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].serviceTier, 'standard', 'Scheduled host tick must default to standard tier');

  await host.close();
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
