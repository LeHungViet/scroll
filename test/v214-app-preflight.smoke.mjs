import assert from 'node:assert/strict';
import {
  APP_HEALTH_SCHEMA,
  ATLAS_SYNC_DIFF_SCHEMA,
  isSafePublicHealthUrl,
  collectAppHealthTargets,
  probeHttpEndpoints,
  formatAppHealthAlert,
  diffAppAtlasSync,
  buildMorningPreflightPrompt,
} from '../index.js';

// 1. SSRF URL guard
for (const bad of [
  '',
  'not-a-url',
  'http://example.com',
  'file:///etc/passwd',
  'https://localhost/health',
  'https://127.0.0.1/status',
  'https://10.0.0.1/',
  'https://172.16.0.1/',
  'https://192.168.1.5/',
  'https://169.254.169.254/latest/meta-data/',
  'https://[::1]/',
  'https://[fe80::1]/',
  'https://[fc00::1]/',
  'https://[::ffff:127.0.0.1]/',
  'https://user:pass@app.example.com/',
  'https://internal-host/',
  'https://service.local/',
  'https://metadata.google.internal/',
]) {
  const res = isSafePublicHealthUrl(bad);
  assert.equal(res.safe, false, `Expected SSRF block for ${bad}`);
}

assert.equal(isSafePublicHealthUrl('https://app.example.com').safe, true);
assert.equal(isSafePublicHealthUrl('https://sub.example.io/auth').safe, true);
assert.equal(isSafePublicHealthUrl('http://127.0.0.1:9999/health', { allowInsecure: true }).safe, true);

// 2. Target collection & deduplication
const targets = collectAppHealthTargets({
  appProfile: {
    apps: [
      { id: 'shop', name: 'Shop Web', publicUrl: 'https://shop.example.com/' },
      { id: 'admin', name: 'Admin Web', publicUrl: 'https://admin.example.com' },
    ],
    healthUrls: ['https://sso.example.com', 'https://shop.example.com'],
  },
  atlas: {
    apps: {
      shop: { name: 'Shop Web', publicUrl: 'https://shop.example.com' },
      mobile: { name: 'Mobile App', publicUrl: 'https://m.example.com' },
    },
  },
});
assert.equal(targets.length, 4, 'Should deduplicate shop.example.com across profile, healthUrls, and atlas');
assert.deepEqual(targets.map(t => t.id), ['shop', 'admin', 'mobile', 'extra-1']);

// 3. Concurrent HTTP probe (healthy + down + timeout + SSRF blocked)
const mockFetch = async (url) => {
  if (url.includes('shop.example.com')) return { status: 200, url };
  if (url.includes('admin.example.com')) return { status: 503, url };
  if (url.includes('slow.example.com')) {
    const err = new Error('TIMEOUT');
    err.name = 'AbortError';
    throw err;
  }
  return { status: 302, url: `${url}/login` };
};

const mixedReport = await probeHttpEndpoints(
  [
    { id: 'shop', name: 'Shop', url: 'https://shop.example.com' },
    { id: 'admin', name: 'Admin', url: 'https://admin.example.com' },
    { id: 'slow', name: 'Slow', url: 'https://slow.example.com' },
    { id: 'evil', name: 'Evil', url: 'https://169.254.169.254/latest/meta-data/' },
  ],
  { fetchImpl: mockFetch, timeoutMs: 2000 },
);
assert.equal(mixedReport.schema, APP_HEALTH_SCHEMA);
assert.equal(mixedReport.ok, false);
assert.equal(mixedReport.total, 4);
assert.equal(mixedReport.upCount, 1);
assert.equal(mixedReport.downCount, 3);
assert.equal(mixedReport.results[0].ok, true);
assert.equal(mixedReport.results[1].error, 'HTTP_503');
assert.ok(mixedReport.results[2].error.startsWith('TIMEOUT_'));
assert.equal(mixedReport.results[3].blocked, true);

const alertText = formatAppHealthAlert(mixedReport, { brandName: 'Acme' });
assert.ok(alertText.includes('Acme'));
assert.ok(alertText.includes('HTTP_503'));

const okReport = await probeHttpEndpoints(
  [{ id: 'shop', name: 'Shop', url: 'https://shop.example.com' }],
  { fetchImpl: mockFetch },
);
assert.equal(okReport.ok, true);
assert.equal(formatAppHealthAlert(okReport, { brandName: 'Acme' }), '', 'Healthy report must stay silent');

// 4. Atlas sync diff calculation
const prevAtlas = {
  schema: 'scroll-app-atlas/v1',
  atlasHash: 'aaa111',
  apps: {
    shop: {
      name: 'Shop',
      sourceSha: '111111111111',
      stats: { screenCount: 10, rpcCount: 20, rlsPolicyCount: 5, i18nCount: 100 },
      recentCommits: [
        { sha: '111111111111', date: '2026-11-26', subject: 'old commit' },
      ],
    },
    admin: {
      name: 'Admin',
      sourceSha: '222222222222',
      stats: { screenCount: 8, rpcCount: 12, rlsPolicyCount: 4, i18nCount: 80 },
      recentCommits: [{ sha: '222222222222', date: '2026-11-26', subject: 'same' }],
    },
  },
};
const nextAtlas = {
  schema: 'scroll-app-atlas/v1',
  atlasHash: 'bbb222',
  compiledAt: '2026-11-27T05:55:00.000Z',
  apps: {
    shop: {
      name: 'Shop',
      sourceSha: '333333333333',
      stats: { screenCount: 11, rpcCount: 22, rlsPolicyCount: 5, i18nCount: 105 },
      recentCommits: [
        { sha: '333333333333', date: '2026-11-27', subject: 'feat: new checkout flow' },
        { sha: '222222222221', date: '2026-11-27', subject: 'fix: coupon label' },
        { sha: '111111111111', date: '2026-11-26', subject: 'old commit' },
      ],
    },
    admin: {
      name: 'Admin',
      sourceSha: '222222222222',
      stats: { screenCount: 8, rpcCount: 12, rlsPolicyCount: 4, i18nCount: 80 },
      recentCommits: [{ sha: '222222222222', date: '2026-11-26', subject: 'same' }],
    },
  },
};
const syncDiff = diffAppAtlasSync(prevAtlas, nextAtlas);
assert.equal(syncDiff.schema, ATLAS_SYNC_DIFF_SCHEMA);
assert.equal(syncDiff.hasChanges, true);
assert.equal(syncDiff.changedCount, 1);
assert.deepEqual(syncDiff.unchangedApps, ['admin']);
assert.equal(syncDiff.diff.shop.newCommitCount, 2);
assert.equal(syncDiff.diff.shop.newCommits[0].subject, 'feat: new checkout flow');
assert.equal(syncDiff.diff.shop.screensDelta, 1);

// 5. Preflight prompt helper
const promptVi = buildMorningPreflightPrompt({ brandName: 'Acme', staleHoursThreshold: 30, lang: 'vi' });
assert.ok(promptVi.includes('app_freshness_status'));
assert.ok(promptVi.includes('NO_REPLY'));
assert.ok(promptVi.includes('ticket_list'));

console.log('v214-app-preflight.smoke.mjs: ALL PASSED');
