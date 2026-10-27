#!/usr/bin/env node
'use strict';
/**
 * 通过 Chrome DevTools Protocol 检查渲染进程的真实 DOM。
 * 用途：Vue 生产版对模板错误是静默的，只能用实际渲染结果确认。
 *
 * 前置：应用已带 --remote-debugging-port=9222 启动
 * 用法：node scripts/cdp-check.js "<要执行的表达式>"
 */
const http = require('http');

const PORT = process.env.CDP_PORT || 9222;

function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function waitForTarget(retries = 12) {
  for (let i = 0; i < retries; i++) {
    try {
      const list = await getTargets();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('没有找到可调试的页面，应用可能没起来');
}

function evaluate(page, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('执行超时'));
    }, 15000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(
        JSON.stringify({
          id: 2,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 2) {
        clearTimeout(timer);
        ws.close();
        if (m.result && m.result.exceptionDetails) {
          reject(new Error(m.result.exceptionDetails.text + ' ' + (m.result.exceptionDetails.exception || '').description || ''));
        } else {
          resolve(m.result && m.result.result ? m.result.result.value : undefined);
        }
      }
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error('WebSocket 错误'));
    };
  });
}

(async () => {
  const expr = process.argv[2];
  if (!expr) {
    console.error('用法: node scripts/cdp-check.js "<表达式>"');
    process.exit(1);
  }
  const page = await waitForTarget();
  const value = await evaluate(page, expr);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
})().catch((e) => {
  console.error('检查失败:', e.message);
  process.exit(1);
});
