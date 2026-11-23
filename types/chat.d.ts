// SCROLL 2.5 TypeScript declarations for `@agentpro/scroll/chat`.
import type { ChatTurnResult, ScrollProvider } from './index.d.ts';

export const ADMIN_CALLBACK_NAMESPACE: string;
export const ALERTS_CALLBACK_NAMESPACE: string;
export const DEFAULT_DELEGATED_GROUP_TOOLS: readonly string[];

export function createMessageDebouncer(opts: {
  quietMs?: number;
  maxWaitMs?: number;
  immediatePrefix?: string;
  onFlush: (merged: Record<string, unknown>) => unknown;
}): {
  push(key: string, item: Record<string, unknown>, opts?: { immediate?: boolean }): Promise<void>;
  flushKey(key: string): Promise<void>;
  flushAll(): Promise<void>;
  close(): void;
  readonly pendingCount: number;
};

export function createGroupGrantStore(opts?: {
  filePath?: string | null;
  defaultAllowedTools?: readonly string[];
  clock?: () => number;
}): {
  grant(opts: { roomId?: string; chatId?: string; isGroup?: boolean; grantedBy: string; ttlMinutes?: number; allowedTools?: string[]; note?: string }): Record<string, unknown>;
  revoke(roomId: string): { ok: boolean; removed: boolean };
  getActiveGrant(roomId: string): Record<string, unknown> | null;
  listActiveGrants(): Array<Record<string, unknown>>;
};

export function matchesOwnerDelegationPhrase(text: string, extraPatterns?: RegExp[]): boolean;
export function createLongTaskRunner(opts: Record<string, unknown>): Record<string, unknown>;
export function createAdminController(opts: Record<string, unknown>): Record<string, unknown>;
export function createAlertLedger(opts?: Record<string, unknown>): Record<string, unknown>;
export function createAlertsController(opts: Record<string, unknown>): Record<string, unknown>;
export function sanitizeUntrustedQuote(text: string, opts?: { maxChars?: number }): string;
export function buildGoogleCalendarTemplateUrl(opts: Record<string, unknown>): string | null;

export const DEFAULT_TURN_RECOVERY_CONFIG: Readonly<{
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  inlineRetryDelaysMs: number[];
  deferredRetryDelaysMs: number[];
  maxStartupReplays: number;
  startupDelayMs: number;
  startupStaggerMs: number;
}>;
export const TRANSIENT_PROVIDER_ERROR_RE: RegExp;
export function isTransientProviderError(err: unknown, extraMatchers?: Array<RegExp | ((err: unknown, msg: string) => boolean)> | null): boolean;
export function resolveTurnRecoveryConfig(globalCfg?: Record<string, unknown>, agentCfg?: Record<string, unknown>): typeof DEFAULT_TURN_RECOVERY_CONFIG;
export function readPendingTurnJournal(filePath: string, opts?: { ttlMs?: number; nowMs?: number }): Array<Record<string, unknown>>;
export function writePendingTurnJournal(filePath: string, entries: Array<Record<string, unknown>>, opts?: { maxEntries?: number }): void;
export function createTurnRecoveryController(opts?: {
  stateDir?: string | null;
  channel?: string;
  accountId?: string;
  config?: Record<string, unknown>;
  lang?: string;
  cues?: Record<string, unknown> | null;
  isTransientError?: (err: unknown) => boolean;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}): {
  readonly enabled: boolean;
  readonly config: typeof DEFAULT_TURN_RECOVERY_CONFIG;
  readonly channel: string;
  readonly accountId: string;
  readonly journalPath: string | null;
  scopeKeyFor(conversationId: string, threadId?: string | number | null): string;
  listPending(opts?: { nowMs?: number }): Array<Record<string, unknown>>;
  getPending(opts: { conversationId: string; threadId?: string | number | null; nowMs?: number }): Record<string, unknown> | null;
  observeIncoming(opts: { conversationId: string; threadId?: string | number | null; messageId: string | number; isGroup?: boolean; isCommand?: boolean; receivedAt?: number }): void;
  cancelPendingTimer(opts: { conversationId: string; threadId?: string | number | null }): void;
  beginTurn(opts: Record<string, unknown>): { turnSeq: number; scopeKey: string; carryoverBlock: string | null; supersededEntry: Record<string, unknown> | null };
  runWithInlineRetry<T>(opts: { fn: (attempt: number) => Promise<T>; signal?: AbortSignal | null; isRecoveryReplay?: boolean; onRetry?: (info: Record<string, unknown>) => void }): Promise<T>;
  completeTurn(opts: { conversationId: string; threadId?: string | number | null; messageId?: string | number | null }): void;
  handleTurnFailure(opts: Record<string, unknown>): Record<string, unknown>;
  scheduleStartupRecovery(opts: Record<string, unknown>): { scheduled: number };
  isCurrentSeq(opts: { conversationId: string; threadId?: string | number | null; expectedSeq: number }): boolean;
  stop(): void;
};

export function createScrollChatRuntime(opts: {
  agentName: string;
  deploymentDir?: string;
  stateDir?: string | null;
  accountId?: string | null;
  ownerIds?: string[];
  provider?: ScrollProvider | null;
  providerName?: string;
  model?: string | null;
  voiceHooks?: Record<string, unknown> | null;
  [key: string]: unknown;
}): Promise<{
  agentName: string;
  accountId: string;
  chat: Record<string, unknown>;
  tools: Record<string, unknown> | null;
  memoryStore: Record<string, unknown> | null;
  memoryTracker: Record<string, unknown> | null;
  knowledgeIndex: Record<string, unknown>;
  provider: ScrollProvider;
  reload(): Record<string, unknown>;
  sendTurn(opts?: Record<string, unknown>): Promise<ChatTurnResult>;
  abortTurn(convId: string): { ok: boolean };
  getHistory(convId: string): unknown[];
  clearSession(convId: string): { ok: boolean };
  close(): Promise<void>;
}>;
