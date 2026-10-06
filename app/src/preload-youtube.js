// Runs in the YouTube window's isolated world (sandboxed). Nothing is exposed to
// the page itself; the filter talks to the main process over IPC.

import { contextBridge, ipcRenderer, webFrame } from 'electron';
import css from '../../core/filter.css';
import { createFilter } from '../../core/engine.js';
import { installAdPrune } from '../../core/adprune.js';

const storage = {
  load: () => ipcRenderer.invoke('aif:load'),
  save: (settings) => ipcRenderer.invoke('aif:save', settings),
  subscribe: (cb) => ipcRenderer.on('aif:changed', (_e, settings) => cb(settings)),
};

// Runs in the page's own world before YouTube's scripts: strips ad data from player
// responses (only while Shields is on).
try {
  if (ipcRenderer.sendSync('aif:ad-prune')) contextBridge.executeInMainWorld({ func: installAdPrune });
} catch (err) {
  console.error('MSM: ad pruning not installed', err);
}

webFrame.insertCSS(css);

// YouTube ignores script clicks on its Skip button, so the main process sends a real one.
const adHooks = {
  trustedClick: (x, y) => {
    const z = webFrame.getZoomFactor();
    ipcRenderer.send('aif:trusted-click', { x: Math.round(x * z), y: Math.round(y * z) });
  },
  onStuck: (videoId) => ipcRenderer.send('aif:ad-stuck', videoId),
};

const filter = createFilter({ storage, adHooks });
filter.init();

ipcRenderer.on('aif:block-page-channel', () => {
  const channel = filter.getPageChannel();
  if (channel) filter.actions.blockChannel(channel);
});
