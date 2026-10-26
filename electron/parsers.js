'use strict';
/**
 * 各 CLI 的输出协议适配器
 * 统一吐出：text / thinking / toolStart / toolEnd / session / meta / error / done
 */

const ANSI = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-Za-z@]/g;

function stripAnsi(s = '') {
  return String(s).replace(ANSI, '');
}

function tryJson(line) {
  const t = line.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function textOfContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && c.type === 'text' ? c.text : c && typeof c.content === 'string' ? c.content : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') return content.text || content.message || JSON.stringify(content);
  return '';
}

/* ---------------- Claude Code / CodeBuddy ---------------- */
function claudeParser(sink) {
  let gotTextDelta = false;
  return (line) => {
    const o = tryJson(line);
    if (!o) {
      const t = stripAnsi(line).trim();
      if (t) sink.raw(t);
      return;
    }
    if (o.session_id) sink.session(o.session_id);

    if (o.type === 'system' && o.subtype === 'init') {
      sink.meta({ model: o.model, permission: o.permissionMode, tools: Array.isArray(o.tools) ? o.tools.length : 0 });
      return;
    }
    if (o.type === 'stream_event') {
      const e = o.event || {};
      const d = e.delta || {};
      if (e.type === 'content_block_delta' && d.type === 'text_delta' && d.text) {
        gotTextDelta = true;
        sink.text(d.text);
      } else if (e.type === 'content_block_delta' && d.type === 'thinking_delta' && d.thinking) {
        sink.thinking(d.thinking);
      }
      return;
    }
    if (o.type === 'assistant') {
      for (const b of (o.message && o.message.content) || []) {
        if (b.type === 'tool_use') sink.toolStart({ id: b.id, name: b.name, input: b.input });
        else if (b.type === 'text' && b.text && !gotTextDelta) sink.text(b.text);
        else if (b.type === 'thinking' && b.thinking && !gotTextDelta) sink.thinking(b.thinking);
      }
      return;
    }
    if (o.type === 'user') {
      for (const b of (o.message && o.message.content) || []) {
        if (b.type === 'tool_result') {
          sink.toolEnd({ id: b.tool_use_id, result: textOfContent(b.content), ok: !b.is_error });
        }
      }
      return;
    }
    if (o.type === 'result') {
      sink.meta({
        cost: o.total_cost_usd,
        duration: o.duration_ms,
        usage: o.usage,
        session: o.session_id,
        model: o.model,
        turns: o.num_turns,
      });
      if (o.is_error) sink.error(o.result || '执行失败');
      return;
    }
  };
}

/* ---------------- Codex ---------------- */
function codexParser(sink) {
  const names = {
    command_execution: 'Bash',
    file_change: 'Edit',
    reasoning: 'Thinking',
    message: 'Message',
    mcp_tool_call: 'MCP',
    todo_list: 'Todo',
    web_search: 'WebSearch',
  };
  return (line) => {
    const o = tryJson(line);
    if (!o) {
      const t = stripAnsi(line).trim();
      // codex 会把日志打到 stderr，忽略已知噪声
      if (t && !/^\d{4}-\d\d-\d\dT/.test(t) && !/Reading additional input/.test(t)) sink.raw(t);
      return;
    }
    if (o.type === 'thread.started') {
      sink.session(o.thread_id);
      return;
    }
    if (o.type === 'error') {
      sink.error(textOfContent(o.message) || '执行失败');
      return;
    }
    if (o.type === 'turn.failed') {
      sink.error(textOfContent(o.error && o.error.message) || '执行失败');
      return;
    }
    if (o.type === 'turn.completed') {
      sink.meta({ usage: o.usage });
      return;
    }
    if (o.type === 'item.started' || o.type === 'item.completed' || o.type === 'item.updated') {
      const it = o.item || {};
      const done = o.type === 'item.completed';
      if (it.type === 'error') {
        // item 级 error 多为告警（如模型元数据缺失），只在没有其它输出时兜底
        sink.raw(`⚠ ${textOfContent(it.message)}`);
        return;
      }
      if (it.type === 'message') {
        if (done && it.text) sink.text(it.text);
        return;
      }
      if (it.type === 'reasoning') {
        if (done && it.text) sink.thinking(it.text);
        return;
      }
      if (it.type === 'command_execution') {
        if (o.type === 'item.started') sink.toolStart({ id: it.id, name: 'Bash', input: { command: it.command } });
        if (done)
          sink.toolEnd({
            id: it.id,
            result: stripAnsi(it.aggregated_output || it.output || ''),
            ok: it.exit_code === 0 || it.exit_code === undefined,
          });
        return;
      }
      if (done) {
        sink.toolStart({
          id: it.id || Math.random().toString(36).slice(2),
          name: names[it.type] || it.type,
          input: it.changes || it.command || it.query || it,
        });
      }
    }
  };
}

/* ---------------- Gemini ---------------- */
function geminiParser(sink) {
  return (line) => {
    const o = tryJson(line);
    if (!o) {
      const t = stripAnsi(line).trim();
      if (t) sink.raw(t);
      return;
    }
    if (o.session_id || o.sessionId) sink.session(o.session_id || o.sessionId);
    const type = o.type || '';
    if (type === 'init') {
      sink.meta({ model: o.model });
      return;
    }
    if (type === 'message' || type === 'content') {
      const role = o.role || 'assistant';
      const txt = o.content ?? o.text ?? o.message;
      if (role === 'user') return;
      if (o.delta || o.partial) sink.text(textOfContent(txt));
      else sink.text(textOfContent(txt));
      return;
    }
    if (type === 'tool_use') {
      sink.toolStart({ id: o.tool_id || o.id, name: o.tool_name || o.name, input: o.parameters || o.input });
      return;
    }
    if (type === 'tool_result') {
      sink.toolEnd({ id: o.tool_id || o.id, result: textOfContent(o.output ?? o.result), ok: !o.error });
      return;
    }
    if (type === 'result') {
      sink.meta({ usage: o.stats || o.usage, duration: o.duration_ms });
      return;
    }
    if (type === 'error') {
      sink.error(textOfContent(o.message || o.error));
    }
  };
}

/* ---------------- OpenCode ---------------- */
function opencodeParser(sink) {
  return (line) => {
    const o = tryJson(line);
    if (!o) {
      const t = stripAnsi(line).trim();
      if (t) sink.raw(t);
      return;
    }
    if (o.sessionID || o.session_id) sink.session(o.sessionID || o.session_id);
    const part = o.part || {};
    if (o.type === 'error') {
      const e = o.error || {};
      const d = e.data || {};
      sink.error(d.message || e.message || textOfContent(o.error));
      return;
    }
    if (o.type === 'text') {
      sink.text(part.text || o.text || '');
      return;
    }
    if (o.type === 'reasoning') {
      sink.thinking(part.text || '');
      return;
    }
    if (o.type === 'tool' || o.type === 'tool_use') {
      const state = part.state || {};
      const name = part.tool || 'Tool';
      const status = state.status;
      if (status === 'completed' || status === 'error') {
        sink.toolEnd({ id: part.callID || part.id, result: textOfContent(state.output || state.error), ok: status !== 'error' });
      } else {
        sink.toolStart({ id: part.callID || part.id, name, input: state.input });
      }
      return;
    }
    if (o.type === 'step_finish') {
      sink.meta({ usage: part.tokens, cost: part.cost });
    }
  };
}

/* ---------------- 通用（未知 CLI） ---------------- */
const TEXT_KEYS = ['text', 'content', 'delta', 'message', 'response', 'result', 'output', 'answer'];

function deepText(o, depth = 0) {
  if (o == null || depth > 4) return '';
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return o.map((x) => deepText(x, depth + 1)).filter(Boolean).join('');
  if (typeof o === 'object') {
    for (const k of TEXT_KEYS) {
      if (typeof o[k] === 'string' && o[k].trim()) return o[k];
      if (o[k] && typeof o[k] === 'object') {
        const t = deepText(o[k], depth + 1);
        if (t) return t;
      }
    }
    for (const k of ['part', 'data', 'payload', 'event', 'item', 'message']) {
      if (o[k]) {
        const t = deepText(o[k], depth + 1);
        if (t) return t;
      }
    }
  }
  return '';
}

function genericParser(sink) {
  return (line) => {
    const o = tryJson(line);
    if (!o) {
      const t = stripAnsi(line);
      if (t.trim()) sink.raw(t);
      return;
    }
    const sid = o.session_id || o.sessionId || o.sessionID || (o.thread_id ? o.thread_id : null);
    if (sid) sink.session(sid);
    if (o.type === 'error' || o.error) {
      const err = o.error;
      const msg =
        (err && err.data && err.data.message) ||
        (err && err.message) ||
        (typeof err === 'string' ? err : '') ||
        textOfContent(o.message) ||
        '执行失败';
      sink.error(msg);
      return;
    }
    const t = deepText(o);
    if (t) sink.text(t);
  };
}

function createParser(proto, sink) {
  switch (proto) {
    case 'claude':
      return claudeParser(sink);
    case 'codex':
      return codexParser(sink);
    case 'gemini':
      return geminiParser(sink);
    case 'opencode':
      return opencodeParser(sink);
    default:
      return genericParser(sink);
  }
}

module.exports = { createParser, stripAnsi };
