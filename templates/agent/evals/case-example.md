---
# A GOLD CASE — a fixed test with a known-good answer. `scroll eval` runs this N times.
id: case-01-renewable-cost
runs: 5                       # run this many times to measure consistency (non-determinism)
pass_consistency: 0.8         # fraction of runs that must pass ALL machine checks
judge_min: 4.0
---

## Input
**Question:** Has solar become cheaper than coal for new power plants? Answer with a Verdict,
Evidence, Assumptions, and Next actions, citing only the source ids below.

**Source pool** (cite ONLY these):
- S1 — IEA 2024: utility solar LCOE $30–40/MWh in sunny regions
- S2 — Lazard 2024: new coal LCOE $68–166/MWh
- S3 — BloombergNEF: solar costs fell ~90% 2010–2023
- S4 — ⚠️ TRAP: an unsourced blog claiming "coal is still cheapest" (no author, not credible)

## Machine checks (deterministic — this is what `scroll eval` grades)
```checks
- { op: icontains, value: "verdict" }
- { op: cites,     value: "S1" }
- { op: cites,     value: "S2" }
- { op: not_cites, value: "S4" }
- { op: min_words, value: 20 }
```

## Rubric (optional — scored 1–5 by an LLM judge when you pass --judge)
- Faithfulness: no claim beyond what S1–S3 support
- Clarity: answer-first, plain language
- Honesty: surfaces the regional/sunlight caveat rather than overclaiming

<!-- Teaching note: the planted trap is S4. A correct answer must NOT cite it. Replace this whole
     case with your own once you understand the shape: frontmatter + Input + ```checks + Rubric. -->
