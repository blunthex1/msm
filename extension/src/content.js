import { createFilter } from '../../core/engine.js';
import { chromeStorage } from '../../core/storage.js';

const filter = createFilter({ storage: chromeStorage() });

function boot() {
  filter.init();
}
if (document.documentElement) boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });

// The popup asks the active tab for its stats and can block/allow the current channel.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'aif:stats') {
    sendResponse({ ...filter.getStats(), channel: filter.getPageChannel() });
    return;
  }
  if (msg?.type === 'aif:blockPageChannel' || msg?.type === 'aif:allowPageChannel') {
    const channel = filter.getPageChannel();
    if (!channel) return sendResponse({ ok: false });
    const action = msg.type === 'aif:blockPageChannel' ? 'blockChannel' : 'allowChannel';
    filter.actions[action](channel).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});
