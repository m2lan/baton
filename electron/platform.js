'use strict';
/**
 * 平台差异集中在这里，别散落到各处。
 * 这个应用要在 Windows / macOS / Linux 三端跑，主要差异只有三件事：
 *   1. 可执行文件的后缀与查找目录
 *   2. 「系统终端」怎么拉起
 *   3. 官方安装脚本用什么解释器执行（PowerShell / sh）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

/** 可执行文件后缀（Windows 上 npm 装的是 .cmd 垫片） */
const BIN_EXTS = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];

/**
 * CLI 常驻但经常不在 PATH 里的目录。
 * mac 上 npm 全局默认在 /opt/homebrew/bin（Apple Silicon）或 /usr/local/bin（Intel），
 * linux 上常见 ~/.npm-global/bin 与 ~/.local/bin。
 */
/**
 * 版本管理器（nvm / fnm / asdf / mise）装的 Node 全局命令。
 * 它们的目录只在 shell 初始化脚本里加进 PATH，从 Finder / Dock 启动的应用拿不到。
 * nvm 有多个版本时新的在前：CLI 的 #!/usr/bin/env node 会用到排在最前面的 node。
 */
function versionManagerDirs(home) {
  const dirs = [];
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  const nvmRoot = path.join(nvmDir, 'versions', 'node');
  try {
    const vers = fs.readdirSync(nvmRoot).filter((v) => /^v\d/.test(v));
    const num = (v) => v.slice(1).split('.').map(Number);
    vers.sort((a, b) => {
      const x = num(a);
      const y = num(b);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] || 0) - (x[i] || 0);
      return 0;
    });
    // nvm alias default 指定的版本排最前（终端里默认用的就是它），比如「20」或「v20.19.4」
    let alias = '';
    try {
      alias = fs.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf8').trim().replace(/^v/, '');
    } catch {}
    const preferred = /^\d/.test(alias) ? vers.find((v) => v === `v${alias}` || v.startsWith(`v${alias}.`)) : '';
    if (preferred) vers.splice(vers.indexOf(preferred), 1), vers.unshift(preferred);
    for (const v of vers) dirs.push(path.join(nvmRoot, v, 'bin'));
  } catch {}
  dirs.push(
    path.join(home, '.fnm', 'aliases', 'default', 'bin'),
    path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims')
  );
  return dirs;
}

/**
 * 从登录 shell 读出用户真正的 PATH。
 * macOS 上从 Finder / Dock 启动的应用只有 /usr/bin:/bin:/usr/sbin:/sbin，
 * 用户在 .zshrc 里加的目录全都看不到。目录猜不全，最可靠的是直接问 shell。
 * 交互式 shell 可能卡在插件的更新提示上，所以加超时；拿不到就返回 null，靠 extraBinDirs 兜底。
 */
function loginShellPath(timeout = 6000) {
  if (isWin) return Promise.resolve(null);
  const shell = process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
  const mark = '__BATON_PATH__';
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' }, // oh-my-zsh 启动时别问要不要更新
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve(null);
    }, timeout);
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.match(new RegExp(`${mark}(.*?)${mark}`, 's'));
      resolve(m && m[1].trim() ? m[1].trim() : null);
    });
  });
}

function extraBinDirs() {
  const home = os.homedir();
  if (isWin) {
    return [
      path.join(process.env.APPDATA || '', 'npm'),
      path.join(home, 'AppData', 'Roaming', 'npm'),
      'C:\\Program Files\\nodejs',
      path.join(home, 'AppData', 'Local', 'Programs', 'nodejs'),
    ];
  }
  // 版本管理器的目录排最前：/usr/local/bin 里常有一个旧的系统 node，
  // 排在前面会让 CLI 的 #!/usr/bin/env node 用上它（实测 v18.16 跑不起 CodeBuddy）
  if (isMac) {
    return [
      ...versionManagerDirs(home),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.deno', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, 'Library', 'pnpm'),
    ];
  }
  return [
    ...versionManagerDirs(home),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/usr/local/bin',
    '/snap/bin',
    '/var/lib/flatpak/exports/bin',
  ];
}

/** 按平台挑出要执行的脚本内容（安装描述里可以分别给 win/mac/linux） */
function installScriptOf(inst) {
  if (!inst) return '';
  if (isWin) return inst.win || inst.cmd || inst.script || '';
  if (isMac) return inst.mac || inst.unix || inst.script || inst.cmd || '';
  return inst.linux || inst.unix || inst.script || inst.cmd || '';
}

/** 把安装描述翻译成「跑什么命令」。inst 里可以按平台给不同脚本。 */
function installCommand(inst, npmBin) {
  if (!inst) return null;
  if (inst.kind === 'npm') {
    return { file: npmBin || 'npm', args: ['install', '-g', inst.pkg] };
  }

  // 官方一行装脚本：win 走 PowerShell，其余走 sh
  if (inst.kind === 'script' || inst.kind === 'powershell') {
    const script = installScriptOf(inst);
    if (!script) return null;
    if (isWin) {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      };
    }
    return { file: '/bin/sh', args: ['-c', script] };
  }

  // 简单命令：aider 那种 python -m pip …
  if (inst.kind === 'cmd') {
    const script = installScriptOf(inst);
    if (!script) return null;
    if (isWin) return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', script] };
    return { file: '/bin/sh', args: ['-c', script] };
  }

  return null;
}

/** 在系统终端里打开某个目录（可选顺带执行一条命令） */
function openSystemTerminal(cwd, cmd) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();

  if (isWin) {
    const inner = `cd /d "${dir}"${cmd ? ` && ${cmd}` : ''}`;
    return spawn(process.env.ComSpec || 'cmd.exe', ['/c', `start "Baton" cmd /k "${inner}"`], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
  }

  if (isMac) {
    // Terminal.app / iTerm 都能吃 AppleScript 的 do script
    const line = `cd ${JSON.stringify(dir)}${cmd ? ` && ${cmd}` : ''}`;
    const esc = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Terminal"
      activate
      do script "${esc}"
    end tell`;
    return spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
  }

  // Linux：终端模拟器名字各家不同，按可用性挑一个
  const candidates = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', cmd || 'bash']],
    ['gnome-terminal', ['--', 'bash', '-lc', cmd || 'bash']],
    ['konsole', ['-e', 'bash', '-lc', cmd || 'bash']],
    ['xfce4-terminal', ['-e', `bash -lc '${(cmd || 'bash').replace(/'/g, "'\\''")}'`]],
    ['xterm', ['-e', 'bash', '-lc', cmd || 'bash']],
  ];
  for (const [bin, args] of candidates) {
    const found = (process.env.PATH || '')
      .split(':')
      .filter(Boolean)
      .some((d) => {
        try {
          return fs.statSync(path.join(d, bin)).isFile();
        } catch {
          return false;
        }
      });
    if (found) {
      return spawn(bin, args, { cwd: dir, detached: true, stdio: 'ignore' });
    }
  }
  return null;
}

/** 给界面用的平台标签 */
function label() {
  if (isWin) return 'Windows';
  if (isMac) return 'macOS';
  return 'Linux';
}

module.exports = {
  isWin,
  isMac,
  isLinux,
  BIN_EXTS,
  extraBinDirs,
  loginShellPath,
  installCommand,
  installScriptOf,
  openSystemTerminal,
  label,
};
