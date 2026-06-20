// SCROLL — `scroll audit`: verify a repo actually FOLLOWS SCROLL, beyond frontmatter structure.
//
// Why: a coding agent (Claude Code / Cursor / Cowork) is told the rules in AGENTS.md, but it can
// improvise, fabricate, or claim "I followed SCROLL" without doing it. `scroll check` only validates
// an agent folder's structure. `scroll audit` adds (1) a repo-wide convention scan that catches the
// common deviations, and (2) a hash-bound report so a "pass" is tied to the exact file state — a claim
// that can't be faked. Run it in CI/pre-commit: the verdict comes from the machine, not the agent.
//
// Static + deterministic + zero model call. Semantic deviations (a subtly wrong SOUL, off-task output)
// are the EVAL's job (gold cases) — audit is the structural + convention + provenance layer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkAgent } from './scroll.js';

// ── convention rules (high-signal, low-false-positive) ──
const VENDOR_MODEL_RE = /\b(claude-(?:[0-9]|3|sonnet|opus|haiku)|gpt-(?:[0-9]|4|5)|o[134](?:-mini)?\b|gemini-(?:[0-9]|1|2)|grok-[0-9])/i;
const PROMPT_VAR_RE = /\b(system_?prompt|persona|instructions|SYSTEM_PROMPT|systemMessage|agentPrompt)\b\s*[:=]\s*[`'"]/;
const PROMPT_TEXT_RE = /[`'"]\s*(you are an?\b|your role is\b|you are the\b|bạn là (?:một )?)/i;
const BANNED_DEPS = [
  'langchain', '@langchain/core', 'langgraph', 'llamaindex', 'crewai',
  'pinecone', '@pinecone-database/pinecone', 'weaviate-ts-client', 'chromadb', 'qdrant', '@qdrant/js-client-rest',
  'kafkajs', 'amqplib', 'bullmq', 'bee-queue',
];
const SKIP_DIRS = new Set(['node_modules', '.git', 'runs', '.build', '.scroll', 'agents', 'dist', 'build', 'coverage', 'test', 'tests', '__tests__', 'eval', 'evals']);

function listCodeFiles(cwd) {
  const out = [];
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name !== '.' && e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|cjs|ts|tsx|jsx|py)$/.test(e.name)) out.push(p);
    }
  })(cwd);
  return out;
}

export function scanConventions(cwd = process.cwd()) {
  const issues = [];
  const add = (rule, severity, file, line, msg) => issues.push({ rule, severity, file: path.relative(cwd, file) || file, line, msg });

  // banned infra in package.json (clearest architectural violation)
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const d of BANNED_DEPS) if (deps[d]) add('banned-infra', 'error', pkgPath, 0, `dependency "${d}" — SCROLL coordinates through the filesystem, not an engine/DB/queue/graph framework`);
    } catch { /* ignore unparseable package.json */ }
  }

  // scan app code for persona/model that belongs in the agent folder
  for (const f of listCodeFiles(cwd)) {
    let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    lines.forEach((ln, i) => {
      const n = i + 1;
      if (PROMPT_VAR_RE.test(ln) || PROMPT_TEXT_RE.test(ln)) add('prompt-in-code', 'warn', f, n, 'persona/system-prompt text in code — move it to the agent SOUL.md');
      if (VENDOR_MODEL_RE.test(ln)) add('hardcoded-model', 'warn', f, n, 'hardcoded model id in code — declare it in IDENTITY.md and pass it as a parameter (ignore if this is your provider/tool adapter)');
    });
  }
  return issues;
}

// content hash binds a "pass" to the exact agent file state (anti-fabrication / anti-drift)
function agentFilesHash(dir) {
  const h = crypto.createHash('sha256');
  for (const f of ['IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'hard-rules.md']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) h.update(`${f}\0`).update(fs.readFileSync(p));
  }
  const ev = path.join(dir, 'evals');
  if (fs.existsSync(ev)) for (const f of fs.readdirSync(ev).sort()) {
    const p = path.join(ev, f);
    try { if (fs.statSync(p).isFile()) h.update(`evals/${f}\0`).update(fs.readFileSync(p)); } catch { /* skip */ }
  }
  return h.digest('hex').slice(0, 16);
}

export function auditRepo(cwd = process.cwd(), opts = {}) {
  const base = path.join(cwd, 'agents');
  const names = opts.name
    ? [opts.name]
    : (fs.existsSync(base) ? fs.readdirSync(base).filter((n) => fs.existsSync(path.join(base, n, 'IDENTITY.md'))) : []);
  const agents = names.map((name) => {
    const c = checkAgent(name, cwd);
    const dir = path.join(base, name);
    const evalsDir = path.join(dir, 'evals');
    const evalCount = fs.existsSync(evalsDir) ? fs.readdirSync(evalsDir).filter((f) => f.endsWith('.md') && f !== 'rubric.md').length : 0;
    const warnings = [...c.warnings];
    if (evalCount < 3) warnings.push(`only ${evalCount} gold eval case(s) — SCROLL expects ≥3 before an agent ships`);
    return { name, level: c.level, errors: c.errors, warnings, evalCount, filesHash: fs.existsSync(dir) ? agentFilesHash(dir) : null };
  });
  const conventions = scanConventions(cwd);
  const errorCount = agents.reduce((s, a) => s + a.errors.length, 0) + conventions.filter((c) => c.severity === 'error').length;
  const warnCount = agents.reduce((s, a) => s + a.warnings.length, 0) + conventions.filter((c) => c.severity === 'warn').length;
  return {
    tool: '@agentpro/scroll audit', generatedAt: new Date().toISOString(),
    agents, conventions, errorCount, warnCount,
    verdict: errorCount === 0 ? 'pass' : 'fail',
  };
}

// CI / anti-fabrication: compare current file state to the committed .scroll/audit.json.
// No report, hash drift, or a recorded failure → not trustworthy → fail.
export function verifyAgainstRecord(cwd, fresh) {
  const recPath = path.join(cwd, '.scroll', 'audit.json');
  if (!fs.existsSync(recPath)) return { ok: false, reason: 'no .scroll/audit.json — `scroll audit` was never run here (a self-claim is not evidence)' };
  let prev; try { prev = JSON.parse(fs.readFileSync(recPath, 'utf8')); } catch { return { ok: false, reason: '.scroll/audit.json is unreadable' }; }
  const prevHash = Object.fromEntries((prev.agents || []).map((a) => [a.name, a.filesHash]));
  const drifted = fresh.agents.filter((a) => prevHash[a.name] !== a.filesHash).map((a) => a.name);
  if (drifted.length) return { ok: false, reason: `files changed since the recorded audit: ${drifted.join(', ')} — re-run \`scroll audit\` (the report no longer matches the code)` };
  if (prev.verdict !== 'pass') return { ok: false, reason: 'the recorded audit verdict was not "pass"' };
  if (fresh.verdict !== 'pass') return { ok: false, reason: 'current audit does not pass' };
  return { ok: true, reason: 'audit record matches current file state and passes' };
}
