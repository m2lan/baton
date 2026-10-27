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
