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
  agentStart: invoke('agent:start'),
  agentCancel: invoke('agent:cancel'),
  agentList: invoke('agent:list'),
  agentGet: invoke('agent:get'),
  agentReview: invoke('agent:review'),
  onAgent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('agent:status', listener);
    return () => ipcRenderer.removeListener('agent:status', listener);
  },
  list: invoke('github:list'),
  read: invoke('github:read'),
  commit: invoke('github:commit'),
  repos: invoke('github:repos'),
  branches: invoke('github:branches'),
  createDev: invoke('github:createDev'),
  commits: invoke('github:commits'),
  compare: invoke('github:compare'),
  pulls: invoke('github:pulls'),
  openGithub: invoke('github:open'),
  testConnection: invoke('connection:test'),
  loadWorkspace: invoke('workspace:load'),
  saveWorkspace: invoke('workspace:save'),
  exportChat: invoke('chat:export'),
  importChat: invoke('chat:import'),
  diagnostics: invoke('app:diagnostics'),
  openDataFolder: invoke('app:openDataFolder'),
  checkUpdate: invoke('update:check'),
  downloadUpdate: invoke('update:download'),
  installUpdate: invoke('update:install'),
  onUpdate: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
