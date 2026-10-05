// The filter engine: watches the YouTube page, evaluates every video card and
// hides/blurs the ones that match. Runs as an extension content script or in the
// desktop app's preload — both provide a `storage` adapter:
//   storage.load()            -> Promise<settings>
//   storage.save(settings)    -> Promise<void>
//   storage.subscribe(cb)     -> cb(settings) whenever settings change anywhere

import { createSponsorSkipper } from './sponsorblock.js';
import {
  addChannel,
  channelInList,
  compileRules,
  evaluate,
  removeChannel,
  sanitizeSettings,
} from './rules.js';
import {
  CARD_SELECTOR,
  extractCard,
  findShorts,
  shortsToWatchUrl,
  findPlayables,
  getPageContext,
  hideTarget,
  isNestedCard,
} from './youtube.js';

const ATTR = 'data-aif';
const GAMES_ATTR = 'data-aif-games';
const SHORTS_ATTR = 'data-aif-shorts';
const CINEMA_ATTR = 'data-aif-cinema';
const TOAST_ID = 'aif-toast';
const OVERLAY_CLASS = 'aif-overlay';
const BAR_ID = 'aif-page-bar';

function h(doc, tag, props = {}, ...children) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return el;
}

/** Stop clicks on our controls from also activating the YouTube link underneath. */
function guard(fn) {
  return (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn(e);
  };
}

export function createFilter({ storage, doc = document, win = window, debounceMs = 120 }) {
  let settings = null;
  let compiled = null;
  let version = 0;
  const cardState = new WeakMap(); // card -> { sig, target }
  const revealed = new Set(); // video ids the user chose to show this session
  let blockedOnPage = new Set();
  let barKey = '';
  let autoBlocked = new Set();
  let timer = null;
  let observer = null;
  let stopped = false;

  // ---- settings ----------------------------------------------------------

  function applySettings(next) {
    settings = sanitizeSettings(next);
    compiled = compileRules(settings);
    version++;
    barKey = '';
    scheduleScan(0);
  }

  async function update(mutator) {
    const current = sanitizeSettings(await storage.load());
    const next = sanitizeSettings(mutator(current));
    await storage.save(next);
    applySettings(next); // apply locally right away; subscribe() will confirm
  }

  const actions = {
    blockChannel: (channel) =>
      update((s) => ({
        ...s,
        blockedChannels: addChannel(s.blockedChannels, channel),
        allowedChannels: removeChannel(s.allowedChannels, channel),
      })),
    allowChannel: (channel) =>
      update((s) => ({
        ...s,
        allowedChannels: addChannel(s.allowedChannels, channel),
        blockedChannels: removeChannel(s.blockedChannels, channel),
      })),
    unblockChannel: (channel) =>
      update((s) => ({ ...s, blockedChannels: removeChannel(s.blockedChannels, channel) })),
    unallowChannel: (channel) =>
      update((s) => ({ ...s, allowedChannels: removeChannel(s.allowedChannels, channel) })),
  };

  // ---- cards -------------------------------------------------------------

  function clearCard(card, target) {
    target.removeAttribute(ATTR);
    if (target !== card) card.removeAttribute(ATTR);
    for (const o of target.querySelectorAll(':scope > .' + OVERLAY_CLASS)) o.remove();
  }

  function buildOverlay(meta, verdict) {
    const reveal = guard(() => {
      if (meta.videoId) revealed.add(meta.videoId);
      version++; // force re-evaluation
      scheduleScan(0);
    });
    const allow = guard(() => actions.allowChannel(meta.channel));
    return h(
      doc,
      'div',
      { class: OVERLAY_CLASS, role: 'note' },
      h(doc, 'div', { class: 'aif-overlay-title' }, 'Hidden by AI Filter'),
      h(doc, 'div', { class: 'aif-overlay-reason' }, verdict.reason || ''),
      h(
        doc,
        'div',
        { class: 'aif-overlay-actions' },
        meta.videoId ? h(doc, 'button', { type: 'button', onclick: reveal }, 'Show') : null,
        meta.channel ? h(doc, 'button', { type: 'button', onclick: allow }, 'Allow channel') : null,
      ),
    );
  }

  function processCard(card, pageChannel) {
    const meta = extractCard(card, pageChannel);
    const ch = meta.channel;
    const sig = [version, meta.title, meta.description, meta.videoId, ch?.handle, ch?.id, ch?.name].join(
      '\u0001',
    );

    const prev = cardState.get(card);
    const target = hideTarget(card);
    if (prev && prev.sig === sig && prev.target === target) {
      if (prev.blocked) blockedOnPage.add(prev.key);
      return;
    }
    if (prev) clearCard(card, prev.target);
    clearCard(card, target);

    let verdict = { blocked: false };
    if (meta.title || ch) verdict = evaluate(meta, compiled);
    if (verdict.blocked && meta.videoId && revealed.has(meta.videoId)) verdict = { blocked: false };

    const key = meta.videoId || meta.title;
    if (verdict.blocked) {
      blockedOnPage.add(key);
      target.setAttribute(ATTR, settings.mode);
      if (settings.mode === 'blur') target.append(buildOverlay(meta, verdict));
    }
    cardState.set(card, { sig, target, blocked: verdict.blocked, key });
  }

  // ---- page bar (watch & channel pages) ------------------------------------

  function removeBar() {
    doc.getElementById(BAR_ID)?.remove();
    barKey = '';
  }

  function renderBar(ctx) {
    if (!settings.enabled || !settings.showPageBar || !ctx.channel || !ctx.anchor) {
      removeBar();
      return;
    }
    const channel = ctx.channel;
    const name = channel.name || channel.handle || 'this channel';
    const blocked = channelInList(channel, settings.blockedChannels);
    const allowed = channelInList(channel, settings.allowedChannels);
    const verdict =
      ctx.type === 'watch' && !blocked && !allowed
        ? evaluate({ title: ctx.title, channel, description: ctx.description }, compiled)
        : { blocked: false };

    let tone = 'neutral';
    let message = name;
    const buttons = [];
    const btn = (label, fn, primary = false) =>
      h(doc, 'button', { type: 'button', class: primary ? 'aif-primary' : '', onclick: guard(fn) }, label);

    if (blocked) {
      tone = 'blocked';
      message = `${name} is on your AI block list — its videos are hidden everywhere.`;
      buttons.push(btn('Unblock channel', () => actions.unblockChannel(channel)));
    } else if (allowed) {
      tone = 'allowed';
      message = `${name} is always allowed.`;
      buttons.push(btn('Remove from allow list', () => actions.unallowChannel(channel)));
    } else if (ctx.disclosed && settings.detectDisclosure) {
      tone = 'warn';
      message = 'The creator labeled this video as altered or synthetic content.';
      buttons.push(btn(`Block ${name}`, () => actions.blockChannel(channel), true));
      buttons.push(btn('Always allow', () => actions.allowChannel(channel)));
    } else if (verdict.blocked) {
      tone = 'warn';
      message = `Looks AI-generated (${verdict.reason}).`;
      buttons.push(btn(`Block ${name}`, () => actions.blockChannel(channel), true));
      buttons.push(btn('Always allow', () => actions.allowChannel(channel)));
    } else {
      // Nothing to report: stay out of the way (block via the menu / popup instead).
      removeBar();
      return;
    }

    const key = [version, ctx.type, tone, message, name].join('|');
    const existing = doc.getElementById(BAR_ID);
    const placed = existing && existing.previousElementSibling === ctx.anchor;
    const placedBefore = existing && existing.nextElementSibling === ctx.anchor;
    if (key === barKey && (placed || placedBefore)) return;

    const bar = h(
      doc,
      'div',
      { id: BAR_ID, class: `aif-tone-${tone}` },
      h(doc, 'span', { class: 'aif-bar-badge' }, 'AI Filter'),
      h(doc, 'span', { class: 'aif-bar-message' }, message),
      h(doc, 'span', { class: 'aif-bar-actions' }, ...buttons),
    );
    existing?.remove();
    if (ctx.type === 'watch') ctx.anchor.after(bar);
    else ctx.anchor.before(bar);
    barKey = key;
  }

  function handlePage() {
    const ctx = getPageContext(doc, win.location);
    if (
      ctx.type === 'watch' &&
      ctx.disclosed &&
      settings.enabled &&
      settings.detectDisclosure &&
      settings.autoBlockDisclosed &&
      ctx.channel &&
      !channelInList(ctx.channel, settings.allowedChannels) &&
      !channelInList(ctx.channel, settings.blockedChannels) &&
      !autoBlocked.has(ctx.videoId)
    ) {
      autoBlocked.add(ctx.videoId);
      actions.blockChannel(ctx.channel);
    }
    renderBar(ctx);
    return ctx;
  }

  // ---- scanning ------------------------------------------------------------

  function scan() {
    timer = null;
    if (!settings || !doc.documentElement) return;
    blockedOnPage = new Set();
    const ctx = handlePage();
    const pageChannel = ctx.type === 'channel' ? ctx.channel : null;
    for (const card of doc.querySelectorAll(CARD_SELECTOR)) {
      if (isNestedCard(card)) continue;
      processCard(card, pageChannel);
    }
    hidePlayables();
    hideShorts();
    cinemaLayout();
    playerWatchdog();
    skipper.update(
      win.location.pathname === '/watch' ? new URLSearchParams(win.location.search).get('v') : null,
      settings.enabled && settings.skipSponsors,
    );
  }

  // ---- stuck-player watchdog -------------------------------------------------
  // Sometimes, after clicking into a video, YouTube's player stays black and never loads
  // until the page is refreshed. If the player hasn't loaded anything after a few seconds,
  // reload once for that video (never twice, so it can't loop).
  // Only triggers when the player never got any media after 12s.

  const WATCHDOG_MS = 12000;
  let watchdog = { vid: null, timer: null };
  function playerWatchdog() {
    const vid = win.location.pathname === '/watch' ? new URLSearchParams(win.location.search).get('v') : null;
    if (vid === watchdog.vid) return;
    win.clearTimeout(watchdog.timer);
    watchdog = { vid, timer: null };
    if (!vid) return;
    watchdog.timer = win.setTimeout(() => {
      if (stopped || watchdog.vid !== vid || doc.hidden) return;
      // Only act on the real symptom: a player with no media attached at all. A slow but
      // loading video (src set, still buffering) is left alone.
      const player = doc.querySelector('#movie_player');
      const video = player?.querySelector('video');
      const hasMedia = video && (video.currentSrc || video.src);
      const errorShown = player?.querySelector('.ytp-error');
      if (!player || hasMedia || errorShown) return;
      try {
        if (win.sessionStorage.getItem('aif-reloaded') === vid) return;
        win.sessionStorage.setItem('aif-reloaded', vid);
      } catch {
        return;
      }
      win.location.reload();
    }, WATCHDOG_MS);
  }

  // ---- sponsor skipping ------------------------------------------------------

  let toastTimer = null;
  function showToast(text, undo) {
    doc.getElementById(TOAST_ID)?.remove();
    const host = doc.querySelector('#movie_player') || doc.body;
    const toast = h(
      doc,
      'div',
      { id: TOAST_ID },
      h(doc, 'span', {}, text),
      h(doc, 'button', { type: 'button', onclick: guard(() => (undo(), toast.remove())) }, 'Undo'),
    );
    host.append(toast);
    win.clearTimeout(toastTimer);
    toastTimer = win.setTimeout(() => toast.remove(), 4000);
  }
  const SKIP_LABEL = { sponsor: 'sponsor', selfpromo: 'self-promotion' };
  const skipper = createSponsorSkipper({
    doc,
    win,
    onSkip: (seg, undo) => showToast(`Skipped ${SKIP_LABEL[seg.category] || seg.category}`, undo),
  });

  // Video pages: hide YouTube's top bar and make the player fill the window.
  // Theater-mode attempts per video; the player ignores clicks until it has finished loading.
  let theater = { vid: null, tries: 0, last: 0 };
  function cinemaLayout() {
    const root = doc.documentElement;
    const on = settings.cinemaLayout && win.location.pathname === '/watch';
    if (on !== root.hasAttribute(CINEMA_ATTR)) {
      if (on) root.setAttribute(CINEMA_ATTR, '');
      else root.removeAttribute(CINEMA_ATTR);
      win.dispatchEvent(new win.Event('resize')); // let the player re-measure
    }
    if (!on) {
      // Undo the theater-mode cookie earlier versions set, once, so YouTube looks normal again.
      try {
        if (!win.localStorage.getItem('aif-wide-reset')) {
          if (/(?:^|;\s*)wide=1(?:;|$)/.test(doc.cookie)) {
            doc.cookie = 'wide=0; domain=.youtube.com; path=/; max-age=31536000; secure; samesite=lax';
          }
          // This page may already be in theater mode; switch it back once the player exists.
          const theaterBtn = doc.querySelector('ytd-watch-flexy[theater] .ytp-size-button');
          if (theaterBtn) theaterBtn.click();
          // Done once we're on a watch page that isn't in theater mode (or we just switched it off).
          if (theaterBtn || doc.querySelector('ytd-watch-flexy:not([hidden]):not([theater]) #movie_player')) {
            win.localStorage.setItem('aif-wide-reset', '1');
          }
        }
      } catch {}
      return;
    }
    // YouTube opens every video in theater mode while its "wide" cookie is set.
    if (!/(?:^|;\s*)wide=1(?:;|$)/.test(doc.cookie)) {
      doc.cookie = 'wide=1; domain=.youtube.com; path=/; max-age=31536000; secure; samesite=lax';
    }
    // Switch to theater (wide) mode so the player spans the full width.
    const flexy = doc.querySelector('ytd-watch-flexy:not([hidden])');
    if (!flexy || flexy.hasAttribute('theater')) return;
    const vid = new URLSearchParams(win.location.search).get('v');
    if (theater.vid !== vid) theater = { vid, tries: 0, last: 0 };
    const now = Date.now();
    const btn = doc.querySelector('.ytp-size-button');
    if (theater.tries >= 30) return; // give up quietly after ~30s
    if (!btn || now - theater.last < 1000) {
      if (!theater.waiting) {
        theater.waiting = true;
        win.setTimeout(() => {
          theater.waiting = false;
          theater.tries++;
          if (!stopped) scheduleScan(0);
        }, 1000);
      }
      return;
    }
    theater.tries++;
    theater.last = now;
    btn.click();
    win.setTimeout(() => {
      win.dispatchEvent(new win.Event('resize'));
      if (!stopped) scheduleScan(0);
    }, 400);
  }

  function markAll(attr, want) {
    for (const el of doc.querySelectorAll(`[${attr}]`)) if (!want.has(el)) el.removeAttribute(attr);
    for (const el of want) if (!el.hasAttribute(attr)) el.setAttribute(attr, '');
  }

  function hidePlayables() {
    markAll(GAMES_ATTR, settings.enabled && settings.hidePlayables ? findPlayables(doc) : new Set());
  }

  function hideShorts() {
    const on = settings.enabled && settings.hideShorts;
    if (on) {
      // Opening a Short plays it in the normal player instead of the Shorts feed.
      const watch = shortsToWatchUrl(win.location);
      if (watch) win.location.replace(watch);
    }
    markAll(SHORTS_ATTR, on ? findShorts(doc) : new Set());
  }

  function scheduleScan(delay = debounceMs) {
    if (timer) {
      if (delay > 0) return;
      win.clearTimeout(timer);
    }
    timer = win.setTimeout(scan, delay);
  }

  function start() {
    observer = new win.MutationObserver(() => scheduleScan());
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'hidden', 'title'],
      characterData: true,
    });
    doc.addEventListener('yt-navigate-finish', () => scheduleScan(0));
    scheduleScan(0);
  }

  return {
    async init() {
      applySettings(await storage.load());
      storage.subscribe((next) => applySettings(next));
      start();
    },
    stop() {
      stopped = true;
      observer?.disconnect();
      if (timer) win.clearTimeout(timer);
    },
    scanNow: scan,
    getStats() {
      return { enabled: !!settings?.enabled, hiddenOnPage: blockedOnPage.size, mode: settings?.mode };
    },
    getPageChannel() {
      return getPageContext(doc, win.location).channel || null;
    },
    actions,
  };
}
