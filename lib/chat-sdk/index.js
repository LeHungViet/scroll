// SCROLL 2.5 -- `@agentpro/scroll/chat` Channel-Agnostic Chat Harness SDK.
//
// Unites ChatSessionRuntime, channel-agnostic 3-axis MemoryTracker, Knowledge Retrieval,
// §47.2 Tool Registry + MCP Manager, Burst Debouncer, Room-Agnostic Group Grants,
// Long-Task Runner, and pure-JSON AdminController -- with zero channel lock-in and
// optional dependency-injected `voiceHooks`.
import path from 'node:path';
import { pickProvider } from '../providers.js';
import { openKnowledge } from '../knowledge.js';
import { createScopedMemoryTracker, buildScopedMemoryPolicy } from '../memory-tracker.js';
import { createMcpManager } from '../mcp-client.js';
import { createToolRegistry } from '../tools.js';
import { createChatSessionRuntime } from '../chat-session.js';
import { createMessageDebouncer } from './debouncer.js';
import {
  createGroupGrantStore,
  DEFAULT_DELEGATED_GROUP_TOOLS,
  matchesOwnerDelegationPhrase,
} from './group-grants.js';
import { createLongTaskRunner } from './long-task-runner.js';
import { createAdminController, ADMIN_CALLBACK_NAMESPACE } from './admin-controller.js';
import { createAlertLedger } from '../alerts.js';
import { createApprovalStore } from '../chat-telemetry.js';
import {
  createAlertsController,
  ALERTS_CALLBACK_NAMESPACE,
  DEFAULT_ALERT_LABELS,
  sanitizeUntrustedQuote,
  sanitizeSafeHtmlMessage,
  escapeHtml,
  buildGoogleCalendarTemplateUrl,
  makeAlertCallbackData,
  parseAlertCallbackData,
} from './alerts-controller.js';
import {
  DEFAULT_TURN_RECOVERY_CONFIG,
  TRANSIENT_PROVIDER_ERROR_RE,
  isTransientProviderError,
  DEFAULT_RECOVERY_CUES,
  resolveRecoveryCues,
  resolveTurnRecoveryConfig,
  stripRecoveryCues,
  sanitizeRecoveryAttachment,
  filterExistingRecoveryAttachments,
  isNewerMessageId,
  hasAssistantReplyAfter,
  readPendingTurnJournal,
  writePendingTurnJournal,
  createTurnRecoveryController,
} from './turn-recovery.js';
import {
  DEFAULT_MEDIA_TTL_MS,
  DEFAULT_MAX_STAGE_BYTES,
  BINARY_FILE_EXTS,
  guessExtFromMime,
  guessMimeFromPath,
  sniffBufferMime,
  isBinaryBuffer,
  isBinaryFilePath,
  resolveMediaStagingDir,
  pruneExpiredStagedMedia,
  persistMediaBuffer,
  extractMcpToolMedia,
  createDefaultMultimodalHooks,
} from '../media-stage.js';
import {
  PLAIN_SPEAK_REGISTERS,
  PLAIN_SPEAK_TIERS,
  PLAIN_SPEAK_ACTIONS,
  DEFAULT_PLAIN_SPEAK_CONFIG,
  DEFAULT_PLAIN_SPEAK_TEMPLATES,
  verifyExtendedPlainSpeakInvariant,
  validatePlainSpeakPack,
  loadPlainSpeakPackFromFile,
  mergePlainSpeakPacks,
  maskProtectedSpans,
  resolvePlainSpeakConfig,
  createPlainSpeakEngine,
} from './plain-speak.js';
import {
  DEFAULT_RESPONSE_ECONOMY_RUNTIME,
  computeUserEchoScore,
  detectSettledTopicReask,
  auditResponseEconomy,
  extractUrls,
  applyDeterministicEconomyTrim,
  createResponseEconomyEngine,
} from './response-economy.js';
import {
  TURN_SHAPES,
  DEFAULT_ECONOMY_CONFIG,
  resolveEconomyConfig,
  isPushbackSignal,
  classifyTurnBudget,
  escalateEffortForRound,
  renderAnswerContractCue,
} from '../turn-budget.js';

export {
  createMessageDebouncer,
  createGroupGrantStore,
  DEFAULT_DELEGATED_GROUP_TOOLS,
  matchesOwnerDelegationPhrase,
  createLongTaskRunner,
  createAdminController,
  ADMIN_CALLBACK_NAMESPACE,
  createApprovalStore,
  createAlertLedger,
  createAlertsController,
  ALERTS_CALLBACK_NAMESPACE,
  DEFAULT_ALERT_LABELS,
  sanitizeUntrustedQuote,
  sanitizeSafeHtmlMessage,
  escapeHtml,
  buildGoogleCalendarTemplateUrl,
  makeAlertCallbackData,
  parseAlertCallbackData,
  DEFAULT_TURN_RECOVERY_CONFIG,
  TRANSIENT_PROVIDER_ERROR_RE,
  isTransientProviderError,
  DEFAULT_RECOVERY_CUES,
  resolveRecoveryCues,
  resolveTurnRecoveryConfig,
  stripRecoveryCues,
  sanitizeRecoveryAttachment,
  filterExistingRecoveryAttachments,
  isNewerMessageId,
  hasAssistantReplyAfter,
  readPendingTurnJournal,
  writePendingTurnJournal,
  createTurnRecoveryController,
  DEFAULT_MEDIA_TTL_MS,
  DEFAULT_MAX_STAGE_BYTES,
  BINARY_FILE_EXTS,
  guessExtFromMime,
  guessMimeFromPath,
  sniffBufferMime,
  isBinaryBuffer,
  isBinaryFilePath,
  resolveMediaStagingDir,
  pruneExpiredStagedMedia,
  persistMediaBuffer,
  extractMcpToolMedia,
  createDefaultMultimodalHooks,
  PLAIN_SPEAK_REGISTERS,
  PLAIN_SPEAK_TIERS,
  PLAIN_SPEAK_ACTIONS,
  DEFAULT_PLAIN_SPEAK_CONFIG,
  DEFAULT_PLAIN_SPEAK_TEMPLATES,
  verifyExtendedPlainSpeakInvariant,
  validatePlainSpeakPack,
  loadPlainSpeakPackFromFile,
  mergePlainSpeakPacks,
  maskProtectedSpans,
  resolvePlainSpeakConfig,
  createPlainSpeakEngine,
  DEFAULT_RESPONSE_ECONOMY_RUNTIME,
  computeUserEchoScore,
  detectSettledTopicReask,
  auditResponseEconomy,
  extractUrls,
  applyDeterministicEconomyTrim,
  createResponseEconomyEngine,
  TURN_SHAPES,
  DEFAULT_ECONOMY_CONFIG,
  resolveEconomyConfig,
  isPushbackSignal,
  classifyTurnBudget,
  escalateEffortForRound,
  renderAnswerContractCue,
  createScopedMemoryTracker,
  buildScopedMemoryPolicy,
  createScopedMemoryTracker as createMemoryTracker,
  buildScopedMemoryPolicy as buildMemoryPolicy,
};

export async function createScrollChatRuntime({
  agentName,
  deploymentDir,
  stateDir,
  accountId = null,
  ownerIds = [],
  provider = null,
  providerName = 'auto',
  providerOpts = {},
  model = null,
  effort = null,
  serviceTier = null,
  authStore = null,
  scheduler = null,
  workerPool = null,
  enableMemory = true,
  memoryChannel = 'chat',
  memoryTracker: customMemoryTracker = null,
  autoSweepEveryTurns = 12,
  enableTools = true,
  toolsRetrieval = null,
  enableMcp = false,
  mcpEnforceLock = true,
  mcpAutoPinLock = false,
  enableSkills = true,
  voiceHooks = null,
  plainSpeak = null,
  responseEconomy = null,
  multimodalHooks = null,
  hooks = null,
  onGroundingHeld = null,
  groundingMode = null,
  trustedRooms = [],
  groundingRetryMax = 0,
  channelMap = null,
  approvalStore = null,
  requestApproval = null,
  webSearchFn = null,
  compactAtChars = 48_000,
  compactAtTokens = null,
  keepRecentTurns = 24,
  dateOrder = 'dmy',
  budget = null,
  acquireLock = true,
  strictToolSupport = true,
} = {}) {
  const rootDir = path.resolve(deploymentDir || process.cwd());
  const absStateDir = stateDir ? path.resolve(stateDir) : null;
  const effectiveAccountId = accountId || agentName;
  const agentDir = path.join(rootDir, 'agents', agentName);

  const activeProvider = provider || pickProvider(providerName, {
    model,
    effort,
    serviceTier,
    authStore,
    cwd: rootDir,
    ...providerOpts,
  });

  const knowledgeIndex = openKnowledge({ cwd: rootDir });
  let chat = null;
  let memoryTracker = customMemoryTracker || null;
  if (!memoryTracker && enableMemory && absStateDir) {
    memoryTracker = createScopedMemoryTracker({
      rootDir: path.join(absStateDir, 'memory', effectiveAccountId),
      workdir: rootDir,
      agentDir,
      ownerIds,
      channel: memoryChannel,
      autoSweepEveryTurns,
      workerPool,
      onSweepRequest: async ({ sid, sessionId, axis }) => {
        if (!memoryTracker) return { ok: false, skipped: true };
        return memoryTracker.runLlmSweep({
          sid,
          sessionId,
          axis,
          provider: activeProvider,
          model,
        });
      },
      onScrubExternal: ({ chatId, needles }) => {
        try { chat?.scrubHistory?.(chatId, needles); } catch { /* ignore */ }
      },
      onReloadAgent: () => {
        try { chat?.reload?.(); } catch { /* ignore */ }
      },
    });
  }
  const memoryStore = memoryTracker ? memoryTracker.store : null;

  let tools = null;
  let mcpManager = null;
  let mcpStartupError = null;
  if (enableMcp) {
    try {
      mcpManager = createMcpManager({
        cwd: rootDir,
        agentDir,
        enforceLock: mcpEnforceLock,
        autoPinLock: mcpAutoPinLock,
        onToolsChanged: () => {
          try { tools?.syncMcpTools?.(); } catch { /* ignore */ }
        },
      });
      await mcpManager.connectAll();
    } catch (err) {
      mcpStartupError = String(err?.message || err);
      mcpManager = null;
    }
  }

  tools = enableTools
    ? createToolRegistry({
        cwd: rootDir,
        agentDir,
        memoryStore,
        knowledgeIndex,
        scheduler,
        workerPool,
        mcpManager,
        approvalStore,
        requestApproval,
        webSearchFn,
        toolsRetrieval,
        spillDir: absStateDir ? path.join(absStateDir, 'scratch') : null,
      })
    : null;
  if (tools && memoryTracker && typeof memoryTracker.registerTools === 'function') {
    memoryTracker.registerTools(tools);
  }
  if (tools && mcpManager) {
    try {
      await Promise.resolve(tools.syncMcpTools());
    } catch (err) {
      mcpStartupError = mcpStartupError || String(err?.message || err);
    }
  }

  chat = createChatSessionRuntime({
    agentName,
    cwd: rootDir,
    deploymentDir: rootDir,
    stateDir: absStateDir,
    provider: activeProvider,
    model,
    serviceTier,
    authStore,
    approvalStore,
    tools,
    enableSkills,
    voiceHooks,
    plainSpeak,
    responseEconomy,
    memoryStore,
    memoryTracker,
    knowledgeIndex,
    scheduler,
    workerPool,
    multimodalHooks,
    hooks,
    onGroundingHeld,
    groundingMode,
    trustedRooms,
    groundingRetryMax,
    channelMap,
    compactAtChars,
    compactAtTokens,
    keepRecentTurns,
    dateOrder,
    budget,
    acquireLock,
    strictToolSupport,
  });

  if (mcpStartupError && chat?.events?.emit) {
    chat.events.emit('mcp.startup_error', { agentName, error: mcpStartupError });
  }

  async function close() {
    try { memoryTracker?.flushRegistry?.(); } catch { /* ignore */ }
    if (mcpManager) await mcpManager.closeAll().catch(() => {});
    await chat.close();
  }

  return {
    agentName,
    accountId: effectiveAccountId,
    chat,
    tools,
    approvalStore: chat.approvalStore || approvalStore || null,
    mcpManager,
    mcpStartupError,
    memoryStore,
    memoryTracker,
    knowledgeIndex,
    provider: activeProvider,
    reload: () => chat.reload(),
    sendTurn: (opts) => chat.sendTurn(opts),
    setPlainSpeak: (engine) => chat.setPlainSpeak(engine),
    get plainSpeak() { return chat.plainSpeak; },
    setResponseEconomy: (engine) => chat.setResponseEconomy(engine),
    get responseEconomy() { return chat.responseEconomy; },
    getLastWorkLedger: (convId) => chat.getLastWorkLedger(convId),
    abortTurn: (convId) => chat.abortTurn(convId),
    getHistory: (convId) => chat.getHistory(convId),
    clearSession: (convId) => chat.clearSession(convId),
    forkSession: (src, dst, opts) => chat.forkSession(src, dst, opts),
    clearProviderThread: (convId) => chat.clearProviderThread(convId),
    getProviderThreadState: (convId) => chat.getProviderThreadState(convId),
    rollbackLastTurn: (convId) => chat.rollbackLastTurn(convId),
    scrubHistory: (convId, needles) => chat.scrubHistory(convId, needles),
    getCacheStats: () => chat.getCacheStats(),
    close,
  };
}
