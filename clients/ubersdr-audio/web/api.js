/**
 * api.js — REST API client for UberSDR Audio
 *
 * All functions return a Promise that resolves to the parsed JSON body on
 * success, or rejects with an Error whose .message is the server's "error"
 * field (or a network error string).
 *
 * The base URL is auto-detected: if the page is served from the API server
 * itself (same origin) we use a relative path.  If running from a file:// or
 * different origin (dev mode) we fall back to window.UBERSDR_API_BASE or
 * http://localhost:9770.
 */

const API = (() => {
  // Determine base URL.  Relative path works when served from the API server.
  const BASE = (() => {
    if (window.UBERSDR_API_BASE) return window.UBERSDR_API_BASE.replace(/\/$/, '');
    if (location.protocol === 'file:') return 'http://localhost:9770';
    return ''; // same origin — use relative paths
  })();

  const V1 = `${BASE}/api/v1`;

  /**
   * Core fetch wrapper.
   * @param {string} method
   * @param {string} path   — relative to /api/v1, e.g. '/status'
   * @param {any}    [body] — will be JSON-serialised
   * @param {object} [headers]
   */
  async function req(method, path, body, headers = {}) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let res;
    try {
      res = await fetch(`${V1}${path}`, opts);
    } catch (e) {
      throw new Error(`Network error: ${e.message}`);
    }

    let json;
    try {
      json = await res.json();
    } catch {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return null;
    }

    if (!res.ok) {
      throw new Error(json?.error || `HTTP ${res.status}`);
    }
    return json;
  }

  const get    = (path)        => req('GET',    path);
  const post   = (path, body)  => req('POST',   path, body);
  const put    = (path, body)  => req('PUT',    path, body);
  const patch  = (path, body)  => req('PATCH',  path, body);
  const del    = (path)        => req('DELETE', path);

  return {
    BASE,
    V1,

    // ── Status ──────────────────────────────────────────────────────────────
    getStatus: ()              => get('/status'),

    // ── Connection ──────────────────────────────────────────────────────────
    connect:          (url, password) => post('/connect', { url, password }),
    disconnect:       ()              => post('/disconnect'),
    getInstances:     ()              => get('/instances'),
    connectInstance:  (body)          => post('/instances/connect', body),

    // ── Instance description ─────────────────────────────────────────────────
    getInstance: () => get('/instance'),

    // ── Tuning ──────────────────────────────────────────────────────────────
    getTune:  ()     => get('/tune'),
    putTune:  (body) => put('/tune', body),

    // ── Audio ────────────────────────────────────────────────────────────────
    getAudio:        ()     => get('/audio'),
    putAudio:        (body) => put('/audio', body),
    getAudioDevices: ()     => get('/audio/devices'),

    // ── AGC ──────────────────────────────────────────────────────────────────
    getAGC:  ()     => get('/agc'),
    putAGC:  (body) => put('/agc', body),

    // ── DSP ──────────────────────────────────────────────────────────────────
    getDSP:        ()     => get('/dsp'),
    putDSP:        (body) => put('/dsp', body),
    patchDSPParams:(body) => patch('/dsp/params', body),
    getDSPFilters: ()     => get('/dsp/filters'),

    // ── Bookmarks ─────────────────────────────────────────────────────────────
    /** Proxies GET /api/bookmarks from the connected SDR server. */
    getBookmarks: (params) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : '';
      return get(`/bookmarks${qs}`);
    },

    // ── Signal ───────────────────────────────────────────────────────────────
    getSignal: () => get('/signal'),

    /** Returns an EventSource for /api/v1/signal/stream */
    signalStream: () => new EventSource(`${V1}/signal/stream`),

    // ── Settings ─────────────────────────────────────────────────────────────
    getSettings: ()     => get('/settings'),
    putSettings: (body) => put('/settings', body),

    // ── FLRig ────────────────────────────────────────────────────────────────
    getFlrig:  ()     => get('/flrig'),
    putFlrig:  (body) => put('/flrig', body),

    // ── Profiles ─────────────────────────────────────────────────────────────
    getProfiles:     ()     => get('/profiles'),
    getProfile:      (name) => get(`/profiles/${encodeURIComponent(name)}`),
    saveProfile:     (name) => put(`/profiles/${encodeURIComponent(name)}`),
    deleteProfile:   (name) => del(`/profiles/${encodeURIComponent(name)}`),
    loadProfile:     (name) => post(`/profiles/${encodeURIComponent(name)}/load`),

    // ── Sinks ────────────────────────────────────────────────────────────────
    getSinks:       ()        => get('/sinks'),
    enableStdout:   ()        => post('/sinks/stdout'),
    disableStdout:  ()        => del('/sinks/stdout'),
    addUDPSink:     (address) => post('/sinks/udp', { address }),
    removeUDPSink:  (address) => del(`/sinks/udp/${encodeURIComponent(address)}`),

    // ── Recording ────────────────────────────────────────────────────────────
    getRecord:      ()       => get('/record'),
    startRecord:    (format) => post('/record/start', format ? { format } : {}),
    stopRecord:     ()       => post('/record/stop'),
    deleteRecord:   ()       => del('/record'),
    /** Returns the URL to download the last completed recording. */
    recordDownloadURL: ()    => `${V1}/record/download`,
  };
})();
