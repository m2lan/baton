'use strict';
/**
 * CLI 目录 + 调用协议定义
 * 每个 agent 描述：怎么检测、怎么装、怎么用一个 prompt 调起来、输出是什么协议
 */

const CATALOG = [
  {
    id: 'claude',
    name: 'Claude Code',
    emoji: '✳️',
    color: '#D97757',
    tag: '长任务 · 代码重构',
    desc: 'Anthropic 官方终端 Agent，工程改造和长上下文最稳',
    bin: 'claude',
    proto: 'claude',
    stdinPrompt: true,
    session: true,
    permission: true,
    install: { kind: 'npm', pkg: '@anthropic-ai/claude-code' },
    login: 'claude',
    docs: 'https://claude.com/claude-code',
    models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy CLI',
    emoji: '🐧',
    color: '#3D7BFF',
    tag: 'WorkBuddy 同源',
    desc: '腾讯 CodeBuddy / WorkBuddy 的终端版，中文场景顺手',
    bin: 'codebuddy',
    proto: 'claude',
    stdinPrompt: true,
    session: true,
    permission: true,
    needsPort: true, // 它的默认本地端口 61172 常被 WorkBuddy 宿主占用，必须换端口
    install: { kind: 'npm', pkg: '@tencent-ai/codebuddy-code' },
    login: 'codebuddy',
    docs: 'https://copilot.tencent.com',
    models: [],
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    emoji: '⚡',
    color: '#10A37F',
    tag: '写代码 · 跑命令',
    desc: 'OpenAI 官方 Codex CLI，沙箱内自主执行',
    bin: 'codex',
    proto: 'codex',
    stdinPrompt: true,
    session: true,
    permission: true,
    install: { kind: 'npm', pkg: '@openai/codex' },
    login: 'codex login --device-auth',
    docs: 'https://github.com/openai/codex',
    models: [],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    emoji: '✦',
    color: '#4285F4',
    tag: '大窗口 · 资料调研',
    desc: 'Google 官方 CLI，百万上下文适合啃长文档',
    bin: 'gemini',
    proto: 'gemini',
    stdinPrompt: true,
    session: true,
    permission: true,
    install: { kind: 'npm', pkg: '@google/gemini-cli' },
    login: 'gemini',
    docs: 'https://github.com/google-gemini/gemini-cli',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    emoji: '◐',
    color: '#F5A524',
    tag: '多模型 · 可换后端',
    desc: '开源终端 Agent，可接任意模型服务商',
    bin: 'opencode',
    proto: 'opencode',
    stdinPrompt: false,
    session: true,
    permission: false,
    install: { kind: 'npm', pkg: 'opencode-ai' },
    login: 'opencode auth login',
    docs: 'https://opencode.ai',
    models: [],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    emoji: '🐙',
    color: '#7C8AA5',
    tag: 'GitHub 生态',
    desc: 'GitHub 官方 CLI，issue / PR 场景顺',
    bin: 'copilot',
    proto: 'generic',
    stdinPrompt: false,
    session: false,
    permission: true,
    install: { kind: 'npm', pkg: '@github/copilot' },
    login: 'copilot',
    docs: 'https://github.com/github/copilot-cli',
    models: [],
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    emoji: '🛰️',
    color: '#8A8F98',
    tag: 'xAI',
    desc: '社区版 Grok 终端客户端',
    bin: 'grok',
    proto: 'generic',
    stdinPrompt: false,
    session: false,
    permission: false,
    install: { kind: 'npm', pkg: '@vibe-kit/grok-cli' },
    login: 'grok',
    docs: 'https://github.com/superagent-ai/grok-cli',
    models: [],
  },
  {
    id: 'qoder',
    name: 'Qoder CLI',
    emoji: '🌊',
    color: '#2F6BFF',
    tag: '阿里 · 仓库级理解',
    desc: 'Qoder 终端版，需要先安装 Qoder 客户端获取',
    bin: 'qoder',
    proto: 'generic',
    stdinPrompt: false,
    session: false,
    permission: false,
    install: { kind: 'manual', url: 'https://qoder.com', hint: '从 Qoder 官网下载客户端后在设置里启用 CLI' },
    login: 'qoder',
    docs: 'https://qoder.com',
    models: [],
  },
  {
    id: 'cursor-agent',
    name: 'Cursor CLI',
    emoji: '🖱️',
    color: '#5B6472',
    tag: 'Cursor 订阅复用',
    desc: '复用 Cursor 订阅的终端 Agent',
    bin: 'cursor-agent',
    proto: 'generic',
    stdinPrompt: false,
    session: true,
    permission: false,
    install: { kind: 'powershell', cmd: 'irm https://cursor.com/install?win32=true | iex' },
    login: 'cursor-agent login',
    docs: 'https://cursor.com/cli',
    models: [],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    emoji: '🐫',
    color: '#615CED',
    tag: '通义 · 国内直连',
    desc: '通义千问终端 Agent，国内网络友好',
    bin: 'qwen',
    proto: 'gemini',
    stdinPrompt: false,
    session: true,
    permission: true,
    install: { kind: 'npm', pkg: '@qwen-code/qwen-code' },
    login: 'qwen',
    docs: 'https://github.com/QwenLM/qwen-code',
    models: [],
  },
  {
    id: 'amp',
    name: 'Amp',
    emoji: '🔆',
    color: '#FF6B35',
    tag: 'Sourcegraph',
    desc: 'Sourcegraph 出品的终端 Agent',
    bin: 'amp',
    proto: 'generic',
    stdinPrompt: false,
    session: true,
    permission: false,
    install: { kind: 'npm', pkg: '@sourcegraph/amp' },
    login: 'amp login',
    docs: 'https://ampcode.com',
    models: [],
  },
  {
    id: 'aider',
    name: 'Aider',
    emoji: '🧷',
    color: '#4CAF50',
    tag: '经典 · git 友好',
    desc: '老牌结对编程 CLI，每次改动自动 commit',
    bin: 'aider',
    proto: 'generic',
    stdinPrompt: false,
    session: false,
    permission: false,
    install: { kind: 'cmd', cmd: 'python -m pip install -U aider-chat' },
    login: '',
    docs: 'https://aider.chat',
    models: [],
  },
];

function getAgent(id) {
  return CATALOG.find((a) => a.id === id) || null;
}

/** 权限模式映射：统一 UI 用 auto / default / plan / readonly */
function permissionArgs(agent, permission) {
  const p = permission || 'auto';
  switch (agent.proto) {
    case 'claude':
      // auto -> bypassPermissions 让 Bot 自己跑完；plan -> 只读规划
      return ['--permission-mode', p === 'plan' ? 'plan' : p === 'default' ? 'default' : 'bypassPermissions'];
    case 'codex': {
      const sandbox = p === 'plan' || p === 'readonly' ? 'read-only' : 'workspace-write';
      return ['--sandbox', sandbox];
    }
    case 'gemini':
      return ['--approval-mode', p === 'plan' ? 'plan' : p === 'default' ? 'default' : 'yolo'];
    case 'copilot':
      return p === 'plan' || p === 'readonly' ? [] : ['--allow-all-tools'];
    default:
      return [];
  }
}

/**
 * 构造一次调用的命令行
 * @returns {{file:string, args:string[], stdin?:string, proto:string}}
 */
function buildInvocation(agent, opts) {
  const { prompt, sessionId, model, permission, systemPrompt, resume } = opts;
  const full = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
  const useResume = !!(resume && sessionId);

  if (agent.proto === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    args.push(...permissionArgs(agent, permission));
    if (model) args.push('--model', model);
    if (useResume) args.push('--resume', sessionId);
    else if (sessionId) args.push('--session-id', sessionId);
    return { file: agent.bin, args, stdin: full, proto: 'claude' };
  }

  if (agent.proto === 'codex') {
    const args = ['exec', '--json', '--skip-git-repo-check', ...permissionArgs(agent, permission)];
    if (model) args.push('--model', model);
    if (useResume) return { file: agent.bin, args: [...args, 'resume', sessionId, '-'], stdin: full, proto: 'codex' };
    return { file: agent.bin, args: [...args, '-'], stdin: full, proto: 'codex' };
  }

  if (agent.proto === 'gemini') {
    const args = ['--output-format', 'stream-json', ...permissionArgs(agent, permission)];
    if (model) args.push('-m', model);
    if (useResume) args.push('--resume', sessionId);
    else if (sessionId) args.push('--session-id', sessionId);
    if (agent.stdinPrompt) return { file: agent.bin, args, stdin: full, proto: 'gemini' };
    return { file: agent.bin, args: [...args, '-p', full], proto: 'gemini' };
  }

  if (agent.proto === 'opencode') {
    const args = ['run', '--format', 'json'];
    if (model) args.push('-m', model);
    if (useResume) args.push('-s', sessionId);
    args.push(full);
    return { file: agent.bin, args, proto: 'opencode' };
  }

  // generic：不认识的 CLI，退化成"把 prompt 当参数传进去，按文本流接"
  const args = [...(agent.baseArgs || [])];
  if (model && agent.proto === 'generic' && agent.modelFlag) args.push(agent.modelFlag, model);
  if (useResume && sessionId && agent.resumeFlag) args.push(agent.resumeFlag, sessionId);
  if (agent.printFlag) args.push(agent.printFlag);
  args.push(full);
  return { file: agent.bin, args, proto: 'generic' };
}

module.exports = { CATALOG, getAgent, buildInvocation };
