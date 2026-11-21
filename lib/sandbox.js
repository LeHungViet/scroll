// SCROLL 2.5 -- §20.4 / D07 Zero-Dependency OS Sandbox, Process Hygiene & Argv Exec Policy.
//
// Isolates `exec` and subprocess tool execution at the OS kernel boundary:
//   - macOS: `/usr/bin/sandbox-exec` with DENY-DEFAULT SBPL profile (`(deny default)`):
//            blocks $HOME reads outside cwd, blocks Mach/AppleEvents/LaunchServices escape,
//            blocks all writes outside cwd & /tmp, marks sensitive policy/VCS subpaths
//            (.git, .scroll, agents, .mcp.json, mcp-lock.json, USER.md) read-only inside cwd,
//            and blocks network by default.
//   - Linux: `bwrap` (Bubblewrap namespaces: --unshare-user/pid/ipc/uts/net, --new-session,
//            --cap-drop ALL, --clearenv + explicit --setenv, read-only system dirs, and
//            read-only overlay of sensitive policy/VCS subpaths inside cwd).
//   - Process-group isolation: spawns detached and terminates the entire process group
//     (`process.kill(-pid, 'SIGKILL')`) on timeout or AbortSignal, with streaming byte caps.
//   - Declarative argv-prefix exec policy (`evaluateExecPolicy`), never shell-string regexes.
//   - Pluggable `execRunner` hook for custom container/microVM runners.
//   - Fail-closed when `requireSandbox: true` and no OS sandbox binary is available.
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TERM',
  'NO_COLOR',
];

// Sensitive subpaths inside a writable workspace that MUST remain read-only so sandboxed
// commands cannot install persistent code or weaken SCROLL security policy.
export const PROTECTED_CWD_SUBPATHS = Object.freeze([
  '.git',
  '.scroll',
  '.mcp.json',
  'mcp-lock.json',
  'USER.md',
  'agents',
]);

// Sensitive directories under $HOME that are always denied read & write in Seatbelt.
const SENSITIVE_HOME_SUBDIRS = Object.freeze([
  '.ssh',
  '.aws',
  '.gnupg',
  '.openclaw',
  '.scroll-telegram',
  '.kube',
  '.config',
]);

const SECRET_ENV_NAME_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|COOKIE|PRIVATE|BEARER)(?:$|_)/i;

export function buildSanitizedEnv({
  allowEnv = DEFAULT_ENV_ALLOWLIST,
  extraEnv = null,
  baseEnv = process.env,
  sandboxHome = null,
} = {}) {
  const out = {};
  const allowSet = new Set(Array.isArray(allowEnv) ? allowEnv.map(String) : DEFAULT_ENV_ALLOWLIST);
  for (const k of allowSet) {
    if (baseEnv && baseEnv[k] !== undefined && !SECRET_ENV_NAME_RE.test(k)) {
      out[k] = String(baseEnv[k]);
    }
  }
  if (!out.PATH) out.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  if (sandboxHome) {
    out.HOME = String(sandboxHome);
    out.TMPDIR = out.TMPDIR || os.tmpdir();
  }
  if (extraEnv && typeof extraEnv === 'object') {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v !== undefined && v !== null) out[String(k)] = String(v);
    }
  }
  return out;
}

function realpathSafe(p) {
  try { return fs.realpathSync.native(p); } catch {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  }
}

function escapeSbpl(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isUnsafeSandboxCwd(realCwd, realHome) {
  if (!realCwd || realCwd === '/' || realCwd === realHome) return true;
  // Also reject direct ancestor of realHome (e.g. /Users or /home)
  if (realHome && realHome.startsWith(realCwd + path.sep)) return true;
  return false;
}

function safeRuntimeReadPrefixes(command, realHome) {
  if (!command || !path.isAbsolute(command)) return [];
  const binReal = realpathSafe(command);
  const binDir = path.dirname(binReal);
  const parent = path.dirname(binDir);
  const isSafePrefix = (p) => {
    if (!p || p === '/' || p === realHome || p === '/Users' || p === '/home') return false;
    if (realHome && realHome.startsWith(p + path.sep)) return false;
    return true;
  };
  const out = [];
  if (isSafePrefix(binDir)) out.push(binDir);
  // Allow versioned runtime prefix (e.g. ~/.nvm/versions/node/v24.x or /opt/homebrew/Cellar/node/24.x)
  // ONLY when binReal sits inside a `bin/` subdir and parent is strictly below realHome or /opt,
  // NEVER `/` and NEVER `realHome` itself!
  if (path.basename(binDir) === 'bin' && isSafePrefix(parent) && parent !== '/usr' && parent !== '/usr/local') {
    out.push(parent);
  }
  return out;
}

export function detectOsSandbox({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    if (fs.existsSync('/usr/bin/sandbox-exec')) {
      return { available: true, kind: 'seatbelt', bin: '/usr/bin/sandbox-exec' };
    }
    return { available: false, kind: null, bin: null };
  }
  if (platform === 'linux') {
    for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']) {
      if (fs.existsSync(candidate)) {
        return { available: true, kind: 'bwrap', bin: candidate };
      }
    }
    return { available: false, kind: null, bin: null };
  }
  return { available: false, kind: null, bin: null };
}

// Declarative Codex-style argv-prefix execution policy (data-driven, never shell regex).
// Rule formats:
//   - "git"                                  -> matches command basename "git" with any args
//   - ["git", "status"]                      -> matches command basename "git" + args prefix ["status"]
//   - { prefix: ["python3", "script.py"] }   -> matches prefix array
//   - { prefix: ["rm", "-rf"], decision: "deny" }
function normalizeExecRule(raw, defaultDecision = 'allow') {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed ? { prefix: [trimmed], decision: defaultDecision } : null;
  }
  if (Array.isArray(raw)) {
    const prefix = raw.map((x) => String(x || '').trim()).filter(Boolean);
    return prefix.length ? { prefix, decision: defaultDecision } : null;
  }
  if (typeof raw === 'object' && Array.isArray(raw.prefix)) {
    const prefix = raw.prefix.map((x) => String(x || '').trim()).filter(Boolean);
    const decision = raw.decision === 'deny' ? 'deny' : defaultDecision;
    return prefix.length ? { prefix, decision } : null;
  }
  return null;
}

function matchesArgvPrefix(argv, prefix) {
  if (!Array.isArray(prefix) || !prefix.length || argv.length < prefix.length) return false;
  const cmd = argv[0];
  const cmdBase = path.basename(cmd);
  const p0 = prefix[0];
  if (p0 !== '*' && p0 !== cmd && p0 !== cmdBase) return false;
  for (let i = 1; i < prefix.length; i++) {
    const pat = prefix[i];
    if (pat === '*') continue;
    if (pat.endsWith('*')) {
      if (!argv[i].startsWith(pat.slice(0, -1))) return false;
    } else if (argv[i] !== pat) {
      return false;
    }
  }
  return true;
}

export function evaluateExecPolicy({
  command,
  args = [],
  allowRules = null,
  denyRules = null,
} = {}) {
  const bin = String(command || '').trim();
  if (!bin) return { ok: false, decision: 'deny', reason: 'exec_missing_command' };
  const argv = [bin, ...(Array.isArray(args) ? args.map(String) : [])];

  const denies = [];
  const allows = [];
  for (const r of Array.isArray(denyRules) ? denyRules : []) {
    const norm = normalizeExecRule(r, 'deny');
    if (norm) denies.push(norm);
  }
  if (Array.isArray(allowRules)) {
    for (const r of allowRules) {
      const norm = normalizeExecRule(r, 'allow');
      if (!norm) continue;
      if (norm.decision === 'deny') denies.push(norm);
      else allows.push(norm);
    }
  }

  for (const d of denies) {
    if (matchesArgvPrefix(argv, d.prefix)) {
      return { ok: false, decision: 'deny', reason: `exec_policy_denied:${d.prefix.join(' ')}` };
    }
  }

  if (Array.isArray(allowRules)) {
    for (const a of allows) {
      if (matchesArgvPrefix(argv, a.prefix)) {
        return { ok: true, decision: 'allow', matchedRule: a.prefix };
      }
    }
    return { ok: false, decision: 'deny', reason: `exec_command_not_allowed:${path.basename(bin)}` };
  }

  return { ok: true, decision: 'allow', matchedRule: null };
}

export function buildSeatbeltProfile({
  cwd,
  command = null,
  extraReadPaths = [],
  protectedSubpaths = PROTECTED_CWD_SUBPATHS,
  allowNetwork = false,
} = {}) {
  const realCwd = realpathSafe(cwd || process.cwd());
  const realHome = realpathSafe(os.homedir());
  const realTmp = realpathSafe(os.tmpdir());

  if (isUnsafeSandboxCwd(realCwd, realHome)) {
    throw new Error(`sandbox_unsafe_cwd:${realCwd}`);
  }

  const readAllows = new Set([
    '/usr',
    '/bin',
    '/sbin',
    '/System',
    '/Library/Frameworks',
    '/Library/Apple',
    '/Library/Developer/CommandLineTools',
    '/Applications/Xcode.app/Contents/Developer',
    '/private/var/db',
    '/private/etc',
    '/etc',
    '/dev',
    '/opt/homebrew',
    '/nix',
    realCwd,
    realTmp,
    '/tmp',
    '/private/tmp',
  ]);
  for (const p of safeRuntimeReadPrefixes(command, realHome)) {
    readAllows.add(p);
  }
  for (const p of extraReadPaths || []) {
    if (!p) continue;
    const rp = realpathSafe(p);
    if (!isUnsafeSandboxCwd(rp, realHome)) readAllows.add(rp);
  }

  const readClauses = [...readAllows].map((p) => `(subpath "${escapeSbpl(p)}")`).join(' ');
  const writeClauses = [realCwd, realTmp, '/tmp', '/private/tmp']
    .map((p) => `(subpath "${escapeSbpl(p)}")`)
    .join(' ');

  const machServices = [
    '(global-name "com.apple.system.logger")',
    '(global-name "com.apple.system.notification_center")',
  ];
  if (allowNetwork) {
    machServices.push(
      '(global-name "com.apple.SystemConfiguration.configd")',
      '(global-name "com.apple.SystemConfiguration.DNSConfiguration")',
      '(global-name "com.apple.mDNSResponder")',
      '(global-name "com.apple.TrustEvaluationAgent")',
      '(global-name "com.apple.SecurityServer")',
    );
  }

  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    `(allow mach-lookup ${machServices.join(' ')})`,
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${readClauses})`,
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    `(allow file-write* ${writeClauses})`,
  ];

  if (allowNetwork) {
    lines.push('(allow network*)');
  } else {
    lines.push('(deny network*)');
  }

  // Last-match-wins: lock sensitive policy & VCS paths inside writable cwd as read-only
  for (const rel of protectedSubpaths || []) {
    if (!rel) continue;
    const full = path.join(realCwd, rel);
    lines.push(`(deny file-write* (subpath "${escapeSbpl(full)}") (literal "${escapeSbpl(full)}"))`);
  }

  // Defense-in-depth: unconditionally deny sensitive $HOME credential dirs at profile tail
  const sensitiveClauses = SENSITIVE_HOME_SUBDIRS
    .map((rel) => `(subpath "${escapeSbpl(path.join(realHome, rel))}")`)
    .join(' ');
  lines.push(`(deny file-read* file-write* ${sensitiveClauses})`);

  return lines.join('\n');
}

export function buildBwrapArgs({
  cwd,
  command,
  args = [],
  env = null,
  protectedSubpaths = PROTECTED_CWD_SUBPATHS,
  allowNetwork = false,
} = {}) {
  const realCwd = realpathSafe(cwd || process.cwd());
  const realHome = realpathSafe(os.homedir());
  if (isUnsafeSandboxCwd(realCwd, realHome)) {
    throw new Error(`sandbox_unsafe_cwd:${realCwd}`);
  }

  const bwrapArgs = [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--new-session',
    '--cap-drop', 'ALL',
    '--die-with-parent',
    '--clearenv',
  ];
  if (!allowNetwork) bwrapArgs.push('--unshare-net');

  const safeEnv = env || buildSanitizedEnv({ sandboxHome: realCwd });
  for (const [k, v] of Object.entries(safeEnv)) {
    bwrapArgs.push('--setenv', String(k), String(v));
  }

  for (const ro of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt/homebrew', '/nix', '/snap']) {
    if (fs.existsSync(ro)) bwrapArgs.push('--ro-bind', ro, ro);
  }
  for (const p of safeRuntimeReadPrefixes(command, realHome)) {
    if (fs.existsSync(p)) bwrapArgs.push('--ro-bind', p, p);
  }

  bwrapArgs.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', realCwd, realCwd,
  );

  // Re-mount existing protected policy & VCS paths inside cwd as read-only
  for (const rel of protectedSubpaths || []) {
    if (!rel) continue;
    const full = path.join(realCwd, rel);
    if (fs.existsSync(full)) {
      bwrapArgs.push('--ro-bind', full, full);
    }
  }

  bwrapArgs.push(
    '--chdir', realCwd,
    '--',
    String(command),
    ...(Array.isArray(args) ? args.map(String) : []),
  );
  return bwrapArgs;
}

// Spawn with detached process-group kill on timeout/abort and streaming byte caps (no unbounded RAM buffer).
function spawnBoundedProcess(bin, argv, { cwd, env, timeoutMs, maxBuffer, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('sandbox_exec_aborted'));
      return;
    }

    const child = spawn(bin, argv, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const cap = Math.max(4096, Number(maxBuffer || 4 * 1024 * 1024));
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let killedReason = null;

    function killGroup() {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }

    const timer = setTimeout(() => {
      killedReason = `sandbox_exec_timeout:${timeoutMs}ms`;
      killGroup();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const onAbort = () => {
      killedReason = 'sandbox_exec_aborted';
      killGroup();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    child.stdout?.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stdoutBytes < cap) {
        const take = Math.min(buf.length, cap - stdoutBytes);
        stdoutChunks.push(take === buf.length ? buf : buf.subarray(0, take));
        stdoutBytes += take;
        if (take < buf.length) stdoutTruncated = true;
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr?.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (stderrBytes < cap) {
        const take = Math.min(buf.length, cap - stderrBytes);
        stderrChunks.push(take === buf.length ? buf : buf.subarray(0, take));
        stderrBytes += take;
        if (take < buf.length) stderrTruncated = true;
      } else {
        stderrTruncated = true;
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      killGroup();
      reject(err);
    });

    child.once('close', (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (killedReason) {
        const err = new Error(killedReason);
        err.stdout = stdout;
        err.stderr = stderr;
        err.killed = true;
        reject(err);
        return;
      }
      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `exit_${code ?? sig}`;
        const err = new Error(`Command failed (${code ?? sig}): ${msg.slice(0, 500)}`);
        err.code = code;
        err.signal = sig;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr, stdoutTruncated, stderrTruncated });
    });
  });
}

export async function runSandboxedExec({
  command,
  args = [],
  cwd = process.cwd(),
  allowEnv = DEFAULT_ENV_ALLOWLIST,
  extraEnv = null,
  baseEnv = process.env,
  timeoutMs = 15_000,
  maxBuffer = 4 * 1024 * 1024,
  sandbox = 'os', // 'os' | 'none'
  requireSandbox = true,
  allowNetwork = false,
  protectedSubpaths = PROTECTED_CWD_SUBPATHS,
  execRunner = null,
  signal = null,
} = {}) {
  const bin = String(command || '').trim();
  if (!bin) throw new Error('sandbox_exec: command is required');
  const cmdArgs = Array.isArray(args) ? args.map(String) : [];
  const realCwd = realpathSafe(cwd);
  const env = buildSanitizedEnv({ allowEnv, extraEnv, baseEnv, sandboxHome: realCwd });
  const effTimeout = Math.min(60_000, Math.max(500, Number(timeoutMs || 15_000)));

  if (typeof execRunner === 'function') {
    return execRunner({
      command: bin,
      args: cmdArgs,
      cwd: realCwd,
      env,
      timeoutMs: effTimeout,
      maxBuffer,
      allowNetwork,
      signal,
    });
  }

  if (sandbox === 'none') {
    if (requireSandbox) throw new Error('sandbox_required_cannot_disable');
    const r = await spawnBoundedProcess(bin, cmdArgs, { cwd: realCwd, env, timeoutMs: effTimeout, maxBuffer, signal });
    return { ok: true, exitCode: 0, stdout: r.stdout, stderr: r.stderr, truncated: r.stdoutTruncated || r.stderrTruncated, sandbox: 'none' };
  }

  const detected = detectOsSandbox();
  if (!detected.available) {
    if (requireSandbox) {
      throw new Error(`sandbox_unavailable: no OS sandbox binary found on ${process.platform}`);
    }
    const r = await spawnBoundedProcess(bin, cmdArgs, { cwd: realCwd, env, timeoutMs: effTimeout, maxBuffer, signal });
    return { ok: true, exitCode: 0, stdout: r.stdout, stderr: r.stderr, truncated: r.stdoutTruncated || r.stderrTruncated, sandbox: 'fallback_unsandboxed' };
  }

  if (detected.kind === 'seatbelt') {
    const profile = buildSeatbeltProfile({ cwd: realCwd, command: bin, protectedSubpaths, allowNetwork });
    const r = await spawnBoundedProcess(detected.bin, ['-p', profile, bin, ...cmdArgs], {
      cwd: realCwd,
      env,
      timeoutMs: effTimeout,
      maxBuffer,
      signal,
    });
    return { ok: true, exitCode: 0, stdout: r.stdout, stderr: r.stderr, truncated: r.stdoutTruncated || r.stderrTruncated, sandbox: 'seatbelt' };
  }

  const bwrapArgs = buildBwrapArgs({ cwd: realCwd, command: bin, args: cmdArgs, env, protectedSubpaths, allowNetwork });
  const r = await spawnBoundedProcess(detected.bin, bwrapArgs, {
    cwd: realCwd,
    env,
    timeoutMs: effTimeout,
    maxBuffer,
    signal,
  });
  return { ok: true, exitCode: 0, stdout: r.stdout, stderr: r.stderr, truncated: r.stdoutTruncated || r.stderrTruncated, sandbox: 'bwrap' };
}
