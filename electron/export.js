'use strict';
/**
 * 把一段会话导出成 Markdown。
 *
 * 目标读者是「想把它贴进文档、发给同事、或者存档」的人，所以取舍是：
 *   - 正文一字不改，完整保留
 *   - 工具调用折叠进 <details>，不然几十条命令会把正文淹掉
 *   - 思考过程默认不导出（又长又几乎没有最终价值）
 */

const { L } = require('./lang');

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 文件名里不能出现的字符统一换成下划线 */
function safeName(s) {
  return String(s || L('会话', 'conversation')).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60);
}

function renderTools(tools) {
  if (!tools.length) return '';
  const lines = ['<details>', L(`<summary>工具调用 ${tools.length} 次</summary>`, `<summary>${tools.length} tool calls</summary>`), ''];
  for (const t of tools) {
    const mark = t.status === 'error' ? '❌' : t.status === 'done' ? '✅' : '⏳';
    const input = String(t.input || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    lines.push(`- ${mark} \`${t.name || 'Tool'}\`${input ? ` ${input}` : ''}`);
  }
  lines.push('', '</details>');
  return lines.join('\n');
}

/**
 * @param {object} p
 * @param {'group'|'bot'} p.kind
 * @param {string} p.title
 * @param {object} [p.group] 群聊时传，用来带出成员和决策板
 * @param {object} [p.bot]   单聊时传
 * @param {string} [p.agentName] 单聊时该 Bot 用的 CLI 名
 * @param {object[]} p.messages
 * @returns {{filename:string, markdown:string}}
 */
function buildMarkdown({ kind, title, group, bot, agentName, messages = [] }) {
  const started = messages.length ? messages[0].createdAt : Date.now();
  const out = [];

  out.push(`# ${title}`, '');
  out.push(L(
    `> 导出于 ${fmtDate(Date.now())} ${fmtTime(Date.now())} ｜ 共 ${messages.length} 条消息`,
    `> Exported ${fmtDate(Date.now())} ${fmtTime(Date.now())} | ${messages.length} messages`
  ));
  out.push(L(`> 起始于 ${fmtDate(started)} ${fmtTime(started)}`, `> Started ${fmtDate(started)} ${fmtTime(started)}`));

  if (kind === 'group' && group) {
    const names = (group.members || []).map((m) => `${m.name}${m.agentName ? `（${m.agentName}）` : ''}`);
    if (names.length) out.push(L(`> 成员：${names.join('、')}`, `> Members: ${names.join(', ')}`));
    if (group.cwd) out.push(L(`> 工作目录：\`${group.cwd}\``, `> Working directory: \`${group.cwd}\``));
  } else if (kind === 'bot' && bot) {
    if (agentName) out.push(`> CLI：${agentName}`);
    if (bot.cwd) out.push(L(`> 工作目录：\`${bot.cwd}\``, `> Working directory: \`${bot.cwd}\``));
  }
  out.push('');

  // 决策板单独一节：它比对话本身更值得先看
  const decisions = (kind === 'group' && group && group.decisions) || [];
  if (decisions.length) {
    out.push(L('## 决策板', '## Decision board'), '');
    for (const d of decisions) out.push(`- ${d}`);
    out.push('');
  }

  out.push('---', '', L('## 对话', '## Conversation'), '');

  const botName = (bot && bot.name) || 'Bot';
  const botEmoji = (bot && bot.emoji) || '🤖';

  for (const m of messages) {
    let who;
    if (m.role === 'user') who = L('👤 你', '👤 You');
    else if (m.role === 'system') who = L('⚙️ 系统', '⚙️ System');
    else if (m.sender) who = `${m.sender.emoji || '🤖'} ${m.sender.name || botName}`;
    else who = `${botEmoji} ${botName}`;

    const dur = m.duration ? ` · ${(m.duration / 1000).toFixed(1)}s` : '';
    const stop = m.meta && m.meta.timeout ? L(' · 超时停止', ' · timed out') : m.meta && m.meta.stopped ? L(' · 手动停止', ' · stopped') : '';
    out.push(`### ${who} · ${fmtTime(m.createdAt)}${dur}${stop}`, '');

    const tools = [];
    for (const part of m.parts || []) {
      if (part.type === 'text' && part.text) out.push(part.text, '');
      else if (part.type === 'tool') tools.push(part);
    }
    if (tools.length) out.push(renderTools(tools), '');

    if (m.status === 'error' && m.error) {
      out.push(L(`> ⚠️ 执行失败：`, `> ⚠️ Failed: `) + String(m.error).split('\n')[0].slice(0, 200), '');
    }
  }

  const filename = `${safeName(title)}-${fmtDate(started)}.md`;
  return { filename, markdown: out.join('\n').replace(/\n{4,}/g, '\n\n\n') };
}

module.exports = { buildMarkdown, safeName };
