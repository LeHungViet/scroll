// SCROLL — skill eval (v1.8 §36.3): does a skill make the work better, on each model it will run on?
//
// Every case runs twice per model: once with the skill, once without (the baseline). Machine checks
// grade both; an optional judge compares the two answers blind (it never learns which one had the
// skill). The record says what the skill adds, not only whether the answer passed:
//   keep             the skill passes and beats the baseline somewhere
//   retire-or-rewrite the model already does as well without it (the skill only costs tokens)
//   fix              the skill's own runs fail
// Verdicts stay ternary (§29): a case nobody could grade is `ungraded`, never a pass.
//
// Cases live in the skill folder, so they travel with it:
//   evals/*.md        SCROLL gold cases (§8: ## Input, ```checks, ## Rubric)
//   evals/evals.json  { "evals": [{ "id", "prompt", "expected_output", "expectations": [], "files": [], "checks": [] }] }
//                     (the layout other skill tools use; `checks` is the SCROLL machine-check extension)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseGoldCase, runChecks } from './eval.js';
import { pickProvider } from './providers.js';
import { openSkills } from './skills.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);

export function loadSkillCases(skillDir) {
  const ev = path.join(skillDir, 'evals');
  const out = [];
  if (!fs.existsSync(ev)) return out;
  for (const f of fs.readdirSync(ev).filter((x) => x.endsWith('.md') && x !== 'rubric.md').sort()) {
    const gc = parseGoldCase(fs.readFileSync(path.join(ev, f), 'utf8'), f);
    out.push({ id: gc.id, input: gc.input, checks: gc.checks, rubric: gc.rubric, runs: gc.runs, threshold: gc.threshold, files: [], from: `evals/${f}` });
  }
  const jp = path.join(ev, 'evals.json');
  if (fs.existsSync(jp)) {
    let j; try { j = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch (e) { throw new Error(`evals/evals.json: ${e.message}`); }
    arr(j.evals).forEach((e, i) => {
      if (!e || !e.prompt) return;
      const rubric = [e.expected_output, ...arr(e.expectations)].filter(Boolean).map((x) => `- ${x}`).join('\n');
      out.push({ id: String(e.id ?? i + 1), input: String(e.prompt), checks: arr(e.checks).filter((c) => c && c.op), rubric, runs: Number(e.runs) || 3, threshold: Number(e.pass_consistency ?? 0.66), files: arr(e.files).map(String), from: 'evals/evals.json' });
    });
  }
  return out;
}

function attachFiles(skillDir, files) {
  const parts = [];
  for (const f of files) {
    const p = path.resolve(skillDir, f);
    if (!p.startsWith(path.resolve(skillDir) + path.sep) || !fs.existsSync(p)) { parts.push(`[attached file ${f}: not found]`); continue; }
    const buf = fs.readFileSync(p);
    parts.push(buf.subarray(0, 8192).includes(0) ? `[attached file ${f}: binary, ${buf.length} bytes]` : `Attached file ${f}:\n${buf.toString('utf8').slice(0, 32000)}`);
  }
  return parts.join('\n\n');
}

const COMPARE_SENTINEL = 'SCROLL_COMPARE_JSON';
function comparePrompt(task, rubric, a, b) {
  return [
    `You compare two answers to the same task (${COMPARE_SENTINEL}). Judge only against the criteria.`,
    'Return JSON only: {"winner": "A" | "B" | "tie", "why": "<one sentence>"}',
    '', '## TASK', task, '', '## CRITERIA', rubric || '(none: judge correctness and completeness)', '', '## ANSWER A', a || '(empty)', '', '## ANSWER B', b || '(empty)',
  ].join('\n');
}
// The order of the two answers alternates case by case (from a per-model seed), so over a suite the
// skill's answer is "A" about half the time: replayable, and a judge that prefers a position gains nothing.
async function compareBlind(prov, model, task, rubric, withText, withoutText, seed, position) {
  const swap = (parseInt(sha(seed).slice(0, 2), 16) + position) % 2 === 1;
  const [a, b] = swap ? [withoutText, withText] : [withText, withoutText];
  let res; try { res = await prov.generate(comparePrompt(task, rubric, a, b), { model }); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  const m = String(res.text || '').match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'comparator returned no JSON' };
  let j; try { j = JSON.parse(m[0]); } catch (e) { return { ok: false, error: 'comparator JSON: ' + e.message }; }
  const w = String(j.winner || '').toUpperCase();
  if (!['A', 'B', 'TIE'].includes(w)) return { ok: false, error: `comparator winner "${j.winner}"` };
  const winner = w === 'TIE' ? 'tie' : ((w === 'A') !== swap ? 'with' : 'without');
  return { ok: true, winner, why: String(j.why || '').slice(0, 300) };
}

async function runSide(prov, model, prompt, runs, checks, cwd) {
  let pass = 0, tokens = 0, ms = 0, last = '', errs = 0;
  for (let i = 0; i < runs; i++) {
    let out = null;
    try { out = await prov.generate(prompt, { cwd, model }); } catch { errs++; continue; }
    last = out.text || '';
    tokens += (out.usage?.uncachedInputTokens || 0) + (out.usage?.cachedInputTokens || 0) + (out.usage?.outputTokens || 0);
    ms += out.durationMs || 0;
    if (checks.length && runChecks(last, checks).allPass) pass++;
  }
  return { pass, runs, rate: runs ? +(pass / runs).toFixed(3) : 0, tokens, ms, last, errors: errs };
}

export async function runSkillEval(name, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const reg = opts.registry || openSkills({ cwd, agent: opts.agent || null, compatFile: false });
  const skill = reg.get(name);
  if (!skill) return { skill: name, ok: false, error: `skill "${name}" is not available (run: scroll skill list --all)` };
  const cases = loadSkillCases(skill.dir);
  if (!cases.length) return { skill: name, ok: false, error: 'no eval cases in evals/ (gold-case .md files or evals/evals.json)' };
  const view = reg.view(name);
  if (!view.ok) return { skill: name, ok: false, error: view.error };
  const providers = arr(opts.providers && opts.providers.length ? opts.providers : ['auto']);
  const results = [];
  for (const pv of providers) {
    const prov = typeof pv === 'object' ? pv : pickProvider(pv, { model: opts.model });
    if (!prov.ready) { results.push({ provider: prov.name, model: prov.model, error: `not ready: ${prov.missing}`, cases: [], ok: false }); continue; }
    let judge = null;
    if (opts.judge) {
      const jp = opts.judgeProvider;
      judge = typeof jp === 'object' && jp ? jp : pickProvider(jp || (typeof pv === 'string' ? pv : 'auto'), { model: opts.judgeModel || opts.model });
      if (!judge.ready) judge = null;
    }
    const rows = [];
    for (const cs of cases) {
      const runs = Math.max(1, Number(opts.n) || cs.runs || 3);
      const files = cs.files.length ? `\n\n${attachFiles(skill.dir, cs.files)}` : '';
      const task = `${cs.input}${files}`;
      const withPrompt = `Follow this skill for the task below.\n\n<skill name="${skill.name}">\n${view.text}\n</skill>\n\nTask:\n${task}`;
      const withoutPrompt = `Task:\n${task}`;
      const w = await runSide(prov, opts.model, withPrompt, runs, cs.checks, cwd);
      const wo = await runSide(prov, opts.model, withoutPrompt, runs, cs.checks, cwd);
      let cmp = null;
      if (judge) cmp = await compareBlind(judge, opts.judgeModel || opts.model, task, cs.rubric, w.last, wo.last, `${prov.name}|${prov.model}`, rows.length);
      const machine = cs.checks.length > 0;
      let verdict;
      if (!machine && !(cmp && cmp.ok)) verdict = 'ungraded';
      else if (machine && w.errors === runs) verdict = 'ungraded';
      else {
        const machinePass = !machine || w.rate >= cs.threshold;
        const judgePass = !(cmp && cmp.ok) || cmp.winner !== 'without';
        verdict = machinePass && judgePass ? 'pass' : 'fail';
      }
      const better = (machine && w.rate > wo.rate) || (cmp && cmp.ok && cmp.winner === 'with');
      const noBetter = (machine ? w.rate <= wo.rate : true) && (!cmp || !cmp.ok || cmp.winner !== 'with');
      rows.push({ id: cs.id, from: cs.from, runs, checks: cs.checks.length, verdict,
        with: { pass: w.pass, rate: w.rate, tokens: w.tokens, ms: w.ms, errors: w.errors },
        without: { pass: wo.pass, rate: wo.rate, tokens: wo.tokens, ms: wo.ms, errors: wo.errors },
        compare: cmp, addsValue: !!better, baselineAsGood: verdict !== 'ungraded' && noBetter });
    }
    const graded = rows.filter((r) => r.verdict !== 'ungraded');
    results.push({ provider: prov.name, model: prov.model, cases: rows, ok: graded.length > 0 && graded.every((r) => r.verdict === 'pass'),
      gradable: graded.length, passed: graded.filter((r) => r.verdict === 'pass').length, ungraded: rows.length - graded.length,
      tokensWith: rows.reduce((s, r) => s + r.with.tokens, 0), tokensWithout: rows.reduce((s, r) => s + r.without.tokens, 0) });
  }
  const graded = results.flatMap((r) => r.cases.filter((c) => c.verdict !== 'ungraded'));
  const ok = results.length > 0 && results.every((r) => r.ok);
  const recommendation = !graded.length ? 'ungraded' : !ok ? 'fix' : graded.every((c) => c.baselineAsGood) ? 'retire-or-rewrite' : 'keep';
  const report = { skill: name, hash: skill.hash, source: skill.source, ts: new Date().toISOString(), cases: cases.length, providers: results, ok, recommendation };
  if (opts.write !== false) {
    try {
      const dir = path.join(cwd, '.scroll', 'skill-eval'); fs.mkdirSync(dir, { recursive: true });
      report.recordHash = sha(JSON.stringify(report.providers) + report.hash + report.ts);
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(report, null, 2) + '\n');
    } catch { /* the record is best-effort; the verdict above is not */ }
  }
  return report;
}
