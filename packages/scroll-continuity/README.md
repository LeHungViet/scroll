# `@agentpro/scroll-continuity`

Universal, zero-dependency, opt-in **long-horizon continuity kernel** for any `@agentpro/scroll` agent.

## Which SCROLL Opt-In Package Should You Install?

SCROLL separates general-purpose agent continuity from deep vertical consulting workflows so you only install what your agent actually needs:

| Agent Type | Install | What You Get |
|---|---|---|
| **Stateless / lightweight bot** | `@agentpro/scroll` | Core loop, sandboxed tools, flat memory, scheduling |
| **Personal assistant, coordinator, ops or multi-session bot** | `@agentpro/scroll` + **`@agentpro/scroll-continuity`** | Lossless bi-temporal event ledger (SQLite + FTS5), goal anchors, POMR pragmatic backlog parking (`B\|D\|U` + `wake_cues`), evidence-backed 5D peer style cards, unbounded self-directed `continuity_recall`, async Sleep-Time compute worker, time-travel replay harness |
| **Deep vertical specialist / compliance / consulting agent** | `@agentpro/scroll` + `@agentpro/scroll-continuity` + **`@agentpro/scroll-advisory`** | Everything above PLUS Tri-Partite Domain Cortex (`T1` normative rules · `T2` verified CBR cases · `T3` TTL-bounded Software Reality Atlas), Enabling 5-Step Consulting Lens, Tier `A/B/C/D` Graceful Boundary Guard, Apprenticeship Promotion Ladder, and 7-Metric Vertical Consulting Bench + 3-Stage Regression Gate |

## Design Principles

1. **Zero external dependencies:** Uses Node.js native `node:sqlite` (`DatabaseSync` + `FTS5`, Node `>= 22.13`) behind a pluggable `StorageAdapter` interface.
2. **Enabling harness — never throttles model reasoning:** Pre-loads a compact top-12 desk and 1-line parked index (preventing tunnel vision), while keeping unbounded `continuity_recall` available whenever the model wants raw history.
3. **Strict tenant & epistemic isolation:** Every business table keys on `tenant_id`; every revision/edge requires `support` provenance; `user_claim` cannot be conflated with `business_settlement`.
4. **Zero-latency background consolidation:** Sleep-Time compute runs asynchronously via `onTurnCompleted` with `as_of_seq` compare-and-swap (CAS).

## Quick Start

```js
import { createContinuityEngine } from '@agentpro/scroll-continuity';

const continuity = createContinuityEngine({ dbPath: './state/continuity.sqlite' });
continuity.recordEvent('tenant-a', {
  channel: 'chat',
  sourceUpdateId: 'msg-101',
  chatId: 'room-1',
  senderId: 'u-1',
  senderName: 'Alex',
  eventType: 'user_msg',
  body: 'We need the Q3 filing done by Oct 30. Also wondering about benefits setup.',
});

const desk = continuity.buildWorkingDesk('tenant-a', {
  query: 'Q3 filing status',
  activeSpeakerId: 'u-1',
});
```
