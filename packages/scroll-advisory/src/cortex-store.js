// Tri-Partite Domain Cortex Store for @agentpro/scroll-advisory:
//   T1: Bi-Temporal Normative Rules (valid_from/to, agency renames, red lines)
//   T2: Field Reality & Verified CBR Case Library (scope, independent case count, auto-freeze on T1 change)
//   T3: Executable Software Reality Atlas (OS/version-pinned, 30-60d TTL, screenshot provenance, Tier A/B/C/D resolver)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function createStandaloneSqliteAdapter(dbPath = ':memory:') {
  const isMemory = !dbPath || dbPath === ':memory:';
  if (!isMemory) fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(isMemory ? ':memory:' : dbPath);
  if (!isMemory) db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return {
    kind: 'sqlite',
    isMemory,
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const res = fn();
        db.exec('COMMIT;');
        return res;
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
        throw err;
      }
    },
    close: () => { try { db.close(); } catch { /* ignore */ } },
  };
}

const CORTEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cortex_t1_rule (
  rule_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL DEFAULT 'general',
  citation TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  agency_name TEXT NOT NULL DEFAULT '',
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  last_reviewed_at TEXT NOT NULL,
  red_lines_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cortex_t2_case (
  case_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'national',
  linked_t1_rule_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  situation TEXT NOT NULL,
  wrong_textbook_path TEXT NOT NULL DEFAULT '',
  verified_field_path TEXT NOT NULL,
  red_lines_json TEXT NOT NULL DEFAULT '[]',
  independent_case_count INTEGER NOT NULL DEFAULT 3,
  sources_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  helpful_count INTEGER NOT NULL DEFAULT 0,
  harmful_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cortex_t3_atlas (
  atlas_id TEXT PRIMARY KEY,
  software TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT 'latest',
  os TEXT NOT NULL DEFAULT 'any',
  error_signature TEXT NOT NULL DEFAULT '',
  goal_milestone TEXT NOT NULL,
  root_cause TEXT NOT NULL DEFAULT '',
  verified_workaround TEXT NOT NULL DEFAULT '',
  ui_steps_json TEXT NOT NULL DEFAULT '[]',
  local_variation INTEGER NOT NULL DEFAULT 0,
  official_inquiry_questions_json TEXT NOT NULL DEFAULT '[]',
  verified_at TEXT NOT NULL,
  ttl_days INTEGER NOT NULL DEFAULT 45,
  verifier TEXT NOT NULL DEFAULT 'sandbox',
  screenshot_ref TEXT,
  status TEXT NOT NULL DEFAULT 'verified',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_t1_valid ON cortex_t1_rule(domain, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_t2_link ON cortex_t2_case(linked_t1_rule_id, status);
CREATE INDEX IF NOT EXISTS idx_t3_sw ON cortex_t3_atlas(software, os, status);
`;

function parseJson(s, fb) {
  if (typeof s !== 'string' || !s) return fb;
  try { return JSON.parse(s); } catch { return fb; }
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();
}

export function createDomainCortexStore({
  storage = null,
  dbPath = ':memory:',
  now = () => new Date().toISOString(),
} = {}) {
  const adapter = storage || createStandaloneSqliteAdapter(dbPath);
  const ownsAdapter = !storage;
  adapter.exec(CORTEX_SCHEMA_SQL);

  const stmts = {
    getT1: adapter.prepare('SELECT * FROM cortex_t1_rule WHERE rule_id = ?'),
    upsertT1: adapter.prepare(`
      INSERT INTO cortex_t1_rule (
        rule_id, domain, citation, title, summary, agency_name, valid_from, valid_to,
        last_reviewed_at, red_lines_json, tags_json, version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id) DO UPDATE SET
        domain = excluded.domain,
        citation = excluded.citation,
        title = excluded.title,
        summary = excluded.summary,
        agency_name = excluded.agency_name,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        last_reviewed_at = excluded.last_reviewed_at,
        red_lines_json = excluded.red_lines_json,
        tags_json = excluded.tags_json,
        version = cortex_t1_rule.version + 1,
        updated_at = excluded.updated_at
    `),
    listT1: adapter.prepare('SELECT * FROM cortex_t1_rule ORDER BY valid_from DESC'),
    freezeLinkedT2: adapter.prepare(`
      UPDATE cortex_t2_case SET status = 'frozen_t1_changed', updated_at = ?
      WHERE linked_t1_rule_id = ? AND status = 'active'
    `),
    upsertT2: adapter.prepare(`
      INSERT INTO cortex_t2_case (
        case_id, domain, title, scope, linked_t1_rule_id, status, situation,
        wrong_textbook_path, verified_field_path, red_lines_json, independent_case_count,
        sources_json, tags_json, helpful_count, harmful_count, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET
        title = excluded.title,
        scope = excluded.scope,
        linked_t1_rule_id = excluded.linked_t1_rule_id,
        status = excluded.status,
        situation = excluded.situation,
        wrong_textbook_path = excluded.wrong_textbook_path,
        verified_field_path = excluded.verified_field_path,
        red_lines_json = excluded.red_lines_json,
        independent_case_count = excluded.independent_case_count,
        sources_json = excluded.sources_json,
        tags_json = excluded.tags_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `),
    listT2: adapter.prepare('SELECT * FROM cortex_t2_case ORDER BY helpful_count DESC, updated_at DESC'),
    getT2: adapter.prepare('SELECT * FROM cortex_t2_case WHERE case_id = ?'),
    incT2Helpful: adapter.prepare('UPDATE cortex_t2_case SET helpful_count = helpful_count + 1, updated_at = ? WHERE case_id = ?'),
    incT2Harmful: adapter.prepare('UPDATE cortex_t2_case SET harmful_count = harmful_count + 1, updated_at = ? WHERE case_id = ?'),
    upsertT3: adapter.prepare(`
      INSERT INTO cortex_t3_atlas (
        atlas_id, software, version, os, error_signature, goal_milestone, root_cause,
        verified_workaround, ui_steps_json, local_variation, official_inquiry_questions_json,
        verified_at, ttl_days, verifier, screenshot_ref, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(atlas_id) DO UPDATE SET
        version = excluded.version,
        os = excluded.os,
        error_signature = excluded.error_signature,
        goal_milestone = excluded.goal_milestone,
        root_cause = excluded.root_cause,
        verified_workaround = excluded.verified_workaround,
        ui_steps_json = excluded.ui_steps_json,
        local_variation = excluded.local_variation,
        official_inquiry_questions_json = excluded.official_inquiry_questions_json,
        verified_at = excluded.verified_at,
        ttl_days = excluded.ttl_days,
        verifier = excluded.verifier,
        screenshot_ref = excluded.screenshot_ref,
        status = excluded.status,
        updated_at = excluded.updated_at
    `),
    listT3: adapter.prepare('SELECT * FROM cortex_t3_atlas ORDER BY verified_at DESC'),
  };

  function hydrateT1(r) {
    if (!r) return null;
    return {
      ruleId: r.rule_id,
      domain: r.domain,
      citation: r.citation,
      title: r.title,
      summary: r.summary,
      agencyName: r.agency_name,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      lastReviewedAt: r.last_reviewed_at,
      redLines: parseJson(r.red_lines_json, []),
      tags: parseJson(r.tags_json, []),
      version: Number(r.version || 1),
      updatedAt: r.updated_at,
    };
  }

  function hydrateT2(r) {
    if (!r) return null;
    return {
      caseId: r.case_id,
      domain: r.domain,
      title: r.title,
      scope: r.scope,
      linkedT1RuleId: r.linked_t1_rule_id,
      status: r.status,
      situation: r.situation,
      wrongTextbookPath: r.wrong_textbook_path,
      verifiedFieldPath: r.verified_field_path,
      redLines: parseJson(r.red_lines_json, []),
      independentCaseCount: Number(r.independent_case_count || 0),
      sources: parseJson(r.sources_json, []),
      tags: parseJson(r.tags_json, []),
      helpfulCount: Number(r.helpful_count || 0),
      harmfulCount: Number(r.harmful_count || 0),
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  function hydrateT3(r) {
    if (!r) return null;
    return {
      atlasId: r.atlas_id,
      software: r.software,
      version: r.version,
      os: r.os,
      errorSignature: r.error_signature,
      goalMilestone: r.goal_milestone,
      rootCause: r.root_cause,
      verifiedWorkaround: r.verified_workaround,
      uiSteps: parseJson(r.ui_steps_json, []),
      localVariation: Boolean(r.local_variation),
      officialInquiryQuestions: parseJson(r.official_inquiry_questions_json, []),
      verifiedAt: r.verified_at,
      ttlDays: Number(r.ttl_days || 45),
      verifier: r.verifier,
      screenshotRef: r.screenshot_ref,
      status: r.status,
      updatedAt: r.updated_at,
    };
  }

  // Upserts T1 rule AND automatically freezes linked T2 field cases if the T1 rule changed!
  function upsertT1Rule(rule = {}) {
    const ts = String(now());
    const ruleId = String(rule.ruleId || `t1_${crypto.randomBytes(5).toString('hex')}`);
    return adapter.transaction(() => {
      const existing = stmts.getT1.get(ruleId);
      const changed = Boolean(existing && (
        existing.summary !== String(rule.summary ?? existing.summary)
        || existing.valid_from !== String(rule.validFrom ?? existing.valid_from)
        || (existing.valid_to || null) !== (rule.validTo ?? null)
        || existing.citation !== String(rule.citation ?? existing.citation)
      ));
      stmts.upsertT1.run(
        ruleId,
        String(rule.domain || 'general'),
        String(rule.citation || ''),
        String(rule.title || ''),
        String(rule.summary || ''),
        String(rule.agencyName || ''),
        String(rule.validFrom || '2020-01-01'),
        rule.validTo ?? null,
        String(rule.lastReviewedAt || ts),
        JSON.stringify(rule.redLines || []),
        JSON.stringify(rule.tags || []),
        1,
        ts
      );
      let frozenCases = 0;
      if (changed) {
        const res = stmts.freezeLinkedT2.run(ts, ruleId);
        frozenCases = Number(res?.changes || 0);
      }
      return { rule: hydrateT1(stmts.getT1.get(ruleId)), frozenCases };
    });
  }

  function getEffectiveT1Rules({ asOfDate = null, domain = null, query = '' } = {}) {
    const target = String(asOfDate || now().slice(0, 10));
    const qTokens = norm(query).split(/\s+/).filter((t) => t.length >= 2);
    return stmts.listT1.all()
      .map(hydrateT1)
      .filter((r) => (!domain || r.domain === domain))
      .filter((r) => r.validFrom <= target && (!r.validTo || r.validTo > target))
      .filter((r) => {
        if (!qTokens.length) return true;
        const hay = norm(`${r.citation} ${r.title} ${r.summary} ${r.tags.join(' ')}`);
        return qTokens.some((t) => hay.includes(t));
      });
  }

  function upsertT2Case(c = {}) {
    const ts = String(now());
    const caseId = String(c.caseId || `t2_${crypto.randomBytes(5).toString('hex')}`);
    stmts.upsertT2.run(
      caseId,
      String(c.domain || 'general'),
      String(c.title || ''),
      String(c.scope || 'national'),
      c.linkedT1RuleId ?? null,
      String(c.status || 'active'),
      String(c.situation || ''),
      String(c.wrongTextbookPath || ''),
      String(c.verifiedFieldPath || ''),
      JSON.stringify(c.redLines || []),
      Number(c.independentCaseCount ?? 3),
      JSON.stringify(c.sources || []),
      JSON.stringify(c.tags || []),
      Number(c.helpfulCount || 0),
      Number(c.harmfulCount || 0),
      c.expiresAt ?? null,
      String(c.createdAt || ts),
      ts
    );
    return hydrateT2(stmts.getT2.get(caseId));
  }

  function searchT2Cases({ query = '', domain = null, includeFrozen = false, nowIso = null } = {}) {
    const cutoff = String(nowIso || now());
    const qTokens = norm(query).split(/\s+/).filter((t) => t.length >= 2);
    return stmts.listT2.all()
      .map(hydrateT2)
      .filter((c) => (!domain || c.domain === domain))
      .filter((c) => (includeFrozen ? true : c.status === 'active'))
      .filter((c) => (!c.expiresAt || c.expiresAt > cutoff))
      .map((c) => {
        const hay = norm(`${c.title} ${c.situation} ${c.verifiedFieldPath} ${c.tags.join(' ')}`);
        const hits = qTokens.length ? qTokens.filter((t) => hay.includes(t)).length : 1;
        return { ...c, _hits: hits };
      })
      .filter((c) => c._hits > 0)
      .sort((a, b) => (b._hits - a._hits) || ((b.helpfulCount - b.harmfulCount) - (a.helpfulCount - a.harmfulCount)));
  }

  function recordT2Feedback(caseId, verdict = 'helpful') {
    const ts = String(now());
    if (verdict === 'harmful') stmts.incT2Harmful.run(ts, String(caseId));
    else stmts.incT2Helpful.run(ts, String(caseId));
    return hydrateT2(stmts.getT2.get(String(caseId)));
  }

  function upsertT3Atlas(entry = {}) {
    const ts = String(now());
    const atlasId = String(entry.atlasId || `t3_${crypto.randomBytes(5).toString('hex')}`);
    stmts.upsertT3.run(
      atlasId,
      String(entry.software || ''),
      String(entry.version || 'latest'),
      String(entry.os || 'any'),
      String(entry.errorSignature || ''),
      String(entry.goalMilestone || ''),
      String(entry.rootCause || ''),
      String(entry.verifiedWorkaround || ''),
      JSON.stringify(entry.uiSteps || []),
      entry.localVariation ? 1 : 0,
      JSON.stringify(entry.officialInquiryQuestions || []),
      String(entry.verifiedAt || ts),
      Math.max(7, Math.min(90, Number(entry.ttlDays) || 45)),
      String(entry.verifier || 'sandbox'),
      entry.screenshotRef ?? null,
      String(entry.status || 'verified'),
      ts
    );
    return listT3Atlas().find((a) => a.atlasId === atlasId);
  }

  function recordClientScreenshotCandidate({ software, os = 'any', errorSignature = '', screenshotRef, goalMilestone = '' } = {}) {
    return upsertT3Atlas({
      software,
      os,
      errorSignature,
      goalMilestone: goalMilestone || 'Verify UI state from client screenshot',
      screenshotRef,
      verifier: 'client_screenshot',
      status: 'pending_review',
    });
  }

  function listT3Atlas({ includePending = false } = {}) {
    return stmts.listT3.all()
      .map(hydrateT3)
      .filter((a) => (includePending ? true : a.status !== 'pending_review'));
  }

  // Resolves Graceful Boundary Tier A / B / C / D for software & local-practice queries!
  function resolveSoftwareGuidance({ software = '', os = null, query = '', nowIso = null } = {}) {
    const nowMs = Date.parse(String(nowIso || now())) || Date.now();
    const swNorm = norm(software || query);
    const osNorm = norm(os || '');
    const qNorm = norm(query);

    const candidates = listT3Atlas({ includePending: false }).filter((a) => {
      const aSw = norm(a.software);
      const aSig = norm(a.errorSignature);
      const swMatch = Boolean(aSw && (swNorm.includes(aSw) || qNorm.includes(aSw)));
      const sigMatch = Boolean(aSig && qNorm.includes(aSig));
      const osCompatible = !osNorm || a.os === 'any' || norm(a.os) === osNorm;
      return (swMatch || sigMatch) && osCompatible;
    });

    if (!candidates.length) {
      return {
        tier: 'D',
        allowUiButtonNames: false,
        entry: null,
        sandboxTicketRecommended: true,
        guidance: 'No verified Software Atlas entry for this software/OS combination; state uncertainty honestly, escalate or request screenshot.',
      };
    }

    const best = candidates[0];
    if (best.localVariation) {
      return {
        tier: 'C',
        allowUiButtonNames: false,
        entry: best,
        sandboxTicketRecommended: true,
        guidance: `Local authority/branch variation applies. State the certain baseline first, then provide ready-to-send official inquiry questions.`,
        officialInquiryQuestions: best.officialInquiryQuestions,
      };
    }

    const verifiedMs = Date.parse(best.verifiedAt) || 0;
    const ageDays = (nowMs - verifiedMs) / 86_400_000;
    const isFresh = best.status === 'verified' && ageDays <= best.ttlDays;

    if (isFresh) {
      return {
        tier: 'A',
        allowUiButtonNames: true,
        ageDays: Math.round(ageDays),
        entry: best,
        sandboxTicketRecommended: false,
        guidance: `Verified Atlas entry (${best.software} / ${best.os}, verified ${best.verifiedAt.slice(0, 10)}). Safe to cite verified steps and workaround.`,
      };
    }

    // Expired TTL -> Auto-downgrade from Tier A to Tier B (NEVER hallucinate button names!)
    return {
      tier: 'B',
      allowUiButtonNames: false,
      expired: true,
      ageDays: Math.round(ageDays),
      entry: { ...best, uiSteps: [] },
      sandboxTicketRecommended: true,
      guidance: `Atlas entry expired (${Math.round(ageDays)}d > TTL ${best.ttlDays}d). Do NOT cite button/menu paths; guide by target milestone ("${best.goalMilestone}") and ask for a current screenshot.`,
    };
  }

  function close() {
    if (ownsAdapter) adapter.close();
  }

  return {
    storage: adapter,
    upsertT1Rule,
    getEffectiveT1Rules,
    upsertT2Case,
    searchT2Cases,
    recordT2Feedback,
    upsertT3Atlas,
    recordClientScreenshotCandidate,
    listT3Atlas,
    resolveSoftwareGuidance,
    close,
  };
}
