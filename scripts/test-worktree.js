'use strict';
/**
 * 任务级 worktree：串行链共用隔离目录，成功合并、失败保留、非 git 不启用、启动清理不误删现场。
 *   node scripts/test-worktree.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-wt-ud-'));
require('./test-hook');

const assert = require('assert');
const ROOT = path.join(__dirname, '..', 'electron');
const { Room } = require(path.join(ROOT, 'room.js'));
const runlog = require(path.join(ROOT, 'runlog.js'));
const git = require(path.join(ROOT, 'git.js'));
require(path.join(ROOT, 'lang.js')).setLang('zh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-wt-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(name) {
  const repo = fs.mkdtempSync(path.join(tmp, name));
  sh(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  sh(repo, ['add', '.']);
  sh(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  return repo;
}

/** 假 runner：按脚本写文件、返回文本；写文件是为了让 room 的快照 / 合并真的发生 */
class FakeRunner {
  constructor(script) {
    this.running = new Map();
    this.calls = [];
    this.script = script || [];
  }
  isRunning(k) {
    return this.running.has(k);
  }
  stop(k) {
    const c = this.running.get(k);
    if (!c) return false;
    c.stopped = true;
    c.finish();
    return true;
  }
  async run(target, agent, prompt, opts) {
    const step = this.script[this.calls.length] || {};
    this.calls.push({ botId: target.id, cwd: target.cwd, prompt });
    if (step.write) fs.writeFileSync(path.join(target.cwd, step.write), step.content || 'x');
    const msg = {
      id: `m${++seq}`,
      role: 'assistant',
      sender: opts.sender,
      parts: [{ type: 'text', text: step.text || 'ok' }],
      status: 'done',
      createdAt: Date.now(),
      meta: {},
    };
    let resolve;
    const done = new Promise((r) => (resolve = r));
    const ctx = {
      finished: false,
      finish: () => {
        if (ctx.finished) return;
        ctx.finished = true;
        this.running.delete(opts.key);
        msg.duration = 10;
        resolve(msg);
      },
    };
    this.running.set(opts.key, ctx);
    setTimeout(ctx.finish, 40);
    return { ok: true, msg, done };
  }
}

function makeRoom(runner, cwdA, cwdB) {
  const msgs = {};
  const store = {
    root: () => process.env.TEST_USERDATA,
    getMessages: (k) => msgs[k] || [],
    appendMessage: (k, m) => (msgs[k] = msgs[k] || []).push(m),
    saveMessages: (k, list) => (msgs[k] = list),
  };
  const bots = [
    { id: 'A', name: 'A', agentId: 'claude', cwd: cwdA || '', emoji: 'A', color: '#f00' },
    { id: 'B', name: 'B', agentId: 'claude', cwd: cwdB || '', emoji: 'B', color: '#0f0' },
  ];
  const room = new Room({
    runner,
    store,
    getBot: (id) => bots.find((b) => b.id === id),
    emit: () => {},
    onChange: () => {},
  });
  const group = {
    id: `g_${++seq}`,
    name: 'G',
    memberIds: ['A', 'B'],
    leaderId: 'A',
    cwd: '',
    decisions: [],
    sessions: {},
    verifyCmd: '',
    worktree: true,
  };
  return { room, group, msgs };
}

const worktreeOf = (key) => (runlog.list(key)[0] || {}).worktree || null;

(async () => {
  /* ---- 1. 成功：整条链在同一个 worktree 里跑，结束后合回主目录 ---- */
  {
    const repo = initRepo('repo-ok-');
    const runner = new FakeRunner([{ text: '改完了 @B', write: 'a.txt' }, { text: '完成', write: 'b.txt' }]);
    const { room, group } = makeRoom(runner);
    group.cwd = repo;
    group.id = 'g_wt_ok';
    await room.send(group, '@A 改点东西');
    await sleep(80);

    assert.strictEqual(runner.calls.length, 2, 'A → B 应各跑一次');
    for (const c of runner.calls) {
      assert(c.cwd.includes(path.join('worktrees', 'task-')), `应在任务 worktree 里跑，实际 ${c.cwd}`);
      assert.notStrictEqual(path.resolve(c.cwd), path.resolve(repo), '不该直接在主目录跑');
      assert.strictEqual(c.cwd, runner.calls[0].cwd, '整条链应共用同一个 worktree');
    }
    assert(fs.existsSync(path.join(repo, 'a.txt')), 'A 的改动应合回主目录');
    assert(fs.existsSync(path.join(repo, 'b.txt')), 'B 的改动应合回主目录');
    const wt = worktreeOf('g_wt_ok');
    assert(wt && wt.merged === true, '任务记录应标记已合并');
    assert(!fs.existsSync(wt.dir), '合并成功后 worktree 应被删除');
    const task = runlog.list('g_wt_ok')[0];
    assert.strictEqual(task.endReason, 'done');
    console.log('✓ 成功任务：隔离执行 + 自动合回');
  }

  /* ---- 2. 阻塞：不合并，保留现场 ---- */
  {
    const repo = initRepo('repo-block-');
    const runner = new FakeRunner([{ text: '【阻塞】缺权限', write: 'c.txt' }]);
    const { room, group } = makeRoom(runner);
    group.cwd = repo;
    group.id = 'g_wt_block';
    await room.send(group, '@A 改点东西');
    await sleep(80);

    assert(!fs.existsSync(path.join(repo, 'c.txt')), '阻塞的任务不该合回主目录');
    const wt = worktreeOf('g_wt_block');
    assert(wt && wt.merged === false && wt.kept === true, '应保留 worktree');
    assert(fs.existsSync(path.join(wt.dir, 'c.txt')), '现场改动应留在 worktree 里');
    assert.strictEqual(runlog.list('g_wt_block')[0].endReason, 'blocked');
    console.log('✓ 阻塞任务：不合并，保留现场');
  }

  /* ---- 3. 非 git 目录：不启用隔离，仍按原目录跑 ---- */
  {
    const plain = fs.mkdtempSync(path.join(tmp, 'plain-'));
    const runner = new FakeRunner([{ text: 'ok' }]);
    const { room, group } = makeRoom(runner);
    group.cwd = plain;
    group.id = 'g_wt_plain';
    await room.send(group, '@A 做点事');
    await sleep(60);

    assert.strictEqual(runner.calls[0].cwd, plain, '非 git 目录应直接用原目录');
    assert.strictEqual(worktreeOf('g_wt_plain'), null, '不该记录 worktree');
    console.log('✓ 非 git 目录：自动跳过隔离');
  }

  /* ---- 4. 成员有自己的目录：无法统一隔离，跳过 ---- */
  {
    const repo = initRepo('repo-mixed-');
    const other = fs.mkdtempSync(path.join(tmp, 'other-'));
    const runner = new FakeRunner([{ text: 'ok' }]);
    const { room, group } = makeRoom(runner, other);
    group.cwd = repo;
    group.id = 'g_wt_mixed';
    await room.send(group, '@A 做点事');
    await sleep(60);

    assert.strictEqual(worktreeOf('g_wt_mixed'), null, '成员目录不一致时不该建任务级 worktree');
    console.log('✓ 成员目录不一致：跳过隔离');
  }

  /* ---- 5. 未合并的 worktree 会被启动清理识别并保留 ---- */
  {
    const dirs = runlog.worktreeDirs();
    const kept = worktreeOf('g_wt_block');
    assert(dirs.includes(kept.dir), '启动清理应知道哪些目录不能删');

    const root2 = initRepo('repo-clean-');
    const base = await git.snapshot(root2);
    const wtRoot = path.join(tmp, 'wts-');
    const keep = path.join(wtRoot, 'keep-me');
    const drop = path.join(wtRoot, 'drop-me');
    const r1 = await git.addWorktree(root2, keep, base);
    const r2 = await git.addWorktree(root2, drop, base);
    assert(r1.ok && r2.ok, '测试用 worktree 应创建成功');
    await git.cleanupStale(wtRoot, [keep]);
    assert(fs.existsSync(keep), 'keep 里的现场不能被清掉');
    assert(!fs.existsSync(drop), '没有任务引用的残留应被清掉');
    await git.removeWorktree(root2, keep);
    console.log('✓ 启动清理跳过未处理的任务现场');
  }

  console.log('\n全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.stack);
  process.exit(1);
});