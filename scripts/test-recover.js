'use strict';
/**
 * 任务持久化与中断恢复：开始即落盘、快照瘦身、崩溃归档、正常收尾、重复启动。
 *   node scripts/test-recover.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-recover-ud-'));
require('./test-hook');

const assert = require('assert');
const ROOT = path.join(__dirname, '..', 'electron');
const runlog = require(path.join(ROOT, 'runlog.js'));
const { buildResumeText } = require(path.join(ROOT, 'room.js'));

const livePath = (key) => runlog.liveFile(key);

/* ---- 1. 任务一创建就有 live 快照 ---- */
{
  const task = new runlog.Task({ key: 'c_start', kind: 'group', title: 'T', userText: 'u' });
  assert(fs.existsSync(livePath('c_start')), '创建任务后应立刻落盘');
  const live = runlog.readLive('c_start');
  assert.strictEqual(live.schema, 1, '快照应带 schema 版本');
  assert.strictEqual(live.task.id, task.data.id);
  assert.strictEqual(live.task.status, 'running');
  assert.strictEqual(live.task.updatedAt > 0, true, '应有 updatedAt');

  /* ---- 2. 快照不带 prompt，用量和改动照常保留 ---- */
  const longPrompt = 'P'.repeat(30000);
  task.setRunning('b1', { kind: 'bot', botId: 'b1', botName: 'B1', prompt: longPrompt });
  task.hop({ kind: 'bot', botId: 'b1', botName: 'B1', prompt: longPrompt, usage: { input: 10, output: 5 }, changes: [{ status: 'M', path: 'a.js' }] });

  let snapshot = runlog.readLive('c_start');
  assert.strictEqual(snapshot.running[0].prompt, undefined, '进行中的跳不该带 prompt');
  assert.strictEqual(snapshot.task.hops.length, 1, '已完成的跳应进快照');
  assert.strictEqual(snapshot.task.hops[0].prompt, undefined, '快照里的跳不该带 prompt');
  assert.deepStrictEqual(snapshot.task.hops[0].usage, { input: 10, output: 5 }, '用量必须保留');
  assert.strictEqual(snapshot.task.hops[0].changes.length, 1, '改动清单必须保留');

  /* ---- 3. 轮次快照与队列截断 ---- */
  task.setRound({ turn: 2, notes: ['补充'], verifyAttempts: 1, currentBotId: 'b2' });
  task.setQueue([{ botId: 'b2', name: 'B2' }], [{ botId: 'b2', text: 'Q'.repeat(5000), from: 'b1', verify: false }]);
  snapshot = runlog.readLive('c_start');
  assert.deepStrictEqual(snapshot.round, { turn: 2, notes: ['补充'], verifyAttempts: 1, currentBotId: 'b2' }, '轮次快照应原样落盘');
  assert.strictEqual(snapshot.queue[0].text.length, 2000, '队列文本应截断到 2000 字');
  assert.strictEqual(snapshot.queue[0].from, 'b1', '队列的其他字段不能丢');

  /* ---- 4. 模拟进程被杀：启动时归档成 interrupted ---- */
  const recovered = runlog.recoverAll();
  assert.strictEqual(recovered.length, 1, '应发现一条未完成任务');
  assert.strictEqual(recovered[0].key, 'c_start');
  assert.strictEqual(recovered[0].taskId, task.data.id);
  assert.strictEqual(recovered[0].round.turn, 2, '应把轮次快照带回去给界面');
  assert.strictEqual(recovered[0].round.queue.length, 1, '未开始的交接要留下来，才能继续');
  assert.strictEqual(recovered[0].round.queue[0].botId, 'b2');
  assert(!fs.existsSync(livePath('c_start')), '归档后应删除 live 快照');

  const hist = runlog.list('c_start');
  assert.strictEqual(hist.length, 1, '中断任务应写进历史');
  assert.strictEqual(hist[0].status, 'interrupted');
  assert.strictEqual(hist[0].endReason, 'hostExit');
  assert.strictEqual(hist[0].hops.length, 1, '已完成的跳不能丢');
  assert.strictEqual(hist[0].totals.usage.input, 10, '中断任务的用量应计入合计');

  /* ---- 5. 重复启动不重复归档 ---- */
  assert.deepStrictEqual(runlog.recoverAll(), [], '没有 live 快照时应什么都不做');
  assert.strictEqual(runlog.list('c_start').length, 1, '不应该出现第二条中断记录');

  /* ---- 6. 中断任务计入全局汇总 ---- */
  {
    const sum = runlog.summary(0);
    const bucket = sum.byKey.find((x) => x.key === 'c_start');
    assert(bucket, '汇总里应包含中断任务');
    assert.strictEqual(bucket.usage.input, 10, '中断任务的 token 应计入汇总');
  }

  /* ---- 7. 正常完成：删快照、标 completed ---- */
  const done = new runlog.Task({ key: 'c_done', kind: 'bot', title: 'D', userText: 'u' });
  done.hop({ kind: 'bot', botId: 'b1', botName: 'B1', usage: { input: 1, output: 2 } });
  done.finish('done');
  assert(!fs.existsSync(livePath('c_done')), '完成后必须删掉 live 快照');
  const doneHist = runlog.list('c_done')[0];
  assert.strictEqual(doneHist.status, 'completed');
  assert.strictEqual(doneHist.endReason, 'done');

  /* ---- 8. 完成后迟到的状态更新不重建快照 ---- */
  done.setQueue([{ botId: 'b2', text: 'x' }]);
  done.saveLive();
  assert(!fs.existsSync(livePath('c_done')), '完成的任务不该再写 live');

  /* ---- 9. 一跳都没跑成的任务：不留快照，也不进历史 ---- */
  const empty = new runlog.Task({ key: 'c_empty', kind: 'bot', title: 'E', userText: 'u' });
  empty.finish('error');
  assert(!fs.existsSync(livePath('c_empty')), '启动失败也要清掉 live');
  assert.strictEqual(runlog.list('c_empty').length, 0, '没有跳的任务不记录');

  /* ---- 10. 旧一轮迟到收尾不能删掉新一轮的快照 ---- */
  {
    const oldTask = new runlog.Task({ key: 'c_race', kind: 'group', title: 'R', userText: 'u' });
    oldTask.hop({ kind: 'bot', botId: 'b1', botName: 'B1' });
    const oldId = oldTask.data.id;
    const newTask = new runlog.Task({ key: 'c_race', kind: 'group', title: 'R', userText: 'u2' });
    newTask.hop({ kind: 'bot', botId: 'b2', botName: 'B2' });
    assert.notStrictEqual(oldTask.data.id, newTask.data.id);

    oldTask.finish('stopped');
    assert(fs.existsSync(livePath('c_race')), '旧一轮收尾时新一轮还在跑，快照不能被删');
    assert.strictEqual(runlog.readLive('c_race').task.id, newTask.data.id);

    oldTask.setQueue([{ botId: 'b9', text: 'late' }]);
    assert.strictEqual(runlog.readLive('c_race').task.id, newTask.data.id, '旧一轮迟到的状态不能覆盖新快照');

    newTask.finish('done');
    assert(!fs.existsSync(livePath('c_race')), '新一轮结束后快照应清掉');
    const ids = runlog.list('c_race').map((t) => t.id);
    assert(ids.includes(oldId) && ids.includes(newTask.data.id), '两轮都应留在历史里');
  }

  /* ---- 11. 删除会话时一并清掉 live ---- */
  {
    const t = new runlog.Task({ key: 'c_remove', kind: 'bot', title: 'X', userText: 'u' });
    t.hop({ kind: 'bot', botId: 'b1', botName: 'B1' });
    runlog.remove('c_remove');
    assert(!fs.existsSync(livePath('c_remove')), '删除会话应清掉 live 快照');
    assert.strictEqual(runlog.list('c_remove').length, 0, '删除会话应清掉历史');
  }

  /* ---- 12. 坏快照直接丢弃，不让每次启动都报错 ---- */
  {
    fs.mkdirSync(path.dirname(livePath('c_bad')), { recursive: true });
    fs.writeFileSync(livePath('c_bad'), '{not json', 'utf8');
    assert.deepStrictEqual(runlog.recoverAll(), [], '坏快照不应产生恢复项');
    assert(!fs.existsSync(livePath('c_bad')), '坏快照应被删除');
  }

  /* ---- 13. 放弃继续：只清轮次信息，任务记录保留 ---- */
  {
    const t = new runlog.Task({ key: 'c_discard', kind: 'group', title: 'G', userText: 'u' });
    t.setRound({ turn: 1 });
    t.setQueue([{ botId: 'b1', name: 'B1' }], [{ botId: 'b1', text: 'x' }]);
    t.interrupt('hostExit');

    const before = runlog.list('c_discard')[0];
    assert(before.round && before.round.queue.length === 1, '中断后应保留可继续的交接');
    assert.strictEqual(runlog.discardResume('c_discard', t.data.id), true);
    const after = runlog.list('c_discard')[0];
    assert.strictEqual(after.status, 'interrupted', '任务记录本身要保留');
    assert.strictEqual(after.round, null, '放弃后应清掉可继续信息');
    assert.strictEqual(after.resumeDismissed, true);
    assert.strictEqual(runlog.discardResume('c_discard', t.data.id), false, '重复放弃不应再成功');
  }

  /* ---- 14. 恢复说明带现场、原始需求和剩余交接 ---- */
  {
    const task = {
      userText: '把登录页改成暗色',
      hops: [{ kind: 'bot', botName: 'A' }, { kind: 'bot', botName: 'B' }, { kind: 'verify', botName: '验收' }],
    };
    const text = buildResumeText(task, ['C', 'D']);
    assert(text.includes('把登录页改成暗色'), '要带上原始需求');
    assert(text.includes('A、B'), '要说明谁已经跑过');
    assert(text.includes('@C @D'), '要用 @ 把剩余成员排进队列');
    assert(text.includes('git status'), '要提醒接手方先核对现场');

    const tail = buildResumeText(task, []);
    assert(tail.includes('负责人'), '没有剩余交班时交给负责人收尾');
    assert(!tail.includes('@C'), '没有剩余成员时不该把成员排进队列');
  }

  /* ---- 15. 「需要人处理」判定：默认视图只留这些 ---- */
  {
    const { needsAttention } = runlog;
    assert.strictEqual(needsAttention({ status: 'interrupted', endReason: 'hostExit', round: {} }), true, '可继续的中断要提示');
    assert.strictEqual(needsAttention({ status: 'interrupted', endReason: 'hostExit', round: null }), false, '放弃继续后不再提示');
    assert.strictEqual(needsAttention({ status: 'completed', endReason: 'blocked' }), true, '阻塞要提示');
    assert.strictEqual(needsAttention({ status: 'completed', endReason: 'blocked', attentionDismissed: true }), false, '点过知道了就不再提示');
    for (const r of ['error', 'failed', 'stall', 'timeout', 'maxTurns', 'verifyFailed']) {
      assert.strictEqual(needsAttention({ status: 'completed', endReason: r }), true, `${r} 应该需要人处理`);
    }
    for (const r of ['done', 'passed', 'verifyPassed', 'stopped', 'handoff']) {
      assert.strictEqual(needsAttention({ status: 'completed', endReason: r }), false, `${r} 不该进默认视图`);
    }
    const t = new runlog.Task({ key: 'c_attention', kind: 'group', title: 'A', userText: 'u' });
    t.hop({ kind: 'bot', botId: 'A', botName: 'A', endReason: 'error' });
    t.finish('error');
    assert.strictEqual(runlog.list('c_attention')[0].needsAttention, true, 'runs:list 要带上判定结果');
  }

  console.log('✓ 任务开始即落盘 / 快照瘦身 / 崩溃归档 / 正常收尾 / 旧一轮迟到不覆盖新一轮');
  console.log('✓ 放弃继续 / 恢复说明 / 需要人处理判定');
  console.log('\n全部通过');
}