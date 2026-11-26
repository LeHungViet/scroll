// SCROLL 2.13 -- Smoke & 2-Way Verification for Universal Ticket Protocol (`scroll-ticket/v1`)
// and Owner-Presence Group Action Gate (`evaluateGroupOwnerActionGate`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TICKET_SCHEMA,
  SCROLL_TICKET_TOOL_SCHEMAS,
  redactTicketPayload,
  buildTicketIdempotencyKey,
  canTransitionTicket,
  projectTicketForAudience,
  evaluateGroupOwnerActionGate,
  buildTicketGuidancePrompt,
  createFileTicketStore,
  CORE_TOOL_GROUPS,
  BUILTIN_TIER_FLOOR,
} from '../index.js';

test('SCROLL 2.13: canonical ticket tools are registered in scroll-core & permission floors', () => {
  const names = SCROLL_TICKET_TOOL_SCHEMAS.map((t) => t.name);
  assert.deepEqual(names, ['ticket_create', 'ticket_update', 'ticket_list', 'ticket_transition']);
  const core = CORE_TOOL_GROUPS.find((g) => g.id === 'scroll-core');
  assert.ok(core, 'scroll-core group exists');
  for (const n of names) {
    assert.equal(core.match(n), true, `scroll-core matches ${n}`);
    assert.ok(BUILTIN_TIER_FLOOR[n], `BUILTIN_TIER_FLOOR has ${n}`);
  }
  assert.equal(SCROLL_TICKET_TOOL_SCHEMAS.find((t) => t.name === 'ticket_list').annotations.readOnlyHint, true);
  assert.equal(SCROLL_TICKET_TOOL_SCHEMAS.find((t) => t.name === 'ticket_create').annotations.readOnlyHint, false);
});

test('SCROLL 2.13: secret redaction strips passwords, OTPs, JWTs, and bot tokens', () => {
  const dirty = {
    email: 'merchant@example.com',
    password: 'super-secret-password',
    otpCode: '123456',
    note: 'Token Bearer abcdef1234567890 and 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789',
    nested: { apiKey: 'sk_live_12345678901234567890', safe: 'ok' },
  };
  const clean = redactTicketPayload(dirty);
  assert.equal(clean.email, 'merchant@example.com');
  assert.equal(clean.password, '[REDACTED]');
  assert.equal(clean.otpCode, '[REDACTED]');
  assert.equal(clean.nested.apiKey, '[REDACTED]');
  assert.equal(clean.nested.safe, 'ok');
  assert.ok(!clean.note.includes('abcdef1234567890'));
  assert.ok(!clean.note.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
});

test('SCROLL 2.13: deterministic authority gate blocks agent self-approval and human handoff closure', () => {
  const approvalTicket = { id: 't1', kind: 'action_approval', status: 'awaiting_approval', approverRole: 'owner', approvedBy: null };
  assert.equal(canTransitionTicket({ ticket: approvalTicket, nextStatus: 'in_progress', actorRole: 'agent' }).allowed, false);
  assert.equal(canTransitionTicket({ ticket: approvalTicket, nextStatus: 'done', actorRole: 'agent', hasReceipt: true }).allowed, false);
  assert.equal(canTransitionTicket({ ticket: approvalTicket, nextStatus: 'in_progress', actorRole: 'member' }).allowed, false);
  assert.equal(canTransitionTicket({ ticket: approvalTicket, nextStatus: 'in_progress', actorRole: 'owner' }).allowed, true);

  // Post-approval agent completion requires receipt
  const approvedTicket = { ...approvalTicket, status: 'in_progress', approvedBy: 'owner_1' };
  assert.equal(canTransitionTicket({ ticket: approvedTicket, nextStatus: 'done', actorRole: 'agent', hasReceipt: false }).allowed, false);
  assert.equal(canTransitionTicket({ ticket: approvedTicket, nextStatus: 'done', actorRole: 'agent', hasReceipt: true }).allowed, true);

  // Human handoff cannot be closed by agent
  const handoff = { id: 't2', kind: 'handoff', status: 'open', approverRole: 'any_member' };
  assert.equal(canTransitionTicket({ ticket: handoff, nextStatus: 'done', actorRole: 'agent' }).allowed, false);
  assert.equal(canTransitionTicket({ ticket: handoff, nextStatus: 'done', actorRole: 'member' }).allowed, true);
});

test('SCROLL 2.13: evaluateGroupOwnerActionGate enforces owner presence & direct vs approval modes', () => {
  assert.equal(evaluateGroupOwnerActionGate({ isGroup: false, isOwnerSender: true }).decision, 'allow');
  assert.equal(evaluateGroupOwnerActionGate({ isGroup: true, isOwnerSender: false, ownerInRoom: false }).decision, 'deny');
  assert.equal(evaluateGroupOwnerActionGate({ isGroup: true, isOwnerSender: true, ownerInRoom: false }).decision, 'deny');
  assert.equal(evaluateGroupOwnerActionGate({ isGroup: true, isOwnerSender: true, ownerInRoom: true }).decision, 'allow');
  const guestInOwnerGroup = evaluateGroupOwnerActionGate({ isGroup: true, isOwnerSender: false, ownerInRoom: true });
  assert.equal(guestInOwnerGroup.decision, 'require_approval');
  assert.equal(guestInOwnerGroup.suggestedTicketKind, 'action_approval');
  assert.equal(guestInOwnerGroup.approverRole, 'owner');
  assert.match(buildTicketGuidancePrompt({ isGroup: true, ownerInRoom: true, isOwnerSender: false }), /ownerInRoom=true/);
});

test('SCROLL 2.13: file ticket store deduplicates within 24h and isolates group visibility', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-tickets-'));
  const store = createFileTicketStore({ filePath: path.join(dir, 'tickets.jsonl') });
  const r1 = store.create({
    kind: 'action_approval',
    title: 'Provision merchant account',
    summary: 'User requested new workspace account',
    dedupeKey: 'acct:merchant@example.com',
    actionSpec: { tool: 'provision_account', args: { email: 'merchant@example.com', password: 'leak' } },
  }, { agentId: 'ag_1', sourceChannel: 'telegram_group', sourceChatId: '-1001', requesterName: 'Guest' });
  assert.equal(r1.ok, true);
  assert.equal(r1.deduplicated, false);
  assert.equal(r1.ticket.schema, TICKET_SCHEMA);
  assert.equal(r1.ticket.status, 'awaiting_approval');
  assert.equal(r1.ticket.actionSpec.args.password, '[REDACTED]');

  // Duplicate within 24h merges into existing ticket
  const r2 = store.create({
    kind: 'action_approval',
    title: 'Provision merchant account',
    summary: 'Follow-up email confirmed',
    dedupeKey: 'acct:merchant@example.com',
  }, { agentId: 'ag_1', sourceChannel: 'telegram_group', sourceChatId: '-1001' });
  assert.equal(r2.deduplicated, true);
  assert.equal(r2.ticket.id, r1.ticket.id);
  assert.ok(r2.ticket.summary.includes('Follow-up email confirmed'));

  // Group A sees only public fields of its own ticket; Group B sees nothing
  const groupAList = store.list({ audience: { isOwner: false, isGroup: true, chatId: '-1001' } });
  assert.equal(groupAList.length, 1);
  assert.equal(groupAList[0].actionSpec, undefined);
  assert.equal(store.list({ audience: { isOwner: false, isGroup: true, chatId: '-9999' } }).length, 0);

  // Owner DM sees full ticket including actionSpec
  const ownerList = store.list({ audience: { isOwner: true, isGroup: false } });
  assert.equal(ownerList.length, 1);
  assert.equal(ownerList[0].actionSpec.args.email, 'merchant@example.com');

  // Verify idempotency helper determinism
  assert.equal(
    buildTicketIdempotencyKey({ agentId: 'a', sourceChatId: '1', kind: 'handoff', dedupeKey: 'X' }),
    buildTicketIdempotencyKey({ agentId: 'a', sourceChatId: '1', kind: 'handoff', dedupeKey: ' x ' }),
  );
  // Verify audience projection directly
  assert.equal(projectTicketForAudience(r1.ticket, { isOwner: false, isGroup: true, chatId: '-2222' }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
