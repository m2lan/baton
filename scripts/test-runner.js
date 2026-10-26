/* 无界面测试：直接跑 Runner，验证 spawn + 流式解析 */
const { Runner } = require('../electron/runner');
const { getAgent } = require('../electron/agents');

const id = process.argv[2] || 'claude';
const agent = getAgent(id);
if (!agent) {
  console.error('unknown agent', id);
  process.exit(1);
}

let parts = [];
const emit = (ch, p) => {
  if (ch === 'run:msg') {
    const m = p.msg;
    const cur = m.parts.map((x) => `${x.type}:${(x.text || x.name || '').length}`).join(' ');
    process.stdout.write(`\r[parts] ${cur}          `);
  } else if (ch === 'run:done') {
    const m = p.msg;
    console.log('\n=== done ===');
    for (const x of m.parts) {
      if (x.type === 'text') console.log(`[text] ${x.text}`);
      if (x.type === 'thinking') console.log(`[thinking] ${x.text.slice(0, 200)}`);
      if (x.type === 'tool') console.log(`[tool:${x.status}] ${x.name} ${String(x.input).slice(0, 120)} -> ${String(x.result || '').slice(0, 120)}`);
    }
    console.log('meta:', JSON.stringify(m.meta), 'status:', m.status, 'session:', m.sessionId);
  }
};

const runner = new Runner({
  emit,
  onSession: (b, s) => console.log('session ->', s),
  onMessage: () => {},
});

const bot = { id: 'test', cwd: process.cwd(), model: '', permission: 'auto', systemPrompt: '' };
const r = runner.run(bot, agent, process.argv[3] || '用一句话介绍你自己，不要调用任何工具');
console.log('run ->', r.ok, r.error || r.msg?.id);
setTimeout(() => {
  console.log('\n(times up)');
  process.exit(0);
}, 60000);
