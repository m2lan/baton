'use strict';
/**
 * 结构化停机：解析【阻塞】/【待确认】，阻塞时停链、清队列、跳过验收；待确认不阻断。
 *   node scripts/test-blocking.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-blocking-ud-'));
require('./test-hook');

const assert = require('assert');
const ROOT = path.join(__dirname, '..', 'electron');
const { Room, extractBlocked, extractConfirm } = require(path.join(ROOT, 'room.js'));
const runlog = require(path.join(ROOT, 'runlog.js'));
// 测试断言的是中文提示，固定语言，避免跟系统 locale 走
require(path.join(ROOT, 'lang.js')).setLang('zh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-blocking-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

/** 假 runner：按顺序返回预设文本；stop() 立即结算 */
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
    setTimeout(ctx.finish, 60);
    return { ok: true, msg, done };
  }
}

function makeRoom(runner, cwds = {}) {
  const msgs = {};
  const store = {
    getMessages: (k) => msgs[k] || [],
    appendMessage: (k, m) => (msgs[k] = msgs[k] || []).push(m),
    saveMessages: (k, list) => (msgs[k] = list),
  };
  const bots = [
    { id: 'A', name: 'A', agentId: 'claude', cwd: cwds.A || '', emoji: 'A', color: '#f00' },
    { id: 'B', name: 'B', agentId: 'claude', cwd: cwds.B || '', emoji: 'B', color: '#0f0' },
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

const systemText = (msgs, key) =>
  (msgs[key] || []).filter((m) => m.role === 'system').map((m) => m.parts[0].text).join('\n');

(async () => {
  /* ---- 1. 标记解析 ---- */
  {
    assert.deepStrictEqual(extractBlocked('【阻塞】需要数据库地址'), ['需要数据库地址']);
    assert.deepStrictEqual(extractBlocked('- 【阻塞】需要权限\n其他内容'), ['需要权限'], '列表符号和后续行不该混进来');
    assert.deepStrictEqual(extractBlocked('【阻塞】'), ['需要你处理'], '没写原因也要给兜底文案');
    assert.deepStrictEqual(extractBlocked('普通回复里提到【阻塞】但不在行首'), [], '只认行首标记');
    assert.deepStrictEqual(extractConfirm('【待确认】按 Node 20 继续'), ['按 Node 20 继续']);
    assert.deepStrictEqual(extractBlocked(''), []);
    console.log('✓ 【阻塞】/【待确认】解析');
  }

  /* ---- 2. 阻塞：停在当前成员，不交班、不再跑下一个 ---- */
  {
    const runner = new FakeRunner(['【阻塞】需要数据库地址 @B']);
    const { room, group, msgs } = makeRoom(runner);
    group.id = 'g_block';
    await room.send(group, '@A 做个事');
    await sleep(120);

    assert.deepStrictEqual(runner.calls.map((c) => c.botId), ['A'], `阻塞后不该再跑 B，实际：${runner.calls.map((c) => c.botId)}`);
    const task = runlog.list('g_block')[0];
    assert(task, '应记录一条任务');
    assert.strictEqual(task.endReason, 'blocked', `整轮应以 blocked 结束，实际 ${task.endReason}`);
    assert.strictEqual(task.hops.length, 1, '阻塞后不该再有跳');
    assert.strictEqual(task.hops[0].endReason, 'blocked', '这一跳应标成 blocked');
    assert.deepStrictEqual(task.hops[0].blocked, ['需要数据库地址 @B'], '原因要留在 hop 里给界面用');
    assert(systemText(msgs, 'g_block').includes('停下来等你处理'), '会话里要有一条可读的停机提示');
    assert.strictEqual(room.busy.size, 0, 'busy 应清空');
    console.log('✓ 阻塞停机：不交班、不再跑后续成员');
  }

  /* ---- 3. 阻塞时跳过验收：活没做完，验了也没意义 ---- */
  {
    const workdir = path.join(tmp, 'verify');
    fs.mkdirSync(workdir, { recursive: true });
    const runner = new FakeRunner(['【阻塞】缺少环境变量']);
    const { room, group } = makeRoom(runner);
    group.id = 'g_block_verify';
    group.cwd = workdir;
    group.verifyCmd = 'exit 0';
    await room.send(group, '@A 做个事');
    await sleep(120);

    const task = runlog.list('g_block_verify')[0];
    assert.strictEqual(task.endReason, 'blocked');
    assert(!task.hops.some((h) => h.kind === 'verify'), '阻塞时不该执行验收命令');
    console.log('✓ 阻塞时不执行验收');
  }

  /* ---- 4. 待确认：不打断交班，整轮结束时汇总提示 ---- */
  {
    const runner = new FakeRunner(['【待确认】按 Node 20 继续 @B', '完成']);
    const { room, group, msgs } = makeRoom(runner);
    group.id = 'g_confirm';
    await room.send(group, '@A 做个事');
    await sleep(150);

    assert.deepStrictEqual(runner.calls.map((c) => c.botId), ['A', 'B'], '待确认不该打断交班');
    const task = runlog.list('g_confirm')[0];
    assert.strictEqual(task.endReason, 'done');
    assert.deepStrictEqual(task.hops[0].confirm, ['按 Node 20 继续 @B'], '待确认要留在 hop 里');
    assert(systemText(msgs, 'g_confirm').includes('待确认的假设'), '结束时汇总一条待确认提示');
    console.log('✓ 待确认不阻断，结束时汇总');
  }

  /* ---- 5. 并发批里有人阻塞：整轮停下，不再排后续交班 ---- */
  {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const runner = new FakeRunner(['【阻塞】缺少密钥', '做完 @B']);
    const { room, group, msgs } = makeRoom(runner, { A: a, B: b });
    group.id = 'g_block_parallel';
    group.concurrent = true;
    await room.send(group, '@A @B 一起做');
    await sleep(200);

    const ids = runner.calls.map((c) => c.botId);
    assert(ids.includes('A') && ids.includes('B'), '并发批里的成员都应先跑完');
    const task = runlog.list('g_block_parallel')[0];
    assert.strictEqual(task.endReason, 'blocked', `并发批里有人阻塞，整轮应 blocked，实际 ${task.endReason}`);
    assert(systemText(msgs, 'g_block_parallel').includes('停下来等你处理'));
    assert.strictEqual(room.busy.size, 0);
    console.log('✓ 并发批中有人阻塞：整轮停下');
  }

  /* ---- 6. 「知道了」标记：只影响提醒，不改任务终态 ---- */
  {
    const t = new runlog.Task({ key: 'g_dismiss', kind: 'group', title: 'G', userText: 'u' });
    t.hop({ kind: 'bot', botId: 'A', botName: 'A', endReason: 'blocked', blocked: ['缺权限'] });
    t.finish('blocked');

    assert.strictEqual(runlog.dismissAttention('g_dismiss', t.data.id), true);
    const after = runlog.list('g_dismiss')[0];
    assert.strictEqual(after.attentionDismissed, true);
    assert.strictEqual(after.endReason, 'blocked', 'dismiss 不该改任务终态');
    assert.strictEqual(runlog.dismissAttention('g_dismiss', t.data.id), false, '重复 dismiss 不应再成功');
    assert.strictEqual(runlog.dismissAttention('g_dismiss', 'nope'), false, '找不到任务时返回 false');
    console.log('✓ 「知道了」标记只影响提醒');
  }

  console.log('\n全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.stack);
  process.exit(1);
});