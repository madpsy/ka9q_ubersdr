/**
 * webaudio.js — Browser audio playback via the /api/v1/audio/stream WebSocket.
 *
 * The server sends raw decoded PCM regardless of the server-side volume/mute/
 * channel settings (those affect the desktop audio output only).  This module
 * simply connects to the WebSocket and plays the stream through the browser's
 * Web Audio API.  Volume/mute are NOT applied here — the stream is played at
 * full scale.  Use the OS/browser volume control to adjust browser playback.
 *
 * The button in the Audio card is a simple enable/disable toggle.
 *
 * Protocol:
 *   1. JSON text frame: {"sample_rate":48000,"channels":2,"format":"pcm-s16le"}
 *   2. Binary frames:   raw S16LE PCM, interleaved channels (~20 ms each)
 *
 * Exports: WebAudio.init(), WebAudio.start(), WebAudio.stop(), WebAudio.isActive()
 */

const WebAudio = (() => {
  let _ws          = null;
  let _ctx         = null;   // AudioContext
  let _nextTime    = 0;      // next scheduled playback time (AudioContext clock)
  let _sampleRate  = 48000;
  let _channels    = 2;
  let _active      = false;
  let _connected   = false;  // SDR instance connection state

  // How far ahead to schedule (seconds).  Larger = more latency but fewer glitches.
  const SCHEDULE_AHEAD = 0.1;
  // Initial buffer before starting playback (seconds).
  const START_BUFFER   = 0.15;

  // ── PCM decode ────────────────────────────────────────────────────────────

  /** Convert a raw ArrayBuffer of S16LE samples to a Web Audio AudioBuffer. */
  function decodeS16LE(arrayBuf, sampleRate, channels) {
    const samples = new Int16Array(arrayBuf);
    const frames  = Math.floor(samples.length / channels);
    if (frames === 0) return null;

    const buf = _ctx.createBuffer(channels, frames, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const out = buf.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        out[i] = samples[i * channels + ch] / 32768.0;
      }
    }
    return buf;
  }

  /** Schedule an AudioBuffer for gapless playback. */
  function scheduleBuffer(audioBuf) {
    const src = _ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(_ctx.destination);

    const now = _ctx.currentTime;
    // If we've fallen behind (tab backgrounded, etc.), reset the clock.
    if (_nextTime < now + SCHEDULE_AHEAD) {
      _nextTime = now + SCHEDULE_AHEAD;
    }
    src.start(_nextTime);
    _nextTime += audioBuf.duration;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function isActive() { return _active; }

  async function start() {
    if (_active) return;
    if (!_connected) return;  // refuse to start when SDR is disconnected

    // AudioContext must be created/resumed inside a user gesture.
    if (!_ctx) {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
    } else if (_ctx.state === 'suspended') {
      await _ctx.resume();
    }

    _nextTime = _ctx.currentTime + START_BUFFER;
    _active   = true;
    updateBtn(true);

    const wsURL = `${API.V1.replace(/^http/, 'ws')}/audio/stream`;
    _ws = new WebSocket(wsURL);
    _ws.binaryType = 'arraybuffer';

    _ws.onopen = () => {
      console.log('WebAudio: connected');
    };

    _ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        // JSON header frame — update stream parameters
        try {
          const hdr = JSON.parse(e.data);
          _sampleRate = hdr.sample_rate ?? 48000;
          _channels   = hdr.channels   ?? 2;
          // Reset scheduling clock on parameter change
          if (_ctx) _nextTime = _ctx.currentTime + START_BUFFER;
        } catch { /* ignore */ }
        return;
      }

      // Binary PCM frame
      if (!_ctx || !_active) return;
      const audioBuf = decodeS16LE(e.data, _sampleRate, _channels);
      if (audioBuf) scheduleBuffer(audioBuf);
    };

    _ws.onerror = () => {
      console.warn('WebAudio: WebSocket error');
    };

    _ws.onclose = () => {
      console.log('WebAudio: WebSocket closed');
      if (_active) {
        // Unexpected close — retry after 2 s
        setTimeout(() => { if (_active) start(); }, 2000);
      }
    };
  }

  function stop() {
    _active = false;
    updateBtn(false);

    if (_ws) {
      _ws.onclose = null; // prevent auto-retry
      _ws.close();
      _ws = null;
    }

    // Suspend AudioContext to release hardware
    if (_ctx && _ctx.state === 'running') {
      _ctx.suspend();
    }
  }

  // ── Button ────────────────────────────────────────────────────────────────
  function updateBtn(active) {
    const btn = document.getElementById('webaudio-btn');
    if (!btn) return;
    if (active) {
      btn.textContent = '🔴 Stop Browser Audio';
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-danger');
    } else {
      btn.textContent = '🎧 Browser Audio';
      btn.classList.remove('btn-danger');
      btn.classList.add('btn-secondary');
    }
    btn.disabled = !_connected && !active;
  }

  // ── Connection state ──────────────────────────────────────────────────────
  /**
   * Called by app.js whenever the SDR connection state changes.
   * @param {boolean} connected  true = connected, false = disconnected/error
   */
  function onConnectionChange(connected) {
    _connected = connected;
    if (!connected && _active) {
      // Auto-stop browser audio when the SDR instance disconnects.
      stop();
    }
    // Enable/disable the button to reflect whether audio is available.
    const btn = document.getElementById('webaudio-btn');
    if (btn) btn.disabled = !connected && !_active;
  }

  function init() {
    document.getElementById('webaudio-btn')?.addEventListener('click', () => {
      if (_active) stop(); else start();
    });
    // Start disabled until we receive a connected state from the poll.
    const btn = document.getElementById('webaudio-btn');
    if (btn) btn.disabled = true;
  }

  return { init, start, stop, isActive, onConnectionChange };
})();
