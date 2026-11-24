// Public facade for `@agentpro/scroll-continuity` — Universal opt-in continuity kernel for @agentpro/scroll.
// Use this package for ANY long-running agent (personal assistant, coordinator, ops bot, or specialist).
// For deep vertical consulting workflows, layer `@agentpro/scroll-advisory` on top of this engine.
import { createSqliteStorageAdapter } from './storage-adapter.js';
import {
  createBiTemporalLedgerStore,
  computeActrScore,
  sanitizeFtsQuery,
  NODE_KINDS,
  PRIORITY_TIERS,
  EPISTEMIC_LEVELS,
  EDGE_TYPES,
} from './ledger-store.js';
import { createProblemRegister, evaluateParkingFlags } from './problem-register.js';
import { createClientImpedanceProfiler, isDeepDetailRequested } from './client-impedance.js';
import { createSleepTimeWorker } from './sleep-worker.js';
import { buildWorkingDesk, createContinuityRecallTool, createContinuityTrackTool } from './recall-tool.js';
import { runContinuityReplay } from './replay-eval.js';

export {
  createSqliteStorageAdapter,
  createBiTemporalLedgerStore,
  computeActrScore,
  sanitizeFtsQuery,
  NODE_KINDS,
  PRIORITY_TIERS,
  EPISTEMIC_LEVELS,
  EDGE_TYPES,
  createProblemRegister,
  evaluateParkingFlags,
  createClientImpedanceProfiler,
  isDeepDetailRequested,
  createSleepTimeWorker,
  buildWorkingDesk,
  createContinuityRecallTool,
  createContinuityTrackTool,
  runContinuityReplay,
};

export function createContinuityEngine({
  dbPath = ':memory:',
  storage = null,
  customSleepTasks = [],
  localeMatchers = null,
  now = () => new Date().toISOString(),
  logger = null,
} = {}) {
  const ledger = createBiTemporalLedgerStore({ storage, dbPath, now });
  const problems = createProblemRegister({ ledger, now });
  const impedance = createClientImpedanceProfiler({ ledger, now, localeMatchers });
  const sleep = createSleepTimeWorker({ ledger, problemRegister: problems, customTasks: customSleepTasks, now, logger });

  function recordEvent(tenantId, event) {
    return ledger.appendEvent(tenantId, event);
  }

  function ingestUserMessage(tenantId, {
    channel = 'chat',
    sourceUpdateId,
    chatId = null,
    threadId = null,
    messageId = null,
    senderId = null,
    senderName = '',
    senderRole = null,
    replyToId = null,
    body = '',
    occurredAt = null,
    payload = {},
    hasAttachment = false,
    extractedKeys = [],
    artifact = null,
  } = {}) {
    const rec = ledger.appendEvent(tenantId, {
      channel,
      sourceUpdateId,
      chatId,
      threadId,
      messageId,
      senderId,
      senderName,
      senderRole,
      replyToId,
      eventType: 'user_msg',
      occurredAt,
      body,
      payload,
    });

    let artRes = null;
    if (artifact && rec.event?.seq) {
      artRes = ledger.recordArtifact(tenantId, {
        sourceSeq: rec.event.seq,
        ...artifact,
      });
    }

    let peer = null;
    if (rec.appended && senderId) {
      peer = impedance.observeMessage(tenantId, {
        speakerId: senderId,
        speakerName: senderName,
        senderRole,
        seq: rec.event.seq,
        text: body,
        hasAttachment: Boolean(hasAttachment || artifact),
        observedAt: rec.event.occurredAt,
      });
    }

    let wake = { matched: [], woken: [] };
    if (rec.appended) {
      wake = problems.scanWakeCandidates(tenantId, {
        eventSeq: rec.event.seq,
        text: `${body || ''} ${artifact?.ocrText || ''}`,
        extractedKeys,
        artifactDuplicateOf: artRes?.duplicateOfArtifactId || null,
        explicitUserAsk: true,
      });
    }

    return {
      ...rec,
      artifact: artRes,
      peer,
      wake,
    };
  }

  function recordAssistantReply(tenantId, {
    channel = 'chat',
    sourceUpdateId,
    chatId = null,
    threadId = null,
    messageId = null,
    agentId = 'assistant',
    agentName = 'Assistant',
    body = '',
    payload = {},
    scheduleSleep = true,
  } = {}) {
    const rec = ledger.appendEvent(tenantId, {
      channel,
      sourceUpdateId,
      chatId,
      threadId,
      messageId,
      senderId: agentId,
      senderName: agentName,
      senderRole: 'assistant',
      eventType: 'bot_reply',
      body,
      payload,
    });
    if (scheduleSleep && rec.appended) {
      sleep.schedule(tenantId).catch(() => {});
    }
    return rec;
  }

  function getDesk(tenantId, opts = {}) {
    return buildWorkingDesk({
      ledger,
      problemRegister: problems,
      impedance,
      tenantId,
      ...opts,
    });
  }

  function createRecallTool(opts = {}) {
    return createContinuityRecallTool({ ledger, problemRegister: problems, ...opts });
  }

  function createTrackTool(opts = {}) {
    return createContinuityTrackTool({ ledger, problemRegister: problems, ...opts });
  }

  return {
    ledger,
    problems,
    impedance,
    sleep,
    recordEvent,
    ingestUserMessage,
    recordAssistantReply,
    buildWorkingDesk: getDesk,
    createRecallTool,
    createTrackTool,
    backupTo: (dest) => ledger.backupTo(dest),
    verifyIntegrity: () => ledger.verifyIntegrity(),
    close: () => ledger.close(),
  };
}

// Ready-to-wire SCROLL lifecycle hooks adapter (works with @agentpro/scroll & @agentpro/scroll-telegram!)
export function createContinuityScrollHooks({
  engine,
  resolveTenantId = ({ chatId, conversationId }) => String(chatId || conversationId || 'default'),
  agentId = 'assistant',
  agentName = 'Assistant',
  maxNodes = 12,
  maxQuotes = 6,
} = {}) {
  if (!engine) throw new Error('createContinuityScrollHooks requires engine');

  return {
    async onBeforeTurn({ chatId, conversationId, threadId = null, messageId = null, sender = null, text = '', attachments = [] } = {}) {
      const tenantId = resolveTenantId({ chatId, conversationId, threadId, sender });
      const clean = String(text || '').trim();
      if (clean) {
        engine.ingestUserMessage(tenantId, {
          sourceUpdateId: messageId != null ? `msg:${chatId || conversationId}:${messageId}` : undefined,
          chatId: chatId || conversationId,
          threadId,
          messageId,
          senderId: sender?.id || sender?.channelId || null,
          senderName: sender?.name || '',
          senderRole: sender?.role || null,
          body: clean,
          hasAttachment: Array.isArray(attachments) && attachments.length > 0,
        });
      }
      const desk = engine.buildWorkingDesk(tenantId, {
        query: clean,
        chatId: chatId || conversationId,
        activeSpeakerId: sender?.id || sender?.channelId || null,
        maxNodes,
        maxQuotes,
      });
      return {
        tenantId,
        desk,
        contextBlock: desk.contextBlock,
        verifiedGroundingText: desk.verifiedGroundingText,
      };
    },

    // Compatible directly with `@agentpro/scroll` `hooks.onTurnCompleted` (0ms latency!)
    async onTurnCompleted({ conversationId, chatId = null, threadId = null, result = null } = {}) {
      const tenantId = resolveTenantId({ chatId, conversationId, threadId });
      const replyText = String(result?.text || '').trim();
      if (!replyText || result?.streamHeld || result?.noReply) return;
      engine.recordAssistantReply(tenantId, {
        sourceUpdateId: result?.traceId ? `reply:${result.traceId}` : undefined,
        chatId: chatId || conversationId,
        threadId,
        agentId,
        agentName,
        body: replyText,
        scheduleSleep: true,
      });
    },
  };
}
