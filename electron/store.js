'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { L } = require('./lang');

let ROOT = null;
function root() {
  if (!ROOT) ROOT = path.join(app.getPath('userData'), 'data');
  return ROOT;
}
function ensure() {
  fs.mkdirSync(path.join(root(), 'chats'), { recursive: true });
}
const botsFile = () => path.join(root(), 'bots.json');
const chatFile = (id) => path.join(root(), 'chats', `${id}.json`);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensure();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- state (bots + settings) ---------- */
function loadState() {
  const s = readJson(botsFile(), null) || { bots: [], groups: [], settings: {} };
  s.bots = Array.isArray(s.bots) ? s.bots : [];
  s.groups = Array.isArray(s.groups) ? s.groups : [];
  s.settings = s.settings || {};
  return s;
}

function saveState(state) {
  writeJson(botsFile(), state);
}

/* ---------- chats ---------- */
const MAX_MESSAGES = 600; // 会话文件整份读写，不设上限会越用越慢

function getMessages(botId) {
  const d = readJson(chatFile(botId), { messages: [] });
  return Array.isArray(d.messages) ? d.messages : [];
}

/**
 * 每个会话只保留最近 MAX_MESSAGES 条。
 * 丢掉的部分不能无声消失：在会话开头放一条系统提示写明丢了多少，
 * 之后每次再丢都在同一条上累加，界面和导出都能看到。
 */
function saveMessages(botId, messages) {
  const head = messages[0];
  const omitted = head && head.meta && Number.isInteger(head.meta.omitted) ? head.meta.omitted : 0;
  const real = omitted ? messages.slice(1) : messages;
  if (real.length <= MAX_MESSAGES) {
    writeJson(chatFile(botId), { messages });
    return;
  }
  const total = omitted + real.length - MAX_MESSAGES;
  const note = {
    id: 'sys_trimmed',
    role: 'system',
    parts: [{
      type: 'text',
      text: L(
        `更早的 ${total} 条消息已超出本地保留上限（每个会话保留最近 ${MAX_MESSAGES} 条），不再显示。`,
        `${total} earlier messages are beyond the local retention limit (last ${MAX_MESSAGES} per chat) and are no longer shown.`
      ),
    }],
    status: 'done',
    createdAt: head ? head.createdAt : Date.now(),
    meta: { omitted: total },
  };
  writeJson(chatFile(botId), { messages: [note, ...real.slice(-MAX_MESSAGES)] });
}

function appendMessage(botId, msg) {
  const list = getMessages(botId);
  list.push(msg);
  saveMessages(botId, list);
  return msg;
}

function clearMessages(botId) {
  writeJson(chatFile(botId), { messages: [] });
}

function deleteChat(botId) {
  try {
    fs.unlinkSync(chatFile(botId));
  } catch {}
}

module.exports = {
  root,
  loadState,
  saveState,
  getMessages,
  saveMessages,
  appendMessage,
  clearMessages,
  deleteChat,
};
