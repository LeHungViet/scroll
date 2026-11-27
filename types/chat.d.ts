// SCROLL 2.5 TypeScript declarations for `@agentpro/scroll/chat`.
import type {
  ChatTurnResult,
  ScrollProvider,
  DurableJobStore,
  JobWakeBus,
  VaultSecretProvider,
} from './index.d.ts';

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

export const DEFAULT_PLAIN_SPEAK_CONFIG: Readonly<{
  enabled: boolean;
  mode: 'live' | 'shadow' | 'off';
  defaultRegister: 'casual_human' | 'client_plain' | 'expert_peer';
  forceRegister: 'casual_human' | 'client_plain' | 'expert_peer' | null;
  locale: string;
  dateOrder: string;
  rewriteEnabled: boolean;
  rewriteMaxChars: number;
  rewriteTimeoutMs: number;
  rewriteMaxTurnLatencyMs: number;
  rewriteTierBMinHits: number;
  rewriteMinRatio: number;
  rewriteMaxRatio: number;
  maxPreGenExamples: number;
  telemetryEnabled: boolean;
  telemetryMaxBytes: number;
}>;
export function verifyExtendedPlainSpeakInvariant(rawBaseline: string, candidate: string, opts?: { dateOrder?: string }): { ok: boolean; reason?: string; diffs?: unknown[] };
export function validatePlainSpeakPack(pack: unknown): { ok: boolean; errors: string[]; warnings: string[] };
export function loadPlainSpeakPackFromFile(filePath: string): Record<string, unknown>;
export function mergePlainSpeakPacks(packs?: Array<string | Record<string, unknown>>): Record<string, unknown>;
export function resolvePlainSpeakConfig(globalCfg?: Record<string, unknown>, agentCfg?: Record<string, unknown>): typeof DEFAULT_PLAIN_SPEAK_CONFIG;
export function createPlainSpeakEngine(opts?: {
  packs?: Array<string | Record<string, unknown>>;
  config?: Record<string, unknown>;
  stateDir?: string | null;
  accountId?: string;
  templates?: Record<string, unknown> | null;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}): {
  readonly enabled: boolean;
  readonly config: typeof DEFAULT_PLAIN_SPEAK_CONFIG;
  readonly packIds: string[];
  readonly entryCount: number;
  readonly telemetryPath: string | null;
  detectRegister(opts?: Record<string, unknown>): { register: string; userUsedTerms: Set<string>; confusionSignal: boolean; reason: string };
  buildPreGenCue(opts?: Record<string, unknown>): string;
  auditText(text: string, opts?: Record<string, unknown>): Record<string, unknown>;
  applyDeterministicFilter(text: string, opts?: Record<string, unknown>): Record<string, unknown>;
  processOutgoing(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
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
  autonomy?: Record<string, unknown> | null;
  onTurnExhausted?: ((ctx: Record<string, unknown>) => unknown) | null;
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

// SCROLL 2.16.1-2.20.1 Durable Multi-Day Execution re-exports on `@agentpro/scroll/chat`
export const DURABLE_JOB_SCHEMA: string;
export const DURABLE_JOB_STATUSES: readonly string[];
export const DURABLE_WAIT_REASONS: readonly string[];
export const REMOTE_JOB_SCHEMA: string;
export const SECRET_HANDLE_SCHEMA: string;
export const SCROLL_DURABLE_JOB_TOOL_SCHEMAS: readonly Record<string, unknown>[];
export function createTurnContextRegistry(opts?: Record<string, unknown>): Record<string, unknown>;
export function clampBackgroundSliceMs(rawMs?: number): number;
export function createDurableJobStore(opts?: Record<string, unknown>): DurableJobStore;
export function createJobWakeBus(opts: Record<string, unknown>): JobWakeBus;
export function evaluateEffectiveAuthority(opts: Record<string, unknown>): { allowed: boolean; code: string; isGroup?: boolean; effectiveTools?: string[]; forbidSecrets?: boolean; forbidCaptchaHandoff?: boolean; parkWaitingFor?: string; reason?: string };
export function evaluateSteeringPermission(opts: Record<string, unknown>): { allowed: boolean; effectiveRole?: string; requiresNewApproval?: boolean; unauthorizedCapabilities?: string[]; code: string; reason?: string };
export function projectJobForAudience(job: Record<string, unknown>, opts?: Record<string, unknown>): Record<string, unknown> | null;
export function createAsyncRemoteJobLedger(opts?: Record<string, unknown>): Record<string, unknown>;
export function createFairShareResourceQueue(opts?: Record<string, unknown>): Record<string, unknown>;
export function resolveAutonomyConfig(raw?: Record<string, unknown> | null): Record<string, unknown>;
export function classifyToolErrorDisposition(errOrResult: unknown): { disposition: 'abort_job' | 'park_waiting' | 'retry_backoff' | 'feed_llm_repair'; errorClass: string; retryable: boolean; parkWaitingFor: string | null; reason: string };
export function buildContinuationWorkLedger(opts?: Record<string, unknown>): string[];
export function validateReObserveBeforeGuiAction(opts: Record<string, unknown>): { allowed: boolean; code: string; reason?: string; reacquireAnchors?: unknown };
export function buildMorningDigest(opts?: Record<string, unknown>): { shouldSend: boolean; reason: string; count?: number; items: Array<Record<string, unknown>>; text: string };
export function matchWakeCueCandidates(opts?: Record<string, unknown>): { candidates: Array<Record<string, unknown>>; ambiguous: boolean; topCandidate: Record<string, unknown> | null };
export function computeDurableJobMetrics(opts?: Record<string, unknown>): Record<string, unknown>;
export function createVaultSecretProvider(opts?: Record<string, unknown>): VaultSecretProvider;
export function redactSecretsDeep<T>(value: T, activeSecrets?: Array<{ name: string; value: string }>, depth?: number): T;
