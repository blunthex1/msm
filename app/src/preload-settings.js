// Preload for the local settings window: exposes the same storage interface the
// extension's options page uses.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aifStore', {
  load: () => ipcRenderer.invoke('aif:load'),
  save: (settings) => ipcRenderer.invoke('aif:save', settings),
  subscribe: (cb) => {
    ipcRenderer.on('aif:changed', (_e, settings) => cb(settings));
  },
});
