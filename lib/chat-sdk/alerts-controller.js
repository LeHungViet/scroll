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
  badgeP0: 'Urgent',
  badgeP1: 'Attention',
  badgeP2: 'Digest',
  badgeCalendar: 'Calendar Reminder',
  digestItemP0: '[P0]',
  digestItemP1: '[P1]',
  digestItemP2: '[P2]',
  headerSep: ' - ',
  metaSep: ' - ',
  labelDue: 'Due',
  labelCount: 'x',
  actionCalendarHint: 'Tap below to add this event to Google Calendar.',
  shadowBanner: '[SHADOW MODE - WOULD HAVE ALERTED]',
  digestTitle: 'Smart Alerts Digest',
  shadowDigestTitle: 'Smart Alerts Shadow Digest (No Live Push)',
  rollupTitle: 'Unacknowledged Alerts Rollup',
  unverifiedWarning: 'Unverified sender (DKIM/DMARC not verified)',
  connectorNotice: 'Inbox connector (no raw DKIM/DMARC header)',
  btnOpenEmail: 'Open Email',
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

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function cleanDisplayQuote(text, { maxChars = 180 } = {}) {
  const safe = sanitizeUntrustedQuote(text, { maxChars: Math.max(maxChars + 60, 260) });
  if (!safe) return '';
  const parts = safe
    .split(/\s*\|\s*/)
    .map((seg) => seg.trim())
    .filter((seg) => {
      if (!seg) return false;
      const bodyOnly = seg.replace(/^[^:]{1,40}:\s*/, '').trim();
      return bodyOnly && bodyOnly !== '[link-removed]';
    })
    .map((seg) => seg.replace(/\s*\[link-removed\]\s*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let out = parts.join(' / ').trim();
  if (out.length > maxChars) {
    out = `${out.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
  }
  return out;
}

function formatDeadlineDisplay(deadlineAt, tz = 'UTC') {
  if (!deadlineAt) return null;
  const raw = String(deadlineAt).trim();
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    const fallback = raw.slice(0, 16).replace('T', ' ');
    return { text: fallback, timePart: '', dayMonth: '', isoDate: raw.slice(0, 10) };
  }
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const day = parts.day || '01';
    const month = parts.month || '01';
    const year = parts.year || '2026';
    const hour = parts.hour === '24' ? '00' : (parts.hour || '00');
    const minute = parts.minute || '00';
    const timePart = `${hour}:${minute}`;
    const dayMonth = `${day}/${month}`;
    const isoDate = `${year}-${month}-${day}`;
    const text = (hour === '00' && minute === '00')
      ? `${dayMonth}/${year}`
      : `${timePart} ${dayMonth}/${year}`;
    return { text, timePart, dayMonth, isoDate, hour: Number(hour), minute: Number(minute) };
  } catch {
    const fallback = raw.slice(0, 16).replace('T', ' ');
    return { text: fallback, timePart: '', dayMonth: '', isoDate: raw.slice(0, 10) };
  }
}

function summaryMentionsDeadline(summary, dl) {
  if (!summary || !dl) return false;
  const s = String(summary);
  const hasDate = (dl.dayMonth && s.includes(dl.dayMonth)) || (dl.isoDate && s.includes(dl.isoDate));
  if (!hasDate) return false;
  if (!dl.timePart || (dl.hour === 0 && dl.minute === 0)) return true;
  const compactHour = dl.minute === 0 ? `${dl.hour}h` : `${dl.hour}h${String(dl.minute).padStart(2, '0')}`;
  return s.includes(dl.timePart) || s.toLowerCase().includes(compactHour);
}

function formatAmountDisplay(amount) {
  if (!amount || amount.value == null) return '';
  const num = Number(amount.value);
  const cur = String(amount.currency || '').trim().toUpperCase();
  if (!Number.isFinite(num)) return `${amount.value} ${cur}`.trim();
  if (cur === 'VND') {
    return `${Math.round(num).toLocaleString('en-US')} VND`;
  }
  const formatted = Number.isInteger(num) ? num.toLocaleString('en-US') : num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur ? `${formatted} ${cur}` : formatted;
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

function isSafeProviderPermalink(rawUrl) {
  if (!rawUrl) return false;
  try {
    const u = new URL(String(rawUrl));
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    return ['mail.google.com', 'outlook.live.com', 'outlook.office.com'].includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
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
  format: defaultFormat = 'plain',
  tz: defaultTz = 'UTC',
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

  function buildCaseButtons(caseObj, { L, hasDirectAction }) {
    const buttons = [];
    const cid = caseObj.caseId;
    const fa = caseObj.frozenAction;

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
      } else if (isSafeProviderPermalink(caseObj.providerPermalink)) {
        row1.push({
          text: L.btnOpenEmail,
          url: String(caseObj.providerPermalink),
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
    return buttons;
  }

  function renderCaseCard(caseObj, {
    labels = null,
    hasDirectAction = true,
    statusNote = null,
    format = defaultFormat,
    tz = defaultTz,
  } = {}) {
    const L = mergeLabels(labels);
    const effFormat = format === 'html' ? 'html' : 'plain';
    const cid = caseObj.caseId;
    const buttons = buildCaseButtons(caseObj, { L, hasDirectAction });
    const summary = sanitizeUntrustedQuote(caseObj.summary || caseObj.caseKey || cid, { maxChars: 220 });
    const fa = caseObj.frozenAction;
    const isCalendarCase = Boolean(
      fa?.tool === 'calendar_create_event'
      || String(caseObj.stage || '').startsWith('meeting_')
      || String(caseObj.caseKey || '').startsWith('calendar:')
    );
    const whereRaw = caseObj.containerTitle
      ? sanitizeUntrustedQuote(caseObj.containerTitle, { maxChars: 60 })
      : (caseObj.effectiveVendor ? sanitizeUntrustedQuote(caseObj.effectiveVendor, { maxChars: 50 }) : '');
    const countNum = Number(caseObj.distinctCount || 1);
    const dl = formatDeadlineDisplay(caseObj.deadlineAt, tz);
    const showDeadline = Boolean(dl && !summaryMentionsDeadline(summary, dl));
    const amountText = formatAmountDisplay(caseObj.latestAmount);
    const isEmailSrc = ['gmail', 'outlook', 'email'].includes(caseObj.source);
    const authWarning = caseObj.authGrade === 'UNVERIFIED' && isEmailSrc
      ? L.unverifiedWarning
      : (caseObj.authGrade === 'PROVIDER_INBOX_PINNED' && isEmailSrc ? L.connectorNotice : null);

    if (effFormat === 'html') {
      const blocks = [];
      const badge = isCalendarCase
        ? L.badgeCalendar
        : caseObj.severity === 'P0'
          ? L.badgeP0
          : caseObj.severity === 'P1'
            ? L.badgeP1
            : L.badgeP2;
      const headCore = whereRaw ? `${badge}${L.headerSep}${whereRaw}` : badge;
      const countSuffix = countNum > 1 ? ` (${L.labelCount}${countNum})` : '';
      blocks.push(`<b>${escapeHtml(headCore)}</b>${escapeHtml(countSuffix)}`);

      blocks.push(escapeHtml(summary));

      if (caseObj.latestQuote) {
        const q = cleanDisplayQuote(caseObj.latestQuote, { maxChars: 180 });
        if (q && q !== summary && !summary.includes(q)) {
          blocks.push(`<blockquote>${escapeHtml(q)}</blockquote>`);
        }
      }

      const metaParts = [];
      if (amountText) metaParts.push(amountText);
      if (showDeadline) metaParts.push(`${L.labelDue}: ${dl.text}`);
      if (metaParts.length) {
        blocks.push(escapeHtml(metaParts.join(L.metaSep)));
      }
      if (authWarning) {
        blocks.push(`<i>${escapeHtml(authWarning)}</i>`);
      }

      const footerLines = [];
      if (fa) {
        if (fa.effectStatus === 'verified') {
          const fl = sanitizeUntrustedQuote(fa.label || fa.tool, { maxChars: 80 });
          footerLines.push(`<b>${escapeHtml(L.actionVerified)}</b>${fl ? `: ${escapeHtml(fl)}` : ''}`);
        } else if (fa.effectStatus === 'unconfirmed') {
          footerLines.push(`<i>${escapeHtml(L.actionUnconfirmed)}</i>`);
        } else if (fa.effectStatus === 'undone') {
          footerLines.push(`<i>${escapeHtml(L.actionUndone)}</i>`);
        } else if (isCalendarCase && L.actionCalendarHint) {
          footerLines.push(`<i>${escapeHtml(L.actionCalendarHint)}</i>`);
        } else {
          const fl = sanitizeUntrustedQuote(fa.label || fa.tool, { maxChars: 80 });
          if (fl && !summary.includes(fl)) {
            footerLines.push(`<i>${escapeHtml(L.actionProposed)}: ${escapeHtml(fl)}</i>`);
          }
        }
      }

      if (statusNote) {
        footerLines.push(`<i>${escapeHtml(sanitizeUntrustedQuote(statusNote, { maxChars: 120 }))}</i>`);
      } else if (caseObj.state === 'auto_resolved') {
        footerLines.push(`<i>${escapeHtml(L.autoResolved)}</i>`);
      } else if (caseObj.state === 'closed') {
        footerLines.push(`<i>${escapeHtml(L.statusClosed)}${caseObj.closedReason && caseObj.closedReason !== 'done' ? `: ${escapeHtml(caseObj.closedReason)}` : ''}</i>`);
      }
      if (footerLines.length) {
        blocks.push(footerLines.join('\n'));
      }

      return {
        caseId: cid,
        severity: caseObj.severity,
        text: blocks.join('\n\n'),
        parseMode: 'HTML',
        buttons,
      };
    }

    const sevBadge = caseObj.severity === 'P0'
      ? L.severityP0
      : caseObj.severity === 'P1'
        ? L.severityP1
        : L.severityP2;

    const lines = [];
    const headerParts = [sevBadge];
    if (whereRaw) headerParts.push(whereRaw);
    if (countNum > 1) {
      headerParts.push(`(${L.labelCount}${countNum})`);
    }
    lines.push(headerParts.join(' | '));
    lines.push(summary);

    if (caseObj.latestQuote) {
      const q = sanitizeUntrustedQuote(caseObj.latestQuote, { maxChars: 180 });
      if (q && q !== summary) lines.push(`> ${q}`);
    }

    const meta = [];
    if (amountText) meta.push(amountText);
    if (showDeadline) meta.push(`${L.labelDue}: ${dl.text}`);
    if (authWarning) meta.push(authWarning);
    if (meta.length) lines.push(meta.join(' | '));

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

    return {
      caseId: cid,
      severity: caseObj.severity,
      text: lines.join('\n'),
      parseMode: null,
      buttons,
    };
  }

  function renderDigestCard(items = [], {
    shadowMode = false,
    labels = null,
    format = defaultFormat,
  } = {}) {
    const L = mergeLabels(labels);
    const effFormat = format === 'html' ? 'html' : 'plain';
    const title = shadowMode ? L.shadowDigestTitle : L.digestTitle;
    const buttons = [];

    if (effFormat === 'html') {
      const blocks = [`<b>${escapeHtml(title)}</b> (${items.length})`];
      const itemBlocks = [];
      let idx = 0;
      for (const item of items.slice(0, 12)) {
        idx += 1;
        const c = item.case || item;
        const where = sanitizeUntrustedQuote(c.containerTitle || c.effectiveVendor || c.source || 'alert', { maxChars: 36 });
        const sum = sanitizeUntrustedQuote(c.summary || c.caseKey || c.caseId, { maxChars: 110 });
        const rep = Number(c.distinctCount || 1) > 1 ? ` (${L.labelCount}${c.distinctCount})` : '';
        const icon = c.severity === 'P0' ? L.digestItemP0 : c.severity === 'P1' ? L.digestItemP1 : L.digestItemP2;
        itemBlocks.push(`${idx}. ${escapeHtml(icon)} <b>${escapeHtml(where)}</b>${escapeHtml(rep)}\n   ${escapeHtml(sum)}`);
        if (buttons.length < 4 && c.state === 'open') {
          buttons.push([
            { text: `${L.btnUseful} (${c.caseId.slice(-4)})`, callbackData: makeAlertCallbackData(c.caseId, 'up') },
            { text: `${L.btnNotUseful} (${c.caseId.slice(-4)})`, callbackData: makeAlertCallbackData(c.caseId, 'dn') },
          ]);
        }
      }
      if (itemBlocks.length) blocks.push(itemBlocks.join('\n\n'));
      return {
        kind: shadowMode ? 'shadow_digest' : 'digest',
        text: blocks.join('\n\n'),
        parseMode: 'HTML',
        buttons,
      };
    }

    const lines = [`${title} (${items.length})`];
    for (const item of items.slice(0, 12)) {
      const c = item.case || item;
      const where = sanitizeUntrustedQuote(c.containerTitle || c.effectiveVendor || c.source || 'alert', { maxChars: 36 });
      const sum = sanitizeUntrustedQuote(c.summary || c.caseKey || c.caseId, { maxChars: 110 });
      const rep = Number(c.distinctCount || 1) > 1 ? ` (${L.labelCount}${c.distinctCount})` : '';
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
      parseMode: null,
      buttons,
    };
  }

  function renderRollupCard(items = [], {
    labels = null,
    format = defaultFormat,
  } = {}) {
    const L = mergeLabels(labels);
    const effFormat = format === 'html' ? 'html' : 'plain';
    if (effFormat === 'html') {
      const blocks = [`<b>${escapeHtml(L.rollupTitle)}</b> (${items.length})`];
      const itemBlocks = [];
      let idx = 0;
      for (const item of items.slice(0, 10)) {
        idx += 1;
        const c = item.case || item;
        const where = sanitizeUntrustedQuote(c.containerTitle || c.effectiveVendor || c.source || 'alert', { maxChars: 36 });
        const sum = sanitizeUntrustedQuote(c.summary || c.caseKey || c.caseId, { maxChars: 100 });
        const icon = c.severity === 'P0' ? L.digestItemP0 : L.digestItemP1;
        itemBlocks.push(`${idx}. ${escapeHtml(icon)} <b>${escapeHtml(where)}</b>\n   ${escapeHtml(sum)}`);
      }
      if (itemBlocks.length) blocks.push(itemBlocks.join('\n\n'));
      return {
        kind: 'rollup',
        text: blocks.join('\n\n'),
        parseMode: 'HTML',
        buttons: [],
      };
    }

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
      parseMode: null,
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
    escapeHtml,
    buildGoogleCalendarTemplateUrl,
  };
}
