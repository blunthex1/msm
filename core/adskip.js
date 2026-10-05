// Skips YouTube's in-video ads. Network ad blocking can't stop these, because YouTube serves
// ads from the same servers as the videos themselves. While the player is showing an ad:
//   1. mute it, hide it and jump to its end (or play it at 16x if the length isn't known yet);
//   2. press the Skip button. YouTube ignores script-generated clicks (event.isTrusted is
//      false), so when the host can send a real input event (the desktop app) we use that;
//   3. if the ad is still stuck on screen after STUCK_MS, ask the host to reload the video
//      (once per video), which drops the ad slot.

const SKIP_BUTTONS = [
  '.ytp-skip-ad-button',
  '.ytp-ad-skip-button',
  '.ytp-ad-skip-button-modern',
  '.ytp-ad-skip-button-slot button',
  'button[id^="skip-button"]',
  'button[class*="skip-button"]',
  'button[class*="skip-ad"]',
].join(',');

const AD_CLASSES = ['ad-showing', 'ad-interrupting'];
export const AD_HIDE_ATTR = 'data-msm-ad';
const STUCK_MS = 4000;
const CLICK_EVERY_MS = 400;

export function createAdSkipper({ doc, win, intervalMs = 250, trustedClick = null, onStuck = null }) {
  let timer = null;
  let mutedByUs = false;
  let rateByUs = null;
  let adSince = 0;
  let lastClick = 0;
  let stuckFiredFor = null;

  function videoId() {
    return new URLSearchParams(win.location.search).get('v');
  }

  function clickSkip(btn) {
    const now = Date.now();
    if (now - lastClick < CLICK_EVERY_MS) return;
    lastClick = now;
    const r = btn.getBoundingClientRect();
    if (trustedClick && r.width > 0 && r.height > 0) {
      trustedClick(r.left + r.width / 2, r.top + r.height / 2);
    }
    // Script click as well: costs nothing and works wherever YouTube still accepts it.
    btn.click();
  }

  function endAd(player, video) {
    if (adSince) {
      adSince = 0;
      player?.removeAttribute(AD_HIDE_ATTR);
      if (video) {
        if (mutedByUs) video.muted = false;
        if (rateByUs !== null && video.playbackRate === 16) video.playbackRate = rateByUs;
      }
    }
    mutedByUs = false;
    rateByUs = null;
  }

  function tick() {
    const player = doc.querySelector('#movie_player');
    const video = player?.querySelector('video');
    if (!player || !video) return;
    const adShowing = AD_CLASSES.some((c) => player.classList.contains(c));
    if (!adShowing) {
      endAd(player, video);
      return;
    }
    const now = Date.now();
    if (!adSince) adSince = now;
    if (!player.hasAttribute(AD_HIDE_ATTR)) player.setAttribute(AD_HIDE_ATTR, '');

    if (!video.muted) {
      video.muted = true;
      mutedByUs = true;
    }
    if (Number.isFinite(video.duration) && video.duration > 0) {
      if (video.currentTime < video.duration - 0.25) video.currentTime = video.duration;
    } else if (video.playbackRate !== 16) {
      if (rateByUs === null) rateByUs = video.playbackRate;
      video.playbackRate = 16;
    }
    if (video.paused && !video.ended) {
      try {
        Promise.resolve(video.play()).catch(() => {});
      } catch {}
    }

    const skip = player.querySelector(SKIP_BUTTONS);
    if (skip) clickSkip(skip);

    if (onStuck && now - adSince > STUCK_MS) {
      const vid = videoId();
      if (vid && stuckFiredFor !== vid) {
        stuckFiredFor = vid;
        adSince = now;
        onStuck(vid);
      }
    }
  }

  return {
    /** Call on every page scan; runs only while `active` (on a video page, setting on). */
    update(active) {
      if (active && !timer) timer = win.setInterval(tick, intervalMs);
      if (!active && timer) {
        win.clearInterval(timer);
        timer = null;
        endAd(doc.querySelector('#movie_player'), doc.querySelector('#movie_player video'));
      }
    },
    tick,
  };
}
