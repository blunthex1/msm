// Strips ad data out of YouTube's player responses before the player sees it, the same
// technique uBlock Origin / Brave use (json-prune on ytInitialPlayerResponse and the
// /youtubei/v1/player responses). Without ad data in the response, the player never
// schedules the ad, so there is nothing to skip.
//
// This function is serialized and run in the PAGE's own JavaScript world at document
// start (before YouTube's scripts), so it must be completely self-contained: no imports,
// no references to anything outside its own body.

export function installAdPrune() {
  if (window.__msmAdPrune) return;
  Object.defineProperty(window, '__msmAdPrune', { value: true });

  var KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
  var nativeParse = JSON.parse;

  function prune(o) {
    if (!o || typeof o !== 'object') return o;
    if (Array.isArray(o)) {
      for (var i = 0; i < o.length; i++) prune(o[i]);
      return o;
    }
    for (var k = 0; k < KEYS.length; k++) {
      if (KEYS[k] in o) {
        try {
          delete o[KEYS[k]];
        } catch (e) {}
      }
    }
    if (o.playerResponse) prune(o.playerResponse);
    return o;
  }

  // 1. The player response embedded in the page's HTML.
  var initial;
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true,
    enumerable: true,
    get: function () {
      return initial;
    },
    set: function (v) {
      initial = prune(v);
    },
  });

  // 2. Responses YouTube's own code fetches while you navigate between videos.
  var nativeFetch = window.fetch;
  var AD_ENDPOINTS = /\/youtubei\/v1\/(player|next|get_watch|reel\/reel_item_watch)/;
  window.fetch = new Proxy(nativeFetch, {
    apply: function (target, thisArg, args) {
      var promise = Reflect.apply(target, thisArg, args);
      var url = '';
      try {
        var a = args[0];
        url = typeof a === 'string' ? a : (a && a.url) || String(a);
      } catch (e) {}
      if (!AD_ENDPOINTS.test(url)) return promise;
      return promise.then(function (res) {
        if (!res || !res.ok) return res;
        return res
          .clone()
          .text()
          .then(function (text) {
            var data = nativeParse.call(JSON, text);
            prune(data);
            return new Response(JSON.stringify(data), {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          })
          .catch(function () {
            return res;
          });
      });
    },
  });

  // 3. Anything else that parses a player response from text.
  JSON.parse = new Proxy(nativeParse, {
    apply: function (target, thisArg, args) {
      var r = Reflect.apply(target, thisArg, args);
      if (r && typeof r === 'object' && ('adPlacements' in r || 'playerResponse' in r)) prune(r);
      return r;
    },
  });
}
