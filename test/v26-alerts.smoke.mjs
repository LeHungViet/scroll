// SCROLL 2.6 -- §51 Smart Alerts Verification & Mutation Gates (T1 - T8).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAlertLedger,
  computeArgsHash,
  verifyTopHopAuthGrade,
  createApprovalStore,
  createToolRegistry,
} from '../index.js';
import {
  createAlertsController,
  sanitizeUntrustedQuote,
  sanitizeSafeHtmlMessage,
  buildGoogleCalendarTemplateUrl,
  makeAlertCallbackData,
} from '../lib/chat-sdk/index.js';

function tmpDir(prefix = 'scroll-alerts-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Base timestamp: 2026-11-22 10:00:00+07:00 (daytime in Asia/Ho_Chi_Minh)
const DAY_10AM = Date.parse('2026-11-22T10:00:00+07:00');
// Quiet hour: 2026-11-22 02:30:00+07:00
const NIGHT_0230 = Date.parse('2026-11-22T02:30:00+07:00');

const TRUSTED_HDR = (domain) => [
  `mx.google.com; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
];

async function run() {
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  }

  console.log('SCROLL 2.6 -- §51 Smart Alerts (T1 - T8)');

  // ── T1: Cross-mailbox twin dedup + identical spam burst suppression ─────────
  await test('T1: cross-mailbox twin & identical spam bursts have zero recurrence weight', () => {
    const dir = tmpDir();
    const ledger = createAlertLedger({
      stateDir: dir,
      shadowMode: false,
      pinnedDomains: ['hetzner.com'],
      clock: () => DAY_10AM,
    });

    // Twin #1 in Gmail
    const r1 = ledger.ingestSignal({
      signalId: 'gm_1',
      source: 'gmail',
      isEmail: true,
      category: 'finance_obligation',
      stage: 'issued',
      fromDomain: 'hetzner.com',
      authHeaders: TRUSTED_HDR('hetzner.com'),
      summary: 'Invoice INV-2026-9910 issued for USD 49.00',
      quote: 'Your invoice INV-2026-9910 for USD 49.00 is ready.',
      occurredAt: DAY_10AM,
      observedAt: DAY_10AM,
    });
    assert.equal(r1.action, 'opened');
    assert.equal(r1.case.distinctCount, 1);

    // Twin #2 forwarded to Outlook 15 minutes later (same invoice ID, same stage, <6h)
    const r2 = ledger.ingestSignal({
      signalId: 'ol_1',
      source: 'outlook',
      isEmail: true,
      category: 'finance_obligation',
      stage: 'issued',
      fromDomain: 'hetzner.com',
      authHeaders: TRUSTED_HDR('hetzner.com'),
      summary: 'Invoice INV-2026-9910 issued for USD 49.00',
      quote: 'Your invoice INV-2026-9910 for USD 49.00 is ready.',
      occurredAt: DAY_10AM + 15 * 60_000,
      observedAt: DAY_10AM + 15 * 60_000,
    });
    assert.equal(r2.action, 'merged');
    assert.equal(r2.case.caseId, r1.case.caseId);
    assert.equal(r2.case.distinctCount, 1, 'cross-mailbox twin must NOT increment distinctCount');

    // Identical automated spam resend 30 minutes later
    const r3 = ledger.ingestSignal({
      signalId: 'gm_2',
      source: 'gmail',
      isEmail: true,
      category: 'finance_obligation',
      stage: 'issued',
      fromDomain: 'hetzner.com',
      authHeaders: TRUSTED_HDR('hetzner.com'),
      summary: 'Invoice INV-2026-9910 issued for USD 49.00',
      quote: 'Your invoice INV-2026-9910 for USD 49.00 is ready.',
      occurredAt: DAY_10AM + 30 * 60_000,
      observedAt: DAY_10AM + 30 * 60_000,
    });
    assert.equal(r3.action, 'merged');
    assert.equal(r3.case.distinctCount, 1, 'near-duplicate spam resend must NOT escalate');
  });

  // ── T2: 3-email vendor drift + Stripe proxy + stage jump escalation ─────────
  await test('T2: proxy vendor unwrap, 7d reminder + 4m stage jump escalate P2 -> P1 -> P0', () => {
    const dir = tmpDir();
    let now = DAY_10AM;
    const ledger = createAlertLedger({
      stateDir: dir,
      shadowMode: false,
      pinnedDomains: ['stripe.com', 'acme.io'],
      clock: () => now,
    });

    // Email 1 via Stripe proxy (Reply-To acme.io)
    const e1 = ledger.ingestSignal({
      signalId: 'm1',
      source: 'gmail',
      isEmail: true,
      category: 'finance_emergency',
      stage: 'issued',
      confidence: 0.95,
      fromDomain: 'stripe.com',
      replyToDomain: 'billing.acme.io',
      authHeaders: TRUSTED_HDR('stripe.com'),
      summary: 'Acme Cloud invoice INV-778812 for $199.00',
      quote: 'Invoice INV-778812 for $199.00 on server prod-db-01',
      occurredAt: now,
      observedAt: now,
    });
    assert.equal(e1.case.effectiveVendor, 'acme.io', 'must unwrap stripe.com proxy to acme.io');
    assert.equal(e1.case.authGrade, 'CRYPTO_VERIFIED');
    assert.equal(e1.case.severity, 'P2', 'first issued email must start at P2');

    // Email 2: 7d + 2h later, reminder from direct acme.io domain (vendor drift)
    now += 7 * DAY + 2 * HOUR;
    const e2 = ledger.ingestSignal({
      signalId: 'm2',
      source: 'gmail',
      isEmail: true,
      category: 'finance_emergency',
      stage: 'reminder',
      confidence: 0.95,
      fromDomain: 'acme.io',
      authHeaders: TRUSTED_HDR('acme.io'),
      summary: 'Reminder: Acme invoice INV-778812 unpaid ($199.00)',
      quote: 'Second notice for INV-778812 on prod-db-01.',
      occurredAt: now,
      observedAt: now,
    });
    assert.equal(e2.action, 'merged');
    assert.equal(e2.case.caseId, e1.case.caseId);
    assert.equal(e2.case.distinctCount, 2);
    assert.equal(e2.case.severity, 'P1', `expected P1 after reminder, got ${e2.case.severity}`);

    // Email 3: 4 minutes later, stage jumps to suspension_notice -> must count immediately (<6h!)
    now += 4 * 60_000;
    const e3 = ledger.ingestSignal({
      signalId: 'm3',
      source: 'gmail',
      isEmail: true,
      category: 'finance_emergency',
      stage: 'suspension_notice',
      confidence: 0.96,
      fromDomain: 'acme.io',
      authHeaders: TRUSTED_HDR('acme.io'),
      summary: 'FINAL WARNING: prod-db-01 will be suspended in 12 hours (INV-778812)',
      quote: 'Immediate payment required for INV-778812 or prod-db-01 shuts down.',
      deadlineAt: new Date(now + 12 * HOUR).toISOString(),
      occurredAt: now,
      observedAt: now,
    });
    assert.equal(e3.action, 'merged');
    assert.equal(e3.case.distinctCount, 3, 'stage progression must count even 4 minutes later');
    assert.equal(e3.case.severity, 'P0', 'verified finance emergency suspension with deadline must reach P0');
  });

  // ── T3: All 4 Hard Anti-False-Merge Vetoes ──────────────────────────────────
  await test('T3: 4 hard anti-false-merge vetoes prevent disjoint/hijack/receipt/sealed merges', () => {
    const dir = tmpDir();
    let now = DAY_10AM;
    const ledger = createAlertLedger({
      stateDir: dir,
      shadowMode: false,
      pinnedDomains: ['aws.amazon.com', 'grab.com'],
      clock: () => now,
    });

    // Veto #1: Disjoint invoice IDs from same vendor
    const a1 = ledger.ingestSignal({
      signalId: 'v1_a',
      source: 'gmail',
      isEmail: true,
      category: 'finance_obligation',
      stage: 'issued',
      fromDomain: 'aws.amazon.com',
      authHeaders: TRUSTED_HDR('aws.amazon.com'),
      summary: 'AWS invoice INV-2026-0001 for $120',
      occurredAt: now,
      observedAt: now,
    });
    const a2 = ledger.ingestSignal({
      signalId: 'v1_b',
      source: 'gmail',
      isEmail: true,
      category: 'finance_obligation',
      stage: 'issued',
      fromDomain: 'aws.amazon.com',
      authHeaders: TRUSTED_HDR('aws.amazon.com'),
      summary: 'AWS invoice INV-2026-0002 for $120',
      mergeCaseId: a1.case.caseId, // even if Stage 2 LLM suggests merging, Veto #1 MUST reject!
      mergeConfidence: 0.99,
      occurredAt: now + 2 * DAY,
      observedAt: now + 2 * DAY,
    });
    assert.equal(a2.action, 'opened', 'disjoint invoice IDs must NEVER merge');
    assert.notEqual(a2.case.caseId, a1.case.caseId);

    // Veto #2: Trust-downgrade hijack (unverified email spoofing In-Reply-To of verified case)
    const trusted = ledger.ingestSignal({
      signalId: 'v2_trusted',
      source: 'gmail',
      isEmail: true,
      category: 'finance_obligation',
      stage: 'issued',
      fromDomain: 'aws.amazon.com',
      authHeaders: TRUSTED_HDR('aws.amazon.com'),
      threadKeys: ['<msg-real-aws-999@aws.amazon.com>'],
      summary: 'AWS billing notice INV-884422',
      occurredAt: now,
      observedAt: now,
    });
    const spoof = ledger.ingestSignal({
      signalId: 'v2_spoof',
      source: 'gmail',
      isEmail: true,
      category: 'finance_emergency',
      stage: 'suspension_notice',
      fromDomain: 'evil-spoof.xyz',
      authHeaders: ['mx.google.com; dkim=fail; dmarc=fail'],
      threadKeys: ['<msg-real-aws-999@aws.amazon.com>'],
      summary: 'URGENT pay INV-884422 now',
      occurredAt: now + HOUR,
      observedAt: now + HOUR,
    });
    assert.equal(spoof.action, 'opened', 'unverified email must NEVER merge into CRYPTO_VERIFIED case');
    assert.notEqual(spoof.case.caseId, trusted.case.caseId);
    assert.equal(spoof.case.severity, 'P2', 'unverified email must be mechanically clamped to <= P2');

    // Veto #3: One-off receipts >15m apart must NEVER merge
    const r1 = ledger.ingestSignal({
      signalId: 'v3_a',
      source: 'gmail',
      isEmail: true,
      category: 'ops_general',
      isOneOffReceipt: true,
      fromDomain: 'grab.com',
      authHeaders: TRUSTED_HDR('grab.com'),
      summary: 'Your Grab ride receipt $8.50',
      occurredAt: now,
      observedAt: now,
    });
    const r2 = ledger.ingestSignal({
      signalId: 'v3_b',
      source: 'gmail',
      isEmail: true,
      category: 'ops_general',
      isOneOffReceipt: true,
      fromDomain: 'grab.com',
      authHeaders: TRUSTED_HDR('grab.com'),
      summary: 'Your Grab ride receipt $8.50',
      occurredAt: now + 3 * HOUR,
      observedAt: now + 3 * HOUR,
    });
    assert.equal(r2.action, 'opened', 'one-off receipts >15m apart must stay separate');
    assert.notEqual(r2.case.caseId, r1.case.caseId);

    // Veto #4: Sealed closed epoch (>48h after close) must NEVER reopen
    ledger.applyFeedback(a1.case.caseId, 'done', { nowMs: now + HOUR });
    const afterSeal = ledger.ingestSignal({
      signalId: 'v4_new',
      source: 'gmail',
      isEmail: true,
      category: 'finance_obligation',
      stage: 'reminder',
      fromDomain: 'aws.amazon.com',
      authHeaders: TRUSTED_HDR('aws.amazon.com'),
      summary: 'AWS invoice INV-2026-0001 reminder',
      occurredAt: now + 4 * DAY,
      observedAt: now + 4 * DAY,
    });
    assert.equal(afterSeal.action, 'opened', 'closed case >48h old is sealed and must open a fresh case');
    assert.notEqual(afterSeal.case.caseId, a1.case.caseId);
  });

  // ── T4: Quiet hours, P0 break-glass, 3-unacked rollup, snooze/mute/self-demotion ──
  await test('T4: quiet hours hold P1, verified P0 breaks glass, 3-unacked rollup, self-demotion', () => {
    const dir = tmpDir();
    let now = NIGHT_0230;
    const ledger = createAlertLedger({
      stateDir: dir,
      shadowMode: false,
      pinnedDomains: ['bank.com'],
      clock: () => now,
    });

    // At 02:30 AM: P1 group alert must be held
    const grp = ledger.ingestSignal({
      signalId: 'n_grp',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-1001',
      containerTitle: 'Ops Team',
      category: 'group_blocker_or_calendar',
      stage: 'blocker',
      senderTrust: 'internal',
      summary: 'Server staging blocked, need approval',
      occurredAt: now,
      observedAt: now,
    });
    assert.equal(grp.case.severity, 'P1');
    assert.equal(grp.decision.disposition, 'hold');
    assert.equal(grp.decision.reason, 'quiet_hours');

    // Group signal claiming security_alert from 1 member is clamped to <= P1 (never P0!)
    const grpSec = ledger.ingestSignal({
      signalId: 'n_grp_sec',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-1002',
      category: 'security_critical',
      stage: 'security_alert',
      confidence: 0.99,
      senderId: 'u_single',
      senderTrust: 'internal',
      summary: 'URGENT server compromised',
      occurredAt: now,
      observedAt: now,
    });
    assert.notEqual(grpSec.case.severity, 'P0', 'single-sender group alert must NEVER reach P0');

    // Verified P0 emergency email at 02:30 AM breaks glass
    const p0 = ledger.ingestSignal({
      signalId: 'n_p0',
      source: 'gmail',
      isEmail: true,
      category: 'security_critical',
      stage: 'security_alert',
      confidence: 0.96,
      fromDomain: 'bank.com',
      authHeaders: TRUSTED_HDR('bank.com'),
      summary: 'Unauthorized wire transfer attempt USD 25000',
      occurredAt: now,
      observedAt: now,
    });
    assert.equal(p0.case.severity, 'P0');
    assert.equal(p0.decision.disposition, 'immediate');
    assert.equal(p0.decision.reason, 'verified_p0_breakglass');

    // Switch to daytime 10:00 AM -> test 3-unacked P1 backpressure rollup
    now = DAY_10AM;
    for (let i = 1; i <= 3; i++) {
      const c = ledger.ingestSignal({
        signalId: `day_p1_${i}`,
        source: 'telegram_group',
        isGroup: true,
        containerId: `-200${i}`,
        category: 'group_blocker_or_calendar',
        stage: 'blocker',
        senderTrust: 'internal',
        summary: `Urgent blocker #${i}`,
        occurredAt: now + i * 1000,
        observedAt: now + i * 1000,
      });
      assert.equal(c.decision.disposition, 'immediate');
      const r = ledger.reserveNotice(c.case.caseId, { purpose: 'immediate', nowMs: now + i * 1000 });
      ledger.confirmNotice(c.case.caseId, r.notice.noticeId, { providerMessageId: `msg_${i}`, nowMs: now + i * 1000 });
    }
    // 4th unacked P1 must trigger rollup backpressure!
    const p1Fourth = ledger.ingestSignal({
      signalId: 'day_p1_4',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-2004',
      category: 'group_blocker_or_calendar',
      stage: 'blocker',
      senderTrust: 'internal',
      summary: 'Urgent blocker #4',
      occurredAt: now + 5000,
      observedAt: now + 5000,
    });
    assert.equal(p1Fourth.decision.disposition, 'rollup', '4th P1 with 3 unacked must enter rollup');

    // Snooze 2h holds case until snooze expires
    const snz = ledger.applyFeedback(p1Fourth.case.caseId, 'snooze_2h', { nowMs: now + 6000 });
    assert.equal(snz.ok, true);
    assert.equal(ledger.decideCaseDisposition(p1Fourth.case.caseId, now + HOUR).disposition, 'hold');

    // Self-demotion: 3 of 6 feedbacks marked not_useful on same source+category -> demoted to digest
    const dir2 = tmpDir();
    const l2 = createAlertLedger({ stateDir: dir2, shadowMode: false, clock: () => DAY_10AM });
    let sawDemoted = false;
    for (let i = 1; i <= 6; i++) {
      const s = l2.ingestSignal({
        signalId: `fb_${i}`,
        source: 'telegram_group',
        isGroup: true,
        containerId: `-300${i}`,
        category: 'group_blocker_or_calendar',
        stage: 'blocker',
        senderTrust: 'internal',
        summary: `Candidate alert #${i}`,
        occurredAt: DAY_10AM + i * 1000,
        observedAt: DAY_10AM + i * 1000,
      });
      const verb = i <= 3 ? 'not_useful' : 'useful';
      const fb = l2.applyFeedback(s.case.caseId, verb, { nowMs: DAY_10AM + i * 1000 + 500 });
      if (fb.demoted) sawDemoted = true;
    }
    assert.equal(sawDemoted, true, '3/6 not_useful feedbacks must trigger self-demotion');
    const afterDemote = l2.ingestSignal({
      signalId: 'fb_7',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-3007',
      category: 'group_blocker_or_calendar',
      stage: 'blocker',
      senderTrust: 'internal',
      summary: 'Candidate alert #7 after demotion',
      occurredAt: DAY_10AM + 90_000,
      observedAt: DAY_10AM + 90_000,
    });
    assert.equal(afterDemote.decision.disposition, 'digest', 'demoted source+kind must drop to digest');
  });

  // ── T5: Auto-resolve on non-threaded owner reply + anti-nag hysteresis ──────
  await test('T5: owner group reply auto-resolves mention case (preserves calendar case) & anti-nag', () => {
    const dir = tmpDir();
    const ledger = createAlertLedger({ stateDir: dir, shadowMode: false, clock: () => DAY_10AM });

    const mentionCase = ledger.ingestSignal({
      signalId: 'grp_mention_1',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-5019061209',
      containerTitle: 'AI Group',
      category: 'group_blocker_or_calendar',
      stage: 'blocker',
      senderTrust: 'internal',
      summary: 'Team waiting on your reply about launch plan',
      occurredAt: DAY_10AM,
      observedAt: DAY_10AM,
    });
    const resv = ledger.reserveNotice(mentionCase.case.caseId, { purpose: 'immediate', nowMs: DAY_10AM });
    ledger.confirmNotice(mentionCase.case.caseId, resv.notice.noticeId, { providerMessageId: 'dm_55', nowMs: DAY_10AM });

    // Anti-nag hysteresis: immediate re-check without new evidence must be silent
    assert.equal(ledger.decideCaseDisposition(mentionCase.case.caseId, DAY_10AM + 30 * 60_000).disposition, 'silent');

    // Also open a calendar_create_event case in the same group
    const calCase = ledger.ingestSignal({
      signalId: 'grp_cal_1',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-5019061209',
      containerTitle: 'AI Group',
      category: 'group_blocker_or_calendar',
      stage: 'meeting_confirmed',
      senderTrust: 'internal',
      summary: 'Coffee meeting today 16:00 missing from calendar',
      frozenAction: {
        tool: 'calendar_create_event',
        args: { summary: 'Coffee meeting', startIso: '2026-11-22T16:00:00+07:00', endIso: '2026-11-22T17:00:00+07:00' },
      },
      occurredAt: DAY_10AM,
      observedAt: DAY_10AM,
    });

    // Owner posts a non-threaded reply in the group 10 minutes later
    const obs = ledger.observeOwnerEngagement({
      source: 'telegram_group',
      containerId: '-5019061209',
      at: DAY_10AM + 10 * 60_000,
    });
    assert.equal(obs.resolved.length, 1);
    assert.equal(obs.resolved[0].caseId, mentionCase.case.caseId);
    assert.equal(ledger.getCase(mentionCase.case.caseId).state, 'auto_resolved');
    assert.equal(ledger.getCase(calCase.case.caseId).state, 'open', 'group reply must NOT silently close missing-calendar case');
  });

  // ── T6: Adversarial / Phishing Hardening ────────────────────────────────────
  await test('T6: punycode, bottom-hop header spoof, prompt injection, and phishing URL stripping', () => {
    // Punycode homograph rejected
    const puny = verifyTopHopAuthGrade({
      authHeaders: ['mx.google.com; dkim=pass header.d=xn--pple-43d.com; dmarc=pass header.from=xn--pple-43d.com'],
      fromDomain: 'xn--pple-43d.com',
      pinnedDomains: ['apple.com'],
    });
    assert.equal(puny.authGrade, 'UNVERIFIED');
    assert.equal(puny.reason, 'punycode_homograph_rejected');

    // Bottom-hop forged Authentication-Results ignored (index 0 failed!)
    const forged = verifyTopHopAuthGrade({
      authHeaders: [
        'mx.google.com; dkim=fail header.d=bank.com; dmarc=fail header.from=bank.com',
        'mx.google.com; dkim=pass header.d=bank.com; dmarc=pass header.from=bank.com',
      ],
      fromDomain: 'bank.com',
      pinnedDomains: ['bank.com'],
    });
    assert.equal(forged.authGrade, 'UNVERIFIED', 'must inspect ONLY top-hop index-0 Authentication-Results');

    // URL, markdown link, HTML tag, bare domain, and bidi char stripping
    const dirty = 'Pay now at https://evil-phish.xyz/login or [verify](http://steal.io/x) or <b>bank-fake.com/auth</b> \u202Ereverse';
    const clean = sanitizeUntrustedQuote(dirty, { maxChars: 240 });
    assert.ok(!clean.includes('https://'), 'protocol URLs must be stripped');
    assert.ok(!clean.includes('http://'), 'markdown link URLs must be stripped');
    assert.ok(!clean.includes('<b>'), 'HTML tags must be stripped');
    assert.ok(!clean.includes('bank-fake.com'), 'bare domain paths must be stripped');
    assert.ok(!clean.includes('\u202E'), 'bidi override characters must be stripped');

    // Calendar template URL strips links from untrusted summary/details
    const tpl = buildGoogleCalendarTemplateUrl({
      summary: 'Meet at https://phish.com/zoom',
      startIso: '2026-11-22T16:00:00+07:00',
      details: 'Join evil.xyz/call now',
    });
    assert.ok(tpl.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE'));
    assert.ok(!decodeURIComponent(tpl).includes('https://phish.com'));
    assert.ok(!decodeURIComponent(tpl).includes('evil.xyz/call'));

    // PROVIDER_INBOX_PINNED (connector without raw headers) is clamped <= P1 (never P0, never night break-glass)
    const dirConn = tmpDir();
    const lConn = createAlertLedger({
      stateDir: dirConn,
      shadowMode: false,
      pinnedDomains: ['vercel.com'],
      clock: () => NIGHT_0230,
    });
    const connAlert = lConn.ingestSignal({
      signalId: 'conn_1',
      source: 'gmail',
      isEmail: true,
      trustedConnectorInbox: true,
      fromDomain: 'vercel.com',
      category: 'security_critical',
      stage: 'security_alert',
      confidence: 0.99,
      summary: 'Security alert on Vercel account',
      occurredAt: NIGHT_0230,
      observedAt: NIGHT_0230,
    });
    assert.equal(connAlert.case.authGrade, 'PROVIDER_INBOX_PINNED');
    assert.equal(connAlert.case.severity, 'P1', 'connector-only pinned email must clamp at <= P1 (never P0)');
    assert.equal(connAlert.decision.disposition, 'hold', 'connector-only P1 must NEVER break quiet hours');
  });

  // ── T7: 1-Tap HITL Action (§21 tap-time token + argsHash + §28 confirmEffect + Undo + Shadow) ──
  await test('T7: 1-tap HITL verifies owner DM, argsHash, §21 token, §28 confirmEffect fail-closed & undo', async () => {
    const dir = tmpDir();
    const ledger = createAlertLedger({ stateDir: dir, shadowMode: false, clock: () => DAY_10AM });
    const approvalStore = createApprovalStore({ dir: path.join(dir, 'approvals') });
    const eventsDb = new Map();
    let simulateMismatch = false;

    const tools = createToolRegistry({
      cwd: dir,
      approvalStore,
    });
    tools.register({
      name: 'calendar_read_event',
      description: 'Read calendar event by ID',
      risk: 'read_only',
      parameters: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
      execute: async ({ eventId }) => {
        if (simulateMismatch) return { id: eventId, status: 'cancelled' };
        return eventsDb.get(eventId) || { id: eventId, status: 'missing' };
      },
    });
    tools.register({
      name: 'calendar_create_event',
      description: 'Create calendar event',
      risk: 'destructive', // enforces §21 approval token + §22 grounding
      ground: ['eventId', 'summary'],
      confirm: {
        probe: 'calendar_read_event',
        expect: "$.status == 'confirmed'",
      },
      parameters: {
        type: 'object',
        properties: { eventId: { type: 'string' }, summary: { type: 'string' } },
        required: ['eventId', 'summary'],
      },
      execute: async ({ eventId, summary }) => {
        const ev = { id: eventId, summary, status: 'confirmed' };
        eventsDb.set(eventId, ev);
        return ev;
      },
    });
    tools.register({
      name: 'calendar_delete_event',
      description: 'Undo calendar event',
      risk: 'destructive',
      ground: ['eventId'],
      confirm: {
        probe: 'calendar_read_event',
        expect: "$.status == 'missing'",
      },
      parameters: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
      execute: async ({ eventId }) => {
        eventsDb.delete(eventId);
        return { deleted: true, eventId };
      },
    });

    const controller = createAlertsController({
      ledger,
      ownerIds: ['1330502578'],
    });

    const args = { eventId: 'scrollalert001', summary: 'Coffee with team' };
    const ing = ledger.ingestSignal({
      signalId: 'cal_sig_1',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-5019061209',
      containerTitle: 'AI Group',
      category: 'group_blocker_or_calendar',
      stage: 'meeting_confirmed',
      senderTrust: 'internal',
      summary: 'Coffee meeting today 16:00',
      frozenAction: {
        tool: 'calendar_create_event',
        tier: 'destructive',
        args,
        label: 'Create event: Coffee with team',
        buttonLabel: 'Create Calendar',
        undoTool: 'calendar_delete_event',
        undoTier: 'destructive',
        undoIdParam: 'eventId',
      },
      occurredAt: DAY_10AM,
      observedAt: DAY_10AM,
    });
    const cid = ing.case.caseId;
    const cbExec = makeAlertCallbackData(cid, 'exec');
    assert.ok(Buffer.byteLength(cbExec, 'utf8') <= 64);

    // 1. Non-owner rejected
    const badActor = await controller.handleCallback(
      { senderId: '999999', isDm: true, isGroup: false },
      cbExec,
      { tools, approvalStore },
    );
    assert.equal(badActor.ok, false);
    assert.equal(badActor.code, 'FORBIDDEN');

    // 2. Owner inside GROUP rejected (strict DM diode!)
    const grpActor = await controller.handleCallback(
      { senderId: '1330502578', isDm: false, isGroup: true },
      cbExec,
      { tools, approvalStore },
    );
    assert.equal(grpActor.ok, false);
    assert.equal(grpActor.code, 'FORBIDDEN');

    // 3. Fail-closed on §28 read-back mismatch
    simulateMismatch = true;
    const unconf = await controller.handleCallback(
      { senderId: '1330502578', chatId: '1330502578', isDm: true, isGroup: false },
      cbExec,
      { tools, approvalStore },
    );
    assert.equal(unconf.ok, false, 'read-back probe mismatch must fail closed');
    assert.equal(ledger.getCase(cid).frozenAction.effectStatus, 'unconfirmed');

    // 4. Valid 1-tap confirm -> executes, verifies §28 probe, records verified + offers Undo
    simulateMismatch = false;
    const okExec = await controller.handleCallback(
      { senderId: '1330502578', chatId: '1330502578', isDm: true, isGroup: false },
      cbExec,
      { tools, approvalStore },
    );
    assert.equal(okExec.ok, true, `expected exec ok, got ${JSON.stringify(okExec)}`);
    assert.equal(okExec.providerResourceId, 'scrollalert001');
    assert.equal(ledger.getCase(cid).frozenAction.effectStatus, 'verified');
    assert.ok(eventsDb.has('scrollalert001'));
    const undoBtn = okExec.card.buttons.flat().find((b) => b.callbackData === makeAlertCallbackData(cid, 'undo'));
    assert.ok(undoBtn, 'verified action card must include Undo button');

    // 5. Tap Undo -> deletes exact eventId and marks undone
    const okUndo = await controller.handleCallback(
      { senderId: '1330502578', chatId: '1330502578', isDm: true, isGroup: false },
      makeAlertCallbackData(cid, 'undo'),
      { tools, approvalStore },
    );
    assert.equal(okUndo.ok, true);
    assert.equal(eventsDb.has('scrollalert001'), false);
    assert.equal(ledger.getCase(cid).frozenAction.effectStatus, 'undone');

    // 6. Shadow mode holds all immediate pushes into shadow_digest
    const dirSh = tmpDir();
    const lSh = createAlertLedger({ stateDir: dirSh, shadowMode: true, clock: () => DAY_10AM });
    const shRes = lSh.ingestSignal({
      signalId: 'sh_1',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-999',
      category: 'group_blocker_or_calendar',
      stage: 'blocker',
      senderTrust: 'internal',
      summary: 'Blocker during shadow mode',
      occurredAt: DAY_10AM,
      observedAt: DAY_10AM,
    });
    assert.equal(shRes.decision.disposition, 'shadow_digest');
    const cSh = createAlertsController({ ledger: lSh, ownerIds: ['1330502578'] });
    const sent = [];
    await cSh.dispatchDueNotices({
      nowMs: DAY_10AM,
      sendOwnerMessage: async (card) => { sent.push(card); return { messageId: '1' }; },
    });
    assert.equal(sent.length, 0, 'shadow mode must send 0 immediate pushes at 10:00');
  });

  // ── T8: Pre-send crash/unknown suppression + dead-PID lock + SHA-256 tamper detection ──
  await test('T8: pre-send unknown suppresses blind retry, dead-PID lock recovers, SHA-256 detects tamper', async () => {
    const dir = tmpDir();
    const ledger = createAlertLedger({ stateDir: dir, shadowMode: false, clock: () => DAY_10AM });
    const controller = createAlertsController({ ledger, ownerIds: ['1330502578'] });

    const ing = ledger.ingestSignal({
      signalId: 'crash_1',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-7001',
      category: 'group_blocker_or_calendar',
      stage: 'blocker',
      senderTrust: 'internal',
      summary: 'Critical issue before simulated network timeout',
      occurredAt: DAY_10AM,
      observedAt: DAY_10AM,
    });

    // Dispatch #1 throws timeout error AFTER pre-send reservation
    let sendAttempts = 0;
    const d1 = await controller.dispatchDueNotices({
      nowMs: DAY_10AM,
      sendOwnerMessage: async () => {
        sendAttempts++;
        throw new Error('ETIMEDOUT');
      },
    });
    assert.equal(sendAttempts, 1);
    assert.equal(d1.failedImmediate.length, 1);
    const notice = ledger.getCase(ing.case.caseId).notices[0];
    assert.equal(notice.status, 'unknown');

    // Dispatch #2 MUST NOT blind-retry duplicate DM while status is unknown!
    const d2 = await controller.dispatchDueNotices({
      nowMs: DAY_10AM + 5 * 60_000,
      sendOwnerMessage: async () => {
        sendAttempts++;
        return { messageId: 'dup' };
      },
    });
    assert.equal(sendAttempts, 1, 'must suppress blind retry when prior notice status is unknown');
    assert.equal(d2.sentImmediate.length, 0);

    // Dead-PID stale lock recovery
    const lockDir = path.join(dir, 'alerts.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999, ts: Date.now() - 60_000 }));
    const stats = ledger.getStats();
    assert.equal(stats.openCases, 1);
    // Mutating must cleanly recover the dead-PID lock
    const fb = ledger.applyFeedback(ing.case.caseId, 'ack', { nowMs: DAY_10AM + 6 * 60_000 });
    assert.equal(fb.ok, true);

    // SHA-256 tamper detection on cases.json
    const casesFile = path.join(dir, 'cases.json');
    const raw = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
    raw.state.cases[ing.case.caseId].summary = 'TAMPERED_SUMMARY';
    fs.writeFileSync(casesFile, JSON.stringify(raw, null, 2));
    assert.throws(
      () => ledger.getCase(ing.case.caseId),
      /checksum_mismatch/,
      'tampered cases.json must fail SHA-256 verification',
    );
  });

  // ── T9: HTML Card Formatting, XSS Escaping, & Duplicate-Due Suppression ──
  await test('T9: HTML card format escapes untrusted markup, deduplicates deadline, and cleans link noise', () => {
    const dir = tmpDir();
    const ledger = createAlertLedger({ stateDir: dir, shadowMode: false, clock: () => DAY_10AM });
    const controller = createAlertsController({
      ledger,
      ownerIds: ['1330502578'],
      format: 'html',
      tz: 'Asia/Ho_Chi_Minh',
    });

    const ing = ledger.ingestSignal({
      signalId: 'html_cal_1',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-9001',
      containerTitle: 'Product <script>x</script> < 5 & Ops',
      category: 'group_blocker_or_calendar',
      stage: 'meeting_confirmed',
      senderTrust: 'internal',
      summary: 'Coffee sync at 16:00 22/11 (Alice & Bob) - missing on Google Calendar',
      quote: 'Alice: Meet at 4pm near park | Member: https://evil.xyz/phish | Member: <a href="http://steal.io">click</a> ok',
      deadlineAt: '2026-11-22T16:00:00+07:00',
      frozenAction: {
        tool: 'calendar_create_event',
        args: { eventId: 'scrollalert999', summary: 'Coffee sync' },
        label: 'Coffee sync (16:00 22/11)',
        buttonLabel: 'Create Calendar',
      },
      occurredAt: DAY_10AM,
      observedAt: DAY_10AM,
    });

    const card = controller.renderCaseCard(ing.case);
    assert.equal(card.parseMode, 'HTML');
    assert.ok(card.text.includes('<b>Calendar Reminder - Product x &lt; 5 &amp; Ops</b>'), `unexpected header: ${card.text}`);
    assert.ok(card.text.includes('<blockquote>'), 'HTML card should render quote inside blockquote');
    assert.ok(!card.text.includes('<script>'), 'raw script tags must never survive');
    assert.ok(!card.text.includes('<a '), 'injected anchor tags must never survive');
    assert.ok(!card.text.includes('evil.xyz'), 'phishing domain must be stripped');
    assert.ok(!card.text.includes('[link-removed]'), 'link-only noise segment should be cleaned out');
    assert.ok(!card.text.includes('Due:'), 'duplicate deadline already in summary must be omitted');
    assert.ok(card.text.includes('<i>Tap below to add this event to Google Calendar.</i>'));

    // Digest card also returns parseMode: HTML and escapes ampersands cleanly
    const digest = controller.renderDigestCard([ing.case]);
    assert.equal(digest.parseMode, 'HTML');
    assert.ok(digest.text.includes('<b>Smart Alerts Digest</b> (1)'));
    assert.ok(digest.text.includes('&amp;'));
  });

  // ── T10: Cross-vendor security burst, multi-channel merge, & human prose style ──
  await test('T10: cross-vendor login+passkey burst, multi-channel merge, & human prose style + link sanitizer', async () => {
    const dir = tmpDir();
    let now = DAY_10AM;
    const ledger = createAlertLedger({
      stateDir: dir,
      shadowMode: false,
      pinnedDomains: ['google.com', 'facebook.com', 'mbbank.com.vn'],
      clock: () => now,
    });

    // Cross-vendor 7-min account takeover burst: Google login 14:49 -> Facebook login 14:54 -> Facebook passkey 14:56
    const g1 = ledger.ingestSignal({
      signalId: 'sec_g1',
      source: 'gmail',
      isEmail: true,
      trustedConnectorInbox: true,
      fromDomain: 'google.com',
      category: 'security_critical',
      stage: 'security_alert',
      securitySubkind: 'login',
      summary: 'New sign-in to Google on Mac at 14:49',
      occurredAt: now,
      observedAt: now,
    });
    const f1 = ledger.ingestSignal({
      signalId: 'sec_f1',
      source: 'gmail',
      isEmail: true,
      trustedConnectorInbox: true,
      fromDomain: 'facebook.com',
      category: 'security_critical',
      stage: 'security_alert',
      securitySubkind: 'login',
      summary: 'New Facebook login on Mac at 14:54',
      occurredAt: now + 5 * 60_000,
      observedAt: now + 5 * 60_000,
    });
    const f2 = ledger.ingestSignal({
      signalId: 'sec_f2',
      source: 'gmail',
      isEmail: true,
      trustedConnectorInbox: true,
      fromDomain: 'facebook.com',
      category: 'security_critical',
      stage: 'security_alert',
      securitySubkind: 'passkey_or_2fa',
      summary: 'Passkey added to Facebook at 14:56',
      occurredAt: now + 7 * 60_000,
      observedAt: now + 7 * 60_000,
    });
    assert.equal(f1.action, 'merged', 'cross-vendor login within 60m must merge into security burst case');
    assert.equal(f2.action, 'merged', 'passkey addition 2m later must merge into same security burst case');
    assert.equal(f2.case.caseId, g1.case.caseId);
    assert.equal(f2.case.securityBurst, true);
    assert.equal(f2.case.distinctVendors.length, 2);
    assert.equal(f2.case.distinctCount, 3);

    // Multi-channel corroboration: Outlook + Telegram group sharing correlationTag `mbbank`
    const mbEmail = ledger.ingestSignal({
      signalId: 'mb_ol_1',
      source: 'outlook',
      isEmail: true,
      trustedConnectorInbox: true,
      fromDomain: 'mbbank.com.vn',
      category: 'finance_obligation',
      stage: 'issued',
      correlationTags: ['mbbank', 'mb_qr'],
      summary: 'MB QR statement fee 1,100,000 VND before 27/11',
      occurredAt: now,
      observedAt: now,
    });
    const mbGroup = ledger.ingestSignal({
      signalId: 'mb_grp_1',
      source: 'telegram_group',
      isGroup: true,
      containerId: '-9001',
      senderTrust: 'internal',
      category: 'finance_obligation',
      stage: 'reminder',
      correlationTags: ['mbbank', 'mb_qr'],
      summary: 'Team flagged MB QR statement fee 1,100,000 VND due 27/11',
      occurredAt: now + 20 * 60_000,
      observedAt: now + 20 * 60_000,
    });
    assert.equal(mbGroup.action, 'merged', 'multi-channel email + group sharing correlationTags must merge');
    assert.equal(mbGroup.case.caseId, mbEmail.case.caseId);
    assert.deepEqual(mbGroup.case.distinctChannels.sort(), ['outlook', 'telegram_group']);

    // Safe HTML sanitizer keeps allowlisted Outlook permalink & strips phishing anchor
    const html = sanitizeSafeHtmlMessage(
      'Check <b>MB Bank</b> now. <a href="https://outlook.live.com/mail/0/inbox/id/abc">View in Outlook</a> and <a href="https://evil-phish.xyz/login">Steal</a>'
    );
    assert.ok(html.includes('<b>MB Bank</b>'));
    assert.ok(html.includes('href="https://outlook.live.com/mail/0/inbox/id/abc"'));
    assert.ok(!html.includes('evil-phish.xyz'), 'phishing anchor href must be stripped');

    // Human style controller sends ZERO buttons on non-action alerts and supports composeNotice veto
    const sent = [];
    const ctrl = createAlertsController({
      ledger,
      ownerIds: ['1330502578'],
      style: 'human',
      format: 'html',
      composeNotice: async (c) => {
        if (c.caseId === mbEmail.case.caseId) return { skip: true, skipReason: 'low_priority_veto' };
        return { text: 'Hey, did you just sign in to <b>Google</b> and add a Facebook <b>passkey</b>?', parseMode: 'HTML' };
      },
    });
    await ctrl.dispatchDueNotices({
      nowMs: now + 25 * 60_000,
      sendOwnerMessage: async (card) => { sent.push(card); return { messageId: 'm_hum_1' }; },
    });
    assert.equal(sent.length, 1, 'vetoed case must be suppressed, security burst must be sent');
    assert.equal(sent[0].buttons.length, 0, 'human style non-action alert must have zero robotic buttons');
    assert.equal(ledger.getCase(mbEmail.case.caseId).state, 'closed');
    assert.equal(ledger.getCase(mbEmail.case.caseId).closedReason, 'low_priority_veto');
  });

  // ── T11: Rollup uses composeDigest/veto (no legacy card leak) + same-timestamp rephrase dedup ──
  await test('T11: rollup routes through composeDigest/human prose (never [link-removed]) & dedupes same-timestamp rephrases', async () => {
    const dir = tmpDir();
    const now = DAY_10AM;
    const ledger = createAlertLedger({
      stateDir: dir,
      shadowMode: false,
      pinnedDomains: ['mbbank.com.vn', 'vercel.com', 'supabase.com'],
      clock: () => now,
    });

    // 1. Same email paraphrased VN vs EN on two consecutive hourly polls (identical occurredAt + vendor + amount)
    const p1 = ledger.ingestSignal({
      signalId: 'ol_poll_1',
      source: 'outlook',
      isEmail: true,
      trustedConnectorInbox: true,
      fromDomain: 'mbbank.com.vn',
      containerTitle: 'Outlook · mbbank.com.vn',
      category: 'security_critical',
      stage: 'security_alert',
      securitySubkind: 'card_issuance',
      amount: { currency: 'USD', value: 222.22 },
      summary: 'Card transaction notice',
      quote: 'Card 2260 charged 222.22 USD at vendor on 2026-11-23 08:25:13',
      occurredAt: now - 30 * 60_000,
      observedAt: now - 25 * 60_000,
    });
    const p2 = ledger.ingestSignal({
      signalId: 'ol_poll_2',
      source: 'outlook',
      isEmail: true,
      trustedConnectorInbox: true,
      fromDomain: 'mbbank.com.vn',
      containerTitle: 'Outlook · mbbank.com.vn',
      category: 'security_critical',
      stage: 'security_alert',
      securitySubkind: 'card_issuance',
      amount: { currency: 'USD', value: 222.22 },
      summary: 'Card transaction notice',
      quote: 'Different language paraphrase for 222.22 USD at same exact second',
      occurredAt: now - 30 * 60_000,
      observedAt: now,
    });
    assert.equal(p2.action, 'merged');
    assert.equal(p2.case.distinctCount, 1, 'same-timestamp rephrase must have weight 0');
    assert.equal(p2.case.securityBurst, false, 'same-timestamp rephrase must NOT trigger securityBurst');

    // 2. Fallback renderRollupCard preserves vendor label cleanly (never [link-removed])
    const ctrlPlain = createAlertsController({ ledger, ownerIds: ['1330502578'], format: 'html' });
    const rawRollup = ctrlPlain.renderRollupCard([{ case: p2.case }]);
    assert.ok(rawRollup.text.includes('mbbank.com.vn'), 'rollup fallback must keep vendor label readable');
    assert.ok(!rawRollup.text.includes('[link-removed]'), 'rollup fallback must never redact vendor into [link-removed]');

    // 3. Trigger unacked_p1_backpressure rollup (3 already-sent unacked P1 cases -> subsequent P1s go to rollup!)
    const c2 = ledger.ingestSignal({
      signalId: 'vc_1', source: 'gmail', isEmail: true, trustedConnectorInbox: true,
      fromDomain: 'vercel.com', category: 'finance_emergency', stage: 'payment_failed',
      summary: 'Vercel payment failed', occurredAt: now + 1000, observedAt: now + 1000,
    });
    const c3 = ledger.ingestSignal({
      signalId: 'sb_1', source: 'gmail', isEmail: true, trustedConnectorInbox: true,
      fromDomain: 'supabase.com', category: 'finance_emergency', stage: 'payment_failed',
      summary: 'Supabase payment failed', occurredAt: now + 2000, observedAt: now + 2000,
    });
    // Mark 3 cases as already sent & unacked so subsequent P1 cases trigger rollup backpressure
    for (const cid of [p2.case.caseId, c2.case.caseId, c3.case.caseId]) {
      const r = ledger.reserveNotice(cid, { purpose: 'immediate', nowMs: now + 3000 });
      ledger.confirmNotice(cid, r.notice.noticeId, { providerMessageId: `m_${cid}`, nowMs: now + 3000 });
    }
    const c4 = ledger.ingestSignal({
      signalId: 'mb_4', source: 'outlook', isEmail: true, trustedConnectorInbox: true,
      fromDomain: 'mbbank.com.vn', containerTitle: 'Outlook · mbbank.com.vn',
      category: 'finance_emergency', stage: 'suspension_notice',
      summary: 'MB final suspension warning', occurredAt: now + 4000, observedAt: now + 4000,
    });
    const c5 = ledger.ingestSignal({
      signalId: 'vc_5', source: 'gmail', isEmail: true, trustedConnectorInbox: true,
      fromDomain: 'vercel.com', category: 'finance_emergency', stage: 'payment_failed',
      summary: 'Vercel duplicate minor notice', occurredAt: now + 4500, observedAt: now + 4500,
    });
    assert.equal(c4.decision.disposition, 'rollup', '4th unacked P1 must route to rollup');

    const sentRollup = [];
    let sawRollupFlag = false;
    const ctrlHuman = createAlertsController({
      ledger,
      ownerIds: ['1330502578'],
      style: 'human',
      format: 'html',
      composeDigest: async (items, opts) => {
        if (opts?.isRollup) sawRollupFlag = true;
        return {
          text: 'Hey, quick heads-up on <b>MBBank</b> — please check directly in the app.',
          parseMode: 'HTML',
          vetoCaseIds: [c5.case.caseId],
          buttons: [],
        };
      },
    });
    await ctrlHuman.dispatchDueNotices({
      nowMs: now + 5000,
      sendOwnerMessage: async (card, meta) => { sentRollup.push({ card, meta }); return { messageId: 'm_rollup_1' }; },
    });
    const rollupDeliveries = sentRollup.filter((x) => x.meta?.kind === 'rollup');
    assert.equal(rollupDeliveries.length, 1, 'rollup must send via human composeDigest');
    assert.equal(sawRollupFlag, true, 'composeDigest must receive isRollup: true');
    assert.ok(rollupDeliveries[0].card.text.includes('quick heads-up on <b>MBBank</b>'));
    assert.ok(!rollupDeliveries[0].card.text.includes('[link-removed]'));
    assert.equal(rollupDeliveries[0].card.buttons.length, 0);
    assert.equal(ledger.getCase(c5.case.caseId).state, 'closed', 'vetoed rollup case must be suppressed');
    assert.ok(c4.case.caseId);
  });

  console.log(`\nALL ${passed}/11 §51 Smart Alerts gates PASSED!`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
