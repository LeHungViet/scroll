// SCROLL 2.5 -- §20.4 / D07 Zero-Dependency OS Sandbox & Sanitized Process Env.
//
// Isolates `exec` and subprocess tool execution at the OS kernel boundary:
//   - macOS: `/usr/bin/sandbox-exec` (Seatbelt SBPL profile: blocks $HOME reads outside cwd,
//            blocks all writes outside cwd & /tmp, blocks network by default)
//   - Linux: `bwrap` (Bubblewrap namespaces: isolated mount/pid/net/ipc, read-only system dirs)
//   - Pluggable `execRunner` hook for custom container/microVM runners
//   - Fail-closed when `requireSandbox: true` and no OS sandbox binary is available
//   - Strict minimal environment allowlist preventing ambient API keys & bot tokens from leaking
//
// Zero runtime dependencies. Node >= 20 built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export function buildSeatbeltProfile({
  cwd,
  command = null,
  extraReadPaths = [],
  allowNetwork = false,
} = {}) {
  const realCwd = realpathSafe(cwd || process.cwd());
  const realHome = realpathSafe(os.homedir());
  const realTmp = realpathSafe(os.tmpdir());

  const readAllows = new Set([realCwd, realTmp, '/tmp', '/private/tmp']);
  if (command && path.isAbsolute(command)) {
    const binReal = realpathSafe(command);
    // Allow reading the runtime installation prefix (e.g. nvm/homebrew node dir)
    readAllows.add(path.dirname(path.dirname(binReal)));
    readAllows.add(path.dirname(binReal));
  }
  for (const p of extraReadPaths || []) {
    if (p) readAllows.add(realpathSafe(p));
  }

  const readClauses = [...readAllows].map((p) => `(subpath "${escapeSbpl(p)}")`).join(' ');
  const writeClauses = [realCwd, realTmp, '/tmp', '/private/tmp']
    .map((p) => `(subpath "${escapeSbpl(p)}")`)
    .join(' ');

  const lines = [
    '(version 1)',
    '(allow default)',
  ];
  if (!allowNetwork) {
    lines.push('(deny network*)');
  }
  lines.push(
    '(deny file-write*)',
    `(allow file-write* ${writeClauses} (literal "/dev/null"))`,
    `(deny file-read* (subpath "${escapeSbpl(realHome)}"))`,
    `(allow file-read* ${readClauses})`,
    `(allow file-read-metadata (subpath "${escapeSbpl(realHome)}"))`,
  );
  return lines.join('\n');
}

export function buildBwrapArgs({
  cwd,
  command,
  args = [],
  allowNetwork = false,
} = {}) {
  const realCwd = realpathSafe(cwd || process.cwd());
  const bwrapArgs = [
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
  ];
  if (!allowNetwork) bwrapArgs.push('--unshare-net');
  for (const ro of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
    if (fs.existsSync(ro)) bwrapArgs.push('--ro-bind', ro, ro);
  }
  bwrapArgs.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--bind', realCwd, realCwd,
    '--chdir', realCwd,
    '--',
    String(command),
    ...(Array.isArray(args) ? args.map(String) : []),
  );
  return bwrapArgs;
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
    const { stdout, stderr } = await execFileAsync(bin, cmdArgs, {
      cwd: realCwd,
      env,
      timeout: effTimeout,
      maxBuffer,
      signal: signal || undefined,
    });
    return { ok: true, exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || ''), sandbox: 'none' };
  }

  const detected = detectOsSandbox();
  if (!detected.available) {
    if (requireSandbox) {
      throw new Error(`sandbox_unavailable: no OS sandbox binary found on ${process.platform}`);
    }
    const { stdout, stderr } = await execFileAsync(bin, cmdArgs, {
      cwd: realCwd,
      env,
      timeout: effTimeout,
      maxBuffer,
      signal: signal || undefined,
    });
    return { ok: true, exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || ''), sandbox: 'fallback_unsandboxed' };
  }

  if (detected.kind === 'seatbelt') {
    const profile = buildSeatbeltProfile({ cwd: realCwd, command: bin, allowNetwork });
    const { stdout, stderr } = await execFileAsync(detected.bin, ['-p', profile, bin, ...cmdArgs], {
      cwd: realCwd,
      env,
      timeout: effTimeout,
      maxBuffer,
      signal: signal || undefined,
    });
    return { ok: true, exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || ''), sandbox: 'seatbelt' };
  }

  const bwrapArgs = buildBwrapArgs({ cwd: realCwd, command: bin, args: cmdArgs, allowNetwork });
  const { stdout, stderr } = await execFileAsync(detected.bin, bwrapArgs, {
    cwd: realCwd,
    env,
    timeout: effTimeout,
    maxBuffer,
    signal: signal || undefined,
  });
  return { ok: true, exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || ''), sandbox: 'bwrap' };
}
