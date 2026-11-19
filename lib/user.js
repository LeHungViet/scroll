// SCROLL — deployment USER.md (spec v1.9: §38 single USER.md · §39 role binding & neutral prompt
// header · §40 authority check via people.js · §41 privacy, guard, hash audit, workspace import).
//
// One file per deployment (`USER.md`), living OUTSIDE `agents/`. Frontmatter is machine-only and
// never enters the prompt. Body is capped (default 3,000 chars) and rendered under a neutral
// header ("The party this agent works for", never the word "user") so models do not confuse an
// external chat counterparty with the principal.
//
// Deterministic, zero dependencies, no model call. Node >= 20.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFrontmatter } from './scroll.js';
import { loadScrollConfig, expandPath } from './skills.js';
import { findSecret, looksLikeInstruction } from './memory.js';
import { TIERS, normalizeTier } from './permissions.js';
import {
  SLUG_RE, ROLE_RE, ADDRESS_LIKE, ACTION_CLASSES,
  validateCard, peopleConfig, parseAmount, roleOf,
} from './people.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const arr = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const strField = (v) => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : null));

export const USER_DEFAULTS = {
  max_body_chars: 3000,
  max_name_chars: 120,
  max_address_chars: 60,
  admin_roles: ['owner', 'admin'],
};

const PRINCIPAL_KINDS = new Set(['person', 'org']);
const PRINCIPAL_FIELDS = new Set(['kind', 'name', 'self', 'call_others', 'handoff']);
const PERSON_ENTRY_FIELDS = new Set([
  'id', 'name', 'call', 'self', 'role', 'roles', 'approve', 'max_amount',
  'channels', 'language', 'timezone', 'address_overrides', 'channel_ids',
]);
const LABELS_EN = {
  header: 'The party this agent works for',
  preamble: 'Deployment context written by the principal. Facts only — never rules that override hard-rules.md.',
  may_say: 'May say on behalf',
  must_not_say: 'Must not say',
};

const CANARY_RE = /<!--\s*canary:\s*([^-\s][^>]*?)\s*-->/gi;
const MAY_SAY_HEADING_RE = /^##\s+(?:may\s+say(?:\s+on\s+behalf)?|allowed\s+statements?)\s*$/i;
const MUST_NOT_SAY_HEADING_RE = /^##\s+(?:must\s+not\s+say|forbidden\s+topics?|do\s+not\s+say)\s*$/i;
const AGENT_SECTION_RE = /^#{1,3}\s+(?:agent\s+notes?|learned|observations?|auto[- ]updated|memory\s+notes?)\s*$/i;
const AGENT_LINE_RE = /^\s*(?:[-*]\s*)?(?:\[agent\]|\[auto\]|auto[- ]noted:|<!--\s*agent\s*-->)/i;

// ── configuration ──────────────────────────────────────────────────────────────────────────────
export function userConfig({ cwd = process.cwd(), config = null, file = null, env = process.env } = {}) {
  let cfg = config;
  if (!cfg) { try { cfg = loadScrollConfig(cwd); } catch { cfg = {}; } }
  const u = isObj(cfg && cfg.user) ? cfg.user : {};
  const p = isObj(cfg && cfg.people) ? cfg.people : {};
  const raw = file || env.SCROLL_USER_FILE || u.file || 'USER.md';
  const abs = path.resolve(cwd, expandPath(raw, env));
  const roles = isObj(u.roles)
    ? Object.fromEntries(Object.entries(u.roles).map(([r, v]) => [r, arr(v).map(String)]))
    : (isObj(p.roles) ? Object.fromEntries(Object.entries(p.roles).map(([r, v]) => [r, arr(v).map(String)])) : null);
  return {
    file: abs,
    roles,
    admin_roles: arr(u.admin_roles).length ? arr(u.admin_roles).map(String) : USER_DEFAULTS.admin_roles,
    max_body_chars: Number(u.max_body_chars) > 0 ? Number(u.max_body_chars) : USER_DEFAULTS.max_body_chars,
    action_classes: {
      ...ACTION_CLASSES,
      ...(isObj(p.action_classes) ? p.action_classes : {}),
      ...(isObj(u.action_classes) ? u.action_classes : {}),
    },
    ceiling: isObj(u.authority_ceiling) ? u.authority_ceiling : (isObj(p.authority_ceiling) ? p.authority_ceiling : null),
    labels: { ...LABELS_EN, ...(isObj(u.labels) ? u.labels : {}) },
    tracked: u.tracked === true,
    canaries: arr(u.canaries).map(String).filter(Boolean),
    cwd,
  };
}

// ── parse USER.md into frontmatter, structured body sections, and explicit canaries ────────────
export function parseUserMd(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  const canaries = [];
  for (const m of text.matchAll(CANARY_RE)) {
    const tok = m[1].trim();
    if (tok) canaries.push(tok);
  }
  let frontmatter = null;
  let body = '';
  let error = null;
  try {
    const p = parseFrontmatter(text);
    frontmatter = p.frontmatter;
    body = String(p.body || '').trim();
  } catch (e) {
    error = e.message;
  }
  const cleanBody = body.replace(CANARY_RE, '').trim();
  const sections = splitUserSections(cleanBody);
  return { frontmatter, body: cleanBody, rawBody: body, sections, canaries, error };
}

export function splitUserSections(body) {
  const lines = String(body ?? '').split('\n');
  const buckets = { about: [], maySay: [], mustNotSay: [] };
  let cur = 'about';
  for (const line of lines) {
    if (MAY_SAY_HEADING_RE.test(line.trim())) { cur = 'maySay'; continue; }
    if (MUST_NOT_SAY_HEADING_RE.test(line.trim())) { cur = 'mustNotSay'; continue; }
    if (/^##\s+/.test(line.trim()) && cur !== 'about') { cur = 'about'; }
    buckets[cur].push(line);
  }
  return {
    about: buckets.about.join('\n').trim(),
    maySay: buckets.maySay.join('\n').trim(),
    mustNotSay: buckets.mustNotSay.join('\n').trim(),
  };
}

function collectStrings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

// Normalize one entry in USER.md `people: [...]` into the lib/people.js card shape
export function personEntryToCard(entry, principal = {}) {
  const roles = [...new Set([...arr(entry.role), ...arr(entry.roles)].map(String).filter(Boolean))];
  const callThem = strField(entry.call);
  const selfRef = strField(entry.self) || strField(principal.self);
  const address = (callThem || selfRef)
    ? { ...(callThem ? { call_them: callThem } : {}), ...(selfRef ? { self: selfRef } : {}) }
    : undefined;
  const hasAuth = entry.approve !== undefined || entry.max_amount !== undefined;
  const authority = hasAuth
    ? {
      ...(entry.approve !== undefined ? { approve: arr(entry.approve) } : {}),
      ...(entry.max_amount !== undefined ? { max_amount: entry.max_amount } : {}),
    }
    : undefined;
  const fm = {
    slug: entry.id,
    name: entry.name,
    ...(address ? { address } : {}),
    ...(entry.language !== undefined ? { language: entry.language } : {}),
    ...(entry.timezone !== undefined ? { timezone: entry.timezone } : {}),
    ...(roles.length ? { roles } : {}),
    ...(authority ? { authority } : {}),
    ...(entry.channels !== undefined ? { channels: arr(entry.channels) } : {}),
    ...(entry.address_overrides !== undefined ? { address_overrides: entry.address_overrides } : {}),
  };
  return { fileSlug: typeof entry.id === 'string' ? entry.id : null, frontmatter: fm, body: '' };
}

// ── validate parsed USER.md (reuses validateCard from lib/people.js) ───────────────────────────
export function validateUserMd(parsed, cfg = userConfig({ config: {} })) {
  const errors = [], warnings = [];
  const fm = parsed.frontmatter;
  if (!isObj(fm)) return { errors: [parsed.error || 'USER.md has no YAML frontmatter (--- ... ---)'], warnings, people: [] };

  // principal block (required, exactly one)
  const pr = fm.principal;
  if (!isObj(pr)) {
    errors.push('missing required frontmatter map "principal" ({ kind, name, ... })');
  } else {
    if (!pr.kind || !PRINCIPAL_KINDS.has(String(pr.kind))) {
      errors.push(`principal.kind "${pr.kind ?? ''}" must be "person" or "org"`);
    }
    if (typeof pr.name !== 'string' || !pr.name.trim()) {
      errors.push('principal.name is required');
    } else if (pr.name.length > USER_DEFAULTS.max_name_chars) {
      errors.push(`principal.name is longer than ${USER_DEFAULTS.max_name_chars} characters`);
    }
    for (const k of ['self', 'call_others']) {
      if (pr[k] !== undefined) {
        const s = strField(pr[k]);
        if (s == null || !s.trim()) errors.push(`principal.${k} must be a non-empty string`);
        else if (s.length > USER_DEFAULTS.max_address_chars) errors.push(`principal.${k} is longer than ${USER_DEFAULTS.max_address_chars} characters`);
      }
    }
    if (pr.handoff !== undefined && !ROLE_RE.test(String(pr.handoff))) {
      errors.push(`principal.handoff "${pr.handoff}" must be a valid role name`);
    }
    for (const k of Object.keys(pr)) {
      if (!PRINCIPAL_FIELDS.has(k)) warnings.push(`principal.${k} is not a known field`);
    }
  }

  // people list (internal team/principal members only — validated via validateCard)
  const peopleCfg = peopleConfig({
    cwd: cfg.cwd,
    config: { people: { action_classes: cfg.action_classes, max_body_chars: cfg.max_body_chars } },
  });
  const validatedPeople = [];
  if (fm.people !== undefined && !Array.isArray(fm.people)) {
    errors.push('people must be a list of internal team members');
  } else {
    const seenIds = new Set();
    for (let i = 0; i < arr(fm.people).length; i++) {
      const entry = fm.people[i];
      if (!isObj(entry)) { errors.push(`people[${i}] must be a map`); continue; }
      const rawId = entry.id == null ? '' : String(entry.id);
      if (!rawId) {
        errors.push(`people[${i}]: missing required field "id"`);
      } else if (ADDRESS_LIKE.test(rawId)) {
        errors.push(`people[${i}].id "${rawId.slice(0, 4)}..." looks like a phone number, email or address — use a stable slug id; map channel ids in the app`);
      } else if (!SLUG_RE.test(rawId)) {
        errors.push(`people[${i}].id "${rawId}" must match ^[a-z][a-z0-9-]*$`);
      } else if (seenIds.has(rawId)) {
        errors.push(`people[${i}].id "${rawId}" is duplicated`);
      } else {
        seenIds.add(rawId);
      }
      for (const k of Object.keys(entry)) {
        if (!PERSON_ENTRY_FIELDS.has(k)) warnings.push(`people[${rawId || i}].${k} is not a known field`);
      }
      const card = personEntryToCard(entry, isObj(pr) ? pr : {});
      const v = validateCard(card, peopleCfg);
      for (const e of v.errors) {
        if (e.includes('slug') && (!rawId || !SLUG_RE.test(rawId))) continue; // already reported as id
        errors.push(`people[${rawId || i}]: ${e}`);
      }
      for (const w of v.warnings) warnings.push(`people[${rawId || i}]: ${w}`);
      validatedPeople.push({
        id: rawId,
        slug: rawId,
        entry,
        frontmatter: card.frontmatter,
        channelIds: arr(entry.channel_ids).map(String).filter(Boolean),
        valid: v.errors.length === 0 && SLUG_RE.test(rawId) && !ADDRESS_LIKE.test(rawId),
      });
    }
  }

  for (const k of Object.keys(fm)) {
    if (!['principal', 'people'].includes(k)) warnings.push(`unknown frontmatter field "${k}"`);
  }

  // body cap + secret & instruction-injection checks
  const body = String(parsed.body || '');
  if (body.length > cfg.max_body_chars) {
    errors.push(`body is ${body.length} characters; the cap is ${cfg.max_body_chars} (user.max_body_chars) — keep detail in subject memory`);
  }
  const texts = [body, ...collectStrings(fm)];
  if (texts.some((t) => findSecret(t))) {
    errors.push('USER.md contains a secret (key, token, password, card number) — never store secrets in USER.md');
  }
  if (looksLikeInstruction(body)) {
    errors.push('USER.md body reads as an instruction to agents (ignore rules, skip approvals, elevate privileges) — rules belong in hard-rules.md');
  }
  return { errors, warnings, people: validatedPeople };
}

// ── open deployment USER.md (frozen snapshot, wraps people.js authority rules) ─────────────────
export function openUser(opts = {}) {
  const cfg = opts.cfg || userConfig(opts);
  const exists = fs.existsSync(cfg.file) && fs.statSync(cfg.file).isFile();
  let raw = '';
  let hash = null;
  let parsed = { frontmatter: null, body: '', rawBody: '', sections: { about: '', maySay: '', mustNotSay: '' }, canaries: [], error: null };
  let validation = { errors: [], warnings: [], people: [] };
  if (exists) {
    raw = fs.readFileSync(cfg.file, 'utf8');
    hash = sha(raw).slice(0, 16);
    parsed = parseUserMd(raw);
    validation = validateUserMd(parsed, cfg);
  }
  const valid = exists && validation.errors.length === 0;
  const principal = valid && isObj(parsed.frontmatter?.principal) ? parsed.frontmatter.principal : null;
  const cards = new Map();
  if (valid) {
    for (const p of validation.people) {
      if (p.id) cards.set(p.id, { ...p, body: '', hash, errors: [], warnings: [] });
    }
  }

  const getValid = (id) => { const c = cards.get(id); return c && c.valid ? c : null; };
  function rolesOf(id) {
    const c = getValid(id); if (!c) return [];
    if (cfg.roles) return Object.keys(cfg.roles).filter((r) => cfg.roles[r].includes(id)).sort();
    return arr(c.frontmatter.roles).map(String).sort();
  }
  function membersOf(role) {
    const r = roleOf(role); if (!r) return [];
    return [...cards.keys()].filter((s) => getValid(s) && rolesOf(s).includes(r)).sort();
  }
  function resolve(ref) {
    const s = String(ref ?? '').trim();
    if (s.startsWith('person:')) return getValid(s.slice(7)) ? [s.slice(7)] : [];
    return membersOf(s);
  }
  const classTier = (c) => normalizeTier(cfg.action_classes[c]);
  const classesOfTier = (tier) => Object.keys(cfg.action_classes).filter((c) => classTier(c) === tier).sort();
  const covers = (list, { tier, action }) => {
    const A = new Set(arr(list).map(String));
    if (A.has(tier)) return true;
    if (action) return A.has(action) && classTier(action) === tier;
    const cls = classesOfTier(tier);
    return cls.length > 0 && cls.every((c) => A.has(c));
  };
  function authorityOf(id) {
    const c = getValid(id); if (!c) return { approve: [], max_amount: null };
    const a = isObj(c.frontmatter.authority) ? c.frontmatter.authority : {};
    let approve = arr(a.approve).map(String);
    let max = typeof a.max_amount === 'number' ? a.max_amount : null;
    if (cfg.ceiling) {
      const ceil = rolesOf(id).map((r) => cfg.ceiling[r]).filter(isObj);
      const allowed = ceil.flatMap((x) => arr(x.approve).map(String));
      approve = approve.filter((e) => allowed.includes(e) || (classTier(e) && allowed.includes(classTier(e))));
      const caps = ceil.map((x) => (typeof x.max_amount === 'number' ? x.max_amount : Infinity));
      const ceilMax = caps.length ? Math.max(...caps) : 0;
      if (Number.isFinite(ceilMax)) max = max == null ? ceilMax : Math.min(max, ceilMax);
    }
    return { approve: [...new Set(approve)].sort(), max_amount: max };
  }
  function canApprove(id, { tier, action = null, amount = null } = {}) {
    if (!SLUG_RE.test(String(id || ''))) return { ok: false, reason: 'unattributed' };
    const c = cards.get(id);
    if (!c) return { ok: false, reason: 'unknown_person' };
    if (!c.valid) return { ok: false, reason: 'invalid_card' };
    const t = normalizeTier(tier) || 'destructive';
    if (action && !Object.prototype.hasOwnProperty.call(cfg.action_classes, action)) return { ok: false, reason: 'unknown_action' };
    const au = authorityOf(id);
    if (!covers(au.approve, { tier: t, action })) return { ok: false, reason: 'no_authority', tier: t, action };
    if (au.max_amount != null) {
      const amt = parseAmount(amount);
      if (amt == null && t === 'financial') return { ok: false, reason: 'amount_unknown' };
      if (amt != null && amt > au.max_amount) return { ok: false, reason: 'over_limit', amount: amt, max_amount: au.max_amount };
    }
    return { ok: true };
  }
  const approversFor = (gate) => [...cards.keys()].filter((s) => getValid(s) && canApprove(s, gate).ok).sort();

  // Map a verified channel sender id (e.g. "zalo:12345" or "telegram:99") or internal person id
  function findByChannelId(channelId) {
    if (!valid || !channelId) return null;
    const target = String(channelId).trim();
    for (const c of cards.values()) {
      if (c.channelIds.includes(target)) return c;
    }
    return null;
  }
  function isInternal({ senderId = null, channelId = null, channelMap = null } = {}) {
    if (!valid) return { internal: false, person: null, reason: 'no_user_md' };
    // Verified channel mapping takes precedence over raw claims
    if (channelId) {
      const ch = String(channelId).trim();
      if (isObj(channelMap) && channelMap[ch]) {
        const mapped = getValid(String(channelMap[ch]));
        if (mapped) return { internal: true, person: mapped, via: 'channel_map' };
        return { internal: false, person: null, reason: 'unmatched_channel_map' };
      }
      const byCh = findByChannelId(ch);
      if (byCh) return { internal: true, person: byCh, via: 'channel_ids' };
      return { internal: false, person: null, reason: 'unknown_channel_id' };
    }
    if (senderId) {
      const p = getValid(String(senderId).trim());
      if (p) return { internal: true, person: p, via: 'verified_sender_id' };
      return { internal: false, person: null, reason: 'unknown_sender_id' };
    }
    return { internal: false, person: null, reason: 'missing_sender' };
  }

  // Render prompt block: frontmatter NEVER enters the prompt; header NEVER uses the word "user"
  function render({ audience = 'internal' } = {}) {
    if (!valid) return { text: '', hash: null, chars: 0, audience };
    const L = cfg.labels;
    const parts = [];
    if (audience === 'internal') {
      if (parsed.sections.about) parts.push(parsed.sections.about);
    }
    if (parsed.sections.maySay) {
      parts.push(`### ${L.may_say}\n${parsed.sections.maySay}`);
    }
    if (parsed.sections.mustNotSay) {
      parts.push(`### ${L.must_not_say}\n${parsed.sections.mustNotSay}`);
    }
    if (!parts.length) return { text: '', hash, chars: 0, audience };
    const inner = `## ${L.header}\n(${L.preamble})\n\n${parts.join('\n\n')}`;
    const snap = sha(inner).slice(0, 16);
    const text = `<principal snapshot="${snap}" audience="${audience}">\n${inner}\n</principal>`;
    return { text, hash: snap, fileHash: hash, chars: text.length, audience };
  }

  // Tool-boundary guard: agents may never write USER.md directly
  function guard(targetPath) {
    const rp = path.resolve(targetPath);
    if (rp === cfg.file) {
      return { allowed: false, tier: 'destructive', reason: 'user_md_is_written_by_people' };
    }
    return { allowed: true };
  }

  // Per-run file hash audit: detects out-of-band USER.md edits between runs
  function checkHashChange(stateDir) {
    if (!exists || !hash) return { changed: false, previousHash: null, hash: null };
    const marker = path.join(stateDir, 'user-md.hash.json');
    let previousHash = null;
    if (fs.existsSync(marker)) {
      try { previousHash = JSON.parse(fs.readFileSync(marker, 'utf8')).hash || null; } catch { /* ignore */ }
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ file: path.relative(cfg.cwd, cfg.file) || cfg.file, hash, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    return { changed: previousHash != null && previousHash !== hash, previousHash, hash };
  }

  function check({ agents = [] } = {}) {
    const errors = [], warnings = [];
    const rel = (p) => path.relative(cfg.cwd, p) || p;
    const agentsDir = path.join(cfg.cwd, 'agents');
    if (cfg.file.startsWith(agentsDir + path.sep)) {
      errors.push(`${rel(cfg.file)} is inside agents/ — USER.md must live outside every agent folder (§41)`);
    }
    if (!exists) return { errors, warnings, active: false, people: 0 };
    for (const e of validation.errors) errors.push(`${rel(cfg.file)}: ${e}`);
    for (const w of validation.warnings) warnings.push(`${rel(cfg.file)}: ${w}`);
    if (valid && principal && principal.handoff && cards.size > 0 && !membersOf(principal.handoff).length) {
      warnings.push(`${rel(cfg.file)}: principal.handoff role "${principal.handoff}" has no matching member in people`);
    }
    for (const [c, t] of Object.entries(cfg.action_classes)) {
      if (!TIERS.includes(String(t))) errors.push(`user.action_classes.${c}: "${t}" is not a §21 tier`);
    }
    for (const { name, identity } of agents) {
      for (const r of arr(identity && identity.serves).map(roleOf).filter(Boolean)) {
        if (valid && cards.size > 0 && !membersOf(r).length) {
          warnings.push(`agent ${name} serves role "${r}", which nobody in USER.md holds`);
        }
      }
    }
    return { errors, warnings, active: valid, people: cards.size, hash };
  }

  const allCanaries = () => [...new Set([...parsed.canaries, ...cfg.canaries])];

  return {
    cfg, file: cfg.file, exists, valid, active: valid, hash,
    principal, sections: parsed.sections, cards,
    errors: validation.errors, warnings: validation.warnings,
    get: (id) => cards.get(id) || null,
    slugs: () => [...cards.keys()],
    rolesOf, membersOf, resolve, authorityOf, canApprove, approversFor,
    findByChannelId, isInternal, render, guard, checkHashChange, check,
    maySayText: () => parsed.sections.maySay,
    mustNotSayText: () => parsed.sections.mustNotSay,
    canaries: allCanaries,
    handoffRole: () => (principal && principal.handoff ? String(principal.handoff) : 'owner'),
  };
}

// ── External workspace USER.md import (§38) ────────────────────────────────────────────────────
// Human-written prose becomes the USER.md body; agent-appended notes/observations are NEVER
// promoted into human-authored principal context — they route to the gated subject-memory queue.
export function importWorkspaceUserMd(raw, {
  principalName = 'Principal',
  kind = 'person',
  self = 'I',
  callOthers = 'you',
  handoff = 'owner',
  maxBodyChars = USER_DEFAULTS.max_body_chars,
  memoryStore = null,
  subjectRef = null,
  by = 'import',
} = {}) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  const p = parseFrontmatter(text);
  const body = String(p.body || '').trim();
  const lines = body.split('\n');
  const humanLines = [];
  const agentNotes = [];
  let inAgentSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,3}\s+/.test(trimmed)) {
      inAgentSection = AGENT_SECTION_RE.test(trimmed);
      if (!inAgentSection) humanLines.push(line);
      continue;
    }
    if (inAgentSection || AGENT_LINE_RE.test(line)) {
      const cleaned = trimmed.replace(/^[-*]\s*/, '').replace(AGENT_LINE_RE, '').trim();
      if (cleaned) agentNotes.push(cleaned);
      continue;
    }
    humanLines.push(line);
  }
  const humanBody = humanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxBodyChars);
  const userMd = [
    '---',
    'principal:',
    `  kind: ${PRINCIPAL_KINDS.has(kind) ? kind : 'person'}`,
    `  name: ${JSON.stringify(principalName)}`,
    `  self: ${JSON.stringify(self)}`,
    `  call_others: ${JSON.stringify(callOthers)}`,
    `  handoff: ${handoff}`,
    'people: []',
    '---',
    humanBody || `# About ${principalName}`,
    '',
  ].join('\n');

  const queuedMemory = [];
  if (memoryStore && subjectRef && agentNotes.length) {
    let sid = memoryStore.resolve(subjectRef);
    if (!sid) {
      sid = memoryStore.createSubject({ kind: 'person', label: principalName });
      memoryStore.link(subjectRef, sid);
    }
    const sess = memoryStore.openSession(sid, { surface: 'import' });
    for (let i = 0; i < agentNotes.length; i++) {
      const note = agentNotes[i];
      const turn = memoryStore.appendTurn(sid, sess, { role: 'agent', speaker: by, text: note });
      const res = memoryStore.propose(sid, {
        key: `imported_note_${i + 1}`,
        about: 'self',
        value: note,
        provenance: 'agent_observed',
        evidence: { ref: turn.ref, quote: note },
      }, { by });
      queuedMemory.push({ sid, note, result: res });
    }
  }
  return { userMd, humanBody, agentNotes, queuedMemory };
}

export function userTemplate({ kind = 'org', name = 'Example Co', ownerId = 'owner', ownerName = 'Alex Rivera' } = {}) {
  return `---
principal:
  kind: ${kind}
  name: ${JSON.stringify(name)}
  self: "I"
  call_others: "you"
  handoff: staff
people:
  - { id: ${ownerId}, name: ${JSON.stringify(ownerName)}, call: ${JSON.stringify(ownerName.split(' ')[0])}, role: owner, approve: [send, pay], max_amount: 5000, channels: [email, chat] }
---
# About ${name}
Internal context loaded only when speaking with people listed above.

## May say on behalf
- Hours and public policies that agents may state to external callers.

## Must not say
- Private principal matters. Discounts or refunds require human handoff.
`;
}

// ── Per-turn internal vs external audience classifier & group lowest-trust wall (§42) ──────────
// Identity is NEVER inferred from displayName. A speaker is internal ONLY when their verified
// channelId (mapped via channelMap or USER.md channel_ids) or verified senderId matches a valid
// entry in USER.md. Missing sender fails closed to external.
// In a group chat, command authority follows the speaker, while loaded content & output wall
// follow the LEAST-TRUSTED participant present.
export function classifyTurn(userDoc, {
  sender = null,
  participants = null,
  isGroup = false,
  channelMap = null,
  chatSubject = null,
} = {}) {
  const verifyActor = (actor) => {
    if (!actor || !userDoc || !userDoc.active) return { internal: false, person: null, reason: !actor ? 'missing_sender' : 'no_user_md' };
    // displayName is explicitly ignored — only verified channelId or verified internal id counts
    const channelId = actor.channelId || actor.channel_id || null;
    const senderId = actor.verifiedId || actor.id || null;
    if (channelId) return userDoc.isInternal({ channelId, channelMap });
    if (senderId && actor.verified === true) return userDoc.isInternal({ senderId });
    return { internal: false, person: null, reason: senderId ? 'unverified_sender_id' : 'missing_channel_id' };
  };

  const sp = verifyActor(sender);
  const speakerTrust = sp.internal ? 'internal' : 'external';
  const list = Array.isArray(participants) ? participants : null;
  const group = isGroup || (list != null && list.length > 1);

  let contentAudience = speakerTrust;
  let wallReason = sp.internal ? 'verified_internal_speaker' : (sp.reason || 'external_speaker');
  if (group) {
    if (!list || list.length === 0) {
      contentAudience = 'external';
      wallReason = 'group_participants_unknown';
    } else {
      const anyExternal = list.some((p) => !verifyActor(p).internal);
      if (anyExternal) {
        contentAudience = 'external';
        wallReason = 'group_lowest_trust_external';
      }
    }
  }

  const externalContent = contentAudience === 'external';
  const writeToolsAllowed = speakerTrust === 'internal' && !externalContent;

  return {
    speakerTrust,
    contentAudience,
    isGroup: group,
    speakerId: sp.person ? sp.person.id : null,
    speakerRoles: sp.person ? userDoc.rolesOf(sp.person.id) : [],
    userSections: externalContent ? ['maySay', 'mustNotSay'] : ['about', 'maySay', 'mustNotSay'],
    writeToolsAllowed,
    toolPolicyOverride: writeToolsAllowed ? null : 'none',
    memoryScope: externalContent ? 'chat_only' : 'principal_and_team',
    chatSubject: chatSubject || null,
    draftOnly: externalContent,
    requireApproval: externalContent,
    groundingRequired: externalContent,
    aiDisclosureRequired: externalContent,
    reason: wallReason,
  };
}

// Normalize diacritics to ASCII so bilingual/international patterns match without raw non-ASCII literals
function foldAscii(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

const IDENTITY_Q_PATTERNS = [
  /\b(?:are|r)\s+you\s+(?:a\s+|an\s+)?(?:bot|ai|robot|machine|human|real\s+person|automated|assistant|chatgpt|llm)\b/,
  /\b(?:is\s+this|am\s+i\s+(?:talking|speaking|chatting)\s+(?:to|with))\s+(?:a\s+|an\s+)?(?:bot|ai|robot|human|real\s+person|assistant|the\s+real)\b/,
  /\b(?:bot|ai)\s+or\s+(?:a\s+)?(?:human|real\s+person)\b/,
  /\b(?:human|real\s+person)\s+or\s+(?:a\s+|an\s+)?(?:bot|ai)\b/,
  /\bor\s+(?:a\s+|an\s+)?(?:bot|ai|robot)\b/,
  /\bis\s+this\s+really\b/,
  /\bwho\s+is\s+actually\s+(?:typing|replying|answering)\b/,
  /\b(?:co\s+phai|la)\s+(?:bot|ai|may|nguoi\s+that|tro\s+ly\s+ao|tu\s+dong)\b/,
  /\b(?:bot|ai|tro\s+ly\s+ao|may)\s+hay\s+nguoi\b/,
  /\bnguoi\s+that\s+hay\s+(?:bot|ai|tro\s+ly\s+ao|may)\b/,
];

const AI_ACKNOWLEDGE_RE = /\b(?:ai|artificial\s+intelligence|ai\s+assistant|virtual\s+assistant|automated\s+assistant|bot|tro\s+ly\s+ai|tro\s+ly\s+ao)\b/;
const AI_DENIAL_RE = /\b(?:i\s+am\s+(?:a\s+)?(?:real\s+)?human|i\s+am\s+not\s+(?:a\s+|an\s+)?(?:bot|ai)|no,?\s*i(?:'m|\s+am)\s+not\s+(?:a\s+|an\s+)?(?:bot|ai)|khong\s+phai\s+(?:bot|ai)|la\s+nguoi\s+that)\b/;

export function isIdentityQuestion(text) {
  const f = foldAscii(text);
  return IDENTITY_Q_PATTERNS.some((re) => re.test(f));
}

export function checkAiDisclosure(replyText) {
  const f = foldAscii(replyText);
  if (AI_DENIAL_RE.test(f)) return { ok: false, reason: 'denied_ai_identity' };
  if (!AI_ACKNOWLEDGE_RE.test(f)) return { ok: false, reason: 'missing_ai_disclosure' };
  return { ok: true };
}

export function applyAiLabel(text, { label = '[AI Assistant]', speaksAs = 'self', approvedByHuman = false } = {}) {
  const s = String(text ?? '').trim();
  if (!s || approvedByHuman || speaksAs === 'owner') return s;
  const tag = String(label || '').trim();
  if (!tag) return s;
  if (s.startsWith(tag) || s.endsWith(tag)) return s;
  return `${tag} ${s}`;
}
