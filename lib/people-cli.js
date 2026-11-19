// SCROLL — `scroll people …`: person cards from the shell (spec v1.9 §38–§41).
// Every command goes through lib/people.js, so a human at the shell meets the same rules as the
// runner: an agent's change to a card waits in the review queue, an approval names who approved,
// and the runner — not this CLI — decides whether that person may approve.
import fs from 'node:fs';
import path from 'node:path';
import { openTeam, cardTemplate, SLUG_RE } from './people.js';
import { loadAgent } from './scroll.js';

const USAGE = `usage: scroll people <command> [--people <dir>] [--json]
  check                                       validate every card + the deployment's role table
  new <slug> [--name "Full Name"]             write a starter card into the people dir
  list                                        slug · name · effective roles · what each may approve
  show <slug> [--agent <a>]                   the block an agent loads for this person (§39)
  propose <slug> --field <f> --value <v> --by <agent> [--reason r]
                                              an agent's change waits for review (f: address.call_them,
                                              address.self, language, timezone, note)
  review [<slug>] [--accept <id> | --reject <id>] --by <slug>
                                              decided by the person on the card or an admin role
  approve <gate-id> --run <run-dir> --by <slug> [--note n]
                                              write an attributed approval (the runner checks authority)
  done <task-id> --run <run-dir> --by <slug> [--note n]
                                              mark a person's WORK.md step done (§40)
  forget <slug> --approve [--store <dir> --region r]
                                              remove the card, its review items, and the subject (§41)`;

const out = (o) => o;
export async function peopleCli(a, env = process.env, cwd = process.cwd()) {
  const [cmd, ...args] = a._;
  if (!cmd || cmd === 'help') return USAGE;
  const team = openTeam({ cwd, dir: typeof a.people === 'string' ? a.people : null, env });
  const by = typeof a.by === 'string' ? a.by : null;
  const agents = () => {
    const base = path.join(cwd, 'agents');
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).filter((n) => fs.existsSync(path.join(base, n, 'IDENTITY.md'))).sort()
      .map((name) => { try { return { name, identity: loadAgent(name, cwd).frontmatter || {} }; } catch { return { name, identity: {} }; } });
  };
  switch (cmd) {
    case 'check': return { ok: true, ...team.check({ agents: agents() }), dir: path.relative(cwd, team.dir) || team.dir };
    case 'new': {
      const slug = args[0];
      if (!SLUG_RE.test(slug || '')) throw new Error('usage: scroll people new <slug> — slug must match ^[a-z][a-z0-9-]*$');
      const f = path.join(team.dir, `${slug}.md`);
      if (fs.existsSync(f)) throw new Error(`${path.relative(cwd, f)} already exists`);
      fs.mkdirSync(team.dir, { recursive: true });
      fs.writeFileSync(f, cardTemplate(slug, typeof a.name === 'string' ? a.name : 'CHANGE ME'));
      return { ok: true, card: path.relative(cwd, f) || f };
    }
    case 'list': return { ok: true, people: team.slugs().map((s) => { const c = team.get(s); return { slug: s, name: c.frontmatter && c.frontmatter.name, valid: c.valid, roles: team.rolesOf(s), authority: team.authorityOf(s) }; }) };
    case 'show': {
      const slug = args[0]; const c = team.get(slug);
      if (!c) throw new Error(`no card for "${slug}" in ${team.dir}`);
      if (!c.valid) return { ok: false, errors: c.errors };
      const ag = typeof a.agent === 'string' ? a.agent : null;
      let identity = {}; if (ag) { try { identity = loadAgent(ag, cwd).frontmatter || {}; } catch { /* no agent */ } }
      const r = team.render({ agent: ag, identity, served: slug });
      return a.json ? { ok: true, ...r } : r.text;
    }
    case 'propose': return team.propose(args[0], { field: a.field, value: a.value, by, reason: typeof a.reason === 'string' ? a.reason : null });
    case 'review': {
      if (typeof a.accept === 'string') return team.resolveReview(a.accept, 'accept', { by });
      if (typeof a.reject === 'string') return team.resolveReview(a.reject, 'reject', { by });
      return { ok: true, items: team.listReview(args[0] || null) };
    }
    case 'approve': case 'done': {
      const id = args[0]; const run = typeof a.run === 'string' ? path.resolve(cwd, a.run) : null;
      if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || !run) throw new Error(`usage: scroll people ${cmd} <id> --run <run-dir> --by <slug>`);
      if (!SLUG_RE.test(by || '')) throw new Error('--by <slug> is required: an approval or a done mark names its person');
      const dir = path.join(run, 'control', cmd === 'approve' ? 'approvals' : 'done');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `${id}.json`);
      const body = { by, ts: new Date().toISOString(), ...(typeof a.note === 'string' ? { note: a.note } : {}) };
      fs.writeFileSync(f, JSON.stringify(body, null, 1) + '\n');
      const note = cmd === 'approve' && !team.get(by) ? 'no card for this person: the runner will reject it' : undefined;
      return out({ ok: true, file: path.relative(cwd, f) || f, note });
    }
    case 'forget': return team.forget(args[0], { approved: !!a.approve, store: typeof a.store === 'string' ? a.store : null, region: typeof a.region === 'string' ? a.region : 'local' });
    default: throw new Error(`unknown people command "${cmd}"\n${USAGE}`);
  }
}
