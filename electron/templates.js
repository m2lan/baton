'use strict';
/**
 * 任务模板：一步建好一个有角色分工的群。
 *
 * 成员只描述「角色」，不绑定具体 CLI —— 建群时按本机已装的 CLI 自动分配，
 * 所以同一个模板在任何机器上都能用，装一个 CLI 也能跑，装五个就各用各的。
 *
 * 写 prompt 的三条约定：
 *   1. 说清楚「你负责什么」和「你不负责什么」，避免成员互相抢活或都撒手
 *   2. 明确交接动作：最后一行 @ 谁；不需要别人接手就什么也别 @
 *   3. 限制输出长度，群聊是接力不是写论文，一次说太多后面的成员读不完
 */

const TEMPLATES = [
  {
    id: 'writing',
    name: '写作小组',
    emoji: '✍️',
    desc: '有人写、有人挑错、有人从读者角度把关',
    hint: '文档、说明、对外材料',
    flow: '作者写 → 审稿挑问题 → 作者改 → 直到审稿说通过',
    members: [
      {
        role: '作者',
        emoji: '✍️',
        color: '#8B5CF6',
        prefer: ['claude', 'codebuddy', 'qoder', 'codex'],
        prompt:
          '你负责写稿。动笔前先确认目标读者和交付形式，如果用户没说清就先问一句。'
          + '写作要求：结构清楚、句子短、不用没解释过的术语。'
          + '每次只交一版完整稿，不要边写边解释你的思路。'
          + '写完在最后单独一行写「@审稿 请审」。',
      },
      {
        role: '审稿',
        emoji: '🔍',
        color: '#F59E0B',
        prefer: ['claude', 'codex', 'gemini'],
        prompt:
          '你负责挑问题，不负责重写。重点看四件事：事实是否准确、逻辑是否站得住、有没有跳步、'
          + '术语有没有解释过。每次只指出最关键的 3 个问题，并说明为什么算问题、改了有什么好处。'
          + '不要罗列所有小毛病，也不要自己动手改稿。'
          + '审完后在最后单独一行写「@作者 请按上面 3 点修改」；'
          + '如果确实没问题了，就直接说通过，不要 @ 任何人。',
      },
      {
        role: '读者',
        emoji: '👀',
        color: '#10B981',
        prefer: ['gemini', 'codebuddy', 'qwen'],
        prompt:
          '你扮演目标读者，把自己当成第一次接触这件事的人。'
          + '读的时候只回答三个问题：哪里看不懂、哪里会想放弃、哪个步骤照着做会卡住。'
          + '用「我看到这里会……」的句式给反馈，不要给修改方案。'
          + '如果通篇都能看懂，就说「没有障碍」，不要 @ 任何人。',
      },
    ],
  },
  {
    id: 'review',
    name: '代码评审',
    emoji: '🔧',
    desc: '实现、审查、测试各管一摊',
    hint: '改动不大但想要第二双眼睛',
    flow: '实现写代码 → 审查提意见 → 实现改 → 测试补用例',
    members: [
      {
        role: '实现',
        emoji: '🔧',
        color: '#3B82F6',
        prefer: ['claude', 'codebuddy', 'codex'],
        prompt:
          '你负责写代码。动手前先说清你打算改哪几个文件、为什么这么改，然后直接改，不要只给建议。'
          + '改完在最后单独一行写「@审查 请看一下」。',
      },
      {
        role: '审查',
        emoji: '🧐',
        color: '#F97316',
        prefer: ['claude', 'codex', 'qoder'],
        prompt:
          '你负责审查，不改代码。只看这几件事：有没有改错地方、边界情况有没有漏、'
          + '有没有引入新的失败路径、命名和结构是否跟周围代码一致。'
          + '最多提 3 条，每条说清「在哪、什么问题、不改会怎样」。'
          + '有问题就在最后一行写「@实现 请按上面修改」；没问题就说通过并 @测试，或者干脆不 @ 任何人。',
      },
      {
        role: '测试',
        emoji: '🧪',
        color: '#10B981',
        prefer: ['codex', 'qwen', 'claude'],
        prompt:
          '你负责验证。优先实际跑一遍（执行测试、跑一下命令），不要只靠读代码下结论。'
          + '报告要写清楚：跑了什么、结果是什么、有没有覆盖到改动的地方。'
          + '发现问题就在最后一行写「@实现 请修」；都正常就说验证通过，不要 @ 任何人。',
      },
    ],
  },
  {
    id: 'feature',
    name: '需求到实现',
    emoji: '📐',
    desc: '产品拆需求、架构定方案、编码落地',
    hint: '一个功能从想法到能用',
    flow: '产品拆需求 → 架构给方案 → 编码实现 → 回到产品验收',
    members: [
      {
        role: '产品',
        emoji: '📋',
        color: '#8B5CF6',
        prefer: ['claude', 'codebuddy', 'gemini'],
        prompt:
          '你负责把模糊需求拆成能验收的东西。输出三部分：要解决什么问题、做哪几件事、'
          + '每件事怎么算做完（可验证的验收标准）。不要写技术方案，那是架构的事。'
          + '拆完在最后单独一行写「@架构 请给方案」。',
      },
      {
        role: '架构',
        emoji: '📐',
        color: '#0EA5E9',
        prefer: ['claude', 'qoder', 'codex'],
        prompt:
          '你负责技术方案。基于产品给的验收标准，说清楚：动哪些模块、数据怎么流、'
          + '边界和失败情况怎么处理、有哪些取舍（以及为什么选这个）。'
          + '不要写完整代码，给到能直接照着实现的程度就够了。'
          + '方案定完在最后单独一行写「@编码 请实现」。',
      },
      {
        role: '编码',
        emoji: '⌨️',
        color: '#10B981',
        prefer: ['claude', 'qoder', 'codex', 'codebuddy'],
        prompt:
          '你负责实现。严格按架构给的方案做，发现方案有问题先说出来再动手改。'
          + '实现完自己跑一遍验证，然后在最后单独一行写「@产品 请验收」。',
      },
    ],
  },
];

/** 已装 CLI 可能有版本等多个副本，按 id 去重 */
function uniqAgents(list) {
  const seen = new Set();
  return (list || []).filter((a) => {
    if (!a || !a.id || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

/**
 * 给每个角色分配一个 CLI。
 * 优先用「还没被占用」的：多 Bot 协作的价值有一半在于不同模型互相挑错，
 * 全堆在同一个 CLI 上就退化成同一个脑子自言自语了。
 * 只有已装的 CLI 不够分时，才允许复用。
 * @param {Array} installed 已安装的 CLI（含 id）
 * @returns {Array<{role,emoji,color,prompt,agent}>}
 */
function buildPlan(template, installed) {
  const pool = uniqAgents(installed);
  if (!pool.length) return [];
  const used = new Set();
  return template.members.map((m, i) => {
    const prefs = m.prefer || [];
    // ① 偏好里还没被占用的
    let hit = prefs.map((id) => pool.find((a) => a.id === id && !used.has(a.id))).find(Boolean);
    // ② 池子里任何还没被占用的
    if (!hit) hit = pool.find((a) => !used.has(a.id));
    // ③ 实在不够分，按偏好复用
    if (!hit) hit = prefs.map((id) => pool.find((a) => a.id === id)).find(Boolean) || pool[i % pool.length];
    used.add(hit.id);
    return { ...m, agent: hit };
  });
}

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

/** 给界面用的精简数据（不带 prompt 全文和 prefer） */
function listForUI() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    desc: t.desc,
    hint: t.hint,
    flow: t.flow,
    roles: t.members.map((m) => ({ role: m.role, emoji: m.emoji, color: m.color })),
  }));
}

module.exports = { TEMPLATES, getTemplate, buildPlan, listForUI };
