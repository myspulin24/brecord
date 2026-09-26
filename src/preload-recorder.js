'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderHost', {
  platform: process.platform,
  onCommand: (cb) => ipcRenderer.on('recorder:command', (_e, msg) => cb(msg)),
  reply: (id, payload) => ipcRenderer.send('recorder:reply', { id, ...payload }),
  chunk: (data) => ipcRenderer.send('recorder:chunk', data),
  event: (data) => ipcRenderer.send('recorder:event', data),
});
