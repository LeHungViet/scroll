// Two-Gear Software Reality Atlas Harvester, TTL Refresh Auditor & 60s HITL Approval Loop
// for `@agentpro/scroll-advisory`.
//   - Gear 1 (HTTP Fetch Probe): lightweight reachability, content extraction, & version drift check.
//   - Gear 2 (Browser/Sandbox Probe): optional real-browser probe (e.g. Dragon Browser / Playwright / CUA)
//     triggered automatically when Gear 1 hits an SPA shell, WAF block, or requires visual verification.
//   - TTL Auditor: identifies expired and expiring-soon Atlas entries for scheduled refresh.
//   - HITL Approval Loop: promotes client-submitted error screenshots (`pending_review`) to verified Atlas entries.
import crypto from 'node:crypto';

export async function defaultHttpProbe(url, { timeoutMs = 10_000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScrollAtlasVerifier/1.0)' },
    });
    const text = await res.text();
    const title = (text.match(/<title[^>]*>([^<]{1,180})<\/title>/i) || [])[1]?.trim() || '';
    const wafBlocked = /request\s+rejected|access\s+denied|cloudflare|captcha/i.test(title) || res.status === 403;
    const isSpaShell = res.ok && text.length < 4000 && !wafBlocked;
    const contentHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    return {
      ok: res.ok && !wafBlocked,
      status: res.status,
      durationMs: Date.now() - t0,
      bytes: text.length,
      title,
      text,
      wafBlocked,
      isSpaShell,
      contentHash,
      gear: 'http',
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - t0,
      error: String(err?.cause?.code || err?.message || err),
      gear: 'http',
    };
  }
}

export function createSoftwareAtlasHarvester({
  cortex,
  targets = [],
  httpProbe = defaultHttpProbe,
  browserProbe = null,
  now = () => new Date().toISOString(),
  logger = null,
} = {}) {
  if (!cortex) throw new Error('createSoftwareAtlasHarvester requires cortex');

  function findExpiringEntries({ warnWithinDays = 7, nowIso = null } = {}) {
    const nowMs = Date.parse(String(nowIso || now())) || Date.now();
    const all = cortex.listT3Atlas({ includePending: false });
    const expired = [];
    const expiringSoon = [];
    let healthyCount = 0;

    for (const entry of all) {
      const verifiedMs = Date.parse(entry.verifiedAt) || 0;
      const ageDays = (nowMs - verifiedMs) / 86_400_000;
      const remainingDays = entry.ttlDays - ageDays;
      if (remainingDays <= 0 || entry.status === 'expired') {
        expired.push({ atlasId: entry.atlasId, software: entry.software, os: entry.os, ageDays: Math.round(ageDays), ttlDays: entry.ttlDays });
      } else if (remainingDays <= warnWithinDays) {
        expiringSoon.push({ atlasId: entry.atlasId, software: entry.software, os: entry.os, remainingDays: Math.round(remainingDays), ttlDays: entry.ttlDays });
      } else {
        healthyCount++;
      }
    }
    return { total: all.length, healthyCount, expiringSoon, expired };
  }

  async function probeTarget(target) {
    const ts = String(now());
    let probeRes = await httpProbe(target.url, { timeoutMs: target.timeoutMs || 10_000 });
    let usedGear = 'http';

    const needsBrowser = Boolean(
      typeof browserProbe === 'function'
      && (target.preferBrowser || !probeRes.ok || probeRes.wafBlocked || probeRes.isSpaShell)
    );
    if (needsBrowser) {
      try {
        const bRes = await browserProbe(target);
        if (bRes && bRes.ok) {
          probeRes = { ...bRes, gear: 'browser' };
          usedGear = 'browser';
        }
      } catch (err) {
        logger?.warn?.(`[scroll-advisory:harvester] browserProbe failed (${target.software}):`, err?.message || err);
      }
    }

    const bodyText = String(probeRes?.text || '');
    const extractedVersion = typeof target.extractVersion === 'function'
      ? (target.extractVersion(bodyText, probeRes) || null)
      : (target.versionRegex instanceof RegExp ? (bodyText.match(target.versionRegex)?.[1] || bodyText.match(target.versionRegex)?.[0] || null) : null);

    const markers = Array.isArray(target.expectedMarkers) ? target.expectedMarkers : [];
    const matchedMarkers = markers.filter((m) => bodyText.toLowerCase().includes(String(m).toLowerCase()));
    const markerOk = !markers.length || matchedMarkers.length > 0;
    const verified = Boolean(probeRes.ok && (markerOk || usedGear === 'browser' || probeRes.isSpaShell));

    // Refresh matching T3 Atlas entries in SQLite if verified!
    const refreshedIds = [];
    if (verified && Array.isArray(target.atlasIds)) {
      const existingById = new Map(cortex.listT3Atlas({ includePending: true }).map((a) => [a.atlasId, a]));
      for (const aid of target.atlasIds) {
        const cur = existingById.get(aid);
        if (!cur) continue;
        cortex.upsertT3Atlas({
          ...cur,
          version: extractedVersion || cur.version,
          verifiedAt: ts,
          verifier: usedGear === 'browser' ? 'sandbox_browser' : 'live_http_probe',
          screenshotRef: probeRes.screenshotRef || cur.screenshotRef || null,
          status: 'verified',
        });
        refreshedIds.push(aid);
      }
    }

    return {
      targetId: target.id || target.software,
      software: target.software,
      url: target.url,
      ok: verified,
      gear: usedGear,
      status: probeRes.status ?? 0,
      durationMs: probeRes.durationMs ?? 0,
      title: probeRes.title || '',
      extractedVersion,
      matchedMarkers,
      contentHash: probeRes.contentHash || null,
      screenshotRef: probeRes.screenshotRef || null,
      refreshedIds,
      verifiedAt: verified ? ts : null,
      error: verified ? null : (probeRes.error || (probeRes.wafBlocked ? 'waf_blocked_needs_browser' : 'probe_failed')),
    };
  }

  async function runHarvest({ targetIds = null } = {}) {
    const selected = Array.isArray(targetIds) && targetIds.length
      ? targets.filter((t) => targetIds.includes(t.id) || targetIds.includes(t.software))
      : targets;
    const results = [];
    for (const target of selected) {
      results.push(await probeTarget(target));
    }
    const okCount = results.filter((r) => r.ok).length;
    const refreshedCount = results.reduce((acc, r) => acc + r.refreshedIds.length, 0);
    return {
      ok: okCount > 0 || selected.length === 0,
      ranAt: String(now()),
      totalTargets: selected.length,
      verifiedTargets: okCount,
      failedTargets: selected.length - okCount,
      refreshedEntries: refreshedCount,
      results,
      ttlAudit: findExpiringEntries(),
    };
  }

  function listPendingCandidates() {
    return cortex.listT3Atlas({ includePending: true }).filter((a) => a.status === 'pending_review');
  }

  function approveCandidate(atlasId, {
    verifiedWorkaround,
    goalMilestone = null,
    uiSteps = null,
    rootCause = null,
    approvedBy = 'human_expert',
    ttlDays = 45,
  } = {}) {
    const all = cortex.listT3Atlas({ includePending: true });
    const target = all.find((a) => a.atlasId === String(atlasId));
    if (!target) return { ok: false, error: 'candidate_not_found' };
    if (!String(verifiedWorkaround || '').trim()) {
      return { ok: false, error: 'verified_workaround_required' };
    }
    const updated = cortex.upsertT3Atlas({
      ...target,
      verifiedWorkaround: String(verifiedWorkaround).trim(),
      goalMilestone: goalMilestone || target.goalMilestone,
      rootCause: rootCause || target.rootCause,
      uiSteps: Array.isArray(uiSteps) ? uiSteps : target.uiSteps,
      verifiedAt: String(now()),
      ttlDays,
      verifier: `expert:${approvedBy}`,
      status: 'verified',
    });
    return { ok: true, entry: updated };
  }

  function rejectCandidate(atlasId, { reason = 'rejected_by_reviewer' } = {}) {
    const all = cortex.listT3Atlas({ includePending: true });
    const target = all.find((a) => a.atlasId === String(atlasId));
    if (!target) return { ok: false, error: 'candidate_not_found' };
    const updated = cortex.upsertT3Atlas({
      ...target,
      rootCause: reason,
      status: 'rejected',
    });
    return { ok: true, entry: updated };
  }

  return {
    probeTarget,
    runHarvest,
    findExpiringEntries,
    listPendingCandidates,
    approveCandidate,
    rejectCandidate,
  };
}
