// SCROLL — skills (v1.8 §34–§36). Zero-dep.
//
// A skill is a folder with a SKILL.md in the open Agent Skills format (agentskills.io): YAML
// frontmatter (`name`, `description`, optional `license`, `compatibility`, `metadata`,
// `allowed-tools`) and a markdown body, plus optional scripts/, references/, assets/.
// The same folder works in many agent runtimes, so an agent built on SCROLL can use skills written
// for other tools without copying or editing them.
//
// What this module does — all of it in code, none of it in a prompt:
//   §34 load    find skills in ordered sources (agent → repo → read-only external folders), resolve
//               name clashes by precedence, hide what the agent cannot run, and give the agent a
//               byte-stable index for the cached prefix plus two tools: skill_list and skill_view.
//   §35 compat  read which tools a skill names (its own declaration, or the tool names it uses),
//               map foreign tool names to SCROLL capabilities, and decide ok | partial | hidden.
//               A human can correct the machine in a sidecar file; the skill itself is never edited.
//   §36 check   validate the format; scan every text file for secrets, exfiltration, remote code,
//               destructive commands, hidden text and prompt injection. A blocked skill never
//               reaches the index or the tools, and there is no flag to force it in.
//
// The model only ever sees what passed. Everything the model can reach is re-checked at read time,
// so a file that changed after the session started is scanned again before it is served.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseYaml } from './scroll.js';
import { tokens } from './memory.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const arr = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
const approxTokens = (s) => Math.ceil(String(s || '').length / 4);

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LIMITS = {
  name: 64, description: 1024, compatibility: 500, bodyLines: 500,
  skillMdBytes: 1024 * 1024,          // a SKILL.md larger than this is refused
  viewBytes: 256 * 1024,              // largest file skill_view serves
  bodyChars: 120000,                  // SKILL.md body served by skill_view (truncated beyond)
  scanFiles: 200, scanFileBytes: 512 * 1024,
  maxDepth: 6, maxSkillsPerSource: 5000,
  indexSkills: 150, indexTokens: 6000, // §34.6
};
export const TRUST_LEVELS = ['builtin', 'trusted', 'community', 'untrusted'];
const SEVERITY = { low: 0, medium: 1, high: 2, critical: 3 };
// the lowest severity that blocks a skill, per trust level (§36.2)
export const BLOCK_AT = { builtin: 'critical', trusted: 'critical', community: 'high', untrusted: 'medium' };

// ── frontmatter ───────────────────────────────────────────────────────────────────────────────
// SCROLL's own YAML reader is a deliberate subset. Real SKILL.md files use more: block scalars
// (`description: >-` then indented lines), escaped double-quoted strings, plain scalars that wrap
// onto the next line, and flow lists that span lines. Those are folded into single values here,
// then the rest goes through the shared reader.
const HOLD = (i) => `"\u0000S${i}\u0000"`;
const HELD_RE = /^\u0000S(\d+)\u0000$/;
function restore(v, held) {
  if (typeof v === 'string') { const m = v.match(HELD_RE); return m ? held[Number(m[1])] : v; }
  if (Array.isArray(v)) return v.map((x) => restore(x, held));
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = restore(x, held); return o; }
  return v;
}
const indentOf = (s) => s.match(/^[ \t]*/)[0].length;
function closingQuote(s, q, from) {
  for (let i = from; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue; }
    if (s[i] === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } return i; }
  }
  return -1;
}
function unquote(q, inner) {
  if (q === "'") return inner.replace(/''/g, "'");
  try { return JSON.parse(`"${inner.replace(/\\'/g, "'").replace(/\\\//g, '/').replace(/\t/g, '\\t')}"`); }
  catch { return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
}
function balance(s) {
  let d = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\' && q === '"') { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch; else if (ch === '[' || ch === '{') d++; else if (ch === ']' || ch === '}') d--;
  }
  return d;
}
export function parseSkillYaml(src) {
  const lines = String(src).split('\n');
  const out = [], held = [];
  const hold = (s) => { held.push(s); return HOLD(held.length - 1); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([ \t]*)([A-Za-z0-9_][A-Za-z0-9_.\- ]*?):(?:[ \t]+(.*))?$/);
    if (!m) { out.push(line); continue; }
    const [, ind, key] = m; const kInd = ind.length;
    let val = (m[3] || '').trim();
    const following = () => { const got = []; let j = i + 1; while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > kInd)) got.push(lines[j++]); return got; };
    const blk = val.match(/^([|>])([+-]?)(\d*)[ \t]*(?:#.*)?$/);
    if (blk) {
      const body = following(); i += body.length;
      while (body.length && body[body.length - 1].trim() === '') body.pop();
      const first = body.find((l) => l.trim() !== '');
      const cut = blk[3] ? kInd + Number(blk[3]) : (first ? indentOf(first) : 0);
      const ls = body.map((l) => (l.trim() === '' ? '' : l.slice(Math.min(cut, indentOf(l)))));
      let text;
      if (blk[1] === '|') text = ls.join('\n');
      else { text = ''; for (const l of ls) { if (l === '') text += '\n'; else text += (text && !text.endsWith('\n') ? ' ' : '') + l; } }
      if (blk[2] !== '-') text += '\n';
      out.push(`${ind}${key}: ${hold(text)}`);
      continue;
    }
    if (val[0] === '"' || val[0] === "'") {
      const q = val[0]; let acc = val; let end = closingQuote(acc, q, 1);
      while (end < 0 && i + 1 < lines.length) { i++; acc += ' ' + lines[i].trim(); end = closingQuote(acc, q, 1); }
      if (end < 0) throw new Error(`unterminated ${q === '"' ? 'double' : 'single'}-quoted value for "${key.trim()}"`);
      out.push(`${ind}${key}: ${hold(unquote(q, acc.slice(1, end)))}`);
      continue;
    }
    if (val[0] === '[' || val[0] === '{') {
      let acc = val;
      while (balance(acc) > 0 && i + 1 < lines.length) { i++; acc += ' ' + lines[i].trim(); }
      out.push(`${ind}${key}: ${acc}`);
      continue;
    }
    if (val !== '' && !val.startsWith('#')) {
      const more = []; let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '' && indentOf(lines[j]) > kInd) more.push(lines[j++].trim());
      if (more.length) { i = j - 1; out.push(`${ind}${key}: ${hold([val, ...more].join(' '))}`); continue; }
    }
    out.push(line);
  }
  const parsed = parseYaml(out.join('\n'));
  return restore(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}, held);
}

export function parseSkillMd(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = text.match(/^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/);
  if (!m) return { frontmatter: null, body: text, error: 'SKILL.md has no YAML frontmatter (--- … ---)' };
  const body = text.slice(m[0].length).replace(/^\n+/, '');
  try { return { frontmatter: parseSkillYaml(m[1] || ''), body, error: null }; }
  catch (e) { return { frontmatter: null, body, error: `frontmatter: ${e.message}` }; }
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ── §36.1 validation ──────────────────────────────────────────────────────────────────────────
// strict = a skill this repo ships (agent or repo source): a SHOULD of the format is an error here.
// External skills belong to someone else: the same findings are warnings, and only what makes a
// skill unusable (no name, no description, a name that cannot be addressed) keeps it out.
export function validateSkill(skill, { strict = false } = {}) {
  const errors = [], warnings = [];
  const should = (msg) => (strict ? errors : warnings).push(msg);
  if (skill.parseError) return { errors: [skill.parseError], warnings };
  const fm = skill.frontmatter || {};
  const dirName = path.basename(skill.dir || '');
  if (typeof fm.name !== 'string' || !fm.name.trim()) errors.push('frontmatter: `name` is required');
  else if (!SKILL_NAME_RE.test(fm.name) || fm.name.length > LIMITS.name) errors.push(`name "${oneLine(fm.name).slice(0, 80)}" must be 1-${LIMITS.name} lowercase letters, digits and single hyphens`);
  else if (dirName && fm.name !== dirName) should(`name "${fm.name}" differs from its folder "${dirName}"`);
  if (typeof fm.description !== 'string' || !fm.description.trim()) errors.push('frontmatter: `description` is required (what the skill does and when to use it)');
  else {
    if (fm.description.length > LIMITS.description) should(`description is ${fm.description.length} characters (max ${LIMITS.description})`);
    if (/<\/?[A-Za-z][^>]*>/.test(fm.description)) should('description contains XML/HTML tags');
  }
  if (fm.compatibility != null && String(fm.compatibility).length > LIMITS.compatibility) should(`compatibility is longer than ${LIMITS.compatibility} characters`);
  if (fm.metadata != null && (typeof fm.metadata !== 'object' || Array.isArray(fm.metadata))) should('metadata must be a map');
  if (strict && typeof fm.name === 'string' && /anthropic|claude/.test(fm.name)) warnings.push(`name "${fm.name}" uses a vendor's reserved word; some runtimes refuse it`);
  const body = skill.body || '';
  const nLines = body.split('\n').length;
  if (nLines > LIMITS.bodyLines) warnings.push(`SKILL.md body is ${nLines} lines; keep it under ${LIMITS.bodyLines} and move detail to references/`);
  if (skill.dir) {
    for (const ref of fileRefs(body)) {
      if (ref.includes('\\')) { warnings.push(`reference "${ref}" uses backslashes; use forward slashes`); continue; }
      const target = path.resolve(skill.dir, ref);
      if (!target.startsWith(path.resolve(skill.dir) + path.sep)) { should(`reference "${ref}" points outside the skill folder`); continue; }
      if (!fs.existsSync(target)) { should(`reference "${ref}" does not exist`); continue; }
      if (strict && /\.md$/i.test(ref)) {
        let inner = ''; try { inner = fs.readFileSync(target, 'utf8'); } catch { /* unreadable */ }
        const nested = fileRefs(inner).filter((r) => /\.md$/i.test(r));
        if (nested.length) warnings.push(`reference "${ref}" links further files (${nested.slice(0, 3).join(', ')}); keep references one level deep from SKILL.md`);
      }
    }
  }
  return { errors, warnings };
}
// relative file references in markdown: [text](path) links and `scripts/…` / `references/…` / `assets/…` spans
function fileRefs(body) {
  const out = new Set();
  for (const m of String(body).matchAll(/\]\(([^)\s#?]+)(?:[#?][^)]*)?\)/g)) {
    const r = m[1];
    if (/^([a-z][a-z0-9+.-]*:|\/|#|~)/i.test(r) || r.includes('{') || r.includes('<')) continue;
    out.add(r.replace(/^\.\//, ''));
  }
  for (const m of String(body).matchAll(/`((?:\.\/)?(?:scripts|references|assets)[\\/][^`\s*?<>{}$]+)`/g)) out.add(m[1].replace(/^\.\//, ''));
  return [...out];
}

// ── §36.2 security scan ───────────────────────────────────────────────────────────────────────
// Rules are data. Each names what it catches; severity decides, with the source's trust, whether
// the skill is blocked or only reported. Findings never carry the matched secret itself.
const SECRET_RES = [
  /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{24,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{20,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\bglpat-[A-Za-z0-9_-]{20,}/,
];
const PLACEHOLDER_RE = /x{4,}|X{4,}|\.\.\.|YOUR|EXAMPLE|example|REPLACE|placeholder|0{8,}|1234567|abcdef/;
function secretInLine(line, next) {
  for (const re of SECRET_RES) {
    const m = line.match(re);
    if (!m) continue;
    const v = m[0];
    if (PLACEHOLDER_RE.test(v)) continue;
    if ((v.match(/\d/g) || []).length < 2 || (v.match(/[A-Za-z]/g) || []).length < 8) continue;
    return true;
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(line) && /^[A-Za-z0-9+/=]{40,}$/.test(String(next || '').trim())) return true;
  return false;
}
export const SECURITY_RULES = [
  { id: 'secret', severity: 'critical', why: 'a live credential is written into the skill', test: (l, n) => secretInLine(l, n) },
  { id: 'exfiltration', severity: 'critical', why: 'sends credentials or private files over the network',
    re: /\b(curl|wget|nc|ncat|scp|rsync|Invoke-WebRequest|iwr|Invoke-RestMethod)\b[^\n]*(~\/\.ssh|\.ssh\/id_|\bid_rsa\b|\bid_ed25519\b|\.aws\/credentials|\.netrc|\.git-credentials|login\.keychain|\/etc\/shadow)/i },
  { id: 'exfiltration', severity: 'critical', why: 'pipes credentials or private files to a network tool',
    re: /(~\/\.ssh|\bid_rsa\b|\.aws\/credentials|\.netrc|\.env\b)[^\n|]*\|\s*(curl|nc|ncat|wget)\b/i },
  { id: 'reverse-shell', severity: 'critical', why: 'opens a shell to a remote host', re: /\/dev\/tcp\/[\w.-]+\/\d+|\bnc(at)?\b[^\n]*\s-e\s|\bbash\s+-i\s+>&|\bmkfifo\b[^\n]*\bnc\b/ },
  { id: 'hidden-text', severity: 'critical', why: 'contains bidirectional control characters that hide text from a reader', re: /[\u202A-\u202E\u2066-\u2069]/ },
  { id: 'hidden-text', severity: 'high', why: 'contains zero-width characters that hide text from a reader', re: /[\u200B\u200C\u2060\u180E]|.\uFEFF/ },
  { id: 'injection', severity: 'high', why: 'tells the model to drop earlier instructions',
    re: /\b(ignore|disregard|forget|override)\b[^\n]{0,30}\b(previous|prior|above|earlier|system|developer|safety)\b[^\n]{0,20}\b(instructions?|prompts?|rules?|messages?|guidelines?)\b/i, quoted: 'medium' },
  { id: 'injection', severity: 'high', why: 'tells the model to hide what it does from the user',
    re: /\b(do not|don't|never)\s+(tell|inform|let)\s+the\s+user\s+(know|about|that|what|you|we)\b|\b(do not|don't|never)\s+(reveal|mention|disclose)\b[^\n]{0,30}\bto\s+the\s+user\b|\bwithout\s+(telling|informing)\s+the\s+user\b|\bhide\b[^\n]{0,20}\bfrom\s+the\s+user\b/i, quoted: 'medium' },
  { id: 'injection', severity: 'high', why: 'tries to replace the model\'s instructions', re: /\byou are now\b|\bnew system prompt\b|\b(developer|DAN|jailbreak)[ -]mode\b/i, quoted: 'medium' },
  { id: 'destructive', severity: 'high', why: 'deletes a home or root directory',
    re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:--no-preserve-root\s+)?(?:\/|\/\*|~\/?|~\/\*|\$HOME\/?|\$\{HOME\}\/?)(?=\s|$|;|&|\|)/ },
  { id: 'destructive', severity: 'high', why: 'erases a disk or exhausts the machine',
    re: /\bmkfs(\.\w+)?\s|\bdd\s+[^\n]*\bof=\/dev\/(sd|disk|nvme|hd|rdisk)|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|\bdiskutil\s+(erase\w*|zeroDisk)\b|\bchmod\s+-R\s+777\s+\/(\s|$)/ },
  { id: 'remote-code', severity: 'high', why: 'downloads code and runs it unseen',
    re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\biex\s*\(\s*(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|New-Object\s+Net\.WebClient)|\beval\s+"?\$\(\s*(curl|wget)\b/i },
  { id: 'persistence', severity: 'high', why: 'adds itself to shell start-up or remote login',
    re: /(>>?|\btee\s+-a)\s*["']?(~|\$HOME)?\/?[^\s"']*(\.bashrc|\.zshrc|\.bash_profile|\.profile|authorized_keys)\b/ },
  { id: 'scheduler', severity: 'medium', why: 'installs a scheduled job', re: /\bcrontab\s+-[a-z]*\s|\bLaunchAgents\/[^\s]+\.plist|\bschtasks\s+\/create\b/i },
  { id: 'privilege', severity: 'medium', why: 'runs commands as administrator', re: /(^|[\s;&|(`])sudo\s+\S/ },
  { id: 'force-push', severity: 'medium', why: 'rewrites shared git history', re: /\bgit\s+push\s+[^\n]*(--force\b|\s-f\b)/ },
];
const TEXT_EXT = /\.(md|markdown|txt|sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|json|ya?ml|toml|ini|cfg|html?|xml)$/i;
export function scanText(text, file = 'SKILL.md', rules = SECURITY_RULES) {
  const findings = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.length > 20000) continue;
    for (const r of rules) {
      if (r.test) { if (r.test(l, lines[i + 1])) findings.push({ rule: r.id, severity: r.severity, file, line: i + 1, why: r.why }); continue; }
      const m = r.re.exec(l);
      if (!m) continue;
      // a phrase quoted as an example ("ignore previous instructions" — do not obey it) is reported, not obeyed
      const quoted = r.quoted && /["'“‘«`]\s*$/.test(l.slice(Math.max(0, m.index - 3), m.index));
      findings.push({ rule: r.id, severity: quoted ? r.quoted : r.severity, file, line: i + 1, why: quoted ? `${r.why} (quoted as an example)` : r.why });
    }
  }
  return findings;
}
function skillFiles(dir, limit = LIMITS.scanFiles) {
  const out = [];
  (function walk(d, rel, depth) {
    if (out.length >= limit || depth > 4) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (out.length >= limit) return;
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const p = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!e.isSymbolicLink()) walk(p, r, depth + 1); continue; }
      if (st.isFile()) out.push({ rel: r, abs: p, size: st.size, mtimeMs: st.mtimeMs });
    }
  })(dir, '', 0);
  return out;
}
export function verdictFor(findings, trust = 'community') {
  const at = SEVERITY[BLOCK_AT[trust] || 'high'];
  const blocking = findings.filter((f) => SEVERITY[f.severity] >= at);
  return { verdict: blocking.length ? 'block' : findings.length ? 'warn' : 'clean', blocking };
}
export function scanSkillDir(dir, trust = 'community', files = null) {
  const findings = [];
  for (const f of files || skillFiles(dir)) {
    if (!TEXT_EXT.test(f.rel) && f.rel !== 'SKILL.md') continue;
    if (f.size > LIMITS.scanFileBytes) { findings.push({ rule: 'unscanned', severity: 'low', file: f.rel, line: 0, why: 'file too large to scan' }); continue; }
    let text; try { text = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    findings.push(...scanText(text, f.rel));
  }
  return { ...verdictFor(findings, trust), findings };
}

// ── §35 tools a skill names, and what they mean here ─────────────────────────────────────────
// Foreign tool names → SCROLL capabilities. Data, not prose: extend it with config
// `skills.tool_aliases` or the `toolAliases` option. `null` = no portable equivalent; only a
// runtime that has a tool of exactly that name satisfies it.
export const TOOL_ALIASES = {
  // file, shell, web
  Bash: 'shell.exec', Read: 'fs.read', Write: 'fs.write', Edit: 'fs.write', MultiEdit: 'fs.write', NotebookEdit: 'fs.write',
  Glob: 'fs.search', Grep: 'fs.search', LS: 'fs.read', WebSearch: 'web.search', WebFetch: 'web.read',
  shell: 'shell.exec', apply_patch: 'fs.write', web_search: 'web.search', view_image: 'vision.read',
  run_shell_command: 'shell.exec', read_file: 'fs.read', write_file: 'fs.write', read_many_files: 'fs.read',
  google_web_search: 'web.search', web_fetch: 'web.read', search_file_content: 'fs.search',
  terminal: 'shell.exec', search_files: 'fs.search', patch: 'fs.write', web_extract: 'web.read', browser_navigate: 'web.browse',
  vision_analyze: 'vision.read', image_generate: 'vision.generate',
  // people and other agents
  AskUserQuestion: 'ask.user', clarify: 'ask.user', SendUserMessage: 'message.send', SendUserFile: 'message.file', send_message: 'message.send',
  Agent: 'dispatch.agents', Task: 'dispatch.agents', delegate_task: 'dispatch.agents',
  // skills, plans, memory
  Skill: 'skills.read', skill_view: 'skills.read', skill_list: 'skills.read', skills_list: 'skills.read',
  TodoWrite: 'tasks.track', TaskCreate: 'tasks.track', TaskUpdate: 'tasks.track', TaskList: 'tasks.track', update_plan: 'tasks.track', todo: 'tasks.track',
  save_memory: 'memory.agent',
  // no portable equivalent
  Artifact: null,
};
// names that are ordinary words: counted only as `Name` in backticks or "Name tool"
const AMBIGUOUS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS', 'Task', 'Agent', 'Skill', 'Artifact', 'shell', 'web_search', 'read_file', 'write_file', 'web_fetch', 'terminal', 'search_files', 'patch', 'clarify', 'send_message', 'todo', 'image_generate', 'view_image', 'save_memory', 'skill_list']);
const SOFT_CAPS = new Set(['tasks.track']); // a missing plan/todo tool changes nothing about what a skill can do
const CAP_SHAPE = /^[a-z]+\.[a-z_*]+$/;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_RES = new Map();
function nameRe(name) {
  let re = NAME_RES.get(name);
  if (!re) {
    const e = reEsc(name);
    re = AMBIGUOUS.has(name) ? new RegExp(`\`${e}\`|\\b${e}\\s+tool\\b`) : new RegExp(`(?<![\\w.-])${e}(?![\\w-])`);
    NAME_RES.set(name, re);
  }
  return re;
}

function aliasCap(name, aliases) { return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : undefined; }
function reqFromName(raw, aliases, hard, via) {
  const name = String(raw).trim().replace(/\(.*\)$/, '');
  if (!name) return null;
  if (CAP_SHAPE.test(name)) return { ref: name, kind: 'cap', cap: name, hard, via };
  const mm = name.replace(/[_*]+$/, '').match(/^mcp__([A-Za-z0-9_.-]+?)__([A-Za-z0-9_.-]+)$/);
  if (mm) return { ref: name.replace(/[_*]+$/, ''), kind: 'mcp', server: mm[1], tool: mm[2], cap: `mcp.${mm[1].toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, hard, via };
  const cap = aliasCap(name, aliases);
  return { ref: name, kind: 'tool', cap: cap === undefined ? null : cap, hard, via };
}
function splitList(v) {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v ?? ''); const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++; if (ch === ')') depth--;
    if (depth === 0 && /[\s,]/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const meta = (fm, ns) => (fm && fm.metadata && typeof fm.metadata === 'object' && fm.metadata[ns] && typeof fm.metadata[ns] === 'object' ? fm.metadata[ns] : {});
export function skillRequirements(fm, body, { aliases = TOOL_ALIASES, extra = [] } = {}) {
  const reqs = new Map();
  const add = (r) => { if (!r) return; const k = r.ref; const cur = reqs.get(k); if (!cur || (r.hard && !cur.hard)) reqs.set(k, r); };
  const sc = meta(fm, 'scroll'), hm = meta(fm, 'hermes');
  for (const n of splitList(fm && fm['allowed-tools'])) add(reqFromName(n, aliases, true, 'allowed-tools'));
  for (const n of splitList(sc.requires)) add(reqFromName(n, aliases, true, 'requires'));
  for (const n of splitList(hm.requires_tools)) add(reqFromName(n, aliases, true, 'requires'));
  for (const n of arr(extra)) add(reqFromName(n, aliases, true, 'override'));
  const text = String(body || '');
  for (const m of text.matchAll(/\bmcp__([A-Za-z0-9_.-]+?)__([A-Za-z0-9_-]+)/g)) add(reqFromName(m[0], aliases, false, 'body'));
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]+):([a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) add({ ref: `${m[1]}:${m[2]}`, kind: 'mcp', server: m[1], tool: m[2], cap: `mcp.${m[1].toLowerCase()}`, hard: false, via: 'body' });
  for (const name of Object.keys(aliases)) {
    if (!text.includes(name)) continue;
    if (nameRe(name).test(text)) add(reqFromName(name, aliases, false, 'body'));
  }
  return [...reqs.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}
export function normalizeAvailable(av) {
  if (!av) return null;
  const caps = new Set(arr(av.capabilities)); const tools = new Set(arr(av.tools)); const servers = new Set(arr(av.mcpServers || av.mcp_servers));
  const capOk = (c) => {
    if (!c) return false;
    if (caps.has(c) || caps.has('*')) return true;
    const root = c.split('.')[0];
    return caps.has(`${root}.*`);
  };
  return { caps, tools, servers, capOk };
}
export function satisfied(req, av) {
  if (!av) return true;
  if (req.kind === 'cap') return av.capOk(req.cap);
  if (req.kind === 'mcp') return av.servers.has(req.server) || av.tools.has(req.ref) || av.tools.has(req.tool) || av.capOk(req.cap) || av.capOk('mcp.*');
  return av.tools.has(req.ref) || (req.cap != null && av.capOk(req.cap));
}
// hidden: a requirement the skill DECLARES is missing, or most of the tools its text names are
// missing (≥2, and more missing than present — a skill built around another runtime's tools).
// partial: some named tools are missing; the skill is shown and skill_view says which.
export function compatStatus(reqs, av) {
  if (!av) return { status: 'unknown', unmet: [], dominant: false };
  const counted = reqs.filter((r) => !(r.cap && SOFT_CAPS.has(r.cap)));
  const unmet = counted.filter((r) => !satisfied(r, av));
  if (unmet.some((r) => r.hard)) return { status: 'hidden', unmet, dominant: false };
  const met = counted.length - unmet.length;
  if (unmet.length >= 2 && unmet.length > met) return { status: 'hidden', unmet, dominant: true };
  return { status: unmet.length ? 'partial' : 'ok', unmet, dominant: false };
}

// ── config, sources, layouts ──────────────────────────────────────────────────────────────────
export function expandPath(p, env = process.env) {
  let s = String(p || '').trim();
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => env[a || b] ?? '');
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return s;
}
export function loadScrollConfig(cwd = process.cwd()) {
  for (const f of ['scroll.config.yaml', 'scroll.config.yml', 'scroll.config.json']) {
    const p = path.join(cwd, f);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    try { return f.endsWith('.json') ? JSON.parse(raw) : (parseSkillYaml(raw) || {}); }
    catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  return {};
}
// How to find skill folders inside a source. Extensible: registerSourceLayout(name, fn).
const LAYOUTS = {
  // any folder: every directory that holds a SKILL.md, at any depth up to max_depth
  dir: (src) => findSkillDirs(src.path, src),
  // a Claude Code plugins folder: only the plugin versions installed_plugins.json says are installed
  'claude-code-plugins': (src) => {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(src.path, 'installed_plugins.json'), 'utf8')); } catch { return []; }
    const dirs = [];
    for (const installs of Object.values((j && j.plugins) || {})) {
      for (const inst of arr(installs)) {
        if (!inst || typeof inst.installPath !== 'string') continue;
        dirs.push(...findSkillDirs(path.join(inst.installPath, 'skills'), { ...src, maxDepth: 2 }));
      }
    }
    return dirs;
  },
};
export function registerSourceLayout(name, fn) { if (typeof fn !== 'function') throw new Error('layout must be a function'); LAYOUTS[name] = fn; }
export function findSkillDirs(root, { maxDepth = LIMITS.maxDepth, maxSkills = LIMITS.maxSkillsPerSource } = {}) {
  const found = []; const seen = new Set();
  (function walk(dir, depth) {
    if (found.length >= maxSkills) return;
    let real; try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return; seen.add(real);
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const md = ents.find((e) => e.name === 'SKILL.md');
    if (md) { try { if (fs.statSync(path.join(dir, 'SKILL.md')).isFile()) { found.push(dir); return; } } catch { /* dangling */ } }
    if (depth >= maxDepth) return;
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.build' || e.name === '.scroll' || e.name === '__pycache__') continue;
      const p = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; } }
      if (isDir) walk(p, depth + 1);
    }
  })(root, 0);
  return found;
}
// Well-known skill folders of other tools. Used only by `scroll skill sources --detect`, which
// reports what exists; nothing is read unless the operator lists it in scroll.config.
export const KNOWN_SKILL_DIRS = [
  { path: '~/.agents/skills', note: 'shared Agent Skills folder' },
  { path: '~/.claude/skills', note: 'Claude Code user skills' },
  { path: '~/.claude/plugins', layout: 'claude-code-plugins', note: 'Claude Code installed plugins' },
  { path: '~/.codex/skills', note: 'Codex user skills' },
  { path: '~/.hermes/skills', note: 'Hermes Agent skills' },
  { path: '~/.gemini/skills', note: 'Gemini CLI skills' },
];
export function detectSkillDirs(env = process.env) {
  return KNOWN_SKILL_DIRS.map((k) => ({ ...k, abs: expandPath(k.path, env) })).filter((k) => fs.existsSync(k.abs));
}
export function resolveSources({ cwd = process.cwd(), agent = null, config = null, env = process.env, identity = null } = {}) {
  const out = [];
  if (agent) out.push({ id: 'agent', kind: 'agent', path: path.join(cwd, 'agents', agent, 'skills'), trust: 'trusted', layout: 'dir' });
  out.push({ id: 'repo', kind: 'repo', path: path.join(cwd, 'skills'), trust: 'trusted', layout: 'dir' });
  if (identity && identity.skills_external === false) return out;
  const sk = ((config || loadScrollConfig(cwd)) || {}).skills || {};
  const fromEnv = String(env.SCROLL_SKILLS_DIRS || '').split(path.delimiter).filter(Boolean);
  [...arr(sk.external_dirs), ...fromEnv].forEach((e, i) => {
    const o = typeof e === 'string' ? { path: e } : (e || {});
    if (!o.path) return;
    out.push({
      id: o.id || `external-${i + 1}`, kind: 'external', path: expandPath(o.path, env), display: String(o.path),
      trust: TRUST_LEVELS.includes(o.trust) ? o.trust : 'community', layout: o.layout || 'dir',
      maxDepth: Number(o.max_depth) || LIMITS.maxDepth,
    });
  });
  return out;
}

// ── loading one skill (cached by file state) ──────────────────────────────────────────────────
// Cached by file state (SKILL.md + every file in the folder), shared across registries. A record
// handed out is a copy: per-registry fields (state, compat, requirements) never leak back.
const CACHE = new Map();
const filesSig = (files) => files.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}`).join(',');
function loadSkillAt(dir, src) {
  const file = path.join(dir, 'SKILL.md');
  let st; try { st = fs.statSync(file); } catch { return null; }
  let realDir; try { realDir = fs.realpathSync(dir); } catch { return null; }
  const files = skillFiles(dir);
  const fsig = filesSig(files);
  const sig = `${src.trust}|${src.kind}|${st.size}|${st.mtimeMs}|${fsig}`;
  const key = `${realDir}|${dir}`;
  let entry = CACHE.get(key);
  if (!entry || entry.sig !== sig) {
    const base = { dir, realDir, file, bytes: st.size, mtimeMs: st.mtimeMs, filesSig: fsig };
    let rec;
    if (st.size > LIMITS.skillMdBytes) {
      rec = { ...base, name: null, description: '', frontmatter: null, hash: null, errors: [`SKILL.md is larger than ${LIMITS.skillMdBytes} bytes`], warnings: [], security: { verdict: 'clean', blocking: [], findings: [] } };
    } else {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = parseSkillMd(raw);
      const fm = parsed.frontmatter || {};
      rec = { ...base, name: typeof fm.name === 'string' ? fm.name.trim() : null, description: oneLine(fm.description), frontmatter: parsed.frontmatter, parseError: parsed.error, hash: sha(raw) };
      const v = validateSkill({ ...rec, body: parsed.body }, { strict: src.kind !== 'external' });
      rec.errors = v.errors; rec.warnings = v.warnings;
    }
    entry = { sig, rec, reqs: new Map(), files, trust: src.trust, security: rec.security || null };
    CACHE.set(key, entry);
  }
  return { ...entry.rec, source: src.id, sourceKind: src.kind, trust: src.trust, _entry: entry };
}
// The security scan reads every file of a skill, so it runs only for a skill that won its name
// (shadowed copies are never served) and is cached with the file state.
function securityOf(r) {
  if (r.security) return r.security;
  const e = r._entry;
  if (e && !e.security) e.security = scanSkillDir(r.dir, e.trust, e.files);
  r.security = e ? e.security : scanSkillDir(r.dir, r.trust);
  return r.security;
}
// requirements depend on the registry's alias table and the operator's overrides: cached per key
function requirementsOf(r, aliases, aliasKey, extra) {
  const k = `${aliasKey}|${JSON.stringify(extra || [])}`;
  const e = r._entry;
  if (e && e.reqs.has(k)) return e.reqs.get(k);
  let body = ''; try { body = parseSkillMd(fs.readFileSync(r.file, 'utf8')).body; } catch { /* gone */ }
  const reqs = skillRequirements(r.frontmatter || {}, body, { aliases, extra });
  if (e) e.reqs.set(k, reqs);
  return reqs;
}
const PLATFORM = { darwin: 'macos', linux: 'linux', win32: 'windows' };
export function normalizePlatformName(p) {
  const s = String(p || '').trim().toLowerCase();
  if (!s) return '';
  if (PLATFORM[s]) return PLATFORM[s];
  if (/^(mac|macos|darwin|osx)$/.test(s)) return 'macos';
  if (/^(win|windows|win32)$/.test(s)) return 'windows';
  return s;
}
function platformsOf(fm) {
  const raw = arr(meta(fm, 'scroll').platforms).concat(arr(fm && fm.platforms), arr(meta(fm, 'hermes').platforms));
  return raw.map(normalizePlatformName).filter(Boolean);
}

// ── the registry ──────────────────────────────────────────────────────────────────────────────
const INDEX_HEADER = 'Skills are tested instructions for specific jobs. When a request matches one, call skill_view with its name and follow it before acting. skill_list finds skills that are not listed here.';
export function openSkills(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const hostPlatform = normalizePlatformName(opts.platform || process.platform) || String(opts.platform || process.platform);
  const buildPlatformSet = (extras = []) => {
    const set = new Set([hostPlatform]);
    for (const p of arr(extras)) {
      const norm = normalizePlatformName(p);
      if (norm) set.add(norm);
    }
    return set;
  };
  let activePlatforms = buildPlatformSet(opts.extraPlatforms || opts.companionPlatforms || []);
  let config = opts.config || null;
  if (!config) { try { config = loadScrollConfig(cwd); } catch (e) { config = {}; emit('skills_config_error', { error: e.message }); } }
  const skCfg = (config && config.skills) || {};
  const aliases = { ...TOOL_ALIASES, ...(skCfg.tool_aliases || {}), ...(opts.toolAliases || {}) };
  const aliasKey = sha(JSON.stringify(aliases));
  const av = normalizeAvailable(opts.available);
  const toolFor = typeof opts.toolFor === 'function' ? opts.toolFor : () => null;
  const names = { list: 'skill_list', view: 'skill_view', ...(opts.toolNames || {}) };
  const limits = { ...LIMITS, indexSkills: Number(skCfg.max_index) || LIMITS.indexSkills, indexTokens: Number(skCfg.max_index_tokens) || LIMITS.indexTokens, ...(opts.limits || {}) };
  const compatPath = opts.compatFile === false ? null : (opts.compatFile || (opts.agent ? path.join(cwd, 'agents', opts.agent, 'skills-compat.json') : path.join(cwd, 'skills-compat.json')));
  const overrides = (() => { if (!compatPath) return {}; try { return JSON.parse(fs.readFileSync(compatPath, 'utf8')).overrides || {}; } catch { return {}; } })();
  const sources = opts.sources || resolveSources({ cwd, agent: opts.agent, config, env: opts.env || process.env, identity: opts.identity });
  const pinned = arr(opts.pinned);
  const usage = opts.usage || {};
  const labels = { header: INDEX_HEADER, ...(opts.labels || {}) };

  function gate(s) {
    const fm = s.frontmatter || {};
    const ov = overrides[s.name] || {};
    const sec = securityOf(s);
    if (sec.verdict === 'block') return { state: 'blocked', reason: sec.blocking.map((f) => `${f.rule} (${f.file}:${f.line})`).join(', ') };
    if (fm['disable-model-invocation'] === true) return { state: 'hidden', reason: 'user-invoked only (disable-model-invocation)' };
    const plats = platformsOf(fm);
    if (plats.length && !plats.some((p) => activePlatforms.has(p))) {
      return { state: 'hidden', reason: `not for ${[...activePlatforms].join('+')} (platforms: ${plats.join(', ')})` };
    }
    if (ov.status === 'hidden') return { state: 'hidden', reason: `override: ${ov.reason || 'hidden by operator'}` };
    const fb = [...splitList(meta(fm, 'scroll').fallback_for), ...splitList(meta(fm, 'hermes').fallback_for_tools)].map((n) => reqFromName(n, aliases, true, 'fallback')).filter(Boolean);
    if (av && fb.length && fb.some((r) => satisfied(r, av))) return { state: 'hidden', reason: `fallback skill; the primary tool is present (${fb.filter((r) => satisfied(r, av)).map((r) => r.ref).join(', ')})` };
    const c = compatStatus(s.requirements, av);
    s.compat = c.status; s.unmet = c.unmet.map((r) => r.ref);
    if (c.status === 'hidden' && ov.status !== 'ok') {
      const list = (rs) => rs.slice(0, 6).map((r) => r.ref).join(', ') + (rs.length > 6 ? ', …' : '');
      return { state: 'hidden', reason: c.dominant ? `most tools it names are not available here: ${list(c.unmet)}` : `needs ${list(c.unmet.filter((r) => r.hard))}` };
    }
    if (ov.status === 'ok') s.compat = 'ok';
    return { state: 'visible', reason: '' };
  }

  function scan() {
    const all = []; const winners = new Map(); const shadowed = [];
    for (const src of sources) {
      const layout = LAYOUTS[src.layout || 'dir'];
      if (!layout) { emit('skills_source_error', { source: src.id, error: `unknown layout "${src.layout}"` }); continue; }
      if (!fs.existsSync(src.path)) continue;
      const recs = [];
      for (const dir of layout(src)) {
        const r = loadSkillAt(dir, src);
        if (!r) continue;
        recs.push(r); all.push(r);
      }
      // inside one source the newest copy of a name wins (plugin caches keep old versions)
      const byName = new Map();
      for (const r of recs) {
        if (r.errors.length || !r.name) continue;
        const cur = byName.get(r.name);
        if (!cur || r.mtimeMs > cur.mtimeMs || (r.mtimeMs === cur.mtimeMs && r.dir < cur.dir)) { if (cur) shadowed.push({ ...cur, by: `newer copy in ${src.id}` }); byName.set(r.name, r); }
        else shadowed.push({ ...r, by: `newer copy in ${src.id}` });
      }
      // across sources the first source wins: agent → repo → external, in config order
      for (const [n, r] of byName) {
        if (winners.has(n)) shadowed.push({ ...r, by: winners.get(n).source });
        else winners.set(n, r);
      }
    }
    const visible = new Map(); const gated = [];
    for (const [n, r] of winners) {
      r.requirements = requirementsOf(r, aliases, aliasKey, overrides[n] ? overrides[n].requires : undefined);
      const g = gate(r); r.state = g.state; r.reason = g.reason;
      if (g.state === 'visible') visible.set(n, r); else gated.push(r);
    }
    const invalid = all.filter((r) => r.errors.length || !r.name);
    return { all, visible, gated, shadowed, invalid };
  }

  let state = scan();
  let frozen = null;
  emit('skills_loaded', { sources: sources.filter((s) => fs.existsSync(s.path)).map((s) => s.id), visible: state.visible.size, hidden: state.gated.filter((r) => r.state === 'hidden').length, blocked: state.gated.filter((r) => r.state === 'blocked').length, invalid: state.invalid.length, shadowed: state.shadowed.length });

  const sortedVisible = () => [...state.visible.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const srcRank = (id) => { const i = sources.findIndex((s) => s.id === id); return i < 0 ? 99 : i; };

  // §34.3 / §34.6 — index: a deterministic function of (visible set, pinned, usage, limits).
  function buildIndex() {
    const rank = [...state.visible.values()].sort((a, b) => {
      const pa = pinned.indexOf(a.name), pb = pinned.indexOf(b.name);
      if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
      if (pa >= 0 && pb >= 0 && pa !== pb) return pa - pb;
      const ua = Number(usage[a.name]) || 0, ub = Number(usage[b.name]) || 0;
      if (ua !== ub) return ub - ua;
      const sa = srcRank(a.source), sb = srcRank(b.source);
      if (sa !== sb) return sa - sb;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    const clean = (s) => oneLine(s).replace(/[<>]/g, '');
    const shorten = (d, n) => { if (d.length <= n) return d; const cut = d.slice(0, n); const dot = cut.lastIndexOf('. '); return (dot > n * 0.5 ? cut.slice(0, dot + 1) : cut.replace(/\s+\S*$/, '')) + (dot > n * 0.5 ? '' : '…'); };
    const render = (list, n) => {
      const lines = [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((s) => `- ${s.name}: ${shorten(clean(s.description), n)}`);
      return ['<available_skills>', labels.header, ...lines, '</available_skills>'].join('\n');
    };
    let take = rank.slice(0, limits.indexSkills);
    let text = '';
    for (const n of [LIMITS.description, 240, 160, 100]) { text = render(take, n); if (approxTokens(text) <= limits.indexTokens) break; }
    while (take.length && approxTokens(text) > limits.indexTokens) { take = take.slice(0, -1); text = render(take, 100); }
    const included = take.map((s) => s.name).sort();
    const omitted = rank.map((s) => s.name).filter((n) => !included.includes(n)).sort();
    return { text: take.length ? text : '', hash: sha(text), included, omitted, tokens: take.length ? approxTokens(text) : 0 };
  }
  function index({ rebuild = false } = {}) {
    if (!frozen || rebuild) { frozen = buildIndex(); emit('skills_indexed', { count: frozen.included.length, omitted: frozen.omitted.length, tokens: frozen.tokens, hash: frozen.hash }); }
    return frozen;
  }

  function list(query = '', { limit = 20, offset = 0 } = {}) {
    const vis = sortedVisible();
    const lim = Math.max(1, Math.min(50, Number(limit) || 20)); const off = Math.max(0, Number(offset) || 0);
    let hits = vis;
    if (String(query || '').trim()) {
      const q = [...new Set(tokens(query))];
      const scored = vis.map((s) => {
        const nt = tokens(s.name.replace(/-/g, ' ')), dt = new Set(tokens(s.description));
        let sc = 0;
        for (const w of q) { if (nt.includes(w)) sc += 5; else if (nt.some((x) => x.startsWith(w) && w.length >= 3)) sc += 3; if (dt.has(w)) sc += 1; }
        if (s.name === String(query).trim()) sc += 10;
        return { s, sc };
      }).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc || (a.s.name < b.s.name ? -1 : 1));
      hits = scored.map((x) => x.s);
    }
    const page = hits.slice(off, off + lim);
    return { total: hits.length, offset: off, skills: page.map((s) => ({ name: s.name, description: s.description.length > 300 ? s.description.slice(0, 299) + '…' : s.description, source: s.source, compat: s.compat || 'unknown' })) };
  }

  // re-check a skill against the disk before serving it: changed → reload + re-scan + re-gate
  function fresh(name) {
    const s = state.visible.get(name);
    if (!s) return null;
    let raw; try { raw = fs.readFileSync(s.file, 'utf8'); } catch { return { denied: 'the skill file is gone' }; }
    if (sha(raw) === s.hash && filesSig(skillFiles(s.dir)) === s.filesSig) return { s, raw };
    const src = sources.find((x) => x.id === s.source);
    const r = loadSkillAt(s.dir, src);
    if (!r || r.errors.length || r.name !== name) { state.visible.delete(name); return { denied: 'the skill changed on disk and is no longer valid' }; }
    r.requirements = requirementsOf(r, aliases, aliasKey, (overrides[name] || {}).requires);
    const g = gate(r);
    emit('skill_rechecked', { name, state: g.state });
    r.state = g.state; r.reason = g.reason;
    if (g.state !== 'visible') { state.visible.delete(name); state.gated.push(r); return { denied: `the skill changed on disk and is now ${g.state}: ${g.reason}` }; }
    state.visible.set(name, r);
    return { s: r, raw: fs.readFileSync(r.file, 'utf8') };
  }
  function whyNot(name) {
    const g = state.gated.find((r) => r.name === name);
    if (g) return `skill "${name}" is ${g.state}: ${g.reason}`;
    if (state.invalid.some((r) => r.name === name)) return `skill "${name}" is invalid`;
    return `no skill named "${name}"`;
  }
  function toolMap(s) {
    const lines = [];
    for (const r of s.requirements || []) {
      if (r.cap && SOFT_CAPS.has(r.cap)) continue;
      const ok = satisfied(r, av);
      const local = r.cap ? toolFor(r.cap, r) : null;
      const over = (overrides[s.name] && overrides[s.name].map && overrides[s.name].map[r.ref]) || null;
      if (over) lines.push(`${r.ref} → ${over}`);
      else if (av && !ok) lines.push(`${r.ref} → not available here`);
      else if (local && local !== r.ref) lines.push(`${r.ref} → ${local}`);
    }
    return lines;
  }
  function view(name, rel = null) {
    const nm = String(name || '').trim();
    const f = fresh(nm);
    if (!f) { emit('skill_denied', { name: nm, reason: whyNot(nm) }); return { ok: false, error: whyNot(nm) }; }
    if (f.denied) { emit('skill_denied', { name: nm, reason: f.denied }); return { ok: false, error: f.denied }; }
    const s = f.s;
    if (!rel) {
      const body = parseSkillMd(f.raw).body;
      const files = skillFiles(s.dir, 100).map((x) => x.rel).filter((x) => x !== 'SKILL.md');
      const map = toolMap(s);
      const head = [`# Skill: ${s.name}`];
      if (map.length) head.push(`Tool names in this skill, as they are here: ${map.join('; ')}.`);
      if (files.length) head.push(`Files in this skill (read one with ${names.view} and path): ${files.slice(0, 60).join(', ')}${files.length > 60 ? ', …' : ''}`);
      const text = `${head.join('\n')}\n\n${body.length > limits.bodyChars ? body.slice(0, limits.bodyChars) + '\n…[truncated]' : body}`;
      usage[s.name] = (Number(usage[s.name]) || 0) + 1;
      emit('skill_viewed', { name: s.name, source: s.source, hash: s.hash, bytes: Buffer.byteLength(text) });
      return { ok: true, name: s.name, text, hash: s.hash, source: s.source };
    }
    const r = String(rel);
    const deny = (why) => { emit('skill_denied', { name: s.name, path: r.slice(0, 200), reason: why }); return { ok: false, error: why }; };
    if (path.isAbsolute(r) || /^[A-Za-z]:/.test(r) || r.split(/[\\/]/).includes('..')) return deny('path must be relative to the skill folder, without ".."');
    let real; try { real = fs.realpathSync(path.join(s.dir, r)); } catch { return deny(`no file "${r}" in skill "${s.name}"`); }
    if (real !== s.realDir && !real.startsWith(s.realDir + path.sep)) return deny('path leads outside the skill folder');
    let st; try { st = fs.statSync(real); } catch { return deny(`no file "${r}"`); }
    if (!st.isFile()) return deny(`"${r}" is not a file`);
    if (st.size > limits.viewBytes) return deny(`"${r}" is larger than ${limits.viewBytes} bytes`);
    const buf = fs.readFileSync(real);
    if (buf.subarray(0, 8192).includes(0)) return deny(`"${r}" is a binary file`);
    const text = buf.toString('utf8');
    const v = verdictFor(scanText(text, r), s.trust);
    if (v.verdict === 'block') return deny(`"${r}" failed the security scan: ${v.blocking.map((x) => x.rule).join(', ')}`);
    emit('skill_viewed', { name: s.name, path: r, source: s.source, hash: s.hash, fileHash: sha(buf), bytes: buf.length });
    return { ok: true, name: s.name, path: r, text };
  }

  function tools() {
    return [
      { name: names.list, description: 'Find skills by keyword. Returns the name and a short description of each match; with no query, lists every skill.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'words to search for' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
        run: (a = {}) => list(a.query || '', { limit: a.limit, offset: a.offset }) },
      { name: names.view, description: "Read a skill's instructions (SKILL.md). Pass path to read one file inside the skill folder, such as references/guide.md.",
        parameters: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name'], additionalProperties: false },
        run: (a = {}) => view(a.name, a.path || null) },
    ];
  }

  // §34.3 — mid-session changes: rescan, report the difference, keep the frozen index (prompt cache)
  function refresh({ rebuild = false } = {}) {
    const before = new Map([...state.visible].map(([n, s]) => [n, s.hash]));
    state = scan();
    const after = new Map([...state.visible].map(([n, s]) => [n, s.hash]));
    const added = [...after.keys()].filter((n) => !before.has(n)).sort();
    const removed = [...before.keys()].filter((n) => !after.has(n)).sort();
    const changed = [...after.keys()].filter((n) => before.has(n) && before.get(n) !== after.get(n)).sort();
    if (rebuild) index({ rebuild: true });
    const parts = [];
    if (added.length) parts.push(`added ${added.join(', ')}`);
    if (removed.length) parts.push(`removed ${removed.join(', ')}`);
    if (changed.length) parts.push(`updated ${changed.join(', ')}`);
    const notice = parts.length ? `Skills changed since this session started: ${parts.join('; ')}. Use ${names.list} to see them.` : '';
    if (notice) emit('skills_changed', { added, removed, changed });
    return { added, removed, changed, notice };
  }

  function report() {
    const row = (r) => ({ name: r.name, source: r.source, kind: r.sourceKind, trust: r.trust, state: r.state || (r.errors && r.errors.length ? 'invalid' : 'shadowed'), reason: r.reason || '', compat: r.compat || null, unmet: r.unmet || [], hash: r.hash, dir: r.dir, errors: r.errors || [], warnings: r.warnings || [], security: r.security ? { verdict: r.security.verdict, findings: r.security.findings.map((f) => ({ rule: f.rule, severity: f.severity, file: f.file, line: f.line })) } : { verdict: 'unscanned', findings: [] }, requires: (r.requirements || []).map((q) => ({ ref: q.ref, cap: q.cap, hard: q.hard, via: q.via })) });
    return {
      sources: sources.map((s) => ({ id: s.id, kind: s.kind, path: s.display || s.path, trust: s.trust, layout: s.layout || 'dir', exists: fs.existsSync(s.path) })),
      visible: sortedVisible().map(row),
      gated: state.gated.map(row).sort((a, b) => (a.name < b.name ? -1 : 1)),
      invalid: state.invalid.map((r) => ({ ...row(r), state: 'invalid', name: r.name || path.basename(r.dir) })),
      shadowed: state.shadowed.map((r) => ({ name: r.name, source: r.source, by: r.by, dir: r.dir })),
    };
  }

  function setExtraPlatforms(extras = [], { rebuild = false } = {}) {
    const next = buildPlatformSet(extras);
    const same = next.size === activePlatforms.size && [...next].every((p) => activePlatforms.has(p));
    if (same) return { platformChanged: false, platforms: [...activePlatforms], added: [], removed: [], changed: [], notice: '' };
    activePlatforms = next;
    const diff = refresh({ rebuild });
    return { platformChanged: true, platforms: [...activePlatforms], ...diff };
  }

  return {
    sources, index, list, view, tools, refresh, report, setExtraPlatforms,
    platforms: () => [...activePlatforms],
    get: (name) => state.visible.get(name) || null,
    names: () => sortedVisible().map((s) => s.name),
    usage: () => ({ ...usage }),
  };
}

// ── §36.1 check (what `scroll check` adds) ────────────────────────────────────────────────────
// Skills this repo ships must be valid and clean; another tool's skills only inform.
export function checkSkills(cwd = process.cwd(), agent = null, opts = {}) {
  const reg = openSkills({ cwd, agent, compatFile: false, ...opts });
  const rep = reg.report();
  const errors = [], warnings = [];
  const own = (r) => r.kind === 'agent' || r.kind === 'repo';
  for (const r of rep.invalid) (own(r) ? errors : warnings).push(...r.errors.map((e) => `skill ${r.name} (${r.source}): ${e}`));
  for (const r of [...rep.visible, ...rep.gated]) {
    if (own(r)) {
      warnings.push(...r.warnings.map((w) => `skill ${r.name}: ${w}`));
      if (r.state === 'blocked') errors.push(`skill ${r.name}: blocked by the security scan — ${r.reason}`);
      else for (const f of r.security.findings.filter((x) => x.severity !== 'low')) warnings.push(`skill ${r.name}: ${f.rule} (${f.severity}) at ${f.file}:${f.line}`);
    }
  }
  for (const r of rep.visible.filter(own)) {
    const n = countEvalCases(r.dir);
    if (n < 3) warnings.push(`skill ${r.name}: ${n} eval case(s) in evals/ — add at least 3 and run \`scroll skill eval ${r.name}\` (§36.3)`);
  }
  const ext = [...rep.visible, ...rep.gated].filter((r) => !own(r));
  const extBlocked = ext.filter((r) => r.state === 'blocked');
  if (extBlocked.length) warnings.push(`${extBlocked.length} external skill(s) blocked by the security scan and kept out: ${extBlocked.slice(0, 5).map((r) => r.name).join(', ')}${extBlocked.length > 5 ? ', …' : ''}`);
  const extInvalid = rep.invalid.filter((r) => !own(r));
  if (extInvalid.length) warnings.push(`${extInvalid.length} external skill(s) invalid and kept out: ${extInvalid.slice(0, 5).map((r) => r.name).join(', ')}${extInvalid.length > 5 ? ', …' : ''}`);
  return { errors, warnings, report: rep, counts: { visible: rep.visible.length, hidden: rep.gated.filter((r) => r.state === 'hidden').length, blocked: rep.gated.filter((r) => r.state === 'blocked').length, invalid: rep.invalid.length, shadowed: rep.shadowed.length } };
}

function countEvalCases(dir) {
  const ev = path.join(dir, 'evals');
  if (!fs.existsSync(ev)) return 0;
  let n = fs.readdirSync(ev).filter((f) => f.endsWith('.md') && f !== 'rubric.md').length;
  try { n += arr(JSON.parse(fs.readFileSync(path.join(ev, 'evals.json'), 'utf8')).evals).length; } catch { /* none */ }
  return n;
}

// ── §35.2 the compatibility sidecar (`scroll skill scan`) ────────────────────────────────────
// Machine-written status per skill; a human's `overrides` survive every rescan.
export function writeCompatFile(file, registry, { runtime = null } = {}) {
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  const rep = registry.report();
  const skills = {};
  for (const r of [...rep.visible, ...rep.gated]) {
    skills[r.name] = { source: r.source, trust: r.trust, hash: r.hash, state: r.state, compat: r.compat, reason: r.reason || undefined, unmet: r.unmet.length ? r.unmet : undefined, requires: r.requires.length ? r.requires.map((q) => q.ref) : undefined, security: r.security.verdict };
  }
  const out = { generatedBy: '@agentpro/scroll skill scan', runtime, skills, overrides: prev.overrides || {} };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return out;
}

// Parse TOOLS.md tool_bindings (§5.2) → toolFor(capability) for one runtime.
export function bindingsToolFor(toolsMd, runtime) {
  if (!toolsMd || !runtime) return () => null;
  const blocks = [...String(toolsMd).matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1]);
  const map = {};
  for (const b of blocks.length ? blocks : [String(toolsMd)]) {
    let y; try { y = parseYaml(b); } catch { continue; }
    if (!y || typeof y !== 'object') continue;
    for (const [cap, v] of Object.entries(y)) if (CAP_SHAPE.test(cap) && v && typeof v === 'object' && typeof v[runtime] === 'string') map[cap] = v[runtime];
  }
  return (cap) => map[cap] || null;
}
