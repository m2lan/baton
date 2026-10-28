'use strict';
/**
 * 网络/代理策略：子进程（CLI 运行、内嵌终端、npm 安装）共用一套环境变量处理。
 *
 * 重要：默认「智能」模式，按 CLI 区分，绝不无脑剥代理。
 *  - 国内 CLI（codebuddy / qwen …）→ 直连。它们自己的 setProxy 在拿到代理变量时会抛
 *    TypeError，随后报 "socket disconnected before secure TLS connection"。
 *  - 海外 CLI（claude / gemini / codex / copilot …）→ 沿用系统代理。这些账号往往依赖
 *    固定地区出口，突然直连会让 IP/地区突变，有风控甚至封号风险。
 */
const net = require('net');
const tls = require('tls');
const { L } = require('./lang');

const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
// WorkBuddy/CodeBuddy 宿主注入的内部变量，别让被拉起的 CLI 继承
const HOST_KEYS = [
  'CODEBUDDY_SERVICE_PROXY_URL',
  'CODEBUDDY_MCP_CONFIG',
  // 宿主 app 自己的守护端口，带过去只会让子进程去抢它已经占住的端口
  'CODEBUDDY_DESKTOP_DAEMON_STABLE_PORT',
  'CODEBUDDY_DAEMON_CONFIGURED_PORT',
  'CODEBUDDY_IDE_PORT',
  'CLAUDE_CODE_SSE_PORT',
  // 宿主 app 自己的 HTTP 服务端口（实测 CLI 会读 SERVER__PORT 去 listen）
  'SERVER__PORT',
  // 宿主强制 headless/lite 打包：带过去 CLI 就不出界面、直接退出
  'CODEBUDDY_FORCE_HEADLESS_BUNDLE',
  'CODEBUDDY_FORCE_LITE_WB_BUNDLE',
  'CODEBUDDY_HOST',
];

/** 这些 CLI 的后端在国内，直连更稳，且对代理变量敏感 */
const DOMESTIC = new Set(['codebuddy', 'qwen', 'mimo', 'qoder', 'iflow']);

const MODES = ['auto', 'direct', 'inherit', 'custom'];

let cfg = { mode: 'auto', url: '', perAgent: {} };

function setConfig(next) {
  cfg = { ...cfg, ...(next || {}) };
  if (!MODES.includes(cfg.mode)) cfg.mode = 'auto';
  cfg.perAgent = cfg.perAgent && typeof cfg.perAgent === 'object' ? cfg.perAgent : {};
  return cfg;
}

function getConfig() {
  return { ...cfg, perAgent: { ...cfg.perAgent } };
}

/**
 * 某个 CLI 实际生效的模式
 * @param agentId 不传（如 npm 安装）时按「海外」处理，避免装不上包
 */
function modeFor(agentId) {
  if (agentId && cfg.perAgent && cfg.perAgent[agentId]) return cfg.perAgent[agentId];
  if (cfg.mode !== 'auto') return cfg.mode;
  if (!agentId) return 'inherit';
  return DOMESTIC.has(agentId) ? 'direct' : 'inherit';
}

/** 就地把代理相关变量写进 env */
function applyProxy(env, agentId) {
  for (const k of PROXY_KEYS) delete env[k];
  for (const k of HOST_KEYS) delete env[k];

  const mode = modeFor(agentId);
  if (mode === 'custom' && cfg.url) {
    env.HTTP_PROXY = env.http_proxy = cfg.url;
    env.HTTPS_PROXY = env.https_proxy = cfg.url;
    return env;
  }
  if (mode === 'inherit') {
    for (const k of PROXY_KEYS) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
    return env;
  }

  // 直连：光删环境变量不够 —— codebuddy 会自己读 Windows 注册表里的系统代理
  // （日志里的 "ProxyResolver OS proxy detected"），必须用 NO_PROXY 明确让它别走代理
  env.NO_PROXY = env.no_proxy = '*';
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

/** 每个域名对应哪个 CLI 的策略 */
const HOSTS = [
  { host: 'api.anthropic.com', agentId: 'claude', label: 'Claude' },
  { host: 'api.openai.com', agentId: 'codex', label: 'Codex' },
  { host: 'copilot.tencent.com', agentId: 'codebuddy', label: 'CodeBuddy' },
  { host: 'registry.npmjs.org', agentId: null, label: 'npm' },
];

async function diagnose() {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const rows = await Promise.all(
    HOSTS.map(async (h) => {
      const mode = modeFor(h.agentId);
      let r;
      if (mode === 'custom' && cfg.url) r = await probeViaProxy(h.host, cfg.url);
      else if (mode === 'inherit' && envProxy) r = await probeViaProxy(h.host, envProxy);
      else r = await probeDirect(h.host);
      const used = mode === 'custom' && cfg.url ? L('自定义代理', 'custom proxy') : mode === 'inherit' && envProxy ? L('代理', 'proxy') : L('直连', 'direct');
      return { ...h, mode, used, ...r };
    })
  );
  return { mode: cfg.mode, url: cfg.url, envProxy, results: rows };
}

module.exports = { setConfig, getConfig, modeFor, applyProxy, diagnose, probeDirect, probeViaProxy, DOMESTIC };
