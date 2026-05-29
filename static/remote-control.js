/* UberSDR remote-tune API bridge.
 * Opt-in via server config (remote_control.enabled). Lets an allowlisted opener window
 * retune THIS session in place via window.postMessage — no reload, so the audio-start
 * gate is not re-prompted, and the audio context survives. It only drives the current
 * tab's window.radioAPI, so it does not touch the server-side session model.
 *
 * Protocol (versioned, namespaced __ubersdr_rc:1):
 *   controller -> us : {type:"tune", freqHz, mode?} | {type:"ping"}
 *   us -> opener     : {type:"ready"} | {type:"tuned", freqHz, mode, ok} | {type:"frequency_changed", freqHz, mode}
 */
(function () {
  "use strict";
  var cfg = window.__ubersdrRemoteControl || { enabled: false, allowedOrigins: [] };
  if (!cfg.enabled) return;
  var V = 1;
  var ALLOWED = Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : [];
  function allowed(o) { return ALLOWED.indexOf(o) !== -1; }
  function api() { return window.radioAPI; }

  function doTune(freqHz, mode) {
    try {
      if (mode && api() && api().setMode) api().setMode(mode);
      if (api() && api().setFrequency) api().setFrequency(freqHz);
      else if (typeof window.setfreq === "function") window.setfreq(freqHz);
      return true;
    } catch (e) { return false; }
  }

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.__ubersdr_rc !== V || !allowed(e.origin)) return;
    if (m.type === "ping") {
      if (e.source) e.source.postMessage({ __ubersdr_rc: V, type: "ready" }, e.origin);
    } else if (m.type === "tune") {
      if (typeof m.freqHz === "number" && m.freqHz >= 10000 && m.freqHz <= 30000000) {
        var ok = doTune(m.freqHz, m.mode);
        if (e.source) e.source.postMessage({ __ubersdr_rc: V, type: "tuned", freqHz: m.freqHz, mode: m.mode || null, ok: ok }, e.origin);
      }
    }
  });

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    if (api() && api().on) {
      clearInterval(timer);
      try {
        api().on("frequency_changed", function (d) {
          var hz = d && (d.frequency != null ? d.frequency : d.freqHz);
          var mode = api().getMode ? api().getMode() : null;
          if (window.opener) ALLOWED.forEach(function (o) { try { window.opener.postMessage({ __ubersdr_rc: V, type: "frequency_changed", freqHz: hz, mode: mode }, o); } catch (_) {} });
        });
      } catch (_) {}
      if (window.opener) ALLOWED.forEach(function (o) { try { window.opener.postMessage({ __ubersdr_rc: V, type: "ready" }, o); } catch (_) {} });
    } else if (tries > 120) { clearInterval(timer); }
  }, 500);
})();
