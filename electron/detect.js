'use strict';
/**
 * CLI 探测：先给「装没装」（纯文件系统，毫秒级），版本号异步补上并落盘缓存。
 * 这样打开窗口不再等一堆 CLI 启动 --version。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveBin, buildEnv, toCommandLine } = require('./runner');
const { stripAnsi } = require('./parsers');

const PROBE_TIMEOUT = 4500;
const CONCURRENCY = 4;

/** 把 install 配置换算成当前平台上可直接复制执行的一条命令 */
function installCmdOf(inst) {
  if (!inst) return '';
  if (inst.kind === 'npm') return `npm i -g ${inst.pkg}`;
  if (inst.kind === 'script' || inst.kind === 'cmd') {
    const p = process.platform;
    if (p === 'win32') return inst.win || inst.cmd || '';
    if (p === 'darwin') return inst.mac || inst.unix || inst.cmd || '';
    return inst.linux || inst.unix || inst.cmd || '';
  }
  return '';
}

function baseInfo(a) {
  return {
    id: a.id,
    name: a.name,
    emoji: a.emoji,
    color: a.color,
    tag: a.tag,
    desc: a.desc,
    docs: a.docs,
    installKind: a.install && a.install.kind,
    installHint: a.install && (a.install.hint || a.install.pkg || a.install.cmd),
    installCmd: installCmdOf(a.install),
    installUrl: a.install && a.install.url,
    loginHint: a.login || '',
    models: a.models || [],
    session: !!a.session,
    permission: !!a.permission,
  };
}

function parseVersion(text) {
  const out = stripAnsi(String(text || '')).trim();
  if (!out) return '';
  const m = out.match(/\d+\.\d+(\.\d+)?[-\w.]*/);
  if (m) return m[0].replace(/[.\s]+$/, '');
  const first = out.split(/\r?\n/)[0].trim();
  return first.slice(0, 40);
}

class Detector {
  constructor({ cacheFile }) {
    this.cacheFile = cacheFile;
    this.cache = null;
    this.running = null;
  }

  readCache() {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) || {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  writeCache() {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch {}
  }

  /** 先用缓存里记下的路径（一次 stat），失效了再走 PATH 扫描 */
  locate(bin, cacheEntry) {
    if (cacheEntry && cacheEntry.path) {
      try {
        if (fs.statSync(cacheEntry.path).isFile()) return cacheEntry.path;
      } catch {}
    }
    return resolveBin(bin);
  }

  /** 立即返回：只做路径确认 + 读缓存里的版本号 */
  fast(catalog) {
    const cache = this.readCache();
    return catalog.map((a) => {
      const p = this.locate(a.bin, cache[a.id]);
      const hit = p ? cache[a.id] : null;
      const fresh = hit && hit.path === p ? hit.version : '';
      return { ...baseInfo(a), installed: !!p, path: p || '', version: fresh || '' };
    });
  }

  /** 异步补版本：命中缓存（路径+mtime 未变）直接跳过 */
  async full(catalog, onPartial) {
    const cache = this.readCache();
    const list = catalog.map((a) => {
      const p = this.locate(a.bin, cache[a.id]);
      return { ...baseInfo(a), installed: !!p, path: p || '', version: '', _bin: a.bin, _mtime: 0 };
    });

    const tasks = [];
    for (const item of list) {
      if (!item.installed) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(item.path).mtimeMs;
      } catch {}
      item._mtime = mtime;
      const hit = cache[item.id];
      if (hit && hit.path === item.path && hit.mtime === mtime && hit.version) {
        item.version = hit.version;
        continue;
      }
      tasks.push(item);
    }

    const emitPartial = () => {
      if (typeof onPartial === 'function') onPartial(this.publicList(list));
    };
    if (!tasks.length) return this.publicList(list);

    // 限制并发，避免同时拉起一堆 CLI
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const item = tasks[cursor++];
        const version = await this.probe(item.path);
        if (version) {
          item.version = version;
          cache[item.id] = { path: item.path, mtime: item._mtime, version, ts: Date.now() };
          emitPartial();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
    this.writeCache();
    return this.publicList(list);
  }

  probe(file) {
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v || 'installed');
      };
      let child;
      try {
        child = spawn(toCommandLine(file, ['--version']), {
          shell: true,
          windowsHide: true,
          env: buildEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return resolve('installed');
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        done(parseVersion(out) || 'installed');
      }, PROBE_TIMEOUT);

      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', () => done('installed'));
      child.on('close', () => done(parseVersion(out)));
    });
  }

  publicList(list) {
    return list.map(({ _bin, _mtime, ...rest }) => rest);
  }

  /** 装完新 CLI 后强制重探某一个 */
  invalidate(id) {
    const cache = this.readCache();
    if (cache[id]) {
      delete cache[id];
      this.writeCache();
    }
  }
}

module.exports = { Detector, parseVersion, installCmdOf };
