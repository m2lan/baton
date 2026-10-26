'use strict';
/**
 * 内嵌终端：用 node-pty 起一个真 PTY，让 CLI 的交互式登录（以及终端操作）
 * 直接在应用窗口里完成，而不是弹外部窗口。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('@lydell/node-pty');
const net = require('net');
const { resolveBin, buildEnv } = require('./runner');

const isWin = process.platform === 'win32';
const sessions = new Map(); // id -> { term, botId }
let seq = 0;

/**
 * Windows 下 .cmd/.bat 不能直接被 CreateProcess 拉起，要包一层 cmd.exe。
 * 注意：node-pty 自己会对参数做引号转义，这里再加引号会变成 cmd 认不出的东西，
 * 所以路径无空格时直接拼；有空格时改成「切到 CLI 所在目录 + 只传文件名」。
 */
function wrapCommand(file, args) {
  if (!isWin) return { file, args };
  const comspec = process.env.ComSpec || 'cmd.exe';
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args };

  if (/\s/.test(file)) {
    return {
      file: comspec,
      args: ['/d', '/s', '/c', [path.basename(file), ...args].join(' ')],
      cwd: path.dirname(file),
    };
  }
  return { file: comspec, args: ['/d', '/s', '/c', [file, ...args].join(' ')] };
}

/**
 * mode = login: 走该 CLI 的登录入口
 * mode = shell: 在 Bot 的工作目录里开一个系统终端
 */
function resolveTarget(bot, agent, mode) {
  const botCwd = bot && bot.cwd && fs.existsSync(bot.cwd) ? bot.cwd : os.homedir();

  if (mode === 'shell') {
    if (isWin) {
      const t = wrapCommand('powershell.exe', ['-NoLogo']);
      return { ...t, cwd: t.cwd || botCwd };
    }
    return { file: process.env.SHELL || 'bash', args: [], cwd: botCwd };
  }

  const bin = agent && resolveBin(agent.bin);
  if (!bin) throw new Error(`找不到 ${agent ? agent.name : 'CLI'}，请先安装`);

  const loginCmd = (agent.login || '').trim();
  const parts = loginCmd.split(/\s+/).filter(Boolean);
  const sub = parts[0] === agent.bin ? parts.slice(1) : parts;

  // 有明确子命令（如 codex login --device-auth）就直接跑
  if (sub.length) {
    const t = wrapCommand(bin, sub);
    return { ...t, cwd: t.cwd || botCwd, slashLogin: false };
  }

  // 没有子命令：进交互模式，由用户（或头部按钮）在终端里输入 /login
  const t = wrapCommand(bin, []);
  return { ...t, cwd: t.cwd || botCwd, slashLogin: agent.proto === 'claude' };
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() || {}).port || 0;
      srv.close(() => resolve(p));
    });
  });
}

async function open({ botId, bot, agent, mode, cols, rows }) {
  const target = resolveTarget(bot, agent, mode);
  const id = `p${++seq}`;
  const env = { ...buildEnv({ tty: true }), TERM: 'xterm-256color', COLORTERM: 'truecolor' };

  // 这类 CLI 的交互模式会复用「稳定的守护端口」（codebuddy 默认 61172），
  // 而宿主 app 往往正占着它；用环境变量指到空闲端口，比 --port 更可靠。
  if (agent && agent.needsPort) {
    const p = await freePort();
    if (p) {
      env.CODEBUDDY_DESKTOP_DAEMON_STABLE_PORT = String(p);
      env.CODEBUDDY_DAEMON_CONFIGURED_PORT = String(p);
    }
  }

  // 这类 CLI 的交互模式会复用「稳定的守护端口」（codebuddy 默认 61172），
  // 而宿主 app 往往正占着它；用环境变量指到空闲端口，比 --port 更可靠。
  if (agent && agent.needsPort) {
    const p = await freePort();
    if (p) {
      env.CODEBUDDY_DESKTOP_DAEMON_STABLE_PORT = String(p);
      env.CODEBUDDY_DAEMON_CONFIGURED_PORT = String(p);
    }
  }

  const term = pty.spawn(target.file, target.args, {
    name: 'xterm-256color',
    cols: Math.max(cols || 100, 20),
    rows: Math.max(rows || 26, 5),
    cwd: target.cwd,
    env,
  });

  sessions.set(id, { term, botId });

  return {
    id,
    cwd: target.cwd,
    title: mode === 'login' ? (agent ? agent.name : 'CLI') : '终端',
    slashLogin: !!target.slashLogin,
  };
}

function write(id, data) {
  const s = sessions.get(id);
  if (s) {
    try {
      s.term.write(data);
    } catch {}
  }
}

function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (s) {
    try {
      s.term.resize(Math.max(cols, 20), Math.max(rows, 5));
    } catch {}
  }
}

function close(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    s.term.kill();
  } catch {}
}

function closeAll() {
  for (const id of [...sessions.keys()]) close(id);
}

/** 把 PTY 的输出接到渲染进程 */
function bind(id, onData, onExit) {
  const s = sessions.get(id);
  if (!s) return;
  s.term.onData((d) => onData(id, d));
  s.term.onExit(({ exitCode }) => {
    sessions.delete(id);
    onExit(id, exitCode);
  });
}

module.exports = { open, write, resize, close, closeAll, bind };
