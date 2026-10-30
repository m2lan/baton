'use strict';
/**
 * 附件 / @ 文件的无界面测试：索引、解析、落盘、按 CLI 准备、prompt 注入、清理。
 *   node scripts/test-attach.js
 * 不需要 Electron 窗口，也不需要装任何 CLI。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// electron/*.js 里有 require('electron')，这里把它指到桩，其它包不受影响
process.env.TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-attach-ud-'));
require('./test-hook');

const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'electron');
const files = require(path.join(ROOT, 'files.js'));
const { getAgent, buildInvocation } = require(path.join(ROOT, 'agents.js'));
const { Room } = require(path.join(ROOT, 'room.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-ws-'));
const ws = path.join(tmp, 'repo');
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.mkdirSync(path.join(ws, 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(ws, 'README'), 'readme\n');
fs.writeFileSync(path.join(ws, 'src', 'b.ts'), 'export const b = 2;\n');
fs.writeFileSync(path.join(ws, 'node_modules', 'x', 'index.js'), 'x\n');
execFileSync('git', ['-C', ws, 'init', '-q']);

(async () => {
  /* ---- 1. 文件索引：git 仓库走 ls-files，跳过 node_modules ---- */
  {
    const list = await files.listFiles(ws, '');
    assert(list.includes('a.ts'), '应列出 a.ts');
    assert(list.includes('src/b.ts'), '应列出子目录文件');
    assert(!list.some((p) => p.startsWith('node_modules/')), 'git 模式应排除 node_modules');
    const hit = await files.listFiles(ws, 'b.t');
    assert.deepStrictEqual(hit.slice(0, 1), ['src/b.ts'], '按文件名过滤');
    // 非 git 目录退回遍历
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-plain-'));
    fs.writeFileSync(path.join(plain, 'x.md'), 'x');
    fs.mkdirSync(path.join(plain, 'node_modules'));
    fs.writeFileSync(path.join(plain, 'node_modules', 'y.js'), 'y');
    assert.deepStrictEqual(await files.listFiles(plain, ''), ['x.md'], '非仓库遍历也要跳过 node_modules');
    console.log('✓ 文件索引');
  }

  /* ---- 2. @ 引用解析 ---- */
  {
    assert.deepStrictEqual(files.parseRefs('看看 @a.ts 和 @Alice，还有 @nope', ['Alice']), ['a.ts', 'nope']);
    assert.deepStrictEqual(files.parseRefs('@README 是文件', []), ['README']);
    assert.deepStrictEqual(files.parseRefs('@Alice 你好', ['Alice']), [], '成员名不该当文件');
    const toks = files.parseRefs('@a.ts @src/b.ts @missing', ['Alice']);
    const got = files.resolveTokens(toks, ws);
    assert.deepStrictEqual(got.map((f) => f.name).sort(), ['a.ts', 'b.ts']);
    assert.deepStrictEqual(files.resolveRefs('看 @a.ts', ws), files.resolveTokens(['a.ts'], ws));
    console.log('✓ @ 引用解析');
  }

  /* ---- 3. 附件落盘与归属校验 ---- */
  let atts;
  {
    const r = files.attachPaths('chat1', [path.join(ws, 'a.ts'), path.join(ws, 'nope.ts')]);
    assert.strictEqual(r.attachments.length, 1, '不存在的文件应被跳过');
    assert.strictEqual(r.errors.length, 1);
    atts = r.attachments;
    assert(fs.existsSync(atts[0].path), '附件应已复制');
    assert(files.isOwned(atts[0].path), '附件路径应属于附件目录');
    assert(!files.isOwned('/etc/passwd'), '/etc/passwd 不属于附件目录');
    assert.strictEqual(atts[0].kind, 'file');
    assert.strictEqual(atts[0].name, 'a.ts', '界面显示的仍是原文件名');
    console.log('✓ 附件落盘');
  }

  /* ---- 4. 按 CLI 能力准备：支持 add-dir 的原样用，不支持的复制进 cwd ---- */
  {
    const claude = getAgent('claude');
    const p1 = files.prepare(claude, atts, ws, 'chat1');
    assert.deepStrictEqual(p1.extraDirs, [files.dirFor('chat1')], 'claude 应拿到附件目录');
    assert.strictEqual(p1.files[0].path, atts[0].path, '支持 add-dir 时不必复制');

    const codex = getAgent('codex');
    const imgPath = path.join(ws, 'pic.png');
    fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const img = files.attachPaths('chat1', [imgPath]).attachments[0];
    assert.strictEqual(img.kind, 'image');
    const p2 = files.prepare(codex, [img], ws, 'chat1');
    assert.deepStrictEqual(p2.images, [img.path], 'codex 的图片走原生 -i');

    const p2c = files.prepare(claude, [img], ws, 'chat1');
    assert.deepStrictEqual(p2c.images, [img.path], 'claude 的图片走 stream-json 图片块');

    const generic = { proto: 'generic', bin: 'foo' };
    const p3 = files.prepare(generic, atts, ws, 'chat1');
    assert.deepStrictEqual(p3.extraDirs, []);
    const copied = p3.files[0].path;
    assert(copied.startsWith(path.join(ws, '.baton', 'attachments')), `应复制进 cwd：${copied}`);
    assert(path.basename(copied).startsWith('chat1-'), '副本名带会话 key 前缀，便于回收');
    assert(fs.existsSync(copied));
    const exclude = fs.readFileSync(path.join(ws, '.git', 'info', 'exclude'), 'utf8');
    assert(exclude.split('\n').includes('.baton/'), '.baton/ 应写进 info/exclude');
    console.log('✓ 按 CLI 准备附件');
  }

  /* ---- 5. prompt 段 ---- */
  {
    const sec = files.promptSection(atts);
    assert(sec.includes('【附件】') && sec.includes(atts[0].path), 'prompt 段应带绝对路径');
    const imgSec = files.promptSection([{ path: '/x/y.png', kind: 'image' }]);
    assert(imgSec.includes('（图片）'));
    assert.strictEqual(files.promptSection([]), '');
    console.log('✓ prompt 附件段');
  }

  /* ---- 6. 命令行参数 ---- */
  {
    const claude = buildInvocation(getAgent('claude'), { prompt: 'hi', extraDirs: ['/tmp/att'] });
    assert(claude.args.includes('--add-dir') && claude.args.includes('/tmp/att'));
    const codex = buildInvocation(getAgent('codex'), { prompt: 'hi', extraDirs: ['/tmp/att'], images: ['/tmp/a.png'] });
    assert(codex.args.includes('-i') && codex.args.includes('/tmp/a.png'), 'codex 应传 -i');
    assert(codex.args.includes('--add-dir') && codex.args.includes('/tmp/att'));
    const gemini = buildInvocation(getAgent('gemini'), { prompt: 'hi', extraDirs: ['/tmp/a', '/tmp/b'] });
    const i = gemini.args.indexOf('--include-directories');
    assert(i >= 0 && gemini.args[i + 1] === '/tmp/a,/tmp/b');

    // Claude / CodeBuddy：有图片时走 stream-json 输入，图片作为 content block 内联
    const png = path.join(tmp, 'tiny.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const claudeImg = buildInvocation(getAgent('claude'), { prompt: '看看这张图', images: [png] });
    assert(claudeImg.args.includes('--input-format') && claudeImg.args.includes('stream-json'));
    const payload = JSON.parse(claudeImg.stdin.trim());
    assert.strictEqual(payload.type, 'user');
    const blocks = payload.message.content;
    assert.strictEqual(blocks[0].type, 'text');
    assert.strictEqual(blocks[1].type, 'image');
    assert.strictEqual(blocks[1].source.type, 'base64');
    assert.strictEqual(blocks[1].source.media_type, 'image/png');
    assert(Buffer.from(blocks[1].source.data, 'base64').length === 8, 'base64 应是原图字节');

    // 没有图片时不改协议，仍是纯文本 stdin
    const claudeText = buildInvocation(getAgent('claude'), { prompt: 'hi' });
    assert(!claudeText.args.includes('--input-format'));
    assert.strictEqual(claudeText.stdin, 'hi');

    // 不支持的格式 / 不存在的文件：跳过内联，退回纯文本
    const heic = buildInvocation(getAgent('claude'), { prompt: 'hi', images: ['/tmp/x.heic'] });
    assert(!heic.args.includes('--input-format') && heic.stdin === 'hi');
    console.log('✓ 命令行参数');
  }

  /* ---- 7. 群聊：附件进入提示词 ---- */
  {
    const prompts = [];
    class FakeRunner {
      isRunning() { return false; }
      stop() {}
      async run(target, agent, prompt) {
        prompts.push(prompt);
        const msg = { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }], status: 'done', createdAt: Date.now(), meta: {} };
        return { ok: true, msg, done: Promise.resolve(msg) };
      }
    }
    const store = {
      getMessages: () => [],
      appendMessage: () => {},
      saveMessages: () => {},
      root: () => tmp,
    };
    const bot = { id: 'A', name: 'A', agentId: 'claude', cwd: ws, emoji: 'A', color: '#f00' };
    const room = new Room({
      runner: new FakeRunner(),
      store,
      getBot: () => bot,
      emit: () => {},
      onChange: () => {},
    });
    const group = { id: 'g_att', name: 'G', memberIds: ['A'], leaderId: 'A', cwd: ws, decisions: [], sessions: {} };
    await room.send(group, '@A 看看这个', null, atts);
    assert.strictEqual(prompts.length, 1);
    assert(prompts[0].includes('【附件】'), '群聊 prompt 应包含附件段');
    assert(prompts[0].includes(atts[0].path), '群聊 prompt 应包含附件路径');

    // 手打的 @文件 也要进 prompt（按 bot 的 cwd 解析）
    prompts.length = 0;
    await room.send(group, '@A 读一下 @src/b.ts', null, []);
    assert(prompts[0].includes(path.join(ws, 'src', 'b.ts')), '@文件 应解析成绝对路径');
    console.log('✓ 群聊附件进入提示词');
  }

  /* ---- 8. 清理：userData 目录 + 工作目录副本，都不越界 ---- */
  {
    files.clear('chat1', [ws]);
    assert(!fs.existsSync(files.dirFor('chat1')), '清理后目录应消失');
    assert(!fs.existsSync(path.join(ws, '.baton', 'attachments')), '工作目录副本应一并收掉');
    assert(fs.existsSync(path.join(ws, '.baton')) === false, '.baton 空了也该收掉');

    const outside = path.join(tmp, 'keep');
    fs.mkdirSync(outside, { recursive: true });
    files.clear('../keep');
    assert(fs.existsSync(outside), '越界 key 不能删到外面');

    // 丢掉未发送的附件：只删附件目录里的文件
    const one = files.attachPaths('chat2', [path.join(ws, 'a.ts')]).attachments[0];
    assert(fs.existsSync(one.path));
    files.discard('/etc/passwd');
    assert(fs.existsSync('/etc/passwd'), 'deny 越界路径');
    files.discard([one.path]);
    assert(!fs.existsSync(one.path), 'discard 应删掉附件');
    console.log('✓ 附件清理');
  }

  /* ---- 9. 去重与数量上限 ---- */
  {
    const dup = files.attachPaths('chat3', [path.join(ws, 'a.ts'), path.join(ws, 'a.ts')]);
    assert.strictEqual(dup.attachments.length, 1, '同一次里重复选同一个文件只留一份');

    const many = [];
    for (let i = 0; i < files.MAX_FILES + 5; i++) {
      const p = path.join(tmp, `many-${i}.txt`);
      fs.writeFileSync(p, 'x');
      many.push(p);
    }
    const r = files.attachPaths('chat3', many);
    assert.strictEqual(r.attachments.length, files.MAX_FILES, `最多 ${files.MAX_FILES} 个`);
    assert.strictEqual(r.errors.length, 1, '超出上限要给出提示');

    const buf = files.attachBuffers('chat3', Array.from({ length: files.MAX_FILES + 5 }, (_, i) => ({
      name: `p${i}.png`, data: Buffer.from([0x89, 0x50]),
    })));
    assert.strictEqual(buf.attachments.length, files.MAX_FILES);
    assert.strictEqual(buf.errors.length, 1);
    files.clear('chat3');
    console.log('✓ 去重与上限');
  }

  /* ---- 10. 工作目录副本按会话回收，空目录一起收 ---- */
  {
    const generic = { proto: 'generic', bin: 'foo' };
    const att = files.attachPaths('chat4', [path.join(ws, 'README')]).attachments;
    const other = files.attachPaths('chat5', [path.join(ws, 'README')]).attachments;
    const p4 = files.prepare(generic, att, ws, 'chat4');
    const p5 = files.prepare(generic, other, ws, 'chat5');
    const local = path.join(ws, '.baton', 'attachments');
    assert(fs.existsSync(p4.files[0].path) && fs.existsSync(p5.files[0].path), '两个会话的副本都在');

    files.clear('chat4', [ws]);
    assert(!fs.existsSync(p4.files[0].path), '只收 chat4 的副本');
    assert(fs.existsSync(p5.files[0].path), '不能动别的会话的副本');
    assert(fs.existsSync(local), '还有别人的副本时目录要留着');

    files.clear('chat5', [ws]);
    assert(!fs.existsSync(local), '最后一个副本收掉后目录也该消失');
    console.log('✓ 副本按会话回收');
  }

  /* ---- 11. 孤儿附件回收：被引用的、刚加的都不能动 ---- */
  {
    const keep = files.attachPaths('chat6', [path.join(ws, 'a.ts')]).attachments[0];
    const stale = files.attachPaths('chat6', [path.join(ws, 'README')]).attachments[0];
    const fresh = files.attachPaths('chat6', [path.join(ws, 'src', 'b.ts')]).attachments[0];
    // 拨老 mtime，模拟「消息已被裁掉、文件留在盘上很久」
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale.path, old, old);
    const n = files.prune('chat6', [keep.path]);
    assert.strictEqual(n, 1, '只该回收没人引用且放旧了的那个');
    assert(fs.existsSync(keep.path), '消息里还引用着的要留着');
    assert(!fs.existsSync(stale.path), '孤儿应被回收');
    assert(fs.existsSync(fresh.path), '刚放进来的（可能还没发出去）不能动');
    files.clear('chat6');
    console.log('✓ 孤儿附件回收');
  }

  /* ---- 12. 启动清扫：只留下还存在的会话 ---- */
  {
    const kept = files.attachPaths('keepme', [path.join(ws, 'a.ts')]).attachments;
    const gone = files.attachPaths('dropme', [path.join(ws, 'a.ts')]).attachments;
    assert(fs.existsSync(gone[0].path));
    const n = files.sweep(['keepme']);
    assert(n >= 1, '应清掉至少一个孤儿目录');
    assert(fs.existsSync(kept[0].path), '还在用的会话不能被清掉');
    assert(!fs.existsSync(files.dirFor('dropme')), '孤儿目录应被删除');
    files.clear('keepme');
    console.log('✓ 启动清扫');
  }

  console.log('\n全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 失败：', e && e.stack);
  process.exit(1);
});
