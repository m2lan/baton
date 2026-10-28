/* LocalBot renderer —— 原生 Vue3（无构建） */
const { createApp, ref, reactive, computed, nextTick } = Vue;

/* ---------------- markdown ---------------- */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMd(src) {
  const text = String(src || '');
  if (!text) return '';
  const codes = [];
  let s = text.replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, (_m, lang, code) => {
    codes.push({ lang, code: code.replace(/\s+$/, '') });
    return `\u0000C${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/^\s*\[([ xX])\]\s+/gm, (_m, c) => (c === ' ' ? '☐ ' : '☑ '));

  const lines = s.split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let buf = [];
  let quote = [];

  const flushPara = () => {
    if (buf.length) {
      out.push(`<p>${buf.join('<br>')}</p>`);
      buf = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      quote = [];
    }
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\s+$/, '');

    // 表格：连续以 | 开头的行
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList(); flushQuote();
      const rows = [];
      let j = li;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        rows.push(lines[j].trim());
        j++;
      }
      li = j - 1;
      const cells = (r) =>
        r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const isSep = (r) => /^\|?[\s:-]*-{2,}[\s:|-]*\|?$/.test(r) && r.includes('-');
      let head = null;
      let body = rows;
      if (rows.length > 1 && isSep(rows[1])) {
        head = cells(rows[0]);
        body = rows.slice(2);
      }
      let t = '<table>';
      if (head) t += `<thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
      t += '<tbody>';
      for (const r of body) {
        if (isSep(r)) continue;
        t += `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`;
      }
      t += '</tbody></table>';
      out.push(t);
      continue;
    }
    if (/^\u0000C\d+\u0000$/.test(line.trim())) {
      flushPara(); flushList(); flushQuote();
      out.push(line.trim());
      continue;
    }
    if (!line.trim()) {
      flushPara(); flushList(); flushQuote();
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(); flushList(); flushQuote();
      const lv = Math.min(h[1].length, 3);
      out.push(`<h${lv}>${h[2]}</h${lv}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara(); flushList(); flushQuote();
      out.push('<hr>');
      continue;
    }
    const q = line.match(/^&gt;\s?(.*)$/);
    if (q) {
      flushPara(); flushList();
      quote.push(q[1]);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara(); flushQuote();
      if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara(); flushQuote();
      if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${ol[1]}</li>`);
      continue;
    }
    flushList(); flushQuote();
    buf.push(line);
  }
  flushPara(); flushList(); flushQuote();

  let html = out.join('\n');
  html = html.replace(/\u0000C(\d+)\u0000/g, (_m, i) => {
    const c = codes[Number(i)] || { code: '' };
    const lang = c.lang ? ` data-lang="${esc(c.lang)}"` : '';
    return `<pre${lang}><code>${esc(c.code)}</code></pre>`;
  });
  return html;
}

/* ---------------- app ---------------- */
const EMOJIS = ['✳️','🐧','⚡','✦','◐','🐙','🛰️','🌊','🖱️','🐫','🔆','🧷','🤖','🦉','🧠','🚀'];

createApp({
  setup() {
    const agents = ref([]);
    const bots = ref([]);
    const groups = ref([]);
    const settings = ref({});
    // 界面语言偏好：'auto' 跟随系统，或 'zh' / 'en'
    const langPref = ref('auto');
    const langOptions = window.I18N.LANGS;
    const langCode = computed(() => window.I18N.resolveLang(langPref.value));
    /** 模板里统一用 t('key')；读 langCode 会自动建立依赖，切语言即重渲染 */
    const t = (key, vars) => window.I18N.t(key, vars, langCode.value);
    const netForm = reactive({ mode: 'auto', url: '', perAgent: {} });
    const diag = ref(null);
    const diagBusy = ref(false);
    const appInfo = reactive({ version: '', packaged: false, platform: '' });
    const updateState = reactive({ state: 'idle', version: '', percent: 0, message: '' });
    const activeId = ref('');
    const chats = reactive({});
    const running = reactive({});
    const roomBusy = reactive({});
    // 群聊进度：{ [gid]: { current: bot, queue: bot[], turn, maxTurns } }
    const roomProgress = reactive({});
    const query = ref('');
    const draft = ref('');
    const modal = ref(null);
    const installing = reactive({});
    const installLog = ref([]);
    const openThink = reactive({});
    const openTool = reactive({});
    const stick = ref(true);
    const stream = ref(null);
    const ta = ref(null);
    const termEl = ref(null);
    const term = reactive({ open: false, id: '', title: '', cwd: '', mode: 'login', err: '', slashLogin: false, netHint: false, agentId: '' });
    let termOut = '';
    let xterm = null;
    let fitAddon = null;
    let termObserver = null;

    const form = reactive({
      agentId: '', name: '', emoji: '🤖', cwd: '', model: '', permission: 'auto', systemPrompt: '', env: '', id: '',
    });

    const groupForm = reactive({
      id: '', name: '', cwd: '', memberIds: [], leaderId: '', concurrent: false, decisionsText: '',
      worktree: true, verifyCmd: '', verifyMax: 3, verifyOwner: '',
    });
    // 运行记录弹窗：任务列表 / 用量汇总
    const runsView = reactive({ tab: 'task', key: '', tasks: [], openTask: '', days: 7, summary: null });
    const openHop = reactive({});
    const openChanges = reactive({});
    const templates = ref([]);
    const creatingTpl = ref(false);
    const tplError = ref('');
    const mention = reactive({ open: false, query: '', index: 0, list: [] });

    const perms = [
      { v: 'auto', label: '自动', tip: 'Bot 自己决定，不再问你 —— 适合明确任务' },
      { v: 'default', label: '谨慎', tip: '涉及写入/执行时按 CLI 默认策略询问' },
      { v: 'plan', label: '只读', tip: '只读规划，不改文件不执行命令' },
    ];

    /* -------- 派生 -------- */
    const convos = computed(() => {
      const gs = groups.value.map((g) => ({
        ...g,
        kind: 'group',
        members: (g.memberIds || []).map((id) => bots.value.find((b) => b.id === id)).filter(Boolean),
      }));
      const bs = bots.value.map((b) => ({ ...b, kind: 'bot' }));
      return [...gs, ...bs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    });
    const active = computed(() => convos.value.find((c) => c.id === activeId.value) || null);
    const filtered = computed(() => {
      const q = query.value.trim().toLowerCase();
      if (!q) return convos.value;
      return convos.value.filter((c) => (c.name + ' ' + (c.preview || '')).toLowerCase().includes(q));
    });
    const isBusy = (id) => !!running[id] || !!roomBusy[id];
    const leaderName = computed(() => {
      const a = active.value;
      if (!a || a.kind !== 'group') return '';
      const l = a.members.find((m) => m.id === a.leaderId) || a.members[0];
      return l ? l.name : '';
    });
    const placeholder = computed(() => {
      const a = active.value;
      if (!a) return '';
      if (isBusy(a.id)) {
        return a.kind === 'group' ? t('composer.placeholderBusyGroup') : t('composer.placeholderBusyBot');
      }
      if (a.kind === 'group') return t('composer.placeholderGroup');
      return t('composer.placeholderBot', { name: a.name });
    });
    const netHint = computed(() => {
      if (netForm.mode === 'auto') {
        return '国内 CLI（CodeBuddy / Qwen）走直连——它们的 setProxy 拿到代理变量会崩；海外 CLI（Claude / Gemini / Codex）沿用系统代理，出口 IP 不变，避免风控。';
      }
      if (netForm.mode === 'inherit') return '所有 CLI 都沿用启动本应用时环境里的 HTTP(S)_PROXY。';
      if (netForm.mode === 'direct') return '所有 CLI 都不带代理。只建议在「完全不需要代理」的网络下使用。';
      return '所有 CLI 与终端都走这个代理。';
    });
    const overrideList = computed(() =>
      Object.entries(netForm.perAgent || {}).map(([id, mode]) => ({ id, mode }))
    );
    const diagRows = computed(() => (diag.value && diag.value.results) || []);
    const canSaveGroup = computed(() => !!groupForm.name.trim() && groupForm.memberIds.length > 0);
    const installedAgents = computed(() => agents.value.filter((a) => a.installed));
    const notInstalled = computed(() => agents.value.filter((a) => !a.installed));
    const installedCount = computed(() => installedAgents.value.length);
    // 首次引导里只列「有明确安装命令」的几个，避免一次甩出十几个把新用户淹掉
    const quickStartCLIs = computed(() =>
      agents.value.filter((a) => !a.installed && a.installCmd).slice(0, 4)
    );
    const runningCount = computed(() => Object.keys(running).filter((k) => running[k]).length + Object.keys(roomBusy).filter((k) => roomBusy[k]).length);
    const messages = computed(() => chats[activeId.value] || []);
    const selectedAgent = computed(() => agents.value.find((a) => a.id === form.agentId) || null);
    const canSave = computed(() => {
      if (!form.name.trim()) return false;
      if (modal.value === 'new') {
        const a = selectedAgent.value;
        return !!(a && a.installed);
      }
      return true;
    });
    const permTip = computed(() => (perms.find((p) => p.v === form.permission) || perms[0]).tip);
    const emojiList = EMOJIS;
    const starters = [
      '先看看这个目录，告诉我它是做什么的',
      '跑一遍构建，有报错就修掉',
      '读一下 README，把缺失的部分补全',
      '列一下当前有哪些没提交的改动',
    ];

    /* -------- 工具函数 -------- */
    const agentOf = (b) => (b ? agents.value.find((a) => a.id === b.agentId) : null);
    const avatarStyle = (b) => {
      const c = (b && b.color) || '#7c6bff';
      return { background: `radial-gradient(120% 120% at 30% 20%, ${c}44, ${c}18 60%, #10131a 100%)`, color: '#fff' };
    };
    const ago = (ts) => {
      if (!ts) return '';
      const d = Date.now() - ts;
      if (d < 60e3) return '刚刚';
      if (d < 3600e3) return `${Math.floor(d / 60e3)}m`;
      if (d < 864e5) return `${Math.floor(d / 3600e3)}h`;
      if (d < 7 * 864e5) return `${Math.floor(d / 864e5)}d`;
      return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    };
    const shortPath = (p) => {
      if (!p) return '默认目录';
      const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
    };
    const shortModel = (m) => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const verLabel = (a) => {
      if (!a) return '';
      if (!a.installed) return '未安装';
      const v = String(a.version || '');
      return v && v !== 'installed' ? 'v' + v : '已安装';
    };
    const permLabel = (p) => (perms.find((x) => x.v === p) || perms[0]).label;
    const toolPreview = (p) => {
      if (!p.input) return '';
      let s = String(p.input).replace(/\s+/g, ' ').trim();
      try {
        const o = JSON.parse(p.input);
        s = o.command || o.file_path || o.path || o.query || o.pattern || o.prompt || s;
        if (typeof s !== 'string') s = JSON.stringify(s);
      } catch {}
      return s.length > 76 ? s.slice(0, 76) + '…' : s;
    };
    const agentNameOf = (x) => {
      if (!x) return '';
      const a = agents.value.find((v) => v.id === x.agentId);
      return a ? a.name : '';
    };
    const senderOf = (m) => {
      const a = active.value;
      if (m && m.sender) {
        const bot = bots.value.find((b) => b.id === m.sender.id);
        return bot || m.sender;
      }
      return a || { name: '', emoji: '🤖', color: '#7c6bff' };
    };
    const renderUserText = (text) => {
      const raw = String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const a = active.value;
      if (!a || a.kind !== 'group' || !a.members.length) return raw.replace(/\n/g, '<br>');
      const names = a.members
        .map((m) => m.name)
        .filter(Boolean)
        .sort((x, y) => y.length - x.length)
        .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (!names.length) return raw.replace(/\n/g, '<br>');
      const re = new RegExp('@(' + names.join('|') + ')', 'g');
      return raw.replace(re, '<span class="at">@$1</span>').replace(/\n/g, '<br>');
    };
    const copy = (m) => {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      navigator.clipboard.writeText(text);
    };
    const copyText = (text) => {
      if (!text) return;
      navigator.clipboard.writeText(String(text));
    };

    // 群聊的 run key 是 gid:botId，消息归属还是 gid
    const chatKeyOf = (key) => String(key || '').split(':')[0];

    /* -------- 消息/滚动 -------- */
    function upsert(botId, msg) {
      if (!chats[botId]) chats[botId] = [];
      const arr = chats[botId];
      const i = arr.findIndex((x) => x.id === msg.id);
      if (i >= 0) arr[i] = msg;
      else arr.push(msg);
      if (botId === activeId.value) scrollBottom();
    }

    function scrollBottom(force) {
      if (!force && !stick.value) return;
      nextTick(() => {
        const el = stream.value;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        setTimeout(() => {
          if (force || stick.value) el.scrollTop = el.scrollHeight;
        }, 80);
      });
    }

    function onScroll() {
      const el = stream.value;
      if (!el) return;
      stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    }

    /* -------- 启动 -------- */
    async function boot() {
      const data = await window.lb.init();
      agents.value = data.agents || [];
      settings.value = data.settings || {};
      if (settings.value.lang) langPref.value = settings.value.lang;
      applyProxySettings(settings.value.proxy);
      bots.value = data.bots || [];
      if (data.app) {
        appInfo.version = data.app.version || '';
        appInfo.packaged = !!data.app.packaged;
        appInfo.platform = data.app.platform || '';
        if (data.app.update) Object.assign(updateState, data.app.update);
      }
      window.lb.listTemplates().then((list) => (templates.value = list || [])).catch(() => {});
      window.lb.onEvent(async (channel, payload) => {
        if (channel === 'run:start') {
          running[chatKeyOf(payload.key)] = true;
          scrollBottom();
        } else if (channel === 'run:msg') {
          running[chatKeyOf(payload.key)] = true;
          upsert(chatKeyOf(payload.key), payload.msg);
        } else if (channel === 'run:done') {
          const ck = chatKeyOf(payload.key);
          running[ck] = false;
          upsert(ck, payload.msg);
          refreshBots();
        } else if (channel === 'msg:update') {
          // 改动清单是 CLI 退出后才算出来的，补到已显示的消息上
          upsert(chatKeyOf(payload.key), payload.msg);
        } else if (channel === 'runs:update') {
          if (modal.value === 'runs' && runsView.key === payload.key) loadRuns();
        } else if (channel === 'room:state') {
          roomBusy[payload.key] = !!payload.active;
          if (payload.active) {
            roomProgress[payload.key] = {
              current: payload.current || null,
              currentList: payload.currentList || [],
              queue: payload.queue || [],
              turn: payload.turn || 0,
              maxTurns: payload.maxTurns || 0,
              verifying: !!payload.verifying,
              usage: payload.usage || null,
            };
          } else {
            delete roomProgress[payload.key];
          }
        } else if (channel === 'rooms:update') {
          groups.value = payload || [];
        } else if (channel === 'update:state') {
          Object.assign(updateState, payload || {});
        } else if (channel === 'bots:update') {
          const cur = activeId.value;
          bots.value = payload || [];
          if (cur && !bots.value.find((b) => b.id === cur) && !groups.value.find((g) => g.id === cur)) activeId.value = '';
        } else if (channel === 'agents:update') {
          agents.value = payload || [];
          for (const a of agents.value) if (a.installed) delete installing[a.id];
        } else if (channel === 'pty:data') {
          if (payload.id === term.id && xterm) {
            termOut += payload.data;
            xterm.write(payload.data);
            if (/TLS connection|socket disconnected|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network error|ECONNREFUSED/i.test(payload.data)) {
              term.netHint = true;
            }
          }
        } else if (channel === 'pty:exit') {
          if (payload.id === term.id && xterm) {
            const plain = termOut.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
            xterm.write('\r\n\x1b[38;5;243m[进程已退出，点「重启」可再来一次]\x1b[0m\r\n');
            if (/EADDRINUSE|address already in use/i.test(plain)) {
              xterm.write(
                '\x1b[33m提示：本地端口 61172 被别的程序占着（通常是 WorkBuddy / CodeBuddy 桌面版正在后台跑）。\r\n' +
                '可以关掉那个程序后点「重启」，或者点右上角「系统终端」到外面去登录。\x1b[0m\r\n'
              );
            } else if (!plain) {
              xterm.write(
                '\x1b[33m提示：它没输出就退出了，通常是本地守护端口被占用（61172）。\r\n' +
                '关掉 WorkBuddy / CodeBuddy 桌面版后点「重启」，或改用「系统终端」。\x1b[0m\r\n'
              );
            }
          }
        } else if (channel === 'install:log') {
          if (payload.line) installLog.value.push(payload.line);
          if (payload.done) delete installing[payload.agentId];
        }
      });

      groups.value = data.groups || [];
      const first = convos.value[0];
      if (first) await select(first.id);
    }

    async function refreshBots() {
      const data = await window.lb.init();
      bots.value = data.bots || [];
      groups.value = data.groups || [];
    }

    async function refreshAgents() {
      agents.value = await window.lb.detect();
    }

    async function select(id) {
      if (term.open && id !== activeId.value) closeTerm();
      activeId.value = id;
      mention.open = false;
      Object.keys(openThink).forEach((k) => delete openThink[k]);
      Object.keys(openTool).forEach((k) => delete openTool[k]);
      if (!chats[id]) chats[id] = await window.lb.getMessages(id);
      scrollBottom(true);
      nextTick(() => ta.value && ta.value.focus());
    }

    /* -------- 新建 / 编辑 -------- */
    function resetForm(a) {
      form.id = '';
      form.agentId = a ? a.id : '';
      form.name = a ? a.name.replace(/\s*(CLI|Code)$/, '') : '';
      form.emoji = a ? a.emoji : '🤖';
      form.cwd = '';
      form.model = '';
      form.permission = 'auto';
      form.systemPrompt = '';
      form.env = '';
    }

    function openNew(preselect) {
      const a = (preselect && agents.value.find((x) => x.id === preselect)) || installedAgents.value[0] || agents.value[0];
      resetForm(a);
      installLog.value = [];
      modal.value = 'new';
    }

    function openEdit(bot) {
      form.id = bot.id;
      form.agentId = bot.agentId;
      form.name = bot.name;
      form.emoji = bot.emoji;
      form.cwd = bot.cwd || '';
      form.model = bot.model || '';
      form.permission = bot.permission || 'auto';
      form.systemPrompt = bot.systemPrompt || '';
      form.env = bot.env || '';
      modal.value = 'edit';
    }

    function closeModals() {
      modal.value = null;
    }

    function pickAgent(a) {
      if (form.agentId === a.id) return;
      form.agentId = a.id;
      form.emoji = a.emoji;
      if (!form.name || agents.value.some((x) => x.name.replace(/\s*(CLI|Code)$/, '') === form.name)) {
        form.name = a.name.replace(/\s*(CLI|Code)$/, '');
      }
    }

    async function install(a) {
      installing[a.id] = true;
      installLog.value = [];
      const r = await window.lb.install(a.id);
      if (!r.ok) {
        installLog.value.push(`✗ ${r.error}`);
        delete installing[a.id];
      }
    }

    async function pickDir() {
      const dir = await window.lb.pickDir();
      if (dir) form.cwd = dir;
    }

    async function save() {
      if (!canSave.value) return;
      if (modal.value === 'new') {
        const bot = await window.lb.createBot({
          agentId: form.agentId,
          name: form.name.trim(),
          emoji: form.emoji,
          color: selectedAgent.value?.color,
          cwd: form.cwd.trim(),
          model: form.model.trim(),
          permission: form.permission,
          systemPrompt: form.systemPrompt,
          env: form.env,
        });
        bots.value = [bot, ...bots.value.filter((b) => b.id !== bot.id)];
        chats[bot.id] = [];
        modal.value = null;
        await select(bot.id);
      } else {
        const patch = {
          name: form.name.trim(),
          emoji: form.emoji,
          cwd: form.cwd.trim(),
          model: form.model.trim(),
          permission: form.permission,
          systemPrompt: form.systemPrompt,
          env: form.env,
        };
        const bot = await window.lb.updateBot(form.id, patch);
        const i = bots.value.findIndex((b) => b.id === form.id);
        if (i >= 0 && bot) bots.value[i] = bot;
        modal.value = null;
      }
    }

    async function removeBot() {
      if (!form.id) return;
      await window.lb.deleteBot(form.id);
      bots.value = bots.value.filter((b) => b.id !== form.id);
      if (activeId.value === form.id) activeId.value = '';
      modal.value = null;
    }

    /* -------- 会话 -------- */
    async function send() {
      const text = draft.value.trim();
      if (!text || !active.value) return;
      const conv = active.value;
      // 群聊在跑的时候允许插话：消息会排到当前轮之后，由下一个接手的 Bot 读到。
      // 单 Bot 没有队列概念，只能等这一轮结束。
      if (isBusy(conv.id) && conv.kind !== 'group') return;
      mention.open = false;
      draft.value = '';
      autoGrow();
      stick.value = true;
      const r = await window.lb.send(conv.id, text);
      if (r.userMsg) upsert(conv.id, r.userMsg);
      if (r.errMsg) upsert(conv.id, r.errMsg);
      if (r.group) roomBusy[conv.id] = true;
      scrollBottom(true);
      if (r.error) console.warn(r.error);
    }

    function stop() {
      if (active.value) window.lb.stop(active.value.id);
    }

    /** 导出当前会话为 Markdown，导出后打开所在文件夹 */
    async function exportChat() {
      const conv = active.value;
      if (!conv) return;
      const r = await window.lb.exportChat(conv.id);
      if (r && r.ok) {
        if (r.dir) window.lb.openFolder(r.dir);
      } else if (r && !r.canceled) {
        console.warn(r.error);
        alert(r.error || '导出失败');
      }
    }

    /* -------- 运行记录 / 用量 -------- */
    async function openRuns() {
      if (!active.value) return;
      runsView.key = active.value.id;
      runsView.tab = 'task';
      runsView.openTask = '';
      modal.value = 'runs';
      await loadRuns();
    }

    async function loadRuns() {
      if (runsView.tab === 'task') {
        runsView.tasks = (await window.lb.listRuns(runsView.key)) || [];
        if (!runsView.openTask && runsView.tasks[0]) runsView.openTask = runsView.tasks[0].id;
      } else {
        runsView.summary = await window.lb.usageSummary(runsView.days);
      }
    }

    function setRunsTab(tab) {
      runsView.tab = tab;
      loadRuns();
    }

    function setUsageDays(d) {
      runsView.days = d;
      loadRuns();
    }

    const toggleHop = (tid, i) => (openHop[tid + '_' + i] = !openHop[tid + '_' + i]);

    function fmtTokens(n) {
      n = Number(n) || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
      return String(n);
    }
    const fmtCost = (c) => (c == null ? '—' : '$' + Number(c).toFixed(c < 1 ? 4 : 2));
    const fmtDur = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${((ms || 0) / 1000).toFixed(1)}s`);
    function fmtTime(ts) {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    const endLabel = (r, h) => (r ? t('runs.end.' + r, { to: (h && h.to) || '' }) : '');
    const sumTok = (u) => (u ? (u.input || 0) + (u.output || 0) : 0);

    /** 按天柱状图：补齐没有记录的日子，空白天也占一格，时间轴才不会被压缩 */
    const usageDays = computed(() => {
      const s = runsView.summary;
      if (!s) return [];
      const map = Object.fromEntries((s.byDay || []).map((d) => [d.day, d]));
      let span = runsView.days;
      if (!span) span = Math.min(90, Math.max(1, s.byDay.length ? Math.ceil((Date.now() - new Date(s.byDay[0].day).getTime()) / 86400000) + 1 : 1));
      const out = [];
      const p = (n) => String(n).padStart(2, '0');
      for (let i = span - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        const x = map[day];
        out.push({ day, label: `${p(d.getMonth() + 1)}-${p(d.getDate())}`, tokens: x ? sumTok(x.usage) : 0, cost: x ? x.cost : 0 });
      }
      const max = Math.max(1, ...out.map((x) => x.tokens));
      return out.map((x) => ({ ...x, pct: (x.tokens / max) * 100 }));
    });

    /** 某个任务里各 Bot 的 token 占比 */
    function botShares(task) {
      const list = (task.totals && task.totals.byBot) || [];
      const total = list.reduce((a, b) => a + sumTok(b.usage), 0) || 1;
      return list.map((b) => ({ ...b, tokens: sumTok(b.usage), pct: Math.round((sumTok(b.usage) / total) * 100) }));
    }

    async function clearChat() {      if (!active.value) return;
      await window.lb.clear(active.value.id);
      chats[active.value.id] = [];
      const b = bots.value.find((x) => x.id === active.value.id);
      if (b) { b.sessionId = ''; b.preview = ''; }
      const g = groups.value.find((x) => x.id === active.value.id);
      if (g) { g.sessions = {}; g.preview = ''; }
    }

    /* -------- 自动更新 -------- */
    const canCheckUpdate = computed(() => appInfo.packaged);
    const updateLabel = computed(() => {
      switch (updateState.state) {
        case 'checking':
          return '检查中…';
        case 'available':
          return `发现 v${updateState.version}`;
        case 'downloading':
          return `下载中 ${updateState.percent || 0}%`;
        case 'ready':
          return `v${updateState.version} 已就绪`;
        case 'latest':
          return '已是最新';
        case 'error':
          return '检查失败';
        case 'disabled':
          return '开发模式';
        default:
          return '';
      }
    });
    const updateHint = computed(() => {
      if (updateState.state === 'error') return updateState.message || '检查更新失败，稍后再试';
      if (updateState.state === 'disabled') return updateState.message || '开发模式不检查更新';
      if (updateState.state === 'ready') return '下载完成，重启后自动安装';
      if (updateState.state === 'available') return '正在后台下载，完成后会提示重启';
      if (updateState.state === 'latest') return '当前已是最新版本';
      return '';
    });

    async function checkUpdate() {
      updateState.state = 'checking';
      updateState.message = '';
      const r = await window.lb.checkUpdate();
      if (!r || !r.ok) {
        updateState.state = 'error';
        updateState.message = String((r && r.error) || '检查更新失败').slice(0, 200);
      }
    }

    async function installUpdate() {
      await window.lb.installUpdate();
    }

    /* -------- 设置 / 网络 -------- */
    function applyProxySettings(proxy) {
      const p = proxy || {};
      netForm.mode = p.mode || 'auto';
      netForm.url = p.url || '';
      netForm.perAgent = { ...(p.perAgent || {}) };
    }

    function openSettings() {
      applyProxySettings(settings.value.proxy);
      diag.value = null;
      modal.value = 'settings';
    }

    async function saveNet() {
      const proxy = { mode: netForm.mode, url: netForm.url.trim(), perAgent: { ...netForm.perAgent } };
      settings.value = (await window.lb.saveSettings({ proxy })) || settings.value;
      modal.value = null;
    }

    /** 切换界面语言：立即生效并落盘，不用重启 */
    async function setLang(v) {
      langPref.value = v;
      document.documentElement.lang = window.I18N.resolveLang(v) === 'zh' ? 'zh-CN' : 'en';
      settings.value = (await window.lb.saveSettings({ lang: v })) || settings.value;
    }

    function clearOverride(agentId) {
      const next = { ...netForm.perAgent };
      delete next[agentId];
      netForm.perAgent = next;
    }

    async function runDiagnose() {
      diagBusy.value = true;
      try {
        // 先把当前选择落盘，诊断才会测这一套
        await window.lb.saveSettings({
          proxy: { mode: netForm.mode, url: netForm.url.trim(), perAgent: { ...netForm.perAgent } },
        });
        diag.value = await window.lb.diagnose();
      } finally {
        diagBusy.value = false;
      }
    }

    async function useDirect() {
      // 只对这个 CLI 生效：海外 CLI 的代理不能被误伤（出口 IP 突变有风控风险）
      const aid = term.agentId;
      if (!aid) return;
      netForm.perAgent = { ...netForm.perAgent, [aid]: 'direct' };
      settings.value =
        (await window.lb.saveSettings({
          proxy: { mode: netForm.mode, url: netForm.url, perAgent: { ...netForm.perAgent } },
        })) || settings.value;
      term.netHint = false;
      restartTerm();
    }

    /* -------- 群聊 -------- */
    function openGroupNew() {
      groupForm.id = '';
      groupForm.name = '协作小组';
      groupForm.cwd = '';
      groupForm.memberIds = bots.value.slice(0, 2).map((b) => b.id);
      groupForm.leaderId = groupForm.memberIds[0] || '';
      groupForm.concurrent = false;
      groupForm.decisionsText = '';
      groupForm.worktree = true;
      groupForm.verifyCmd = '';
      groupForm.verifyMax = 3;
      groupForm.verifyOwner = '';
      modal.value = 'group';
    }

    function openGroupEdit(group) {
      groupForm.id = group.id;
      groupForm.name = group.name;
      groupForm.cwd = group.cwd || '';
      groupForm.memberIds = [...(group.memberIds || [])];
      groupForm.leaderId = group.leaderId || groupForm.memberIds[0] || '';
      groupForm.concurrent = !!group.concurrent;
      groupForm.decisionsText = (group.decisions || []).join('\n');
      groupForm.worktree = group.worktree !== false;
      groupForm.verifyCmd = group.verifyCmd || '';
      groupForm.verifyMax = group.verifyMax || 3;
      groupForm.verifyOwner = group.verifyOwner || '';
      modal.value = 'group';
    }

    function toggleMember(id) {
      const i = groupForm.memberIds.indexOf(id);
      if (i >= 0) groupForm.memberIds.splice(i, 1);
      else groupForm.memberIds.push(id);
      if (!groupForm.memberIds.includes(groupForm.leaderId)) groupForm.leaderId = groupForm.memberIds[0] || '';
    }

    async function pickGroupDir() {
      const dir = await window.lb.pickDir();
      if (dir) groupForm.cwd = dir;
    }

    /** 从模板一键建群：会自动创建各个角色的 Bot，再组成群 */
    async function useTemplate(t) {
      if (creatingTpl.value) return;
      creatingTpl.value = true;
      tplError.value = '';
      try {
        const r = await window.lb.createFromTemplate({ templateId: t.id, cwd: groupForm.cwd.trim() });
        if (!r || !r.ok) {
          tplError.value = (r && r.error) || '创建失败';
          return;
        }
        await refreshBots();
        groupForm.id = '';
        modal.value = null;
        await select(r.group.id);
      } catch (e) {
        tplError.value = String((e && e.message) || e);
      } finally {
        creatingTpl.value = false;
      }
    }

    async function saveGroup() {
      if (!canSaveGroup.value) return;
      const patch = {
        name: groupForm.name.trim(),
        cwd: groupForm.cwd.trim(),
        memberIds: [...groupForm.memberIds],
        leaderId: groupForm.leaderId || groupForm.memberIds[0],
        concurrent: !!groupForm.concurrent,
        worktree: !!groupForm.worktree,
        verifyCmd: groupForm.verifyCmd.trim(),
        verifyMax: Math.min(10, Math.max(1, Number(groupForm.verifyMax) || 3)),
        verifyOwner: groupForm.memberIds.includes(groupForm.verifyOwner) ? groupForm.verifyOwner : '',
        decisions: groupForm.decisionsText
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean),
      };
      if (groupForm.id) {
        const g = await window.lb.updateGroup(groupForm.id, patch);
        const i = groups.value.findIndex((x) => x.id === groupForm.id);
        if (i >= 0 && g) groups.value[i] = g;
        modal.value = null;
      } else {
        const g = await window.lb.createGroup(patch);
        groups.value = [g, ...groups.value.filter((x) => x.id !== g.id)];
        chats[g.id] = [];
        modal.value = null;
        await select(g.id);
      }
    }

    async function removeGroup() {
      if (!groupForm.id) return;
      await window.lb.deleteGroup(groupForm.id);
      groups.value = groups.value.filter((g) => g.id !== groupForm.id);
      if (activeId.value === groupForm.id) activeId.value = '';
      modal.value = null;
    }

    /* -------- @ 成员 -------- */
    function refreshMention() {
      const a = active.value;
      if (!a || a.kind !== 'group' || !ta.value) {
        mention.open = false;
        return;
      }
      const pos = ta.value.selectionStart || 0;
      const before = draft.value.slice(0, pos);
      const m = before.match(/@([^\s@]{0,16})$/);
      if (!m) {
        mention.open = false;
        return;
      }
      const q = m[1].toLowerCase();
      mention.query = m[1];
      mention.list = a.members.filter((x) => {
        if (!q) return true;
        return x.name.toLowerCase().includes(q) || String(agentNameOf(x) || '').toLowerCase().includes(q);
      });
      mention.index = 0;
      mention.open = mention.list.length > 0;
    }

    function applyMention(member) {
      const el = ta.value;
      const pos = el ? el.selectionStart || 0 : draft.value.length;
      const head = draft.value.slice(0, pos).replace(/@([^\s@]{0,16})$/, `@${member.name} `);
      draft.value = head + draft.value.slice(pos);
      mention.open = false;
      nextTick(() => {
        if (!el) return;
        el.focus();
        el.setSelectionRange(head.length, head.length);
        autoGrow();
      });
    }

    function onDraftInput() {
      autoGrow();
      refreshMention();
    }

    /** 群聊里某个 Bot 要登录时，定位到它 */
    function openTermFor(m) {
      const botId = (m && m.sender && m.sender.id) || active.value.id;
      const bot = bots.value.find((b) => b.id === botId);
      if (!bot) return;
      openTerm('login', bot.id);
    }

    function useStarter(text) {
      draft.value = text;
      nextTick(() => {
        autoGrow();
        if (ta.value) {
          ta.value.focus();
          ta.value.setSelectionRange(text.length, text.length);
        }
      });
    }

    function autoGrow() {
      const el = ta.value;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    }

    function onKey(e) {
      if (mention.open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = mention.list.length;
          const d = e.key === 'ArrowDown' ? 1 : -1;
          mention.index = (mention.index + d + n) % n;
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const m = mention.list[mention.index];
          if (m) applyMention(m);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          mention.open = false;
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    }

    function toggle(kind, mid, i) {
      const map = kind === 'think' ? openThink : openTool;
      const k = mid + '_' + i;
      map[k] = !map[k];
    }

    /* ---------- 内嵌终端 ---------- */
    function ensureXterm() {
      if (xterm || !termEl.value) return;
      xterm = new Terminal({
        fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
        fontSize: 12.5,
        lineHeight: 1.3,
        letterSpacing: 0,
        cursorBlink: true,
        scrollback: 4000,
        theme: {
          background: '#07090d',
          foreground: '#dbe1ec',
          cursor: '#a78bfa',
          selectionBackground: '#2b2545',
          black: '#1a1f28', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
          blue: '#60a5fa', magenta: '#a78bfa', cyan: '#22d3ee', white: '#dbe1ec',
          brightBlack: '#4a5567', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fcd34d',
          brightBlue: '#93c5fd', brightMagenta: '#c4b5fd', brightCyan: '#67e8f9', brightWhite: '#f4f7fc',
        },
      });
      fitAddon = new FitAddon.FitAddon();
      xterm.loadAddon(fitAddon);
      xterm.open(termEl.value);
      xterm.onData((d) => {
        if (term.id) window.lb.ptyWrite(term.id, d);
      });
      if (window.ResizeObserver) {
        termObserver = new ResizeObserver(() => fitTerm());
        termObserver.observe(termEl.value);
      }
    }

    function fitTerm() {
      if (!xterm || !termEl.value || !termEl.value.offsetHeight) return;
      try {
        fitAddon.fit();
        if (term.id) window.lb.ptyResize(term.id, xterm.cols, xterm.rows);
      } catch {}
    }

    async function openTerm(mode, botId) {
      if (!active.value) return;
      const targetBotId =
        botId ||
        (active.value.kind === 'bot' ? active.value.id : (active.value.members[0] || {}).id);
      if (!targetBotId) return;
      term.mode = mode === 'shell' ? 'shell' : 'login';
      term.err = '';
      term.netHint = false;
      term.open = true;
      await nextTick();
      ensureXterm();
      fitTerm();
      term.cwd = active.value.cwd || '';
      const r = await window.lb.ptyOpen(targetBotId, term.mode, xterm ? xterm.cols : 100, xterm ? xterm.rows : 26);
      if (!r.ok) {
        term.err = r.error;
        return;
      }
      termOut = '';
      const tb = bots.value.find((b) => b.id === targetBotId);
      term.agentId = tb ? tb.agentId : '';
      term.id = r.id;
      term.title = r.title;
      term.cwd = r.cwd;
      term.slashLogin = !!r.slashLogin;
      if (xterm) {
        xterm.clear();
        xterm.focus();
      }
      nextTick(fitTerm);
    }

    function sendSlashLogin() {
      if (term.id) window.lb.ptyWrite(term.id, '/login\r');
      if (xterm) xterm.focus();
    }

    function closeTerm() {
      if (term.id) window.lb.ptyClose(term.id);
      term.id = '';
      term.open = false;
      if (termObserver) {
        termObserver.disconnect();
        termObserver = null;
      }
      if (xterm) {
        xterm.dispose();
        xterm = null;
        fitAddon = null;
      }
    }

    function restartTerm() {
      const mode = term.mode;
      closeTerm();
      nextTick(() => openTerm(mode));
    }

    const openTerminal = (bot, login) => window.lb.openTerminal(bot.id, !!login);
    const openFolder = (bot) => window.lb.openFolder(bot.cwd);
    const openExternal = (url) => window.lb.openExternal(url);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') modal.value = null;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openNew();
      }
    });

    boot();

    return {
      agents, bots, activeId, chats, running, query, draft, modal, installing, installLog,
      openThink, openTool, stream, ta, form, perms, emojiList,
      active, filtered, installedAgents, notInstalled, installedCount, runningCount,
      messages, selectedAgent, canSave, permTip,
      agentOf, avatarStyle, ago, shortPath, shortModel, verLabel, permLabel, toolPreview, copy, copyText,
      quickStartCLIs,
      select, refreshBots, refreshAgents, openNew, openEdit, closeModals, pickAgent,
      install, pickDir, save, removeBot, send, stop, clearChat, exportChat, autoGrow, onKey, toggle,
      openTerminal, openFolder, openExternal, render: renderMd, onScroll, starters, useStarter,
      term, termEl, openTerm, closeTerm, restartTerm, sendSlashLogin, openTermFor,
      groups, groupForm, canSaveGroup, openGroupNew, openGroupEdit, toggleMember, pickGroupDir,
      saveGroup, removeGroup, mention, applyMention, onDraftInput, isBusy, convos, roomProgress, roomBusy,
      templates, creatingTpl, tplError, useTemplate,
      leaderName, placeholder, senderOf, agentNameOf, renderUserText,
      settings, netForm, netHint, diag, diagRows, diagBusy, openSettings, saveNet, runDiagnose, useDirect, overrideList, clearOverride,
      appInfo, updateState, updateLabel, updateHint, canCheckUpdate, checkUpdate, installUpdate,
      t, langPref, langCode, langOptions, setLang,
      runsView, openHop, openChanges, openRuns, setRunsTab, setUsageDays, toggleHop, usageDays, botShares,
      fmtTokens, fmtCost, fmtDur, fmtTime, endLabel, sumTok,
    };
  },
}).mount('#app');
