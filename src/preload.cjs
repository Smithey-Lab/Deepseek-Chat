const { contextBridge, ipcRenderer } = require('electron');
const invoke = (channel) => (input) => ipcRenderer.invoke(channel, input);
contextBridge.exposeInMainWorld('workspace', {
  settings: invoke('settings:get'),
  saveSettings: invoke('settings:save'),
  loadChats: invoke('chat:load'),
  saveChats: invoke('chat:save'),
  models: invoke('chat:models'),
  send: invoke('chat:send'),
  cancel: invoke('chat:cancel'),
  list: invoke('github:list'),
  read: invoke('github:read'),
  commit: invoke('github:commit'),
  checkUpdate: invoke('update:check'),
  downloadUpdate: invoke('update:download'),
  installUpdate: invoke('update:install'),
  onUpdate: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
