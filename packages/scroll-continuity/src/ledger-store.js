// Bi-Temporal Provenance-Locked SQLite Ledger Store (6 Core Tables + FTS5).
// Implements strict tenant isolation, [valid_from, valid_to) x [known_from_seq, known_to_seq)
// bi-temporal versioning, mandatory `support` provenance before commit, epistemic separation
// (`user_claim` != `document_evidence` != `business_settlement`), and ACT-R independent-confirmation tie-break.
import crypto from 'node:crypto';
import { createSqliteStorageAdapter } from './storage-adapter.js';

export const NODE_KINDS = Object.freeze([
  'goal',
  'workstream',
  'obligation',
  'evidence',
  'hypothesis',
  'parked_item',
  'constraint',
  'entity',
]);

export const PRIORITY_TIERS = Object.freeze([
  'STATUTORY_PENALTY',
  'APEX_GOAL',
  'CRITICAL_ACTIVE',
  'PARKED_DORMANT',
]);

export const EPISTEMIC_LEVELS = Object.freeze([
  'user_claim',
  'document_evidence',
  'verified_fact',
  'business_settlement',
]);

export const EDGE_TYPES = Object.freeze([
  'part_of',
  'blocks',
  'supports',
  'contradicts',
  'may_match',
  'settles',
]);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event (
  tenant_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'chat',
  source_update_id TEXT NOT NULL,
  chat_id TEXT,
  thread_id TEXT,
  message_id TEXT,
  sender_id TEXT,
  sender_name TEXT,
  sender_role TEXT,
  reply_to_id TEXT,
  event_type TEXT NOT NULL DEFAULT 'user_msg',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (tenant_id, channel, source_update_id)
);

CREATE TABLE IF NOT EXISTS artifact (
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  blob_path TEXT,
  download_status TEXT NOT NULL DEFAULT 'ready',
  mime TEXT,
  ocr_version TEXT,
  ocr_text TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, source_seq) REFERENCES event(tenant_id, seq)
);

CREATE TABLE IF NOT EXISTS node (
  tenant_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  business_key TEXT,
  priority_tier TEXT NOT NULL DEFAULT 'CRITICAL_ACTIVE',
  created_seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, node_id),
  FOREIGN KEY (tenant_id, created_seq) REFERENCES event(tenant_id, seq)
);

CREATE TABLE IF NOT EXISTS revision (
  tenant_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  priority_tier TEXT NOT NULL DEFAULT 'CRITICAL_ACTIVE',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  epistemic_level TEXT NOT NULL DEFAULT 'user_claim',
  valid_from TEXT,
  valid_to TEXT,
  known_from_seq INTEGER NOT NULL,
  known_to_seq INTEGER,
  date_precision TEXT NOT NULL DEFAULT 'unknown',
  due_at TEXT,
  has_legal_consequence INTEGER NOT NULL DEFAULT 0,
  reopen_condition TEXT,
  wake_cues_json TEXT NOT NULL DEFAULT '[]',
  auto_expire_at TEXT,
  owner_id TEXT,
  confirm_timestamps_json TEXT NOT NULL DEFAULT '[]',
  last_asked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, node_id, rev),
  FOREIGN KEY (tenant_id, node_id) REFERENCES node(tenant_id, node_id),
  FOREIGN KEY (tenant_id, known_from_seq) REFERENCES event(tenant_id, seq)
);

CREATE TABLE IF NOT EXISTS edge (
  tenant_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  src_node_id TEXT NOT NULL,
  dst_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  reason TEXT NOT NULL DEFAULT '',
  valid_from TEXT,
  valid_to TEXT,
  known_from_seq INTEGER NOT NULL,
  known_to_seq INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, edge_id),
  FOREIGN KEY (tenant_id, src_node_id) REFERENCES node(tenant_id, node_id),
  FOREIGN KEY (tenant_id, dst_node_id) REFERENCES node(tenant_id, node_id),
  FOREIGN KEY (tenant_id, known_from_seq) REFERENCES event(tenant_id, seq)
);

CREATE TABLE IF NOT EXISTS support (
  tenant_id TEXT NOT NULL,
  support_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_rev INTEGER NOT NULL DEFAULT 1,
  source_seq INTEGER NOT NULL,
  excerpt_ref TEXT NOT NULL DEFAULT '',
  extractor_version TEXT NOT NULL DEFAULT 'v1',
  source_type TEXT NOT NULL DEFAULT 'user_msg',
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, support_id),
  FOREIGN KEY (tenant_id, source_seq) REFERENCES event(tenant_id, seq)
);

CREATE TABLE IF NOT EXISTS peer_style (
  tenant_id TEXT NOT NULL,
  speaker_id TEXT NOT NULL,
  speaker_name TEXT NOT NULL DEFAULT '',
  role_archetype TEXT NOT NULL DEFAULT 'unknown',
  stable_traits_json TEXT NOT NULL DEFAULT '{}',
  transient_state_json TEXT NOT NULL DEFAULT '{}',
  tech_env_json TEXT NOT NULL DEFAULT '{}',
  cadence_json TEXT NOT NULL DEFAULT '{}',
  updated_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, speaker_id)
);

CREATE TABLE IF NOT EXISTS sleep_run (
  tenant_id TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  as_of_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (tenant_id, job_kind, as_of_seq)
);

CREATE INDEX IF NOT EXISTS idx_event_tenant_chat ON event(tenant_id, chat_id, seq);
CREATE INDEX IF NOT EXISTS idx_artifact_tenant_sha ON artifact(tenant_id, sha256);
CREATE INDEX IF NOT EXISTS idx_node_tenant_bkey ON node(tenant_id, business_key);
CREATE INDEX IF NOT EXISTS idx_node_tenant_tier ON node(tenant_id, priority_tier, kind);
CREATE INDEX IF NOT EXISTS idx_rev_lookup ON revision(tenant_id, node_id, known_from_seq, known_to_seq);
CREATE INDEX IF NOT EXISTS idx_rev_open_due ON revision(tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_edge_src ON edge(tenant_id, src_node_id, edge_type, known_from_seq);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(tenant_id, dst_node_id, edge_type, known_from_seq);
CREATE INDEX IF NOT EXISTS idx_support_target ON support(tenant_id, target_kind, target_id, target_rev);

CREATE VIRTUAL TABLE IF NOT EXISTS continuity_fts USING fts5(
  tenant_id UNINDEXED,
  doc_kind UNINDEXED,
  doc_id UNINDEXED,
  source_seq UNINDEXED,
  content
);
`;

export function sanitizeFtsQuery(raw) {
  const tokens = String(raw || '')
    .replace(/["'`*():^~\\{}[\]]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  if (!tokens.length) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

// ACT-R Base-Level Activation computed STRICTLY on independent human/evidence confirmations
// (NEVER bot self-mentions!), capped at 10.0, used ONLY as a tie-breaker after mandatory B-tree fetch.
export function computeActrScore(confirmTimestamps = [], nowMs = Date.now()) {
  if (!Array.isArray(confirmTimestamps) || !confirmTimestamps.length) return 0;
  let sum = 0;
  for (const ts of confirmTimestamps) {
    const ms = typeof ts === 'number' ? ts : Date.parse(String(ts || ''));
    if (!Number.isFinite(ms)) continue;
    const ageDays = Math.max(0, (nowMs - ms) / 86_400_000);
    sum += Math.pow(1 + ageDays, -0.5);
  }
  return Math.min(10, Number(Math.log(1 + sum).toFixed(4)));
}

function parseJsonSafe(str, fallback) {
  if (typeof str !== 'string' || !str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function assertTenantId(tenantId) {
  const t = String(tenantId || '').trim();
  if (!t) throw new Error('tenantId is required for strict multi-tenant isolation');
  return t;
}

export function createBiTemporalLedgerStore({
  storage = null,
  dbPath = ':memory:',
  now = () => new Date().toISOString(),
} = {}) {
  const adapter = storage || createSqliteStorageAdapter({ dbPath });
  const ownsAdapter = !storage;
  adapter.exec(SCHEMA_SQL);

  const stmts = {
    maxSeq: adapter.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM event WHERE tenant_id = ?'),
    findEventByUpdate: adapter.prepare(
      'SELECT * FROM event WHERE tenant_id = ? AND channel = ? AND source_update_id = ?'
    ),
    getEvent: adapter.prepare('SELECT * FROM event WHERE tenant_id = ? AND seq = ?'),
    insertEvent: adapter.prepare(`
      INSERT INTO event (
        tenant_id, seq, channel, source_update_id, chat_id, thread_id, message_id,
        sender_id, sender_name, sender_role, reply_to_id, event_type,
        occurred_at, received_at, body, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listEvents: adapter.prepare(
      'SELECT * FROM event WHERE tenant_id = ? AND seq <= ? ORDER BY seq ASC LIMIT ? OFFSET ?'
    ),
    recentEvents: adapter.prepare(
      'SELECT * FROM event WHERE tenant_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?'
    ),
    recentEventsByChat: adapter.prepare(
      'SELECT * FROM event WHERE tenant_id = ? AND chat_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?'
    ),
    insertFts: adapter.prepare(
      'INSERT INTO continuity_fts (tenant_id, doc_kind, doc_id, source_seq, content) VALUES (?, ?, ?, ?, ?)'
    ),
    deleteFtsDoc: adapter.prepare(
      'DELETE FROM continuity_fts WHERE tenant_id = ? AND doc_kind = ? AND doc_id = ?'
    ),
    searchFts: adapter.prepare(`
      SELECT doc_kind, doc_id, source_seq, content, bm25(continuity_fts) AS rank
      FROM continuity_fts
      WHERE continuity_fts MATCH ? AND tenant_id = ? AND CAST(source_seq AS INTEGER) <= ?
      ORDER BY rank ASC
      LIMIT ?
    `),
    insertArtifact: adapter.prepare(`
      INSERT INTO artifact (
        tenant_id, artifact_id, source_seq, sha256, blob_path, download_status,
        mime, ocr_version, ocr_text, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    findArtifactBySha: adapter.prepare(
      'SELECT * FROM artifact WHERE tenant_id = ? AND sha256 = ? ORDER BY source_seq ASC LIMIT 1'
    ),
    listArtifacts: adapter.prepare(
      'SELECT * FROM artifact WHERE tenant_id = ? AND source_seq <= ? ORDER BY source_seq DESC LIMIT ?'
    ),
    getNode: adapter.prepare('SELECT * FROM node WHERE tenant_id = ? AND node_id = ?'),
    findNodeByBusinessKey: adapter.prepare(
      'SELECT * FROM node WHERE tenant_id = ? AND business_key = ? LIMIT 1'
    ),
    insertNode: adapter.prepare(`
      INSERT INTO node (tenant_id, node_id, kind, business_key, priority_tier, created_seq, updated_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updateNodeMeta: adapter.prepare(`
      UPDATE node SET priority_tier = ?, business_key = COALESCE(?, business_key), updated_seq = ?
      WHERE tenant_id = ? AND node_id = ?
    `),
    maxRev: adapter.prepare(
      'SELECT COALESCE(MAX(rev), 0) AS max_rev FROM revision WHERE tenant_id = ? AND node_id = ?'
    ),
    closeOpenRevision: adapter.prepare(`
      UPDATE revision SET known_to_seq = ?
      WHERE tenant_id = ? AND node_id = ? AND known_to_seq IS NULL
    `),
    insertRevision: adapter.prepare(`
      INSERT INTO revision (
        tenant_id, node_id, rev, priority_tier, title, summary, payload_json, status, epistemic_level,
        valid_from, valid_to, known_from_seq, known_to_seq, date_precision, due_at,
        has_legal_consequence, reopen_condition, wake_cues_json, auto_expire_at,
        owner_id, confirm_timestamps_json, last_asked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getRevisionAtSeq: adapter.prepare(`
      SELECT r.*, n.kind, n.business_key, n.created_seq, n.updated_seq
      FROM revision r
      JOIN node n ON n.tenant_id = r.tenant_id AND n.node_id = r.node_id
      WHERE r.tenant_id = ? AND r.node_id = ?
        AND r.known_from_seq <= ?
        AND (r.known_to_seq IS NULL OR r.known_to_seq > ?)
      ORDER BY r.rev DESC
      LIMIT 1
    `),
    listRevisionsAtSeq: adapter.prepare(`
      SELECT r.*, n.kind, n.business_key, n.created_seq, n.updated_seq
      FROM revision r
      JOIN node n ON n.tenant_id = r.tenant_id AND n.node_id = r.node_id
      WHERE r.tenant_id = ?
        AND r.known_from_seq <= ?
        AND (r.known_to_seq IS NULL OR r.known_to_seq > ?)
      ORDER BY r.known_from_seq DESC, r.rev DESC
    `),
    insertEdge: adapter.prepare(`
      INSERT INTO edge (
        tenant_id, edge_id, src_node_id, dst_node_id, edge_type, status, reason,
        valid_from, valid_to, known_from_seq, known_to_seq, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    closeEdge: adapter.prepare(
      'UPDATE edge SET known_to_seq = ?, status = ? WHERE tenant_id = ? AND edge_id = ? AND known_to_seq IS NULL'
    ),
    listEdgesForNode: adapter.prepare(`
      SELECT * FROM edge
      WHERE tenant_id = ?
        AND (src_node_id = ? OR dst_node_id = ?)
        AND known_from_seq <= ?
        AND (known_to_seq IS NULL OR known_to_seq > ?)
    `),
    listAllActiveEdges: adapter.prepare(`
      SELECT * FROM edge
      WHERE tenant_id = ?
        AND known_from_seq <= ?
        AND (known_to_seq IS NULL OR known_to_seq > ?)
    `),
    insertSupport: adapter.prepare(`
      INSERT INTO support (
        tenant_id, support_id, target_kind, target_id, target_rev,
        source_seq, excerpt_ref, extractor_version, source_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listSupportsForTarget: adapter.prepare(`
      SELECT * FROM support
      WHERE tenant_id = ? AND target_kind = ? AND target_id = ? AND target_rev = ?
      ORDER BY source_seq ASC
    `),
  };

  function getHeadSeq(tenantId) {
    const t = assertTenantId(tenantId);
    const row = stmts.maxSeq.get(t);
    return Number(row?.max_seq || 0);
  }

  function hydrateEvent(row) {
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      seq: Number(row.seq),
      channel: row.channel,
      sourceUpdateId: row.source_update_id,
      chatId: row.chat_id,
      threadId: row.thread_id,
      messageId: row.message_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      senderRole: row.sender_role,
      replyToId: row.reply_to_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      body: row.body,
      payload: parseJsonSafe(row.payload_json, {}),
    };
  }

  function hydrateNodeRev(row) {
    if (!row) return null;
    const confirmTimestamps = parseJsonSafe(row.confirm_timestamps_json, []);
    const supports = stmts.listSupportsForTarget.all(
      row.tenant_id,
      'revision',
      row.node_id,
      Number(row.rev)
    ).map((s) => ({
      supportId: s.support_id,
      sourceSeq: Number(s.source_seq),
      excerptRef: s.excerpt_ref,
      extractorVersion: s.extractor_version,
      sourceType: s.source_type,
      createdAt: s.created_at,
    }));
    return {
      tenantId: row.tenant_id,
      nodeId: row.node_id,
      rev: Number(row.rev),
      kind: row.kind,
      businessKey: row.business_key,
      priorityTier: row.priority_tier,
      title: row.title,
      summary: row.summary,
      payload: parseJsonSafe(row.payload_json, {}),
      status: row.status,
      epistemicLevel: row.epistemic_level,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      knownFromSeq: Number(row.known_from_seq),
      knownToSeq: row.known_to_seq != null ? Number(row.known_to_seq) : null,
      datePrecision: row.date_precision,
      dueAt: row.due_at,
      hasLegalConsequence: Boolean(row.has_legal_consequence),
      reopenCondition: row.reopen_condition,
      wakeCues: parseJsonSafe(row.wake_cues_json, []),
      autoExpireAt: row.auto_expire_at,
      ownerId: row.owner_id,
      confirmTimestamps,
      lastAskedAt: row.last_asked_at,
      createdSeq: Number(row.created_seq),
      updatedSeq: Number(row.updated_seq),
      createdAt: row.created_at,
      supports,
    };
  }

  function appendEvent(tenantId, ev = {}) {
    const t = assertTenantId(tenantId);
    const channel = String(ev.channel || 'chat');
    const sourceUpdateId = String(
      ev.sourceUpdateId || ev.sourceKey || `auto:${Date.now()}:${crypto.randomBytes(6).toString('hex')}`
    );
    const receivedAt = String(ev.receivedAt || now());
    const occurredAt = String(ev.occurredAt || receivedAt);
    const body = String(ev.body ?? ev.text ?? '').trim();

    return adapter.transaction(() => {
      const existing = stmts.findEventByUpdate.get(t, channel, sourceUpdateId);
      if (existing) {
        return {
          appended: false,
          duplicate: true,
          event: hydrateEvent(existing),
          headSeq: getHeadSeq(t),
        };
      }
      const nextSeq = getHeadSeq(t) + 1;
      stmts.insertEvent.run(
        t,
        nextSeq,
        channel,
        sourceUpdateId,
        ev.chatId != null ? String(ev.chatId) : null,
        ev.threadId != null ? String(ev.threadId) : null,
        ev.messageId != null ? String(ev.messageId) : null,
        ev.senderId != null ? String(ev.senderId) : null,
        ev.senderName != null ? String(ev.senderName) : null,
        ev.senderRole != null ? String(ev.senderRole) : null,
        ev.replyToId != null ? String(ev.replyToId) : null,
        String(ev.eventType || ev.kind || 'user_msg'),
        occurredAt,
        receivedAt,
        body,
        JSON.stringify(ev.payload || {})
      );
      if (body) {
        stmts.insertFts.run(t, 'event', String(nextSeq), String(nextSeq), body);
      }
      const inserted = stmts.getEvent.get(t, nextSeq);
      return {
        appended: true,
        duplicate: false,
        event: hydrateEvent(inserted),
        headSeq: nextSeq,
      };
    });
  }

  function recordArtifact(tenantId, art = {}) {
    const t = assertTenantId(tenantId);
    const sourceSeq = Number(art.sourceSeq);
    if (!Number.isInteger(sourceSeq) || sourceSeq <= 0) {
      throw new Error('recordArtifact requires a valid positive integer sourceSeq');
    }
    const sha256 = String(art.sha256 || crypto.createHash('sha256').update(String(art.ocrText || art.blobPath || Date.now())).digest('hex'));
    const artifactId = String(art.artifactId || `art_${sha256.slice(0, 12)}_${sourceSeq}`);
    const ocrText = String(art.ocrText || '').trim();
    const createdAt = String(art.createdAt || now());

    return adapter.transaction(() => {
      const prior = stmts.findArtifactBySha.get(t, sha256);
      const blobPath = art.blobPath || prior?.blob_path || null;
      const reusedBlob = Boolean(prior && prior.blob_path && blobPath === prior.blob_path);
      stmts.insertArtifact.run(
        t,
        artifactId,
        sourceSeq,
        sha256,
        blobPath,
        String(art.downloadStatus || (blobPath ? 'ready' : 'missing_original')),
        art.mime ? String(art.mime) : null,
        art.ocrVersion ? String(art.ocrVersion) : null,
        ocrText,
        JSON.stringify(art.metadata || {}),
        createdAt
      );
      if (ocrText) {
        stmts.insertFts.run(t, 'artifact', artifactId, String(sourceSeq), ocrText);
      }
      return {
        artifactId,
        sha256,
        blobPath,
        reusedBlob,
        duplicateOfArtifactId: prior ? prior.artifact_id : null,
      };
    });
  }

  function validateSupports(tenantId, supports, epistemicLevel = null) {
    if (!Array.isArray(supports) || !supports.length) {
      const err = new Error('PROVENANCE_REQUIRED: Every revision or edge must cite at least one support source_seq');
      err.code = 'PROVENANCE_REQUIRED';
      throw err;
    }
    for (const s of supports) {
      const seq = Number(s?.sourceSeq);
      if (!Number.isInteger(seq) || seq <= 0) {
        const err = new Error('PROVENANCE_INVALID_SEQ: Support requires valid positive sourceSeq');
        err.code = 'PROVENANCE_INVALID_SEQ';
        throw err;
      }
      const ev = stmts.getEvent.get(tenantId, seq);
      if (!ev) {
        const err = new Error(`PROVENANCE_MISSING_EVENT: sourceSeq ${seq} does not exist in tenant ${tenantId}`);
        err.code = 'PROVENANCE_MISSING_EVENT';
        throw err;
      }
    }
    // Hard Epistemic Separation: a raw user_claim alone CANNOT mark an obligation as `business_settlement`!
    if (epistemicLevel === 'business_settlement') {
      const hasStrongProof = supports.some((s) => {
        const st = String(s?.sourceType || 'user_msg');
        return st === 'document' || st === 'ocr' || st === 'tool_output' || st === 'verified_ledger';
      });
      if (!hasStrongProof) {
        const err = new Error(
          'EPISTEMIC_VIOLATION: business_settlement requires document, ocr, tool_output, or verified_ledger support (user_claim is insufficient)'
        );
        err.code = 'EPISTEMIC_VIOLATION';
        throw err;
      }
    }
  }

  function upsertNodeRevision(tenantId, spec = {}) {
    const t = assertTenantId(tenantId);
    const kind = NODE_KINDS.includes(spec.kind) ? spec.kind : 'workstream';
    const priorityTier = PRIORITY_TIERS.includes(spec.priorityTier) ? spec.priorityTier : 'CRITICAL_ACTIVE';
    const epistemicLevel = EPISTEMIC_LEVELS.includes(spec.epistemicLevel) ? spec.epistemicLevel : 'user_claim';
    const knownFromSeq = Number(spec.knownFromSeq || getHeadSeq(t));
    const supports = spec.supports || [];
    const createdAt = String(spec.createdAt || now());

    return adapter.transaction(() => {
      validateSupports(t, supports, epistemicLevel);
      if (!stmts.getEvent.get(t, knownFromSeq)) {
        throw new Error(`knownFromSeq ${knownFromSeq} does not exist in tenant ${t}`);
      }
      let nodeId = spec.nodeId ? String(spec.nodeId) : null;
      if (!nodeId && spec.businessKey) {
        const found = stmts.findNodeByBusinessKey.get(t, String(spec.businessKey));
        if (found) nodeId = found.node_id;
      }
      if (!nodeId) {
        nodeId = `${kind}_${crypto.randomBytes(6).toString('hex')}`;
      }

      const existingNode = stmts.getNode.get(t, nodeId);
      if (!existingNode) {
        stmts.insertNode.run(
          t,
          nodeId,
          kind,
          spec.businessKey ? String(spec.businessKey) : null,
          priorityTier,
          knownFromSeq,
          knownFromSeq
        );
      } else {
        stmts.updateNodeMeta.run(
          priorityTier,
          spec.businessKey ? String(spec.businessKey) : null,
          Math.max(Number(existingNode.updated_seq || 0), knownFromSeq),
          t,
          nodeId
        );
      }

      const prevRev = Number(stmts.maxRev.get(t, nodeId)?.max_rev || 0);
      const prevRow = prevRev > 0 ? stmts.getRevisionAtSeq.get(t, nodeId, knownFromSeq, knownFromSeq) : null;
      const nextRev = prevRev + 1;
      if (prevRev > 0) {
        stmts.closeOpenRevision.run(knownFromSeq, t, nodeId);
      }

      // Independent confirmation timestamps (ONLY human/evidence confirmations — NEVER bot self-mentions!)
      const prevConfirms = prevRow ? parseJsonSafe(prevRow.confirm_timestamps_json, []) : [];
      const mergedConfirms = [...prevConfirms];
      if (spec.independentConfirm !== false) {
        const confirmTs = String(spec.confirmAt || createdAt);
        if (!mergedConfirms.includes(confirmTs)) mergedConfirms.push(confirmTs);
      }

      const wakeCues = Array.isArray(spec.wakeCues)
        ? [...new Set(spec.wakeCues.map((c) => String(c || '').trim()).filter(Boolean))]
        : (prevRow ? parseJsonSafe(prevRow.wake_cues_json, []) : []);

      const hasLegal = spec.hasLegalConsequence !== undefined
        ? (spec.hasLegalConsequence ? 1 : 0)
        : (prevRow ? Number(prevRow.has_legal_consequence || 0) : (priorityTier === 'STATUTORY_PENALTY' ? 1 : 0));

      const title = String(spec.title ?? prevRow?.title ?? '').trim();
      const summary = String(spec.summary ?? prevRow?.summary ?? '').trim();

      stmts.insertRevision.run(
        t,
        nodeId,
        nextRev,
        priorityTier,
        title,
        summary,
        JSON.stringify(spec.payload ?? (prevRow ? parseJsonSafe(prevRow.payload_json, {}) : {})),
        String(spec.status ?? prevRow?.status ?? 'open'),
        epistemicLevel,
        spec.validFrom !== undefined ? spec.validFrom : (prevRow?.valid_from ?? null),
        spec.validTo !== undefined ? spec.validTo : (prevRow?.valid_to ?? null),
        knownFromSeq,
        null,
        String(spec.datePrecision ?? prevRow?.date_precision ?? (spec.validFrom ? 'day' : 'unknown')),
        spec.dueAt !== undefined ? spec.dueAt : (prevRow?.due_at ?? null),
        hasLegal,
        spec.reopenCondition !== undefined ? spec.reopenCondition : (prevRow?.reopen_condition ?? null),
        JSON.stringify(wakeCues),
        spec.autoExpireAt !== undefined ? spec.autoExpireAt : (prevRow?.auto_expire_at ?? null),
        spec.ownerId !== undefined ? spec.ownerId : (prevRow?.owner_id ?? null),
        JSON.stringify(mergedConfirms),
        spec.lastAskedAt !== undefined ? spec.lastAskedAt : (prevRow?.last_asked_at ?? null),
        createdAt
      );

      for (const s of supports) {
        stmts.insertSupport.run(
          t,
          `sup_${crypto.randomBytes(6).toString('hex')}`,
          'revision',
          nodeId,
          nextRev,
          Number(s.sourceSeq),
          String(s.excerptRef || ''),
          String(s.extractorVersion || 'v1'),
          String(s.sourceType || 'user_msg'),
          createdAt
        );
      }

      // Refresh node FTS entry with latest revision content tagged at `knownFromSeq`
      const ftsText = [title, summary, spec.businessKey || '', wakeCues.join(' ')].filter(Boolean).join(' ');
      if (ftsText) {
        stmts.deleteFtsDoc.run(t, 'node', nodeId);
        stmts.insertFts.run(t, 'node', nodeId, String(knownFromSeq), ftsText);
      }

      return hydrateNodeRev(stmts.getRevisionAtSeq.get(t, nodeId, knownFromSeq, knownFromSeq));
    });
  }

  function addEdge(tenantId, spec = {}) {
    const t = assertTenantId(tenantId);
    const edgeType = EDGE_TYPES.includes(spec.edgeType) ? spec.edgeType : 'supports';
    const knownFromSeq = Number(spec.knownFromSeq || getHeadSeq(t));
    const supports = spec.supports || [];
    const createdAt = String(spec.createdAt || now());
    const edgeId = String(spec.edgeId || `edge_${crypto.randomBytes(6).toString('hex')}`);

    return adapter.transaction(() => {
      validateSupports(t, supports, null);
      if (!stmts.getNode.get(t, String(spec.srcNodeId)) || !stmts.getNode.get(t, String(spec.dstNodeId))) {
        throw new Error('EDGE_ENDPOINT_MISSING: Both srcNodeId and dstNodeId must exist in the same tenant');
      }
      stmts.insertEdge.run(
        t,
        edgeId,
        String(spec.srcNodeId),
        String(spec.dstNodeId),
        edgeType,
        String(spec.status || (edgeType === 'may_match' ? 'candidate' : 'active')),
        String(spec.reason || ''),
        spec.validFrom ?? null,
        spec.validTo ?? null,
        knownFromSeq,
        null,
        createdAt
      );
      for (const s of supports) {
        stmts.insertSupport.run(
          t,
          `sup_${crypto.randomBytes(6).toString('hex')}`,
          'edge',
          edgeId,
          1,
          Number(s.sourceSeq),
          String(s.excerptRef || ''),
          String(s.extractorVersion || 'v1'),
          String(s.sourceType || 'user_msg'),
          createdAt
        );
      }
      return {
        tenantId: t,
        edgeId,
        srcNodeId: String(spec.srcNodeId),
        dstNodeId: String(spec.dstNodeId),
        edgeType,
        status: String(spec.status || (edgeType === 'may_match' ? 'candidate' : 'active')),
        reason: String(spec.reason || ''),
        knownFromSeq,
      };
    });
  }

  function closeEdge(tenantId, edgeId, { asOfSeq = null, status = 'superseded' } = {}) {
    const t = assertTenantId(tenantId);
    const seq = Number(asOfSeq || getHeadSeq(t));
    stmts.closeEdge.run(seq, String(status), t, String(edgeId));
  }

  function isWithinValidWindow(row, validAt) {
    if (!validAt) return true;
    const target = String(validAt);
    if (row.valid_from && String(row.valid_from) > target) return false;
    if (row.valid_to && String(row.valid_to) <= target) return false;
    return true;
  }

  function getNodeAt(tenantId, nodeId, { asOfSeq = null, validAt = null } = {}) {
    const t = assertTenantId(tenantId);
    const seq = asOfSeq != null ? Number(asOfSeq) : getHeadSeq(t);
    const row = stmts.getRevisionAtSeq.get(t, String(nodeId), seq, seq);
    if (!row || !isWithinValidWindow(row, validAt)) return null;
    return hydrateNodeRev(row);
  }

  function listNodes(tenantId, {
    asOfSeq = null,
    validAt = null,
    kinds = null,
    tiers = null,
    statuses = null,
    excludeStatuses = null,
  } = {}) {
    const t = assertTenantId(tenantId);
    const seq = asOfSeq != null ? Number(asOfSeq) : getHeadSeq(t);
    const rows = stmts.listRevisionsAtSeq.all(t, seq, seq);
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (seen.has(r.node_id)) continue;
      seen.add(r.node_id);
      if (!isWithinValidWindow(r, validAt)) continue;
      if (Array.isArray(kinds) && kinds.length && !kinds.includes(r.kind)) continue;
      if (Array.isArray(tiers) && tiers.length && !tiers.includes(r.priority_tier)) continue;
      if (Array.isArray(statuses) && statuses.length && !statuses.includes(r.status)) continue;
      if (Array.isArray(excludeStatuses) && excludeStatuses.length && excludeStatuses.includes(r.status)) continue;
      out.push(hydrateNodeRev(r));
    }
    return out;
  }

  function listEdges(tenantId, { asOfSeq = null, validAt = null, edgeTypes = null, statuses = null } = {}) {
    const t = assertTenantId(tenantId);
    const seq = asOfSeq != null ? Number(asOfSeq) : getHeadSeq(t);
    const rows = stmts.listAllActiveEdges.all(t, seq, seq);
    return rows
      .filter((e) => isWithinValidWindow(e, validAt))
      .filter((e) => (!Array.isArray(edgeTypes) || !edgeTypes.length || edgeTypes.includes(e.edge_type)))
      .filter((e) => (!Array.isArray(statuses) || !statuses.length || statuses.includes(e.status)))
      .map((e) => ({
        tenantId: e.tenant_id,
        edgeId: e.edge_id,
        srcNodeId: e.src_node_id,
        dstNodeId: e.dst_node_id,
        edgeType: e.edge_type,
        status: e.status,
        reason: e.reason,
        validFrom: e.valid_from,
        validTo: e.valid_to,
        knownFromSeq: Number(e.known_from_seq),
        knownToSeq: e.known_to_seq != null ? Number(e.known_to_seq) : null,
      }));
  }

  // 1-2 typed hops inside the SAME tenant (HippoRAG 2 principle without noisy global PPR!)
  function getNeighborhood(tenantId, seedNodeIds = [], { hops = 2, edgeTypes = null, asOfSeq = null, validAt = null } = {}) {
    const t = assertTenantId(tenantId);
    const seq = asOfSeq != null ? Number(asOfSeq) : getHeadSeq(t);
    const visitedNodes = new Map();
    const visitedEdges = new Map();
    let frontier = [...new Set(seedNodeIds.map(String).filter(Boolean))];

    for (const id of frontier) {
      const n = getNodeAt(t, id, { asOfSeq: seq, validAt });
      if (n) visitedNodes.set(id, { ...n, hopDistance: 0 });
    }

    const maxHops = Math.max(0, Math.min(3, Number(hops) || 2));
    for (let h = 1; h <= maxHops && frontier.length; h++) {
      const nextFrontier = [];
      for (const id of frontier) {
        const edges = stmts.listEdgesForNode.all(t, id, id, seq, seq);
        for (const e of edges) {
          if (!isWithinValidWindow(e, validAt)) continue;
          if (Array.isArray(edgeTypes) && edgeTypes.length && !edgeTypes.includes(e.edge_type)) continue;
          if (!visitedEdges.has(e.edge_id)) {
            visitedEdges.set(e.edge_id, {
              edgeId: e.edge_id,
              srcNodeId: e.src_node_id,
              dstNodeId: e.dst_node_id,
              edgeType: e.edge_type,
              status: e.status,
              reason: e.reason,
              knownFromSeq: Number(e.known_from_seq),
            });
          }
          const neighborId = e.src_node_id === id ? e.dst_node_id : e.src_node_id;
          if (!visitedNodes.has(neighborId)) {
            const neighbor = getNodeAt(t, neighborId, { asOfSeq: seq, validAt });
            if (neighbor) {
              visitedNodes.set(neighborId, { ...neighbor, hopDistance: h });
              nextFrontier.push(neighborId);
            }
          }
        }
      }
      frontier = nextFrontier;
    }

    return {
      nodes: [...visitedNodes.values()],
      edges: [...visitedEdges.values()],
    };
  }

  function searchFts(tenantId, query, { asOfSeq = null, limit = 12 } = {}) {
    const t = assertTenantId(tenantId);
    const seq = asOfSeq != null ? Number(asOfSeq) : getHeadSeq(t);
    const safeQ = sanitizeFtsQuery(query);
    if (!safeQ) return [];
    try {
      const rows = stmts.searchFts.all(safeQ, t, seq, Math.max(1, Math.min(50, Number(limit) || 12)));
      return rows.map((r) => ({
        docKind: r.doc_kind,
        docId: r.doc_id,
        sourceSeq: Number(r.source_seq),
        content: r.content,
        rank: Number(r.rank),
      }));
    } catch {
      return [];
    }
  }

  function listEvents(tenantId, { asOfSeq = null, limit = 100, offset = 0 } = {}) {
    const t = assertTenantId(tenantId);
    const seq = asOfSeq != null ? Number(asOfSeq) : getHeadSeq(t);
    return stmts.listEvents.all(t, seq, limit, offset).map(hydrateEvent);
  }

  function getRecentEvents(tenantId, { chatId = null, asOfSeq = null, limit = 15 } = {}) {
    const t = assertTenantId(tenantId);
    const seq = asOfSeq != null ? Number(asOfSeq) : getHeadSeq(t);
    const rows = chatId != null
      ? stmts.recentEventsByChat.all(t, String(chatId), seq, limit)
      : stmts.recentEvents.all(t, seq, limit);
    return rows.reverse().map(hydrateEvent);
  }

  function listArtifacts(tenantId, { asOfSeq = null, limit = 30 } = {}) {
    const t = assertTenantId(tenantId);
    const seq = asOfSeq != null ? Number(asOfSeq) : getHeadSeq(t);
    return stmts.listArtifacts.all(t, seq, limit).map((a) => ({
      tenantId: a.tenant_id,
      artifactId: a.artifact_id,
      sourceSeq: Number(a.source_seq),
      sha256: a.sha256,
      blobPath: a.blob_path,
      downloadStatus: a.download_status,
      mime: a.mime,
      ocrVersion: a.ocr_version,
      ocrText: a.ocr_text,
      metadata: parseJsonSafe(a.metadata_json, {}),
      createdAt: a.created_at,
    }));
  }

  function findNodeByBusinessKey(tenantId, businessKey, { asOfSeq = null, validAt = null } = {}) {
    const t = assertTenantId(tenantId);
    const row = stmts.findNodeByBusinessKey.get(t, String(businessKey || ''));
    if (!row) return null;
    return getNodeAt(t, row.node_id, { asOfSeq, validAt });
  }

  function close() {
    if (ownsAdapter) adapter.close();
  }

  return {
    storage: adapter,
    getHeadSeq,
    appendEvent,
    recordArtifact,
    upsertNodeRevision,
    addEdge,
    closeEdge,
    getNodeAt,
    findNodeByBusinessKey,
    listNodes,
    listEdges,
    getNeighborhood,
    searchFts,
    listEvents,
    getRecentEvents,
    listArtifacts,
    backupTo: (dest) => adapter.backupTo(dest),
    verifyIntegrity: () => adapter.verifyIntegrity(),
    close,
  };
}
