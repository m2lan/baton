const pty = require('@lydell/node-pty');
const args = process.argv.slice(2);
const cmd = args.join(' ');
const term = pty.spawn(process.env.ComSpec, ['/d', '/s', '/c', cmd], {
  name: 'xterm-256color', cols: 100, rows: 26, cwd: 'E:\doc\ai-example\qoder\example2',
  env: { ...process.env, TERM: 'xterm-256color' },
});
let out = '';
term.onData((d) => { out += d; });
const dump = () => JSON.stringify(out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').slice(-500));
term.onExit(({ exitCode }) => { console.log('EXIT', exitCode, dump()); process.exit(0); });
setTimeout(() => { console.log('RUNNING', dump()); term.kill(); process.exit(0); }, 6000);
