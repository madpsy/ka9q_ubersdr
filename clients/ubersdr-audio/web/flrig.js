/**
 * flrig.js — FLRig sync configuration panel.
 *
 * Exports: FLRig.init(), FLRig.applySnapshot(flrigObj)
 */

const FLRig = (() => {
  const enabledCheck  = () => document.getElementById('flrig-enabled-check');
  const hostEntry     = () => document.getElementById('flrig-host-entry');
  const portEntry     = () => document.getElementById('flrig-port-entry');
  const dirGroup      = () => document.querySelectorAll('input[name="flrig-dir"]');
  const pttMuteCheck  = () => document.getElementById('flrig-ptt-mute-check');
  const applyBtn      = () => document.getElementById('flrig-apply-btn');
  const dot           = () => document.getElementById('flrig-dot');
  const statusLabel   = () => document.getElementById('flrig-status-label');
  const pttBadge      = () => document.getElementById('flrig-ptt-badge');

  let _ready = false;

  function getDirection() {
    for (const r of dirGroup()) {
      if (r.checked) return r.value;
    }
    return 'both';
  }

  function setDirection(dir) {
    for (const r of dirGroup()) {
      r.checked = (r.value === dir);
    }
  }

  function applySnapshot(flrig) {
    if (!flrig) return;

    _ready = false;

    const ec = enabledCheck();
    if (ec && flrig.enabled != null) ec.checked = flrig.enabled;

    const he = hostEntry();
    if (he && flrig.host) he.value = flrig.host;

    const pe = portEntry();
    if (pe && flrig.port != null) pe.value = flrig.port;

    if (flrig.direction) setDirection(flrig.direction);

    const pm = pttMuteCheck();
    if (pm && flrig.ptt_mute != null) pm.checked = flrig.ptt_mute;

    // Status dot
    const d = dot();
    if (d) {
      d.className = 'dot ' + (
        !flrig.enabled          ? 'dot-grey'   :
        flrig.connected         ? 'dot-green'  : 'dot-red'
      );
    }

    // Status label
    const sl = statusLabel();
    if (sl) {
      if (!flrig.enabled) {
        sl.textContent = 'Disabled';
      } else if (flrig.connected) {
        sl.textContent = 'Connected';
      } else {
        sl.textContent = 'Connecting…';
      }
    }

    // PTT badge
    const pb = pttBadge();
    if (pb) {
      if (flrig.ptt_active) {
        pb.textContent = 'TX';
        pb.className = 'ptt-badge ptt-tx';
      } else {
        pb.textContent = 'RX';
        pb.className = 'ptt-badge ptt-rx';
      }
    }

    _ready = true;
  }

  async function sendConfig() {
    if (!_ready) return;

    const host = (hostEntry()?.value || '127.0.0.1').trim();
    const portRaw = parseInt(portEntry()?.value || '12345', 10);
    const port = (portRaw >= 1 && portRaw <= 65535) ? portRaw : 12345;

    try {
      const result = await API.putFlrig({
        enabled:   enabledCheck()?.checked ?? false,
        host,
        port,
        direction: getDirection(),
        ptt_mute:  pttMuteCheck()?.checked ?? true,
      });
      if (result) applySnapshot(result);
    } catch (e) {
      console.warn('FLRig error:', e.message);
    }
  }

  function init() {
    applyBtn()?.addEventListener('click', sendConfig);

    // Apply on Enter in host/port fields
    hostEntry()?.addEventListener('keydown', e => {
      if (e.key === 'Enter') sendConfig();
    });
    portEntry()?.addEventListener('keydown', e => {
      if (e.key === 'Enter') sendConfig();
    });

    // Auto-apply on checkbox/radio changes
    enabledCheck()?.addEventListener('change', sendConfig);
    pttMuteCheck()?.addEventListener('change', sendConfig);
    for (const r of dirGroup()) {
      r.addEventListener('change', sendConfig);
    }

    _ready = true;
  }

  return { init, applySnapshot };
})();
