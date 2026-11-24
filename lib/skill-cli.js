// SCROLL — `scroll skill <list|view|index|scan|check|eval|sources>` (v1.8). `add` stays in installers.js.
import fs from 'node:fs';
import path from 'node:path';
import { loadAgent } from './scroll.js';
import { openSkills, checkSkills, writeCompatFile, detectSkillDirs, bindingsToolFor } from './skills.js';

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
export const SKILL_HELP = `usage:
  scroll skill add <folder> [--agent a] [--force]   install a skill folder into skills/ (scanned first)
  scroll skill add --new <name> [--agent a]         scaffold a skill
  scroll skill list [--agent a] [--all] [--json]    skills the agent can use (--all: hidden, blocked, invalid too)
  scroll skill view <name> [path] [--agent a]       what skill_view returns for this skill or one of its files
  scroll skill index [--agent a]                    the <available_skills> block for the cached prefix
  scroll skill scan [--agent a] [--runtime r]       write skills-compat.json (status per skill; your overrides are kept)
  scroll skill check [--agent a]                    validate skills; errors for skills this repo ships
  scroll skill eval <name> [--agent a] [--provider p1,p2] [--n N] [--judge]   with vs without the skill
  scroll skill sources [--detect]                   configured sources; --detect lists other tools' skill folders found here`;

// what the agent can do, from IDENTITY.capabilities + configured .mcp.json servers (+ TOOLS.md bindings for a runtime)
function agentContext(cwd, agentName, runtime) {
  if (!agentName) return {};
  const ag = loadAgent(agentName, cwd);
  const fm = ag.frontmatter || {};
  const mcpServers = [];
  for (const p of [path.join(cwd, '.mcp.json'), path.join(cwd, 'agents', agentName, '.mcp.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const name of Object.keys(j?.mcpServers || {})) mcpServers.push(name);
    } catch { /* optional */ }
  }
  return {
    agent: agentName, identity: fm, pinned: fm.skills,
    available: { capabilities: Array.isArray(fm.capabilities) ? fm.capabilities : [], mcpServers },
    toolFor: bindingsToolFor(ag.tools, runtime),
  };
}

export async function skillCli(sub, a, cwd = process.cwd()) {
  const agent = typeof a.agent === 'string' ? a.agent : null;
  const runtime = typeof a.runtime === 'string' ? a.runtime : null;
  const ctx = () => agentContext(cwd, agent, runtime);
  switch (sub) {
    case 'list': {
      const reg = openSkills({ cwd, ...ctx() });
      const rep = reg.report();
      const rows = a.all ? [...rep.visible, ...rep.gated, ...rep.invalid] : rep.visible;
      if (a.json) { console.log(JSON.stringify(a.all ? rep : rep.visible, null, 2)); return; }
      if (!rows.length) { console.log(c.dim('no skills found (sources: agents/<a>/skills, skills/, skills.external_dirs in scroll.config.yaml)')); return; }
      for (const r of rows) {
        const st = r.state === 'visible' ? (r.compat === 'partial' ? c.yellow('partial') : c.green('ok')) : r.state === 'blocked' ? c.red('blocked') : r.state === 'invalid' ? c.red('invalid') : c.yellow(r.state);
        console.log(`${st.padEnd(18)} ${c.bold(r.name || '?')} ${c.dim(`[${r.source}]`)}${r.reason ? c.dim(' — ' + r.reason) : ''}${r.state === 'invalid' ? c.dim(' — ' + r.errors.join('; ')) : ''}`);
      }
      console.log(c.dim(`\n${rep.visible.length} usable · ${rep.gated.filter((r) => r.state === 'hidden').length} hidden · ${rep.gated.filter((r) => r.state === 'blocked').length} blocked · ${rep.invalid.length} invalid · ${rep.shadowed.length} shadowed`));
      return;
    }
    case 'view': {
      const name = a._[1]; if (!name) throw new Error('usage: scroll skill view <name> [path]');
      const reg = openSkills({ cwd, ...ctx() });
      const v = reg.view(name, a._[2] || null);
      if (!v.ok) { console.log(`${c.red('✖')} ${v.error}`); process.exitCode = 1; return; }
      console.log(v.text);
      return;
    }
    case 'index': {
      const reg = openSkills({ cwd, ...ctx() });
      const ix = reg.index();
      if (a.json) { console.log(JSON.stringify(ix, null, 2)); return; }
      console.log(ix.text || c.dim('(empty: no usable skills)'));
      console.log(c.dim(`\n${ix.included.length} skill(s) · ~${ix.tokens} tokens · hash ${ix.hash}${ix.omitted.length ? ` · ${ix.omitted.length} omitted (reachable with skill_list): ${ix.omitted.slice(0, 8).join(', ')}${ix.omitted.length > 8 ? ', …' : ''}` : ''}`));
      return;
    }
    case 'scan': {
      const reg = openSkills({ cwd, ...ctx() });
      const file = typeof a.out === 'string' ? path.resolve(cwd, a.out) : (agent ? path.join(cwd, 'agents', agent, 'skills-compat.json') : path.join(cwd, 'skills-compat.json'));
      const out = writeCompatFile(file, reg, { runtime });
      const vals = Object.values(out.skills);
      console.log(`${c.green('✔')} wrote ${path.relative(cwd, file) || file} — ${vals.filter((v) => v.state === 'visible' && v.compat !== 'partial').length} ok · ${vals.filter((v) => v.compat === 'partial').length} partial · ${vals.filter((v) => v.state === 'hidden').length} hidden · ${vals.filter((v) => v.state === 'blocked').length} blocked`);
      console.log(c.dim('  correct the machine under "overrides": { "<skill>": { "status": "ok|hidden", "map": { "ForeignTool": "local_tool" }, "requires": [] } }'));
      return;
    }
    case 'check': {
      const res = checkSkills(cwd, agent, ctx());
      for (const w of res.warnings) console.log(`${c.yellow('⚠')} ${w}`);
      for (const e of res.errors) console.log(`${c.red('✖')} ${e}`);
      const k = res.counts;
      console.log(`${res.errors.length ? c.red('✖') : c.green('✔')} skills: ${k.visible} usable · ${k.hidden} hidden · ${k.blocked} blocked · ${k.invalid} invalid · ${k.shadowed} shadowed`);
      if (res.errors.length) process.exitCode = 1;
      return;
    }
    case 'eval': {
      const name = a._[1]; if (!name) throw new Error('usage: scroll skill eval <name> [--provider p1,p2] [--n N] [--judge]');
      const { runSkillEval } = await import('./skill-eval.js');
      const providers = typeof a.provider === 'string' ? a.provider.split(',').map((s) => s.trim()).filter(Boolean) : ['auto'];
      const rep = await runSkillEval(name, { cwd, agent, providers, n: a.n ? Number(a.n) : undefined, judge: !!a.judge, model: typeof a.model === 'string' ? a.model : undefined, registry: openSkills({ cwd, compatFile: false, ...ctx() }) });
      if (a.json) { console.log(JSON.stringify(rep, null, 2)); if (!rep.ok) process.exitCode = 1; return; }
      if (rep.error) { console.log(`${c.red('✖')} ${rep.error}`); process.exitCode = 1; return; }
      for (const p of rep.providers) {
        console.log(c.bold(`\n${p.provider} (${p.model})`) + (p.error ? ` ${c.red(p.error)}` : ''));
        for (const r of p.cases) {
          const mark = r.verdict === 'pass' ? c.green('✔') : r.verdict === 'ungraded' ? c.yellow('·') : c.red('✖');
          const cmp = r.compare ? (r.compare.ok ? ` · blind: ${r.compare.winner}` : c.yellow(` · blind: ${r.compare.error}`)) : '';
          console.log(`${mark} ${r.id} — with ${r.with.pass}/${r.runs} · without ${r.without.pass}/${r.runs}${cmp} · tokens ${r.with.tokens} vs ${r.without.tokens}`);
        }
      }
      const verdict = rep.ok ? c.green('PASS') : c.red('FAIL');
      console.log(`\n${verdict} — recommendation: ${c.bold(rep.recommendation)} · record .scroll/skill-eval/${name}.json`);
      if (!rep.ok) process.exitCode = 1;
      return;
    }
    case 'sources': {
      const reg = openSkills({ cwd, ...ctx() });
      for (const s of reg.report().sources) console.log(`${s.exists ? c.green('●') : c.dim('○')} ${c.bold(s.id)} ${s.path} ${c.dim(`(${s.kind}, trust ${s.trust}${s.layout !== 'dir' ? ', layout ' + s.layout : ''})`)}`);
      if (a.detect) {
        const found = detectSkillDirs();
        console.log(c.bold('\nskill folders of other tools on this machine (not read unless listed in scroll.config.yaml):'));
        for (const k of found) console.log(`  ${k.path}${k.layout ? c.dim(' layout ' + k.layout) : ''} ${c.dim('— ' + k.note)}`);
        if (found.length) console.log(c.dim('\n  add one:  skills:\n              external_dirs:\n                - { path: ~/.agents/skills, trust: trusted }'));
      }
      return;
    }
    default:
      console.log(SKILL_HELP);
  }
}
