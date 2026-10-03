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
