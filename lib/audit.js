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
import { checkAgent, checkMcpConfigPinning, parseFrontmatter } from './scroll.js';
import { parseGoldCase } from './eval.js';
import { confirmRequired } from './effects.js';
import { checkSkills } from './skills.js';
import { openTeam, scanForPeople } from './people.js';
import { openUser } from './user.js';

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
  for (const f of ['IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'hard-rules.md', '.mcp.json']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      try { if (fs.statSync(p).isFile()) h.update(`${f}\0`).update(fs.readFileSync(p)); } catch { /* skip */ }
    }
  }
  // Include custom `hard_rules` files referenced in IDENTITY.md frontmatter
  try {
    const idPath = path.join(dir, 'IDENTITY.md');
    if (fs.existsSync(idPath)) {
      const { frontmatter } = parseFrontmatter(fs.readFileSync(idPath, 'utf8'));
      const customRules = frontmatter?.hard_rules;
      const list = Array.isArray(customRules) ? customRules : (typeof customRules === 'string' ? [customRules] : []);
      for (const rel of list.map(String).sort()) {
        const p = path.resolve(dir, rel);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          h.update(`hard_rules:${rel}\0`).update(fs.readFileSync(p));
        }
      }
    }
  } catch { /* skip */ }
  // Include memory/lessons.md if present inside the agent folder
  const lessonsPath = path.join(dir, 'memory', 'lessons.md');
  if (fs.existsSync(lessonsPath)) {
    try { if (fs.statSync(lessonsPath).isFile()) h.update('memory/lessons.md\0').update(fs.readFileSync(lessonsPath)); } catch { /* skip */ }
  }
  // Hash evals/** recursively so nested fixtures/suites cannot be modified undetected
  hashTree(h, path.join(dir, 'evals'), 'evals');
  hashTree(h, path.join(dir, 'skills'), 'skills');   // v1.8: the agent's own skills are part of the agent
  h.update('people\0').update(JSON.stringify(scanForPeople(dir)));   // v1.9 §41: a card dropped in later breaks --verify
  return h.digest('hex').slice(0, 16);
}

// ── §41 privacy: nothing about a person travels inside something meant to be shared ──
// Shared = every agent folder, every repo skill, every plugin bundle (a folder with a manifest, or a
// .plugin/.zip archive). The cards themselves live in the deployment's people dir, outside all of it.
const PKG_SKIP = new Set(['node_modules', '.git', 'runs', '.scroll', '.build', 'agents', 'skills', 'people', 'knowledge']);
function findBundles(cwd, maxDepth = 3) {
  const out = [];
  const has = (d, f) => fs.existsSync(path.join(d, f));
  const pluginManifest = (d) => has(d, 'plugin.json') || has(d, path.join('.claude-plugin', 'plugin.json'));
  // a bundle: a plugin manifest, or the agent-pack shape `scroll plugin add` reads (manifest.json + agents/ or skills/)
  const isBundle = (d) => pluginManifest(d) || (has(d, 'manifest.json') && (has(d, 'agents') || has(d, 'skills')));
  if (pluginManifest(cwd)) out.push(cwd);   // the repo itself is published as a plugin
  (function walk(d, depth) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (PKG_SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.claude-plugin')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (isBundle(p)) out.push(p); else if (depth < maxDepth) walk(p, depth + 1); }
      else if (e.isFile() && /\.(plugin|zip)$/i.test(e.name)) out.push(p);
    }
  })(cwd, 1);
  return out;
}
function privacyLabel(kind) {
  if (kind === 'user-md') return 'a USER.md';
  if (kind === 'people-dir') return 'a people/ folder';
  if (kind === 'knowledge-dir') return 'a knowledge/ folder';
  if (kind === 'card') return 'a person card';
  return 'a person card, USER.md or knowledge/ inside the archive';
}
// §41 content-leak check: scan shareable packages (agents/, skills/, plugin bundles) for canary strings
export function scanCanaries(cwd, canaries = []) {
  const tokens = [...new Set((canaries || []).map((x) => String(x || '').trim()).filter((x) => x.length >= 6))];
  if (!tokens.length) return [];
  const hits = [];
  const scanFile = (file, label) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const tok of tokens) {
      if (text.includes(tok)) hits.push({ file: label, canary: tok });
    }
  };
  const walkDir = (dir, prefix, depth = 0) => {
    if (!fs.existsSync(dir) || depth > 6) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.build') continue;
      const p = path.join(dir, e.name);
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) walkDir(p, rel, depth + 1);
      else if (e.isFile()) scanFile(p, rel);
    }
  };
  walkDir(path.join(cwd, 'agents'), 'agents');
  walkDir(path.join(cwd, 'skills'), 'skills');
  for (const b of findBundles(cwd)) {
    const rel = path.relative(cwd, b) || '.';
    if (fs.statSync(b).isDirectory()) walkDir(b, rel);
    else scanFile(b, rel);
  }
  return hits;
}
export function auditPrivacy(cwd = process.cwd(), opts = {}) {
  const issues = [];
  const say = (where, h) => issues.push(`${where}${h.file ? '/' + h.file : ''}${h.entry ? ' → ' + h.entry : ''}: ${privacyLabel(h.kind)} — shared packages never carry people or deployment data; USER.md and knowledge/ live at deployment root (§41)`);
  const sk = path.join(cwd, 'skills');
  if (fs.existsSync(sk)) for (const n of fs.readdirSync(sk).sort()) for (const h of scanForPeople(path.join(sk, n))) say(`skills/${n}`, h);
  for (const b of findBundles(cwd)) {
    const rel = path.relative(cwd, b) || '.';
    for (const h of scanForPeople(b)) say(rel, h);
  }
  const userDoc = openUser({ cwd });
  const canaries = [...userDoc.canaries(), ...(opts.canaries || [])];
  for (const hit of scanCanaries(cwd, canaries)) {
    issues.push(`${hit.file}: leaked private canary "${hit.canary.slice(0, 12)}..." inside a shareable package (§41)`);
  }
  return issues;
}
// every file under a folder, in a fixed order (symlinks are not followed)
function hashTree(h, dir, label) {
  if (!fs.existsSync(dir)) return;
  (function walk(d, rel) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name); const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) { try { h.update(`${r}\0`).update(fs.readFileSync(p)); } catch { /* skip */ } }
      else if (e.isSymbolicLink()) { try { h.update(`${r}\0->${fs.readlinkSync(p)}`); } catch { /* skip */ } }
    }
  })(dir, label);
}
function repoSkillsHash(cwd) {
  const h = crypto.createHash('sha256');
  hashTree(h, path.join(cwd, 'skills'), 'skills');
  return h.digest('hex').slice(0, 16);
}

// ── §30 fixture provenance ──
// A suite where every precondition was hand-built is a suite that grades nothing but itself.
function auditFixtures(evalsDir) {
  if (!fs.existsSync(evalsDir)) return [];
  const files = fs.readdirSync(evalsDir).filter((f) => f.endsWith('.md') && f !== 'rubric.md');
  if (!files.length) return [];
  const out = [];
  const provs = [];
  for (const f of files) {
    let gc; try { gc = parseGoldCase(fs.readFileSync(path.join(evalsDir, f), 'utf8'), f); } catch { continue; }
    const fx = gc.fixture || {};
    provs.push(fx.provenance || null);
    for (const issue of fx.issues || []) out.push(`evals/${f}: ${issue} (§30)`);
  }
  const declared = provs.filter(Boolean);
  if (declared.length && declared.every((p) => p === 'synthetic')) {
    out.push('every gold case uses a hand-built fixture (provenance=synthetic) — the path that should CREATE these preconditions is unverified; add at least one `product-path` case covering arm/setup (§30)');
  }
  return out;
}

// ── §28 effect confirmation ──
// A write nobody reads back is a write nobody has evidence of.
function auditConfirms(agentDir, cwd) {
  const out = [];
  for (const file of [path.join(agentDir, '.mcp.json'), path.join(cwd, '.mcp.json')]) {
    if (!fs.existsSync(file)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const servers = j.mcpServers || {};
    for (const [srv, cfg] of Object.entries(servers)) {
      for (const [tool, t] of Object.entries((cfg && cfg.tools) || {})) {
        const tier = t && t.risk;
        if (!confirmRequired(tier)) continue;
        if (!t.confirm || !t.confirm.probe || !t.confirm.expect) {
          out.push(`${srv}.${tool}: risk=${tier} write has no \`confirm\` { probe, expect } — a non-error response is not evidence the write happened; a conformant runner blocks it (§28)`);
        }
      }
    }
  }
  return out;
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
    warnings.push(...auditFixtures(evalsDir));            // §30
    warnings.push(...auditConfirms(dir, cwd));            // §28
    const errors = [...c.errors];
    for (const h of scanForPeople(dir)) errors.push(`agents/${name}/${h.file}: ${privacyLabel(h.kind)} — an agent folder never carries a person or deployment data (§7, §41); move USER.md and knowledge/ to deployment root`);
    let skills = null;
    if (!c.errors.length) {                               // v1.8 §36: skills the agent and repo ship
      const sk = checkSkills(cwd, name);
      errors.push(...sk.errors); warnings.push(...sk.warnings);
      skills = sk.counts;
    }
    return { name, level: c.level, errors, warnings, evalCount, skills, filesHash: fs.existsSync(dir) ? agentFilesHash(dir) : null };
  });
  const conventions = scanConventions(cwd);
  for (const errMsg of checkMcpConfigPinning(cwd)) {
    conventions.push({ rule: 'mcp-unpinned-package', severity: 'error', file: '.mcp.json', line: 0, msg: errMsg });
  }
  const people = auditPeople(cwd, agents.map((a) => ({ name: a.name, identity: identityOf(path.join(base, a.name)) })), opts);
  const errorCount = agents.reduce((s, a) => s + a.errors.length, 0) + conventions.filter((c) => c.severity === 'error').length + people.errors.length;
  const warnCount = agents.reduce((s, a) => s + a.warnings.length, 0) + conventions.filter((c) => c.severity === 'warn').length + people.warnings.length;
  return {
    tool: '@agentpro/scroll audit', generatedAt: new Date().toISOString(),
    agents, conventions, people, errorCount, warnCount, skillsHash: repoSkillsHash(cwd),
    privacyHash: crypto.createHash('sha256').update(JSON.stringify(people.privacy)).digest('hex').slice(0, 16),
    verdict: errorCount === 0 ? 'pass' : 'fail',
  };
}

function identityOf(dir) {
  try { return parseFrontmatter(fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf8')).frontmatter || {}; } catch { return {}; }
}
// §38–§41 at the repo level: shared packages carry no people; the cards (if any) are valid; the people
// dir is outside agents/ and out of git unless the deployment says otherwise; person-owned WORK.md
// steps name people who have a card.
export function auditPeople(cwd = process.cwd(), agents = [], opts = {}) {
  const errors = [], warnings = [];
  const privacy = auditPrivacy(cwd, opts);
  errors.push(...privacy);
  let userDoc = null;
  try { userDoc = openUser({ cwd }); } catch (e) { errors.push(`user: ${e.message}`); }
  if (userDoc && userDoc.exists) {
    const uc = userDoc.check({ agents });
    errors.push(...uc.errors); warnings.push(...uc.warnings);
    const inRepo = userDoc.file.startsWith(cwd + path.sep);
    if (inRepo && !userDoc.cfg.tracked) {
      const rel = path.relative(cwd, userDoc.file).split(path.sep).join('/');
      const gi = fs.existsSync(path.join(cwd, '.gitignore')) ? fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8').split('\n').map((l) => l.trim().replace(/^\//, '').replace(/\/$/, '')) : [];
      if (!gi.includes(rel) && !gi.includes('USER.md')) warnings.push(`${rel} is not in .gitignore — USER.md is private by default; ignore it, or set user.tracked: true for a private repo (§41)`);
    }
  }
  let team = null;
  try { team = openTeam({ cwd }); } catch (e) { errors.push(`people: ${e.message}`); }
  if (team) {
    // When deployment USER.md is active, role coverage is checked against USER.md above — do not emit
    // spurious legacy people/ "nobody holds role" warnings for an unused people/ directory (§44).
    const chk = team.check({ agents: (userDoc && userDoc.exists) ? [] : agents });
    errors.push(...chk.errors); warnings.push(...chk.warnings);
    const inRepo = team.dir.startsWith(cwd + path.sep);
    if (inRepo && fs.existsSync(team.dir) && !team.cfg.tracked) {
      const rel = path.relative(cwd, team.dir).split(path.sep).join('/');
      const gi = fs.existsSync(path.join(cwd, '.gitignore')) ? fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8').split('\n').map((l) => l.trim().replace(/^\//, '').replace(/\/$/, '')) : [];
      if (!gi.includes(rel)) warnings.push(`${rel}/ is not in .gitignore — person cards are private by default; ignore it, or set people.tracked: true for a private repo (§41)`);
    }
    const wp = path.join(cwd, 'WORK.md');
    if (fs.existsSync(wp)) {
      const persons = [...fs.readFileSync(wp, 'utf8').matchAll(/^\s*owner:\s*["']?person:([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
      for (const p of [...new Set(persons)]) {
        if (userDoc && userDoc.exists) {
          if (!userDoc.get(p) || !userDoc.get(p).valid) errors.push(`WORK.md: step owned by person:${p}, who is not a valid entry in USER.md (§40)`);
        } else if (!fs.existsSync(team.dir)) {
          warnings.push(`WORK.md: step owned by person:${p}, but there is no USER.md or people dir here to check the person`);
        } else if (!team.get(p) || !team.get(p).valid) {
          errors.push(`WORK.md: step owned by person:${p}, who has no valid card (§40)`);
        }
      }
    }
  }
  return { errors, warnings, privacy, cards: (userDoc && userDoc.exists ? userDoc.cards.size : 0) + (team ? team.cards.size : 0), userActive: !!(userDoc && userDoc.active) };
}

// CI / anti-fabrication: compare current file state to the committed .scroll/audit.json.
// No report, hash drift, or a recorded failure → not trustworthy → fail.
export function verifyAgainstRecord(cwd, fresh) {
  const recPath = path.join(cwd, '.scroll', 'audit.json');
  if (!fs.existsSync(recPath)) return { ok: false, reason: 'no .scroll/audit.json — `scroll audit` was never run here (a self-claim is not evidence)' };
  let prev; try { prev = JSON.parse(fs.readFileSync(recPath, 'utf8')); } catch { return { ok: false, reason: '.scroll/audit.json is unreadable' }; }
  const prevHash = Object.fromEntries((prev.agents || []).map((a) => [a.name, a.filesHash]));
  const drifted = fresh.agents.filter((a) => prevHash[a.name] !== a.filesHash).map((a) => a.name);
  if (prev.skillsHash !== undefined && prev.skillsHash !== fresh.skillsHash) drifted.push('skills/');
  if (prev.privacyHash !== undefined && prev.privacyHash !== fresh.privacyHash) drifted.push('shared packages (people)');
  if (drifted.length) return { ok: false, reason: `files changed since the recorded audit: ${drifted.join(', ')} — re-run \`scroll audit\` (the report no longer matches the code)` };
  if (prev.verdict !== 'pass') return { ok: false, reason: 'the recorded audit verdict was not "pass"' };
  if (fresh.verdict !== 'pass') return { ok: false, reason: 'current audit does not pass' };
  return { ok: true, reason: 'audit record matches current file state and passes' };
}
