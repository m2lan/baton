'use strict';
/**
 * 界面文案。做法很朴素：一张表 + 一个 t()，不引入框架。
 *
 * 约定：
 *   - key 用「区域.用途」，比如 sidebar.search、composer.hintGroup
 *   - 占位符写 {name}，t('x', {name: 'foo'}) 时替换
 *   - 中文是基准语言：en 缺哪个 key 就退回中文，不会显示成 key 本身
 */

const DICT = {
  zh: {
    // ---------- 侧栏 ----------
    'sidebar.tagline': '本机 CLI 团队 · {n}/{total}',
    'sidebar.newBot': '新建 Bot',
    'sidebar.search': '搜索会话',
    'sidebar.rescan': '重新扫描本机 CLI',
    'sidebar.chats': '会话',
    'sidebar.newGroup': '新建群聊',
    'sidebar.noMatch': '没有匹配的会话',
    'sidebar.noBots': '还没有 Bot，点右上角 ＋ 建一个',
    'sidebar.localCli': '本机 CLI',
    'sidebar.available': '可用',
    'sidebar.refresh': '刷新',
    'sidebar.workspace': '本地工作区',
    'sidebar.running': '{n} 个 Bot 在跑',
    'sidebar.idle': '空闲',
    'sidebar.settings': '设置',

    // ---------- 会话头部 ----------
    'head.groupBadge': '群聊 · {n} 个 Bot',
    'head.followDir': '跟随各 Bot 的目录',
    'head.defaultDir': '默认目录',
    'head.atHint': '@ 谁谁回答，回答里 @ 别人即交班',
    'head.session': '会话 {id}',
    'head.loggedIn': '已登录',
    'head.notLoggedIn': '未登录',
    'head.goLogin': '去登录',
    'head.terminal': '终端',
    'head.members': '成员',
    'head.export': '导出',
    'head.exportTip': '导出为 Markdown',
    'head.clear': '清空',

    // ---------- 空态 ----------
    'hero.noCliBadge': '还没检测到任何 AI CLI',
    'hero.title': '三步就能开始干活',
    'hero.sub': 'Baton 自己不调用模型，它驱动你本机已经装好的 AI CLI。<br/>先把其中一个装起来，剩下的交给 Baton。',
    'hero.step1Title': '装一个 AI CLI',
    'hero.step1Body': '点下面的「复制」，把命令贴到终端执行；装完回来点最下方的「重新扫描」。',
    'hero.step2Title': '登录',
    'hero.step2Body': '多数 CLI 第一次运行会自己打开浏览器让你授权。如果新建 Bot 后发现它没登录，在会话里点「在窗口内登录」，不用另外开终端。',
    'hero.step3Title': '建第一个 Bot',
    'hero.step3Body': '给它起个名字、选个干活目录，就能派任务了。想让几个 Bot 互相配合，再建个群聊把它们拉进来。',
    'hero.copy': '复制',
    'hero.copyTip': '复制命令',
    'hero.manualOnly': '这几个都需要手动下载，去官网装完再回来。',
    'hero.rescanCta': '装好了，重新扫描',
    'hero.docsCta': '看文档',
    'hero.installedBadge': '本机已安装 {n} 个 AI CLI',
    'hero.mainTitle': '把你的 CLI，<span class="grad">变成一支 Bot 团队</span>',
    'hero.mainSub': '每个 Bot 绑定本机一个 AI CLI，拥有自己的工作目录和记忆。<br/>像给同事派活一样派任务，多个 Bot 可以同时干活。',
    'hero.newBotCta': '＋ 新建一个 Bot',
    'hero.newGroupCta': '👥 新建群聊',
    'hero.rescanBtn': '重新扫描本机 CLI',
    'hero.notInstalled': '未安装 · 点击安装',

    // ---------- 输入框 ----------
    'composer.placeholderGroup': '在群里说点什么，@ 某个 Bot 让它回答',
    'composer.placeholderBot': '给 {name} 派个活，Enter 发送',
    'composer.placeholderBusyGroup': '补充要求？Enter 发送，当前这个跑完就轮到它读到',
    'composer.placeholderBusyBot': '补充要求？Enter 发送，会排在这轮之后',
    'composer.hintGroup': 'Enter 发送 · @ 指定回答者 · 回答里 @ 别人会自动交班',
    'composer.hintGroupBusy': '跑的时候也能发，会排到当前这一轮之后，由下一个接手的 Bot 读到',
    'composer.hintBot': 'Enter 发送 · Shift+Enter 换行 · 任务在本机 CLI 里真实执行',
    'composer.stop': '停止当前任务',
    'composer.send': '发送',
    'composer.queueSend': '排到当前任务之后',
    'composer.membersChip': '{n} 个成员',
    'composer.atChip': '@ 指定谁回答',
    'composer.defaultModel': '默认模型',

    // ---------- 进度条 ----------
    'queue.running': '正在跑',
    'queue.parallel': '并行中',
    'queue.queued': '排队',
    'queue.turn': '第 {n}/{total} 轮',
    'queue.idle': '说完就结束，除非它 @ 别人',

    // ---------- 设置 ----------
    'settings.lang': '界面语言',
    'settings.langHint': '切换后立即生效',

    // ---------- 通用 ----------
    'common.you': '你',
    'common.system': '系统',
    'common.copy': '复制',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.delete': '删除',
    'common.close': '关闭',
    'common.failed': '执行失败',
    'common.stopped': '已手动停止',
    'common.timeout': '已超时停止',

    // ---------- 运行记录 / 用量 ----------
    'head.runs': '运行记录',
    'head.runsTip': '每次任务的用量、每一跳的 prompt 和改动',
    'runs.title': '运行记录',
    'runs.sub': '每次任务：谁接的手、花了多少、当时看到的 prompt、改了哪些文件',
    'runs.tabTasks': '本会话任务',
    'runs.tabUsage': '用量汇总',
    'runs.empty': '还没有记录。发一条消息后，这里会出现这次任务的每一跳。',
    'runs.hops': '{n} 跳',
    'runs.verify': '验收',
    'runs.prompt': '实际发给 CLI 的 prompt',
    'runs.changes': '改动的文件',
    'runs.output': '命令输出',
    'runs.exit': '退出码 {n}',
    'runs.byBot': '各 Bot 占比',
    'runs.worktree': 'worktree',
    'runs.noCost': '这个 CLI 不报费用',
    'runs.end.done': '完成',
    'runs.end.handoff': '交班 → {to}',
    'runs.end.stall': '原地打转',
    'runs.end.timeout': '超时',
    'runs.end.stopped': '已停止',
    'runs.end.error': '出错',
    'runs.end.maxTurns': '跳数用完',
    'runs.end.passed': '通过',
    'runs.end.failed': '未通过',
    'runs.end.verifyPassed': '验收通过',
    'runs.end.verifyFailed': '验收未通过',
    'usage.today': '今天',
    'usage.days': '{n} 天',
    'usage.all': '全部',
    'usage.tokens': 'Token',
    'usage.tokensSub': '输入 {i} · 输出 {o}',
    'usage.cache': '缓存读取',
    'usage.cacheSub': '不按全价计',
    'usage.cost': '费用',
    'usage.costSub': '只含会报费用的 CLI',
    'usage.tasks': '任务',
    'usage.tasksSub': '共 {n} 跳',
    'usage.taskCount': '{n} 次任务',
    'usage.byDay': '每天 Token',
    'usage.byBot': '按 Bot',
    'usage.byConvo': '按会话',
    'usage.empty': '这个时间段没有记录',
    'msg.changes': '改了 {n} 个文件',
    'msg.tokensTip': '输入 {i} · 输出 {o} · 缓存读取 {c}',
    'queue.verifying': '正在跑验收命令',
    'queue.usage': '本次 {tok} tok',

    // ---------- Bot / 群设置里的新字段 ----------
    'bot.env': '环境变量',
    'bot.envHint': '可选，一行一个 KEY=VALUE，启动 CLI 时注入',
    'bot.envPlaceholder': '比如接模型网关：\nANTHROPIC_BASE_URL=http://127.0.0.1:3425\nANTHROPIC_API_KEY=xxx',
    'group.worktree': '共用 git 仓库时用 worktree 隔离',
    'group.worktreeHint': '成员共用同一个仓库也能并行：每人一个临时 worktree，跑完把改动以未提交的形式合回主目录；冲突的改动存成补丁文件，不会硬合。',
    'group.verify': '验收命令',
    'group.verifyHint': '可选。交班链结束后自动执行，失败就把输出交回去修',
    'group.verifyPlaceholder': '比如 npm test',
    'group.verifyOwner': '失败交给',
    'group.verifyMax': '最多重试',
    'group.verifyLeader': '负责人',
  },

  en: {
    // ---------- sidebar ----------
    'sidebar.tagline': 'Local CLI crew · {n}/{total}',
    'sidebar.newBot': 'New Bot',
    'sidebar.search': 'Search chats',
    'sidebar.rescan': 'Rescan local CLIs',
    'sidebar.chats': 'Chats',
    'sidebar.newGroup': 'New room',
    'sidebar.noMatch': 'No matching conversations',
    'sidebar.noBots': 'No Bots yet — click ＋ at the top right',
    'sidebar.localCli': 'Local CLIs',
    'sidebar.available': 'available',
    'sidebar.refresh': 'Refresh',
    'sidebar.workspace': 'Local workspace',
    'sidebar.running': '{n} Bot(s) running',
    'sidebar.idle': 'Idle',
    'sidebar.settings': 'Settings',

    // ---------- conversation header ----------
    'head.groupBadge': 'Room · {n} Bots',
    'head.followDir': "Follow each Bot's folder",
    'head.defaultDir': 'Default folder',
    'head.atHint': '@ someone to answer; an @ in a reply hands off',
    'head.session': 'Session {id}',
    'head.loggedIn': 'Signed in',
    'head.notLoggedIn': 'Not signed in',
    'head.goLogin': 'Sign in',
    'head.terminal': 'Terminal',
    'head.members': 'Members',
    'head.export': 'Export',
    'head.exportTip': 'Export as Markdown',
    'head.clear': 'Clear',

    // ---------- empty state ----------
    'hero.noCliBadge': 'No AI CLI detected yet',
    'hero.title': 'Three steps to get going',
    'hero.sub': "Baton doesn't call models itself — it drives the AI CLIs already on your machine.<br/>Install one of them and Baton takes it from there.",
    'hero.step1Title': 'Install an AI CLI',
    'hero.step1Body': 'Hit Copy below and paste the command into your terminal, then come back and press Rescan.',
    'hero.step2Title': 'Sign in',
    'hero.step2Body': "Most CLIs open a browser to authorise on first run. If a Bot turns out not to be signed in, use “Sign in here” in the conversation — no separate terminal needed.",
    'hero.step3Title': 'Create your first Bot',
    'hero.step3Body': 'Name it, pick a working folder, and start handing it tasks. Want several Bots to collaborate? Create a room and add them.',
    'hero.copy': 'Copy',
    'hero.copyTip': 'Copy command',
    'hero.manualOnly': 'These need a manual download — grab them from their sites and come back.',
    'hero.rescanCta': 'Installed — rescan',
    'hero.docsCta': 'Read the docs',
    'hero.installedBadge': '{n} AI CLI(s) installed',
    'hero.mainTitle': 'Turn your CLIs into <span class="grad">a team of Bots</span>',
    'hero.mainSub': 'Each Bot binds to one local AI CLI, with its own working folder and memory.<br/>Hand out tasks like you would to colleagues — several Bots can work at once.',
    'hero.newBotCta': '＋ New Bot',
    'hero.newGroupCta': '👥 New room',
    'hero.rescanBtn': 'Rescan local CLIs',
    'hero.notInstalled': 'Not installed · click to install',

    // ---------- composer ----------
    'composer.placeholderGroup': 'Say something, or @ a Bot to answer',
    'composer.placeholderBot': 'Give {name} a task, Enter to send',
    'composer.placeholderBusyGroup': 'Add a requirement — Enter to send, the next Bot reads it',
    'composer.placeholderBusyBot': 'Add a requirement — queued after this turn',
    'composer.hintGroup': 'Enter to send · @ to address one Bot · an @ in a reply hands off',
    'composer.hintGroupBusy': 'You can type while it runs — it queues and the next Bot reads it',
    'composer.hintBot': 'Enter to send · Shift+Enter for a newline · runs in your local CLI',
    'composer.stop': 'Stop the current task',
    'composer.send': 'Send',
    'composer.queueSend': 'Queue after the current task',
    'composer.membersChip': '{n} members',
    'composer.atChip': '@ to pick who answers',
    'composer.defaultModel': 'Default model',

    // ---------- progress bar ----------
    'queue.running': 'running',
    'queue.parallel': 'in parallel',
    'queue.queued': 'queued',
    'queue.turn': 'turn {n}/{total}',
    'queue.idle': 'ends when it stops mentioning anyone',

    // ---------- settings ----------
    'settings.lang': 'Interface language',
    'settings.langHint': 'Applies immediately',

    // ---------- common ----------
    'common.you': 'You',
    'common.system': 'System',
    'common.copy': 'Copy',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.close': 'Close',
    'common.failed': 'Failed',
    'common.stopped': 'Stopped',
    'common.timeout': 'Timed out',

    // ---------- runs / usage ----------
    'head.runs': 'Runs',
    'head.runsTip': 'Usage per task, the prompt and file changes of every hop',
    'runs.title': 'Runs',
    'runs.sub': 'Each task: who took over, what it cost, the exact prompt, which files changed',
    'runs.tabTasks': 'Tasks here',
    'runs.tabUsage': 'Usage',
    'runs.empty': 'Nothing yet. Send a message and every hop of that task shows up here.',
    'runs.hops': '{n} hops',
    'runs.verify': 'Verify',
    'runs.prompt': 'Prompt sent to the CLI',
    'runs.changes': 'Files changed',
    'runs.output': 'Command output',
    'runs.exit': 'exit {n}',
    'runs.byBot': 'Share by Bot',
    'runs.worktree': 'worktree',
    'runs.noCost': 'This CLI does not report cost',
    'runs.end.done': 'done',
    'runs.end.handoff': 'handoff → {to}',
    'runs.end.stall': 'stalled',
    'runs.end.timeout': 'timed out',
    'runs.end.stopped': 'stopped',
    'runs.end.error': 'error',
    'runs.end.maxTurns': 'hop limit',
    'runs.end.passed': 'passed',
    'runs.end.failed': 'failed',
    'runs.end.verifyPassed': 'verified',
    'runs.end.verifyFailed': 'verify failed',
    'usage.today': 'Today',
    'usage.days': '{n} days',
    'usage.all': 'All',
    'usage.tokens': 'Tokens',
    'usage.tokensSub': 'in {i} · out {o}',
    'usage.cache': 'Cache reads',
    'usage.cacheSub': 'not billed at full rate',
    'usage.cost': 'Cost',
    'usage.costSub': 'only CLIs that report cost',
    'usage.tasks': 'Tasks',
    'usage.tasksSub': '{n} hops',
    'usage.taskCount': '{n} tasks',
    'usage.byDay': 'Tokens per day',
    'usage.byBot': 'By Bot',
    'usage.byConvo': 'By conversation',
    'usage.empty': 'No records in this range',
    'msg.changes': '{n} files changed',
    'msg.tokensTip': 'in {i} · out {o} · cache reads {c}',
    'queue.verifying': 'running the verify command',
    'queue.usage': '{tok} tok so far',

    // ---------- new Bot / room fields ----------
    'bot.env': 'Environment',
    'bot.envHint': 'Optional, one KEY=VALUE per line, injected when the CLI starts',
    'bot.envPlaceholder': 'e.g. point it at a model gateway:\nANTHROPIC_BASE_URL=http://127.0.0.1:3425\nANTHROPIC_API_KEY=xxx',
    'group.worktree': 'Isolate with git worktrees when sharing a repo',
    'group.worktreeHint': 'Members sharing one repo can still run in parallel: each gets a temporary worktree, and changes are applied back to the main directory uncommitted. Conflicting changes are saved as a patch file instead of being forced in.',
    'group.verify': 'Verify command',
    'group.verifyHint': 'Optional. Runs when the handoff chain ends; on failure the output goes back for a fix',
    'group.verifyPlaceholder': 'e.g. npm test',
    'group.verifyOwner': 'On failure',
    'group.verifyMax': 'Max retries',
    'group.verifyLeader': 'Lead',
  },
};

const LANGS = [
  { v: 'auto', label: '跟随系统 / Auto' },
  { v: 'zh', label: '简体中文' },
  { v: 'en', label: 'English' },
];

/** 系统语言 → 支持的语言；中文系一律归到 zh，其余归 en */
function detectLang() {
  const raw = (navigator.language || 'zh').toLowerCase();
  return raw.startsWith('zh') ? 'zh' : 'en';
}

/**
 * @param {string} key
 * @param {object} [vars] 占位符，如 {n: 3}
 * @param {string} [lang] 目标语言；不传则跟随系统
 */
function t(key, vars, lang) {
  const code = lang && DICT[lang] ? lang : detectLang();
  const table = DICT[code] || DICT.zh;
  let s = table[key];
  if (s === undefined) s = DICT.zh[key];
  if (s === undefined) return key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split(`{${k}}`).join(String(vars[k]));
    }
  }
  return s;
}

/** 把 'auto' 解析成实际语言码 */
function resolveLang(pref) {
  return !pref || pref === 'auto' ? detectLang() : (DICT[pref] ? pref : 'zh');
}

window.I18N = { t, detectLang, resolveLang, LANGS, DICT };
