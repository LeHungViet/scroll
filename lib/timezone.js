// SCROLL 2.8.3 -- Canonical Global IANA Timezone Resolution & Region-C Clock Cue (`lib/timezone.js`).
// Zero dependencies, pure Node >= 20, zero hardcoded country/locale defaults.
//
// Resolution cascade (highest -> lowest priority):
//   1. turnTimezone       -- explicit per-turn override (e.g., web client browser tz when traveling)
//   2. speakerTimezone    -- active speaker's `timezone` from USER.md / people.js card
//   3. principalTimezone  -- deployment principal's `principal.timezone` from USER.md
//   4. agentTimezone      -- agent's declared `timezone` from IDENTITY.md frontmatter
//   5. hostTimezone       -- host/companion/runtime default IANA timezone
//   6. fallback           -- 'UTC' (never hardcoded to a specific country)

export function isValidIanaTimezone(tz) {
  if (typeof tz !== 'string') return false;
  const s = tz.trim();
  if (!s || s.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimezone(tz) {
  if (typeof tz !== 'string') return null;
  const s = tz.trim();
  return isValidIanaTimezone(s) ? s : null;
}

export function detectHostTimezone(fallback = 'UTC') {
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const clean = normalizeTimezone(detected);
    if (clean) return clean;
  } catch { /* ignore */ }
  return normalizeTimezone(fallback) || 'UTC';
}

export function getUtcOffsetLabel(date = new Date(), tz = 'UTC') {
  const safeTz = normalizeTimezone(tz) || 'UTC';
  const d = date instanceof Date ? date : new Date(date);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTz,
      timeZoneName: 'shortOffset',
    }).formatToParts(d);
    const raw = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    if (raw === 'GMT' || raw === 'UTC') return 'UTC+00:00';
    const m = raw.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (m) {
      const sign = m[1];
      const hh = String(m[2]).padStart(2, '0');
      const mm = String(m[3] || '00').padStart(2, '0');
      return `UTC${sign}${hh}:${mm}`;
    }
    return raw.replace(/^GMT/, 'UTC');
  } catch {
    return 'UTC+00:00';
  }
}

export function resolveTimezone({
  turnTimezone = null,
  speakerTimezone = null,
  principalTimezone = null,
  agentTimezone = null,
  hostTimezone = null,
  fallback = 'UTC',
} = {}) {
  const candidates = [
    ['turn', turnTimezone],
    ['speaker', speakerTimezone],
    ['principal', principalTimezone],
    ['agent', agentTimezone],
    ['host', hostTimezone],
    ['fallback', fallback],
  ];
  for (const [source, value] of candidates) {
    const clean = normalizeTimezone(value);
    if (clean) return { timezone: clean, source };
  }
  return { timezone: 'UTC', source: 'fallback' };
}

// Neutral, unambiguous Region-C live clock cue (100% sec 13 prefix-cache safe).
// Uses ISO YYYY-MM-DD + weekday + 24h HH:MM + IANA zone + live DST-aware UTC offset.
export function formatCurrentTimeCue(now = new Date(), { timezone = 'UTC' } = {}) {
  const safeTz = normalizeTimezone(timezone) || 'UTC';
  const d = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: safeTz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const pick = (type) => parts.find((p) => p.type === type)?.value || '';
    const wd = pick('weekday');
    const yr = pick('year');
    const mo = pick('month');
    const dy = pick('day');
    const hrRaw = pick('hour');
    const hr = hrRaw === '24' ? '00' : hrRaw;
    const mn = pick('minute');
    const offset = getUtcOffsetLabel(d, safeTz);
    return `[Current time: ${wd}, ${yr}-${mo}-${dy} ${hr}:${mn} · ${safeTz} (${offset})]`;
  } catch {
    return `[Current time: ${d.toISOString()} · UTC (UTC+00:00)]`;
  }
}
