// UberSDR Bridge — Popup Script
'use strict';

// ── DOM refs ───────────────────────────────────────────────────────────────────

const tabList         = document.getElementById('tab-list');
const stateFreq       = document.getElementById('state-freq');
const stateMode       = document.getElementById('state-mode');
const stateBwLow      = document.getElementById('state-bw-low');
const stateBwHigh     = document.getElementById('state-bw-high');
const stateDbfs       = document.getElementById('state-dbfs');
const stateSnr        = document.getElementById('state-snr');
const signalBarFill   = document.getElementById('signal-bar-fill');

const btnMute         = document.getElementById('btn-mute');
const btnSync         = document.getElementById('btn-sync');
const btnPttMute      = document.getElementById('btn-ptt-mute');
const btnPower        = document.getElementById('btn-power');

const inputFreq       = document.getElementById('input-freq');
const btnSetFreq      = document.getElementById('btn-set-freq');
const stepButtons     = document.querySelectorAll('.step-btn');

const selectMode      = document.getElementById('select-mode');

const bwHeader        = document.getElementById('bw-header');
const bwArrow         = document.getElementById('bw-arrow');
const bwBody          = document.getElementById('bw-body');
const inputBwLow      = document.getElementById('input-bw-low');
const inputBwHigh     = document.getElementById('input-bw-high');
const btnSetBw        = document.getElementById('btn-set-bw');

const flrigHeader      = document.getElementById('flrig-header');
const flrigArrow       = document.getElementById('flrig-arrow');
const flrigBody        = document.getElementById('flrig-body');
const flrigEnabledCb   = document.getElementById('flrig-enabled');
const flrigDot         = document.getElementById('flrig-dot');
const flrigStatusTxt   = document.getElementById('flrig-status-text');
const flrigPttBadge    = document.getElementById('flrig-ptt-badge');
const flrigReadoutFreq = document.getElementById('flrig-readout-freq');
const flrigReadoutMode = document.getElementById('flrig-readout-mode');
const inputFlrigHost   = document.getElementById('input-flrig-host');
const inputFlrigPort   = document.getElementById('input-flrig-port');
const selectFlrigDir   = document.getElementById('select-flrig-dir');
const btnSaveFlrig     = document.getElementById('btn-save-flrig');
const btnTestFlrig     = document.getElementById('btn-test-flrig');

const profilesHeader   = document.getElementById('profiles-header');
const profilesArrow    = document.getElementById('profiles-arrow');
const profilesBody     = document.getElementById('profiles-body');
const inputProfileName = document.getElementById('input-profile-name');
const btnSaveProfile   = document.getElementById('btn-save-profile');
const profileList      = document.getElementById('profile-list');

const statusBar       = document.getElementById('status-bar');

const selectInstance   = document.getElementById('select-instance');
const instanceInfo     = document.getElementById('instance-info');

const modalBackdrop   = document.getElementById('modal-backdrop');
const modalTitle      = document.getElementById('modal-title');
const modalBody       = document.getElementById('modal-body');
const modalConfirm    = document.getElementById('modal-confirm');
const modalAdd        = document.getElementById('modal-add');
const modalCancel     = document.getElementById('modal-cancel');

// ── Local state ────────────────────────────────────────────────────────────────

let currentState = null;   // Last known radio state { freq, mode, bwLow, bwHigh }
let selectedTabId = null;
let isMuted = false;
let isSyncEnabled    = false;  // mirrors background flrigEnabled (default: disabled)
let isPluginEnabled  = true;   // mirrors background pluginEnabled
let isPttMuteEnabled = false;  // mirrors background pttMuteEnabled
let isPttActive      = false;  // current PTT state from flrig
let publicInstances  = [];     // Cached list from instances.ubersdr.org

// ── Confirm modal ──────────────────────────────────────────────────────────────

function showConfirmModal(title, body, onConfirm) {
    modalTitle.textContent = title;
    modalBody.textContent  = body;
    modalBackdrop.classList.add('open');

    function cleanup() {
        modalBackdrop.classList.remove('open');
        modalConfirm.removeEventListener('click', onYes);
        modalCancel.removeEventListener('click', onNo);
        modalBackdrop.removeEventListener('click', onBackdrop);
    }
    function onYes()      { cleanup(); onConfirm(true);  }
    function onNo()       { cleanup(); onConfirm(false); }
    function onBackdrop(e) { if (e.target === modalBackdrop) { cleanup(); onConfirm(false); } }

    modalConfirm.addEventListener('click', onYes);
    modalCancel.addEventListener('click', onNo);
    modalBackdrop.addEventListener('click', onBackdrop);
}

// ── Instance open modal (Replace / Add / Cancel) ───────────────────────────────

// choice: 'replace' | 'add' | 'cancel'
function showInstanceModal(title, body, onChoice) {
    modalTitle.textContent = title;
    modalBody.textContent  = body;
    modalBackdrop.classList.add('open');

    function cleanup() {
        modalBackdrop.classList.remove('open');
        modalConfirm.removeEventListener('click', onReplace);
        modalAdd.removeEventListener('click', onAdd);
        modalCancel.removeEventListener('click', onCancel);
        modalBackdrop.removeEventListener('click', onBackdrop);
    }
    function onReplace()    { cleanup(); onChoice('replace'); }
    function onAdd()        { cleanup(); onChoice('add');     }
    function onCancel()     { cleanup(); onChoice('cancel');  }
    function onBackdrop(e)  { if (e.target === modalBackdrop) { cleanup(); onChoice('cancel'); } }

    modalConfirm.addEventListener('click', onReplace);
    modalAdd.addEventListener('click', onAdd);
    modalCancel.addEventListener('click', onCancel);
    modalBackdrop.addEventListener('click', onBackdrop);
}

// ── Instance browser (local probe + public API) ────────────────────────────────
//
// Local instances announce themselves via Avahi as ubersdr.local:8080.
// We probe GET http://ubersdr.local:8080/api/description — if it responds we
// prepend a "📡 Local" entry above the public list.
//
// Both fetches run independently so neither blocks the other.

const INSTANCES_API      = 'https://instances.ubersdr.org/api/instances?online_only=true';
const LOCAL_PROBE_URL    = 'http://ubersdr.local:8080/api/description';
const LOCAL_PROBE_TIMEOUT_MS = 2000;

// Normalise a /api/description response into the same shape as a public instance
// entry so the rest of the code can treat them identically.
function descriptionToInstance(desc) {
    const rec = desc.receiver || {};
    return {
        // Mark as local so we can distinguish it in the dropdown value.
        __local:           true,
        callsign:          rec.callsign  || 'Local',
        name:              rec.name      || 'Local UberSDR',
        location:          rec.location  || '',
        available_clients: desc.available_clients != null ? desc.available_clients : 1,
        max_clients:       desc.max_clients       != null ? desc.max_clients       : 1,
        // Use the public_url from the description if present, otherwise fall back
        // to the probe origin so the tab actually opens the right page.
        public_url:        (rec.public_url && rec.public_url.startsWith('http'))
                               ? rec.public_url
                               : 'http://ubersdr.local:8080/',
    };
}

// Cached local instance (null = not found / not yet probed).
let localInstance = null;

async function probeLocalInstance() {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);
        const res = await fetch(LOCAL_PROBE_URL, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const desc = await res.json();
        localInstance = descriptionToInstance(desc);
    } catch (_) {
        localInstance = null;
    }
    // Repopulate the dropdown with whatever we now know (local + public).
    populateInstanceDropdown();
}

async function fetchPublicInstances() {
    // Don't disable or wipe the select — that would prevent the dropdown from opening.
    // Just fetch silently and update the options once the response arrives.
    try {
        const res = await fetch(INSTANCES_API);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        publicInstances = (data.instances || []).sort((a, b) => {
            const ka = (a.callsign || a.name || '').toUpperCase();
            const kb = (b.callsign || b.name || '').toUpperCase();
            return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
        populateInstanceDropdown();
        setStatus(`Loaded ${publicInstances.length} public instances`, 'ok');
    } catch (err) {
        if (publicInstances.length === 0 && !localInstance) {
            selectInstance.innerHTML = '<option value="">— failed to load —</option>';
        }
        setStatus('Failed to load instances: ' + err.message, 'error');
    }
}

// Kick off both fetches in parallel — neither waits for the other.
function fetchAllInstances() {
    probeLocalInstance();   // fast (2 s timeout), updates dropdown when done
    fetchPublicInstances(); // may take longer, also updates dropdown when done
}

function populateInstanceDropdown() {
    // Preserve the current selection so rebuilding the list doesn't reset it.
    const prevValue = selectInstance.value;

    selectInstance.innerHTML = '<option value="">— select an instance —</option>';

    // Local instance first (if found), with a separator.
    if (localInstance) {
        const optGroup = document.createElement('optgroup');
        optGroup.label = '📡 Local';
        const opt = document.createElement('option');
        opt.value = '__local__';
        const slots = `${localInstance.available_clients}/${localInstance.max_clients}`;
        const loc   = localInstance.location ? ` — ${localInstance.location}` : '';
        opt.textContent = `${localInstance.callsign || localInstance.name}${loc} (${slots})`;
        if (localInstance.available_clients === 0) opt.textContent += ' ●';
        optGroup.appendChild(opt);
        selectInstance.appendChild(optGroup);
    }

    // Public instances below.
    if (publicInstances.length > 0) {
        const optGroup = document.createElement('optgroup');
        optGroup.label = '🌐 Public';
        publicInstances.forEach((inst, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            const slots = `${inst.available_clients}/${inst.max_clients}`;
            const loc = inst.location ? ` — ${inst.location}` : '';
            opt.textContent = `${inst.callsign || inst.name}${loc} (${slots})`;
            if (inst.available_clients === 0) opt.textContent += ' ●';
            optGroup.appendChild(opt);
        });
        selectInstance.appendChild(optGroup);
    }

    // Restore previous selection if it still exists.
    if (prevValue && selectInstance.querySelector(`option[value="${prevValue}"]`)) {
        selectInstance.value = prevValue;
    }
}

selectInstance.addEventListener('change', () => {
    const val = selectInstance.value;
    if (val === '') {
        instanceInfo.textContent = '';
        instanceInfo.className = 'instance-info';
        return;
    }

    // Resolve the selected instance object.
    let inst;
    if (val === '__local__') {
        inst = localInstance;
    } else {
        inst = publicInstances[parseInt(val, 10)];
    }
    if (!inst) return;

    const avail = inst.available_clients;
    const max   = inst.max_clients;
    const label = inst.callsign || inst.name;
    instanceInfo.textContent = `${inst.name} · ${avail}/${max} slots · ${inst.public_url}`;
    instanceInfo.className   = 'instance-info ' + (avail > 0 ? 'available' : 'full');

    const hasCurrentTab = !!selectedTabId;

    const activateTab = (tab) => {
        browser.runtime.sendMessage({ type: 'popup:pending_select', tabId: tab.id }).catch(() => {});
        browser.tabs.update(tab.id, { active: true }).catch(() => {});
    };

    const resetDropdown = () => {
        selectInstance.value = '';
        instanceInfo.textContent = '';
        instanceInfo.className = 'instance-info';
    };

    // No existing UberSDR tab — just open directly, no modal needed.
    if (!hasCurrentTab) {
        browser.tabs.create({ url: inst.public_url, active: true }).then(activateTab);
        resetDropdown();
        setStatus(`Opening ${label}…`, 'info');
        return;
    }

    // There is an existing tab — ask whether to replace it or add a new one.
    showInstanceModal(
        `Open "${label}"?`,
        `Replace: navigate the current UberSDR tab to ${inst.public_url}\nAdd: open in a new tab`,
        (choice) => {
            if (choice === 'cancel') { resetDropdown(); return; }

            if (choice === 'replace') {
                browser.tabs.update(selectedTabId, { url: inst.public_url, active: true })
                    .then(activateTab)
                    .catch(() => {
                        browser.tabs.create({ url: inst.public_url, active: true }).then(activateTab);
                    });
            } else {
                // 'add' — open in a new tab alongside the existing one
                browser.tabs.create({ url: inst.public_url, active: true }).then(activateTab);
            }

            resetDropdown();
            setStatus(`Opening ${label}…`, 'info');
        }
    );
});

// Fetch fresh list when the user focuses the dropdown (once per focus, before it opens).
selectInstance.addEventListener('focus', () => {
    fetchAllInstances();
});

// ── Initialise ─────────────────────────────────────────────────────────────────

async function init() {
    // Ask background for the current registry and state.
    try {
        const resp = await browser.runtime.sendMessage({ type: 'popup:get_registry' });
        if (resp) {
            renderTabList(resp.tabs, resp.selectedTabId);
            selectedTabId = resp.selectedTabId;
            // Only restore last state if there are actually tabs registered —
            // otherwise renderTabList already cleared the display via renderState(null)
            // and we must not re-populate it with stale values.
            if (resp.lastState && resp.tabs && resp.tabs.length > 0) {
                currentState = resp.lastState;
                renderState(resp.lastState);
            }
            // Restore flrig UI
            if (resp.flrigHost)      inputFlrigHost.value  = resp.flrigHost;
            if (resp.flrigPort)      inputFlrigPort.value  = resp.flrigPort;
            if (resp.flrigDirection) selectFlrigDir.value  = resp.flrigDirection;
            if (resp.flrigEnabled !== undefined) {
                flrigEnabledCb.checked = resp.flrigEnabled;
                updateFlrigUI(resp.flrigEnabled, resp.flrigConnected);
            }
            // Restore header button states
            if (resp.flrigEnabled    !== undefined) setSyncButtonState(resp.flrigEnabled);
            if (resp.pluginEnabled   !== undefined) setPluginButtonState(resp.pluginEnabled);
            if (resp.pttMuteEnabled  !== undefined) setPttMuteButtonState(resp.pttMuteEnabled);
            if (resp.pttActive       !== undefined) updatePttDisplay(resp.pttActive);
        }
    } catch (err) {
        setStatus('Background not ready — try reopening the popup.', 'error');
    }
}

// ── Tab list rendering ─────────────────────────────────────────────────────────
// Uses a diff-style update: existing DOM nodes are patched in-place rather than
// destroyed and recreated.  This prevents click events being swallowed when a
// registry:updated message arrives mid-click (which caused the "have to click
// multiple times" / flickering bug).

function buildTabItem(tab, activeTabId, multiTab) {
    const item = document.createElement('div');
    item.className = 'tab-item' + (tab.tabId === activeTabId ? ' selected' : '');
    item.dataset.tabId = tab.tabId;

    const info = document.createElement('div');
    info.className = 'tab-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'tab-title-row';

    const title = document.createElement('div');
    title.className   = 'tab-title';
    title.textContent = tab.title || 'UberSDR';
    titleRow.appendChild(title);

    if (tab.audioStarted === false) {
        const badge = document.createElement('span');
        badge.className   = 'tab-waiting-badge';
        badge.title       = 'Waiting for play — SDR→rig sync paused until audio starts';
        badge.textContent = '⏸ waiting';
        titleRow.appendChild(badge);
    }

    const url = document.createElement('div');
    url.className   = 'tab-url';
    url.textContent = tab.url;

    info.appendChild(titleRow);
    info.appendChild(url);
    item.appendChild(info);

    if (multiTab) {
        item.appendChild(buildVfoSelect(tab));
    }

    // Close button — closes the browser tab entirely.
    const closeBtn = document.createElement('button');
    closeBtn.className   = 'tab-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title       = 'Close this tab';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        browser.tabs.remove(tab.tabId).catch(() => {});
    });
    item.appendChild(closeBtn);

    item.addEventListener('click', (e) => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
        if (e.target.classList.contains('tab-close-btn')) return;
        selectTab(tab.tabId);
    });

    return item;
}

function buildVfoSelect(tab) {
    const vfoSel = document.createElement('select');
    vfoSel.className = 'vfo-select';
    vfoSel.title     = 'Assign VFO (— = unassigned)';
    [{ val: '', label: '—' }, { val: 'A', label: 'A' }, { val: 'B', label: 'B' }].forEach(({ val, label }) => {
        const opt = document.createElement('option');
        opt.value       = val;
        opt.textContent = label;
        opt.selected    = (tab.vfo == null ? '' : tab.vfo) === val;
        vfoSel.appendChild(opt);
    });
    vfoSel.addEventListener('change', (e) => {
        e.stopPropagation();
        const raw = e.target.value;
        browser.runtime.sendMessage({
            type:  'popup:set_tab_vfo',
            tabId: tab.tabId,
            vfo:   raw === '' ? null : raw,
        }).catch(() => {});
    });
    return vfoSel;
}

function patchTabItem(item, tab, activeTabId, multiTab) {
    // Selected highlight
    const isSelected = tab.tabId === activeTabId;
    item.classList.toggle('selected', isSelected);

    // Title text
    const titleEl = item.querySelector('.tab-title');
    if (titleEl) titleEl.textContent = tab.title || 'UberSDR';

    // Waiting badge — add if missing and needed, remove if no longer needed
    const titleRow = item.querySelector('.tab-title-row');
    if (titleRow) {
        let badge = titleRow.querySelector('.tab-waiting-badge');
        if (tab.audioStarted === false) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className   = 'tab-waiting-badge';
                badge.title       = 'Waiting for play — SDR→rig sync paused until audio starts';
                badge.textContent = '⏸ waiting';
                titleRow.appendChild(badge);
            }
        } else {
            if (badge) badge.remove();
        }
    }

    // VFO select — add if now multiTab and missing; remove if no longer multiTab;
    // update value if already present (but only when not focused to avoid disrupting
    // an open dropdown).
    let vfoSel = item.querySelector('.vfo-select');
    if (multiTab) {
        if (!vfoSel) {
            // Insert before the close button so order is: info · vfo · close
            const closeBtn = item.querySelector('.tab-close-btn');
            item.insertBefore(buildVfoSelect(tab), closeBtn || null);
        } else if (document.activeElement !== vfoSel) {
            const desired = tab.vfo == null ? '' : tab.vfo;
            if (vfoSel.value !== desired) vfoSel.value = desired;
        }
    } else {
        if (vfoSel) vfoSel.remove();
    }

    // Close button — ensure it exists (should always be present after buildTabItem).
    if (!item.querySelector('.tab-close-btn')) {
        const closeBtn = document.createElement('button');
        closeBtn.className   = 'tab-close-btn';
        closeBtn.textContent = '✕';
        closeBtn.title       = 'Close this tab';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            browser.tabs.remove(tab.tabId).catch(() => {});
        });
        item.appendChild(closeBtn);
    }
}

function renderTabList(tabs, activeTabId) {
    if (!tabs || tabs.length === 0) {
        tabList.innerHTML = '<div class="no-tabs">No UberSDR tabs detected.<br>Open an UberSDR page to begin.</div>';
        setControlsEnabled(false);
        // Clear stale state display when no tabs are registered.
        currentState = null;
        selectedTabId = null;
        renderState(null);
        return;
    }

    setControlsEnabled(true);

    // Remove the "no tabs" placeholder if present.
    const noTabs = tabList.querySelector('.no-tabs');
    if (noTabs) noTabs.remove();

    const multiTab = tabs.length > 1;

    // Build a set of incoming tabIds for fast lookup.
    const incomingIds = new Set(tabs.map(t => t.tabId));

    // Remove DOM rows for tabs that are no longer in the registry.
    for (const existing of Array.from(tabList.querySelectorAll('.tab-item'))) {
        if (!incomingIds.has(Number(existing.dataset.tabId))) {
            existing.remove();
        }
    }

    // Add or patch each incoming tab in order.
    tabs.forEach((tab, idx) => {
        const existingItem = tabList.querySelector(`.tab-item[data-tab-id="${tab.tabId}"]`);
        if (existingItem) {
            // Patch in-place — no DOM destruction, no event-listener loss.
            patchTabItem(existingItem, tab, activeTabId, multiTab);
            // Ensure correct DOM order (tabs may have been reordered).
            const children = tabList.children;
            if (children[idx] !== existingItem) {
                tabList.insertBefore(existingItem, children[idx] || null);
            }
        } else {
            // New tab — build and insert at the correct position.
            const newItem = buildTabItem(tab, activeTabId, multiTab);
            const children = tabList.children;
            tabList.insertBefore(newItem, children[idx] || null);
        }
    });
}

function selectTab(tabId) {
    selectedTabId = tabId;
    browser.runtime.sendMessage({ type: 'popup:select_tab', tabId }).catch(() => {});
    setStatus(`Switched to tab ${tabId}`, 'info');
    // Don't clear state here — background will immediately push the cached
    // lastState for the new tab, followed by a fresh snapshot.
}

// ── State rendering ────────────────────────────────────────────────────────────

function renderState(state) {
    if (!state) {
        stateFreq.textContent   = '—';
        stateMode.textContent   = '—';
        stateBwLow.textContent  = '—';
        stateBwHigh.textContent = '—';
        stateDbfs.textContent   = '—';
        stateSnr.textContent    = '—';
        signalBarFill.style.width = '0%';
        signalBarFill.className = 'signal-bar-fill';
        return;
    }

    if (state.freq !== undefined) {
        stateFreq.textContent = formatHz(state.freq);
        // Pre-fill the frequency input in kHz, always showing 3 decimal places
        // so the user can see and edit down to 1 Hz resolution.
        if (document.activeElement !== inputFreq) {
            inputFreq.value = (state.freq / 1000).toFixed(3);
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
    if (state.dbfs !== undefined) {
        stateDbfs.textContent = state.dbfs.toFixed(1) + ' dBFS';
        // Non-linear mapping identical to signal-meter.js:
        //   -120 to -80 dBFS → 0–40%
        //   -80  to -60 dBFS → 40–80%
        //   -60  to -20 dBFS → 80–100%
        let pct;
        if (state.dbfs < -80) {
            pct = ((state.dbfs + 120) / 40) * 40;
        } else if (state.dbfs < -60) {
            pct = 40 + ((state.dbfs + 80) / 20) * 40;
        } else {
            pct = 80 + ((state.dbfs + 60) / 40) * 20;
        }
        pct = Math.max(0, Math.min(100, pct));
        signalBarFill.style.width = pct + '%';
        // Colour thresholds identical to signal-meter.js
        signalBarFill.className = 'signal-bar-fill ' + (
            state.dbfs >= -70 ? 'sig-strong' :
            state.dbfs >= -85 ? 'sig-medium' : 'sig-weak'
        );
    }
    if (state.snr !== undefined) {
        stateSnr.textContent = state.snr !== null
            ? state.snr.toFixed(1) + ' dB'
            : '—';
    }
    if (state.muted !== undefined && state.muted !== isMuted) {
        isMuted = state.muted;
        btnMute.textContent = isMuted ? '🔇' : '🔊';
        btnMute.classList.toggle('muted', isMuted);
        btnMute.title = isMuted ? 'Unmute' : 'Mute';
    }
}

// ── Controls enable/disable ────────────────────────────────────────────────────

function setControlsEnabled(enabled) {
    btnSetFreq.disabled = !enabled;
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
    const khz = parseFloat(inputFreq.value);
    if (isNaN(khz) || khz < 10 || khz > 30000) {
        inputFreq.classList.add('error');
        setStatus('Frequency must be between 10 kHz and 30 MHz', 'error');
        return;
    }
    const hz = Math.round(khz * 1000);
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

// ── Mute ──────────────────────────────────────────────────────────────────────

btnMute.addEventListener('click', () => {
    isMuted = !isMuted;
    btnMute.textContent = isMuted ? '🔇' : '🔊';
    btnMute.classList.toggle('muted', isMuted);
    btnMute.title = isMuted ? 'Unmute' : 'Mute';
    // Use tab-level mute (browser mixer) — same mechanism as PTT-mute and
    // multi-tab muting — for instant, consistent behaviour.
    browser.runtime.sendMessage({ type: 'popup:set_tab_mute', muted: isMuted }).catch(() => {});
    setStatus(isMuted ? 'Muted' : 'Unmuted', 'info');
});

// ── Sync toggle (header shortcut for flrig enabled) ───────────────────────────

function setSyncButtonState(enabled) {
    isSyncEnabled = enabled;
    btnSync.classList.toggle('sync-on', enabled);
    btnSync.classList.toggle('sync-off', !enabled);
    btnSync.title = enabled ? 'flrig sync ON — click to disable' : 'flrig sync OFF — click to enable';
}

btnSync.addEventListener('click', () => {
    const newEnabled = !isSyncEnabled;
    setSyncButtonState(newEnabled);
    // Keep the checkbox in the flrig section in sync.
    flrigEnabledCb.checked = newEnabled;
    updateFlrigUI(newEnabled, false);
    saveFlrigSettings(newEnabled);
    setStatus(newEnabled ? 'flrig sync enabled' : 'flrig sync disabled', 'info');
});

// ── PTT-mute toggle ────────────────────────────────────────────────────────────

function setPttMuteButtonState(enabled) {
    isPttMuteEnabled = enabled;
    btnPttMute.classList.toggle('ptt-mute-on',  enabled);
    btnPttMute.classList.toggle('ptt-mute-off', !enabled);
    btnPttMute.title = enabled
        ? 'PTT-mute ON — SDR mutes while transmitting (click to disable)'
        : 'PTT-mute OFF — SDR stays live during TX (click to enable)';
}

function updatePttDisplay(active) {
    isPttActive = active;
    // Badge in flrig section — always visible, switches between RX (green) and TX (red+pulse)
    if (flrigPttBadge) {
        flrigPttBadge.textContent = active ? 'TX' : 'RX';
        flrigPttBadge.classList.toggle('tx', active);
        flrigPttBadge.classList.toggle('rx', !active);
    }
    // Header button gets extra pulse class when actively transmitting
    btnPttMute.classList.toggle('ptt-active', active && isPttMuteEnabled);
}

btnPttMute.addEventListener('click', () => {
    const newEnabled = !isPttMuteEnabled;
    setPttMuteButtonState(newEnabled);
    browser.runtime.sendMessage({ type: 'popup:set_ptt_mute_enabled', enabled: newEnabled }).catch(() => {});
    setStatus(newEnabled ? 'PTT-mute enabled' : 'PTT-mute disabled', newEnabled ? 'ok' : 'info');
});

// ── Power toggle (enable / disable the entire plugin) ─────────────────────────

function setPluginButtonState(enabled) {
    isPluginEnabled = enabled;
    btnPower.classList.toggle('power-on', enabled);
    btnPower.classList.toggle('power-off', !enabled);
    btnPower.title = enabled ? 'Plugin ON — click to disable' : 'Plugin OFF — click to enable';
}

btnPower.addEventListener('click', () => {
    const newEnabled = !isPluginEnabled;
    setPluginButtonState(newEnabled);
    browser.runtime.sendMessage({ type: 'popup:set_plugin_enabled', enabled: newEnabled }).catch(() => {});
    setStatus(newEnabled ? 'Plugin enabled' : 'Plugin disabled', newEnabled ? 'ok' : 'error');
});

// ── Mode ──────────────────────────────────────────────────────────────────────

selectMode.addEventListener('change', () => {
    const mode = selectMode.value;
    if (!mode) return;
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

// ── flrig sync ────────────────────────────────────────────────────────────────

flrigHeader.addEventListener('click', () => toggleCollapsible(flrigBody, flrigArrow));

flrigEnabledCb.addEventListener('change', () => {
    const enabled = flrigEnabledCb.checked;
    setSyncButtonState(enabled);
    updateFlrigUI(enabled, false);
    saveFlrigSettings(enabled);
});

btnSaveFlrig.addEventListener('click', () => {
    saveFlrigSettings(flrigEnabledCb.checked);
    setStatus('flrig settings saved', 'ok');
});

btnTestFlrig.addEventListener('click', async () => {
    const host = inputFlrigHost.value.trim() || '127.0.0.1';
    const port = parseInt(inputFlrigPort.value, 10) || 12345;
    setStatus('Testing flrig connection…', 'info');
    try {
        // Send a test XML-RPC call directly from the popup (same origin rules apply
        // since we have host permission via manifest).
        const body = `<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params></params></methodCall>`;
        const res = await fetch(`http://${host}:${port}/RPC2`, {
            method:  'POST',
            headers: { 'Content-Type': 'text/xml' },
            body,
        });
        if (res.ok) {
            flrigDot.className       = 'flrig-dot connected';
            flrigStatusTxt.textContent = 'Connected';
            setStatus('flrig reachable ✓', 'ok');
        } else {
            flrigDot.className       = 'flrig-dot error';
            flrigStatusTxt.textContent = `HTTP ${res.status}`;
            setStatus(`flrig returned HTTP ${res.status}`, 'error');
        }
    } catch (err) {
        flrigDot.className       = 'flrig-dot error';
        flrigStatusTxt.textContent = 'Unreachable';
        setStatus('flrig not reachable: ' + err.message, 'error');
    }
});

function saveFlrigSettings(enabled) {
    browser.runtime.sendMessage({
        type:      'popup:set_flrig',
        enabled:   enabled,
        host:      inputFlrigHost.value.trim() || '127.0.0.1',
        port:      parseInt(inputFlrigPort.value, 10) || 12345,
        direction: selectFlrigDir.value,
    }).catch(() => {});
}

function updateFlrigUI(enabled, connected) {
    if (!enabled) {
        flrigDot.className         = 'flrig-dot';
        flrigStatusTxt.textContent = 'Disabled';
        // Hide PTT badge when flrig is disabled
        if (flrigPttBadge) flrigPttBadge.style.display = 'none';
    } else if (connected) {
        flrigDot.className         = 'flrig-dot connected';
        flrigStatusTxt.textContent = 'Connected';
        // Show PTT badge when connected
        if (flrigPttBadge) flrigPttBadge.style.display = '';
    } else {
        flrigDot.className         = 'flrig-dot';
        flrigStatusTxt.textContent = 'Connecting…';
        // Show PTT badge (as RX) even while connecting — it will update on first poll
        if (flrigPttBadge) flrigPttBadge.style.display = '';
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
    const n = Number(hz);
    if (!isFinite(n) || isNaN(n)) return '—';
    if (n >= 1000000) {
        // 3 decimal places = 1 kHz resolution at MHz scale
        // Strip trailing zeros after decimal for cleaner display
        return (n / 1000000).toFixed(6).replace(/\.?0+$/, '') + ' MHz';
    } else if (n >= 1000) {
        // 3 decimal places = 1 Hz resolution at kHz scale
        return (n / 1000).toFixed(3).replace(/\.?0+$/, '') + ' kHz';
    }
    return n + ' Hz';
}

// ── Listen for messages from background ───────────────────────────────────────
// Background pushes state updates and registry changes while the popup is open.

browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case 'registry:updated':
            // Background always includes the authoritative selectedTabId.
            if (msg.selectedTabId !== undefined) selectedTabId = msg.selectedTabId;
            // Don't rebuild the tab list while the user has a VFO dropdown open —
            // doing so would destroy the open <select> mid-interaction.
            if (document.activeElement && document.activeElement.classList.contains('vfo-select')) break;
            renderTabList(msg.tabs, selectedTabId);
            break;

        case 'state:update':
        case 'state:snapshot':
            currentState = { ...(currentState || {}), ...msg.state };
            renderState(currentState);
            break;

        case 'flrig:status':
            updateFlrigUI(flrigEnabledCb.checked, msg.connected);
            if (msg.message) {
                flrigStatusTxt.textContent = msg.message;
            }
            break;

        case 'flrig:state':
            if (msg.freq !== undefined && flrigReadoutFreq) {
                flrigReadoutFreq.textContent = formatHz(msg.freq);
            }
            if (msg.mode !== undefined && flrigReadoutMode) {
                const vfoLabel = msg.vfo ? ` [${msg.vfo}]` : '';
                flrigReadoutMode.textContent = msg.mode + vfoLabel;
            }
            if (msg.ptt !== undefined) {
                updatePttDisplay(msg.ptt);
            }
            break;

        case 'ptt:status':
            updatePttDisplay(!!msg.active);
            break;

        case 'vfo:switched':
            // flrig switched VFO — background also sends registry:updated which
            // re-renders the tab list; just update local selectedTabId and status.
            if (msg.tabId) selectedTabId = msg.tabId;
            setStatus(`flrig switched to VFO ${msg.vfo}`, 'info');
            break;

        default:
            break;
    }
});

// ── Profiles ───────────────────────────────────────────────────────────────────

profilesHeader.addEventListener('click', () => toggleCollapsible(profilesBody, profilesArrow));

function renderProfileList(profiles) {
    profileList.innerHTML = '';
    const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'profile-no-saved';
        empty.textContent = 'No saved profiles yet.';
        profileList.appendChild(empty);
        return;
    }
    names.forEach(name => {
        const p = profiles[name];
        const item = document.createElement('div');
        item.className = 'profile-item';

        const nameEl = document.createElement('div');
        nameEl.className = 'profile-name';
        nameEl.textContent = name;
        nameEl.title = name;

        const meta = document.createElement('div');
        meta.className = 'profile-meta';
        const instCount = (p.instances || []).length;
        const date = p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '';
        meta.textContent = `${instCount} inst${instCount !== 1 ? 's' : ''}${date ? ' · ' + date : ''}`;

        const actions = document.createElement('div');
        actions.className = 'profile-actions';

        const btnLoad = document.createElement('button');
        btnLoad.className = 'btn btn-primary btn-sm';
        btnLoad.textContent = 'Load';
        btnLoad.title = `Load profile "${name}"`;
        btnLoad.addEventListener('click', () => loadProfile(name));

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-secondary btn-sm';
        btnDel.textContent = '✕';
        btnDel.title = `Delete profile "${name}"`;
        btnDel.addEventListener('click', () => deleteProfile(name));

        actions.appendChild(btnLoad);
        actions.appendChild(btnDel);

        item.appendChild(nameEl);
        item.appendChild(meta);
        item.appendChild(actions);
        profileList.appendChild(item);
    });
}

async function fetchAndRenderProfiles() {
    try {
        const resp = await browser.runtime.sendMessage({ type: 'popup:get_profiles' });
        if (resp && resp.profiles) renderProfileList(resp.profiles);
    } catch (_) {}
}

btnSaveProfile.addEventListener('click', async () => {
    const name = inputProfileName.value.trim();
    if (!name) {
        inputProfileName.classList.add('error');
        setStatus('Enter a profile name', 'error');
        return;
    }
    inputProfileName.classList.remove('error');
    try {
        const resp = await browser.runtime.sendMessage({ type: 'popup:save_profile', name });
        if (resp && resp.ok) {
            renderProfileList(resp.profiles);
            inputProfileName.value = '';
            setStatus(`Profile "${name}" saved`, 'ok');
        }
    } catch (err) {
        setStatus('Failed to save profile: ' + err.message, 'error');
    }
});

inputProfileName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSaveProfile.click();
});

async function loadProfile(name) {
    try {
        const resp = await browser.runtime.sendMessage({ type: 'popup:load_profile', name });
        if (resp && resp.ok) {
            setStatus(`Profile "${name}" loaded`, 'ok');
        } else {
            setStatus(`Failed to load profile "${name}"`, 'error');
        }
    } catch (err) {
        setStatus('Failed to load profile: ' + err.message, 'error');
    }
}

async function deleteProfile(name) {
    showConfirmModal(
        `Delete "${name}"?`,
        `This will permanently remove the profile "${name}".`,
        async (confirmed) => {
            if (!confirmed) return;
            try {
                const resp = await browser.runtime.sendMessage({ type: 'popup:delete_profile', name });
                if (resp && resp.ok) {
                    renderProfileList(resp.profiles);
                    setStatus(`Profile "${name}" deleted`, 'info');
                }
            } catch (err) {
                setStatus('Failed to delete profile: ' + err.message, 'error');
            }
        }
    );
}

// ── Boot ───────────────────────────────────────────────────────────────────────

// Apply default visual states immediately (before async init response arrives).
setSyncButtonState(isSyncEnabled);
setPluginButtonState(isPluginEnabled);
setPttMuteButtonState(isPttMuteEnabled);

init();
fetchAndRenderProfiles();
