'use strict';
/**
 * 群聊编排：多个 Bot 同屏协作。
 * 规则：
 *  - 用户 @谁 谁回答，按 @ 的顺序串行；没 @ 就交给「负责人」。
 *  - Bot 回答里 @其他成员 = 交班，接手的 Bot 会看到前面的群聊记录继续做。
 *  - 一轮最多 MAX_TURNS 跳，防止两个 Bot 互相甩锅无限循环。
 */
const { getAgent } = require('./agents');

const MAX_TURNS = 4;
const CTX_MESSAGES = 14;
const CTX_CHARS = 2400;

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
    this.emit('room:state', { key: gid, active: false });
    return true;
  }

  members(group) {
    return (group.memberIds || []).map((id) => this.getBot(id)).filter(Boolean);
  }

  /** 群聊里给某个 Bot 的历史上下文（别人说的话） */
  contextFor(group, bot) {
    const all = this.store.getMessages(group.id) || [];
    const lines = [];
    let chars = 0;
    for (let i = all.length - 1; i >= 0 && lines.length < CTX_MESSAGES; i--) {
      const m = all[i];
      if (m.role === 'assistant' && m.sender && m.sender.id === bot.id) continue;
      const body = textOf(m);
      if (!body) continue;
      const who = m.role === 'user' ? '用户' : (m.sender && m.sender.name) || '成员';
      const line = `${who}: ${body.length > 400 ? body.slice(0, 400) + '…' : body}`;
      if (chars + line.length > CTX_CHARS) break;
      chars += line.length;
      lines.unshift(line);
    }
    return lines;
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
    if (ctx.length) chunks.push(`【最近的群聊记录】\n${ctx.join('\n')}`);

    if (job.from) {
      const fromBot = this.getBot(job.from);
      chunks.push(`【交班】「${fromBot ? fromBot.name : '成员'}」把这件事交给了你，请接着往下做，不要重复它已经完成的步骤。`);
    }

    chunks.push(`【本轮任务】\n${job.text}`);
    chunks.push('如果这件事需要别的成员接手，在回答最后单独一行写 `@成员名` 交班；不需要就不要 @ 任何人。');

    return chunks.filter(Boolean).join('\n\n');
  }

  /** 从 Bot 的回答里挑下一个接手的人 */
  pickHandoff(msg, group, spoke) {
    const body = textOf(msg);
    if (!body) return null;
    const members = this.members(group);
    const mentioned = findMentions(body, members);
    for (const id of mentioned) {
      if (!spoke.has(id)) return id;
    }
    return null;
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
    this.emit('room:state', { key: group.id, active: true });

    const mentioned = findMentions(userText, members);
    const leader = group.leaderId || members[0].id;
    const targets = mentioned.length ? mentioned : [leader];

    const queue = targets.map((id) => ({ botId: id, text: userText, from: null }));
    const spoke = new Set();
    let turns = 0;

    try {
      while (queue.length && turns < MAX_TURNS && !this.aborted.has(group.id)) {
        const job = queue.shift();
        const bot = this.getBot(job.botId);
        if (!bot) continue;
        // 一轮里每个 Bot 只说一次：用户 @ 了它、前面又有人交班给它，也不重复跑
        if (spoke.has(bot.id)) continue;
        const agent = getAgent(bot.agentId);
        if (!agent) {
          this.pushSystem(group.id, `找不到 ${bot.name} 对应的 CLI 配置`);
          continue;
        }

        const fresh = group.memberIds.includes(bot.id);
        if (!fresh) continue;

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
        spoke.add(bot.id);
        turns++;
        if (this.aborted.has(group.id)) break;

        const next = this.pickHandoff(msg, group, spoke);
        if (next) queue.push({ botId: next, text: job.text, from: bot.id });
      }
    } finally {
      this.busy.delete(group.id);
      this.aborted.delete(group.id);
      this.emit('room:state', { key: group.id, active: false });
      this.onChange(group.id);
    }

    return { ok: true };
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
