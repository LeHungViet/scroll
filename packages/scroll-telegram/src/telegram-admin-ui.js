// Telegram Inline Keyboard Admin UI wrapping @agentpro/scroll/chat's pure JSON AdminController.
import { ADMIN_CALLBACK_NAMESPACE } from '@agentpro/scroll/chat';

export function createTelegramAdminUi({
  controller,
  namespace = ADMIN_CALLBACK_NAMESPACE,
} = {}) {
  if (!controller) throw new Error('createTelegramAdminUi: controller is required');

  const btn = (text, ...parts) => ({
    text,
    callback_data: [namespace, ...parts].join(':'),
  });

  function renderView({ page = 'home', botId = null, notice = null } = {}) {
    const status = controller.getStatus();
    const lines = [];
    const buttons = [];

    if (page === 'bot' && botId) {
      const b = status.bots.find((x) => x.id === botId);
      if (b) {
        lines.push(`Admin - Bot ${b.id} (${b.username ? '@' + b.username : b.agentName})`);
        lines.push(`- State: ${b.paused ? 'Paused' : 'Running'}`);
        lines.push(`- Provider/Model: ${b.provider} - ${b.model || 'auto'}`);
        lines.push(`- Group policy: ${b.groupPolicy}`);
        lines.push(`- Knowledge chunks: ${b.knowledgeChunks}`);
        lines.push(`- Turns: ${b.turnsProcessed} (errors: ${b.errors})`);
        buttons.push([
          btn(b.paused ? 'Resume bot' : 'Pause bot', 'bpause', b.id),
          btn('Reload SOUL/KB', 'reload', b.id),
        ]);
        buttons.push([
          btn(`Group: mention${b.groupPolicy === 'mention' ? ' *' : ''}`, 'gpol', b.id, 'mention'),
          btn(`Group: all${b.groupPolicy === 'all' ? ' *' : ''}`, 'gpol', b.id, 'all'),
          btn(`Group: off${b.groupPolicy === 'off' ? ' *' : ''}`, 'gpol', b.id, 'off'),
        ]);
        buttons.push([btn('Back', 'home')]);
      }
    } else if (page === 'crons') {
      lines.push(`Admin - Cron Jobs (${status.cronCount})`);
      const jobs = status.cronCount ? controller.listCrons({ id: null, isDm: true, isGroup: false }).jobs : [];
      if (!jobs.length) lines.push('(no scheduled jobs)');
      for (const j of jobs.slice(0, 8)) {
        lines.push(`- [${j.enabled ? 'ON' : 'OFF'}] ${j.id}: ${j.name} (${j.cron || j.at || `${j.everyMs}ms`})`);
        buttons.push([
          btn(`${j.enabled ? 'Disable' : 'Enable'} ${j.id}`, 'ctog', j.id),
          btn(`Run ${j.id}`, 'crun', j.id),
          btn(`Delete ${j.id}`, 'cdel', j.id),
        ]);
      }
      buttons.push([btn('Back', 'home')]);
    } else if (page === 'grants') {
      lines.push(`Admin - Active Group Grants (${status.activeGrants.length})`);
      if (!status.activeGrants.length) lines.push('(no active group grants)');
      for (const g of status.activeGrants.slice(0, 8)) {
        lines.push(`- Room ${g.roomId}: ${g.allowedTools.join(', ')} (${g.remainingMinutes}m left)`);
        buttons.push([btn(`Revoke ${g.roomId}`, 'grev', g.roomId)]);
      }
      buttons.push([btn('Back', 'home')]);
    } else if (page === 'tasks') {
      lines.push(`Admin - Long Tasks (${status.longTasks.length})`);
      if (!status.longTasks.length) lines.push('(no recent long tasks)');
      for (const t of status.longTasks.slice(0, 8)) {
        lines.push(`- [${t.status}] ${t.id}: ${t.title} (${t.step}/${t.maxSteps})`);
        if (t.status === 'running' || t.status === 'queued') {
          buttons.push([btn(`Cancel ${t.id}`, 'tcancel', t.id)]);
        }
      }
      buttons.push([btn('Back', 'home')]);
    } else {
      lines.push(`SCROLL Fleet Admin (uptime ${status.uptimeSec}s)`);
      lines.push(`- Global: ${status.globalPaused ? 'PAUSED' : 'ACTIVE'}`);
      lines.push(`- Bots: ${status.bots.length} | Crons: ${status.cronCount} | Grants: ${status.activeGrants.length}`);
      for (const b of status.bots) {
        lines.push(`- ${b.id}: ${b.paused ? 'paused' : 'active'} (${b.provider}/${b.model || 'auto'}) · ${b.turnsProcessed} turns`);
        buttons.push([btn(`Manage ${b.id}`, 'bot', b.id)]);
      }
      buttons.push([
        btn(status.globalPaused ? 'Resume Fleet' : 'Pause Fleet', 'gkill'),
        btn('Memory Consolidate', 'mcons'),
      ]);
      buttons.push([
        btn('Grants', 'grants'),
        btn('Tasks', 'tasks'),
        btn('Refresh', 'home'),
      ]);
    }

    if (notice) lines.push('', `Note: ${notice}`);
    return { text: lines.join('\n'), buttons };
  }

  async function handleCallback(actor, data) {
    if (!String(data || '').startsWith(`${namespace}:`)) return null;
    if (!controller.isOwner(actor)) {
      return { forbidden: true, toast: 'Owner DM required.' };
    }
    const parts = String(data).slice(namespace.length + 1).split(':');
    const [cmd, a1, a2] = parts;
    try {
      if (cmd === 'home') return { toast: 'Refreshed', view: renderView({ page: 'home' }) };
      if (cmd === 'bot') return { toast: a1, view: renderView({ page: 'bot', botId: a1 }) };
      if (cmd === 'grants') return { toast: 'Grants', view: renderView({ page: 'grants' }) };
      if (cmd === 'tasks') return { toast: 'Tasks', view: renderView({ page: 'tasks' }) };
      if (cmd === 'gkill') {
        const r = await controller.executeAction(actor, 'global_pause');
        return { toast: r.data.globalPaused ? 'Paused' : 'Resumed', view: renderView({ page: 'home' }) };
      }
      if (cmd === 'bpause') {
        const r = await controller.executeAction(actor, 'bot_pause', { botId: a1 });
        return { toast: r.data.paused ? 'Paused' : 'Resumed', view: renderView({ page: 'bot', botId: a1 }) };
      }
      if (cmd === 'gpol') {
        await controller.executeAction(actor, 'bot_policy', { botId: a1, policy: a2 });
        return { toast: `Policy: ${a2}`, view: renderView({ page: 'bot', botId: a1 }) };
      }
      if (cmd === 'reload') {
        await controller.executeAction(actor, 'bot_reload', { botId: a1 });
        return { toast: 'Reloaded', view: renderView({ page: 'bot', botId: a1, notice: 'Agent reloaded.' }) };
      }
      if (cmd === 'mcons') {
        const r = await controller.executeAction(actor, 'memory_consolidate');
        return { toast: `Consolidated ${r.data.totalSubjects}`, view: renderView({ page: 'home', notice: `Consolidated ${r.data.totalSubjects} subject(s).` }) };
      }
      if (cmd === 'grev') {
        await controller.executeAction(actor, 'grant_revoke', { roomId: a1 });
        return { toast: 'Revoked', view: renderView({ page: 'grants', notice: `Revoked ${a1}.` }) };
      }
      if (cmd === 'tcancel') {
        await controller.executeAction(actor, 'task_cancel', { taskId: a1 });
        return { toast: 'Cancelled', view: renderView({ page: 'tasks', notice: `Cancelled ${a1}.` }) };
      }
      if (cmd === 'ctog') {
        await controller.executeAction(actor, 'cron_toggle', { jobId: a1 });
        return { toast: 'Toggled', view: renderView({ page: 'home' }) };
      }
      if (cmd === 'cdel') {
        await controller.executeAction(actor, 'cron_delete', { jobId: a1 });
        return { toast: 'Deleted', view: renderView({ page: 'home' }) };
      }
      if (cmd === 'crun') {
        await controller.executeAction(actor, 'cron_run', { jobId: a1 });
        return { toast: 'Triggered', view: renderView({ page: 'home', notice: `Triggered ${a1}.` }) };
      }
      return { toast: 'Unknown command', view: renderView({ page: 'home' }) };
    } catch (err) {
      return { toast: String(err?.message || err).slice(0, 120), view: renderView({ page: 'home', notice: String(err?.message || err) }) };
    }
  }

  return {
    namespace,
    renderView,
    handleCallback,
  };
}
