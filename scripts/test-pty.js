/* 用真实 pty 模块在 Electron 里验证 CLI 的交互式启动
   用法: electron scripts/test-pty.js <agentId|raw> <login|shell|raw:命令> [ms] */
const { app } = require('electron');
const { buildEnv } = require('../electron/runner');
const { getAgent } = require('../electron/agents');
const proxy = require('../electron/net');

const agentId = process.argv[2] || 'codebuddy';
const mode = process.argv[3] || 'login';
const waitMs = Number(process.argv[4] || 8000);
const CWD = 'E:\\doc\\ai-example\\qoder\\example2';

const strip = (s) =>
  String(s)
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function finish(label, extra) {
  console.log(label, extra);
  setTimeout(() => app.exit(0), 500);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const pty = require('@lydell/node-pty');
  proxy.setConfig({ mode: 'direct' });
  const env = { ...buildEnv({ tty: true }), TERM: 'xterm-256color', COLORTERM: 'truecolor' };

  if (!mode.startsWith('raw:')) {
    const terminal = require('../electron/pty');
    const agent = getAgent(agentId);
    const r = await terminal.open({ botId: 'test', bot: { id: 'test', cwd: CWD }, agent, mode, cols: 100, rows: 28 });
    console.log('OPEN', JSON.stringify(r));
    let out = '';
    terminal.bind(r.id, (_i, d) => (out += d), (_i, code) => finish('EXIT', code + ' ' + JSON.stringify(strip(out).slice(-700))));
    setTimeout(() => {
      finish('ALIVE', JSON.stringify(strip(out).slice(-700)));
      terminal.close(r.id);
    }, waitMs);
    return;
  }

  const file = process.env.ComSpec || 'cmd.exe';
  const t = pty.spawn(file, ['/d', '/s', '/c', mode.slice(4)], { name: 'xterm-256color', cols: 100, rows: 28, cwd: CWD, env });
  let out = '';
  t.onData((d) => (out += d));
  t.onExit(({ exitCode }) => finish('EXIT', exitCode + ' ' + JSON.stringify(strip(out).slice(-700))));
  setTimeout(() => {
    finish('ALIVE', JSON.stringify(strip(out).slice(-700)));
    t.kill();
  }, waitMs);
});
