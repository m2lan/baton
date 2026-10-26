'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createParser, stripAnsi } = require('./parsers');
const { buildInvocation } = require('./agents');

const isWin = process.platform === 'win32';

/* ---------------- 环境与可执行文件解析 ---------------- */
function candidateDirs() {
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

function buildEnv() {
  const env = { ...process.env };
  env.PATH = candidateDirs().join(isWin ? ';' : ':');
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  env.CI = '0';
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
  const env = buildEnv();
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

/* ---------------- 版本探测 ---------------- */
function readVersion(bin) {
  const resolved = resolveBin(bin);
  if (!resolved) return null;
  try {
    const r = spawnSync(toCommandLine(resolved, ['--version']), {
      shell: true,
      encoding: 'utf8',
      timeout: 12000,
      windowsHide: true,
      input: '',
    });
    const out = stripAnsi(`${r.stdout || ''}${r.stderr || ''}`).trim();
    const m = out.match(/\d+\.\d+(\.\d+)?[-\w.]*/);
    return m ? m[0] : out.split(/\r?\n/)[0].slice(0, 40) || 'installed';
  } catch {
    return 'installed';
  }
}

function detectAgents(catalog) {
  return catalog.map((a) => {
    const p = resolveBin(a.bin);
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
      models: a.models || [],
      session: !!a.session,
      permission: !!a.permission,
      installed: !!p,
      path: p || '',
      version: p ? readVersion(a.bin) : '',
    };
  });
}

/* ---------------- 消息组装 ---------------- */
const AUTH_HINT =
  /(authentication required|authentication fail|please use \/login|not logged in|not signed in|please (log|sign) in|set an auth method|invalid api key|unauthorized|401|no credentials|未登录|未授权|请先登录)/i;

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

  isRunning(botId) {
    return this.running.has(botId);
  }

  stop(botId) {
    const ctx = this.running.get(botId);
    if (!ctx) return false;
    ctx.stopped = true;
    killTree(ctx.child);
    return true;
  }

  run(bot, agent, prompt) {
    if (this.running.has(bot.id)) return { ok: false, error: '这个 Bot 正在执行上一条任务' };
    if (!agent) return { ok: false, error: '找不到对应的 CLI 配置' };

    const resolved = resolveBin(agent.bin);
    if (!resolved) {
      return { ok: false, error: `本机没有找到 ${agent.name}（${agent.bin}），请先安装或检查 PATH` };
    }

    const cwd = bot.cwd && fs.existsSync(bot.cwd) ? bot.cwd : os.homedir();
    const inv = buildInvocation(agent, {
      prompt,
      sessionId: bot.sessionId,
      resume: !!bot.sessionId,
      model: bot.model,
      permission: bot.permission,
      systemPrompt: bot.systemPrompt,
    });

    const msg = newMessage();
    const ctx = { child: null, msg, stderr: [], stopped: false, dirty: false };
    const sink = this.makeSink(bot, msg, ctx);

    let child;
    try {
      child = spawnCli(resolved, inv.args, { cwd });
    } catch (e) {
      return { ok: false, error: `启动失败：${e.message}` };
    }
    ctx.child = child;
    this.running.set(bot.id, ctx);
    this.emit('run:start', { botId: bot.id, msgId: msg.id });

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
      this.flush(bot, ctx);
    });

    child.stderr.on('data', (chunk) => {
      const txt = chunk.toString('utf8');
      ctx.stderr.push(txt);
      if (ctx.stderr.length > 200) ctx.stderr.shift();
    });

    child.on('error', (err) => {
      sink.error(`启动失败：${err.message}`);
      this.finish(bot, ctx, 1);
    });

    child.on('close', (code) => {
      if (buf.trim()) {
        try {
          parser(buf);
        } catch {}
        buf = '';
      }
      this.finish(bot, ctx, code);
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

    return { ok: true, msg };
  }

  makeSink(bot, msg, ctx) {
    const last = (type) => (msg.parts.length && msg.parts[msg.parts.length - 1].type === type ? msg.parts[msg.parts.length - 1] : null);
    const emitMsg = () => this.emit('run:msg', { botId: bot.id, msg });

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
        this.onSession(bot.id, sid);
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

  flush(bot, ctx) {
    if (!ctx.dirty) return;
    ctx.dirty = false;
    this.emit('run:msg', { botId: bot.id, msg: ctx.msg });
  }

  finish(bot, ctx, code) {
    const msg = ctx.msg;
    this.running.delete(bot.id);

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

    this.onMessage(bot.id, msg);
    this.emit('run:done', { botId: bot.id, msg });
  }
}

module.exports = { Runner, detectAgents, resolveBin, spawnCli, buildEnv, killTree };
