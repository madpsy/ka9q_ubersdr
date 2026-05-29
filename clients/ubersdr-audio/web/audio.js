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

  let _volume   = 80;
  let _muted    = false;
  let _channel  = 'both';
  let _format   = 'opus';
  let _deviceId = '';
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
      r.checked   = (r.value === fmt);
      r.disabled  = disabled;
    }
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
