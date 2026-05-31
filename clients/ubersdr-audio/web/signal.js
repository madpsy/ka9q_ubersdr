/**
 * signal.js — Signal quality meters driven by SSE stream.
 *
 * Subscribes to /api/v1/signal/stream and updates the three level bars
 * (Signal, SNR, Audio) in real time.  Falls back to polling /api/v1/signal
 * if SSE is not available.
 *
 * Exports: Signal.init(), Signal.applySnapshot(signalObj), Signal.setNoData()
 */

const Signal = (() => {
  // Meter configuration: { barId, valueId, min, max }
  const METERS = {
    signal: { barId: 'signal-bar', valueId: 'signal-value', min: -120, max: -50 },
    snr:    { barId: 'snr-bar',    valueId: 'snr-value',    min: 25,   max: 80  },
    audio:  { barId: 'audio-bar',  valueId: 'audio-value',  min: -60,  max: 0   },
  };

  const NO_DATA = -999;
  let _es = null;          // EventSource
  let _pollTimer = null;   // fallback poll interval

  /** Map a value in [min,max] to a 0–1 fraction, clamped. */
  function toFrac(val, min, max) {
    return Math.max(0, Math.min(1, (val - min) / (max - min)));
  }

  /**
   * Compute bar fill colour matching the Fyne barColour() function:
   * frac 0→0.5: red(220,0,0) → yellow(220,200,0)
   * frac 0.5→1: yellow(220,200,0) → green(0,200,0)
   */
  function barColour(frac) {
    let r, g;
    if (frac < 0.5) {
      r = 220;
      g = Math.round(frac * 2 * 200);
    } else {
      g = 200;
      r = Math.round((1 - (frac - 0.5) * 2) * 220);
    }
    return `rgb(${r},${g},0)`;
  }

  /** Update a single meter bar and value label. */
  function updateMeter(key, val) {
    const cfg = METERS[key];
    const bar = document.getElementById(cfg.barId);
    const lbl = document.getElementById(cfg.valueId);
    if (!bar || !lbl) return;

    if (val <= NO_DATA + 1) {
      bar.style.width = '0%';
      bar.style.backgroundColor = '';
      lbl.textContent = '—';
      lbl.style.color = '';
    } else {
      const frac = toFrac(val, cfg.min, cfg.max);
      bar.style.width = (frac * 100) + '%';
      bar.style.backgroundColor = barColour(frac);
      lbl.textContent = val.toFixed(1);
      lbl.style.color = '';
    }
  }

  /** Apply a full signal snapshot object from the API. */
  function applySnapshot(sig) {
    if (!sig) { setNoData(); return; }
    updateMeter('signal', sig.baseband_dbfs   ?? NO_DATA);
    updateMeter('snr',    sig.snr_db          ?? NO_DATA);
    updateMeter('audio',  sig.audio_dbfs      ?? NO_DATA);
  }

  /** Clear all meters to the no-data state. */
  function setNoData() {
    updateMeter('signal', NO_DATA);
    updateMeter('snr',    NO_DATA);
    updateMeter('audio',  NO_DATA);
  }

  /** Start the SSE stream.  Reconnects automatically on error. */
  function startSSE() {
    if (_es) { _es.close(); _es = null; }
    stopPoll();

    try {
      _es = API.signalStream();
    } catch (e) {
      startPoll();
      return;
    }

    _es.onmessage = (e) => {
      try {
        const sig = JSON.parse(e.data);
        applySnapshot(sig);
      } catch { /* ignore parse errors */ }
    };

    _es.onerror = () => {
      // Browser will auto-reconnect; we just clear the meters briefly.
      // If SSE keeps failing, fall back to polling.
      if (_es && _es.readyState === EventSource.CLOSED) {
        _es = null;
        startPoll();
      }
    };
  }

  /** Fallback: poll /signal every 500 ms. */
  function startPoll() {
    stopPoll();
    _pollTimer = setInterval(async () => {
      try {
        const sig = await API.getSignal();
        applySnapshot(sig);
      } catch { setNoData(); }
    }, 500);
  }

  function stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  /** Stop all signal updates (called on disconnect). */
  function stop() {
    if (_es) { _es.close(); _es = null; }
    stopPoll();
    setNoData();
  }

  function init() {
    startSSE();
  }

  return { init, applySnapshot, setNoData, stop, startSSE };
})();
