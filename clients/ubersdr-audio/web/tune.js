/**
 * tune.js — Frequency, mode, bandwidth and step controls.
 *
 * Exports: Tune.init(), Tune.applySnapshot(tuneObj), Tune.isIQMode(),
 *          Tune.currentMode(), Tune.currentFreqHz()
 */

const Tune = (() => {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const freqEntry    = () => document.getElementById('freq-entry');
  const freqApplyBtn = () => document.getElementById('freq-apply-btn');
  const freqDownBtn  = () => document.getElementById('freq-down-btn');
  const freqUpBtn    = () => document.getElementById('freq-up-btn');
  const stepSelect   = () => document.getElementById('step-select');
  const modeSelect   = () => document.getElementById('mode-select');
  const bwSlider     = () => document.getElementById('bw-slider');
  const bwValueLabel = () => document.getElementById('bw-value-label');

  // ── Constants ─────────────────────────────────────────────────────────────
  const FREQ_MIN_HZ = 10_000;
  const FREQ_MAX_HZ = 30_000_000;

  const BASE_MODES = ['usb','lsb','am','sam','fm','cwu','cwl','iq'];
  const WIDE_IQ    = ['iq48','iq96','iq192','iq384'];

  // ── State ─────────────────────────────────────────────────────────────────
  let _freqHz       = 14_200_000;
  let _mode         = 'usb';
  let _bwHz         = 2700;
  let _stepHz       = 1000;
  let _sending      = false;   // debounce guard for slider
  let _bwTimer      = null;
  let _suppressUntil = 0;      // epoch ms — ignore poll-driven applySnapshot until this time

  // ── Helpers ───────────────────────────────────────────────────────────────
  function isIQMode(m)     { return (m || _mode).startsWith('iq'); }
  function isWideIQ(m)     { return WIDE_IQ.includes(m || _mode); }
  function isSSBMode(m)    { return ['usb','lsb'].includes(m || _mode); }

  function bwSliderMax(mode) {
    if (['am','sam','fm'].includes(mode)) return 6000;
    if (mode === 'iq') return 12000;
    return 5000;
  }

  function bwDefault(mode) {
    switch (mode) {
      case 'usb': case 'lsb': return 2700;
      case 'cwu': case 'cwl': return 600;
      case 'am':  case 'sam': return 4000;
      case 'fm':              return 5000;
      case 'iq':              return 12000;
      default:                return 2700;
    }
  }

  function clampFreq(hz) {
    return Math.max(FREQ_MIN_HZ, Math.min(FREQ_MAX_HZ, Math.round(hz)));
  }

  function formatFreqKHz(hz) {
    return (hz / 1000).toFixed(3);
  }

  function parseFreqKHz(s) {
    const f = parseFloat(s);
    if (isNaN(f)) return null;
    return Math.round(f * 1000);
  }

  function getStep() {
    return parseInt(stepSelect()?.value || '1000', 10);
  }

  // ── Send tune to API ──────────────────────────────────────────────────────
  async function sendTune(overrides = {}) {
    const body = {
      frequency_hz: _freqHz,
      mode:         _mode,
      bandwidth_hz: isWideIQ(_mode) ? undefined : _bwHz,
      step_hz:      _stepHz,
      ...overrides,
    };
    // Remove undefined keys
    Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

    try {
      const result = await API.putTune(body);
      if (result) applySnapshot(result, true);
    } catch (e) {
      console.warn('Tune error:', e.message);
    }
  }

  // ── Apply snapshot from status/tune response ──────────────────────────────
  function applySnapshot(tune, fromServer = false) {
    if (!tune) return;
    // If a bookmark (or other direct tune) recently fired, ignore poll-driven
    // snapshots for a short window so the UI doesn't revert.
    if (!fromServer && Date.now() < _suppressUntil) return;

    const newMode = tune.mode || _mode;
    const newFreq = tune.frequency_hz ?? _freqHz;
    const newBW   = tune.bandwidth_hz ?? _bwHz;
    const newStep = tune.step_hz ?? _stepHz;

    _freqHz = newFreq;
    _mode   = newMode;
    _bwHz   = newBW;
    _stepHz = newStep;

    // Update frequency display
    const fe = freqEntry();
    if (fe && document.activeElement !== fe) {
      fe.value = formatFreqKHz(_freqHz);
    }

    // Update mode select — rebuild options if wide IQ modes changed
    const ms = modeSelect();
    if (ms) {
      const allowedIQ = tune.allowed_iq_modes || [];
      rebuildModeOptions(ms, allowedIQ);
      if (ms.value !== _mode) ms.value = _mode;
    }

    // Update BW slider
    const sl = bwSlider();
    if (sl) {
      const max = bwSliderMax(_mode);
      sl.max = max;
      if (document.activeElement !== sl) {
        sl.value = isWideIQ(_mode) ? max : Math.min(_bwHz, max);
      }
      sl.disabled = isWideIQ(_mode);
    }
    updateBWLabel();

    // Update step
    const ss = stepSelect();
    if (ss && ss.value !== String(_stepHz)) ss.value = String(_stepHz);

    // Notify AGC about mode change
    if (typeof AGC !== 'undefined') AGC.onModeChange(_mode);
    // Notify Audio about IQ mode constraint
    if (typeof Audio !== 'undefined') Audio.onModeChange(_mode);
    // Notify DSP
    if (typeof DSP !== 'undefined') DSP.onModeChange(_mode);
    // Notify Record — Opus is disabled in IQ modes
    if (typeof Record !== 'undefined') Record.onModeChange(_mode);
  }

  function updateBWLabel() {
    const lbl = bwValueLabel();
    if (!lbl) return;
    if (isWideIQ(_mode)) {
      lbl.textContent = 'server preset';
    } else {
      lbl.textContent = `${_bwHz} Hz`;
    }
  }

  // ── Rebuild mode <select> options ─────────────────────────────────────────
  function rebuildModeOptions(ms, allowedWideIQ) {
    const current = ms.value || _mode;
    const permitted = new Set((allowedWideIQ || []).map(m => m.toLowerCase()));

    // Build option list
    const opts = [...BASE_MODES];
    for (const m of WIDE_IQ) {
      if (permitted.has(m)) opts.push(m);
    }

    // Only rebuild if the option set changed
    const existing = Array.from(ms.options).map(o => o.value);
    const same = existing.length === opts.length && opts.every((o, i) => o === existing[i]);
    if (same) return;

    ms.innerHTML = '';
    for (const m of opts) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m.toUpperCase();
      ms.appendChild(opt);
    }

    // Restore selection (fall back to usb if mode no longer available)
    ms.value = opts.includes(current) ? current : 'usb';
    if (ms.value !== current) _mode = ms.value;
  }

  // ── Apply frequency from entry field ─────────────────────────────────────
  function applyFreqEntry() {
    const hz = parseFreqKHz(freqEntry()?.value);
    if (hz === null) {
      freqEntry().value = formatFreqKHz(_freqHz);
      return;
    }
    _freqHz = clampFreq(hz);
    freqEntry().value = formatFreqKHz(_freqHz);
    sendTune();
  }

  function applyFreqDelta(delta) {
    const cur = parseFreqKHz(freqEntry()?.value) ?? _freqHz;
    _freqHz = clampFreq(cur + delta);
    freqEntry().value = formatFreqKHz(_freqHz);
    sendTune();
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // Frequency apply button
    freqApplyBtn()?.addEventListener('click', applyFreqEntry);

    // Enter key on frequency field
    freqEntry()?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); applyFreqEntry(); }
    });

    // Step buttons
    freqDownBtn()?.addEventListener('click', () => applyFreqDelta(-getStep()));
    freqUpBtn()?.addEventListener('click',   () => applyFreqDelta(+getStep()));

    // Step select — persist and update internal state
    stepSelect()?.addEventListener('change', e => {
      _stepHz = parseInt(e.target.value, 10);
    });

    // Mode select
    modeSelect()?.addEventListener('change', e => {
      const prev = _mode;
      _mode = e.target.value;

      // Update BW slider range and default
      const sl = bwSlider();
      if (sl) {
        const max = bwSliderMax(_mode);
        sl.max = max;
        if (!isWideIQ(_mode)) {
          _bwHz = bwDefault(_mode);
          sl.value = _bwHz;
        }
        sl.disabled = isWideIQ(_mode);
      }
      updateBWLabel();

      // Notify other modules
      if (typeof AGC !== 'undefined') AGC.onModeChange(_mode);
      if (typeof Audio !== 'undefined') Audio.onModeChange(_mode);
      if (typeof DSP !== 'undefined') DSP.onModeChange(_mode);
      if (typeof Record !== 'undefined') Record.onModeChange(_mode);

      sendTune();
    });

    // Bandwidth slider — debounce sends
    bwSlider()?.addEventListener('input', e => {
      _bwHz = parseInt(e.target.value, 10);
      updateBWLabel();
    });

    bwSlider()?.addEventListener('change', e => {
      _bwHz = parseInt(e.target.value, 10);
      updateBWLabel();
      sendTune();
    });

    // Touch: also fire on touchend for mobile sliders
    bwSlider()?.addEventListener('touchend', () => {
      _bwHz = parseInt(bwSlider().value, 10);
      updateBWLabel();
      sendTune();
    });
  }

  return {
    init,
    applySnapshot,
    /** Suppress poll-driven applySnapshot calls until the given epoch ms. */
    suppressPollUntil: (until) => { _suppressUntil = until; },
    isIQMode:       () => isIQMode(_mode),
    isWideIQ:       () => isWideIQ(_mode),
    isSSBMode:      () => isSSBMode(_mode),
    currentMode:    () => _mode,
    currentFreqHz:  () => _freqHz,
    formatFreqKHz,
  };
})();
