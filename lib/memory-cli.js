// SCROLL — `scroll memory …`: operate a subject-memory store from the shell (spec v1.7 §31-§33).
// Every command goes through lib/memory.js — the CLI never touches store files directly, so the
// gate, the locks, the read-back, and the access trace apply to humans exactly as to agents.
import { openStore } from './memory.js';

const USAGE = `usage: scroll memory <command> --store <dir> [--region r] [--policy file.json|POLICY.md] [--json]
  new [--kind person|group|agent|project] [--label text]   create a subject → prints its sid
  link <alias> <sid> · unlink <alias> · resolve <alias>      channel identities (telegram:…, email, phone, device:…)
  show <sid|alias>                                          index + active facts (sensitive values masked)
  snapshot <sid|alias> [--caps a,b] [--topics ns,ns] [--persona p]   the frozen load contract
  search <sid|alias> "<query>" [--scope facts|sessions|cards|days|all] [--limit n] [--reader who]
  forget <sid|alias> <factId…>                              tombstone + cascade + redaction
  review <sid|alias> [--accept id | --reject id]           machine writes waiting for a human
  member <group> <person> [--read ns,ns] [--write ns,ns] [--remove]
  consolidate <sid|alias> · fsck <sid|alias> [--repair] · replay <sid|alias>
  erase <sid|alias> --approve                               destructive: subject + every alias`;

const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

export function memoryCli(a, env = {}) {
  const [cmd, ...args] = a._;
  if (!cmd || cmd === 'help') return USAGE;
  const root = typeof a.store === 'string' ? a.store : env.SCROLL_MEMORY_STORE;
  if (!root) throw new Error('memory store required: --store <dir> or SCROLL_MEMORY_STORE');
  const m = openStore({ root, region: typeof a.region === 'string' ? a.region : (env.SCROLL_MEMORY_REGION || 'local'),
    policy: typeof a.policy === 'string' ? a.policy : (env.SCROLL_MEMORY_POLICY || undefined) });
  const sidOf = (x) => {
    if (!x) throw new Error(USAGE);
    const sid = /^s_[a-z0-9]+_[0-9a-f]{16}$/.test(x) ? x : m.resolve(x);
    if (!sid || !m.exists(sid)) throw new Error(`unknown subject: ${x}`);
    return sid;
  };
  switch (cmd) {
    case 'new': return { ok: true, sid: m.createSubject({ kind: typeof a.kind === 'string' ? a.kind : 'person', label: typeof a.label === 'string' ? a.label : null }) };
    case 'link': return m.link(args[0], sidOf(args[1]));
    case 'unlink': return m.unlink(args[0]);
    case 'resolve': { const sid = m.resolve(args[0]); return sid ? { ok: true, sid } : { ok: false, reason: 'not_found' }; }
    case 'show': {
      const sid = sidOf(args[0]); const st = m.state(sid);
      const facts = st.facts.map((f) => `- ${f.id} ${f.key}${f.about !== 'self' ? ` [${f.about}]` : ''}: ${f.sensitivity === 'sensitive' ? '(sensitive)' : f.value}  (${f.provenance}${f.pinned ? ', pinned' : ''})`);
      return a.json ? { ok: true, meta: m.meta(sid), facts: st.facts.map((f) => ({ ...f, value: f.sensitivity === 'sensitive' ? undefined : f.value })), memberships: st.memberships, review: m.listReview(sid).length }
        : [`subject ${m.hmac(sid)} (${m.meta(sid).kind})`, ...facts, `${st.history.length} superseded/expired · ${m.listSessions(sid).length} sessions · ${m.listReview(sid).length} awaiting review`].join('\n');
    }
    case 'snapshot': { const s = m.snapshot(sidOf(args[0]), { capabilities: list(a.caps), topics: a.topics ? list(a.topics) : null, persona: typeof a.persona === 'string' ? a.persona : null }); return a.json ? s : (s.denied ? `denied: ${s.denied}` : s.text); }
    case 'search': {
      const r = m.search(sidOf(args[0]), { query: args.slice(1).join(' '), scope: typeof a.scope === 'string' ? a.scope : 'all', limit: a.limit ? Number(a.limit) : 8, reader: typeof a.reader === 'string' ? a.reader : 'cli' });
      return a.json ? r : (r.hits.map((h) => `${h.ref}  ${h.ts.slice(0, 16)}  ${h.status ? `[${h.status}] ` : ''}${h.sensitive ? '[sensitive] ' : ''}${h.text.replace(/\s+/g, ' ')}`).join('\n') || 'no hits');
    }
    case 'forget': return m.forget(sidOf(args[0]), args.slice(1), { by: 'cli' });
    case 'review': {
      const sid = sidOf(args[0]);
      if (typeof a.accept === 'string') return m.resolveReview(sid, a.accept, 'accept', { by: 'cli' });
      if (typeof a.reject === 'string') return m.resolveReview(sid, a.reject, 'reject', { by: 'cli' });
      return { ok: true, items: m.listReview(sid) };
    }
    case 'member': {
      const g = sidOf(args[0]), p = sidOf(args[1]);
      return a.remove ? m.removeMember(g, p) : m.addMember(g, p, { read: a.read ? list(a.read) : ['*'], write: list(a.write) });
    }
    case 'consolidate': return { ok: true, ...m.consolidate(sidOf(args[0])) };
    case 'fsck': return m.fsck(sidOf(args[0]), { repair: !!a.repair });
    case 'replay': { const sid = sidOf(args[0]); const h1 = m.replayHash(sid); const h2 = m.replayHash(sid); return { ok: h1 === h2, hash: h1 }; }
    case 'erase': return m.erase(sidOf(args[0]), [], { approved: !!a.approve });
    default: throw new Error(`unknown memory command "${cmd}"\n${USAGE}`);
  }
}
