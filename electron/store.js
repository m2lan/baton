'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

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
  const s = readJson(botsFile(), null) || { bots: [], settings: {} };
  s.bots = Array.isArray(s.bots) ? s.bots : [];
  s.settings = s.settings || {};
  return s;
}

function saveState(state) {
  writeJson(botsFile(), state);
}

/* ---------- chats ---------- */
function getMessages(botId) {
  const d = readJson(chatFile(botId), { messages: [] });
  return Array.isArray(d.messages) ? d.messages : [];
}

function saveMessages(botId, messages) {
  const trimmed = messages.length > 600 ? messages.slice(-600) : messages;
  writeJson(chatFile(botId), { messages: trimmed });
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
