// SCROLL 2.5 -- Channel-Agnostic §50 Multi-Step Background Long-Task Runner.
// Runs multi-step autonomous workflows asynchronously via `WorkerPool` without blocking live chat.
// Prompt instructions are loaded from `templates/long-task-planner.md` (Rule 3: zero hardcoded prose).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedTemplate = null;
function loadPlannerSections() {
  if (cachedTemplate) return cachedTemplate;
  const tplPath = path.resolve(__dirname, '..', '..', 'templates', 'long-task-planner.md');
  let raw = '';
  try { raw = fs.readFileSync(tplPath, 'utf8'); } catch { raw = ''; }
  const section = (heading) => {
    const re = new RegExp(`(?:^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
    const m = raw.match(re);
    return m ? m[1].trim() : '';
  };
  cachedTemplate = {
    step1: section('Step 1 Instructions'),
    cont: section('Continuation Instructions'),
    synth: section('Final Synthesis Instructions'),
  };
  return cachedTemplate;
}

function interpolate(tpl, vars) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
}

export function createLongTaskRunner({
  stateDir = null,
  workerPool,
  channel = 'chat',
  defaultDelegatedTools = null,
  defaultToolsAllow = null,
  stepPromptBuilder = null,
  synthesisPromptBuilder = null,
  onProgress = null,
  onComplete = null,
  maxDefaultSteps = 12,
  maxDefaultMinutes = 20,
} = {}) {
  if (!workerPool || typeof workerPool.submit !== 'function') {
    throw new Error('createLongTaskRunner: workerPool is required');
  }
  const tasksDir = stateDir ? path.join(path.resolve(stateDir), 'long-tasks') : null;
  if (tasksDir) fs.mkdirSync(tasksDir, { recursive: true, mode: 0o700 });

  const tasks = new Map();

  function saveTask(t) {
    if (!tasksDir) return;
    const p = path.join(tasksDir, `${t.id}.json`);
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
  }

  function snapshot(t) {
    return {
      id: t.id,
      botId: t.botId,
      chatId: t.chatId,
      roomId: t.chatId,
      isGroup: Boolean(t.isGroup),
      channel: t.channel,
      title: t.title,
      goal: t.goal,
      status: t.status,
      step: t.step,
      maxSteps: t.maxSteps,
      maxMinutes: t.maxMinutes,
      startedAt: t.startedAt,
      updatedAt: t.updatedAt,
      finishedAt: t.finishedAt,
      stepsLog: [...t.stepsLog],
      finalReport: t.finalReport,
      error: t.error,
    };
  }

  function startTask({
    bot = null,
    runtime = null,
    botId = null,
    chatId = null,
    roomId = null,
    isGroup = false,
    channel: taskChannel = channel,
    sender = null,
    title = 'Long Task',
    goal,
    maxSteps = maxDefaultSteps,
    maxMinutes = maxDefaultMinutes,
    delegatedTools = defaultDelegatedTools,
    toolsAllow = defaultToolsAllow,
    reportEverySteps = 3,
    model = null,
    effort = null,
  } = {}) {
    const activeRuntime = runtime || bot?.runtime;
    if (!activeRuntime || typeof activeRuntime.sendTurn !== 'function') {
      throw new Error('longTask.startTask: runtime (or bot.runtime) with sendTurn is required');
    }
    if (!goal || !String(goal).trim()) throw new Error('longTask.startTask: goal is required');

    const id = `lt_${crypto.randomBytes(4).toString('hex')}`;
    const boundedSteps = Math.max(1, Math.min(30, Number(maxSteps || maxDefaultSteps)));
    const boundedMins = Math.max(1, Math.min(45, Number(maxMinutes || maxDefaultMinutes)));
    const nowIso = new Date().toISOString();
    const targetRoom = String(roomId ?? chatId ?? 'default');

    const task = {
      id,
      botId: botId || bot?.id || activeRuntime.agentName || 'default',
      chatId: targetRoom,
      isGroup: Boolean(isGroup),
      channel: String(taskChannel || 'chat'),
      title: String(title || 'Long Task').slice(0, 120),
      goal: String(goal).trim().slice(0, 4000),
      status: 'queued',
      step: 0,
      maxSteps: boundedSteps,
      maxMinutes: boundedMins,
      startedAt: nowIso,
      updatedAt: nowIso,
      finishedAt: null,
      stepsLog: [],
      finalReport: null,
      error: null,
      workerJobId: null,
    };
    tasks.set(id, task);
    saveTask(task);

    const tpl = loadPlannerSections();

    const job = workerPool.submit({
      id: `wk_${id}`,
      label: `long-task:${task.title}`,
      chatId: task.chatId,
      fn: async ({ signal }) => {
        const deadlineMs = Date.now() + boundedMins * 60_000;
        task.status = 'running';
        task.updatedAt = new Date().toISOString();
        saveTask(task);

        const convId = `longtask:${id}`;
        let stalledSteps = 0;
        try {
          for (let step = 1; step <= boundedSteps; step++) {
            if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
            if (Date.now() >= deadlineMs) {
              task.stepsLog.push({ step, ts: new Date().toISOString(), summary: 'Reached time ceiling; synthesizing final report.' });
              break;
            }
            task.step = step;
            task.updatedAt = new Date().toISOString();
            saveTask(task);

            const vars = {
              taskId: id,
              step,
              maxSteps: boundedSteps,
              maxMinutes: boundedMins,
              title: task.title,
              goal: task.goal,
            };
            const stepPrompt = typeof stepPromptBuilder === 'function'
              ? stepPromptBuilder(vars)
              : interpolate(step === 1 ? tpl.step1 : tpl.cont, vars);

            const turn = await activeRuntime.sendTurn({
              conversationId: convId,
              text: stepPrompt,
              sender,
              isGroup: false,
              channel: task.channel,
              model: model || bot?.model,
              effort: effort || bot?.effort || 'low',
              delegatedTools,
              toolsAllow,
              approved: true,
              signal,
            });

            const outText = String(turn.text || '').trim();
            const isDone = /(?:^|\n)\s*TASK_DONE\s*$/i.test(outText);
            const isBlocked = /(?:^|\n)\s*TASK_BLOCKED\s*$/i.test(outText);
            const cleanOut = outText.replace(/(?:^|\n)\s*TASK_(?:DONE|BLOCKED)\s*$/i, '').trim();
            const toolsUsed = (turn.toolTraces || []).map((tr) => tr.name);
            task.stepsLog.push({
              step,
              ts: new Date().toISOString(),
              toolsUsed,
              summary: cleanOut.slice(0, 600),
            });
            task.updatedAt = new Date().toISOString();
            saveTask(task);

            if (isDone) {
              task.finalReport = cleanOut;
              break;
            }
            if (isBlocked) {
              task.status = 'blocked';
              task.error = cleanOut;
              task.finishedAt = new Date().toISOString();
              task.updatedAt = task.finishedAt;
              saveTask(task);
              if (typeof onComplete === 'function') await Promise.resolve(onComplete(snapshot(task))).catch(() => {});
              return snapshot(task);
            }
            if (toolsUsed.length === 0) stalledSteps += 1;
            else stalledSteps = 0;
            if (stalledSteps >= 2) {
              task.status = 'blocked';
              task.error = cleanOut || 'stalled_without_tool_progress';
              task.finishedAt = new Date().toISOString();
              task.updatedAt = task.finishedAt;
              saveTask(task);
              if (typeof onComplete === 'function') await Promise.resolve(onComplete(snapshot(task))).catch(() => {});
              return snapshot(task);
            }
            if (typeof onProgress === 'function' && step % Math.max(1, Number(reportEverySteps || 3)) === 0 && step < boundedSteps) {
              await Promise.resolve(onProgress(snapshot(task), cleanOut)).catch(() => {});
            }
          }

          if (!task.finalReport) {
            const synthPrompt = typeof synthesisPromptBuilder === 'function'
              ? synthesisPromptBuilder({ taskId: id, title: task.title, goal: task.goal })
              : interpolate(tpl.synth, { taskId: id, title: task.title, goal: task.goal });
            const synth = await activeRuntime.sendTurn({
              conversationId: convId,
              text: synthPrompt,
              sender,
              isGroup: false,
              channel: task.channel,
              model: model || bot?.model,
              effort: 'low',
              toolsAllow: [],
              signal,
            });
            task.finalReport = String(synth.text || '').trim() || task.stepsLog.map((s) => `Step ${s.step}: ${s.summary}`).join('\n');
          }

          task.status = 'completed';
          task.finishedAt = new Date().toISOString();
          task.updatedAt = task.finishedAt;
          saveTask(task);
          if (typeof onComplete === 'function') await Promise.resolve(onComplete(snapshot(task))).catch(() => {});
          return snapshot(task);
        } catch (err) {
          task.status = signal.aborted ? 'cancelled' : 'failed';
          task.error = String(err?.message || err);
          task.finishedAt = new Date().toISOString();
          task.updatedAt = task.finishedAt;
          saveTask(task);
          if (typeof onComplete === 'function') await Promise.resolve(onComplete(snapshot(task))).catch(() => {});
          return snapshot(task);
        }
      },
    });

    task.workerJobId = job.id;
    saveTask(task);
    return snapshot(task);
  }

  function getTask(taskId) {
    const t = tasks.get(taskId);
    return t ? snapshot(t) : null;
  }

  function listTasks({ chatId = null, roomId = null, status = null } = {}) {
    const filterRoom = roomId ?? chatId;
    return [...tasks.values()]
      .filter((t) => (!filterRoom || t.chatId === String(filterRoom)) && (!status || t.status === status))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map(snapshot);
  }

  function cancelTask(taskId) {
    const t = tasks.get(taskId);
    if (!t) return { ok: false, reason: 'task_not_found' };
    if (t.workerJobId) workerPool.cancel(t.workerJobId);
    t.status = 'cancelled';
    t.finishedAt = new Date().toISOString();
    t.updatedAt = t.finishedAt;
    saveTask(t);
    return { ok: true, id: taskId, status: 'cancelled' };
  }

  function registerTools({
    tools,
    bot = null,
    runtime = null,
    ownerIds = [],
    groupGrants = null,
    channel: toolChannel = channel,
    delegatedTools = defaultDelegatedTools,
    toolsAllow = defaultToolsAllow,
  } = {}) {
    const ownerSet = new Set((ownerIds || []).map(String));
    const canLaunch = (ctx) => {
      const rawId = String(ctx.sender?.id || ctx.sender?.channelId || '');
      const stripped = rawId.replace(/^[a-z0-9_-]+:/i, '');
      if ((rawId && ownerSet.has(rawId)) || (stripped && ownerSet.has(stripped))) return true;
      if (ctx.chatId && groupGrants) {
        const g = groupGrants.getActiveGrant(ctx.chatId);
        if (g && g.allowedTools.includes('start_long_task')) return true;
      }
      return false;
    };

    tools.register({
      name: 'start_long_task',
      description: 'Start a non-blocking multi-step background long task (up to 30 steps / 45 min). Reports progress and sends a final summary when done.',
      risk: 'reversible_write',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title' },
          goal: { type: 'string', description: 'Detailed goal and step plan for the autonomous loop' },
          maxSteps: { type: 'number', description: 'Max autonomous iterations (1-30, default 10)' },
          maxMinutes: { type: 'number', description: 'Max wall-clock minutes (1-45, default 15)' },
        },
        required: ['title', 'goal'],
      },
      async execute(args, ctx) {
        if (!canLaunch(ctx)) return { ok: false, error: 'owner_or_active_group_grant_required' };
        const activeGrant = ctx.chatId && groupGrants ? groupGrants.getActiveGrant(ctx.chatId) : null;
        const t = startTask({
          bot,
          runtime,
          chatId: ctx.chatId || ownerIds[0] || 'default',
          isGroup: Boolean(ctx.turnClassification?.isGroup),
          channel: toolChannel,
          sender: ctx.sender || (ownerIds[0] ? { id: ownerIds[0], name: 'Owner' } : null),
          title: args.title,
          goal: args.goal,
          maxSteps: args.maxSteps || 10,
          maxMinutes: args.maxMinutes || 15,
          delegatedTools: activeGrant ? activeGrant.allowedTools : delegatedTools,
          toolsAllow,
        });
        return {
          ok: true,
          taskId: t.id,
          status: t.status,
          maxSteps: t.maxSteps,
          maxMinutes: t.maxMinutes,
          note: 'Long task started in background; progress and final report will be delivered automatically.',
        };
      },
    });

    tools.register({
      name: 'long_task_status',
      description: 'Check status and recent step log of background long tasks.',
      risk: 'read_only',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
      },
      async execute(args, ctx) {
        if (args.taskId) return { ok: true, task: getTask(args.taskId) };
        return { ok: true, tasks: listTasks({ chatId: ctx.chatId || null }).slice(0, 10) };
      },
    });

    tools.register({
      name: 'cancel_long_task',
      description: 'Cancel a running background long task by taskId.',
      risk: 'reversible_write',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      async execute(args, ctx) {
        if (!canLaunch(ctx)) return { ok: false, error: 'owner_or_active_group_grant_required' };
        return cancelTask(args.taskId);
      },
    });
  }

  return {
    startTask,
    getTask,
    listTasks,
    cancelTask,
    registerTools,
  };
}
