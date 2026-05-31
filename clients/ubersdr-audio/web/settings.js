/**
 * settings.js — Application settings panel.
 *
 * Manages the Settings card in the web UI.  Currently exposes:
 *   • browser_auto_connect — when enabled, opening this page auto-connects to
 *     the last-used SDR instance and closing all tabs auto-disconnects.
 *
 * The setting is persisted server-side (Fyne preferences) so it survives
 * app restarts and is shared between the desktop GUI and the web UI.
 */

const Settings = (() => {
  let _check = null;   // <input type="checkbox" id="settings-auto-connect-check">
  let _busy  = false;  // prevent re-entrant sends

  // ── Apply snapshot from /status ──────────────────────────────────────────
  function applySnapshot(settings) {
    if (!settings || _check === null) return;
    _check.checked = !!settings.browser_auto_connect;
  }

  // ── Send current checkbox value to the server ────────────────────────────
  async function sendConfig() {
    if (_busy) return;
    _busy = true;
    try {
      await API.putSettings({ browser_auto_connect: _check.checked });
    } catch (e) {
      console.warn('Settings: putSettings failed:', e.message);
      // Revert checkbox to last known server state on failure.
      try {
        const s = await API.getSettings();
        if (s && _check) _check.checked = !!s.browser_auto_connect;
      } catch { /* ignore */ }
    } finally {
      _busy = false;
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    _check = document.getElementById('settings-auto-connect-check');
    if (!_check) return;

    _check.addEventListener('change', sendConfig);
  }

  return { init, applySnapshot };
})();
