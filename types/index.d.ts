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
