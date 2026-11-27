// SCROLL 2.5 TypeScript declarations (zero-dep public API surface).

export interface UsageMetrics {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  providerTotalTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface ProviderResponse {
  text: string;
  toolCalls?: ToolCall[];
  thinkingBlocks?: unknown[];
  rawParts?: unknown[];
  usage: UsageMetrics;
  durationMs: number;
  responseId?: string | null;
  threadId?: string | null;
  model?: string;
  authProfileId?: string;
}

export interface ScrollProvider {
  name: string;
  model: string;
  ready: boolean;
  supportsTools?: boolean;
  nativeToolManager?: boolean;
  missing: string | null;
  generate(prompt: string, opts?: Record<string, unknown>): Promise<ProviderResponse>;
  close?: () => Promise<void>;
}

export interface ChatTurnResult {
  text: string;
  bubbles: string[];
  rawText: string;
  toolTraces: Array<{ round: number; id?: string; name: string; arguments: Record<string, unknown>; result: Record<string, unknown> }>;
  toolMode?: 'direct' | 'portable';
  grounding: { checked: boolean; ok: boolean; claims: unknown[]; missing: unknown[]; pairMismatches: unknown[]; held: unknown[] };
  streamHeld?: boolean;
  aiDisclosure: { checked: boolean; ok: boolean };
  turnClassification: Record<string, unknown>;
  knowledgeHits: unknown[];
  usage: UsageMetrics;
  durationMs: number;
  model?: string;
  responseId?: string | null;
  prefixHash?: string;
  threadReused?: boolean;
  compacted?: boolean;
  aborted: boolean;
  traceId?: string;
}

export function loadAgent(name: string, cwd?: string): Record<string, unknown>;
export function checkAgent(name: string, cwd?: string): { errors: string[]; warnings: string[]; level: string };
export function checkMcpConfigPinning(cwd?: string, agentDir?: string | null): string[];
export function buildAgent(name: string, cwd?: string, opts?: Record<string, unknown>): { written: string[]; targets: string[] };
export function pickProvider(name?: string, opts?: Record<string, unknown>): ScrollProvider;
export function createAuthStore(opts?: Record<string, unknown>): Record<string, unknown>;
export function runLoopbackOAuthCallback(opts?: Record<string, unknown>): Promise<{ redirectUri: string; port: number; waitForCode: () => Promise<{ code: string; state: string | null }>; close: () => void }>;
export function createCodexAppServerClient(opts?: Record<string, unknown>): Record<string, unknown>;
export function findCodexBinary(opts?: Record<string, unknown>): string | null;
export function createToolRegistry(opts?: Record<string, unknown>): Record<string, unknown>;
export function buildToolRetriever(tools: unknown[], opts?: Record<string, unknown>): Record<string, unknown>;
export function buildAvailableToolsIndex(deferredTools: unknown[], opts?: Record<string, unknown>): { text: string; hash: string; deferredCount: number; estimatedTokens: number; tier: string };
export function validateToolArgs(args: unknown, schema: unknown): { ok: boolean; errors: string[] };
export function createMcpManager(opts?: Record<string, unknown>): Record<string, unknown>;
export function createMcpHttpClient(opts: Record<string, unknown>): Record<string, unknown>;
export function createChatSessionRuntime(opts: Record<string, unknown>): {
  sendTurn(opts?: Record<string, unknown>): Promise<ChatTurnResult>;
  abortTurn(conversationId: string): { ok: boolean };
  getHistory(conversationId: string): unknown[];
  clearSession(conversationId: string): { ok: boolean } | Promise<{ ok: boolean }>;
  forkSession(sourceConvId: string, targetConvId: string, opts?: { atIndex?: number | null }): { ok: boolean; sourceConvId: string; targetConvId: string; turns: number };
  compactSession(conversationId: string, opts?: Record<string, unknown>): Promise<{ compacted: boolean }>;
  reload(): Record<string, unknown>;
  getCacheStats(): Record<string, unknown>;
  close(): Promise<void>;
};
export function createWorkerPool(opts?: Record<string, unknown>): Record<string, unknown>;
export function createScheduler(opts?: Record<string, unknown>): Record<string, unknown>;
export function openStore(opts?: Record<string, unknown>): Record<string, unknown>;
export function createScopedMemoryTracker(opts: Record<string, unknown>): Record<string, unknown>;
export function buildScopedMemoryPolicy(personalTaxonomy?: unknown, opts?: Record<string, unknown>): Record<string, unknown>;
export function openUser(opts?: Record<string, unknown>): Record<string, unknown>;
export function openKnowledge(opts?: Record<string, unknown>): Record<string, unknown>;
export function openSkills(opts?: Record<string, unknown>): Record<string, unknown>;
export function createSecretVault(opts: Record<string, unknown>): Record<string, unknown>;
export function createEventLogger(opts?: Record<string, unknown>): Record<string, unknown>;
export function createAuditChain(opts?: Record<string, unknown>): Record<string, unknown>;
export function verifyAuditChain(filePath: string): { ok: boolean; count: number; errors: unknown[] };
export const DEFAULT_TIER_MULTIPLIERS: Readonly<Record<string, number>>;
export function resolveModelPricing(pricing?: Record<string, unknown>, opts?: Record<string, unknown>): Record<string, unknown>;
export function estimateUsageUsd(usage: Record<string, unknown>, pricing?: Record<string, unknown>, opts?: Record<string, unknown>): number;
export function createBudgetGovernor(opts?: Record<string, unknown>): Record<string, unknown>;
export function createApprovalStore(opts?: Record<string, unknown>): Record<string, unknown>;
export function createAlertLedger(opts?: Record<string, unknown>): Record<string, unknown>;
export function computeArgsHash(tool: string, args: Record<string, unknown>): string;
export function verifyTopHopAuthGrade(opts?: Record<string, unknown>): { authGrade: string; reason: string; alignedDomain: string };
export function computeUrgencyAndSeverity(caseObj: Record<string, unknown>, opts?: Record<string, unknown>): Record<string, unknown>;
export function acquireWriterLock(stateDir: string, opts?: { lockName?: string; owner?: string }): { acquired: boolean; lockPath?: string; token?: string; release: () => void };
export function evaluateExecPolicy(opts: { command: string; args?: string[]; allowRules?: unknown[] | null; denyRules?: unknown[] | null }): { ok: boolean; decision: 'allow' | 'deny'; reason?: string; matchedRule?: string[] | null };
export function pruneOldToolResults(messages: unknown[], opts?: { keepRecentToolMessages?: number; maxOldChars?: number }): { messages: unknown[]; prunedCount: number; savedChars: number };
export function applySpillToFileLimit(output: unknown, opts?: { toolName?: string; maxChars?: number; spillDir?: string | null }): unknown;
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown>;
export function runSandboxedExec(opts: Record<string, unknown>): Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string; truncated?: boolean; sandbox: string }>;
export function runEvals(name: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function runChatEvals(name: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function auditRepo(cwd?: string, opts?: Record<string, unknown>): Record<string, unknown>;
export function runWork(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
export function runLoop(file: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
// SCROLL 2.8 (§52-§56) Managed Agent Host & Immutable Packs
export function generatePackSigningKeyPair(): { publicKeyPem: string; privateKeyPem: string };
export function scanTextForPackLeaks(text: string, opts?: Record<string, unknown>): Array<{ file: string; rule: string; sample: string }>;
export function buildAgentPack(opts: Record<string, unknown>): { ok: boolean; packDir: string; manifest: Record<string, unknown>; sha256: string; signed: boolean };
export function verifyAgentPack(opts: Record<string, unknown>): { ok: boolean; packDir: string; manifest?: Record<string, unknown>; sha256?: string; verifiedSignature: boolean; findings: unknown[]; errors: string[] };
export function createPackRegistry(opts: Record<string, unknown>): Record<string, unknown>;
export function createLayeredKnowledge(layers?: unknown[]): Record<string, unknown>;
export function openTenantWorkspace(opts: Record<string, unknown>): Record<string, unknown>;
export function createPrincipalProvider(opts?: Record<string, unknown>): Record<string, unknown>;
export function createDesktopMutex(opts?: Record<string, unknown>): Record<string, unknown>;
export function createRemoteToolClient(opts: Record<string, unknown>): Record<string, unknown>;
export function createCompanionToolHost(opts: Record<string, unknown>): Record<string, unknown>;
export function verifyCompanionAudit(auditPath: string): { ok: boolean; count: number; errors: unknown[] };
export function createScrollAgentHost(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
export function redactTelemetryText(text: string): string;
export const HIGH_RISK_REMOTE_TIERS: ReadonlySet<string>;
export function normalizeCompanionBinding(raw?: Record<string, unknown> | null): {
  enabled: boolean;
  deviceId: string | null;
  deviceIds: string[];
  updatedAt: string | null;
};
export function isRemoteToolAllowedInContext(
  spec: Record<string, unknown> | null | undefined,
  ctx?: { isGroup?: boolean; isOwner?: boolean },
): boolean;
export function buildCompanionCapabilitiesPrompt(opts?: {
  devices?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  turnCtx?: { isGroup?: boolean; isOwner?: boolean };
  internalTools?: string[];
}): string;
export function createMultiRemoteToolClient(opts?: Record<string, unknown>): Record<string, unknown>;
// SCROLL 2.16.1-2.20.1 (sec 57-63) Durable Multi-Day Execution, Wake Bus, Autonomy, Companion Async 202 & SecretProvider
export interface AsyncRemoteJobAccepted {
  ok: true;
  accepted: true;
  status: 'accepted';
  operationId: string;
  remoteJobId: string | null;
  pollAfterSec: number;
  deviceId: string;
  callId: string;
}
export interface NormalizedOrigin {
  origin: string;
  hostname: string;
  protocol: string;
}
export interface DurableJobStore {
  filePath: string | null;
  createJob(spec?: Record<string, unknown>): Record<string, unknown>;
  claimJob(opts?: Record<string, unknown>): Record<string, unknown>;
  parkJob(opts?: Record<string, unknown>): Record<string, unknown>;
  enqueueWake(opts?: Record<string, unknown>): Record<string, unknown>;
  recordEffectIntent(opts?: Record<string, unknown>): Record<string, unknown>;
  recordEffectReceipt(opts?: Record<string, unknown>): Record<string, unknown>;
  openAsk(opts?: Record<string, unknown>): Record<string, unknown>;
  answerAsk(opts?: Record<string, unknown>): Record<string, unknown>;
  submitSteering(opts?: Record<string, unknown>): Record<string, unknown>;
  ackSteeringApplied(opts?: Record<string, unknown>): Record<string, unknown>;
  completeJob(opts?: Record<string, unknown>): Record<string, unknown>;
  failJob(opts?: Record<string, unknown>): Record<string, unknown>;
  recordNegativeProbe(opts?: Record<string, unknown>): Record<string, unknown>;
  reap(opts?: { nowMs?: number; reconcileStaleMs?: number; maxReconcileRounds?: number }): Record<string, unknown>;
  boot(opts?: { nowMs?: number }): Record<string, unknown>;
  enqueueOutbox(opts: Record<string, unknown>): Record<string, unknown>;
  claimPendingOutbox(opts?: { workerId?: string; leaseMs?: number; limit?: number; nowMs?: number }): Array<Record<string, unknown>>;
  markOutboxDelivery(clientMessageId: string, opts?: Record<string, unknown>): Record<string, unknown>;
  getJob(jobId: string): Record<string, unknown> | null;
  listJobs(filter?: { status?: string | null; agentId?: string | null; chatId?: string | null }): Array<Record<string, unknown>>;
  getAsk(askId: string): Record<string, unknown> | null;
  listAsks(filter?: { jobId?: string | null; status?: string | null }): Array<Record<string, unknown>>;
  listOutbox(filter?: { jobId?: string | null; deliveryState?: string | null }): Array<Record<string, unknown>>;
  getNextDueAtMs(): number | null;
  assertTransition(from: string, to: string): boolean;
}
export interface JobWakeBus {
  registerProbe(name: string, fn: (ctx: Record<string, unknown>) => unknown): string;
  hasProbe(name: string): boolean;
  listProbes(): string[];
  publishEvent(event?: Record<string, unknown>, opts?: { nowMs?: number }): Promise<{ ok: boolean; code?: string; woken: string[]; buffered: string[] }>;
  tick(opts?: { nowMs?: number; maxBatch?: number }): Promise<{ deferred?: boolean; reap: Record<string, unknown> | null; woken: string[]; probedNegative: Array<Record<string, unknown>>; probeRejected: Array<Record<string, unknown>> }>;
  scheduleNextTimer(): void;
  start(): void;
  stop(): void;
}
export interface AsyncRemoteJobRecord {
  schema: string;
  remoteJobId: string;
  operationId: string;
  tenantId: string;
  deploymentId: string;
  deviceId: string;
  tool: string;
  argsHash: string;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  cancelRequested: boolean;
  pollAfterSec: number;
  receipt: unknown;
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  receiptPersistencePending?: boolean;
}
export interface AsyncRemoteJobLedger {
  readonly isDurable: boolean;
  computeIdentityHash(opts?: { tool?: string; deviceId?: string; args?: Record<string, unknown> }): string;
  accept(opts?: {
    tenantId?: string;
    deploymentId: string;
    deviceId?: string;
    operationId: string;
    tool: string;
    args?: Record<string, unknown>;
    pollAfterSec?: number;
  }): { ok: true; idempotent: boolean; record: AsyncRemoteJobRecord } | { ok: false; code: string; operationId?: string };
  updateStatus(
    idOrOp: string,
    opts: {
      deploymentId: string;
      status: AsyncRemoteJobRecord['status'];
      receipt?: unknown;
      error?: string | null;
      cancelRequested?: boolean | null;
    },
  ): { ok: true; alreadyTerminal?: boolean; record: AsyncRemoteJobRecord } | { ok: false; code: string };
  lookup(idOrOp: string, opts: { deploymentId: string }): AsyncRemoteJobRecord | null;
  compact(opts?: { nowMs?: number }): { ok: boolean; pruned: number; retained: number };
}
export interface FairShareResourceLease {
  ok: true;
  physicalResourceId: string;
  groupKey: string;
  waitedMs: number;
  release(): boolean;
}
export interface FairShareResourceQueue {
  acquire(opts?: {
    physicalResourceId?: string;
    tenantId?: string;
    groupId?: string;
    estimatedMs?: number;
    signal?: AbortSignal | null;
  }): Promise<FairShareResourceLease | { ok: false; code: string; groupKey?: string; maxPerGroupQueued?: number }>;
  getStats(physicalResourceId?: string): {
    physicalResourceId: string;
    inFlightTotal: number;
    queuedByGroup: Record<string, number>;
    occupiedMsByGroup: Record<string, number>;
    oldestEligibleAgeMs: number;
  };
}
export interface VaultSecretProvider {
  tenantId: string;
  putSecret(opts?: Record<string, unknown>): { ok: boolean; name: string; stepUp: string; allowedDomains: string[] };
  grantPerJobOrigin(opts?: Record<string, unknown>): Record<string, unknown>;
  issueEachUseToken(opts?: Record<string, unknown>): Record<string, unknown>;
  resolveToolArgs(opts?: Record<string, unknown>): Record<string, unknown>;
  listPolicies(): Array<Record<string, unknown>>;
}
export const DEFAULT_TURN_TIMEOUT_MS: number;
export const DEFAULT_TURN_TOKEN_GRACE_MS: number;
export const BACKGROUND_SLICE_DEFAULT_MS: number;
export const BACKGROUND_SLICE_MAX_MS: number;
export function normalizeTurnContext(raw?: Record<string, unknown>, opts?: { nowMs?: number; ttlMs?: number | null }): Record<string, unknown>;
export function computeTurnTokenTtlMs(opts?: { turnTimeoutMs?: number; graceMs?: number }): number;
export function clampBackgroundSliceMs(rawMs?: number): number;
export function createTurnContextRegistry(opts?: Record<string, unknown>): Record<string, unknown>;
export function computeTicketSpecHash(actionSpec: unknown): string | null;
export function findForbiddenInternalKeys(value: unknown, prefix?: string, out?: string[]): string[];
export function sanitizeTicketPayloadPatch(value: unknown, depth?: number): unknown;
export function validateTicketUpdate(opts: Record<string, unknown>): { allowed: boolean; code: string; reason?: string; forbiddenKeys?: string[] };
export function validateTicketTransitionScope(opts: Record<string, unknown>): { allowed: boolean; code: string; reason?: string };
export function evaluateTicketTurnExit(opts: Record<string, unknown>): { action: string; code: string; allowAutoClose: boolean; implicitYieldCount?: number; recoverCount?: number };
export const DURABLE_JOB_SCHEMA: string;
export const DURABLE_JOB_STATUSES: readonly string[];
export const DURABLE_TERMINAL_STATUSES: ReadonlySet<string>;
export const DURABLE_WAIT_REASONS: readonly string[];
export const TEMPO_TIERS: readonly string[];
export const ASK_KINDS: readonly string[];
export const ASK_TARGET_ROLES: readonly string[];
export const STEERING_COMMANDS: readonly string[];
export const DEFAULT_INLINE_ASK_WAIT_SEC: number;
export const SCROLL_DURABLE_JOB_TOOL_SCHEMAS: readonly Record<string, unknown>[];
export function computeJobArgsHash(args: unknown): string;
export function normalizeJobBudget(raw?: Record<string, unknown>, opts?: { nowMs?: number }): Record<string, unknown>;
export function evaluateJobBudget(budget: Record<string, unknown>, opts?: { nowMs?: number; reserveUsd?: number }): Record<string, unknown>;
export function computeTempoTier(opts?: Record<string, unknown>): 'micro' | 'sprint' | 'marathon';
export function computeNextProbeDelaySec(opts?: Record<string, unknown>): number;
export function isWithinQuietHours(nowMs: number, quietHours?: Record<string, unknown> | null): boolean;
export function nextNotificationWindowMs(nowMs: number, quietHours?: Record<string, unknown> | null, opts?: { urgent?: boolean }): number;
export function detectPoliteBailout(replyText: string, opts?: Record<string, unknown>): { detected: boolean; code?: string; reason: string };
export function evaluateEffectiveAuthority(opts: Record<string, unknown>): { allowed: boolean; code: string; isGroup?: boolean; effectiveTools?: string[]; forbidSecrets?: boolean; forbidCaptchaHandoff?: boolean; parkWaitingFor?: string; reason?: string };
export function evaluateSteeringPermission(opts: Record<string, unknown>): { allowed: boolean; effectiveRole?: string; requiresNewApproval?: boolean; unauthorizedCapabilities?: string[]; code: string; reason?: string };
export function projectJobForAudience(job: Record<string, unknown>, opts?: { isOwner?: boolean; isGroup?: boolean; chatId?: string | null }): Record<string, unknown> | null;
export function createDurableJobStore(opts?: Record<string, unknown>): DurableJobStore;
export function createJobWakeBus(opts: Record<string, unknown>): JobWakeBus;
export const AUTONOMY_MODES: readonly string[];
export const ERROR_DISPOSITIONS: readonly string[];
export const DEFAULT_AUTONOMY_CONFIG: Readonly<Record<string, unknown>>;
export function validateAutonomyConfig(raw: unknown): { ok: boolean; errors: string[] };
export function resolveAutonomyConfig(raw?: Record<string, unknown> | null): Record<string, unknown>;
export function classifyToolErrorDisposition(errOrResult: unknown): { disposition: 'abort_job' | 'park_waiting' | 'retry_backoff' | 'feed_llm_repair'; errorClass: string; retryable: boolean; parkWaitingFor: string | null; reason: string };
export function buildContinuationWorkLedger(opts?: Record<string, unknown>): string[];
export function validateReObserveBeforeGuiAction(opts: Record<string, unknown>): { allowed: boolean; code: string; reason?: string; reacquireAnchors?: unknown };
export function isGuiObserveTool(toolName: string, observeTools?: ReadonlySet<string>): boolean;
export function buildMorningDigest(opts?: Record<string, unknown>): { shouldSend: boolean; reason: string; count?: number; items: Array<Record<string, unknown>>; text: string };
export function matchWakeCueCandidates(opts?: Record<string, unknown>): { candidates: Array<Record<string, unknown>>; ambiguous: boolean; topCandidate: Record<string, unknown> | null };
export function computeDurableJobMetrics(opts?: Record<string, unknown>): Record<string, unknown>;
export const REMOTE_JOB_SCHEMA: string;
export const REMOTE_JOB_STATUSES: readonly string[];
export const DEFAULT_REMOTE_JOB_RETENTION_MS: number;
export function createAsyncRemoteJobLedger(opts?: {
  filePath?: string | null;
  retentionMs?: number;
  now?: () => number;
}): AsyncRemoteJobLedger;
export function createFairShareResourceQueue(opts?: {
  maxPerGroupInFlight?: number;
  maxPerGroupQueued?: number;
  quantumMs?: number;
  agingMs?: number;
  now?: () => number;
}): FairShareResourceQueue;
export const SECRET_HANDLE_SCHEMA: string;
export const SECRET_STEP_UP_MODES: readonly string[];
export function isSecretHandle(val: unknown): boolean;
export function normalizeOrigin(rawOrigin: string): NormalizedOrigin | null;
export function matchesAllowedDomain(activeOrigin: string, allowedDomains?: string[], opts?: { matchMode?: string }): boolean;
export function redactSecretsDeep<T>(value: T, activeSecrets?: Array<{ name: string; value: string }>, depth?: number): T;
export function createVaultSecretProvider(opts?: Record<string, unknown>): VaultSecretProvider;
