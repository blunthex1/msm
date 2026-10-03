// Storage adapters. The engine and the options page only talk to this interface:
//   load() -> Promise<settings>, save(settings) -> Promise<void>, subscribe(cb)

import { SETTINGS_KEY } from './defaults.js';
import { sanitizeSettings } from './rules.js';

/** Browser extension storage (chrome.storage.local; works in Chrome, Edge and Firefox). */
export function chromeStorage(api = globalThis.chrome) {
  return {
    async load() {
      const data = await api.storage.local.get(SETTINGS_KEY);
      return sanitizeSettings(data?.[SETTINGS_KEY]);
    },
    async save(settings) {
      await api.storage.local.set({ [SETTINGS_KEY]: sanitizeSettings(settings) });
    },
    subscribe(cb) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[SETTINGS_KEY]) cb(sanitizeSettings(changes[SETTINGS_KEY].newValue));
      });
    },
  };
}

/** In-memory storage, used by tests. */
export function memoryStorage(initial = {}) {
  let value = sanitizeSettings(initial);
  const listeners = new Set();
  return {
    async load() {
      return structuredClone(value);
    },
    async save(settings) {
      value = sanitizeSettings(settings);
      for (const cb of listeners) cb(structuredClone(value));
    },
    subscribe(cb) {
      listeners.add(cb);
    },
  };
}
