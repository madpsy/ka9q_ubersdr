/**
 * dsp.js — Noise reduction (DSP) enable/filter/params panel.
 *
 * Exports: DSP.init(), DSP.applySnapshot(dspObj), DSP.onModeChange(mode),
 *          DSP.onConnected(), DSP.onDisconnected()
 */

const DSP = (() => {
  const enableCheck   = () => document.getElementById('dsp-enable-check');
  const filterSelect  = () => document.getElementById('dsp-filter-select');
  const configBtn     = () => document.getElementById('dsp-config-btn');
  const applyBtn      = () => document.getElementById('dsp-apply-btn');
  const statusLabel   = () => document.getElementById('dsp-status-label');

  let _available  = false;
  let _enabled    = false;
  let _filter     = '';
  let _filters    = [];       // full filter metadata from /dsp/filters
  let _filterNames = [];      // simple name list from /dsp
  let _connected  = false;
  let _suppress   = false;    // prevent feedback loops
  let _currentParams = {};    // name → value string, for the active filter
  let _debounceTimers = {};   // param name → timeout id

  // ── UI state ──────────────────────────────────────────────────────────────
  function updateUI() {
    const ec = enableCheck();
    const fs = filterSelect();
    const cb = configBtn();
    const ab = applyBtn();
    const sl = statusLabel();

    if (!_available) {
      if (ec) ec.disabled = true;
      if (fs) fs.disabled = true;
      if (cb) cb.disabled = true;
      if (ab) ab.disabled = true;
      if (sl) sl.textContent = 'Not available on this instance';
      return;
    }

    if (!_connected) {
      if (ec) ec.disabled = true;
      if (fs) fs.disabled = true;
      if (cb) cb.disabled = true;
      if (ab) ab.disabled = true;
      if (sl) sl.textContent = _enabled
        ? 'Active (disconnected)'
        : 'Available on this instance — connect to enable';
      return;
    }

    // Connected + available
    if (ec) ec.disabled = false;
    if (fs) fs.disabled = false;

    if (_enabled) {
      if (cb) cb.disabled = false;
      if (ab) ab.disabled = false;
      if (sl) sl.textContent = 'Active';
    } else {
      if (cb) cb.disabled = true;
      if (ab) cb.disabled = true;
      if (ab) ab.disabled = true;
      if (sl) sl.textContent = 'Available — check the box to activate';
    }
  }

  // ── Populate filter dropdown ──────────────────────────────────────────────
  function populateFilters(names) {
    const fs = filterSelect();
    if (!fs) return;
    const prev = fs.value || _filter;
    fs.innerHTML = '<option value="">Select filter…</option>';
    for (const n of names) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      fs.appendChild(opt);
    }
    if (names.includes(prev)) fs.value = prev;
    else if (names.length > 0) fs.value = names[0];
    _filter = fs.value;
  }

  // ── Apply snapshot from /status or /dsp ──────────────────────────────────
  function applySnapshot(dsp) {
    if (!dsp) return;

    _available = dsp.available ?? _available;
    _enabled   = dsp.enabled   ?? _enabled;
    if (dsp.filter) _filter = dsp.filter;
    if (dsp.filters && dsp.filters.length > 0) {
      _filterNames = dsp.filters;
      populateFilters(_filterNames);
    }

    _suppress = true;
    const ec = enableCheck();
    if (ec) ec.checked = _enabled;
    const fs = filterSelect();
    if (fs && _filter) fs.value = _filter;
    _suppress = false;

    updateUI();
  }

  function onModeChange(_mode) {
    // No mode-specific DSP constraints currently
  }

  function onConnected() {
    _connected = true;
    updateUI();
    // Fetch full filter metadata
    fetchFilters();
  }

  function onDisconnected() {
    _connected = false;
    _enabled   = false;
    _suppress  = true;
    const ec = enableCheck();
    if (ec) ec.checked = false;
    _suppress = false;
    updateUI();
  }

  // ── Fetch full filter metadata ────────────────────────────────────────────
  async function fetchFilters() {
    if (!_available) return;
    try {
      const data = await API.getDSPFilters();
      if (data?.filters) {
        _filters = data.filters;
        // Also update the name list
        _filterNames = _filters.map(f => f.name);
        populateFilters(_filterNames);
      }
    } catch (e) {
      console.warn('DSP filters error:', e.message);
    }
  }

  // ── Send DSP enable/disable ───────────────────────────────────────────────
  async function sendDSP(enabled, filter) {
    try {
      const body = { enabled };
      if (enabled && filter) body.filter = filter;
      const result = await API.putDSP(body);
      if (result) applySnapshot(result);
    } catch (e) {
      console.warn('DSP error:', e.message);
      // Revert checkbox on error
      _suppress = true;
      const ec = enableCheck();
      if (ec) ec.checked = _enabled;
      _suppress = false;
      updateUI();
    }
  }

  // ── DSP Config Modal ──────────────────────────────────────────────────────
  function openConfigModal() {
    const filterName = filterSelect()?.value;
    if (!filterName) return;

    const filterMeta = _filters.find(f => f.name === filterName);
    const params = filterMeta?.params?.filter(p => p.runtime_safe) || [];

    const title = document.getElementById('dsp-config-title');
    const body  = document.getElementById('dsp-config-body');
    if (!title || !body) return;

    title.textContent = `${filterName} Parameters`;
    body.innerHTML = '';

    if (params.length === 0) {
      body.innerHTML = '<p class="text-muted">No runtime-configurable parameters for this filter.</p>';
    } else {
      for (const p of params) {
        body.appendChild(buildParamGroup(p));
      }
    }

    App.openModal('modal-dsp-config');
  }

  function buildParamGroup(p) {
    const group = document.createElement('div');
    group.className = 'param-group';

    const nameEl = document.createElement('div');
    nameEl.className = 'param-name';
    nameEl.textContent = p.name;
    group.appendChild(nameEl);

    if (p.description) {
      const desc = document.createElement('div');
      desc.className = 'param-desc';
      desc.textContent = p.description;
      group.appendChild(desc);
    }

    const currentVal = _currentParams[p.name] ?? p.default ?? '';

    switch (p.type) {
      case 'float':
      case 'int': {
        const min = parseFloat(p.min ?? 0);
        const max = parseFloat(p.max ?? 1);
        let cur = parseFloat(currentVal);
        if (isNaN(cur)) cur = parseFloat(p.default ?? min);
        cur = Math.max(min, Math.min(max, cur));

        const step = p.type === 'int' ? 1 : Math.max(0.01, (max - min) / 100);

        const row = document.createElement('div');
        row.className = 'param-slider-row';

        const sl = document.createElement('input');
        sl.type  = 'range';
        sl.className = 'slider';
        sl.min   = min;
        sl.max   = max;
        sl.step  = step;
        sl.value = cur;

        const valLbl = document.createElement('span');
        valLbl.className = 'param-value';
        valLbl.textContent = p.type === 'int' ? Math.round(cur) : cur.toFixed(2);

        const rangeLbl = document.createElement('span');
        rangeLbl.className = 'param-range';
        rangeLbl.textContent = `(${p.min}–${p.max})`;

        sl.addEventListener('input', e => {
          const v = parseFloat(e.target.value);
          valLbl.textContent = p.type === 'int' ? Math.round(v) : v.toFixed(2);
        });
        sl.addEventListener('change', e => {
          const v = parseFloat(e.target.value);
          sendParamDebounced(p.name, p.type === 'int' ? String(Math.round(v)) : v.toFixed(4));
        });
        sl.addEventListener('touchend', e => {
          const v = parseFloat(sl.value);
          sendParamDebounced(p.name, p.type === 'int' ? String(Math.round(v)) : v.toFixed(4));
        });

        row.appendChild(sl);
        row.appendChild(valLbl);
        row.appendChild(rangeLbl);
        group.appendChild(row);
        break;
      }

      case 'bool': {
        const lbl = document.createElement('label');
        lbl.className = 'checkbox-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        const truthy = ['true','1','on'].includes(String(currentVal).toLowerCase());
        cb.checked = truthy;
        cb.addEventListener('change', e => {
          sendParamDebounced(p.name, e.target.checked ? 'true' : 'false');
        });
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + p.name));
        group.appendChild(lbl);
        break;
      }

      default: {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = currentVal;
        inp.placeholder = p.default ?? '';
        inp.addEventListener('change', e => {
          sendParamDebounced(p.name, e.target.value);
        });
        group.appendChild(inp);
        break;
      }
    }

    return group;
  }

  function sendParamDebounced(name, val) {
    if (_debounceTimers[name]) clearTimeout(_debounceTimers[name]);
    _debounceTimers[name] = setTimeout(async () => {
      _currentParams[name] = val;
      try {
        await API.patchDSPParams({ [name]: val });
      } catch (e) {
        console.warn(`DSP param ${name} error:`, e.message);
      }
    }, 100);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    enableCheck()?.addEventListener('change', e => {
      if (_suppress) return;
      _enabled = e.target.checked;
      const filter = filterSelect()?.value || '';
      if (!_enabled) {
        // Close config modal if open
        App.closeModal('modal-dsp-config');
        _currentParams = {};
      }
      sendDSP(_enabled, filter);
    });

    filterSelect()?.addEventListener('change', e => {
      if (_suppress) return;
      _filter = e.target.value;
      _currentParams = {}; // clear params for new filter
      if (_enabled && _filter) {
        sendDSP(true, _filter);
      }
    });

    applyBtn()?.addEventListener('click', () => {
      if (!_enabled || !_filter) return;
      sendDSP(true, _filter);
    });

    configBtn()?.addEventListener('click', () => {
      if (_filters.length === 0) {
        fetchFilters().then(openConfigModal);
      } else {
        openConfigModal();
      }
    });
  }

  return { init, applySnapshot, onModeChange, onConnected, onDisconnected };
})();
