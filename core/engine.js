// The filter engine: watches the YouTube page, evaluates every video card and
// hides/blurs the ones that match. Runs as an extension content script or in the
// desktop app's preload — both provide a `storage` adapter:
//   storage.load()            -> Promise<settings>
//   storage.save(settings)    -> Promise<void>
//   storage.subscribe(cb)     -> cb(settings) whenever settings change anywhere

import {
  addChannel,
  channelInList,
  compileRules,
  evaluate,
  removeChannel,
  sanitizeSettings,
} from './rules.js';
import { CARD_SELECTOR, extractCard, getPageContext, hideTarget, isNestedCard } from './youtube.js';

const ATTR = 'data-aif';
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
      buttons.push(btn(`Block ${name} as AI`, () => actions.blockChannel(channel)));
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
