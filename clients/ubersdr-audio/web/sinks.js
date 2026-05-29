/**
 * sinks.js — stdout and UDP PCM output sinks management.
 *
 * Exports: Sinks.init(), Sinks.applySnapshot(sinksObj)
 */

const Sinks = (() => {
  const stdoutCheck   = () => document.getElementById('stdout-check');
  const udpAddrEntry  = () => document.getElementById('udp-address-entry');
  const udpAddBtn     = () => document.getElementById('udp-add-btn');
  const udpList       = () => document.getElementById('udp-sinks-list');

  let _stdout   = false;
  let _udpSinks = [];
  let _suppress = false;

  // ── Apply snapshot ────────────────────────────────────────────────────────
  function applySnapshot(sinks) {
    if (!sinks) return;

    _stdout   = sinks.stdout ?? _stdout;
    _udpSinks = sinks.udp    ?? _udpSinks;

    _suppress = true;
    const sc = stdoutCheck();
    if (sc) sc.checked = _stdout;
    _suppress = false;

    renderUDPList();
  }

  // ── Render UDP list ───────────────────────────────────────────────────────
  function renderUDPList() {
    const ul = udpList();
    if (!ul) return;
    ul.innerHTML = '';

    if (_udpSinks.length === 0) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:6px 0;color:var(--text-muted);font-size:0.82rem';
      li.textContent = 'No UDP sinks configured.';
      ul.appendChild(li);
      return;
    }

    for (const addr of _udpSinks) {
      const li = document.createElement('li');
      li.className = 'sink-item';

      const span = document.createElement('span');
      span.textContent = addr;

      const btn = document.createElement('button');
      btn.className = 'sink-remove-btn';
      btn.textContent = '✕';
      btn.title = 'Remove';
      btn.addEventListener('click', () => removeUDPSink(addr));

      li.appendChild(span);
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  // ── Stdout toggle ─────────────────────────────────────────────────────────
  async function toggleStdout(enabled) {
    try {
      if (enabled) {
        await API.enableStdout();
        _stdout = true;
      } else {
        await API.disableStdout();
        _stdout = false;
      }
    } catch (e) {
      console.warn('Stdout sink error:', e.message);
      // Revert
      _suppress = true;
      const sc = stdoutCheck();
      if (sc) sc.checked = _stdout;
      _suppress = false;
    }
  }

  // ── UDP sink add/remove ───────────────────────────────────────────────────
  async function addUDPSink() {
    const addr = udpAddrEntry()?.value?.trim();
    if (!addr) return;

    try {
      await API.addUDPSink(addr);
      _udpSinks.push(addr);
      renderUDPList();
      const ae = udpAddrEntry();
      if (ae) ae.value = '';
    } catch (e) {
      console.warn('Add UDP sink error:', e.message);
    }
  }

  async function removeUDPSink(addr) {
    try {
      await API.removeUDPSink(addr);
      _udpSinks = _udpSinks.filter(a => a !== addr);
      renderUDPList();
    } catch (e) {
      console.warn('Remove UDP sink error:', e.message);
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    stdoutCheck()?.addEventListener('change', async e => {
      if (_suppress) return;
      const enabling = e.target.checked;
      if (enabling) {
        const ok = await App.confirm(
          'Enable stdout PCM',
          'This will write raw decoded PCM audio to the process stdout.\n\nOnly enable this if you have a pipeline consuming stdout (e.g. piped to ffmpeg or aplay). Enabling it accidentally will not cause harm but may produce unexpected output.'
        );
        if (!ok) {
          // Revert the checkbox
          _suppress = true;
          const sc = stdoutCheck();
          if (sc) sc.checked = false;
          _suppress = false;
          return;
        }
      }
      toggleStdout(enabling);
    });

    udpAddBtn()?.addEventListener('click', addUDPSink);

    udpAddrEntry()?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addUDPSink();
    });
  }

  return { init, applySnapshot };
})();
