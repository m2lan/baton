'use strict';
/**
 * 运行日志：每次任务一条记录，用量统计和 prompt 检查器都读它。
 *
 * 一次「任务」= 用户发一句话，到这句话引发的整条交班链结束。单 Bot 会话里就是一问一答。
 * 结构：
 *   task = { id, key, kind, title, userText, startedAt, finishedAt, endReason, hops: [hop] }
 *   hop  = { kind: 'bot'|'verify', botId, botName, agentId, from, startedAt, duration,
 *            status, endReason, usage: {input, output, cacheRead}, cost, model, prompt, msgId, changes }
 *
 * 按会话分文件存（data/runs/<key>.json），每个会话只留最近 MAX_TASKS 条。
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { L } = require('./lang');

const MAX_TASKS = 60;
// 正在跑的任务：开始就登记，界面实时画接力图；结束才落盘
const liveTasks = new Map(); // key -> Task
let emitter = () => {};
function setEmitter(fn) {
  emitter = fn || (() => {});
}
const MAX_PROMPT = 20000; // prompt 原文上限：够看清三层上下文，又不至于把日志撑爆
const MAX_QUEUE_TEXT = 2000; // live 快照里排队任务的文本上限，和 userText 保持一致
const LIVE_SCHEMA = 1;

const dir = () => path.join(store.root(), 'runs');
const file = (key) => path.join(dir(), `${key}.json`);
// 进行中的任务单独放一层子目录：runlog.list() 只扫 *.json，不会误读它
const liveDir = () => path.join(dir(), 'live');
const liveFile = (key) => path.join(liveDir(), `${key}.json`);

function read(key) {
  try {
    const d = JSON.parse(fs.readFileSync(file(key), 'utf8'));
    return Array.isArray(d.tasks) ? d.tasks : [];
  } catch {
    return [];
  }
}

function write(key, tasks) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file(key)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ tasks: tasks.slice(-MAX_TASKS) }), 'utf8');
  fs.renameSync(tmp, file(key));
}

function writeLive(key, payload) {
  fs.mkdirSync(liveDir(), { recursive: true });
  const target = liveFile(key);
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmp, target);
}

function readLive(key) {
  try {
    return JSON.parse(fs.readFileSync(liveFile(key), 'utf8'));
  } catch {
    return null;
  }
}

function removeLive(key) {
  try {
    fs.unlinkSync(liveFile(key));
  } catch {}
}

/** 只删属于自己的快照：同一会话开始新一轮后，旧一轮迟到的 finish 不能删掉新快照 */
function removeLiveIfOwned(key, id) {
  const cur = readLive(key);
  if (cur && cur.task && cur.task.id !== id) return false;
  removeLive(key);
  return true;
}

/** prompt 只进历史，不进 live 快照：60 跳 × 20KB 反复重写不值得 */
function stripPrompt(h) {
  const { prompt, ...rest } = h;
  return rest;
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0 });

function addUsage(acc, u) {
  if (!u) return acc;
  acc.input += u.input || 0;
  acc.output += u.output || 0;
  acc.cacheRead += u.cacheRead || 0;
  return acc;
}

/** 任务的合计：token、费用（只有部分 CLI 报费用，没报的不计入），按 Bot 拆分 */
function totalsOf(task) {
  const usage = emptyUsage();
  let cost = 0;
  let costKnown = false;
  const byBot = {};
  for (const h of task.hops || []) {
    if (h.kind !== 'bot') continue;
    addUsage(usage, h.usage);
    if (typeof h.cost === 'number') {
      cost += h.cost;
      costKnown = true;
    }
    const b = byBot[h.botId] || (byBot[h.botId] = { botId: h.botId, name: h.botName, agentId: h.agentId, hops: 0, usage: emptyUsage(), cost: 0, costKnown: false });
    b.hops++;
    addUsage(b.usage, h.usage);
    if (typeof h.cost === 'number') {
      b.cost += h.cost;
      b.costKnown = true;
    }
  }
  return {
    usage,
    // null 表示这批跳一个都没报费用，和「费用是 0」区分开，界面显示 —
    cost: costKnown ? cost : null,
    byBot: Object.values(byBot).map(({ costKnown, ...b }) => ({ ...b, cost: costKnown ? b.cost : null })),
    hops: (task.hops || []).filter((h) => h.kind === 'bot').length,
  };
}

class Task {
  constructor({ key, kind, title, userText }) {
    this.data = {
      id: `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      key,
      kind,
      title,
      userText: String(userText || '').slice(0, 2000),
      startedAt: Date.now(),
      finishedAt: 0,
      endReason: '',
      status: 'running',
      updatedAt: Date.now(),
      hops: [],
      worktree: null, // 任务级隔离目录：{root, dir, merged, kept?}
    };
    this.running = new Map(); // id -> 正在跑的这一跳（Bot 或验收）
    this.queue = []; // 给界面看的排队成员（只有名字等展示字段）
    this.jobs = []; // 排队任务的完整内容，中断恢复要靠它知道还剩谁、做什么
    this.round = null; // 群聊轮次快照，供中断恢复
    liveTasks.set(key, this);
    this.emitLive();
    this.saveLive();
  }

  /** 推给界面的快照。已完成的跳不带 prompt（太大，结束后在列表里看）；正在跑的带上 */
  snapshot() {
    return {
      ...this.data,
      hops: this.data.hops.map(({ prompt, ...h }) => h),
      running: [...this.running.values()],
      queue: this.queue,
      totals: this.totals(),
    };
  }

  emitLive() {
    emitter('runs:live', { key: this.data.key, live: this.snapshot() });
  }

  /**
   * 进行中快照落盘。只在状态边界调用（开始 / 换跳 / 队列变化 / 出结论），
   * 不在流式 token 上调用；失败也不能打断正在跑的任务，下一次状态变化会重写。
   */
  saveLive() {
    if (this.finished) return;
    // 同一会话已经开了新一轮：旧一轮迟到的状态更新不能覆盖新快照
    if (liveTasks.get(this.data.key) !== this) return;
    this.data.updatedAt = Date.now();
    try {
      writeLive(this.data.key, {
        schema: LIVE_SCHEMA,
        task: {
          ...this.data,
          status: 'running',
          hops: this.data.hops.map(stripPrompt),
        },
        running: [...this.running.values()].map(stripPrompt),
        queue: (this.jobs || []).map((q) => ({
          ...q,
          text: String(q.text || '').slice(0, MAX_QUEUE_TEXT),
        })),
        round: this.round || null,
      });
    } catch {}
  }

  /** 群聊轮次快照：恢复时要靠它知道上一轮跑到第几棒、还剩谁没跑 */
  setRound(round) {
    this.round = round || null;
    this.saveLive();
  }

  /** 任务级隔离目录：合并成功后 dir 已被删掉，记录留着方便回溯当时在哪跑的 */
  setWorktree(info) {
    this.data.worktree = info || null;
    this.saveLive();
  }

  setRunning(id, info) {
    this.running.set(id, { ...info, startedAt: info.startedAt || Date.now() });
    this.emitLive();
    this.saveLive();
  }

  clearRunning(id) {
    this.running.delete(id);
    this.saveLive();
  }

  setQueue(list, jobs) {
    const next = list || [];
    const sameQueue = JSON.stringify(next) === JSON.stringify(this.queue);
    const sameJobs = !Array.isArray(jobs) || JSON.stringify(jobs) === JSON.stringify(this.jobs);
    if (sameQueue && sameJobs) return;
    this.queue = next;
    if (Array.isArray(jobs)) this.jobs = jobs;
    this.emitLive();
    this.saveLive();
  }

  /** 记一跳。prompt 太长就截断，其余字段原样 */
  hop(h) {
    const rec = { kind: 'bot', ...h };
    if (rec.prompt && rec.prompt.length > MAX_PROMPT) rec.prompt = rec.prompt.slice(0, MAX_PROMPT) + L('\n…（已截断）', '\n…(truncated)');
    if (rec.changes && rec.changes.length > 80) rec.changes = rec.changes.slice(0, 80);
    this.data.hops.push(rec);
    this.emitLive();
    this.saveLive();
    return rec;
  }

  /** 正在跑的任务也要能看到累计用量（进度条上显示） */
  totals() {
    return totalsOf(this.data);
  }

  finish(endReason) {
    // 结算可能被不同路径各调一次（正常结束 / 异常兜底），重复写会把同一条任务记两遍
    if (this.finished) return this.data;
    this.finished = true;
    this.data.finishedAt = Date.now();
    this.data.endReason = endReason || this.data.endReason || 'done';
    this.data.status = 'completed';
    this.data.updatedAt = this.data.finishedAt;
    this.running.clear();
    this.queue = [];
    if (liveTasks.get(this.data.key) === this) liveTasks.delete(this.data.key);
    emitter('runs:live', { key: this.data.key, live: null });
    // 先删 live 再判空：启动失败这种一跳都没跑成的任务，也不能留下运行中快照
    removeLiveIfOwned(this.data.key, this.data.id);
    if (!this.data.hops.length) return this.data; // 一跳都没跑成（比如启动失败）就不记
    const list = read(this.data.key);
    list.push(this.data);
    write(this.data.key, list);
    emitter('runs:update', { key: this.data.key });
    return this.data;
  }

  /**
   * 应用退出时收尾：和 finish 的区别是终态为 interrupted，且把轮次快照一起归档，
   * 让下次启动能看到「上次跑到一半」并决定是否继续。零跳任务也要记 —— 中断本身就是信息。
   */
  interrupt(reason = 'hostExit') {
    if (this.finished) return this.data;
    this.finished = true;
    const now = Date.now();
    this.data.status = 'interrupted';
    this.data.endReason = reason;
    this.data.finishedAt = now;
    this.data.updatedAt = now;
    this.data.interruptedAt = now;
    this.data.round = { ...(this.round || {}), queue: this.jobs || [] };
    this.running.clear();
    this.queue = [];
    if (liveTasks.get(this.data.key) === this) liveTasks.delete(this.data.key);
    emitter('runs:live', { key: this.data.key, live: null });
    removeLiveIfOwned(this.data.key, this.data.id);
    const list = read(this.data.key);
    if (!list.some((t) => t.id === this.data.id)) {
      list.push(this.data);
      write(this.data.key, list);
    }
    emitter('runs:update', { key: this.data.key });
    return this.data;
  }
}

const NEEDS_ATTENTION = new Set(['blocked', 'error', 'failed', 'stall', 'timeout', 'maxTurns', 'verifyFailed', 'mergeFailed']);

/**
 * 这条任务是否需要人处理：中断待继续、阻塞等人、或失败类终态。
 * 「知道了」之后不再算，避免一个已经看过的失败一直占着默认视图。
 */
function needsAttention(t) {
  if (!t || t.attentionDismissed) return false;
  if (t.status === 'interrupted' && t.round) return true;
  return NEEDS_ATTENTION.has(t.endReason);
}

/** 会话的任务列表（新的在前），附带每条的合计和「是否需要人处理」 */
function list(key) {
  return read(key)
    .reverse()
    .map((t) => ({ ...t, totals: totalsOf(t), needsAttention: needsAttention(t) }));
}

/**
 * 近 N 天所有会话的用量，按会话和 Bot 汇总。
 * @param {number} days 0 = 全部
 */
function summary(days) {
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  let files = [];
  try {
    files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch {}
  const total = { usage: emptyUsage(), cost: 0, costKnown: false, tasks: 0, hops: 0 };
  const byKey = {};
  const byBot = {};
  const byDay = {};
  // 费用只有部分 CLI 报：一个都没报时合计是「未知」而不是 0，界面据此显示 —
  const addCost = (bucket, cost) => {
    if (typeof cost !== 'number') return;
    bucket.cost += cost;
    bucket.costKnown = true;
  };
  for (const f of files) {
    const key = f.slice(0, -5);
    for (const t of read(key)) {
      if (t.startedAt < since) continue;
      const tt = totalsOf(t);
      total.tasks++;
      total.hops += tt.hops;
      addUsage(total.usage, tt.usage);
      addCost(total, tt.cost);
      const k = byKey[key] || (byKey[key] = { key, title: t.title, tasks: 0, usage: emptyUsage(), cost: 0, costKnown: false });
      k.tasks++;
      addUsage(k.usage, tt.usage);
      addCost(k, tt.cost);
      for (const b of tt.byBot) {
        const x = byBot[b.botId] || (byBot[b.botId] = { botId: b.botId, name: b.name, agentId: b.agentId, hops: 0, usage: emptyUsage(), cost: 0, costKnown: false });
        x.hops += b.hops;
        addUsage(x.usage, b.usage);
        addCost(x, b.cost);
      }
      const d = new Date(t.startedAt);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const y = byDay[day] || (byDay[day] = { day, usage: emptyUsage(), cost: 0, costKnown: false });
      addUsage(y.usage, tt.usage);
      addCost(y, tt.cost);
    }
  }
  const tok = (u) => u.input + u.output;
  const settle = (list) => list.map(({ costKnown, ...x }) => ({ ...x, cost: costKnown ? x.cost : null }));
  return {
    total: settle([total])[0],
    byKey: settle(Object.values(byKey)).sort((a, b) => tok(b.usage) - tok(a.usage)),
    byBot: settle(Object.values(byBot)).sort((a, b) => tok(b.usage) - tok(a.usage)),
    byDay: settle(Object.values(byDay)).sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

function liveOf(key) {
  const t = liveTasks.get(key);
  return t ? t.snapshot() : null;
}

function remove(key) {
  try {
    fs.unlinkSync(file(key));
  } catch {}
  removeLive(key);
}

/** 应用退出时把所有进行中的任务标成中断，供下次启动展示 */
function interruptAll(reason = 'hostExit') {
  return [...liveTasks.values()].map((task) => task.interrupt(reason));
}

/**
 * 启动时收拢上次没跑完的任务：把 live 快照归档成 interrupted 写进历史，删掉快照。
 * 返回 [{ key, taskId, round }]：渲染层据此显示「上次任务中断」，并让用户决定是否继续。
 * 这里只归档，不重启任何执行 —— CLI 进程状态不可恢复，继续由用户显式触发。
 */
function recoverAll() {
  let names = [];
  try {
    names = fs.readdirSync(liveDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const key = name.slice(0, -5);
    const payload = readLive(key);
    const data = payload && payload.task;
    // 写到一半断电之类的坏快照：直接丢弃，不能让它每次启动都报一次错
    if (!data || !data.id) {
      removeLive(key);
      continue;
    }
    const list = read(key);
    // 同一任务已经归档过（归档后进程又崩了），不要记两遍
    if (list.some((t) => t.id === data.id)) {
      removeLive(key);
      continue;
    }
    const task = {
      ...data,
      status: 'interrupted',
      endReason: 'hostExit',
      finishedAt: data.finishedAt || Date.now(),
      updatedAt: Date.now(),
      interruptedAt: Date.now(),
      hops: Array.isArray(data.hops) ? data.hops : [],
      round: { ...(payload.round || {}), queue: payload.queue || [] },
    };
    list.push(task);
    write(key, list);
    removeLive(key);
    out.push({ key, taskId: task.id, round: task.round });
  }
  return out;
}

/** 用户选择「放弃继续」：只清掉可继续的轮次信息，任务记录本身保留 */
function discardResume(key, taskId) {
  const list = read(key);
  const i = list.findIndex((t) => t.id === taskId && t.status === 'interrupted' && t.round);
  if (i < 0) return false;
  list[i] = { ...list[i], round: null, resumeDismissed: true };
  write(key, list);
  emitter('runs:update', { key });
  return true;
}

/** 用户点「知道了」：不再在会话顶部提醒这条任务，记录本身保留 */
function dismissAttention(key, taskId) {
  const list = read(key);
  const i = list.findIndex((t) => t.id === taskId);
  if (i < 0 || list[i].attentionDismissed) return false;
  list[i] = { ...list[i], attentionDismissed: true };
  write(key, list);
  emitter('runs:update', { key });
  return true;
}

/** 还没处理掉的任务级 worktree：启动清理时要跳过它们，否则现场就没了 */
function worktreeDirs() {
  let names = [];
  try {
    names = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    for (const t of read(name.slice(0, -5))) {
      if (t.worktree && t.worktree.dir && !t.worktree.merged) out.push(t.worktree.dir);
    }
  }
  return out;
}

module.exports = {
  Task,
  list,
  summary,
  remove,
  totalsOf,
  liveOf,
  setEmitter,
  recoverAll,
  interruptAll,
  discardResume,
  dismissAttention,
  needsAttention,
  worktreeDirs,
  liveFile,
  readLive,
};
