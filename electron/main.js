'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, screen } = require('electron');
const { CATALOG, getAgent } = require('./agents');
const store = require('./store');
const { Runner, spawnCli, resolveBin, killTree } = require('./runner');
const { Detector } = require('./detect');
const terminal = require('./pty');
const { Room, findMentions } = require('./room');

const SHOT = (process.argv.find((a) => a.startsWith('--shot=')) || '').split('=')[1] || null;
const SHOT_JS = (process.argv.find((a) => a.startsWith('--shot-js=')) || '').split('=').slice(1).join('=') || null;
const SHOT_DELAY = Number((process.argv.find((a) => a.startsWith('--shot-delay=')) || '').split('=')[1] || 2600);
const WIN_SIZE = ((process.argv.find((a) => a.startsWith('--win-size=')) || '').split('=')[1] || '').split('x').map(Number);

let win = null;
let state = { bots: [], settings: {} };
let agentCache = [];
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

  let file;
  let args;
  if (inst.kind === 'npm') {
    file = resolveBin('npm') || 'npm';
    args = ['install', '-g', inst.pkg];
  } else if (inst.kind === 'powershell') {
    file = 'powershell.exe';
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inst.cmd];
  } else {
    file = inst.cmd;
    args = [];
  }

  installing = agentId;
  emit('install:log', { agentId, line: `$ ${inst.kind === 'npm' ? `npm install -g ${inst.pkg}` : inst.cmd}` });

  const child = spawnCli(file, args, { cwd: app.getPath('home') });
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
      persist();
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

  ipcMain.handle('chat:send', (_e, payload) => {
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

    const r = runner.run(bot, agent, text, { key });
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
    const cmd = login && agent && agent.login ? `"${agent.login}"` : '';
    const inner = `cd /d "${cwd}"${cmd ? ` && ${cmd}` : ''}`;
    if (process.platform === 'win32') {
      spawnCli('cmd.exe', ['/c', `start "LocalBot" cmd /k "${inner}"`], {});
    } else {
      spawnCli('x-terminal-emulator', ['-e', `bash -lc 'cd "${cwd}" && ${cmd || 'bash'}'`], {});
    }
    return true;
  });

  /* ---------- 内嵌终端 ---------- */
  ipcMain.handle('pty:open', (_e, { botId, mode, cols, rows }) => {
    const bot = state.bots.find((b) => b.id === botId);
    const agent = bot && getAgent(bot.agentId);
    try {
      const r = terminal.open({ botId, bot, agent, mode: mode === 'shell' ? 'shell' : 'login', cols, rows });
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
    return true;
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    state.settings = { ...state.settings, ...patch };
    persist();
    return state.settings;
  });
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
