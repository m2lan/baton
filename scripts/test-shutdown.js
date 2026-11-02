'use strict';
/**
 * 退出收尾：进行中的任务标成中断、半截输出落盘、重复退出不重复记账。
 *   node scripts/test-shutdown.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-shutdown-ud-'));
require('./test-hook');

const assert = require('assert');
const ROOT = path.join(__dirname, '..', 'electron');
const runlog = require(path.join(ROOT, 'runlog.js'));
const { Runner, spawnCli } = require(path.join(ROOT, 'runner.js'));

(async () => {
  /* ---- 1. interrupt：零跳任务也归档，轮次快照一起留下 ---- */
  {
    const task = new runlog.Task({ key: 'c_int', kind: 'group', title: 'I', userText: 'u' });
    task.setRound({ turn: 1, notes: ['补充'], verifyAttempts: 0, currentBotId: 'b1' });
    task.interrupt('hostExit');

    assert(!fs.existsSync(runlog.liveFile('c_int')), '中断后应删除 live 快照');
    const hist = runlog.list('c_int');
    assert.strictEqual(hist.length, 1, '中断本身是信息，零跳也要记一条');
    assert.strictEqual(hist[0].status, 'interrupted');
    assert.strictEqual(hist[0].endReason, 'hostExit');
    assert.strictEqual(hist[0].round.turn, 1, '轮次快照要留给「继续」用');
    assert(hist[0].interruptedAt > 0, '应记录中断时刻');

    /* ---- 2. 重复调用不重复写 ---- */
    task.interrupt('hostExit');
    assert.strictEqual(runlog.list('c_int').length, 1, '重复收尾不能记两遍');
  }

  /* ---- 3. interruptAll 只处理还在进行中的任务 ---- */
  {
    const running = new runlog.Task({ key: 'c_all_run', kind: 'bot', title: 'R', userText: 'u' });
    const done = new runlog.Task({ key: 'c_all_done', kind: 'bot', title: 'D', userText: 'u' });
    done.hop({ kind: 'bot', botId: 'b1', botName: 'B1' });
    done.finish('done');

    const out = runlog.interruptAll('hostExit');
    const ids = out.map((t) => t.id);
    assert(ids.includes(running.data.id), '进行中的任务应被中断');
    assert(!ids.includes(done.data.id), '已完成的任务不该被再改一次');
    assert.strictEqual(runlog.list('c_all_done')[0].status, 'completed', '已完成任务的终态不能变');
    assert.strictEqual(runlog.list('c_all_run')[0].status, 'interrupted');
  }

  /* ---- 4. Runner.drain：半截输出以 interrupted 落盘 ---- */
  {
    const saved = [];
    const runner = new Runner({
      emit: () => {},
      onMessage: (key, msg) => saved.push({ key, msg }),
    });

    const child = spawnCli(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    const msg = {
      id: 'm_live',
      role: 'assistant',
      parts: [{ type: 'text', text: '半截输出' }],
      status: 'streaming',
      createdAt: Date.now() - 100,
      meta: {},
    };
    runner.running.set('k_drain', { child, msg, finished: false });

    const n = runner.drain('hostExit');
    assert.strictEqual(n, 1, '应结算一个正在跑的进程');
    assert.strictEqual(runner.running.size, 0, 'drain 后不应再有 running 记录');
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].key, 'k_drain');
    const out = saved[0].msg;
    assert.strictEqual(out.status, 'interrupted');
    assert.strictEqual(out.meta.interrupted, true);
    assert.strictEqual(out.parts[0].text, '半截输出', '半截输出不能丢');
    assert(out.duration >= 0 && out.finishedAt > 0);

    await new Promise((resolve) => {
      child.on('close', resolve);
      setTimeout(resolve, 3000);
    });
  }

  /* ---- 5. 都收尾干净了，下次启动没有「残留中断」可补 ---- */
  assert.deepStrictEqual(runlog.recoverAll(), [], '优雅退出后不应再出现恢复项');

  console.log('✓ 中断归档 / 重复收尾幂等 / 半截输出落盘 / 下次启动无残留');
  console.log('\n全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.stack);
  process.exit(1);
});