<!-- This is the PUBLIC, publishable README — the face of the framework devs see. EN by default (global dev audience). VN version available on request. -->

# 📜 SCROLL — a harness for agentic loops

**Build AI agents as folders, not code.** A filesystem-native harness: an agent is a directory of markdown, the LLM does the work, a thin CLI coordinates. No engine, no database, no runtime lock-in. Runs the same locally and in the cloud — and gives you the **outer loop** (loop engineering) so an agent finds its own work, does it, verifies it, and remembers it, without you prompting each turn.

```bash
npm i -g @agentpro/scroll
scroll new researcher                 # scaffold a compliant agent (L1-ready: hard-rules + 3 gold evals)
scroll build researcher               # render it for Cowork / Codex / Gemini / voice
scroll run  researcher --task "…"     # inner loop: one harnessed run — capped, gated, checkpointed
scroll loop LOOP.md                   # outer loop: schedule + find work + stop conditions
```

`MIT` · `Node ≥ 20` · **Spec v1.6** · **`@agentpro/scroll` 0.11.0** · vendor-neutral — runs on Claude · OpenAI/Codex · Gemini · Grok

> **GitHub topics:** `loop-engineering` · `agent-harness` · `agentic` · `agentic-loops` · `ai-agents` · `autonomous-agents` · `llm` · `mcp`

---

## Why SCROLL

Most agent frameworks make you import a heavy runtime (graphs, schedulers, vector DBs) and lock you to one model vendor. SCROLL bets the opposite way:

| | Heavy frameworks | **SCROLL** |
|---|---|---|
| An agent is… | an object in code | **a folder of markdown** |
| State lives in… | a database / session | **the filesystem + git** |
| Orchestration | the framework runtime | **a declarative DAG you advance deterministically** |
| Safety | hope the model behaves | **risk-tiered gates + grounding, enforced in code** |
| Model | locked to one vendor | **vendor-neutral — one definition, any runtime** |
| The whole framework | a dependency tree | **a convention + one small CLI** |

The thesis in one line: **SCROLL doesn't try to make the model smarter — it makes the model's built-in weaknesses unable to cause harm.** Every mechanism below compensates for a specific model failure mode.

| Mechanism | The model weakness it neutralizes |
|---|---|
| Risk-tiered permission matrix | the model doesn't understand *consequences* |
| Grounding pre-check | *hallucination* (inventing ids / amounts) |
| Tool-boundary enforcement | *sycophancy* — it can't be trusted to stop itself |
| External eval (gold cases) | biased self-assessment |
| Comprehension digest | the *user's* passive over-delegation |

---

## Implementation status (2026-07-15 · v1.6)

**Built & tested** (`test/` — **73 checks green**: 9 core + 14 runtime + 16 v1.4 + 6 v1.5 + 10 v1.6 + 11 installers + 7 audit):

- **§28 Effect confirmation** — a write is not "done" because the call returned a non-error. `lib/effects.js` re-reads the state with a **separate** probe and checks a declared predicate; a mismatch emits `effect_unconfirmed` and fails the step. `financial`/`destructive` writes with no `confirm` are blocked (fail-closed) and flagged by `scroll audit`. Corollary: an unknown input field is rejected, never dropped — silently dropping input is how a system reports success for work it never did.
- **§29 Ungraded is not pass** — `verdict` is ternary (`pass | fail | ungraded`). "No check ran" is counted separately and never folded into `ok`; a judge that could not run says nothing, so it grades `ungraded` rather than `fail`.
- **§30 Fixture provenance** — gold cases declare `fixture.provenance` (`product-path | recorded | synthetic`); `scroll eval` prints it beside every verdict and `scroll audit` flags a suite built only on hand-made fixtures — the shape where a scheduler's *execute* path is green while its *arm* path was never run once.

- **Inner loop** `scroll run` — deterministic DAG advance from `WORK.md`, single controller, cost-gate, append-only `blackboard/`, hard caps + circuit breaker, stable-prefix caching, model routing, deterministic non-LLM steps, verify-before-done, per-tick checkpoint, `events.jsonl`.
- **Risk-tiered permissions** — five tiers (`read_only · reversible_write · external_comm · financial · destructive`), enforced at the **action boundary in code** (not the prompt). Risk is declared as data in `.mcp.json` / `IDENTITY.security`, never read from prose.
- **Grounding pre-check** — before a `financial`/`destructive` action, every critical parameter must trace to a real prior source; a fabricated id/amount **never executes**.
- **Outer loop** `scroll loop` + `LOOP.md` — schedule, work-source, and stop conditions for self-directed runs. A loop with no stop condition is refused.
- **Comprehension digest** — every run writes a human-readable `digest.md` from the event stream (no model call), language-aware.
- **`scroll eval`** — gold cases run N times → machine checks + consistency (`pass^k`) + optional LLM-judge + hash-bound record. **(built — earlier docs called this roadmap; it ships.)**
- **Per-language token budgeting** — `scroll cost` / the cost gate scale by language (Vietnamese ≈ 1.8× English).
- **Worktree-lite isolation** — parallel tasks get isolated working dirs (real `git worktree` with `--worktree` on a repo) so two agents never corrupt shared state.
- **Crash-resume** — `scroll run --resume` restores completed tasks from the checkpoint and finishes the rest **without re-billing**.
- **`scroll audit`** — convention scan + hash-bound compliance report (CI; `--verify`).
- **Extension installers** — `scroll mcp add` (wire an MCP server/connector into `.mcp.json`, with `${vault:KEY}` credentials + per-tool risk tiers), `scroll skill add` (install or scaffold a `SKILL.md` skill, attach it to an agent), `scroll plugin add` (unpack an agent-pack bundle: agents + skills + merged `.mcp.json`).

Providers: `mock` (offline) · `codex` · `claude` · `openai` · `anthropic` · `gemini`. On a case-gated live A/B eval the runtime cut billable tokens **50–88%** and latency **50–75%** vs an unstructured baseline, at equal-or-better quality.

**Roadmap:** AG-UI / OpenTelemetry event emission · storage adapters (S3/GCS/repo) · registry-backed discovery for `mcp add`.

---

## Quickstart

**1. Install** — `npm i -g @agentpro/scroll`

**2. Create an agent** — `scroll new` scaffolds a correct, **L1-ready** folder:
```
agents/atlas/
├── IDENTITY.md      # who it is + security (risk tiers) — machine-readable frontmatter
├── SOUL.md          # how it thinks (you write this part)
├── TOOLS.md         # what it can use
├── hard-rules.md    # rules it must never break
├── memory/          # what it remembers
└── evals/           # 3 gold cases — graded by `scroll eval`
```

**3. Build, run, loop:**
```bash
scroll check atlas             # validate structure (pre-commit + CI)
scroll build atlas             # → Cowork / Codex / Gemini / Claude-subagent / A2A
scroll run   atlas --task "…"  # inner loop: deterministic, capped, gated, checkpointed
scroll loop  LOOP.md           # outer loop: scheduled, self-directed, with stop conditions
```

---

## Inner loop vs. outer loop (loop engineering)

The shift the field is naming **loop engineering** is from writing prompts to designing the *system that prompts the agent*. SCROLL gives you both halves explicitly:

- **`scroll run` — the inner loop.** One harnessed execution of a `WORK.md`: advance the DAG, act inside a step, verify, checkpoint.
- **`LOOP.md` + `scroll loop` — the outer loop.** Defines **when** to start an inner loop (`schedule`), **where** it finds work (`work_source`), and **when to stop** (`stop_conditions` — required). It rides your host scheduler (cron / scheduled-tasks); there's no daemon engine.

```yaml
# LOOP.md
id: market-watch-daily
controller: lead
schedule:       { cron: "0 7 * * *" }
work_source:    { type: work_file, query: WORK.md }
stop_conditions:{ max_runs_per_day: 4, budget_usd_per_day: 5, halt_on: [gate_denied, verify_fail] }
digest: required
```

The outer loop **never escalates privilege** — every action inside still passes the permission matrix below — and writes a digest after every run.

---

## Safety: risk tiers + grounding, enforced in code

A model is sycophantic and prompt-injectable, so it can't be trusted to stop before a dangerous action. SCROLL puts the gate in **deterministic code, in front of the action**.

**Five tiers, lowest → highest consequence**, each mapped to a policy:

| tier | default policy |
|---|---|
| `read_only` | auto |
| `reversible_write` | auto + log |
| `external_comm` | soft-hold |
| `financial` | must-approve **+ grounding** |
| `destructive` | must-approve **+ grounding** |

Risk is **data, not prose** — declared per-tool in `.mcp.json` or per-namespace in `IDENTITY.security` (a label a model can read is just another prompt it can be talked out of):

```yaml
# IDENTITY.md
security:
  risk_defaults: { fs.read: read_only, shell.exec: destructive, mcp.*: external_comm }
  approval:      { financial: must-approve, destructive: must-approve }
```

`must-approve` blocks until an approval file appears under `control/approvals/`. **Grounding** runs first for `financial`/`destructive`: every declared parameter (a product code, an amount, a customer id) must trace to a real source seen earlier in the run — otherwise the action is **denied and never runs, even if "approved."** An invented invoice can't be issued.

---

## Multi-agent, the safe way

Agents coordinate through **files**, not a message bus:

- **`WORK.md`** — the task chain as a declarative DAG. One *controller* owns it (this prevents the #1 multi-agent failure: infinite handoff loops). A deterministic runner advances it; the LLM only acts *inside* a step.
- **`blackboard/`** — a shared space where agents post discoveries (one append-only file each).
- **Worktree-lite isolation** — parallel tasks write to isolated dirs, so two agents never collide.

Default is **single-agent**. Multi-agent is opt-in and only when a task is genuinely parallel — it costs ~15× the tokens, so SCROLL estimates cost (language-aware) *before* it spawns.

---

## Watch, control, and read back

```
runs/<id>/events.jsonl   # run_started · permission_decision · grounding_checked · cost_update · completed …
runs/<id>/digest.md      # human-readable summary — what it did, which dangerous tiers it touched, cost
```

- **Stream** the events (tail locally, or SSE/WebSocket in the cloud; types map to **AG-UI**).
- **Control** a live run by writing files: `control/pause`, `control/stop`, `control/steer.md`, or approve a gate under `control/approvals/`.
- **Read the digest** — so the owner understands the run instead of just trusting it (an antidote to passive over-delegation).

---

## Compliance is structural, not trust-based

SCROLL doesn't rely on you reading the docs — the correct path is the only one that works: a **scaffold** that's correct by default, a JSON **schema**, a **linter** (`scroll check`) in CI, a build that **refuses** invalid agents, an [`AGENTS.md`](./AGENTS.md) that teaches AI coding tools the rules, and **`scroll audit`** — a hash-bound report so a "pass" is tied to the exact file state and can't be faked.

---

## CLI reference

| Command | Does | Status |
|---|---|---|
| `scroll new <name>` | Scaffold an L1-ready agent folder | ✅ built |
| `scroll check <name>` | Validate structure (linter; pre-commit + CI) | ✅ built |
| `scroll build <name>` | Render one source → every runtime | ✅ built |
| `scroll run --work <f>` | **Inner loop** over a `WORK.md` (or `run <agent> --task`) | ✅ built |
| `scroll loop <LOOP.md>` | **Outer loop** — schedule + find work + stop conditions | ✅ built |
| `scroll eval <name>` | Gold cases N× → machine checks + consistency + judge | ✅ built |
| `scroll audit [name]` | Conventions + hash-bound report (CI; `--verify`) | ✅ built |
| `scroll registry` | Scan agents → a config/observability view | ✅ built |
| `scroll cost <task> [--language vi]` | Single vs multi token estimate (language-aware) | ✅ built |
| `scroll mcp add <name>` | Wire an MCP server / connector into `.mcp.json` (`${vault:KEY}` creds · per-tool risk) | ✅ built |
| `scroll skill add <ref>` | Install / scaffold a `SKILL.md` skill (`--agent` to attach) | ✅ built |
| `scroll plugin add <ref>` | Unpack an agent-pack bundle (agents + skills + merged `.mcp.json`) | ✅ built |

Useful `run` flags: `--resume` (crash-resume), `--worktree` (git-worktree isolation), `--risk <tier>`, `--auto-approve`, `--language <code>`, `--max-usd` / `--max-iterations`.

---

## Packaging

- **`@agentpro/scroll`** — the CLI + loader (npm).
- **`@agentpro/scroll-schema`** — the versioned spec + JSON Schema.
- **Storage adapters** — `@agentpro/scroll-s3`, `-gcs`, `-repo` (roadmap).

Your *agents* are never packaged — they're folders you own and version, like `AGENTS.md`.

## Learn more
- [`SPEC.md`](./SPEC.md) — the formal agent-folder + frontmatter spec (incl. §21 permissions, §22 grounding, §23 LOOP)
- [`AGENTS.md`](./AGENTS.md) — how AI coding tools follow SCROLL
- [`templates/`](./templates/) — a worked agent + a `WORK.md` + a `LOOP.md`

## License
[MIT](./LICENSE) © 2026 Agent Pro. Use it, fork it, ship it — just keep the copyright notice.

---

*SCROLL — a harness for agentic loops. Turn every AI subscription your team pays for into coordinated, governed, portable agents. Built by Agent Pro.*
