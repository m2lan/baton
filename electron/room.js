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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getAgent } = require('./agents');
const { buildEnv } = require('./runner');
const { stripAnsi } = require('./parsers');
const { Task } = require('./runlog');
const git = require('./git');
const { L } = require('./lang');

const isWin = process.platform === 'win32';

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
// 验收命令：交班链自然结束后跑一次，不过就交回去修
const VERIFY_TIMEOUT_MS = Math.max(30 * 1000, Number(process.env.BATON_VERIFY_TIMEOUT_MS) || 5 * 60 * 1000);
const VERIFY_MAX_DEFAULT = 3;
const VERIFY_OUTPUT_CHARS = 3000;
const HANDOFF_FILES = 15; // 交班时最多列出几个上一棒改过的文件

/** 「M src/a.js」这种一行一个的改动清单 */
function formatChanges(changes, max) {
  const list = (changes || []).slice(0, max || changes.length).map((c) => `${c.status} ${c.path}`);
  if (changes && max && changes.length > max) list.push(`…还有 ${changes.length - max} 个`);
  return list.join('\n');
}

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
  // 名字后面紧跟字母/数字/下划线，说明这是另一个更长的单词（@A 命中 @Alice）。
  // 只认 ASCII：中文常写成「@张三请看一下」，中间没有空格，不能算边界；
  // 代价是「@张三丰」也会命中成员「张三」，这个取舍偏向日常写法。
  const isNameChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

  const ordered = [...members].sort((a, b) => (b.name || '').length - (a.name || '').length);
  for (const m of ordered) {
    const name = m.name || '';
    if (!name) continue;
    let from = 0;
    for (;;) {
      const idx = src.indexOf('@' + name, from);
      if (idx === -1) break;
      const end = idx + 1 + name.length;
      if (isNameChar(src[end])) {
        from = end;
        continue;
      }
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
    this.busy = new Set();
    this.live = new Map(); // gid -> 当前轮次的可变状态（队列、插话），供中途介入用
  }

  isBusy(gid) {
    return this.busy.has(gid);
  }

  /**
   * 这一轮还是当前这一轮吗？
   * stop 之后 live 被摘掉、或者用户马上又发了一句顶掉它，旧循环都必须自己收尾。
   * 不能用全局 aborted 标记：新一轮发起时会清它，旧循环就会误以为还能继续跑。
   */
  isCurrent(gid, live) {
    return this.live.get(gid) === live;
  }

  /**
   * 跑的时候用户又说了话：挂到当前这一轮，不打断正在跑的 Bot。
   * 消息已经存进会话了，所以下一个接手的 Bot 通过【用户的需求】那层天然能读到；
   * 这里再做两件事：① 把它作为「补充要求」显式塞进下一次 prompt；
   * ② 如果队列已经空了，补一个负责人接手，别让这条补充晾着没人管。
   */
  interject(group, text) {
    const live = this.live.get(group.id);
    if (!live) return { ok: false, error: L('这个群正在跑上一轮', 'This room is still running the previous turn') };
    if (live.queue.length) {
      // 后面还排着人：挂到下一棒的「执行中补充」里，由 runJob 消费
      live.notes.push(text);
    } else {
      // 队列空了：这句话得有人接，排给负责人。不要再同时写进 notes，
      // 否则下一棒的任务文本和补充里各有一份，模型会看到两遍。
      const leader = group.leaderId || (group.memberIds || [])[0];
      if (leader) live.queue.push({ botId: leader, text, from: null });
    }
    this.emitState(group, { active: true, current: live.current, queue: live.queue, turn: live.turn });
    return { ok: true, queued: true };
  }

  stop(gid) {
    const live = this.live.get(gid);
    if (live && live.killVerify) live.killVerify();
    for (const key of this.runner.running.keys()) {
      if (key.startsWith(`${gid}:`)) this.runner.stop(key);
    }
    // 先摘掉 live 再清 busy：在跑的循环看到自己已不是当前这一轮，会自然收尾；
    // 即便用户紧接着又发了一句，新旧两轮也不会共用 busy / live。
    this.live.delete(gid);
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
  contextFor(group, bot, opts = {}) {
    const all = this.store.getMessages(group.id) || [];
    // fresh：这次是全新会话（比如在 worktree 里跑），它不记得自己说过什么，自己的话也得带上
    const isMine = (m) => !opts.fresh && m.role === 'assistant' && m.sender && m.sender.id === bot.id;
    const who = (m) => (m.role === 'user' ? '用户' : (m.sender && m.sender.name) || '成员');
    const clip = (s) => (s.length > CTX_MSG_CHARS ? s.slice(0, CTX_MSG_CHARS) + '…' : s);

    /* ---- ① 用户需求锚点 ---- */
    // 从最新往回取：群聊跑久了，用户最近说的话才是这一轮真正要做的。
    // 旧的写法从最早往后取、一超预算就 break，聊过几轮之后最新的要求反而被丢掉，
    // Bot 会一直围着最早那句需求打转。
    const asks = [];
    let budget = CTX_BUDGET_ASK;
    for (let i = all.length - 1; i >= 0 && budget > 0; i--) {
      const m = all[i];
      if (m.role !== 'user') continue;
      const body = textOf(m);
      if (!body) continue;
      let line = `用户: ${clip(body)}`;
      if (line.length > budget) {
        // 最新一条自己也放不下：截断保留开头（那句通常就是要求本身），更早的不再挤进来
        if (asks.length || budget < 200) break;
        line = line.slice(0, Math.max(0, budget - 1)) + '…';
      }
      budget -= line.length;
      asks.unshift(line); // unshift 保持时间顺序，模型读起来是「先早后晚」
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

    const ctx = this.contextFor(group, bot, { fresh: !!job.worktree });
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
      if (job.fromChanges && job.fromChanges.length) {
        chunks.push(`【上一棒改动的文件】\n${formatChanges(job.fromChanges, HANDOFF_FILES)}\n需要核对时直接看这些文件，不要只凭它的描述。`);
      }
    }
    if (job.worktree) {
      chunks.push('【隔离目录】你这次在一个独立的 git worktree 里工作，和其他成员并行。只改和你任务相关的文件；跑完后改动会自动合回主目录。');
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
   * 决定这一批能不能并发、怎么并发：
   *   - 'dirs'：各成员本来就有独立目录，直接并行
   *   - 'worktree'：大家共用同一个 git 仓库 → 每人一个临时 worktree，跑完把改动合回来
   *   - null：不能并发（没设目录会落到 home；共用目录又不是 git 仓库，同时改会互相覆盖）
   */
  async planConcurrent(group, jobs) {
    const bots = (jobs || []).map((j) => this.getBot(j.botId)).filter(Boolean);
    if (bots.length < 2) return { mode: null };
    const dirs = bots.map((b) => group.cwd || b.cwd || '');
    if (dirs.some((d) => !d)) return { mode: null, reason: 'noDir' };
    if (new Set(dirs).size === dirs.length) return { mode: 'dirs' };
    if (group.worktree === false) return { mode: null, reason: 'shared' };
    const roots = await Promise.all(dirs.map((d) => git.repoRoot(d)));
    if (roots.some((r) => !r) || new Set(roots).size !== 1) return { mode: null, reason: 'shared' };
    return { mode: 'worktree', root: roots[0], dirs };
  }

  /** 改动清单补进已经落盘的消息里（快照要等 CLI 退出后才算得出来） */
  patchMessageMeta(gid, msg, meta) {
    msg.meta = { ...(msg.meta || {}), ...meta };
    const list = this.store.getMessages(gid) || [];
    const i = list.findIndex((m) => m.id === msg.id);
    if (i >= 0) {
      list[i] = msg;
      this.store.saveMessages(gid, list);
    }
    this.emit('msg:update', { key: gid, msg });
  }

  /**
   * 跑一个 job，返回 {bot, msg, hop, after}；失败返回 null（错误已经推进会话里了）
   * job: {botId, text, from, fromChanges?, worktree?: {root, dir, cwd, base}}
   */
  async runJob(group, job, members, live) {
    const bot = this.getBot(job.botId);
    if (!bot) return null;
    const agent = getAgent(bot.agentId);
    if (!agent) {
      this.pushSystem(group.id, L(`找不到 ${bot.name} 对应的 CLI 配置`, `No CLI config found for ${bot.name}`));
      return null;
    }
    if (!group.memberIds.includes(bot.id)) return null;
    // 已经 stop / 被新一轮顶掉：排队中的任务不要再真的拉起 CLI
    if (!this.isCurrent(group.id, live)) return null;

    // 用户在这期间补充的要求，显式塞进本轮任务（光靠上下文层容易被当成背景信息忽略）
    let jobText = job.text;
    if (live.notes.length) {
      jobText = `${job.text}\n\n【执行中用户补充】\n${live.notes.join('\n')}\n请先满足这些补充，再继续原来的任务。`;
      live.notes = [];
    }

    const wt = job.worktree;
    const cwd = wt ? wt.cwd : group.cwd || bot.cwd;
    const target = {
      id: bot.id,
      cwd,
      model: bot.model,
      permission: bot.permission,
      systemPrompt: bot.systemPrompt,
      env: bot.env,
      // worktree 换了目录，原来的 session 在这里 resume 不了，开新会话
      sessionId: wt ? '' : (group.sessions && group.sessions[bot.id]) || '',
    };
    const prompt = this.buildPrompt(group, bot, { ...job, text: jobText }, members);

    // 跑之前给工作区拍个快照，跑完再拍一次，就知道这一棒改了什么
    const root = wt ? wt.dir : await git.repoRoot(cwd);
    const before = wt ? wt.base : await git.snapshot(root);

    const startedAt = Date.now();
    const from = job.from ? (this.getBot(job.from) || {}).name || '' : job.verify ? '验收' : '用户';
    const who = { botId: bot.id, botName: bot.name, emoji: bot.emoji, color: bot.color, agentId: bot.agentId };
    live.task.setRunning(bot.id, { kind: 'bot', ...who, from, startedAt, worktree: !!wt, batch: job.batch || 0, prompt });
    const r = await this.runner.run(target, agent, prompt, {
      key: `${group.id}:${bot.id}`,
      sender: { id: bot.id, name: bot.name, emoji: bot.emoji, color: bot.color, agentId: bot.agentId },
      ephemeral: !!wt,
    });
    if (!r.ok) {
      live.task.clearRunning(bot.id);
      live.task.emitLive();
      this.pushSystem(group.id, L(`${bot.name} 启动失败：${r.error}`, `${bot.name} failed to start: ${r.error}`));
      return null;
    }
    const msg = await r.done;

    const after = before ? await git.snapshot(root) : null;
    const changes = after ? await git.changedFiles(root, before, after) : [];
    if (changes.length) this.patchMessageMeta(group.id, msg, { changes: changes.slice(0, 80) });

    const meta = msg.meta || {};
    live.task.clearRunning(bot.id);
    const hop = live.task.hop({
      ...who,
      from,
      batch: job.batch || 0,
      startedAt,
      duration: msg.duration || Date.now() - startedAt,
      status: msg.status,
      endReason: meta.timeout ? 'timeout' : meta.stopped ? 'stopped' : msg.status === 'error' ? 'error' : '',
      usage: meta.tokens || null,
      cost: typeof meta.cost === 'number' ? meta.cost : null,
      model: meta.model || bot.model || '',
      prompt,
      msgId: msg.id,
      cwd,
      worktree: !!wt,
      changes,
    });
    this.emitState(group, live.lastState || {}, live);
    return { bot, msg, hop, after, changes };
  }

  /**
   * 共用仓库的并发：每人一个 detached worktree，各跑各的，跑完按顺序把改动应用回主目录。
   * 合不回去的（和前面的人改了同一处）存成 .patch 文件，告诉用户在哪，不硬合。
   */
  async runWorktreeBatch(group, batch, members, live, plan) {
    const root = plan.root;
    const base = await git.snapshot(root);
    if (!base) return null;
    const stamp = Date.now().toString(36);
    const wtRoot = path.join(this.store.root(), 'worktrees');
    const prepared = [];
    for (let i = 0; i < batch.length; i++) {
      const job = batch[i];
      const dir = path.join(wtRoot, `${group.id}-${job.botId}-${stamp}`);
      const r = await git.addWorktree(root, dir, base);
      if (!r.ok) {
        for (const p of prepared) await git.removeWorktree(root, p.worktree.dir);
        this.pushSystem(group.id, L(`创建 worktree 失败，本轮改为串行：${r.error}`, `Could not create a worktree, running serially this turn: ${r.error}`));
        return null;
      }
      const cwd = path.join(dir, path.relative(root, plan.dirs[i]));
      prepared.push({ ...job, worktree: { root, dir, cwd, base } });
    }

    const results = await Promise.all(prepared.map((job) => this.runJob(group, job, members, live)));

    const merged = [];
    const failed = [];
    for (let i = 0; i < prepared.length; i++) {
      const res = results[i];
      const wt = prepared[i].worktree;
      if (res && res.after && res.after !== base && this.isCurrent(group.id, live)) {
        const patch = await git.diffPatch(root, base, res.after);
        const ap = await git.applyPatch(root, patch);
        if (ap.ok) merged.push(res.bot.name);
        else {
          const dir = path.join(this.store.root(), 'patches');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${group.id}-${res.bot.name.replace(/[\\/:*?"<>|\s]/g, '_')}-${stamp}.patch`);
          fs.writeFileSync(file, patch || '', 'utf8');
          failed.push({ name: res.bot.name, file, error: ap.error });
        }
      }
      await git.removeWorktree(root, wt.dir);
    }
    if (merged.length) {
      this.pushSystem(group.id, L(
        `已把 ${merged.join('、')} 在独立 worktree 里的改动合回主目录（未提交，可以用 git status 查看）。`,
        `Applied the worktree changes of ${merged.join(', ')} back to the main directory (uncommitted — see git status).`
      ));
    }
    for (const f of failed) {
      this.pushSystem(
        group.id,
        L(
          `${f.name} 的改动和前面成员的改动冲突，没有合回主目录。补丁存在：${f.file}\n可以手动 \`git apply --3way\` 处理。`,
          `${f.name}'s changes conflict with an earlier member's and were not applied. Patch saved to: ${f.file}\nApply it by hand with \`git apply --3way\`.`
        )
          + (f.error ? `\n${f.error}` : '')
      );
    }
    return results;
  }

  /** 跑验收命令：shell 执行，返回退出码和输出末尾 */
  runVerify(cmd, cwd, live) {
    return new Promise((resolve) => {
      const started = Date.now();
      let out = '';
      let timedOut = false;
      let settled = false;
      let child;
      let timer = null;
      let killTimer = null;
      let forceTimer = null;

      const output = () => stripAnsi(out).trim().slice(-VERIFY_OUTPUT_CHARS);
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(forceTimer);
        if (live.killVerify === kill) live.killVerify = null;
        resolve(r);
      };

      try {
        // detached：自成进程组，超时 / 停止时能把 npm test 拉起的子进程一起收掉
        child = spawn(cmd, { cwd, env: buildEnv(), shell: true, windowsHide: true, detached: !isWin });
      } catch (e) {
        resolve({ code: -1, output: e.message, duration: 0 });
        return;
      }

      /**
       * 先 SIGTERM，3 秒后升级 SIGKILL。
       * 10 秒还没 close（孙进程占着 stdio 时很常见）就直接结算，
       * 否则这个 await 会永远不返回，整条交班链和 busy 一起卡死。
       */
      const kill = () => {
        if (isWin) {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          } catch {}
          return;
        }
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          try {
            child.kill('SIGTERM');
          } catch {}
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {}
          }
        }, 3000);
        if (killTimer.unref) killTimer.unref();
        forceTimer = setTimeout(() => done({ code: -1, timedOut, output: output(), duration: Date.now() - started }), 10000);
        if (forceTimer.unref) forceTimer.unref();
      };
      live.killVerify = kill;
      const push = (c) => {
        out += c.toString('utf8');
        if (out.length > VERIFY_OUTPUT_CHARS * 8) out = out.slice(-VERIFY_OUTPUT_CHARS * 4);
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, VERIFY_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      child.on('error', (e) => {
        out += `\n${e.message}`;
      });
      child.on('close', (code) => {
        done({
          code: timedOut ? -1 : code == null ? -1 : code,
          timedOut,
          output: output(),
          duration: Date.now() - started,
        });
      });
    });
  }

  /**
   * 交班链自然结束后的验收。
   * @returns {'passed'|'retry'|'failed'|'skipped'} retry 时已经把修复任务排进 queue
   */
  async verify(group, live, queue) {
    const cmd = String(group.verifyCmd || '').trim();
    if (!cmd) return 'skipped';
    const leaderId = group.leaderId || (group.memberIds || [])[0];
    const leader = this.getBot(leaderId);
    const cwd = group.cwd || (leader && leader.cwd) || '';
    if (!cwd || !fs.existsSync(cwd)) {
      this.pushSystem(group.id, L('设置了验收命令，但群和负责人都没有工作目录，跳过验收。', 'A verify command is set, but neither the room nor the lead has a working directory — skipping it.'));
      return 'skipped';
    }
    const max = Math.max(1, Number(group.verifyMax) || VERIFY_MAX_DEFAULT);
    live.verifyAttempts = (live.verifyAttempts || 0) + 1;
    this.emitState(group, { active: true, verifying: true, queue: [], turn: live.turn }, live);

    live.task.setRunning('verify', { kind: 'verify', botName: '验收', cmd, attempt: live.verifyAttempts });
    const r = await this.runVerify(cmd, cwd, live);
    live.task.clearRunning('verify');
    if (!this.isCurrent(group.id, live)) return 'failed';
    const passed = r.code === 0;
    live.task.hop({
      kind: 'verify',
      botName: '验收',
      startedAt: Date.now() - r.duration,
      duration: r.duration,
      status: passed ? 'done' : 'error',
      endReason: passed ? 'passed' : r.timedOut ? 'timeout' : 'failed',
      cmd,
      exitCode: r.code,
      output: r.output,
      attempt: live.verifyAttempts,
    });
    const secs = (r.duration / 1000).toFixed(1);
    if (passed) {
      this.pushSystem(group.id, L(`✓ 验收通过：\`${cmd}\`（${secs}s）`, `✓ Verify passed: \`${cmd}\` (${secs}s)`));
      return 'passed';
    }
    const mins = Math.round(VERIFY_TIMEOUT_MS / 60000);
    // why 也会写进交给模型的修复任务里，那部分保持中文
    const why = r.timedOut ? `超过 ${mins} 分钟没结束` : `退出码 ${r.code}`;
    const whyUi = r.timedOut ? L(why, `did not finish within ${mins} min`) : L(why, `exit code ${r.code}`);
    const tail = r.output ? `\n\`\`\`\n${r.output}\n\`\`\`` : '';
    const ownerId = (group.verifyOwner && group.memberIds.includes(group.verifyOwner) && group.verifyOwner) || leaderId;
    const owner = this.getBot(ownerId);
    if (live.verifyAttempts >= max || !owner) {
      this.pushSystem(group.id, L(
        `✗ 验收未通过（${live.verifyAttempts}/${max}）：\`${cmd}\` ${whyUi}，已达重试上限，停下等你处理。${tail}`,
        `✗ Verify failed (${live.verifyAttempts}/${max}): \`${cmd}\` ${whyUi}. Retry limit reached — over to you.${tail}`
      ));
      return 'failed';
    }
    this.pushSystem(group.id, L(
      `✗ 验收未通过（${live.verifyAttempts}/${max}）：\`${cmd}\` ${whyUi}，交回 ${owner.name} 修复。${tail}`,
      `✗ Verify failed (${live.verifyAttempts}/${max}): \`${cmd}\` ${whyUi}. Handed back to ${owner.name} to fix.${tail}`
    ));
    queue.push({
      botId: owner.id,
      from: null,
      verify: true,
      text:
        `【验收未通过】验收命令 \`${cmd}\` ${why}。输出末尾：${tail}\n`
        + '请找到原因并修复。需要别人配合可以 @ 对方；修好后不用 @ 任何人，Baton 会自动重新验收。',
    });
    return 'retry';
  }

  async send(group, userText, userMsg) {
    const members = this.members(group);
    if (!members.length) {
      this.pushSystem(group.id, L('这个群还没有成员，先在群设置里加几个 Bot。', 'This room has no members yet — add some Bots in room settings.'));
      return { ok: false, error: L('群聊没有成员', 'The room has no members') };
    }
    if (this.busy.has(group.id)) return this.interject(group, userText);

    this.busy.add(group.id);

    const mentioned = findMentions(userText, members);
    const leader = group.leaderId || members[0].id;
    const targets = mentioned.length ? mentioned : [leader];

    const queue = targets.map((id) => ({ botId: id, text: userText, from: null }));
    let turns = 0;
    let endReason = 'done';
    const lastText = new Map(); // botId -> 上一轮的正文，用于识别原地打转
    const task = new Task({ key: group.id, kind: 'group', title: group.name, userText });
    const live = { queue, notes: [], current: null, currentList: [], turn: 0, task };
    this.live.set(group.id, live);
    // 这一轮的身份（见 isCurrent）：被 stop 或被新一轮顶掉后，旧循环靠它收尾
    const isCurrent = () => this.isCurrent(group.id, live);
    this.emitState(group, { active: true, queue, turn: 0 }, live);

    // 一个 Bot 跑完之后的共同处理：收集决策、找下一个接手的人
    const settle = (res) => {
      const body = textOf(res.msg);
      const decided = extractDecisions(body);
      if (decided.length) this.mergeDecisions(group, decided);
      return { body, next: this.pickHandoff(res.msg, group) };
    };

    try {
      /* ---------------- 第一批：只有「用户一次 @ 了多个 Bot」才可能并发 ---------------- */
      // 交班链本身有依赖（后一个要读前一个的结论），所以永远串行；
      // 能并发的只有开头这几个「互不依赖、并列被点名」的成员。
      if (group.concurrent && queue.length > 1) {
        const plan = await this.planConcurrent(group, queue);
        if (plan.mode) {
          const batch = queue.splice(0, queue.length);
          for (const j of batch) j.batch = 1; // 同一批并行的成员，接力图里画在同一列
          const bots = batch.map((j) => this.getBot(j.botId)).filter(Boolean);
          live.currentList = bots;
          live.turn = 1;
          this.emitState(group, { active: true, currentList: bots, queue: [], turn: 1 }, live);

          let results = null;
          if (plan.mode === 'worktree') results = await this.runWorktreeBatch(group, batch, members, live, plan);
          if (!results && plan.mode === 'worktree') {
            queue.push(...batch); // worktree 没建成，退回串行
          } else {
            if (!results) results = await Promise.all(batch.map((job) => this.runJob(group, job, members, live)));
            live.currentList = [];

            const handoffs = [];
            for (const res of results) {
              if (!res || !isCurrent()) continue;
              turns++;
              const { body, next } = settle(res);
              lastText.set(res.bot.id, body);
              if (next) {
                res.hop.endReason = 'handoff';
                res.hop.to = (this.getBot(next) || {}).name || '';
              } else if (!res.hop.endReason) res.hop.endReason = 'done';
              if (next && !queue.some((j) => j.botId === next) && !handoffs.some((h) => h.botId === next)) {
                handoffs.push({ botId: next, from: res.bot.id, changes: res.changes });
              }
            }
            // 并发跑完的几个人谁要交班，按顺序排进队列，后面照常串行接力
            for (const h of handoffs) queue.push({ botId: h.botId, text: userText, from: h.from, fromChanges: h.changes });
          }
        } else {
          this.pushSystem(
            group.id,
            plan.reason === 'noDir'
              ? L('并发已开启，但有成员没设置工作目录，本轮仍按串行执行。', 'Parallel runs are on, but a member has no working directory — running serially this turn.')
              : L(
                '并发已开启，但这几个成员共用同一个目录且不是 git 仓库，本轮仍按串行执行 —— 同时改同一目录会互相覆盖。'
                  + '给每个 Bot 设置各自的目录，或把目录初始化成 git 仓库（会自动用 worktree 隔离），就能真正并行。',
                'Parallel runs are on, but these members share a directory that is not a git repo — running serially, since editing one folder at once would overwrite each other. '
                  + 'Give each Bot its own directory, or make the folder a git repo (worktrees are used automatically) to really run in parallel.'
              )
          );
        }
      }

      for (;;) {
        while (queue.length && turns < MAX_TURNS && isCurrent()) {
          const job = queue.shift();
          const bot = this.getBot(job.botId);
          if (!bot) continue;
          live.current = bot;
          live.turn = turns + 1;

          // 告诉界面：当前轮到谁，后面还排着谁
          this.emitState(group, { active: true, current: bot, queue, turn: turns + 1 }, live);

          const res = await this.runJob(group, job, members, live);
          if (!res) continue;
          turns++;
          if (!isCurrent()) {
            endReason = 'stopped';
            break;
          }

          // 原地打转：同一个 Bot 连续两次说的几乎一样，再排下去也只是烧 token
          const body = textOf(res.msg);
          const prev = lastText.get(bot.id);
          if (prev && body.length >= STALL_MIN_CHARS && similarity(prev, body) >= STALL_SIMILARITY) {
            res.hop.endReason = 'stall';
            endReason = 'stall';
            this.pushSystem(
              group.id,
              L(
                `${bot.name} 这轮和上一轮说的几乎一样，判定为原地打转，已停下。换个更具体的要求，或 @ 另一个成员打破僵局。`,
                `${bot.name} said almost the same thing as last turn — treated as stalled and stopped. Give a more specific ask, or @ another member to break the loop.`
              )
            );
            queue.length = 0;
            break;
          }
          lastText.set(bot.id, body);

          const { next } = settle(res);
          if (next) {
            res.hop.endReason = 'handoff';
            res.hop.to = (this.getBot(next) || {}).name || '';
            // 去重：这个 Bot 已经排在队列里（比如用户一开始就 @ 了它），就不重复入队
            const alreadyQueued = queue.some((j) => j.botId === next);
            if (!alreadyQueued) queue.push({ botId: next, text: job.text, from: bot.id, fromChanges: res.changes });
          } else if (!res.hop.endReason) res.hop.endReason = 'done';
        }

        if (!isCurrent()) {
          endReason = 'stopped';
          break;
        }
        if (endReason === 'stall') break;
        if (queue.length) {
          endReason = 'maxTurns';
          this.pushSystem(group.id, L(
            `已经接力了 ${MAX_TURNS} 跳，先停在这里。看一下进展，需要的话再发一句让它们继续。`,
            `Reached ${MAX_TURNS} hops — pausing here. Check the progress and send another message to continue.`
          ));
          break;
        }
        if (!turns) break; // 一个都没跑起来（比如 CLI 启动失败），验收没有意义
        // 交班链自然结束：有验收命令就验收，不过就交回去修，修完再验
        const v = await this.verify(group, live, queue);
        if (v === 'retry' && isCurrent()) continue;
        if (!isCurrent()) endReason = 'stopped';
        else if (v === 'passed') endReason = 'verifyPassed';
        else if (v === 'failed') endReason = 'verifyFailed';
        break;
      }
    } finally {
      task.finish(endReason);
      // 只有自己还是当前这一轮，才清 busy / live / 界面状态。
      // 否则会把「stop 之后马上又发的那一轮」一起清掉：界面显示空闲、实际还在跑。
      if (isCurrent()) {
        this.emitState(group, { active: false }, live);
        this.live.delete(group.id);
        this.busy.delete(group.id);
      }
      this.onChange(group.id);
    }

    return { ok: true };
  }

  /**
   * 广播群聊进度，让界面知道「谁在跑、还有谁排队」
   * @param {object} group
   * @param {object} p {current: bot|null, currentList: bot[], queue: job[], turn: number}
   * @param {object} liveRef 传了就做身份校验：旧一轮（已 stop / 已被顶掉）的迟到更新直接丢弃
   */
  emitState(group, p = {}, liveRef) {
    if (liveRef && this.live.get(group.id) !== liveRef) return;
    const live = this.live.get(group.id);
    if (live && p.active !== false) live.lastState = p;
    const totals = live && live.task ? live.task.totals() : null;
    const brief = (b) => (b ? { id: b.id, name: b.name, emoji: b.emoji, color: b.color } : null);
    const list = (p.currentList || (p.current ? [p.current] : [])).map(brief).filter(Boolean);
    const queued = (p.queue || [])
      .map((j) => brief(this.getBot(j.botId)))
      .filter(Boolean);
    if (live && live.task && p.active !== false) live.task.setQueue(queued);
    this.emit('room:state', {
      key: group.id,
      active: p.active !== undefined ? !!p.active : list.length > 0,
      current: list[0] || null,
      currentList: list,
      queue: queued,
      turn: p.turn || 0,
      maxTurns: MAX_TURNS,
      verifying: !!p.verifying,
      usage: totals ? { tokens: totals.usage.input + totals.usage.output, cost: totals.cost } : null,
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
