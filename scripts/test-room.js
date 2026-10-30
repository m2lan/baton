'use strict';
/**
 * 群聊编排的回归测试：stop→send 竞态、交班链、进程回收、验收、上下文预算、Windows 转义。
 *   node scripts/test-room.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-room-ud-'));
require('./test-hook');

const assert = require('assert');
const ROOT = path.join(__dirname, '..', 'electron');
const { Room } = require(path.join(ROOT, 'room.js'));
const runnerMod = require(path.join(ROOT, 'runner.js'));
const runlog = require(path.join(ROOT, 'runlog.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-room-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

/** 假 runner：可控回复文本；stop() 立即结算，模拟被杀的 CLI */
class FakeRunner {
  constructor(replies) {
    this.running = new Map();
    this.calls = [];
    this.replies = replies || [];
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
  async run(target, agentName, prompt, opts) {
    const n = this.calls.push({ botId: target.id, key: opts.key, prompt }) - 1;
    const text = this.replies[n] || 'ok';
    const msg = {
      id: `m${++seq}`,
      role: 'assistant',
      sender: opts.sender,
      parts: [{ type: 'text', text }],
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
    setTimeout(ctx.finish, 80);
    return { ok: true, msg, done };
  }
}

function makeRoom(runner) {
  const msgs = {};
  const store = {
    getMessages: (k) => msgs[k] || [],
    appendMessage: (k, m) => (msgs[k] = msgs[k] || []).push(m),
    saveMessages: (k, list) => (msgs[k] = list),
  };
  const bots = [
    { id: 'A', name: 'A', agentId: 'claude', cwd: '', emoji: 'A', color: '#f00' },
    { id: 'B', name: 'B', agentId: 'claude', cwd: '', emoji: 'B', color: '#0f0' },
  ];
  const events = [];
  const room = new Room({
    runner,
    store,
    getBot: (id) => bots.find((b) => b.id === id),
    emit: (ch, payload) => events.push({ ch, payload }),
    onChange: () => {},
  });
  const group = {
    id: 'g_test',
    name: 'G',
    memberIds: ['A', 'B'],
    leaderId: 'A',
    cwd: '',
    decisions: [],
    sessions: {},
    verifyCmd: '',
  };
  return { room, group, events, msgs };
}

(async () => {
  /* ---- 1. stop 之后马上再发：旧一轮不能接着跑 ---- */
  {
    const runner = new FakeRunner(['@B 继续', 'ok', 'ok']);
    const { room, group } = makeRoom(runner);
    const p1 = room.send(group, '@A 第一句');
    await sleep(15); // 第一棒已经跑起来
    room.stop(group.id);
    const p2 = room.send(group, '@A 第二句');
    await Promise.all([p1, p2]);
    await sleep(200);

    assert.deepStrictEqual(runner.calls.map((c) => c.botId), ['A', 'A'], `旧一轮不该继续交班，实际调用：${runner.calls.map((c) => c.botId)}`);
    assert.strictEqual(room.busy.size, 0, 'busy 应该被清空');
    assert.strictEqual(room.live.size, 0, 'live 应该被清空');
    console.log('✓ stop 后立即再发：旧一轮已收尾，未跑 B');
  }

  /* ---- 2. 正常交班链仍然工作，runlog 记满两跳 ---- */
  {
    const runner = new FakeRunner(['@B 请接手', '完成']);
    const { room, group } = makeRoom(runner);
    group.id = 'g_chain';
    await room.send(group, '@A 做个事');
    await sleep(100);

    assert.deepStrictEqual(runner.calls.map((c) => c.botId), ['A', 'B'], '正常交班链应跑 A → B');
    const tasks = runlog.list('g_chain');
    assert.strictEqual(tasks.length, 1, '应记录一条任务');
    assert.strictEqual(tasks[0].hops.length, 2, '应记录两跳');
    assert.strictEqual(tasks[0].totals.hops, 2);
    console.log('✓ 正常交班链：A → B，runlog 两跳');
  }

  /* ---- 3. 只认 SIGTERM 的进程：3 秒后应被 SIGKILL 收掉 ---- */
  if (process.platform === 'win32') {
    console.log('- 跳过 SIGTERM 升级（Windows 没有信号）');
  } else {
    const ready = path.join(tmp, 'term-ignored');
    try {
      fs.unlinkSync(ready);
    } catch {}
    const child = runnerMod.spawnCli('/bin/sh', ['-c', `trap "" TERM; : > ${ready}; while :; do sleep 1; done`]);
    const t0 = Date.now();
    // 等 trap 真正装上再发信号，否则测的是「还没忽略 TERM」的普通进程
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await sleep(10);
    assert(fs.existsSync(ready), '子进程没能进入忽略 SIGTERM 的状态');
    await new Promise((resolve) => {
      child.on('close', resolve);
      runnerMod.killTree(child);
    });
    const ms = Date.now() - t0;
    assert(ms >= 2500, `应等到 SIGKILL 兜底才退出，实际 ${ms}ms（SIGTERM 被忽略了）`);
    assert(ms < 6000, `忽略 SIGTERM 的进程应被 SIGKILL 收掉，实际 ${ms}ms`);
    console.log(`✓ 忽略 SIGTERM 的进程在 ${ms}ms 内被 SIGKILL 收掉`);
  }

  /* ---- 4. 正常进程：SIGTERM 立即生效，不必等 3 秒 ---- */
  if (process.platform !== 'win32') {
    const child = runnerMod.spawnCli('/bin/sh', ['-c', 'sleep 30']);
    const t0 = Date.now();
    await new Promise((resolve) => {
      child.on('close', resolve);
      runnerMod.killTree(child);
    });
    const ms = Date.now() - t0;
    assert(ms < 2000, `正常进程应在 SIGTERM 后立即退出，实际 ${ms}ms`);
    console.log(`✓ 正常进程 ${ms}ms 内退出`);
  }

  /* ---- 5. 验收：通过 / 不通过都正常结算，不会卡住 ---- */
  {
    const workdir = path.join(tmp, 'workdir');
    fs.mkdirSync(workdir, { recursive: true });
    const runner = new FakeRunner(['ok', 'ok']);
    const { room, group } = makeRoom(runner);
    group.id = 'g_verify_pass';
    group.cwd = workdir;
    group.verifyCmd = 'exit 0';
    await room.send(group, '@A 做事');
    await sleep(100);
    let t = runlog.list('g_verify_pass')[0];
    assert(t && t.endReason === 'verifyPassed', `验收通过应记为 verifyPassed，实际 ${t && t.endReason}`);
    assert(t.hops.some((h) => h.kind === 'verify' && h.status === 'done'), '应记录一条通过状态的验收跳');

    const runner2 = new FakeRunner(['ok']);
    const r2 = makeRoom(runner2);
    r2.group.id = 'g_verify_fail';
    r2.group.cwd = workdir;
    r2.group.verifyCmd = 'exit 3';
    r2.group.verifyMax = 1;
    await r2.room.send(r2.group, '@A 做事');
    await sleep(100);
    t = runlog.list('g_verify_fail')[0];
    assert(t && t.endReason === 'verifyFailed', `验收不通过应记为 verifyFailed，实际 ${t && t.endReason}`);
    assert(t.hops.some((h) => h.kind === 'verify' && h.exitCode === 3), '应记录验收退出码');
    assert.strictEqual(r2.room.busy.size, 0, 'busy 应清空');
    console.log('✓ 验收通过 / 不通过都正常结算');
  }

  /* ---- 6. 验收过程中停止：能及时收尾，不会挂住 ---- */
  {
    const workdir = path.join(tmp, 'workdir');
    const runner = new FakeRunner(['ok']);
    const { room, group } = makeRoom(runner);
    group.id = 'g_verify_stop';
    group.cwd = workdir;
    group.verifyCmd = 'sleep 10';
    const p = room.send(group, '@A 做事');
    await sleep(200); // Bot 已跑完，进入验收
    room.stop(group.id);
    const t0 = Date.now();
    await p;
    const ms = Date.now() - t0;
    assert(ms < 4000, `停止后应在几秒内收尾，实际 ${ms}ms`);
    assert.strictEqual(room.busy.size, 0, 'busy 应清空');
    assert.strictEqual(room.live.size, 0, 'live 应清空');
    console.log(`✓ 验收中停止：${ms}ms 内收尾`);
  }

  /* ---- 7. 上下文锚点优先保留最新的用户需求 ---- */
  {
    const { room, msgs } = makeRoom(new FakeRunner([]));
    const gid = 'g_ctx';
    msgs[gid] = [];
    for (let i = 1; i <= 6; i++) {
      msgs[gid].push({ id: 'u' + i, role: 'user', parts: [{ type: 'text', text: `第${i}条 ` + 'x'.repeat(400) }] });
    }
    const ctx = room.contextFor({ id: gid, memberIds: ['A'] }, { id: 'A' });
    assert.strictEqual(ctx.asks.length, 3, `预算内应保留 3 条（实际 ${ctx.asks.length}）`);
    assert(ctx.asks[2].includes('第6条'), '最新一条必须在上下文里');
    assert(ctx.asks[0].includes('第4条'), '保留的应是最新的几条，按时间顺序排列');
    assert(!ctx.asks.join('').includes('第1条'), '最早的那条应被挤掉');
    console.log('✓ 上下文锚点保留最新 3 条需求');
  }

  /* ---- 8. Windows 命令行转义 ---- */
  {
    const { toCommandLine } = runnerMod;
    assert.strictEqual(toCommandLine('C:\\a b\\cli.cmd', ['x']), '"C:\\a b\\cli.cmd" x');
    assert.strictEqual(toCommandLine('cli.cmd', ['say "hi"']), 'cli.cmd "say \\"hi\\""');
    assert.strictEqual(toCommandLine('cli.cmd', ['a b\\']), 'cli.cmd "a b\\\\"');
    assert.strictEqual(toCommandLine('cli.cmd', ['a&b']), 'cli.cmd "a&b"');
    assert.strictEqual(toCommandLine('cli.cmd', ['']), 'cli.cmd ""');
    assert.strictEqual(toCommandLine('cli.cmd', ['100%']), 'cli.cmd 100%');
    console.log('✓ Windows 命令行转义');
  }

  console.log('\n全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.stack);
  process.exit(1);
});
