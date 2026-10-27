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

const MAX_TURNS = 60;
// 同一个 Bot 连续两次说出几乎一样的话，判定为原地打转。
// 单轮超时已在 runner 里兜底，这里管的是「跑得动但没进展」。
const STALL_SIMILARITY = 0.92;
const STALL_MIN_CHARS = 20; // 太短的回复（如「同意」「收到」）不参与判定，避免误伤
// 决策板：群里定下来的事，后续所有成员都读它，避免反复推翻
const MAX_DECISIONS = 20;
const DECISION_MERGE_SIM = 0.85; // 新决策和旧的太像，就当是修订，替换而不是追加
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

/** 从 Bot 的回答里抽出「- 【决策】xxx」这样的行 */
function extractDecisions(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^[\s>*\-]*【决策】\s*(.+?)\s*$/);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * 4-gram Jaccard 相似度，用来识别「同一 Bot 连续两轮说的话几乎一样」。
 * 只关心是否原地打转，不需要精确的语义相似度。
 * 先把数字归一成 #：「第 2 轮」和「第 3 轮」本质是同一句话，
 * 否则真实死循环会因为轮次数字不同而漏判（实测相似度只有 0.84）。
 */
function similarity(a, b) {
  const norm = (s) => String(s || '').replace(/\d+/g, '#').replace(/\s+/g, ' ');
  const grams = (s) => {
    const t = norm(s);
    const set = new Set();
    for (let i = 0; i + 4 <= t.length; i++) set.add(t.slice(i, i + 4));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
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
    this.live = new Map(); // gid -> 当前轮次的可变状态（队列、插话），供中途介入用
  }

  isBusy(gid) {
    return this.busy.has(gid);
  }

  /**
   * 跑的时候用户又说了话：挂到当前这一轮，不打断正在跑的 Bot。
   * 消息已经存进会话了，所以下一个接手的 Bot 通过【用户的需求】那层天然能读到；
   * 这里再做两件事：① 把它作为「补充要求」显式塞进下一次 prompt；
   * ② 如果队列已经空了，补一个负责人接手，别让这条补充晾着没人管。
   */
  interject(group, text) {
    const live = this.live.get(group.id);
    if (!live) return { ok: false, error: '这个群正在跑上一轮' };
    live.notes.push(text);
    if (!live.queue.length) {
      const leader = group.leaderId || (group.memberIds || [])[0];
      if (leader) live.queue.push({ botId: leader, text, from: null });
    }
    this.emitState(group, { active: true, current: live.current, queue: live.queue, turn: live.turn });
    return { ok: true, queued: true };
  }

  stop(gid) {
    this.aborted.add(gid);
    for (const key of this.runner.running.keys()) {
      if (key.startsWith(`${gid}:`)) this.runner.stop(key);
    }
    this.busy.delete(gid);
    this.live.delete(gid);
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

    // 决策板优先级高于零散结论：已经定下来的事不该被后来的成员推翻
    const board = group.decisions || [];
    if (board.length) {
      chunks.push(
        `【已经定下的决策】\n${board.map((d) => `- ${d}`).join('\n')}\n`
          + '这些是前面已经拍板的，不要再推翻。如果确实需要改，先说明为什么必须改。'
      );
    }

    if (ctx.decisions.length) chunks.push(`【其他人已经得出的结论】\n${ctx.decisions.join('\n')}`);
    if (ctx.recent.length) chunks.push(`【最近的群聊记录】\n${ctx.recent.join('\n')}`);

    if (job.from) {
      const fromBot = this.getBot(job.from);
      chunks.push(`【交班】「${fromBot ? fromBot.name : '成员'}」把这件事交给了你，请接着往下做，不要重复它已经完成的步骤。`);
    }

    chunks.push(`【本轮任务】\n${job.text}`);
    chunks.push('如果这件事需要别的成员接手，在回答最后单独一行写 `@成员名` 交班；不需要就不要 @ 任何人。');
    chunks.push(
      '如果你做出了会影响后续的结论（定了方案、定了技术栈、定了范围、定了取舍），'
        + '在回答最后用单独一行写 `【决策】一句话说明`。没做出新决策就不用写，也不要把过程当决策写。'
    );

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

  /**
   * 把新决策并进决策板。
   * 同一个决策经常被后来的成员「补充一点」—— 比如「技术栈用 Vue 3」之后变成
   * 「技术栈用 Vue 3 + Pinia」。这种情况字符相似度只有 0.74，会漏判成两条互相矛盾的记录。
   * 所以除了相似度，还用「一个是另一个的前缀/子串且长度接近」来认定是修订。
   */
  mergeDecisions(group, list) {
    const board = group.decisions || (group.decisions = []);
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    for (const d of list || []) {
      const text = String(d || '').trim();
      if (!text) continue;
      const nt = norm(text);
      const idx = board.findIndex((x) => {
        if (similarity(x, text) >= DECISION_MERGE_SIM) return true;
        const nx = norm(x);
        if (!nx || !nt) return false;
        const [shorter, longer] = nx.length <= nt.length ? [nx, nt] : [nt, nx];
        return longer.includes(shorter) && shorter.length / longer.length >= 0.5;
      });
      if (idx >= 0) board[idx] = text;
      else board.push(text);
    }
    if (board.length > MAX_DECISIONS) board.splice(0, board.length - MAX_DECISIONS);
    return board;
  }

  /**
   * 并发的前提：这几个人各自有独立工作目录。
   * 共用目录时同时跑会互相覆盖文件，这种「快了但结果不可信」的加速没有意义。
   */
  canConcurrent(group, jobs) {
    const bots = (jobs || []).map((j) => this.getBot(j.botId)).filter(Boolean);
    if (bots.length < 2) return false;
    const dirs = bots.map((b) => group.cwd || b.cwd || '');
    if (dirs.some((d) => !d)) return false; // 没设目录会落到 home，同样会互相干扰
    return new Set(dirs).size === dirs.length;
  }

  /** 跑一个 job，返回 {bot, msg}；失败返回 null（错误已经推进会话里了） */
  async runJob(group, job, members, live) {
    const bot = this.getBot(job.botId);
    if (!bot) return null;
    const agent = getAgent(bot.agentId);
    if (!agent) {
      this.pushSystem(group.id, `找不到 ${bot.name} 对应的 CLI 配置`);
      return null;
    }
    if (!group.memberIds.includes(bot.id)) return null;

    // 用户在这期间补充的要求，显式塞进本轮任务（光靠上下文层容易被当成背景信息忽略）
    let jobText = job.text;
    if (live.notes.length) {
      jobText = `${job.text}\n\n【执行中用户补充】\n${live.notes.join('\n')}\n请先满足这些补充，再继续原来的任务。`;
      live.notes = [];
    }

    const target = {
      id: bot.id,
      cwd: group.cwd || bot.cwd,
      model: bot.model,
      permission: bot.permission,
      systemPrompt: bot.systemPrompt,
      sessionId: (group.sessions && group.sessions[bot.id]) || '',
    };
    const prompt = this.buildPrompt(group, bot, { ...job, text: jobText }, members);

    const r = await this.runner.run(target, agent, prompt, {
      key: `${group.id}:${bot.id}`,
      sender: { id: bot.id, name: bot.name, emoji: bot.emoji, color: bot.color, agentId: bot.agentId },
    });
    if (!r.ok) {
      this.pushSystem(group.id, `${bot.name} 启动失败：${r.error}`);
      return null;
    }
    const msg = await r.done;
    return { bot, msg };
  }

  async send(group, userText, userMsg) {
    const members = this.members(group);
    if (!members.length) {
      this.pushSystem(group.id, '这个群还没有成员，先在群设置里加几个 Bot。');
      return { ok: false, error: '群聊没有成员' };
    }
    if (this.busy.has(group.id)) return this.interject(group, userText);

    this.aborted.delete(group.id);
    this.busy.add(group.id);

    const mentioned = findMentions(userText, members);
    const leader = group.leaderId || members[0].id;
    const targets = mentioned.length ? mentioned : [leader];

    const queue = targets.map((id) => ({ botId: id, text: userText, from: null }));
    let turns = 0;
    const lastText = new Map(); // botId -> 上一轮的正文，用于识别原地打转
    const live = { queue, notes: [], current: null, currentList: [], turn: 0 };
    this.live.set(group.id, live);
    this.emitState(group, { active: true, queue, turn: 0 });

    try {
      /* ---------------- 第一批：只有「用户一次 @ 了多个 Bot」才可能并发 ---------------- */
      // 交班链本身有依赖（后一个要读前一个的结论），所以永远串行；
      // 能并发的只有开头这几个「互不依赖、并列被点名」的成员。
      if (group.concurrent && queue.length > 1) {
        if (this.canConcurrent(group, queue)) {
          const batch = queue.splice(0, queue.length);
          const bots = batch.map((j) => this.getBot(j.botId)).filter(Boolean);
          live.currentList = bots;
          live.turn = 1;
          this.emitState(group, { active: true, currentList: bots, queue: [], turn: 1 });

          const results = await Promise.all(batch.map((job) => this.runJob(group, job, members, live)));
          live.currentList = [];

          const handoffs = [];
          for (const res of results) {
            if (!res || this.aborted.has(group.id)) continue;
            turns++;
            const body = textOf(res.msg);
            lastText.set(res.bot.id, body);
            const decided = extractDecisions(body);
            if (decided.length) this.mergeDecisions(group, decided);
            const next = this.pickHandoff(res.msg, group);
            if (next && !queue.some((j) => j.botId === next) && !handoffs.includes(next)) handoffs.push(next);
          }
          // 并发跑完的几个人谁要交班，按顺序排进队列，后面照常串行接力
          for (const id of handoffs) queue.push({ botId: id, text: userText, from: null });
        } else {
          this.pushSystem(
            group.id,
            '并发已开启，但这几个成员共用同一个工作目录，本轮仍按串行执行 —— 同时改同一目录会互相覆盖。'
              + '给每个 Bot 设置各自独立的目录后才会真正并行。'
          );
        }
      }

      while (queue.length && turns < MAX_TURNS && !this.aborted.has(group.id)) {
        const job = queue.shift();
        const bot = this.getBot(job.botId);
        if (!bot) continue;
        live.current = bot;
        live.turn = turns + 1;

        // 告诉界面：当前轮到谁，后面还排着谁
        this.emitState(group, { active: true, current: bot, queue, turn: turns + 1 });

        const res = await this.runJob(group, job, members, live);
        if (!res) continue;
        turns++;
        if (this.aborted.has(group.id)) break;

        // 原地打转：同一个 Bot 连续两次说的几乎一样，再排下去也只是烧 token
        const body = textOf(res.msg);
        const prev = lastText.get(bot.id);
        if (prev && body.length >= STALL_MIN_CHARS && similarity(prev, body) >= STALL_SIMILARITY) {
          this.pushSystem(
            group.id,
            `${bot.name} 这轮和上一轮说的几乎一样，判定为原地打转，已停下。换个更具体的要求，或 @ 另一个成员打破僵局。`
          );
          break;
        }
        lastText.set(bot.id, body);

        const decided = extractDecisions(body);
        if (decided.length) this.mergeDecisions(group, decided);

        const next = this.pickHandoff(res.msg, group);
        if (next) {
          // 去重：这个 Bot 已经排在队列里（比如用户一开始就 @ 了它），就不重复入队
          const alreadyQueued = queue.some((j) => j.botId === next);
          if (!alreadyQueued) queue.push({ botId: next, text: job.text, from: bot.id });
        }
      }
    } finally {
      this.busy.delete(group.id);
      this.aborted.delete(group.id);
      this.live.delete(group.id);
      this.emitState(group, { active: false });
      this.onChange(group.id);
    }

    return { ok: true };
  }

  /**
   * 广播群聊进度，让界面知道「谁在跑、还有谁排队」
   * @param {object} group
   * @param {object} p {current: bot|null, currentList: bot[], queue: job[], turn: number}
   */
  emitState(group, p = {}) {
    const brief = (b) => (b ? { id: b.id, name: b.name, emoji: b.emoji, color: b.color } : null);
    const list = (p.currentList || (p.current ? [p.current] : [])).map(brief).filter(Boolean);
    const queued = (p.queue || [])
      .map((j) => brief(this.getBot(j.botId)))
      .filter(Boolean);
    this.emit('room:state', {
      key: group.id,
      active: p.active !== undefined ? !!p.active : list.length > 0,
      current: list[0] || null,
      currentList: list,
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

module.exports = { Room, findMentions, textOf, similarity };
