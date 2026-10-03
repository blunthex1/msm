// Auto-update from GitHub Releases (electron-updater).
//
// The installed (NSIS) app checks the repo's latest release shortly after launch and
// every few hours, downloads a newer version in the background, then offers to restart.
// If the user picks "Later", the update installs the next time the app quits.
// Dev runs (`npm start`) and the portable .exe never update themselves.

import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_MS = 15 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let manualCheck = false; // show "you're up to date" / errors only when the user asked
let downloaded = null; // version waiting to install
let prompting = false;

export function updatesSupported() {
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && process.platform !== 'linux';
}

function show(opts) {
  return dialog.showMessageBox({ title: 'MSM for YouTube', ...opts });
}

async function offerRestart(version) {
  if (prompting) return;
  prompting = true;
  try {
    const { response } = await show({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Version ${version} is ready to install.`,
      detail: 'Restart now to update, or it will install automatically the next time you close the app.',
    });
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall());
  } finally {
    prompting = false;
  }
}

export function setupUpdater() {
  if (!updatesSupported()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-not-available', () => {
    if (manualCheck) show({ type: 'info', message: `You're up to date (version ${app.getVersion()}).` });
    manualCheck = false;
  });
  autoUpdater.on('update-available', (info) => {
    if (manualCheck)
      show({
        type: 'info',
        message: `Downloading version ${info.version}…`,
        detail: "You'll be asked to restart when it's ready.",
      });
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info.version;
    offerRestart(info.version);
  });
  autoUpdater.on('error', (err) => {
    if (manualCheck)
      show({ type: 'warning', message: "Couldn't check for updates.", detail: String(err?.message || err) });
    manualCheck = false;
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

/** Menu action: Help → Check for Updates… */
export function checkForUpdatesManually() {
  if (!updatesSupported()) {
    show({
      type: 'info',
      message: 'Automatic updates are only available in the installed version.',
      detail: 'Download the latest installer from the GitHub Releases page.',
    });
    return;
  }
  if (downloaded) return offerRestart(downloaded);
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}
