// Auto-skip sponsor segments inside videos using the community SponsorBlock database
// (https://sponsor.ajay.app). Privacy: only the first 4 hex chars of the video id's SHA-256
// are sent, so the server sees a bucket of many videos, not which one you're watching.

const API = 'https://sponsor.ajay.app/api/skipSegments/';
export const SPONSOR_CATEGORIES = ['sponsor', 'selfpromo'];

async function sha256Hex(text, win) {
  const buf = await win.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fetch skippable [start, end] segments for a video. Returns [] when none or on error. */
export async function fetchSegments(videoId, win = window, categories = SPONSOR_CATEGORIES) {
  try {
    const prefix = (await sha256Hex(videoId, win)).slice(0, 4);
    const url = `${API}${prefix}?categories=${encodeURIComponent(JSON.stringify(categories))}`;
    const res = await win.fetch(url, { credentials: 'omit' });
    if (!res.ok) return [];
    const data = await res.json();
    const entry = Array.isArray(data) && data.find((v) => v.videoID === videoId);
    if (!entry) return [];
    return entry.segments
      .filter((s) => s.actionType === 'skip' && Array.isArray(s.segment))
      .map((s) => ({ start: +s.segment[0], end: +s.segment[1], category: s.category }))
      .filter((s) => s.end - s.start >= 1)
      .sort((a, b) => a.start - b.start);
  } catch {
    return [];
  }
}

/** Watches the page's <video> and jumps over sponsor segments of the current video. */
export function createSponsorSkipper({ doc, win, onSkip }) {
  let videoId = null;
  let segments = [];
  let video = null;
  const skipped = new Set(); // segments already skipped (don't fight a user who seeks back)

  function onTime() {
    if (!video || !segments.length) return;
    const t = video.currentTime;
    for (const seg of segments) {
      const key = `${seg.start}`;
      if (t >= seg.start && t < seg.end - 0.3 && !skipped.has(key)) {
        skipped.add(key);
        const from = t;
        video.currentTime = Math.min(seg.end, video.duration || seg.end);
        onSkip?.(seg, () => {
          video.currentTime = from; // Undo
        });
        return;
      }
    }
  }

  function attach(v) {
    if (video === v) return;
    video?.removeEventListener('timeupdate', onTime);
    video = v;
    video?.addEventListener('timeupdate', onTime);
  }

  return {
    /** Call on every page scan. id = current watch-page video id (or null). */
    update(id, enabled) {
      if (!enabled || !id) {
        attach(null);
        videoId = null;
        segments = [];
        return;
      }
      attach(doc.querySelector('#movie_player video, video.html5-main-video'));
      if (id === videoId) return;
      videoId = id;
      segments = [];
      skipped.clear();
      fetchSegments(id, win).then((segs) => {
        if (videoId === id) segments = segs;
      });
    },
  };
}
