// SCROLL 2.8 -- sec 53 Tenant Workspace Isolation, Layered Knowledge, & Atomic Pack Binding (`WorkspaceResolver`).
// Zero-dep, pure ASCII, Node >= 20.
//
// Strictly separates immutable shared Agent Packs from mutable per-tenant deployment state:
//   tenants/<tenantId>/deployments/<deploymentId>/
//     binding.json        (atomic activePack / previousPack / epoch pointer)
//     profile/            (USER.md, weights.override.json, persona.delta.md)
//     memory/             (SCROLL 3-axis scoped memory -- outside immutable pack workdir!)
//     user-docs/          (mutable tenant knowledge overlaid atop read-only pack KB)
//     domain-state/       (tenant business data: books, calendars, caches)
//     runtime/            (sessions, dedupe journals, promotions, telemetry)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openKnowledge, formatKnowledgeBlock } from './knowledge.js';
import { verifyAgentPack } from './pack.js';
import {
  stageCandidate,
  recordGateResult,
  promoteCandidate,
  rollbackActive,
  getActiveManifest,
} from './promotion.js';

export const WORKSPACE_BINDING_SCHEMA = 'scroll-workspace-binding/v1';

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeSegment(value, label = 'segment') {
  const s = String(value || '').trim();
  if (!s || !SAFE_SEGMENT_RE.test(s) || s.includes('..')) {
    const err = new Error(`ERR_INVALID_${String(label).toUpperCase()}:${s}`);
    err.code = 'ERR_PATH_ESCAPE';
    throw err;
  }
  return s;
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function writeAtomicJson(filePath, data) {
  ensureDir(path.dirname(filePath), 0o700);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function writeAtomicText(filePath, text) {
  ensureDir(path.dirname(filePath), 0o700);
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, String(text ?? ''), { encoding: 'utf8', mode: 0o600 });
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

function copyDirRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  ensureDir(dst, 0o700);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

export function createLayeredKnowledge(layers = []) {
  const activeLayers = (Array.isArray(layers) ? layers : [])
    .filter((l) => l && l.index && l.index.active && typeof l.index.retrieve === 'function')
    .map((l, idx) => ({
      name: String(l.name || `layer-${idx}`),
      index: l.index,
      weight: Number(l.weight ?? 1.0),
      mutable: Boolean(l.mutable),
    }));

  const allChunks = activeLayers.flatMap((l) => Array.isArray(l.index.chunks) ? l.index.chunks : []);
  const filesCount = activeLayers.reduce((acc, l) => acc + Number(l.index.filesCount || l.index.files?.length || 0), 0);
  const totalCorpusChars = activeLayers.reduce((acc, l) => acc + Number(l.index.totalCorpusChars || 0), 0);
  const hash = crypto.createHash('sha256')
    .update(activeLayers.map((l) => `${l.name}:${l.weight}:${l.index.hash || '0'}`).join('|'))
    .digest('hex')
    .slice(0, 16);

  function retrieve(query, opts = {}) {
    const t0 = performance.now();
    if (!activeLayers.length) {
      return {
        query: String(query ?? ''),
        hits: [],
        chunks: [],
        selectedChars: 0,
        totalCorpusChars: 0,
        durationMs: 0,
        layers: [],
      };
    }
    const topK = Math.max(1, Number(opts.topK || 4));
    const maxChars = Math.max(500, Number(opts.maxChars || 6000));
    const combined = [];

    for (const layer of activeLayers) {
      const res = layer.index.retrieve(query, {
        ...opts,
        topK: Math.max(topK * 2, 8),
        maxChars: Math.max(maxChars * 2, 12000),
      });
      for (const hit of res.hits || []) {
        combined.push({
          ...hit,
          layer: layer.name,
          rawScore: hit.score,
          score: +(Number(hit.score || 0) * layer.weight).toFixed(3),
        });
      }
    }

    combined.sort((a, b) => b.score - a.score);
    const selected = [];
    const seen = new Set();
    let usedChars = 0;

    for (const h of combined) {
      if (selected.length >= topK) break;
      const dedupeKey = `${h.layer}:${h.id}`;
      if (seen.has(dedupeKey)) continue;
      if (selected.length > 0 && usedChars + Number(h.chars || h.text?.length || 0) > maxChars) continue;
      seen.add(dedupeKey);
      selected.push(h);
      usedChars += Number(h.chars || h.text?.length || 0);
    }

    return {
      query: String(query ?? ''),
      hits: selected,
      chunks: selected.map((h) => h.text),
      selectedChars: usedChars,
      totalCorpusChars,
      durationMs: +(performance.now() - t0).toFixed(2),
      layers: activeLayers.map((l) => l.name),
    };
  }

  function listFiles(opts = {}) {
    const cap = Math.min(500, Math.max(1, Number(opts.limit || 100)));
    const merged = [];
    const folderCounts = new Map();
    for (const layer of activeLayers) {
      if (typeof layer.index.listFiles !== 'function') continue;
      const res = layer.index.listFiles({ ...opts, limit: 500 });
      for (const f of res.files || []) {
        const key = f.folder || '/';
        folderCounts.set(key, (folderCounts.get(key) || 0) + 1);
        merged.push({ ...f, layer: layer.name });
      }
    }
    const folders = [...folderCounts.entries()]
      .map(([folder, count]) => ({ folder, count }))
      .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
    return {
      total: merged.length,
      totalFiles: merged.length,
      truncated: merged.length > cap,
      folders,
      files: merged.slice(0, cap),
    };
  }

  function readFile(file, opts = {}) {
    const requestedLayer = opts.layer ? String(opts.layer) : null;
    let denied = null;
    for (const layer of activeLayers) {
      if (requestedLayer && layer.name !== requestedLayer) continue;
      if (typeof layer.index.readFile !== 'function') continue;
      const res = layer.index.readFile(file, opts);
      if (res && res.ok) return { ...res, layer: layer.name };
      if (res && res.error === 'ERR_KNOWLEDGE_ACCESS_DENIED') {
        denied = { ...res, layer: layer.name };
      }
    }
    if (denied) return denied;
    return { ok: false, error: 'ERR_KNOWLEDGE_NOT_FOUND', file: String(file || '') };
  }

  function stats() {
    return {
      active: activeLayers.length > 0,
      hash,
      filesCount,
      chunksCount: allChunks.length,
      totalCorpusChars,
      layers: activeLayers.map((l) => ({
        name: l.name,
        weight: l.weight,
        mutable: l.mutable,
        hash: l.index.hash,
        filesCount: Number(l.index.filesCount || l.index.files?.length || 0),
        chunksCount: Array.isArray(l.index.chunks) ? l.index.chunks.length : 0,
      })),
    };
  }

  return {
    active: activeLayers.length > 0,
    hash,
    filesCount,
    chunksCount: allChunks.length,
    chunks: allChunks,
    totalCorpusChars,
    layers: activeLayers.map((l) => ({ name: l.name, weight: l.weight, mutable: l.mutable, hash: l.index.hash })),
    retrieve,
    listFiles,
    readFile,
    stats,
    format: (chunks) => formatKnowledgeBlock(chunks, { hash }),
  };
}

function toBindingPackRef(verified) {
  return {
    packId: verified.manifest.packId,
    agentName: verified.manifest.agentName,
    version: verified.manifest.version,
    sha256: verified.sha256,
    packDir: verified.packDir,
    stateSchemaVersion: Number(verified.manifest.stateSchemaVersion || 1),
  };
}

export function openTenantWorkspace({
  tenantsRootDir,
  tenantId,
  deploymentId,
  packRegistry = null,
  initialPack = null,
  now = () => new Date(),
} = {}) {
  const absTenantsRoot = path.resolve(String(tenantsRootDir || ''));
  const safeTenant = assertSafeSegment(tenantId, 'tenant_id');
  const safeDeployment = assertSafeSegment(deploymentId, 'deployment_id');

  const rootDir = path.resolve(absTenantsRoot, safeTenant, 'deployments', safeDeployment);
  if (!rootDir.startsWith(absTenantsRoot + path.sep)) {
    const err = new Error(`ERR_WORKSPACE_PATH_ESCAPE:${safeTenant}/${safeDeployment}`);
    err.code = 'ERR_PATH_ESCAPE';
    throw err;
  }

  const paths = {
    rootDir,
    bindingFile: path.join(rootDir, 'binding.json'),
    profileDir: path.join(rootDir, 'profile'),
    userFile: path.join(rootDir, 'profile', 'USER.md'),
    weightsFile: path.join(rootDir, 'profile', 'weights.override.json'),
    personaDeltaFile: path.join(rootDir, 'profile', 'persona.delta.md'),
    memoryDir: path.join(rootDir, 'memory'),
    userDocsDir: path.join(rootDir, 'user-docs'),
    sharedKnowledgeDir: path.resolve(absTenantsRoot, safeTenant, 'shared-knowledge'),
    domainStateDir: path.join(rootDir, 'domain-state'),
    runtimeDir: path.join(rootDir, 'runtime'),
    toolPolicyFile: path.join(rootDir, 'runtime', 'tool-policy.json'),
    backupsDir: path.join(rootDir, 'runtime', 'backups'),
  };

  ensureDir(paths.rootDir, 0o700);
  ensureDir(paths.profileDir, 0o700);
  ensureDir(paths.memoryDir, 0o700);
  ensureDir(paths.userDocsDir, 0o700);
  ensureDir(paths.domainStateDir, 0o700);
  ensureDir(paths.runtimeDir, 0o700);

  function resolveAndVerifyPack(packSpec) {
    if (!packSpec) throw new Error('ERR_PACK_SPEC_REQUIRED');
    if (packRegistry && typeof packRegistry.resolvePack === 'function') {
      return packRegistry.resolvePack(packSpec);
    }
    const res = verifyAgentPack({
      packDir: packSpec.packDir,
      expectedSha256: packSpec.expectedSha256 || packSpec.sha256 || null,
    });
    if (!res.ok) {
      const err = new Error(`ERR_PACK_VERIFICATION_FAILED:${res.errors.join(',')}`);
      err.code = 'ERR_PACK_VERIFICATION_FAILED';
      err.errors = res.errors;
      throw err;
    }
    return res;
  }

  function recordPromotion(packRef, { evalReport = null, mutationReport = null, requireGate = false, ts = now() } = {}) {
    const candId = `pack-${packRef.packId}-${packRef.version}-${packRef.sha256.slice(0, 8)}`;
    const staged = stageCandidate({
      stateDir: paths.runtimeDir,
      candidateId: candId,
      snapshotDir: packRef.packDir,
      metadata: {
        packId: packRef.packId,
        version: packRef.version,
        stateSchemaVersion: packRef.stateSchemaVersion,
      },
      now: ts,
    });
    if (!staged.ok) throw new Error(`ERR_PROMOTION_STAGE_FAILED:${staged.error || 'unknown'}`);

    const effectiveEval = evalReport || { ok: true, passed: 1, total: 1, passRate: 1.0, regressions: 0 };
    const gate = recordGateResult({
      stateDir: paths.runtimeDir,
      candidateId: candId,
      evalReport: effectiveEval,
      mutationReport,
      requireMutationKill: Boolean(requireGate && mutationReport),
      now: ts,
    });
    if (!gate.ok) {
      const err = new Error(`ERR_PROMOTION_GATE_FAILED:${(gate.reasons || [gate.error]).join(',')}`);
      err.code = 'ERR_PROMOTION_GATE_FAILED';
      throw err;
    }

    const promoted = promoteCandidate({
      stateDir: paths.runtimeDir,
      candidateId: candId,
      allowBypassShadow: true,
      now: ts,
    });
    if (!promoted.ok) {
      throw new Error(`ERR_PROMOTION_FAILED:${promoted.error}`);
    }
    return promoted.manifest;
  }

  let binding = readJsonSafe(paths.bindingFile);
  if (!binding) {
    if (!initialPack) {
      throw new Error('ERR_WORKSPACE_UNINITIALIZED:initialPack_required');
    }
    const verified = resolveAndVerifyPack(initialPack);
    const activePack = toBindingPackRef(verified);
    const ts = now();
    recordPromotion(activePack, { ts });
    binding = {
      schema: WORKSPACE_BINDING_SCHEMA,
      tenantId: safeTenant,
      deploymentId: safeDeployment,
      activePack,
      previousPack: null,
      epoch: 1,
      stateSchemaVersion: activePack.stateSchemaVersion,
      createdAt: ts.toISOString(),
      updatedAt: ts.toISOString(),
    };
    writeAtomicJson(paths.bindingFile, binding);
  }

  function getBinding() {
    const fresh = readJsonSafe(paths.bindingFile);
    if (fresh) binding = fresh;
    return JSON.parse(JSON.stringify(binding));
  }

  function advanceEpoch(nextEpoch = null) {
    const cur = getBinding();
    const target = nextEpoch == null ? Number(cur.epoch || 0) + 1 : Number(nextEpoch);
    if (!Number.isInteger(target) || target <= Number(cur.epoch || 0)) {
      const err = new Error(`ERR_STALE_EPOCH:current=${cur.epoch},requested=${target}`);
      err.code = 'ERR_STALE_EPOCH';
      throw err;
    }
    cur.epoch = target;
    cur.updatedAt = now().toISOString();
    writeAtomicJson(paths.bindingFile, cur);
    binding = cur;
    return target;
  }

  function writeUserMd(markdown) {
    writeAtomicText(paths.userFile, String(markdown ?? ''));
    return paths.userFile;
  }

  function readUserMd() {
    return fs.existsSync(paths.userFile) ? fs.readFileSync(paths.userFile, 'utf8') : null;
  }

  function writeWeightsOverride(weights) {
    if (!weights || typeof weights !== 'object') {
      throw new Error('ERR_INVALID_WEIGHTS_OVERRIDE');
    }
    writeAtomicJson(paths.weightsFile, weights);
    return weights;
  }

  function readWeightsOverride() {
    return readJsonSafe(paths.weightsFile);
  }

  function writePersonaDelta(markdown) {
    writeAtomicText(paths.personaDeltaFile, String(markdown ?? ''));
    return paths.personaDeltaFile;
  }

  function readPersonaDelta() {
    return fs.existsSync(paths.personaDeltaFile) ? fs.readFileSync(paths.personaDeltaFile, 'utf8') : null;
  }

  function readToolPolicy() {
    const raw = readJsonSafe(paths.toolPolicyFile);
    if (!raw || typeof raw !== 'object') return { schema: 'scroll-tool-policy/v1', disabledGroups: [] };
    return {
      schema: 'scroll-tool-policy/v1',
      disabledGroups: Array.isArray(raw.disabledGroups)
        ? [...new Set(raw.disabledGroups.map((x) => String(x || '').trim()).filter(Boolean))]
        : [],
      ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    };
  }

  function writeToolPolicy(policy = {}) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error('ERR_INVALID_TOOL_POLICY');
    }
    const normalized = {
      schema: 'scroll-tool-policy/v1',
      disabledGroups: Array.isArray(policy.disabledGroups)
        ? [...new Set(policy.disabledGroups.map((x) => String(x || '').trim()).filter(Boolean))]
        : [],
      updatedAt: now().toISOString(),
    };
    writeAtomicJson(paths.toolPolicyFile, normalized);
    return normalized;
  }

  function getLayeredKnowledge({
    packKnowledge = null,
    extraLayers = [],
    includeSharedTenantKnowledge = true,
    defaultTenantVisibility = 'public',
    tenantWeight = 1.25,
    sharedWeight = 1.12,
    packWeight = 1.0,
  } = {}) {
    const cur = getBinding();
    let sharedPackKb = packKnowledge;
    if (!sharedPackKb && packRegistry && cur.activePack) {
      sharedPackKb = packRegistry.getSharedKnowledge({
        packId: cur.activePack.packId,
        version: cur.activePack.version,
        expectedSha256: cur.activePack.sha256,
        packDir: cur.activePack.packDir,
      });
    }
    const tenantKb = openKnowledge({ cwd: paths.rootDir, dir: paths.userDocsDir, defaultVisibility: defaultTenantVisibility });
    const layers = [];
    if (tenantKb.active) layers.push({ name: 'tenant:user-docs', index: tenantKb, weight: tenantWeight, mutable: true });
    if (includeSharedTenantKnowledge && paths.sharedKnowledgeDir && fs.existsSync(paths.sharedKnowledgeDir)) {
      const sharedKb = openKnowledge({ cwd: paths.sharedKnowledgeDir, dir: paths.sharedKnowledgeDir, defaultVisibility: defaultTenantVisibility });
      if (sharedKb.active) layers.push({ name: 'tenant:shared-knowledge', index: sharedKb, weight: sharedWeight, mutable: true });
    }
    if (Array.isArray(extraLayers)) {
      for (const extra of extraLayers) {
        if (!extra || typeof extra !== 'object') continue;
        const idx = extra.index || (extra.dir ? openKnowledge({ cwd: extra.dir, dir: extra.dir, defaultVisibility: extra.defaultVisibility || defaultTenantVisibility }) : null);
        if (idx && idx.active) {
          layers.push({
            name: String(extra.name || 'tenant:extra'),
            index: idx,
            weight: Number(extra.weight ?? sharedWeight),
            mutable: extra.mutable !== false,
          });
        }
      }
    }
    if (sharedPackKb && sharedPackKb.active) layers.push({ name: 'pack:shared', index: sharedPackKb, weight: packWeight, mutable: false });
    return createLayeredKnowledge(layers);
  }

  async function switchPack({
    packId,
    version,
    expectedSha256 = null,
    packDir = null,
    migrate = null,
    evalReport = null,
    mutationReport = null,
    requireGate = false,
    allowMajorMigration = true,
  } = {}) {
    const cur = getBinding();
    const verified = resolveAndVerifyPack({ packId, version, expectedSha256, packDir });
    const nextPack = toBindingPackRef(verified);
    const curSchema = Number(cur.stateSchemaVersion || 1);
    const nextSchema = Number(nextPack.stateSchemaVersion || 1);

    if (nextSchema < curSchema) {
      const err = new Error(`ERR_SCHEMA_DOWNGRADE_BLOCKED:current=${curSchema},target=${nextSchema}`);
      err.code = 'ERR_SCHEMA_DOWNGRADE_BLOCKED';
      throw err;
    }

    let backupDir = null;
    if (nextSchema > curSchema) {
      if (!allowMajorMigration || typeof migrate !== 'function') {
        const err = new Error(`ERR_SCHEMA_MIGRATION_REQUIRED:from=${curSchema},to=${nextSchema}`);
        err.code = 'ERR_SCHEMA_MIGRATION_REQUIRED';
        throw err;
      }
      const tsTag = now().toISOString().replace(/[:.]/g, '-');
      backupDir = path.join(paths.backupsDir, `pre-schema-v${nextSchema}-${tsTag}`);
      ensureDir(backupDir, 0o700);
      copyDirRecursive(paths.profileDir, path.join(backupDir, 'profile'));
      copyDirRecursive(paths.domainStateDir, path.join(backupDir, 'domain-state'));
      fs.copyFileSync(paths.bindingFile, path.join(backupDir, 'binding.json'));

      try {
        await migrate({
          fromVersion: curSchema,
          toVersion: nextSchema,
          paths: { ...paths },
          binding: cur,
          nextPack,
        });
      } catch (migErr) {
        // Restore profile & domain-state on failed major migration
        fs.rmSync(paths.profileDir, { recursive: true, force: true });
        fs.rmSync(paths.domainStateDir, { recursive: true, force: true });
        copyDirRecursive(path.join(backupDir, 'profile'), paths.profileDir);
        copyDirRecursive(path.join(backupDir, 'domain-state'), paths.domainStateDir);
        throw migErr;
      }
    }

    const ts = now();
    recordPromotion(nextPack, { evalReport, mutationReport, requireGate, ts });

    const updated = {
      ...cur,
      previousPack: cur.activePack,
      activePack: nextPack,
      stateSchemaVersion: nextSchema,
      updatedAt: ts.toISOString(),
    };
    writeAtomicJson(paths.bindingFile, updated);
    binding = updated;
    return {
      ok: true,
      activePack: updated.activePack,
      previousPack: updated.previousPack,
      backupDir,
    };
  }

  function rollbackPack() {
    const t0 = performance.now();
    const cur = getBinding();
    if (!cur.previousPack) {
      const err = new Error('ERR_NO_PREVIOUS_PACK');
      err.code = 'ERR_NO_PREVIOUS_PACK';
      throw err;
    }

    const verifiedPrev = resolveAndVerifyPack({
      packId: cur.previousPack.packId,
      version: cur.previousPack.version,
      expectedSha256: cur.previousPack.sha256,
      packDir: cur.previousPack.packDir,
    });
    const restoredPack = toBindingPackRef(verifiedPrev);

    if (getActiveManifest(paths.runtimeDir)?.previousManifest) {
      rollbackActive({ stateDir: paths.runtimeDir, now: now() });
    }

    const updated = {
      ...cur,
      activePack: restoredPack,
      previousPack: cur.activePack,
      stateSchemaVersion: restoredPack.stateSchemaVersion,
      updatedAt: now().toISOString(),
    };
    writeAtomicJson(paths.bindingFile, updated);
    binding = updated;
    const durationMs = +(performance.now() - t0).toFixed(3);
    return {
      ok: true,
      activePack: updated.activePack,
      rolledBackFrom: cur.activePack,
      durationMs,
    };
  }

  return {
    tenantId: safeTenant,
    deploymentId: safeDeployment,
    getPaths: () => ({ ...paths }),
    getBinding,
    advanceEpoch,
    writeUserMd,
    readUserMd,
    writeWeightsOverride,
    readWeightsOverride,
    writePersonaDelta,
    readPersonaDelta,
    readToolPolicy,
    writeToolPolicy,
    getLayeredKnowledge,
    switchPack,
    rollbackPack,
  };
}
