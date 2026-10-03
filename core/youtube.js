// Everything that knows about YouTube's DOM lives here. YouTube changes its markup
// often (e.g. the 2025 move from ytd-*-renderer to yt-lockup-view-model), so each
// lookup tries the current structure first and falls back to older ones.

/** Outer elements that represent one video/short/playlist in a feed, search, sidebar or end screen. */
export const CARD_SELECTOR = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'ytd-playlist-panel-video-renderer',
  'ytd-reel-item-renderer',
  'ytd-compact-movie-renderer',
  'ytd-movie-renderer',
  'yt-lockup-view-model',
  'ytm-shorts-lockup-view-model-v2',
  'ytm-shorts-lockup-view-model',
  'a.ytp-videowall-still',
].join(',');

const TITLE_SELECTORS = [
  '#video-title',
  '#video-title-link',
  '[class*="ockupMetadataViewModelTitle"]',
  '[class*="lockup-metadata-view-model__title"]',
  '[class*="lockup-metadata-view-model-wiz__title"]',
  '[class*="MetadataTitle"]',
  '.ytp-videowall-still-info-title',
  'h3',
];

const CHANNEL_LINK_SELECTOR =
  'a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"], ' +
  'a[href*="youtube.com/@"], a[href*="youtube.com/channel/"]';

const METADATA_ROW_SELECTOR =
  '[class*="ContentMetadataViewModelMetadataRow"], [class*="content-metadata-view-model__metadata-row"], [class*="content-metadata-view-model-wiz__metadata-row"]';

const DESCRIPTION_SELECTORS = ['#description-text', '.metadata-snippet-text', '#description'];

function text(el) {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstText(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (!el) continue;
    const t = el.getAttribute('title') || text(el);
    if (t) return t;
  }
  return '';
}

/** Parse a channel URL/path into { handle } or { id }. */
export function parseChannelHref(href) {
  if (!href) return null;
  let path = href;
  try {
    path = new URL(href, 'https://www.youtube.com').pathname;
  } catch {
    return null;
  }
  let m = /^\/(@[^/?#]+)/.exec(path);
  if (m) {
    let handle = m[1];
    try {
      handle = decodeURIComponent(handle);
    } catch {}
    return { handle };
  }
  m = /^\/channel\/(UC[\w-]{10,})/.exec(path);
  if (m) return { id: m[1] };
  m = /^\/(?:c|user)\/([^/?#]+)/.exec(path);
  if (m) return { name: m[1] };
  return null;
}

/** Parse a video id from a /watch?v= or /shorts/ URL. */
export function parseVideoId(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://www.youtube.com');
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = /^\/shorts\/([\w-]{6,})/.exec(u.pathname);
    if (m) return m[1];
  } catch {}
  return null;
}

function cardVideoId(card) {
  const host = card.querySelector('[class*="content-id-"]') || card;
  const cls = typeof host.className === 'string' ? host.className : '';
  const m = /content-id-([\w-]{6,})/.exec(cls);
  if (m) return m[1];
  const link = card.matches?.('a[href]')
    ? card
    : card.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
  return parseVideoId(link?.getAttribute('href'));
}

function cardChannel(card) {
  const channel = {};

  // Prefer the link inside the channel-name element, then any channel link.
  const nameEl = card.querySelector('ytd-channel-name');
  const link = nameEl?.querySelector(CHANNEL_LINK_SELECTOR) || card.querySelector(CHANNEL_LINK_SELECTOR);
  if (link) Object.assign(channel, parseChannelHref(link.getAttribute('href')));

  let name = nameEl ? text(nameEl.querySelector('#text') || nameEl) : '';

  // New lockups: when there are 2+ metadata rows, the first row is the channel name.
  if (!name) {
    const rows = card.querySelectorAll(METADATA_ROW_SELECTOR);
    if (rows.length >= 2) name = text(rows[0]);
  }
  // End-screen video wall: "Channel • 1.2M views"
  if (!name) {
    const author = card.querySelector('.ytp-videowall-still-info-author');
    if (author) name = text(author).split(' • ')[0];
  }
  if (!name && link) {
    const linkText = text(link);
    if (linkText && !linkText.startsWith('@')) name = linkText;
    else name = link.getAttribute('aria-label')?.replace(/^Go to channel\s*/i, '') || '';
  }
  if (name) channel.name = name;
  return Object.keys(channel).length ? channel : null;
}

/**
 * Pull the metadata we match on out of a card element.
 * pageChannel is used when the card has no channel info (e.g. channel page grids).
 */
export function extractCard(card, pageChannel = null) {
  const title = firstText(card, TITLE_SELECTORS);
  const channel = cardChannel(card) || pageChannel || null;
  const description = firstText(card, DESCRIPTION_SELECTORS);
  const videoId = cardVideoId(card);
  return { title, channel, description, videoId };
}

/** The element to hide for a card (shorts inside grid shelves have a wrapper cell). */
export function hideTarget(card) {
  const parent = card.parentElement;
  if (
    parent &&
    typeof parent.className === 'string' &&
    /GridShelfItem|grid-shelf-view-model[\w-]*__shelf-item/.test(parent.className)
  ) {
    return parent;
  }
  return card;
}

/** Is this card nested inside another card (handled by the outer one)? */
export function isNestedCard(card) {
  return !!card.parentElement?.closest(CARD_SELECTOR);
}

// ---------------------------------------------------------------------------
// Shorts

const SHORTS_LINK = 'a[href^="/shorts/"], a[href*="youtube.com/shorts/"]';
const SHORTS_CARD = 'ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model, ytd-reel-item-renderer';
const SHORTS_SHELF =
  'ytd-rich-section-renderer, ytd-rich-shelf-renderer, ytd-shelf-renderer, ytd-reel-shelf-renderer, grid-shelf-view-model';
const SHORTS_ITEM = `${CARD_SELECTOR}, ${SHORTS_CARD}`;

/** Elements to hide so Shorts disappear: shelves, single Shorts cards, sidebar entries. */
export function findShorts(doc) {
  const out = new Set();
  const consider = (el) => {
    let shelf = null;
    for (let s = el.closest(SHORTS_SHELF); s && isShortsShelf(s); s = s.parentElement?.closest(SHORTS_SHELF))
      shelf = s;
    if (shelf) return out.add(shelf);
    const item = outermost(el, SHORTS_ITEM);
    if (item) out.add(hideTarget(item));
  };
  for (const a of doc.querySelectorAll(SHORTS_LINK)) consider(a);
  for (const card of doc.querySelectorAll(SHORTS_CARD)) consider(card);
  for (const shelf of doc.querySelectorAll('ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts]'))
    out.add(shelf.closest('ytd-rich-section-renderer') || shelf);
  // Sidebar "Shorts" entry (full and mini guide).
  for (const a of doc.querySelectorAll(
    'ytd-guide-entry-renderer a[title="Shorts"], ytd-mini-guide-entry-renderer a[title="Shorts"], ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
  )) {
    out.add(a.closest('ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer'));
  }
  out.delete(null);
  return out;
}

// A shelf counts as a Shorts shelf when every link to content in it points at /shorts/.
function isShortsShelf(shelf) {
  const links = shelf.querySelectorAll('a[href*="/watch"], a[href*="/shorts/"], a[href*="/playables"]');
  let shorts = 0;
  for (const a of links) {
    if (!/\/shorts\//.test(a.getAttribute('href'))) return false;
    shorts++;
  }
  return shorts > 0;
}

/** /shorts/<id> -> /watch?v=<id>, or null if not a Shorts URL. */
export function shortsToWatchUrl(loc) {
  const m = /^\/shorts\/([\w-]{6,})/.exec(loc.pathname);
  return m ? `${loc.origin}/watch?v=${m[1]}` : null;
}

// ---------------------------------------------------------------------------
// YouTube Playables (in-browser games)

const PLAYABLE_LINK = 'a[href^="/playables"], a[href*="youtube.com/playables"]';
const PLAYABLE_CARD = 'ytd-mini-game-card-view-model, ytd-mini-game-card-renderer';
// Containers that hold a whole shelf of games on the home feed / search.
const PLAYABLE_SHELF =
  'ytd-rich-section-renderer, ytd-rich-shelf-renderer, ytd-shelf-renderer, ytd-horizontal-card-list-renderer, ytd-reel-shelf-renderer';
const PLAYABLE_ITEM = `${CARD_SELECTOR}, ${PLAYABLE_CARD}, ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer`;

/** Elements to hide so YouTube Playables disappear: shelves, single game cards, sidebar entries. */
export function findPlayables(doc) {
  const out = new Set();
  const consider = (el) => {
    // Largest enclosing shelf that holds nothing but games.
    let shelf = null;
    for (
      let s = el.closest(PLAYABLE_SHELF);
      s && isGameShelf(s);
      s = s.parentElement?.closest(PLAYABLE_SHELF)
    )
      shelf = s;
    if (shelf) return out.add(shelf);
    const item = outermost(el, PLAYABLE_ITEM);
    if (item) out.add(item);
  };
  for (const a of doc.querySelectorAll(PLAYABLE_LINK)) consider(a);
  for (const card of doc.querySelectorAll(PLAYABLE_CARD)) consider(card);
  return out;
}

// The outermost ancestor (or self) matching selector, so hiding it leaves no empty wrapper.
function outermost(el, selector) {
  let found = el.closest(selector);
  while (found) {
    const up = found.parentElement?.closest(selector);
    if (!up) break;
    found = up;
  }
  return found;
}

// A shelf counts as a games shelf when every link to content in it points at /playables.
function isGameShelf(shelf) {
  const links = shelf.querySelectorAll('a[href*="/watch"], a[href*="/shorts/"], a[href*="/playables"]');
  let games = 0;
  for (const a of links) {
    if (!/\/playables/.test(a.getAttribute('href'))) return false;
    games++;
  }
  return games > 0 || !!shelf.querySelector(PLAYABLE_CARD);
}

// ---------------------------------------------------------------------------
// Page context (watch page / channel page)

const DISCLOSURE_TEXT = /altered or synthetic content/i;

function visible(doc, selector) {
  for (const el of doc.querySelectorAll(selector)) {
    if (!el.hasAttribute('hidden')) return el;
  }
  return null;
}

export function getPageContext(doc, loc) {
  const path = loc.pathname;

  if (path === '/watch') {
    const flexy = visible(doc, 'ytd-watch-flexy');
    if (!flexy) return { type: 'other' };
    const meta = flexy.querySelector('ytd-watch-metadata') || flexy;
    const title = text(meta.querySelector('#title h1, h1.ytd-watch-metadata, h1 yt-formatted-string, h1'));
    const owner = meta.querySelector('#owner') || flexy.querySelector('ytd-video-owner-renderer') || meta;
    const channel = cardChannel(owner);
    const descEl = meta.querySelector('#description') || flexy.querySelector('#description');
    const description = text(descEl).slice(0, 5000);
    const disclosed =
      !!flexy.querySelector('how-this-was-made-section-view-model') || DISCLOSURE_TEXT.test(text(descEl));
    return {
      type: 'watch',
      videoId: new URLSearchParams(loc.search).get('v'),
      title,
      channel,
      description,
      disclosed,
      anchor: meta.tagName.toLowerCase() === 'ytd-watch-metadata' ? meta : null,
    };
  }

  const chan = parseChannelHref(path);
  if (chan && !path.startsWith('/c/') && !path.startsWith('/user/')) {
    const browse = visible(doc, 'ytd-browse[page-subtype="channels"]');
    if (!browse) return { type: 'other' };
    const header = browse.querySelector(
      'yt-page-header-renderer h1, #page-header h1, ytd-c4-tabbed-header-renderer #channel-name #text, #channel-header #text',
    );
    const name = text(header);
    const channel = { ...chan };
    if (name) channel.name = name;
    return {
      type: 'channel',
      channel,
      anchor: browse.querySelector('ytd-two-column-browse-results-renderer'),
    };
  }

  return { type: 'other' };
}
