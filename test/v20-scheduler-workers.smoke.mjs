// SCROLL 2.0 smoke + mutation test -- §49 Scheduler, §50 Async Workers, Hybrid Memory Search.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCron, matchesCron, createScheduler, canManageJob } from '../lib/scheduler.js';
import { createWorkerPool } from '../lib/chat-session.js';
import { openStore } from '../lib/memory.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v20-sched-'));
let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    console.log('  \x1b[32m✔\x1b[0m', name);
    pass++;
  } catch (e) {
    console.log('  \x1b[31m✖\x1b[0m', name, '--', e.message);
    fail++;
  }
}

console.log('SCROLL 2.0 -- §49 Scheduler, §50 Workers & Hybrid Memory');

await t('IANA timezone cron matches exact Asia/Ho_Chi_Minh wall clock (09:00 ICT == 02:00 UTC)', () => {
  const parsed = parseCron('0 9 * * 1-5'); // 09:00 Mon-Fri
  // 2026-11-23 is Monday; 02:00 UTC == 09:00 Asia/Ho_Chi_Minh
  assert.equal(matchesCron(parsed, Date.parse('2026-11-23T02:00:00Z'), 'Asia/Ho_Chi_Minh'), true);
  assert.equal(matchesCron(parsed, Date.parse('2026-11-23T09:00:00Z'), 'Asia/Ho_Chi_Minh'), false);
  // Sunday 2026-11-22 02:00 UTC == Sunday 09:00 ICT -> should NOT match Mon-Fri
  assert.equal(matchesCron(parsed, Date.parse('2026-11-22T02:00:00Z'), 'Asia/Ho_Chi_Minh'), false);
});

await t('Scheduler triggers once per minute, respects kill-switch, daily budget cap, retry backoff, and owner DM authority', async () => {
  let now = Date.parse('2026-11-23T02:00:00Z'); // Mon 09:00 ICT
  const cronFile = path.join(tmp, 'cron.json');
  const sched = createScheduler({
    filePath: cronFile,
    defaultTz: 'Asia/Ho_Chi_Minh',
    clock: () => now,
    baseRetryMs: 10_000,
  });

  const grpJob = sched.addJob({
    id: 'morning-standup',
    name: 'Group Standup',
    cron: '0 9 * * 1-5',
    tz: 'Asia/Ho_Chi_Minh',
    targetChatId: '-100555666',
    prompt: 'Daily standup summary',
    maxDailyRuns: 2,
  });

  // Owner in DM CAN manage group cron; external user CANNOT
  assert.equal(canManageJob({ isInternal: true, roles: ['owner'], isDm: true }, grpJob), true);
  assert.equal(canManageJob({ isInternal: false, roles: [], isDm: true }, grpJob), false);

  // First tick triggers at 09:00 ICT
  let fires = 0;
  const r1 = await sched.tick({ handler: async () => { fires++; return 'sent'; } });
  assert.equal(r1.triggered.length, 1);
  assert.equal(r1.triggered[0].ok, true);
  assert.equal(fires, 1);

  // Second tick in the same minute does NOT double-fire
  const r2 = await sched.tick({ handler: async () => { fires++; } });
  assert.equal(r2.triggered.length, 0);

  // Retry backoff on transient failure (interval job)
  sched.addJob({ id: 'flaky', name: 'Flaky Check', everyMs: 5000, maxDailyRuns: 2, maxRetries: 2 });
  let attempts = 0;
  const rFail = await sched.tick({
    handler: async (job) => {
      if (job.id !== 'flaky') return;
      attempts++;
      if (attempts === 1) throw new Error('HTTP 429 rate limited');
      return 'recovered';
    },
  });
  assert.equal(rFail.triggered[0].ok, false);
  assert.ok(rFail.triggered[0].retryAt);

  // Before backoff expires -> skipped
  now += 5000;
  const rEarly = await sched.tick({ handler: async () => { attempts++; } });
  assert.equal(rEarly.triggered.length, 0);
  assert.ok(rEarly.skipped.some((s) => s.jobId === 'flaky' && s.reason === 'retry_backoff'));

  // After backoff expires -> retries & recovers, hitting daily cap (2 runs)
  now += 10_000;
  const rRec = await sched.tick({ handler: async () => { attempts++; return 'recovered'; } });
  assert.equal(rRec.triggered[0].ok, true);
  assert.equal(attempts, 2);

  // Exceeding daily budget cap -> blocked!
  now += 60_000;
  const rCap = await sched.tick({ handler: async () => { attempts++; } });
  assert.ok(rCap.skipped.some((s) => s.jobId === 'flaky' && s.reason === 'daily_budget_cap'));

  // Global kill-switch pauses everything
  sched.setPaused(true);
  const rPaused = await sched.tick({ handler: async () => { throw new Error('must not run'); } });
  assert.equal(rPaused.paused, true);
  assert.equal(rPaused.triggered.length, 0);
});

await t('§50 Async Background WorkerPool limits concurrency, supports cancellation, and fires onComplete', async () => {
  let maxObserved = 0;
  let running = 0;
  const completed = [];
  const pool = createWorkerPool({ maxConcurrent: 2, onComplete: (j) => completed.push(j.id) });

  const makeTask = (ms, val) => async ({ signal }) => {
    running++;
    if (running > maxObserved) maxObserved = running;
    await new Promise((resolve, reject) => {
      const tm = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(tm); reject(new Error('aborted')); }, { once: true });
    });
    running--;
    return val;
  };

  const j1 = pool.submit({ label: 'w1', chatId: 'c1', fn: makeTask(30, 'res1') });
  const j2 = pool.submit({ label: 'w2', chatId: 'c1', fn: makeTask(30, 'res2') });
  const j3 = pool.submit({ label: 'w3', chatId: 'c1', fn: makeTask(30, 'res3') });
  const j4 = pool.submit({ label: 'w4', chatId: 'c1', fn: makeTask(30, 'res4') });

  // Cancel queued j4 before it starts
  const cRes = pool.cancel(j4.id);
  assert.equal(cRes.ok, true);

  const [r1, r2, r3, r4] = await Promise.all([
    pool.waitFor(j1.id),
    pool.waitFor(j2.id),
    pool.waitFor(j3.id),
    pool.waitFor(j4.id),
  ]);
  assert.equal(maxObserved, 2);
  assert.equal(r1.status, 'completed');
  assert.equal(r1.output, 'res1');
  assert.equal(r2.output, 'res2');
  assert.equal(r3.output, 'res3');
  assert.equal(r4.status, 'cancelled');
  assert.equal(completed.length, 3);
  pool.close();
});

await t('Hybrid memory search combines semantic embeddings with lexical scan + consolidateDigest', async () => {
  const store = openStore({ root: path.join(tmp, 'mem-store') });
  const sid = store.createSubject({ kind: 'person', label: 'Sam' });
  const sess = store.openSession(sid, { surface: 'chat' });
  const t1 = store.appendTurn(sid, sess, { role: 'user', speaker: sid, text: 'I prefer oolong tea in the morning' });
  const t2 = store.appendTurn(sid, sess, { role: 'user', speaker: sid, text: 'My workspace laptop is a Linux workstation' });
  store.remember(sid, { key: 'pref.drink', value: 'oolong tea', quote: 'oolong tea', ref: t1.ref });
  store.remember(sid, { key: 'device.laptop', value: 'Linux workstation', quote: 'Linux workstation', ref: t2.ref });

  // Simple deterministic embedding mapping beverage synonyms to dimension 0, computers to dimension 1
  const embed = async (txt) => {
    const s = String(txt).toLowerCase();
    const bev = /tea|drink|beverage|oolong|coffee/.test(s) ? 1 : 0;
    const comp = /laptop|linux|workstation|computer/.test(s) ? 1 : 0;
    return [bev, comp, 0.01];
  };

  // Query "morning beverage" has zero lexical overlap with "oolong tea", yet hybrid search finds it!
  const res = await store.searchHybrid(sid, { query: 'morning beverage', scope: 'facts', embed });
  assert.equal(res.engine, 'hybrid');
  assert.ok(res.hits.length >= 1);
  assert.match(res.hits[0].text, /oolong tea/);

  const digest = store.consolidateDigest(sid);
  assert.equal(digest.factCount, 2);
  assert.match(digest.text, /pref\.drink: oolong tea/);
});

await t('Mutation self-test: flipping timezone from Asia/Ho_Chi_Minh to UTC breaks 09:00 ICT cron match', () => {
  const parsed = parseCron('0 9 * * 1-5');
  const instant = Date.parse('2026-11-23T02:00:00Z');
  assert.equal(matchesCron(parsed, instant, 'Asia/Ho_Chi_Minh'), true);
  assert.equal(matchesCron(parsed, instant, 'UTC'), false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '\x1b[32m✔ all green\x1b[0m' : '\x1b[31m✖ failures\x1b[0m'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
