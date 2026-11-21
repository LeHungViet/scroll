// SCROLL 2.5 -- Pure Transport-Agnostic AdminController (JSON API, zero Telegram UI coupling).
// Drives Telegram inline keyboards, Web dashboards, Bot Room consoles, Slack slash commands, or CLI.
// Strict security invariant: destructive/admin commands require a verified owner in DM!

export const ADMIN_CALLBACK_NAMESPACE = 'scroll-admin';

export function createAdminController({
  bots,
  authStore = null,
  scheduler = null,
  groupGrants = null,
  longTasks = null,
  runCronNowFn = null,
  runDreamNowFn = null,
  ownerIds = [],
  startedAt = Date.now(),
} = {}) {
  const ownerSet = new Set((ownerIds || []).map(String));
  let globalPaused = false;
  const reviewShortcuts = new Map();

  function isOwner(actor) {
    if (!actor) return false;
    const rawId = String(actor.senderId ?? actor.id ?? '');
    const stripped = rawId.replace(/^[a-z0-9_-]+:/i, '');
    if (!rawId || (!ownerSet.has(rawId) && !ownerSet.has(stripped))) return false;
    return actor.isDm === true && actor.isGroup !== true;
  }

  function assertOwner(actor) {
    if (!isOwner(actor)) {
      const err = new Error('admin_owner_dm_required');
      err.code = 'FORBIDDEN';
      throw err;
    }
  }

  function listBots() {
    return [...bots.values()].map((b) => ({
      id: b.id,
      username: b.username || null,
      agentName: b.agentName,
      provider: b.runtime.provider.name,
      model: b.model || b.runtime.provider.model,
      paused: Boolean(b.paused),
      groupPolicy: b.groupPolicy || 'mention',
      knowledgeChunks: b.runtime.knowledgeIndex?.active ? b.runtime.knowledgeIndex.chunks.length : 0,
      memory: b.runtime.memoryTracker && typeof b.runtime.memoryTracker.getStats === 'function'
        ? b.runtime.memoryTracker.getStats()
        : null,
      turnsProcessed: Number(b.stats?.turns || 0),
      errors: Number(b.stats?.errors || 0),
    }));
  }

  function consolidateAllMemory(actor) {
    assertOwner(actor);
    let totalSubjects = 0;
    const perBot = [];
    for (const b of bots.values()) {
      if (b.runtime?.memoryTracker && typeof b.runtime.memoryTracker.consolidateAll === 'function') {
        const r = b.runtime.memoryTracker.consolidateAll();
        totalSubjects += Number(r.consolidatedSubjects || 0);
        perBot.push({ botId: b.id, consolidatedSubjects: r.consolidatedSubjects || 0 });
      }
    }
    return { ok: true, totalSubjects, perBot };
  }

  function listAllReviews() {
    const out = [];
    for (const b of bots.values()) {
      const mt = b.runtime?.memoryTracker;
      if (!mt || typeof mt.listPendingReviews !== 'function') continue;
      for (const item of mt.listPendingReviews()) {
        out.push({ botId: b.id, ...item });
      }
    }
    return out;
  }

  function registerReviewShortcut(shortKey, ref) {
    reviewShortcuts.set(String(shortKey), ref);
  }

  function resolveReview(actor, shortKey, decision) {
    assertOwner(actor);
    const ref = reviewShortcuts.get(String(shortKey || ''));
    if (!ref) return { ok: false, reason: 'review_shortcut_expired' };
    const bot = bots.get(ref.botId);
    if (!bot?.runtime?.memoryTracker) return { ok: false, reason: 'bot_not_found' };
    const r = bot.runtime.memoryTracker.resolveReviewItem({ sid: ref.sid, reviewId: ref.reviewId, decision, by: 'owner' });
    if (r.ok) reviewShortcuts.delete(String(shortKey));
    return r;
  }

  function getStatus() {
    const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
    return {
      globalPaused,
      uptimeSec,
      bots: listBots(),
      authProfiles: authStore ? authStore.listProfiles() : [],
      cronPaused: scheduler ? scheduler.paused : false,
      cronCount: scheduler ? scheduler.listJobs().length : 0,
      activeGrants: groupGrants ? groupGrants.listActiveGrants() : [],
      longTasks: longTasks ? longTasks.listTasks().slice(0, 10) : [],
    };
  }

  function toggleGlobalPause(actor) {
    assertOwner(actor);
    globalPaused = !globalPaused;
    if (scheduler) scheduler.setPaused(globalPaused);
    return { ok: true, globalPaused };
  }

  function toggleBotPause(actor, botId) {
    assertOwner(actor);
    const bot = bots.get(botId);
    if (!bot) throw new Error(`bot_not_found:${botId}`);
    bot.paused = !bot.paused;
    return { ok: true, botId, paused: bot.paused };
  }

  function setGroupPolicy(actor, botId, policy) {
    assertOwner(actor);
    if (!['mention', 'all', 'off'].includes(policy)) throw new Error(`invalid_group_policy:${policy}`);
    const bot = bots.get(botId);
    if (!bot) throw new Error(`bot_not_found:${botId}`);
    bot.groupPolicy = policy;
    return { ok: true, botId, groupPolicy: policy };
  }

  function switchModel(actor, botId, model) {
    assertOwner(actor);
    const bot = bots.get(botId);
    if (!bot) throw new Error(`bot_not_found:${botId}`);
    bot.model = String(model || '').trim() || null;
    return { ok: true, botId, model: bot.model };
  }

  function reloadAgent(actor, botId) {
    assertOwner(actor);
    const bot = bots.get(botId);
    if (!bot) throw new Error(`bot_not_found:${botId}`);
    const info = bot.runtime.reload();
    return { ok: true, botId, ...info };
  }

  async function startChatGptLogin(actor, botId) {
    assertOwner(actor);
    const bot = bots.get(botId) || [...bots.values()][0];
    const client = bot?.runtime?.provider?.client;
    if (!client || typeof client.startLogin !== 'function') {
      return { ok: false, reason: 'codex_app_server_not_active' };
    }
    const res = await client.startLogin({ type: 'chatgpt' });
    return { ok: true, ...res };
  }

  function listCrons(actor) {
    assertOwner(actor);
    return {
      paused: scheduler ? scheduler.paused : false,
      jobs: scheduler ? scheduler.listJobs() : [],
    };
  }

  function toggleCron(actor, jobId) {
    assertOwner(actor);
    if (!scheduler) throw new Error('scheduler_not_configured');
    const cur = scheduler.getJob(jobId);
    if (!cur) throw new Error(`job_not_found:${jobId}`);
    const next = scheduler.updateJob(jobId, { enabled: !cur.enabled });
    return { ok: true, job: next };
  }

  function deleteCron(actor, jobId) {
    assertOwner(actor);
    if (!scheduler) throw new Error('scheduler_not_configured');
    return scheduler.removeJob(jobId);
  }

  function readRecentAudit(actor, botId, limit = 10) {
    assertOwner(actor);
    const bot = bots.get(botId);
    if (!bot || !bot.tools) return [];
    return bot.tools.getAuditLog().slice(-Math.max(1, Math.min(30, limit)));
  }

  // Pure JSON command executor usable by any UI/channel adapter
  async function executeAction(actor, action, args = {}) {
    assertOwner(actor);
    switch (action) {
      case 'status':
        return { ok: true, action, page: 'home', data: getStatus() };
      case 'global_pause': {
        const res = toggleGlobalPause(actor);
        return { ok: true, action, page: 'home', data: res };
      }
      case 'bot_pause': {
        const res = toggleBotPause(actor, args.botId);
        return { ok: true, action, page: 'bot', botId: args.botId, data: res };
      }
      case 'bot_policy': {
        const res = setGroupPolicy(actor, args.botId, args.policy);
        return { ok: true, action, page: 'bot', botId: args.botId, data: res };
      }
      case 'bot_model': {
        const res = switchModel(actor, args.botId, args.model);
        return { ok: true, action, page: 'bot', botId: args.botId, data: res };
      }
      case 'bot_reload': {
        const res = reloadAgent(actor, args.botId);
        return { ok: true, action, page: 'bot', botId: args.botId, data: res };
      }
      case 'cron_toggle': {
        const res = toggleCron(actor, args.jobId);
        return { ok: true, action, page: 'crons', data: res };
      }
      case 'cron_delete': {
        const res = deleteCron(actor, args.jobId);
        return { ok: true, action, page: 'crons', data: res };
      }
      case 'cron_run': {
        if (typeof runCronNowFn !== 'function') return { ok: false, action, reason: 'cron_runner_not_configured' };
        const res = await runCronNowFn(args.jobId);
        return { ok: Boolean(res?.ok !== false), action, page: 'crons', data: res };
      }
      case 'memory_consolidate': {
        const res = consolidateAllMemory(actor);
        return { ok: true, action, page: 'memory', data: res };
      }
      case 'memory_dream': {
        if (typeof runDreamNowFn !== 'function') return { ok: false, action, reason: 'dream_runner_not_configured' };
        const res = await runDreamNowFn();
        return { ok: true, action, page: 'memory', data: res };
      }
      case 'review_resolve': {
        const res = resolveReview(actor, args.shortKey, args.decision);
        return { ok: Boolean(res?.ok), action, page: 'reviews', data: res };
      }
      case 'grant_revoke': {
        if (!groupGrants) return { ok: false, action, reason: 'group_grants_not_configured' };
        const res = groupGrants.revoke(args.roomId || args.chatId);
        return { ok: Boolean(res?.ok), action, page: 'grants', data: res };
      }
      case 'task_cancel': {
        if (!longTasks) return { ok: false, action, reason: 'long_tasks_not_configured' };
        const res = longTasks.cancelTask(args.taskId);
        return { ok: Boolean(res?.ok), action, page: 'tasks', data: res };
      }
      case 'auth_login': {
        const res = await startChatGptLogin(actor, args.botId);
        return { ok: Boolean(res?.ok), action, page: 'auth', data: res };
      }
      case 'audit': {
        const entries = readRecentAudit(actor, args.botId, args.limit || 10);
        return { ok: true, action, page: 'audit', botId: args.botId, data: { entries } };
      }
      default:
        return { ok: false, action, reason: `unknown_admin_action:${action}` };
    }
  }

  return {
    get globalPaused() { return globalPaused; },
    isOwner,
    assertOwner,
    listBots,
    getStatus,
    toggleGlobalPause,
    toggleBotPause,
    setGroupPolicy,
    switchModel,
    reloadAgent,
    startChatGptLogin,
    listCrons,
    toggleCron,
    deleteCron,
    consolidateAllMemory,
    listAllReviews,
    registerReviewShortcut,
    resolveReview,
    readRecentAudit,
    executeAction,
  };
}
