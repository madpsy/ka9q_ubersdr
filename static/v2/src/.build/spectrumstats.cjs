var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/spectrumStats.js
var spectrumStats_exports = {};
__export(spectrumStats_exports, {
  STATS_DEFAULT_DESKTOP: () => STATS_DEFAULT_DESKTOP,
  STATS_DEFAULT_MOBILE: () => STATS_DEFAULT_MOBILE,
  STATS_PLACES: () => STATS_PLACES,
  formatHzPerBin: () => formatHzPerBin,
  formatThroughput: () => formatThroughput,
  perSecond: () => perSecond,
  statLines: () => statLines,
  statsPlace: () => statsPlace,
  throughputSplit: () => throughputSplit
});
module.exports = __toCommonJS(spectrumStats_exports);
var STATS_PLACES = ["off", "left", "right"];
var STATS_DEFAULT_DESKTOP = "left";
var STATS_DEFAULT_MOBILE = "off";
function statsPlace(setting, isMobile) {
  if (STATS_PLACES.includes(setting))
    return setting;
  return isMobile ? STATS_DEFAULT_MOBILE : STATS_DEFAULT_DESKTOP;
}
function perSecond(delta, ms) {
  if (!(ms > 0) || !Number.isFinite(delta) || delta < 0)
    return null;
  return delta * 1e3 / ms;
}
function rate(v) {
  if (v == null || !Number.isFinite(v))
    return null;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}
function formatThroughput(...streams) {
  const parts = streams.filter((v) => Number.isFinite(v) && v >= 0);
  if (!parts.length)
    return null;
  const total = parts.reduce((a, b) => a + b, 0);
  const [div, unit] = total < 1024 ? [1, "B/s"] : total < 1024 * 1024 ? [1024, "kB/s"] : [1024 * 1024, "MB/s"];
  const part = (v) => String(Math.round(v / div));
  if (parts.length === 1)
    return `${part(parts[0])} ${unit}`;
  return `${parts.map(part).join(" + ")} = ${part(total)} ${unit}`;
}
function throughputSplit(streams, bits = false) {
  const known = streams.filter((v) => Number.isFinite(v) && v >= 0);
  const totalBytes = known.reduce((a, b) => a + b, 0);
  const scaled = bits ? totalBytes * 8 : totalBytes;
  const [div, unit] = bits ? scaled < 1e6 ? [1e3, "kbit/s"] : [1e6, "Mbit/s"] : totalBytes < 1024 ? [1, "B/s"] : totalBytes < 1024 * 1024 ? [1024, "kB/s"] : [1024 * 1024, "MB/s"];
  const one = (v) => {
    const n = (bits ? v * 8 : v) / div;
    return div > 1024 * 512 || bits && div > 1e3 ? n.toFixed(1) : String(Math.round(n));
  };
  return {
    unit,
    total: known.length ? one(totalBytes) : null,
    values: streams.map((v) => Number.isFinite(v) && v >= 0 ? one(v) : null)
  };
}
function formatHzPerBin(hz) {
  if (!(hz > 0))
    return null;
  if (hz < 1)
    return `${hz.toFixed(2)} Hz`;
  if (hz < 100)
    return `${hz.toFixed(1)} Hz`;
  return `${Math.round(hz)} Hz`;
}
function appLoad(app) {
  if (!app)
    return null;
  const parts = [];
  if (app.cpu != null)
    parts.push(`${Math.round(app.cpu)}%`);
  if (app.mem != null) {
    const mb = app.mem / 1e6;
    parts.push(mb >= 1e3 ? `${(mb / 1e3).toFixed(1)} GB` : `${Math.round(mb)} MB`);
  }
  return parts.length ? parts.join("  ") : null;
}
function formatStreamShort(rate2, channels) {
  const parts = [];
  if (rate2 > 0)
    parts.push(`${(rate2 / 1e3).toFixed(rate2 % 1e3 ? 1 : 0)}K`);
  if (channels > 0)
    parts.push(`${Math.round(channels)}ch`);
  return parts.length ? parts.join(" ") : null;
}
function statLines(s = {}) {
  const out = [];
  const add = (key, label, value, title) => {
    if (value)
      out.push({ key, label, value, title });
  };
  add("fps", "FPS", rate(s.fps), "Animation frames per second \u2014 the rate the browser is managing, drawn or idle. Well below the screen refresh means this machine is struggling, whatever the receiver is doing.");
  add("feed", "FEED", rate(s.framesIn) && `${rate(s.framesIn)}/s`, "Spectrum frames arriving per second. Halves when the idle throttle takes effect, and drops to nothing when the socket is paused.");
  if (s.divisor > 1) {
    add("poll", "POLL", `1/${Math.round(s.divisor)}`, "The server is polling the receiver at this fraction of the full rate \u2014 the idle throttle, or another client on a shared channel.");
  }
  const fft = [s.binCount > 0 && `${s.binCount} bins`, formatHzPerBin(s.binHz)].filter(Boolean).join("  ");
  add("fft", "FFT", fft, "Bins across the view, and what one bin is worth. The resolution decides whether two close carriers are one blob or two.");
  add("net", "NET", formatThroughput(s.bytesIn, s.audioBytes, s.bandBytes), "Every stream this session is running \u2014 the main spectrum, the audio, and the band spectrum panel when it is open \u2014 and the total. What the connection is costing, and which part of it to do something about.");
  const latency = (s.queuedSec || 0) + (s.outLatSec || 0);
  const audio = [
    latency > 0 ? `${Math.round(latency * 1e3)} ms` : null,
    formatStreamShort(s.streamRate, s.streamChannels),
    s.underruns > 0 ? `${s.underruns} drop${s.underruns === 1 ? "" : "s"}` : null
  ].filter(Boolean).join("  ") || null;
  const users = s.listeners > 0 ? `${Math.round(s.listeners)}${s.chatUsers > 0 ? ` (${Math.round(s.chatUsers)})` : ""}` : null;
  add("users", "USERS", users, "Sessions on this receiver right now, yours included \u2014 the same list the Listeners panel shows \u2014 and in brackets how many are in chat. A shared receiver getting busy is the other reason the spectrum can slow down, and the one nothing else on this display would tell you about.");
  add("ip", "IP", typeof s.ip === "string" && s.ip ? s.ip : null, "The address this page is connected from, as the receiver sees it \u2014 /api/myip, the same lookup behind the greeting on the start screen.");
  add("app", "APP", appLoad(s.app), "What this app is costing the machine it is running on: processor time as a share of one core, and real memory. Only the Android, iOS and desktop clients can measure this \u2014 a browser tab has no way to ask.");
  add("audio", "AUDIO", audio, "The audio stream: how far behind live you are \u2014 what is queued ahead of the playback clock plus what the output device adds \u2014 then its sample rate and channel count, both set by the mode, and how many dropouts there have been.");
  return out;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  STATS_DEFAULT_DESKTOP,
  STATS_DEFAULT_MOBILE,
  STATS_PLACES,
  formatHzPerBin,
  formatThroughput,
  perSecond,
  statLines,
  statsPlace,
  throughputSplit
});
