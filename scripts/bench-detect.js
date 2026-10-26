/* 测速：fast / full(冷) / full(缓存命中) */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { Detector } = require('../electron/detect');
const { CATALOG } = require('../electron/agents');

const cacheFile = path.join(os.tmpdir(), 'lb-detect-bench.json');
try {
  fs.unlinkSync(cacheFile);
} catch {}

(async () => {
  const d = new Detector({ cacheFile });

  let t = Date.now();
  const fast = d.fast(CATALOG);
  console.log(`fast(冷): ${Date.now() - t}ms，已装 ${fast.filter((a) => a.installed).length} 个`);

  t = Date.now();
  const full = await d.full(CATALOG, (partial) => {
    const done = partial.filter((a) => a.installed && a.version).length;
    process.stdout.write(`\r  探测中… 已完成 ${done} 个   `);
  });
  console.log(`\nfull(冷): ${Date.now() - t}ms`);
  console.log('  ' + full.filter((a) => a.installed).map((a) => `${a.id}@${a.version}`).join('  '));

  const d2 = new Detector({ cacheFile });
  t = Date.now();
  const fast2 = d2.fast(CATALOG);
  console.log(`fast(有缓存): ${Date.now() - t}ms，带版本 ${fast2.filter((a) => a.version).length} 个`);

  const d3 = new Detector({ cacheFile });
  t = Date.now();
  await d3.full(CATALOG);
  console.log(`full(缓存命中): ${Date.now() - t}ms`);
})();
