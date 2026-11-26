// SCROLL 2.5 -- permission layer (v1.4 -> v2.5). Risk-tiered, enforced at the action boundary.
//
// Five tiers, lowest -> highest consequence:
//   read_only · reversible_write · external_comm · financial · destructive
// A matrix maps each tier to a policy: auto | auto-log | soft-hold | must-approve.
// financial + destructive additionally require a grounding check (see grounding.js).
//
// Risk is DATA, not prose: it is declared in .mcp.json (per tool) or IDENTITY.security
// (per capability namespace), and resolved here -- never read from a markdown body.
// Built-in floor tiers cannot be lowered by operator config; operators may only raise them.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './scroll.js';

export const TIERS = ['read_only', 'reversible_write', 'external_comm', 'financial', 'destructive'];
export const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]));

export const DEFAULT_MATRIX = {
  read_only: 'auto',
  reversible_write: 'auto-log',
  external_comm: 'soft-hold',
  financial: 'must-approve',
  destructive: 'must-approve',
};

// Built-in minimum safety floors: operator config may raise a tier, never lower below floor.
export const BUILTIN_TIER_FLOOR = {
  exec: 'destructive',
  memory_forget: 'destructive',
  memory_remember: 'reversible_write',
  memory_lesson: 'reversible_write',
  memory_open_loops: 'reversible_write',
  automations: 'reversible_write',
  spawn_worker: 'reversible_write',
};

// Logical capability -> concrete built-in tool aliases for `security.tools_allow` matching
export const CAPABILITY_TOOL_ALIASES = {
  'fs.read': ['read_file', 'list_dir'],
  'web.search': ['web_search'],
  'web.fetch': ['web_fetch'],
  'shell.exec': ['exec'],
  'skills.read': ['skill_list', 'skill_view'],
  'knowledge.read': ['knowledge_search', 'knowledge_list', 'knowledge_read'],
  'memory.read': ['memory_search', 'memory_inspect'],
  'memory.write': ['memory_remember', 'memory_forget', 'memory_lesson', 'memory_open_loops'],
  'schedule.manage': ['automations'],
  'workers.spawn': ['spawn_worker'],
};

const GROUND_TIERS = new Set(['financial', 'destructive']);
const LEGACY_TIER = { irreversible: 'destructive', reversible: 'reversible_write' };

export function normalizeTier(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (TIER_RANK[s] !== undefined) return s;
  if (LEGACY_TIER[s]) return LEGACY_TIER[s];
  return null;
}

export function maxTier(a, b) {
  const na = normalizeTier(a);
  const nb = normalizeTier(b);
  if (!na) return nb || 'destructive';
  if (!nb) return na;
  return TIER_RANK[na] >= TIER_RANK[nb] ? na : nb;
}

export function enforceTierFloor(name, tier, floors = BUILTIN_TIER_FLOOR) {
  const norm = normalizeTier(tier) || 'destructive';
  const floor = floors && floors[name] ? normalizeTier(floors[name]) : null;
  if (!floor) return norm;
  return maxTier(norm, floor);
}

function globToRegex(pattern) {
  const escaped = String(pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

// Match a tool name against a `security.tools_allow` rule array (exact, glob, or logical capability).
// If `allowRules` is null/undefined, returns true (not configured -> open for backwards compatibility).
// If `allowRules` is an array (including `[]`), deny-by-default: must match at least one rule.
export function matchesToolAllow(toolName, allowRules) {
  if (allowRules == null) return true;
  if (!Array.isArray(allowRules)) return false;
  if (!allowRules.length) return false;
  const target = String(toolName || '').trim();
  if (!target) return false;
  for (const rawRule of allowRules) {
    const rule = String(rawRule || '').trim();
    if (!rule) continue;
    if (rule === '*' || rule === target) return true;
    const aliased = CAPABILITY_TOOL_ALIASES[rule];
    if (aliased && aliased.includes(target)) return true;
    if (rule.includes('*') && globToRegex(rule).test(target)) return true;
  }
  return false;
}

// Resolve a tool/capability name -> a tier.
// Precedence: explicit .mcp.json per-tool -> IDENTITY exact -> IDENTITY longest glob
// (e.g. `mcp.github.*` > `mcp.*` > `fs.*`) -> fallback `destructive`, then apply built-in floor.
export function resolveTier(name, { mcpTools = {}, riskDefaults = {}, enforceFloor = true } = {}) {
  if (!name) return { tier: 'destructive', via: 'fallback' };
  const sName = String(name);

  let resolved = null;
  let via = 'fallback';

  const fromMcp = mcpTools[sName] && normalizeTier(mcpTools[sName].risk);
  if (fromMcp) {
    resolved = fromMcp;
    via = 'mcp';
  }
  if (!resolved) {
    const exact = riskDefaults[sName] && normalizeTier(riskDefaults[sName]);
    if (exact) {
      resolved = exact;
      via = 'identity';
    }
  }
  if (!resolved) {
    // Support multi-segment globs (`mcp.github.*` beats `mcp.*`) as well as root globs (`fs.*`)
    const globKeys = Object.keys(riskDefaults)
      .filter((k) => k.endsWith('.*'))
      .sort((a, b) => b.length - a.length);
    for (const key of globKeys) {
      const prefix = key.slice(0, -1); // includes trailing '.'
      if (sName.startsWith(prefix)) {
        const t = normalizeTier(riskDefaults[key]);
        if (t) {
          resolved = t;
          via = 'identity-glob';
          break;
        }
      }
    }
  }
  if (!resolved) {
    resolved = 'destructive';
    via = 'fallback';
  }
  if (enforceFloor) {
    const floored = enforceTierFloor(sName, resolved);
    if (floored !== resolved) {
      return { tier: floored, via: `${via}+floor` };
    }
  }
  return { tier: resolved, via };
}

export const POLICY_RANK = Object.freeze({
  auto: 0,
  'auto-log': 1,
  'soft-hold': 2,
  'must-approve': 3,
});

// Minimum approval policy floors: high-risk tiers cannot silently downgrade to auto/auto-log
// via tampered IDENTITY.md frontmatter unless the caller explicitly passes `enforceFloor: false`.
export const POLICY_FLOOR = Object.freeze({
  financial: 'must-approve',
  destructive: 'must-approve',
});

export function maxPolicy(a, b) {
  const ra = POLICY_RANK[a];
  const rb = POLICY_RANK[b];
  if (ra === undefined) return rb === undefined ? 'must-approve' : b;
  if (rb === undefined) return a;
  return ra >= rb ? a : b;
}

export function policyForTier(tier, overrides = {}, { enforceFloor = true } = {}) {
  const matrix = { ...DEFAULT_MATRIX, ...(overrides || {}) };
  const raw = matrix[tier] || 'must-approve';
  const normalized = POLICY_RANK[raw] !== undefined ? raw : 'must-approve';
  if (!enforceFloor) return normalized;
  const floor = POLICY_FLOOR[tier];
  return floor ? maxPolicy(normalized, floor) : normalized;
}

export function needsGrounding(tier) {
  return GROUND_TIERS.has(tier);
}

// The single deterministic decision. Returns one of: allow | await | deny.
export function evaluateAction({ tier, policy, approved = false, groundingRequired = false, grounded = null }) {
  if (groundingRequired && grounded === false) {
    return { decision: 'deny', reason: 'grounding failed — a critical parameter could not be traced to a real source' };
  }
  if (policy === 'must-approve' && !approved) {
    return { decision: 'await', reason: 'must-approve: blocked until an approval file is present' };
  }
  const held = policy === 'soft-hold';
  return { decision: 'allow', reason: held ? 'soft-hold: executed and logged' : 'within policy', held };
}

// Load per-tool risk from repo-level & agent-level `.mcp.json`.
// Stores canonical `mcp.<server>.<tool>` keys AND non-colliding short names, preserving `confirm`.
export function loadMcpRisk(cwd = process.cwd(), agentDir = null) {
  const tools = {};
  const bareOwners = new Map();
  const files = [path.join(cwd, '.mcp.json')];
  if (agentDir) files.push(path.join(agentDir, '.mcp.json'));
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const servers = j.mcpServers || {};
    for (const [serverName, srv] of Object.entries(servers)) {
      if (!srv || typeof srv !== 'object') continue;
      for (const [toolName, meta] of Object.entries(srv.tools || {})) {
        const entry = {
          risk: meta?.risk || null,
          ground: Array.isArray(meta?.ground) ? meta.ground : [],
          confirm: meta?.confirm || null,
          server: serverName,
        };
        const fullKey = `mcp.${serverName}.${toolName}`;
        tools[fullKey] = entry;
        if (!bareOwners.has(toolName) || bareOwners.get(toolName) === serverName) {
          bareOwners.set(toolName, serverName);
          tools[toolName] = entry;
        } else {
          // Ambiguous bare name across two servers -> remove bare key to prevent collision overwrite
          delete tools[toolName];
        }
      }
    }
  }
  return tools;
}

// Read IDENTITY.security + top-level capabilities/budget/tools_retrieval from an agent folder.
export function loadAgentSecurity(agentDir) {
  const empty = {
    riskDefaults: {},
    approvalOverrides: {},
    toolsAllow: null,
    egressAllow: null,
    execAllow: null,
    execDeny: null,
    capabilities: null,
    budget: null,
    toolsRetrieval: null,
  };
  if (!agentDir) return empty;
  try {
    const raw = fs.readFileSync(path.join(agentDir, 'IDENTITY.md'), 'utf8');
    const { frontmatter } = parseFrontmatter(raw);
    const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
    const sec = (fm.security && typeof fm.security === 'object') ? fm.security : {};
    const normalizeExecList = (list) => (Array.isArray(list)
      ? list.map((item) => (Array.isArray(item) || (item && typeof item === 'object') ? item : String(item)))
      : null);
    return {
      riskDefaults: sec.risk_defaults && typeof sec.risk_defaults === 'object' ? sec.risk_defaults : {},
      approvalOverrides: sec.approval && typeof sec.approval === 'object' ? sec.approval : {},
      toolsAllow: Array.isArray(sec.tools_allow) ? sec.tools_allow.map(String) : null,
      egressAllow: Array.isArray(sec.egress_allow) ? sec.egress_allow.map(String) : null,
      execAllow: normalizeExecList(sec.exec_allow),
      execDeny: normalizeExecList(sec.exec_deny),
      capabilities: Array.isArray(fm.capabilities) ? fm.capabilities.map(String) : null,
      budget: fm.budget && typeof fm.budget === 'object' ? fm.budget : null,
      toolsRetrieval: fm.tools_retrieval && typeof fm.tools_retrieval === 'object' ? fm.tools_retrieval : null,
    };
  } catch {
    return empty;
  }
}
