'use strict';
/**
 * P2 回归：@ 匹配边界 / 未知费用的汇总 / interject 不重复投放 / 消息截断提示。
 *   node scripts/test-p2.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-p2-ud-'));
require('./test-hook');

const assert = require('assert');
const ROOT = path.join(__dirname, '..', 'electron');
const { Room, findMentions } = require(path.join(ROOT, 'room.js'));
const runlog = require(path.join(ROOT, 'runlog.js'));
const store = require(path.join(ROOT, 'store.js'));

/* ---- 1. @ 匹配边界 ---- */
const members = [
  { id: 'a', name: 'A' },
  { id: 'alice', name: 'Alice' },
  { id: 'zhang', name: '张三' },
  { id: 'li', name: '李四' },
];
assert.deepStrictEqual(findMentions('@Alice 你好', members), ['alice'], '@Alice 应只命中 Alice');
assert.deepStrictEqual(findMentions('@A 你好', members), ['a'], '@A 应命中 A');
assert.deepStrictEqual(findMentions('@A@Alice', members), ['a', 'alice'], '连续两个 @ 都应命中');
assert.deepStrictEqual(findMentions('@Bob 你好', members), [], '不在成员里的名字不该命中前缀成员');
assert.deepStrictEqual(findMentions('@张三请看一下', members), ['zhang'], '中文名后直接接正文仍应命中');
assert.deepStrictEqual(findMentions('@李四，你来', members), ['li'], '中文标点边界正常');
assert.deepStrictEqual(findMentions('@张三丰 是谁', members), ['zhang'], '中文没有空格边界，宁可命中前缀成员（见代码注释）');
assert.deepStrictEqual(findMentions('@A1 你好', members), [], 'ASCII 字母数字紧跟时不该命中前缀成员');
console.log('✓ @ 匹配边界');

/* ---- 2. 费用未知时汇总为 null，而不是 0 ---- */
{
  const t1 = new runlog.Task({ key: 'c1', kind: 'bot', title: 'c1', userText: 'x' });
  t1.hop({ kind: 'bot', botId: 'b1', botName: 'B1', usage: { input: 10, output: 5 } });
  t1.finish('done');

  const t2 = new runlog.Task({ key: 'c2', kind: 'bot', title: 'c2', userText: 'x' });
  t2.hop({ kind: 'bot', botId: 'b1', botName: 'B1', usage: { input: 1, output: 1 }, cost: 0.5 });
  t2.hop({ kind: 'bot', botId: 'b2', botName: 'B2', usage: { input: 1, output: 1 } });
  t2.finish('done');

  const s = runlog.summary(0);
  assert.strictEqual(typeof s.total.cost, 'number', '有跳报了费用时合计应是数字');
  assert.strictEqual(s.total.cost, 0.5);
  const b1 = s.byBot.find((b) => b.botId === 'b1');
  const b2 = s.byBot.find((b) => b.botId === 'b2');
  assert.strictEqual(b1.cost, 0.5, '报过费用的 Bot 费用照常累加');
  assert.strictEqual(b2.cost, null, '从没报过费用的 Bot 应是 null，界面显示 —');
  assert.strictEqual(b2.costKnown, undefined, '内部标记不应外泄');

  const list = runlog.list('c1')[0];
  assert.strictEqual(list.totals.cost, null, '单条任务未知费用应是 null');
  assert.strictEqual(list.totals.byBot[0].cost, null);
  console.log('✓ 费用未知汇总是 null');
}

/* ---- 3. interject 不重复投放补充 ---- */
{
  const events = [];
  const room = new Room({
    runner: { running: new Map() },
    store: { getMessages: () => [], appendMessage: () => {} },
    getBot: () => null,
    emit: (ch) => events.push(ch),
    onChange: () => {},
  });
  const group = { id: 'g1', leaderId: 'a', memberIds: ['a', 'b'] };

  // 队列空：排一个任务，不能再进 notes
  const live1 = { queue: [], notes: [], current: null, turn: 1 };
  room.live.set('g1', live1);
  room.interject(group, '顺便加个日志');
  assert.strictEqual(live1.queue.length, 1, '队列空时应排给负责人');
  assert.strictEqual(live1.queue[0].text, '顺便加个日志');
  assert.strictEqual(live1.notes.length, 0, '同一句话不该同时写进 notes');

  // 队列非空：只挂补充，不再加任务
  const live2 = { queue: [{ botId: 'b', text: '原任务' }], notes: [], current: null, turn: 1 };
  room.live.set('g1', live2);
  room.interject(group, '改成英文');
  assert.strictEqual(live2.queue.length, 1, '已有排队任务时不该再加一个');
  assert.deepStrictEqual(live2.notes, ['改成英文'], '补充应挂到下一棒');
  console.log('✓ interject 不会重复投放');
}

/* ---- 4. 消息截断会留下可见提示 ---- */
{
  const list = [];
  for (let i = 0; i < 700; i++) list.push({ id: `m${i}`, role: 'user', parts: [{ type: 'text', text: `第${i}条` }] });
  store.saveMessages('trim', list);
  let saved = store.getMessages('trim');
  assert.strictEqual(saved.length, 601, `应是 1 条提示 + 最近 600 条，实际 ${saved.length}`);
  assert.strictEqual(saved[0].role, 'system');
  assert.strictEqual(saved[0].meta.omitted, 100);
  assert(saved[0].parts[0].text.includes('100'), '提示应写明丢了多少条');
  assert.strictEqual(saved[1].id, 'm100', '保留的应是最新的 600 条');

  // 再丢一条：同一条提示累加
  saved.push({ id: 'm700', role: 'user', parts: [{ type: 'text', text: '第700条' }] });
  store.saveMessages('trim', saved);
  const again = store.getMessages('trim');
  assert.strictEqual(again.length, 601);
  assert.strictEqual(again[0].meta.omitted, 101, '再次截断应在同一条提示上累加');
  assert.strictEqual(again[1].id, 'm101');

  // 未超限不动
  store.saveMessages('small', [{ id: 'x', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]);
  assert.strictEqual(store.getMessages('small').length, 1);
  console.log('✓ 消息截断留下可见提示');
}

console.log('\n全部通过');
