// websdr-sound.js — UberSDR Opus audio decoder for the WebSDR frontend
//
// Replaces the original PA3FWM ADPCM decoder.  Connects to /~~stream,
// receives UberSDR Opus Version-2 binary packets, decodes them with the
// wasm-audio-decoders OpusDecoder library (same library used by the main
// UberSDR frontend), and plays them via the Web Audio API.
//
// Wire format (Version 2, 21-byte header):
//   [timestamp:8 LE uint64][sampleRate:4 LE uint32][channels:1]
//   [basebandPower:4 LE float32][noiseDensity:4 LE float32][opusData...]
//
// Public interface (called by websdr-base.js):
//   window.prep_html5sound()          — create window.soundapplet
//   window.soundapplet.setparam(qs)   — send /~~param?<qs> over WebSocket
//   window.soundapplet.mute()         — toggle mute
//   window.soundapplet.setvolume(v)   — set volume (0.0–1.0 typical)
//   window.soundapplet.smeter()       — return S-meter value (0–1270 range)
//   window.soundapplet.getid()        — return connection ID (1 when connected)
//   window.soundapplet.destroy()      — close connection and release resources

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  var HEADER_SIZE      = 21;      // bytes before Opus payload
  var DEFAULT_SR       = 48000;
  var MIN_BUFFER_SEC   = 0.05;    // minimum scheduling lookahead (50 ms)
  var MAX_BUFFER_SEC   = 1.5;     // drop packets if buffer exceeds this

  // ── Library loader ─────────────────────────────────────────────────────────
  // Inject opus-decoder.min.js once, then call back when ready.

  var _libReady    = false;
  var _libPending  = false;
  var _libCallbacks = [];

  function _loadLib(cb) {
    if (_libReady) { cb(); return; }
    _libCallbacks.push(cb);
    if (_libPending) return;
    _libPending = true;

    var s = document.createElement('script');
    s.src  = 'opus-decoder.min.js';
    s.type = 'text/javascript';
    s.onload = function () {
      _libReady = true;
      var cbs = _libCallbacks.slice();
      _libCallbacks = [];
      for (var i = 0; i < cbs.length; i++) { try { cbs[i](); } catch(e) {} }
    };
    s.onerror = function () {
      console.error('WebSDR: failed to load opus-decoder.min.js');
    };
    document.head.appendChild(s);
  }

  // ── UberSDRSound constructor ───────────────────────────────────────────────

  function UberSDRSound() {
    this._ws            = null;
    this._audioCtx      = null;
    this._gainNode      = null;
    this._nextPlayTime  = 0;
    this._audioSR       = 0;      // sample rate of current AudioContext

    // Opus decoder (wasm-audio-decoders OpusDecoder instance)
    this._decoder       = null;
    this._decoderSR     = 0;
    this._decoderCh     = 0;
    this._decoderReady  = false;  // true after decoder.ready resolves

    // Playback state
    this._muted         = false;
    this._volume        = 1.0;
    this._connected     = false;

    // S-meter: basebandPower in dBFS from packet header
    this._basebandPower = -999.0;

    // Queue of packets that arrived before the decoder was ready
    this._pendingPackets = [];

    this._connect();
  }

  // ── WebSocket connection ───────────────────────────────────────────────────

  UberSDRSound.prototype._connect = function () {
    var self = this;
    var proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
    var url   = proto + '//' + window.location.host + '/~~stream';

    self._ws = new WebSocket(url);
    self._ws.binaryType = 'arraybuffer';

    self._ws.onopen = function () {
      self._connected = true;
      if (window.soundappletstarted) {
        window.soundappletstarted();
      }
    };

    self._ws.onmessage = function (event) {
      self._onMessage(event.data);
    };

    self._ws.onclose = function () {
      self._connected = false;
    };

    self._ws.onerror = function (e) {
      console.error('WebSDR audio WebSocket error', e);
    };
  };

  // ── Packet parsing ─────────────────────────────────────────────────────────

  UberSDRSound.prototype._onMessage = function (buf) {
    if (buf.byteLength < HEADER_SIZE + 1) {
      return;
    }

    var dv         = new DataView(buf);
    var sampleRate = dv.getUint32(8, true);
    var channels   = dv.getUint8(12);
    var bbPower    = dv.getFloat32(13, true);

    if (sampleRate < 8000 || sampleRate > 192000) { sampleRate = DEFAULT_SR; }
    if (channels < 1 || channels > 2)             { channels   = 1; }

    this._basebandPower = bbPower;

    var opusData = new Uint8Array(buf, HEADER_SIZE);

    this._ensureAudio(sampleRate);
    this._ensureDecoder(sampleRate, channels, opusData);
  };

  // ── Web Audio setup ────────────────────────────────────────────────────────

  UberSDRSound.prototype._ensureAudio = function (sampleRate) {
    var self = this;

    // Recreate AudioContext if sample rate changed
    if (self._audioCtx && self._audioSR !== sampleRate) {
      self._teardownAudio();
    }

    if (self._audioCtx) {
      if (self._audioCtx.state === 'suspended') {
        self._audioCtx.resume().catch(function () {});
      }
      return;
    }

    self._audioSR = sampleRate;

    try {
      self._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sampleRate });
    } catch (e) {
      self._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      self._audioSR  = self._audioCtx.sampleRate;
    }

    // Store in document.ct so the existing audio_start() button can call
    // document.ct.resume() to unlock the AudioContext on user gesture.
    document.ct = self._audioCtx;

    self._gainNode = self._audioCtx.createGain();
    self._gainNode.gain.value = self._muted ? 0.0 : self._volume;
    self._gainNode.connect(self._audioCtx.destination);

    self._nextPlayTime = self._audioCtx.currentTime;

    self._audioCtx.resume().catch(function () {});
  };

  UberSDRSound.prototype._teardownAudio = function () {
    if (this._gainNode) {
      try { this._gainNode.disconnect(); } catch (e) {}
      this._gainNode = null;
    }
    if (this._audioCtx) {
      if (document.ct === this._audioCtx) {
        document.ct = null;
      }
      try { this._audioCtx.close(); } catch (e) {}
      this._audioCtx = null;
    }
    this._audioSR      = 0;
    this._nextPlayTime = 0;
  };

  // ── Opus decoder (wasm-audio-decoders) ────────────────────────────────────

  UberSDRSound.prototype._ensureDecoder = function (sampleRate, channels, opusData) {
    var self = this;

    // If decoder already matches, decode immediately
    if (self._decoderReady &&
        self._decoderSR === sampleRate &&
        self._decoderCh === channels) {
      self._decodeFrame(opusData);
      return;
    }

    // Queue this packet while we (re)initialise
    self._pendingPackets.push({ data: opusData, sr: sampleRate, ch: channels });

    // If already initialising for the same config, just wait
    if (!self._decoderReady &&
        self._decoderSR === sampleRate &&
        self._decoderCh === channels) {
      return;
    }

    // Tear down old decoder and start fresh
    self._teardownDecoder();
    self._decoderSR = sampleRate;
    self._decoderCh = channels;

    _loadLib(function () {
      // Resolve OpusDecoder class (same lookup as main frontend)
      var OpusDecoderClass = null;
      if (typeof OpusDecoder !== 'undefined') {
        OpusDecoderClass = OpusDecoder;
      } else if (window['opus-decoder'] && window['opus-decoder'].OpusDecoder) {
        OpusDecoderClass = window['opus-decoder'].OpusDecoder;
      }

      if (!OpusDecoderClass) {
        console.error('WebSDR: OpusDecoder class not found after library load');
        return;
      }

      var dec;
      try {
        dec = new OpusDecoderClass({ sampleRate: sampleRate, channels: channels });
      } catch (e) {
        console.error('WebSDR: OpusDecoder constructor error:', e);
        return;
      }

      dec.ready.then(function () {
        // Check we haven't been destroyed or superseded
        if (self._decoderSR !== sampleRate || self._decoderCh !== channels) {
          try { dec.free(); } catch (e) {}
          return;
        }
        self._decoder      = dec;
        self._decoderReady = true;

        // Drain queued packets (only those matching current config)
        var pending = self._pendingPackets;
        self._pendingPackets = [];
        for (var i = 0; i < pending.length; i++) {
          var p = pending[i];
          if (p.sr === sampleRate && p.ch === channels) {
            self._decodeFrame(p.data);
          }
        }
      }).catch(function (e) {
        console.error('WebSDR: OpusDecoder.ready rejected:', e);
      });
    });
  };

  UberSDRSound.prototype._decodeFrame = function (opusData) {
    if (!this._decoder || !this._decoderReady) { return; }

    var decoded;
    try {
      decoded = this._decoder.decodeFrame(opusData);
    } catch (e) {
      console.error('WebSDR: decodeFrame error:', e);
      return;
    }

    if (!decoded || !decoded.channelData || decoded.channelData.length === 0) {
      return;
    }
    this._playDecoded(decoded);
  };

  UberSDRSound.prototype._teardownDecoder = function () {
    if (this._decoder) {
      try { this._decoder.free(); } catch (e) {}
      this._decoder = null;
    }
    this._decoderReady   = false;
    this._decoderSR      = 0;
    this._decoderCh      = 0;
    this._pendingPackets = [];
  };

  // ── Audio playback ─────────────────────────────────────────────────────────

  UberSDRSound.prototype._playDecoded = function (decoded) {
    var self = this;
    var ctx  = self._audioCtx;
    if (!ctx || ctx.state === 'closed') { return; }

    if (ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
      return; // drop this frame; next one will play after resume
    }

    var numFrames  = decoded.channelData[0].length;
    var numCh      = Math.max(2, decoded.channelData.length);
    var sampleRate = self._decoderSR;

    var buffer = ctx.createBuffer(numCh, numFrames, sampleRate);

    if (decoded.channelData.length === 1) {
      // Mono — duplicate to both channels
      buffer.getChannelData(0).set(decoded.channelData[0]);
      buffer.getChannelData(1).set(decoded.channelData[0]);
    } else {
      for (var ch = 0; ch < decoded.channelData.length && ch < 2; ch++) {
        buffer.getChannelData(ch).set(decoded.channelData[ch]);
      }
    }

    var source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(self._gainNode);

    var currentTime = ctx.currentTime;

    // Underrun: reset schedule
    if (self._nextPlayTime < currentTime) {
      self._nextPlayTime = currentTime + MIN_BUFFER_SEC;
    }
    // Overrun: drop packet to prevent lag accumulation
    else if ((self._nextPlayTime - currentTime) > MAX_BUFFER_SEC) {
      return;
    }

    source.start(self._nextPlayTime);
    self._nextPlayTime += buffer.duration;
  };

  // ── Public interface ───────────────────────────────────────────────────────

  // Send a /~~param command over the WebSocket (called by websdr-base.js).
  UberSDRSound.prototype.setparam = function (qs) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send('GET /~~param?' + qs);
    }
  };

  // Toggle mute.
  UberSDRSound.prototype.mute = function () {
    this._muted = !this._muted;
    if (this._gainNode) {
      this._gainNode.gain.value = this._muted ? 0.0 : this._volume;
    }
  };

  // Set volume (0.0–1.0 typical; websdr-base.js passes values in that range).
  UberSDRSound.prototype.setvolume = function (v) {
    this._volume = v;
    if (!this._muted && this._gainNode) {
      this._gainNode.gain.value = v;
    }
  };

  // Return S-meter value in the range expected by websdr-base.js updatesmeter():
  //   displayed_dBFS = s / 100.0 - 127
  // so we encode: s = (dbfs + 127) * 100
  // Range: 0 (= -127 dBFS) to 12700 (= 0 dBFS).
  // basebandPower is in dBFS (e.g. -80.0).
  UberSDRSound.prototype.smeter = function () {
    var dbfs = this._basebandPower;
    if (dbfs < -127) { dbfs = -127; }
    if (dbfs >    0) { dbfs =    0; }
    return Math.round((dbfs + 127.0) * 100.0);
  };

  // Return connection ID: 1 when connected, 0 otherwise.
  UberSDRSound.prototype.getid = function () {
    return this._connected ? 1 : 0;
  };

  // Tear down everything.
  UberSDRSound.prototype.destroy = function () {
    this._teardownDecoder();
    this._teardownAudio();
    if (this._ws) {
      this._ws.onopen    = null;
      this._ws.onmessage = null;
      this._ws.onclose   = null;
      this._ws.onerror   = null;
      try { this._ws.close(); } catch (e) {}
      this._ws = null;
    }
    this._connected = false;
    window.soundapplet = null;
  };

  // ── Entry point ────────────────────────────────────────────────────────────

  window.prep_html5sound = function () {
    if (window.soundapplet) {
      window.soundapplet.destroy();
    }
    window.soundapplet = new UberSDRSound();
  };

  // Auto-start (mirrors original websdr-sound.js behaviour).
  window.prep_html5sound();

}());
