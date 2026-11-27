// SCROLL 2.19 -- Morning Digest Batching, Candidate-Only Wake Cues, and Cadence/Fairness Telemetry.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDurableJobStore,
  buildMorningDigest,
  matchWakeCueCandidates,
  computeDurableJobMetrics,
} from '../index.js';

test('SCROLL 2.19: Morning Digest batches >24h quiet Marathon jobs per room and respects quietHours', () => {
  const start = Date.parse('2026-11-28T02:00:00Z'); // 09:00 Asia/Ho_Chi_Minh
  let now = start;
  const quietHours = { start: '22:00', end: '07:30', tz: 'Asia/Ho_Chi_Minh' };
  const store = createDurableJobStore({ clock: () => now, quietHours });

  const j1 = store.createJob({
    goal: 'Track portal filing #101',
    principals: { requester: { principalId: 'u1' }, ownerIds: ['u_own'] },
    audienceRoom: { channel: 'telegram', chatId: '-1001', isGroup: true },
    budget: { horizonDays: 10 },
  }).job;
  const c1 = store.claimJob({ jobId: j1.jobId });
  store.parkJob({ jobId: j1.jobId, revision: c1.revision, jobEpoch: c1.jobEpoch, leaseToken: c1.leaseToken, waitingFor: 'external', sleepSec: 3600, checkpoint: { milestone: 'awaiting_agency' } });

  const j2 = store.createJob({
    goal: 'Monitor supplier quote #202',
    principals: { requester: { principalId: 'u2' }, ownerIds: ['u_own'] },
    audienceRoom: { channel: 'telegram', chatId: '-1001', isGroup: true },
    budget: { horizonDays: 7 },
  }).job;
  const c2 = store.claimJob({ jobId: j2.jobId });
  store.openAsk({ jobId: j2.jobId, revision: c2.revision, jobEpoch: c2.jobEpoch, leaseToken: c2.leaseToken, targetRole: 'owner', kind: 'handoff', question: 'Sensitive owner check' });

  // After 2 hours -> too fresh for 24h digest
  assert.equal(buildMorningDigest({ jobs: store.listJobs(), chatId: '-1001', nowMs: start + 2 * 3600_000, quietHours }).shouldSend, false);

  // During overnight quietHours (23:00 VN = 16:00Z next day) -> suppressed
  const nightMs = Date.parse('2026-11-29T16:00:00Z');
  assert.equal(buildMorningDigest({ jobs: store.listJobs(), chatId: '-1001', nowMs: nightMs, quietHours }).reason, 'quiet_hours_active');

  // Next morning at 09:05 VN (+24h05m) -> 1 consolidated digest with neutral owner status
  const morningMs = start + 24 * 3600_000 + 5 * 60_000;
  const digest = buildMorningDigest({ jobs: store.listJobs(), chatId: '-1001', nowMs: morningMs, quietHours });
  assert.equal(digest.shouldSend, true);
  assert.equal(digest.count, 2);
  assert.match(digest.text, /Track portal filing #101/);
  assert.equal(digest.items.find((i) => i.jobId === j2.jobId).waitingFor, 'owner_approval_neutral');
});

test('SCROLL 2.19: Wake Cues act strictly as authorized candidates and block strangers, cross-room, and ambiguity', () => {
  const store = createDurableJobStore();
  const j1 = store.createJob({
    goal: 'Prepare monthly financial workbook',
    principals: { requester: { principalId: 'u_req', externalId: 'tg:55' }, ownerIds: ['u_own'] },
    audienceRoom: { channel: 'telegram', chatId: '-1001', isGroup: true },
  }).job;
  const c1 = store.claimJob({ jobId: j1.jobId });
  const a1 = store.openAsk({
    jobId: j1.jobId,
    revision: c1.revision,
    jobEpoch: c1.jobEpoch,
    leaseToken: c1.leaseToken,
    targetRole: 'requester',
    kind: 'choice',
    question: 'Choose currency format for workbook',
    options: [{ id: 'vnd', label: 'VND' }, { id: 'usd', label: 'USD' }],
  }).ask;

  // Stranger in the same group echoing the exact askId + option -> 0 candidates!
  const strangerRes = matchWakeCueCandidates({
    text: `Use USD for ${a1.askId}`,
    senderId: 'u_stranger',
    chatId: '-1001',
    openAsks: store.listAsks({ status: 'open' }),
    jobs: store.listJobs(),
  });
  assert.equal(strangerRes.candidates.length, 0);
  assert.equal(strangerRes.topCandidate, null);

  // Cross-room message from requester -> 0 candidates!
  const crossRoom = matchWakeCueCandidates({
    text: `Use USD for ${a1.askId}`,
    senderId: 'tg:55',
    chatId: '-9999',
    openAsks: store.listAsks({ status: 'open' }),
    jobs: store.listJobs(),
  });
  assert.equal(crossRoom.candidates.length, 0);

  // Authorized requester referencing askId + option -> clear topCandidate carrying intentRev
  const matched = matchWakeCueCandidates({
    text: `Use USD for ${a1.askId}`,
    senderId: 'tg:55',
    chatId: '-1001',
    openAsks: store.listAsks({ status: 'open' }),
    jobs: store.listJobs(),
  });
  assert.equal(matched.ambiguous, false);
  assert.equal(matched.topCandidate.askId, a1.askId);
  assert.equal(matched.topCandidate.intentRev, 1);

  // Ambiguity guard: second open ask for same requester in same room with overlapping option -> ambiguous=true, topCandidate=null
  const j2 = store.createJob({
    goal: 'Prepare supplier budget workbook',
    principals: { requester: { principalId: 'u_req', externalId: 'tg:55' }, ownerIds: ['u_own'] },
    audienceRoom: { channel: 'telegram', chatId: '-1001', isGroup: true },
  }).job;
  const c2 = store.claimJob({ jobId: j2.jobId });
  store.openAsk({
    jobId: j2.jobId,
    revision: c2.revision,
    jobEpoch: c2.jobEpoch,
    leaseToken: c2.leaseToken,
    targetRole: 'requester',
    kind: 'choice',
    question: 'Choose currency format for supplier workbook',
    options: [{ id: 'vnd', label: 'VND' }, { id: 'usd', label: 'USD' }],
  });

  const amb = matchWakeCueCandidates({
    text: 'Choose USD currency format',
    senderId: 'tg:55',
    chatId: '-1001',
    openAsks: store.listAsks({ status: 'open' }),
    jobs: store.listJobs(),
  });
  assert.equal(amb.candidates.length, 2);
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.topCandidate, null);

  // Telemetry snapshot aggregates probes, outbox, and fairness metrics cleanly
  const metrics = computeDurableJobMetrics({
    jobs: store.listJobs(),
    outbox: store.listOutbox(),
    fairShareStats: { oldestEligibleAgeMs: 4200 },
  });
  assert.equal(metrics.totalJobs, 2);
  assert.equal(metrics.oldestEligibleAgeMs, 4200);
  assert.ok(metrics.outboxPendingCount >= 2);
});
