'use strict';
/**
 * 群聊编排：多个 Bot 同屏协作。
 * 规则：
 *  - 用户 @谁 谁回答，按 @ 的顺序串行；没 @ 就交给「负责人」。
 *  - Bot 回答里 @其他成员 = 交班，接手的 Bot 会看到前面的群聊记录继续做。
 *  - 结束条件：某个 Bot 的回答不再 @ 任何人，即视为任务完成、自然收尾。
 *    不限制单个 Bot 出现的次数（允许「出方案→评审→回改→再审」来回多次），
 *    只用 MAX_TURNS 兜底，防止极端情况下无限空转。
 */
const { getAgent } = require('./agents');

const MAX_TURNS = 24;
// 上下文分三层预算：用户的每句话都是需求，不能丢；别人的发言只留结论 + 近期
const CTX_BUDGET_ASK = 1500; // ① 用户需求锚点
const CTX_BUDGET_DECISION = 1600; // ② 其他 Bot 的结论
const CTX_BUDGET_RECENT = 3000; // ③ 近期完整对话
const CTX_MSG_CHARS = 600; // 单条消息最多保留多少字
const CTX_RECENT_MSGS = 10; // ③ 最多取最近几条

function textOf(msg) {
  if (!msg || !msg.parts) return '';
  return msg.parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/** 从文本里按出现顺序找出被 @ 的成员（名字互为前缀时取最长匹配） */
function findMentions(text, members) {
  const src = String(text || '');
  const hits = [];
  const taken = new Array(src.length).fill(false);

  const ordered = [...members].sort((a, b) => (b.name || '').length - (a.name || '').length);
  for (const m of ordered) {
    const name = m.name || '';
    if (!name) continue;
    let from = 0;
    for (;;) {
      const idx = src.indexOf('@' + name, from);
      if (idx === -1) break;
      const end = idx + 1 + name.length;
      let overlap = false;
      for (let i = idx; i < end; i++) if (taken[i]) overlap = true;
      if (!overlap) {
        for (let i = idx; i < end; i++) taken[i] = true;
        hits.push({ botId: m.id, at: idx });
      }
      from = end;
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.botId);
}

class Room {
  constructor({ runner, store, getBot, emit, onChange }) {
    this.runner = runner;
    this.store = store;
    this.getBot = getBot;
    this.emit = emit;
    this.onChange = onChange || (() => {});
    this.aborted = new Set();
    this.busy = new Set();
  }

  isBusy(gid) {
    return this.busy.has(gid);
  }

  stop(gid) {
    this.aborted.add(gid);
    for (const key of this.runner.running.keys()) {
      if (key.startsWith(`${gid}:`)) this.runner.stop(key);
    }
    this.busy.delete(gid);
    this.emit('room:state', { key: gid, active: false, current: null, queue: [] });
    return true;
  }

  members(group) {
    return (group.memberIds || []).map((id) => this.getBot(id)).filter(Boolean);
  }

  /**
   * 群聊上下文，按重要性分三层（不按时间一刀切）：
   *   ① 用户说过的所有话 —— 都是需求，永不丢
   *   ② 其他 Bot 的结论 —— 补「最近窗口之外」的发言，取末尾段落 + @ 交班行
   *   ③ 最近若干条完整对话 —— 保证连贯
   * 三层互不重复：用户消息只进 ①，窗口内的 Bot 消息只进 ③，窗口外的才进 ②。
   * 自己说过的话不用带：每个 Bot 有自己的 session，--resume 时它自己记得。
   * @returns {{asks: string[], decisions: string[], recent: string[]}}
   */
  contextFor(group, bot) {
    const all = this.store.getMessages(group.id) || [];
    const isMine = (m) => m.role === 'assistant' && m.sender && m.sender.id === bot.id;
    const who = (m) => (m.role === 'user' ? '用户' : (m.sender && m.sender.name) || '成员');
    const clip = (s) => (s.length > CTX_MSG_CHARS ? s.slice(0, CTX_MSG_CHARS) + '…' : s);

    /* ---- ① 用户需求锚点 ---- */
    const asks = [];
    let budget = CTX_BUDGET_ASK;
    for (const m of all) {
      if (m.role !== 'user') continue;
      const body = textOf(m);
      if (!body) continue;
      const line = `用户: ${clip(body)}`;
      if (line.length > budget) break;
      budget -= line.length;
      asks.push(line);
    }

    /* ---- ③ 最近几条完整对话（先算，给 ② 做去重） ---- */
    // 用户的话已经在 ① 里，这里不再重复；自己的话在自己的 session 里
    const recent = [];
    const covered = new Set();
    budget = CTX_BUDGET_RECENT;
    for (let i = all.length - 1; i >= 0 && recent.length < CTX_RECENT_MSGS; i--) {
      const m = all[i];
      if (isMine(m) || m.role === 'system' || m.role === 'user') continue;
      const body = textOf(m);
      if (!body) continue;
      const line = `${who(m)}: ${clip(body)}`;
      if (line.length > budget) break;
      budget -= line.length;
      recent.unshift(line);
      covered.add(m.id);
    }

    /* ---- ② 其他 Bot 的结论 ---- */
    // 只补「最近窗口之外」的发言：窗口内已经完整包含了，不用重复。
    // 每个 Bot 取窗口外的最后一条，结论在最后一段，先保住它。
    const lastOutside = new Map();
    for (const m of all) {
      if (m.role !== 'assistant' || !m.sender || isMine(m)) continue;
      if (covered.has(m.id)) continue;
      lastOutside.set(m.sender.id, m);
    }
    const others = [...lastOutside.values()].reverse(); // 最近说过话的优先
    const perBot = Math.max(180, Math.floor(CTX_BUDGET_DECISION / Math.max(1, others.length)));
    const decisions = [];
    for (const m of others) {
      const body = textOf(m);
      if (!body) continue;
      const paras = body.split(/\n{2,}/).filter(Boolean);
      // 结论在最后一段，先保住它；预算还有富余，再从上一段末尾补一点上下文
      const last = paras[paras.length - 1] || body;
      let merged = last.length > perBot ? last.slice(0, perBot) + '…' : last;
      const remain = perBot - merged.length;
      if (remain > 60 && paras.length > 1) {
        const prev = paras[paras.length - 2];
        merged = `${prev.slice(-remain)}\n${merged}`;
      }
      // 末尾的 @ 交班行单独保留，不要被截断吃掉
      const atLine = body
        .split('\n')
        .filter((l) => /@\S/.test(l))
        .slice(-1)[0];
      if (atLine && !merged.includes(atLine)) merged = `${merged}\n${atLine}`;
      if (!merged.trim()) continue;
      decisions.push(`${who(m)}: ${merged}`);
    }
    decisions.reverse();

    return { asks, decisions, recent };
  }

  buildPrompt(group, bot, job, members) {
    const names = members.map((m) => m.name).join('、');
    const isLeader = (group.leaderId || (group.memberIds || [])[0]) === bot.id;
    const chunks = [
      `【群聊】你在多 Bot 协作房间「${group.name}」里，成员：${names}。`,
      `你是「${bot.name}」，只代表你自己发言，不要假装别人，也不要复述整段对话。`,
      isLeader ? '你是本房间的负责人，用户没点名时由你主答。' : '',
    ];

    const ctx = this.contextFor(group, bot);
    if (ctx.asks.length) chunks.push(`【用户的需求】\n${ctx.asks.join('\n')}`);
    if (ctx.decisions.length) chunks.push(`【其他人已经得出的结论】\n${ctx.decisions.join('\n')}`);
    if (ctx.recent.length) chunks.push(`【最近的群聊记录】\n${ctx.recent.join('\n')}`);

    if (job.from) {
      const fromBot = this.getBot(job.from);
      chunks.push(`【交班】「${fromBot ? fromBot.name : '成员'}」把这件事交给了你，请接着往下做，不要重复它已经完成的步骤。`);
    }

    chunks.push(`【本轮任务】\n${job.text}`);
    chunks.push('如果这件事需要别的成员接手，在回答最后单独一行写 `@成员名` 交班；不需要就不要 @ 任何人。');

    return chunks.filter(Boolean).join('\n\n');
  }

  /** 从 Bot 的回答里挑下一个接手的人：@ 了谁就交给谁（不限制次数） */
  pickHandoff(msg, group) {
    const body = textOf(msg);
    if (!body) return null;
    const members = this.members(group);
    const mentioned = findMentions(body, members);
    return mentioned[0] || null;
  }

  async send(group, userText, userMsg) {
    const members = this.members(group);
    if (!members.length) {
      this.pushSystem(group.id, '这个群还没有成员，先在群设置里加几个 Bot。');
      return { ok: false, error: '群聊没有成员' };
    }
    if (this.busy.has(group.id)) return { ok: false, error: '这个群正在跑上一轮' };

    this.aborted.delete(group.id);
    this.busy.add(group.id);

    const mentioned = findMentions(userText, members);
    const leader = group.leaderId || members[0].id;
    const targets = mentioned.length ? mentioned : [leader];

    const queue = targets.map((id) => ({ botId: id, text: userText, from: null }));
    let turns = 0;
    this.emitState(group, { active: true, queue, turn: 0 });

    try {
      while (queue.length && turns < MAX_TURNS && !this.aborted.has(group.id)) {
        const job = queue.shift();
        const bot = this.getBot(job.botId);
        if (!bot) continue;
        const agent = getAgent(bot.agentId);
        if (!agent) {
          this.pushSystem(group.id, `找不到 ${bot.name} 对应的 CLI 配置`);
          continue;
        }

        const fresh = group.memberIds.includes(bot.id);
        if (!fresh) continue;

        // 告诉界面：当前轮到谁，后面还排着谁
        this.emitState(group, { active: true, current: bot, queue, turn: turns + 1 });

        const target = {
          id: bot.id,
          cwd: group.cwd || bot.cwd,
          model: bot.model,
          permission: bot.permission,
          systemPrompt: bot.systemPrompt,
          sessionId: (group.sessions && group.sessions[bot.id]) || '',
        };
        const prompt = this.buildPrompt(group, bot, job, members);

        const r = await this.runner.run(target, agent, prompt, {
          key: `${group.id}:${bot.id}`,
          sender: { id: bot.id, name: bot.name, emoji: bot.emoji, color: bot.color, agentId: bot.agentId },
        });

        if (!r.ok) {
          this.pushSystem(group.id, `${bot.name} 启动失败：${r.error}`);
          continue;
        }

        const msg = await r.done;
        turns++;
        if (this.aborted.has(group.id)) break;

        const next = this.pickHandoff(msg, group);
        if (next) {
          // 去重：这个 Bot 已经排在队列里（比如用户一开始就 @ 了它），就不重复入队
          const alreadyQueued = queue.some((j) => j.botId === next);
          if (!alreadyQueued) queue.push({ botId: next, text: job.text, from: bot.id });
        }
      }
    } finally {
      this.busy.delete(group.id);
      this.aborted.delete(group.id);
      this.emitState(group, { active: false });
      this.onChange(group.id);
    }

    return { ok: true };
  }

  /**
   * 广播群聊进度，让界面知道「谁在跑、还有谁排队」
   * @param {object} group
   * @param {object} p {current: bot|null, queue: job[], turn: number}
   */
  emitState(group, p = {}) {
    const brief = (b) => (b ? { id: b.id, name: b.name, emoji: b.emoji, color: b.color } : null);
    const current = p.current ? brief(p.current) : null;
    const queued = (p.queue || [])
      .map((j) => brief(this.getBot(j.botId)))
      .filter(Boolean);
    this.emit('room:state', {
      key: group.id,
      active: p.active !== undefined ? !!p.active : !!current,
      current,
      queue: queued,
      turn: p.turn || 0,
      maxTurns: MAX_TURNS,
    });
  }

  pushSystem(gid, text) {
    const msg = {
      id: `sys_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      role: 'system',
      parts: [{ type: 'text', text }],
      status: 'done',
      createdAt: Date.now(),
    };
    this.store.appendMessage(gid, msg);
    this.emit('run:done', { key: gid, msg });
  }
}

module.exports = { Room, findMentions, textOf };
