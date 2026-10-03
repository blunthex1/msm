// Pure matching logic — no DOM access, so it can be unit tested in Node.

import { DEFAULT_SETTINGS, KEYWORD_PACKS } from './defaults.js';

const WORD_CHAR = '[\\p{L}\\p{N}_]';

/** Lowercase + NFKC so stylised text ("𝐀𝐈 𝐀𝐫𝐭", full-width letters) matches plain keywords. */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn a plain keyword into a regex source fragment. */
function keywordSource(keyword) {
  const kw = normalizeText(keyword);
  if (!kw) return null;
  let src = kw.split(' ').map(escapeRegex).join('[\\s\\-_]*');
  if (/\p{L}$/u.test(kw)) src += 's?';
  // Only add word boundaries on sides that start/end with a word character,
  // so "#ai" and "a.i." still work.
  const startsWord = /^[\p{L}\p{N}_]/u.test(kw);
  const endsWord = /[\p{L}\p{N}_]$/u.test(kw);
  return (startsWord ? `(?<!${WORD_CHAR})` : '') + `(?:${src})` + (endsWord ? `(?!${WORD_CHAR})` : '');
}

/** Parse "/pattern/flags" into a RegExp, or return null if it is not a regex keyword / is invalid. */
export function parseRegexKeyword(keyword) {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(String(keyword).trim());
  if (!m) return null;
  try {
    const flags = new Set(m[2].replace(/[gy]/g, ''));
    flags.add('i');
    flags.add('u');
    return new RegExp(m[1], [...flags].join(''));
  } catch {
    return null;
  }
}

export function isRegexKeyword(keyword) {
  return /^\/.+\/[a-z]*$/s.test(String(keyword).trim());
}

/**
 * Compile settings into a fast matcher.
 * Returns { matchText(text) -> keyword|null, settings }.
 */
export function compileRules(settings) {
  const ignored = new Set((settings.ignoredKeywords || []).map(normalizeText));
  const plain = new Map(); // regex source -> display keyword
  const regexes = [];

  const add = (kw) => {
    if (typeof kw !== 'string' || !kw.trim()) return;
    if (isRegexKeyword(kw)) {
      const re = parseRegexKeyword(kw);
      if (re) regexes.push({ re, keyword: kw.trim() });
      return;
    }
    if (ignored.has(normalizeText(kw))) return;
    const src = keywordSource(kw);
    if (src && !plain.has(src)) plain.set(src, kw.trim());
  };

  for (const [packId, pack] of Object.entries(KEYWORD_PACKS)) {
    if (settings.packs?.[packId]) pack.keywords.forEach(add);
  }
  (settings.customKeywords || []).forEach(add);

  // Longer keywords first so the reported match is the most specific one.
  const entries = [...plain.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([src, kw]) => ({ src, kw, re: new RegExp(src, 'iu') }));
  const combined = entries.length ? new RegExp(entries.map((e) => e.src).join('|'), 'iu') : null;

  function matchText(text) {
    const t = normalizeText(text);
    if (!t) return null;
    if (combined) {
      const m = combined.exec(t);
      if (m) {
        // Find which keyword produced the match for a readable reason.
        for (const { re, kw } of entries) {
          if (re.test(m[0])) return kw;
        }
        return m[0];
      }
    }
    for (const { re, keyword } of regexes) {
      if (re.test(t)) return keyword;
    }
    return null;
  }

  return { matchText, settings };
}

// ---------------------------------------------------------------------------
// Channels

/** Normalise a channel reference into lookup keys. */
export function channelKeys(channel) {
  const keys = new Set();
  if (!channel) return keys;
  if (channel.handle) keys.add(normalizeHandle(channel.handle));
  if (channel.id) keys.add(channel.id);
  if (channel.name) keys.add('name:' + normalizeText(channel.name));
  return keys;
}

export function normalizeHandle(handle) {
  let h = decodeURIComponentSafe(String(handle).trim());
  if (!h.startsWith('@')) h = '@' + h;
  return h.toLowerCase();
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Build the stored list entry for a channel: { key, name }. */
export function channelEntry(channel) {
  const key = channel.handle
    ? normalizeHandle(channel.handle)
    : channel.id
      ? channel.id
      : 'name:' + normalizeText(channel.name);
  return { key, name: channel.name || channel.handle || channel.id || key };
}

/** Does any entry in `list` refer to `channel`? */
export function channelInList(channel, list) {
  if (!channel || !list?.length) return null;
  const keys = channelKeys(channel);
  if (!keys.size) return null;
  for (const entry of list) {
    if (keys.has(entry.key)) return entry;
    if (entry.name && keys.has('name:' + normalizeText(entry.name))) return entry;
  }
  return null;
}

export function addChannel(list, channel) {
  const entry = channelEntry(channel);
  const rest = (list || []).filter((e) => e.key !== entry.key && !channelInList(channel, [e]));
  return [...rest, entry];
}

export function removeChannel(list, channel) {
  return (list || []).filter((e) => !channelInList(channel, [e]));
}

// ---------------------------------------------------------------------------
// Evaluation

/**
 * Decide whether a video should be filtered.
 * meta: { title, channel: {handle,id,name}, description }
 * Returns { blocked: boolean, reason?: string, kind?: string }
 */
export function evaluate(meta, compiled) {
  const s = compiled.settings;
  if (!s.enabled) return { blocked: false };
  const channel = meta.channel;

  if (channelInList(channel, s.allowedChannels)) return { blocked: false, kind: 'allowed' };

  const blockedEntry = channelInList(channel, s.blockedChannels);
  if (blockedEntry) {
    return { blocked: true, kind: 'channel', reason: `Blocked channel: ${blockedEntry.name}` };
  }

  const titleHit = compiled.matchText(meta.title);
  if (titleHit) return { blocked: true, kind: 'title', reason: `Title matches “${titleHit}”` };

  if (s.matchChannelNames && channel?.name) {
    const hit = compiled.matchText(channel.name);
    if (hit) return { blocked: true, kind: 'channelName', reason: `Channel name matches “${hit}”` };
  }

  if (s.matchDescriptions && meta.description) {
    const hit = compiled.matchText(meta.description);
    if (hit) return { blocked: true, kind: 'description', reason: `Description matches “${hit}”` };
  }

  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Settings validation (used on everything read from storage or received over IPC)

function cleanStrings(value, max = 500) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v === 'string' && v.trim() && v.length <= 300) out.push(v.trim());
    if (out.length >= max) break;
  }
  return [...new Set(out)];
}

function cleanChannels(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const v of value) {
    if (!v || typeof v.key !== 'string' || !v.key || v.key.length > 300) continue;
    if (seen.has(v.key)) continue;
    seen.add(v.key);
    out.push({ key: v.key, name: typeof v.name === 'string' ? v.name.slice(0, 200) : v.key });
    if (out.length >= 5000) break;
  }
  return out;
}

export function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  const packs = {};
  for (const id of Object.keys(KEYWORD_PACKS)) packs[id] = bool(r.packs?.[id], d.packs[id]);
  return {
    enabled: bool(r.enabled, d.enabled),
    mode: r.mode === 'blur' || r.mode === 'hide' ? r.mode : d.mode,
    packs,
    customKeywords: cleanStrings(r.customKeywords),
    ignoredKeywords: cleanStrings(r.ignoredKeywords),
    blockedChannels: cleanChannels(r.blockedChannels),
    allowedChannels: cleanChannels(r.allowedChannels),
    matchChannelNames: bool(r.matchChannelNames, d.matchChannelNames),
    matchDescriptions: bool(r.matchDescriptions, d.matchDescriptions),
    detectDisclosure: bool(r.detectDisclosure, d.detectDisclosure),
    autoBlockDisclosed: bool(r.autoBlockDisclosed, d.autoBlockDisclosed),
    showPageBar: bool(r.showPageBar, d.showPageBar),
  };
}
