// Installer smoke — `scroll mcp/skill/plugin add` wire capabilities into the files the runtime reads.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mcpAdd, skillAdd, attachSkillToAgent, pluginAdd } from '../lib/installers.js';
import { loadMcpRisk, resolveTier } from '../lib/permissions.js';
import { runWork } from '../lib/runtime.js';

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); console.log('  \x1b[32m✔\x1b[0m', name); pass++; } catch (e) { console.log('  \x1b[31m✖\x1b[0m', name, '—', e.message); fail++; } };
function mkroot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-inst-')); }
function writeAgent(root, name) {
  const dir = path.join(root, 'agents', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), `---\nname: ${name}\ntitle: ${name}\nversion: 1.0.0\nruntimes: [cowork]\nmodel: { primary: mock-1 }\ncapabilities: [fs.read]\n---\n${name} agent.`);
  fs.writeFileSync(path.join(dir, 'SOUL.md'), `${name} cites sources.`);
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const events = (r) => fs.readFileSync(r.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const types = (evs) => new Set(evs.map((e) => e.type));

// ── mcp add ──────────────────────────────────────────────────────────────────
await t('mcp add: writes .mcp.json with a stdio server', () => {
  const root = mkroot();
  const res = mcpAdd('notion', { command: 'npx', args: ['-y', 'notion-mcp'] }, root);
  assert.equal(res.existed, false);
  const j = readJson(path.join(root, '.mcp.json'));
  assert.equal(j.mcpServers.notion.command, 'npx');
  assert.deepEqual(j.mcpServers.notion.args, ['-y', 'notion-mcp']);
});

await t('mcp add: credentials as ${vault:KEY} are surfaced, http transport supported', () => {
  const root = mkroot();
  const res = mcpAdd('gmail', { url: 'https://mcp.example/gmail', transport: 'http', env: { GMAIL_TOKEN: '${vault:gmail}' } }, root);
  assert.deepEqual(res.vaultRefs, ['gmail']);
  const srv = readJson(path.join(root, '.mcp.json')).mcpServers.gmail;
  assert.equal(srv.type, 'http'); assert.equal(srv.url, 'https://mcp.example/gmail');
  assert.equal(srv.env.GMAIL_TOKEN, '${vault:gmail}');
});

await t('mcp add: re-add MERGES (keeps prior fields, reports existed)', () => {
  const root = mkroot();
  mcpAdd('einvoice', { command: 'einvoice-mcp', tools: { lookup: { risk: 'read_only' } } }, root);
  const res2 = mcpAdd('einvoice', { command: 'einvoice-mcp', tools: { issue_invoice: { risk: 'financial', ground: ['code', 'amount'] } } }, root);
  assert.equal(res2.existed, true);
  const tools = readJson(path.join(root, '.mcp.json')).mcpServers.einvoice.tools;
  assert.ok(tools.issue_invoice && tools.issue_invoice.risk === 'financial');
});

await t('mcp add --agent writes an agent-level .mcp.json', () => {
  const root = mkroot(); writeAgent(root, 'biller');
  mcpAdd('einvoice', { command: 'einvoice-mcp', agent: 'biller', tools: { issue_invoice: { risk: 'financial' } } }, root);
  assert.ok(fs.existsSync(path.join(root, 'agents', 'biller', '.mcp.json')));
  assert.ok(!fs.existsSync(path.join(root, '.mcp.json')), 'repo-level not created');
});

await t('mcp add → per-tool risk is read by the runtime and ENFORCED (integration)', async () => {
  const root = mkroot(); writeAgent(root, 'biller');
  mcpAdd('einvoice', { command: 'einvoice-mcp', tools: { issue_invoice: { risk: 'financial', ground: ['code'] } } }, root);
  // resolver sees it
  assert.equal(resolveTier('issue_invoice', { mcpTools: loadMcpRisk(root) }).tier, 'financial');
  // and a runtime task that calls that tool is gated (financial = must-approve), no approval → blocked
  const r = await runWork({ cwd: root, task: 'Issue invoice.', agent: 'biller', tool: 'issue_invoice', autoApprove: false, providerName: 'mock', runDir: path.join(root, 'run') });
  const ty = types(events(r));
  assert.ok(ty.has('permission_decision'), 'permission decision emitted');
  const pd = events(r).find((e) => e.type === 'permission_decision');
  assert.equal(pd.data.tier, 'financial', 'tier came from the .mcp.json that `mcp add` wrote');
  assert.ok(ty.has('gate_blocked') && !ty.has('provider_call_started'), 'unapproved financial tool blocked before action');
});

// ── skill add ────────────────────────────────────────────────────────────────
await t('skill add <folder>: copies a SKILL.md folder into skills/', () => {
  const root = mkroot();
  const src = path.join(root, 'src-skill');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: invoicing\ndescription: how to invoice\ntriggers: [invoice]\n---\nbody');
  const res = skillAdd('src-skill', {}, root);
  assert.equal(res.name, 'invoicing');
  assert.ok(fs.existsSync(path.join(root, 'skills', 'invoicing', 'SKILL.md')));
});

await t('skill add rejects a folder with no SKILL.md / bad frontmatter', () => {
  const root = mkroot();
  fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
  assert.throws(() => skillAdd('empty', {}, root), /no SKILL.md/);
});

await t('skill add --new scaffolds a valid stub', () => {
  const root = mkroot();
  const res = skillAdd('triage', { new: true }, root);
  assert.equal(res.scaffolded, true);
  const md = fs.readFileSync(path.join(root, 'skills', 'triage', 'SKILL.md'), 'utf8');
  assert.ok(/name: triage/.test(md) && /description:/.test(md) && /triggers:/.test(md));
});

await t('skill add --agent attaches to IDENTITY.skills (idempotent)', () => {
  const root = mkroot(); writeAgent(root, 'case');
  skillAdd('triage', { new: true, agent: 'case' }, root);
  let id = fs.readFileSync(path.join(root, 'agents', 'case', 'IDENTITY.md'), 'utf8');
  assert.ok(/skills:\s*\[triage\]/.test(id), 'skill referenced on the agent');
  // attaching again does not duplicate
  attachSkillToAgent(root, 'case', 'triage');
  id = fs.readFileSync(path.join(root, 'agents', 'case', 'IDENTITY.md'), 'utf8');
  assert.equal((id.match(/triage/g) || []).length, 1, 'no duplicate entry');
});

// ── plugin add ───────────────────────────────────────────────────────────────
function makePluginDir(root) {
  const p = path.join(root, 'social-pack');
  fs.mkdirSync(path.join(p, 'agents', 'hunter'), { recursive: true });
  fs.mkdirSync(path.join(p, 'skills', 'posting'), { recursive: true });
  fs.writeFileSync(path.join(p, 'manifest.json'), JSON.stringify({ name: 'social-pack', version: '1.0.0' }));
  fs.writeFileSync(path.join(p, 'agents', 'hunter', 'IDENTITY.md'), '---\nname: hunter\ntitle: Hunter\nversion: 1.0.0\nruntimes: [cowork]\nmodel: { primary: mock-1 }\ncapabilities: [web.search]\n---\nhunter');
  fs.writeFileSync(path.join(p, 'agents', 'hunter', 'SOUL.md'), 'hunts leads');
  fs.writeFileSync(path.join(p, 'skills', 'posting', 'SKILL.md'), '---\nname: posting\ndescription: post to socials\ntriggers: [post]\n---\nbody');
  fs.writeFileSync(path.join(p, '.mcp.json'), JSON.stringify({ mcpServers: { zalo: { command: 'zalo-mcp', tools: { send: { risk: 'external_comm' } } } } }));
  return p;
}

await t('plugin add <dir>: unpacks agents + skills + merges .mcp.json', () => {
  const root = mkroot();
  const res = pluginAdd(makePluginDir(root), {}, root);
  assert.equal(res.name, 'social-pack');
  assert.ok(fs.existsSync(path.join(root, 'agents', 'hunter', 'IDENTITY.md')), 'agent installed');
  assert.ok(fs.existsSync(path.join(root, 'skills', 'posting', 'SKILL.md')), 'skill installed');
  const mcp = readJson(path.join(root, '.mcp.json'));
  assert.equal(mcp.mcpServers.zalo.tools.send.risk, 'external_comm', 'mcp merged with risk');
  assert.deepEqual(res.installed.agents, ['hunter']);
});

await t('plugin add: skips existing items unless --force', () => {
  const root = mkroot();
  const dir = makePluginDir(root);
  pluginAdd(dir, {}, root);
  const again = pluginAdd(dir, {}, root);
  assert.ok(again.installed.agents[0].includes('skipped'), 'existing agent skipped');
  const forced = pluginAdd(dir, { force: true }, root);
  assert.deepEqual(forced.installed.agents, ['hunter'], 'force re-installs');
});

console.log(`\ninstallers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
