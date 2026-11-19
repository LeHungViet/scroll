// SCROLL — extension installers (v1.4): `scroll mcp add` · `scroll skill add` · `scroll plugin add`.
//
// These are the package-manager sugar for an agent: they WIRE capabilities declaratively, they do
// not ship implementations. MCP-first — tool implementations come from the MCP server; a skill is a
// SKILL.md folder; a plugin is an agent-pack bundle. All they do is edit files (.mcp.json, skills/,
// agents/) the runtime already reads. Zero-dep (the `unzip` CLI is used only for a .plugin ZIP;
// an unpacked plugin directory needs nothing).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSkillMd, validateSkill, scanSkillDir } from './skills.js';
import { scanForPeople } from './people.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/;
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function vaultRefs(env) {
  if (!env) return [];
  return Object.values(env).map(String).filter((v) => /^\$\{vault:.+\}$/.test(v)).map((v) => v.replace(/^\$\{vault:(.+)\}$/, '$1'));
}

// ── scroll mcp add <name> ─────────────────────────────────────────────────────
// Declare an MCP server / connector in .mcp.json (repo-level, or agent-level with opts.agent).
// Credentials are referenced as ${vault:KEY} (resolved at load, never written into the file).
// Per-tool risk/grounding (v1.4 §21) lives under server.tools.
export function mcpAdd(name, opts = {}, cwd = process.cwd()) {
  if (!NAME_RE.test(name || '')) throw new Error(`mcp name "${name}" must match ${NAME_RE}`);
  const file = opts.agent ? path.join(cwd, 'agents', opts.agent, '.mcp.json') : path.join(cwd, '.mcp.json');
  if (opts.agent && !fs.existsSync(path.join(cwd, 'agents', opts.agent))) throw new Error(`agent not found: agents/${opts.agent}/`);
  const json = readJson(file) || { mcpServers: {} };
  json.mcpServers = json.mcpServers || {};
  const existed = !!json.mcpServers[name];

  let server;
  if (opts.url) server = { type: opts.transport || 'http', url: opts.url };
  else server = { command: opts.command || name, args: Array.isArray(opts.args) ? opts.args : [] };
  if (opts.env && Object.keys(opts.env).length) server.env = opts.env;
  if (opts.tools && Object.keys(opts.tools).length) server.tools = opts.tools;

  // merge: keep existing fields (e.g. previously-added tools/env) unless this call overrides them
  json.mcpServers[name] = { ...(json.mcpServers[name] || {}), ...server };
  writeJson(file, json);
  return { file: path.relative(cwd, file) || file, name, existed, server: json.mcpServers[name], vaultRefs: vaultRefs(server.env) };
}

// ── scroll skill add <ref|--new name> ─────────────────────────────────────────
// A skill is a SKILL.md folder. Install it onto the repo search path (skills/<name>/), optionally
// attach it to an agent (IDENTITY.skills). --new scaffolds a stub.
export function skillAdd(ref, opts = {}, cwd = process.cwd()) {
  const skillsDir = path.join(cwd, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  if (opts.new) {
    const name = ref;
    if (!NAME_RE.test(name || '')) throw new Error(`skill name "${name}" must match ${NAME_RE}`);
    const dest = path.join(skillsDir, name);
    if (fs.existsSync(dest)) throw new Error(`skills/${name}/ already exists`);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), skillStub(name));
    return { name, dir: path.relative(cwd, dest) || dest, scaffolded: true, attachedToAgent: opts.agent ? attachSkillToAgent(cwd, opts.agent, name) : null };
  }

  const srcDir = path.resolve(cwd, ref || '');
  const skillMd = path.join(srcDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new Error(`no SKILL.md in "${ref}" — a skill is a folder containing SKILL.md`);
  // v1.8 §36: the open Agent Skills format (name + description), then the security scan. Installing
  // copies the skill into the repo, so it is held to the repo's bar; --force overwrites, it never
  // lets a blocked skill in.
  const parsed = parseSkillMd(fs.readFileSync(skillMd, 'utf8'));
  const fm = parsed.frontmatter || {};
  const v = validateSkill({ dir: srcDir, frontmatter: parsed.frontmatter, body: parsed.body, parseError: parsed.error }, { strict: false });
  if (v.errors.length) throw new Error(`SKILL.md is not a valid skill: ${v.errors.join('; ')}`);
  const name = fm.name;
  // v1.9 §41: a shared skill never carries a person (card, USER.md, people/)
  const ppl = scanForPeople(srcDir);
  if (ppl.length) throw new Error(`skill "${name}" carries people (${ppl.map((h) => h.file).join(', ')}) — person cards live in the deployment's people dir, never in a shared package`);
  const sec = scanSkillDir(srcDir, opts.trust || 'community');
  if (sec.verdict === 'block') throw new Error(`skill "${name}" failed the security scan: ${sec.blocking.map((f) => `${f.rule} at ${f.file}:${f.line}`).join(', ')}`);
  const dest = path.join(skillsDir, name);
  if (fs.existsSync(dest) && !opts.force) throw new Error(`skills/${name}/ already exists (use --force to overwrite)`);
  fs.cpSync(srcDir, dest, { recursive: true });
  return { name, dir: path.relative(cwd, dest) || dest, scaffolded: false, warnings: v.warnings, security: sec.verdict, attachedToAgent: opts.agent ? attachSkillToAgent(cwd, opts.agent, name) : null };
}

// Ensure an agent's IDENTITY frontmatter references the skill (inline `skills: [a, b]`).
export function attachSkillToAgent(cwd, agent, skillName) {
  const idp = path.join(cwd, 'agents', agent, 'IDENTITY.md');
  if (!fs.existsSync(idp)) throw new Error(`agent not found: agents/${agent}/IDENTITY.md`);
  const raw = fs.readFileSync(idp, 'utf8');
  const m = raw.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) throw new Error(`agents/${agent}/IDENTITY.md has no frontmatter`);
  let fm = m[2];
  const existing = fm.match(/^skills:\s*\[([^\]]*)\]\s*$/m);
  if (existing) {
    const items = existing[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (!items.includes(skillName)) items.push(skillName);
    fm = fm.replace(/^skills:\s*\[[^\]]*\]\s*$/m, `skills: [${items.join(', ')}]`);
  } else {
    fm = `${fm}\nskills: [${skillName}]`;
  }
  fs.writeFileSync(idp, raw.replace(/^---\n[\s\S]*?\n---/, `---\n${fm}\n---`));
  return agent;
}

// The open Agent Skills layout (v1.8 §34.1). The description is what an agent reads to decide
// whether to use the skill: say what it does AND when, in the words a user would use.
function skillStub(name) {
  return `---\nname: ${name}\ndescription: Does X for Y. Use when the user asks to … or mentions …. CHANGE ME.\n---\n\n# ${name}\n\nThe name and description sit in every agent's cached index; this body loads only when the skill is used, so keep it under 500 lines and move detail to references/ (one level deep).\n\n## Steps\n\n1. …\n\nAdd at least 3 eval cases in evals/ before relying on it: \`scroll skill eval ${name}\` runs each with and without the skill.\n`;
}

// ── scroll plugin add <ref> ───────────────────────────────────────────────────
// A plugin is an "agent-pack": agents/ + skills/ + .mcp.json (+ manifest). Unpack a directory or a
// .plugin/.zip and merge it into the repo. Existing items are skipped unless --force.
export function pluginAdd(ref, opts = {}, cwd = process.cwd()) {
  let srcDir = path.resolve(cwd, ref || '');
  if (!fs.existsSync(srcDir)) throw new Error(`plugin not found: ${ref}`);
  let tmp = null;
  if (fs.statSync(srcDir).isFile()) {
    if (!/\.(plugin|zip)$/.test(srcDir)) throw new Error('a plugin file must be a .plugin or .zip (or pass an unpacked directory)');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-plugin-'));
    const r = spawnSync('unzip', ['-q', '-o', srcDir, '-d', tmp], { encoding: 'utf8' });
    if (r.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('unzip failed (install the `unzip` CLI, or pass an unpacked plugin directory): ' + (r.stderr || '')); }
    srcDir = pluginRoot(tmp);
  }

  const manifest = readJson(path.join(srcDir, 'manifest.json')) || readJson(path.join(srcDir, 'plugin.json')) || {};
  const installed = { agents: [], skills: [], mcpServers: [] };

  const copyTree = (subdir, listKey) => {
    const base = path.join(srcDir, subdir);
    if (!fs.existsSync(base)) return;
    for (const n of fs.readdirSync(base)) {
      const s = path.join(base, n);
      if (!fs.statSync(s).isDirectory()) continue;
      const d = path.join(cwd, subdir, n);
      if (fs.existsSync(d) && !opts.force) { installed[listKey].push(`${n} (skipped: exists)`); continue; }
      // v1.8 §36.2: a plugin's skill is scanned like any other; a blocked one is not installed
      // v1.9 §41: an agent or skill that carries a person (card, USER.md, people/) is not installed
      { const ppl = scanForPeople(s); if (ppl.length) { installed[listKey].push(`${n} (skipped: carries people — ${ppl.map((h) => h.file).join(', ')})`); continue; } }
      if (subdir === 'skills') { const sec = scanSkillDir(s, opts.trust || 'community'); if (sec.verdict === 'block') { installed[listKey].push(`${n} (skipped: blocked by the security scan — ${sec.blocking.map((f) => f.rule).join(', ')})`); continue; } }
      fs.cpSync(s, d, { recursive: true });
      installed[listKey].push(n);
    }
  };
  copyTree('agents', 'agents');
  copyTree('skills', 'skills');
  if (fs.existsSync(path.join(srcDir, 'people'))) installed.ignored = ['people/ (a plugin never installs person cards — §41)'];

  const pmcp = readJson(path.join(srcDir, '.mcp.json'));
  if (pmcp && pmcp.mcpServers) {
    const dest = path.join(cwd, '.mcp.json');
    const cur = readJson(dest) || { mcpServers: {} };
    cur.mcpServers = cur.mcpServers || {};
    for (const [k, v] of Object.entries(pmcp.mcpServers)) {
      if (cur.mcpServers[k] && !opts.force) { installed.mcpServers.push(`${k} (skipped: exists)`); continue; }
      cur.mcpServers[k] = v; installed.mcpServers.push(k);
    }
    writeJson(dest, cur);
  }

  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  return { name: manifest.name || path.basename(String(ref)).replace(/\.(plugin|zip)$/, ''), installed, manifest };
}

// If a zip unpacked to a single wrapper folder (and no manifest/agents at top), descend into it.
function pluginRoot(dir) {
  const top = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  const hasContent = ['manifest.json', 'plugin.json', 'agents', 'skills', '.mcp.json'].some((n) => fs.existsSync(path.join(dir, n)));
  if (!hasContent && top.length === 1 && fs.statSync(path.join(dir, top[0])).isDirectory()) return path.join(dir, top[0]);
  return dir;
}
