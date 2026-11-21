# Prompt Caching Guide (SCROLL 2.0, §13)

SCROLL is designed from the ground up so LLM prompt caches hit reliably across every tick of an autonomous loop (`scroll run`) and every turn of a live conversation (`scroll chat`).

Every provider computes prefix caches by matching exact token prefixes from byte 0. A single changing timestamp, unsorted tool list, or per-turn RAG snippet injected into the system prompt invalidates the entire cached prefix for the rest of the conversation.

---

## 1. The §13 Two-Region Layout

`lib/chat-session.js` enforces a strict three-part wire layout on every turn:

```
┌──────────────────────────────────────────────────────────────────────┐
│ REGION A -- STABLE PREFIX (byte-identical across turns)              │
│   1. Agent Identity (IDENTITY.md frontmatter)                        │
│   2. Soul & Persona (SOUL.md)                                        │
│   3. Hard Rules (hard-rules.md)                                      │
│   4. L5 Procedural Lessons (agents/<agent>/memory/lessons.md, §7)    │
│   5. Principal / Team Profile (USER.md rendered for audience, §42)   │
│   6. Static Voice Character Preset (`voiceBefore.stableSystemBlock`) │
│   7. Frozen Subject Memory (`stableMemoryBlock`, §32.4)              │
│   8. External Safety Contract (external/mixed turns only, §42-§44)   │
│   9. Sorted Tool Schemas (`tools.listSchemas()`, alphabetical)       │
├───────────────────────── CACHE BREAKPOINT 1 & 2 ─────────────────────┤
│ REGION B -- APPEND-ONLY CONVERSATION HISTORY                         │
│   Turn 1 (user + assistant) ... Turn N-1 (user + assistant)          │
├───────────────────────── CACHE BREAKPOINT 3 ─────────────────────────┤
│ REGION C -- VOLATILE SUFFIX (inside the final user message)          │
│   - Retrieved knowledge chunks (§44 `knowledgeChunks`)               │
│   - Per-turn voice cues (`voiceBefore.volatileTurnBlock`: affect,    │
│     cadence, move playbook, mode escalation overrides)               │
│   - Per-turn `contextBlocks` & `voiceBefore.extraContextBlocks`      │
│   - Dynamic memory (`dynamicMemoryBlock`: current speaker member     │
│     profile, peer summaries, owner group index)                      │
│   - Current user message & multimodal attachment notes               │
└──────────────────────────────────────────────────────────────────────┘
```

Because Region A never mutates between turns and Region B only appends at the tail, the token prefix through Turn N-1 remains byte-identical across turns.

---

## 2. Channel-Agnostic Scoped Memory & Frozen Snapshots

`lib/memory-tracker.js` (`createScopedMemoryTracker`) provides 3-axis subject memory (`user`, `group`, `member`) plus L5 lessons for **any** surface (web chat, CLI, voice, Slack, Discord, Telegram, MCP, mobile apps, or CRM rooms) without breaking prompt caches:

- **`stableMemoryBlock`** is snapshotted once per `(conversation, day)` with `capsule_turns: 0` (live history already lives in Region B) and `excludeSession` (preventing double-injection of today's turns). It stays frozen inside Region A until a reset, compaction, explicit memory write, or day rollover.
- **`dynamicMemoryBlock`** holds per-turn changing context (e.g., which speaker spoke inside a multi-person room, peer digests, or owner room index) and is attached to Region C after `history`.
- **Voice plugins (§43)** should return `{ stableSystemBlock, volatileTurnBlock, extraContextBlocks }` from `beforeTurn()`. `stableSystemBlock` stays in Region A; `volatileTurnBlock` and `extraContextBlocks` move to Region C automatically.

---

## 3. Six Cache-Busting Anti-Patterns (Prevented by SCROLL)

| Anti-pattern | Why it breaks caching | SCROLL safeguard |
|---|---|---|
| Putting `new Date()` / timestamps in `systemPrompt` | Changes byte 0 on every turn | Never inject wall-clock timestamps into Region A |
| Unsorted tool/MCP definitions | Map/discovery order shifts across restarts | `tools.listSchemas()` sorts alphabetically by `name` |
| Injecting RAG / knowledge chunks into `system` | Different query -> different system prompt | `knowledgeChunks` (§44) attach in Region C after `history` |
| Injecting live memory writes into `system` mid-session | Mutates Region A every time a fact is added | Frozen `stableMemoryBlock` (§32.4); volatile deltas go to Region C |
| Re-flattening full history on persistent RPC threads | Pays full re-prefill tokens on every turn | `codex-app-server` reuses persistent `threadId` per `(conversationId, prefixHash, model)` |
| Mutating early history turns silently | Invalidates Region B breakpoint | History is append-only; `compactSession` / `scrubHistory` explicitly reset cached threads |

---

## 4. Provider-Specific Mechanics (`lib/providers.js` & `lib/chat-session.js`)

### Anthropic (`anthropic`)
`makeAnthropicProvider` places **three** explicit `cache_control` breakpoints automatically:
1. **`system[0]`** — caches Region A system instructions.
2. **Last entry of `body.tools`** — caches the sorted tool definition block.
3. **Penultimate entry of `messages`** (`messages[messages.length - 2]`) — caches the entire conversation history prefix (Region B) up to the previous turn.

Optional extended TTL:
```js
const runtime = createChatSessionRuntime({
  agentName: 'assistant',
  providerName: 'anthropic',
  cacheTtl: '1h', // default is Anthropic's standard 5m ephemeral TTL
});
```
When `cacheTtl: '1h'` is set, SCROLL attaches `{ type: 'ephemeral', ttl: '1h' }` and sends the `anthropic-beta: extended-cache-ttl-2025-04-11` header automatically.

### OpenAI (`openai` / `openai-compatible`)
`makeOpenAIProvider` and `makeOpenAICompatibleProvider` forward:
- **`prompt_cache_key`**: automatically derived as `${agentName}:${conversationId}` (truncated to 64 chars) whenever targeting `api.openai.com` or when `promptCacheKey` is explicitly passed. This routes repeat turns of the same conversation to the same cache shard.
- **`prompt_cache_retention: '24h'`**: sent when `cacheTtl: '24h'` is configured (for supported OpenAI models).
- Third-party OpenAI-compatible proxies (e.g., local vLLM / Ollama) do **not** receive `prompt_cache_key` unless `promptCacheKey` is explicitly passed, avoiding 400 validation errors on strict schemas.

### Codex App-Server (`codex-app-server`)
`createChatSessionRuntime` tracks persistent server-side threads per conversation (`reuseProviderThreads: true` by default):
- **Turn 1**: opens a persistent thread (`ephemeral: false`) with `baseInstructions = systemPrompt` and sorted `dynamicTools`, storing `{ threadId, prefixHash, model }`.
- **Turn 2..N**: when `prefixHash` and `model` match, SCROLL sends **only the single new user turn** (`[{ role: 'user', content: finalUserMessage }]`) on the existing `threadId`, preserving server-side KV cache and avoiding redundant history re-transmission.
- **Self-healing resets**: `clearSession()`, `compactSession()`, `reload()`, `scrubHistory()`, prefix changes (e.g., new L5 lesson or updated frozen memory), model switches, or stale-thread RPC errors automatically clear the thread and cleanly start a new persistent thread with full history.

### Google Gemini (`gemini`)
- **Implicit caching**: works automatically because Region A + Region B stay byte-identical across turns; `usage.cachedInputTokens` maps directly from `usageMetadata.cachedContentTokenCount`.
- **Explicit Context Caching**: pass `cachedContent: 'cachedContents/...'` either on `pickProvider('gemini', { cachedContent })` or per-call `generate(..., { cachedContent })`. When `cachedContent` is set, SCROLL omits `systemInstruction` to satisfy Gemini's API contract.

### xAI Grok & Other Compatible Endpoints
Automatic prefix caching benefits immediately from Region A byte-stability and alphabetically sorted tool definitions, with zero vendor lock-in.

---

## 5. Verification & Telemetry

Inspect caching directly from `sendTurn()` results and runtime stats:

```js
const turn1 = await runtime.sendTurn({ conversationId: 'room-42', text: 'Hello', sender });
const turn2 = await runtime.sendTurn({ conversationId: 'room-42', text: 'Follow-up', sender });

console.log({
  prefixIdentical: turn1.prefixHash === turn2.prefixHash,
  threadReused: turn2.threadReused,
  cachedInputTokens: turn2.usage.cachedInputTokens,
  uncachedInputTokens: turn2.usage.uncachedInputTokens,
  stats: runtime.getCacheStats(),
});
```

Expected healthy signals on Turn 2+:
- `turn1.prefixHash === turn2.prefixHash` (even when RAG hits, dynamic memory, or voice affect cues change!)
- `turn2.usage.cachedInputTokens > 0` on providers supporting prompt caching
- `turn2.threadReused === true` when running on `codex-app-server`
