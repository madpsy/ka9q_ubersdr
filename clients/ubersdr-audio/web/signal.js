/**
 * signal.js — Signal quality meters driven by SSE stream.
 *
 * Subscribes to /api/v1/signal/stream and updates the three level bars
 * (Signal, SNR, Audio) in real time.  Falls back to polling /api/v1/signal
 * if SSE is not available.
 *
 * Also manages the SNR squelch slider overlaid on the SNR bar:
 *   - Slider range: 25–80 dB (matching the SNR bar scale).
 *   - max+1 (81) = disabled sentinel (-999 sent to API).
 *   - Default: far right (81 = disabled).
 *   - In IQ mode: slider hidden/disabled, gate reset to -999.
 *
 * Exports: Signal.init(), Signal.applySnapshot(signalObj), Signal.setNoData(),
 *          Signal.onModeChange(mode)
 */

const Signal = (() => {
  // Meter configuration: { barId, valueId, min, max }
  const METERS = {
    signal: { barId: 'signal-bar', valueId: 'signal-value', min: -120, max: -50 },
    snr:    { barId: 'snr-bar',    valueId: 'snr-value',    min: 25,   max: 80  },
    audio:  { barId: 'audio-bar',  valueId: 'audio-value',  min: -60,  max: 0   },
  };

  // Squelch slider constants — must match the HTML min/max/step attributes.
  // Far LEFT (min) = off; sliding right increases the threshold.
  const SQUELCH_MIN      = 24;   // slider value meaning "disabled" (far left)
  const SQUELCH_MAX      = 80;   // dB — matches SNR bar max
  const SQUELCH_OFF_VAL  = 24;   // slider value meaning "disabled"
  const SQUELCH_SENTINEL = -999; // value sent to API when disabled

  const NO_DATA = -999;
  let _es = null;          // EventSource
  let _pollTimer = null;   // fallback poll interval
  let _sendTimer = null;   // debounce timer for gate API calls
  let _currentSNR = NO_DATA; // last known SNR value

  // ── DOM helpers ────────────────────────────────────────────────────────────
  const squelchSlider = () => document.getElementById('snr-squelch-slider');
  const squelchHint   = () => document.getElementById('snr-squelch-hint');

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

  // ── Squelch slider helpers ─────────────────────────────────────────────────

  /** Convert slider position to the dB threshold (or SQUELCH_SENTINEL if off). */
  function sliderToThreshold(sliderVal) {
    const v = parseFloat(sliderVal);
    if (v <= SQUELCH_OFF_VAL) return SQUELCH_SENTINEL; // far left = off
    return v;
  }

  /** Convert a dB threshold (or sentinel) to a slider position. */
  function thresholdToSlider(threshold) {
    if (threshold <= SQUELCH_SENTINEL + 1) return SQUELCH_OFF_VAL; // disabled → far left
    return Math.max(SQUELCH_OFF_VAL + 1, Math.min(SQUELCH_MAX, threshold));
  }

  /** Update the hint text below the SNR row. */
  function updateHint(threshold) {
    const hint = squelchHint();
    if (!hint) return;
    if (threshold <= SQUELCH_SENTINEL + 1) {
      hint.textContent = 'Squelch off';
      hint.classList.remove('active');
    } else {
      hint.textContent = `Squelch: ≥ ${threshold.toFixed(1)} dB SNR`;
      hint.classList.add('active');
    }
  }

  /** Send the gate threshold to the API (debounced 50 ms). */
  function scheduleGateSend(threshold) {
    if (_sendTimer) clearTimeout(_sendTimer);
    _sendTimer = setTimeout(async () => {
      try {
        await API.putAudioGate(threshold);
      } catch (e) {
        console.warn('Audio gate error:', e.message);
      }
    }, 50);
  }

  /** Apply a full signal snapshot object from the API. */
  function applySnapshot(sig) {
    if (!sig) { setNoData(); return; }
    updateMeter('signal', sig.baseband_dbfs ?? NO_DATA);
    updateMeter('snr',    sig.snr_db        ?? NO_DATA);
    _currentSNR = sig.snr_db ?? NO_DATA;

    // If the SNR gate is active and SNR is below the threshold, the gate is
    // suppressing audio — show no-data on the audio bar rather than the stale
    // last-played value.
    const sl = squelchSlider();
    const threshold = sl ? sliderToThreshold(sl.value) : SQUELCH_SENTINEL;
    if (threshold > SQUELCH_SENTINEL && _currentSNR > NO_DATA && _currentSNR < threshold) {
      updateMeter('audio', NO_DATA);
    } else {
      updateMeter('audio', sig.audio_dbfs ?? NO_DATA);
    }
  }

  /** Clear all meters to the no-data state. */
  function setNoData() {
    updateMeter('signal', NO_DATA);
    updateMeter('snr',    NO_DATA);
    updateMeter('audio',  NO_DATA);
    _currentSNR = NO_DATA;
  }

  /**
   * Called by Tune.onModeChange (via app.js) when the mode changes.
   * In IQ modes the gate is meaningless — disable the slider and reset to off.
   */
  function onModeChange(mode) {
    const sl = squelchSlider();
    if (!sl) return;
    const iq = (mode || '').startsWith('iq');
    if (iq) {
      sl.disabled = true;
      sl.value = SQUELCH_OFF_VAL;
      updateHint(SQUELCH_SENTINEL);
      // Reset gate on server side too.
      scheduleGateSend(SQUELCH_SENTINEL);
    } else {
      sl.disabled = false;
    }
  }

  // ── SSE / polling ──────────────────────────────────────────────────────────

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

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    startSSE();

    // Load current gate value from API and set slider position.
    API.getAudioGate().then(data => {
      const sl = squelchSlider();
      if (!sl || data == null) return;
      const threshold = data.min_snr ?? SQUELCH_SENTINEL;
      sl.value = thresholdToSlider(threshold);
      updateHint(threshold);
    }).catch(() => { /* ignore — default is off */ });

    // Wire up the squelch slider.
    const sl = squelchSlider();
    if (sl) {
      // Live update of hint while dragging (no API call yet).
      sl.addEventListener('input', () => {
        const threshold = sliderToThreshold(sl.value);
        updateHint(threshold);
      });

      // Send to API on release (debounced).
      sl.addEventListener('change', () => {
        const threshold = sliderToThreshold(sl.value);
        updateHint(threshold);
        scheduleGateSend(threshold);
      });

      // Touch devices: also fire on touchend.
      sl.addEventListener('touchend', () => {
        const threshold = sliderToThreshold(sl.value);
        updateHint(threshold);
        scheduleGateSend(threshold);
      });
    }
  }

  return { init, applySnapshot, setNoData, stop, startSSE, onModeChange };
})();
