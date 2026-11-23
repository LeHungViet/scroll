// SCROLL 2.5 -- Automated 2-Package Tarball Packaging, Zero-Leak, & CLI Gates (G13, G14).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const TG_PKG_DIR = path.join(REPO, 'packages', 'scroll-telegram');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✔ ${name}`); pass++; }
  catch (e) { console.error(`  ✖ ${name} -- ${e?.stack || e}`); fail++; }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scroll-v25-pack-'));
console.log('SCROLL 2.5 -- 2-Package Monorepo Tarball Gate, Zero-Leak Scan, & CLI Subcommands (G13, G14)');

// ── G13: Package metadata, zero dependencies, exports map, & clean /tmp tarball install ──
await t('G13: @agentpro/scroll & @agentpro/scroll-telegram lockstep 2.5.x with dependencies: {} and zero relative parent imports', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const tgPkg = JSON.parse(fs.readFileSync(path.join(TG_PKG_DIR, 'package.json'), 'utf8'));

  assert.match(rootPkg.version, /^2\.5\.\d+$/);
  assert.deepEqual(rootPkg.dependencies, {});
  assert.ok(rootPkg.exports['.']);
  assert.ok(rootPkg.exports['./chat']);
  assert.ok(rootPkg.exports['./lib/*'], 'Bot Room backward-compat ./lib/* export must be preserved');

  assert.equal(tgPkg.name, '@agentpro/scroll-telegram');
  assert.equal(tgPkg.version, rootPkg.version);
  assert.deepEqual(tgPkg.dependencies, {});
  assert.equal(tgPkg.peerDependencies['@agentpro/scroll'], `^${rootPkg.version}`);

  // Verify zero parent relative imports (`../../` escaping package) in scroll-telegram
  for (const rel of ['src/index.js', 'src/telegram-api.js', 'src/telegram-admin-ui.js', 'src/telegram-daemon.js', 'bin/scroll-telegram.js']) {
    const src = fs.readFileSync(path.join(TG_PKG_DIR, rel), 'utf8');
    assert.ok(!src.includes('../../'), `${rel} must not contain parent-escaping ../../ imports`);
    assert.ok(!/jen-extensions/i.test(src), `${rel} must not hardcode private extensions`);
  }
});

await t('G13: npm pack into isolated /tmp consumer installs cleanly, leaks 0 forbidden patterns, & runs chat + Slack grant + Telegram adapter', () => {
  const packDir = path.join(tmpRoot, 'tarballs');
  fs.mkdirSync(packDir, { recursive: true });

  const p1 = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(p1.status, 0, `root npm pack failed: ${p1.stderr}`);
  const p2 = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json'], { cwd: TG_PKG_DIR, encoding: 'utf8' });
  assert.equal(p2.status, 0, `scroll-telegram npm pack failed: ${p2.stderr}`);

  const tgzFiles = fs.readdirSync(packDir).filter((f) => f.endsWith('.tgz')).sort();
  assert.equal(tgzFiles.length, 2, 'must produce exactly 2 tarballs');

  // Inspect tarball contents via `tar -tzf` for zero test/internal leaks
  const scrollTgz = path.join(packDir, tgzFiles.find((f) => f.startsWith('agentpro-scroll-2.')));
  const tgTgz = path.join(packDir, tgzFiles.find((f) => f.startsWith('agentpro-scroll-telegram-2.')));

  for (const tgz of [scrollTgz, tgTgz]) {
    const list = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
    assert.equal(list.status, 0);
    const entries = list.stdout.split('\n').filter(Boolean);
    assert.ok(!entries.some((e) => e.startsWith('package/test/')), `${path.basename(tgz)} must not ship test/`);
    assert.ok(!entries.some((e) => /jen-extensions|voice\/module/i.test(e)), `${path.basename(tgz)} must not ship private extensions`);
  }

  // Extract into isolated /tmp consumer node_modules/@agentpro/* (offline, zero network!)
  const consumer = path.join(tmpRoot, 'consumer');
  const modBase = path.join(consumer, 'node_modules', '@agentpro');
  fs.mkdirSync(path.join(modBase, 'scroll'), { recursive: true });
  fs.mkdirSync(path.join(modBase, 'scroll-telegram'), { recursive: true });
  assert.equal(spawnSync('tar', ['-xzf', scrollTgz, '--strip-components=1', '-C', path.join(modBase, 'scroll')]).status, 0);
  assert.equal(spawnSync('tar', ['-xzf', tgTgz, '--strip-components=1', '-C', path.join(modBase, 'scroll-telegram')]).status, 0);

  // Scan unpacked tarball source for forbidden private patterns
  const scanDir = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) scanDir(full);
      else if (/\.(js|mjs|ts|json|md)$/.test(ent.name)) {
        const txt = fs.readFileSync(full, 'utf8');
        assert.ok(!/100\.70\.\d+\.\d+/.test(txt), `Tailscale IP leaked in ${full}`);
        assert.ok(!/\/Users\//.test(txt), `Host user path leaked in ${full}`);
      }
    }
  };
  scanDir(modBase);

  // Run an isolated consumer verification script outside the repo!
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(consumer, 'verify.mjs'), `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as scroll from '@agentpro/scroll';
import * as chatSdk from '@agentpro/scroll/chat';
import * as memMod from '@agentpro/scroll/lib/memory.js';
import * as tgMod from '@agentpro/scroll-telegram';

assert.equal(typeof scroll.createChatSessionRuntime, 'function');
assert.equal(typeof scroll.runChatEvals, 'function');
assert.equal(typeof scroll.openSkills, 'function');
assert.equal(typeof memMod.openStore, 'function');
assert.equal(typeof chatSdk.createScrollChatRuntime, 'function');
assert.equal(typeof chatSdk.createTurnRecoveryController, 'function');
assert.equal(typeof tgMod.createTelegramFleetDaemon, 'function');

const work = path.join(process.cwd(), 'deploy');
fs.mkdirSync(work, { recursive: true });
scroll.scaffold('demo', work);

const rt = await chatSdk.createScrollChatRuntime({
  agentName: 'demo',
  deploymentDir: work,
  stateDir: path.join(process.cwd(), 'state'),
  provider: scroll.pickProvider('mock', { scriptedTurns: [() => ({ text: 'Isolated tarball OK!' })] }),
});
const turn = await rt.sendTurn({ conversationId: 'slack:C08DEMO', text: 'Ping', channel: 'slack' });
assert.equal(turn.text, 'Isolated tarball OK!');
await rt.close();

// Room-agnostic group grant works with non-numeric Slack room IDs!
const grants = chatSdk.createGroupGrantStore({ filePath: path.join(work, 'grants.json') });
const g = grants.grant({ roomId: 'C08SLACKROOM', isGroup: true, grantedBy: 'U123OWNER', ttlMinutes: 30 });
assert.equal(g.roomId, 'C08SLACKROOM');
assert.equal(grants.getActiveGrant('C08SLACKROOM').grantedBy, 'U123OWNER');

// Pure JSON AdminController works without Telegram markup!
const admin = chatSdk.createAdminController({ bots: new Map(), ownerIds: ['U123OWNER'] });
const st = await admin.executeAction({ id: 'U123OWNER', isDm: true, isGroup: false }, 'status');
assert.equal(st.ok, true);
assert.equal(Array.isArray(st.data.bots), true);
console.log('TARBALL_CONSUMER_OK');
`);

  const runRes = spawnSync(process.execPath, ['verify.mjs'], { cwd: consumer, encoding: 'utf8' });
  assert.equal(runRes.status, 0, `isolated consumer script failed:\n${runRes.stderr}\n${runRes.stdout}`);
  assert.match(runRes.stdout, /TARBALL_CONSUMER_OK/);
});

// ── G14: CLI Subcommands (scroll check @latest ban, audit --verify-chain, eval --chat, auth migration) ──
await t('G14: CLI enforces @latest ban, verifies hash-chained audit.jsonl, runs eval --chat, & migrates legacy auth.json', () => {
  const cli = path.join(REPO, 'bin', 'scroll.js');
  const work = path.join(tmpRoot, 'g14-cli');
  fs.mkdirSync(work, { recursive: true });

  // 1. Scaffold agent
  const rNew = spawnSync(process.execPath, [cli, 'new', 'bot1'], { cwd: work, encoding: 'utf8' });
  assert.equal(rNew.status, 0, rNew.stderr);

  // 2. Unpinned @latest in .mcp.json -> scroll check MUST fail (exit 1)!
  fs.writeFileSync(path.join(work, '.mcp.json'), JSON.stringify({
    mcpServers: { bad: { command: 'npx', args: ['-y', 'some-mcp@latest'] } },
  }));
  const rBad = spawnSync(process.execPath, [cli, 'check', 'bot1'], { cwd: work, encoding: 'utf8' });
  assert.equal(rBad.status, 1, 'scroll check must fail on @latest MCP package');
  assert.match(rBad.stdout, /@latest is banned/);

  // 3. Pin exact version -> scroll check MUST pass (exit 0)!
  fs.writeFileSync(path.join(work, '.mcp.json'), JSON.stringify({
    mcpServers: { good: { command: 'npx', args: ['-y', 'some-mcp@2.1.0'] } },
  }));
  const rGood = spawnSync(process.execPath, [cli, 'check', 'bot1'], { cwd: work, encoding: 'utf8' });
  assert.equal(rGood.status, 0, `pinned check failed: ${rGood.stdout}\n${rGood.stderr}`);

  // 4. Legacy .scroll/chat-state/auth.json auto-migrates to .scroll/auth.json on `scroll chat`
  fs.mkdirSync(path.join(work, '.scroll', 'chat-state'), { recursive: true });
  fs.writeFileSync(path.join(work, '.scroll', 'chat-state', 'auth.json'), JSON.stringify({
    schema: 'scroll-auth/1', defaults: {}, profiles: { p1: { id: 'p1', provider: 'openai', type: 'api_key', apiKey: 'sk-legacy' } },
  }));
  const rChat = spawnSync(process.execPath, [cli, 'chat', 'bot1', '--provider', 'mock', '--no-mcp', '--message', 'hello'], { cwd: work, encoding: 'utf8' });
  assert.equal(rChat.status, 0, `scroll chat failed: ${rChat.stderr}`);
  assert.ok(fs.existsSync(path.join(work, '.scroll', 'auth.json')), 'legacy auth.json auto-migrated to .scroll/auth.json');

  // 5. `scroll audit --verify-chain` passes on intact audit.jsonl and fails on tampered audit.jsonl
  const auditFile = path.join(work, '.scroll', 'chat-state', 'audit.jsonl');
  // Ensure at least one valid entry exists by verifying empty/existing file, then creating & tampering
  const rVerifyOk = spawnSync(process.execPath, [cli, 'audit', '--verify-chain', auditFile], { cwd: work, encoding: 'utf8' });
  assert.equal(rVerifyOk.status, 0, rVerifyOk.stdout);
  fs.writeFileSync(auditFile, '{"seq":1,"prevHash":"000","hash":"bad"}\n');
  const rVerifyBad = spawnSync(process.execPath, [cli, 'audit', '--verify-chain', auditFile], { cwd: work, encoding: 'utf8' });
  assert.equal(rVerifyBad.status, 1, 'tampered audit chain must exit 1');

  // 6. `scroll eval bot1 --chat --trials 2 --provider mock`
  const chatEvalDir = path.join(work, 'agents', 'bot1', 'evals', 'chat');
  fs.mkdirSync(chatEvalDir, { recursive: true });
  fs.writeFileSync(path.join(chatEvalDir, 'basic.json'), JSON.stringify({
    id: 'smoke-chat',
    scriptedTurns: [{ text: 'Verified response 123' }],
    turns: [{ text: 'Ping', checks: [{ op: 'contains', value: 'Verified response 123' }] }],
  }));
  const rEval = spawnSync(process.execPath, [cli, 'eval', 'bot1', '--chat', '--trials', '2', '--provider', 'mock'], { cwd: work, encoding: 'utf8' });
  assert.equal(rEval.status, 0, `scroll eval --chat failed: ${rEval.stdout}\n${rEval.stderr}`);
  assert.match(rEval.stdout, /pass\^2=1/);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${fail ? '✖ failures:' : '✔ all green:'} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
