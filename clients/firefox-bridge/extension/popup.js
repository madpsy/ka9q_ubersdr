// UberSDR Bridge — Popup Script
'use strict';

// ── DOM refs ───────────────────────────────────────────────────────────────────

const tabList         = document.getElementById('tab-list');
const stateFreq       = document.getElementById('state-freq');
const stateMode       = document.getElementById('state-mode');
const stateBwLow      = document.getElementById('state-bw-low');
const stateBwHigh     = document.getElementById('state-bw-high');

const inputFreq       = document.getElementById('input-freq');
const btnSetFreq      = document.getElementById('btn-set-freq');
const stepButtons     = document.querySelectorAll('.step-btn');

const selectMode      = document.getElementById('select-mode');
const btnSetMode      = document.getElementById('btn-set-mode');

const bwHeader        = document.getElementById('bw-header');
const bwArrow         = document.getElementById('bw-arrow');
const bwBody          = document.getElementById('bw-body');
const inputBwLow      = document.getElementById('input-bw-low');
const inputBwHigh     = document.getElementById('input-bw-high');
const btnSetBw        = document.getElementById('btn-set-bw');

const bridgeHeader    = document.getElementById('bridge-header');
const bridgeArrow     = document.getElementById('bridge-arrow');
const bridgeBody      = document.getElementById('bridge-body');
const bridgeEnabled   = document.getElementById('bridge-enabled');
const bridgeDot       = document.getElementById('bridge-dot');
const bridgeStatusTxt = document.getElementById('bridge-status-text');
const inputBridgeUrl  = document.getElementById('input-bridge-url');
const inputBridgeSec  = document.getElementById('input-bridge-secret');
const btnSaveBridge   = document.getElementById('btn-save-bridge');
const btnTestBridge   = document.getElementById('btn-test-bridge');

const statusBar       = document.getElementById('status-bar');

// ── Local state ────────────────────────────────────────────────────────────────

let currentState = null;   // Last known radio state { freq, mode, bwLow, bwHigh }
let selectedTabId = null;

// ── Initialise ─────────────────────────────────────────────────────────────────

async function init() {
    // Ask background for the current registry and state.
    try {
        const resp = await browser.runtime.sendMessage({ type: 'popup:get_registry' });
        if (resp) {
            renderTabList(resp.tabs, resp.selectedTabId);
            selectedTabId = resp.selectedTabId;
            if (resp.lastState) {
                currentState = resp.lastState;
                renderState(resp.lastState);
            }
            if (resp.bridgeUrl)     inputBridgeUrl.value = resp.bridgeUrl;
            if (resp.bridgeEnabled) {
                bridgeEnabled.checked = resp.bridgeEnabled;
                updateBridgeUI(resp.bridgeEnabled);
            }
        }
    } catch (err) {
        setStatus('Background not ready — try reopening the popup.', 'error');
    }
}

// ── Tab list rendering ─────────────────────────────────────────────────────────

function renderTabList(tabs, activeTabId) {
    if (!tabs || tabs.length === 0) {
        tabList.innerHTML = '<div class="no-tabs">No UberSDR tabs detected.<br>Open an UberSDR page to begin.</div>';
        setControlsEnabled(false);
        return;
    }

    setControlsEnabled(true);
    tabList.innerHTML = '';

    tabs.forEach(tab => {
        const item = document.createElement('div');
        item.className = 'tab-item' + (tab.tabId === activeTabId ? ' selected' : '');
        item.dataset.tabId = tab.tabId;

        const radio = document.createElement('input');
        radio.type      = 'radio';
        radio.name      = 'tab-select';
        radio.className = 'tab-radio';
        radio.checked   = tab.tabId === activeTabId;
        radio.addEventListener('change', () => selectTab(tab.tabId));

        const info = document.createElement('div');
        info.className = 'tab-info';

        const title = document.createElement('div');
        title.className   = 'tab-title';
        title.textContent = tab.title || 'UberSDR';

        const url = document.createElement('div');
        url.className   = 'tab-url';
        url.textContent = tab.url;

        info.appendChild(title);
        info.appendChild(url);
        item.appendChild(radio);
        item.appendChild(info);
        item.addEventListener('click', () => {
            radio.checked = true;
            selectTab(tab.tabId);
        });

        tabList.appendChild(item);
    });
}

function selectTab(tabId) {
    selectedTabId = tabId;
    browser.runtime.sendMessage({ type: 'popup:select_tab', tabId }).catch(() => {});
    setStatus(`Switched to tab ${tabId}`, 'info');
    // Clear state display until we get a fresh snapshot.
    currentState = null;
    renderState(null);
}

// ── State rendering ────────────────────────────────────────────────────────────

function renderState(state) {
    if (!state) {
        stateFreq.textContent  = '—';
        stateMode.textContent  = '—';
        stateBwLow.textContent = '—';
        stateBwHigh.textContent = '—';
        return;
    }

    if (state.freq !== undefined) {
        stateFreq.textContent = formatHz(state.freq);
        // Pre-fill the frequency input with the current value.
        if (document.activeElement !== inputFreq) {
            inputFreq.value = state.freq;
        }
    }
    if (state.mode !== undefined) {
        stateMode.textContent = state.mode.toUpperCase();
        if (selectMode.value !== state.mode) {
            selectMode.value = state.mode;
        }
    }
    if (state.bwLow !== undefined) {
        stateBwLow.textContent = state.bwLow + ' Hz';
        if (document.activeElement !== inputBwLow) {
            inputBwLow.value = state.bwLow;
        }
    }
    if (state.bwHigh !== undefined) {
        stateBwHigh.textContent = state.bwHigh + ' Hz';
        if (document.activeElement !== inputBwHigh) {
            inputBwHigh.value = state.bwHigh;
        }
    }
}

// ── Controls enable/disable ────────────────────────────────────────────────────

function setControlsEnabled(enabled) {
    btnSetFreq.disabled = !enabled;
    btnSetMode.disabled = !enabled;
    btnSetBw.disabled   = !enabled;
    inputFreq.disabled  = !enabled;
    selectMode.disabled = !enabled;
    inputBwLow.disabled = !enabled;
    inputBwHigh.disabled = !enabled;
    stepButtons.forEach(b => b.disabled = !enabled);
}

// ── Command senders ────────────────────────────────────────────────────────────

function sendCommand(command) {
    browser.runtime.sendMessage({ type: 'popup:command', command }).catch((err) => {
        setStatus('Failed to send command: ' + err.message, 'error');
    });
}

// ── Frequency ─────────────────────────────────────────────────────────────────

btnSetFreq.addEventListener('click', () => {
    const hz = parseInt(inputFreq.value, 10);
    if (isNaN(hz) || hz < 10000 || hz > 30000000) {
        inputFreq.classList.add('error');
        setStatus('Frequency must be between 10 kHz and 30 MHz', 'error');
        return;
    }
    inputFreq.classList.remove('error');
    sendCommand({ type: 'cmd:set_freq', freq: hz });
    setStatus(`Set frequency → ${formatHz(hz)}`, 'ok');
});

inputFreq.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSetFreq.click();
});

stepButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const delta = parseInt(btn.dataset.delta, 10);
        sendCommand({ type: 'cmd:adjust_freq', delta });
        const sign = delta > 0 ? '+' : '';
        setStatus(`Adjust frequency ${sign}${formatHz(Math.abs(delta))}`, 'info');
    });
});

// ── Mode ──────────────────────────────────────────────────────────────────────

btnSetMode.addEventListener('click', () => {
    const mode = selectMode.value;
    if (!mode) {
        setStatus('Select a mode first', 'error');
        return;
    }
    sendCommand({ type: 'cmd:set_mode', mode });
    setStatus(`Set mode → ${mode.toUpperCase()}`, 'ok');
});

// ── Bandwidth ─────────────────────────────────────────────────────────────────

bwHeader.addEventListener('click', () => toggleCollapsible(bwBody, bwArrow));

btnSetBw.addEventListener('click', () => {
    const low  = parseInt(inputBwLow.value,  10);
    const high = parseInt(inputBwHigh.value, 10);
    if (isNaN(low) || isNaN(high)) {
        setStatus('Enter valid bandwidth values', 'error');
        return;
    }
    sendCommand({ type: 'cmd:set_bandwidth', low, high });
    setStatus(`Set bandwidth → ${low} / ${high} Hz`, 'ok');
});

// ── Bridge server ─────────────────────────────────────────────────────────────

bridgeHeader.addEventListener('click', () => toggleCollapsible(bridgeBody, bridgeArrow));

bridgeEnabled.addEventListener('change', () => {
    const enabled = bridgeEnabled.checked;
    updateBridgeUI(enabled);
    browser.runtime.sendMessage({
        type:    'popup:set_bridge',
        enabled: enabled,
        url:     inputBridgeUrl.value.trim() || 'http://localhost:7373',
        secret:  inputBridgeSec.value,
    }).catch(() => {});
});

btnSaveBridge.addEventListener('click', () => {
    const url    = inputBridgeUrl.value.trim() || 'http://localhost:7373';
    const secret = inputBridgeSec.value;
    browser.runtime.sendMessage({
        type:    'popup:set_bridge',
        enabled: bridgeEnabled.checked,
        url,
        secret,
    }).then(() => {
        setStatus('Bridge settings saved', 'ok');
    }).catch(() => {
        setStatus('Failed to save bridge settings', 'error');
    });
});

btnTestBridge.addEventListener('click', async () => {
    const url    = inputBridgeUrl.value.trim() || 'http://localhost:7373';
    const secret = inputBridgeSec.value;
    setStatus('Testing bridge connection…', 'info');
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (secret) headers['X-UberSDR-Secret'] = secret;
        const res = await fetch(`${url}/ubersdr/ping`, { method: 'GET', headers });
        if (res.ok) {
            bridgeDot.className       = 'bridge-dot connected';
            bridgeStatusTxt.textContent = 'Connected';
            setStatus('Bridge server reachable ✓', 'ok');
        } else {
            bridgeDot.className       = 'bridge-dot error';
            bridgeStatusTxt.textContent = `HTTP ${res.status}`;
            setStatus(`Bridge returned HTTP ${res.status}`, 'error');
        }
    } catch (err) {
        bridgeDot.className       = 'bridge-dot error';
        bridgeStatusTxt.textContent = 'Unreachable';
        setStatus('Bridge server not reachable', 'error');
    }
});

function updateBridgeUI(enabled) {
    if (enabled) {
        bridgeDot.className       = 'bridge-dot';
        bridgeStatusTxt.textContent = 'Enabled (not yet tested)';
    } else {
        bridgeDot.className       = 'bridge-dot';
        bridgeStatusTxt.textContent = 'Disabled';
    }
}

// ── Collapsible helper ─────────────────────────────────────────────────────────

function toggleCollapsible(body, arrow) {
    const isOpen = body.classList.toggle('open');
    arrow.classList.toggle('open', isOpen);
}

// ── Status bar ─────────────────────────────────────────────────────────────────

let statusTimer = null;

function setStatus(msg, type = '') {
    statusBar.textContent = msg;
    statusBar.className   = 'status-bar' + (type ? ' ' + type : '');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
        statusBar.textContent = 'Ready';
        statusBar.className   = 'status-bar';
    }, 4000);
}

// ── Frequency formatter ────────────────────────────────────────────────────────

function formatHz(hz) {
    if (hz >= 1000000) {
        return (hz / 1000000).toFixed(3) + ' MHz';
    } else if (hz >= 1000) {
        return (hz / 1000).toFixed(1) + ' kHz';
    }
    return hz + ' Hz';
}

// ── Listen for messages from background ───────────────────────────────────────
// Background pushes state updates and registry changes while the popup is open.

browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case 'registry:updated':
            renderTabList(msg.tabs, selectedTabId);
            break;

        case 'state:update':
        case 'state:snapshot':
            currentState = { ...(currentState || {}), ...msg.state };
            renderState(currentState);
            break;

        default:
            break;
    }
});

// ── Boot ───────────────────────────────────────────────────────────────────────

init();
