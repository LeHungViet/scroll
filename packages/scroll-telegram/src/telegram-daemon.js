// SCROLL 2.5 -- Standalone Multi-Bot Telegram Fleet Daemon (`@agentpro/scroll-telegram`).
// Consumes ONLY `@agentpro/scroll` and `@agentpro/scroll/chat` (zero parent relative imports).
// Private extensions (e.g., custom tools, Voice hooks, custom slash commands) load cleanly
// through the `plugins: [...]` contract.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  createAuthStore,
  createWorkerPool,
  createScheduler,
  createCodexAppServerClient,
  pickProvider,
} from '@agentpro/scroll';
import {
  createScrollChatRuntime,
  createMessageDebouncer,
  createGroupGrantStore,
  matchesOwnerDelegationPhrase,
  createLongTaskRunner,
  createAdminController,
  ADMIN_CALLBACK_NAMESPACE,
} from '@agentpro/scroll/chat';
import { createTelegramApi } from './telegram-api.js';
import { createTelegramAdminUi } from './telegram-admin-ui.js';

const HITL_NAMESPACE = 'scroll-hitl';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function loadDotEnvFile(envFile) {
  if (!envFile || !fs.existsSync(envFile)) return 0;
  let loaded = 0;
  const raw = fs.readFileSync(envFile, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
      loaded++;
    }
  }
  return loaded;
}

function readOffset(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isSafeInteger(j.offset) ? j.offset : null;
  } catch {
    return null;
  }
}

function writeOffset(file, offset) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ offset, updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function senderDisplayName(from) {
  if (!from) return 'Member';
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return full || (from.username ? `@${from.username}` : `User ${from.id}`);
}

function matchesTrigger({ bot, msg, text }) {
  const isGroup = msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup');
  if (!isGroup) return { trigger: true, reason: 'dm' };
  const slashMatch = /^\/([a-z0-9_]+)(?:@([A-Za-z0-9_]+))?\b/i.exec(String(text || '').trim());
  if (slashMatch) {
    const targetBot = slashMatch[2];
    if (!targetBot || (bot.username && targetBot.toLowerCase() === bot.username.toLowerCase())) {
      return { trigger: true, reason: 'slash_command' };
    }
    return { trigger: false, reason: 'other_bot_command' };
  }
  const policy = bot.groupPolicy || 'mention';
  if (policy === 'off') return { trigger: false, reason: 'group_off' };
  if (policy === 'all') return { trigger: true, reason: 'group_all' };
  if (msg.reply_to_message?.from && bot.botUserId && String(msg.reply_to_message.from.id) === String(bot.botUserId)) {
    return { trigger: true, reason: 'reply_to_bot' };
  }
  const lowered = String(text || '').toLowerCase();
  if (bot.username && lowered.includes(`@${bot.username.toLowerCase()}`)) {
    return { trigger: true, reason: 'at_mention' };
  }
  for (const pat of bot.mentionRegexes || []) {
    if (pat.test(text || '')) return { trigger: true, reason: 'pattern_mention' };
  }
  return { trigger: false, reason: 'no_mention' };
}

async function resolvePlugins(pluginSpecs = [], baseDir = process.cwd()) {
  const resolved = [];
  for (const spec of pluginSpecs || []) {
    if (typeof spec === 'function') {
      resolved.push(spec);
      continue;
    }
    if (spec && typeof spec === 'object' && typeof spec.setup === 'function') {
      resolved.push(spec.setup);
      continue;
    }
    if (typeof spec === 'string' && spec.trim()) {
      const target = spec.startsWith('file://')
        ? spec
        : (spec.startsWith('.') || path.isAbsolute(spec) ? pathToFileURL(path.resolve(baseDir, spec)).href : spec);
      const mod = await import(target);
      const fn = mod.default || mod.setup || mod.registerPlugin;
      if (typeof fn === 'function') resolved.push(fn);
    }
  }
  return resolved;
}

export async function createTelegramFleetDaemon(config = {}, {
  logger = console,
  fetchImpl = globalThis.fetch,
  providerFactory = null,
  plugins = [],
} = {}) {
  if (config.envFile) loadDotEnvFile(path.resolve(config.envFile));
  const stateDir = path.resolve(config.stateDir || path.join(process.cwd(), '.scroll-telegram'));
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const ownerIds = (config.ownerIds || []).map(String);
  const authStore = createAuthStore({ filePath: path.join(stateDir, 'auth.json') });
  const workerPool = createWorkerPool({ maxConcurrent: Number(config.maxWorkers || 3) });

  let sharedCodexClient = null;
  const needsCodex = (config.bots || []).some((b) => (b.provider || 'codex-app-server') === 'codex-app-server');
  if (needsCodex && !providerFactory) {
    const codexCfg = config.codexAppServer || {};
    sharedCodexClient = createCodexAppServerClient({
      command: codexCfg.command || null,
      args: codexCfg.args || null,
      searchPaths: codexCfg.searchPaths || [],
      defaultModel: codexCfg.defaultModel || null,
      timeoutMs: Number(codexCfg.timeoutMs || 120_000),
    });
  }

  const bots = new Map();
  const pendingHitl = new Map();
  const startedAt = Date.now();
  let stopped = false;

  const scheduler = createScheduler({
    filePath: path.join(stateDir, 'cron.json'),
    defaultTz: config.defaultTz || 'UTC',
    tickIntervalMs: Number(config.cronTickIntervalMs || 15_000),
    onTrigger: async (job) => deliverScheduledJob(job),
  });

  const groupGrants = createGroupGrantStore({
    filePath: path.join(stateDir, 'group-grants.json'),
  });

  const longTasks = createLongTaskRunner({
    stateDir,
    workerPool,
    channel: 'telegram',
    onProgress: async (task, stepSummary) => {
      const bot = bots.get(task.botId);
      if (!bot || task.isGroup) return;
      await bot.api.sendMessage({
        chatId: task.chatId,
        text: `[${task.title} - Step ${task.step}/${task.maxSteps}]\n${stepSummary.slice(0, 420)}`,
      }).catch(() => {});
    },
    onComplete: async (task) => {
      const bot = bots.get(task.botId);
      if (!bot) return;
      const ownerDm = bot.ownerIds?.[0] || ownerIds?.[0] || null;
      if (task.status === 'failed' || task.status === 'blocked') {
        const target = task.isGroup && ownerDm ? ownerDm : task.chatId;
        await bot.api.sendMessage({
          chatId: target,
          text: `[Long Task ${task.status}: ${task.title}]\nStep ${task.step}/${task.maxSteps}: ${String(task.error || 'stopped').slice(0, 900)}`,
        }).catch(() => {});
        return;
      }
      const body = task.finalReport || `Completed "${task.title}" after ${task.step} step(s).`;
      await bot.api.sendMessage({ chatId: task.chatId, text: body.slice(0, 4000) }).catch(() => {});
    },
  });

  const adminController = createAdminController({
    bots,
    authStore,
    scheduler,
    groupGrants,
    longTasks,
    runCronNowFn: async (jobId) => {
      const job = scheduler.getJob(jobId);
      if (!job) return { ok: false, reason: 'job_not_found' };
      await deliverScheduledJob(job);
      return { ok: true, jobId };
    },
    ownerIds,
    startedAt,
  });

  const adminUi = createTelegramAdminUi({ controller: adminController });
  const loadedPlugins = await resolvePlugins([...(config.plugins || []), ...(plugins || [])], config.baseDir || process.cwd());
  const pluginHooks = [];

  async function requestHitlApproval(bot, req) {
    const ownerChatId = bot.ownerIds?.[0] || ownerIds[0];
    if (!ownerChatId) return { approved: false, reason: 'no_owner_chat_configured' };
    const tokenId = crypto.randomBytes(6).toString('hex');
    const preview = JSON.stringify(req.args || {}).slice(0, 220);
    await bot.api.sendMessage({
      chatId: ownerChatId,
      text: `Approval required (${bot.id})\n- Tool: ${req.tool} (${req.tier})\n- Args: ${preview}`,
      buttons: [[
        { text: 'Approve', callback_data: `${HITL_NAMESPACE}:ok:${tokenId}` },
        { text: 'Deny', callback_data: `${HITL_NAMESPACE}:no:${tokenId}` },
      ]],
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingHitl.delete(tokenId);
        resolve({ approved: false, reason: 'approval_timeout' });
      }, Number(config.hitlTimeoutMs || 120_000));
      if (typeof timer.unref === 'function') timer.unref();
      pendingHitl.set(tokenId, {
        resolve: (approved, approver) => {
          clearTimeout(timer);
          pendingHitl.delete(tokenId);
          resolve({ approved, approver });
        },
        ownerIds: new Set(bot.ownerIds?.length ? bot.ownerIds : ownerIds),
      });
    });
  }

  async function deliverScheduledJob(job) {
    const bot = bots.get(job.agentName) || [...bots.values()][0];
    if (!bot || bot.paused || adminController.globalPaused) return { skipped: true };
    const targetChatId = job.targetChatId || bot.ownerIds?.[0] || ownerIds[0];
    if (!targetChatId) return { skipped: true, reason: 'no_target_chat' };
    const turn = await bot.runtime.sendTurn({
      conversationId: String(targetChatId),
      text: job.prompt || job.name,
      channel: 'telegram',
      model: bot.model,
      effort: bot.effort,
    });
    const bubbles = Array.isArray(turn.bubbles) && turn.bubbles.length ? turn.bubbles : [turn.text];
    for (const b of bubbles.filter(Boolean)) {
      await bot.api.sendMessage({ chatId: targetChatId, text: b });
    }
    return { ok: true, bubbles: bubbles.length };
  }

  async function extractAttachments(bot, msg) {
    const out = [];
    if (Array.isArray(msg.photo) && msg.photo.length) {
      const largest = msg.photo[msg.photo.length - 1];
      try {
        const info = await bot.api.getFile(largest.file_id);
        if (info?.file_path) {
          const buf = await bot.api.downloadFile(info.file_path);
          out.push({
            type: 'image',
            base64: buf.toString('base64'),
            mimeType: 'image/jpeg',
            caption: msg.caption || null,
          });
        }
      } catch (err) {
        logger.warn?.(`[scroll-telegram:${bot.id}] photo download failed:`, err?.message || err);
      }
    }
    if (msg.voice?.file_id) {
      out.push({ type: 'voice', fileId: msg.voice.file_id, mimeType: msg.voice.mime_type || 'audio/ogg' });
    }
    if (msg.document?.file_id) {
      out.push({ type: 'document', fileId: msg.document.file_id, name: msg.document.file_name || 'file', mimeType: msg.document.mime_type || null });
    }
    return out;
  }

  async function handleIncomingMessage(bot, msg) {
    if (!msg || !msg.chat) return;
    if (msg.from?.is_bot) return;
    const chatId = String(msg.chat.id);
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const senderId = msg.from ? String(msg.from.id) : null;
    const senderName = senderDisplayName(msg.from);
    const rawText = String(msg.text || msg.caption || '').trim();
    const attachments = await extractAttachments(bot, msg);
    if (!rawText && !attachments.length) return;

    // Allow plugins to observe every message (e.g. rolling group buffer)
    for (const h of pluginHooks) {
      if (typeof h.onRawMessage === 'function') {
        try { await h.onRawMessage({ bot, msg, chatId, isGroup, senderId, senderName, text: rawText }); } catch { /* isolate */ }
      }
    }

    const trig = matchesTrigger({ bot, msg, text: rawText });
    if (!trig.trigger) return;

    const actor = { id: senderId, senderId, isDm: !isGroup, isGroup };

    // Built-in slash commands
    if (/^\/admin(?:@[A-Za-z0-9_]+)?\b/i.test(rawText)) {
      if (!adminController.isOwner(actor)) {
        await bot.api.sendMessage({ chatId, text: 'Admin console is available to the verified owner in DM only.', replyToMessageId: msg.message_id });
        return;
      }
      const view = adminUi.renderView({ page: 'home' });
      await bot.api.sendMessage({ chatId, text: view.text, buttons: view.buttons });
      return;
    }
    if (/^\/clear(?:@[A-Za-z0-9_]+)?\b/i.test(rawText)) {
      await bot.runtime.clearSession(chatId);
      await bot.api.sendMessage({ chatId, text: 'Session history cleared.', replyToMessageId: msg.message_id });
      return;
    }
    if (/^\/grant(?:@[A-Za-z0-9_]+)?\b/i.test(rawText) && isGroup) {
      if (!senderId || !bot.ownerSet.has(senderId)) {
        await bot.api.sendMessage({ chatId, text: 'Only the verified owner may grant group tool permissions.', replyToMessageId: msg.message_id });
        return;
      }
      const minsMatch = rawText.match(/\b(\d{1,3})\b/);
      const g = groupGrants.grant({ roomId: chatId, isGroup: true, grantedBy: senderId, ttlMinutes: minsMatch ? Number(minsMatch[1]) : 60 });
      await bot.api.sendMessage({ chatId, text: `Granted group tools (${g.allowedTools.join(', ')}) for ${g.ttlMinutes} min.`, replyToMessageId: msg.message_id });
      return;
    }
    if (/^\/revoke(?:@[A-Za-z0-9_]+)?\b/i.test(rawText) && isGroup) {
      if (!senderId || !bot.ownerSet.has(senderId)) return;
      groupGrants.revoke(chatId);
      await bot.api.sendMessage({ chatId, text: 'Revoked group tool grant.', replyToMessageId: msg.message_id });
      return;
    }

    // Plugin slash commands
    for (const h of pluginHooks) {
      if (typeof h.onCommand === 'function') {
        const handled = await h.onCommand({ bot, msg, chatId, isGroup, senderId, senderName, text: rawText, actor });
        if (handled) return;
      }
    }

    if (bot.paused || adminController.globalPaused) return;

    // Owner natural-language delegation in groups
    if (isGroup && senderId && bot.ownerSet.has(senderId) && matchesOwnerDelegationPhrase(rawText, bot.delegationPatterns)) {
      groupGrants.grant({ roomId: chatId, isGroup: true, grantedBy: senderId, ttlMinutes: 60, note: rawText.slice(0, 120) });
    }

    const burstKey = `${bot.id}:${chatId}:${senderId || 'anon'}`;
    await bot.debouncer.push(burstKey, {
      chatId,
      isGroup,
      chatTitle: msg.chat.title || null,
      sender: { id: senderId, channelId: senderId ? `tg:${senderId}` : null, name: senderName },
      text: rawText,
      attachments,
      messageId: msg.message_id,
    });
  }

  async function processBurst(bot, item) {
    if (bot.paused || adminController.globalPaused) return;
    const { chatId, isGroup, chatTitle, sender, text, attachments, messageId, messageIds } = item;
    await bot.api.sendChatAction({ chatId, action: 'typing' });
    const activeGrant = isGroup ? groupGrants.getActiveGrant(chatId) : null;
    try {
      const turn = await bot.runtime.sendTurn({
        conversationId: chatId,
        text,
        sender,
        isGroup,
        channel: 'telegram',
        chatTitle,
        messageId,
        messageIds,
        attachments,
        model: bot.model,
        effort: bot.effort,
        delegatedTools: activeGrant ? activeGrant.allowedTools : null,
      });
      bot.stats.turns++;
      if (turn.streamHeld) {
        logger.warn?.(`[scroll-telegram:${bot.id}] grounding held unverified reply for chat ${chatId}`);
      }
      const bubbles = Array.isArray(turn.bubbles) && turn.bubbles.length ? turn.bubbles : [turn.text];
      for (let i = 0; i < bubbles.length; i++) {
        const chunk = String(bubbles[i] || '').trim();
        if (!chunk) continue;
        if (i > 0) await sleep(Math.round(350 * bot.delayScale));
        await bot.api.sendMessage({
          chatId,
          text: chunk.slice(0, 4096),
          replyToMessageId: i === 0 && isGroup ? messageId : null,
        });
      }
    } catch (err) {
      bot.stats.errors++;
      logger.error?.(`[scroll-telegram:${bot.id}] turn error:`, err?.message || err);
    }
  }

  async function handleCallbackQuery(bot, cq) {
    if (!cq) return;
    const data = String(cq.data || '');
    const fromId = cq.from ? String(cq.from.id) : null;
    const chatId = cq.message?.chat ? String(cq.message.chat.id) : null;
    const isGroup = cq.message?.chat && (cq.message.chat.type === 'group' || cq.message.chat.type === 'supergroup');
    const actor = { id: fromId, senderId: fromId, isDm: !isGroup, isGroup: Boolean(isGroup) };

    if (data.startsWith(`${HITL_NAMESPACE}:`)) {
      const [, decision, tokenId] = data.split(':');
      const entry = pendingHitl.get(tokenId);
      if (!entry) {
        await bot.api.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Approval request expired.' });
        return;
      }
      if (!fromId || !entry.ownerIds.has(fromId) || isGroup) {
        await bot.api.answerCallbackQuery({ callbackQueryId: cq.id, text: 'Owner DM required.', showAlert: true });
        return;
      }
      const approved = decision === 'ok';
      entry.resolve(approved, `tg:${fromId}`);
      await bot.api.answerCallbackQuery({ callbackQueryId: cq.id, text: approved ? 'Approved' : 'Denied' });
      if (chatId && cq.message?.message_id) {
        await bot.api.editMessageText({
          chatId,
          messageId: cq.message.message_id,
          text: `${cq.message.text || 'Approval'}\n\nDecision: ${approved ? 'APPROVED' : 'DENIED'}`,
        }).catch(() => {});
      }
      return;
    }

    if (data.startsWith(`${ADMIN_CALLBACK_NAMESPACE}:`)) {
      const res = await adminUi.handleCallback(actor, data);
      if (res?.forbidden) {
        await bot.api.answerCallbackQuery({ callbackQueryId: cq.id, text: res.toast, showAlert: true });
        return;
      }
      await bot.api.answerCallbackQuery({ callbackQueryId: cq.id, text: res?.toast || 'OK' });
      if (res?.view && chatId && cq.message?.message_id) {
        await bot.api.editMessageText({
          chatId,
          messageId: cq.message.message_id,
          text: res.view.text,
          buttons: res.view.buttons,
        }).catch(() => {});
      }
      return;
    }

    for (const h of pluginHooks) {
      if (typeof h.onCallbackQuery === 'function') {
        const handled = await h.onCallbackQuery({ bot, cq, data, actor, chatId, isGroup });
        if (handled) return;
      }
    }
  }

  // Initialize bots
  for (const bCfg of config.bots || []) {
    if (bCfg.enabled === false) continue;
    const token = bCfg.token || (bCfg.tokenEnv ? process.env[bCfg.tokenEnv] : null);
    if (!token) throw new Error(`Bot "${bCfg.id}" missing token / tokenEnv`);
    const botOwnerIds = (bCfg.ownerIds || ownerIds).map(String);
    const api = createTelegramApi({ token, apiBaseUrl: bCfg.apiBaseUrl || config.apiBaseUrl || 'https://api.telegram.org', fetchImpl });

    let provider;
    if (typeof providerFactory === 'function') {
      provider = await providerFactory(bCfg);
    } else if ((bCfg.provider || 'codex-app-server') === 'codex-app-server' && sharedCodexClient) {
      provider = pickProvider('codex-app-server', {
        model: bCfg.model || null,
        effort: bCfg.effort || null,
        client: sharedCodexClient,
      });
    } else {
      provider = pickProvider(bCfg.provider || 'auto', {
        model: bCfg.model || null,
        authStore,
        cwd: path.resolve(bCfg.deploymentDir || process.cwd()),
      });
    }

    const botObj = {
      id: bCfg.id,
      agentName: bCfg.agentName || bCfg.id,
      username: bCfg.username || null,
      botUserId: null,
      api,
      model: bCfg.model || null,
      effort: bCfg.effort || null,
      groupPolicy: bCfg.groupPolicy || 'mention',
      mentionRegexes: (bCfg.mentionPatterns || []).map((p) => new RegExp(p, 'i')),
      delegationPatterns: (bCfg.delegationPatterns || []).map((p) => new RegExp(p, 'iu')),
      paused: Boolean(bCfg.paused),
      delayScale: Number(bCfg.delayScale ?? 1),
      ownerIds: botOwnerIds,
      ownerSet: new Set(botOwnerIds),
      offsetFile: path.join(stateDir, `offset-${bCfg.id}.json`),
      stats: { turns: 0, errors: 0 },
      runtime: null,
      tools: null,
      debouncer: null,
      pollAbort: null,
    };

    const runtime = await createScrollChatRuntime({
      agentName: botObj.agentName,
      deploymentDir: path.resolve(bCfg.deploymentDir || process.cwd()),
      stateDir,
      accountId: bCfg.accountId || bCfg.id,
      ownerIds: botOwnerIds,
      provider,
      model: botObj.model,
      effort: botObj.effort,
      authStore,
      scheduler,
      workerPool,
      enableMemory: bCfg.enableMemory !== false,
      memoryChannel: 'telegram',
      enableTools: bCfg.enableTools !== false,
      toolsRetrieval: bCfg.toolsRetrieval || null,
      enableMcp: Boolean(bCfg.enableMcp),
      voiceHooks: bCfg.voiceHooks || null,
      requestApproval: (req) => requestHitlApproval(botObj, req),
      compactAtChars: Number(bCfg.compactAtChars || 48_000),
      keepRecentTurns: Number(bCfg.keepRecentTurns || 12),
      acquireLock: bCfg.acquireLock !== false,
    });
    botObj.runtime = runtime;
    botObj.tools = runtime.tools;
    if (runtime.tools) {
      longTasks.registerTools({ tools: runtime.tools, bot: botObj, ownerIds: botOwnerIds, groupGrants });
    }
    botObj.debouncer = createMessageDebouncer({
      quietMs: Number(bCfg.debounceQuietMs ?? 1200),
      maxWaitMs: Number(bCfg.debounceMaxWaitMs ?? 4500),
      onFlush: (item) => processBurst(botObj, item),
    });

    bots.set(botObj.id, botObj);
  }

  // Invoke registered plugins
  for (const pluginFn of loadedPlugins) {
    const hook = await pluginFn({
      config,
      stateDir,
      bots,
      authStore,
      scheduler,
      workerPool,
      groupGrants,
      longTasks,
      adminController,
      logger,
    });
    if (hook && typeof hook === 'object') pluginHooks.push(hook);
  }

  async function pollBot(bot) {
    let offset = readOffset(bot.offsetFile);
    bot.pollAbort = new AbortController();
    while (!stopped && !bot.pollAbort.signal.aborted) {
      try {
        const updates = await bot.api.getUpdates(
          { offset: offset != null ? offset : undefined, timeout: Number(config.pollTimeoutSec || 25) },
          { signal: bot.pollAbort.signal }
        );
        for (const upd of updates || []) {
          offset = upd.update_id + 1;
          writeOffset(bot.offsetFile, offset);
          if (upd.callback_query) {
            handleCallbackQuery(bot, upd.callback_query).catch((e) => logger.error?.('[callback]', e?.message || e));
          } else if (upd.message) {
            handleIncomingMessage(bot, upd.message).catch((e) => logger.error?.('[message]', e?.message || e));
          }
        }
      } catch (err) {
        if (stopped || bot.pollAbort.signal.aborted) break;
        const waitMs = err?.code === 'TELEGRAM_TIMEOUT' ? 1000 : Number(err?.retryAfterMs || 2500);
        logger.warn?.(`[scroll-telegram:${bot.id}] poll error (retrying in ${waitMs}ms):`, err?.message || err);
        await sleep(waitMs);
      }
    }
  }

  async function start() {
    stopped = false;
    for (const bot of bots.values()) {
      const me = await bot.api.getMe();
      bot.username = me?.username || bot.username;
      bot.botUserId = me?.id || null;
      logger.info?.(`[scroll-telegram] connected @${bot.username} (${bot.id})`);
      pollBot(bot).catch(() => {});
    }
    scheduler.start();
    return { bots: [...bots.keys()] };
  }

  async function stop() {
    stopped = true;
    scheduler.stop();
    for (const bot of bots.values()) {
      if (bot.pollAbort) bot.pollAbort.abort();
      bot.debouncer.close();
      await bot.runtime.close().catch(() => {});
    }
    workerPool.close();
    if (sharedCodexClient) await sharedCodexClient.close().catch(() => {});
  }

  return {
    bots,
    authStore,
    scheduler,
    workerPool,
    groupGrants,
    longTasks,
    adminController,
    adminUi,
    start,
    stop,
    handleIncomingMessage,
    handleCallbackQuery,
  };
}
