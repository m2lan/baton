#!/usr/bin/env node
'use strict';
/**
 * 打包入口。集中处理三件容易踩的事：
 *   1. 目标平台/架构校验（mac 只能在 macOS 上打；原生模块要按平台装）
 *   2. 国内镜像（Electron 与 electron-builder 的 binaries 默认走 npmmirror）
 *   3. 打包前自检（入口、vendor、图标、原生模块）
 *
 * 用法：
 *   npm run dist              # 当前平台的完整安装包
 *   npm run dist:win          # Windows：nsis + portable
 *   npm run dist:mac          # macOS：dmg + zip（必须在 macOS 上跑）
 *   npm run dist:linux        # Linux：AppImage + deb
 *   npm run pack              # 只出免安装目录，用来快速验证
 *   node scripts/dist.js --arch=x64        # 只打一个架构
 *   LOCALBOT_OFFICIAL_MIRROR=1 npm run dist  # 走官方源
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const args = process.argv.slice(2);

const NATIVE = {
  win32: { x64: '@lydell/node-pty-win32-x64', arm64: '@lydell/node-pty-win32-arm64' },
  darwin: { x64: '@lydell/node-pty-darwin-x64', arm64: '@lydell/node-pty-darwin-arm64' },
  linux: { x64: '@lydell/node-pty-linux-x64', arm64: '@lydell/node-pty-linux-arm64' },
};
const LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const PLATFORM_MAP = { win32: 'WINDOWS', darwin: 'MAC', linux: 'LINUX' };

const hasFlag = (name) => args.includes(`--${name}`);
const optValue = (name, fallback = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const log = (m) => process.stdout.write(`${m}\n`);
const fail = (m) => {
  process.stderr.write(`\n✗ ${m}\n`);
  process.exit(1);
};

const dirOnly = hasFlag('dir');
const wantOfficial = process.env.LOCALBOT_OFFICIAL_MIRROR === '1';

/* ---------- 目标平台 ---------- */
const platforms = ['win32', 'darwin', 'linux'].filter((p) =>
  hasFlag(p === 'win32' ? 'win' : p === 'darwin' ? 'mac' : 'linux')
);
if (!platforms.length) platforms.push(process.platform);

/* ---------- 目标架构：默认读 package.json 里该平台声明的 arch，没写就用本机架构 ---------- */
function archesOfPlatform(p) {
  const cfg = (pkg.build && pkg.build[p === 'win32' ? 'win' : p === 'darwin' ? 'mac' : 'linux']) || {};
  const set = new Set();
  for (const t of cfg.target || []) {
    for (const a of (t && t.arch) || []) set.add(a);
  }
  // 没声明就跟着构建机走（mac 上不会去打 x64）
  return set.size ? [...set] : [process.arch === 'arm64' ? 'arm64' : 'x64'];
}

const archArg = optValue('arch', '');
const arches = archArg ? archArg.split(',').map((s) => s.trim()) : null;
if (arches) {
  for (const a of arches) if (!['x64', 'arm64'].includes(a)) fail(`不支持的架构 ${a}（只支持 x64 / arm64）`);
}

/* ---------- 1. 平台可行性 ---------- */
if (platforms.includes('darwin') && process.platform !== 'darwin') {
  fail(
    [
      'macOS 的 dmg/zip 必须在 macOS 上构建。',
      '',
      '原因：dmg 依赖 hdiutil，签名/公证依赖 Apple 工具链，electron-builder 在非 macOS 上会直接失败。',
      '做法：在 Mac 上 npm install && npm run dist:mac；',
      '      或用仓库自带的 .github/workflows/release.yml（GitHub Actions 的 macOS runner）。',
    ].join('\n')
  );
}
if (platforms.includes('win32') && process.platform !== 'win32') {
  log('! 在非 Windows 上打 Windows 包：能出安装包，但无法签数字证书，部分杀软会提示未知发布者。');
}

/* ---------- 2. 原生模块自检（每个目标平台+架构都要有对应二进制） ---------- */
const matrix = [];
for (const p of platforms) {
  for (const a of arches || archesOfPlatform(p)) matrix.push({ platform: p, arch: a });
}

const missing = matrix.filter(
  (m) => NATIVE[m.platform] && NATIVE[m.platform][m.arch] &&
    !fs.existsSync(path.join(ROOT, 'node_modules', NATIVE[m.platform][m.arch]))
);
if (missing.length) {
  const ver = pkg.dependencies['@lydell/node-pty'].replace(/^[^0-9]*/, '');
  fail(
    [
      '缺少目标平台的原生模块，打出来的包内嵌终端会不可用：',
      '',
      ...missing.map((m) => `  · ${LABEL[m.platform]} ${m.arch} → ${NATIVE[m.platform][m.arch]}`),
      '',
      'npm 只安装当前平台的 optionalDependencies，跨平台打包前要手动补：',
      '',
      ...missing.map((m) => `  npm i -D --no-save ${NATIVE[m.platform][m.arch]}@${ver}`),
      '',
      '更推荐的做法：到对应系统上构建（尤其 macOS），或用 CI 的三平台矩阵。',
    ].join('\n')
  );
}

/* ---------- 3. 镜像 ---------- */
if (!wantOfficial) {
  process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/';
}

/* ---------- 4. 资源自检 ---------- */
for (const [rel, what] of [
  ['electron/main.js', '主进程入口'],
  ['renderer/index.html', '渲染层'],
  ['renderer/vendor/vue.global.prod.js', 'Vue 运行时（无构建方案依赖它）'],
  ['renderer/vendor/xterm.js', '终端 UI'],
  ['renderer/vendor/xterm.css', '终端样式'],
  ['build/icon.png', '应用图标'],
]) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail(`缺少${what}：${rel}（先跑 npm install / npm run icon）`);
}
const icon = fs.readFileSync(path.join(ROOT, 'build/icon.png'));
const iw = icon.readUInt32BE(16);
const ih = icon.readUInt32BE(20);
if (iw < 512) fail(`图标至少 512×512（当前 ${iw}×${ih}），跑 npm run icon 重新生成`);

/* ---------- 5. 构建 ---------- */
const eb = require('electron-builder');
const { build, Platform, Arch } = eb;
const ARCH_MAP = { x64: Arch.x64, arm64: Arch.arm64 };

// electron-builder 覆盖旧产物时会做一次批量删除，某些环境（沙箱 / 杀软 / 只读挂载）会拦下来报
// SAFE_DELETE_BULK_CONFIRM_REQUIRED。自己先清干净，让它只需新建。--keep-output 可跳过。
const OUT_REL = optValue('out', '') || pkg.build.directories.output;
const OUT_DIR = path.isAbsolute(OUT_REL) ? OUT_REL : path.join(ROOT, OUT_REL);
if (!hasFlag('keep-output') && fs.existsSync(OUT_DIR)) {
  log(`清理旧产物 ${OUT_REL}/ …`);
  try {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  } catch (e) {
    fail(
      `清理 ${OUT_REL}/ 失败：${e.message}\n` +
        `请手动删除该目录后重试，或用 --out=xxx 输出到别处。`
    );
  }
}

const buildConfig = {
  ...pkg.build,
  directories: { ...pkg.build.directories, output: OUT_REL },
};

(async () => {
  log('');
  log(`LocalBot v${pkg.version}   构建机：${os.platform()} ${os.arch()}`);
  log(`目标：${platforms.map((p) => LABEL[p]).join(' + ')}   架构：${arches ? arches.join(', ') : '按 package.json'}`);
  log(`模式：${dirOnly ? '免安装目录（自检用）' : '完整安装包'}   源：${wantOfficial ? '官方' : 'npmmirror 镜像'}`);
  log('');

  const started = Date.now();
  for (const p of platforms) {
    const plat = Platform[PLATFORM_MAP[p]];
    const list = arches || archesOfPlatform(p);
    for (const a of list) {
      log(`→ ${LABEL[p]} ${a} …`);
      // 「dir」本身就是一个 target，不需要额外的 dir 选项
      const targets = plat.createTarget(dirOnly ? ['dir'] : undefined, ARCH_MAP[a]);
      await build({ targets, config: buildConfig });
    }
  }

  const out = OUT_DIR;
  log('');
  log(`✓ 完成，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (fs.existsSync(out)) {
    const files = fs
      .readdirSync(out)
      .map((f) => ({ f, st: fs.statSync(path.join(out, f)) }))
      .filter((x) => x.st.isFile())
      .sort((a, b) => b.st.size - a.st.size);
    if (files.length) {
      log(`产物目录：${path.relative(ROOT, out)}`);
      for (const { f, st } of files) log(`  ${(st.size / 1048576).toFixed(1).padStart(7)} MB  ${f}`);
    }
  }
})().catch((e) => {
  process.stderr.write(`\n✗ 构建失败：${e.message}\n`);
  if (process.env.DEBUG) process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
