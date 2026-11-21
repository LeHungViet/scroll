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

export {
  createMessageDebouncer,
  createGroupGrantStore,
  DEFAULT_DELEGATED_GROUP_TOOLS,
  matchesOwnerDelegationPhrase,
  createLongTaskRunner,
  createAdminController,
  ADMIN_CALLBACK_NAMESPACE,
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
  authStore = null,
  scheduler = null,
  workerPool = null,
  enableMemory = true,
  memoryChannel = 'chat',
  memoryTracker: customMemoryTracker = null,
  autoSweepEveryTurns = 12,
  enableTools = true,
  enableMcp = false,
  mcpEnforceLock = true,
  mcpAutoPinLock = false,
  enableSkills = true,
  voiceHooks = null,
  multimodalHooks = null,
  hooks = null,
  channelMap = null,
  requestApproval = null,
  webSearchFn = null,
  compactAtChars = 48_000,
  compactAtTokens = null,
  keepRecentTurns = 12,
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
        requestApproval,
        webSearchFn,
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
    authStore,
    tools,
    enableSkills,
    voiceHooks,
    memoryStore,
    memoryTracker,
    knowledgeIndex,
    scheduler,
    workerPool,
    multimodalHooks,
    hooks,
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
    mcpManager,
    mcpStartupError,
    memoryStore,
    memoryTracker,
    knowledgeIndex,
    provider: activeProvider,
    reload: () => chat.reload(),
    sendTurn: (opts) => chat.sendTurn(opts),
    abortTurn: (convId) => chat.abortTurn(convId),
    getHistory: (convId) => chat.getHistory(convId),
    clearSession: (convId) => chat.clearSession(convId),
    forkSession: (src, dst, opts) => chat.forkSession(src, dst, opts),
    close,
  };
}
