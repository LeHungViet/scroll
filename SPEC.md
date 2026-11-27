# SCROLL Specification

**Version:** 2.5 · **Status:** Stable (runtime built; §28–§50 & §47.2 implemented) · **Date:** 2026-11-21 · **Reference impl:** `@agentpro/scroll` 2.5.0

> **v2.5 (production chat harness, §47.2 Portable Tool Retriever & 2-package monorepo):**
> - **Hardened Action Boundary:** `fs.realpathSync.native` + case-insensitive & dotfile deny-list (`USER.md`, `.env`, `.scroll/**`, `.mcp.json`), OS kernel sandboxing (`sandbox-exec` / `bwrap`) with minimal env allowlist for `exec` & MCP subprocesses, AES-256-GCM vault (`${vault:KEY}` fail-closed), DNS/IPv6/CGNAT `100.64.0.0/10` + manual-redirect SSRF & `egress_allow`, provenance-tagged §22 grounding (untrusted `web_fetch` cannot launder claims), buffered streaming on external grounded turns, single-use per-call approval tokens + `canApprove()`, and fail-closed read-only `confirmEffect` probes.
> - **§47.2 Portable Tool Retriever (Zero-Dep):** 3-set architecture (deployment-frozen Catalog `C`, per-turn Visible `V`, per-call Executable `E`) with multi-field BM25F + batch `queries[]` `tool_search`, Transparent Unwrap `tool_invoke` with host JSON Schema validation, Room-Sticky group prompt-cache invariance (`<turn_speaker>` in Region C), `.scroll/mcp.lock.json` TOFU pinning, ASI04 quarantine, and `scroll check` ban on unpinned `npx …@latest`.
> - **D16 Observability, Budget & Concurrency:** OTel GenAI-aligned `events.jsonl`, hash-chained `audit.jsonl` (`scroll audit --verify-chain`), `IDENTITY.budget` + loop/error circuit breakers, single-writer PID lock, per-conversation turn mutex, per-round JSONL crash recovery, and §34 `openSkills()` wired into live chat sessions.
> - **4-Provider Parity & Streamable HTTP MCP:** Real SSE streaming, parallel tool calling, `thoughtSignature`/`thinking` preservation, `images`, and `authStore` failover across OpenAI, Anthropic, Gemini, and Codex App-Server (`base64` vision temp-file bridge + turn-bound RPC callbacks); Streamable HTTP MCP (`Mcp-Session-Id` + HTTP `404` re-init + `Promise.allSettled` isolation); token-aware compaction + `400 context_length_exceeded` auto-recovery; multi-turn `runChatEvals()` (`pass^k`); and lockstep 2-package monorepo (`@agentpro/scroll` with `./chat` + `@agentpro/scroll-telegram`).

> **v1.9 (people in the agent team):** §38 a person card per person (`people/<slug>.md`), written by that person, outside every agent folder, with a body capped by code · §39 agents bind to people by role (`serves`, `reports_to: role:<r>`); the deployment maps roles to people and every agent of the team loads the same card · §40 a person can own a `WORK.md` step, and an approval names its approver, whose card the runner checks before the gate opens, with a hash-chained audit trail · §41 audit fails when a card, a `USER.md` or a `people/` folder travels inside an agent folder, a skill or a plugin. §3, §9, §13, §18.3 and §20.5 are updated to match; `pronoun` and `reports_to: user` remain valid as legacy.
>
> **v1.8 (skills):** §34 a skill loader — the open Agent Skills format, ordered sources including read-only folders of other tools, a byte-stable index, `skill_list` / `skill_view` · §35 one skill, many runtimes: foreign tool names map to capabilities, and a skill built around tools the agent lacks is hidden · §36 skills are validated, scanned for secrets, exfiltration, remote code and injection before any model sees them, and evaluated with and without the skill on every model they run on. §19.3 now points here; `triggers` is no longer required.
>
> **v1.7 (subject memory):** §31 per-subject facts behind one five-layer gate · §32 episodic sessions, cards and day notes with a frozen, hashed load contract, deterministic search and a forget that reaches every copy · §33 groups and many surfaces. §7 stays the agent's own memory.
>
> **v1.4 (the harness + loop-engineering layer):** §21 risk-tiered permission matrix (5 tiers, enforced at the action boundary) · §22 grounding pre-check · §23 `LOOP.md` outer loop. Plus record corrections: `scroll eval` is **built** (not roadmap); the approval file lives under `control/approvals/<id>` (§18.3).

This document is the normative reference for SCROLL agents. A tool is **SCROLL-conformant** if it reads and writes agent folders exactly as defined here.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as in RFC 2119.

---

## 1 · Overview & terminology

- **Agent** — a directory containing the files defined in §2. The directory name is the agent's local id.
- **Source** — the canonical agent files a human/AI authors (`IDENTITY.md`, `SOUL.md`, etc.). The single source of truth.
- **Rendering** — a runtime-specific artifact produced from the source by a transpiler (§15). Renderings are generated; they MUST NOT be hand-edited.
- **Loader** — a SCROLL-conformant program that reads an agent folder and assembles its context.
- **Controller** — the single agent that owns a `WORK.md` in a multi-agent run (§9).
- **Conformant tool** — a program (CLI, library, plugin) implementing this spec.

A SCROLL **repository** MAY contain many agents under `agents/` and SHOULD contain a root `AGENTS.md` (§17) and a `scroll.config.*` (§16).

---

## 2 · The agent folder

```
agents/<name>/
├── IDENTITY.md      REQUIRED   identity + machine-readable frontmatter (§3)
├── SOUL.md          REQUIRED   persona prose (§4)
├── TOOLS.md         OPTIONAL   capability → tool wiring (§5)
├── hard-rules.md    OPTIONAL   inviolable rules (§6)
├── memory/          OPTIONAL   recall, archival, layered (§7)
└── evals/           RECOMMENDED gold test cases (§8)
```

- `<name>` **MUST** match `^[a-z][a-z0-9-]*$` and be unique within its `agents/` directory.
- An agent **MUST** contain `IDENTITY.md` and `SOUL.md`. All other files are OPTIONAL but a conformant loader MUST honor them when present.
- Unknown files in the folder **MUST** be ignored by loaders (forward compatibility).
- An agent folder **MUST NOT** carry anything about a person — no person card, no `USER.md`, no `people/` folder (§41). People are described by cards outside `agents/` (§38).

---

## 3 · `IDENTITY.md`

`IDENTITY.md` consists of YAML frontmatter (between `---` fences) followed by free-form body prose.

### 3.1 Frontmatter (normative)

| Field | Req | Type | Notes |
|---|---|---|---|
| `name` | MUST | string | `^[a-z][a-z0-9-]*$`, equals folder name |
| `title` | MUST | string | human-readable label |
| `version` | MUST | string | semver `MAJOR.MINOR.PATCH` |
| `serves` | SHOULD | string[] | v1.9: roles this agent serves (`owner` or `role:owner`), never a person (§39) |
| `pronoun` | OPTIONAL | string | legacy: how the agent addresses the user. From v1.9 the address lives on each person's card (§38); `pronoun` is only the last fallback and `scroll check` warns |
| `language` | SHOULD | string | BCP-47 (e.g. `en`, `vi-VN`) |
| `runtimes` | MUST | string[] | non-empty; values from the runtime registry (§15) |
| `model` | MUST | object | `{ primary, fallback?, voice?, voice_id? }`; `primary` REQUIRED |
| `capabilities` | MUST | string[] | logical capabilities (§5.1); MAY be empty |
| `dispatch` | OPTIONAL | object | `{ authority, can_dispatch?, spawn_template? }` |
| `position` | OPTIONAL | enum | `c-suite \| above-c-suite \| outside-org \| runtime` |
| `reports_to` | OPTIONAL | string | another agent's name, or `role:<role>` (v1.9). `user` is legacy (warning); `person:<slug>` is an error (§39) |
| `hard_rules` | OPTIONAL | path | relative path to a rules file (§6) |
| `memory` | OPTIONAL | object | overrides default memory layout (§7) |
| `a2a` | OPTIONAL | object | A2A Agent Card export hints (§15) |
| `skills` | OPTIONAL | string[] | skills pinned to the top of this agent's index (§34.6) |
| `skills_external` | OPTIONAL | boolean | `false` keeps external skill folders away from this agent (§34.2) |

- `dispatch.authority` **MUST** be one of `none | low | medium | high`. Default `none`.
- Fields not listed here are **OPTIONAL extensions**; a conformant validator MUST treat unknown fields as a **warning**, never an error.
- The full JSON Schema is **Appendix A**.

### 3.2 Body

Everything after the closing `---` is appended to the agent's assembled context (§13) after `SOUL.md`. It MAY be empty. It MUST NOT contain secrets; secret references use `${vault:KEY}` syntax, resolved at load time.

---

## 4 · `SOUL.md`

Free-form prose defining voice, values, and behavior. There is **no required structure** — this is the human-authored heart of the agent. A loader **MUST** include the full contents of `SOUL.md` in the assembled context (§13). Tools **MUST NOT** auto-generate `SOUL.md` from frontmatter.

---

## 5 · `TOOLS.md`

### 5.1 Capabilities (logical, runtime-agnostic)
Capabilities are dot-namespaced verbs. Reserved roots: `fs`, `web`, `shell`, `mcp`, `vision`, `voice`, `dispatch`, `memory` (v1.7, §31), `skills`, `ask`, `message`, `tasks` (v1.8, §35). Example: `web.search`, `fs.read`, `shell.exec`, `dispatch.agents`, `memory.subject`.

The `capabilities` array in `IDENTITY.md` is the source of truth; `TOOLS.md` **MUST NOT** declare a capability absent from `IDENTITY.md`. A validator MUST flag the mismatch.

### 5.2 Tool bindings (per runtime)
`TOOLS.md` MAY contain a YAML block mapping each capability to a runtime-specific tool name:
```yaml
web.search:
  cowork: WebSearch
  codex:  web_search
  gemini: google_search
```
Tool **implementations** live in application code, never in the agent folder. Only the **wiring** is specified here.

---

## 6 · `hard-rules.md`
A list of rules the agent **MUST NOT** violate, in prose or bullets. Referenced by `IDENTITY.md:hard_rules` (which MAY be a shared file used by multiple agents). A conformant loader **MUST** place `hard-rules` in the cached prefix (§13) so they are always present, and **SHOULD** support an automated rule-check.

---

## 7 · `memory/`

| Path | Role | Notes |
|---|---|---|
| `memory/lessons.md` | recall | scanned at session start; append-only |
| `memory/log/` | archival | one file per session, **race-safe** |
| `memory/private/` | private | visible only to this agent |
| `memory/team/` | team | visible to agents sharing a `team_id` |
| `memory/global/` | global | visible to all agents |

- Archival log files **MUST** be named `YYYY-MM-DD-<topic>.md` and **MUST NOT** be appended to concurrently by two processes (race-safe rule: one file per session).
- Visibility is determined by **folder**, not metadata. Promotion between layers is a file **move**.
- A loader **MUST** only surface memory an agent is permitted to read (its own `private`, its `team`, and `global`).
- §7 holds the agent's **own** memory (procedure, lessons). Facts about the people, groups and projects an agent serves **MUST NOT** be written here — they belong in subject memory (§31–§33), outside the repo. What a person says about themselves is their card (§38), also outside the agent folder.

---

## 8 · `evals/`

An agent SHOULD ship at least three **gold cases**. Each gold case is a markdown file with frontmatter:

```yaml
---
id: case-01-...
runs: 10          # times to execute (consistency measurement)
---
```
The body **MUST** contain: an **Input**, a **checklist** of programmatically-verifiable requirements (including at least one **planted trap** the agent must not fall for), an OPTIONAL **rubric** for LLM-judging, and **pass thresholds**.

`evals/rubric.md` MAY hold a shared rubric. A conformant `eval` runner (§ tooling) **MUST**:
1. run each case `runs` times,
2. apply programmatic checks and (if present) an LLM-judge,
3. grade the **end state / output**, never the execution path,
4. report a score per case plus a **diff against the previous run**,
5. compute a consistency metric (pass^k) for customer-facing reliability.

---

## 9 · Multi-agent — `WORK.md`

`WORK.md` is the work-chain for a multi-agent run, expressed as a **declarative DAG**.

### 9.1 Task record
Each task **MUST** declare:

| Field | Req | Notes |
|---|---|---|
| `id` | MUST | unique within the file |
| `title` | MUST | short imperative |
| `status` | MUST | `todo \| doing \| done \| blocked` |
| `owner` | MUST | exactly one owner: an agent (`<name>` or `agent:<name>`) or, v1.9, a person (`person:<slug>`, §40) |
| `blockedBy` | OPTIONAL | list of task ids (dependencies) |
| `objective` | MUST | what "done" means |
| `output_format` | MUST | expected shape of the result |
| `tool_guidance` | SHOULD | which tools/sources to use |
| `boundaries` | MUST | what NOT to do / scope limits |

The last four fields are the **four-part task contract**. Omitting any of `objective`, `output_format`, `boundaries` **MUST** be a validation error (under-specified tasks cause agent drift).

### 9.2 Ownership & advancement (normative)
- A `WORK.md` **MUST** have exactly one **controller**, and it **MUST** be an agent (a person may own steps, never the chain — §40); only the controller writes `WORK.md`. Sub-agents **MUST NOT** reassign tasks to each other (this prevents infinite handoff loops).
- Advancement **MUST** be deterministic: a runner reads dependencies and dispatches every task whose `blockedBy` is satisfied. An LLM **MUST NOT** freely decide task ordering; LLM autonomy is confined to *within a step* and to explicitly open-ended routing tasks.
- Independent tasks **MAY** be dispatched in parallel (fork-join). Each parallel task **MUST** write to its own files (race-safe); no two tasks write the same file.

---

## 10 · `blackboard/`

A shared information space. Each entry is **one append-only file**:
```
blackboard/<YYYY-MM-DD>-<author>-<slug>.md
```
with frontmatter `type` (`discovery | decision | request | progress | warning`), `author`, `visibility` (`team | global`), and OPTIONAL `expires_at`.

- Writers **MUST NOT** modify another agent's entry (append-only).
- On task start, a loader **SHOULD** surface entries relevant to the task (entity/keyword match), placed in the **volatile** context region (§13).
- Entries without `expires_at` default to a 7-day lifetime; `scroll prune` removes expired entries.

---

## 11 · `registry.md`

A generated table of agent track-record, used for capability-aware dispatch:
`agent · task_type · runs · success_rate · avg_tokens · avg_duration`.

It is **derived** from `memory/log/` by a conformant tool and **MUST NOT** be hand-maintained as the source of truth. Dispatch logic MAY weight by success rate, recency, and token efficiency.

---

## 12 · Token governance

A SCROLL repo **MUST** support hard caps, configured in `scroll.config.*`:

```yaml
budget:
  per_run_usd: 25
  per_iteration_tokens: 4000
  max_iterations: 50
  recursion_depth: 2
  wall_clock_minutes: 60
  on_exceed: pause   # pause | downgrade | abort
```

- A conformant runner **MUST** enforce these as **hard** limits with a circuit breaker. On breach it **MUST** take `on_exceed` action and **SHOULD** notify a human.
- A token **ledger** (running tally) **SHOULD** be written to `ledger.md` (or the storage backend) and is the basis for cost reporting.
- Before spawning multiple agents, a runner **SHOULD** estimate single-vs-multi cost and prefer single-agent unless the task is parallel and read-heavy.

---

## 13 · Context assembly & caching (normative)

A loader **MUST** assemble an agent's context in two regions, in this order:

```
[ STABLE PREFIX ]                          → cache breakpoint →   [ VOLATILE SUFFIX ]
  tool/MCP definitions                                             current task (WORK.md)
  hard-rules                                                       fresh blackboard entries
  IDENTITY (frontmatter + body)                                    timestamps, prior step output
  SOUL                                                             retrieved memory
  pinned skill indexes
  people block (§39)
```

- The stable prefix **MUST** be byte-identical across ticks of the same agent so provider prompt-caching hits. Tools **MUST NOT** interleave volatile content into the prefix.
- Where a provider's default cache lifetime is short, loaders **MUST** set an explicit cache TTL; cached reads are typically billed at a small fraction of fresh input. Consult the provider's caching documentation — this spec fixes no vendor's numbers. See [`docs/prompt-caching.md`](./docs/prompt-caching.md) for the reference chat-session layout and per-provider adapter behavior (Anthropic 3-breakpoint caching, OpenAI `prompt_cache_key`, Codex App-Server persistent `threadId` reuse, and Gemini explicit `cachedContent`).
- Skills are referenced by **index** (name + one-line description) in the prefix; full skill bodies load **on demand** (progressive disclosure). §34 specifies the loader, the index and the read tools; skill *content* is out of scope.

---

## 14 · The Runner

A conformant runner drives one heartbeat loop:
```
wake → load context → pick ready task(s) → dispatch → write result + checkpoint → stop-check → sleep|halt
```

- **Checkpoint:** after each tick the runner **MUST** persist state durably (a git commit locally, or a write to the storage backend) such that a crashed run resumes from the last checkpoint.
- **Decomposition:** long objectives **MUST** be split into short, individually-verifiable units; the runner **SHOULD** verify per step and track per-step success.
- **Human gates:** any irreversible external action (send, pay, delete, post) **MUST** halt and await an approval file under `gates/`.
- **Stop conditions:** the runner **MUST** halt on objective-complete, budget breach (§12), or a watchdog timeout.

---

## 15 · Transpilation

`scroll build` renders the source to one artifact per declared runtime. Runtime registry (extensible): `cowork`, `codex`, `gemini`, `claude-subagent`, `voice`, `a2a`.

- Transpilers **MUST** be deterministic: identical source ⇒ identical output.
- Renderings **MUST** carry a generated-file marker and **MUST NOT** be edited by hand; a conformant tool **SHOULD** warn on drift between source and rendering.
- A2A export produces a static Agent Card JSON from frontmatter; it does not require a running endpoint.

---

## 16 · Storage adapters

State access is abstracted behind a path-addressed read/write interface. A conformant loader **MUST** support at least `local-fs` and **SHOULD** support an object-store driver.

```yaml
# scroll.config.yaml
storage:
  driver: s3          # local-fs | s3 | gcs | repo
  bucket: my-agents
  prefix: ${TENANT}   # multi-tenant isolation
```

- Agent **definitions** are read-only config shipped with the deployment.
- Runtime **state** (`WORK.md`, `blackboard/`, `memory/`, `ledger`) is addressed by path and stored via the driver. Agent code **MUST NOT** assume a local filesystem.
- Multi-tenant deployments **MUST** namespace state by tenant/run prefix.

---

## 17 · Conformance levels & validation

`scroll check` reports against three levels:

| Level | Requires |
|---|---|
| **L0 — Valid agent** | `IDENTITY.md` frontmatter valid; `SOUL.md` present; capabilities consistent with `TOOLS.md` |
| **L1 — Gradeable** | L0 + ≥3 gold cases in `evals/`; `hard-rules` present |
| **L2 — Multi-agent ready** | L1 + any `WORK.md` satisfies the four-part contract and single-controller rule |

- Validation is **linter-style**: structural violations are **errors**; style/extension issues are **warnings**. A conformant tool SHOULD run `check` in pre-commit and CI.
- The repo root SHOULD contain `AGENTS.md` instructing AI tools to follow this spec.

---

## 18 · Observability & control

A conformant runner **MUST** emit an event stream and **MUST** honor control files. This is the surface through which users observe and steer a run.

### 18.1 Event stream
Events are written append-only to `runs/<run-id>/events.jsonl`, one JSON object per line:
```json
{ "ts": "<iso8601>", "run": "<run-id>", "agent": "<name>", "type": "<type>", "data": { } }
```
`type` **MUST** be one of: `run_started`, `step_started`, `thought`, `tool_call`, `tool_result`, `message`, `state_update`, `gate_request`, `cost_update`, `run_completed`, `error`. Events **MUST** be append-only. Consumers tail the file (local) or subscribe via an SSE/WebSocket gateway (cloud). Event types **SHOULD** map to the **AG-UI** protocol so standard frontends can render them.

### 18.2 State polling
Current run state **MUST** be derivable by reading `WORK.md` (task statuses) plus the ledger (tokens/cost) — without replaying the event stream. Polling is a cheap file read.

### 18.3 Control
A runner **MUST** check `control/` at the start of every tick and honor:
- `control/pause`, `control/resume`, `control/stop` — presence-based signals
- `control/steer.md` — guidance injected into the next step's context
- `control/approvals/<gate-id>` — approval for a pending must-approve gate (§21). From v1.9 the file names its approver (`{ "by": "<slug>" }`); with a team configured the runner checks that person's card (§40.2).
- `control/done/<task-id>.json` — v1.9: the person who owns a step marks it done (`{ "by": "<slug>" }`, §40.1). The runner writes the matching request to `control/requests/<task-id>.json`. (The v1.3 draft wrote this as `gates/<id>.approved`; `control/approvals/` is normative from v1.4. A conformant runner SHOULD also accept the legacy `control/<id>.approved` for back-compat.)

`thought` (chain-of-thought) events are **advisory transparency**, not authoritative; consumers **MUST NOT** treat them as ground truth.

### 18.4 Backend tracing
A runner **SHOULD** emit **OpenTelemetry GenAI** spans (LLM client, agent, tool) for backend observability, independently of the user-facing event stream.

---

## 19 · Tools, MCP, connectors, skills & plugins

SCROLL specifies how capabilities **attach** to an agent; it does not ship their implementations. It is **MCP-first** and reuses standard formats. The wiring is installed by `scroll mcp add` / `scroll skill add` / `scroll plugin add` (implemented in impl 0.8.0) — they only edit `.mcp.json`, `skills/`, and `agents/`; the runtime reads those files.

### 19.1 Tools & MCP
- An agent declares logical `capabilities` in `IDENTITY.md` and per-runtime `tool_bindings` in `TOOLS.md` (§5).
- MCP servers are declared in a standard **`.mcp.json`** (repo-level or under `agents/<name>/.mcp.json`). A loader **MUST** connect to declared servers and expose their tools to the agent when the agent has the `mcp.client` capability. Tool *implementations* come from the MCP server, not the agent folder.

### 19.2 Connectors
A connector (Gmail, Slack, Notion, …) is an MCP server plus credentials. Credentials **MUST** be referenced via `${vault:KEY}` and resolved at load time; they **MUST NOT** appear in any agent file. A conformant tool **SHOULD** integrate an MCP/connector registry for discovery (`scroll mcp add`).

### 19.3 Skills
- A skill is a directory containing **`SKILL.md`** in the open Agent Skills format: frontmatter `name` and `description` (REQUIRED), `license`, `compatibility`, `metadata`, `allowed-tools` (OPTIONAL), then a markdown body; optional `scripts/`, `references/`, `assets/`. (v1.8: `triggers` is no longer required; the description says when to use the skill. A legacy `triggers` field is ignored.)
- Loading, precedence, the index, the read tools, compatibility and checks are specified in **§34–§36**.

### 19.4 Plugins
A plugin is a bundle (an "agent pack") containing one or more agents, a `skills/` directory, a `.mcp.json`, and a manifest. `scroll plugin add` unpacks it into `agents/` + `skills/` and merges MCP config. Plugin bundles **SHOULD** be compatible with the `.plugin` ZIP format used by Cowork/Claude.

---

## 20 · Governance & security (v2 — the production rail)

This is the rail that separates a pilot from production. A conformant runner **MUST** implement §20.1–20.5 and **SHOULD** implement §20.6–20.7. Aligned to the OWASP Agentic Top 10 (2026) and the NIST agent-standards dimensions (identity, authorization, auditing, non-repudiation).

### 20.1 Permission enforcement (deny-by-default, at the tool boundary)
- An agent's tool/action permissions are an explicit **allow-list**; anything not listed is denied (`ASI02` Tool Misuse).
- Permissions **MUST** be enforced at the tool/runtime boundary — **NOT** in the system prompt. Prompt text is advisory and can be overridden by injection; the gate sits at the action.
- Authorization **SHOULD** be policy-as-code (OPA/Cedar) evaluated adjacent to the action, returning allow/deny + a reason code. Scopes only narrow, never widen (`ASI03`).

### 20.2 Identity & credentials
- Each agent **MUST** have its own scoped, tenant-bound **non-human identity** — never a shared service account or a borrowed user token.
- Credentials **MUST** be short-lived/scoped (OAuth 2.1 / RFC 8693 token-exchange) and referenced via `${vault:KEY}`, resolved **server-side**; secrets **MUST NOT** enter the model context or logs.
- Agent→tool calls **SHOULD** use sender-constrained tokens (DPoP/mTLS). Identity standards (badges/passports) are **not** mandated — conform to OAuth, do not invent a scheme.

### 20.3 Untrusted content & injection defense
- All tool outputs, retrieved documents, and third-party tool descriptions **MUST** be treated as **data, never instructions** (`ASI01` Goal Hijack, indirect prompt injection). A runner **MUST NOT** execute instructions found in content.
- Tool definitions **SHOULD** be pinned/verified against silent change ("rug-pull", `ASI04`); "always allow"/auto-run of un-vetted tools **MUST NOT** be the default.

### 20.4 Sandboxing & egress
- Agent-generated code or untrusted tool execution **MUST** run in a sandbox (microVM/gVisor/isolate), never unwrapped (`ASI05`).
- The agent runtime **SHOULD** apply a network **egress allow-list** (block-by-default, block RFC 1918) to prevent SSRF/exfiltration.

### 20.5 Risk-tiered human approval
- Actions are classified **reversible** vs **irreversible**. Irreversible/high-risk actions (send, pay, delete, cross-tenant, schema change) **MUST** be gated `must-approve` (block until a `gates/<id>.approved` file exists). Lower-risk actions **MAY** be `auto` or `soft-hold` (`ASI09`).
- Per-tenant circuit breakers + hard cost caps (§12) back-stop runaway behavior.
- **Who may approve (v1.9).** An approval names its approver. When the deployment has person cards, the runner checks the approver's card in code — the tier or action class, and the amount — before the gate opens, rejects an approval that is unattributed or not covered, and appends every decision to an audit trail (§40.2–§40.3). Being able to create the file is no longer enough.

### 20.6 Audit & provenance
- A runner **SHOULD** write a tamper-evident, per-action audit record binding `actor (agent+tenant) · authority/scope · action/resource · SHA-256(input,output) · policy decision · approver`, hash-chained (aligned to the IETF Agent Audit Trail draft), correlated by OpenTelemetry trace-id.

### 20.7 Data governance
- A runner **SHOULD** redact/mask PII at the tool boundary before data enters context, tag data residency, and apply per-class retention. Inadvertently logged secrets **MUST** be purged.

### 20.8 Frontmatter additions (v2)
`IDENTITY.md` MAY declare:
```yaml
security:
  tools_allow: [web.search, fs.read]     # deny-by-default allow-list
  egress_allow: ["api.example.com"]      # network allow-list
  identity: scoped                        # scoped non-human identity
  risk_defaults:                          # v1.4 — capability → tier (§21.3)
    fs.read: read_only
    shell.exec: destructive
    mcp.*: external_comm
  approval:                               # v1.4 — tier → policy (§21.2)
    external_comm: soft-hold              # auto | auto-log | soft-hold | must-approve
    financial: must-approve
    destructive: must-approve
```

---

## 21 · Risk-tiered permission matrix (v1.4)

This refines §20.5 from a binary (reversible/irreversible) into a five-tier matrix, and fixes the **enforcement point at the action boundary** — a conformant runner evaluates it in code, immediately before an action, **never** by asking the model to self-restrain.

### 21.1 Tiers
Every action **MUST** be classified into exactly one tier (lowest → highest consequence):
`read_only` · `reversible_write` · `external_comm` · `financial` · `destructive`.
An action whose tier cannot be determined **MUST** be treated as `destructive` (fail-safe / deny-by-default).

### 21.2 Matrix (default policies, overridable)
| tier | default policy |
|---|---|
| `read_only` | `auto` |
| `reversible_write` | `auto-log` (execute + audit record §20.6) |
| `external_comm` | `soft-hold` |
| `financial` | `must-approve` **+ grounding (§22)** |
| `destructive` | `must-approve` **+ grounding (§22)** |

- `must-approve` **MUST** block until an approval file exists at `control/approvals/<gate-id>` (§18.3).
- `soft-hold` **MAY** execute after a configurable hold; `auto`/`auto-log` execute immediately.
- A `financial` policy **MAY** carry a `threshold` so amounts below it are `soft-hold` and above it `must-approve`.

### 21.3 Where risk is declared (data, not prose)
Risk is **machine-readable** and resolved by the runner, in precedence order: (1) a per-tool `risk` in `.mcp.json`; (2) `IDENTITY.security.risk_defaults` keyed by capability (exact, then namespace glob like `mcp.*`); (3) the `destructive` fallback. A risk label **MUST NOT** be taken from a markdown body — prompt text is advisory and injectable (§20.1).

### 21.4 Decision & events
The runner emits `permission_decision { tool, tier, policy, decision: allow|await|deny, reason }`. `deny` (e.g. grounding failure) **MUST** take precedence over an approval — an approved-but-ungrounded action still does not run. Legacy `gate_requested`/`gate_approved`/`gate_blocked` events remain for back-compat; the v1.3 task risk `irreversible` is an alias for `destructive`.

---

## 22 · Grounding pre-check (v1.4)

Before any `financial` or `destructive` action, a runner **SHOULD** verify that every **critical parameter** declared for it (e.g. a product code, an amount, a customer id) traces to a real source already present in the run — the `blackboard/`, a prior `tool_result`, `control/steer.md`, or the task objective.

- The check is **deterministic**: it matches parameters by exact/regex token (codes, ids) or digits (amounts). It **MUST NOT** rely on an LLM judgment of "semantic" grounding — that would re-introduce model trust.
- Parameters to ground are declared per-tool in `.mcp.json` (`{ "issue_invoice": { "risk": "financial", "ground": ["code","amount"] } }`) or on a `WORK.md` task (`ground:`).
- On a missing trace the runner **MUST** emit `grounding_failed` and **MUST NOT** execute the action. A passing check emits `grounding_checked { traced, missing, passed }`.

---

## 23 · `LOOP.md` — the outer loop (v1.4)

`scroll run` is the **inner loop** (one harnessed execution). `LOOP.md` defines the **outer loop**: when to start an inner loop, where it finds work, and when to stop. A conformant `scroll loop` rides the host scheduler; it introduces **no engine, DB, or daemon runtime**.

### 23.1 Frontmatter (normative)
| Field | Req | Notes |
|---|---|---|
| `id` | MUST | unique loop id |
| `controller` | MUST | exactly one owner |
| `work_source` | MUST | `{ type: work_file \| inline \| glob, query }` — where each iteration's work comes from |
| `stop_conditions` | MUST | at least one of `max_runs`, `max_runs_per_day`, `budget_usd_per_day`, `until`, or a non-empty `halt_on[]` |
| `schedule` | SHOULD | `{ cron }` or `{ interval_ms }` or `{ on_event }` |
| `budget` | SHOULD | per-loop and per-run caps |
| `digest` | SHOULD | `required` to write a digest (§18) after each inner run |

### 23.2 Rules
- A `LOOP.md` with **no** stop condition **MUST** be refused (a loop that can't stop is unsafe).
- The outer loop **MUST NOT** escalate privilege: every action in each inner run is still subject to §21.
- Loop state (runs today, spend today) **MUST** persist (e.g. `runs/loop-<id>/state.json`) so stop conditions hold across process restarts.

---

## Appendix A · `IDENTITY.md` frontmatter JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agentpro.dev/scroll/identity-1.9.json",
  "title": "SCROLL IDENTITY frontmatter",
  "type": "object",
  "required": ["name", "title", "version", "runtimes", "model", "capabilities"],
  "additionalProperties": true,
  "properties": {
    "name":    { "type": "string", "pattern": "^[a-z][a-z0-9-]*$" },
    "title":   { "type": "string", "minLength": 1 },
    "version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "pronoun": { "type": "string" },
    "language":{ "type": "string" },
    "position":{ "enum": ["c-suite", "above-c-suite", "outside-org", "runtime"] },
    "reports_to": { "type": "string", "pattern": "^(user|role:[a-z][a-z0-9_-]*|[a-z][a-z0-9-]*)$" },
    "serves":  { "type": "array", "items": { "type": "string", "pattern": "^(role:)?[a-z][a-z0-9_-]*$" } },
    "runtimes": {
      "type": "array", "minItems": 1,
      "items": { "enum": ["cowork", "codex", "gemini", "claude-subagent", "voice", "a2a"] }
    },
    "model": {
      "type": "object",
      "required": ["primary"],
      "properties": {
        "primary":  { "type": "string" },
        "fallback": { "type": "string" },
        "voice":    { "type": "string" },
        "voice_id": { "type": "string" }
      }
    },
    "capabilities": {
      "type": "array",
      "items": { "type": "string", "pattern": "^(fs|web|shell|mcp|vision|voice|dispatch|memory|skills|ask|message|tasks)\\.[a-z_]+$" }
    },
    "dispatch": {
      "type": "object",
      "properties": {
        "authority":     { "enum": ["none", "low", "medium", "high"] },
        "can_dispatch":  { "type": "array", "items": { "type": "string" } },
        "spawn_template":{ "type": "string" }
      }
    },
    "hard_rules": { "type": "string" },
    "memory":     { "type": "object" },
    "a2a":        { "type": "object" }
  }
}
```

---

## Appendix B · Minimal valid agent (L0)

```
agents/echo/
├── IDENTITY.md
└── SOUL.md
```
`IDENTITY.md`:
```yaml
---
name: echo
title: Echo
version: 0.1.0
runtimes: [cowork]
model: { primary: claude-haiku-4-5 }
capabilities: []
---
```
`SOUL.md`:
```
You repeat the user's message back, clearly and briefly.
```

---

## Versioning

This spec is versioned with semver. Renderings and validators declare the spec version they target. Backward-incompatible changes increment MAJOR. Agents declare their own `version` independently of the spec version.

| Spec | Reference impl | Adds |
|---|---|---|
| 1.9 | 0.14.0 | §38–§41 people in the agent team: person cards, binding by role, person-owned steps, approvals checked against the approver's card, privacy audit. Backward compatible: `pronoun` and `reports_to: user` still validate (warnings); without person cards, approvals behave as in 1.8. |
| 1.8 | 0.13.0 | §34–§36 skills |
| 1.7 | 0.12.0 | §31–§33 subject memory |
| 1.6 | 0.11.0 | §28–§30 effect confirmation, ungraded ≠ pass, fixture provenance |
| 1.5 | 0.9.0 | §24–§27 ledger, planner, try-budget, proof |
| 1.4 | 0.8.0 | §21–§23 risk tiers, grounding, `LOOP.md` |

*SCROLL Specification v1.9 · reference implementation `@agentpro/scroll` 0.14.0 — Agent Pro. Companion: `README.md`, `AGENTS.md`, `templates/agent/`, `templates/work/LOOP.md`.*

---

## §24–27 — v1.5 · Trackable · Self-Driving · Honest-on-Failure

New `LOOP.md` fields (all OPTIONAL — backward compatible; `validateLoop` type-checks them only when present):

- **§24 `ledger:`** — a human-readable tracking table that spans runs. `local://path.csv|md` (core, zero-dep), or an external URI scheme resolved by an **app-layer adapter** reading `runs/loop-<id>/ledger.jsonl` (the core ships no third-party client). After **every** output — pass or fail — a runner **MUST** append one row: `ts · loop · iteration · task · status · tries · proof · digest`. If `ledger` is unset and the loop is driven through an agent or skill, the runner **MUST** ask the operator where to store it and **MUST NOT** silently default to a remote store. A bare CLI defaults to `local://runs/ledger.csv`.
- **§25 `planner:`** — a command executed **once, before** the loop, that **generates** the backlog (self-planning: study a reference → enumerate outstanding work → emit `WORK`). It is a plain command, deterministic, outside the model. Absent → v1.4 behaviour (consume pre-existing work).
- **§26 `max_tries_per_task:`** (default 3) — each task gets N tries of its own; pass → stop early. Exhausted and still failing → record ledger `status: failed` + proof, then **CONTINUE to the next task**. Halt only on `gate_denied` (immediately, no retry) or when `verify_fail ∈ halt_on` (after exhausting N — backward compat). A try-budget is **per task**, never global.
- **§27 Proof-pack** — `result.proof` (a path/URI to inspectable evidence) is recorded in the ledger. A **failure MUST carry proof** of what was attempted; silent failure is non-conformant. Rendering visual evidence is app-layer; the core mandates only that proof **exists** and is **recorded**.

Reference impl: `lib/loop.js` (`validateLoop` + `runLoop`) + `lib/ledger.js`.

---

## §28 — Effect confirmation (v1.6)

> Reference impl: `lib/effects.js` (`confirmEffect` · `evalExpect` · `rejectUnknownFields`), audited by `scroll audit`.

A write that *reports* success is not evidence that the write *happened*.

- A runner **MUST** classify an action as a WRITE when it mutates state outside the run's own memory (tiers `reversible_write | external_comm | financial | destructive`, §21).
- A WRITE **MUST NOT** be considered successful merely because the call returned a non-error status. Self-reported success is not evidence.
- The runner **MUST** confirm the effect with an **independent read-back**. The read-back **MUST** be a separate read operation; the write's own response **MUST NOT** be used as its confirmation.
- If the write reports success but the read-back does not satisfy `expect`, the runner **MUST** emit `effect_unconfirmed` and mark the step **failed**. This is a failure, not a warning.
- A WRITE at tier `financial | destructive` with no declared `confirm` **MUST** be flagged by `scroll audit`; a conformant runner blocks by default (fail-closed).

Declared as data, alongside `risk`/`ground` (§21.3, §22) — never in prose:

```json
"issue_invoice": {
  "risk": "financial",
  "ground": ["product_code", "amount"],
  "confirm": { "probe": "lookup_invoice", "expect": "$.status == 'issued'" }
}
```

Events: `effect_confirmed { tool, probe, ok, observed }` · `effect_unconfirmed { tool, expected, observed }`.

**Corollary — fail-closed on unknown input.** An interface that receives a field it does not understand **MUST** reject the request (a 4xx-equivalent carrying `rejected[]`) and **MUST NOT** ignore it silently. Silently dropping input is how a system comes to report success for work it never did; an agent reading that success will then report it onward in perfect good faith. The agent is not lying — the interface is.

---

## §29 — Ungraded is not pass (v1.6)

> Reference impl: `lib/eval.js` — `case.verdict` is `'pass' | 'fail' | 'ungraded'`; `report.ungraded` counts them; `ok` requires ≥1 graded case and every graded case passing.

A verdict is **ternary**, never boolean:

| verdict | meaning |
|---|---|
| `pass` | graded — at least one check actually ran, and every check passed |
| `fail` | graded — a check ran and failed |
| `ungraded` | **no check ran** — no rubric declared, tooling absent, or the checker itself errored |

- `ungraded` **MUST NOT** be coerced to `pass` anywhere: API, UI, ledger (§24), digest, or gate.
- A UI **MUST** render `ungraded` distinctly from `pass` — a neutral marker, never a check-mark.
- A `must-approve` gate (§21) treats `ungraded` as `fail` (fail-closed).
- Ledger `status` accepts `ungraded`; a digest (§18) **MUST** count it separately. "3 done" where two were never graded is a false report.
- When a checker cannot run (missing dependency, unavailable tool), its result is `ungraded` — **never** `pass`.

Rationale: a harness in which "not measured" and "measured and good" are indistinguishable renders every green number it emits meaningless — and makes §27 proof worthless.

---

## §30 — Fixture provenance (v1.6)

> Reference impl: `lib/eval.js` (`parseFixture`) prints provenance beside every verdict; `scroll audit` warns on a missing/invalid provenance and on a suite that is entirely `synthetic`. The shipped scaffold declares its own provenance.

§8 requires grading the end state rather than the execution path. It is silent on **where the precondition came from** — and that silence lets a green suite prove nothing.

If a case's precondition was created **by hand** rather than by the product's own path, the case says nothing about that path. Every gold case (§8) **MUST** declare its fixture's provenance:

```yaml
---
id: case-01-...
fixture:
  provenance: product-path | recorded | synthetic   # REQUIRED
  setup: <command/path that creates the precondition>   # REQUIRED when provenance = product-path
---
```

- `product-path` — the precondition is produced by the product's own path, the one an operator takes. **Default.**
- `recorded` — captured from a real environment; carries a hash and a source.
- `synthetic` — hand-constructed. **MUST** carry a `justification`, and **MUST NOT** count as evidence for the path that would otherwise have created that precondition.
- Any capability that carries state (a schedule, an account, a permission, a subscription) **MUST** have at least one `product-path` case covering its **arm/setup** path — not only its **execute** path. Exercising `execute` against a hand-made precondition leaves `arm` completely unverified while the suite stays green.
- `scroll eval` **MUST** print provenance beside every verdict; `scroll audit` **MUST** warn when a capability is covered only by `synthetic` cases.

**Never hand-mutate the state of the system you are grading.** If a fixture must be hand-patched before a case will run, the case has just found a defect — not an inconvenience.

---

## §31 — Subject memory (v1.7)

> Reference impl: `lib/memory.js` (`openStore`) · CLI `scroll memory …` (`lib/memory-cli.js`) · read path wired into `scroll run` (`task.subject`) · tests `test/v17.smoke.mjs`, including a mutation self-test.

§7 is the memory an **agent** keeps about its own work. §31 is the memory an agent keeps about the **subjects it serves**: a person, a group, a project, or another agent. The rule that governs everything below: **the agent proposes, the machine decides.** A model may suggest that something be remembered; only a gate written in code turns it into a durable fact.

### 31.1 Store and identity

- Subject memory lives in a **data plane outside git and outside every workdir**. A store located inside a run's workdir **MUST** be refused (`store_inside_workdir`). Any raw tool path (shell, file read/write) that resolves into the store **MUST** be treated as tier `destructive` before normal tier resolution — the loader and the `memory.*` capabilities are the only legal way in.
- A subject id is opaque and immutable: `s_<region>_<16 hex>`, never derived from personal data. The region is part of the id, so routing is a path.
- Storage is sharded by the hex of the id: `subjects/<hh>/<hh>/<sid>/`. **One directory per subject; no file may hold the content of two subjects** (search indexes, ledgers and caches included).
- Channel identities (`telegram:<id>`, an email, a phone, `device:<id>`, `mcp:<client>`) are **aliases**: stored as `sha256(normalize(alias)) → sid`. An alias that already points at another subject is refused (`alias_conflict`); merging is an explicit operation.
- Raw sids never leave the data plane: events, digests and ledgers carry an HMAC pseudonym.

### 31.2 Journal leads, projections follow

```
<sid>/journal/CURRENT · seg-NNNN.jsonl · seg-NNNN.jsonl.sealed   # source of truth for facts
<sid>/profile.json · index.md · days/ · sessions/*.card.md        # projections — rebuildable
```

- A write takes the subject lock, appends, fsyncs, and **confirms by reading back** (§28) before it counts. Projections are replaced by atomic rename.
- A checkpoint is a **structural** marker in journal order; the tail after it is ordered by `(ts, append order)`, so replaying a journal twice yields byte-identical projections, and an op appended after a checkpoint with an earlier clock still survives.
- Consolidation is bracketed (`consolidate_start` … `consolidate_end`), writes a checkpoint as the first line of a new segment, seals the old ones, and appends an **anchor** — a running hash over every journal line. `fsck` recomputes it; a line edited behind the store's back breaks every later anchor. A torn tail is skipped on read and truncated by `fsck --repair`.
- Invariant (machine-checked): at most **one active fact per `(key, about)`**; a new value supersedes the old one, which stays queryable with `superseded_by`.

### 31.3 Fact schema

`id · key (namespace.key, registered in the taxonomy) · value · about (self | person:<slug> | group) · provenance · evidence · sensitivity · derived_from? · expires_at? · status`

Provenance is a closed vocabulary: `stated` (the subject said it) · `agent_observed` · `system_verified` · `user_edit` · `derived` (consolidated from cited facts). Evidence for `stated` / `agent_observed` is `{ ref: "<session>#<seq>", quote }` — a pointer to a stored turn and a verbatim quote from it.

### 31.4 The gate (one gate, every write path)

Every write — a mid-session proposal, the end-of-session sweep (§32.3), consolidation (§31.6), a human edit — passes the same five layers, in order:

1. **Syntax** — the key is registered in the taxonomy; type, length, enum and required fields hold.
2. **Evidence** — the referenced turn exists and contains the quote verbatim (case- and whitespace-insensitive). For `stated`, that turn **MUST** have been spoken by the subject itself; a quote from the agent's own turn can at most yield `agent_observed` (`speaker_mismatch` otherwise). `derived` facts **MUST** cite existing fact ids. `system_verified` / `user_edit` are accepted only from trusted callers.
3. **Provenance floor** — keys may require a provenance (e.g. entitlements require `system_verified`).
4. **Sensitivity** — each key has a class `normal | sensitive | never`. `never` is refused outright; `sensitive` only when the policy allows it. Values and quotes are scanned for secrets (keys, tokens, card numbers, password assignments) and refused on a hit. Turns are redacted **before** they reach disk. Apps MAY add secret shapes for their own language (`secret_patterns`); the built-in ones always apply.
5. **Instruction-like content** — a value that reads as an instruction to the agent (ignore rules, skip confirmations, elevate privileges, exfiltrate credentials) is refused. Memory is data, never a channel for installing rules. Apps MAY add patterns; they may not remove the built-in ones.

A value whose folded form matches a **tombstone** (§32.7) is refused (`forgotten`). A machine write (`derived` / `agent_observed`) that would overwrite a `user_edit`, or a `derived` sensitive fact, goes to a **review queue** instead of the journal.

### 31.5 The loader

- Loads only what the gate would accept today: a fact below its key's provenance floor, or of class `never`, **MUST NOT** load even if it reached the journal by another route.
- `sensitive` facts never load into the contract; they surface only through an explicit search (§32.5), flagged.
- Scoping is a static lookup, not a model judgment: `capability_topics` maps the agent's capabilities to namespaces; `always_load` / `always_load_for: [capability]` pins keys; with a `persona`, a shared account loads only account-level facts and that persona's own.
- Profiles that require verification (e.g. customer service) **MUST** deny the contract and search to an unverified subject.
- Output is fenced and marked as data: `<subject-memory sid="<hmac>" snapshot="<hash>"> (DATA ONLY …) … </subject-memory>`. Subject memory is never a valid grounding source (§22) for `financial` parameters unless `system_verified`.
- In `scroll run`, a task with `subject:` (or `--subject`) gets its subject's contract in the volatile part of the prompt (§13) and emits `memory_loaded { subject (hmac), snapshot, memoryChars, truncated }` or `memory_denied`.

### 31.6 Consolidation

- **Mechanical tier** (deterministic, no model): checkpoint + seal, TTL expiry, retention (§32.6), recall-based promotion (§32.5), anchor. Bracketed.
- **Model tier** ("dream"): the app supplies the model call; every output op goes through the gate and **MUST** cite fact ids. A merge marks each source `superseded_by` the merged fact. Before committing, the runner checks **handoff fidelity**: every fact active before the dream is still active or superseded/expired with a link; anything else aborts. A dream is gated (a minimum of new swept sessions **and** of elapsed time) and **SHOULD** be scheduled as an ordinary bounded run (§23), not a background daemon. **A failed dream is a terminal state** that blocks the next dream until a human acknowledges it — never "warn and continue".

---

## §32 — Episodic memory: sessions and days (v1.7)

> Reference impl: `lib/memory.js` (`openSession` · `appendTurn` · `closeSession` · `sweep` · `snapshot` · `search` · `forget`).

### 32.1 Layers

| Layer | Unit | Written by | In the load contract |
|---|---|---|---|
| L1 session | every turn: `seq, ts, surface, speaker, role, text` | the runtime, append-only | never wholesale; only the capsule (§32.4) |
| L2 card | a summary of one session; every line cites turn `seq`s | the sweep (model, gated) | via day notes |
| L3 day | `days/YYYY-MM-DD.md`, rebuilt **deterministically** from cards + facts of that day | the machine | today and yesterday |
| L4 facts | §31 | the gate | by topic/capability |
| L5 procedure | the agent's own lessons (§7) | the agent | stable prefix |
| index | "what is in memory": namespaces, counts, date ranges | the machine | always |

### 32.2 Sessions on conversational surfaces

§14 runs end at a machine-defined point. A conversation does not, so the boundary is part of the contract: a session closes on `idle | closed | daily | compaction | explicit | reset`. The app decides the thresholds; closing before a context compaction is the **pre-compaction flush**. A subject MAY have several sessions open at once (one per surface); each has its own file, so they never contend.

### 32.3 Sweep

On close, `sweep(session, summarize)` runs the app's summarizer over the session and is **idempotent**: a watermark records the last swept `seq`; a crash means it re-runs, and duplicate facts are no-ops.
- Card lines without a valid citation, or that read as instructions, are dropped. A line citing a turn that produced a `sensitive` fact is kept out of the card (cards feed day notes, which load every session).
- Proposed facts carry `{ seq, quote }` and pass the §31.4 gate.

### 32.4 The load contract

Built by code, in a fixed order: index → facts → group facts (§33) → day notes (today, yesterday) → **capsule** (the last K turns across every surface, excluding the running session; turns that produced a sensitive fact are masked) → open items. Over budget, sections are cut from the bottom **with a marker**, never silently.

- The contract is **frozen for the session**: writes made during the session do not change it (the agent sees them through tool results and search). This keeps the prompt prefix cacheable.
- It is **hashed**; the session's first line records the hash, so "what did the agent know at that moment" can be replayed.
- Open items are context, not an agenda: an agent does not raise them unprompted.

### 32.5 Search

`search(query, scope, since, limit)` is deterministic: diacritic-insensitive prefix matching over the subject's own files (facts including superseded and expired ones, turns, cards, days), ranked by `(matched terms desc, ts desc, ref asc)`. It returns bounded, labelled hits. **Every read is recorded** in the subject's access ledger (`reader`, `session`, `query`, `refs`). Facts recalled in at least `min_recalls` reads across at least `min_sessions` sessions are pinned by the mechanical tier — counts decide, not a model. An index (for example SQLite FTS) MAY be added as a projection, provided it is rebuildable, per-subject, and returns the same ranked results as the scan.

### 32.6 Retention

Raw turns older than `retention_days` are removed by the mechanical tier; cards, day notes and facts remain. Facts keep their own quote, so evidence survives the turn it came from.

### 32.7 Forget

`forget(fact)` writes a tombstone (a hash of the folded value) and **cascades**: a `derived` fact whose every source is forgotten is forgotten too. The content is then removed **everywhere it lives** — journal lines (including checkpoints in sealed segments) become stubs, the quote and value are scrubbed from stored turns (policy `forget_purges_turn`, default on), card lines carrying them are dropped, access-ledger entries and review items quoting them are removed, and projections are rebuilt. A `redact` op is appended so `fsck` knows anchors before it were rewritten on purpose. Conformance test: after a forget, a grep of the whole store for the content finds nothing, and re-proposing it — even from a new session — is refused.

`edit(fact)` supersedes with provenance `user_edit`; machines cannot overwrite it except through the review queue (§31.4). Erasing a whole subject is `destructive` and requires approval; it removes the directory and every alias, and the erase ledger keeps only the pseudonym.

---

## §33 — Groups, shared accounts and many surfaces (v1.7)

> Reference impl: `lib/memory.js` (`addMember` · `removeMember` · `proposeToGroup`) and `lib/memory-tracker.js` (`createScopedMemoryTracker` — channel-agnostic 3-axis `user` / `group` / `member` tracker + L5 lessons + sweep/dream orchestration for any surface).

- Subject kinds: `person | group | agent | project`. A **group** (a household, a team, a company) is a subject with its own store.
- Membership is a `system_verified` op written to both journals: `member_of { group, role, read: [namespaces], write: [namespaces] }`. Only trusted callers create it.
- A person's contract includes the group facts in the namespaces they may read. **It never includes another person's facts, even within the same group** (conformance: a canary planted in one member's memory never appears in another member's contract or search).
- A member may propose a group fact only in a namespace they may write, with evidence from **their own** turn.
- What a person says about a third party is stored in the speaker's memory under the speaker's subject (`about: person:<slug>`) — relationship context, never a profile of the other person.
- Session scope across surfaces is policy: `main` (one owner, every surface continues one conversation), `per-surface`, or `per-peer`. Whatever the scope, every surface writes to the same subject.
- Another agent acting for the subject (e.g. through MCP) is a different speaker: its turns can yield `agent_observed`, never `stated`. Its reads are recorded like any other (§32.5).

### SPEC / APP boundary

| SPEC fixes (conformance) | APP decides (policy) |
|---|---|
| layout and isolation · journal + projections + anchors · the five-layer gate · tombstones and forget cascade · loader laws (provenance floor, sensitive out, persona, verification) · frozen, hashed, fenced contract · deterministic search + access ledger · bracketed consolidation and dream rules · group read/write by namespace | store location and region · taxonomy, sensitivity classes and extra instruction patterns · budgets, capsule size, retention, TTLs · session boundaries and scope · promotion and dream thresholds · who reviews · labels and language of the contract |

A memory need the mechanism does not cover is a proposal to change this spec — not a workaround inside the app.

---

## §34 — Loading skills (v1.8)

> Reference impl: `lib/skills.js` (`openSkills` · `resolveSources` · `findSkillDirs` · `registerSourceLayout`). CLI: `scroll skill list | view | index | sources`.

Skills written for one agent runtime are folders in an open format, so an agent built on SCROLL can use them as they are. The loader decides, in code, which skills an agent may see; the model only ever sees what passed.

### 34.1 Format
A skill is a folder holding `SKILL.md` in the open Agent Skills format (§19.3). `name` is 1–64 characters of lowercase letters, digits and single hyphens; `description` is at most 1024 characters and says what the skill does and when to use it. SCROLL-specific fields live under `metadata.scroll`: `requires`, `fallback_for`, `platforms` (§34.5). Fields other runtimes define (for example `metadata.hermes.requires_tools`, `disable-model-invocation`) **SHOULD** be honored when their meaning is clear. A loader **MUST** read block scalars, quoted strings and wrapped lines in the frontmatter; a description must never be lost to a YAML subset.

### 34.2 Sources and precedence
Sources are read in this order; for a given name the first source wins and the others are reported as shadowed:

1. `agents/<name>/skills/` (trust `trusted`)
2. repo `skills/` (trust `trusted`)
3. `skills.external_dirs` in `scroll.config.*`, in the order listed, then `SCROLL_SKILLS_DIRS` (path-delimited). Each entry is a path or `{ path, trust, layout, max_depth }`; `~` and `${VAR}` expand. Default trust: `community`.

- External sources are **read-only**: a loader **MUST NOT** write to them.
- Inside one source, when several folders declare the same name (a plugin cache keeping old versions), the copy with the newest `SKILL.md` wins.
- A `layout` says how to find skill folders in a source. `dir` (default): every directory holding a `SKILL.md`, at any depth up to `max_depth` (default 6), following directory symlinks once. `claude-code-plugins`: only the plugin versions its `installed_plugins.json` lists as installed. Layouts are extensible.
- An agent with `skills_external: false` sees only sources 1–2.
- Nothing outside the configured sources is read. A tool **MAY** report well-known skill folders of other tools that exist on the machine (`scroll skill sources --detect`), but adding one is the operator's decision.

### 34.3 The index
- The index is one block in the stable prefix (§13), after hard-rules:
  ```
  <available_skills>
  <one fixed line telling the model to read a skill with skill_view before using it>
  - <name>: <description>
  </available_skills>
  ```
- It **MUST** be a deterministic function of the visible skill set, the pinned list and the limits: lines sorted by name, whitespace collapsed, angle brackets removed (a description cannot close the block). Two builds over the same set **MUST** be byte-identical.
- The index is **frozen** when a session or run opens it. Skills added, removed or changed later are announced in the volatile suffix on the next turn (`refresh` returns the notice); the prefix is rebuilt only when asked.

### 34.4 Read tools
Two tools, gated by the capability `skills.read`. Their names are data (default `skill_list`, `skill_view`).
- `skill_list(query?, limit?, offset?)` — name and short description of visible skills; with a query, a deterministic search over name and description, folded for diacritics.
- `skill_view(name, path?)` — without `path`: the `SKILL.md` body, preceded by the tool-name map for this runtime (§35.2) and the list of files in the skill. With `path`: one text file inside the skill folder.
- `skill_view` **MUST** refuse absolute paths, `..`, any path whose real location (after symlinks) is outside the skill folder, binary files and files above the size cap.
- Before serving, the loader **MUST** compare the skill's files with what it scanned. A changed skill is validated, scanned and gated again; one that no longer passes is refused for the rest of the session.
- Every view is an event (`skill_viewed`, `skill_denied`) with the skill's content hash.

### 34.5 Visibility
A skill reaches the index and the tools only if all of these hold:
- it is valid (§36.1) and passed the security scan (§36.2);
- `disable-model-invocation` is not `true` (a skill meant to be started by a person only);
- the current platform is in `platforms`, when declared (`macos | linux | windows`);
- none of its `fallback_for` tools or capabilities is available (a fallback appears only when the primary tool is missing);
- its compatibility status is not `hidden` (§35), unless the operator overrides it.

### 34.6 Caps
The index holds at most `skills.max_index` skills (default 150) and `skills.max_index_tokens` tokens (default 6000). Descriptions are shortened first; then skills are dropped lowest-ranked first. Rank: pinned (`IDENTITY.skills`, in order) → usage counts supplied by the application → source order → name. A skill left out of the index stays reachable through `skill_list`.

### 34.7 Steps that name skills
A `WORK.md` task (or `scroll run --skill a,b`) MAY list `skills: [...]`. The runner loads each in full into that step's volatile suffix. If any of them is not visible, the step **MUST NOT** run: it is blocked (`gate_blocked`, reason `skill`) and no model is called.

---

## §35 — One skill, many runtimes (v1.8)

> Reference impl: `lib/skills.js` (`TOOL_ALIASES` · `skillRequirements` · `compatStatus` · `writeCompatFile`). CLI: `scroll skill scan`.

### 35.1 What a skill needs
A loader derives a skill's requirements from:
- **declared** (hard): `allowed-tools`, `metadata.scroll.requires`, `metadata.hermes.requires_tools`, operator overrides;
- **named in the text** (soft): MCP tool names (`mcp__server__tool`, `Server:tool`) and known tool names of other runtimes. Ordinary words (`Read`, `Task`, `patch`) count only as `` `Name` `` or "Name tool".

Foreign tool names map to SCROLL capabilities through a table that is **data** (`TOOL_ALIASES`, extended by `skills.tool_aliases` in config). A name with no portable equivalent maps to nothing and is satisfied only by a tool of exactly that name. A missing planning tool (`tasks.track`) never counts against a skill.

### 35.2 Status
Against what the agent has (capabilities, tool names, MCP servers):
- `ok` — everything is available.
- `partial` — some tools named in the text are missing; the skill is shown, and `skill_view` says which ones are not available here.
- `hidden` — a declared requirement is missing, or most of the tools its text names are missing (at least two, and more missing than present): a skill built around another runtime's tools.

`skill_view` prepends a map from the names the skill uses to this runtime's tools (from `TOOLS.md` bindings, §5.2), e.g. `AskUserQuestion → ask_owner`. The skill's own text is never rewritten.

### 35.3 The sidecar
`scroll skill scan` writes `skills-compat.json` (per agent: `agents/<name>/skills-compat.json`): per skill its source, trust, content hash, state, status and missing tools. The operator corrects the machine under `overrides`: `{ "<skill>": { "status": "ok" | "hidden", "map": { "<ForeignTool>": "<local tool>" }, "requires": [...] } }`. Overrides survive every rescan. An override can show or hide a skill; it can never admit a skill the security scan blocked.

---

## §36 — Checking and grading skills (v1.8)

> Reference impl: `lib/skills.js` (`validateSkill` · `scanSkillDir` · `SECURITY_RULES` · `checkSkills`), `lib/skill-eval.js` (`runSkillEval`). CLI: `scroll skill check | eval`; `scroll check` and `scroll audit` include skills.

### 36.1 Validation
`name` and `description` present and well-formed; `description` and `compatibility` within limits; files the body links to exist and stay inside the folder; the body under 500 lines (warning); references one level deep (warning). For skills the repo ships (sources 1–2) a broken SHOULD is an **error** and fails `scroll check`; for external skills it is a warning, and only a skill that cannot be addressed (no name, no description, a name outside the pattern) is kept out.

### 36.2 Security scan
Every text file in a skill (up to a file and size cap) is scanned line by line. Rules are data; each has a severity:

| rule | severity |
|---|---|
| a live credential (`secret`); exfiltration of credentials or private files; a reverse shell; bidirectional control characters | critical |
| zero-width hidden text; instructions to drop earlier instructions or hide actions from the user; deleting a home or root folder; erasing a disk; downloading and running code unseen; writing to shell start-up files or `authorized_keys` | high |
| installing scheduled jobs; `sudo`; force-pushing | medium |

- A phrase quoted as an example (`"ignore previous instructions" — do not obey it`) is reported at medium.
- Whether a finding **blocks** depends on the source's trust: `builtin` and `trusted` block at critical, `community` at high, `untrusted` at medium. Lower findings are reported.
- A blocked skill **MUST NOT** reach the index, `skill_view`, a step, an install (`scroll skill add`, `scroll plugin add`) or an eval. There is no flag that forces it in; changing a source's trust is an edit to configuration, made by a person.
- Findings name the rule, file and line, never the matched text.
- `scroll audit` binds its record to the content of the agent's and the repo's skills: editing one after the audit fails `audit --verify`.

### 36.3 Evaluation
Cases travel with the skill: `evals/*.md` (gold cases, §8) or `evals/evals.json` (`{ "evals": [{ "id", "prompt", "expected_output", "expectations", "files", "checks" }] }`).
- Each case runs on each named model **with** the skill and **without** it (the baseline), `runs` times each. Machine checks grade both sides.
- An optional judge compares the two final answers **blind**: it never sees the skill, and the order of the answers alternates case by case.
- Verdicts are ternary (§29). A case with no machine check and no judge result is `ungraded`.
- The record (`.scroll/skill-eval/<name>.json`, bound to the skill's content hash) states a recommendation: `keep` (passes, and beats the baseline somewhere), `retire-or-rewrite` (the model does as well without it), `fix` (fails on some model), `ungraded`.
- A skill the repo ships **SHOULD** have at least three cases.

### SPEC / APP boundary (skills)

| SPEC fixes (conformance) | APP decides (policy) |
|---|---|
| the format and its validation · source order and precedence · read-only external sources · the scan and what blocks per trust level · read-time recheck · `skill_view` confinement · a deterministic, frozen index · hidden ⇒ not offered · a step never runs without the skills it names · with/without evaluation and ternary verdicts | which external folders, and how much each is trusted · index caps and usage ranking · tool names and the alias table · overrides in the sidecar · which models a skill is evaluated on |

---

## §38 — Deployment `USER.md` (v1.9)

> Reference impl: `lib/user.js` (`openUser` · `parseUserMd` · `validateUserMd` · `importWorkspaceUserMd` · `guard` · `checkHashChange`) wrapping `lib/people.js` (`validateCard` · `canApprove`) · CLI `scroll user check|new|show|import` and `scroll check user`.

An agent folder describes a reusable role (`IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `hard-rules.md`, `evals/`). It stays free of real people and deployment secrets. Each deployment adds **one `USER.md`** at the deployment root stating whom the agents work for and which internal people may assign or approve work. Customers and external contacts never go into `USER.md` — they live in subject memory (§31).

### 38.1 Location
One file per deployment: `--user <path>`, then `SCROLL_USER_FILE`, then `user.file` in `scroll.config.*`, then `<repo>/USER.md`. `USER.md` **MUST NOT** live inside `agents/` (§41). Legacy per-person cards under `people/<slug>.md` remain supported when no `USER.md` is present.

### 38.2 Frontmatter (machine-only)
Frontmatter is read only by code and **NEVER** serialized into the model prompt:

- `principal` (MUST, map): `kind: person | org`, `name` (<= 120 chars), optional `self`, `call_others` (<= 60 chars), `handoff` (role name, default `owner`).
- `people` (OPTIONAL, list of internal members only): `{ id, name, call, self?, role|roles, approve, max_amount, channels?, channel_ids? }`. `id` MUST match `^[a-z][a-z0-9-]*$` and MUST NOT look like a phone number, email, handle or URL; applications bind verified channel sender IDs to `id`. Each entry is validated through `validateCard()` from `lib/people.js`.

### 38.3 Body & sections
The markdown body is capped by code (`user.max_body_chars`, default **3,000 characters**). An over-cap body is an error and `USER.md` does not load. Body and frontmatter are scanned for secrets and prompt-injection instructions (§31.4). Sections split cleanly into:
- `# About <principal>` — internal-only context, loaded only for internal turns.
- `## May say on behalf` — public facts loaded for external turns as well, and accepted as a valid grounding source.
- `## Must not say` — topic-level boundaries loaded for external turns as well (state the topic, never the secret itself).

### 38.4 Ownership, hash audit, and external workspace import
- Agents never write `USER.md`; applications call `guard(path)` at tool boundaries (raw writes return `allowed: false, tier: 'destructive'`).
- Every run hashes `USER.md` (`checkHashChange`); an out-of-band edit emits `user_md_changed` and writes a hash-chained record to `audit.jsonl`.
- `importWorkspaceUserMd()` imports plain external workspace `USER.md` files: human-written prose becomes the `USER.md` body, while agent-authored sections/lines (`## Notes`, `## Learned`, `## Observations`, `[agent]`) are separated and routed to the gated subject-memory review queue instead of becoming principal prose.

## §39 — Neutral prompt framing & role binding (v1.9)

> Reference impl: `lib/user.js` (`render`) · `lib/scroll.js` (`checkAgent`, `buildAgent`) · `lib/runtime.js` (`stablePrefix`, `context_loaded`).

### 39.1 Agent roles stay portable
`IDENTITY.md` declares `serves: [owner]` (or `role:owner`) and `reports_to: role:<role>` or an agent name. A `person:<slug>` value in either is an error.

### 39.2 Neutral prompt header (never "user")
When loading `USER.md` into the stable prefix (both compact and full paths, alongside `hard-rules.md`), the loader wraps allowed body sections under a neutral header (**"The party this agent works for"** by default, configurable via `user.labels`), never using the word `"user"`, so models never mistake an external chat counterparty for the principal. Every run emits `context_loaded { files, chars }` listing the exact files and character counts that reached the model.

## §40 — Internal authority at the gate & in `WORK.md` (v1.9)

> Reference impl: `lib/user.js` (`canApprove` · `approversFor`) · `lib/people.js` · `lib/runtime.js` (`personStep`, approval check, `audit.jsonl`, `notify`).

### 40.1 A person owns a step
`owner: person:<slug>` (§9.1). The controller **MUST** be an agent. The runner emits `human_task_requested` + `notify`, pauses the dependent branch, and resumes only when that exact person writes `control/done/<task-id>.json`.

### 40.2 Checked approvals
When `USER.md` (or legacy `people/`) is active, a `must-approve` gate checks `{ "by": "<id>" }` in code via `canApprove()` against the person's `approve` list (action classes `write|send|publish|pay|delete` or §21 tiers), `max_amount`, and deployment `authority_ceiling`. Decisions (`accepted`, `rejected`, `auto-approved`) append to hash-chained `runs/<id>/audit.jsonl`.

## §41 — Privacy, package boundaries, and canary audit (v1.9)

> Reference impl: `lib/people.js` (`scanForPeople` · `zipEntries`) · `lib/audit.js` (`auditRepo` · `auditPrivacy` · `scanCanaries`) · `lib/installers.js`.

- **Outside every agent folder.** `USER.md` and `knowledge/` live at the deployment root, outside `agents/`, and are warned about when missing from `.gitignore` unless `user.tracked: true`.
- **Never in a shared package.** `scroll audit` fails when a `USER.md`, a `knowledge/` folder, a `people/` folder, or a card-shaped file is found inside `agents/<name>/`, `skills/`, or a plugin bundle / `.plugin` / `.zip` archive. `scroll skill add` and `scroll plugin add` refuse or skip them.
- **Canary content-leak scan.** Private canary markers (`<!-- canary: TOKEN -->` in `USER.md` or `user.canaries` in `scroll.config.*`) are scanned across the contents of `agents/`, `skills/`, and plugin bundles so leaks inside `SOUL.md`, `evals/`, or `lessons.md` fail `scroll audit` and break `audit --verify` (`privacyHash`).

### SPEC / APP boundary (deployment principal)

| SPEC fixes (conformance) | APP decides (policy) |
|---|---|
| `USER.md` schema & validation via `validateCard` · 3,000-char body cap · frontmatter never enters prompt · neutral prompt header (no "user") · `hard-rules.md` loaded on every runtime & build path · `guard()` blocks raw writes · hash-change audit · `canApprove()` checked in code · `USER.md`, `knowledge/`, and canaries blocked from shared packages | where `USER.md` lives · role table & authority ceilings · labels & locale · channel-id to person-id mapping · notification delivery |

## §42 — Per-turn internal vs external boundary & group wall (v1.9)

> Reference impl: `lib/user.js` (`classifyTurn` · `isIdentityQuestion` · `checkAiDisclosure` · `applyAiLabel`) · `lib/runtime.js` (per-turn enforcement) · tests `test/v19-boundary.smoke.mjs`.

Whether a turn is **internal** or **external** is computed by code on **every turn** — never by a static deployment mode or by matching a sender's display name:

- **Verified identity only:** a sender is `internal` only when their verified channel ID (resolved via `channelMap` or `channel_ids` on `USER.md`) or verified internal ID matches a valid person in `USER.md`. Missing sender IDs fail closed to `external`.
- **Group lowest-trust content wall:** in a group chat, speaker authority tracks the speaker, while loaded content and output rules track the **least-trusted participant present**. If any participant is `external`, `contentAudience` is `external` — `# About` private notes never load, write tools are stripped (`toolPolicy = 'none'`), and subject memory is restricted to the chat's own subject (`chat_only`).
- **External output gate:** external turns cannot invoke `reversible_write`, `financial`, or `destructive` tools; replies stay drafts (`decision: 'hold'`) awaiting human approval by default; unreviewed replies for `self`/`org` carry a machine-attached AI label from config/locale; identity questions escalate to handoff for `speaks_as: owner` and require explicit AI acknowledgement for `self`/`org`.

## §43 — `speaks_as`, machine-enforced `style:`, Voice hooks, presets, and reply grounding (v1.9)

> Reference impl: `lib/style.js` (`ENFORCED_STYLE_KEYS` · `validateStyle` · `enforceStyle` · `hasBareNumericSlider`) · `lib/grounding.js` (`collectPrincipalSources` · `groundReply` · `verifyClaimsInvariant`) · `lib/scroll.js` (`AGENT_PRESETS` · `scaffold`) · `lib/runtime.js` (2 official voice hooks) · tests `test/v19-style-grounding.smoke.mjs`.

### 43.1 `speaks_as` & role setup presets
`IDENTITY.md` declares `speaks_as: self | owner | org` (default `self`). `scroll new <name> --preset <preset>` scaffolds standardized English blueprints for the four canonical roles: `assistant` (`self`), `service` (`org`), `proxy` (`owner`), and `teammate` (`self`).

### 43.2 Machine-enforced `style:` block
`IDENTITY.style` accepts **only** keys with deterministic code enforcement: `bubbles` (`>= 1`), `max_chars` (`>= 20`), `emoji` (`>= 0`), `follow_up` (`>= 0`). Any unenforced qualitative key (`warmth`, `humor`, `tone`) fails `scroll check`. `enforceStyle()` strips redundant markdown, enforces emoji/follow-up/bubble ceilings, regenerates at most once on `max_chars` breach (else holds for review), and **never alters numbers, amounts, product codes, dates, or links**.

### 43.3 Two official Voice plugin hooks & safety ordering
Conversational voice modules (persona, affective control, human-like delivery) remain at the plugin/app layer and plug into SCROLL via two hooks:
1. **`beforeTurn()`**: returns volatile turn guidance (`<= 650` chars) appended at the **end** of the prompt after history/deliverable so the stable prefix stays cache-stable. Bare numeric sliders (`warmth: 4/5`) are rejected — plugins must translate levels into concrete behavioral wording.
2. **`shapeOutgoing()`**: runs **after** `groundReply()` on the raw model text. `verifyClaimsInvariant(rawText, shapedText)` verifies the multiset of `(amount, code, date, link)` claims is unchanged; any perturbation reverts and holds the reply. Outbox approvals bind to `shapedHash`.

### 43.4 Reply grounding (principal sources only · 3-tier `grounding_mode` in v2.5.3)
`groundReply()` checks every amount, product code, date, and link in an external reply against **principal-authored sources only** (`collectPrincipalSources`: retrieved `knowledge/` chunks, `USER.md` `May say on behalf`, verified tool outputs across turns in the same conversation — never unverified user messages). It also verifies same-line `code <-> amount` pairs (`pair_mismatch`) and holds unverified high-risk claim classes (`percent`, `time`, `relative_date`, `inventory`, `written_number`) for human review.

`IDENTITY.md` (or the runtime `groundingMode` option) may declare `grounding_mode: strict | balanced | advisory`:
- **`strict`** *(default for 1-on-1 external guest DMs and `speaks_as: org` customer-service bots)*: holds on any unverified amount, code, date, link, pair mismatch, or hold trigger.
- **`balanced`** *(default for `speaks_as: self` / `owner` assistants and teammates in group rooms)*: holds on unverified external URLs, conflicting `code <-> amount` pairs, and unapproved discount percentage promises while logging casual dates/times/conversational numbers as advisory telemetry.
- **`advisory`** *(for owner-declared `trustedRooms`)*: records full grounding telemetry without holding prose, while keeping the §42 Privacy Wall (`# About` / DM memory isolation) and §21–§22 Tool Risk & Action Grounding walls strictly enforced.

Interactive chat runtimes support optional bounded `groundingRetryMax` self-healing regeneration (when no mutating tool side effects have executed), and channel adapters such as `@agentpro/scroll-telegram` enforce a Zero-Leak Group Shield that routes held/error diagnostics privately to the verified owner DM rather than posting raw hold notices or technical errors into group chats.

## §44 — Large deployment knowledge retrieval, conversational mode & source-aware grounding (v1.10)

> Reference impl: `lib/knowledge.js` (`indexKnowledge` · `retrieveKnowledge` · `formatKnowledgeBlock` · `openKnowledge`) · `lib/runtime.js` (`knowledge_retrieved` · conversational deliverable · `<verified-caller>`) · `lib/grounding.js` · `lib/audit.js` · tests `test/v110-knowledge.smoke.mjs`.

- **Deterministic zero-dep `knowledge/` chunking & retrieval:** `openKnowledge()` indexes deployment-root `knowledge/` (outside `agents/`, per §41), splits Markdown by `##`/`###` headings with a bounded per-chunk cap (`maxChunkChars = 1600`, preserving Markdown table headers when sub-splitting), and retrieves top-K chunks via Unicode-folded BM25 + heading + bigram + exact SKU/alpha-code matching.
- **Prompt injection + cache safety:** `runWork()` automatically retrieves relevant chunks from `knowledge/` (or accepts explicit `opts.knowledgeChunks`), injects `<retrieved-knowledge>` into the **volatile** suffix after `stablePrefix` so prompt-prefix caching stays intact, emits `knowledge_retrieved`, and passes the exact same chunks to `groundReply()`.
- **Conversational deliverable mode:** When a turn is external, declares `style:`, uses `voiceHooks`, or sets `speaks_as: org|owner` (or `opts.conversational: true`), `runtime.js` omits the research-report `Verdict / Evidence / Assumptions / Next actions` template so `SOUL.md` and `style:` control natural chat output, and `verify()` validates conversational replies without requiring report headings.
- **Source-aware large-KB grounding:** `grounding.js` recognizes both alphanumeric and uppercase hyphenated alpha codes (`AUR-DLX`, `FDP-STD`), strips trailing backticks on Markdown inline-code URLs, excludes explicitly marked expired/invalid/trap lines from authorized pricing pools, covers hospitality/booking inventory claims, and skips false-positive holds on clock times or percentages that appear verbatim in `principalSources` (or inside explicit refusals).
- **Verified internal caller & clean `USER.md` audit:** Verified internal turns receive a machine-generated `<verified-caller audience="internal" ...>` header; `auditPeople()` skips redundant legacy `people/` `serves`-role warnings when deployment `USER.md` is active.
- **Scale libraries, §42 visibility wall, progressive tools & zero-reboot hot-reload (v2.10):** Documents support optional YAML frontmatter (`title`, `visibility: public | internal | owner_only`, `source_url`, `source_type`, `synced_at`, `valid_from`, `valid_to`) and folder-level `.kb-meta.json` visibility inheritance. `retrieveKnowledge()`, `listKnowledgeFiles()`, and `readKnowledgeFile()` enforce `resolveTurnKnowledgeAudience()` strictly (`external` turns see `public` only; `internal`/team groups cap at `internal`; private owner DMs see `owner_only`). Built-in read-only tools `knowledge_list`, `knowledge_search` (with `folder` scope), and `knowledge_read` (section + pagination, fail-closed `ERR_KNOWLEDGE_ACCESS_DENIED`) enable progressive disclosure over large nested SOP libraries. `openTenantWorkspace()` supports a 3-layer stack (`tenant:user-docs` > `tenant:shared-knowledge` / `extraLayers` > `pack:shared`), and `ScrollAgentHost.reloadKnowledge()` hot-swaps the index in-memory without rebooting the host or invalidating Region A prompt caches (`test/v210-knowledge-scale.smoke.mjs`).

## §45 — Interactive multi-turn chat session runtime (v2.0)

> Reference impl: `lib/chat-session.js` (`createChatSessionRuntime`) · `lib/scroll.js` (`scroll chat`) · tests `test/v20-chat-tools-mcp.smoke.mjs`.

SCROLL 2.0 extends the batch `WORK.md` runner with an interactive, streaming, per-conversation **Chat Session Runtime** that enforces every SCROLL safety primitive on every live chat turn:

- **Per-conversation durable transcripts & auto-compaction:** each conversation persists turns to an append-only JSONL transcript outside the agent folder (`0600`) and automatically compacts older turns into a deterministic (or caller-summarized) summary record when context crosses `compactAtChars`.
- **Per-turn SCROLL enforcement:** every turn runs `classifyTurn` (§42 boundary & group lowest-trust wall), subject memory snapshot (§31–§33, gated to `principal_and_team`), `retrieveKnowledge` (§44), Voice Hook 1 (`beforeTurn`, rejecting bare numeric sliders per §43), live multi-round tool calls (§47), `groundReply` (§43–§44), `enforceStyle` (§43), and Voice Hook 2 (`shapeOutgoing`, verified by `verifyClaimsInvariant` so voice shaping can never mutate amounts, codes, dates, or links).
- **Hot-reload & interrupt:** `reload()` refreshes `IDENTITY.md`, `SOUL.md`, `hard-rules.md`, `USER.md`, and `knowledge/` live without restarting the host process; `abortTurn(conversationId)` interrupts an in-flight turn cleanly via `AbortController`.

## §46 — Unified AuthProvider & persistent Codex App-Server client (v2.0)

> Reference impl: `lib/auth.js` (`createPkceChallenge` · `buildAuthorizationUrl` · `exchangeAuthCode` · `startDeviceAuth` · `pollDeviceToken` · `createAuthStore`) · `lib/codex-app-server.js` (`findCodexBinary` · `createCodexAppServerClient`) · `lib/providers.js` (`codex-app-server` · `openai-compatible`) · `lib/scroll.js` (`scroll auth`) · tests `test/v20-auth-provider.smoke.mjs`.

- **Unified credential store (`0600`, atomic writes):** supports `oauth`, `api_key`, `proxy`, and `codex_app_server` profiles in one redacted store with automatic OAuth token refresh (`skewMs`), multi-account priority ordering, and automatic 429/401 circuit-breaker cooldown failover (`withFailover`).
- **Standard OAuth 2.0 flows:** ships zero-dep RFC 7636 PKCE (`S256`) and RFC 8628 Device Authorization Grant helpers so web apps and headless chat bots can authenticate users without external SDKs.
- **Persistent Codex App-Server JSON-RPC client:** keeps a single stdio `codex app-server --listen stdio://` subprocess alive for ChatGPT OAuth (`account/read`, `account/login/start`, `account/rateLimits/read`), automatic explicit model resolution via `model/list`, streaming `item/agentMessage/delta` notifications, and `turn/interrupt` on abort.
- **OpenAI-compatible streaming provider:** supports custom `baseUrl`, `AuthStore` failover, native function calling (`tools`), vision image inputs, and SSE delta streaming.

## §47 — Live multi-round tool executor & zero-dep MCP stdio client (v2.0)

> Reference impl: `lib/mcp-client.js` (`loadMcpConfig` · `createMcpStdioClient` · `createMcpManager`) · `lib/tools.js` (`createToolRegistry` · `isSafePublicUrl`) · tests `test/v20-chat-tools-mcp.smoke.mjs`.

- **One deterministic safety gate for all tools:** built-in tools (`read_file`, `list_dir`, `web_fetch`, `web_search`, `knowledge_search`, `memory_search`, `memory_remember`, `memory_forget`, `automations`, `spawn_worker`, `exec`) and dynamically discovered MCP stdio tools all pass through §42 boundary filtering (external/mixed-group turns are strictly `read_only`), §21 risk tier + policy matrix, §22 parameter grounding, interactive HITL approval (`requestApproval`), and §28 post-write read-back confirmation (`confirmEffect`).
- **Hardened built-ins:** `read_file` and `list_dir` enforce workspace containment and block memory-store direct access (§31.7 I-01); `web_fetch` blocks localhost, RFC1918, link-local, CGNAT, and cloud metadata IPs before and after redirects.
- **Zero-dep MCP stdio client:** reads `.mcp.json`, resolves `${vault:KEY}` from environment variables at runtime only, handshakes via JSON-RPC 2.0 `initialize` + `tools/list`, and registers discovered tools alongside SCROLL `risk`/`ground`/`confirm` metadata.

## §47.2 — Portable Tool Retriever, Room-Sticky Group Caching & ASI04 Pinning (v2.5)

> Reference impl: `lib/tool-retriever.js` (`buildToolRetriever` · `buildAvailableToolsIndex` · `validateToolArgs` · `computeSchemaHash`) · `lib/tools.js` (`getPromptSurface` · `searchTools` · `executeTool` Transparent Unwrap) · `lib/mcp-client.js` (`createMcpHttpClient` · `verifyAndPinTools` · `approveMcpLock`) · `lib/scroll.js` (`checkMcpConfigPinning` · `scroll mcp diff|approve`) · tests `test/v25-tool-retriever.smoke.mjs`.

- **3-Set Architecture (`C / V / E`):**
  1. **Catalog `C` (deployment-frozen, Region A):** When registered tools exceed `defer_threshold` (default `15`) or `max_schema_bytes` (`8 KB`), only core always-loaded tools plus `tool_search` and `tool_invoke` enter provider tool schemas. Remaining tools appear in a frozen `<available_tools>` catalog capped at `<= 1,500` tokens across three adaptive density tiers (full summaries, compact groups, namespace counts).
  2. **Visible `V` (per-turn volatile, Region C):** `tool_search` accepts single `query` or batch `queries[]`, filters strictly by the turn's speaker trust (`allowWriteTools`, `delegatedTools`, `tools_allow`), ranks via deterministic multi-field BM25F + bigrams + bilingual synonyms (+ optional `embedFn`), and records each returned tool's `schemaHash` in the session's `hydratedTools` map.
  3. **Executable `E` (per-call Transparent Unwrap):** `tool_invoke({ name, arguments })` rejects recursion (`tool_invoke`/`tool_search`), requires prior `tool_search` hydration for deferred tools, verifies `schemaHash` against mid-session drift (ASI04), validates `arguments` against JSON Schema on the host (`validateToolArgs`), and unwraps directly into the single unified `executeTool(targetName, targetArgs, ctx)` gate (enforcing §42, §21, §22, §28, budget/loop breakers, and `audit.jsonl` under the real target tool name).
- **Room-Sticky Group Cache Invariance:** In multi-speaker group rooms, Region A (`USER.md` rendered for room audience, safety contract, `<available_skills>`, `<available_tools>`, and tool schemas) stays byte-identical across alternating Owner, Teammate, and Guest turns (`prefixHash` variance = 0), while per-turn `<turn_speaker ... />` sanitized metadata attaches in Region C and per-speaker RBAC enforces strictly on `V` and `E`.
- **Supply-Chain & Rug-Pull Protection (ASI04):** MCP tool descriptions are scanned via `scanText()` and quarantined on prompt injection or hidden Unicode; `.scroll/mcp.lock.json` pins `(cmdHash, schemaHash, descHash)` on first use (TOFU) and quarantines unexpected descriptor drift until explicitly approved via `scroll mcp approve`; `scroll check` and `scroll audit` ban unpinned `npx …@latest` / unversioned packages in `.mcp.json`.

## §48 — Multimodal attachments in chat sessions (v2.0 / v2.5)

> Reference impl: `lib/chat-session.js` (`processAttachments`) · `lib/providers.js` · tests `test/v20-chat-tools-mcp.smoke.mjs`.

- Chat turns accept structured `attachments` (`image`, `audio`/`voice`, `document`/`file`).
- Images are forwarded directly to multimodal providers (URL, base64 data URI, or local image path); audio/voice notes pass through pluggable `multimodalHooks.transcribeAudio`; documents pass through `multimodalHooks.extractDocument` or bounded UTF-8 extraction.

## §49 — Timezone-aware cron, heartbeat & reminder scheduler (v2.0)

> Reference impl: `lib/scheduler.js` (`parseCron` · `zonedParts` · `matchesCron` · `canManageJob` · `createScheduler`) · `lib/scroll.js` (`scroll cron`) · tests `test/v20-scheduler-workers.smoke.mjs`.

- Pure Node `Intl.DateTimeFormat` 5-field cron evaluation in any IANA timezone (e.g. `Asia/Ho_Chi_Minh`), plus interval (`everyMs`) and one-shot (`at`) reminders, persisted atomically (`0600`).
- Enforces single-fire-per-minute deduplication, exponential retry backoff on transient/429 errors, per-job `maxDailyRuns` budget caps, and a global `paused` kill-switch.
- **0-LLM deterministic pre-check & budget isolation (v2.8.5):** `createScheduler` and `createScrollAgentHost.runScheduledTick` support a deterministic `precheck` gate (`registerPrecheck` / `precheck`) that skips idle ticks with zero LLM calls and zero `dailyRuns` consumption, enforce `budgetGovernor` pre-flight caps (including dedicated `maxBackgroundDailyUsd` / `bucketCaps` isolation, `maxMonthlyUsd`, invoice-anchored `syncExternalInvoice`, graduated `onBudgetAlert` thresholds, and multimodal + `serviceTier` pricing in `lib/chat-telemetry.js`), and default background/scheduled ticks to `serviceTier: 'standard'` so scheduled work never inherits interactive `fast`/`priority` multipliers accidentally.
- **Owner DM authority (`canManageJob`):** a verified internal `owner`/`admin` in a direct message is authorized to inspect, toggle, edit, or delete scheduled jobs targeting any group chat.

## §50 — Async background workers & hybrid memory search (v2.0)

> Reference impl: `lib/chat-session.js` (`createWorkerPool`) · `lib/memory.js` (`searchHybrid` · `consolidateDigest`) · tests `test/v20-scheduler-workers.smoke.mjs`.

- **Non-blocking worker pool:** `createWorkerPool` bounds concurrent background jobs (`maxConcurrent`), supports cancellation via `AbortController`, and invokes `onComplete` so long-running tasks never block live chat turns.
- **Hybrid semantic + lexical memory search:** `memoryStore.searchHybrid(sid, { query, embed, semanticWeight })` combines optional caller-supplied vector embeddings (cosine similarity) with SCROLL's deterministic lexical scan while preserving every §31–§33 access-ledger and isolation guarantee; `consolidateDigest()` yields a bounded deterministic fact digest.

---

## §51 — Response Economy & Outcome-Only Runtime (v2.7)

SCROLL 2.7 completes the Gricean triad at the runtime boundary so every conformant chat agent delivers concise, outcome-only replies without sacrificing deep reasoning or factual accuracy:

- **Triad separation:** `lib/grounding.js` enforces **Quality** (zero hallucination); `lib/chat-sdk/plain-speak.js` enforces **Manner** (human naturalness, zero jargon); `lib/turn-budget.js` + `lib/chat-sdk/response-economy.js` enforce **Quantity & Relevance** (answer only what was asked, outcome over process narration, zero user-echo, zero unsolicited tutorials).
- **Decoupled Brain vs Mouth (`effort_routing: fixed` default):** `IDENTITY.md` declares a machine-validated `economy:` map (`mode`, `effort_routing`, `links`, `process_narration`, `echo_guard`, `default_follow_up`, `compress_llm`, `max_chars_brief`). Thinking `effort` stays at the agent's configured level (`high`/`ultra`) by default so terse-but-hard prompts never regress; optional `effort_routing: auto` enforces a strict 6-gate fail-high allowlist + deterministic mid-turn escalation ladder (`escalateEffortForRound`).
- **Region-C `AnswerContract` (§13 cache-invariant):** `classifyTurnBudget` classifies every turn in `<0.5ms` (`ack_confirm | action_exec | status_yn | lookup_brief | provenance_pull | complex_analysis`) and injects a compact Region-C contract without altering Region-A `prefixHash`.
- **Two-Channel Pull-on-Demand Work Ledger:** Tool names, verified URLs, and stripped citation links are persisted per-conversation in `workLedgerByConv` instead of dumped into chat; when the user later asks for sources or details (`provenance_pull`), SCROLL surfaces the ledger on demand.
- **Subset-Safe Compression Invariant (`verifyCompressionInvariant`):** Unlike `verifyClaimsInvariant` (1:1 multiset equality for wording swaps), `verifyCompressionInvariant` enforces `claims(after) ⊆ claims(before)` (zero fabricated or perturbed numbers/dates/codes/links/percents/times) + negation polarity preservation, enabling safe removal of unsolicited paragraphs and links.
- **Unified Post-Gen Editorial Budget (INV-EC-1):** `ResponseEconomy` runs after grounding and before `PlainSpeak`, sharing a strict maximum of **1 ephemeral post-gen LLM pass per turn** (`effort: 'low'`, `serviceTier: 'fast'`, `ephemeral: true`). Only the clean compressed `finalText` is persisted to session history, eliminating in-context verbosity self-poisoning.
- **Static Prompt Hygiene (`scroll audit`):** Warns on bloated `SOUL.md` (`>12KB`) and directive conflicts between `SOUL.md` mandatory-link rules and `IDENTITY.economy.links: on_request`.

---

## §57 — Durable Multi-Day Execution Kernel (`scroll-job/v1`, v2.16.1–v2.17.0)

> Reference impl: `lib/tickets.js` (`computeTicketSpecHash` · `validateTicketUpdate` · `validateTicketTransitionScope` · `evaluateTicketTurnExit` · `assignExecutionOwner`) · `lib/turn-context.js` (`createTurnContextRegistry` · `clampBackgroundSliceMs`) · `lib/durable-jobs.js` (`createDurableJobStore` · `DURABLE_JOB_STATUSES` · `SCROLL_DURABLE_JOB_TOOL_SCHEMAS`) · tests `test/v2161-security-hardening.smoke.mjs`, `test/v217-durable-multiday.smoke.mjs`.

- **Ticket Approval Hardening & Fail-Closed Turn Context (v2.16.1):** `Ticket` remains the immutable Approval & Audit layer (`specHash = SHA-256(canonical(actionSpec))`). `validateTicketUpdate()` rejects internal `_*` keys, cross-room/cross-agent edits, and post-approval `actionSpec` tampering. `validateTicketTransitionScope()` binds every execution transition to `(approvedTicketId, approvedSpecHash)`. `createTurnContextRegistry()` attaches an immutable opaque `turnToken` (via `AsyncLocalStorage`, TTL `>= turnTimeoutMs + 60s`) so concurrent rooms never share mutable `activeTurn` state or fall back to an Owner DM context; background execution slices are clamped to `<= 180s` (`clampBackgroundSliceMs`). `evaluateTicketTurnExit()` blocks bare `end_turn` auto-closing of in-flight work.
- **Single Execution Engine (`DurableJob`, 8 Core States):** Tickets may delegate execution atomically (`assignExecutionOwner('durable')`) to a `DurableJob` record (`scroll-job/v1`) persisted via conditional compare-and-swap (`revision`, `jobEpoch`, `leaseToken`) under a file lock. Core statuses are strictly `queued | running | waiting | reconciling | paused | completed | failed | cancelled`, orthogonal to `waitingFor` (`external | requester | owner | approver | companion | approval`).
- **Exactly-Once Side-Effect Reconciliation:** Before dispatching any side-effecting tool, the host persists an `effectIntent` keyed by deterministic `operationId` (`argsHash` conflict-checked) and fenced by `(jobEpoch, leaseToken)`. On host crash or lease expiry, the Periodic Reaper (`reap()`) transitions active jobs with in-flight intents to `reconciling` instead of blindly re-executing; `recordEffectReceipt` settles the intent deterministically, preventing duplicate side effects across 30-day replays.
- **Two-Clock Budget & Statutory Lock:** Every job tracks active execution slices (`maxSlices`, `maxActiveMs`), wall-clock horizon (`horizonDays`: default 7d, hard ceiling 30d), and per-day caps (`maxSlicesPerDay`, `maxUsdPerDay`). When `statutoryLock: true`, horizon expiry transitions to `paused` and escalates to the owner rather than silently cancelling regulated filings or contracts (capped at 90 days).
- **Explicit Exit Contract & Anti-Bailout:** Background slices cannot close on prose alone. `detectPoliteBailout()` (ASCII/NFD-folded) flags conversational bailouts ("I will check back later", "please check again") when no explicit `job_yield` / `job_complete` / `job_fail` / `ask_requester` / `escalate_owner` tool call occurred, converting premature exit into retry or owner escalation.
- **Transactional Outbox & Edit-in-Place:** Status cards, progress edits, and final reports are written to an idempotent outbox keyed by `clientMessageId`. Negative probes only enqueue `progress_edit` updates against the live status card (`externalMessageId`), producing zero spam push messages; `quietHours` defers non-urgent notifications while never blocking execution or background probes.

## §58 — Dual-Speed Wake Bus & 0-LLM Probes (v2.17.0)

> Reference impl: `lib/job-wake-bus.js` (`createJobWakeBus`) · `lib/durable-jobs.js` (`computeTempoTier` · `computeNextProbeDelaySec`) · tests `test/v217-durable-multiday.smoke.mjs`.

- **Separation from Cron Automations:** `job_yield` is strictly separate from recurring §49 `automations` — it has no `cron` syntax and no `match: all` wildcard. Jobs are woken by (a) event-driven `publishEvent()` (`< 5ms` wake, with callback-before-park buffering into `eventInbox` when a job is still `running`), (b) dynamic `MIN(nextDueAt)` scheduling, and (c) a 20-second safety sweep.
- **3-Tempo Gears & Dual-Speed Backoff:** Jobs automatically classify into `micro` (`< 15m`), `sprint` (`15m–2h`, probe backoff `30s -> 60s -> 120s -> 180s`), or `marathon` (`> 2h` to `30d`, probe backoff `15m -> 30m -> 1h -> 4h`).
- **Host-Registered Named 0-LLM Probes (Anti-SSRF):** `registerProbe(probeName, fn)` registers deterministic host probes. `job_yield` may only reference a registered `probeName` — raw URLs, hostnames, shell strings, or file paths are rejected fail-closed. Negative probes reschedule backoff and update the status card with zero LLM tokens and zero slice consumption.

## §59 — Declarative `IDENTITY.autonomy`, 4-Branch Error Dispositions & Re-Observe First (v2.18.0)

> Reference impl: `lib/autonomy.js` (`validateAutonomyConfig` · `resolveAutonomyConfig` · `classifyToolErrorDisposition` · `buildContinuationWorkLedger` · `validateReObserveBeforeGuiAction`) · `lib/scroll.js` · `lib/chat-session.js` · tests `test/v218-autonomy-async-reobserve.smoke.mjs`.

- **Opt-In Autonomy Config:** `IDENTITY.md` may declare `autonomy: { mode: off | ask | continue_in_background, max_slices, max_wall_hours, max_active_minutes, max_usd_per_job, quiet_hours }` (default `mode: 'off'`, zero behavioral change for existing agents). `createChatSessionRuntime` invokes `onTurnExhausted` when an active turn hits round/timeout exhaustion under `ask` or `continue_in_background`.
- **4-Branch Error Disposition:** `classifyToolErrorDisposition()` deterministically routes every tool failure into `abort_job` (permission/auth/scope revoked), `park_waiting` (companion offline, waiting for external resource), `retry_backoff` (429/5xx/network timeout), or `feed_llm_repair` (bad selector, validation error, stale UI element) so agents never waste LLM retries on unrecoverable permission blocks.
- **Anchored Continuation Ledger & Re-Observe First:** `buildContinuationWorkLedger()` caps continuation summaries at `<= 25` lines with Line 0 permanently locked to `[GOAL]` to prevent multi-day goal drift. `validateReObserveBeforeGuiAction()` blocks any GUI/browser mutation (`browser_click`, `cua_act`, `desktop_click`, etc.) after a sleep/wake gap (`> 5m`) or host restart until a fresh observation tool (`isGuiObserveTool`) refreshes `checkpoint.lastObservedAtMs`.

## §60 — Morning Digest Batching, Candidate-Only Wake Cues & Cadence Metrics (v2.19.0)

> Reference impl: `lib/autonomy.js` (`buildMorningDigest` · `matchWakeCueCandidates` · `computeDurableJobMetrics`) · tests `test/v219-digest-wake-cues.smoke.mjs`.

- **Anti-Fatigue Morning Digest:** `buildMorningDigest()` batches non-urgent multi-day updates after `quietHours` into a single compact digest per audience, respecting privacy projection (group rooms receive neutral summaries with zero owner-private diagnostics).
- **Candidate-Only Natural-Language Wake Cues:** `matchWakeCueCandidates()` matches natural user follow-ups ("done", "paid", "verified") ONLY against jobs in the same room where the speaker is an authorized principal (`requester | owner | approver`). Strangers, cross-room messages, and ambiguous multi-job matches never auto-resume a job; ambiguous matches return candidates for explicit user confirmation.
- **Cadence Metrics:** `computeDurableJobMetrics()` aggregates active jobs by tempo tier, probe efficiency ratio, and outbox/ask volume for operator observability.

## §61 — Zero-Exposure `SecretProvider` (`scroll-secret-handle/v1`, v2.20.0)

> Reference impl: `lib/secret-provider.js` (`createVaultSecretProvider` · `isSecretHandle` · `matchesAllowedDomain` · `redactSecretsDeep`) · `eval/multiday-cv-browser/runner.mjs` · tests `test/v220-secret-provider-and-eval.smoke.mjs`.

- **Handles Only in Model Context:** Extending `lib/vault.js`, `createVaultSecretProvider()` lets the LLM reference credentials exclusively via opaque handles `{ $secret: "<name>", field: "<field>" }`. Raw secret bytes are resolved inside the host right before tool dispatch and scrubbed on the way back via `redactSecretsDeep()` (plaintext, URL-encoded, and Base64 variants).
- **Hard Security Boundaries:**
  1. **Owner-DM-Only:** Any resolution inside a group turn or a background slice originating from a group (`isGroup || originIsGroup`) fails closed with `ERR_SECRET_FORBIDDEN_IN_GROUP`.
  2. **Declared `secret_args` Only:** Handles passed into non-secret tool arguments (e.g., selectors, URLs, prompts) fail with `ERR_UNDECLARED_SECRET_ARG`.
  3. **Machine-Measured `secret_destination`:** Active browser/endpoint origin must match `allowedDomains` over HTTPS (`exact_or_subdomain`), blocking phishing redirects with `SECRET_DESTINATION_MISMATCH`.
  4. **Step-Up Controls:** Secrets declare `stepUp: none | per_job_origin | each_use`. `per_job_origin` binds an explicit owner grant to `(name, jobId, origin)`; `each_use` elevates to `financial` tier and consumes a single-use token per call.
- **72-Hour Deterministic Fault-Injection Eval:** `npm run eval:multiday` (`eval/multiday-cv-browser/runner.mjs`) compresses a 30-day multi-host CV/browser lifecycle into `< 1s` under a deterministic fake clock, verifying all 10 production Go/No-Go gates (CAS race, crash-after-202 reconciliation, callback-before-park, 16x 0-LLM probes, cancel-vs-dispatch race, steering scope reapproval, post-mutex permission drift, outbox dedupe, Fair-Share DRR, and Day-29 Re-Observe + phishing + 0-byte canary leak).

## §62 — Companion Fair-Share DRR, Post-Mutex Fence & Async `202 Accepted` (`scroll-remote-job/v1`, v2.17.0–v2.18.0)

> Reference impl: `lib/remote-tool-transport.js` (`createFairShareResourceQueue` · `createAsyncRemoteJobLedger` · `createCompanionToolHost` · `createRemoteToolClient`) · tests `test/v217-durable-multiday.smoke.mjs`, `test/v218-autonomy-async-reobserve.smoke.mjs`.

- **Fair-Share DRR by Physical Resource (§62a):** `createFairShareResourceQueue()` enforces two-level Deficit Round-Robin scheduling keyed by `physicalResourceId` (with per-group queue caps, last-served rotation, and aging boost) so one noisy group cannot starve another group sharing the same desktop/browser host.
- **Post-Mutex Resource Fence (§62a):** `createCompanionToolHost()` re-evaluates `verifyResourceFence` and `disallowGroupOriginTools` **after** acquiring `DesktopMutex` (and passes `checkFence()` into tool handlers), neutralizing TOCTOU permission drift (e.g., owner leaving a group while a job waited for desktop access).
- **Async `202 Accepted` Protocol (§62b):** Long-running remote operations (`scroll-remote-job/v1`) return `{ status: 'accepted', remoteJobId, operationId, pollAfterSec }` backed by `createAsyncRemoteJobLedger()` (durable before returning `202`, 31-day receipt retention, `argsHash` conflict detection). `accepted` is never treated as `completed`; after a host crash before ACK, `getRemoteJobStatus(operationId)` reconciles cleanly without launching duplicate work, and `cancelRemoteJob()` propagates cancellation safely.

## §63 — Multi-Principal Requester, Group Authority & Non-Blocking Human Dialogue (v2.17.0)

> Reference impl: `lib/durable-jobs.js` (`evaluateEffectiveAuthority` · `evaluateSteeringPermission` · `projectJobForAudience` · `openAsk` · `answerAsk` · `submitSteering`) · tests `test/v217-durable-multiday.smoke.mjs`.

- **Three Distinct Principals:** Every durable job separates `requester` (who initiated the task), `owner` (account/workspace owner), and `approver` (designated approver for gated tiers), applicable uniformly to both DM and group rooms.
- **Intersection Authority (`effectiveScope = snapshot ∩ live`):** Every slice re-evaluates `evaluateEffectiveAuthority()` against live group membership, policy posture, and active grants. Revoking a grant or owner departure shrinks effective authority immediately without leaking privilege from an older snapshot.
- **Non-Blocking Ask Protocol (`inlineWaitSec = 0`):** `ask_requester` (`choice | text | handoff`, strictly banning `kind: 'secret'`) and `escalate_owner` park the job immediately without holding the per-agent serial turn queue. `answerAsk()` enforces principal verification (blocking agents and unauthorized group members from answering on a requester's behalf), supports bounded 2-nudge-1-park cadences and Default-Unless-Vetoed policies.
- **Verified Mid-Flight Steering (`intentRev`):** `submitSteering()` (`pause | resume | cancel | amend | redirect`) authorizes strictly by principal role, arbitrates `cancel` vs in-flight side effects via `cancel_requested -> reconciling -> cancelled`, and forces fresh approval (`REAPPROVAL_REQUIRED`) whenever an amendment expands capability scope.

---

## Design note — §28–30 and the failure they answer

§21 (risk), §22 (grounding) and §1.4 (enforce at the tool boundary) compensate for weaknesses of the *model*: it does not understand consequences, it hallucinates identifiers, it will not stop on its own.

§28–30 compensate for weaknesses of the *engineers and operators*:

| mechanism | compensates for |
|---|---|
| §28 effect confirmation | a system that reports success for work it never performed — which an agent then relays in good faith |
| §29 ungraded ≠ pass | "no yardstick" being indistinguishable from "measured and good" |
| §30 fixture provenance | hand-patching a precondition and calling the result acceptance |

A harness that only guards against the model is half a harness.
