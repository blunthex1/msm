// Runs the filter engine against markup copied from real YouTube pages (Oct 2026).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createFilter } from '../core/engine.js';
import { memoryStorage } from '../core/storage.js';

const searchCard = (id, title, handle, name) => `
<ytd-video-renderer>
  <div id="dismissible">
    <ytd-thumbnail><a id="thumbnail" href="/watch?v=${id}"></a></ytd-thumbnail>
    <div class="text-wrapper">
      <div id="meta"><div id="title-wrapper"><h3>
        <a id="video-title" href="/watch?v=${id}" title="${title}"><yt-formatted-string>${title}</yt-formatted-string></a>
      </h3></div></div>
      <div id="channel-info">
        <a id="channel-thumbnail" href="/${handle}" aria-label="Go to channel ${name}"></a>
        <ytd-channel-name id="channel-name"><div id="container"><div id="text-container">
          <yt-formatted-string id="text"><a href="/${handle}">${name}</a></yt-formatted-string>
        </div></div></ytd-channel-name>
      </div>
      <yt-formatted-string id="description-text"></yt-formatted-string>
    </div>
  </div>
</ytd-video-renderer>`;

const lockupCard = (id, title, channelName) => `
<ytd-rich-item-renderer><div id="content"><yt-lockup-view-model>
  <div class="ytLockupViewModelHost content-id-${id}">
    <a class="ytLockupViewModelContentImage" href="/watch?v=${id}"></a>
    <div class="ytLockupViewModelMetadata"><yt-lockup-metadata-view-model>
      <div class="ytLockupMetadataViewModelTextContainer">
        <h3 class="ytLockupMetadataViewModelHeadingReset" title="${title}">
          <a class="ytLockupMetadataViewModelTitle" href="/watch?v=${id}"><span>${title}</span></a>
        </h3>
        <div class="ytLockupMetadataViewModelMetadata"><yt-content-metadata-view-model>
          ${channelName ? `<div class="ytContentMetadataViewModelMetadataRow"><span>${channelName}</span></div>` : ''}
          <div class="ytContentMetadataViewModelMetadataRow"><span>25K views</span><span>11d ago</span></div>
        </yt-content-metadata-view-model></div>
      </div>
    </yt-lockup-metadata-view-model></div>
  </div>
</yt-lockup-view-model></div></ytd-rich-item-renderer>`;

const shortsCell = (id, title) => `
<div class="ytGridShelfViewModelGridShelfItem"><ytm-shorts-lockup-view-model-v2>
  <ytm-shorts-lockup-view-model class="shortsLockupViewModelHost">
    <a class="shortsLockupViewModelHostEndpoint reel-item-endpoint" href="/shorts/${id}"></a>
    <div class="shortsLockupViewModelHostOutsideMetadata">
      <h3 class="shortsLockupViewModelHostMetadataTitle"><a href="/shorts/${id}"><span>${title}</span></a></h3>
    </div>
  </ytm-shorts-lockup-view-model>
</ytm-shorts-lockup-view-model-v2></div>`;

async function setup(body, { url = 'https://www.youtube.com/results?search_query=x', settings = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url });
  const storage = memoryStorage(settings);
  const filter = createFilter({ storage, doc: dom.window.document, win: dom.window, debounceMs: 5 });
  await filter.init();
  filter.scanNow();
  return { dom, doc: dom.window.document, filter, storage };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const marks = (doc) =>
  [...doc.querySelectorAll('[data-aif]')].map(
    (e) => e.tagName.toLowerCase() + ':' + e.getAttribute('data-aif'),
  );

test('hides AI search results and leaves others', async () => {
  const { doc, filter } = await setup(
    searchCard('aaaaaaaaaaa', 'Sora 2 vs Veo 3 Comparison', '@Ai-Chemy', 'Ai Chemy') +
      searchCard('bbbbbbbbbbb', 'How to fix a bike chain', '@bikes', 'Bike Shop'),
  );
  const cards = doc.querySelectorAll('ytd-video-renderer');
  assert.equal(cards[0].getAttribute('data-aif'), 'hide');
  assert.equal(cards[1].getAttribute('data-aif'), null);
  assert.equal(filter.getStats().hiddenOnPage, 1);
  filter.stop();
});

test('handles new lockups (outer rich-item hidden) and shorts grid cells', async () => {
  const { doc, filter } = await setup(
    lockupCard('ccccccccccc', 'Cute puppy compilation', 'AI Animation Studio') +
      lockupCard('ddddddddddd', 'Cute puppy compilation', 'Real Dogs') +
      `<grid-shelf-view-model><div class="ytGridShelfViewModelGridShelfRow">${shortsCell('eeeeeeeeeee', 'Ranking the BEST Ai Cat Moments #shorts')}${shortsCell('fffffffffff', 'My real cat')}</div></grid-shelf-view-model>`,
  );
  assert.deepEqual(marks(doc), ['ytd-rich-item-renderer:hide', 'div:hide']);
  // The grid cell wrapper is hidden (not just the lockup) so no empty slot is left behind.
  assert.ok(
    doc.querySelector('.ytGridShelfViewModelGridShelfItem[data-aif="hide"] a[href="/shorts/eeeeeeeeeee"]'),
  );
  filter.stop();
});

test('blur mode adds an overlay with Show and Allow channel', async () => {
  const { doc, filter, storage } = await setup(
    searchCard('aaaaaaaaaaa', 'AI generated cat saves baby', '@slop', 'Slop TV'),
    {
      settings: { mode: 'blur' },
    },
  );
  const card = doc.querySelector('ytd-video-renderer');
  assert.equal(card.getAttribute('data-aif'), 'blur');
  const buttons = [...card.querySelectorAll('.aif-overlay button')].map((b) => b.textContent);
  assert.deepEqual(buttons, ['Show', 'Allow channel']);

  // "Show" reveals just this video.
  card.querySelector('.aif-overlay button').click();
  await tick();
  assert.equal(card.getAttribute('data-aif'), null);
  assert.equal(card.querySelector('.aif-overlay'), null);

  // "Allow channel" persists to storage and un-hides the channel's other videos.
  card.insertAdjacentHTML('afterend', searchCard('zzzzzzzzzzz', 'AI generated dog', '@slop', 'Slop TV'));
  await tick();
  const second = doc.querySelectorAll('ytd-video-renderer')[1];
  assert.equal(second.getAttribute('data-aif'), 'blur');
  second.querySelector('.aif-overlay button:last-child').click();
  await tick();
  assert.deepEqual((await storage.load()).allowedChannels, [{ key: '@slop', name: 'Slop TV' }]);
  assert.equal(doc.querySelector('[data-aif]'), null);
  filter.stop();
});

test('re-evaluates recycled elements and settings changes', async () => {
  const { doc, filter, storage } = await setup(searchCard('aaaaaaaaaaa', 'Plain title', '@x', 'X'));
  const card = doc.querySelector('ytd-video-renderer');
  assert.equal(card.getAttribute('data-aif'), null);

  // YouTube reuses the element for a different video.
  const t = card.querySelector('#video-title');
  t.setAttribute('title', 'Midjourney portraits');
  t.querySelector('yt-formatted-string').textContent = 'Midjourney portraits';
  await tick();
  assert.equal(card.getAttribute('data-aif'), 'hide');

  // Disabling the filter un-hides everything.
  await storage.save({ ...(await storage.load()), enabled: false });
  await tick();
  assert.equal(card.getAttribute('data-aif'), null);
  filter.stop();
});

test('newly inserted cards are filtered via MutationObserver', async () => {
  const { doc, filter } = await setup('<div id="contents"></div>');
  doc
    .getElementById('contents')
    .insertAdjacentHTML('beforeend', searchCard('ggggggggggg', 'AI music video', '@m', 'M'));
  await tick();
  assert.equal(doc.querySelector('ytd-video-renderer').getAttribute('data-aif'), 'hide');
  filter.stop();
});

test('channel page: cards inherit the page channel; bar offers unblock', async () => {
  const body = `
  <ytd-browse page-subtype="channels">
    <yt-page-header-renderer><h1>Ai Chemy</h1></yt-page-header-renderer>
    <ytd-two-column-browse-results-renderer>
      ${lockupCard('hhhhhhhhhhh', 'I tested a new workflow', '')}
    </ytd-two-column-browse-results-renderer>
  </ytd-browse>`;
  const { doc, filter } = await setup(body, {
    url: 'https://www.youtube.com/@Ai-Chemy/videos',
    settings: { blockedChannels: [{ key: '@ai-chemy', name: 'Ai Chemy' }] },
  });
  assert.equal(doc.querySelector('ytd-rich-item-renderer').getAttribute('data-aif'), 'hide');
  const bar = doc.getElementById('aif-page-bar');
  assert.ok(bar, 'page bar rendered');
  assert.match(bar.textContent, /on your AI block list/);
  bar.querySelector('button').click(); // Unblock
  await tick();
  assert.equal(doc.querySelector('ytd-rich-item-renderer').getAttribute('data-aif'), null);
  assert.match(doc.getElementById('aif-page-bar').textContent, /Block Ai Chemy as AI/);
  filter.stop();
});

test('watch page: synthetic-content label is detected and can auto-block', async () => {
  const body = `
  <ytd-watch-flexy><div id="below">
    <ytd-watch-metadata>
      <div id="title"><h1><yt-formatted-string>Cat rescues owl</yt-formatted-string></h1></div>
      <div id="owner"><ytd-channel-name><div id="text"><a href="/@slopfarm">Slop Farm</a></div></ytd-channel-name></div>
      <div id="description"><how-this-was-made-section-view-model>Altered or synthetic content</how-this-was-made-section-view-model></div>
    </ytd-watch-metadata>
  </div></ytd-watch-flexy>`;
  const url = 'https://www.youtube.com/watch?v=iiiiiiiiiii';

  const manual = await setup(body, { url });
  assert.match(manual.doc.getElementById('aif-page-bar').textContent, /altered or synthetic/);
  manual.filter.stop();

  const auto = await setup(body, { url, settings: { autoBlockDisclosed: true } });
  await tick();
  const s = await auto.storage.load();
  assert.deepEqual(
    s.blockedChannels.map((c) => c.key),
    ['@slopfarm'],
  );
  assert.match(auto.doc.getElementById('aif-page-bar').textContent, /on your AI block list/);
  auto.filter.stop();
});

const gameCard = (id, title) => `
<ytd-rich-item-renderer><div id="content"><ytd-mini-game-card-view-model>
  <a href="/playables/${id}"><img></a><h3><a href="/playables/${id}">${title}</a></h3>
</ytd-mini-game-card-view-model></div></ytd-rich-item-renderer>`;

const playablesShelf = `
<ytd-rich-section-renderer id="games"><div id="content"><ytd-rich-shelf-renderer>
  <h2>YouTube Playables</h2>
  ${gameCard('UgkxAAAA', 'My Mini Mart')}${gameCard('UgkxBBBB', 'Western Farm')}
</ytd-rich-shelf-renderer></div></ytd-rich-section-renderer>`;

const guideEntry = (href, label) =>
  `<ytd-guide-entry-renderer><a id="endpoint" href="${href}">${label}</a></ytd-guide-entry-renderer>`;

test('hides the Playables shelf and sidebar entry, keeps normal videos', async () => {
  const { doc, filter, storage } = await setup(
    guideEntry('/playables', 'Playables') +
      guideEntry('/feed/history', 'History') +
      playablesShelf +
      lockupCard('ccccccccccc', 'Cooking pasta at home', 'Chef'),
    { url: 'https://www.youtube.com/' },
  );
  const games = () => [...doc.querySelectorAll('[data-aif-games]')].map((e) => e.id || e.textContent.trim());
  assert.deepEqual(games(), ['Playables', 'games']);
  assert.equal(marks(doc).length, 0, 'normal video untouched');
  assert.equal(filter.getStats().hiddenOnPage, 0, 'games do not count as AI videos');

  await storage.save({ ...(await storage.load()), hidePlayables: false });
  await tick();
  assert.deepEqual(games(), []);
  filter.stop();
});

test('a mixed shelf only loses its game cards', async () => {
  const { doc, filter } = await setup(
    `<ytd-rich-section-renderer><ytd-rich-shelf-renderer>
      ${gameCard('UgkxCCCC', 'Gas Station')}${lockupCard('ddddddddddd', 'Bike repair basics', 'Bikes')}
    </ytd-rich-shelf-renderer></ytd-rich-section-renderer>`,
    { url: 'https://www.youtube.com/' },
  );
  const hidden = [...doc.querySelectorAll('[data-aif-games]')];
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].tagName.toLowerCase(), 'ytd-rich-item-renderer');
  assert.match(hidden[0].textContent, /Gas Station/);
  filter.stop();
});
