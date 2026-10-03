import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addChannel,
  channelInList,
  compileRules,
  evaluate,
  normalizeText,
  removeChannel,
  sanitizeSettings,
} from '../core/rules.js';
import { parseChannelHref, parseVideoId } from '../core/youtube.js';
import { parseChannelInput } from '../core/options/options.js';

const rules = (patch = {}) => compileRules(sanitizeSettings(patch));
const blocked = (title, patch) => evaluate({ title }, rules(patch)).blocked;

test('default pack catches typical AI-generated titles', () => {
  for (const title of [
    'Cat saves baby from flood | AI Generated',
    'This AI-generated movie trailer is insane',
    'Harry Potter as an 80s sitcom (AI art)',
    'Ranking the BEST Ai Cat Moments #shorts #viral',
    'Made with Sora 2 — Underwater city',
    'Veo3 test: dragons over London',
    'Lofi beats but every song is made by Suno',
    'Dancing grandma #aiart #fyp',
    'Midjourney V7 portraits',
    '𝐀𝐈 𝐆𝐞𝐧𝐞𝐫𝐚𝐭𝐞𝐝 cartoon', // stylised unicode
    'ＡＩ ｇｅｎｅｒａｔｅｄ', // full-width
  ]) {
    assert.ok(blocked(title), `expected block: ${title}`);
  }
});

test('default pack leaves normal and AI-adjacent titles alone', () => {
  for (const title of [
    'Kingdom Hearts: Sora vs Riku boss fight',
    "STRONGEST SORA'S FORMS | #shorts #sora #kh #kingdomhearts",
    'Lo que veo cada mañana #veo #vlog',
    'How I said goodbye to Thailand',
    'Maintaining your bonsai tree',
    'Fixing a car alternator',
    'Explaining how ChatGPT works', // AI topic, not AI-generated: only the topics pack hides this
    'Daily vlog: ai weiwei exhibition',
  ]) {
    assert.ok(!blocked(title), `expected show: ${title}`);
  }
});

test('topics pack is opt-in and aggressive', () => {
  const t = 'Explaining how ChatGPT works';
  assert.equal(blocked(t), false);
  assert.equal(blocked(t, { packs: { aiGenerated: true, aiTopics: true } }), true);
  assert.equal(blocked('Is A.I. taking our jobs?', { packs: { aiTopics: true } }), true);
  assert.equal(blocked('GPT-5 review', { packs: { aiTopics: true } }), true);
  assert.equal(blocked('Said the raindrop', { packs: { aiTopics: true } }), false);
});

test('keyword matching handles separators, plurals and hashtags', () => {
  assert.ok(blocked('AI-art compilation'));
  assert.ok(blocked('#AIArt daily'));
  assert.ok(blocked('ai_cover of Bohemian Rhapsody'));
  assert.ok(blocked('Best AI covers 2026'));
  assert.ok(!blocked('aiartist'));
});

test('custom keywords, regexes and ignored keywords', () => {
  assert.ok(blocked('Grandma singing opera', { customKeywords: ['grandma singing'] }));
  assert.ok(blocked('Talking capybara episode 4', { customKeywords: ['/talking\\s+capybara/'] }));
  // invalid regex is ignored rather than throwing
  assert.ok(!blocked('anything', { customKeywords: ['/(unclosed/'] }));
  assert.ok(!blocked('New Suno album', { ignoredKeywords: ['suno'] }));
});

test('reason names the matched keyword', () => {
  const v = evaluate({ title: 'Epic AI short film about Mars' }, rules());
  assert.equal(v.blocked, true);
  assert.match(v.reason, /ai short film/i);
});

test('channel block and allow lists', () => {
  const ch = { handle: '@Ai-Chemy', name: 'Ai Chemy' };
  let s = sanitizeSettings({ blockedChannels: addChannel([], ch) });
  assert.equal(evaluate({ title: 'Ordinary title', channel: ch }, compileRules(s)).kind, 'channel');
  // matches by display name when the card has no handle
  assert.ok(evaluate({ title: 'x', channel: { name: 'ai chemy' } }, compileRules(s)).blocked);
  // handle comparison is case-insensitive
  assert.ok(channelInList({ handle: '@ai-chemy' }, s.blockedChannels));

  // allowlist wins over keywords
  s = sanitizeSettings({ allowedChannels: addChannel([], ch) });
  assert.equal(evaluate({ title: 'AI generated stuff', channel: ch }, compileRules(s)).blocked, false);

  assert.deepEqual(removeChannel(addChannel([], ch), { handle: '@ai-chemy' }), []);
});

test('channel names and descriptions can be matched', () => {
  const c = rules();
  assert.ok(evaluate({ title: 'Cute puppy', channel: { name: 'AI Animation Studio' } }, c).blocked);
  assert.ok(evaluate({ title: 'Cute puppy', description: 'Made with AI ✨ #aivideo' }, c).blocked);
  const off = rules({ matchChannelNames: false, matchDescriptions: false });
  assert.ok(
    !evaluate({ title: 'Cute puppy', channel: { name: 'AI Animation Studio' }, description: '#aivideo' }, off)
      .blocked,
  );
});

test('disabled filter blocks nothing', () => {
  assert.equal(blocked('AI generated', { enabled: false }), false);
});

test('sanitizeSettings rejects junk', () => {
  const s = sanitizeSettings({
    enabled: 'yes',
    mode: 'explode',
    customKeywords: ['ok', 42, '', 'ok'],
    blockedChannels: [{ key: '@a', name: 'A' }, { nope: true }, { key: '@a' }],
    __proto__: { evil: true },
  });
  assert.equal(s.enabled, true);
  assert.equal(s.mode, 'hide');
  assert.deepEqual(s.customKeywords, ['ok']);
  assert.deepEqual(s.blockedChannels, [{ key: '@a', name: 'A' }]);
  assert.equal(s.evil, undefined);
});

test('URL and input parsing', () => {
  assert.deepEqual(parseChannelHref('/@Ai-Chemy'), { handle: '@Ai-Chemy' });
  assert.deepEqual(parseChannelHref('https://www.youtube.com/@foo/videos'), { handle: '@foo' });
  assert.deepEqual(parseChannelHref('/channel/UCabcdefghijklmnopqrstuv'), { id: 'UCabcdefghijklmnopqrstuv' });
  assert.equal(parseChannelHref('/watch?v=abc'), null);
  assert.equal(parseVideoId('/watch?v=pNMMFov2f_c&pp=xyz'), 'pNMMFov2f_c');
  assert.equal(parseVideoId('/shorts/HM_SpXP3nuk'), 'HM_SpXP3nuk');
  assert.deepEqual(parseChannelInput('@foo'), { handle: '@foo', name: '@foo' });
  assert.equal(parseChannelInput('youtube.com/@bar/shorts').handle, '@bar');
  assert.deepEqual(parseChannelInput('Some Channel'), { name: 'Some Channel' });
  assert.equal(normalizeText('  Ａ  B​ C '), 'a b c');
});
