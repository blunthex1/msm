// Settings page, shared by the browser extension and the desktop app.

import { DEFAULT_SETTINGS, KEYWORD_PACKS } from '../defaults.js';
import {
  addChannel,
  compileRules,
  evaluate,
  isRegexKeyword,
  parseRegexKeyword,
  removeChannel,
  sanitizeSettings,
} from '../rules.js';
import { parseChannelHref } from '../youtube.js';

/** Turn what a user typed ("@foo", a URL, "UC…", or a name) into a channel object. */
export function parseChannelInput(input) {
  const v = input.trim();
  if (!v) return null;
  if (v.startsWith('@')) return { handle: v.split(/[/?#\s]/)[0], name: v.split(/[/?#\s]/)[0] };
  if (/^UC[\w-]{20,}$/.test(v)) return { id: v, name: v };
  if (/^(https?:\/\/)?(www\.|m\.)?youtube\.com\//i.test(v)) {
    const url = v.startsWith('http') ? v : 'https://' + v;
    const parsed = parseChannelHref(url);
    if (parsed) return { ...parsed, name: parsed.handle || parsed.id || parsed.name };
    return null;
  }
  return { name: v };
}

export function mountOptions(storage, doc = document) {
  const $ = (id) => doc.getElementById(id);
  let settings = sanitizeSettings({});
  let savedTimer = null;

  function el(tag, props = {}, ...children) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    e.append(...children.filter((c) => c != null));
    return e;
  }

  async function save(patch) {
    settings = sanitizeSettings({ ...settings, ...patch });
    await storage.save(settings);
    const s = $('saved');
    s.textContent = 'Saved';
    s.style.opacity = '1';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (s.style.opacity = '0'), 1200);
    renderDynamic();
  }

  // ---- static controls -----------------------------------------------------

  const packsRoot = $('packs');
  for (const [id, pack] of Object.entries(KEYWORD_PACKS)) {
    const box = el('input', { type: 'checkbox', 'data-pack': id });
    box.addEventListener('change', () => save({ packs: { ...settings.packs, [id]: box.checked } }));
    packsRoot.append(
      el(
        'div',
        { class: 'pack' },
        el(
          'label',
          { class: 'check' },
          box,
          el('span', {}, el('strong', {}, pack.label), el('small', {}, pack.description)),
        ),
        el(
          'details',
          {},
          el('summary', {}, `${pack.keywords.length} keywords`),
          el('p', {}, pack.keywords.join(', ')),
        ),
      ),
    );
  }

  const bools = [
    'enabled',
    'matchChannelNames',
    'matchDescriptions',
    'detectDisclosure',
    'autoBlockDisclosed',
    'showPageBar',
    'hidePlayables',
    'hideShorts',
    'cinemaWatch',
  ];
  for (const id of bools) $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));

  for (const radio of doc.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => radio.checked && save({ mode: radio.value }));
  }

  const lines = (v) =>
    v
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  let kwTimer = null;
  for (const id of ['customKeywords', 'ignoredKeywords']) {
    $(id).addEventListener('input', () => {
      clearTimeout(kwTimer);
      kwTimer = setTimeout(() => save({ [id]: lines($(id).value) }), 400);
    });
  }

  function channelForm(formId, inputId, listKey, otherKey) {
    $(formId).addEventListener('submit', (e) => {
      e.preventDefault();
      const ch = parseChannelInput($(inputId).value);
      if (!ch) return;
      $(inputId).value = '';
      save({
        [listKey]: addChannel(settings[listKey], ch),
        [otherKey]: removeChannel(settings[otherKey], ch),
      });
    });
  }
  channelForm('blockForm', 'blockInput', 'blockedChannels', 'allowedChannels');
  channelForm('allowForm', 'allowInput', 'allowedChannels', 'blockedChannels');

  $('tester').addEventListener('input', renderTest);

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'ai-filter-settings.json' });
    doc.body.append(a);
    a.click();
    a.remove();
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      settings = sanitizeSettings(data);
      await save({});
      renderAll();
    } catch {
      alert('That file is not a valid AI Filter settings export.');
    }
    e.target.value = '';
  });
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset all AI Filter settings, including your channel lists?')) return;
    settings = sanitizeSettings(DEFAULT_SETTINGS);
    await save({});
    renderAll();
  });

  // ---- rendering -------------------------------------------------------------

  function renderChannels(listKey, rootId, countId) {
    const root = $(rootId);
    root.replaceChildren();
    const list = settings[listKey];
    $(countId).textContent = list.length ? `(${list.length})` : '';
    if (!list.length) {
      root.append(el('li', { class: 'empty' }, 'None yet.'));
      return;
    }
    for (const entry of [...list].reverse()) {
      const label = entry.key.startsWith('name:') ? entry.name : entry.key;
      root.append(
        el(
          'li',
          { title: entry.key },
          entry.name && entry.name.toLowerCase() !== label.toLowerCase()
            ? el('span', {}, entry.name, el('small', {}, label))
            : el('span', {}, label),
          el(
            'button',
            {
              type: 'button',
              'aria-label': `Remove ${entry.name}`,
              onclick: () => save({ [listKey]: settings[listKey].filter((e) => e.key !== entry.key) }),
            },
            '✕',
          ),
        ),
      );
    }
  }

  function renderTest() {
    const title = $('tester').value;
    const out = $('testResult');
    if (!title.trim()) {
      out.textContent = '';
      out.className = 'test-result';
      return;
    }
    const verdict = evaluate({ title }, compileRules({ ...settings, enabled: true }));
    out.textContent = verdict.blocked ? `Would be filtered — ${verdict.reason}` : 'Would be shown.';
    out.className = 'test-result ' + (verdict.blocked ? 'blocked' : 'ok');
  }

  function renderDynamic() {
    const bad = settings.customKeywords.filter((k) => isRegexKeyword(k) && !parseRegexKeyword(k));
    $('keywordErrors').textContent = bad.length ? `Invalid regex: ${bad.join(', ')}` : '';
    $('autoBlockDisclosed').disabled = !settings.detectDisclosure;
    renderChannels('blockedChannels', 'blockedChannels', 'blockedCount');
    renderChannels('allowedChannels', 'allowedChannels', 'allowedCount');
    renderTest();
  }

  function renderAll() {
    for (const id of bools) $(id).checked = settings[id];
    for (const radio of doc.querySelectorAll('input[name="mode"]'))
      radio.checked = radio.value === settings.mode;
    for (const box of doc.querySelectorAll('[data-pack]')) box.checked = !!settings.packs[box.dataset.pack];
    // Don't clobber a textarea the user is typing in.
    for (const id of ['customKeywords', 'ignoredKeywords']) {
      if (doc.activeElement !== $(id)) $(id).value = settings[id].join('\n');
    }
    renderDynamic();
  }

  storage.load().then((s) => {
    settings = s;
    renderAll();
  });
  storage.subscribe((s) => {
    settings = s;
    renderAll();
  });
}
