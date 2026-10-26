/* 生成应用图标：用 Electron 渲染一张高分辨率 PNG（打包时由 electron-builder 转 ico/icns） */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = Number(process.argv.find((a) => a.startsWith('--size='))?.split('=')[1] || 1024);
const OUTS = [
  path.join(__dirname, '..', 'assets', 'icon.png'),
  path.join(__dirname, '..', 'build', 'icon.png'),
];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  for (const out of OUTS) fs.mkdirSync(path.dirname(out), { recursive: true });
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent;display:grid;place-items:center}
    .ic{width:${SIZE}px;height:${SIZE}px;border-radius:${Math.round(SIZE * 0.234)}px;display:grid;place-items:center;
        background:linear-gradient(135deg,#6d5cff 0%,#9d7bff 55%,#c084fc 100%);
        box-shadow:inset 0 ${Math.round(-SIZE * 0.035)}px ${Math.round(SIZE * 0.117)}px rgba(0,0,0,.25);position:relative}
    .ic:after{content:"";position:absolute;inset:0;border-radius:${Math.round(SIZE * 0.234)}px;
        background:radial-gradient(70% 50% at 30% 12%,rgba(255,255,255,.45),transparent 60%)}
    span{font:700 ${Math.round(SIZE * 0.586)}px/1 "Segoe UI Symbol",-apple-system,"Segoe UI",sans-serif;color:#fff;
         text-shadow:0 ${Math.round(SIZE * 0.02)}px ${Math.round(SIZE * 0.059)}px rgba(40,20,120,.45);
         transform:translateY(${Math.round(-SIZE * 0.012)}px)}
  </style></head><body><div class="ic"><span>◈</span></div></body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  for (const out of OUTS) {
    fs.writeFileSync(out, img.toPNG());
    console.log('icon ->', out, `${SIZE}x${SIZE}`);
  }
  app.quit();
});
