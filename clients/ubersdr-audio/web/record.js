/**
 * record.js — Recording card module.
 *
 * Manages the "Recording" card in the web UI.  State is driven by the
 * /api/v1/status poll (s.record) via Record.applySnapshot(), with immediate
 * optimistic UI updates on button press.
 *
 * API shape (from recordStatusJSON in api_handlers_record.go):
 *   state:             "idle" | "recording" | "ready"
 *   format:            "pcm" | "opus"
 *   max_duration_secs: number
 *   filename:          string   (when state != "idle")
 *   size_bytes:        number   (when state != "idle")
 *   started_at:        string   (ISO-8601, when state != "idle")
 *   elapsed_secs:      number   (when state != "idle")
 *   remaining_secs:    number   (when state == "recording")
 *   stopped_at:        string   (when state == "ready")
 *   auto_stopped:      bool     (when state == "ready")
 *   duration_secs:     number   (when state == "ready")
 */

const Record = (() => {
  // ── DOM refs (populated in init()) ────────────────────────────────────────
  let _formatPCM    = null; // <input type="radio" value="pcm">
  let _formatOpus   = null; // <input type="radio" value="opus">
  let _startBtn     = null;
  let _stopBtn      = null;
  let _statusText   = null;
  let _timerText    = null;
  let _downloadBtn  = null;
  let _deleteBtn    = null;
  let _readyRow     = null;
  let _filenameText = null;
  let _sizeText     = null;

  // ── Local state ───────────────────────────────────────────────────────────
  let _state = 'idle'; // mirrors server state
  let _timerInterval = null;
  let _elapsedSecs = 0;
  let _maxSecs = 3600;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function fmtDuration(secs) {
    const s = Math.floor(secs);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtBytes(bytes) {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000)     return `${(bytes / 1_000).toFixed(0)} kB`;
    return `${bytes} B`;
  }

  function startLocalTimer(startElapsed, max) {
    stopLocalTimer();
    _elapsedSecs = startElapsed;
    _maxSecs = max;
    _timerInterval = setInterval(() => {
      _elapsedSecs += 1;
      updateTimerDisplay();
    }, 1000);
    updateTimerDisplay();
  }

  function stopLocalTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  }

  function updateTimerDisplay() {
    if (!_timerText) return;
    const remaining = Math.max(0, _maxSecs - _elapsedSecs);
    _timerText.textContent = `${fmtDuration(_elapsedSecs)} / −${fmtDuration(remaining)}`;
  }

  let _iqMode = false; // true when an IQ mode is active

  function setRecordingUI(recording) {
    if (_startBtn)   _startBtn.disabled  = recording;
    if (_stopBtn)    _stopBtn.disabled   = !recording;
    if (_formatPCM)  _formatPCM.disabled = recording;
    // Opus is disabled both while recording AND when IQ mode is active.
    if (_formatOpus) _formatOpus.disabled = recording || _iqMode;
    if (_timerText)  _timerText.style.display = recording ? '' : 'none';
    if (!recording)  stopLocalTimer();
  }

  function setReadyUI(ready) {
    if (_readyRow) _readyRow.style.display = ready ? '' : 'none';
  }

  // ── applySnapshot — called every poll tick ─────────────────────────────────
  function applySnapshot(rec) {
    if (!rec) return;

    const newState = rec.state || 'idle';
    const changed  = newState !== _state;
    _state = newState;
    _maxSecs = rec.max_duration_secs || 3600;

    switch (_state) {
      case 'recording':
        setRecordingUI(true);
        setReadyUI(false);
        if (_statusText) _statusText.textContent = 'Recording…';
        // Sync local timer to server elapsed (handles page reload mid-recording).
        if (changed || _timerInterval === null) {
          startLocalTimer(rec.elapsed_secs || 0, _maxSecs);
        }
        break;

      case 'ready':
        setRecordingUI(false);
        setReadyUI(true);
        stopLocalTimer();
        if (_statusText) {
          const dur = rec.duration_secs ? ` (${fmtDuration(rec.duration_secs)})` : '';
          const auto = rec.auto_stopped ? ' — auto-stopped' : '';
          _statusText.textContent = `Ready for download${dur}${auto}`;
        }
        if (_timerText) _timerText.style.display = 'none';
        if (_filenameText) _filenameText.textContent = rec.filename || '';
        if (_sizeText)     _sizeText.textContent     = rec.size_bytes ? fmtBytes(rec.size_bytes) : '';
        break;

      default: // idle
        setRecordingUI(false);
        setReadyUI(false);
        stopLocalTimer();
        if (_statusText) _statusText.textContent = 'Idle';
        if (_timerText)  _timerText.style.display = 'none';
        break;
    }
  }

  // ── Button handlers ───────────────────────────────────────────────────────
  async function onStart() {
    const format = _formatOpus?.checked ? 'opus' : 'pcm';
    _startBtn.disabled = true;
    try {
      await API.startRecord(format);
      // Optimistic UI — server will confirm on next poll
      _state = 'recording';
      setRecordingUI(true);
      setReadyUI(false);
      if (_statusText) _statusText.textContent = 'Recording…';
      startLocalTimer(0, _maxSecs);
    } catch (e) {
      _startBtn.disabled = false;
      if (_statusText) _statusText.textContent = `Error: ${e.message}`;
    }
  }

  async function onStop() {
    _stopBtn.disabled = true;
    try {
      await API.stopRecord();
      // Optimistic UI
      _state = 'ready';
      setRecordingUI(false);
      stopLocalTimer();
      if (_statusText) _statusText.textContent = 'Stopped — fetching status…';
      if (_timerText)  _timerText.style.display = 'none';
    } catch (e) {
      _stopBtn.disabled = false;
      if (_statusText) _statusText.textContent = `Error: ${e.message}`;
    }
  }

  function onDownload() {
    const url = API.recordDownloadURL();
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function onDelete() {
    const ok = await App.confirm('Delete Recording', 'Delete the completed recording file?');
    if (!ok) return;
    try {
      await API.deleteRecord();
      _state = 'idle';
      setRecordingUI(false);
      setReadyUI(false);
      if (_statusText) _statusText.textContent = 'Idle';
    } catch (e) {
      if (_statusText) _statusText.textContent = `Error: ${e.message}`;
    }
  }

  // ── init ──────────────────────────────────────────────────────────────────
  function init() {
    _formatPCM    = document.getElementById('record-format-pcm');
    _formatOpus   = document.getElementById('record-format-opus');
    _startBtn     = document.getElementById('record-start-btn');
    _stopBtn      = document.getElementById('record-stop-btn');
    _statusText   = document.getElementById('record-status');
    _timerText    = document.getElementById('record-timer');
    _downloadBtn  = document.getElementById('record-download-btn');
    _deleteBtn    = document.getElementById('record-delete-btn');
    _readyRow     = document.getElementById('record-ready-row');
    _filenameText = document.getElementById('record-filename');
    _sizeText     = document.getElementById('record-size');

    if (_startBtn)    _startBtn.addEventListener('click', onStart);
    if (_stopBtn)     _stopBtn.addEventListener('click', onStop);
    if (_downloadBtn) _downloadBtn.addEventListener('click', onDownload);
    if (_deleteBtn)   _deleteBtn.addEventListener('click', onDelete);

    // Initial UI state
    setRecordingUI(false);
    setReadyUI(false);
    if (_timerText) _timerText.style.display = 'none';
    if (_stopBtn)   _stopBtn.disabled = true;
  }

  // ── Mode change ───────────────────────────────────────────────────────────
  /**
   * Called by tune.js whenever the mode changes.
   * In IQ modes, Opus recording is not meaningful (raw IQ data is PCM-only);
   * disable the Opus radio and switch to PCM if it was selected.
   */
  function onModeChange(mode) {
    _iqMode = (mode || '').startsWith('iq');
    if (_iqMode) {
      // Force PCM when entering IQ mode.
      if (_formatPCM)  _formatPCM.checked  = true;
      if (_formatOpus) {
        _formatOpus.checked  = false;
        _formatOpus.disabled = true;
        const lbl = _formatOpus.closest?.('.radio-label');
        if (lbl) lbl.classList.add('disabled');
      }
    } else {
      // Re-enable Opus when leaving IQ mode (unless currently recording).
      const shouldDisable = (_state === 'recording');
      if (_formatOpus) {
        _formatOpus.disabled = shouldDisable;
        const lbl = _formatOpus.closest?.('.radio-label');
        if (lbl) lbl.classList.toggle('disabled', shouldDisable);
      }
    }
  }

  return { init, applySnapshot, onModeChange };
})();
