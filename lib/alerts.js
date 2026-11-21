// SCROLL 2.6 -- §51 Smart Alerts / Proactive Signal Ledger (Zero-Dep, Model-Free).
//
// Core invariant: commit three facts independently in durable storage:
//   1. Evidence arrived / Case escalated (`signals[]`, `urgencyScore`, `severity`)
//   2. Owner was notified (`notices[]`, pre-send reservation, never blind-retried on `unknown`)
//   3. Authorized action took effect (delegated to §21 `approvalStore` + §28 `confirmEffect`)
//
// Zero runtime dependencies. Node >= 20 built-ins only. Pure data/policy engine:
// no internal timers (§49 scheduler invokes `tick(now)`), no LLM calls, no prompts,
// no arbitrary recipient overrides (destination pinned to verified Owner DM at controller layer).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';
import { zonedParts } from './scheduler.js';
import { parseAmount } from './grounding.js';
import { canonicalJson } from './chat-telemetry.js';

export const ALERTS_SCHEMA = 'scroll-alerts/1';

export const ALERT_CAPS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxCases: 10_000,
  maxSignalsPerCase: 40,
  maxNoticesPerCase: 20,
  maxEventsHistory: 50_000,
  maxQuoteChars: 600,
  maxSummaryChars: 300,
});

const BILLING_PROXIES = new Set([
  'stripe.com',
  'paddle.com',
  'chargebee.com',
  'amazonses.com',
  'sendgrid.net',
  'mailgun.org',
  'postmarkapp.com',
  'fastspring.com',
  'braintreegateway.com',
]);

const DEFAULT_TRUSTED_MTAS = [
  'mx.google.com',
  'google.com',
  'protection.outlook.com',
  'mail.protection.outlook.com',
];

const EMERGENCY_P0_CATEGORIES = new Set([
  'security_critical',
  'finance_emergency',
]);

const CATEGORY_MULTIPLIER = Object.freeze({
  security_critical: 1.30,
  finance_emergency: 1.30,
  finance_obligation: 1.20,
  group_blocker_or_calendar: 1.05,
  ops_general: 0.85,
});

const STAGE_ORDER = Object.freeze({
  fyi: 0,
  issued: 1,
  reminder: 2,
  payment_failed: 3,
  past_due: 4,
  suspension_notice: 5,
  security_alert: 5,
  escalation: 4,
  blocker: 4,
  meeting_proposed: 2,
  meeting_confirmed: 3,
  cancelled: 0,
});

const SEVERITY_RANK = Object.freeze({
  P3: 0,
  P2: 1,
  P1: 2,
  P0: 3,
});

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str ?? ''), 'utf8').digest('hex');
}

export function computeArgsHash(tool, args) {
  return `sha256:${sha256Hex(canonicalJson({ tool: String(tool || ''), args: args || {} }))}`;
}

export function normalizeTextForHash(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeText(text) {
  const norm = normalizeTextForHash(text);
  if (!norm) return [];
  return [...new Set(norm.split(' ').filter((w) => w.length >= 2))];
}

// Deterministic 64-bit SimHash over character/word shingles (zero dependencies)
export function simhash64(text) {
  const tokens = tokenizeText(text);
  if (!tokens.length) return '0000000000000000';
  const weights = new Int32Array(64);
  for (const tok of tokens) {
    const h = crypto.createHash('sha256').update(tok).digest();
    const hi = h.readUInt32BE(0);
    const lo = h.readUInt32BE(4);
    for (let i = 0; i < 32; i++) {
      weights[i] += ((hi >>> (31 - i)) & 1) ? 1 : -1;
      weights[32 + i] += ((lo >>> (31 - i)) & 1) ? 1 : -1;
    }
  }
  let hiOut = 0n;
  let loOut = 0n;
  for (let i = 0; i < 32; i++) {
    if (weights[i] >= 0) hiOut |= 1n << BigInt(31 - i);
    if (weights[32 + i] >= 0) loOut |= 1n << BigInt(31 - i);
  }
  const combined = (hiOut << 32n) | loOut;
  return combined.toString(16).padStart(16, '0');
}

export function simhashDistance(hexA, hexB) {
  if (!hexA || !hexB) return 64;
  let x = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let bits = 0;
  while (x > 0n) {
    x &= x - 1n;
    bits++;
  }
  return bits;
}

export function canonicalizeDomain(rawDomain) {
  const clean = String(rawDomain || '')
    .trim()
    .toLowerCase()
    .replace(/^.*@/, '')
    .replace(/[>\s].*$/, '')
    .replace(/\.+$/, '');
  if (!clean) return '';
  try {
    const ascii = url.domainToASCII(clean);
    return (ascii || clean).toLowerCase();
  } catch {
    return clean;
  }
}

export function extractEtldPlusOne(rawDomain) {
  const d = canonicalizeDomain(rawDomain);
  if (!d) return '';
  const parts = d.split('.').filter(Boolean);
  if (parts.length <= 2) return d;
  const twoLevelCcTlds = new Set(['com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn', 'co.uk', 'co.jp', 'com.au', 'com.sg', 'co.kr']);
  const tail2 = parts.slice(-2).join('.');
  if (twoLevelCcTlds.has(tail2) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return tail2;
}

// Top-hop Authentication-Results parser (strictly index 0 stamped by trusted receiving MTA).
// Rejects forged lower-hop Authentication-Results headers and Punycode lookalikes.
export function verifyTopHopAuthGrade({
  authHeaders = [],
  fromDomain = '',
  pinnedDomains = [],
  trustedMtas = DEFAULT_TRUSTED_MTAS,
} = {}) {
  const list = Array.isArray(authHeaders) ? authHeaders : (authHeaders ? [String(authHeaders)] : []);
  if (!list.length) return { authGrade: 'UNVERIFIED', reason: 'no_auth_headers', alignedDomain: '' };

  const top = String(list[0] || '').trim();
  if (!top) return { authGrade: 'UNVERIFIED', reason: 'empty_top_auth_header', alignedDomain: '' };

  // Extract authserv-id before first semicolon
  const authserv = top.split(';')[0].trim().toLowerCase();
  const trustedHit = trustedMtas.some((m) => {
    const t = String(m || '').toLowerCase();
    return authserv === t || authserv.endsWith(`.${t}`) || authserv.includes(t);
  });
  if (!trustedHit) {
    return { authGrade: 'UNVERIFIED', reason: `untrusted_mta:${authserv.slice(0, 64)}`, alignedDomain: '' };
  }

  const dkimPass = /\bdkim\s*=\s*pass\b/i.test(top);
  const dmarcPass = /\bdmarc\s*=\s*pass\b/i.test(top);
  if (!dkimPass || !dmarcPass) {
    return {
      authGrade: 'UNVERIFIED',
      reason: !dmarcPass ? 'dmarc_not_pass' : 'dkim_not_pass',
      alignedDomain: '',
    };
  }

  const dkimDomainMatch = top.match(/\bheader\.d\s*=\s*([a-z0-9._-]+)/i);
  const dmarcFromMatch = top.match(/\bheader\.from\s*=\s*([a-z0-9._-]+)/i);
  const rawAligned = dkimDomainMatch?.[1] || dmarcFromMatch?.[1] || fromDomain;
  const alignedAscii = canonicalizeDomain(rawAligned);
  const alignedOrg = extractEtldPlusOne(alignedAscii);
  if (!alignedAscii || !alignedOrg) {
    return { authGrade: 'UNVERIFIED', reason: 'missing_aligned_domain', alignedDomain: '' };
  }

  // Punycode homograph rejection unless explicitly pinned in ASCII form
  const pinnedSet = new Set((pinnedDomains || []).map((d) => canonicalizeDomain(d)).filter(Boolean));
  const pinnedOrgs = new Set((pinnedDomains || []).map((d) => extractEtldPlusOne(d)).filter(Boolean));
  const isPinned = pinnedSet.has(alignedAscii) || pinnedOrgs.has(alignedOrg);

  if (alignedAscii.split('.').some((label) => label.startsWith('xn--')) && !isPinned) {
    return {
      authGrade: 'UNVERIFIED',
      reason: 'punycode_homograph_rejected',
      alignedDomain: alignedAscii,
    };
  }

  if (!isPinned) {
    return {
      authGrade: 'DOMAIN_VERIFIED_NOT_PINNED',
      reason: 'domain_not_in_pinned_allowlist',
      alignedDomain: alignedAscii,
    };
  }
  return {
    authGrade: 'CRYPTO_VERIFIED',
    reason: 'top_hop_dkim_dmarc_pinned_pass',
    alignedDomain: alignedAscii,
  };
}

export function extractHardIds(text) {
  const s = String(text || '');
  const invoice = new Set();
  const account = new Set();
  const resource = new Set();

  // Invoice / receipt / contract IDs (high entropy: >= 5 chars with at least one digit)
  const invRe = /\b(?:inv(?:oice)?|bill|receipt|contract|order|ref)[#:\s-]*([A-Z0-9][A-Z0-9_-]{3,28})\b/gi;
  let m;
  while ((m = invRe.exec(s)) !== null) {
    const id = m[1].toUpperCase();
    if (/\d/.test(id) && id.length >= 4) invoice.add(id);
  }
  // Bare prefixed codes like R2026-884129, INV-9001, HNH065727-2026-10
  const codeRe = /\b([A-Z]{1,5}\d{2,6}[-_][A-Z0-9_-]{2,20})\b/g;
  while ((m = codeRe.exec(s)) !== null) {
    invoice.add(m[1].toUpperCase());
  }

  // Account / customer / card last-4 IDs
  const acctRe = /\b(?:account|acct|customer|client|card|ending\s+in)[#:\s*-]*([A-Z0-9]{4,20})\b/gi;
  while ((m = acctRe.exec(s)) !== null) {
    const id = m[1].toUpperCase();
    if (/\d/.test(id)) account.add(id);
  }

  // Server / project / domain resource IDs (e.g. cx41-prod, api-gateway-1, example.vn)
  const resRe = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+){1,4})\b/gi;
  while ((m = resRe.exec(s)) !== null) {
    const tok = m[1].toLowerCase();
    if (/\d/.test(tok) && tok.length >= 5 && !invoice.has(tok.toUpperCase())) {
      resource.add(tok);
    }
  }

  return {
    invoice: [...invoice].slice(0, 8),
    account: [...account].slice(0, 8),
    resource: [...resource].slice(0, 8),
  };
}

export function extractAmountTuple(text) {
  const s = String(text || '');
  // Match currency-prefixed or currency-suffixed amounts (ASCII-safe; locale adapters pass `amount` directly)
  const patterns = [
    { re: /\$\s*([0-9][0-9,._]*(?:\.\d{1,2})?)/, currency: 'USD' },
    { re: /\b(USD|EUR|GBP|SGD|JPY|KRW|VND)\s*([0-9][0-9,._]*(?:\.\d{1,2})?)\b/i, dynamic: 1 },
    { re: /\b([0-9][0-9.,_]*)\s*(USD|EUR|GBP|SGD|JPY|KRW|VND)\b/i, dynamic: 2 },
  ];
  for (const p of patterns) {
    const m = s.match(p.re);
    if (!m) continue;
    let currency = p.currency;
    let rawNum = m[1];
    if (p.dynamic === 1) {
      currency = m[1].toUpperCase();
      rawNum = m[2];
    } else if (p.dynamic === 2) {
      rawNum = m[1];
      currency = m[2].toUpperCase();
    }
    const val = parseAmount(rawNum);
    if (val != null && Number.isFinite(val) && val > 0) {
      return { currency, value: val };
    }
  }
  return null;
}

export function extractEffectiveVendor({
  fromDomain = '',
  replyToDomain = '',
  fromDisplay = '',
  alignedDomain = '',
} = {}) {
  const baseOrg = extractEtldPlusOne(alignedDomain || fromDomain);
  if (baseOrg && !BILLING_PROXIES.has(baseOrg)) return baseOrg;

  // Proxy sender (Stripe/Paddle/SES/etc.): extract merchant from Reply-To or Display Brand
  const replyOrg = extractEtldPlusOne(replyToDomain);
  if (replyOrg && !BILLING_PROXIES.has(replyOrg)) return replyOrg;

  const brand = String(fromDisplay || '')
    .toLowerCase()
    .replace(/\b(?:via|billing|noreply|no-reply|support|receipts|invoices|payments|notifications|stripe|paddle)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)[0];
  if (brand && brand.length >= 3) return `${brand}`;
  return baseOrg || '';
}

export function extractCanonicalFeatures(rawSignal = {}) {
  const combinedText = [
    rawSignal.subject || '',
    rawSignal.summary || '',
    rawSignal.quote || '',
    rawSignal.snippet || '',
  ].filter(Boolean).join(' ');

  const hardIds = extractHardIds(combinedText);
  if (Array.isArray(rawSignal.invoiceIds)) {
    for (const id of rawSignal.invoiceIds) {
      const clean = String(id || '').trim().toUpperCase();
      if (clean && !hardIds.invoice.includes(clean)) hardIds.invoice.push(clean);
    }
  }
  if (Array.isArray(rawSignal.accountIds)) {
    for (const id of rawSignal.accountIds) {
      const clean = String(id || '').trim().toUpperCase();
      if (clean && !hardIds.account.includes(clean)) hardIds.account.push(clean);
    }
  }
  if (Array.isArray(rawSignal.resourceIds)) {
    for (const id of rawSignal.resourceIds) {
      const clean = String(id || '').trim().toLowerCase();
      if (clean && !hardIds.resource.includes(clean)) hardIds.resource.push(clean);
    }
  }

  const threadKeys = [...new Set([
    ...(Array.isArray(rawSignal.threadKeys) ? rawSignal.threadKeys : []),
    rawSignal.rfcMessageId,
    rawSignal.inReplyTo,
    ...(Array.isArray(rawSignal.references) ? rawSignal.references : []),
    rawSignal.threadId ? `${rawSignal.source || 'src'}:thread:${rawSignal.threadId}` : null,
    rawSignal.containerId && rawSignal.topicRootId
      ? `${rawSignal.source || 'src'}:topic:${rawSignal.containerId}:${rawSignal.topicRootId}`
      : null,
  ].map((v) => String(v || '').trim()).filter(Boolean))];

  const amount = rawSignal.amount && typeof rawSignal.amount === 'object' && Number.isFinite(Number(rawSignal.amount.value))
    ? { currency: String(rawSignal.amount.currency || 'USD').toUpperCase(), value: Number(rawSignal.amount.value) }
    : extractAmountTuple(combinedText);

  const effectiveVendor = rawSignal.effectiveVendor
    ? String(rawSignal.effectiveVendor).toLowerCase().trim()
    : extractEffectiveVendor({
        fromDomain: rawSignal.fromDomain,
        replyToDomain: rawSignal.replyToDomain,
        fromDisplay: rawSignal.fromDisplay,
        alignedDomain: rawSignal.alignedDomain,
      });

  const simhash = rawSignal.simhash64 || simhash64(rawSignal.snippet || rawSignal.quote || rawSignal.summary || rawSignal.subject || '');
  const tokens = tokenizeText(combinedText).slice(0, 64);

  return {
    effectiveVendor,
    hardIds,
    threadKeys,
    amount,
    simhash64: simhash,
    tokens,
  };
}

function jaccard(arrA, arrB) {
  const a = new Set(arrA || []);
  const b = new Set(arrB || []);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function hasIntersection(arrA, arrB) {
  if (!Array.isArray(arrA) || !Array.isArray(arrB) || !arrA.length || !arrB.length) return false;
  const setA = new Set(arrA);
  for (const x of arrB) if (setA.has(x)) return true;
  return false;
}

// ── 4 Hard Anti-False-Merge Vetoes (code-enforced; LLM cannot override) ──────
export function checkAntiMergeVetoes(signal, existingCase, { nowMs = Date.now() } = {}) {
  if (!existingCase) return { vetoed: true, reason: 'missing_case' };

  // Veto #4: Sealed Epoch Veto (closed or aged past active window)
  const maxAgeDays = (existingCase.category === 'finance_obligation' || existingCase.category === 'finance_emergency') ? 45 : 14;
  if (existingCase.state === 'closed') {
    return { vetoed: true, reason: 'sealed_epoch_closed' };
  }
  const lastActivity = Number(existingCase.lastEvidenceAt || existingCase.openedAt || 0);
  if (lastActivity > 0 && (nowMs - lastActivity) > maxAgeDays * DAY_MS) {
    return { vetoed: true, reason: 'sealed_epoch_aged' };
  }

  // Veto #1: Disjoint Instance ID Veto (two distinct invoice IDs NEVER merge unless multi-invoice statement)
  const sigInv = signal.hardIds?.invoice || [];
  const caseInv = existingCase.hardIds?.invoice || [];
  if (!signal.isMultiInvoiceStatement && sigInv.length > 0 && caseInv.length > 0 && !hasIntersection(sigInv, caseInv)) {
    return { vetoed: true, reason: 'disjoint_invoice_id' };
  }

  // Veto #2: Trust-Downgrade Hijack Veto (unverified email CANNOT hijack a CRYPTO_VERIFIED case)
  if (existingCase.authGrade === 'CRYPTO_VERIFIED' && signal.isEmail) {
    if (signal.authGrade !== 'CRYPTO_VERIFIED') {
      return { vetoed: true, reason: 'trust_downgrade_hijack' };
    }
    if (existingCase.effectiveVendor && signal.effectiveVendor && existingCase.effectiveVendor !== signal.effectiveVendor) {
      return { vetoed: true, reason: 'verified_vendor_mismatch' };
    }
  }

  // Veto #3: One-Off Successful Transaction Receipt Veto
  if (signal.isOneOffReceipt || existingCase.isOneOffReceipt) {
    const lastSig = existingCase.signals?.[existingCase.signals.length - 1];
    const dt = lastSig ? Math.abs(Number(signal.occurredAt || nowMs) - Number(lastSig.occurredAt || 0)) : Infinity;
    if (dt > 15 * MINUTE_MS && !signal.isRetryOrFailed) {
      return { vetoed: true, reason: 'one_off_receipt_distinct' };
    }
  }

  return { vetoed: false, reason: null };
}

export function computeDeterministicAffinity(signal, existingCase) {
  const vendorMatch = Boolean(signal.effectiveVendor && existingCase.effectiveVendor && signal.effectiveVendor === existingCase.effectiveVendor);
  const acctMatch = hasIntersection(signal.hardIds?.account, existingCase.hardIds?.account)
    || hasIntersection(signal.hardIds?.resource, existingCase.hardIds?.resource);
  let amountMatch = false;
  if (signal.amount && existingCase.latestAmount && signal.amount.currency === existingCase.latestAmount.currency) {
    const maxAmt = Math.max(signal.amount.value, existingCase.latestAmount.value, 1e-9);
    amountMatch = Math.abs(signal.amount.value - existingCase.latestAmount.value) / maxAmt <= 0.02;
  }
  const tokenOverlap = jaccard(signal.tokens, existingCase.tokens);
  const score = (vendorMatch ? 0.35 : 0) + (acctMatch ? 0.25 : 0) + (amountMatch ? 0.20 : 0) + (0.20 * tokenOverlap);
  return { score: Number(score.toFixed(4)), vendorMatch, acctMatch, amountMatch, tokenOverlap: Number(tokenOverlap.toFixed(4)) };
}

// ── Smooth Recurrence Escalation Formula U(C, t) in [0, 100] ─────────────────
export function computeBaseScore(sig) {
  if (typeof sig.baseScore === 'number' && Number.isFinite(sig.baseScore)) {
    return Math.max(0, Math.min(80, sig.baseScore));
  }
  const cat = sig.category || 'ops_general';
  const stage = sig.stage || 'fyi';
  if (stage === 'security_alert') {
    return sig.authGrade === 'CRYPTO_VERIFIED' ? 72 : 35;
  }
  if (stage === 'suspension_notice') return 64;
  if (stage === 'payment_failed' || stage === 'past_due' || stage === 'blocker' || stage === 'meeting_confirmed') {
    return 58;
  }
  if (cat === 'security_critical' || cat === 'finance_emergency') {
    if (sig.authGrade !== 'CRYPTO_VERIFIED') return 35;
    return stage === 'issued' ? 32 : 64;
  }
  if (stage === 'reminder' || stage === 'escalation' || stage === 'meeting_proposed') return 38;
  if (cat === 'group_blocker_or_calendar') return 38;
  return 20; // routine issued invoice / FYI
}

export function computeUrgencyAndSeverity(caseObj, {
  nowMs = Date.now(),
  internalConfirmingMembers = 0,
} = {}) {
  const signals = Array.isArray(caseObj.signals) ? caseObj.signals : [];
  if (!signals.length) return { urgencyScore: 0, severity: 'P3', distinctCount: 0, securityBurst: false };

  const cat = caseObj.category || signals[0].category || 'ops_general';
  const mult = CATEGORY_MULTIPLIER[cat] ?? 0.85;
  const isFinance = cat === 'finance_obligation' || cat === 'finance_emergency';
  const lambdaPerDay = isFinance ? (Math.LN2 / 10) : (Math.LN2 / 2);

  const b0 = computeBaseScore(signals[0]);
  let recurrenceSum = 0;
  let distinctCount = 1;
  let prevEffective = signals[0];
  let recentSecurityCount = (cat === 'security_critical' || signals[0].stage === 'security_alert')
    && (nowMs - Number(signals[0].occurredAt || nowMs) <= HOUR_MS)
    ? 1
    : 0;

  for (let i = 1; i < signals.length; i++) {
    const s = signals[i];
    const tCur = Number(s.occurredAt || nowMs);
    const tPrev = Number(prevEffective.occurredAt || 0);
    const dtMs = Math.max(0, tCur - tPrev);
    const simDist = simhashDistance(s.simhash64, prevEffective.simhash64);

    const prevRank = STAGE_ORDER[prevEffective.stage] ?? 1;
    const curRank = STAGE_ORDER[s.stage] ?? 1;
    const stageProgressed = curRank > prevRank || Boolean(s.materialDelta);

    // Cross-mailbox twin (<30m & SimHash <= 3 bits, same stage) or identical RFC messageId -> weight 0
    const isSameMsgId = Boolean(s.rfcMessageId && prevEffective.rfcMessageId && s.rfcMessageId === prevEffective.rfcMessageId);
    const isCrossMailboxTwin = !stageProgressed && dtMs < 30 * MINUTE_MS && simDist <= 3;
    const isIdenticalStateSpam = !stageProgressed && s.deltaHash && prevEffective.deltaHash && s.deltaHash === prevEffective.deltaHash && dtMs < 6 * HOUR_MS;
    const isSecuritySignal = cat === 'security_critical' || s.stage === 'security_alert';

    if (isSameMsgId || isCrossMailboxTwin) {
      continue;
    }

    if (isSecuritySignal && (nowMs - tCur) <= HOUR_MS) {
      recentSecurityCount++;
    }

    if (isIdenticalStateSpam && !(isSecuritySignal && recentSecurityCount >= 3)) {
      continue;
    }

    let gain = 0;
    if (stageProgressed && dtMs >= 10_000) {
      gain = 26;
      distinctCount++;
      prevEffective = s;
    } else if (isSecuritySignal && recentSecurityCount >= 3 && simDist > 0) {
      gain = 26;
      distinctCount++;
      prevEffective = s;
    } else if (dtMs >= 6 * HOUR_MS) {
      gain = 16;
      distinctCount++;
      prevEffective = s;
    } else if (s.source !== prevEffective.source && simDist > 3 && dtMs >= 5 * MINUTE_MS) {
      // Distinct cross-source corroboration (e.g. email + group message)
      gain = 20;
      distinctCount++;
      prevEffective = s;
    }

    if (gain > 0) {
      const ageDays = Math.max(0, (nowMs - tCur) / DAY_MS);
      recurrenceSum += gain * Math.exp(-lambdaPerDay * ageDays);
    }
  }

  const securityBurst = recentSecurityCount >= 3;
  const cappedRecurrence = Math.min(45, recurrenceSum);

  // Deadline boost D(Delta T)
  let deadlineBoost = 0;
  if (caseObj.deadlineAt) {
    const dueMs = Date.parse(caseObj.deadlineAt);
    if (Number.isFinite(dueMs)) {
      const deltaMs = dueMs - nowMs;
      if (deltaMs > -7 * DAY_MS && deltaMs <= 24 * HOUR_MS) deadlineBoost = 22;
      else if (deltaMs > 24 * HOUR_MS && deltaMs <= 72 * HOUR_MS) deadlineBoost = 12;
    }
  }

  const rawScore = mult * (b0 + cappedRecurrence + deadlineBoost);
  const urgencyScore = Number(Math.max(0, Math.min(100, rawScore)).toFixed(2));

  let severity = 'P3';
  if (urgencyScore >= 85) severity = 'P0';
  else if (urgencyScore >= 60) severity = 'P1';
  else if (urgencyScore >= 35) severity = 'P2';
  else severity = 'P3';

  // ── Mechanical Provenance Clamping (LLM CANNOT bypass these gates!) ──
  const maxConfidence = Math.max(...signals.map((s) => Number(s.confidence ?? 0.9)));
  const isEmailOnly = signals.every((s) => s.isEmail);
  const isGroupOnly = signals.every((s) => s.isGroup);
  const hasCryptoVerified = caseObj.authGrade === 'CRYPTO_VERIFIED' || signals.some((s) => s.authGrade === 'CRYPTO_VERIFIED');
  const isClosedEmergencyCat = EMERGENCY_P0_CATEGORIES.has(cat) || signals.some((s) => s.stage === 'suspension_notice');

  if (isEmailOnly && !hasCryptoVerified) {
    // Unverified email is HARD-CLAMPED at P2 regardless of text urgency or LLM confidence!
    if (SEVERITY_RANK[severity] > SEVERITY_RANK.P2) severity = 'P2';
  }

  if (isGroupOnly && severity === 'P0') {
    // Group messages NEVER trigger P0 unless >=2 internal USER.md members confirm a critical outage
    const internalCount = Math.max(
      Number(internalConfirmingMembers || 0),
      new Set(signals.filter((s) => s.senderTrust === 'internal').map((s) => s.senderId).filter(Boolean)).size
    );
    if (internalCount < 2) severity = 'P1';
  }

  if (severity === 'P0') {
    const eligibleP0 = maxConfidence >= 0.92
      && (
        (hasCryptoVerified && isClosedEmergencyCat)
        || (!isEmailOnly && !isGroupOnly && hasCryptoVerified)
        || (isGroupOnly && new Set(signals.filter((s) => s.senderTrust === 'internal').map((s) => s.senderId).filter(Boolean)).size >= 2)
      );
    if (!eligibleP0) severity = 'P1';
  }

  return { urgencyScore, severity, distinctCount, securityBurst };
}

// ── Durable Atomic Single-Writer Store (O_EXCL lock + fsync + SHA-256) ───────
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function fsyncDirBestEffort(dir) {
  try {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* macOS/FUSE may not support directory fsync */ }
}

function writeAtomicDurable(filePath, contentStr) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(tmp, flags, 0o600);
  try {
    fs.writeFileSync(fd, contentStr, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
  fsyncDirBestEffort(dir);
}

export function createAlertLedger({
  stateDir = null,
  tz = 'Asia/Ho_Chi_Minh',
  clock = () => Date.now(),
  shadowMode = true,
  quietHoursStart = 22,
  quietHoursEnd = 8,
  maxDailyP1 = 4,
  maxNightP0 = 2,
  maxUnackedBeforeRollup = 3,
  digestHours = [9, 18],
  shadowDigestHour = 21,
  pinnedDomains = [],
  trustedMtas = DEFAULT_TRUSTED_MTAS,
  allowNightP0 = true,
  policyVersion = '1',
} = {}) {
  const absDir = stateDir ? path.resolve(stateDir) : null;
  const casesFile = absDir ? path.join(absDir, 'cases.json') : null;
  const eventsFile = absDir ? path.join(absDir, 'events.jsonl') : null;
  const lockDir = absDir ? path.join(absDir, 'alerts.lock') : null;

  function emptyState() {
    return {
      schema: ALERTS_SCHEMA,
      revision: 0,
      createdAt: clock(),
      updatedAt: clock(),
      shadowMode: Boolean(shadowMode),
      cases: {},
      mutes: {},
      demotions: {},
      feedbackHistory: {},
      cursors: {},
      dailyStats: {},
      lastDigestKey: null,
      lastHeartbeatDay: null,
    };
  }

  function withDirLock(fn) {
    if (!absDir || !lockDir) return fn();
    fs.mkdirSync(absDir, { recursive: true, mode: 0o700 });
    const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const ownerFile = path.join(lockDir, 'owner.json');
    let acquired = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        acquired = true;
        break;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        // Reclaim ONLY if recorded PID on same host (or omitted host) is provably dead,
        // or if lock directory has been orphaned without owner.json for > 10s.
        try {
          const meta = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          const sameHost = !meta?.host || meta.host === os.hostname();
          if (meta && sameHost && !isProcessAlive(Number(meta.pid))) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          try {
            const st = fs.statSync(lockDir);
            if (Date.now() - st.mtimeMs > 10_000) {
              fs.rmSync(lockDir, { recursive: true, force: true });
              continue;
            }
          } catch { continue; }
        }
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8);
        } catch { /* ignore */ }
      }
    }
    if (!acquired) throw new Error('alerts_ledger_lock_busy');
    try {
      fs.writeFileSync(ownerFile, JSON.stringify({ token, pid: process.pid, host: os.hostname(), at: Date.now() }) + '\n', { mode: 0o600 });
      return fn();
    } finally {
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  function readStateNoLock() {
    if (!casesFile || !fs.existsSync(casesFile)) return emptyState();
    const st = fs.lstatSync(casesFile);
    if (!st.isFile() || st.isSymbolicLink() || st.size > ALERT_CAPS.maxBytes) {
      throw new Error('unsafe_alerts_ledger_file');
    }
    const raw = fs.readFileSync(casesFile, 'utf8');
    const env = JSON.parse(raw);
    const expected = sha256Hex(canonicalJson(env.state));
    if (env.checksum !== expected) {
      throw new Error('alerts_ledger_checksum_mismatch');
    }
    return env.state;
  }

  function writeStateNoLock(st) {
    st.revision = Number(st.revision || 0) + 1;
    st.updatedAt = clock();
    if (Object.keys(st.cases || {}).length > ALERT_CAPS.maxCases) {
      throw new Error('alerts_cases_cap_reached');
    }
    if (!casesFile) return;
    const cleanState = JSON.parse(JSON.stringify(st));
    const payload = JSON.stringify({ state: cleanState, checksum: sha256Hex(canonicalJson(cleanState)) }, null, 2) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > ALERT_CAPS.maxBytes) {
      throw new Error('alerts_ledger_cap_reached');
    }
    writeAtomicDurable(casesFile, payload);
  }

  function appendEvent(ev) {
    if (!eventsFile) return;
    try {
      fs.mkdirSync(absDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(eventsFile, JSON.stringify({ ts: new Date(clock()).toISOString(), ...ev }) + '\n', { mode: 0o600 });
    } catch { /* isolate event log error */ }
  }

  let memState = withDirLock(() => readStateNoLock());

  function mutate(fn) {
    return withDirLock(() => {
      const st = casesFile ? readStateNoLock() : memState;
      const res = fn(st);
      writeStateNoLock(st);
      memState = st;
      return res;
    });
  }

  function snapshotState() {
    return withDirLock(() => (casesFile ? readStateNoLock() : memState));
  }

  function isQuietHour(nowMs) {
    const p = zonedParts(nowMs, tz);
    if (quietHoursStart > quietHoursEnd) {
      return p.hour >= quietHoursStart || p.hour < quietHoursEnd;
    }
    return p.hour >= quietHoursStart && p.hour < quietHoursEnd;
  }

  function nextMorningMs(nowMs) {
    const p = zonedParts(nowMs, tz);
    const deltaHours = p.hour < quietHoursEnd
      ? (quietHoursEnd - p.hour)
      : (24 - p.hour + quietHoursEnd);
    return nowMs + deltaHours * HOUR_MS - p.minute * MINUTE_MS;
  }

  function getNightKey(nowMs) {
    const p = zonedParts(nowMs, tz);
    // Group 22:00..23:59 with next morning's 00:00..07:59
    if (p.hour < quietHoursEnd) {
      const prev = zonedParts(nowMs - 12 * HOUR_MS, tz);
      return `night:${prev.dateKey}`;
    }
    return `night:${p.dateKey}`;
  }

  function isMuted(st, caseObj, nowMs) {
    const mutes = st.mutes || {};
    const keys = [
      caseObj.caseKey ? `case:${caseObj.caseKey}` : null,
      caseObj.effectiveVendor ? `vendor:${caseObj.effectiveVendor}` : null,
      caseObj.containerId ? `group:${caseObj.containerId}` : null,
      caseObj.category ? `kind:${caseObj.category}` : null,
      caseObj.source && caseObj.category ? `source_kind:${caseObj.source}:${caseObj.category}` : null,
    ].filter(Boolean);
    for (const k of keys) {
      const rule = mutes[k];
      if (!rule) continue;
      if (rule.expiresAt && nowMs >= rule.expiresAt) continue;
      // Night-only P0 mute still allows daytime P1
      if (rule.scope === 'no_night_p0') continue;
      return { muted: true, ruleKey: k, rule };
    }
    return { muted: false, ruleKey: null, rule: null };
  }

  function isNightP0Muted(st, caseObj, nowMs) {
    const mutes = st.mutes || {};
    const keys = [
      caseObj.effectiveVendor ? `no_night_p0:vendor:${caseObj.effectiveVendor}` : null,
      caseObj.category ? `no_night_p0:kind:${caseObj.category}` : null,
    ].filter(Boolean);
    for (const k of keys) {
      const rule = mutes[k];
      if (rule && (!rule.expiresAt || nowMs < rule.expiresAt)) return true;
    }
    return false;
  }

  // Enumerate top candidate open Cases for Stage 2 Tier-3 semantic correlation
  function findCandidateCases(rawSignal, { limit = 3 } = {}) {
    const st = snapshotState();
    const nowMs = Number(rawSignal.occurredAt || clock());
    const feats = extractCanonicalFeatures(rawSignal);
    const probeSig = { ...rawSignal, ...feats };
    const scored = [];
    for (const c of Object.values(st.cases || {})) {
      const veto = checkAntiMergeVetoes(probeSig, c, { nowMs });
      if (veto.vetoed) continue;
      const aff = computeDeterministicAffinity(probeSig, c);
      if (aff.score >= 0.30 || aff.tokenOverlap >= 0.30 || hasIntersection(feats.threadKeys, c.threadKeys)) {
        scored.push({
          caseId: c.caseId,
          caseKey: c.caseKey,
          category: c.category,
          effectiveVendor: c.effectiveVendor,
          summary: String(c.summary || '').slice(0, 180),
          severity: c.severity,
          signalCount: (c.signals || []).length,
          score: aff.score,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit));
  }

  // ── Pure VoI & Delivery Policy Evaluator (`decide`) ────────────────────────
  function decideCaseDisposition(st, caseObj, { nowMs = clock() } = {}) {
    if (!caseObj || caseObj.state === 'closed' || caseObj.state === 'auto_resolved') {
      return { disposition: 'silent', reason: `case_${caseObj?.state || 'missing'}`, eligibleAt: null };
    }

    const muteChk = isMuted(st, caseObj, nowMs);
    if (muteChk.muted) {
      return { disposition: 'silent', reason: `muted:${muteChk.ruleKey}`, eligibleAt: null };
    }

    if (caseObj.snoozeUntil && nowMs < caseObj.snoozeUntil) {
      // Allow ONLY verified P0 to break a snooze unless night P0 is muted
      if (caseObj.severity !== 'P0') {
        return { disposition: 'hold', reason: 'snoozed', eligibleAt: caseObj.snoozeUntil };
      }
    }

    const sev = caseObj.severity || 'P3';
    if (sev === 'P3') {
      return { disposition: 'silent', reason: 'below_p2_threshold', eligibleAt: null };
    }

    // Check anti-nag hysteresis against last notice on THIS case
    const notices = caseObj.notices || [];
    const lastNotice = notices[notices.length - 1] || null;
    const snoozeJustExpired = Boolean(caseObj.snoozeUntil && nowMs >= caseObj.snoozeUntil);

    if (lastNotice && !snoozeJustExpired) {
      if (lastNotice.status === 'pending' || lastNotice.status === 'unknown') {
        // Pre-send reservation uncertainty suppresses blind retry unless a NEW higher tier arrived!
        const jumped = SEVERITY_RANK[sev] > SEVERITY_RANK[lastNotice.severity || 'P2'];
        if (!jumped) {
          return { disposition: 'silent', reason: 'prior_delivery_pending_or_unknown', eligibleAt: null };
        }
      }
      const prevRank = SEVERITY_RANK[lastNotice.severity || 'P2'];
      const curRank = SEVERITY_RANK[sev];
      const deltaScore = Number(caseObj.urgencyScore || 0) - Number(lastNotice.urgencyScoreAtSend || 0);
      const elapsedMs = nowMs - Number(lastNotice.sentAt || lastNotice.reservedAt || 0);
      const hasNewEvidence = Number(caseObj.signals?.length || 0) > Number(lastNotice.coveredSignalCount || 0);
      const deadlineCrossed24h = Boolean(
        caseObj.deadlineAt
        && !caseObj.deadline24hNotified
        && (Date.parse(caseObj.deadlineAt) - nowMs) <= 24 * HOUR_MS
        && (Date.parse(caseObj.deadlineAt) - nowMs) > -7 * DAY_MS
      );

      const tierJumped = curRank > prevRank;
      const majorDeltaAfterCooldown = hasNewEvidence && deltaScore >= 18 && elapsedMs >= 12 * HOUR_MS;
      const p0MaterialDelta = sev === 'P0' && hasNewEvidence && elapsedMs >= 15 * MINUTE_MS;

      if (!tierJumped && !majorDeltaAfterCooldown && !deadlineCrossed24h && !p0MaterialDelta) {
        return { disposition: 'silent', reason: 'anti_nag_hysteresis', eligibleAt: null };
      }
    }

    // Shadow Mode holds ALL real-time pushes into daily Shadow Digest!
    if (st.shadowMode) {
      return { disposition: 'shadow_digest', reason: 'shadow_mode_active', eligibleAt: null };
    }

    // Self-demotion check (if >=3 of last 6 feedbacks for source+category were not_useful -> digest)
    const demoteKey = `${caseObj.source || 'src'}:${caseObj.category || 'ops_general'}`;
    if (st.demotions?.[demoteKey] && sev !== 'P0') {
      return { disposition: 'digest', reason: `self_demoted:${demoteKey}`, eligibleAt: null };
    }

    // Per-sender group rate-limit (non-internal group sender max 1 immediate DM / 24h)
    const lastSig = caseObj.signals?.[caseObj.signals.length - 1];
    if (lastSig?.isGroup && lastSig.senderTrust !== 'internal' && lastSig.senderId) {
      const todayKey = zonedParts(nowMs, tz).dateKey;
      const senderCount = st.dailyStats?.[todayKey]?.senderDms?.[lastSig.senderId] || 0;
      if (senderCount >= 1 && sev !== 'P0') {
        return { disposition: 'digest', reason: 'group_sender_daily_cap', eligibleAt: null };
      }
    }

    const quiet = isQuietHour(nowMs);
    const todayKey = zonedParts(nowMs, tz).dateKey;
    const nightKey = getNightKey(nowMs);
    const dayStats = st.dailyStats?.[todayKey] || { p1Sent: 0, p0Sent: 0, senderDms: {} };
    const nightP0Sent = st.dailyStats?.[nightKey]?.p0Sent || 0;

    // Count currently unacknowledged P1 immediate cards
    const unackedP1 = Object.values(st.cases || {}).filter((c) => {
      if (c.state !== 'open' || c.severity !== 'P1') return false;
      const ln = (c.notices || []).at(-1);
      return ln && ln.purpose === 'immediate' && ln.status === 'confirmed' && !ln.ackedAt;
    }).length;

    // P0 Break-Glass path
    if (sev === 'P0') {
      if (quiet) {
        if (!allowNightP0 || isNightP0Muted(st, caseObj, nowMs)) {
          return { disposition: 'hold', reason: 'night_p0_disabled_or_muted', eligibleAt: nextMorningMs(nowMs) };
        }
        if (nightP0Sent >= maxNightP0) {
          return { disposition: 'hold', reason: 'night_p0_cap_reached', eligibleAt: nextMorningMs(nowMs) };
        }
      }
      return { disposition: 'immediate', reason: 'verified_p0_breakglass', eligibleAt: nowMs };
    }

    // P1 Immediate daytime path
    if (sev === 'P1') {
      if (quiet) {
        return { disposition: 'hold', reason: 'quiet_hours', eligibleAt: nextMorningMs(nowMs) };
      }
      if (dayStats.p1Sent >= maxDailyP1) {
        return { disposition: 'digest', reason: 'daily_p1_budget_reached', eligibleAt: null };
      }
      if (unackedP1 >= maxUnackedBeforeRollup) {
        return { disposition: 'rollup', reason: 'unacked_p1_backpressure', eligibleAt: null, unackedP1 };
      }
      return { disposition: 'immediate', reason: 'p1_immediate', eligibleAt: nowMs };
    }

    // P2 Digest path
    if (unackedP1 >= maxUnackedBeforeRollup) {
      return { disposition: 'hold', reason: 'p2_suppressed_by_unacked_backpressure', eligibleAt: null };
    }
    return { disposition: 'digest', reason: 'p2_digest', eligibleAt: null };
  }

  // ── Ingest a Normalized Signal (Stage 1 + optional Stage 2 metadata) ───────
  function ingestSignal(rawSignal = {}) {
    const nowMs = Number(rawSignal.observedAt || clock());
    const occurredAt = Number(rawSignal.occurredAt || nowMs);
    const isEmail = Boolean(rawSignal.isEmail || ['gmail', 'outlook', 'email'].includes(rawSignal.source));
    const isGroup = Boolean(rawSignal.isGroup || ['telegram_group', 'slack_channel', 'group'].includes(rawSignal.source));

    // Mechanical top-hop MTA authentication for emails (never trust LLM-supplied authGrade!)
    let authGrade = 'UNVERIFIED';
    let alignedDomain = '';
    if (isEmail) {
      const auth = verifyTopHopAuthGrade({
        authHeaders: rawSignal.authHeaders || [],
        fromDomain: rawSignal.fromDomain || '',
        pinnedDomains: rawSignal.pinnedDomains || pinnedDomains,
        trustedMtas,
      });
      authGrade = auth.authGrade;
      alignedDomain = auth.alignedDomain;
    } else if (rawSignal.senderTrust === 'internal') {
      authGrade = 'INTERNAL_TRUSTED';
    }

    const feats = extractCanonicalFeatures({ ...rawSignal, alignedDomain });
    const evidenceId = String(
      rawSignal.evidenceId
      || `${rawSignal.source || 'src'}:${rawSignal.account || 'default'}:${rawSignal.containerId || 'root'}:${rawSignal.itemId || sha256Hex(feats.simhash64 + occurredAt).slice(0, 12)}`
    );

    const deltaHash = sha256Hex(canonicalJson({
      stage: rawSignal.stage || 'fyi',
      deadlineAt: rawSignal.deadlineAt || null,
      amount: feats.amount || null,
      materialDelta: rawSignal.materialDelta || null,
    })).slice(0, 16);

    const normalizedSig = {
      signalId: `sig_${sha256Hex(`${evidenceId}:${rawSignal.revision || 0}`).slice(0, 12)}`,
      evidenceId,
      source: String(rawSignal.source || 'unknown'),
      account: String(rawSignal.account || ''),
      containerId: rawSignal.containerId != null ? String(rawSignal.containerId) : null,
      containerTitle: rawSignal.containerTitle ? String(rawSignal.containerTitle).slice(0, 140) : null,
      itemId: rawSignal.itemId != null ? String(rawSignal.itemId) : null,
      rfcMessageId: rawSignal.rfcMessageId ? String(rawSignal.rfcMessageId).trim() : null,
      senderId: rawSignal.senderId != null ? String(rawSignal.senderId) : null,
      senderName: rawSignal.senderName ? String(rawSignal.senderName).slice(0, 100) : null,
      senderTrust: rawSignal.senderTrust === 'internal' ? 'internal' : 'external',
      isEmail,
      isGroup,
      authGrade,
      alignedDomain,
      effectiveVendor: feats.effectiveVendor,
      hardIds: feats.hardIds,
      threadKeys: feats.threadKeys,
      amount: feats.amount,
      simhash64: feats.simhash64,
      tokens: feats.tokens,
      category: String(rawSignal.category || (isGroup ? 'group_blocker_or_calendar' : 'ops_general')),
      stage: String(rawSignal.stage || 'fyi'),
      confidence: Math.max(0, Math.min(1, Number(rawSignal.confidence ?? 0.9))),
      baseScore: typeof rawSignal.baseScore === 'number' ? rawSignal.baseScore : undefined,
      summary: String(rawSignal.summary || '').slice(0, ALERT_CAPS.maxSummaryChars),
      quote: String(rawSignal.quote || '').slice(0, ALERT_CAPS.maxQuoteChars),
      materialDelta: rawSignal.materialDelta ? String(rawSignal.materialDelta).slice(0, 200) : null,
      deltaHash,
      deadlineAt: rawSignal.deadlineAt || null,
      isMultiInvoiceStatement: Boolean(rawSignal.isMultiInvoiceStatement),
      isOneOffReceipt: Boolean(rawSignal.isOneOffReceipt),
      isRetryOrFailed: Boolean(rawSignal.isRetryOrFailed),
      occurredAt,
      observedAt: nowMs,
      mergeCaseId: rawSignal.mergeCaseId || null,
      mergeConfidence: Number(rawSignal.mergeConfidence || 0),
    };

    return mutate((st) => {
      // Exact evidenceId dedup (re-scan / replay is a strict no-op!)
      for (const existing of Object.values(st.cases)) {
        if ((existing.signals || []).some((s) => s.evidenceId === evidenceId)) {
          const decision = decideCaseDisposition(st, existing, { nowMs });
          return { ok: true, action: 'duplicate_evidence_noop', case: existing, decision };
        }
      }

      // ── 3-Tier Correlation Waterfall (guarded by 4 Hard Anti-Merge Vetoes) ──
      let matchedCase = null;
      let matchTier = 'new';
      const vetoLog = [];

      // Check Tier 1 (Deterministic Hard Lock)
      for (const c of Object.values(st.cases)) {
        const veto = checkAntiMergeVetoes(normalizedSig, c, { nowMs });
        if (veto.vetoed) {
          vetoLog.push({ caseId: c.caseId, reason: veto.reason });
          continue;
        }
        const threadHit = hasIntersection(normalizedSig.threadKeys, c.threadKeys)
          && !normalizedSig.isBulkNoreply;
        const vendorIdHit = Boolean(
          normalizedSig.effectiveVendor
          && c.effectiveVendor === normalizedSig.effectiveVendor
          && (
            hasIntersection(normalizedSig.hardIds.invoice, c.hardIds?.invoice)
            || hasIntersection(normalizedSig.hardIds.resource, c.hardIds?.resource)
          )
        );
        const exactCaseKeyHit = Boolean(rawSignal.caseKey && c.caseKey === String(rawSignal.caseKey));
        if (exactCaseKeyHit || threadHit || vendorIdHit) {
          matchedCase = c;
          matchTier = 'tier1_hard_lock';
          break;
        }
      }

      // Check Tier 2 (Deterministic Weighted Entity Affinity >= 0.75)
      if (!matchedCase) {
        let best = null;
        for (const c of Object.values(st.cases)) {
          const veto = checkAntiMergeVetoes(normalizedSig, c, { nowMs });
          if (veto.vetoed) continue;
          const aff = computeDeterministicAffinity(normalizedSig, c);
          if (aff.score >= 0.75 && (!best || aff.score > best.score)) {
            best = { c, score: aff.score };
          }
        }
        if (best) {
          matchedCase = best.c;
          matchTier = `tier2_entity_affinity:${best.score}`;
        }
      }

      // Check Tier 3 (Piggybacked Stage 2 Semantic Link >= 0.85, still subject to Hard Vetoes!)
      if (!matchedCase && normalizedSig.mergeCaseId && normalizedSig.mergeConfidence >= 0.85) {
        const target = st.cases[normalizedSig.mergeCaseId];
        if (target) {
          const veto = checkAntiMergeVetoes(normalizedSig, target, { nowMs });
          if (!veto.vetoed) {
            matchedCase = target;
            matchTier = `tier3_semantic:${normalizedSig.mergeConfidence}`;
          } else {
            vetoLog.push({ caseId: target.caseId, reason: `tier3_vetoed:${veto.reason}` });
          }
        }
      }

      let targetCase;
      if (matchedCase) {
        targetCase = matchedCase;
        targetCase.signals.push(normalizedSig);
        if (targetCase.signals.length > ALERT_CAPS.maxSignalsPerCase) {
          targetCase.signals = targetCase.signals.slice(-ALERT_CAPS.maxSignalsPerCase);
        }
        targetCase.lastEvidenceAt = Math.max(Number(targetCase.lastEvidenceAt || 0), occurredAt);
        targetCase.sources = [...new Set([...(targetCase.sources || []), normalizedSig.source])];
        targetCase.threadKeys = [...new Set([...(targetCase.threadKeys || []), ...normalizedSig.threadKeys])].slice(-32);
        targetCase.tokens = [...new Set([...(targetCase.tokens || []), ...normalizedSig.tokens])].slice(-96);
        targetCase.hardIds = {
          invoice: [...new Set([...(targetCase.hardIds?.invoice || []), ...normalizedSig.hardIds.invoice])].slice(0, 12),
          account: [...new Set([...(targetCase.hardIds?.account || []), ...normalizedSig.hardIds.account])].slice(0, 12),
          resource: [...new Set([...(targetCase.hardIds?.resource || []), ...normalizedSig.hardIds.resource])].slice(0, 12),
        };
        if (normalizedSig.amount) targetCase.latestAmount = normalizedSig.amount;
        if (normalizedSig.deadlineAt) targetCase.deadlineAt = normalizedSig.deadlineAt;
        if (normalizedSig.summary) targetCase.summary = normalizedSig.summary;
        if (normalizedSig.quote) targetCase.latestQuote = normalizedSig.quote;
        if (normalizedSig.authGrade === 'CRYPTO_VERIFIED') targetCase.authGrade = 'CRYPTO_VERIFIED';
        if (rawSignal.frozenAction) {
          targetCase.frozenAction = {
            ...rawSignal.frozenAction,
            argsHash: computeArgsHash(rawSignal.frozenAction.tool, rawSignal.frozenAction.args),
            effectStatus: targetCase.frozenAction?.effectStatus === 'verified' ? 'verified' : 'proposed',
          };
        }
      } else {
        const shortId = `c_${crypto.randomBytes(3).toString('hex')}`;
        const derivedKey = rawSignal.caseKey
          ? String(rawSignal.caseKey)
          : `${normalizedSig.category}:${normalizedSig.effectiveVendor || normalizedSig.containerId || 'general'}:${normalizedSig.hardIds.invoice[0] || normalizedSig.hardIds.resource[0] || shortId}`;
        targetCase = {
          caseId: shortId,
          caseKey: derivedKey,
          category: normalizedSig.category,
          source: normalizedSig.source,
          sources: [normalizedSig.source],
          containerId: normalizedSig.containerId,
          containerTitle: normalizedSig.containerTitle,
          state: 'open',
          authGrade: normalizedSig.authGrade,
          effectiveVendor: normalizedSig.effectiveVendor,
          hardIds: normalizedSig.hardIds,
          threadKeys: normalizedSig.threadKeys,
          tokens: normalizedSig.tokens,
          latestAmount: normalizedSig.amount,
          deadlineAt: normalizedSig.deadlineAt,
          deadline24hNotified: false,
          isOneOffReceipt: normalizedSig.isOneOffReceipt,
          summary: normalizedSig.summary,
          latestQuote: normalizedSig.quote,
          openedAt: occurredAt,
          lastEvidenceAt: occurredAt,
          signals: [normalizedSig],
          notices: [],
          urgencyScore: 0,
          severity: 'P3',
          distinctCount: 1,
          snoozeUntil: null,
          closedAt: null,
          closedReason: null,
          frozenAction: rawSignal.frozenAction
            ? {
                ...rawSignal.frozenAction,
                argsHash: computeArgsHash(rawSignal.frozenAction.tool, rawSignal.frozenAction.args),
                effectStatus: 'proposed',
                providerResourceId: null,
              }
            : null,
          templateUrl: rawSignal.templateUrl || null,
          policyVersion,
        };
        st.cases[shortId] = targetCase;
      }

      const prevSeverity = targetCase.severity;
      const scored = computeUrgencyAndSeverity(targetCase, { nowMs });
      targetCase.urgencyScore = scored.urgencyScore;
      targetCase.severity = scored.severity;
      targetCase.distinctCount = scored.distinctCount;
      targetCase.securityBurst = scored.securityBurst;

      const decision = decideCaseDisposition(st, targetCase, { nowMs });
      appendEvent({
        kind: 'signal_ingested',
        caseId: targetCase.caseId,
        signalId: normalizedSig.signalId,
        matchTier,
        vetoes: vetoLog.slice(0, 5),
        prevSeverity,
        severity: targetCase.severity,
        urgencyScore: targetCase.urgencyScore,
        distinctCount: targetCase.distinctCount,
        authGrade: targetCase.authGrade,
        disposition: decision.disposition,
        reason: decision.reason,
      });

      return {
        ok: true,
        action: matchedCase ? 'merged' : 'opened',
        matchTier,
        vetoes: vetoLog,
        case: targetCase,
        decision,
      };
    });
  }

  // ── Pre-Send Notice Reservation (crash-safe: persisted BEFORE transport I/O) ─
  function reserveNotice(caseId, { purpose = 'immediate', renderHash = null, nowMs = clock() } = {}) {
    return mutate((st) => {
      const c = st.cases[caseId];
      if (!c) return { ok: false, reason: 'case_not_found' };
      const notice = {
        noticeId: `n_${crypto.randomBytes(4).toString('hex')}`,
        purpose,
        severity: c.severity,
        urgencyScoreAtSend: c.urgencyScore,
        coveredSignalCount: (c.signals || []).length,
        renderHash: renderHash || null,
        status: 'pending',
        reservedAt: nowMs,
        sentAt: null,
        providerMessageId: null,
        ackedAt: null,
      };
      c.notices.push(notice);
      if (c.notices.length > ALERT_CAPS.maxNoticesPerCase) {
        c.notices = c.notices.slice(-ALERT_CAPS.maxNoticesPerCase);
      }
      if (c.snoozeUntil && nowMs >= c.snoozeUntil) c.snoozeUntil = null;
      if (c.deadlineAt && (Date.parse(c.deadlineAt) - nowMs) <= 24 * HOUR_MS) {
        c.deadline24hNotified = true;
      }

      // Reserve attention capacity transactionally before send
      const todayKey = zonedParts(nowMs, tz).dateKey;
      const nightKey = getNightKey(nowMs);
      if (!st.dailyStats[todayKey]) st.dailyStats[todayKey] = { p1Sent: 0, p0Sent: 0, senderDms: {} };
      if (!st.dailyStats[nightKey]) st.dailyStats[nightKey] = { p0Sent: 0 };
      if (purpose === 'immediate') {
        if (c.severity === 'P0') {
          st.dailyStats[todayKey].p0Sent = (st.dailyStats[todayKey].p0Sent || 0) + 1;
          if (isQuietHour(nowMs)) st.dailyStats[nightKey].p0Sent = (st.dailyStats[nightKey].p0Sent || 0) + 1;
        } else if (c.severity === 'P1') {
          st.dailyStats[todayKey].p1Sent = (st.dailyStats[todayKey].p1Sent || 0) + 1;
        }
        const lastSig = c.signals?.[c.signals.length - 1];
        if (lastSig?.isGroup && lastSig.senderId) {
          st.dailyStats[todayKey].senderDms[lastSig.senderId] = (st.dailyStats[todayKey].senderDms[lastSig.senderId] || 0) + 1;
        }
      }
      appendEvent({ kind: 'notice_reserved', caseId, noticeId: notice.noticeId, purpose, severity: c.severity });
      return { ok: true, notice, case: c };
    });
  }

  function confirmNotice(caseId, noticeId, { providerMessageId, chatId = null, nowMs = clock() } = {}) {
    return mutate((st) => {
      const c = st.cases[caseId];
      if (!c) return { ok: false, reason: 'case_not_found' };
      const n = (c.notices || []).find((x) => x.noticeId === noticeId);
      if (!n) return { ok: false, reason: 'notice_not_found' };
      n.status = 'confirmed';
      n.providerMessageId = String(providerMessageId || '');
      n.chatId = chatId != null ? String(chatId) : null;
      n.sentAt = nowMs;
      appendEvent({ kind: 'notice_confirmed', caseId, noticeId, providerMessageId: n.providerMessageId });
      return { ok: true, notice: n, case: c };
    });
  }

  function markNoticeUnknown(caseId, noticeId, { error = null, nowMs = clock() } = {}) {
    return mutate((st) => {
      const c = st.cases[caseId];
      if (!c) return { ok: false, reason: 'case_not_found' };
      const n = (c.notices || []).find((x) => x.noticeId === noticeId);
      if (!n) return { ok: false, reason: 'notice_not_found' };
      n.status = 'unknown';
      n.error = error ? String(error).slice(0, 200) : 'delivery_unknown';
      n.updatedAt = nowMs;
      appendEvent({ kind: 'notice_unknown', caseId, noticeId, error: n.error });
      return { ok: true, notice: n };
    });
  }

  // ── Owner Feedback Verbs & Self-Demotion ───────────────────────────────────
  function applyFeedback(caseId, verb, {
    actor = 'owner',
    snoozeMs = 2 * HOUR_MS,
    muteDays = 30,
    nowMs = clock(),
  } = {}) {
    return mutate((st) => {
      const c = st.cases[caseId];
      if (!c) return { ok: false, reason: 'case_not_found' };
      const lastNotice = (c.notices || []).at(-1);
      if (lastNotice && !lastNotice.ackedAt) lastNotice.ackedAt = nowMs;

      const fbKey = `${c.source || 'src'}:${c.category || 'ops_general'}`;
      if (!st.feedbackHistory[fbKey]) st.feedbackHistory[fbKey] = [];
      let demoted = false;

      if (verb === 'ack' || verb === 'useful') {
        st.feedbackHistory[fbKey].push({ verb: 'useful', at: nowMs });
      } else if (verb === 'done' || verb === 'close') {
        c.state = 'closed';
        c.closedAt = nowMs;
        c.closedReason = 'owner_done';
        c.snoozeUntil = null;
        st.feedbackHistory[fbKey].push({ verb: 'useful', at: nowMs });
      } else if (verb === 'snooze' || verb === 'snooze_2h' || verb === 'snooze_24h') {
        const dur = verb === 'snooze_24h' ? DAY_MS : Number(snoozeMs || 2 * HOUR_MS);
        c.snoozeUntil = nowMs + dur;
      } else if (verb === 'not_useful' || verb === 'false_positive') {
        c.state = 'closed';
        c.closedAt = nowMs;
        c.closedReason = 'owner_not_useful';
        st.feedbackHistory[fbKey].push({ verb: 'not_useful', at: nowMs });
      } else if (verb === 'mute_sender' && c.effectiveVendor) {
        c.state = 'closed';
        c.closedAt = nowMs;
        c.closedReason = 'owner_muted_sender';
        st.mutes[`vendor:${c.effectiveVendor}`] = { scope: 'vendor', createdAt: nowMs, expiresAt: nowMs + muteDays * DAY_MS, by: actor };
        st.feedbackHistory[fbKey].push({ verb: 'not_useful', at: nowMs });
      } else if (verb === 'mute_group' && c.containerId) {
        c.state = 'closed';
        c.closedAt = nowMs;
        c.closedReason = 'owner_muted_group';
        st.mutes[`group:${c.containerId}`] = { scope: 'group', createdAt: nowMs, expiresAt: nowMs + muteDays * DAY_MS, by: actor };
        st.feedbackHistory[fbKey].push({ verb: 'not_useful', at: nowMs });
      } else if (verb === 'mute_kind') {
        c.state = 'closed';
        c.closedAt = nowMs;
        c.closedReason = 'owner_muted_kind';
        st.mutes[`source_kind:${fbKey}`] = { scope: 'source_kind', createdAt: nowMs, expiresAt: nowMs + muteDays * DAY_MS, by: actor };
        st.feedbackHistory[fbKey].push({ verb: 'not_useful', at: nowMs });
      } else if (verb === 'no_night_p0') {
        const k = c.effectiveVendor ? `no_night_p0:vendor:${c.effectiveVendor}` : `no_night_p0:kind:${c.category}`;
        st.mutes[k] = { scope: 'no_night_p0', createdAt: nowMs, expiresAt: null, by: actor };
      } else {
        return { ok: false, reason: `unsupported_feedback_verb:${verb}` };
      }

      // Self-demotion: >= 3 of last 6 feedbacks marked not_useful -> demote source+kind to digest
      st.feedbackHistory[fbKey] = st.feedbackHistory[fbKey].slice(-6);
      if (st.feedbackHistory[fbKey].length >= 6) {
        const neg = st.feedbackHistory[fbKey].filter((x) => x.verb === 'not_useful').length;
        if (neg >= 3 && !st.demotions[fbKey]) {
          st.demotions[fbKey] = { at: nowMs, negativeRatio: `${neg}/6` };
          demoted = true;
        }
      }

      appendEvent({ kind: 'owner_feedback', caseId, verb, actor, demoted });
      return { ok: true, case: c, verb, demoted };
    });
  }

  // ── Auto-Resolve by Observation (Owner replied in group / created event) ───
  function observeOwnerEngagement({ source = 'telegram_group', containerId, at = clock(), reason = 'owner_replied_in_channel' } = {}) {
    if (!containerId) return { ok: true, resolved: [] };
    const cid = String(containerId);
    return mutate((st) => {
      const resolved = [];
      for (const c of Object.values(st.cases)) {
        if (c.state !== 'open') continue;
        if (c.source !== source || String(c.containerId || '') !== cid) continue;
        // Only auto-resolve unanswered-group / blocker cases (NOT missing-calendar cases unless explicitly calendar_observed)
        if (reason !== 'calendar_event_observed' && c.frozenAction?.tool === 'calendar_create_event') continue;
        if (Number(c.lastEvidenceAt || 0) <= at) {
          c.state = 'auto_resolved';
          c.closedAt = at;
          c.closedReason = reason;
          resolved.push({
            caseId: c.caseId,
            lastNotice: (c.notices || []).at(-1) || null,
            summary: c.summary,
          });
        }
      }
      if (resolved.length) {
        appendEvent({ kind: 'auto_resolved', source, containerId: cid, count: resolved.length, reason });
      }
      return { ok: true, resolved };
    });
  }

  function recordActionEffect(caseId, { status, providerResourceId = null, error = null, nowMs = clock() } = {}) {
    return mutate((st) => {
      const c = st.cases[caseId];
      if (!c || !c.frozenAction) return { ok: false, reason: 'action_not_found' };
      c.frozenAction.effectStatus = status;
      if (providerResourceId != null) c.frozenAction.providerResourceId = String(providerResourceId);
      c.frozenAction.effectCheckedAt = nowMs;
      if (error) c.frozenAction.lastError = String(error).slice(0, 240);
      if (status === 'verified') {
        c.state = 'closed';
        c.closedAt = nowMs;
        c.closedReason = 'action_verified';
      } else if (status === 'undone') {
        c.state = 'closed';
        c.closedAt = nowMs;
        c.closedReason = 'action_undone';
      }
      appendEvent({ kind: 'action_effect', caseId, status, providerResourceId, error });
      return { ok: true, case: c };
    });
  }

  // ── Pure Tick (invoked by §49 scheduler — no internal setInterval!) ────────
  function tick(nowMs = clock()) {
    return mutate((st) => {
      const immediate = [];
      const digest = [];
      const rollup = [];
      let rollupNeeded = false;

      for (const c of Object.values(st.cases)) {
        if (c.state !== 'open') continue;
        const scored = computeUrgencyAndSeverity(c, { nowMs });
        c.urgencyScore = scored.urgencyScore;
        c.severity = scored.severity;
        c.distinctCount = scored.distinctCount;

        const d = decideCaseDisposition(st, c, { nowMs });
        if (d.disposition === 'immediate') {
          immediate.push({ case: c, decision: d });
        } else if (d.disposition === 'digest' || d.disposition === 'shadow_digest') {
          digest.push({ case: c, decision: d });
        } else if (d.disposition === 'rollup') {
          rollup.push({ case: c, decision: d });
          rollupNeeded = true;
        }
      }

      const p = zonedParts(nowMs, tz);
      const digestWindow = st.shadowMode
        ? (p.hour === shadowDigestHour)
        : digestHours.includes(p.hour);
      const digestKey = `${p.dateKey}T${String(p.hour).padStart(2, '0')}`;
      const digestDue = Boolean(digestWindow && digest.length > 0 && st.lastDigestKey !== digestKey);

      const heartbeatDue = Boolean(
        p.hour === 21
        && st.lastHeartbeatDay !== p.dateKey
        && immediate.length === 0
        && !digestDue
      );

      return {
        nowMs,
        shadowMode: Boolean(st.shadowMode),
        quietHours: isQuietHour(nowMs),
        immediate,
        digest: digestDue ? digest : [],
        digestPending: digest,
        digestPendingCount: digest.length,
        digestKey,
        rollup,
        rollupNeeded,
        heartbeatDue,
        dateKey: p.dateKey,
      };
    });
  }

  function markDigestSent(digestKey) {
    return mutate((st) => {
      st.lastDigestKey = String(digestKey);
      return { ok: true };
    });
  }

  function markHeartbeatSent(dateKey) {
    return mutate((st) => {
      st.lastHeartbeatDay = String(dateKey);
      return { ok: true };
    });
  }

  function setShadowMode(enabled) {
    return mutate((st) => {
      st.shadowMode = Boolean(enabled);
      appendEvent({ kind: 'shadow_mode_changed', shadowMode: st.shadowMode });
      return { ok: true, shadowMode: st.shadowMode };
    });
  }

  function getCursor(sourceKey) {
    const st = snapshotState();
    return st.cursors?.[String(sourceKey)] ?? null;
  }

  function setCursor(sourceKey, value) {
    return mutate((st) => {
      st.cursors[String(sourceKey)] = value;
      return { ok: true };
    });
  }

  function getCase(caseId) {
    const st = snapshotState();
    return st.cases?.[caseId] ? structuredClone(st.cases[caseId]) : null;
  }

  function listCases({ state = null, limit = 50 } = {}) {
    const st = snapshotState();
    let list = Object.values(st.cases || {});
    if (state) list = list.filter((c) => c.state === state);
    list.sort((a, b) => Number(b.lastEvidenceAt || 0) - Number(a.lastEvidenceAt || 0));
    return list.slice(0, limit).map((c) => structuredClone(c));
  }

  function getStats() {
    const st = snapshotState();
    const all = Object.values(st.cases || {});
    return {
      schema: st.schema,
      revision: st.revision,
      shadowMode: Boolean(st.shadowMode),
      totalCases: all.length,
      openCases: all.filter((c) => c.state === 'open').length,
      closedCases: all.filter((c) => c.state === 'closed').length,
      autoResolvedCases: all.filter((c) => c.state === 'auto_resolved').length,
      mutes: Object.keys(st.mutes || {}).length,
      demotions: Object.keys(st.demotions || {}),
    };
  }

  return {
    ingestSignal,
    findCandidateCases,
    reserveNotice,
    confirmNotice,
    markNoticeUnknown,
    applyFeedback,
    observeOwnerEngagement,
    recordActionEffect,
    tick,
    markDigestSent,
    markHeartbeatSent,
    setShadowMode,
    getCursor,
    setCursor,
    getCase,
    listCases,
    getStats,
    decideCaseDisposition: (caseId, nowMs = clock()) => {
      const st = snapshotState();
      return decideCaseDisposition(st, st.cases?.[caseId], { nowMs });
    },
  };
}
