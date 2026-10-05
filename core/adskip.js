// Skips YouTube's in-video ads: while the player is showing an ad, mute it, jump to its end
// and press the Skip button as soon as it appears. Network ad blocking can't stop these,
// because YouTube serves ads from the same servers as the videos themselves.

const SKIP_BUTTONS = [
  '.ytp-skip-ad-button',
  '.ytp-ad-skip-button',
  '.ytp-ad-skip-button-modern',
  'button[class*="skip-button"]',
].join(',');

export function createAdSkipper({ doc, win, intervalMs = 300 }) {
  let timer = null;
  let mutedByUs = false;

  function tick() {
    const player = doc.querySelector('#movie_player');
    const video = player?.querySelector('video');
    if (!player || !video) return;
    const adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    if (!adShowing) {
      if (mutedByUs) {
        video.muted = false;
        mutedByUs = false;
      }
      return;
    }
    if (!video.muted) {
      video.muted = true;
      mutedByUs = true;
    }
    if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.25) {
      video.currentTime = video.duration;
    }
    const skip = player.querySelector(SKIP_BUTTONS);
    if (skip) skip.click();
  }

  return {
    /** Call on every page scan; runs only while `active` (on a video page, setting on). */
    update(active) {
      if (active && !timer) timer = win.setInterval(tick, intervalMs);
      if (!active && timer) {
        win.clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
