#!/usr/bin/env node
// CLI entrypoint for `@agentpro/scroll-telegram`.
import fs from 'node:fs';
import path from 'node:path';
import {
  findCodexBinary,
  checkAgent,
  openKnowledge,
  createCodexAppServerClient,
} from '@agentpro/scroll';
import { createTelegramFleetDaemon } from '../src/telegram-daemon.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function loadConfig(configPath) {
  const abs = path.resolve(configPath || path.join(process.env.HOME || '.', '.scroll-telegram', 'config.json'));
  if (!fs.existsSync(abs)) {
    throw new Error(`Config file not found: ${abs}`);
  }
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  return { abs, config: { baseDir: path.dirname(abs), ...parsed } };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  if (cmd === 'start') {
    const { config } = loadConfig(args.config);
    const daemon = await createTelegramFleetDaemon(config);
    const onSig = async (sig) => {
      console.log(`[scroll-telegram] received ${sig}, shutting down cleanly...`);
      await daemon.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => onSig('SIGTERM'));
    process.on('SIGINT', () => onSig('SIGINT'));
    await daemon.start();
    return;
  }

  if (cmd === 'doctor') {
    const { abs, config } = loadConfig(args.config);
    const report = {
      configPath: abs,
      stateDir: path.resolve(config.stateDir || path.dirname(abs)),
      codexBinary: findCodexBinary({
        command: config.codexAppServer?.command || null,
        searchPaths: config.codexAppServer?.searchPaths || [],
      }),
      bots: [],
    };
    for (const b of config.bots || []) {
      const check = checkAgent(b.agentName || b.id, path.resolve(b.deploymentDir));
      const kb = openKnowledge({ cwd: path.resolve(b.deploymentDir) });
      report.bots.push({
        id: b.id,
        enabled: b.enabled !== false,
        agentName: b.agentName || b.id,
        level: check.level,
        errors: check.errors,
        knowledgeChunks: kb.active ? kb.chunks.length : 0,
      });
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.bots.some((b) => b.enabled && b.errors.length > 0)) process.exitCode = 1;
    return;
  }

  if (cmd === 'login-chatgpt') {
    const { config } = loadConfig(args.config);
    const client = createCodexAppServerClient({
      command: config.codexAppServer?.command || null,
      searchPaths: config.codexAppServer?.searchPaths || [],
    });
    try {
      const acct = await client.readAccount();
      if (acct?.account && !args.force) {
        console.log(JSON.stringify({ status: 'already_signed_in', account: acct.account }, null, 2));
        return;
      }
      const login = await client.startLogin({ type: 'chatgpt' });
      console.log(JSON.stringify({ status: 'login_started', ...login }, null, 2));
    } finally {
      await client.close();
    }
    return;
  }

  console.log(`scroll-telegram -- SCROLL 2.5 Multi-Bot Telegram Fleet Daemon
Usage:
  scroll-telegram start --config <path/to/config.json>
  scroll-telegram doctor --config <path/to/config.json>
  scroll-telegram login-chatgpt --config <path/to/config.json> [--force]`);
}

main().catch((err) => {
  console.error('[scroll-telegram] fatal:', err?.message || err);
  process.exit(1);
});
