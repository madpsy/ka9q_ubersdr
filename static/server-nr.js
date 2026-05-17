/**
 * server-nr.js — Server-Side DSP Noise Reduction Popout Controller
 *
 * Runs inside the server-nr.html popout window.
 * Communicates with the main page (window.opener) via postMessage.
 *
 * Message protocol (popout → opener):
 *   { type: 'snr_request_filters' }          — ask main page to call get_dsp_filters
 *   { type: 'snr_enable', filter, params }   — enable DSP insert
 *   { type: 'snr_disable' }                  — disable DSP insert
 *   { type: 'snr_params', params }           — update params mid-stream
 *
 * Message protocol (opener → popout):
 *   { type: 'dsp_filters', info: { available, filters, reason } }
 *   { type: 'dsp_status',  info: { enabled, filter } }
 *   { type: 'dsp_error',   info: { code, message } }
 *   { type: 'snr_connection_state', connected: bool }
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
    /** @type {Array<{name:string, description:string, params:Array}>} */
    filters: [],
    available: false,
    enabled: false,
    activeFilter: null,
    /** Current param values keyed by param name */
    paramValues: {},
    /** Debounce timers for slider params */
    paramTimers: {},
    connected: false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const els = {
    statusBadge:      () => document.getElementById('snr-status-badge'),
    filterSelect:     () => document.getElementById('snr-filter-select'),
    filterDesc:       () => document.getElementById('snr-filter-desc'),
    paramsContainer:  () => document.getElementById('snr-params-container'),
    btnEnable:        () => document.getElementById('snr-btn-enable'),
    btnDisable:       () => document.getElementById('snr-btn-disable'),
    btnRefresh:       () => document.getElementById('snr-btn-refresh'),
    message:          () => document.getElementById('snr-message'),
    unavailable:      () => document.getElementById('snr-unavailable'),
    unavailReason:    () => document.getElementById('snr-unavail-reason'),
    loading:          () => document.getElementById('snr-loading'),
    mainContent:      () => document.getElementById('snr-main-content'),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(text, cls) {
    const el = els.statusBadge();
    if (!el) return;
    el.textContent = text;
    el.className = cls; // 'disabled' | 'enabled' | 'pending' | 'unavail'
}

function showMessage(text, type = 'info', persistent = false) {
    const el = els.message();
    if (!el) return;
    el.textContent = text;
    el.className = type; // 'info' | 'success' | 'error' | 'warning'
    // Auto-clear after 6 s for non-error, non-persistent messages
    clearTimeout(el._timer);
    if (!persistent && type !== 'error') {
        el._timer = setTimeout(() => {
            el.className = '';
            el.textContent = '';
        }, 6000);
    }
}

function clearMessage() {
    const el = els.message();
    if (!el) return;
    el.className = '';
    el.textContent = '';
}

function setLoading(visible) {
    const ld = els.loading();
    const mc = els.mainContent();
    if (ld) {
        ld.classList.toggle('visible', visible);
        ld.style.display = visible ? 'flex' : 'none';
    }
    if (mc) mc.style.display = visible ? 'none' : '';
}

function setUnavailable(reason) {
    const uv = els.unavailable();
    const mc = els.mainContent();
    const ur = els.unavailReason();
    if (uv) uv.classList.add('visible');
    if (mc) mc.style.display = 'none';
    if (ur) ur.textContent = reason || 'DSP noise reduction is not available on this server.';
}

function postToOpener(msg) {
    if (window.opener && !window.opener.closed) {
        window.opener.postMessage(msg, window.location.origin);
    }
}

// ── Filter selector ───────────────────────────────────────────────────────────

function populateFilterSelect(filters) {
    const sel = els.filterSelect();
    if (!sel) return;
    sel.innerHTML = '';
    filters.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.name;
        opt.textContent = f.name.toUpperCase();
        sel.appendChild(opt);
    });
    // Restore active filter selection if still available
    if (state.activeFilter && filters.some(f => f.name === state.activeFilter)) {
        sel.value = state.activeFilter;
    }
    onFilterSelectChange();
}

function onFilterSelectChange() {
    const sel = els.filterSelect();
    const desc = els.filterDesc();
    if (!sel || !desc) return;

    const name = sel.value;
    const filter = state.filters.find(f => f.name === name);
    if (!filter) {
        desc.textContent = '';
        renderParams([]);
        return;
    }
    desc.textContent = filter.description || '';
    renderParams(filter.params || []);
}

// ── Dynamic parameter rendering ───────────────────────────────────────────────

/**
 * Render parameter controls from the server's filter param descriptors.
 * Each param descriptor: { name, type, default, min, max, description, runtime_safe }
 */
function renderParams(params) {
    const container = els.paramsContainer();
    if (!container) return;
    container.innerHTML = '';

    // Reset param values for this filter
    state.paramValues = {};

    const runtimeParams = params.filter(p => p.runtime_safe !== false);

    if (runtimeParams.length === 0) {
        const notice = document.createElement('p');
        notice.className = 'snr-no-params';
        notice.textContent = 'This filter has no adjustable parameters.';
        container.appendChild(notice);
        return;
    }

    runtimeParams.forEach(param => {
        // Initialise value from default
        state.paramValues[param.name] = param.default ?? '';

        const row = document.createElement('div');
        row.className = 'snr-param-row';

        const ptype = (param.type || 'float').toLowerCase();

        if (ptype === 'bool') {
            renderBoolParam(row, param);
        } else if (param.min !== undefined && param.max !== undefined && param.min !== '' && param.max !== '') {
            renderSliderParam(row, param);
        } else if (param.type === 'string' || (param.min === undefined && param.max === undefined)) {
            renderSelectOrTextParam(row, param);
        } else {
            renderSliderParam(row, param);
        }

        container.appendChild(row);
    });
}

function renderSliderParam(row, param) {
    const min = parseFloat(param.min ?? 0);
    const max = parseFloat(param.max ?? 100);
    const def = parseFloat(param.default ?? min);
    const step = computeStep(min, max);

    state.paramValues[param.name] = String(def);

    const header = document.createElement('div');
    header.className = 'snr-param-header';

    const label = document.createElement('span');
    label.className = 'snr-param-label';
    label.textContent = formatParamName(param.name);

    const valueSpan = document.createElement('span');
    valueSpan.className = 'snr-param-value';
    valueSpan.textContent = formatParamValue(def, param);

    header.appendChild(label);
    header.appendChild(valueSpan);
    row.appendChild(header);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'snr-slider';
    slider.min = min;
    slider.max = max;
    slider.step = step;
    slider.value = def;
    slider.dataset.paramName = param.name;

    slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        valueSpan.textContent = formatParamValue(v, param);
        state.paramValues[param.name] = String(v);
        debounceSendParams(param.name);
    });

    row.appendChild(slider);

    if (param.description) {
        const desc = document.createElement('span');
        desc.className = 'snr-param-desc';
        desc.textContent = param.description;
        row.appendChild(desc);
    }
}

function renderBoolParam(row, param) {
    const def = param.default === 'true' || param.default === true;
    state.paramValues[param.name] = def ? 'true' : 'false';

    const label = document.createElement('label');
    label.className = 'snr-param-check';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = def;
    cb.dataset.paramName = param.name;

    cb.addEventListener('change', () => {
        state.paramValues[param.name] = cb.checked ? 'true' : 'false';
        if (state.enabled) sendCurrentParams();
    });

    const text = document.createElement('span');
    text.className = 'snr-param-label';
    text.textContent = formatParamName(param.name);

    label.appendChild(cb);
    label.appendChild(text);
    row.appendChild(label);

    if (param.description) {
        const desc = document.createElement('span');
        desc.className = 'snr-param-desc';
        desc.textContent = param.description;
        row.appendChild(desc);
    }
}

function renderSelectOrTextParam(row, param) {
    // If the description hints at discrete values (e.g. "one of: a, b, c") we
    // could parse them, but for now render a plain text input.
    state.paramValues[param.name] = param.default ?? '';

    const header = document.createElement('div');
    header.className = 'snr-param-header';
    const label = document.createElement('span');
    label.className = 'snr-param-label';
    label.textContent = formatParamName(param.name);
    header.appendChild(label);
    row.appendChild(header);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'snr-input';
    input.value = param.default ?? '';
    input.dataset.paramName = param.name;
    input.placeholder = param.description || '';

    input.addEventListener('change', () => {
        state.paramValues[param.name] = input.value;
        if (state.enabled) sendCurrentParams();
    });

    row.appendChild(input);

    if (param.description) {
        const desc = document.createElement('span');
        desc.className = 'snr-param-desc';
        desc.textContent = param.description;
        row.appendChild(desc);
    }
}

// ── Param helpers ─────────────────────────────────────────────────────────────

function computeStep(min, max) {
    const range = max - min;
    if (range <= 1) return 0.01;
    if (range <= 10) return 0.1;
    if (range <= 100) return 1;
    return Math.pow(10, Math.floor(Math.log10(range)) - 1);
}

function formatParamName(name) {
    // "gain-method" → "Gain Method"
    return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function formatParamValue(v, param) {
    const ptype = (param.type || 'float').toLowerCase();
    if (ptype === 'int') return String(Math.round(v));
    // Show 2 decimal places for small ranges, 1 for larger
    const range = parseFloat(param.max ?? 100) - parseFloat(param.min ?? 0);
    if (range <= 1) return v.toFixed(3);
    if (range <= 10) return v.toFixed(2);
    return v.toFixed(1);
}

// ── Debounced param send ──────────────────────────────────────────────────────

function debounceSendParams(paramName) {
    if (!state.enabled) return; // Only send live updates when insert is active
    clearTimeout(state.paramTimers[paramName]);
    state.paramTimers[paramName] = setTimeout(() => {
        sendCurrentParams();
    }, 120); // 120 ms debounce — fast enough for sliders
}

function sendCurrentParams() {
    if (!state.enabled) return;
    postToOpener({ type: 'snr_params', params: { ...state.paramValues } });
}

// ── Enable / Disable ──────────────────────────────────────────────────────────

function enableDSP() {
    const sel = els.filterSelect();
    if (!sel || !sel.value) return;

    const filterName = sel.value;
    setStatus('ENABLING…', 'pending');
    clearMessage();

    postToOpener({
        type: 'snr_enable',
        filter: filterName,
        params: { ...state.paramValues },
    });
}

function disableDSP() {
    setStatus('DISABLING…', 'pending');
    clearMessage();
    postToOpener({ type: 'snr_disable' });
}

function updateButtonStates() {
    const btnEn = els.btnEnable();
    const btnDis = els.btnDisable();
    const sel = els.filterSelect();

    if (btnEn) btnEn.disabled = !state.connected || !state.available || state.enabled;
    if (btnDis) btnDis.disabled = !state.connected || !state.enabled;
    if (sel) sel.disabled = state.enabled; // Lock filter while active
}

// ── Incoming messages from opener ─────────────────────────────────────────────

window.addEventListener('message', (event) => {
    // Only accept messages from the same origin (the main page)
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case 'dsp_filters':
            handleFiltersResponse(msg.info || {});
            break;
        case 'dsp_status':
            handleDSPStatus(msg.info || {});
            break;
        case 'dsp_error':
            handleDSPError(msg.info || {});
            break;
        case 'snr_connection_state':
            handleConnectionState(msg.connected);
            break;
        default:
            break;
    }
});

function handleFiltersResponse(info) {
    setLoading(false);

    if (!info.available) {
        setUnavailable(info.reason || 'DSP noise reduction is not available on this server.');
        return;
    }

    state.available = true;
    // If the main page sent us filters, we must be connected (it only does so when
    // DSP is enabled and the WS is open, or from instanceDescription fast-path).
    // Mark connected so the Enable button is enabled.
    state.connected = true;

    state.filters = info.filters || [];

    if (state.filters.length === 0) {
        setUnavailable('No DSP filters are enabled on this server.');
        return;
    }

    // Update status badge from "LOADING…" to "DISABLED"
    setStatus('DISABLED', 'disabled');

    populateFilterSelect(state.filters);
    updateButtonStates();

    // Only show the hint message if we don't yet have full param details
    // (i.e. this is the fast-path response with empty params arrays).
    const hasParams = state.filters.some(f => f.params && f.params.length > 0);
    if (!hasParams) {
        showMessage(`${state.filters.length} filter(s) available. Loading parameters…`, 'info', true);
    } else {
        showMessage(`${state.filters.length} filter(s) available. Select a filter and click Enable.`, 'info', true);
    }
}

function handleDSPStatus(info) {
    state.enabled = !!info.enabled;
    state.activeFilter = info.filter || null;

    if (state.enabled) {
        setStatus(`ACTIVE — ${(state.activeFilter || '').toUpperCase()}`, 'enabled');
        showMessage(`Server-side noise reduction active (${state.activeFilter}).`, 'success');
    } else {
        setStatus('DISABLED', 'disabled');
        showMessage('Server-side noise reduction disabled.', 'info');
        // Unlock filter selector
        const sel = els.filterSelect();
        if (sel) sel.disabled = false;
    }
    updateButtonStates();
}

function handleDSPError(info) {
    const code = info.code || 'ERROR';
    const message = info.message || 'An unknown DSP error occurred.';

    setStatus('ERROR', 'disabled');
    showMessage(`[${code}] ${message}`, 'error');

    // Reset pending state
    if (!state.enabled) {
        updateButtonStates();
    }
}

function handleConnectionState(connected) {
    state.connected = connected;
    updateButtonStates();

    if (!connected) {
        setStatus('DISCONNECTED', 'unavail');
        showMessage('Main page is disconnected from the server. Reconnect to use server NR.', 'warning');
    } else if (state.available && !state.enabled) {
        setStatus('DISABLED', 'disabled');
        clearMessage();
    }
}

// ── Refresh (re-request filter list) ─────────────────────────────────────────

function refreshFilters() {
    setLoading(true);
    clearMessage();
    state.filters = [];
    state.available = false;
    postToOpener({ type: 'snr_request_filters' });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
    // Wire up buttons
    const btnEn = els.btnEnable();
    const btnDis = els.btnDisable();
    const btnRef = els.btnRefresh();
    const sel = els.filterSelect();

    if (btnEn) btnEn.addEventListener('click', enableDSP);
    if (btnDis) btnDis.addEventListener('click', disableDSP);
    if (btnRef) btnRef.addEventListener('click', refreshFilters);
    if (sel) sel.addEventListener('change', onFilterSelectChange);

    // Initial state
    setStatus('LOADING…', 'pending');
    setLoading(true);
    updateButtonStates();

    // Retry sending snr_request_filters several times with increasing delays.
    // This handles the race where the opener's message listener hasn't registered
    // yet when the popout first loads (ES module evaluation timing).
    let filterRequestAttempts = 0;
    function requestFilters() {
        if (state.available) return; // already got a response
        filterRequestAttempts++;
        console.log(`[ServerNR] Requesting filters from opener (attempt ${filterRequestAttempts})`);
        postToOpener({ type: 'snr_request_filters' });
        if (filterRequestAttempts < 5) {
            setTimeout(requestFilters, 300 * filterRequestAttempts);
        }
    }
    // First attempt after a short delay to let the opener's load handler fire
    setTimeout(requestFilters, 100);

    // If we still haven't received dsp_filters after 5 s, show a timeout message.
    // Only cancel this when dsp_filters actually arrives (handled in handleFiltersResponse).
    setTimeout(() => {
        if (!state.available && !document.getElementById('snr-unavailable').classList.contains('visible')) {
            setLoading(false);
            showMessage('No response from main page. Is the main window still open and connected?', 'warning');
            setStatus('UNKNOWN', 'unavail');
            updateButtonStates();
        }
    }, 5000);
}

// Run after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
