import { channelInList } from '../../core/rules.js';
import { chromeStorage } from '../../core/storage.js';

const storage = chromeStorage();
const $ = (id) => document.getElementById(id);
let settings;
let tabId = null;
let stats = null;

async function askTab(message) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null; // not a YouTube tab, or the page hasn't loaded the filter yet
  }
}

function render() {
  $('enabled').checked = settings.enabled;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === settings.mode;

  const status = $('status');
  status.replaceChildren();
  if (!stats) {
    status.textContent = 'Open YouTube to start filtering.';
  } else if (!settings.enabled) {
    status.textContent = 'Filtering is paused.';
  } else {
    const b = document.createElement('b');
    b.textContent = String(stats.hiddenOnPage);
    status.append(
      b,
      stats.hiddenOnPage === 1 ? ' video filtered on this page.' : ' videos filtered on this page.',
    );
  }

  const ch = stats?.channel;
  $('channelBox').hidden = !ch;
  if (ch) {
    const name = ch.name || ch.handle || ch.id;
    const blocked = channelInList(ch, settings.blockedChannels);
    const allowed = channelInList(ch, settings.allowedChannels);
    $('channelName').textContent = blocked ? `${name} is blocked` : allowed ? `${name} is allowed` : name;
    $('blockBtn').hidden = !!blocked;
    $('allowBtn').hidden = !!allowed;
  }
}

async function refreshStats() {
  stats = await askTab({ type: 'aif:stats' });
  render();
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  settings = await storage.load();
  await refreshStats();

  storage.subscribe((s) => {
    settings = s;
    setTimeout(refreshStats, 250); // let the page re-filter first
  });

  $('enabled').addEventListener('change', (e) => storage.save({ ...settings, enabled: e.target.checked }));
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', () => r.checked && storage.save({ ...settings, mode: r.value }));
  }
  $('blockBtn').addEventListener('click', () => askTab({ type: 'aif:blockPageChannel' }));
  $('allowBtn').addEventListener('click', () => askTab({ type: 'aif:allowPageChannel' }));
  $('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

main();
