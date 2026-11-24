// SCROLL 2.6 -- Content-addressed promotion lifecycle (`stage -> gate -> shadow -> promote -> rollback`).
// Zero-dep, pure ASCII, Node >= 20.
//
// Provides atomic, SHA-256 verified promotion of knowledge snapshots, domain packs, or prompt
// artifacts so unverified automated updates can never silently overwrite live state.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomicJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function hashSnapshotDir(rootDir) {
  const resolved = path.resolve(String(rootDir || ''));
  if (!fs.existsSync(resolved)) {
    throw new Error(`snapshot_dir_not_found:${resolved}`);
  }
  const files = [];
  (function walk(dir, relBase) {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) files.push({ full, rel });
    }
  })(resolved, '');

  const h = crypto.createHash('sha256');
  let totalBytes = 0;
  const manifestFiles = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const fileSha = crypto.createHash('sha256').update(buf).digest('hex');
    h.update(`${f.rel}\0${fileSha}\n`);
    totalBytes += buf.length;
    manifestFiles.push({ path: f.rel, bytes: buf.length, sha256: fileSha });
  }
  return {
    rootDir: resolved,
    sha256: h.digest('hex'),
    fileCount: files.length,
    totalBytes,
    files: manifestFiles,
  };
}

function promotionPaths(stateDir) {
  const root = path.join(path.resolve(stateDir), 'promotions');
  return {
    root,
    candidatesDir: path.join(root, 'candidates'),
    activeManifest: path.join(root, 'active_manifest.json'),
    historyLog: path.join(root, 'history.jsonl'),
  };
}

function candidateFile(stateDir, candidateId) {
  const safeId = String(candidateId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safeId) throw new Error('invalid_candidate_id');
  return path.join(promotionPaths(stateDir).candidatesDir, `${safeId}.json`);
}

function appendHistory(stateDir, entry) {
  const p = promotionPaths(stateDir);
  ensureDir(p.root);
  fs.appendFileSync(p.historyLog, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function stageCandidate({
  stateDir,
  candidateId = null,
  snapshotDir,
  metadata = {},
  now = new Date(),
} = {}) {
  const digest = hashSnapshotDir(snapshotDir);
  const id = candidateId || `cand-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${digest.sha256.slice(0, 10)}`;
  const record = {
    schema: 'scroll-promotion-candidate/v1',
    candidateId: id,
    status: 'staged',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    snapshotDir: digest.rootDir,
    sha256: digest.sha256,
    fileCount: digest.fileCount,
    totalBytes: digest.totalBytes,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    gate: null,
    shadow: null,
    promotedAt: null,
  };
  writeAtomicJson(candidateFile(stateDir, id), record);
  appendHistory(stateDir, { ts: now.toISOString(), event: 'staged', candidateId: id, sha256: digest.sha256 });
  return { ok: true, candidate: record };
}

export function recordGateResult({
  stateDir,
  candidateId,
  evalReport,
  mutationReport = null,
  requireMutationKill = true,
  minPassRate = 0.95,
  maxRegressions = 0,
  now = new Date(),
} = {}) {
  const fp = candidateFile(stateDir, candidateId);
  const rec = readJsonSafe(fp);
  if (!rec) return { ok: false, error: `candidate_not_found:${candidateId}` };

  // Re-verify snapshot immutability before grading
  const liveDigest = hashSnapshotDir(rec.snapshotDir);
  if (liveDigest.sha256 !== rec.sha256) {
    rec.status = 'gated_fail';
    rec.updatedAt = now.toISOString();
    rec.gate = { ok: false, reasons: ['snapshot_hash_mismatch_after_stage'], checkedAt: now.toISOString() };
    writeAtomicJson(fp, rec);
    return { ok: false, error: 'snapshot_hash_mismatch_after_stage', candidate: rec };
  }

  const reasons = [];
  if (!evalReport || typeof evalReport !== 'object') {
    reasons.push('missing_eval_report');
  } else {
    if (evalReport.ok !== true) reasons.push('eval_report_not_ok');
    const passRate = evalReport.passRate != null
      ? Number(evalReport.passRate)
      : (evalReport.total > 0 ? Number(evalReport.passed || 0) / Number(evalReport.total) : 0);
    if (passRate < minPassRate) reasons.push(`pass_rate_below_threshold:${passRate.toFixed(4)}<${minPassRate}`);
    if (Number(evalReport.regressions || 0) > maxRegressions) {
      reasons.push(`regressions_exceeded:${evalReport.regressions}>${maxRegressions}`);
    }
    if (evalReport.p0PassRate != null && Number(evalReport.p0PassRate) < 1.0) {
      reasons.push(`p0_pass_rate_below_1:${evalReport.p0PassRate}`);
    }
  }

  if (requireMutationKill) {
    if (!mutationReport || typeof mutationReport !== 'object') {
      reasons.push('missing_mutation_report');
    } else if (mutationReport.ok !== true || Number(mutationReport.killRate || 0) < 1.0) {
      reasons.push(`mutation_kill_incomplete:${mutationReport.killed || 0}/${mutationReport.total || 0}`);
    }
  }

  const passed = reasons.length === 0;
  rec.status = passed ? 'gated_pass' : 'gated_fail';
  rec.updatedAt = now.toISOString();
  rec.gate = {
    ok: passed,
    checkedAt: now.toISOString(),
    reasons,
    evalSummary: evalReport ? {
      ok: Boolean(evalReport.ok),
      passed: Number(evalReport.passed || 0),
      total: Number(evalReport.total || 0),
      passRate: evalReport.passRate != null ? Number(evalReport.passRate) : null,
      p0PassRate: evalReport.p0PassRate != null ? Number(evalReport.p0PassRate) : null,
      regressions: Number(evalReport.regressions || 0),
    } : null,
    mutationSummary: mutationReport ? {
      ok: Boolean(mutationReport.ok),
      killed: Number(mutationReport.killed || 0),
      total: Number(mutationReport.total || 0),
      killRate: Number(mutationReport.killRate || 0),
    } : null,
  };
  writeAtomicJson(fp, rec);
  appendHistory(stateDir, { ts: now.toISOString(), event: rec.status, candidateId: rec.candidateId, sha256: rec.sha256, reasons });
  return { ok: passed, candidate: rec, reasons };
}

export function startShadow({
  stateDir,
  candidateId,
  minShadowHours = 48,
  now = new Date(),
} = {}) {
  const fp = candidateFile(stateDir, candidateId);
  const rec = readJsonSafe(fp);
  if (!rec) return { ok: false, error: `candidate_not_found:${candidateId}` };
  if (rec.status !== 'gated_pass') {
    return { ok: false, error: `cannot_shadow_from_status:${rec.status}` };
  }
  const minHours = Math.max(0, Number(minShadowHours));
  const readyAt = new Date(now.getTime() + minHours * 3_600_000).toISOString();
  rec.status = 'shadow';
  rec.updatedAt = now.toISOString();
  rec.shadow = {
    startedAt: now.toISOString(),
    minShadowHours: minHours,
    readyAt,
  };
  writeAtomicJson(fp, rec);
  appendHistory(stateDir, { ts: now.toISOString(), event: 'shadow_started', candidateId: rec.candidateId, readyAt });
  return { ok: true, candidate: rec };
}

export function getActiveManifest(stateDir) {
  return readJsonSafe(promotionPaths(stateDir).activeManifest);
}

export function promoteCandidate({
  stateDir,
  candidateId,
  allowBypassShadow = false,
  now = new Date(),
} = {}) {
  const fp = candidateFile(stateDir, candidateId);
  const rec = readJsonSafe(fp);
  if (!rec) return { ok: false, error: `candidate_not_found:${candidateId}` };

  if (rec.status !== 'shadow' && !(allowBypassShadow && rec.status === 'gated_pass')) {
    return { ok: false, error: `cannot_promote_from_status:${rec.status}` };
  }
  if (!rec.gate || rec.gate.ok !== true) {
    return { ok: false, error: 'gate_not_passed' };
  }
  if (rec.status === 'shadow' && !allowBypassShadow && rec.shadow?.readyAt) {
    if (now.getTime() < Date.parse(rec.shadow.readyAt)) {
      return { ok: false, error: `shadow_window_incomplete:ready_at_${rec.shadow.readyAt}` };
    }
  }

  // Verify snapshot hash one last time before atomic pointer flip
  const liveDigest = hashSnapshotDir(rec.snapshotDir);
  if (liveDigest.sha256 !== rec.sha256) {
    return { ok: false, error: 'snapshot_hash_mismatch_at_promote' };
  }

  const prev = getActiveManifest(stateDir);
  const manifest = {
    schema: 'scroll-active-manifest/v1',
    manifestId: `mf-${now.toISOString().replace(/[:.]/g, '-')}-${rec.sha256.slice(0, 8)}`,
    candidateId: rec.candidateId,
    snapshotDir: rec.snapshotDir,
    sha256: rec.sha256,
    fileCount: rec.fileCount,
    promotedAt: now.toISOString(),
    previousManifest: prev ? {
      manifestId: prev.manifestId,
      candidateId: prev.candidateId,
      snapshotDir: prev.snapshotDir,
      sha256: prev.sha256,
      promotedAt: prev.promotedAt,
    } : null,
  };

  writeAtomicJson(promotionPaths(stateDir).activeManifest, manifest);
  rec.status = 'promoted';
  rec.promotedAt = now.toISOString();
  rec.updatedAt = now.toISOString();
  writeAtomicJson(fp, rec);
  appendHistory(stateDir, {
    ts: now.toISOString(),
    event: 'promoted',
    manifestId: manifest.manifestId,
    candidateId: rec.candidateId,
    sha256: rec.sha256,
    previousCandidateId: prev?.candidateId || null,
  });
  return { ok: true, manifest, candidate: rec };
}

export function rollbackActive({
  stateDir,
  toCandidateId = null,
  now = new Date(),
} = {}) {
  const t0 = performance.now();
  const current = getActiveManifest(stateDir);
  if (!current) return { ok: false, error: 'no_active_manifest' };

  let target = null;
  if (toCandidateId) {
    const rec = readJsonSafe(candidateFile(stateDir, toCandidateId));
    if (!rec) return { ok: false, error: `candidate_not_found:${toCandidateId}` };
    target = {
      manifestId: `rb-${now.toISOString().replace(/[:.]/g, '-')}-${rec.sha256.slice(0, 8)}`,
      candidateId: rec.candidateId,
      snapshotDir: rec.snapshotDir,
      sha256: rec.sha256,
    };
  } else if (current.previousManifest) {
    target = current.previousManifest;
  } else {
    return { ok: false, error: 'no_previous_manifest_to_rollback' };
  }

  const liveDigest = hashSnapshotDir(target.snapshotDir);
  if (liveDigest.sha256 !== target.sha256) {
    return { ok: false, error: 'rollback_target_hash_mismatch' };
  }

  const restored = {
    schema: 'scroll-active-manifest/v1',
    manifestId: `rb-${now.toISOString().replace(/[:.]/g, '-')}-${target.sha256.slice(0, 8)}`,
    candidateId: target.candidateId,
    snapshotDir: target.snapshotDir,
    sha256: target.sha256,
    fileCount: liveDigest.fileCount,
    promotedAt: now.toISOString(),
    rolledBackFrom: current.candidateId,
    previousManifest: {
      manifestId: current.manifestId,
      candidateId: current.candidateId,
      snapshotDir: current.snapshotDir,
      sha256: current.sha256,
      promotedAt: current.promotedAt,
    },
  };
  writeAtomicJson(promotionPaths(stateDir).activeManifest, restored);
  const durationMs = +(performance.now() - t0).toFixed(3);
  appendHistory(stateDir, {
    ts: now.toISOString(),
    event: 'rolled_back',
    fromCandidateId: current.candidateId,
    toCandidateId: restored.candidateId,
    sha256: restored.sha256,
    durationMs,
  });
  return { ok: true, manifest: restored, durationMs };
}

export function listPromotions(stateDir) {
  const dir = promotionPaths(stateDir).candidatesDir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonSafe(path.join(dir, f)))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
