'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const { createParser, stripAnsi } = require('./parsers');
const { buildInvocation } = require('./agents');
const proxy = require('./net');

const isWin = process.platform === 'win32';

/* ---------------- 环境与可执行文件解析 ---------------- */
let dirsCache = { at: 0, list: [] };

function candidateDirs() {
  // 目录列表会做一堆 existsSync，缓存起来，别每次找 bin 都重算
  if (Date.now() - dirsCache.at < 30000 && dirsCache.list.length) return dirsCache.list;
  const list = computeDirs();
  dirsCache = { at: Date.now(), list };
  return list;
}

function computeDirs() {
  const dirs = (process.env.PATH || '').split(isWin ? ';' : ':').filter(Boolean);
  const home = os.homedir();
  const extra = [
    path.join(process.env.APPDATA || '', 'npm'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    'C:\\Program Files\\nodejs',
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter((d) => d && d !== '\\' && fs.existsSync(d));
  return [...new Set([...dirs, ...extra])];
}

/**
 * @param opts.tty     交互式终端：不要塞 NO_COLOR / CI，否则 CLI 会以为自己在 CI 里直接退出
 * @param opts.agentId 按 CLI 决定代理策略（国内直连、海外沿用系统代理）
 */
function buildEnv(opts = {}) {
  const env = { ...process.env };
  env.PATH = candidateDirs().join(isWin ? ';' : ':');
  delete env.CI;
  if (opts.tty) {
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
  } else {
    env.FORCE_COLOR = '0';
    env.NO_COLOR = '1';
  }
  // 代理策略统一在这里处理（按 CLI 区分，别把海外 CLI 的代理剥掉）
  proxy.applyProxy(env, opts.agentId);
  return env;
}

function resolveBin(bin) {
  if (!bin) return null;
  if (path.isAbsolute(bin) && fs.existsSync(bin)) return bin;
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of candidateDirs()) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

function quoteCmd(s) {
  const str = String(s);
  if (str === '') return '""';
  if (/[\s"&|<>^%()]/.test(str)) return `"${str.replace(/"/g, '\\"')}"`;
  return str;
}

function toCommandLine(file, args) {
  return [quoteCmd(file), ...args.map(quoteCmd)].join(' ');
}

function spawnCli(file, args, opts = {}) {
  const env = buildEnv({ agentId: opts.agentId });
  if (isWin) {
    return spawn(toCommandLine(file, args), {
      shell: true,
      cwd: opts.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawn(file, args, { cwd: opts.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {}
}

/* ---------------- 消息组装 ---------------- */
const AUTH_HINT =
  /(authentication required|authentication fail|please use \/login|not logged in|not signed in|please (log|sign) in|set an auth method|invalid api key|unauthorized|401|no credentials|未登录|未授权|请先登录)/i;

/** 找一个空闲的本地端口（有些 CLI 会监听固定端口，和宿主 app 打架） */
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

/** 把 JSON 化的错误串压成一句人话 */
function humanizeError(input) {
  let text = stripAnsi(String(input || '')).trim();
  if (!text) return '';
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text);
      text = (o.error && (o.error.message || (o.error.data && o.error.data.message))) || o.message || text;
    } catch {}
  }
  return String(text).trim();
}

function newMessage() {  return {
    id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    role: 'assistant',
    parts: [],
    status: 'streaming',
    createdAt: Date.now(),
    meta: {},
  };
}

class Runner {
  constructor({ emit, onSession, onMessage }) {
    this.emit = emit;
    this.onSession = onSession || (() => {});
    this.onMessage = onMessage || (() => {});
    this.running = new Map(); // botId -> { child, msg, timer, stderr }
  }

  isRunning(key) {
    return this.running.has(key);
  }

  stop(key) {
    const ctx = this.running.get(key);
    if (!ctx) return false;
    ctx.stopped = true;
    killTree(ctx.child);
    return true;
  }

  /**
   * @param target {id, cwd, model, permission, systemPrompt, sessionId}
   * @param opts   {key, sender}  key 决定会话归属（Bot 用 bot.id，群聊用 gid:botId）
   */
  async run(target, agent, prompt, opts = {}) {
    const key = opts.key || target.id;
    if (this.running.has(key)) return { ok: false, error: '正在执行上一条任务' };
    if (!agent) return { ok: false, error: '找不到对应的 CLI 配置' };

    const resolved = resolveBin(agent.bin);
    if (!resolved) {
      return { ok: false, error: `本机没有找到 ${agent.name}（${agent.bin}），请先安装或检查 PATH` };
    }

    const cwd = target.cwd && fs.existsSync(target.cwd) ? target.cwd : os.homedir();
    const inv = buildInvocation(agent, {
      prompt,
      sessionId: target.sessionId,
      resume: !!target.sessionId,
      model: target.model,
      permission: target.permission,
      systemPrompt: target.systemPrompt,
    });

    // 固定端口的 CLI（如 codebuddy 默认 61172）要和宿主 app 抢，这里换一个空闲的
    if (agent.needsPort) {
      const p = await freePort();
      if (p) inv.args.push('--port', String(p));
    }

    const msg = newMessage();
    if (opts.sender) msg.sender = opts.sender;
    const ctx = { child: null, msg, stderr: [], stopped: false, dirty: false, key };
    let doneResolve;
    ctx.done = new Promise((r) => (doneResolve = r));
    ctx.resolveDone = () => doneResolve(msg);
    const sink = this.makeSink(key, msg, ctx);

    let child;
    try {
      child = spawnCli(resolved, inv.args, { cwd, agentId: agent.id });
    } catch (e) {
      return { ok: false, error: `启动失败：${e.message}` };
    }
    ctx.child = child;
    this.running.set(key, ctx);
    this.emit('run:start', { key, msgId: msg.id });

    const parser = createParser(inv.proto, sink);

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) {
          try {
            parser(line);
          } catch (e) {
            sink.raw(line);
          }
        }
      }
      this.flush(key, ctx);
    });

    child.stderr.on('data', (chunk) => {
      const txt = chunk.toString('utf8');
      ctx.stderr.push(txt);
      if (ctx.stderr.length > 200) ctx.stderr.shift();
    });

    child.on('error', (err) => {
      sink.error(`启动失败：${err.message}`);
      this.finish(key, ctx, 1);
    });

    child.on('close', (code) => {
      if (buf.trim()) {
        try {
          parser(buf);
        } catch {}
        buf = '';
      }
      this.finish(key, ctx, code);
    });

    if (inv.stdin != null) {
      try {
        child.stdin.write(inv.stdin);
        child.stdin.end();
      } catch {}
    } else {
      try {
        child.stdin.end();
      } catch {}
    }

    return { ok: true, msg, done: ctx.done };
  }

  makeSink(key, msg, ctx) {
    const last = (type) => (msg.parts.length && msg.parts[msg.parts.length - 1].type === type ? msg.parts[msg.parts.length - 1] : null);
    const emitMsg = () => this.emit('run:msg', { key, msg });

    return {
      text: (delta) => {
        if (!delta) return;
        let p = last('text');
        if (!p) {
          p = { type: 'text', text: '' };
          msg.parts.push(p);
        }
        p.text += delta;
        ctx.dirty = true;
        emitMsg();
      },
      thinking: (delta) => {
        if (!delta) return;
        let p = last('thinking');
        if (!p) {
          p = { type: 'thinking', text: '' };
          msg.parts.push(p);
        }
        p.text += delta;
        ctx.dirty = true;
        emitMsg();
      },
      raw: (line) => {
        // 非结构化输出：当作正文（去掉重复空行）
        let p = last('text');
        if (!p) {
          p = { type: 'text', text: '' };
          msg.parts.push(p);
        }
        p.text += (p.text && !p.text.endsWith('\n') ? '\n' : '') + line;
        ctx.dirty = true;
        emitMsg();
      },
      toolStart: ({ id, name, input }) => {
        if (msg.parts.some((p) => p.type === 'tool' && p.id === id && id)) return;
        msg.parts.push({
          type: 'tool',
          id: id || `t_${Math.random().toString(36).slice(2, 8)}`,
          name: String(name || 'Tool'),
          input: typeof input === 'string' ? input : JSON.stringify(input || {}, null, 2).slice(0, 1500),
          status: 'running',
        });
        ctx.dirty = true;
        emitMsg();
      },
      toolEnd: ({ id, result, ok }) => {
        let p = msg.parts.find((x) => x.type === 'tool' && x.id === id);
        if (!p) {
          p = { type: 'tool', id: id || `t_${Math.random().toString(36).slice(2, 8)}`, name: 'Tool', input: '', status: 'running' };
          msg.parts.push(p);
        }
        p.result = String(result || '').slice(0, 4000);
        p.status = ok ? 'done' : 'error';
        ctx.dirty = true;
        emitMsg();
      },
      session: (sid) => {
        if (!sid) return;
        msg.sessionId = sid;
        this.onSession(key, sid);
      },
      meta: (obj) => {
        msg.meta = msg.meta || {};
        for (const [k, v] of Object.entries(obj || {})) {
          if (v !== undefined && v !== null && v !== '') msg.meta[k] = v;
        }
        emitMsg();
      },
      error: (message) => {
        const text = humanizeError(message);
        if (!text) return;
        if (!msg.error) msg.error = text;
        if (AUTH_HINT.test(text)) msg.meta = { ...(msg.meta || {}), authError: true };
        ctx.dirty = true;
        emitMsg();
      },
    };
  }

  flush(key, ctx) {
    if (!ctx.dirty) return;
    ctx.dirty = false;
    this.emit('run:msg', { key, msg: ctx.msg });
  }

  finish(key, ctx, code) {
    const msg = ctx.msg;
    this.running.delete(key);

    const errText = stripAnsi(ctx.stderr.join('')).trim();
    if (!msg.error && code !== 0 && !ctx.stopped) {
      msg.error = errText.slice(-1200) || `进程退出码 ${code}`;
      if (AUTH_HINT.test(msg.error)) msg.meta = { ...(msg.meta || {}), authError: true };
    }
    if (ctx.stopped) msg.meta = { ...(msg.meta || {}), stopped: true };

    // 登录态判断要扫全文：有些 CLI 把「需要登录」当普通输出打到 stdout
    const allText = msg.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') + '\n' + (msg.error || '');
    if (AUTH_HINT.test(allText)) msg.meta = { ...(msg.meta || {}), authError: true };

    // 只有错误、没有任何正文时，把错误抬成一条可读消息
    if (msg.error && !msg.parts.some((p) => p.type === 'text' && p.text.trim())) {
      msg.parts.push({ type: 'text', text: msg.error });
    }
    if (!msg.parts.length) {
      msg.parts.push({ type: 'text', text: ctx.stopped ? '（已停止）' : '（没有输出）' });
    }
    msg.status = msg.error && !ctx.stopped ? 'error' : 'done';
    msg.finishedAt = Date.now();
    msg.duration = msg.finishedAt - msg.createdAt;

    this.onMessage(key, msg);
    this.emit('run:done', { key, msg });
    if (ctx.resolveDone) ctx.resolveDone();
  }
}

module.exports = { Runner, resolveBin, spawnCli, buildEnv, killTree, toCommandLine };
