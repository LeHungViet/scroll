// SCROLL 2.14.1 -- Zero-dependency App Health Preflight & Atlas Sync Diff Primitives.
// Biz-neutral & placement-agnostic: any SCROLL host (Bot Room, W24, CLI, custom server) can run
// 0-token SSRF-safe HTTP probes against tenant-configured app URLs and compute exact per-app
// Git commit diffs on hot-reload without hardcoding any product or merchant domain.

export const APP_HEALTH_SCHEMA = 'scroll-app-health/v1';
export const ATLAS_SYNC_DIFF_SCHEMA = 'scroll-atlas-sync-diff/v1';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
]);

function isPrivateOrReservedIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateOrReservedIpv6(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare.includes(':')) return false;
  if (bare === '::' || bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true;
  if (bare.startsWith('fe80:') || bare.startsWith('fc') || bare.startsWith('fd')) return true;
  if (bare.startsWith('::ffff:')) {
    const mapped = bare.slice('::ffff:'.length);
    if (isPrivateOrReservedIpv4(mapped)) return true;
    // Hex-encoded IPv4 mapped address like ::ffff:7f00:1
    if (/^[0-9a-f:]+$/i.test(mapped)) return true;
  }
  return false;
}

/**
 * Strict SSRF guard for merchant application health probe URLs.
 * Allows only public HTTPS origins (no credentials, no loopback/private/link-local/internal hosts).
 */
export function isSafePublicHealthUrl(rawUrl, { allowInsecure = false } = {}) {
  const raw = String(rawUrl || '').trim();
  if (!raw || raw.length > 512) {
    return { safe: false, url: null, reason: 'EMPTY_OR_TOO_LONG' };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { safe: false, url: null, reason: 'INVALID_URL' };
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'https:' && !(allowInsecure && proto === 'http:')) {
    return { safe: false, url: null, reason: 'HTTPS_REQUIRED' };
  }
  if (parsed.username || parsed.password) {
    return { safe: false, url: null, reason: 'CREDENTIALS_NOT_ALLOWED' };
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) {
    return { safe: false, url: null, reason: 'MISSING_HOST' };
  }
  if (!allowInsecure) {
    if (
      BLOCKED_HOSTNAMES.has(host)
      || host.endsWith('.localhost')
      || host.endsWith('.local')
      || host.endsWith('.internal')
      || host.endsWith('.arpa')
      || host.endsWith('.lan')
    ) {
      return { safe: false, url: null, reason: 'PRIVATE_HOSTNAME' };
    }
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
      return { safe: false, url: null, reason: 'NUMERIC_IP_LITERAL' };
    }
    if (isPrivateOrReservedIpv4(host) || isPrivateOrReservedIpv6(host)) {
      return { safe: false, url: null, reason: 'PRIVATE_IP' };
    }
    if (!host.includes('.')) {
      return { safe: false, url: null, reason: 'SINGLE_LABEL_HOST' };
    }
  }
  return { safe: true, url: parsed.toString() };
}

function normalizeUrlKey(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    const pathname = u.pathname.replace(/\/+$/, '') || '';
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${pathname}${u.search}`;
  } catch {
    return String(raw || '').trim().toLowerCase();
  }
}

/**
 * Extracts unique health-check targets from any tenant's App Profile + compiled App Atlas.
 */
export function collectAppHealthTargets({ appProfile = null, atlas = null, app = null } = {}) {
  const filterApp = app ? String(app).trim().toLowerCase() : '';
  const targets = [];
  const seenUrls = new Set();

  const pushTarget = ({ id, name, url, source }) => {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) return;
    const key = normalizeUrlKey(cleanUrl);
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
    targets.push({
      id: String(id || 'app').trim() || 'app',
      name: String(name || id || cleanUrl).trim(),
      url: cleanUrl,
      source: source || 'profile',
    });
  };

  if (Array.isArray(appProfile?.apps)) {
    for (const a of appProfile.apps) {
      if (!a || typeof a !== 'object') continue;
      const aid = String(a.id || '').trim().toLowerCase();
      if (filterApp && aid !== filterApp) continue;
      if (a.publicUrl) {
        pushTarget({ id: a.id || a.name, name: a.name || a.id, url: a.publicUrl, source: 'app_profile' });
      }
    }
  }

  if (atlas?.apps && typeof atlas.apps === 'object') {
    for (const [appId, a] of Object.entries(atlas.apps)) {
      if (filterApp && appId.toLowerCase() !== filterApp) continue;
      if (a?.publicUrl) {
        pushTarget({ id: appId, name: a.name || appId, url: a.publicUrl, source: 'app_atlas' });
      }
    }
  }

  if (!filterApp && Array.isArray(appProfile?.healthUrls)) {
    for (let i = 0; i < appProfile.healthUrls.length; i++) {
      const entry = appProfile.healthUrls[i];
      if (typeof entry === 'string') {
        let label = entry;
        try { label = new URL(entry).hostname; } catch { /* keep raw */ }
        pushTarget({ id: `extra-${i + 1}`, name: label, url: entry, source: 'health_urls' });
      } else if (entry && typeof entry === 'object' && entry.url) {
        pushTarget({
          id: entry.id || `extra-${i + 1}`,
          name: entry.name || entry.id || entry.url,
          url: entry.url,
          source: 'health_urls',
        });
      }
    }
  }

  return targets;
}

/**
 * Concurrently probes configured public HTTP endpoints (0 LLM tokens, strict SSRF protection).
 */
export async function probeHttpEndpoints(targets = [], {
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  userAgent = 'SCROLL-AppHealthProbe/1.0',
  allowInsecure = false,
  now = Date.now,
} = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const checkedAt = new Date(now()).toISOString();
  const effectiveTimeout = Math.max(500, Math.min(20_000, Number(timeoutMs) || 8_000));

  const results = await Promise.all(list.map(async (item) => {
    const rawUrl = typeof item === 'string' ? item : item?.url;
    const id = typeof item === 'string' ? rawUrl : (item?.id || rawUrl || 'unknown');
    const name = typeof item === 'string' ? rawUrl : (item?.name || id);
    const guard = isSafePublicHealthUrl(rawUrl, { allowInsecure });
    if (!guard.safe) {
      return {
        id,
        name,
        url: String(rawUrl || ''),
        ok: false,
        blocked: true,
        status: null,
        latencyMs: 0,
        finalUrl: null,
        error: `ERR_SSRF_BLOCKED:${guard.reason}`,
      };
    }
    if (typeof fetchImpl !== 'function') {
      return {
        id,
        name,
        url: guard.url,
        ok: false,
        blocked: false,
        status: null,
        latencyMs: 0,
        finalUrl: null,
        error: 'ERR_FETCH_UNAVAILABLE',
      };
    }

    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), effectiveTimeout);
    try {
      const res = await fetchImpl(guard.url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/json;q=0.9,*/*;q=0.5',
        },
      });
      const latencyMs = Math.max(0, Math.round(now() - started));
      const status = Number(res?.status || 0);
      const ok = status >= 200 && status < 400;
      // Drain/cancel body quickly to prevent lingering sockets
      try { await res?.body?.cancel?.(); } catch { /* ignore */ }
      return {
        id,
        name,
        url: guard.url,
        ok,
        blocked: false,
        status: status || null,
        latencyMs,
        finalUrl: res?.url || guard.url,
        error: ok ? null : `HTTP_${status || 'UNKNOWN'}`,
      };
    } catch (err) {
      const latencyMs = Math.max(0, Math.round(now() - started));
      const isTimeout = err?.name === 'AbortError' || String(err?.message || '').includes('TIMEOUT');
      return {
        id,
        name,
        url: guard.url,
        ok: false,
        blocked: false,
        status: null,
        latencyMs,
        finalUrl: null,
        error: isTimeout ? `TIMEOUT_${effectiveTimeout}MS` : String(err?.code || err?.message || 'NETWORK_ERROR').slice(0, 120),
      };
    } finally {
      clearTimeout(timer);
    }
  }));

  const upCount = results.filter(r => r.ok).length;
  const downCount = results.length - upCount;

  return {
    schema: APP_HEALTH_SCHEMA,
    ok: downCount === 0,
    checkedAt,
    total: results.length,
    upCount,
    downCount,
    results,
  };
}

/**
 * Formats a concise owner alert ONLY when one or more probed endpoints are down.
 * Returns empty string '' when all endpoints are healthy (or none configured) so 0-token crons stay silent.
 */
export function formatAppHealthAlert(report, { brandName = '', lang = 'vi' } = {}) {
  if (!report || !Array.isArray(report.results) || report.results.length === 0) return '';
  const down = report.results.filter(r => !r.ok);
  if (down.length === 0) return '';

  const label = brandName ? ` (${brandName})` : '';
  if (String(lang || 'vi').toLowerCase().startsWith('en')) {
    const lines = [
      `⚠️ App Health Alert${label}: ${down.length}/${report.total} endpoint(s) unhealthy`,
      ...down.map(r => `- ${r.name} (${r.url}): ${r.error || `HTTP ${r.status}`} (${r.latencyMs}ms)`),
    ];
    return lines.join('\n');
  }
  const lines = [
    `⚠️ Cảnh báo sức khỏe ứng dụng${label}: ${down.length}/${report.total} trang đang gặp sự cố`,
    ...down.map(r => `- ${r.name} (${r.url}): ${r.error || `HTTP ${r.status}`} (${r.latencyMs}ms)`),
  ];
  return lines.join('\n');
}

/**
 * Computes exact per-app SHA drift and newly added commits between a previous and next App Atlas.
 */
export function diffAppAtlasSync(prevAtlas, nextAtlas, { syncedAt = new Date().toISOString() } = {}) {
  const prevApps = prevAtlas?.apps && typeof prevAtlas.apps === 'object' ? prevAtlas.apps : {};
  const nextApps = nextAtlas?.apps && typeof nextAtlas.apps === 'object' ? nextAtlas.apps : {};

  const diff = {};
  const changedApps = [];
  const unchangedApps = [];

  for (const [appId, nextApp] of Object.entries(nextApps)) {
    const prevApp = prevApps[appId] || null;
    const prevSha = prevApp?.sourceSha || null;
    const nextSha = nextApp?.sourceSha || null;
    const changed = Boolean(!prevApp || prevSha !== nextSha);

    const prevCommitSet = new Set(
      (Array.isArray(prevApp?.recentCommits) ? prevApp.recentCommits : [])
        .map(c => String(c?.sha || '').trim())
        .filter(Boolean),
    );
    const nextCommits = Array.isArray(nextApp?.recentCommits) ? nextApp.recentCommits : [];
    const newCommits = [];
    if (changed) {
      for (const c of nextCommits) {
        const sha = String(c?.sha || '').trim();
        if (!sha) continue;
        if (prevSha && (sha === prevSha || prevSha.startsWith(sha) || sha.startsWith(prevSha))) break;
        if (prevCommitSet.has(sha)) continue;
        newCommits.push({
          sha: sha.slice(0, 12),
          date: c?.date || null,
          subject: String(c?.subject || '').slice(0, 160),
        });
        if (newCommits.length >= 10) break;
      }
    }

    const entry = {
      app: appId,
      name: nextApp?.name || appId,
      previousSha: prevSha,
      newSha: nextSha,
      changed,
      newCommitCount: newCommits.length,
      newCommits,
      screensDelta: (nextApp?.stats?.screenCount ?? nextApp?.stats?.screens ?? 0)
        - (prevApp?.stats?.screenCount ?? prevApp?.stats?.screens ?? 0),
      rpcsDelta: (nextApp?.stats?.rpcCount ?? nextApp?.stats?.rpcs ?? 0)
        - (prevApp?.stats?.rpcCount ?? prevApp?.stats?.rpcs ?? 0),
      rlsDelta: (nextApp?.stats?.rlsPolicyCount ?? nextApp?.stats?.rlsPolicies ?? 0)
        - (prevApp?.stats?.rlsPolicyCount ?? prevApp?.stats?.rlsPolicies ?? 0),
      i18nDelta: (nextApp?.stats?.i18nCount ?? nextApp?.stats?.i18nKeys ?? 0)
        - (prevApp?.stats?.i18nCount ?? prevApp?.stats?.i18nKeys ?? 0),
    };
    diff[appId] = entry;
    if (changed) changedApps.push(entry);
    else unchangedApps.push(appId);
  }

  return {
    schema: ATLAS_SYNC_DIFF_SCHEMA,
    syncedAt,
    atlasHash: nextAtlas?.atlasHash || null,
    compiledAt: nextAtlas?.compiledAt || syncedAt,
    hasChanges: changedApps.length > 0,
    changedCount: changedApps.length,
    changedApps,
    unchangedApps,
    diff,
  };
}

/**
 * Canonical, zero-hardcode morning preflight cron prompt for Merchant/Product AI agents on SCROLL.
 * Strictly returns `NO_REPLY` when all monitored endpoints are healthy, no new repo commits require
 * guidance review, Atlas is fresh, and no owner-facing tickets or open loops need attention.
 */
export function buildMorningPreflightPrompt({
  brandName = '',
  staleHoursThreshold = 30,
  lang = 'vi',
} = {}) {
  const brand = String(brandName || '').trim();
  const staleHours = Math.max(6, Number(staleHoursThreshold) || 30);
  if (String(lang || 'vi').toLowerCase().startsWith('en')) {
    return [
      `Run the daily morning preflight${brand ? ` for ${brand}` : ''}:`,
      `1. Call app_freshness_status({ checkLiveHealth: true }) to verify live HTTP status of all configured apps, check Atlas age (flag if ageHours > ${staleHours}), and inspect recentSyncChanges for new commits in the last 24h that may affect user guides or UI labels.`,
      '2. Call ticket_list({ status: "open" }) and ticket_list({ status: "awaiting_approval" }) to see any open tickets or approvals waiting on the owner.',
      '3. Call memory_open_loops and memory_recent_chats to check for any unresolved customer questions or blockers needing the owner\'s decision.',
      '4. SILENT RULE: If ALL monitored apps are HTTP 200 OK, Atlas is fresh, no new commits need guide updates, 0 open/awaiting-approval tickets exist, and there are no unresolved questions for the owner, output EXACTLY `NO_REPLY` (nothing else).',
      '5. Otherwise, send one concise bulleted morning briefing to the owner covering only the actionable items (App Health · New Repo Changes · Open Tickets / Questions for Owner).',
    ].join('\n');
  }
  return [
    `Thực hiện kiểm tra đầu ngày (Morning Preflight)${brand ? ` cho ${brand}` : ''}:`,
    `1. Gọi app_freshness_status({ checkLiveHealth: true }) để đo HTTP trực tiếp các ứng dụng trong App Profile, kiểm tra độ tươi của App Atlas (cảnh báo nếu ageHours > ${staleHours} giờ), và xem mục recentSyncChanges xem 24 giờ qua có commit mới nào ảnh hưởng luồng/nhãn nút hướng dẫn khách không.`,
    '2. Gọi ticket_list({ status: "open" }) và ticket_list({ status: "awaiting_approval" }) để kiểm tra phiếu đang mở hoặc chờ chủ sở hữu duyệt trong mục Việc.',
    '3. Gọi memory_open_loops và memory_recent_chats để xem có câu hỏi nào của khách còn bỏ ngỏ hoặc điểm nào cần hỏi/chốt với chủ sở hữu không.',
    '4. QUY TẮC IM LẶNG (BẮT BUỘC): Nếu TẤT CẢ ứng dụng đều hoạt động bình thường (HTTP 2xx/3xx), Atlas còn tươi, không có commit mới nào cần lưu ý/cập nhật hướng dẫn, không có phiếu mở/chờ duyệt và không có việc cần hỏi chủ sở hữu -> chỉ trả về đúng chuỗi `NO_REPLY` (không thêm bất kỳ chữ nào khác).',
    '5. Ngược lại, chỉ khi có ít nhất 1 mục cần chủ sở hữu biết hoặc quyết định, gửi 1 bản tin ngắn gọn đi thẳng cốt lõi theo tối đa 3 nhóm (chỉ hiện nhóm có việc): Sức khỏe ứng dụng · Cập nhật mới trên repo · Việc / Câu hỏi cần chốt.',
  ].join('\n');
}
