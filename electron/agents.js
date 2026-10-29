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
    tagEn: 'Long tasks · refactoring',
    desc: 'Anthropic 官方终端 Agent，工程改造和长上下文最稳',
    descEn: 'Anthropic\'s terminal agent, strongest on big refactors and long context',
    bin: 'claude',
    proto: 'claude',
    stdinPrompt: true,
    session: true,
    permission: true,
    install: { kind: 'npm', pkg: '@anthropic-ai/claude-code' },
    login: 'claude',
    docs: 'https://claude.com/claude-code',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy CLI',
    emoji: '🐧',
    color: '#3D7BFF',
    tag: 'WorkBuddy 同源',
    tagEn: 'Same core as WorkBuddy',
    desc: '腾讯 CodeBuddy / WorkBuddy 的终端版，中文场景顺手',
    descEn: 'Terminal edition of Tencent CodeBuddy / WorkBuddy, comfortable in Chinese',
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
    tagEn: 'Code · commands',
    desc: 'OpenAI 官方 Codex CLI，沙箱内自主执行',
    descEn: 'OpenAI\'s Codex CLI, runs autonomously in a sandbox',
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
    tagEn: 'Huge context · research',
    desc: 'Google 官方 CLI，百万上下文适合啃长文档',
    descEn: 'Google\'s CLI; a million-token context for long documents',
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
    tagEn: 'Any model · swappable backend',
    desc: '开源终端 Agent，可接任意模型服务商',
    descEn: 'Open-source terminal agent that works with any model provider',
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
    tagEn: 'GitHub ecosystem',
    desc: 'GitHub 官方 CLI，issue / PR 场景顺',
    descEn: 'GitHub\'s CLI, at home with issues and PRs',
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
    descEn: 'Community Grok terminal client',
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
    tagEn: 'Alibaba · repo-level understanding',
    desc: 'Qoder 官方终端 Agent，复用 Qoder 账号额度',
    descEn: 'Qoder\'s terminal agent, uses your Qoder account quota',
    bin: 'qodercli',
    proto: 'qoder',
    stdinPrompt: true,
    session: true,
    permission: true,
    install: { kind: 'npm', pkg: '@qoder-ai/qodercli' },
    login: 'qodercli login',
    docs: 'https://docs.qoder.com/zh/cli/overview',
    models: [],
  },
  {
    id: 'cursor-agent',
    name: 'Cursor CLI',
    emoji: '🖱️',
    color: '#5B6472',
    tag: 'Cursor 订阅复用',
    tagEn: 'Uses your Cursor plan',
    desc: '复用 Cursor 订阅的终端 Agent',
    descEn: 'Terminal agent on your Cursor subscription',
    bin: 'cursor-agent',
    proto: 'generic',
    stdinPrompt: false,
    session: true,
    permission: false,
    install: {
      kind: 'script',
      win: 'irm https://cursor.com/install?win32=true | iex',
      mac: 'curl https://cursor.com/install -fsS | bash',
      linux: 'curl https://cursor.com/install -fsS | bash',
    },
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
    tagEn: 'Qwen · direct in China',
    desc: '通义千问终端 Agent，国内网络友好',
    descEn: 'Qwen terminal agent, works well on networks in China',
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
    descEn: 'Terminal agent by Sourcegraph',
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
    tagEn: 'Classic · git-friendly',
    desc: '老牌结对编程 CLI，每次改动自动 commit',
    descEn: 'Veteran pair-programming CLI that commits every change',
    bin: 'aider',
    proto: 'generic',
    stdinPrompt: false,
    session: false,
    permission: false,
    install: {
      kind: 'cmd',
      win: 'python -m pip install -U aider-chat',
      mac: 'python3 -m pip install -U aider-chat',
      linux: 'python3 -m pip install -U aider-chat',
      unix: 'python3 -m pip install -U aider-chat',
      cmd: 'python -m pip install -U aider-chat',
    },
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
    case 'qoder':
      // qodercli 的权限枚举：bypass_permissions / dont_ask / auto
      return ['--permission-mode', p === 'plan' ? 'auto' : p === 'default' ? 'dont_ask' : 'bypass_permissions'];
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

  if (agent.proto === 'qoder') {
    const args = ['-p', '--output-format', 'stream-json'];
    args.push(...permissionArgs(agent, permission));
    if (model) args.push('-m', model);
    if (useResume) args.push('--resume', sessionId);
    else if (sessionId) args.push('--session-id', sessionId);
    return { file: agent.bin, args, stdin: full, proto: 'qoder' };
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
