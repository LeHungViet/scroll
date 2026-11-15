<!-- This file is read automatically by AI coding tools (Claude Code, Cursor, Cowork, Codex...). It teaches the AI how to build agents the SCROLL way, so vibecoders get compliant agents by default — without reading the docs. Ship a copy of this at the root of any SCROLL repo. -->

# Working in a SCROLL repo

This repository uses **SCROLL**: AI agents are folders of markdown, not code. If you are an AI assistant editing this repo, follow these rules. They are not optional — `scroll check` runs in CI and will fail the build otherwise.

## Where agents live
- App-specific agents: `agents/<name>/`
- Never put an agent's persona, rules, or model choice inside application code (`.js`/`.ts`/`.py`). Those belong in the agent's files.

## An agent is exactly these files
```
agents/<name>/
├── IDENTITY.md   # YAML frontmatter — name, version, runtimes, model, capabilities, pronoun
├── SOUL.md       # the persona in prose — voice, values, behavior
├── TOOLS.md      # capabilities (logical) + tool_bindings (per runtime)
├── hard-rules.md # rules the agent must never break
├── memory/       # lessons.md, log/, and private|team|global/
└── evals/        # gold test cases + rubric.md
```

## Hard rules when creating or editing an agent
1. **Always start with `scroll new <name>`** — do not hand-create the folder. The scaffold is the source of correctness.
2. **`IDENTITY.md` frontmatter must validate** against the schema: `name`, `version` (semver), `runtimes[]`, `model`, `capabilities[]` are required. Your editor will flag errors; fix them before finishing.
3. **Put behavior in `SOUL.md`, not in code.** If you're tempted to write a prompt string in a `.ts` file, stop — it goes in `SOUL.md`.
4. **Tools are wired in `TOOLS.md`**, declared as logical `capabilities` + per-runtime `tool_bindings`. The actual tool *implementations* stay in app code; only the *wiring* lives here.
5. **Every agent needs at least 3 gold eval cases** in `evals/` before it ships. A gold case = a fixed input + a checklist of what a correct output must contain + at least one planted trap (a bad source or contradiction it must not fall for).
6. **Multi-agent is opt-in.** Default to a single agent. Only introduce a controller + sub-agents (via `WORK.md`) when the task is genuinely parallel and read-heavy. Write/coupled tasks stay single-threaded.
7. **Coordinate through files, never message-passing.** Shared findings go to `blackboard/` (one file per entry). A single controller owns `WORK.md`. Handoffs pass a summary, not full history.
8. **Order context for caching:** stable content first (tools, hard-rules, IDENTITY, SOUL), volatile content last (current task, fresh blackboard). Never interleave.
9. **Declare risk as data, never prose (v1.4).** A tool's risk tier goes in `.mcp.json` (per tool) or `IDENTITY.security.risk_defaults` (per capability) — never as a sentence in a markdown body, where a model can be talked out of it. Tiers: `read_only · reversible_write · external_comm · financial · destructive`. `financial`/`destructive` actions are gated and **grounding-checked**: list the parameters to ground (`ground: [...]`) so a fabricated id/amount can't execute.
10. **For self-directed or scheduled work, write a `LOOP.md` (the outer loop).** It MUST declare at least one `stop_conditions` (a loop that can't stop is unsafe). The inner loop is `scroll run`; the outer loop is `scroll loop`. Never hand-roll a `while(true)` — it bypasses the caps, gates, and digest.
11. **Memory about people is data the machine admits, not notes the model writes (v1.7).** Facts about the people, groups or projects an agent serves go through `lib/memory.js` (§31–33) — never into `agents/<name>/memory/`, never into the repo. Don't hand-roll a "user notes" file, a vector store, or a prompt that tells the model what to remember: propose facts with a quote and a turn reference and let the gate decide. Keep the store outside every workdir.

12. **Skills are folders the loader admits, not text you paste into prompts (v1.8).** Use the open `SKILL.md` format (`name` + a `description` that says what and when). Put the agent's own skills in `agents/<name>/skills/`, shared ones in `skills/`, and other tools' skill folders under `skills.external_dirs` in `scroll.config.yaml` — never copy a skill's text into `SOUL.md` or code. Declare what a skill needs (`allowed-tools` or `metadata.scroll.requires`), give it ≥3 cases in its `evals/`, and run `scroll skill eval` — keep a skill only if it beats the baseline. Never weaken the scan or trust a source on a model's say-so.

## Before you say you're done
Run, in order — and do not merely *claim* you ran them; the human/CI re-runs `scroll audit --verify`:
```bash
scroll check <name>     # structure (and the agent's skills) must pass
scroll audit            # conventions + hash-bound report → writes .scroll/audit.json
scroll build <name>     # must render without error
scroll eval <name>      # score must not regress vs the previous run
```
`scroll audit` is the compliance gate. It flags the things an assistant tends to improvise: persona/prompt text left in code, hardcoded model ids, banned infra (DBs, queues, graph/agent frameworks), and agents shipped without ≥3 gold evals. It writes a report **bound to a content hash**, so a "pass" can't be faked or go stale — if you edit files after auditing, `scroll audit --verify` fails. Do not mark the task complete on a failing check or audit.

## What NOT to do
- ❌ Don't add a database, message queue, or orchestration engine. SCROLL coordinates through the filesystem.
- ❌ Don't hardcode a model vendor in app logic. The agent declares its model in `IDENTITY.md`; the runtime is swappable.
- ❌ Don't let an agent run unbounded. Long tasks are split into short, checkpointed steps with hard caps.
- ❌ Don't bypass `WORK.md` to have agents call each other directly — that creates the infinite-handoff failure mode.

Follow these and your agents are portable, gradeable, observable, and cheap by construction.
