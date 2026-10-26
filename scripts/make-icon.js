/* 生成应用图标：用 Electron 渲染一张 512x512 PNG */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets', 'icon.png');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:512px;height:512px;background:transparent;display:grid;place-items:center}
    .ic{width:512px;height:512px;border-radius:120px;display:grid;place-items:center;
        background:linear-gradient(135deg,#6d5cff 0%,#9d7bff 55%,#c084fc 100%);
        box-shadow:inset 0 -18px 60px rgba(0,0,0,.25);position:relative}
    .ic:after{content:"";position:absolute;inset:0;border-radius:120px;
        background:radial-gradient(70% 50% at 30% 12%,rgba(255,255,255,.45),transparent 60%)}
    span{font:700 300px/1 "Segoe UI Symbol",-apple-system,"Segoe UI",sans-serif;color:#fff;
         text-shadow:0 10px 30px rgba(40,20,120,.45);transform:translateY(-6px)}
  </style></head><body><div class="ic"><span>◈</span></div></body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(OUT, img.toPNG());
  console.log('icon ->', OUT);
  app.quit();
});
