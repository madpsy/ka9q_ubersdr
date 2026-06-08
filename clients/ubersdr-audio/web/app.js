/**
 * app.js — Application bootstrap and orchestrator.
 *
 * Responsibilities:
 *  - Initialise all modules
 *  - Poll /api/v1/status every 1 s and fan out to all modules
 *  - Provide shared modal helpers (App.openModal, App.closeModal, App.confirm)
 *  - Wire card collapse/expand behaviour
 *  - Wire generic modal close buttons
 */

const App = (() => {
  // ── Poll interval ─────────────────────────────────────────────────────────
  const POLL_MS = 1000;
  let _pollTimer = null;
  let _lastState = null;

  // ── Status polling ────────────────────────────────────────────────────────
  async function poll() {
    try {
      const status = await API.getStatus();
      applyStatus(status);
    } catch (e) {
      // API unreachable — show error state
      Connection.applySnapshot({ state: 'error', error_message: e.message });
    }
  }

  function applyStatus(s) {
    if (!s) return;

    const prevState = _lastState;
    _lastState = s.connection?.state;

    // Connection panel
    if (s.connection) Connection.applySnapshot(s.connection);

    // Tune
    if (s.tune) Tune.applySnapshot(s.tune);

    // Audio
    if (s.audio) Audio.applySnapshot(s.audio);

    // AGC
    if (s.agc) AGC.applySnapshot(s.agc);

    // DSP
    if (s.dsp) {
      DSP.applySnapshot(s.dsp);
      if (_lastState === 'connected' && prevState !== 'connected') {
        DSP.onConnected();
      } else if (_lastState !== 'connected' && prevState === 'connected') {
        DSP.onDisconnected();
      }
    }

    // FLRig
    if (s.flrig) FLRig.applySnapshot(s.flrig);

    // Settings
    if (s.settings) Settings.applySnapshot(s.settings);

    // Sinks
    if (s.sinks) Sinks.applySnapshot(s.sinks);

    // Recording
    if (s.record) Record.applySnapshot(s.record);

    // Signal (snapshot only — live updates come from SSE)
    if (s.signal) Signal.applySnapshot(s.signal);

    // Audio gate — sync slider position across GUI and web UI
    if (s.audio_gate) Signal.applyGateSnapshot(s.audio_gate);

    // Bookmarks — fetch on first connect, retry while empty, clear on disconnect
    if (_lastState === 'connected' && prevState !== 'connected') {
      Signal.startSSE();
      Bookmarks.onConnected();
      WebAudio.onConnectionChange(true);
    } else if (_lastState === 'connected') {
      // Retry bookmark fetch on every poll tick while connected but empty
      // (handles the auto-connect race where the first fetch fires before the
      // SDR proxy connection is ready).
      Bookmarks.retryIfEmpty();
    }
    if (_lastState !== 'connected' && prevState === 'connected') {
      Signal.setNoData();
      Bookmarks.onDisconnected();
      WebAudio.onConnectionChange(false);
    }
  }

  function startPolling() {
    stopPolling();
    poll(); // immediate first poll
    _pollTimer = setInterval(poll, POLL_MS);
  }

  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────
  function openModal(id) {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = 'flex';
      // Trap focus inside modal for accessibility
      const first = el.querySelector('input, button, select, textarea, [tabindex]');
      if (first) setTimeout(() => first.focus(), 50);
    }
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  /**
   * Show a confirm dialog.  Returns a Promise<boolean>.
   */
  function confirm(title, message) {
    return new Promise(resolve => {
      const modal   = document.getElementById('modal-confirm');
      const titleEl = document.getElementById('confirm-title');
      const msgEl   = document.getElementById('confirm-message');
      const okBtn   = document.getElementById('confirm-ok-btn');
      const cancelBtn = document.getElementById('confirm-cancel-btn');

      if (!modal) { resolve(true); return; }

      if (titleEl) titleEl.textContent = title;
      if (msgEl)   msgEl.textContent   = message;

      openModal('modal-confirm');

      function cleanup() {
        closeModal('modal-confirm');
        okBtn?.removeEventListener('click', onOK);
        cancelBtn?.removeEventListener('click', onCancel);
      }

      function onOK()     { cleanup(); resolve(true);  }
      function onCancel() { cleanup(); resolve(false); }

      okBtn?.addEventListener('click', onOK);
      cancelBtn?.addEventListener('click', onCancel);
    });
  }

  // ── Card collapse/expand ──────────────────────────────────────────────────
  function initCards() {
    document.querySelectorAll('.card-header[data-toggle]').forEach(header => {
      const bodyId = header.dataset.toggle;
      const body   = document.getElementById(bodyId);
      if (!body) return;

      header.addEventListener('click', () => {
        const collapsed = header.classList.toggle('collapsed');
        body.classList.toggle('hidden', collapsed);
      });
    });
  }

  // ── Generic modal close buttons ───────────────────────────────────────────
  function initModalClose() {
    // data-close="modal-id" on buttons
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-close]');
      if (btn) closeModal(btn.dataset.close);

      // Click on backdrop closes modal
      if (e.target.classList.contains('modal-backdrop')) {
        const modal = e.target.closest('.modal');
        if (modal) closeModal(modal.id);
      }
    });

    // Escape key closes topmost visible modal
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const modals = Array.from(document.querySelectorAll('.modal'))
        .filter(m => m.style.display !== 'none');
      if (modals.length > 0) {
        closeModal(modals[modals.length - 1].id);
      }
    });
  }

  // ── Page title update ─────────────────────────────────────────────────────
  function updateTitle(conn, tune) {
    if (!conn || conn.state !== 'connected') {
      document.title = 'UberSDR';
      return;
    }
    const parts = [];
    if (conn.callsign) parts.push(conn.callsign);
    if (tune?.frequency_hz) parts.push(Tune.formatFreqKHz(tune.frequency_hz) + ' kHz');
    if (tune?.mode) parts.push(tune.mode.toUpperCase());
    document.title = parts.length > 0 ? `UberSDR — ${parts.join(' ')}` : 'UberSDR';
  }

  // ── Wake lock (keep screen on while connected on mobile) ──────────────────
  let _wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      _wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not critical */ }
  }

  function releaseWakeLock() {
    if (_wakeLock) { _wakeLock.release(); _wakeLock = null; }
  }

  // Re-acquire wake lock when page becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _lastState === 'connected') {
      requestWakeLock();
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    initCards();
    initModalClose();

    // Initialise all modules
    Help.init();
    Signal.init();
    Tune.init();
    AGC.init();
    Audio.init();
    WebAudio.init();
    Bookmarks.init();
    DSP.init();
    FLRig.init();
    Settings.init();
    Connection.init();
    Profiles.init();
    Sinks.init();
    Record.init();

    // Start polling
    startPolling();
  }

  // Boot when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { openModal, closeModal, confirm, requestWakeLock, releaseWakeLock };
})();
