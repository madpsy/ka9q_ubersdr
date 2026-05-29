/**
 * agc.js — AGC hang time and recovery rate sliders.
 *
 * The AGC row is only visible when the current mode is USB or LSB.
 * Exports: AGC.init(), AGC.applySnapshot(agcObj), AGC.onModeChange(mode)
 */

const AGC = (() => {
  const hangSlider    = () => document.getElementById('agc-hang-slider');
  const hangLabel     = () => document.getElementById('agc-hang-label');
  const recovSlider   = () => document.getElementById('agc-recovery-slider');
  const recovLabel    = () => document.getElementById('agc-recovery-label');
  const agcRow        = () => document.getElementById('agc-row');

  const DEFAULT_HANG  = 1.1;
  const DEFAULT_RECOV = 20.0;

  let _hangTime  = DEFAULT_HANG;
  let _recovRate = DEFAULT_RECOV;
  let _sendTimer = null;

  function isSSBMode(mode) { return mode === 'usb' || mode === 'lsb'; }

  function updateVisibility(mode) {
    const row = agcRow();
    if (!row) return;
    row.style.display = isSSBMode(mode) ? '' : 'none';
  }

  function updateLabels() {
    const hl = hangLabel();
    const rl = recovLabel();
    if (hl) hl.textContent = `${_hangTime.toFixed(1)} s`;
    if (rl) rl.textContent = `${_recovRate.toFixed(0)} dB/s`;
  }

  function scheduleSend() {
    if (_sendTimer) clearTimeout(_sendTimer);
    _sendTimer = setTimeout(sendAGC, 150);
  }

  async function sendAGC() {
    try {
      await API.putAGC({
        hang_time_s:          _hangTime,
        recovery_rate_db_s:   _recovRate,
      });
    } catch (e) {
      // 409 = not in USB/LSB mode — silently ignore
      if (!e.message.includes('409') && !e.message.toLowerCase().includes('mode')) {
        console.warn('AGC error:', e.message);
      }
    }
  }

  function applySnapshot(agc) {
    if (!agc) return;
    if (agc.hang_time_s          != null) _hangTime  = agc.hang_time_s;
    if (agc.recovery_rate_db_s   != null) _recovRate = agc.recovery_rate_db_s;

    const hs = hangSlider();
    const rs = recovSlider();
    if (hs && document.activeElement !== hs) hs.value = _hangTime;
    if (rs && document.activeElement !== rs) rs.value = _recovRate;
    updateLabels();
  }

  function onModeChange(mode) {
    updateVisibility(mode);
    if (isSSBMode(mode)) {
      // Reset to defaults when entering SSB mode
      _hangTime  = DEFAULT_HANG;
      _recovRate = DEFAULT_RECOV;
      const hs = hangSlider();
      const rs = recovSlider();
      if (hs) hs.value = _hangTime;
      if (rs) rs.value = _recovRate;
      updateLabels();
    }
  }

  function init() {
    const hs = hangSlider();
    const rs = recovSlider();

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

    updateLabels();
  }

  return { init, applySnapshot, onModeChange };
})();
