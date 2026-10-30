'use strict';
/**
 * 附件与 @ 文件引用。
 *
 * 核心取舍：不把文件内容拼进 prompt。这些 CLI 本来就是 agent，自带读文件的工具，
 * 把文件放到它们读得到的位置、在 prompt 里给绝对路径，既省上下文，也不会因为
 * 一个 5MB 的日志把 prompt 撑爆。
 *
 * 放哪里：
 *   - 支持额外目录的 CLI（claude / codebuddy / codex 用 --add-dir，gemini 用
 *     --include-directories）直接读 userData 下的附件目录，不碰用户仓库。
 *   - 不支持的 CLI 退回到 <cwd>/.baton/attachments/，并写进 .git/info/exclude，
 *     只在本地忽略，不改用户的 .gitignore。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { app } = require('electron');
const { L } = require('./lang');

const MAX_ATTACH = 100 * 1024 * 1024; // 单个附件上限：再大复制一次要很久
const MAX_FILES = 20; // 一次会话里挂太多附件，prompt 和复制开销都不划算
const MAX_LIST = 20000; // 文件索引上限，超大仓库也不至于卡住
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.tif', '.tiff']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.turbo',
  'target', 'vendor', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'coverage',
]);

const isImage = (p) => IMAGE_EXT.has(path.extname(String(p || '')).toLowerCase());

const root = () => path.join(app.getPath('userData'), 'attachments');
const safeKey = (key) => String(key || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
const dirFor = (key) => path.join(root(), safeKey(key));

function metaOf(abs, st) {
  return {
    path: abs,
    name: path.basename(abs),
    size: st.size,
    kind: isImage(abs) ? 'image' : 'file',
  };
}

/* ---------------- 文件索引（@ 补全） ---------------- */

const listCache = new Map(); // cwd -> { at, files }
const inflight = new Map(); // cwd -> Promise，同一目录并发请求只扫一次
const LIST_TTL = 30_000;

/** git 仓库里用 ls-files（天然尊重 .gitignore），否则退回有上限的遍历 */
function gitFiles(cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'ls-files', '-co', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5000 },
      (err, out) => resolve(err ? null : String(out).split('\0').filter(Boolean).slice(0, MAX_LIST))
    );
  });
}

function walkFiles(cwd) {
  const out = [];
  const queue = [{ dir: cwd, depth: 0 }];
  while (queue.length && out.length < MAX_LIST) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_LIST) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= 6 || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        queue.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile()) {
        out.push(path.relative(cwd, abs).split(path.sep).join('/'));
      }
    }
  }
  return out;
}

function filesOf(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return Promise.resolve([]);
  const hit = listCache.get(cwd);
  if (hit && Date.now() - hit.at < LIST_TTL) return Promise.resolve(hit.files);
  if (inflight.has(cwd)) return inflight.get(cwd);
  const p = (async () => {
    const raw = (await gitFiles(cwd)) || walkFiles(cwd);
    // 没写 .gitignore 的仓库也会列出 node_modules，这里再兜一层
    const files = raw.filter((rel) => !rel.split('/').some((seg) => SKIP_DIRS.has(seg)));
    listCache.set(cwd, { at: Date.now(), files });
    return files;
  })().finally(() => inflight.delete(cwd));
  inflight.set(cwd, p);
  return p;
}

/** 输入框 @ 后面的候选：按「文件名开头 > 路径开头 > 包含」排，够快也够准 */
async function listFiles(cwd, query, limit = 40) {
  const all = await filesOf(cwd);
  const q = String(query || '').toLowerCase();
  const n = Math.max(1, Math.min(200, Number(limit) || 40));
  if (!q) return all.slice(0, n);
  const hits = [];
  for (const rel of all) {
    const lower = rel.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score = -1;
    if (base === q) score = 0;
    else if (base.startsWith(q)) score = 1;
    else if (lower.startsWith(q)) score = 2;
    else if (base.includes(q)) score = 3;
    else if (lower.includes(q)) score = 4;
    if (score >= 0) hits.push({ rel, score, len: rel.length });
  }
  hits.sort((a, b) => a.score - b.score || a.len - b.len);
  return hits.slice(0, n).map((h) => h.rel);
}

/** 文本里手打的 @路径（成员名由调用方排除）；是否真的是文件交给 resolveTokens 判断 */
function parseRefs(text, memberNames = []) {
  const out = [];
  const seen = new Set();
  // 中文标点也算边界：@Alice，你好 / @src/a.ts，然后
  const re = /@([^\s@，。！？；：、（）【】「」《》]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    // 末尾的标点不属于路径，例如「看看 @src/a.ts，然后」
    const token = m[1].replace(/[),.;:!?，。、；：！？）】》"'`]+$/, '');
    if (!token) continue;
    if (memberNames.includes(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * 把路径 token 解析成这个工作目录下真实存在的文件。
 * 按运行时的 cwd 解析（而不是发消息时的目录），worktree 里也能指到同一份文件。
 */
function resolveTokens(tokens, cwd) {
  if (!cwd) return [];
  const out = [];
  const seen = new Set();
  for (const token of tokens || []) {
    const abs = path.resolve(cwd, token);
    if (seen.has(abs)) continue;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      seen.add(abs);
      out.push(metaOf(abs, st));
    } catch {}
  }
  return out;
}

function resolveRefs(text, cwd, memberNames = []) {
  return resolveTokens(parseRefs(text, memberNames), cwd);
}

/* ---------------- 附件落盘 ---------------- */

function uniqueName(dir, base) {
  const ext = path.extname(base);
  const stem = path.basename(base, ext).replace(/[^\w一-龥.-]+/g, '_').slice(0, 60) || 'file';
  let name = `${Date.now().toString(36)}-${stem}${ext}`;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) {
    name = `${Date.now().toString(36)}-${i}-${stem}${ext}`;
  }
  return name;
}

function saveOne(key, src) {
  let st;
  try {
    st = fs.statSync(src);
  } catch {
    return { error: L(`${src} 不存在`, `${src} was not found`) };
  }
  if (!st.isFile()) return { error: L(`${path.basename(src)} 不是文件`, `${path.basename(src)} is not a file`) };
  if (st.size > MAX_ATTACH) {
    return { error: L(`${path.basename(src)} 超过 ${Math.round(MAX_ATTACH / 1024 / 1024)}MB`, `${path.basename(src)} is larger than ${Math.round(MAX_ATTACH / 1024 / 1024)}MB`) };
  }
  const dir = dirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, uniqueName(dir, path.basename(src)));
  try {
    fs.copyFileSync(src, dest);
  } catch (e) {
    return { error: e.message };
  }
  // 盘上是唯一文件名，界面和导出里仍显示用户原来的文件名
  return { ...metaOf(dest, fs.statSync(dest)), name: path.basename(src) };
}

/** 把用户选中的文件复制进会话附件目录（原文件不动） */
function attachPaths(key, paths) {
  const list = [];
  const errors = [];
  // 同一次里重复选到同一个文件只留一份；两个不同的文件同名是允许的
  const srcs = [];
  const seen = new Set();
  for (const p of paths || []) {
    if (!p) continue;
    const abs = path.resolve(String(p));
    if (seen.has(abs)) continue;
    seen.add(abs);
    srcs.push(abs);
  }
  if (srcs.length > MAX_FILES) {
    errors.push(L(`一次最多添加 ${MAX_FILES} 个附件`, `Up to ${MAX_FILES} files at a time`));
  }
  for (const src of srcs.slice(0, MAX_FILES)) {
    const r = saveOne(key, src);
    if (r && r.error) errors.push(r.error);
    else if (r) list.push(r);
  }
  return { attachments: list, errors };
}

/** 粘贴的图片 / 拖进来的内存数据，直接写盘 */
function attachBuffers(key, items) {
  const dir = dirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  const list = [];
  const errors = [];
  const all = (items || []).filter(Boolean);
  if (all.length > MAX_FILES) {
    errors.push(L(`一次最多添加 ${MAX_FILES} 个附件`, `Up to ${MAX_FILES} files at a time`));
  }
  for (const it of all.slice(0, MAX_FILES)) {
    try {
      const buf = Buffer.from(it.data);
      if (!buf.length) continue;
      if (buf.length > MAX_ATTACH) {
        errors.push(L(`${it.name || '图片'} 太大`, `${it.name || 'image'} is too large`));
        continue;
      }
      const label = it.name || 'paste.png';
      const name = uniqueName(dir, label);
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, buf);
      list.push({ ...metaOf(dest, fs.statSync(dest)), name: label });
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { attachments: list, errors };
}

/* ---------------- 运行时准备 ---------------- */

/** 这类 CLI 能不能直接读工作目录之外的文件 */
function extraDirFlag(agent) {
  if (!agent) return '';
  if (agent.proto === 'claude' || agent.proto === 'codex') return '--add-dir';
  if (agent.proto === 'gemini') return '--include-directories';
  return '';
}

const excluded = new Set();
/** 把 .baton/ 写进本地 exclude（不影响仓库里的 .gitignore） */
function excludeLocal(cwd) {
  if (excluded.has(cwd)) return;
  excluded.add(cwd);
  try {
    const p = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const file = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!cur.split('\n').some((l) => l.trim() === '.baton/')) {
      fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}.baton/\n`);
    }
  } catch {}
}

/**
 * 按 CLI 的能力准备附件：能加目录的原样用，不能的复制到工作目录下。
 * @returns {{files: object[], extraDirs: string[], images: string[]}}
 */
function prepare(agent, attachments, cwd, key) {
  const list = (attachments || []).filter((a) => a && a.path && fs.existsSync(a.path));
  if (!list.length) return { files: [], extraDirs: [], images: [] };
  // runner 在 cwd 为空时会退到用户主目录，这里保持一致
  const workdir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const dir = dirFor(key);
  if (extraDirFlag(agent)) {
    // codex 用 -i、claude / codebuddy 用 stream-json 图片块；两者都是原生图片输入
    const nativeImages = agent && (agent.proto === 'codex' || agent.proto === 'claude');
    return {
      files: list,
      extraDirs: [dir],
      images: nativeImages ? list.filter((a) => a.kind === 'image').map((a) => a.path) : [],
    };
  }
  const local = path.join(workdir, '.baton', 'attachments');
  try {
    fs.mkdirSync(local, { recursive: true });
    excludeLocal(workdir);
  } catch {
    return { files: list, extraDirs: [], images: [] };
  }
  const files = list.map((a) => {
    // 带上会话 key 前缀：清空 / 删除会话时才能把工作目录里的副本一并收掉
    const dest = path.join(local, `${safeKey(key)}-${path.basename(a.path)}`);
    try {
      if (!fs.existsSync(dest)) fs.copyFileSync(a.path, dest);
      return { ...a, path: dest };
    } catch {
      return a;
    }
  });
  return { files, extraDirs: [], images: [] };
}

/** prompt 里的附件段：只给路径，内容让 agent 自己按需读 */
function promptSection(files) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return '';
  const lines = list.map((f) => `- ${f.path}${f.kind === 'image' ? '（图片）' : ''}`);
  return `【附件】\n用户附带了以下文件，需要时直接读取（绝对路径，不要猜内容）：\n${lines.join('\n')}`;
}

/**
 * 回收会话附件目录里已经没人引用的文件：消息被裁掉（每个会话只留最近 600 条）、
 * 界面崩在发送之前，都会留下孤儿文件。
 * keep 是当前消息里还引用着的路径；minAge 兜底，别误删正在编辑、还没发出去的附件。
 */
function prune(key, keep, minAge = 30 * 60 * 1000) {
  const dir = dirFor(key);
  if (!isOwned(dir)) return 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const used = new Set((keep || []).map((p) => path.resolve(String(p))));
  const now = Date.now();
  let n = 0;
  for (const name of names) {
    const abs = path.join(dir, name);
    if (used.has(path.resolve(abs))) continue;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || now - st.mtimeMs < minAge) continue;
      fs.unlinkSync(abs);
      n++;
    } catch {}
  }
  return n;
}

/** 只允许清理由本模块创建的目录 */
function isOwned(p) {
  const abs = path.resolve(String(p || ''));
  return abs.startsWith(path.resolve(root()) + path.sep);
}

function clear(key, cwds = []) {
  const dir = dirFor(key);
  if (isOwned(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  // 不支持 add-dir 的 CLI，附件副本落在工作目录的 .baton/attachments 里，这里按 key 前缀收掉
  const prefix = `${safeKey(key)}-`;
  for (const cwd of cwds || []) clearLocal(cwd, prefix);
}

/** 删掉某个工作目录里属于这个会话的附件副本；目录空了就一起收 */
function clearLocal(cwd, prefix) {
  const local = path.join(String(cwd || ''), '.baton', 'attachments');
  let names;
  try {
    names = fs.readdirSync(local);
  } catch {
    return;
  }
  let left = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) {
      left++;
      continue;
    }
    try {
      fs.unlinkSync(path.join(local, name));
    } catch {
      left++;
    }
  }
  try {
    if (!left) {
      fs.rmdirSync(local);
      const parent = path.dirname(local);
      if (!fs.readdirSync(parent).length) fs.rmdirSync(parent);
    }
  } catch {}
}

/** 启动时清掉已经不存在的会话留下的附件目录（崩溃、手删数据都会留下） */
function sweep(keys) {
  const keep = new Set((keys || []).map(safeKey));
  let names;
  try {
    names = fs.readdirSync(root());
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (keep.has(name)) continue;
    try {
      fs.rmSync(path.join(root(), name), { recursive: true, force: true });
      n++;
    } catch {}
  }
  return n;
}

/** 丢掉还没发出去的附件（用户点了 × 或切换了会话） */
function discard(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  for (const p of list) {
    if (!isOwned(p)) continue;
    try {
      fs.unlinkSync(p);
      const dir = path.dirname(p);
      // 目录空了就一起收掉，别留一堆空壳
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {}
  }
  return true;
}

module.exports = {
  root,
  dirFor,
  isOwned,
  MAX_FILES,
  listFiles,
  parseRefs,
  resolveTokens,
  resolveRefs,
  attachPaths,
  attachBuffers,
  prepare,
  promptSection,
  clear,
  prune,
  sweep,
  discard,
};
