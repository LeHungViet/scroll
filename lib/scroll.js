// SCROLL — filesystem-native agent framework CLI (+ scroll audit · v1.8 scroll skill: load, check, scan, eval)
// One module, no engine. Reads agent folders, validates, transpiles. ~spec v1.2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStyle, SPEAKS_AS_VALUES } from './style.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Minimal YAML-subset parser (zero-dep). Covers SCROLL frontmatter:
//    scalars, quoted strings, inline [..] / {..}, block maps + block sequences (indent-based).
//    Frontmatter is simple by design; full YAML is intentionally out of scope.
function stripComment(line) {
  let q = null, out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { out += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}
function splitTopLevel(s) {
  const parts = []; let depth = 0, q = null, cur = '';
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function yScalar(v) {
  v = v.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'")) return v.slice(1, -1);
  if (v[0] === '[' && v.at(-1) === ']') return splitTopLevel(v.slice(1, -1)).map(yScalar).filter((x) => x !== '');
  if (v[0] === '{' && v.at(-1) === '}') {
    const o = {};
    for (const pair of splitTopLevel(v.slice(1, -1))) {
      const ci = pair.indexOf(':'); if (ci < 0) continue;
      const k = pair.slice(0, ci).trim().replace(/^["']|["']$/g, '');
      o[k] = yScalar(pair.slice(ci + 1));
    }
    return o;
  }
  return v;
}
export function parseYaml(src) {
  const lines = String(src).split('\n').map(stripComment).filter((l) => l.trim() !== '');
  let idx = 0;
  const indentOf = (s) => s.match(/^ */)[0].length;
  function block(min) {
    let map = null, arr = null;
    while (idx < lines.length) {
      const line = lines[idx];
      const ind = indentOf(line);
      if (ind < min) break;
      if (ind > min) { idx++; continue; }
      const content = line.slice(ind);
      if (content === '-' || content.startsWith('- ')) {
        arr = arr || [];
        const rest = content.slice(1).trim();
        idx++;
        // Block map inside sequence item: `- id: ana\n  name: Ana`
        if (rest && !rest.startsWith('{') && !rest.startsWith('[') && !rest.startsWith('"') && !rest.startsWith("'") && /^[A-Za-z0-9_."-]+\s*:/.test(rest)) {
          const ci = rest.indexOf(':');
          const k = rest.slice(0, ci).trim().replace(/^["']|["']$/g, '');
          const v = rest.slice(ci + 1).trim();
          const item = {};
          if (v === '') {
            const nextInd = idx < lines.length ? indentOf(lines[idx]) : min;
            item[k] = (idx < lines.length && nextInd > ind + 2) ? block(nextInd) : null;
          } else {
            item[k] = yScalar(v);
          }
          const nextInd = idx < lines.length ? indentOf(lines[idx]) : min;
          if (idx < lines.length && nextInd > ind) {
            const extra = block(nextInd);
            if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(item, extra);
          }
          arr.push(item);
        } else if (rest === '') {
          const nextInd = idx < lines.length ? indentOf(lines[idx]) : min;
          arr.push(idx < lines.length && nextInd > ind ? block(nextInd) : null);
        } else {
          arr.push(yScalar(rest));
        }
      } else {
        const ci = content.indexOf(':');
        if (ci < 0) { idx++; continue; }
        const key = content.slice(0, ci).trim().replace(/^["']|["']$/g, '');
        const val = content.slice(ci + 1).trim();
        idx++;
        map = map || {};
        if (val === '') {
          const nextInd = idx < lines.length ? indentOf(lines[idx]) : min;
          map[key] = (idx < lines.length && nextInd > min) ? block(nextInd) : null;
        } else {
          map[key] = yScalar(val);
        }
      }
    }
    return arr !== null ? arr : (map || {});
  }
  return block(0);
}
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'agent');
const RUNTIMES = ['cowork', 'codex', 'gemini', 'claude-subagent', 'voice', 'a2a'];
const ROLE_REF_RE = /^(role:)?[a-z][a-z0-9_-]*$/;   // v1.9 §39
const CAP_RE = /^(fs|web|shell|mcp|vision|voice|dispatch|memory|skills|ask|message|tasks|knowledge)\.[a-z_]+$/;   // v1.7: memory.* (§31) · v1.8: skills.* ask.* message.* tasks.* (§35) · v1.9: knowledge.* (§43)

// ── ANSI helpers ──
const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

// ── Frontmatter ──
export function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: null, body: raw };
  let fm;
  try { fm = parseYaml(m[1]) || {}; }
  catch (e) { throw new Error(`frontmatter YAML invalid: ${e.message}`); }
  return { frontmatter: fm, body: m[2].trim() };
}

// ── Load an agent folder → structured object ──
export function loadAgent(name, cwd = process.cwd()) {
  const dir = path.join(cwd, 'agents', name);
  if (!fs.existsSync(dir)) throw new Error(`agent not found: agents/${name}/`);
  const read = (f) => { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  const identityRaw = read('IDENTITY.md');
  if (identityRaw == null) throw new Error(`agents/${name}/IDENTITY.md missing`);
  const { frontmatter, body } = parseFrontmatter(identityRaw);
  let hardRules = read('hard-rules.md');
  if (frontmatter && typeof frontmatter.hard_rules === 'string' && frontmatter.hard_rules.trim()) {
    const resolved = path.resolve(dir, frontmatter.hard_rules);
    if ((resolved === dir || resolved.startsWith(dir + path.sep)) && fs.existsSync(resolved)) {
      hardRules = fs.readFileSync(resolved, 'utf8');
    }
  }
  const evalsDir = path.join(dir, 'evals');
  const evals = fs.existsSync(evalsDir)
    ? fs.readdirSync(evalsDir).filter((f) => f.endsWith('.md') && f !== 'rubric.md')
    : [];
  return {
    name, dir, frontmatter, identityBody: body,
    soul: read('SOUL.md'), tools: read('TOOLS.md'), hardRules,
    lessons: read(path.join('memory', 'lessons.md')),
    evals,
  };
}

// ── CHECK: validate against spec → { errors, warnings, level } ──
export function checkAgent(name, cwd = process.cwd()) {
  const errors = [], warnings = [];
  let agent;
  try { agent = loadAgent(name, cwd); }
  catch (e) { return { errors: [e.message], warnings: [], level: null }; }
  const fm = agent.frontmatter;

  if (!fm || typeof fm !== 'object') {
    errors.push('IDENTITY.md has no valid frontmatter');
  } else {
    // required fields
    const req = ['name', 'title', 'version', 'runtimes', 'model', 'capabilities'];
    for (const k of req) if (fm[k] === undefined) errors.push(`IDENTITY: missing required field "${k}"`);
    // name
    if (fm.name && !/^[a-z][a-z0-9-]*$/.test(fm.name)) errors.push(`IDENTITY: name "${fm.name}" must match ^[a-z][a-z0-9-]*$`);
    if (fm.name && fm.name !== name) errors.push(`IDENTITY: name "${fm.name}" must equal folder name "${name}"`);
    // version
    if (fm.version && !/^\d+\.\d+\.\d+$/.test(String(fm.version))) errors.push(`IDENTITY: version "${fm.version}" must be semver`);
    // runtimes
    if (fm.runtimes !== undefined) {
      if (!Array.isArray(fm.runtimes) || fm.runtimes.length === 0) errors.push('IDENTITY: runtimes must be a non-empty array');
      else for (const r of fm.runtimes) if (!RUNTIMES.includes(r)) warnings.push(`IDENTITY: unknown runtime "${r}"`);
    }
    // model
    if (fm.model !== undefined && (typeof fm.model !== 'object' || !fm.model.primary)) errors.push('IDENTITY: model.primary is required');
    // capabilities
    if (fm.capabilities !== undefined) {
      if (!Array.isArray(fm.capabilities)) errors.push('IDENTITY: capabilities must be an array');
      else for (const cap of fm.capabilities) if (!CAP_RE.test(cap)) warnings.push(`IDENTITY: capability "${cap}" not in reserved namespace`);
    }
    // dispatch
    if (fm.dispatch && fm.dispatch.authority && !['none', 'low', 'medium', 'high'].includes(fm.dispatch.authority))
      errors.push(`IDENTITY: dispatch.authority "${fm.dispatch.authority}" invalid`);
    // v1.9 §39 — people are bound by ROLE; how to address a person lives on that person's card
    if (fm.serves !== undefined) {
      const sv = Array.isArray(fm.serves) ? fm.serves : [fm.serves];
      for (const r of sv) {
        const s = String(r);
        if (s.startsWith('person:')) errors.push(`IDENTITY: serves "${s}" names a person — bind by role (e.g. role:owner); the deployment maps roles to people (§39)`);
        else if (!ROLE_REF_RE.test(s)) errors.push(`IDENTITY: serves "${s}" must be a role (owner or role:owner)`);
      }
    }
    if (fm.reports_to !== undefined) {
      const rt = String(fm.reports_to);
      if (rt === 'user') warnings.push('IDENTITY: reports_to "user" is legacy — use role:<role> (§39)');
      else if (rt.startsWith('person:')) errors.push(`IDENTITY: reports_to "${rt}" names a person — use role:<role> (§39)`);
      else if (rt.startsWith('role:') ? !ROLE_REF_RE.test(rt) : !/^[a-z][a-z0-9-]*$/.test(rt)) errors.push(`IDENTITY: reports_to "${rt}" must be an agent name or role:<role>`);
    }
    if (fm.pronoun !== undefined) warnings.push('IDENTITY: pronoun is legacy — how to address a person belongs on their card (people/<slug>.md, address); kept only as a fallback (§38–§39)');
    else if (fm.serves === undefined && fm.reports_to === undefined) warnings.push('IDENTITY: serves not set — declare the roles this agent serves, e.g. serves: [owner] (§39)');
    // v1.9 §43 — speaks_as + machine-enforced style block
    if (fm.speaks_as !== undefined && !SPEAKS_AS_VALUES.has(String(fm.speaks_as))) {
      errors.push(`IDENTITY: speaks_as "${fm.speaks_as}" must be one of: self, owner, org (§43)`);
    }
    if (fm.style !== undefined) {
      errors.push(...validateStyle(fm.style).errors);
    }
    if (fm.language === undefined) warnings.push('IDENTITY: language not set (recommended)');
  }

  // SOUL.md
  if (!agent.soul || !agent.soul.trim()) errors.push('SOUL.md missing or empty');

  // TOOLS capabilities ⊆ IDENTITY capabilities
  if (agent.tools && fm && Array.isArray(fm.capabilities)) {
    const declared = new Set(fm.capabilities);
    const used = [...agent.tools.matchAll(/^([a-z]+\.[a-z_]+):/gm)].map((x) => x[1]);
    for (const u of used) if (!declared.has(u)) errors.push(`TOOLS: capability "${u}" not declared in IDENTITY.capabilities`);
  }

  // hard_rules reference resolves
  if (fm && fm.hard_rules) {
    const hp = path.join(agent.dir, fm.hard_rules);
    if (!fs.existsSync(hp)) warnings.push(`IDENTITY: hard_rules path "${fm.hard_rules}" not found`);
  }

  // §47.2 / ASI04: ban unpinned `npx …@latest` / unversioned packages in `.mcp.json`
  errors.push(...checkMcpConfigPinning(cwd, agent.dir));

  // ── conformance level ──
  let level = null;
  if (errors.length === 0) {
    level = 'L0';
    const hasRules = (fm && fm.hard_rules) || agent.hardRules;
    if (agent.evals.length >= 3 && hasRules) level = 'L1';
    if (level === 'L1' && fs.existsSync(path.join(cwd, 'WORK.md'))) {
      // L2 requires WORK.md to satisfy the 4-part contract — checked by checkWork()
      const w = checkWork(cwd);
      if (w.errors.length === 0 && w.tasks > 0) level = 'L2'; else warnings.push(...w.errors);
    }
  }
  return { errors, warnings, level };
}

// §47.2 / ASI04 supply-chain check: flag unpinned `npx …@latest` or unversioned `npx`/`uvx` in `.mcp.json`
export function checkMcpConfigPinning(cwd = process.cwd(), agentDir = null) {
  const errors = [];
  const files = [path.join(cwd, '.mcp.json')];
  if (agentDir) files.push(path.join(agentDir, '.mcp.json'));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const servers = parsed?.mcpServers || {};
    for (const [srvName, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object') continue;
      const cmd = String(cfg.command || '').trim();
      const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
      if (cmd === 'npx' || cmd === 'uvx' || /(?:^|\/)(?:npx|uvx)$/.test(cmd)) {
        const pkgArg = args.find((a) => !a.startsWith('-'));
        if (!pkgArg) continue;
        if (/@latest\b/i.test(pkgArg)) {
          errors.push(`${rel(cwd, file)} [${srvName}]: unpinned MCP package "${pkgArg}" (@latest is banned; pin an exact version, e.g. pkg@1.2.3)`);
        } else if (cmd.endsWith('npx') && !/@\d+\.\d+/.test(pkgArg)) {
          errors.push(`${rel(cwd, file)} [${srvName}]: unpinned npx MCP package "${pkgArg}" (pin an exact semver version, e.g. ${pkgArg}@1.2.3)`);
        } else if (cmd.endsWith('uvx') && !/(?:==|@)\d+\.\d+/.test(pkgArg)) {
          errors.push(`${rel(cwd, file)} [${srvName}]: unpinned uvx MCP package "${pkgArg}" (pin an exact version, e.g. ${pkgArg}==1.2.3)`);
        }
      }
    }
  }
  return errors;
}

// ── CHECK WORK.md (4-part contract + single controller) ──
export function checkWork(cwd = process.cwd()) {
  const p = path.join(cwd, 'WORK.md');
  if (!fs.existsSync(p)) return { errors: [], tasks: 0, owners: [] };
  const raw = fs.readFileSync(p, 'utf8');
  // tasks are fenced yaml blocks ```task ... ``` OR a yaml list under "## tasks"
  const blocks = [...raw.matchAll(/```task\n([\s\S]*?)```/g)].map((m) => m[1]);
  const errors = [], owners = new Set();
  // v1.9 §40 — exactly one controller, and it is an agent: a person holds steps, never the chain
  const wfm = raw.startsWith('---') ? (parseFrontmatter(raw).frontmatter || {}) : {};
  if (wfm.controller && String(wfm.controller).startsWith('person:')) errors.push(`WORK: controller "${wfm.controller}" is a person — the controller must be one agent; people own steps (§40)`);
  let tasks = 0;
  for (const b of blocks) {
    let t; try { t = parseYaml(b); } catch { errors.push('WORK: a task block has invalid YAML'); continue; }
    if (!t) continue;
    tasks++;
    for (const f of ['id', 'title', 'status', 'owner', 'objective', 'output_format', 'boundaries'])
      if (t[f] === undefined) errors.push(`WORK: task "${t.id || '?'}" missing "${f}"`);
    if (t.owner) {
      // v1.9 §40 — owner: agent:<name> | person:<slug> | <name> (an agent, as before)
      const o = String(t.owner);
      if (o.startsWith('person:') ? !/^person:[a-z][a-z0-9-]*$/.test(o) : !/^(agent:)?[a-z][a-z0-9-]*$/.test(o)) errors.push(`WORK: task "${t.id}" owner "${o}" must be <agent>, agent:<agent> or person:<slug>`);
      owners.add(o.replace(/^agent:/, ''));
    }
    if (t.status && !['todo', 'doing', 'done', 'blocked'].includes(t.status))
      errors.push(`WORK: task "${t.id}" invalid status "${t.status}"`);
  }
  return { errors, tasks, owners: [...owners] };
}

// ── BUILD: transpile source → runtime renderings (deterministic) ──
export function buildAgent(name, cwd = process.cwd(), opts = {}) {
  const a = loadAgent(name, cwd);
  const fm = a.frontmatter || {};
  const outDir = path.join(a.dir, '.build');
  const targets = Array.isArray(fm.runtimes) ? fm.runtimes : [];
  const written = [];
  const MARK = '<!-- GENERATED by scroll build — do not edit. Source: ../../ -->';
  const userBlock = typeof opts.userBlock === 'string' && opts.userBlock.trim() ? opts.userBlock.trim() : '';

  const ensure = (d) => fs.mkdirSync(d, { recursive: true });

  // Cowork YourRole.md
  if (targets.includes('cowork')) {
    const d = path.join(outDir, 'cowork'); ensure(d);
    const out = [
      MARK, '',
      `# ${fm.title || name} — ${name}`, '',
      fm.pronoun ? `*Pronoun: ${fm.pronoun} · Language: ${fm.language || 'n/a'}*\n` : '',
      fm.serves ? `*Serves: ${[].concat(fm.serves).join(', ')} — each person's card (people/<slug>.md) says how to address them*\n` : '',
      '## Identity', a.identityBody || '', '',
      '## Soul', a.soul || '', '',
      a.tools ? '## Tools\n' + a.tools : '',
      a.hardRules ? '\n## Hard rules\n' + a.hardRules : '', // cowork-hr
      userBlock ? '\n' + userBlock : '',
    ].join('\n');
    const f = path.join(d, 'YourRole.md'); fs.writeFileSync(f, out); written.push(rel(cwd, f));
  }

  // Claude subagent (.md + frontmatter)
  if (targets.includes('claude-subagent')) {
    const d = path.join(outDir, 'claude-subagent'); ensure(d);
    const desc = (fm.title || name).replace(/\n/g, ' ');
    const sub = [
      '---',
      `name: ${name}`,
      `description: ${desc}`,
      `model: ${(fm.model && fm.model.primary) || 'inherit'}`,
      '---', '',
      a.soul || '', '',
      a.identityBody || '',
      a.hardRules ? '\n## Hard rules\n' + a.hardRules : '', // subagent-hr
      userBlock ? '\n' + userBlock : '',
    ].join('\n');
    const f = path.join(d, `${name}.md`); fs.writeFileSync(f, sub); written.push(rel(cwd, f));
  }

  // A2A Agent Card (static JSON)
  if (targets.includes('a2a')) {
    const d = path.join(outDir, 'a2a'); ensure(d);
    const card = {
      schemaVersion: '1.0', name, title: fm.title || name, version: fm.version || '0.0.0',
      capabilities: fm.capabilities || [], model: (fm.model && fm.model.primary) || null,
    };
    const f = path.join(d, `${name}.agent-card.json`);
    fs.writeFileSync(f, JSON.stringify(card, null, 2) + '\n'); written.push(rel(cwd, f));
  }

  // Generic prompt for codex/gemini/voice
  for (const rt of ['codex', 'gemini', 'voice']) {
    if (!targets.includes(rt)) continue;
    const d = path.join(outDir, rt); ensure(d);
    const out = [
      MARK, '',
      a.soul || '', '',
      a.identityBody || '',
      a.tools ? '\n' + a.tools : '',
      a.hardRules ? '\n## Hard rules\n' + a.hardRules : '', // generic-hr
      userBlock ? '\n' + userBlock : '',
    ].join('\n');
    const f = path.join(d, `${name}.prompt.md`); fs.writeFileSync(f, out); written.push(rel(cwd, f));
  }

  return { written, targets };
}

// ── REGISTRY: scan agents/ → rows ──
export function scanRegistry(cwd = process.cwd()) {
  const base = path.join(cwd, 'agents');
  if (!fs.existsSync(base)) return [];
  const rows = [];
  for (const name of fs.readdirSync(base)) {
    const idp = path.join(base, name, 'IDENTITY.md');
    if (!fs.existsSync(idp)) continue;
    try {
      const { frontmatter: fm } = parseFrontmatter(fs.readFileSync(idp, 'utf8'));
      rows.push({
        name, title: fm?.title || '', version: fm?.version || '',
        runtimes: (fm?.runtimes || []).join(','), model: fm?.model?.primary || '',
        caps: (fm?.capabilities || []).length,
      });
    } catch { rows.push({ name, title: c.red('(invalid IDENTITY)'), version: '', runtimes: '', model: '', caps: 0 }); }
  }
  return rows;
}

// ── COST: rough single-vs-multi estimate (language-aware) ──
// Non-English text costs more tokens per character (Vietnamese ≈ 1.8× English). Estimating as if
// English badly underestimates real spend for non-English markets — a local insight competitors miss.
export const LANG_MULT = { en: 1, vi: 1.8, ja: 1.6, zh: 1.7, ko: 1.6, th: 1.6, ar: 1.5, ru: 1.4 };
export function langMultiplier(language) {
  if (!language) return 1;
  const base = String(language).toLowerCase().split('-')[0];
  return LANG_MULT[base] || 1.5; // unknown but non-English → conservative 1.5
}
export function estimateCost(taskText, nAgents = 2, { language } = {}) {
  const mult = langMultiplier(language);
  const taskTokens = Math.ceil(((taskText || '').length / 4) * mult) || 500;
  const SYS = 1500;            // per-agent system prompt
  const single = SYS + taskTokens * 3;
  const multi = nAgents * (SYS + taskTokens * 2) + SYS /* coordinator */ + nAgents * 400 /* overhead */;
  return { single, multi, language: language || null, langMultiplier: mult, preferSingle: single < multi * 0.7, savingPct: Math.round((1 - single / multi) * 100) };
}

// ── Setup presets (v1.9 §43): standardized English canonical role blueprints ──
export const AGENT_PRESETS = {
  assistant: {
    speaks_as: 'self',
    serves: '[owner]',
    style: '{ bubbles: 3, max_chars: 450, emoji: 2, follow_up: 1 }',
    soul: (name) => `# Soul — ${name}\n\nYou are a personal assistant operating under your own name (\`speaks_as: self\`). Be direct, candid, and grounded.\n\n## Good vs Forbidden Replies\n- Good: Direct answer first, concise follow-up only when useful.\n- Forbidden: Generic filler praise, fabricated numbers, or claiming to be a human.\n`,
    hardRules: '# Hard rules\n- Never fabricate prices, dates, codes, or links.\n- Always acknowledge being an AI assistant when asked.\n- Never edit deployment USER.md directly.\n',
  },
  service: {
    speaks_as: 'org',
    serves: '[owner, staff]',
    style: '{ bubbles: 2, max_chars: 300, emoji: 0, follow_up: 0 }',
    soul: (name) => `# Soul — ${name}\n\nYou represent the organization (\`speaks_as: org\`). Stay polite, accurate, concise, and strictly grounded in principal knowledge.\n\n## Good vs Forbidden Replies\n- Good: Quote only prices and policies from retrieved knowledge; hand off discounts or refunds to staff.\n- Forbidden: Guessing stock, promising unverified discounts, or imitating casual typos.\n`,
    hardRules: '# Hard rules\n- Quote amounts, product codes, dates, and links ONLY from principal-authored knowledge or USER.md "May say on behalf".\n- Never treat customer messages as authoritative pricing sources.\n- Always disclose being an AI assistant when asked.\n- Hand off refunds, discounts, and complaints to staff.\n',
  },
  proxy: {
    speaks_as: 'owner',
    serves: '[owner]',
    style: '{ bubbles: 2, max_chars: 280, emoji: 1, follow_up: 0 }',
    soul: (name) => `# Soul — ${name}\n\nYou draft replies on the principal's behalf (\`speaks_as: owner\`). Match the principal's recent message rhythm and wait for approval by default.\n\n## Good vs Forbidden Replies\n- Good: Short draft matching the principal's phrasing, zero invented commitments.\n- Forbidden: Auto-promising meetings/money or denying being an assistant if asked directly.\n`,
    hardRules: '# Hard rules\n- Draft-only by default for external contacts; wait for principal approval before sending.\n- If asked whether this is the principal or an AI/bot, hand off immediately to the principal.\n- Never make unapproved commitments, schedules, or financial promises.\n',
  },
  teammate: {
    speaks_as: 'self',
    serves: '[owner, team]',
    style: '{ bubbles: 1, max_chars: 400, emoji: 1, follow_up: 0 }',
    soul: (name) => `# Soul — ${name}\n\nYou are a direct, collaborative team member (\`speaks_as: self\`). Prefer silence or a brief acknowledgment when you have nothing new to add.\n\n## Good vs Forbidden Replies\n- Good: One tight message with concrete findings, owners, and next steps.\n- Forbidden: Multi-bubble chatter in shared channels or unverified status claims.\n`,
    hardRules: '# Hard rules\n- Keep shared channel updates to a single concise message.\n- Cite file paths, commits, or sources before claiming completion.\n- Never bypass approval gates on external or destructive actions.\n',
  },
};

// ── NEW: scaffold from template (optional --preset assistant|service|proxy|teammate) ──
export function scaffold(name, cwd = process.cwd(), opts = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`name "${name}" must match ^[a-z][a-z0-9-]*$`);
  const presetName = opts && opts.preset ? String(opts.preset) : null;
  if (presetName && !Object.prototype.hasOwnProperty.call(AGENT_PRESETS, presetName)) {
    throw new Error(`unknown preset "${presetName}" — valid presets: ${Object.keys(AGENT_PRESETS).join(', ')}`);
  }
  const dest = path.join(cwd, 'agents', name);
  if (fs.existsSync(dest)) throw new Error(`agents/${name}/ already exists`);
  fs.cpSync(TEMPLATE_DIR, dest, { recursive: true });
  // patch IDENTITY name + title
  const idp = path.join(dest, 'IDENTITY.md');
  let id = fs.readFileSync(idp, 'utf8');
  id = id.replace(/^name: researcher.*$/m, `name: ${name}`)
         .replace(/^title: Research Synthesizer.*$/m, `title: ${name}`);
  if (presetName) {
    const p = AGENT_PRESETS[presetName];
    id = id.replace(/^serves:.*$/m, `serves: ${p.serves}`);
    const extraLines = `speaks_as: ${p.speaks_as}\nstyle: ${p.style}`;
    id = id.replace(/\n---\n/, `\n${extraLines}\n---\n`);
    fs.writeFileSync(path.join(dest, 'SOUL.md'), p.soul(name));
    fs.writeFileSync(path.join(dest, 'hard-rules.md'), p.hardRules);
  }
  fs.writeFileSync(idp, id);
  return rel(cwd, dest);
}

function rel(cwd, p) { return path.relative(cwd, p) || p; }

// tiny flag parser: --key value | --flag (boolean) | positional → _[]
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// "K=v,K2=${vault:X}" → { K: 'v', K2: '${vault:X}' }
function parseKv(s) {
  if (typeof s !== 'string') return undefined;
  const o = {};
  for (const pair of s.split(',')) { const i = pair.indexOf('='); if (i < 0) continue; o[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
  return Object.keys(o).length ? o : undefined;
}
// "issue_invoice:financial:code|amount,lookup:read_only" → { issue_invoice:{risk,ground:[...]}, lookup:{risk} }
function parseTools(s) {
  if (typeof s !== 'string') return undefined;
  const o = {};
  for (const t of s.split(',')) {
    const [name, tier, ground] = t.split(':');
    if (!name || !name.trim()) continue;
    o[name.trim()] = { ...(tier ? { risk: tier.trim() } : {}), ...(ground ? { ground: ground.split('|').map((x) => x.trim()).filter(Boolean) } : {}) };
  }
  return Object.keys(o).length ? o : undefined;
}

// ── CLI dispatch ──
const HELP = `${c.bold('scroll')} — build AI agents as folders, not code

${c.bold('Usage:')} scroll <command> [args]

  ${c.cyan('new')} <name>       scaffold a compliant agent folder (--preset assistant|service|proxy|teammate)
  ${c.cyan('check')} <name>     validate structure against the spec (L0/L1/L2)
  ${c.cyan('audit')} [name]     deeper compliance check — conventions + hash-bound report (run in CI; --verify; --verify-chain)
  ${c.cyan('build')} <name>     render one source → every runtime
  ${c.cyan('registry')}         scan agents/ → a config table
  ${c.cyan('cost')} "<task>"    estimate single vs multi-agent token cost
  ${c.cyan('eval')} <name>      run gold cases N times → machine checks + consistency (--chat --trials k for pass^k)
  ${c.cyan('run')} --work <f>   drive the inner loop: one harnessed multi-agent run (or: run <agent> --task "...")
  ${c.cyan('loop')} <LOOP.md>   drive the OUTER loop: schedule + find work + stop conditions (loop engineering)
  ${c.cyan('chat')} <agent>     interactive multi-turn chat session (§45: --provider, --model, --message, --session)
  ${c.cyan('auth')} <cmd>       auth profiles & OAuth/Codex login (§46: list · add · remove · default · login)
  ${c.cyan('cron')} <cmd>       timezone-aware cron jobs & reminders (§49: list · add · toggle · remove · pause · resume · tick)
  ${c.cyan('user')} <cmd>        deployment USER.md: check · new · show · import
  ${c.cyan('people')} <cmd>      person cards: check · new · list · show · propose · review · approve · done · forget
  ${c.cyan('memory')} <cmd>      subject memory: new · link · show · snapshot · search · forget · review · member · consolidate · fsck · erase
  ${c.cyan('mcp')} <cmd>        MCP servers & TOFU lockfile: add · diff · approve
  ${c.cyan('skill')} <cmd>      skills: add · list · view · index · scan · check · eval · sources
  ${c.cyan('plugin')} add <ref> install a plugin bundle (agents + skills + mcp)
  ${c.cyan('help')}             this message
`;

export async function run(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'new': {
      const a = parseArgs(rest);
      const name = a._[0]; if (!name) throw new Error('usage: scroll new <name> [--preset assistant|service|proxy|teammate]');
      const preset = typeof a.preset === 'string' ? a.preset : undefined;
      const where = scaffold(name, process.cwd(), { preset });
      console.log(`${c.green('✔')} created ${c.bold(where)}${preset ? c.dim(` (preset: ${preset})`) : ''}`);
      console.log(c.dim(`  edit SOUL.md (the persona) and IDENTITY.md (the frontmatter), then:`));
      console.log(c.dim(`  scroll check ${name} && scroll build ${name}`));
      break;
    }
    case 'check': {
      const name = rest[0]; if (!name) throw new Error('usage: scroll check <name>  |  scroll check user  |  scroll check people');
      // v1.9 §38 — `scroll check user` validates deployment USER.md (an agent named "user" still wins)
      if (name === 'user' && !fs.existsSync(path.join(process.cwd(), 'agents', 'user', 'IDENTITY.md'))) { await run(['user', 'check', ...rest.slice(1)]); break; }
      // v1.9 §38 — `scroll check people` validates legacy cards (an agent named "people" still wins)
      if (name === 'people' && !fs.existsSync(path.join(process.cwd(), 'agents', 'people', 'IDENTITY.md'))) { await run(['people', 'check', ...rest.slice(1)]); break; }
      const { errors, warnings, level } = checkAgent(name);
      // v1.8 §36.1 — skills this agent and repo ship must be valid and pass the security scan
      let sk = { errors: [], warnings: [], counts: null };
      if (errors.length === 0) { const { checkSkills } = await import('./skills.js'); sk = checkSkills(process.cwd(), name, { identity: loadAgent(name).frontmatter }); }
      for (const w of [...warnings, ...sk.warnings]) console.log(`${c.yellow('⚠')} ${w}`);
      for (const e of [...errors, ...sk.errors]) console.log(`${c.red('✖')} ${e}`);
      const nErr = errors.length + sk.errors.length;
      if (sk.counts && (sk.counts.visible || sk.counts.hidden || sk.counts.blocked || sk.counts.invalid)) console.log(c.dim(`  skills: ${sk.counts.visible} usable · ${sk.counts.hidden} hidden · ${sk.counts.blocked} blocked · ${sk.counts.invalid} invalid`));
      if (nErr === 0) console.log(`${c.green('✔')} ${name} valid — conformance ${c.bold(level)}`);
      else { console.log(`${c.red('✖')} ${name} has ${nErr} error(s)`); process.exitCode = 1; }
      break;
    }
    case 'build': {
      const name = rest[0]; if (!name) throw new Error('usage: scroll build <name>');
      const chk = checkAgent(name);
      if (chk.errors.length) { chk.errors.forEach((e) => console.log(`${c.red('✖')} ${e}`)); throw new Error(`refusing to build invalid agent (run: scroll check ${name})`); }
      const { written, targets } = buildAgent(name);
      console.log(`${c.green('✔')} built ${c.bold(name)} → ${targets.join(', ')}`);
      written.forEach((f) => console.log(c.dim(`  ${f}`)));
      break;
    }
    case 'registry': {
      const rows = scanRegistry();
      if (!rows.length) { console.log(c.dim('no agents found under agents/')); break; }
      const pad = (s, n) => String(s).padEnd(n);
      console.log(c.bold(`${pad('NAME', 16)}${pad('VERSION', 10)}${pad('MODEL', 22)}${pad('RUNTIMES', 24)}CAPS`));
      for (const r of rows) console.log(`${pad(r.name, 16)}${pad(r.version, 10)}${pad(r.model, 22)}${pad(r.runtimes, 24)}${r.caps}`);
      console.log(c.dim(`\n${rows.length} agent(s). This table is derived from files — it is the registry.`));
      break;
    }
    case 'cost': {
      const a = parseArgs(rest);
      const task = a._.join(' '); if (!task) throw new Error('usage: scroll cost "<task>" [--language vi]');
      const lang = typeof a.language === 'string' ? a.language : (typeof a.lang === 'string' ? a.lang : undefined);
      const e = estimateCost(task, 2, { language: lang });
      console.log(`single-agent ~${e.single.toLocaleString()} tok · multi-agent ~${e.multi.toLocaleString()} tok${e.langMultiplier !== 1 ? ` · lang ${lang} ×${e.langMultiplier}` : ''}`);
      console.log(e.preferSingle ? `${c.green('→ prefer single')} (saves ~${e.savingPct}%)` : `${c.yellow('→ multi-agent justified')} (parallel/read-heavy)`);
      break;
    }
    case 'audit': {
      const a = parseArgs(rest);
      if (a['verify-chain']) {
        const { verifyAuditChain } = await import('./chat-telemetry.js');
        const target = typeof a['verify-chain'] === 'string'
          ? path.resolve(process.cwd(), a['verify-chain'])
          : path.join(process.cwd(), '.scroll', 'chat-state', 'audit.jsonl');
        const res = verifyAuditChain(target);
        if (a.json) console.log(JSON.stringify({ file: rel(process.cwd(), target), ...res }, null, 2));
        else console.log(res.ok ? `${c.green('✔')} audit chain verified (${res.count} entries): ${rel(process.cwd(), target)}` : `${c.red('✖')} audit chain tampered (${res.errors.length} error(s))`);
        if (!res.ok) process.exitCode = 1;
        break;
      }
      const { auditRepo, verifyAgainstRecord } = await import('./audit.js');
      const report = auditRepo(process.cwd(), { name: a._[0] });
      if (a.verify) {
        const v = verifyAgainstRecord(process.cwd(), report);
        console.log(v.ok ? `${c.green('✔')} ${v.reason}` : `${c.red('✖')} ${v.reason}`);
        if (!v.ok) process.exitCode = 1;
        break;
      }
      if (a.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const ag of report.agents) {
          const mark = ag.errors.length ? c.red('✖') : c.green('✔');
          console.log(`${mark} ${c.bold(ag.name)} — ${ag.level || c.red('invalid')} · ${ag.evalCount} eval(s)`);
          ag.errors.forEach((e) => console.log(`    ${c.red('error')} ${e}`));
          ag.warnings.forEach((w) => console.log(`    ${c.yellow('warn')}  ${w}`));
        }
        if (report.people && (report.people.errors.length || report.people.warnings.length)) {
          console.log(c.bold(`\npeople (§38–§41${report.people.cards ? ` · ${report.people.cards} card(s)` : ''}):`));
          report.people.errors.forEach((e) => console.log(`  ${c.red('error')} ${e}`));
          report.people.warnings.forEach((w) => console.log(`  ${c.yellow('warn ')} ${w}`));
        }
        if (report.conventions.length) {
          console.log(c.bold('\nconventions:'));
          for (const v of report.conventions) console.log(`  ${v.severity === 'error' ? c.red('error') : c.yellow('warn ')} ${c.cyan(v.rule)} — ${v.file}${v.line ? ':' + v.line : ''} — ${v.msg}`);
        }
        const verdict = report.verdict === 'pass' ? c.green('PASS') : c.red('FAIL');
        console.log(`\n${verdict} — ${report.errorCount} error(s), ${report.warnCount} warning(s)`);
        console.log(c.dim("  compliance = passing this in CI, not an agent's self-claim. Record: .scroll/audit.json"));
      }
      if (!a['no-write']) {
        fs.mkdirSync(path.join(process.cwd(), '.scroll'), { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), '.scroll', 'audit.json'), JSON.stringify(report, null, 2) + '\n');
      }
      if (report.verdict !== 'pass') process.exitCode = 1;
      break;
    }
    case 'eval': {
      const a = parseArgs(rest);
      const name = a._[0]; if (!name) throw new Error('usage: scroll eval <name> [--n N] [--chat --trials K] [--provider mock|claude|codex|openai|...] [--model M]');
      if (a.chat) {
        const { runChatEvals } = await import('./eval.js');
        const rep = await runChatEvals(name, {
          cwd: process.cwd(),
          trials: a.trials ? Number(a.trials) : (a.n ? Number(a.n) : 3),
          provider: typeof a.provider === 'string' ? a.provider : 'mock',
          model: typeof a.model === 'string' ? a.model : undefined,
        });
        if (a.json) { console.log(JSON.stringify(rep, null, 2)); if (!rep.ok) process.exitCode = 1; break; }
        if (rep.error) { console.log(`${c.red('✖')} ${name}: ${rep.error}`); process.exitCode = 1; break; }
        for (const cs of rep.cases) {
          const mark = cs.verdict === 'pass' ? c.green('✔') : c.red('✖');
          console.log(`${mark} ${c.bold(cs.id)} — ${cs.passedTrials}/${cs.trials} trials pass · pass^${cs.trials}=${cs.passPowK} (min ${cs.minPassPowK})`);
        }
        console.log(`\n${rep.ok ? c.green('PASS') : c.red('FAIL')} — ${rep.passed}/${rep.total} chat eval case(s) · record .scroll/eval/${name}-chat.json`);
        if (!rep.ok) process.exitCode = 1;
        break;
      }
      const { runEvals } = await import('./eval.js');
      const rep = await runEvals(name, {
        cwd: process.cwd(), n: a.n ? Number(a.n) : undefined,
        provider: typeof a.provider === 'string' ? a.provider : 'auto',
        model: typeof a.model === 'string' ? a.model : undefined,
        judge: !!a.judge,
        judgeProvider: typeof a['judge-provider'] === 'string' ? a['judge-provider'] : undefined,
        judgeModel: typeof a['judge-model'] === 'string' ? a['judge-model'] : undefined,
      });
      if (a.json) { console.log(JSON.stringify(rep, null, 2)); if (!rep.ok) process.exitCode = 1; break; }
      if (rep.error) { console.log(`${c.red('✖')} ${name}: ${rep.error}`); process.exitCode = 1; break; }
      for (const cs of rep.cases) {
        // §30 — provenance is printed beside every verdict: a green case built on a hand-made
        // precondition proves nothing about the path that should have made it.
        const prov = cs.fixture && cs.fixture.provenance
          ? c.dim(` [${cs.fixture.provenance}]`)
          : c.yellow(' [provenance?]');
        if (cs.skipped) { console.log(`${c.yellow('·')} ${cs.id}${prov} — ${c.yellow('ungraded')}: ${cs.reason}`); continue; }
        // §29 — verdict is ternary. `ungraded` gets a neutral marker, never a check-mark.
        const mark = cs.verdict === 'pass' ? c.green('✔') : cs.verdict === 'ungraded' ? c.yellow('·') : c.red('✖');
        const jd = cs.judge ? ` · judge ${cs.judge.ok ? cs.judge.average + '/' + cs.judge.min + (cs.judge.pass ? '✔' : '✖') : 'ERR ' + (cs.judge.error || '')}` : '';
        console.log(`${mark} ${c.bold(cs.id)}${prov} — ${cs.verdict === 'ungraded' ? c.yellow('ungraded (checker did not run)') : `${cs.passCount}/${cs.runs} runs pass (consistency ${cs.consistency} ≥ ${cs.threshold})`} · ${cs.checks} check(s)${jd}`);
        if (cs.verdict === 'fail') { const f = cs.perRun.find((r) => !r.allPass); if (f && f.fails.length) console.log(c.dim(`    failed: ${f.fails.join(', ')}${f.err ? ' · ' + f.err : ''}`)); }
        if (cs.fixture && cs.fixture.issues && cs.fixture.issues.length) console.log(c.yellow(`    fixture: ${cs.fixture.issues.join('; ')}`));
      }
      const verdict = rep.ok ? c.green('PASS') : c.red('FAIL');
      const ung = rep.ungraded ? c.yellow(` · ${rep.ungraded} ungraded (not counted as pass)`) : '';
      console.log(`\n${verdict} — ${rep.passed}/${rep.gradable} graded case(s)${ung} · provider ${rep.provider} (${rep.model}) · record .scroll/eval/${name}.json`);
      if (!rep.ok) process.exitCode = 1;
      break;
    }
    case 'run': {
      const a = parseArgs(rest);
      const positional = a._[0];
      const opts = {
        cwd: process.cwd(),
        workFile: a.work || (positional && positional.endsWith('.md') ? positional : undefined),
        task: typeof a.task === 'string' ? a.task : undefined,
        agent: a.agent || (positional && !positional.endsWith('.md') ? positional : undefined),
        providerName: a.provider || 'auto',
        model: typeof a.model === 'string' ? a.model : undefined,
        eventsPath: typeof a.events === 'string' ? a.events : undefined,
        outPath: typeof a.out === 'string' ? a.out : undefined,
        runDir: typeof a['run-dir'] === 'string' ? a['run-dir'] : undefined,
        json: !!a.json,
        verbose: !a.json,
        autoApprove: !!a['auto-approve'],
        risk: typeof a.risk === 'string' ? a.risk : undefined,
        resumeSelftest: !!a['resume-selftest'],
        noLean: !!a['no-lean'],
        maxTokens: a['max-tokens'] ? Number(a['max-tokens']) : undefined,
        intermediateMaxTokens: a['intermediate-max-tokens'] ? Number(a['intermediate-max-tokens']) : undefined,
        blackboardCap: a['blackboard-cap'] ? Number(a['blackboard-cap']) : undefined,
        subModel: typeof a['sub-model'] === 'string' ? a['sub-model'] : undefined,
        route: a['no-route'] ? false : undefined,
        compactPrefix: !!a['compact-prefix'],
        language: typeof a.language === 'string' ? a.language : (typeof a.lang === 'string' ? a.lang : undefined),
        resume: !!a.resume,
        worktree: !!a.worktree,
        tool: typeof a.tool === 'string' ? a.tool : undefined,
        subject: typeof a.subject === 'string' ? a.subject : undefined,
        for: typeof a.for === 'string' ? a.for : undefined,              // v1.9 §39: the person this step serves
        userFile: typeof a.user === 'string' ? a.user : undefined,       // v1.9 §38: deployment USER.md path
        peopleDir: typeof a.people === 'string' ? a.people : undefined,  // v1.9 §38: legacy cards dir
        action: typeof a.action === 'string' ? a.action : undefined,     // v1.9 §40.2: the action class the approver must hold
        amount: typeof a.amount === 'string' ? a.amount : undefined,     // v1.9 §40.2: checked against the approver's max_amount
        skills: typeof a.skill === 'string' ? a.skill.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
        memoryStore: typeof a['memory-store'] === 'string' ? a['memory-store'] : undefined,
        caps: {},
      };
      const capMap = { 'max-iterations': 'maxIterations', 'max-input-tokens': 'maxInputTokens', 'max-wall-clock-ms': 'maxWallClockMs', 'max-usd': 'maxUsd' };
      for (const k of Object.keys(capMap)) if (a[k] != null && a[k] !== true) opts.caps[capMap[k]] = Number(a[k]);
      if (!opts.workFile && !opts.task) throw new Error('usage: scroll run --work <WORK.md>  |  scroll run <agent> --task "<text>"');
      const { runWork } = await import('./runtime.js');
      const res = await runWork(opts);
      if (!a.json) {
        const m = res.metrics;
        const mark = res.status === 'completed' ? c.green('✔') : c.yellow('●');
        console.log(`${mark} scroll run ${c.bold(res.status)} — ${m.tasksCompleted}/${m.tasksTotal} task(s) · ${res.decision}/${res.spawnedAgents} agent(s)`);
        console.log(c.dim(`  tokens ${m.billableTokenEquivalent} (cache ${m.cacheHitPct}%) · $${m.costUsd} · ${m.durationMs}ms · verify ${res.verification.passed ? c.green('PASS') : c.red('FAIL')}`));
        console.log(c.dim(`  events: ${rel(process.cwd(), res.eventsPath)}  ·  output: ${rel(process.cwd(), res.outPath)}`));
        for (const w of res.waiting || []) console.log(c.yellow(`  waiting: ${w.taskId} — ${w.kind === 'person' ? `person:${w.person}${w.problem ? ` (${w.problem})` : ''} (mark done: scroll people done ${w.taskId} --run ${rel(process.cwd(), res.runDir)} --by ${w.person})` : `approval ${w.gateId}${w.approvers && w.approvers.length ? ` by one of: ${w.approvers.join(', ')}` : ' — nobody on the team may approve this'}`}`));
      }
      if (res.verification && res.verification.passed === false) process.exitCode = 1;
      break;
    }
    case 'loop': {
      const a = parseArgs(rest);
      const file = a._[0] || (typeof a.work === 'string' ? a.work : 'LOOP.md');
      const { runLoop } = await import('./loop.js');
      const { runWork } = await import('./runtime.js');
      const summary = await runLoop(file, {
        cwd: process.cwd(),
        once: !!a.once,
        dryRun: !!a['dry-run'],
        maxRuns: a['max-runs'] != null && a['max-runs'] !== true ? Number(a['max-runs']) : undefined,
        providerName: a.provider || 'auto',
        model: typeof a.model === 'string' ? a.model : undefined,
        sleepMs: a['sleep-ms'] != null && a['sleep-ms'] !== true ? Number(a['sleep-ms']) : undefined,
        verbose: !a.json,
        runWork,
      });
      if (a.json) { console.log(JSON.stringify(summary, null, 2)); break; }
      console.log(`${c.green('✔')} loop ${c.bold(summary.id)} — ${summary.iterations} iteration(s)${summary.stopped ? ` · stopped: ${summary.stopped}` : ''}`);
      for (const r of summary.runs) console.log(c.dim(`  iter ${r.iteration}: ${r.dryRun ? 'dry-run' : r.status + (r.verify != null ? ' · verify ' + (r.verify ? 'PASS' : 'FAIL') : '')}${r.digest ? ' · ' + r.digest : ''}`));
      console.log(c.dim(`  loop events: ${rel(process.cwd(), summary.eventsPath)}`));
      break;
    }
    case 'chat': {
      const a = parseArgs(rest);
      const agentName = a._[0] || (typeof a.agent === 'string' ? a.agent : null);
      if (!agentName) throw new Error('usage: scroll chat <agent> [--message "<text>"] [--session <id>] [--provider mock|codex-app-server|openai|...] [--model M]');
      const { createChatSessionRuntime } = await import('./chat-session.js');
      const { createToolRegistry } = await import('./tools.js');
      const { createAuthStore } = await import('./auth.js');
      const { createMcpManager } = await import('./mcp-client.js');
      const cwd = process.cwd();
      const stateDir = typeof a['state-dir'] === 'string' ? path.resolve(cwd, a['state-dir']) : path.join(cwd, '.scroll', 'chat-state');
      // Unified auth store path (.scroll/auth.json), auto-migrating legacy .scroll/chat-state/auth.json once
      const defaultAuthFile = path.join(cwd, '.scroll', 'auth.json');
      const legacyAuthFile = path.join(stateDir, 'auth.json');
      if (!a['auth-file'] && !fs.existsSync(defaultAuthFile) && fs.existsSync(legacyAuthFile)) {
        fs.mkdirSync(path.dirname(defaultAuthFile), { recursive: true, mode: 0o700 });
        fs.copyFileSync(legacyAuthFile, defaultAuthFile);
        try { fs.chmodSync(defaultAuthFile, 0o600); } catch { /* ignore */ }
      }
      const authFile = typeof a['auth-file'] === 'string' ? path.resolve(cwd, a['auth-file']) : defaultAuthFile;
      const authStore = createAuthStore({ filePath: authFile });
      const agentDir = path.join(cwd, 'agents', agentName);
      let mcpManager = null;
      if (!a['no-tools'] && !a['no-mcp']) {
        mcpManager = createMcpManager({ cwd, agentDir });
        if (mcpManager.listConfiguredServers().length > 0) {
          await mcpManager.connectAll().catch(() => {});
        }
      }
      const tools = a['no-tools'] ? null : createToolRegistry({ cwd, agentDir, mcpManager });
      if (tools && mcpManager) tools.syncMcpTools();
      const runtime = createChatSessionRuntime({
        agentName,
        cwd,
        stateDir,
        providerName: typeof a.provider === 'string' ? a.provider : 'auto',
        model: typeof a.model === 'string' ? a.model : undefined,
        authStore,
        tools,
      });
      const convId = typeof a.session === 'string' ? a.session : 'cli-default';
      const sender = typeof a.sender === 'string' ? { id: a.sender, verified: true } : null;
      try {
        if (typeof a.message === 'string') {
          let streamed = false;
          const res = await runtime.sendTurn({
            conversationId: convId,
            text: a.message,
            sender,
            channel: 'cli',
            onDelta: a.json ? null : (d) => { streamed = true; process.stdout.write(d); },
          });
          if (a.json) console.log(JSON.stringify(res, null, 2));
          else {
            if (!streamed && res.text) process.stdout.write(res.text);
            if ((streamed || res.text) && !String(res.text || '').endsWith('\n')) process.stdout.write('\n');
          }
        } else {
          const readline = await import('node:readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${agentName}> ` });
          rl.prompt();
          for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === '/exit' || trimmed === '/quit') break;
            if (trimmed === '/clear') { runtime.clearSession(convId); console.log(c.dim('session cleared')); rl.prompt(); continue; }
            let streamed = false;
            const res = await runtime.sendTurn({
              conversationId: convId,
              text: trimmed,
              sender,
              channel: 'cli',
              onDelta: (d) => { streamed = true; process.stdout.write(d); },
            });
            if (!streamed) console.log(res.text);
            else if (!String(res.text || '').endsWith('\n')) process.stdout.write('\n');
            rl.prompt();
          }
          rl.close();
        }
      } finally {
        await runtime.close();
        if (mcpManager) await mcpManager.closeAll().catch(() => {});
      }
      break;
    }
    case 'auth': {
      const a = parseArgs(rest);
      const sub = a._[0] || 'list';
      const cwd = process.cwd();
      const authFile = typeof a.file === 'string' ? path.resolve(cwd, a.file) : path.join(cwd, '.scroll', 'auth.json');
      const { createAuthStore, createPkceChallenge, buildAuthorizationUrl, runLoopbackOAuthCallback, exchangeAuthCode } = await import('./auth.js');
      const store = createAuthStore({ filePath: authFile });
      if (sub === 'list') {
        const list = store.listProfiles({ provider: typeof a.provider === 'string' ? a.provider : null });
        if (a.json) console.log(JSON.stringify(list, null, 2));
        else if (!list.length) console.log(c.dim('no auth profiles configured'));
        else for (const p of list) console.log(`${p.isDefault ? c.green('*') : ' '} ${c.bold(p.id)} (${p.provider}/${p.type})${p.inCooldown ? c.yellow(' [cooldown]') : ''}${p.disabled ? c.red(' [disabled]') : ''}`);
        break;
      }
      if (sub === 'add') {
        const id = a._[1]; if (!id) throw new Error('usage: scroll auth add <id> --provider <p> [--api-key K | --token T] [--base-url URL]');
        const saved = store.upsertProfile({
          id,
          provider: typeof a.provider === 'string' ? a.provider : 'openai',
          type: typeof a.type === 'string' ? a.type : (a['api-key'] ? 'api_key' : (a['base-url'] ? 'proxy' : 'oauth')),
          apiKey: typeof a['api-key'] === 'string' ? a['api-key'] : undefined,
          accessToken: typeof a.token === 'string' ? a.token : undefined,
          refreshToken: typeof a['refresh-token'] === 'string' ? a['refresh-token'] : undefined,
          baseUrl: typeof a['base-url'] === 'string' ? a['base-url'] : undefined,
          label: typeof a.label === 'string' ? a.label : id,
          isDefault: !!a.default,
        });
        console.log(a.json ? JSON.stringify(saved, null, 2) : `${c.green('✔')} auth profile saved: ${c.bold(saved.id)} (${saved.provider}/${saved.type})`);
        break;
      }
      if (sub === 'remove') {
        const id = a._[1]; if (!id) throw new Error('usage: scroll auth remove <id>');
        const res = store.removeProfile(id);
        console.log(a.json ? JSON.stringify(res) : (res.removed ? `${c.green('✔')} removed ${id}` : `${c.yellow('⚠')} not found: ${id}`));
        break;
      }
      if (sub === 'default') {
        const provider = a._[1]; const id = a._[2];
        if (!provider || !id) throw new Error('usage: scroll auth default <provider> <profileId>');
        const res = store.setDefault(provider, id);
        console.log(a.json ? JSON.stringify(res) : `${c.green('✔')} default ${provider} -> ${id}`);
        break;
      }
      if (sub === 'login') {
        const prov = typeof a.provider === 'string' ? a.provider : (a._[1] || 'codex');
        if (prov === 'codex' || prov === 'chatgpt') {
          const { createCodexAppServerClient } = await import('./codex-app-server.js');
          const client = createCodexAppServerClient();
          try {
            const out = await client.startLogin({ type: 'chatgpt' });
            console.log(a.json ? JSON.stringify(out, null, 2) : `${c.green('✔')} ChatGPT login started: ${out?.authUrl || JSON.stringify(out)}`);
          } finally {
            await client.close();
          }
          break;
        }
        const pkce = createPkceChallenge();
        const clientId = typeof a['client-id'] === 'string' ? a['client-id'] : (process.env.SCROLL_OAUTH_CLIENT_ID || 'scroll-cli');
        if (a.loopback) {
          const cb = await runLoopbackOAuthCallback({
            port: a.port ? Number(a.port) : 0,
            expectedState: pkce.state,
            timeoutMs: a['timeout-ms'] ? Number(a['timeout-ms']) : 180_000,
          });
          const url = buildAuthorizationUrl({
            provider: prov,
            clientId,
            redirectUri: cb.redirectUri,
            challenge: pkce.challenge,
            state: pkce.state,
          });
          console.log(`Open to authenticate:\n  ${url}\nWaiting on ${cb.redirectUri} ...`);
          const { code } = await cb.waitForCode();
          const tok = await exchangeAuthCode({
            provider: prov,
            clientId,
            clientSecret: typeof a['client-secret'] === 'string' ? a['client-secret'] : null,
            code,
            verifier: pkce.verifier,
            redirectUri: cb.redirectUri,
          });
          const profileId = typeof a.id === 'string' ? a.id : `${prov}-oauth`;
          const saved = store.upsertProfile({
            id: profileId,
            provider: prov,
            type: 'oauth',
            clientId,
            accessToken: tok.accessToken,
            refreshToken: tok.refreshToken,
            expiresAt: tok.expiresAt,
            tokenType: tok.tokenType,
            isDefault: true,
          });
          console.log(a.json ? JSON.stringify(saved, null, 2) : `${c.green('✔')} OAuth profile saved: ${c.bold(saved.id)}`);
          break;
        }
        const url = buildAuthorizationUrl({
          provider: prov,
          clientId,
          redirectUri: typeof a['redirect-uri'] === 'string' ? a['redirect-uri'] : 'http://127.0.0.1:8787/callback',
          challenge: pkce.challenge,
          state: pkce.state,
        });
        console.log(a.json ? JSON.stringify({ url, ...pkce }, null, 2) : `Open to authenticate:\n  ${url}`);
        break;
      }
      throw new Error(`unknown auth subcommand "${sub}"`);
    }
    case 'cron': {
      const a = parseArgs(rest);
      const sub = a._[0] || 'list';
      const cwd = process.cwd();
      const cronFile = typeof a.file === 'string' ? path.resolve(cwd, a.file) : path.join(cwd, '.scroll', 'cron.json');
      const { createScheduler } = await import('./scheduler.js');
      const sched = createScheduler({ filePath: cronFile, defaultTz: typeof a.tz === 'string' ? a.tz : 'UTC' });
      if (sub === 'list') {
        const jobs = sched.listJobs({ chatId: typeof a.chat === 'string' ? a.chat : null });
        if (a.json) console.log(JSON.stringify({ paused: sched.paused, jobs }, null, 2));
        else if (!jobs.length) console.log(c.dim(`no cron jobs (${sched.paused ? 'paused' : 'active'})`));
        else for (const j of jobs) console.log(`${j.enabled ? c.green('●') : c.dim('○')} ${c.bold(j.id)} [${j.cron || j.at || `${j.everyMs}ms`} @ ${j.tz}] ${j.name}`);
        break;
      }
      if (sub === 'add') {
        const job = sched.addJob({
          id: typeof a.id === 'string' ? a.id : undefined,
          name: typeof a.name === 'string' ? a.name : (a._[1] || 'Scheduled job'),
          cron: typeof a.cron === 'string' ? a.cron : undefined,
          everyMs: a['every-ms'] ? Number(a['every-ms']) : undefined,
          at: typeof a.at === 'string' ? a.at : undefined,
          tz: typeof a.tz === 'string' ? a.tz : 'UTC',
          targetChatId: typeof a.chat === 'string' ? a.chat : undefined,
          agentName: typeof a.agent === 'string' ? a.agent : undefined,
          prompt: typeof a.prompt === 'string' ? a.prompt : '',
        });
        console.log(a.json ? JSON.stringify(job, null, 2) : `${c.green('✔')} cron added: ${c.bold(job.id)} (${job.cron || job.at || job.everyMs})`);
        break;
      }
      if (sub === 'toggle') {
        const id = a._[1]; if (!id) throw new Error('usage: scroll cron toggle <id>');
        const cur = sched.getJob(id); if (!cur) throw new Error(`job not found: ${id}`);
        const next = sched.updateJob(id, { enabled: !cur.enabled });
        console.log(a.json ? JSON.stringify(next, null, 2) : `${c.green('✔')} ${id}: ${next.enabled ? 'enabled' : 'disabled'}`);
        break;
      }
      if (sub === 'remove') {
        const id = a._[1]; if (!id) throw new Error('usage: scroll cron remove <id>');
        const res = sched.removeJob(id);
        console.log(a.json ? JSON.stringify(res) : (res.removed ? `${c.green('✔')} removed ${id}` : `${c.yellow('⚠')} not found: ${id}`));
        break;
      }
      if (sub === 'pause' || sub === 'resume') {
        const res = sched.setPaused(sub === 'pause');
        console.log(a.json ? JSON.stringify(res) : `${c.green('✔')} scheduler ${res.paused ? 'paused' : 'resumed'}`);
        break;
      }
      if (sub === 'tick') {
        if (a.execute) {
          const { createChatSessionRuntime } = await import('./chat-session.js');
          const { createAuthStore } = await import('./auth.js');
          const defaultAgent = typeof a.agent === 'string' ? a.agent : null;
          const authStore = createAuthStore({ filePath: path.join(cwd, '.scroll', 'auth.json') });
          const res = await sched.tick({
            handler: async (job) => {
              const targetAgent = job.agentName || defaultAgent;
              if (!targetAgent) return { skipped: true, reason: 'no_agent_configured' };
              const rt = createChatSessionRuntime({
                agentName: targetAgent,
                cwd,
                stateDir: path.join(cwd, '.scroll', 'chat-state'),
                providerName: typeof a.provider === 'string' ? a.provider : 'auto',
                authStore,
                acquireLock: false,
              });
              try {
                const out = await rt.sendTurn({
                  conversationId: job.targetChatId || `cron:${job.id}`,
                  text: job.prompt || job.name,
                  channel: 'cron',
                });
                return { ok: true, jobId: job.id, text: out.text };
              } finally {
                await rt.close();
              }
            },
          });
          console.log(a.json ? JSON.stringify(res, null, 2) : `${c.green('✔')} tick (executed): ${res.triggered.length} triggered`);
        } else {
          const res = await sched.tick({ handler: async (job) => ({ dryRun: true, jobId: job.id }) });
          console.log(a.json ? JSON.stringify(res, null, 2) : `${c.green('✔')} tick (dry-run): ${res.triggered.length} triggered`);
        }
        break;
      }
      throw new Error(`unknown cron subcommand "${sub}"`);
    }
    case 'user': {
      const a = parseArgs(rest);
      const sub = a._[0] || 'check';
      const { openUser, importWorkspaceUserMd, userTemplate } = await import('./user.js');
      const cwd = process.cwd();
      const file = typeof a.file === 'string' ? a.file : undefined;
      if (sub === 'new') {
        const dest = path.resolve(cwd, file || 'USER.md');
        if (fs.existsSync(dest) && !a.force) throw new Error(`${rel(cwd, dest)} already exists (pass --force to overwrite)`);
        fs.writeFileSync(dest, userTemplate({
          kind: typeof a.kind === 'string' ? a.kind : 'org',
          name: typeof a.name === 'string' ? a.name : 'Example Co',
        }));
        console.log(`${c.green('✔')} created ${c.bold(rel(cwd, dest))}`);
        break;
      }
      if (sub === 'import') {
        const src = a._[1]; if (!src) throw new Error('usage: scroll user import <source-USER.md> [--out USER.md] [--name "Principal"] [--kind person|org]');
        const raw = fs.readFileSync(path.resolve(cwd, src), 'utf8');
        const res = importWorkspaceUserMd(raw, {
          principalName: typeof a.name === 'string' ? a.name : 'Principal',
          kind: typeof a.kind === 'string' ? a.kind : 'person',
        });
        const dest = path.resolve(cwd, typeof a.out === 'string' ? a.out : 'USER.md');
        fs.writeFileSync(dest, res.userMd);
        if (a.json) console.log(JSON.stringify({ out: rel(cwd, dest), humanChars: res.humanBody.length, agentNotes: res.agentNotes }, null, 2));
        else console.log(`${c.green('✔')} imported ${rel(cwd, dest)} (${res.humanBody.length} human chars · ${res.agentNotes.length} agent note(s) separated)`);
        break;
      }
      const doc = openUser({ cwd, file });
      if (sub === 'show') {
        const aud = typeof a.audience === 'string' ? a.audience : 'internal';
        const r = doc.render({ audience: aud });
        console.log(a.json ? JSON.stringify({ active: doc.active, hash: doc.hash, audience: aud, text: r.text }, null, 2) : (r.text || '(no active USER.md)'));
        break;
      }
      const chk = doc.check();
      if (a.json) console.log(JSON.stringify({ file: rel(cwd, doc.file), ...chk }, null, 2));
      else {
        for (const w of chk.warnings) console.log(`${c.yellow('⚠')} ${w}`);
        for (const e of chk.errors) console.log(`${c.red('✖')} ${e}`);
        console.log(chk.errors.length
          ? `${c.red('✖')} user: ${chk.errors.length} error(s) (${rel(cwd, doc.file)})`
          : `${c.green('✔')} user: ${chk.active ? `valid · ${chk.people} internal member(s)` : 'no USER.md'} (${rel(cwd, doc.file)})`);
      }
      if (chk.errors.length) process.exitCode = 1;
      break;
    }
    case 'people': {
      const a = parseArgs(rest);
      const { peopleCli } = await import('./people-cli.js');
      const out = await peopleCli(a, process.env);
      if (a._[0] === 'check' && out && typeof out === 'object' && !a.json) {
        for (const w of out.warnings) console.log(`${c.yellow('⚠')} ${w}`);
        for (const e of out.errors) console.log(`${c.red('✖')} ${e}`);
        console.log(out.errors.length ? `${c.red('✖')} people: ${out.errors.length} error(s) in ${out.cards} card(s) (${out.dir})` : `${c.green('✔')} people: ${out.cards} card(s) valid (${out.dir})`);
        if (out.errors.length) process.exitCode = 1;
        break;
      }
      if (a.json || typeof out !== 'string') console.log(typeof out === 'string' ? JSON.stringify({ text: out }) : JSON.stringify(out, null, 2));
      else console.log(out);
      if (out && out.ok === false) process.exitCode = 1;
      break;
    }
    case 'memory': {
      const a = parseArgs(rest);
      const { memoryCli } = await import('./memory-cli.js');
      const out = memoryCli(a, process.env);
      if (a.json || typeof out !== 'string') console.log(typeof out === 'string' ? JSON.stringify({ text: out }) : JSON.stringify(out, null, 2));
      else console.log(out);
      if (out && out.ok === false) process.exitCode = 1;
      break;
    }
    case 'mcp': {
      const a = parseArgs(rest);
      const sub = a._[0];
      if (sub === 'diff' || sub === 'approve') {
        const cwd = process.cwd();
        const agentDir = typeof a.agent === 'string' ? path.join(cwd, 'agents', a.agent) : null;
        const targetServer = a._[1] || null;
        const { createMcpManager, approveMcpLock, loadMcpLock, mcpLockPath } = await import('./mcp-client.js');
        const mgr = createMcpManager({ cwd, agentDir, autoPin: false });
        const lockFile = mcpLockPath(cwd);
        try {
          await mgr.connectAll();
          const allTools = mgr.listDiscoveredTools().concat(mgr.listQuarantinedTools ? mgr.listQuarantinedTools() : []);
          const filtered = targetServer ? allTools.filter((t) => t.server === targetServer) : allTools;
          if (sub === 'approve') {
            const approvedRes = approveMcpLock(cwd, filtered, { pinnedBy: 'cli' });
            console.log(a.json ? JSON.stringify({ ok: true, lockFile: rel(cwd, lockFile), ...approvedRes }, null, 2) : `${c.green('✔')} approved ${approvedRes.approved || filtered.length} MCP tool(s) in ${rel(cwd, lockFile)}`);
          } else {
            const lock = loadMcpLock(cwd);
            const diffs = [];
            for (const t of filtered) {
              const key = t.fullName || `mcp.${t.server}.${t.name}`;
              const pinned = lock.tools?.[key];
              if (!pinned) diffs.push({ server: t.server, tool: t.name, key, status: 'new' });
              else if (pinned.schemaHash !== t.schemaHash || pinned.descHash !== t.descHash) {
                diffs.push({ server: t.server, tool: t.name, key, status: 'changed', oldHash: pinned.schemaHash, newHash: t.schemaHash });
              }
            }
            if (a.json) console.log(JSON.stringify({ lockFile: rel(cwd, lockFile), diffs }, null, 2));
            else if (!diffs.length) console.log(`${c.green('✔')} MCP descriptors match ${rel(cwd, lockFile)}`);
            else for (const d of diffs) console.log(`${d.status === 'changed' ? c.red('!') : c.yellow('+')} ${d.key} (${d.status})`);
            if (diffs.some((d) => d.status === 'changed')) process.exitCode = 1;
          }
        } finally {
          await mgr.closeAll();
        }
        break;
      }
      if (sub !== 'add') { console.log('usage: scroll mcp <add|diff|approve> [name] [--command "cmd" | --url URL] [--args "a b"] [--env "K=${vault:K}"] [--tool "name:tier[:g1|g2]"] [--agent <agent>]'); break; }
      const name = a._[1]; if (!name) throw new Error('usage: scroll mcp add <name> [--command cmd | --url URL] [--env "K=${vault:K}"] [--tool "name:tier"] [--agent <agent>]');
      const { mcpAdd } = await import('./installers.js');
      const res = mcpAdd(name, {
        command: typeof a.command === 'string' ? a.command : undefined,
        args: typeof a.args === 'string' ? a.args.split(/\s+/).filter(Boolean) : undefined,
        url: typeof a.url === 'string' ? a.url : undefined,
        transport: typeof a.transport === 'string' ? a.transport : undefined,
        env: parseKv(a.env), tools: parseTools(a.tool),
        agent: typeof a.agent === 'string' ? a.agent : undefined,
      });
      console.log(`${c.green('✔')} mcp ${res.existed ? 'updated' : 'added'} ${c.bold(name)} → ${res.file}`);
      if (res.vaultRefs.length) console.log(c.dim(`  credentials via vault: ${res.vaultRefs.join(', ')} (resolved at load — never written to the file)`));
      if (res.server.tools) console.log(c.dim(`  tools: ${Object.entries(res.server.tools).map(([k, v]) => `${k}=${v.risk || 'read_only'}`).join(', ')}`));
      break;
    }
    case 'skill': {
      const a = parseArgs(rest);
      if (a._[0] !== 'add') { const { skillCli } = await import('./skill-cli.js'); await skillCli(a._[0], a); break; }
      const isNew = a.new !== undefined;
      const ref = isNew ? (typeof a.new === 'string' ? a.new : a._[1]) : a._[1];
      if (!ref) throw new Error('usage: scroll skill add <path> [--agent <a>]  |  scroll skill add --new <name> [--agent <a>]');
      const { skillAdd } = await import('./installers.js');
      const res = skillAdd(ref, { new: isNew, force: !!a.force, agent: typeof a.agent === 'string' ? a.agent : undefined });
      console.log(`${c.green('✔')} skill ${res.scaffolded ? 'scaffolded' : 'added'} ${c.bold(res.name)} → ${res.dir}`);
      for (const w of res.warnings || []) console.log(c.yellow(`  ⚠ ${w}`));
      if (res.attachedToAgent) console.log(c.dim(`  referenced by agent ${res.attachedToAgent} (IDENTITY.skills)`));
      break;
    }
    case 'plugin': {
      const a = parseArgs(rest);
      if (a._[0] !== 'add') { console.log('usage: scroll plugin add <path-to-.plugin|dir> [--force]'); break; }
      const ref = a._[1]; if (!ref) throw new Error('usage: scroll plugin add <path-to-.plugin|dir> [--force]');
      const { pluginAdd } = await import('./installers.js');
      const res = pluginAdd(ref, { force: !!a.force });
      console.log(`${c.green('✔')} plugin ${c.bold(res.name)} installed`);
      console.log(c.dim(`  agents: ${res.installed.agents.join(', ') || 'none'} · skills: ${res.installed.skills.join(', ') || 'none'} · mcp: ${res.installed.mcpServers.join(', ') || 'none'}`));
      break;
    }
    case 'help': case undefined: case '--help': case '-h':
      console.log(HELP); break;
    default:
      throw new Error(`unknown command "${cmd}" — try: scroll help`);
  }
}
