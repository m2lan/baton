'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('lb', {
  init: () => invoke('app:init'),
  detect: () => invoke('agents:detect'),
  install: (id) => invoke('agents:install', id),
  createBot: (cfg) => invoke('bots:create', cfg),
  createGroup: (cfg) => invoke('groups:create', cfg),
  listTemplates: () => invoke('templates:list'),
  createFromTemplate: (payload) => invoke('templates:create', payload),
  updateGroup: (id, patch) => invoke('groups:update', id, patch),
  deleteGroup: (id) => invoke('groups:delete', id),
  updateBot: (id, patch) => invoke('bots:update', id, patch),
  deleteBot: (id) => invoke('bots:delete', id),
  getMessages: (botId) => invoke('chat:get', botId),
  send: (key, text, attachments) => invoke('chat:send', { key, text, attachments }),
  stop: (botId) => invoke('chat:stop', botId),
  clear: (botId) => invoke('chat:clear', botId),
  exportChat: (key) => invoke('chat:export', key),
  listFiles: (cwd, q) => invoke('files:list', { cwd, q }),
  pickAttachments: (key) => invoke('attach:pick', key),
  addAttachments: (key, paths) => invoke('attach:add', { key, paths }),
  saveAttachments: (key, items) => invoke('attach:save', { key, items }),
  discardAttachments: (paths) => invoke('attach:discard', paths),
  openAttachment: (p) => invoke('attach:open', p),
  // 同步转成 file://，界面里直接当图片 src 用
  fileUrl: (p) => {
    try {
      return pathToFileURL(String(p)).href;
    } catch {
      return '';
    }
  },
  // 拖进来的 File 只有渲染层拿得到，转成绝对路径交给主进程复制
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  listRuns: (key) => invoke('runs:list', key),
  usageSummary: (days) => invoke('runs:summary', days),
  pickDir: () => invoke('dialog:pickDir'),
  openExternal: (url) => invoke('shell:open', url),
  openFolder: (dir) => invoke('shell:openFolder', dir),
  openTerminal: (botId, login) => invoke('shell:terminal', botId, login),
  saveSettings: (patch) => invoke('settings:save', patch),
  diagnose: () => invoke('net:diagnose'),
  updateState: () => invoke('update:state'),
  checkUpdate: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  ptyOpen: (botId, mode, cols, rows) => invoke('pty:open', { botId, mode, cols, rows }),
  ptyWrite: (id, data) => invoke('pty:write', id, data),
  ptyResize: (id, cols, rows) => invoke('pty:resize', id, cols, rows),
  ptyClose: (id) => invoke('pty:close', id),
  onEvent: (fn) => {
    const handler = (_e, data) => fn(data.channel, data.payload);
    ipcRenderer.on('evt', handler);
    return () => ipcRenderer.removeListener('evt', handler);
  },
});
