'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('lb', {
  init: () => invoke('app:init'),
  detect: () => invoke('agents:detect'),
  install: (id) => invoke('agents:install', id),
  createBot: (cfg) => invoke('bots:create', cfg),
  createGroup: (cfg) => invoke('groups:create', cfg),
  updateGroup: (id, patch) => invoke('groups:update', id, patch),
  deleteGroup: (id) => invoke('groups:delete', id),
  updateBot: (id, patch) => invoke('bots:update', id, patch),
  deleteBot: (id) => invoke('bots:delete', id),
  getMessages: (botId) => invoke('chat:get', botId),
  send: (key, text) => invoke('chat:send', { key, text }),
  stop: (botId) => invoke('chat:stop', botId),
  clear: (botId) => invoke('chat:clear', botId),
  pickDir: () => invoke('dialog:pickDir'),
  openExternal: (url) => invoke('shell:open', url),
  openFolder: (dir) => invoke('shell:openFolder', dir),
  openTerminal: (botId, login) => invoke('shell:terminal', botId, login),
  saveSettings: (patch) => invoke('settings:save', patch),
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
