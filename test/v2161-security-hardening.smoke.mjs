// SCROLL 2.16.1 -- Security Hardening Smoke & 2-Way Verification
// Covers all 4 P0/P1 prerequisites:
//   1. ticket_update room/agent/status binding, forbidden `_*` keys, immutable `specHash`
//   2. ticket_transition bound to `approvedTicketId` & `approvedSpecHash` integrity
//   3. Immutable token-bound fail-closed Turn Context Registry (concurrent group + background isolation)
//   4. Explicit exit gate (no auto-close on bare end_turn) & activeElapsedMs budget accounting
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computeTicketSpecHash,
  findForbiddenInternalKeys,
  validateTicketUpdate,
  validateTicketTransitionScope,
  evaluateTicketTurnExit,
  evaluateTicketContinuationBudget,
  createFileTicketStore,
  createTurnContextRegistry,
  computeTurnTokenTtlMs,
  clampBackgroundSliceMs,
  DEFAULT_TURN_TIMEOUT_MS,
  BACKGROUND_SLICE_MAX_MS,
} from '../index.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v2161-'));
  return { dir, store: createFileTicketStore({ filePath: path.join(dir, 'tickets.jsonl') }) };
}

test('SCROLL 2.16.1: ticket_update blocks internal _* keys, cross-room/agent edits, and post-card actionSpec tampering', () => {
  const { dir, store } = tmpStore();
  try {
    const created = store.create({
      kind: 'action_approval',
      title: 'Export weekly report',
      actionSpec: { tool: 'browser_export', args: { scope: 'week-48' } },
      approvalCardSent: true,
    }, { agentId: 'ag_1', sourceChannel: 'telegram_group', sourceChatId: '-1001' });

    assert.equal(created.ok, true);
    assert.ok(created.ticket.specHash?.startsWith('sha256:'));

    // 1. Forbidden _execution override in payloadPatch -> BLOCKED
    const badMeta = store.update(created.ticket.id, {
      payloadPatch: { note: 'ok', _execution: { maxExecutionMs: 999_999_999 } },
    }, { agentId: 'ag_1', sourceChatId: '-1001', isGroup: true, isOwner: false });
    assert.equal(badMeta.ok, false);
    assert.equal(badMeta.code, 'FORBIDDEN_INTERNAL_KEY');
    assert.deepEqual(findForbiddenInternalKeys({ a: { _nested: 1 } }), ['a._nested']);

    // 2. Cross-room non-owner update -> BLOCKED
    const crossRoom = store.update(created.ticket.id, {
      note: 'Injected from another group',
    }, { agentId: 'ag_1', sourceChatId: '-9999', isGroup: true, isOwner: false });
    assert.equal(crossRoom.ok, false);
    assert.equal(crossRoom.code, 'TICKET_ROOM_MISMATCH');

    // 3. Cross-agent update -> BLOCKED
    const crossAgent = store.update(created.ticket.id, {
      note: 'Hijack from agent 2',
    }, { agentId: 'ag_2', sourceChatId: '-1001', isGroup: true, isOwner: false });
    assert.equal(crossAgent.ok, false);
    assert.equal(crossAgent.code, 'TICKET_AGENT_MISMATCH');

    // 4. Non-owner mutating actionSpec after approval card sent -> BLOCKED
    const tamperSpec = store.update(created.ticket.id, {
      actionSpec: { tool: 'wire_transfer', args: { amount: 9999 } },
    }, { agentId: 'ag_1', sourceChatId: '-1001', isGroup: true, isOwner: false, actorRole: 'agent' });
    assert.equal(tamperSpec.ok, false);
    assert.equal(tamperSpec.code, 'ACTION_SPEC_LOCKED_PENDING_APPROVAL');

    // 5. Same-room benign note update succeeds
    const validUpdate = store.update(created.ticket.id, {
      note: 'Requester confirmed format: xlsx',
      payloadPatch: { format: 'xlsx' },
    }, { agentId: 'ag_1', sourceChatId: '-1001', isGroup: true, isOwner: false });
    assert.equal(validUpdate.ok, true);
    assert.equal(validUpdate.ticket.payload.format, 'xlsx');

    // 6. Owner approves -> freezes approvedSpecHash; even owner cannot mutate actionSpec post-approval
    const approved = store.transition(created.ticket.id, { status: 'in_progress', actorRole: 'owner', actorId: 'owner_1' });
    assert.equal(approved.ok, true);
    assert.equal(approved.ticket.approvedSpecHash, created.ticket.specHash);

    const postApproveMut = validateTicketUpdate({
      ticket: approved.ticket,
      patch: { actionSpec: { tool: 'browser_export', args: { scope: 'all' } } },
      ctx: { agentId: 'ag_1', sourceChatId: '-1001', isOwner: true, isGroup: false },
    });
    assert.equal(postApproveMut.allowed, false);
    assert.equal(postApproveMut.code, 'ACTION_SPEC_LOCKED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCROLL 2.16.1: ticket_transition binds to approvedTicketId, agentId, and specHash integrity', () => {
  const { dir, store } = tmpStore();
  try {
    const tA = store.create({ kind: 'action_approval', title: 'Task A', actionSpec: { tool: 'a', args: {} } }, { agentId: 'ag_1', sourceChatId: '-1' }).ticket;
    const tB = store.create({ kind: 'action_approval', title: 'Task B', actionSpec: { tool: 'b', args: {} } }, { agentId: 'ag_1', sourceChatId: '-2' }).ticket;
    store.transition(tA.id, { status: 'in_progress', actorRole: 'owner', actorId: 'owner_1' });
    store.transition(tB.id, { status: 'in_progress', actorRole: 'owner', actorId: 'owner_1' });

    // Agent bound to tA tries to transition tB -> BLOCKED
    const crossTicket = store.transition(tB.id, {
      status: 'in_progress',
      actorRole: 'agent',
      agentId: 'ag_1',
      approvedTicketId: tA.id,
    });
    assert.equal(crossTicket.ok, false);
    assert.equal(crossTicket.code, 'TICKET_SCOPE_MISMATCH');

    // Tampered actionSpec vs frozen approvedSpecHash -> BLOCKED
    const tampered = {
      ...store.find(tA.id),
      actionSpec: { tool: 'evil_tool', args: {} },
    };
    const integrity = validateTicketTransitionScope({
      ticket: tampered,
      actorRole: 'agent',
      agentId: 'ag_1',
      approvedTicketId: tA.id,
    });
    assert.equal(integrity.allowed, false);
    assert.equal(integrity.code, 'SPEC_HASH_MISMATCH');
    assert.notEqual(computeTicketSpecHash(tampered.actionSpec), tampered.approvedSpecHash);

    // Atomic executionOwner claim prevents dual legacy+durable runs
    const claimed = store.assignExecutionOwner(tA.id, { executionOwner: 'durable', durableJobId: 'job_1' });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.idempotent, false);
    const sameAgain = store.assignExecutionOwner(tA.id, { executionOwner: 'durable', durableJobId: 'job_1' });
    assert.equal(sameAgain.ok, true);
    assert.equal(sameAgain.idempotent, true);
    const conflict = store.assignExecutionOwner(tA.id, { executionOwner: 'durable', durableJobId: 'job_2' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'EXECUTION_OWNER_CONFLICT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SCROLL 2.16.1: token-bound TurnContextRegistry isolates overlapping turns and fails closed', async () => {
  let now = 1_800_000_000_000;
  const reg = createTurnContextRegistry({ clock: () => now });

  // Missing or unknown token NEVER falls back to Owner DM
  assert.equal(reg.resolve(null).ok, false);
  assert.equal(reg.resolve('tt_nonexistent').ok, false);
  assert.throws(() => reg.requireContext('tt_nonexistent'), /ERR_TURN_CONTEXT_UNKNOWN/);

  // TTL automatically exceeds turnTimeoutMs (480s -> 540s)
  assert.ok(computeTurnTokenTtlMs({ turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS }) > DEFAULT_TURN_TIMEOUT_MS);
  assert.equal(clampBackgroundSliceMs(900_000), BACKGROUND_SLICE_MAX_MS);

  // Overlapping group turn & background slice maintain isolated immutable contexts
  const seen = [];
  await Promise.all([
    reg.runWithContext({ agentId: 'ag_1', surface: 'telegram', chatId: '-1001', isGroup: true, isOwner: false, senderId: 'u_guest' }, async ({ token, context }) => {
      assert.equal(Object.isFrozen(context), true);
      await new Promise((r) => setTimeout(r, 15));
      const cur = reg.current();
      assert.equal(cur.ok, true);
      assert.equal(cur.context.isGroup, true);
      assert.equal(cur.context.isOwner, false);
      assert.equal(reg.resolve(token).context.senderId, 'u_guest');
      seen.push('group');
    }),
    reg.runWithContext({ agentId: 'ag_1', surface: 'web', chatId: 'dm_owner', isGroup: false, isOwner: true, isBackgroundSlice: true, jobId: 'job_99' }, async ({ token }) => {
      await new Promise((r) => setTimeout(r, 5));
      const cur = reg.current();
      assert.equal(cur.ok, true);
      assert.equal(cur.context.isGroup, false);
      assert.equal(cur.context.jobId, 'job_99');
      assert.equal(reg.resolve(token).context.isOwner, true);
      seen.push('bg');
    }),
  ]);
  assert.deepEqual(seen.sort(), ['bg', 'group']);

  // Expiration fails closed
  const { token } = reg.issue({ agentId: 'ag_1', isOwner: true, turnTimeoutMs: 60_000 });
  assert.equal(reg.resolve(token).ok, true);
  now += 200_000;
  assert.equal(reg.resolve(token).code, 'ERR_TURN_CONTEXT_EXPIRED');
});

test('SCROLL 2.16.1: explicit exit gate blocks auto-close and activeElapsedMs decouples sleep from compute', () => {
  // Bare end_turn must NOT auto-close; returns implicit_yield then escalates after cap
  const bare1 = evaluateTicketTurnExit({ explicitDone: false, hasCheckpoint: false, implicitYieldCount: 0 });
  assert.equal(bare1.action, 'implicit_yield');
  assert.equal(bare1.allowAutoClose, false);
  const bare3 = evaluateTicketTurnExit({ explicitDone: false, hasCheckpoint: false, implicitYieldCount: 2, maxImplicitYields: 2 });
  assert.equal(bare3.action, 'escalate_owner');
  assert.equal(bare3.code, 'EXPLICIT_EXIT_CONTRACT_BREACH');

  // Explicit done without receipt triggers recover, not complete
  assert.equal(evaluateTicketTurnExit({ explicitDone: true, hasVerifiedReceipt: false }).action, 'recover');
  assert.equal(evaluateTicketTurnExit({ explicitDone: true, hasVerifiedReceipt: true }).action, 'complete');

  // 90-minute Sprint job with only 12 minutes of active compute stays within 45m active budget
  const now = 1_800_000_000_000;
  const sprintOk = evaluateTicketContinuationBudget({
    execution: { continuationsUsed: 5, maxContinuations: 12, startedAt: now - 90 * 60_000, activeElapsedMs: 12 * 60_000, consecutiveErrors: 0 },
    nowMs: now,
  });
  assert.equal(sprintOk.allowed, true);
  const sprintOver = evaluateTicketContinuationBudget({
    execution: { continuationsUsed: 5, maxContinuations: 12, startedAt: now - 90 * 60_000, activeElapsedMs: 46 * 60_000, consecutiveErrors: 0 },
    nowMs: now,
  });
  assert.equal(sprintOver.allowed, false);
  assert.equal(sprintOver.code, 'MAX_EXECUTION_TIME_REACHED');
});
