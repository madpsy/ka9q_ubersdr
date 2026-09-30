/**
 * audio.js — Volume, mute, channel routing, format, and audio device selector.
 *
 * Exports: Audio.init(), Audio.applySnapshot(audioObj), Audio.onModeChange(mode)
 */

const Audio = (() => {
  const volumeSlider    = () => document.getElementById('volume-slider');
  const muteBtn         = () => document.getElementById('mute-btn');
  const channelSelect   = () => document.getElementById('channel-select');
  const formatGroup     = () => document.querySelectorAll('input[name="format"]');
  const deviceSelect    = () => document.getElementById('device-select');
  const refreshDevBtn   = () => document.getElementById('refresh-devices-btn');
  const warningEl       = () => document.getElementById('audio-warning');
  const marginRow       = () => document.getElementById('margin-row');
  const marginSlider    = () => document.getElementById('margin-slider');
  const marginValue     = () => document.getElementById('margin-value');

  // Reduced-depth IQ margin, as in the v2 UI and the server's pcm_lossy.go:
  // 10-60 dB, and the slider's top stop, one past 60, means lossless (0). IQ
  // starts at 15 dB until the operator moves it, as in v2.
  const MARGIN_MIN = 10;
  const MARGIN_START = 15;
  const MARGIN_MAX = 60;
  const MARGIN_LOSSLESS = MARGIN_MAX + 1;

  let _volume   = 80;
  let _muted    = false;
  let _channel  = 'both';
  let _format   = 'opus';
  let _deviceId = '';
  let _margin   = MARGIN_START;
  let _marginDragging = false;
  let _premuteVol = 80;
  let _sendTimer  = null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function isIQMode(mode) { return (mode || '').startsWith('iq'); }

  function getSelectedFormat() {
    for (const r of formatGroup()) {
      if (r.checked) return r.value;
    }
    return 'opus';
  }

  function setFormatUI(fmt, disabled) {
    for (const r of formatGroup()) {
      r.checked  = (r.value === fmt);
      r.disabled = disabled;
      // Toggle .disabled on the parent label for CSS styling fallback
      // (browsers that don't support :has() will use this class).
      const lbl = r.closest('.radio-label');
      if (lbl) lbl.classList.toggle('disabled', disabled);
    }
  }

  function marginFromSlider(v) {
    v = Number(v);
    return v >= MARGIN_LOSSLESS ? 0 : Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, Math.round(v)));
  }
  function marginText(m) { return m > 0 ? `${m} dB` : 'Lossless'; }

  function updateMarginUI() {
    const sl = marginSlider();
    if (sl && !_marginDragging) sl.value = _margin > 0 ? _margin : MARGIN_LOSSLESS;
    const lbl = marginValue();
    if (lbl) lbl.textContent = marginText(_margin);
  }

  function updateMuteUI() {
    const btn = muteBtn();
    if (!btn) return;
    btn.textContent = _muted ? '🔇' : '🔊';
    const sl = volumeSlider();
    if (sl) sl.disabled = _muted;
  }

  // ── Send helpers ──────────────────────────────────────────────────────────
  function scheduleSend(body) {
    if (_sendTimer) clearTimeout(_sendTimer);
    _sendTimer = setTimeout(() => sendAudio(body), 120);
  }

  async function sendAudio(body) {
    try {
      const result = await API.putAudio(body);
      if (result) applySnapshot(result, true);
    } catch (e) {
      console.warn('Audio error:', e.message);
    }
  }

  // ── Apply snapshot ────────────────────────────────────────────────────────
  function applySnapshot(audio, fromServer = false) {
    if (!audio) return;

    if (audio.volume   != null) _volume   = audio.volume;
    if (audio.muted    != null) _muted    = audio.muted;
    if (audio.channel  != null) _channel  = audio.channel;
    if (audio.format   != null) _format   = audio.format;
    if (audio.device_id != null) _deviceId = audio.device_id;
    if (audio.min_margin != null) { _margin = audio.min_margin; updateMarginUI(); }

    // What the output is losing, e.g. a wide IQ mode resampled to 48 kHz by
    // the sound server. Absent from older servers: leave it hidden.
    const w = warningEl();
    if (w && audio.warning !== undefined) {
      w.textContent = audio.warning || '';
      w.hidden = !audio.warning;
    }

    const sl = volumeSlider();
    if (sl && document.activeElement !== sl) sl.value = _volume;

    updateMuteUI();

    const cs = channelSelect();
    if (cs) cs.value = _channel;

    setFormatUI(_format, false);

    // Sync device selector
    const ds = deviceSelect();
    if (ds && _deviceId !== undefined) {
      for (const opt of ds.options) {
        if (opt.value === _deviceId) { ds.value = _deviceId; break; }
      }
    }

  }

  // ── Mode change (IQ constraints) ──────────────────────────────────────────
  function onModeChange(mode) {
    const iq = isIQMode(mode);
    const cs = channelSelect();
    const ds = deviceSelect();

    // Only IQ is ever reduced; everything else is sent whole, so the control
    // is not shown at all outside IQ.
    const mr = marginRow();
    if (mr) mr.hidden = !iq;

    if (iq) {
      // IQ requires uncompressed + both channels
      setFormatUI('pcm-zstd', true);
      if (cs) { cs.value = 'both'; cs.disabled = true; }
    } else {
      setFormatUI(_format, false);
      if (cs) { cs.disabled = false; }
    }
  }

  // ── Populate device list ──────────────────────────────────────────────────
  async function populateDevices() {
    try {
      const data = await API.getAudioDevices();
      const ds = deviceSelect();
      if (!ds || !data?.devices) return;

      const prev = ds.value;
      ds.innerHTML = '';
      for (const dev of data.devices) {
        const opt = document.createElement('option');
        opt.value       = dev.id;
        opt.textContent = dev.name;
        ds.appendChild(opt);
      }
      // Restore selection
      ds.value = prev;
      if (!ds.value && data.devices.length > 0) ds.value = data.devices[0].id;
      _deviceId = ds.value;
    } catch (e) {
      console.warn('Device list error:', e.message);
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // Volume slider
    volumeSlider()?.addEventListener('input', e => {
      _volume = parseFloat(e.target.value);
      if (!_muted) _premuteVol = _volume;
    });
    volumeSlider()?.addEventListener('change', e => {
      _volume = parseFloat(e.target.value);
      if (!_muted) _premuteVol = _volume;
      scheduleSend({ volume: _volume });
    });
    volumeSlider()?.addEventListener('touchend', () => {
      scheduleSend({ volume: _volume });
    });

    // Mute button
    muteBtn()?.addEventListener('click', () => {
      _muted = !_muted;
      if (_muted) {
        _premuteVol = _volume;
      } else {
        _volume = _premuteVol;
        const sl = volumeSlider();
        if (sl) sl.value = _volume;
      }
      updateMuteUI();
      sendAudio({ muted: _muted });
    });

    // Channel select
    channelSelect()?.addEventListener('change', e => {
      _channel = e.target.value;
      sendAudio({ channel: _channel });
    });

    // Format radio group
    for (const r of formatGroup()) {
      r.addEventListener('change', async e => {
        if (!e.target.checked) return;
        const newFmt = e.target.value;

        if (newFmt === 'pcm-zstd') {
          // Warn about bandwidth
          const ok = await App.confirm(
            'High Bandwidth Warning',
            'Uncompressed audio uses approximately 4× more bandwidth than Compressed.\n\nThis increases costs for the instance owner. Only switch if you have a specific reason to do so.'
          );
          if (!ok) {
            // Revert
            setFormatUI(_format, false);
            return;
          }
        }

        _format = newFmt;
        sendAudio({ format: _format });
      });
    }

    // IQ margin: the label follows the drag, the value is sent on release.
    // The server applies it to the next packet with no reconnect.
    const ms = marginSlider();
    if (ms) {
      ms.addEventListener('input', e => {
        _marginDragging = true;
        const lbl = marginValue();
        if (lbl) lbl.textContent = marginText(marginFromSlider(e.target.value));
      });
      ms.addEventListener('change', e => {
        _marginDragging = false;
        _margin = marginFromSlider(e.target.value);
        updateMarginUI();
        sendAudio({ min_margin: _margin });
      });
    }

    // Device select
    deviceSelect()?.addEventListener('change', e => {
      _deviceId = e.target.value;
      sendAudio({ device_id: _deviceId });
    });

    // Refresh devices button
    refreshDevBtn()?.addEventListener('click', populateDevices);

    // Initial device population
    populateDevices();
  }

  return { init, applySnapshot, onModeChange, populateDevices };
})();
