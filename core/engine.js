// The filter engine: watches the YouTube page, evaluates every video card and
// hides/blurs the ones that match. Runs as an extension content script or in the
// desktop app's preload — both provide a `storage` adapter:
//   storage.load()            -> Promise<settings>
//   storage.save(settings)    -> Promise<void>
//   storage.subscribe(cb)     -> cb(settings) whenever settings change anywhere

import { createAdSkipper } from './adskip.js';
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

export function createFilter({ storage, doc = document, win = window, debounceMs = 120, adHooks = {} }) {
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
    if (stopped || !settings || !doc.documentElement) return;
    blockedOnPage = new Set();
    const ctx = handlePage();
    const pageChannel = ctx.type === 'channel' ? ctx.channel : null;
    for (const card of doc.querySelectorAll(CARD_SELECTOR)) {
      if (isNestedCard(card)) continue;
      processCard(card, pageChannel);
    }
    hidePlayables();
    hideShorts();
    playerLayout();
    adSkipper.update(win.location.pathname === '/watch' && settings.skipAds);
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
  // Only triggers when nothing is playing after 7s.

  const WATCHDOG_MS = 7000;
  let watchdog = { vid: null, timer: null };
  function playerWatchdog() {
    const vid = win.location.pathname === '/watch' ? new URLSearchParams(win.location.search).get('v') : null;
    if (vid === watchdog.vid) return;
    win.clearTimeout(watchdog.timer);
    watchdog = { vid, timer: null };
    if (!vid) return;
    watchdog.timer = win.setTimeout(() => {
      if (stopped || watchdog.vid !== vid || doc.hidden) return;
      // The symptom: the player is black and nothing is playing (no media at all, or an ad
      // that never loaded, so there is no picture and the clock never moves). A video
      // that is playing, or showing a YouTube error, is left alone.
      const player = doc.querySelector('#movie_player');
      const video = player?.querySelector('video');
      const errorShown = player?.querySelector('.ytp-error');
      if (!player || errorShown) return;
      const hasMedia = video && (video.currentSrc || video.src);
      const noPicture = video && video.readyState < 2 && video.currentTime === 0;
      if (hasMedia && !noPicture) return;
      try {
        if (win.sessionStorage.getItem('aif-reloaded') === vid) return;
        win.sessionStorage.setItem('aif-reloaded', vid);
      } catch {
        return;
      }
      win.location.reload();
    }, WATCHDOG_MS);
  }

  const adSkipper = createAdSkipper({ doc, win, ...adHooks });

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

  // Player size on video pages: 'default' (YouTube's normal layout), 'theater' (wide), or
  // 'fit' (wide + sized to fill the window). Applied once per video, so pressing T still
  // works for the rest of that video.
  let sizing = { vid: null, done: false, tries: 0, last: 0, waiting: false };
  function setWideCookie(on) {
    const has = /(?:^|;\s*)wide=1(?:;|$)/.test(doc.cookie);
    if (has !== on)
      doc.cookie = `wide=${on ? 1 : 0}; domain=.youtube.com; path=/; max-age=31536000; secure; samesite=lax`;
  }
  function playerLayout() {
    const root = doc.documentElement;
    const onWatch = win.location.pathname === '/watch';
    const size = settings.playerSize;
    const fit = onWatch && size === 'fit';
    if (fit !== root.hasAttribute(CINEMA_ATTR)) {
      if (fit) root.setAttribute(CINEMA_ATTR, '');
      else root.removeAttribute(CINEMA_ATTR);
      win.dispatchEvent(new win.Event('resize')); // let the player re-measure
    }
    const wantTheater = size !== 'default';
    // YouTube reads its "wide" cookie on page load; keep it matching so the first frame is right.
    setWideCookie(wantTheater);
    if (!onWatch) return;

    const vid = new URLSearchParams(win.location.search).get('v');
    if (sizing.vid !== vid) sizing = { vid, done: false, tries: 0, last: 0, waiting: false };
    if (sizing.done || sizing.tries >= 30) return;
    const flexy = doc.querySelector('ytd-watch-flexy:not([hidden])');
    const btn = doc.querySelector('#movie_player .ytp-size-button');
    if (flexy && btn && flexy.hasAttribute('theater') === wantTheater) {
      sizing.done = true;
      return;
    }
    const now = Date.now();
    if (!flexy || !btn || now - sizing.last < 1000) {
      // The player ignores clicks until it has finished loading; try again shortly.
      if (!sizing.waiting) {
        sizing.waiting = true;
        win.setTimeout(() => {
          sizing.waiting = false;
          sizing.tries++;
          if (!stopped) scheduleScan(0);
        }, 1000);
      }
      return;
    }
    sizing.tries++;
    sizing.last = now;
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
      adSkipper.update(false);
      win.clearTimeout(watchdog.timer);
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
