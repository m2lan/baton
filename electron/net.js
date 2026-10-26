'use strict';
/**
 * 网络/代理策略：子进程（CLI 运行、内嵌终端、npm 安装）共用一套环境变量处理。
 * 默认直连 —— 系统里存在 127.0.0.1 这类本地代理时，很多 CLI 的 TLS 会被重置。
 */
const net = require('net');
const tls = require('tls');

const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
// WorkBuddy/CodeBuddy 宿主注入的内部变量，别让被拉起的 CLI 继承
const HOST_KEYS = ['CODEBUDDY_SERVICE_PROXY_URL', 'CODEBUDDY_MCP_CONFIG'];

let cfg = { mode: 'direct', url: '' };

function setConfig(next) {
  cfg = { ...cfg, ...(next || {}) };
  if (!['direct', 'inherit', 'custom'].includes(cfg.mode)) cfg.mode = 'direct';
  return cfg;
}

function getConfig() {
  return { ...cfg };
}

/** 就地把代理相关变量写进 env */
function applyProxy(env) {
  for (const k of PROXY_KEYS) delete env[k];
  for (const k of HOST_KEYS) delete env[k];

  if (cfg.mode === 'custom' && cfg.url) {
    env.HTTP_PROXY = env.http_proxy = cfg.url;
    env.HTTPS_PROXY = env.https_proxy = cfg.url;
  } else if (cfg.mode === 'inherit') {
    for (const k of PROXY_KEYS) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
  }
  return env;
}

function parseProxy(url) {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url}`);
    return { host: u.hostname, port: Number(u.port || 80), auth: u.username ? `${u.username}:${u.password}` : '' };
  } catch {
    return null;
  }
}

/** 直连做一次 TLS 握手 */
function probeDirect(host, timeout = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const sock = tls.connect({ host, port: 443, servername: host, timeout }, () => {
      if (done) return;
      done = true;
      resolve({ ok: true, ms: Date.now() - started });
      sock.destroy();
    });
    sock.on('error', (e) => {
      if (done) return;
      done = true;
      resolve({ ok: false, ms: Date.now() - started, error: e.code || e.message });
    });
    sock.on('timeout', () => {
      if (done) return;
      done = true;
      resolve({ ok: false, ms: Date.now() - started, error: 'TIMEOUT' });
      sock.destroy();
    });
  });
}

/** 经 HTTP 代理 CONNECT，再做 TLS 握手 */
function probeViaProxy(host, proxyUrl, timeout = 8000) {
  return new Promise((resolve) => {
    const p = parseProxy(proxyUrl);
    const started = Date.now();
    if (!p) return resolve({ ok: false, ms: 0, error: 'BAD_PROXY_URL' });

    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve({ ...r, ms: Date.now() - started });
      try {
        sock.destroy();
      } catch {}
    };

    const sock = net.connect({ host: p.host, port: p.port });
    sock.setTimeout(timeout);
    sock.on('timeout', () => finish({ ok: false, error: 'TIMEOUT' }));
    sock.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    sock.on('connect', () => {
      const auth = p.auth ? `Proxy-Authorization: Basic ${Buffer.from(p.auth).toString('base64')}\r\n` : '';
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${auth}\r\n`);
    });

    let buf = '';
    sock.on('data', function onData(chunk) {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      const status = Number((buf.match(/^HTTP\/1\.[01]\s+(\d{3})/) || [])[1] || 0);
      if (status !== 200) return finish({ ok: false, error: `PROXY_HTTP_${status || 'ERR'}` });
      const secure = tls.connect({ socket: sock, servername: host, timeout }, () => finish({ ok: true }));
      secure.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
      secure.on('timeout', () => finish({ ok: false, error: 'TLS_TIMEOUT' }));
    });
  });
}

const HOSTS = ['copilot.tencent.com', 'api.openai.com', 'registry.npmjs.org'];

async function diagnose() {
  const mode = cfg.mode;
  const url = cfg.url;
  const results = [];
  for (const host of HOSTS) {
    const r =
      mode === 'custom' && url
        ? await probeViaProxy(host, url)
        : mode === 'inherit' && (process.env.HTTPS_PROXY || process.env.https_proxy)
        ? await probeViaProxy(host, process.env.HTTPS_PROXY || process.env.https_proxy)
        : await probeDirect(host);
    results.push({ host, ...r });
  }
  return {
    mode,
    url,
    envProxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
    results,
  };
}

module.exports = { setConfig, getConfig, applyProxy, diagnose, probeDirect, probeViaProxy };
