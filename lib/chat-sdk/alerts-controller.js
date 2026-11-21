// SCROLL 2.6 -- §51 Channel-Agnostic Smart Alerts Controller (Zero-Dep, Pure English ASCII).
//
// Responsibilities:
//   1. Strict One-Way Owner DM Diode: notifications and callbacks are bound ONLY to verified
//      Owner IDs supplied at controller construction time; never accepts destination chatId
//      from signals, cases, frozen actions, or LLM outputs.
//   2. Phishing-Safe Sanitization: strips URLs, bare domain paths, HTML tags, and bidi spoofing
//      characters from untrusted quotes and calendar templates.
//   3. Compact 64-byte-safe callback grammar (`sa:<caseId>:<verb>`).
//   4. 1-Tap Action Execution: verifies frozen `argsHash`, mints a fresh single-use §21 approval
//      token AT TAP TIME via `approvalStore`, executes through `tools.executeTool`, enforces §28
//      `confirmEffect` read-back verification (fail closed on unconfirmed), and supports Undo.
//   5. Crash-Safe Dispatch: reserves notices in `alertLedger` BEFORE transport I/O and marks
//      uncertain failures `unknown` instead of blind-retrying duplicate DMs.
//
// Zero runtime dependencies. Node >= 20 built-ins only.

import crypto from 'node:crypto';
import { computeArgsHash } from '../alerts.js';

export const ALERTS_CALLBACK_NAMESPACE = 'sa';

const BIDI_AND_ZW_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const MD_LINK_RE = /\[([^\]]{1,120})\]\(([^)]+)\)/g;
const PROTOCOL_URL_RE = /\b(?:https?|ftp|tg|mailto|javascript|data|file):\/\/[^\s<>()]+|\bmailto:[^\s<>()]+/gi;
const BARE_DOMAIN_PATH_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|vn|ai|app|dev|xyz|info|biz|me|gg|ly|to|cc|ru|cn|uk|de|fr|jp|kr|sg|au|ca|us|edu|gov|bank|pay|cloud|site|online|click|link|top|vip)(?:\/[^\s<>()]*)?/gi;

export const DEFAULT_ALERT_LABELS = Object.freeze({
  severityP0: '[P0 URGENT]',
  severityP1: '[P1 ACTION]',
  severityP2: '[P2 DIGEST]',
  shadowBanner: '[SHADOW MODE - WOULD HAVE ALERTED]',
  digestTitle: 'Smart Alerts Digest',
  shadowDigestTitle: 'Smart Alerts Shadow Digest (No Live Push)',
  rollupTitle: 'Unacknowledged Alerts Rollup',
  unverifiedWarning: 'Unverified sender (DKIM/DMARC not verified)',
  actionProposed: 'Proposed action',
  actionVerified: 'Action verified',
  actionUnconfirmed: 'Action executed but read-back unconfirmed - please check manually',
  actionUndone: 'Action undone',
  autoResolved: 'Resolved automatically (owner activity observed)',
  statusClosed: 'Closed',
  statusSnoozed: 'Snoozed',
  statusMuted: 'Muted',
  btnConfirm: 'Confirm',
  btnOpenLink: 'Open Link',
  btnUndo: 'Undo',
  btnDone: 'Done',
  btnSnooze2h: 'Snooze 2h',
  btnSnooze24h: 'Snooze 24h',
  btnUseful: 'Useful',
  btnNotUseful: 'Not useful',
  btnMuteGroup: 'Mute group 30d',
  btnMuteSender: 'Mute sender 30d',
  btnNoNightP0: 'No night P0',
});

const VERB_MAP = Object.freeze({
  done: 'done',
  sn2: 'snooze_2h',
  sn24: 'snooze_24h',
  up: 'useful',
  dn: 'not_useful',
  mg: 'mute_group',
  ms: 'mute_sender',
  mk: 'mute_kind',
  nn: 'no_night_p0',
});

export function sanitizeUntrustedQuote(text, { maxChars = 180 } = {}) {
  let s = String(text || '');
  s = s.replace(BIDI_AND_ZW_RE, '');
  s = s.replace(MD_LINK_RE, '$1 [link-removed]');
  s = s.replace(HTML_TAG_RE, ' ');
  s = s.replace(PROTOCOL_URL_RE, '[link-removed]');
  s = s.replace(BARE_DOMAIN_PATH_RE, '[link-removed]');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxChars) {
    s = `${s.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
  }
  return s;
}

function formatGcalUtc(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs || ''));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export function buildGoogleCalendarTemplateUrl({
  summary,
  startIso,
  endIso = null,
  durationMin = 60,
  details = '',
  location = '',
  tz = 'Asia/Ho_Chi_Minh',
} = {}) {
  const startMs = typeof startIso === 'number' ? startIso : Date.parse(String(startIso || ''));
  if (!Number.isFinite(startMs)) return null;
  const endMs = endIso
    ? (typeof endIso === 'number' ? endIso : Date.parse(String(endIso)))
    : startMs + Math.max(15, Number(durationMin || 60)) * 60_000;
  const startFmt = formatGcalUtc(startMs);
  const endFmt = formatGcalUtc(Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + 60 * 60_000);
  if (!startFmt || !endFmt) return null;

  const safeTitle = sanitizeUntrustedQuote(summary || 'Scheduled Event', { maxChars: 120 });
  const safeDetails = sanitizeUntrustedQuote(details || '', { maxChars: 240 });
  const safeLoc = sanitizeUntrustedQuote(location || '', { maxChars: 120 });

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: safeTitle,
    dates: `${startFmt}/${endFmt}`,
    ctz: String(tz || 'Asia/Ho_Chi_Minh'),
  });
  if (safeDetails) params.set('details', safeDetails);
  if (safeLoc) params.set('location', safeLoc);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function makeAlertCallbackData(caseId, verb) {
  const data = `${ALERTS_CALLBACK_NAMESPACE}:${String(caseId)}:${String(verb)}`;
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error(`alert_callback_exceeds_64_bytes:${data}`);
  }
  return data;
}

export function parseAlertCallbackData(callbackData) {
  const raw = String(callbackData || '');
  const parts = raw.split(':');
  if (parts.length !== 3 || parts[0] !== ALERTS_CALLBACK_NAMESPACE) return null;
  const caseId = parts[1];
  const verb = parts[2];
  if (!/^[a-z0-9_-]{3,24}$/i.test(caseId) || !/^[a-z0-9_]{2,12}$/i.test(verb)) return null;
  return { namespace: parts[0], caseId, verb };
}

function sha256Short(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function normalizeActorId(actor) {
  const raw = String(actor?.senderId ?? actor?.id ?? '');
  return raw.replace(/^[a-z0-9_-]+:/i, '');
}

export function createAlertsController({
  ledger,
  ownerIds = [],
  labels: defaultLabels = {},
  requireActionConfirmation = true,
  sendSilentHeartbeat = false,
} = {}) {
  if (!ledger) throw new Error('createAlertsController: ledger is required');

  const ownerSet = new Set();
  for (const id of (ownerIds || [])) {
    const s = String(id || '').trim();
    if (!s) continue;
    ownerSet.add(s);
    ownerSet.add(s.replace(/^[a-z0-9_-]+:/i, ''));
  }

  function mergeLabels(override = null) {
    return { ...DEFAULT_ALERT_LABELS, ...(defaultLabels || {}), ...(override || {}) };
  }

  function isOwnerDm(actor) {
    if (!actor || typeof actor !== 'object') return false;
    if (actor.isDm !== true || actor.isGroup === true) return false;
    const raw = String(actor.senderId ?? actor.id ?? '').trim();
    const stripped = normalizeActorId(actor);
    if (!raw) return false;
    return ownerSet.has(raw) || ownerSet.has(stripped);
  }

  function renderCaseCard(caseObj, {
    labels = null,
    hasDirectAction = true,
    statusNote = null,
  } = {}) {
    const L = mergeLabels(labels);
    const sevBadge = caseObj.severity === 'P0'
      ? L.severityP0
      : caseObj.severity === 'P1'
        ? L.severityP1
        : L.severityP2;

    const lines = [];
    const headerParts = [sevBadge];
    if (caseObj.containerTitle) headerParts.push(sanitizeUntrustedQuote(caseObj.containerTitle, { maxChars: 60 }));
    else if (caseObj.effectiveVendor) headerParts.push(sanitizeUntrustedQuote(caseObj.effectiveVendor, { maxChars: 50 }));
    if (Number(caseObj.distinctCount || 1) > 1) {
      headerParts.push(`(x${caseObj.distinctCount})`);
    }
    lines.push(headerParts.join(' | '));

    const summary = sanitizeUntrustedQuote(caseObj.summary || caseObj.caseKey || caseObj.caseId, { maxChars: 220 });
    lines.push(summary);

    if (caseObj.latestQuote) {
      const q = sanitizeUntrustedQuote(caseObj.latestQuote, { maxChars: 180 });
      if (q && q !== summary) lines.push(`> ${q}`);
    }

    const meta = [];
    if (caseObj.latestAmount && caseObj.latestAmount.value != null) {
      meta.push(`${caseObj.latestAmount.value} ${caseObj.latestAmount.currency || ''}`.trim());
    }
    if (caseObj.deadlineAt) {
      meta.push(`Due: ${String(caseObj.deadlineAt).slice(0, 16).replace('T', ' ')}`);
    }
    if (caseObj.authGrade === 'UNVERIFIED' && ['gmail', 'outlook', 'email'].includes(caseObj.source)) {
      meta.push(L.unverifiedWarning);
    }
    if (meta.length) lines.push(meta.join(' | '));

    const fa = caseObj.frozenAction;
    if (fa) {
      if (fa.effectStatus === 'verified') {
        lines.push(`${L.actionVerified}: ${sanitizeUntrustedQuote(fa.label || fa.tool, { maxChars: 80 })}`);
      } else if (fa.effectStatus === 'unconfirmed') {
        lines.push(L.actionUnconfirmed);
      } else if (fa.effectStatus === 'undone') {
        lines.push(L.actionUndone);
      } else {
        lines.push(`${L.actionProposed}: ${sanitizeUntrustedQuote(fa.label || fa.tool, { maxChars: 80 })}`);
      }
    }

    if (statusNote) {
      lines.push(`[${sanitizeUntrustedQuote(statusNote, { maxChars: 120 })}]`);
    } else if (caseObj.state === 'auto_resolved') {
      lines.push(`[${L.autoResolved}]`);
    } else if (caseObj.state === 'closed') {
      lines.push(`[${L.statusClosed}: ${caseObj.closedReason || 'done'}]`);
    }

    const buttons = [];
    const cid = caseObj.caseId;

    if (caseObj.state === 'open') {
      const row1 = [];
      if (fa && fa.effectStatus !== 'verified' && hasDirectAction) {
        row1.push({
          text: fa.buttonLabel || L.btnConfirm,
          callbackData: makeAlertCallbackData(cid, 'exec'),
        });
      } else if (caseObj.templateUrl) {
        row1.push({
          text: fa?.buttonLabel || L.btnOpenLink,
          url: String(caseObj.templateUrl),
        });
      }
      row1.push({ text: L.btnDone, callbackData: makeAlertCallbackData(cid, 'done') });
      row1.push({ text: L.btnSnooze2h, callbackData: makeAlertCallbackData(cid, 'sn2') });
      buttons.push(row1);

      const row2 = [
        { text: L.btnNotUseful, callbackData: makeAlertCallbackData(cid, 'dn') },
      ];
      if (caseObj.containerId && ['telegram_group', 'slack_channel', 'group'].includes(caseObj.source)) {
        row2.push({ text: L.btnMuteGroup, callbackData: makeAlertCallbackData(cid, 'mg') });
      } else if (caseObj.effectiveVendor) {
        row2.push({ text: L.btnMuteSender, callbackData: makeAlertCallbackData(cid, 'ms') });
      }
      if (caseObj.severity === 'P0') {
        row2.push({ text: L.btnNoNightP0, callbackData: makeAlertCallbackData(cid, 'nn') });
      }
      buttons.push(row2);
    } else if (fa && fa.effectStatus === 'verified' && fa.undoTool && fa.providerResourceId) {
      buttons.push([
        { text: L.btnUndo, callbackData: makeAlertCallbackData(cid, 'undo') },
      ]);
    }

    return {
      caseId: cid,
      severity: caseObj.severity,
      text: lines.join('\n'),
      buttons,
    };
  }

  function renderDigestCard(items = [], { shadowMode = false, labels = null } = {}) {
    const L = mergeLabels(labels);
    const title = shadowMode ? L.shadowDigestTitle : L.digestTitle;
    const lines = [`${title} (${items.length})`];
    const buttons = [];

    for (const item of items.slice(0, 12)) {
      const c = item.case || item;
      const where = sanitizeUntrustedQuote(c.containerTitle || c.effectiveVendor || c.source || 'alert', { maxChars: 36 });
      const sum = sanitizeUntrustedQuote(c.summary || c.caseKey || c.caseId, { maxChars: 110 });
      const rep = Number(c.distinctCount || 1) > 1 ? ` (x${c.distinctCount})` : '';
      lines.push(`- [${c.severity || 'P2'}] ${where}${rep}: ${sum}`);
      if (buttons.length < 4 && c.state === 'open') {
        buttons.push([
          { text: `${L.btnUseful} (${c.caseId.slice(-4)})`, callbackData: makeAlertCallbackData(c.caseId, 'up') },
          { text: `${L.btnNotUseful} (${c.caseId.slice(-4)})`, callbackData: makeAlertCallbackData(c.caseId, 'dn') },
        ]);
      }
    }

    return {
      kind: shadowMode ? 'shadow_digest' : 'digest',
      text: lines.join('\n'),
      buttons,
    };
  }

  function renderRollupCard(items = [], { labels = null } = {}) {
    const L = mergeLabels(labels);
    const lines = [`${L.rollupTitle} (${items.length})`];
    for (const item of items.slice(0, 10)) {
      const c = item.case || item;
      const where = sanitizeUntrustedQuote(c.containerTitle || c.effectiveVendor || c.source || 'alert', { maxChars: 36 });
      const sum = sanitizeUntrustedQuote(c.summary || c.caseKey || c.caseId, { maxChars: 100 });
      lines.push(`- [${c.severity || 'P1'}] ${where}: ${sum}`);
    }
    return {
      kind: 'rollup',
      text: lines.join('\n'),
      buttons: [],
    };
  }

  async function handleCallback(actor, callbackData, {
    tools = null,
    approvalStore = null,
    userDoc = null,
    executeContext = {},
    labels = null,
    hasDirectAction = true,
    nowMs = Date.now(),
  } = {}) {
    if (!isOwnerDm(actor)) {
      return { ok: false, code: 'FORBIDDEN', reason: 'alerts_owner_dm_required' };
    }
    const parsed = parseAlertCallbackData(callbackData);
    if (!parsed) {
      return { ok: false, reason: 'invalid_alert_callback' };
    }

    const { caseId, verb } = parsed;
    const c = ledger.getCase(caseId);
    if (!c) {
      return { ok: false, reason: 'case_not_found' };
    }

    const actorId = normalizeActorId(actor);
    const L = mergeLabels(labels);

    // ── Execute Frozen Action (1-Tap HITL: mint §21 token AT TAP TIME + enforce §28 confirmEffect) ──
    if (verb === 'exec') {
      const fa = c.frozenAction;
      if (!fa || !fa.tool) {
        return { ok: false, reason: 'no_frozen_action_on_case' };
      }
      if (fa.effectStatus === 'verified') {
        return {
          ok: true,
          action: 'already_verified',
          case: c,
          card: renderCaseCard(c, { labels: L, hasDirectAction }),
        };
      }
      const recomputedHash = computeArgsHash(fa.tool, fa.args || {});
      if (!fa.argsHash || recomputedHash !== fa.argsHash) {
        return { ok: false, reason: 'frozen_args_hash_mismatch' };
      }
      if (!tools || typeof tools.executeTool !== 'function') {
        return { ok: false, reason: 'tool_registry_unavailable' };
      }
      if (!approvalStore || typeof approvalStore.issue !== 'function') {
        return { ok: false, reason: 'approval_store_unavailable' };
      }

      const convId = String(actor.chatId ?? executeContext.chatId ?? actorId);
      const tok = approvalStore.issue({
        tool: fa.tool,
        args: fa.args || {},
        approver: actorId,
        tier: fa.tier || 'reversible_write',
        conversationId: convId,
        ttlMs: 60_000,
      });

      const execRes = await tools.executeTool(fa.tool, fa.args || {}, {
        ...executeContext,
        approvalTokenId: tok.id,
        chatId: convId,
        sender: (executeContext.sender && typeof executeContext.sender === 'object')
          ? executeContext.sender
          : { id: actorId, channelId: String(actor.senderId ?? actorId) },
        turnClassification: executeContext.turnClassification ?? {
          isGroup: false,
          isDm: true,
          speakerTrust: 'internal',
          writeToolsAllowed: true,
        },
        userDoc,
        trustedGroundingSources: executeContext.trustedGroundingSources ?? JSON.stringify(fa.args || {}),
      });

      const needsConfirm = fa.requireConfirmation !== undefined
        ? Boolean(fa.requireConfirmation)
        : Boolean(requireActionConfirmation);

      const confirmedOk = Boolean(
        execRes.confirmation && execRes.confirmation.checked === true && execRes.confirmation.ok === true
      );

      if (!execRes.ok || execRes.decision === 'unconfirmed') {
        const errMsg = execRes.error || execRes.reason || 'action_execution_failed';
        const updated = ledger.recordActionEffect(caseId, {
          status: execRes.decision === 'unconfirmed' ? 'unconfirmed' : 'failed',
          error: errMsg,
          nowMs,
        });
        return {
          ok: false,
          reason: errMsg,
          execResult: execRes,
          case: updated.case || ledger.getCase(caseId),
          card: renderCaseCard(updated.case || ledger.getCase(caseId), { labels: L, hasDirectAction }),
        };
      }

      if (needsConfirm && !confirmedOk) {
        const updated = ledger.recordActionEffect(caseId, {
          status: 'unconfirmed',
          error: 'effect_confirmation_missing',
          nowMs,
        });
        return {
          ok: false,
          reason: 'effect_confirmation_missing',
          execResult: execRes,
          case: updated.case || ledger.getCase(caseId),
          card: renderCaseCard(updated.case || ledger.getCase(caseId), { labels: L, hasDirectAction }),
        };
      }

      const providerResourceId = execRes.output?.id
        ?? execRes.output?.eventId
        ?? execRes.confirmation?.probeOutput?.id
        ?? fa.args?.eventId
        ?? null;

      const updated = ledger.recordActionEffect(caseId, {
        status: 'verified',
        providerResourceId,
        nowMs,
      });

      return {
        ok: true,
        action: 'executed',
        providerResourceId,
        execResult: execRes,
        case: updated.case,
        card: renderCaseCard(updated.case, { labels: L, hasDirectAction }),
      };
    }

    // ── Undo Previously Verified Action (scoped strictly to providerResourceId on this case) ──
    if (verb === 'undo') {
      const fa = c.frozenAction;
      if (!fa || fa.effectStatus !== 'verified' || !fa.undoTool || !fa.providerResourceId) {
        return { ok: false, reason: 'action_not_undoable' };
      }
      if (!tools || typeof tools.executeTool !== 'function' || !approvalStore) {
        return { ok: false, reason: 'undo_executor_unavailable' };
      }
      const convId = String(actor.chatId ?? executeContext.chatId ?? actorId);
      const idParam = fa.undoIdParam || 'eventId';
      const undoArgs = { ...(fa.undoArgs || {}), [idParam]: fa.providerResourceId };
      const tok = approvalStore.issue({
        tool: fa.undoTool,
        args: undoArgs,
        approver: actorId,
        tier: fa.undoTier || 'reversible_write',
        conversationId: convId,
        ttlMs: 60_000,
      });
      const execRes = await tools.executeTool(fa.undoTool, undoArgs, {
        ...executeContext,
        approvalTokenId: tok.id,
        chatId: convId,
        sender: (executeContext.sender && typeof executeContext.sender === 'object')
          ? executeContext.sender
          : { id: actorId, channelId: String(actor.senderId ?? actorId) },
        turnClassification: executeContext.turnClassification ?? {
          isGroup: false,
          isDm: true,
          speakerTrust: 'internal',
          writeToolsAllowed: true,
        },
        userDoc,
        trustedGroundingSources: executeContext.trustedGroundingSources ?? JSON.stringify(undoArgs),
      });
      if (!execRes.ok) {
        return {
          ok: false,
          reason: execRes.error || execRes.reason || 'undo_failed',
          execResult: execRes,
        };
      }
      const updated = ledger.recordActionEffect(caseId, {
        status: 'undone',
        providerResourceId: fa.providerResourceId,
        nowMs,
      });
      return {
        ok: true,
        action: 'undone',
        execResult: execRes,
        case: updated.case,
        card: renderCaseCard(updated.case, { labels: L, hasDirectAction }),
      };
    }

    // ── Feedback Verbs (done / snooze / useful / not_useful / mute / no_night_p0) ──
    const mapped = VERB_MAP[verb];
    if (!mapped) {
      return { ok: false, reason: `unsupported_callback_verb:${verb}` };
    }
    const fb = ledger.applyFeedback(caseId, mapped, { actor: actorId, nowMs });
    if (!fb.ok) return fb;

    const note = mapped === 'snooze_2h'
      ? `${L.statusSnoozed} (2h)`
      : mapped === 'snooze_24h'
        ? `${L.statusSnoozed} (24h)`
        : mapped.startsWith('mute_')
          ? `${L.statusMuted}`
          : null;

    return {
      ok: true,
      action: mapped,
      demoted: Boolean(fb.demoted),
      case: fb.case,
      card: renderCaseCard(fb.case, { labels: L, hasDirectAction, statusNote: note }),
    };
  }

  // ── Crash-Safe Due Notice Dispatcher (Strictly One-Way Owner DM Diode) ─────
  async function dispatchDueNotices({
    nowMs = Date.now(),
    sendOwnerMessage,
    labels = null,
    hasDirectAction = true,
  } = {}) {
    if (typeof sendOwnerMessage !== 'function') {
      throw new Error('dispatchDueNotices: sendOwnerMessage callback is required');
    }
    const L = mergeLabels(labels);
    const plan = ledger.tick(nowMs);
    const sentImmediate = [];
    const failedImmediate = [];
    let digestSent = false;
    let rollupSent = false;
    let heartbeatSent = false;

    for (const item of plan.immediate) {
      const c = item.case;
      const card = renderCaseCard(c, { labels: L, hasDirectAction });
      const renderHash = sha256Short(card.text);
      const resv = ledger.reserveNotice(c.caseId, {
        purpose: 'immediate',
        renderHash,
        nowMs,
      });
      if (!resv.ok) continue;

      try {
        // One-Way Diode: sendOwnerMessage is pinned to verified Owner DM by the host transport!
        const res = await sendOwnerMessage(card, {
          kind: 'immediate',
          caseId: c.caseId,
          noticeId: resv.notice.noticeId,
          severity: c.severity,
        });
        const msgId = res?.messageId ?? res?.message_id ?? res?.id ?? 'sent';
        ledger.confirmNotice(c.caseId, resv.notice.noticeId, {
          providerMessageId: String(msgId),
          chatId: res?.chatId != null ? String(res.chatId) : null,
          nowMs,
        });
        sentImmediate.push({ caseId: c.caseId, noticeId: resv.notice.noticeId, messageId: String(msgId) });
      } catch (err) {
        // Crash/timeout uncertainty: mark `unknown`, NEVER blind-retry a duplicate DM!
        ledger.markNoticeUnknown(c.caseId, resv.notice.noticeId, {
          error: String(err?.message || err),
          nowMs,
        });
        failedImmediate.push({ caseId: c.caseId, noticeId: resv.notice.noticeId, error: String(err?.message || err) });
      }
    }

    if (plan.digest.length > 0) {
      const card = renderDigestCard(plan.digest, { shadowMode: plan.shadowMode, labels: L });
      const reservations = [];
      for (const item of plan.digest) {
        const r = ledger.reserveNotice(item.case.caseId, {
          purpose: plan.shadowMode ? 'shadow_digest' : 'digest',
          renderHash: sha256Short(card.text),
          nowMs,
        });
        if (r.ok) reservations.push({ caseId: item.case.caseId, noticeId: r.notice.noticeId });
      }
      try {
        const res = await sendOwnerMessage(card, {
          kind: plan.shadowMode ? 'shadow_digest' : 'digest',
          digestKey: plan.digestKey,
          count: plan.digest.length,
        });
        const msgId = res?.messageId ?? res?.message_id ?? res?.id ?? 'digest';
        for (const r of reservations) {
          ledger.confirmNotice(r.caseId, r.noticeId, {
            providerMessageId: String(msgId),
            chatId: res?.chatId != null ? String(res.chatId) : null,
            nowMs,
          });
        }
        ledger.markDigestSent(plan.digestKey);
        digestSent = true;
      } catch (err) {
        for (const r of reservations) {
          ledger.markNoticeUnknown(r.caseId, r.noticeId, { error: String(err?.message || err), nowMs });
        }
      }
    }

    if (plan.rollupNeeded && plan.rollup && plan.rollup.length > 0) {
      const unrolled = plan.rollup.filter((item) => {
        const ln = (item.case.notices || []).at(-1);
        return !ln || ln.purpose !== 'rollup';
      });
      if (unrolled.length > 0) {
        const card = renderRollupCard(unrolled, { labels: L });
        const reservations = [];
        for (const item of unrolled) {
          const r = ledger.reserveNotice(item.case.caseId, {
            purpose: 'rollup',
            renderHash: sha256Short(card.text),
            nowMs,
          });
          if (r.ok) reservations.push({ caseId: item.case.caseId, noticeId: r.notice.noticeId });
        }
        try {
          const res = await sendOwnerMessage(card, { kind: 'rollup', count: unrolled.length });
          const msgId = res?.messageId ?? res?.message_id ?? res?.id ?? 'rollup';
          for (const r of reservations) {
            ledger.confirmNotice(r.caseId, r.noticeId, {
              providerMessageId: String(msgId),
              chatId: res?.chatId != null ? String(res.chatId) : null,
              nowMs,
            });
          }
          rollupSent = true;
        } catch (err) {
          for (const r of reservations) {
            ledger.markNoticeUnknown(r.caseId, r.noticeId, { error: String(err?.message || err), nowMs });
          }
        }
      }
    }

    if (plan.heartbeatDue && sendSilentHeartbeat) {
      try {
        await sendOwnerMessage({
          kind: 'heartbeat',
          text: `Smart Alerts: no urgent items today (${plan.dateKey}).`,
          buttons: [],
        }, { kind: 'heartbeat', dateKey: plan.dateKey });
        ledger.markHeartbeatSent(plan.dateKey);
        heartbeatSent = true;
      } catch { /* ignore heartbeat failure */ }
    }

    return {
      ok: true,
      plan,
      sentImmediate,
      failedImmediate,
      digestSent,
      rollupSent,
      heartbeatSent,
    };
  }

  return {
    isOwnerDm,
    renderCaseCard,
    renderDigestCard,
    renderRollupCard,
    handleCallback,
    dispatchDueNotices,
    sanitizeUntrustedQuote,
    buildGoogleCalendarTemplateUrl,
  };
}
