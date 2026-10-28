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

const dir = () => path.join(store.root(), 'runs');
const file = (key) => path.join(dir(), `${key}.json`);

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
    const b = byBot[h.botId] || (byBot[h.botId] = { botId: h.botId, name: h.botName, agentId: h.agentId, hops: 0, usage: emptyUsage(), cost: 0 });
    b.hops++;
    addUsage(b.usage, h.usage);
    if (typeof h.cost === 'number') b.cost += h.cost;
  }
  return { usage, cost: costKnown ? cost : null, byBot: Object.values(byBot), hops: (task.hops || []).filter((h) => h.kind === 'bot').length };
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
      hops: [],
    };
    this.running = new Map(); // id -> 正在跑的这一跳（Bot 或验收）
    this.queue = []; // 排队等着接手的成员
    liveTasks.set(key, this);
    this.emitLive();
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

  setRunning(id, info) {
    this.running.set(id, { ...info, startedAt: info.startedAt || Date.now() });
    this.emitLive();
  }

  clearRunning(id) {
    this.running.delete(id);
  }

  setQueue(list) {
    const next = list || [];
    if (JSON.stringify(next) === JSON.stringify(this.queue)) return;
    this.queue = next;
    this.emitLive();
  }

  /** 记一跳。prompt 太长就截断，其余字段原样 */
  hop(h) {
    const rec = { kind: 'bot', ...h };
    if (rec.prompt && rec.prompt.length > MAX_PROMPT) rec.prompt = rec.prompt.slice(0, MAX_PROMPT) + L('\n…（已截断）', '\n…(truncated)');
    if (rec.changes && rec.changes.length > 80) rec.changes = rec.changes.slice(0, 80);
    this.data.hops.push(rec);
    this.emitLive();
    return rec;
  }

  /** 正在跑的任务也要能看到累计用量（进度条上显示） */
  totals() {
    return totalsOf(this.data);
  }

  finish(endReason) {
    this.data.finishedAt = Date.now();
    this.data.endReason = endReason || this.data.endReason || 'done';
    this.running.clear();
    if (liveTasks.get(this.data.key) === this) liveTasks.delete(this.data.key);
    emitter('runs:live', { key: this.data.key, live: null });
    if (!this.data.hops.length) return this.data; // 一跳都没跑成（比如启动失败）就不记
    const list = read(this.data.key);
    list.push(this.data);
    write(this.data.key, list);
    emitter('runs:update', { key: this.data.key });
    return this.data;
  }
}

/** 会话的任务列表（新的在前），附带每条的合计 */
function list(key) {
  return read(key)
    .reverse()
    .map((t) => ({ ...t, totals: totalsOf(t) }));
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
  const total = { usage: emptyUsage(), cost: 0, tasks: 0, hops: 0 };
  const byKey = {};
  const byBot = {};
  const byDay = {};
  for (const f of files) {
    const key = f.slice(0, -5);
    for (const t of read(key)) {
      if (t.startedAt < since) continue;
      const tt = totalsOf(t);
      total.tasks++;
      total.hops += tt.hops;
      addUsage(total.usage, tt.usage);
      if (tt.cost) total.cost += tt.cost;
      const k = byKey[key] || (byKey[key] = { key, title: t.title, tasks: 0, usage: emptyUsage(), cost: 0 });
      k.tasks++;
      addUsage(k.usage, tt.usage);
      if (tt.cost) k.cost += tt.cost;
      for (const b of tt.byBot) {
        const x = byBot[b.botId] || (byBot[b.botId] = { botId: b.botId, name: b.name, agentId: b.agentId, hops: 0, usage: emptyUsage(), cost: 0 });
        x.hops += b.hops;
        addUsage(x.usage, b.usage);
        x.cost += b.cost;
      }
      const d = new Date(t.startedAt);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const y = byDay[day] || (byDay[day] = { day, usage: emptyUsage(), cost: 0 });
      addUsage(y.usage, tt.usage);
      if (tt.cost) y.cost += tt.cost;
    }
  }
  const tok = (u) => u.input + u.output;
  return {
    total,
    byKey: Object.values(byKey).sort((a, b) => tok(b.usage) - tok(a.usage)),
    byBot: Object.values(byBot).sort((a, b) => tok(b.usage) - tok(a.usage)),
    byDay: Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1)),
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
}

module.exports = { Task, list, summary, remove, totalsOf, liveOf, setEmitter };
