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
    const activeId = ref('');
    const chats = reactive({});
    const running = reactive({});
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
    const term = reactive({ open: false, id: '', title: '', cwd: '', mode: 'login', err: '', slashLogin: false });
    let xterm = null;
    let fitAddon = null;
    let termObserver = null;

    const form = reactive({
      agentId: '', name: '', emoji: '🤖', cwd: '', model: '', permission: 'auto', systemPrompt: '', id: '',
    });

    const perms = [
      { v: 'auto', label: '自动', tip: 'Bot 自己决定，不再问你 —— 适合明确任务' },
      { v: 'default', label: '谨慎', tip: '涉及写入/执行时按 CLI 默认策略询问' },
      { v: 'plan', label: '只读', tip: '只读规划，不改文件不执行命令' },
    ];

    /* -------- 派生 -------- */
    const active = computed(() => bots.value.find((b) => b.id === activeId.value) || null);
    const filtered = computed(() => {
      const q = query.value.trim().toLowerCase();
      if (!q) return bots.value;
      return bots.value.filter((b) => (b.name + ' ' + (b.preview || '')).toLowerCase().includes(q));
    });
    const installedAgents = computed(() => agents.value.filter((a) => a.installed));
    const notInstalled = computed(() => agents.value.filter((a) => !a.installed));
    const installedCount = computed(() => installedAgents.value.length);
    const runningCount = computed(() => Object.values(running).filter(Boolean).length);
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
    const copy = (m) => {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      navigator.clipboard.writeText(text);
    };

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
      bots.value = data.bots || [];
      window.lb.onEvent(async (channel, payload) => {
        if (channel === 'run:start') {
          running[payload.botId] = true;
          scrollBottom();
        } else if (channel === 'run:msg') {
          running[payload.botId] = true;
          upsert(payload.botId, payload.msg);
        } else if (channel === 'run:done') {
          running[payload.botId] = false;
          upsert(payload.botId, payload.msg);
          refreshBots();
        } else if (channel === 'bots:update') {
          const cur = activeId.value;
          bots.value = payload || [];
          if (cur && !bots.value.find((b) => b.id === cur)) activeId.value = '';
        } else if (channel === 'agents:update') {
          agents.value = payload || [];
          for (const a of agents.value) if (a.installed) delete installing[a.id];
        } else if (channel === 'pty:data') {
          if (payload.id === term.id && xterm) xterm.write(payload.data);
        } else if (channel === 'pty:exit') {
          if (payload.id === term.id && xterm) {
            xterm.write('\r\n\x1b[38;5;243m[进程已退出，点「重启」可再来一次]\x1b[0m\r\n');
          }
        } else if (channel === 'install:log') {
          if (payload.line) installLog.value.push(payload.line);
          if (payload.done) delete installing[payload.agentId];
        }
      });

      const first = bots.value[0];
      if (first) await select(first.id);
    }

    async function refreshBots() {
      const data = await window.lb.init();
      bots.value = data.bots || [];
    }

    async function refreshAgents() {
      agents.value = await window.lb.detect();
    }

    async function select(id) {
      if (term.open && id !== activeId.value) closeTerm();
      activeId.value = id;
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
      const bot = active.value;
      if (running[bot.id]) return;
      draft.value = '';
      autoGrow();
      stick.value = true;
      const r = await window.lb.send(bot.id, text);
      if (r.userMsg) upsert(bot.id, r.userMsg);
      if (r.errMsg) upsert(bot.id, r.errMsg);
      scrollBottom(true);
      if (r.error) console.warn(r.error);
    }

    function stop() {
      if (active.value) window.lb.stop(active.value.id);
    }

    async function clearChat() {
      if (!active.value) return;
      await window.lb.clear(active.value.id);
      chats[active.value.id] = [];
      const b = bots.value.find((x) => x.id === active.value.id);
      if (b) { b.sessionId = ''; b.preview = ''; }
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

    async function openTerm(mode) {
      if (!active.value) return;
      term.mode = mode === 'shell' ? 'shell' : 'login';
      term.err = '';
      term.open = true;
      await nextTick();
      ensureXterm();
      fitTerm();
      term.cwd = active.value.cwd || '';
      const r = await window.lb.ptyOpen(active.value.id, term.mode, xterm ? xterm.cols : 100, xterm ? xterm.rows : 26);
      if (!r.ok) {
        term.err = r.error;
        return;
      }
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
      agentOf, avatarStyle, ago, shortPath, shortModel, verLabel, permLabel, toolPreview, copy,
      select, refreshBots, refreshAgents, openNew, openEdit, closeModals, pickAgent,
      install, pickDir, save, removeBot, send, stop, clearChat, autoGrow, onKey, toggle,
      openTerminal, openFolder, openExternal, render: renderMd, onScroll, starters, useStarter,
      term, termEl, openTerm, closeTerm, restartTerm, sendSlashLogin,
    };
  },
}).mount('#app');
