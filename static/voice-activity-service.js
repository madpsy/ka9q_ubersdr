// Voice Activity Service
// =====================
// Centralised polling of /api/noisefloor/voice-activity for the currently
// active band. Exposes window.VoiceActivityService so the voice widget — and
// any other part of the UI — can consume live voice-activity data without each
// component running its own fetch loop.
//
// Usage:
//   var unsub = window.VoiceActivityService.subscribe(function (state) {
//     // state = { enabled, band, activities, data, error, timestamp }
//   });
//   // ...later
//   unsub();
//
//   window.VoiceActivityService.getLatest();       // most recent state, or null
//   window.VoiceActivityService.getCurrentBand();  // active band id, or null
//
// Notes:
//   - Polling is lazy: it only runs while there is at least one subscriber.
//   - It is feature-gated: if the server reports noise-floor monitoring is
//     disabled (/api/description), the service emits a disabled state and never
//     polls.
//   - Subscribers are replayed the latest state immediately on subscribe.

(function () {
  'use strict';

  var POLL_MS        = 5000;   // band data refresh cadence
  var BAND_WATCH_MS  = 500;    // how often we check for an active-band change
  var MIN_CONFIDENCE = 0.7;    // server-side confidence filter

  var subscribers = [];        // array of callbacks
  var latest      = null;      // last emitted state object
  var currentBand = null;
  var latestBands = null;      // last fetched { bandName: [activities] } map

  var pollTimer   = null;
  var watchTimer  = null;
  var lastWatched = null;      // last band seen by the watcher
  var inFlight    = false;

  // Resolves once to true/false: is noise-floor monitoring enabled server-side?
  var enabledPromise = null;

  // ── Band detection (mirrors the active band-status badge) ─────────────────
  function getCurrentBand() {
    var btn = document.querySelector('.band-status-badge.active');
    return btn ? btn.getAttribute('data-band') : null;
  }

  // ── Subscriber plumbing ───────────────────────────────────────────────────
  function emit(state) {
    latest = state;
    for (var i = 0; i < subscribers.length; i++) {
      try { subscribers[i](state); }
      catch (e) { console.warn('[VoiceActivityService] subscriber error:', e); }
    }
  }

  function subscribe(cb) {
    if (typeof cb !== 'function') return function () {};
    subscribers.push(cb);
    // Replay the most recent state immediately so late subscribers render now.
    if (latest) { try { cb(latest); } catch (e) { /* ignore */ } }
    ensureRunning();
    return function unsubscribe() {
      var idx = subscribers.indexOf(cb);
      if (idx !== -1) subscribers.splice(idx, 1);
      if (subscribers.length === 0) stop();
    };
  }

  // ── Feature gate ──────────────────────────────────────────────────────────
  function checkEnabled() {
    if (enabledPromise) return enabledPromise;
    enabledPromise = fetch('/api/description')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { return !!(data && data.noise_floor); })
      .catch(function () { return false; });
    return enabledPromise;
  }

  // ── Polling lifecycle ─────────────────────────────────────────────────────
  function ensureRunning() {
    if (subscribers.length === 0) return;
    checkEnabled().then(function (enabled) {
      if (!enabled) {
        emit({ enabled: false, band: null, activities: [], data: null,
               error: null, timestamp: Date.now() });
        return;
      }
      if (pollTimer || watchTimer) return; // already running
      fetchAndEmit();
      pollTimer  = setInterval(fetchAndEmit, POLL_MS);
      watchTimer = setInterval(function () {
        var b = getCurrentBand();
        if (b !== lastWatched) {
          lastWatched = b;
          // We already hold every band's activity from the last fetch, so a
          // band change just re-derives the current-band slice instantly — no
          // extra request (the next poll refreshes the underlying data).
          if (latestBands) emitFromBands(latestBands, b);
          else fetchAndEmit();
        }
      }, BAND_WATCH_MS);
    });
  }

  function stop() {
    if (pollTimer)  { clearInterval(pollTimer);  pollTimer  = null; }
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    lastWatched = null;
  }

  // ── Fetch & emit ──────────────────────────────────────────────────────────
  // Flatten the all-bands { bandName: [activities] } map into one array.
  function flattenBands(bands) {
    var out = [];
    if (!bands) return out;
    for (var name in bands) {
      if (!Object.prototype.hasOwnProperty.call(bands, name)) continue;
      if (Array.isArray(bands[name])) out = out.concat(bands[name]);
    }
    return out;
  }

  // Build & emit a state object from the cached all-bands map for the active
  // band. `activities` is the current band's slice (the voice widget + markers
  // render this); `allActivities` spans every band so marker prev/next
  // navigation can reach voice activity on other bands too.
  function emitFromBands(bands, band) {
    latestBands = bands || {};
    // Tag each activity with the band it belongs to (the all-bands map is keyed
    // by band, but the activity objects themselves don't carry it) so marker
    // labels can show e.g. "Voice 20m" when there's no callsign.
    for (var bn in latestBands) {
      if (!Object.prototype.hasOwnProperty.call(latestBands, bn)) continue;
      var arr = latestBands[bn];
      if (Array.isArray(arr)) {
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] && typeof arr[i] === 'object') arr[i].band = bn;
        }
      }
    }
    emit({
      enabled: true,
      band: band,
      activities: (band && latestBands[band]) ? latestBands[band] : [],
      allActivities: flattenBands(latestBands),
      data: latestBands,
      error: null,
      timestamp: Date.now()
    });
  }

  function fetchAndEmit() {
    if (inFlight) return;
    var band = getCurrentBand();
    currentBand = band;

    // Fetch every band at once (single endpoint, same rate-limit bucket). The
    // current-band slice is derived locally, so no per-band request is needed.
    inFlight = true;
    fetch('/api/noisefloor/voice-activity/all?min_confidence=' + MIN_CONFIDENCE)
      .then(function (r) {
        if (r.status === 429) return null;            // rate limited — keep last
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data) return;                            // 429: leave existing state
        emitFromBands(data.bands || {}, getCurrentBand());
      })
      .catch(function (err) {
        emit({ enabled: true, band: band, activities: [], allActivities: [],
               data: null, error: err.message, timestamp: Date.now() });
      })
      .finally(function () { inFlight = false; });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.VoiceActivityService = {
    subscribe:        subscribe,
    getLatest:        function () { return latest; },
    // Flattened voice activity across ALL bands (for marker prev/next nav).
    getAllActivities: function () { return latest ? (latest.allActivities || []) : []; },
    getCurrentBand:   getCurrentBand,
    MIN_CONFIDENCE:   MIN_CONFIDENCE
  };
})();
