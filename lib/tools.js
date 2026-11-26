// SCROLL 2.5 -- §47 Live Multi-Round Tool Executor, Built-in Registry,
// Security Boundary Wall (§20-§22, §28, §42), OS Sandbox, & §47.2 Portable Tool Retriever.
//
// Every tool call -- direct, MCP, or unwrapped from `tool_invoke` -- passes through ONE
// deterministic safety gate:
//   0. Transparent unwrap for `tool_invoke` (anti-recursion, hydrated check, schemaHash pin,
//      host JSON Schema arg validation) so ALL downstream gates inspect the REAL target tool.
//   1. Unified allow-list (`IDENTITY.security.tools_allow` intersected with per-turn `toolsAllow`).
//   2. §42 boundary enforcement (external/mixed-group turns cannot invoke write/exec/admin tools).
//   3. §21 risk tier + floor + policy matrix (`resolveTier` + `policyForTier` + `evaluateAction`).
//   4. §22 provenance-aware action grounding for financial/destructive tiers (`checkGrounding`).
//   5. §21 per-call persistent HITL approval token (`approvalStore` + `userDoc.canApprove`).
//   6. §28 fail-closed post-write effect confirmation (`confirmEffect`, read-only probe only).
//   7. Tamper-evident hash-chained audit trail (`auditChain` + ring buffer).
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  resolveTier,
  maxTier,
  policyForTier,
  needsGrounding,
  evaluateAction,
  loadMcpRisk,
  loadAgentSecurity,
  matchesToolAllow,
} from './permissions.js';
import { checkGrounding } from './grounding.js';
import { confirmEffect } from './effects.js';
import {
  extractMcpToolMedia,
  isBinaryBuffer,
  isBinaryFilePath,
  guessMimeFromPath,
  resolveMediaStagingDir,
} from './media-stage.js';
import { runSandboxedExec, evaluateExecPolicy } from './sandbox.js';
import { hashArgs } from './chat-telemetry.js';
import {
  buildToolRetriever,
  buildAvailableToolsIndex,
  validateToolArgs,
  computeSchemaHash,
} from './tool-retriever.js';
import { scanText } from './skills.js';
import { resolveTurnKnowledgeAudience } from './knowledge.js';

const EXTERNAL_SENSITIVE_FILES = new Set([
  'identity.md',
  'soul.md',
  'hard-rules.md',
  'tools.md',
  'lessons.md',
  'user.md',
  'work.md',
  'loop.md',
]);

function hexPairToIpv4(hiHex, loHex) {
  const hi = parseInt(hiHex, 16);
  const lo = parseInt(loHex, 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateIpv4Octets(o0, o1, o2, o3) {
  if ([o0, o1, o2, o3].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (o0 === 0) return true;                                // 0.0.0.0/8
  if (o0 === 10) return true;                               // 10.0.0.0/8
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return true;     // 100.64.0.0/10 CGNAT / Tailscale
  if (o0 === 127) return true;                              // 127.0.0.0/8 loopback
  if (o0 === 169 && o1 === 254) return true;                // 169.254.0.0/16 link-local / cloud metadata
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true;      // 172.16.0.0/12
  if (o0 === 192 && o1 === 0 && (o2 === 0 || o2 === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (o0 === 192 && o1 === 168) return true;                // 192.168.0.0/16
  if (o0 === 198 && (o1 === 18 || o1 === 19)) return true;  // 198.18.0.0/15 benchmark
  if (o0 === 198 && o1 === 51 && o2 === 100) return true;   // 198.51.100.0/24 TEST-NET-2
  if (o0 === 203 && o1 === 0 && o2 === 113) return true;    // 203.0.113.0/24 TEST-NET-3
  if (o0 >= 224) return true;                               // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

function expandIpv6ToWords(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase();
  if (!ip) return null;
  // Convert trailing embedded IPv4 (e.g. `::ffff:127.0.0.1` or `0:0:0:0:0:ffff:127.0.0.1`) to two 16-bit hex words
  const lastColon = ip.lastIndexOf(':');
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes('.')) {
    const v4Part = ip.slice(lastColon + 1);
    if (!net.isIPv4(v4Part)) return null;
    const o = v4Part.split('.').map(Number);
    const wHi = ((o[0] << 8) | o[1]).toString(16);
    const wLo = ((o[2] << 8) | o[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${wHi}:${wLo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if (halves.length === 2 ? missing < 0 : left.length !== 8) return null;
  const full = [...left, ...Array(missing).fill('0'), ...right];
  if (full.length !== 8) return null;
  const words = [];
  for (const part of full) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(parseInt(part, 16));
  }
  return words;
}

export function isPrivateIp(rawIp) {
  let ip = String(rawIp || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);
  if (!ip) return true;

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return isPrivateIpv4Octets(parts[0], parts[1], parts[2], parts[3]);
  }
  if (net.isIPv6(ip)) {
    const w = expandIpv6ToWords(ip);
    if (!w) return true;
    const allZero6 = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
    // Unspecified `::` & Loopback `::1`
    if (allZero6 && w[5] === 0 && w[6] === 0 && (w[7] === 0 || w[7] === 1)) return true;
    // IPv4-mapped IPv6 `::ffff:a.b.c.d` (including expanded `0:0:0:0:0:ffff:7f00:1`)
    if (allZero6 && w[5] === 0xffff) {
      return isPrivateIpv4Octets((w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff);
    }
    // IPv4-translated `::ffff:0:a.b.c.d` (RFC 2765)
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0) {
      return isPrivateIpv4Octets((w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff);
    }
    // Deprecated IPv4-compatible IPv6 `::a.b.c.d`
    if (allZero6 && w[5] === 0 && (w[6] !== 0 || w[7] > 1)) {
      return isPrivateIpv4Octets((w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff);
    }
    // NAT64 well-known (`64:ff9b::/96`) & local-use (`64:ff9b:1::/48`)
    if (w[0] === 0x0064 && w[1] === 0xff9b && ((w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) || w[2] === 1)) return true;
    // Discard-Only Prefix (`100::/64`, RFC 6666)
    if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true;
    // 6to4 (`2002::/16`)
    if (w[0] === 0x2002) return true;
    // Teredo (`2001:0000::/32`), Benchmarking (`2001:2::/48`), Documentation (`2001:db8::/32`)
    if (w[0] === 0x2001 && (w[1] === 0x0000 || w[1] === 0x0db8 || (w[1] === 0x0002 && w[2] === 0))) return true;
    // ULA `fc00::/7`
    if ((w[0] & 0xfe00) === 0xfc00) return true;
    // Link-local `fe80::/10`
    if ((w[0] & 0xffc0) === 0xfe80) return true;
    // Deprecated site-local `fec0::/10`
    if ((w[0] & 0xffc0) === 0xfec0) return true;
    // Multicast `ff00::/8`
    if ((w[0] & 0xff00) === 0xff00) return true;
    return false;
  }
  return false;
}

function hostMatchesEgressAllow(host, egressAllow) {
  if (!Array.isArray(egressAllow)) return true;
  if (!egressAllow.length) return false;
  const h = String(host || '').toLowerCase();
  for (const rule of egressAllow) {
    const r = String(rule || '').trim().toLowerCase();
    if (!r) continue;
    if (r === '*') return true;
    if (r === h) return true;
    if (r.startsWith('*.') && (h === r.slice(2) || h.endsWith(r.slice(1)))) return true;
  }
  return false;
}

export function isSafePublicUrl(rawUrl, { egressAllow = null } = {}) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `disallowed_protocol:${u.protocol}` };
  }
  const host = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `ssrf_blocked_host:${host}` };
  }
  if (host === 'metadata.google.internal' || host === '169.254.169.254') {
    return { ok: false, reason: 'ssrf_blocked_metadata' };
  }
  if (isPrivateIp(host)) {
    return { ok: false, reason: `ssrf_blocked_private_ip:${host}` };
  }
  if (egressAllow !== null && !hostMatchesEgressAllow(host, egressAllow)) {
    return { ok: false, reason: `egress_host_not_allowed:${host}` };
  }
  return { ok: true, url: u.toString(), host };
}

export async function resolveAndValidatePublicUrl(rawUrl, {
  egressAllow = null,
  contentAudience = 'internal',
  dnsLookup = null,
} = {}) {
  // Egress axis on external audience: block outbound web_fetch unless egressAllow explicitly permits host
  if (contentAudience === 'external' && (!Array.isArray(egressAllow) || !egressAllow.length)) {
    return { ok: false, reason: 'egress_blocked_on_external_audience' };
  }
  const base = isSafePublicUrl(rawUrl, { egressAllow });
  if (!base.ok) return base;

  const ipVer = net.isIP(base.host);
  if (ipVer) {
    return { ...base, resolvedIp: base.host, resolvedFamily: ipVer };
  }

  // DNS resolution check (fail CLOSED on every DNS error; validates ALL A/AAAA records and pins first public IP)
  const lookupFn = typeof dnsLookup === 'function'
    ? dnsLookup
    : (h) => dns.promises.lookup(h, { all: true, verbatim: true });

  let records;
  try {
    records = await lookupFn(base.host);
  } catch (err) {
    return { ok: false, reason: `ssrf_dns_lookup_failed:${base.host}:${err?.message || err}` };
  }
  const list = Array.isArray(records) ? records : (records ? [records] : []);
  if (!list.length) {
    return { ok: false, reason: `ssrf_dns_no_records:${base.host}` };
  }

  let firstIp = null;
  let firstFamily = 4;
  for (const rec of list) {
    const ip = typeof rec === 'string' ? rec : rec?.address;
    if (!ip) continue;
    if (isPrivateIp(ip)) {
      return { ok: false, reason: `ssrf_dns_resolved_private_ip:${base.host}->${ip}` };
    }
    if (!firstIp) {
      firstIp = ip;
      firstFamily = (typeof rec === 'object' && rec?.family) || net.isIP(ip) || 4;
    }
  }
  if (!firstIp) {
    return { ok: false, reason: `ssrf_dns_no_valid_ip:${base.host}` };
  }
  return { ...base, resolvedIp: firstIp, resolvedFamily: firstFamily };
}

async function readBoundedStreamText(res, maxBytes = 2 * 1024 * 1024) {
  const cap = Math.max(4096, Number(maxBytes || 2 * 1024 * 1024));
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        if (total + buf.length > cap) {
          const take = Math.max(0, cap - total);
          if (take > 0) chunks.push(buf.subarray(0, take));
          total += take;
          truncated = true;
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        chunks.push(buf);
        total += buf.length;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), bytesRead: total, truncated };
  }
  const raw = await res.text();
  const buf = Buffer.from(String(raw || ''), 'utf8');
  if (buf.length > cap) {
    return { text: buf.subarray(0, cap).toString('utf8'), bytesRead: cap, truncated: true };
  }
  return { text: String(raw || ''), bytesRead: buf.length, truncated: false };
}

// Socket-pinned HTTP(S) GET preventing DNS rebinding TOCTOU (pins lookup to validated IP while
// preserving original hostname for TLS SNI, certificate verification, and Host header).
function pinnedHttpGet(urlStr, { resolvedIp, resolvedFamily = 4, signal = null, maxBytes = 2 * 1024 * 1024, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error('invalid_url')); return; }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const cap = Math.max(4096, Number(maxBytes || 2 * 1024 * 1024));

    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      agent: false, // Never reuse pooled keep-alive sockets across DNS-pinned fetches
      family: resolvedFamily,
      autoSelectFamily: false,
      headers: {
        Host: u.host,
        'User-Agent': 'scroll-agent/2.5',
        Accept: '*/*',
      },
      timeout: timeoutMs,
      ...(isHttps ? { servername: u.hostname } : {}),
      lookup: (_host, lookupOpts, cb) => {
        const callback = typeof lookupOpts === 'function' ? lookupOpts : cb;
        if (lookupOpts && typeof lookupOpts === 'object' && lookupOpts.all) {
          callback(null, [{ address: resolvedIp, family: resolvedFamily }]);
        } else {
          callback(null, resolvedIp, resolvedFamily);
        }
      },
    };

    const req = mod.request(opts, (res) => {
      const peerAddr = res.socket?.remoteAddress;
      if (peerAddr && isPrivateIp(peerAddr)) {
        res.destroy();
        reject(new Error(`ssrf_peer_ip_private:${peerAddr}`));
        return;
      }
      const status = Number(res.statusCode || 0);
      const hdrs = res.headers || {};
      const headers = {
        get(k) {
          const v = hdrs[String(k || '').toLowerCase()];
          return Array.isArray(v) ? v.join(', ') : (v ?? null);
        },
      };
      if (status >= 300 && status < 400) {
        // Immediately destroy socket instead of res.resume() so a hostile 3xx body cannot cause unbounded drain
        res.destroy();
        resolve({ status, url: urlStr, headers, bodyText: '', truncated: false });
        return;
      }
      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (total + buf.length > cap) {
          const take = Math.max(0, cap - total);
          if (take > 0) chunks.push(buf.subarray(0, take));
          total += take;
          truncated = true;
          res.destroy();
          resolve({ status, url: urlStr, headers, bodyText: Buffer.concat(chunks).toString('utf8'), truncated });
          return;
        }
        chunks.push(buf);
        total += buf.length;
      });
      res.once('end', () => {
        resolve({ status, url: urlStr, headers, bodyText: Buffer.concat(chunks).toString('utf8'), truncated });
      });
      res.once('error', (err) => {
        if (truncated) {
          resolve({ status, url: urlStr, headers, bodyText: Buffer.concat(chunks).toString('utf8'), truncated: true });
        } else {
          reject(err);
        }
      });
    });

    req.once('timeout', () => {
      req.destroy(new Error(`web_fetch_timeout:${timeoutMs}ms`));
    });
    req.once('error', reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('web_fetch_aborted'));
        return;
      }
      const onAbort = () => req.destroy(new Error('web_fetch_aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      req.once('close', () => signal.removeEventListener('abort', onAbort));
    }
    req.end();
  });
}

function realpathNativeSafe(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync.native(abs); } catch {
    try { return fs.realpathSync(abs); } catch {
      try {
        const parent = fs.realpathSync.native(path.dirname(abs));
        return path.join(parent, path.basename(abs));
      } catch {
        return abs;
      }
    }
  }
}

function resolveInsideRoot(rootDir, relPath) {
  const root = realpathNativeSafe(rootDir);
  const candidate = path.resolve(root, String(relPath || '.'));
  const target = realpathNativeSafe(candidate);
  const rootCmp = process.platform === 'darwin' || process.platform === 'win32' ? root.toLowerCase() : root;
  const targetCmp = process.platform === 'darwin' || process.platform === 'win32' ? target.toLowerCase() : target;
  if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp + path.sep)) {
    throw new Error(`path_traversal_denied:${relPath}`);
  }
  return { root, target, rel: path.relative(root, target) || '.' };
}

function assertFileReadable({ root, target, rel, userDoc, memoryStore, turnClassification }) {
  // Block hidden dotfiles / directories (`.env`, `.scroll/**`, `.mcp.json`, `.git/**`)
  if (rel !== '.') {
    const segments = rel.split(path.sep).filter(Boolean);
    for (const seg of segments) {
      if (seg.startsWith('.')) {
        throw new Error(`sensitive_dotfile_denied:${rel}`);
      }
    }
  }
  // Block USER.md (symlink & case-insensitive protected)
  if (userDoc && typeof userDoc.guard === 'function') {
    const g = userDoc.guard(target);
    if (!g.allowed) throw new Error(g.reason || 'user_md_denied');
  }
  const baseLower = path.basename(target).toLowerCase();
  if (baseLower === 'user.md' && path.dirname(target).toLowerCase() === root.toLowerCase()) {
    throw new Error('user_md_denied');
  }
  if (memoryStore && typeof memoryStore.assertToolPathAllowed === 'function') {
    const chk = memoryStore.assertToolPathAllowed(target);
    if (!chk.allowed) throw new Error(chk.reason);
  }
  // External/mixed-group turns cannot read agent prompt files (`SOUL.md`, `IDENTITY.md`, `hard-rules.md`, etc.)
  if (turnClassification?.contentAudience === 'external' && EXTERNAL_SENSITIVE_FILES.has(baseLower)) {
    throw new Error(`external_audience_file_denied:${baseLower}`);
  }
}

function readBoundedFile(absPath, maxBytes, rootDir = null) {
  // Use O_NOFOLLOW when available to eliminate symlink-swap TOCTOU races between realpath and open
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(absPath, openFlags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`not_a_file:${path.basename(absPath)}`);
    if (rootDir) {
      const recheck = realpathNativeSafe(absPath);
      const rootReal = realpathNativeSafe(rootDir);
      const rootCmp = process.platform === 'darwin' || process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
      const reCmp = process.platform === 'darwin' || process.platform === 'win32' ? recheck.toLowerCase() : recheck;
      if (reCmp !== rootCmp && !reCmp.startsWith(rootCmp + path.sep)) {
        throw new Error(`path_traversal_denied:${path.basename(absPath)}`);
      }
      // Verify the opened fd's dev/ino matches the post-open realpath (defeats intermediate directory symlink swaps!)
      const recheckStat = fs.statSync(recheck);
      if (recheckStat.dev !== stat.dev || recheckStat.ino !== stat.ino) {
        throw new Error(`path_symlink_race_denied:${path.basename(absPath)}`);
      }
    }
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    let offset = 0;
    while (offset < toRead) {
      const n = fs.readSync(fd, buf, offset, toRead - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    const slice = buf.subarray(0, offset);
    if (isBinaryFilePath(absPath) || isBinaryBuffer(slice)) {
      return {
        bytes: stat.size,
        binary: true,
        mimeType: guessMimeFromPath(absPath),
        path: absPath,
        truncated: false,
        content: '',
        hint: 'Binary file — do not read as UTF-8 text; pass to a document/media extractor or send directly.',
      };
    }
    return {
      bytes: stat.size,
      truncated: stat.size > toRead,
      content: slice.toString('utf8'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

// DeepSeek-Harness-inspired Spill-to-File Output Limiter: keeps bounded head + tail in prompt
// context while persisting full raw output to `.scroll/scratch/` so the agent can slice on demand.
export function applySpillToFileLimit(output, {
  toolName = 'tool',
  maxChars = 24_000,
  spillDir = null,
} = {}) {
  const cap = Math.max(2000, Number(maxChars || 24_000));
  if (output == null) return output;
  const serialized = typeof output === 'string' ? output : JSON.stringify(output);
  if (serialized.length <= cap) return output;

  const headLen = Math.floor(cap * 0.65);
  const tailLen = Math.floor(cap * 0.25);
  const head = serialized.slice(0, headLen);
  const tail = serialized.slice(serialized.length - tailLen);
  const omitted = serialized.length - headLen - tailLen;

  let spilledPath = null;
  if (spillDir) {
    try {
      fs.mkdirSync(spillDir, { recursive: true, mode: 0o700 });
      const safeTool = String(toolName).replace(/[^A-Za-z0-9_.-]/g, '_');
      const file = path.join(spillDir, `${Date.now()}-${safeTool}-${crypto.randomBytes(4).toString('hex')}.log`);
      fs.writeFileSync(file, serialized + '\n', { mode: 0o600 });
      spilledPath = file;
    } catch { /* isolate scratch spill error */ }
  }

  return {
    truncated: true,
    totalChars: serialized.length,
    omittedChars: omitted,
    ...(spilledPath ? { spilledPath } : {}),
    preview: `${head}\n\n... [${omitted} chars omitted${spilledPath ? `; full output saved to ${spilledPath}` : ''}] ...\n\n${tail}`,
  };
}

const DEFAULT_BUILTIN_RISK = {
  read_file: 'read_only',
  list_dir: 'read_only',
  web_search: 'read_only',
  web_fetch: 'read_only',
  memory_search: 'read_only',
  knowledge_search: 'read_only',
  knowledge_list: 'read_only',
  knowledge_read: 'read_only',
  skill_list: 'read_only',
  skill_view: 'read_only',
  tool_search: 'read_only',
  memory_remember: 'reversible_write',
  memory_forget: 'destructive',
  automations: 'reversible_write',
  spawn_worker: 'reversible_write',
  exec: 'destructive',
};

const CORE_ALWAYS_LOAD_DEFAULTS = [
  'read_file',
  'list_dir',
  'knowledge_search',
  'knowledge_list',
  'knowledge_read',
  'memory_search',
  'skill_list',
  'skill_view',
];

export function createToolRegistry({
  cwd = process.cwd(),
  agentDir = null,
  userDoc = null,
  memoryStore = null,
  knowledgeIndex = null,
  enableKnowledgeTools = false,
  skills = null,
  scheduler = null,
  workerPool = null,
  mcpManager = null,
  approvalStore = null,
  auditChain = null,
  requestApproval = null,
  webSearchFn = null,
  fetchImpl = globalThis.fetch,
  dnsLookup = null,
  enableExec = null, // null = auto (disabled if strictExec or agentDir disallows; enabled if bare registry or explicitly true)
  strictExec = false,
  allowedExecBinaries = null,
  deniedExecBinaries = null,
  execRunner = null,
  execSandbox = 'os',
  requireSandbox = true,
  egressAllow = null,
  toolsAllow = null,
  toolsRetrieval = null,
  riskDefaults = null,
  approvalOverrides = null,
  maxToolOutputChars = 24_000,
  maxWebFetchBytes = 2 * 1024 * 1024,
  spillDir = null,
  onAudit = null,
  embedFn = null,
} = {}) {
  const tools = new Map();
  const shortAliasMap = new Map(); // optional non-colliding short name -> canonical mcp.<server>.<tool>
  const quarantinedMcp = new Map();
  const auditLog = [];

  const sec = agentDir ? loadAgentSecurity(agentDir) : {
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
  const mcpRisk = loadMcpRisk(cwd, agentDir);
  const mergedRiskDefaults = {
    ...DEFAULT_BUILTIN_RISK,
    ...(sec.riskDefaults || {}),
    ...(riskDefaults || {}),
  };
  const mergedApprovalOverrides = {
    ...(sec.approvalOverrides || {}),
    ...(approvalOverrides || {}),
  };
  const effectiveIdentityToolsAllow = toolsAllow !== null ? toolsAllow : sec.toolsAllow;
  const effectiveEgressAllow = egressAllow !== null ? egressAllow : sec.egressAllow;
  const effectiveExecAllow = allowedExecBinaries !== null ? allowedExecBinaries : sec.execAllow;
  const effectiveExecDeny = deniedExecBinaries !== null ? deniedExecBinaries : sec.execDeny;
  const effectiveSpillDir = spillDir || null;
  const hasExplicitDeferThreshold = (sec.toolsRetrieval && sec.toolsRetrieval.deferThreshold != null)
    || (toolsRetrieval && toolsRetrieval.deferThreshold != null);
  const hasExplicitMaxSchemaBytes = (sec.toolsRetrieval && sec.toolsRetrieval.maxSchemaBytes != null)
    || (toolsRetrieval && toolsRetrieval.maxSchemaBytes != null);
  const retrievalCfg = {
    mode: 'auto', // auto | portable | off
    deferThreshold: 15,
    maxSchemaBytes: 8192,
    maxIndexTokens: 1500,
    maxSearchResults: 5,
    requireSearchBeforeInvoke: true,
    alwaysLoad: CORE_ALWAYS_LOAD_DEFAULTS,
    ...(sec.toolsRetrieval || {}),
    ...(toolsRetrieval || {}),
  };

  let retrieverCache = null;
  let registryVersion = 0;

  function invalidateRetriever() {
    retrieverCache = null;
    registryVersion++;
  }

  function recordAudit(entry) {
    const full = { ts: new Date().toISOString(), ...entry };
    auditLog.push(full);
    if (auditLog.length > 500) auditLog.shift();
    if (auditChain && typeof auditChain.append === 'function') {
      try { auditChain.append(entry); } catch { /* isolate disk error */ }
    }
    if (typeof onAudit === 'function') {
      try { onAudit(full); } catch { /* ignore */ }
    }
    return full;
  }

  function register(def) {
    if (!def || !def.name || typeof def.execute !== 'function') {
      throw new Error('tool register: name and execute(args, ctx) are required');
    }
    const name = String(def.name);
    const params = def.parameters || { type: 'object', properties: {} };
    const description = String(def.description || '');
    tools.set(name, {
      name,
      description,
      shortDescription: def.shortDescription || null,
      namespace: def.namespace || (def.server ? `mcp.${def.server}` : 'builtin'),
      server: def.server || null,
      serverDescription: def.serverDescription || '',
      parameters: params,
      risk: def.risk || null,
      ground: Array.isArray(def.ground) ? def.ground : [],
      confirm: def.confirm || null,
      deferLoading: def.deferLoading !== undefined ? def.deferLoading : null,
      tags: Array.isArray(def.tags) ? def.tags : [],
      examples: Array.isArray(def.examples) ? def.examples : [],
      schemaHash: def.schemaHash || computeSchemaHash({ name, description, parameters: params }),
      trustedOutput: def.trustedOutput !== undefined ? Boolean(def.trustedOutput) : (name !== 'web_fetch' && name !== 'web_search'),
      execute: def.execute,
    });
    invalidateRetriever();
  }

  function unregister(name) {
    const ok = tools.delete(name);
    if (ok) invalidateRetriever();
    return ok;
  }

  // ── Built-in tools ──
  register({
    name: 'read_file',
    description: 'Read a UTF-8 file inside the workspace directory.',
    risk: 'read_only',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside workspace' },
        maxBytes: { type: 'number', description: 'Max bytes to return (default 16000)' },
      },
      required: ['path'],
    },
    async execute(args, ctx) {
      const resolved = resolveInsideRoot(cwd, args.path);
      assertFileReadable({ ...resolved, userDoc: ctx?.userDoc || userDoc, memoryStore, turnClassification: ctx?.turnClassification });
      const cap = Math.min(64_000, Math.max(256, Number(args.maxBytes || 16_000)));
      const data = readBoundedFile(resolved.target, cap, resolved.root);
      return {
        path: resolved.rel,
        bytes: data.bytes,
        truncated: data.truncated,
        content: data.content,
        ...(data.binary ? { binary: true, mimeType: data.mimeType, hint: data.hint } : {}),
      };
    },
  });

  register({
    name: 'list_dir',
    description: 'List entries in a directory inside the workspace.',
    risk: 'read_only',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory path (default .)' } },
    },
    async execute(args, ctx) {
      const resolved = resolveInsideRoot(cwd, args.path || '.');
      assertFileReadable({ ...resolved, userDoc: ctx?.userDoc || userDoc, memoryStore, turnClassification: ctx?.turnClassification });
      const isExt = ctx?.turnClassification?.contentAudience === 'external';
      const entries = fs.readdirSync(resolved.target, { withFileTypes: true })
        .filter((e) => {
          if (e.name.startsWith('.')) return false;
          const low = e.name.toLowerCase();
          if (low === 'user.md' && resolved.rel === '.') return false;
          if (isExt && EXTERNAL_SENSITIVE_FILES.has(low)) return false;
          return true;
        })
        .slice(0, 200)
        .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }));
      return { path: resolved.rel, entries };
    },
  });

  register({
    name: 'web_fetch',
    description: 'Fetch a public HTTP/HTTPS URL (enforces DNS/IPv6/CGNAT SSRF guard, manual redirect checks, and egress_allow).',
    risk: 'read_only',
    trustedOutput: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxChars: { type: 'number' },
      },
      required: ['url'],
    },
    async execute(args, ctx) {
      const audience = ctx?.turnClassification?.contentAudience || 'internal';
      let currentUrl = String(args.url || '');
      let res = null;
      let lastCheck = null;
      const usePinnedSocket = fetchImpl === globalThis.fetch;
      for (let hop = 0; hop < 6; hop++) {
        const check = await resolveAndValidatePublicUrl(currentUrl, {
          egressAllow: effectiveEgressAllow,
          contentAudience: audience,
          dnsLookup,
        });
        if (!check.ok) throw new Error(check.reason);
        lastCheck = check;
        if (usePinnedSocket && check.resolvedIp) {
          res = await pinnedHttpGet(check.url, {
            resolvedIp: check.resolvedIp,
            resolvedFamily: check.resolvedFamily,
            signal: ctx?.signal || null,
            maxBytes: maxWebFetchBytes,
          });
        } else {
          res = await fetchImpl(check.url, { method: 'GET', redirect: 'manual', signal: ctx?.signal || undefined });
        }
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
          if (!loc) break;
          currentUrl = new URL(loc, check.url).toString();
          continue;
        }
        break;
      }
      if (!res) throw new Error('web_fetch_no_response');
      if (res.status >= 300 && res.status < 400) throw new Error('web_fetch_too_many_redirects');
      const finalUrl = res.url || currentUrl;
      const finalCheck = finalUrl === lastCheck?.url
        ? lastCheck
        : await resolveAndValidatePublicUrl(finalUrl, {
            egressAllow: effectiveEgressAllow,
            contentAudience: audience,
            dnsLookup,
          });
      if (!finalCheck.ok) throw new Error(`redirect_${finalCheck.reason}`);
      const cap = Math.min(24_000, Math.max(500, Number(args.maxChars || 8000)));
      const bodyRead = typeof res.bodyText === 'string'
        ? { text: res.bodyText, truncated: Boolean(res.truncated) }
        : await readBoundedStreamText(res, maxWebFetchBytes);
      return {
        url: finalCheck.url,
        status: res.status,
        truncated: bodyRead.truncated || bodyRead.text.length > cap,
        body: bodyRead.text.slice(0, cap),
        untrustedExternal: true,
      };
    },
  });

  register({
    name: 'web_search',
    description: 'Search the web using a configured search provider.',
    risk: 'read_only',
    trustedOutput: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async execute(args) {
      if (typeof webSearchFn === 'function') {
        return webSearchFn(String(args.query || ''), { limit: Number(args.limit || 5) });
      }
      const braveKey = process.env.BRAVE_API_KEY;
      if (!braveKey) throw new Error('web_search_not_configured: provide webSearchFn or BRAVE_API_KEY');
      const limit = Math.min(10, Math.max(1, Number(args.limit || 5)));
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(String(args.query || ''))}&count=${limit}`;
      const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey } });
      if (!res.ok) throw new Error(`web_search_failed:${res.status}`);
      const json = await res.json();
      const results = (json.web?.results || []).slice(0, limit).map((r) => ({
        title: r.title, url: r.url, snippet: r.description || '',
      }));
      return { query: args.query, results, untrustedExternal: true };
    },
  });

  let activeKnowledge = knowledgeIndex || null;
  let knowledgeToolsRegistered = false;

  function ensureKnowledgeToolsRegistered() {
    if (knowledgeToolsRegistered) return;
    knowledgeToolsRegistered = true;

    register({
      name: 'knowledge_search',
      description: 'Search the indexed deployment knowledge base (SOPs, manuals, tariffs, FAQs) with optional folder scoping.',
      risk: 'read_only',
      trustedOutput: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          folder: { type: 'string', description: 'Optional folder prefix filter (e.g. SOP/FrontDesk)' },
          topK: { type: 'number', description: 'Max hits to return (default 4, max 12)' },
        },
        required: ['query'],
      },
      async execute(args, ctx) {
        if (!activeKnowledge || typeof activeKnowledge.retrieve !== 'function') {
          return { query: String(args.query || ''), hits: [] };
        }
        const audience = resolveTurnKnowledgeAudience(ctx?.turnClassification, ctx?.sender);
        const topK = Math.min(12, Math.max(1, Number(args.topK || 4)));
        const res = activeKnowledge.retrieve(String(args.query || ''), {
          topK,
          folder: args.folder ? String(args.folder) : null,
          audience,
        });
        return {
          query: res.query,
          audience,
          hits: (res.hits || []).map((h) => ({
            file: h.file,
            heading: h.heading,
            folder: h.folder || '',
            visibility: h.visibility || 'public',
            score: h.score,
            text: h.text,
            ...(h.sourceUrl ? { sourceUrl: h.sourceUrl } : {}),
            ...(h.layer ? { layer: h.layer } : {}),
          })),
        };
      },
    });

    register({
      name: 'knowledge_list',
      description: 'List folders and documents in the knowledge base to browse large operational libraries before reading.',
      risk: 'read_only',
      trustedOutput: true,
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Optional folder prefix filter' },
          query: { type: 'string', description: 'Optional substring filter over file path, title, or headings' },
          limit: { type: 'number', description: 'Max files to list (default 50, max 200)' },
        },
      },
      async execute(args, ctx) {
        if (!activeKnowledge || typeof activeKnowledge.listFiles !== 'function') {
          return { folder: String(args.folder || ''), total: 0, folders: [], files: [] };
        }
        const audience = resolveTurnKnowledgeAudience(ctx?.turnClassification, ctx?.sender);
        const limit = Math.min(200, Math.max(1, Number(args.limit || 50)));
        return {
          audience,
          ...activeKnowledge.listFiles({
            folder: args.folder ? String(args.folder) : '',
            query: args.query ? String(args.query) : '',
            limit,
            audience,
          }),
        };
      },
    });

    register({
      name: 'knowledge_read',
      description: 'Read a specific knowledge document or section (bounded pagination, enforces visibility access control).',
      risk: 'read_only',
      trustedOutput: true,
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Relative document path returned by knowledge_list or knowledge_search' },
          section: { type: 'string', description: 'Optional heading/section substring to extract' },
          offsetChars: { type: 'number', description: 'Character offset for paginated reading (default 0)' },
          maxChars: { type: 'number', description: 'Max characters to return (default 8000, max 20000)' },
        },
        required: ['file'],
      },
      async execute(args, ctx) {
        if (!activeKnowledge || typeof activeKnowledge.readFile !== 'function') {
          return { ok: false, error: 'ERR_KNOWLEDGE_NOT_CONFIGURED' };
        }
        const audience = resolveTurnKnowledgeAudience(ctx?.turnClassification, ctx?.sender);
        return activeKnowledge.readFile(String(args.file || ''), {
          section: args.section ? String(args.section) : null,
          offsetChars: Math.max(0, Number(args.offsetChars || 0)),
          maxChars: Math.min(20_000, Math.max(256, Number(args.maxChars || 8000))),
          audience,
        });
      },
    });
  }

  function setKnowledgeIndex(nextKb) {
    activeKnowledge = nextKb || null;
    if (activeKnowledge && !knowledgeToolsRegistered) {
      ensureKnowledgeToolsRegistered();
    }
    return { active: Boolean(activeKnowledge && activeKnowledge.active) };
  }

  if (activeKnowledge || enableKnowledgeTools) {
    ensureKnowledgeToolsRegistered();
  }

  function registerSkills(skillsReg) {
    if (!skillsReg || typeof skillsReg.tools !== 'function') return [];
    const raw = skillsReg.tools();
    const list = Array.isArray(raw)
      ? raw
      : Object.entries(raw || {}).map(([k, v]) => ({ name: v?.name || k, ...v }));
    const registered = [];
    for (const item of list) {
      if (!item || !item.name || typeof item.run !== 'function') continue;
      register({
        name: String(item.name),
        description: String(item.description || ''),
        risk: 'read_only',
        trustedOutput: true,
        parameters: item.parameters || { type: 'object', properties: {} },
        async execute(args) {
          return item.run(args || {});
        },
      });
      registered.push(String(item.name));
    }
    return registered;
  }

  if (skills) {
    registerSkills(skills);
  }

  if (memoryStore) {
    register({
      name: 'memory_search',
      description: 'Search subject memory for facts, sessions, cards, or day notes.',
      risk: 'read_only',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          scope: { type: 'string', enum: ['all', 'facts', 'sessions', 'cards', 'days'] },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
      async execute(args, ctx) {
        const sid = ctx.subjectSid;
        if (!sid) return { hits: [], note: 'no_subject_bound' };
        return memoryStore.search(sid, {
          query: String(args.query || ''),
          scope: args.scope || 'all',
          limit: Number(args.limit || 6),
          session: ctx.memorySessionId || null,
        });
      },
    });

    register({
      name: 'memory_remember',
      description: 'Propose a grounded fact into subject memory with a verbatim quote from the current turn.',
      risk: 'reversible_write',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['key', 'value', 'quote'],
      },
      async execute(args, ctx) {
        if (!ctx.subjectSid || !ctx.turnRef) return { ok: false, reason: 'no_turn_reference' };
        return memoryStore.remember(ctx.subjectSid, {
          key: args.key,
          value: args.value,
          quote: args.quote,
          ref: ctx.turnRef,
        });
      },
    });

    register({
      name: 'memory_forget',
      description: 'Permanently forget and redact fact IDs from subject memory.',
      risk: 'destructive',
      ground: ['ids'],
      confirm: { mode: 'none', reason: 'tombstone_atomic_journal_verified' },
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
        required: ['ids'],
      },
      async execute(args, ctx) {
        if (!ctx.subjectSid) return { ok: false, reason: 'no_subject_bound' };
        return memoryStore.forget(ctx.subjectSid, args.ids, { reason: args.reason || 'user_request' });
      },
    });
  }

  if (scheduler) {
    register({
      name: 'automations',
      description: 'List, create, toggle, update, or delete timezone-aware scheduled cron jobs and reminders.',
      risk: 'reversible_write',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'update', 'toggle', 'delete'] },
          jobId: { type: 'string' },
          name: { type: 'string' },
          cron: { type: 'string' },
          everyMs: { type: 'number' },
          at: { type: 'string' },
          tz: { type: 'string' },
          targetChatId: { type: 'string' },
          prompt: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['action'],
      },
      async execute(args, ctx) {
        const actor = {
          id: ctx.turnClassification?.speakerId || ctx.sender?.id || null,
          roles: ctx.turnClassification?.speakerRoles || [],
          isInternal: ctx.turnClassification?.speakerTrust === 'internal',
          isDm: !ctx.turnClassification?.isGroup,
        };
        if (args.action === 'list') {
          return { jobs: scheduler.listJobs({ chatId: args.targetChatId || null }) };
        }
        if (args.action === 'create') {
          if (!actor.isInternal) return { ok: false, reason: 'owner_or_internal_required' };
          const job = scheduler.addJob({
            id: args.jobId || undefined,
            name: args.name || 'Scheduled task',
            cron: args.cron || null,
            everyMs: args.everyMs || null,
            at: args.at || null,
            tz: args.tz || undefined,
            targetChatId: args.targetChatId || ctx.chatId || null,
            prompt: args.prompt || '',
            enabled: args.enabled !== false,
            ownerId: actor.id,
          });
          return { ok: true, job };
        }
        const existing = scheduler.getJob(args.jobId);
        if (!existing) return { ok: false, reason: 'job_not_found' };
        if (!scheduler.canManageJob(actor, existing)) {
          return { ok: false, reason: 'forbidden_manage_job' };
        }
        if (args.action === 'delete') return scheduler.removeJob(args.jobId);
        if (args.action === 'toggle') return { ok: true, job: scheduler.updateJob(args.jobId, { enabled: args.enabled !== undefined ? Boolean(args.enabled) : !existing.enabled }) };
        return {
          ok: true,
          job: scheduler.updateJob(args.jobId, {
            ...(args.name != null ? { name: args.name } : {}),
            ...(args.cron != null ? { cron: args.cron } : {}),
            ...(args.tz != null ? { tz: args.tz } : {}),
            ...(args.prompt != null ? { prompt: args.prompt } : {}),
            ...(args.enabled != null ? { enabled: Boolean(args.enabled) } : {}),
          }),
        };
      },
    });
  }

  if (workerPool) {
    register({
      name: 'spawn_worker',
      description: 'Launch an asynchronous background subagent worker without blocking the chat turn.',
      risk: 'reversible_write',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          task: { type: 'string' },
        },
        required: ['task'],
      },
      async execute(args, ctx) {
        if (typeof ctx.spawnWorkerFn !== 'function') {
          return { ok: false, reason: 'worker_runner_not_configured' };
        }
        const job = workerPool.submit({
          label: args.label || 'background-worker',
          chatId: ctx.chatId || null,
          fn: ({ signal, jobId }) => ctx.spawnWorkerFn(String(args.task || ''), { ...ctx, signal, jobId }),
        });
        return { ok: true, jobId: job.id, status: job.status };
      },
    });
  }

  const execEnabled = enableExec !== null
    ? Boolean(enableExec)
    : (!strictExec);

  if (execEnabled) {
    register({
      name: 'exec',
      description: 'Execute a single binary inside the OS sandbox (destructive tier; requires approval & sanitized env).',
      risk: 'destructive',
      ground: ['command', 'args'],
      confirm: { mode: 'none', reason: 'process_exit_verified' },
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'number' },
        },
        required: ['command'],
      },
      async execute(args, ctx) {
        const bin = String(args.command || '').trim();
        if (!bin) throw new Error('exec: command is required');
        const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        if (strictExec && (!Array.isArray(effectiveExecAllow) || !effectiveExecAllow.length)) {
          throw new Error('exec_disabled_strict_allowlist_required');
        }
        const execPol = evaluateExecPolicy({
          command: bin,
          args: cmdArgs,
          allowRules: Array.isArray(effectiveExecAllow) ? effectiveExecAllow : null,
          denyRules: Array.isArray(effectiveExecDeny) ? effectiveExecDeny : null,
        });
        if (!execPol.ok) {
          throw new Error(execPol.reason || `exec_binary_not_allowed:${bin}`);
        }
        const res = await runSandboxedExec({
          command: bin,
          args: cmdArgs,
          cwd,
          timeoutMs: Math.min(60_000, Number(args.timeoutMs || 15_000)),
          sandbox: execSandbox,
          requireSandbox,
          allowNetwork: false,
          execRunner,
          signal: ctx?.signal || null,
        });
        return {
          stdout: String(res.stdout || '').slice(0, 12_000),
          stderr: String(res.stderr || '').slice(0, 4000),
          sandbox: res.sandbox || execSandbox,
        };
      },
    });
  }

  function resolveToolEntry(name) {
    const direct = tools.get(name);
    if (direct) return { name, def: direct };
    const canonical = shortAliasMap.get(name);
    if (canonical && tools.has(canonical)) return { name: canonical, def: tools.get(canonical) };
    return null;
  }

  function resolveEffectiveTier(name, def) {
    // Operator `.mcp.json` or `IDENTITY.security.risk_defaults` rules take precedence and can NEVER be
    // downgraded by a tool's self-declared `def.risk`. When no explicit operator rule matches (`via === 'fallback'`),
    // honor `def.risk` (still subject to `BUILTIN_TIER_FLOOR`).
    const policyResolved = resolveTier(name, { mcpTools: mcpRisk, riskDefaults: mergedRiskDefaults });
    if (def?.risk) {
      const defResolved = resolveTier(name, {
        mcpTools: { [name]: { risk: def.risk, ground: def.ground || [], confirm: def.confirm || null } },
        riskDefaults: {},
      });
      if (policyResolved.via === 'fallback') {
        return { tier: defResolved.tier, via: 'tool_def' };
      }
      const highest = maxTier(policyResolved.tier, defResolved.tier);
      const via = highest === policyResolved.tier ? policyResolved.via : `${policyResolved.via}+tool_def`;
      return { tier: highest, via };
    }
    return policyResolved;
  }

  function isToolAllowedByPolicy(name, turnToolsAllow = null) {
    if (name === 'tool_search' || name === 'tool_invoke') return true;
    if (!matchesToolAllow(name, effectiveIdentityToolsAllow)) return false;
    if (turnToolsAllow != null && !matchesToolAllow(name, turnToolsAllow)) return false;
    return true;
  }

  function syncMcpTools() {
    if (!mcpManager) return [];
    const discovered = mcpManager.listDiscoveredTools();
    const added = [];
    const bareCounts = new Map();
    for (const t of discovered) {
      bareCounts.set(t.name, (bareCounts.get(t.name) || 0) + 1);
    }
    for (const t of discovered) {
      const fullName = t.fullName || `mcp.${t.server}.${t.name}`;
      // Scan MCP description & parameter text for prompt-injection / hidden Unicode (`ASI01`)
      const descText = `${t.description || ''} ${JSON.stringify(t.parameters || {})}`;
      const findings = scanText(descText, fullName);
      const severe = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
      if (severe.length) {
        quarantinedMcp.set(fullName, { reason: 'mcp_description_injection_blocked', findings: severe });
        recordAudit({ tool: fullName, decision: 'quarantine', reason: 'mcp_description_injection_blocked', findings: severe.map((f) => f.id) });
        continue;
      }

      // Canonical registration under `mcp.<server>.<tool>` so `mcp.*` and `mcp.<server>.*` globs work!
      register({
        name: fullName,
        namespace: t.namespace || `mcp.${t.server}`,
        server: t.server,
        serverDescription: t.serverDescription || '',
        description: t.description,
        shortDescription: t.shortDescription || null,
        parameters: t.parameters,
        risk: t.risk || null, // null lets IDENTITY `mcp.*` risk_defaults resolve before falling back to `destructive`!
        ground: t.ground,
        confirm: t.confirm,
        deferLoading: t.deferLoading,
        tags: t.tags,
        examples: t.examples,
        schemaHash: t.schemaHash,
        trustedOutput: false,
        async execute(args, ctx) {
          const mcpRes = await mcpManager.callTool(t.server, t.name, args, { signal: ctx?.signal || null });
          const stagingDir = ctx?.mediaStagingDir
            || (spillDir ? path.resolve(path.dirname(spillDir), 'staging', 'mcp-media') : resolveMediaStagingDir(null, 'mcp-media'));
          const extracted = extractMcpToolMedia(mcpRes, {
            stagingDir,
            toolName: fullName,
          });
          const out = extracted.output && typeof extracted.output === 'object'
            ? extracted.output
            : { ok: true, text: String(extracted.output ?? '') };
          if (extracted.mediaItems.length) {
            Object.defineProperty(out, '_scrollMediaItems', {
              value: extracted.mediaItems,
              enumerable: false,
              configurable: true,
            });
          }
          return out;
        },
      });
      if (!tools.has(t.name) && bareCounts.get(t.name) === 1) {
        shortAliasMap.set(t.name, fullName);
      }
      for (const wireAlias of [
        fullName.replace(/[^a-zA-Z0-9_-]/g, '_'),
        fullName.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_'),
      ]) {
        if (wireAlias && wireAlias !== fullName && !tools.has(wireAlias) && !shortAliasMap.has(wireAlias)) {
          shortAliasMap.set(wireAlias, fullName);
        }
      }
      added.push(fullName);
    }
    return added;
  }

  function buildCatalog({ turnToolsAllow = null } = {}) {
    const out = [];
    for (const def of tools.values()) {
      if (def.name === 'tool_search' || def.name === 'tool_invoke') continue;
      if (!isToolAllowedByPolicy(def.name, turnToolsAllow)) continue;
      const { tier } = resolveEffectiveTier(def.name, def);
      out.push({
        name: def.name,
        namespace: def.namespace,
        serverDescription: def.serverDescription,
        description: def.description,
        shortDescription: def.shortDescription,
        parameters: def.parameters,
        tags: def.tags,
        examples: def.examples,
        ground: def.ground,
        deferLoading: def.deferLoading,
        schemaHash: def.schemaHash,
        tier,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function getRetriever(catalog) {
    const catalogKey = `${registryVersion}:${(catalog || []).map((c) => c.name).join('|')}`;
    if (!retrieverCache || retrieverCache.key !== catalogKey) {
      retrieverCache = {
        key: catalogKey,
        version: registryVersion,
        engine: buildToolRetriever(catalog, { embedFn }),
      };
    }
    return retrieverCache.engine;
  }

  // Filter whether a tool is callable for the current turn's speaker posture
  function isVisibleForTurn(entry, { allowWriteTools = true, delegatedTools = null, turnToolsAllow = null } = {}) {
    if (!isToolAllowedByPolicy(entry.name, turnToolsAllow)) return false;
    if (allowWriteTools) return true;
    if (entry.tier === 'read_only') return true;
    const delegatedSet = Array.isArray(delegatedTools) && delegatedTools.length ? new Set(delegatedTools.map(String)) : null;
    return Boolean(delegatedSet && delegatedSet.has(entry.name));
  }

  function searchTools({
    query = '',
    queries = null,
    namespace = null,
    risk = 'all',
    limit = retrievalCfg.maxSearchResults || 5,
    allowWriteTools = true,
    delegatedTools = null,
    turnToolsAllow = null,
    includeForbiddenHints = false,
  } = {}) {
    const catalog = buildCatalog({ turnToolsAllow });
    const engine = getRetriever(catalog);
    const res = engine.search({
      query,
      queries,
      namespace,
      risk,
      limit,
      filterFn: includeForbiddenHints
        ? (entry) => isToolAllowedByPolicy(entry.name, turnToolsAllow)
        : (entry) => isVisibleForTurn(entry, { allowWriteTools, delegatedTools, turnToolsAllow }),
    });
    return {
      trust: 'third_party',
      queries: res.queries,
      totalMatches: res.totalMatches,
      availableNamespaces: res.availableNamespaces,
      tools: res.hits.map((h) => ({
        name: h.name,
        namespace: h.namespace,
        risk: h.tier,
        policy: policyForTier(h.tier, mergedApprovalOverrides),
        ground: h.ground || [],
        schemaHash: h.schemaHash,
        callable_by_current_speaker: isVisibleForTurn(h, { allowWriteTools, delegatedTools, turnToolsAllow }),
        description: h.description,
        parameters: h.parameters,
        ...(h.examples?.length ? { examples: h.examples } : {}),
      })),
    };
  }

  // Register meta-tools lazily when Portable Retrieval is active
  function ensureMetaToolsRegistered() {
    if (!tools.has('tool_search')) {
      register({
        name: 'tool_search',
        description: 'Search deferred tools by keyword or batch queries to inspect exact JSON parameter schemas before calling tool_invoke.',
        risk: 'read_only',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Single search query' },
            queries: { type: 'array', items: { type: 'string' }, description: 'Batch queries for multi-system tasks in 1 round-trip' },
            namespace: { type: 'string', description: 'Optional namespace filter (e.g. mcp.github, builtin)' },
            risk: { type: 'string', enum: ['all', 'read_only', 'write'] },
            limit: { type: 'number' },
          },
        },
        async execute(args, ctx) {
          const allowWrite = ctx?.turnClassification ? Boolean(ctx.turnClassification.writeToolsAllowed) : true;
          const result = searchTools({
            query: args.query || '',
            queries: Array.isArray(args.queries) ? args.queries : null,
            namespace: args.namespace || null,
            risk: args.risk || 'all',
            limit: Number(args.limit || retrievalCfg.maxSearchResults || 5),
            allowWriteTools: allowWrite,
            delegatedTools: ctx?.delegatedTools || null,
            turnToolsAllow: ctx?.toolsAllow || null,
          });
          if (ctx?.hydratedTools && typeof ctx.hydratedTools.set === 'function') {
            for (const item of result.tools) {
              ctx.hydratedTools.set(item.name, item.schemaHash);
            }
          }
          return result;
        },
      });
    }
    if (!tools.has('tool_invoke')) {
      // NOTE: `tool_invoke` is transparently unwrapped inside `executeTool()` BEFORE any security gate!
      register({
        name: 'tool_invoke',
        description: 'Invoke a deferred tool discovered via tool_search by exact name and JSON arguments.',
        risk: 'destructive', // never relies on this tier; unwrap enforces the real target tool's tier/policy/gates!
        confirm: { mode: 'none', reason: 'unwrapped_to_target_tool_gate' },
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact canonical tool name returned by tool_search' },
            arguments: { type: 'object', description: 'JSON object matching the tool parameter schema' },
          },
          required: ['name', 'arguments'],
        },
        async execute() {
          throw new Error('tool_invoke_must_be_unwrapped_by_executeTool');
        },
      });
    }
  }

  // Legacy/simple flat list (still sorted deterministically by name, honors IDENTITY.security.tools_allow!)
  function listSchemas({ allowWriteTools = true, delegatedTools = null, turnToolsAllow = null } = {}) {
    const catalog = buildCatalog({ turnToolsAllow });
    return catalog
      .filter((entry) => isVisibleForTurn(entry, { allowWriteTools, delegatedTools, turnToolsAllow }))
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
        tier: entry.tier,
        schemaHash: entry.schemaHash,
      }));
  }

  // §47.2 Prompt Surface Builder (3-Set C / V / E + Room-Sticky Cache Invariance!)
  //   - When `roomSticky: true` (group rooms), Region A schemas & `<available_tools>` are built from
  //     deployment Catalog C (speaker-independent) so alternating Owner/Teammate turns NEVER flip `prefixHash`!
  //   - Enforcement happens strictly at `tool_search` (Visible V) and `executeTool` (Executable E).
  function getPromptSurface({
    allowWriteTools = true,
    delegatedTools = null,
    turnToolsAllow = null,
    roomSticky = false,
    mode = retrievalCfg.mode,
    providerName = null,
    nativeToolManager = null,
  } = {}) {
    const catalogC = buildCatalog({ turnToolsAllow: roomSticky ? null : turnToolsAllow });
    const surfaceList = roomSticky
      ? catalogC
      : catalogC.filter((entry) => isVisibleForTurn(entry, { allowWriteTools, delegatedTools, turnToolsAllow }));

    const schemaBytes = surfaceList.reduce(
      (sum, t) => sum + Buffer.byteLength(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }), 'utf8'),
      0
    );

    // Providers with a native tool manager / Code-Mode (e.g. `codex-app-server` `ALL_TOOLS` + `exec`
    // or any future agent harness setting `nativeToolManager: true`) already index dynamicTools
    // out-of-band. Double-deferring moderate toolsets breaks native discovery without saving prompt
    // tokens, while very large MCP catalogs (>60 tools / 64 KB) still defer cleanly.
    const isNativeCodeMode = nativeToolManager === true
      || (nativeToolManager == null && providerName === 'codex-app-server');
    const effectiveDeferThreshold = hasExplicitDeferThreshold
      ? Number(retrievalCfg.deferThreshold || 15)
      : (isNativeCodeMode ? 60 : Number(retrievalCfg.deferThreshold || 15));
    const effectiveMaxSchemaBytes = hasExplicitMaxSchemaBytes
      ? Number(retrievalCfg.maxSchemaBytes || 8192)
      : (isNativeCodeMode ? 65536 : Number(retrievalCfg.maxSchemaBytes || 8192));

    const shouldDefer = mode === 'portable' || (
      mode !== 'off' && (
        surfaceList.length > effectiveDeferThreshold
        || schemaBytes >= effectiveMaxSchemaBytes
      )
    );

    if (!shouldDefer) {
      return {
        mode: 'direct',
        activeSchemas: surfaceList.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          tier: t.tier,
          schemaHash: t.schemaHash,
        })),
        availableToolsIndex: { text: '', hash: 'direct', deferredCount: 0, estimatedTokens: 0, tier: 'none' },
        deferredNames: new Set(),
      };
    }

    ensureMetaToolsRegistered();
    const alwaysSet = new Set(Array.isArray(retrievalCfg.alwaysLoad) ? retrievalCfg.alwaysLoad.map(String) : CORE_ALWAYS_LOAD_DEFAULTS);
    const active = [];
    const deferred = [];
    const nsDescs = {};

    for (const t of surfaceList) {
      if (t.serverDescription && t.namespace) nsDescs[t.namespace] = t.serverDescription;
      const isAlways = t.deferLoading === false || (t.deferLoading !== true && alwaysSet.has(t.name));
      if (isAlways && active.length < 10) {
        active.push({ name: t.name, description: t.description, parameters: t.parameters, tier: t.tier, schemaHash: t.schemaHash });
      } else {
        deferred.push(t);
      }
    }

    for (const metaName of ['tool_search', 'tool_invoke']) {
      const def = tools.get(metaName);
      if (def) {
        active.push({ name: def.name, description: def.description, parameters: def.parameters, tier: def.risk || 'read_only', schemaHash: def.schemaHash });
      }
    }
    active.sort((a, b) => a.name.localeCompare(b.name));

    const availableToolsIndex = buildAvailableToolsIndex(deferred, {
      maxIndexTokens: retrievalCfg.maxIndexTokens || 1500,
      namespaceDescriptions: nsDescs,
    });
    return {
      mode: 'portable',
      activeSchemas: active,
      availableToolsIndex,
      deferredNames: new Set(deferred.map((d) => d.name)),
    };
  }

  async function executeTool(rawName, args = {}, ctx = {}) {
    // ── Stage 0: Transparent Unwrap for `tool_invoke` BEFORE EVERY GATE! ──
    if (rawName === 'tool_invoke') {
      const targetNameRaw = String(args?.name || '').trim();
      const targetArgs = args?.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? args.arguments
        : {};
      if (!targetNameRaw) {
        const res = { ok: false, decision: 'deny', reason: 'tool_invoke_missing_target_name' };
        recordAudit({ tool: 'tool_invoke', decision: 'deny', reason: res.reason });
        return res;
      }
      if (targetNameRaw === 'tool_invoke' || targetNameRaw === 'tool_search') {
        const res = { ok: false, decision: 'deny', reason: 'recursive_meta_tool_denied' };
        recordAudit({ tool: targetNameRaw, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.reason });
        return res;
      }
      const resolvedTarget = resolveToolEntry(targetNameRaw);
      if (!resolvedTarget) {
        const res = { ok: false, decision: 'deny', error: `unknown_tool:${targetNameRaw}` };
        recordAudit({ tool: targetNameRaw, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.error });
        return res;
      }
      const { name: targetName, def: targetDef } = resolvedTarget;

      // Require search-before-invoke for deferred tools when enabled & hydratedTools Map is tracked
      if (retrievalCfg.requireSearchBeforeInvoke && ctx?.hydratedTools instanceof Map && ctx?.deferredNames instanceof Set && ctx.deferredNames.has(targetName)) {
        const pinnedHash = ctx.hydratedTools.get(targetName);
        if (!pinnedHash) {
          const res = {
            ok: false,
            decision: 'deny',
            reason: 'deferred_tool_not_searched_yet: call tool_search first',
            targetTool: targetName,
          };
          recordAudit({ tool: targetName, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.reason });
          return res;
        }
        if (pinnedHash !== targetDef.schemaHash) {
          const res = {
            ok: false,
            decision: 'deny',
            reason: 'mcp_schema_hash_changed_mid_session_asi04',
            targetTool: targetName,
          };
          recordAudit({ tool: targetName, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.reason });
          return res;
        }
      }

      // Host JSON Schema argument validation (compensates for provider not constraining `arguments: object`)
      const schemaCheck = validateToolArgs(targetArgs, targetDef.parameters);
      if (!schemaCheck.ok) {
        const res = {
          ok: false,
          decision: 'deny',
          reason: 'invalid_tool_arguments',
          validationErrors: schemaCheck.errors,
          expectedParameters: targetDef.parameters,
        };
        recordAudit({ tool: targetName, viaMetaTool: 'tool_invoke', decision: 'deny', reason: res.reason, validationErrors: schemaCheck.errors });
        return res;
      }

      // Delegate straight into the SINGLE unified gate under the REAL target tool name!
      return executeTool(targetName, targetArgs, { ...ctx, viaMetaTool: 'tool_invoke' });
    }

    const resolved = resolveToolEntry(rawName);
    if (!resolved) {
      const res = { ok: false, decision: 'deny', error: `unknown_tool:${rawName}` };
      recordAudit({ tool: rawName, viaMetaTool: ctx.viaMetaTool || null, decision: 'deny', reason: res.error });
      return res;
    }
    const { name, def } = resolved;

    // ── Stage 0B: Host JSON Schema Argument Validation for ALL calls (direct & unwrapped) ──
    if (def.parameters && typeof def.parameters === 'object') {
      const argCheck = validateToolArgs(args || {}, def.parameters);
      if (!argCheck.ok) {
        const res = {
          ok: false,
          decision: 'deny',
          reason: 'invalid_tool_arguments',
          validationErrors: argCheck.errors,
        };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, decision: 'deny', reason: res.reason, validationErrors: argCheck.errors });
        return res;
      }
    }

    // ── Stage 1: Unified Allow-List (`IDENTITY.security.tools_allow` ∩ per-turn `toolsAllow`) ──
    if (!isToolAllowedByPolicy(name, ctx.toolsAllow || null)) {
      const res = { ok: false, decision: 'deny', reason: `tool_not_in_allowlist:${name}` };
      recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, decision: 'deny', reason: res.reason });
      return res;
    }

    const { tier, via } = resolveEffectiveTier(name, def);
    const policy = policyForTier(tier, mergedApprovalOverrides);

    // ── Stage 2: §42 Boundary Wall (external / mixed-group turns strictly read_only unless delegated) ──
    const delegatedSet = Array.isArray(ctx.delegatedTools) ? new Set(ctx.delegatedTools.map(String)) : null;
    if (ctx.turnClassification && !ctx.turnClassification.writeToolsAllowed && tier !== 'read_only' && !(delegatedSet && delegatedSet.has(name))) {
      const res = { ok: false, decision: 'deny', tier, policy, reason: 'boundary_wall_write_tools_blocked' };
      recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, decision: 'deny', reason: res.reason });
      return res;
    }

    // ── Stage 3: §28 Fail-Closed Confirm Spec Check BEFORE running high-risk actions ──
    const isHighRisk = tier === 'financial' || tier === 'destructive';
    if (isHighRisk) {
      const hasValidConfirm = Boolean(
        def.confirm && (
          (def.confirm.probe && def.confirm.expect)
          || (def.confirm.mode === 'none' && typeof def.confirm.reason === 'string' && def.confirm.reason.trim().length > 0)
        )
      );
      if (!hasValidConfirm) {
        const res = { ok: false, decision: 'deny', tier, policy, reason: 'confirm_spec_required_for_high_risk_tool' };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
    }

    // ── Stage 4: §22 Provenance-Aware Grounding Pre-Check (FAIL CLOSED!) ──
    const groundingRequired = needsGrounding(tier);
    let grounded = null;
    let groundingMissing = [];
    if (groundingRequired) {
      const mcpEntry = mcpRisk[name];
      // Union ground keys from `.mcp.json` AND tool definition so neither can silently erase the other
      const groundKeys = [...new Set([
        ...(Array.isArray(mcpEntry?.ground) ? mcpEntry.ground : []),
        ...(Array.isArray(def.ground) ? def.ground : []),
      ])];
      if (!groundKeys.length) {
        // High-risk tool without declared grounding specification -> FAIL CLOSED!
        const res = {
          ok: false,
          decision: 'deny',
          tier,
          policy,
          reason: 'grounding_spec_required_for_high_risk_tool',
          missingGrounding: ['_missing_ground_spec'],
        };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
      const subset = {};
      const missingArgs = [];
      for (const k of groundKeys) {
        const val = args ? args[k] : undefined;
        if (Array.isArray(val)) {
          // Optional array field (`exec.args`): if provided & non-empty, ground EVERY element;
          // for all other required high-risk fields, an empty array [] is missing!
          const items = val.map((x) => String(x ?? '').trim()).filter(Boolean);
          if (!items.length && !(name === 'exec' && k === 'args')) {
            missingArgs.push(k);
          } else {
            for (let i = 0; i < items.length; i++) {
              subset[`${k}[${i}]`] = items[i];
            }
          }
        } else if (val !== undefined && val !== null && String(val).trim() !== '') {
          subset[k] = val;
        } else if (!(name === 'exec' && k === 'args')) {
          missingArgs.push(k);
        }
      }
      if (missingArgs.length) {
        grounded = false;
        groundingMissing = missingArgs;
      } else {
        // Provenance-safe grounding: prefer `trustedGroundingSources` (excludes untrusted web_fetch/external pages!)
        const sourceText = ctx.trustedGroundingSources !== undefined
          ? ctx.trustedGroundingSources
          : (ctx.groundingSources || '');
        const g = checkGrounding(subset, sourceText);
        grounded = g.ok;
        groundingMissing = g.missing;
      }
    }

    // ── Stage 5: Per-Call Approval Verification & HITL Callback (NO bare `approved: true` bypass!) ──
    const effectiveUserDoc = ctx.userDoc || userDoc;
    const actionAmount = args?.amount != null && Number.isFinite(Number(args.amount)) ? Number(args.amount) : null;
    let approved = false;
    let approverId = null;

    if (ctx.approvalTokenId && approvalStore) {
      const chk = approvalStore.consume({
        tokenId: ctx.approvalTokenId,
        tool: name,
        args,
        userDoc: effectiveUserDoc,
        tier,
        amount: actionAmount,
        conversationId: ctx.chatId || null,
        turnId: ctx.turnId || null,
        schemaHash: def.schemaHash || null,
      });
      if (!chk.ok) {
        const res = { ok: false, decision: 'deny', tier, policy, reason: chk.reason };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
      approved = true;
      approverId = chk.token.approver || null;
    } else if (ctx.approved === true) {
      // Strictly reject bare turn-wide `approved: true` AND enforce single-use latch so two identical tool calls
      // in the same turn cannot replay the same inline approval!
      if (ctx.inlineApprovalState?.used || ctx._inlineApprovalUsed) {
        const res = { ok: false, decision: 'deny', tier, policy, reason: 'approval_already_used' };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
      if (!ctx.approvedTool || ctx.approvedTool !== name) {
        const res = {
          ok: false,
          decision: 'deny',
          tier,
          policy,
          reason: ctx.approvedTool ? 'approval_tool_mismatch' : 'approval_binding_required',
        };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
      const actualArgsHash = hashArgs(args || {});
      if (!ctx.approvedArgsHash || ctx.approvedArgsHash !== actualArgsHash) {
        const res = { ok: false, decision: 'deny', tier, policy, reason: 'approval_args_hash_mismatch' };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
        return res;
      }
      if (effectiveUserDoc && effectiveUserDoc.active && typeof effectiveUserDoc.canApprove === 'function') {
        if (!ctx.approver) {
          const res = { ok: false, decision: 'deny', tier, policy, reason: 'approval_missing_approver' };
          recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
          return res;
        }
        const authChk = effectiveUserDoc.canApprove(ctx.approver, { tier, amount: actionAmount });
        if (authChk && authChk.ok === false) {
          const res = { ok: false, decision: 'deny', tier, policy, reason: authChk.reason || 'approver_not_authorized' };
          recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', approver: ctx.approver, reason: res.reason });
          return res;
        }
      }
      if (ctx.inlineApprovalState && typeof ctx.inlineApprovalState === 'object') {
        ctx.inlineApprovalState.used = true;
      }
      ctx._inlineApprovalUsed = true;
      approved = true;
      approverId = ctx.approver || null;
    }

    let evalRes = evaluateAction({ tier, policy, approved, groundingRequired, grounded });

    if (evalRes.decision === 'deny') {
      const res = { ok: false, decision: 'deny', tier, policy, reason: evalRes.reason, missingGrounding: groundingMissing };
      recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: evalRes.reason, missingGrounding: groundingMissing });
      return res;
    }

    if (evalRes.decision === 'await') {
      const approverFn = ctx.requestApproval || requestApproval;
      if (typeof approverFn === 'function') {
        if (typeof ctx.onApprovalRequested === 'function') {
          try { ctx.onApprovalRequested({ tool: name, tier }); } catch { /* ignore */ }
        }
        const decision = await approverFn({
          tool: name,
          server: def.server || null,
          schemaHash: def.schemaHash,
          tier,
          policy,
          args,
          amount: actionAmount,
          chatId: ctx.chatId || null,
          sender: ctx.sender || null,
        });
        const isApproved = Boolean(decision === true || (decision && decision.approved === true));
        const by = (decision && typeof decision === 'object' && (decision.approver || decision.by)) || null;
        if (isApproved) {
          if (effectiveUserDoc && effectiveUserDoc.active && typeof effectiveUserDoc.canApprove === 'function') {
            if (!by) {
              const res = { ok: false, decision: 'deny', tier, policy, reason: 'approval_missing_approver' };
              recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', reason: res.reason });
              return res;
            }
            const authChk = effectiveUserDoc.canApprove(by, { tier, amount: actionAmount });
            if (authChk && authChk.ok === false) {
              const res = { ok: false, decision: 'deny', tier, policy, reason: authChk.reason || 'approver_not_authorized' };
              recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', approver: by, reason: res.reason });
              return res;
            }
          }
          if (approvalStore) {
            const tok = approvalStore.issue({
              tool: name,
              args,
              approver: by,
              tier,
              amount: actionAmount,
              conversationId: ctx.chatId || null,
              turnId: ctx.turnId || null,
              schemaHash: def.schemaHash || null,
            });
            const consumed = approvalStore.consume({
              tokenId: tok.id,
              tool: name,
              args,
              userDoc: effectiveUserDoc,
              tier,
              amount: actionAmount,
              conversationId: ctx.chatId || null,
              turnId: ctx.turnId || null,
              schemaHash: def.schemaHash || null,
            });
            approved = consumed.ok;
            approverId = by;
            if (!consumed.ok) {
              const res = { ok: false, decision: 'deny', tier, policy, reason: consumed.reason };
              recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'deny', approver: by, reason: res.reason });
              return res;
            }
          } else {
            approved = true;
            approverId = by;
          }
        }
        evalRes = evaluateAction({ tier, policy, approved, groundingRequired, grounded });
      }
      if (evalRes.decision !== 'allow') {
        const res = { ok: false, decision: 'await', tier, policy, reason: evalRes.reason };
        recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'await', reason: evalRes.reason });
        return res;
      }
    }

    // ── Stage 6: Execute Tool + §28 Read-Only Probe Confirmation + Spill-to-File Limiter ──
    try {
      const rawOutput = await def.execute(args || {}, ctx);
      const mediaItems = Array.isArray(rawOutput?._scrollMediaItems) ? rawOutput._scrollMediaItems : [];
      const output = applySpillToFileLimit(rawOutput, {
        toolName: name,
        maxChars: ctx.maxToolOutputChars || maxToolOutputChars,
        spillDir: ctx.spillDir || effectiveSpillDir,
      });
      if (mediaItems.length && output && typeof output === 'object' && !output._scrollMediaItems) {
        Object.defineProperty(output, '_scrollMediaItems', {
          value: mediaItems,
          enumerable: false,
          configurable: true,
        });
      }
      let confirmation = null;
      if (def.confirm && def.confirm.mode !== 'none') {
        confirmation = await confirmEffect({
          tool: name,
          tier,
          confirm: def.confirm,
          params: args || {},
          invoke: async (probeName, probeParams) => {
            const probeResolved = resolveToolEntry(probeName);
            if (!probeResolved) throw new Error(`confirm_probe_not_found:${probeName}`);
            const probeTier = resolveEffectiveTier(probeResolved.name, probeResolved.def).tier;
            if (probeTier !== 'read_only') {
              throw new Error(`confirm_probe_must_be_read_only:${probeResolved.name}:${probeTier}`);
            }
            return probeResolved.def.execute(probeParams || {}, ctx);
          },
        });
        if (!confirmation.ok) {
          recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'unconfirmed', reason: confirmation.reason });
          return { ok: false, decision: 'unconfirmed', executed: true, tier, policy, output, mediaItems, confirmation, error: confirmation.reason };
        }
      }
      recordAudit({
        tool: name,
        viaMetaTool: ctx.viaMetaTool || null,
        tier,
        policy,
        via,
        decision: 'allow',
        ok: true,
        approved,
        approver: approverId,
        trustedOutput: def.trustedOutput,
      });
      return { ok: true, decision: 'allow', executed: true, tier, policy, output, mediaItems, confirmation, trustedOutput: def.trustedOutput };
    } catch (err) {
      const msg = String(err?.message || err);
      recordAudit({ tool: name, viaMetaTool: ctx.viaMetaTool || null, tier, policy, via, decision: 'error', error: msg });
      return { ok: false, decision: 'error', executed: true, tier, policy, error: msg };
    }
  }

  return {
    register,
    registerSkills,
    unregister,
    setKnowledgeIndex,
    syncMcpTools,
    listSchemas,
    getPromptSurface,
    searchTools,
    executeTool,
    has: (name) => Boolean(resolveToolEntry(name)),
    getAuditLog: () => [...auditLog],
    getQuarantinedTools: () => [...quarantinedMcp.entries()].map(([name, info]) => ({ name, ...info })),
    get securityConfig() { return sec; },
  };
}
