/**
 * agc.js — AGC hang time, recovery rate, and threshold sliders.
 *
 * The AGC row is only visible when the current mode is USB or LSB.
 * On connect and mode change the current values are fetched from the server
 * via GET /agc so sliders always reflect the server's state rather than
 * hardcoded defaults.
 *
 * Exports: AGC.init(), AGC.applySnapshot(agcObj), AGC.onModeChange(mode),
 *          AGC.fetchAndApply()
 */

const AGC = (() => {
  const hangSlider    = () => document.getElementById('agc-hang-slider');
  const hangLabel     = () => document.getElementById('agc-hang-label');
  const recovSlider   = () => document.getElementById('agc-recovery-slider');
  const recovLabel    = () => document.getElementById('agc-recovery-label');
  const threshSlider  = () => document.getElementById('agc-threshold-slider');
  const threshLabel   = () => document.getElementById('agc-threshold-label');
  const agcRow        = () => document.getElementById('agc-row');

  // Preset defaults — used only as fallback if the server fetch fails.
  const DEFAULT_HANG   = 1.1;
  const DEFAULT_RECOV  = 20.0;
  const DEFAULT_THRESH = -15.0;

  let _hangTime   = DEFAULT_HANG;
  let _recovRate  = DEFAULT_RECOV;
  let _threshold  = DEFAULT_THRESH;
  let _sendTimer  = null;

  function isSSBMode(mode) { return mode === 'usb' || mode === 'lsb'; }

  function updateVisibility(mode) {
    const row = agcRow();
    if (!row) return;
    row.style.display = isSSBMode(mode) ? '' : 'none';
  }

  function updateLabels() {
    const hl = hangLabel();
    const rl = recovLabel();
    const tl = threshLabel();
    if (hl) hl.textContent = `${_hangTime.toFixed(1)} s`;
    if (rl) rl.textContent = `${_recovRate.toFixed(0)} dB/s`;
    if (tl) tl.textContent = `${_threshold.toFixed(0)} dB`;
  }

  function scheduleSend() {
    if (_sendTimer) clearTimeout(_sendTimer);
    _sendTimer = setTimeout(sendAGC, 150);
  }

  async function sendAGC() {
    try {
      await API.putAGC({
        hang_time_s:        _hangTime,
        recovery_rate_db_s: _recovRate,
        threshold_db:       _threshold,
      });
    } catch (e) {
      // 409 = not in USB/LSB mode — silently ignore
      if (!e.message.includes('409') && !e.message.toLowerCase().includes('mode')) {
        console.warn('AGC error:', e.message);
      }
    }
  }

  /** Apply a snapshot object from the server (GET /agc or status message). */
  function applySnapshot(agc) {
    if (!agc) return;
    if (agc.hang_time_s        != null) _hangTime  = agc.hang_time_s;
    if (agc.recovery_rate_db_s != null) _recovRate = agc.recovery_rate_db_s;
    if (agc.threshold_db       != null) _threshold = agc.threshold_db;

    const hs = hangSlider();
    const rs = recovSlider();
    const ts = threshSlider();
    if (hs && document.activeElement !== hs) hs.value = _hangTime;
    if (rs && document.activeElement !== rs) rs.value = _recovRate;
    if (ts && document.activeElement !== ts) ts.value = _threshold;
    updateLabels();
  }

  /**
   * Fetch current AGC values from the server and apply them to the sliders.
   * Called on connect and when entering USB/LSB mode so sliders always reflect
   * the server's state rather than hardcoded defaults.
   */
  async function fetchAndApply() {
    try {
      const agc = await API.getAGC();
      applySnapshot(agc);
    } catch (e) {
      // Server not reachable or not in SSB mode — keep current values
      console.warn('AGC fetch failed:', e.message);
    }
  }

  function onModeChange(mode) {
    updateVisibility(mode);
    if (isSSBMode(mode)) {
      // Fetch current values from server instead of resetting to hardcoded defaults.
      // This ensures sliders reflect any values previously set by the user or
      // restored by the server after a preset reload.
      fetchAndApply();
    }
  }

  function init() {
    const hs = hangSlider();
    const rs = recovSlider();
    const ts = threshSlider();

    hs?.addEventListener('input', e => {
      _hangTime = parseFloat(e.target.value);
      updateLabels();
    });
    hs?.addEventListener('change', () => scheduleSend());
    hs?.addEventListener('touchend', () => scheduleSend());

    rs?.addEventListener('input', e => {
      _recovRate = parseFloat(e.target.value);
      updateLabels();
    });
    rs?.addEventListener('change', () => scheduleSend());
    rs?.addEventListener('touchend', () => scheduleSend());

    ts?.addEventListener('input', e => {
      _threshold = parseFloat(e.target.value);
      updateLabels();
    });
    ts?.addEventListener('change', () => scheduleSend());
    ts?.addEventListener('touchend', () => scheduleSend());

    updateLabels();
  }

  return { init, applySnapshot, onModeChange, fetchAndApply };
})();
