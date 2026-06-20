---
# LOOP.md — the OUTER loop (loop engineering). `scroll loop LOOP.md` runs it.
#
# The inner loop (`scroll run`) executes ONE WORK.md with a harness. This file defines the system
# that decides WHEN to start an inner loop, WHERE it finds work, and WHEN to stop — so the agent
# finds its own work, does it, verifies it, and remembers it, without a human prompting each turn.
id: market-watch-daily
controller: lead                       # one owner of the outer loop

schedule:                              # when to wake (host scheduler: cron / scheduled-tasks / HEARTBEAT)
  cron: "0 7 * * *"                    # 07:00 daily

work_source:                           # where each iteration finds its work
  type: work_file                      # work_file | inline | glob
  query: WORK.md                       # the WORK.md to run each iteration

stop_conditions:                       # at least ONE is REQUIRED — a loop with no stop is refused
  max_runs_per_day: 4
  budget_usd_per_day: 5
  until: "2026-12-31"
  halt_on: [gate_denied, verify_fail]  # halt the loop on a denied gate or a failed verification

budget:
  per_run:
    max_usd: 2

digest: required                       # write a human-readable digest after every inner run
language: en
---

# Goal

Describe, in plain prose, what this outer loop is for and where its boundaries are. Example:

> Each morning, re-run the market-entry WORK.md against the latest sources, write a digest, and
> stop for the day after 4 runs or $5 — whichever comes first. Halt immediately if any gated action
> is denied or a run fails verification, and wait for a human.
