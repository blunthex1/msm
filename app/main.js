// MSM for YouTube — desktop app main process.
// Wraps youtube.com in a dedicated window and runs the AI filter inside it.

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, session, shell } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { existsSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeSettings } from '../core/rules.js';
import { checkForUpdatesManually, setupUpdater } from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME_URL = 'https://www.youtube.com/';
const PARTITION = 'persist:youtube';
const PROJECT_URL = 'https://github.com/blunthex1/msm';
const isMac = process.platform === 'darwin';

// Google refuses to sign in "embedded browsers"; a Firefox UA on the sign-in pages
// is the long-standing workaround used by other Electron wrappers.
const SIGN_IN_UA = isMac
  ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:140.0) Gecko/20100101 Firefox/140.0'
  : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

// ---------------------------------------------------------------------------
// Persistent config (filter settings + window state)

const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = { filter: sanitizeSettings({}), window: {}, alwaysOnTop: false, shields: true, quality: 'auto' };

async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8'));
    config = {
      filter: sanitizeSettings(raw.filter),
      window: raw.window && typeof raw.window === 'object' ? raw.window : {},
      alwaysOnTop: raw.alwaysOnTop === true,
      wideReset: raw.wideReset === true,
      quality: QUALITIES.some((q) => q.id === raw.quality) ? raw.quality : 'auto',
      shields: raw.shields !== false,
    };
  } catch {
    // first run or unreadable file: keep defaults
  }
}

let saveChain = Promise.resolve();
function saveConfig() {
  // Serialise writes and write atomically so a crash can't leave a half-written file.
  saveChain = saveChain
    .then(async () => {
      const tmp = configPath() + '.tmp';
      await writeFile(tmp, JSON.stringify(config, null, 2));
      await rename(tmp, configPath());
    })
    .catch((err) => console.error('Failed to save config', err));
  return saveChain;
}

// ---------------------------------------------------------------------------
// URL policy

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

const isYouTubeHost = (h) => !!h && (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be');
const isGoogleHost = (h) =>
  !!h && (h === 'google.com' || h.endsWith('.google.com') || /^accounts\.google\.[a-z.]+$/.test(h));

/** URLs that stay inside the app; everything else opens in the default browser. */
function isInAppUrl(url) {
  const h = hostOf(url);
  return isYouTubeHost(h) || isGoogleHost(h);
}

/** youtube.com/redirect?q=… wraps outbound links in descriptions/comments. */
function unwrapRedirect(url) {
  try {
    const u = new URL(url);
    if (isYouTubeHost(u.hostname) && u.pathname === '/redirect' && u.searchParams.get('q')) {
      return u.searchParams.get('q');
    }
  } catch {}
  return url;
}

function openExternal(url) {
  const target = unwrapRedirect(url);
  if (/^https?:\/\//i.test(target)) shell.openExternal(target);
}

/** Accept youtube.com / youtu.be links passed on the command line. */
function urlFromArgv(argv) {
  const arg = argv.find((a) => /^https:\/\//i.test(a) && isYouTubeHost(hostOf(a)));
  return arg || null;
}

// ---------------------------------------------------------------------------
// Session setup

function cleanUserAgent(ua) {
  // Drop "Electron/x" and the app's own token so YouTube serves the normal desktop site.
  return ua.replace(/ (?!(?:AppleWebKit|Chrome|Safari|Mobile)\/)[\w.-]+\/[\w.-]+/g, '');
}

let defaultUA = '';

// Earlier versions turned on YouTube's theater mode via its "wide" cookie. Clear it once,
// before any page loads, so YouTube renders its normal layout from the first frame.
async function resetTheaterCookieOnce() {
  if (config.wideReset || config.filter.playerSize !== 'default') return;
  try {
    const ses = session.fromPartition(PARTITION);
    for (const c of await ses.cookies.get({ name: 'wide' })) {
      const host = c.domain.replace(/^\./, '');
      await ses.cookies.remove(`https://${host}${c.path || '/'}`, 'wide');
    }
  } catch (err) {
    console.error('Could not reset theater cookie', err);
  }
  config.wideReset = true;
  saveConfig();
}

function setupSession() {
  const ses = session.fromPartition(PARTITION);
  defaultUA = cleanUserAgent(ses.getUserAgent());
  ses.setUserAgent(defaultUA);

  ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, cb) => {
    const headers = { ...details.requestHeaders, 'User-Agent': SIGN_IN_UA };
    for (const k of Object.keys(headers)) if (/^sec-ch-ua/i.test(k)) delete headers[k];
    cb({ requestHeaders: headers });
  });

  setupShields(ses);

  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// ---------------------------------------------------------------------------
// Shields: ad & tracker blocking with Ghostery's engine, using uBlock Origin /
// EasyList / EasyPrivacy-style filter lists (the same lists Brave Shields uses).

let blocker = null;
let blockerSession = null;

// uBlock Origin's lists (filters, quick fixes, unbreak, privacy, badware + its scriptlet
// resources) and EasyList/EasyPrivacy. YouTube changes its ads often and uBO's "quick fixes"
// list follows within hours, so the lists are refreshed every 12 hours (and on demand).
const LISTS_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let listsUpdatedAt = 0;
let listsUpdating = false;

async function loadBlocker({ force = false } = {}) {
  const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
  const fetchFn = (url, init) => net.fetch(url, init);
  const cache = (allowStale) => ({
    path: cachePath,
    read: async (p) => {
      const { mtimeMs } = await stat(p);
      if (!allowStale && (force || Date.now() - mtimeMs > LISTS_MAX_AGE_MS)) throw new Error('stale');
      listsUpdatedAt = mtimeMs;
      return readFile(p);
    },
    write: async (p, data) => {
      await writeFile(p, data);
      listsUpdatedAt = Date.now();
    },
  });
  try {
    return await ElectronBlocker.fromPrebuiltAdsAndTracking(fetchFn, cache(false));
  } catch (err) {
    // Offline or a list server is down: fall back to the last lists we had.
    console.error('Shields: could not fetch fresh filter lists', err);
    return ElectronBlocker.fromPrebuiltAdsAndTracking(fetchFn, cache(true));
  }
}

async function updateFilterLists({ force = false } = {}) {
  if (listsUpdating) return;
  listsUpdating = true;
  buildMenu();
  try {
    const next = await loadBlocker({ force });
    if (blocker && blockerSession && config.shields) blocker.disableBlockingInSession(blockerSession);
    blocker = next;
    if (config.shields && blockerSession) blocker.enableBlockingInSession(blockerSession);
  } catch (err) {
    console.error('Shields: failed to load filter lists', err);
  } finally {
    listsUpdating = false;
    buildMenu();
  }
}

async function setupShields(ses) {
  blockerSession = ses;
  await updateFilterLists();
  setInterval(() => updateFilterLists(), LISTS_MAX_AGE_MS);
}

function listsStatusLabel() {
  if (listsUpdating) return 'Updating filter lists…';
  if (!blocker) return 'Filter lists not loaded';
  const mins = Math.round((Date.now() - listsUpdatedAt) / 60000);
  const ago = mins < 2 ? 'just now' : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return `uBlock Origin + EasyList lists, updated ${ago}`;
}

function setShields(on) {
  config.shields = on;
  saveConfig();
  if (blocker && blockerSession) {
    if (on) blocker.enableBlockingInSession(blockerSession);
    else blocker.disableBlockingInSession(blockerSession);
  }
  for (const w of ytWindows) w.webContents.reload();
  buildMenu();
}

// ---------------------------------------------------------------------------
// Video quality (YouTube's player API lives in the page, so this runs in the page's world)

const QUALITIES = [
  { id: 'auto', label: 'Auto' },
  { id: 'hd2160', label: '2160p (4K)' },
  { id: 'hd1440', label: '1440p' },
  { id: 'hd1080', label: '1080p' },
  { id: 'hd720', label: '720p' },
  { id: 'large', label: '480p' },
  { id: 'medium', label: '360p' },
];

function applyQuality(wc) {
  if (wc.isDestroyed() || !/^https:\/\/www\.youtube\.com\/watch/.test(wc.getURL())) return;
  const want = JSON.stringify(config.quality);
  // Pick the best available level at or below the chosen one; retry until the player is ready.
  const script = `(() => {
    const want = ${want};
    const order = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
    let tries = 0;
    const t = setInterval(() => {
      const p = document.getElementById('movie_player');
      const levels = p && p.getAvailableQualityLevels ? p.getAvailableQualityLevels() : [];
      if (levels.length && !p.classList.contains('ad-showing')) {
        clearInterval(t);
        if (want === 'auto') { p.setPlaybackQualityRange && p.setPlaybackQualityRange('auto', 'auto'); return; }
        const pick = levels.find((l) => order.indexOf(l) >= order.indexOf(want)) || levels[levels.length - 1];
        try { p.setPlaybackQualityRange(pick, pick); } catch {}
        try { p.setPlaybackQuality(pick); } catch {}
      }
      if (++tries > 60) clearInterval(t);
    }, 500);
  })();`;
  wc.executeJavaScript(script).catch(() => {});
}

function setQuality(id) {
  config.quality = id;
  saveConfig();
  for (const w of ytWindows) applyQuality(w.webContents);
  buildMenu();
}

// ---------------------------------------------------------------------------
// Windows

const ytWindows = new Set();
let settingsWin = null;

function preloadPath(name) {
  return path.join(here, 'dist', name);
}

function iconPath() {
  const p = path.join(here, 'build', 'icon.png');
  return existsSync(p) ? p : undefined;
}

function createYouTubeWindow(url = HOME_URL, { restoreState = false } = {}) {
  const state = restoreState ? config.window : {};
  const win = new BrowserWindow({
    width: state.bounds?.width || 1280,
    height: state.bounds?.height || 800,
    x: state.bounds?.x,
    y: state.bounds?.y,
    minWidth: 480,
    minHeight: 360,
    backgroundColor: '#0f0f0f',
    title: app.getName(),
    icon: iconPath(),
    show: false,
    alwaysOnTop: config.alwaysOnTop,
    webPreferences: {
      partition: PARTITION,
      preload: preloadPath('preload-youtube.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  ytWindows.add(win);
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  const wc = win.webContents;

  wc.setWindowOpenHandler(({ url: target }) => {
    if (unwrapRedirect(target) !== target || !isInAppUrl(target)) openExternal(target);
    else if (isYouTubeHost(hostOf(target))) createYouTubeWindow(target);
    else wc.loadURL(target); // Google sign-in popups
    return { action: 'deny' };
  });

  const guardNavigation = (event, target) => {
    if (!isInAppUrl(target) || unwrapRedirect(target) !== target) {
      event.preventDefault();
      openExternal(target);
    }
  };
  wc.on('will-navigate', (e) => guardNavigation(e, e.url));
  wc.on('will-redirect', (e) => guardNavigation(e, e.url));

  // Keep navigator.userAgent consistent with the sign-in UA header on Google's login pages.
  // Apply the chosen quality whenever a video opens (full loads and in-app navigation).
  wc.on('did-finish-load', () => applyQuality(wc));
  wc.on('did-navigate-in-page', () => applyQuality(wc));

  wc.on('did-start-navigation', (e) => {
    if (!e.isMainFrame) return;
    const onSignIn = hostOf(e.url) === 'accounts.google.com';
    const want = onSignIn ? SIGN_IN_UA : defaultUA;
    if (wc.getUserAgent() !== want) wc.setUserAgent(want);
  });

  // Mouse back/forward buttons (Windows).
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (cmd === 'browser-forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });

  win.on('close', () => {
    if (ytWindows.size === 1) {
      config.window = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
      saveConfig();
    }
  });
  win.on('closed', () => ytWindows.delete(win));
  win.on('focus', buildMenu);

  wc.loadURL(url);
  return win;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 780,
    height: 860,
    minWidth: 420,
    title: 'AI Filter Settings',
    icon: iconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#0f0f10',
    webPreferences: {
      preload: preloadPath('preload-settings.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWin.on('closed', () => (settingsWin = null));
  settingsWin.loadFile(path.join(here, 'dist', 'settings.html'));
}

function focusedYouTubeWindow() {
  const w = BrowserWindow.getFocusedWindow();
  if (w && ytWindows.has(w)) return w;
  return [...ytWindows].at(-1) || null;
}

// ---------------------------------------------------------------------------
// Filter settings IPC

function isTrustedSender(frame) {
  if (!frame) return false;
  const url = frame.url || '';
  if (url.startsWith('file://') && settingsWin && frame === settingsWin.webContents.mainFrame) return true;
  return isYouTubeHost(hostOf(url)) && [...ytWindows].some((w) => w.webContents.mainFrame === frame);
}

async function setFilterSettings(next) {
  config.filter = sanitizeSettings(next);
  await saveConfig();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('aif:changed', config.filter);
  buildMenu();
}

function setupIpc() {
  ipcMain.handle('aif:load', (e) => {
    if (!isTrustedSender(e.senderFrame)) throw new Error('untrusted sender');
    return config.filter;
  });
  ipcMain.handle('aif:save', async (e, next) => {
    if (!isTrustedSender(e.senderFrame)) throw new Error('untrusted sender');
    await setFilterSettings(next);
  });
}

// ---------------------------------------------------------------------------
// Menu

function withWc(fn) {
  return () => {
    const w = focusedYouTubeWindow();
    if (w) fn(w.webContents, w);
  };
}

function buildMenu() {
  const f = config.filter;
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createYouTubeWindow() },
        { label: 'AI Filter Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&Navigate',
      submenu: [
        {
          label: 'Back',
          accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: withWc((wc) => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()),
        },
        {
          label: 'Forward',
          accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: withWc((wc) => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()),
        },
        { label: 'Home', accelerator: 'Alt+Home', click: withWc((wc) => wc.loadURL(HOME_URL)) },
        { label: 'Subscriptions', click: withWc((wc) => wc.loadURL(HOME_URL + 'feed/subscriptions')) },
        { label: 'History', click: withWc((wc) => wc.loadURL(HOME_URL + 'feed/history')) },
        { label: 'Watch Later', click: withWc((wc) => wc.loadURL(HOME_URL + 'playlist?list=WL')) },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: withWc((wc) => wc.reload()) },
        { label: 'Reload', accelerator: 'F5', visible: false, click: withWc((wc) => wc.reload()) },
        { type: 'separator' },
        {
          label: 'Open YouTube Link from Clipboard',
          accelerator: 'CmdOrCtrl+Shift+V',
          click: withWc((wc) => {
            const text = clipboard.readText().trim();
            if (isYouTubeHost(hostOf(text))) wc.loadURL(text);
          }),
        },
        {
          label: 'Copy Page Link',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: withWc((wc) => clipboard.writeText(wc.getURL())),
        },
        { label: 'Open Page in Browser', click: withWc((wc) => shell.openExternal(wc.getURL())) },
      ],
    },
    {
      label: '&Shields',
      submenu: [
        {
          label: 'Block Ads && Trackers',
          type: 'checkbox',
          checked: config.shields,
          accelerator: 'CmdOrCtrl+Shift+S',
          click: (item) => setShields(item.checked),
        },
        {
          label: 'Skip Video Ads',
          type: 'checkbox',
          checked: config.filter.skipAds,
          click: () => setFilterSettings({ ...config.filter, skipAds: !config.filter.skipAds }),
        },
        {
          label: 'Skip Sponsor Segments',
          type: 'checkbox',
          checked: config.filter.skipSponsors,
          click: () => setFilterSettings({ ...config.filter, skipSponsors: !config.filter.skipSponsors }),
        },
        { type: 'separator' },
        { label: listsStatusLabel(), enabled: false },
        {
          label: 'Update Filter Lists Now',
          enabled: !listsUpdating,
          click: () => updateFilterLists({ force: true }),
        },
      ],
    },
    {
      label: 'AI &Filter',
      submenu: [
        {
          label: 'Filter Enabled',
          type: 'checkbox',
          checked: f.enabled,
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => setFilterSettings({ ...config.filter, enabled: !config.filter.enabled }),
        },
        { type: 'separator' },
        {
          label: 'Hide Matching Videos',
          type: 'radio',
          checked: f.mode === 'hide',
          click: () => setFilterSettings({ ...config.filter, mode: 'hide' }),
        },
        {
          label: 'Blur Matching Videos',
          type: 'radio',
          checked: f.mode === 'blur',
          click: () => setFilterSettings({ ...config.filter, mode: 'blur' }),
        },
        { type: 'separator' },
        {
          label: 'Block This Channel',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: withWc((wc) => wc.send('aif:block-page-channel')),
        },
        {
          label: 'Block Shorts',
          type: 'checkbox',
          checked: f.hideShorts,
          click: () => setFilterSettings({ ...config.filter, hideShorts: !config.filter.hideShorts }),
        },
        {
          label: 'Hide AI News && Hype Too',
          type: 'checkbox',
          checked: f.packs.aiTopics,
          click: () =>
            setFilterSettings({
              ...config.filter,
              packs: { ...config.filter.packs, aiTopics: !config.filter.packs.aiTopics },
            }),
        },
        { type: 'separator' },
        {
          label: `Blocked Channels (${f.blockedChannels.length})…`,
          click: openSettings,
        },
        { label: 'Settings…', click: openSettings },
      ],
    },
    {
      label: 'V&ideo',
      submenu: [
        { label: 'Player Size', enabled: false },
        ...[
          ['default', 'Normal'],
          ['theater', 'Theater (wide)'],
          ['fit', 'Fit to Window'],
        ].map(([id, label]) => ({
          label: `   ${label}`,
          type: 'radio',
          checked: f.playerSize === id,
          click: () => setFilterSettings({ ...config.filter, playerSize: id }),
        })),
        { type: 'separator' },
        { label: 'Quality', enabled: false },
        ...QUALITIES.map((q) => ({
          label: `   ${q.label}`,
          type: 'radio',
          checked: config.quality === q.id,
          click: () => setQuality(q.id),
        })),
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=', visible: false },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11' },
        {
          label: 'Always on Top',
          type: 'checkbox',
          checked: config.alwaysOnTop,
          accelerator: 'CmdOrCtrl+Shift+T',
          click: (item) => {
            config.alwaysOnTop = item.checked;
            for (const w of ytWindows) w.setAlwaysOnTop(item.checked);
            saveConfig();
          },
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: checkForUpdatesManually },
        { label: 'Project Page', click: () => shell.openExternal(PROJECT_URL) },
        {
          label: 'About',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'About',
              message: `${app.getName()} ${app.getVersion()}`,
              detail:
                'A dedicated YouTube window with a built-in filter for AI-generated videos.\n' +
                'Not affiliated with or endorsed by YouTube or Google.\n\n' +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.platform === 'win32') app.setAppUserModelId('io.github.blunthex1.msm');

  app.on('second-instance', (_e, argv) => {
    const url = urlFromArgv(argv);
    if (url) {
      createYouTubeWindow(url);
      return;
    }
    const w = focusedYouTubeWindow();
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    } else {
      createYouTubeWindow();
    }
  });

  app.whenReady().then(async () => {
    await loadConfig();
    setupSession();
    await resetTheaterCookieOnce();
    setupIpc();
    buildMenu();
    createYouTubeWindow(urlFromArgv(process.argv) || HOME_URL, { restoreState: true });
    setupUpdater();

    app.on('activate', () => {
      if (ytWindows.size === 0) createYouTubeWindow(HOME_URL, { restoreState: true });
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
