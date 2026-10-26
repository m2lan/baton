'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, screen } = require('electron');

/**
 * 打包后没有控制台，主进程异常会静默消失，用户只看到"双击没反应"。
 * 这里把启动期异常落到 userData/crash.log，排错时先看这个文件。
 */
function logLine(kind, msg) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'crash.log');
    // 自限体积：超过 256KB 就重开，避免长期运行把磁盘写满
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, '');
    } catch {}
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${kind}: ${msg}\n`);
  } catch {}
}
function logFatal(kind, err) {
  logLine(kind, (err && err.stack) || err);
}
process.on('uncaughtException', (e) => {
  logFatal('uncaughtException', e);
  console.error(e);
});
process.on('unhandledRejection', (e) => {
  logFatal('unhandledRejection', e);
  console.error(e);
});

const { CATALOG, getAgent } = require('./agents');
const store = require('./store');
const { Runner, spawnCli, resolveBin, killTree } = require('./runner');
const { Detector } = require('./detect');
const terminal = require('./pty');
const netCfg = require('./net');
const platform = require('./platform');
const { Room, findMentions } = require('./room');

// 调试用参数。打包后 Chromium 会对未知的 --xxx 直接报 "bad option" 退出，
// 所以同时支持环境变量（LOCALBOT_SHOT / LOCALBOT_SHOT_JS …），CI 与打包版都能用。
const opt = (name) => {
  const flag = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(flag));
  if (hit) return hit.slice(flag.length);
  const env = `LOCALBOT_${name.toUpperCase().replace(/-/g, '_')}`;
  return process.env[env] || '';
};
const SHOT = opt('shot') || null;
const SHOT_JS = opt('shot-js') || null;
const SHOT_DELAY = Number(opt('shot-delay') || 2600);
const WIN_SIZE = (opt('win-size') || '').split('x').map(Number);

let win = null;
let state = { bots: [], settings: {} };
let agentCache = [];
const ptyMeta = new Map(); // ptyId -> { botId, mode }
let detector = null;
const getDetector = () =>
  (detector ||= new Detector({ cacheFile: path.join(app.getPath('userData'), 'data', 'agents-cache.json') }));

/* ---------------- 事件发送 ---------------- */
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('evt', { channel, payload });
}

/* ---------------- Bot CRUD ---------------- */
function persist() {
  store.saveState(state);
}

function createBot(cfg) {
  const agent = getAgent(cfg.agentId);
  if (!agent) throw new Error('未知的 CLI');
  const bot = {
    id: `b_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: cfg.name || agent.name,
    emoji: cfg.emoji || agent.emoji,
    color: cfg.color || agent.color,
    agentId: agent.id,
    cwd: cfg.cwd || '',
    model: cfg.model || '',
    permission: cfg.permission || 'auto',
    systemPrompt: cfg.systemPrompt || '',
    sessionId: '',
    authed: null, // null=未知, true=已登录, false=需要登录
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preview: '',
  };
  state.bots.unshift(bot);
  persist();
  return bot;
}

function updateBot(id, patch) {
  const bot = state.bots.find((b) => b.id === id);
  if (!bot) return null;
  Object.assign(bot, patch, { updatedAt: Date.now() });
  persist();
  return bot;
}

/* ---------------- 群聊 ---------------- */
const isGroupKey = (key) => String(key || '').startsWith('g_');

function createGroup(cfg) {
  const memberIds = (cfg.memberIds || []).filter((id) => state.bots.some((b) => b.id === id));
  if (memberIds.length < 1) throw new Error('至少选一个 Bot');
  const group = {
    id: `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name: cfg.name || '新群聊',
    emoji: cfg.emoji || '👥',
    color: cfg.color || '#7c6bff',
    memberIds,
    leaderId: cfg.leaderId || memberIds[0],
    cwd: cfg.cwd || '',
    sessions: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    preview: '',
  };
  state.groups.unshift(group);
  persist();
  return group;
}

function updateGroup(id, patch) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return null;
  if (patch.memberIds) {
    patch.memberIds = patch.memberIds.filter((bid) => state.bots.some((b) => b.id === bid));
    if (!patch.memberIds.includes(g.leaderId)) patch.leaderId = patch.memberIds[0] || '';
    // 被移出的成员清掉它的群内会话，避免上下文错位
    for (const bid of Object.keys(g.sessions || {})) {
      if (!patch.memberIds.includes(bid)) delete g.sessions[bid];
    }
  }
  Object.assign(g, patch, { updatedAt: Date.now() });
  persist();
  return g;
}

/* ---------------- 安装 ---------------- */
let installing = null;

function installAgent(agentId) {
  const agent = getAgent(agentId);
  if (!agent) return { ok: false, error: '未知的 CLI' };
  const inst = agent.install || {};
  if (inst.kind === 'manual') return { ok: false, error: inst.hint || '需要手动安装' };
  if (installing) return { ok: false, error: '已有安装任务在进行中' };

  // 安装命令的差异（npm / PowerShell / sh）统一由 platform 决定
  const cmd = platform.installCommand(inst, resolveBin('npm'));
  if (!cmd) return { ok: false, error: inst.hint || '这个平台没有可用的自动安装方式' };

  installing = agentId;
  emit('install:log', {
    agentId,
    line: `$ ${inst.kind === 'npm' ? `npm install -g ${inst.pkg}` : platform.installScriptOf(inst)}`,
  });

  const child = spawnCli(cmd.file, cmd.args, { cwd: app.getPath('home') });
  const push = (chunk) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) emit('install:log', { agentId, line });
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', async (code) => {
    installing = null;
    emit('install:log', { agentId, line: code === 0 ? '✓ 安装完成' : `✗ 安装结束（退出码 ${code}）`, done: true, code });
    getDetector().invalidate(agentId);
    agentCache = await getDetector().full(CATALOG);
    emit('agents:update', agentCache);
  });
  return { ok: true };
}

/* ---------------- Runner ---------------- */
const runner = new Runner({
  emit,
  onSession: (key, sid) => {
    if (isGroupKey(key)) {
      const [gid, botId] = key.split(':');
      const g = state.groups.find((x) => x.id === gid);
      if (!g || !botId) return;
      g.sessions = g.sessions || {};
      if (g.sessions[botId] !== sid) {
        g.sessions[botId] = sid;
        persist();
      }
      return;
    }
    const bot = state.bots.find((b) => b.id === key);
    if (bot && bot.sessionId !== sid) {
      bot.sessionId = sid;
      bot.updatedAt = Date.now();
      persist();
      emit('bots:update', state.bots);
    }
  },
  onMessage: (key, msg) => {
    // 群聊的 key 是 gid:botId，落盘只认 gid（否则 Windows 会把冒号当成 NTFS 数据流）
    const chatKey = isGroupKey(key) ? key.split(':')[0] : key;
    store.appendMessage(chatKey, msg);
    const text = (msg.parts.find((p) => p.type === 'text' && p.text) || {}).text || '';
    if (isGroupKey(key)) {
      const g = state.groups.find((x) => x.id === chatKey);
      if (g) {
        g.updatedAt = Date.now();
        if (text) g.preview = text;
        persist();
      }
      return;
    }
    const bot = state.bots.find((b) => b.id === key);
    if (bot) {
      bot.updatedAt = Date.now();
      if (text) bot.preview = text;
      // 从执行结果反推登录态：报鉴权错误=没登录，正常出结果=已登录
      if (msg.meta && msg.meta.authError) bot.authed = false;
      else if (msg.status === 'done' && text) bot.authed = true;
      persist();
      emit('bots:update', state.bots);
    }
  },
});

const room = new Room({
  runner,
  store,
  getBot: (id) => state.bots.find((b) => b.id === id),
  emit,
  onChange: () => emit('rooms:update', state.groups),
});

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('app:init', () => {
    state = store.loadState();
    // v1 曾经把默认值写成全局直连（会剥掉海外 CLI 的代理），这里一次性迁回「智能」
    const savedProxy = state.settings.proxy;
    if (!savedProxy || savedProxy.v !== 2) {
      state.settings.proxy = {
        mode: 'auto',
        url: (savedProxy && savedProxy.url) || '',
        perAgent: (savedProxy && savedProxy.perAgent) || {},
        v: 2,
      };
      persist();
    }
    netCfg.setConfig(state.settings.proxy);
    if (!agentCache.length) {
      // 先用「装没装 + 缓存版本」瞬间返回，版本号后台补
      agentCache = getDetector().fast(CATALOG);
      getDetector()
        .full(CATALOG, (partial) => {
          agentCache = partial;
          emit('agents:update', partial);
        })
        .then((list) => {
          agentCache = list;
          emit('agents:update', list);
        })
        .catch(() => {});
    }
    return {
      bots: state.bots,
      groups: state.groups,
      settings: state.settings,
      agents: agentCache,
      catalog: CATALOG.length,
    };
  });

  ipcMain.handle('agents:detect', async () => {
    agentCache = await getDetector().full(CATALOG);
    emit('agents:update', agentCache);
    return agentCache;
  });

  ipcMain.handle('agents:install', (_e, id) => installAgent(id));

  ipcMain.handle('bots:create', (_e, cfg) => createBot(cfg));
  ipcMain.handle('bots:update', (_e, id, patch) => {
    const bot = updateBot(id, patch);
    emit('bots:update', state.bots);
    return bot;
  });
  ipcMain.handle('bots:delete', (_e, id) => {
    runner.stop(id);
    state.bots = state.bots.filter((b) => b.id !== id);
    store.deleteChat(id);
    for (const g of state.groups) {
      if ((g.memberIds || []).includes(id)) {
        g.memberIds = g.memberIds.filter((x) => x !== id);
        if (g.leaderId === id) g.leaderId = g.memberIds[0] || '';
        if (g.sessions) delete g.sessions[id];
      }
    }
    persist();
    emit('rooms:update', state.groups);
    return true;
  });

  ipcMain.handle('groups:create', (_e, cfg) => createGroup(cfg));
  ipcMain.handle('groups:update', (_e, id, patch) => {
    const g = updateGroup(id, patch);
    emit('rooms:update', state.groups);
    return g;
  });
  ipcMain.handle('groups:delete', (_e, id) => {
    room.stop(id);
    state.groups = state.groups.filter((g) => g.id !== id);
    store.deleteChat(id);
    persist();
    return true;
  });

  ipcMain.handle('chat:get', (_e, botId) => store.getMessages(botId));
  ipcMain.handle('chat:clear', (_e, key) => {
    room.stop(key);
    runner.stop(key);
    store.clearMessages(key);
    if (isGroupKey(key)) {
      const g = state.groups.find((x) => x.id === key);
      if (g) {
        g.sessions = {};
        g.preview = '';
        persist();
        emit('rooms:update', state.groups);
      }
    } else {
      updateBot(key, { sessionId: '', preview: '' });
      emit('bots:update', state.bots);
    }
    return true;
  });
  ipcMain.handle('chat:stop', (_e, key) => (isGroupKey(key) ? room.stop(key) : runner.stop(key)));

  ipcMain.handle('chat:send', async (_e, payload) => {
    const key = payload.key || payload.botId;
    const text = payload.text;

    if (isGroupKey(key)) {
      const group = state.groups.find((g) => g.id === key);
      if (!group) return { ok: false, error: '群聊不存在' };
      const userMsg = {
        id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        parts: [{ type: 'text', text }],
        status: 'done',
        createdAt: Date.now(),
        mentions: findMentions(text, group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter(Boolean)),
      };
      store.appendMessage(key, userMsg);
      group.updatedAt = Date.now();
      group.preview = text.slice(0, 60);
      persist();
      room.send(group, text, userMsg).catch((e) => room.pushSystem(key, `编排出错：${e.message}`));
      return { ok: true, userMsg, group: true };
    }

    const bot = state.bots.find((b) => b.id === key);
    if (!bot) return { ok: false, error: 'Bot 不存在' };
    const agent = getAgent(bot.agentId);
    const userMsg = {
      id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      parts: [{ type: 'text', text }],
      status: 'done',
      createdAt: Date.now(),
    };
    store.appendMessage(key, userMsg);
    bot.updatedAt = Date.now();
    bot.preview = text.slice(0, 60);
    persist();

    const r = await runner.run(bot, agent, text, { key });
    if (!r.ok) {
      const errMsg = {
        id: `m_${Date.now().toString(36)}err`,
        role: 'assistant',
        parts: [{ type: 'text', text: r.error }],
        status: 'error',
        createdAt: Date.now(),
      };
      store.appendMessage(key, errMsg);
      return { ok: false, error: r.error, userMsg, errMsg };
    }
    return { ok: true, userMsg, msgId: r.msg.id };
  });

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('shell:openFolder', (_e, dir) => {
    if (dir && fs.existsSync(dir)) shell.openPath(dir);
  });

  ipcMain.handle('shell:terminal', (_e, botId, login) => {
    const bot = state.bots.find((b) => b.id === botId);
    const agent = bot && getAgent(bot.agentId);
    const cwd = (bot && bot.cwd) || app.getPath('home');
    const cmd = login && agent && agent.login ? agent.login : '';
    const child = platform.openSystemTerminal(cwd, cmd);
    return { ok: !!child };
  });

  /* ---------- 内嵌终端 ---------- */
  ipcMain.handle('pty:open', async (_e, { botId, mode, cols, rows }) => {
    const bot = state.bots.find((b) => b.id === botId);
    const agent = bot && getAgent(bot.agentId);
    try {
      const realMode = mode === 'shell' ? 'shell' : 'login';
      const r = await terminal.open({ botId, bot, agent, mode: realMode, cols, rows });
      ptyMeta.set(r.id, { botId, mode: realMode });
      terminal.bind(
        r.id,
        (id, data) => emit('pty:data', { id, data }),
        (id, code) => emit('pty:exit', { id, code })
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('pty:write', (_e, id, data) => {
    terminal.write(id, data);
    return true;
  });
  ipcMain.handle('pty:resize', (_e, id, cols, rows) => {
    terminal.resize(id, cols, rows);
    return true;
  });
  ipcMain.handle('pty:close', (_e, id) => {
    terminal.close(id);
    const meta = ptyMeta.get(id);
    ptyMeta.delete(id);
    // 在登录终端里操作过，状态就以「未知」呈现，等下一次真实调用再判定
    if (meta && meta.mode === 'login') {
      const bot = state.bots.find((b) => b.id === meta.botId);
      if (bot && bot.authed !== null) {
        bot.authed = null;
        persist();
        emit('bots:update', state.bots);
      }
    }
    return true;
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    state.settings = { ...state.settings, ...patch };
    if (state.settings.proxy) {
      state.settings.proxy = { ...state.settings.proxy, v: 2 };
      netCfg.setConfig(state.settings.proxy);
    }
    persist();
    return state.settings;
  });

  ipcMain.handle('net:diagnose', async () => netCfg.diagnose());
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  // 默认尺寸跟随屏幕可用区域，避免小屏/高缩放下窗口超出屏幕
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const w = WIN_SIZE[0] || Math.min(1320, Math.max(1020, wa.width - 120));
  const h = WIN_SIZE[1] || Math.min(900, Math.max(660, wa.height - 100));
  win = new BrowserWindow({
    width: w,
    height: h,
    center: true,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#08090c',
    title: 'LocalBot',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: !SHOT,
    autoHideMenuBar: true,
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (SHOT || process.argv.includes('--dev')) {
    // 开发/截图模式下禁用缓存，避免改了前端看不到效果
    win.webContents.session.clearCache().catch(() => {});
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 加载失败在打包后是静默的（白屏），把原因记下来
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logFatal('did-fail-load', `${code} ${desc} ${url}`);
  });
  if (SHOT || process.argv.includes('--dev')) {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) logFatal('renderer-console', message);
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev') || SHOT) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  if (SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        win.webContents.setBackgroundThrottling(false);
        win.show();
        win.focus();
        try {
          if (SHOT_JS) {
            const r = await Promise.race([
              win.webContents.executeJavaScript(SHOT_JS).catch((e) => `ERR: ${e.message}`),
              new Promise((res) => setTimeout(() => res('TIMEOUT'), 60000)),
            ]);
            console.log('[shot-js]', r);
          }
          await new Promise((r) => setTimeout(r, 600));
          const img = await win.webContents.capturePage();
          fs.writeFileSync(SHOT, img.toPNG());
        } catch (e) {
          console.error(e);
        }
        app.quit();
      }, SHOT_DELAY);
    });
  }
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  if (process.platform === 'win32') app.setAppUserModelId('com.localbot.app');
  logLine('boot', `v${app.getVersion()} packaged=${app.isPackaged} shot=${SHOT || '-'} argv=${JSON.stringify(process.argv)}`);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const botId of runner.running.keys()) runner.stop(botId);
  terminal.closeAll();
  app.quit();
});
