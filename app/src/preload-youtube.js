// Runs in the YouTube window's isolated world (sandboxed). Nothing is exposed to
// the page itself; the filter talks to the main process over IPC.

import { ipcRenderer, webFrame } from 'electron';
import css from '../../core/filter.css';
import { createFilter } from '../../core/engine.js';

const storage = {
  load: () => ipcRenderer.invoke('aif:load'),
  save: (settings) => ipcRenderer.invoke('aif:save', settings),
  subscribe: (cb) => ipcRenderer.on('aif:changed', (_e, settings) => cb(settings)),
};

webFrame.insertCSS(css);

const filter = createFilter({ storage });
filter.init();

ipcRenderer.on('aif:block-page-channel', () => {
  const channel = filter.getPageChannel();
  if (channel) filter.actions.blockChannel(channel);
});
