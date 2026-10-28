'use strict';
/**
 * 群聊里和 git 打交道的部分：每一跳改了哪些文件、并发时的 worktree 隔离。
 *
 * 原则：不碰用户的分支、暂存区和提交历史。
 *   - 快照用「临时 index + write-tree」：把整个工作区（含未跟踪文件，遵守 .gitignore）
 *     写成一棵 tree 对象，只往对象库里加东西，用户的 index 原样不动
 *   - worktree 一律 detached，跑完把差异以「未提交改动」应用回主目录，不建分支、不 commit
 *
 * 工作目录不是 git 仓库、或本机没装 git 时，所有函数返回 null，调用方当作「没有这项能力」处理。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { buildEnv, resolveBin } = require('./runner');
const { L } = require('./lang');

const MAX_BUF = 64 * 1024 * 1024;

function git(cwd, args, opts = {}) {
  const bin = resolveBin('git');
  if (!bin) return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: 'git not found' });
  const env = { ...buildEnv(), ...(opts.env || {}) };
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { cwd, env, maxBuffer: MAX_BUF, windowsHide: true, timeout: opts.timeout || 60000 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
    if (opts.input != null) {
      child.stdin.end(opts.input);
    }
  });
}

/** 所在仓库的根目录；不是仓库返回 null */
async function repoRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const r = await git(dir, ['rev-parse', '--show-toplevel']);
  return r.ok ? path.resolve(r.stdout.trim()) : null;
}

/**
 * 把整个工作区写成一棵 tree，返回它的 hash。
 * 先拷一份真实 index 当起点：里面有 stat 缓存，add -A 只需重新哈希改过的文件，大仓库也快。
 */
async function snapshot(root) {
  if (!root) return null;
  const tmp = path.join(os.tmpdir(), `baton-idx-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  try {
    const idx = await git(root, ['rev-parse', '--git-path', 'index']);
    if (idx.ok) {
      const real = path.resolve(root, idx.stdout.trim());
      if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    }
    const env = { GIT_INDEX_FILE: tmp };
    const add = await git(root, ['add', '-A'], { env, timeout: 120000 });
    if (!add.ok) return null;
    const tree = await git(root, ['write-tree'], { env });
    return tree.ok ? tree.stdout.trim() : null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/** 两棵 tree 之间改了哪些文件：[{status: 'A'|'M'|'D'|'R', path}] */
async function changedFiles(root, a, b) {
  if (!root || !a || !b || a === b) return [];
  const r = await git(root, ['diff', '--name-status', '--no-renames', a, b]);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status.charAt(0), path: rest.join('\t') };
    });
}

async function diffPatch(root, a, b) {
  const r = await git(root, ['diff', '--binary', '--no-renames', a, b]);
  return r.ok ? r.stdout : null;
}

/** 把补丁应用到工作区（不进暂存区）。先直接 apply，不行再试三方合并 */
async function applyPatch(root, patch) {
  if (!patch || !patch.trim()) return { ok: true, empty: true };
  let r = await git(root, ['apply', '--whitespace=nowarn', '-'], { input: patch });
  if (r.ok) return { ok: true };
  const r3 = await git(root, ['apply', '--3way', '--whitespace=nowarn', '-'], { input: patch });
  if (r3.ok) return { ok: true, threeWay: true };
  return { ok: false, error: (r3.stderr || r.stderr || '').trim().slice(-800) };
}

/**
 * 建一个和主目录当前状态一致的 detached worktree。
 * worktree 只能基于某个提交，所以先在 HEAD 上建，再把「HEAD → 主目录当前快照」的差异补进去，
 * 让成员看到的和主目录一模一样（包括用户还没提交的改动）。
 * @returns {{dir, base}} base 是主目录的快照，之后用它算这个成员改了什么
 */
async function addWorktree(root, dir, base) {
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  } catch {}
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return { ok: false, error: L('仓库还没有任何提交，无法创建 worktree', 'The repo has no commits yet, so a worktree cannot be created') };
  const add = await git(root, ['worktree', 'add', '--detach', dir, 'HEAD'], { timeout: 180000 });
  if (!add.ok) return { ok: false, error: add.stderr.trim().slice(-400) };
  const headTree = await git(root, ['rev-parse', 'HEAD^{tree}']);
  if (headTree.ok && base && headTree.stdout.trim() !== base) {
    const patch = await diffPatch(root, headTree.stdout.trim(), base);
    const ap = await applyPatch(dir, patch);
    if (!ap.ok) {
      await removeWorktree(root, dir);
      return { ok: false, error: L(`同步主目录未提交的改动失败：${ap.error}`, `Could not copy the main directory's uncommitted changes: ${ap.error}`) };
    }
  }
  return { ok: true, dir };
}

async function removeWorktree(root, dir) {
  await git(root, ['worktree', 'remove', '--force', dir]);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  await git(root, ['worktree', 'prune']);
}

/**
 * 收拾上次没清理掉的 worktree（跑到一半 app 被关掉时会留下）。
 * worktree 目录里的 .git 文件指回主仓库，借它找到主仓库再正规地 remove。
 */
async function cleanupStale(wtRoot) {
  let names = [];
  try {
    names = fs.readdirSync(wtRoot);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(wtRoot, name);
    const r = await git(dir, ['rev-parse', '--git-common-dir']);
    if (r.ok) {
      const common = path.resolve(dir, r.stdout.trim());
      await removeWorktree(path.dirname(common), dir);
    } else {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

module.exports = { git, cleanupStale, repoRoot, snapshot, changedFiles, diffPatch, applyPatch, addWorktree, removeWorktree };
