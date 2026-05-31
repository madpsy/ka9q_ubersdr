/**
 * connection.js — Connection panel: URL entry, connect/disconnect,
 * browse instances dialog, station label.
 *
 * Exports: Connection.init(), Connection.applySnapshot(connectionObj),
 *          Connection.getURL(), Connection.getPassword()
 */

const Connection = (() => {
  const urlEntry      = () => document.getElementById('url-entry');
  const passEntry     = () => document.getElementById('password-entry');
  const connectBtn    = () => document.getElementById('connect-btn');
  const browseBtn     = () => document.getElementById('browse-btn');
  const webBtn        = () => document.getElementById('web-btn');
  const stationLabel  = () => document.getElementById('station-label');
  const stationRow    = () => document.getElementById('station-row');
  const statusDot     = () => document.getElementById('status-dot');
  const statusLabel   = () => document.getElementById('status-label');
  const usersLabel    = () => document.getElementById('users-label');
  const throughputLbl = () => document.getElementById('throughput-label');

  let _state            = 'disconnected';
  let _sessionTimer     = null;
  let _sessionRemaining = null;   // locally-tracked countdown (seconds)
  let _reconnectTimer   = null;
  let _userDisconnected = false;

  // ── Status dot helper ─────────────────────────────────────────────────────
  function setDot(colour) {
    const d = statusDot();
    if (d) d.className = `dot dot-${colour}`;
  }

  // ── Format session time ───────────────────────────────────────────────────
  function formatSessionTime(secs) {
    if (secs <= 0) return '0s';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function stopSessionTimer() {
    if (_sessionTimer) { clearInterval(_sessionTimer); _sessionTimer = null; }
  }

  function stopReconnectTimer() {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  }

  // ── Apply connection snapshot ─────────────────────────────────────────────
  function applySnapshot(conn) {
    if (!conn) return;

    const prev = _state;
    _state = conn.state || 'disconnected';

    const sl = statusLabel();
    const cb = connectBtn();

    // Always sync the URL entry from the server's reported URL so it persists
    // across disconnect and the user can click Connect again without re-typing.
    if (conn.url) {
      const ue = urlEntry();
      if (ue && !ue.value) {
        // Only set if empty — don't overwrite what the user typed
        ue.value = conn.url;
      }
    }

    switch (_state) {
      case 'connected': {
        stopReconnectTimer();
        setDot('green');
        _userDisconnected = false;
        // Auto-dismiss the browse dialog if it was open when the connection
        // was established (e.g. connected via the Fyne GUI or another browser tab).
        if (prev !== 'connected') {
          App.closeModal('modal-browse');
        }

        // Sync URL entry from server (always keep it up to date while connected)
        if (conn.url) {
          const ue = urlEntry();
          if (ue) ue.value = conn.url;
        }

        // Station info
        const parts = [];
        if (conn.callsign) parts.push(conn.callsign);
        if (conn.name)     parts.push(conn.name);
        if (conn.location) parts.push(conn.location);
        const stText = parts.join(' · ');
        const stLbl = stationLabel();
        const stRow = stationRow();
        if (stLbl) stLbl.textContent = stText;
        if (stRow) stRow.style.display = stText ? '' : 'none';

        // Users
        const ul = usersLabel();
        if (ul) {
          if (conn.active_users >= 0) {
            ul.textContent = conn.max_users > 0
              ? `${conn.active_users}/${conn.max_users} users`
              : `${conn.active_users} users`;
          } else {
            ul.textContent = '';
          }
        }

        // Throughput
        const tl = throughputLbl();
        if (tl && conn.throughput_bps != null) {
          const bps = conn.throughput_bps;
          if (bps >= 1_000_000) tl.textContent = `${(bps/1_000_000).toFixed(1)} MB/s`;
          else if (bps >= 1000) tl.textContent = `${(bps/1000).toFixed(0)} kB/s`;
          else if (bps > 0)     tl.textContent = `${bps} B/s`;
          else                  tl.textContent = '';
        }

        // Session timer — only (re)start when transitioning into connected state
        // or when the server reports a significantly different remaining time
        // (e.g. new session).  Do NOT restart on every poll or the counter resets.
        if (!conn.session_unlimited && conn.session_remaining_s > 0) {
          const serverRemaining = conn.session_remaining_s;
          const needStart = prev !== 'connected' ||
            !_sessionTimer ||
            Math.abs(serverRemaining - (_sessionRemaining ?? serverRemaining)) > 10;

          if (needStart) {
            stopSessionTimer();
            _sessionRemaining = serverRemaining;
            if (sl) sl.textContent = `Connected · ${formatSessionTime(_sessionRemaining)}`;
            _sessionTimer = setInterval(() => {
              _sessionRemaining--;
              if (_sessionRemaining <= 0) {
                stopSessionTimer();
                setDot('orange');
                if (sl) sl.textContent = 'Session time expired';
                return;
              }
              if (_sessionRemaining <= 300) setDot('orange');
              if (sl) sl.textContent = `Connected · ${formatSessionTime(_sessionRemaining)}`;
            }, 1000);
          }
          // else: timer already running, leave it alone
        } else {
          stopSessionTimer();
          _sessionRemaining = null;
          if (sl) sl.textContent = 'Connected · Unlimited';
        }

        if (cb) {
          cb.textContent = 'Disconnect';
          cb.className = 'btn btn-danger';
        }
        break;
      }

      case 'connecting': {
        stopSessionTimer();
        stopReconnectTimer();
        setDot('orange');
        if (sl) sl.textContent = 'Connecting…';
        if (cb) {
          cb.textContent = 'Cancel';
          cb.className = 'btn btn-secondary';
        }
        break;
      }

      case 'error': {
        stopSessionTimer();
        setDot('red');
        const msg = conn.error_message || '';
        if (sl) sl.textContent = msg ? `Error: ${msg}` : 'Error';
        if (cb) {
          cb.textContent = 'Connect';
          cb.className = 'btn btn-primary';
        }
        clearStationLabel();
        clearUsersLabel();

        // Auto-reconnect after 5 s unless user disconnected
        if (!_userDisconnected) {
          let countdown = 5;
          stopReconnectTimer();
          const tick = () => {
            if (countdown <= 0) {
              doConnect();
              return;
            }
            setDot('orange');
            if (sl) sl.textContent = `Reconnecting in ${countdown}s…`;
            countdown--;
            _reconnectTimer = setTimeout(tick, 1000);
          };
          _reconnectTimer = setTimeout(tick, 1000);
        }
        break;
      }

      default: { // disconnected
        stopSessionTimer();
        stopReconnectTimer();
        setDot('red');
        if (sl) sl.textContent = 'Disconnected';
        if (cb) {
          cb.textContent = 'Connect';
          cb.className = 'btn btn-primary';
        }
        clearStationLabel();
        clearUsersLabel();
        break;
      }
    }
  }

  function clearStationLabel() {
    const stLbl = stationLabel();
    const stRow = stationRow();
    if (stLbl) stLbl.textContent = '';
    if (stRow) stRow.style.display = 'none';
  }

  function clearUsersLabel() {
    const ul = usersLabel();
    const tl = throughputLbl();
    if (ul) ul.textContent = '';
    if (tl) tl.textContent = '';
  }

  // ── Connect / Disconnect ──────────────────────────────────────────────────
  async function doConnect() {
    const url  = urlEntry()?.value?.trim();
    const pass = passEntry()?.value || '';
    if (!url) {
      setDot('red');
      const sl = statusLabel();
      if (sl) sl.textContent = 'Error: URL is required';
      return;
    }
    _userDisconnected = false;
    try {
      await API.connect(url, pass);
    } catch (e) {
      const sl = statusLabel();
      setDot('red');
      if (sl) sl.textContent = `Error: ${e.message}`;
    }
  }

  async function doDisconnect() {
    _userDisconnected = true;
    stopReconnectTimer();
    try {
      await API.disconnect();
    } catch (e) {
      console.warn('Disconnect error:', e.message);
    }
  }

  // ── Browse Instances ──────────────────────────────────────────────────────
  let _allInstances   = [];
  let _filteredIdx    = [];
  let _selectedIdx    = -1;

  async function openBrowseDialog() {
    const sl = statusLabel();
    if (_state !== 'connected') {
      setDot('orange');
      if (sl) sl.textContent = 'Fetching instances…';
    }

    App.openModal('modal-browse');
    const list = document.getElementById('instances-list');
    if (list) list.innerHTML = '<li style="padding:12px;color:var(--text-muted)">Loading…</li>';

    const searchEl = document.getElementById('browse-search');
    if (searchEl) {
      searchEl.value = '';
      // Focus the search box so the user can type immediately
      setTimeout(() => searchEl.focus(), 80);
    }

    try {
      const data = await API.getInstances();
      _allInstances = data?.instances || [];
    } catch (e) {
      _allInstances = [];
    }

    if (_state !== 'connected') {
      setDot('red');
      if (sl) sl.textContent = 'Disconnected';
    }

    // Sort: local first, then alphabetical
    _allInstances.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'local' ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    _filteredIdx = _allInstances.map((_, i) => i);
    _selectedIdx = -1;
    renderInstanceList();
    updateBrowseConnectBtn();
  }

  function renderInstanceList() {
    const list = document.getElementById('instances-list');
    if (!list) return;
    list.innerHTML = '';

    if (_filteredIdx.length === 0) {
      list.innerHTML = '<li style="padding:12px;color:var(--text-muted)">No instances found.</li>';
      return;
    }

    _filteredIdx.forEach((allIdx, filtIdx) => {
      const inst = _allInstances[allIdx];
      const li = document.createElement('li');
      li.className = 'instance-item' +
        (inst.available_clients === 0 && inst.max_clients > 0 ? ' full' : '') +
        (filtIdx === _selectedIdx ? ' selected' : '');

      const prefix = inst.source === 'local' ? '📡' : '🌐';
      const badge  = inst.source === 'local'
        ? '<span class="item-badge badge-local">local</span>'
        : '<span class="item-badge badge-public">public</span>';
      const fullBadge = (inst.available_clients === 0 && inst.max_clients > 0)
        ? '<span class="item-badge badge-full">full</span>' : '';

      const slots = inst.max_clients > 0
        ? ` · ${inst.available_clients}/${inst.max_clients} slots`
        : '';
      const loc = inst.location ? ` · ${inst.location}` : '';

      li.innerHTML = `
        <div class="item-title">${prefix} ${escHtml(inst.callsign || inst.name || inst.host)}${badge}${fullBadge}</div>
        <div class="item-subtitle">${escHtml(inst.host)}:${inst.port}${escHtml(loc)}${escHtml(slots)}</div>
      `;

      li.addEventListener('click', () => {
        // Update selection without rebuilding the list (rebuilding destroys the
        // element before dblclick can fire on it).
        const list2 = document.getElementById('instances-list');
        list2?.querySelectorAll('.instance-item').forEach((el, i) => {
          el.classList.toggle('selected', i === filtIdx);
        });
        _selectedIdx = filtIdx;
        updateBrowseConnectBtn();
        document.getElementById('browse-search')?.focus();
      });

      li.addEventListener('dblclick', () => {
        _selectedIdx = filtIdx;
        connectSelectedInstance();
      });

      list.appendChild(li);
    });
  }

  function updateBrowseConnectBtn() {
    const btn = document.getElementById('browse-connect-btn');
    if (btn) btn.disabled = _selectedIdx < 0;
  }

  async function connectSelectedInstance() {
    if (_selectedIdx < 0 || _selectedIdx >= _filteredIdx.length) return;
    const inst = _allInstances[_filteredIdx[_selectedIdx]];
    App.closeModal('modal-browse');

    const url = `${inst.tls ? 'https' : 'http'}://${inst.host}:${inst.port}`;
    const ue = urlEntry();
    if (ue) ue.value = url;

    _userDisconnected = false;
    try {
      await API.connect(url, passEntry()?.value || '');
    } catch (e) {
      setDot('red');
      const sl = statusLabel();
      if (sl) sl.textContent = `Error: ${e.message}`;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function getURL()      { return urlEntry()?.value?.trim() || ''; }
  function getPassword() { return passEntry()?.value || ''; }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // Connect / Disconnect button
    connectBtn()?.addEventListener('click', () => {
      if (_state === 'connected' || _state === 'connecting') {
        doDisconnect();
      } else {
        stopReconnectTimer();
        doConnect();
      }
    });

    // Enter key on URL / password fields
    urlEntry()?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (_state === 'connected' || _state === 'connecting') doDisconnect();
        else doConnect();
      }
    });
    passEntry()?.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (_state === 'connected' || _state === 'connecting') doDisconnect();
        else doConnect();
      }
    });

    // Browse button
    browseBtn()?.addEventListener('click', openBrowseDialog);

    // Web button — open current URL in browser
    webBtn()?.addEventListener('click', () => {
      const url = urlEntry()?.value?.trim();
      if (url) window.open(url, '_blank', 'noopener');
    });

    // Browse modal connect button
    document.getElementById('browse-connect-btn')?.addEventListener('click', connectSelectedInstance);

    // Browse search — keyboard navigation
    document.getElementById('browse-search')?.addEventListener('keydown', e => {
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
      e.preventDefault();
      if (e.key === 'Enter') {
        if (_selectedIdx >= 0) connectSelectedInstance();
        return;
      }
      const len = _filteredIdx.length;
      if (len === 0) return;
      if (e.key === 'ArrowDown') {
        _selectedIdx = _selectedIdx < len - 1 ? _selectedIdx + 1 : 0;
      } else {
        _selectedIdx = _selectedIdx > 0 ? _selectedIdx - 1 : len - 1;
      }
      renderInstanceList();
      updateBrowseConnectBtn();
      // Scroll selected item into view
      const list = document.getElementById('instances-list');
      const sel = list?.querySelector('.instance-item.selected');
      sel?.scrollIntoView({ block: 'nearest' });
    });

    // Browse search
    document.getElementById('browse-search')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();
      _selectedIdx = -1;
      if (!q) {
        _filteredIdx = _allInstances.map((_, i) => i);
      } else {
        _filteredIdx = _allInstances
          .map((inst, i) => ({ inst, i }))
          .filter(({ inst }) => {
            const hay = `${inst.callsign} ${inst.name} ${inst.host}:${inst.port}`.toLowerCase();
            return hay.includes(q);
          })
          .map(({ i }) => i);
      }
      renderInstanceList();
      updateBrowseConnectBtn();
    });

    // Auto-open browse dialog on startup only if not already connected.
    setTimeout(async () => {
      try {
        const status = await API.getStatus();
        if (status?.connection?.state === 'connected') return;
      } catch { /* API not ready — open dialog anyway */ }
      openBrowseDialog();
    }, 400);
  }

  return { init, applySnapshot, getURL, getPassword, doConnect, doDisconnect };
})();
