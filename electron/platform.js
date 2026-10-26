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
  if (isMac) {
    return [
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
  installCommand,
  installScriptOf,
  openSystemTerminal,
  label,
};
