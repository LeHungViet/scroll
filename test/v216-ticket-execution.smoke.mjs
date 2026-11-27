// SCROLL 2.16 -- Smoke & 2-Way Verification for Post-Approval Ticket Execution
// (`resolveTicketApprovalPlan`, `parseTicketChannelTarget`, `normalizeTicketCheckpoint`,
//  `evaluateTicketContinuationBudget`, `buildTicketApprovalTurnPrompt`, and execution tools).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TICKET_EXECUTION_MODES,
  TICKET_DEFAULT_MAX_CONTINUATIONS,
  TICKET_MIN_RECHECK_SEC,
  TICKET_MAX_RECHECK_SEC,
  TICKET_WAIT_MAX_SEC,
  SCROLL_TICKET_TOOL_SCHEMAS,
  SCROLL_TICKET_EXECUTION_TOOL_SCHEMAS,
  BUILTIN_TIER_FLOOR,
  CORE_TOOL_GROUPS,
  canTransitionTicket,
  parseTicketChannelTarget,
  resolveTicketApprovalPlan,
  normalizeTicketCheckpoint,
  evaluateTicketContinuationBudget,
  buildTicketApprovalTurnPrompt,
} from '../index.js';

test('SCROLL 2.16: execution schemas & permission floors stay backward-compatible and registered', () => {
  assert.deepEqual(TICKET_EXECUTION_MODES, ['mcp_tool', 'agent_turn', 'manual']);
  // Legacy 4-tool list preserved verbatim
  assert.deepEqual(SCROLL_TICKET_TOOL_SCHEMAS.map((t) => t.name), [
    'ticket_create', 'ticket_update', 'ticket_list', 'ticket_transition',
  ]);
  const transitionSchema = SCROLL_TICKET_TOOL_SCHEMAS.find((t) => t.name === 'ticket_transition');
  assert.ok(transitionSchema.inputSchema.properties.checkpoint, 'ticket_transition exposes checkpoint');

  // Execution helper tools live in scroll-core & have explicit tier floors
  const execNames = SCROLL_TICKET_EXECUTION_TOOL_SCHEMAS.map((t) => t.name);
  assert.deepEqual(execNames, ['ticket_reply_room', 'ticket_wait']);
  const core = CORE_TOOL_GROUPS.find((g) => g.id === 'scroll-core');
  for (const name of execNames) {
    assert.equal(core.match(name), true, `scroll-core must match ${name}`);
    assert.ok(BUILTIN_TIER_FLOOR[name], `BUILTIN_TIER_FLOOR must declare ${name}`);
  }
});

test('SCROLL 2.16: parseTicketChannelTarget parses any surface generically without hardcoding', () => {
  assert.deepEqual(parseTicketChannelTarget('telegram_group', '-5019061209'), {
    sourceChannel: 'telegram_group',
    surface: 'telegram',
    isGroup: true,
    chatId: '-5019061209',
    conversationId: 'telegram:-5019061209',
  });
  assert.deepEqual(parseTicketChannelTarget('telegram_dm', '12345'), {
    sourceChannel: 'telegram_dm',
    surface: 'telegram',
    isGroup: false,
    chatId: '12345',
    conversationId: 'telegram:12345',
  });
  assert.deepEqual(parseTicketChannelTarget('slack_group', 'C998877'), {
    sourceChannel: 'slack_group',
    surface: 'slack',
    isGroup: true,
    chatId: 'C998877',
    conversationId: 'slack:C998877',
  });
  assert.deepEqual(parseTicketChannelTarget('web', null), {
    sourceChannel: 'web',
    surface: 'web',
    isGroup: false,
    chatId: null,
    conversationId: null,
  });
});

test('SCROLL 2.16: resolveTicketApprovalPlan routes mcp_tool, agent_turn, and manual deterministically', () => {
  const mcpPlan = resolveTicketApprovalPlan({
    kind: 'action_approval',
    agentId: 'ag_1',
    sourceChannel: 'telegram_group',
    sourceChatId: '-1001',
    actionSpec: { tool: 'demo_provision', args: { email: 'a@example.com' } },
  }, { hasAgentRuntime: true });
  assert.equal(mcpPlan.mode, 'mcp_tool');
  assert.equal(mcpPlan.nextStatus, 'in_progress');
  assert.equal(mcpPlan.executeMcpTool, true);
  assert.equal(mcpPlan.wakeAgent, false);

  const agentPlan = resolveTicketApprovalPlan({
    kind: 'action_approval',
    agentId: 'ag_1',
    sourceChannel: 'telegram_group',
    sourceChatId: '-1001',
    actionSpec: null,
  }, { hasAgentRuntime: true });
  assert.equal(agentPlan.mode, 'agent_turn');
  assert.equal(agentPlan.nextStatus, 'in_progress');
  assert.equal(agentPlan.wakeAgent, true);
  assert.equal(agentPlan.sendStaticApprovalNotice, false);
  assert.equal(agentPlan.maxContinuations, TICKET_DEFAULT_MAX_CONTINUATIONS);
  assert.equal(agentPlan.target.surface, 'telegram');
  assert.equal(agentPlan.target.isGroup, true);

  const manualNoAgent = resolveTicketApprovalPlan({
    kind: 'action_approval',
    agentId: null,
    actionSpec: null,
  }, { hasAgentRuntime: true });
  assert.equal(manualNoAgent.mode, 'manual');
  assert.equal(manualNoAgent.nextStatus, 'done');
  assert.equal(manualNoAgent.wakeAgent, false);

  const explicitManual = resolveTicketApprovalPlan({
    kind: 'action_approval',
    agentId: 'ag_1',
    actionSpec: { mode: 'manual' },
  }, { hasAgentRuntime: true });
  assert.equal(explicitManual.mode, 'manual');
  assert.equal(explicitManual.nextStatus, 'done');
});

test('SCROLL 2.16: canTransitionTicket allows agent checkpointing & system verified receipt while blocking self-approval', () => {
  const unapproved = { id: 't1', kind: 'action_approval', status: 'awaiting_approval', approverRole: 'owner', approvedBy: null };
  assert.equal(canTransitionTicket({ ticket: unapproved, nextStatus: 'in_progress', actorRole: 'agent' }).allowed, false);
  assert.equal(canTransitionTicket({ ticket: unapproved, nextStatus: 'in_progress', actorRole: 'system' }).allowed, false);
  assert.equal(canTransitionTicket({ ticket: unapproved, nextStatus: 'done', actorRole: 'system', hasReceipt: true }).allowed, false);

  const inProgApproved = { id: 't1', kind: 'action_approval', status: 'in_progress', approverRole: 'owner', approvedBy: 'owner:us_1' };
  const cpRes = canTransitionTicket({ ticket: inProgApproved, nextStatus: 'in_progress', actorRole: 'agent' });
  assert.equal(cpRes.allowed, true);
  assert.equal(cpRes.via, 'agent_checkpoint');

  // System can close approved in_progress ONLY with receipt
  assert.equal(canTransitionTicket({ ticket: inProgApproved, nextStatus: 'done', actorRole: 'system', hasReceipt: false }).allowed, false);
  const sysClose = canTransitionTicket({ ticket: inProgApproved, nextStatus: 'done', actorRole: 'system', hasReceipt: true });
  assert.equal(sysClose.allowed, true);
  assert.equal(sysClose.via, 'system_post_approval_receipt');

  // Unapproved in_progress action_approval cannot be checkpointed by agent
  const sneaky = { id: 't2', kind: 'action_approval', status: 'in_progress', approverRole: 'owner', approvedBy: null };
  assert.equal(canTransitionTicket({ ticket: sneaky, nextStatus: 'in_progress', actorRole: 'agent' }).allowed, false);
});

test('SCROLL 2.16: checkpoint normalization clamps bounds, redacts secrets & enforces continuation budget', () => {
  const now = 1_800_000_000_000;
  const cp = normalizeTicketCheckpoint({
    step: 'waiting_slides_export',
    progressSummary: 'Uploaded deck with token Bearer supersecret123456',
    nextAction: 'Check browser tab 42 and download PPTX',
    recheckAfterSec: 3, // below min -> clamped
    state: { tabId: 42, apiKey: 'sk_live_secret_value_12345' },
  }, now);
  assert.equal(cp.recheckAfterSec, TICKET_MIN_RECHECK_SEC);
  assert.equal(cp.nextRecheckAt, now + TICKET_MIN_RECHECK_SEC * 1000);
  assert.ok(!cp.progressSummary.includes('supersecret123456'));
  assert.equal(cp.state.apiKey, '[REDACTED]');
  assert.equal(cp.state.tabId, 42);

  const cpHigh = normalizeTicketCheckpoint({ step: 'long', recheckAfterSec: 9999 }, now);
  assert.equal(cpHigh.recheckAfterSec, TICKET_MAX_RECHECK_SEC);

  // Stop-condition budget checks
  assert.equal(evaluateTicketContinuationBudget({
    execution: { continuationsUsed: 2, maxContinuations: 12, startedAt: now - 60_000, consecutiveErrors: 0 },
    nowMs: now,
  }).allowed, true);

  assert.equal(evaluateTicketContinuationBudget({
    execution: { continuationsUsed: 12, maxContinuations: 12, startedAt: now - 60_000, consecutiveErrors: 0 },
    nowMs: now,
  }).code, 'MAX_CONTINUATIONS_REACHED');

  assert.equal(evaluateTicketContinuationBudget({
    execution: { continuationsUsed: 1, maxContinuations: 12, startedAt: now - 50 * 60_000, consecutiveErrors: 0 },
    nowMs: now,
  }).code, 'MAX_EXECUTION_TIME_REACHED');

  assert.equal(evaluateTicketContinuationBudget({
    execution: { continuationsUsed: 1, maxContinuations: 12, startedAt: now - 60_000, consecutiveErrors: 3 },
    nowMs: now,
  }).code, 'MAX_CONSECUTIVE_ERRORS_REACHED');
});

test('SCROLL 2.16: buildTicketApprovalTurnPrompt builds natural start & continuation prompts without leaks', () => {
  const ticket = {
    id: 'tk_1',
    ticketCode: 'TK-AABBCCDD',
    title: 'Polish training deck on final copy',
    note: 'Edit final PPTX and return updated file to group.',
    requesterName: 'Guest User',
    sourceChannel: 'telegram_group',
    sourceChatId: '-100555',
    sourceChatTitle: 'Demo Group',
    meta: { _internal: 'hidden', sourceFilename: 'deck-final.pptx', password: 'secret' },
  };
  const startPrompt = buildTicketApprovalTurnPrompt(ticket, {
    approvedBy: 'owner:us_1',
    phase: 'approved_start',
    attachments: [{ fileRef: 'file_1', mediaId: 'hmed_abc', filename: 'deck-final.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sizeBytes: 512000 }],
  });
  assert.match(startPrompt, /APPROVED TICKET EXECUTION -- TK-AABBCCDD/);
  assert.match(startPrompt, /ticket_reply_room/);
  assert.match(startPrompt, /ticket_wait/);
  assert.match(startPrompt, new RegExp(`${TICKET_WAIT_MAX_SEC}s`));
  assert.match(startPrompt, /deck-final\.pptx/);
  assert.ok(!startPrompt.includes('_internal'), 'internal _ meta fields must not leak into prompt');
  assert.ok(!startPrompt.includes('"secret"'), 'secrets in meta must be redacted');

  const contPrompt = buildTicketApprovalTurnPrompt(ticket, {
    approvedBy: 'owner:us_1',
    phase: 'continue',
    attempt: 3,
    maxContinuations: 12,
    checkpoint: {
      step: 'waiting_generation',
      progressSummary: 'Prompt submitted in browser tab 9',
      nextAction: 'Check if export button is visible',
      state: { tabId: 9 },
    },
  });
  assert.match(contPrompt, /APPROVED TICKET CONTINUATION -- TK-AABBCCDD \(check 3\/12\)/);
  assert.match(contPrompt, /do NOT greet or re-announce approval again/);
  assert.match(contPrompt, /Check if export button is visible/);
});
