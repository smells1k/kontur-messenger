'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kontur', {
  isDesktop: true,
  platform: process.platform,
  getConfig: () => ipcRenderer.invoke('app:config'),
  setServerUrl: (url) => ipcRenderer.invoke('app:setServerUrl', url),
  health: () => ipcRenderer.invoke('app:health'),
  restartServer: () => ipcRenderer.invoke('app:restartServer'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (cfg) => ipcRenderer.invoke('settings:save', cfg),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
});
