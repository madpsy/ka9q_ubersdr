// UberSDR Bridge — Background Script (Service Worker, Manifest V3)
//
// Responsibilities:
//   1. Maintain a registry of UberSDR tabs (registered by content_script.js)
//   2. Track which tab the user has selected as the "active" target
//   3. Relay commands from the popup to the selected tab's content script
//   4. Relay state updates from content scripts to the popup (if open)
//   5. Sync frequency/mode with flrig via XML-RPC (bidirectional, configurable)
//
// MV3 / Service Worker notes:
//   - chrome.alarms is used for the flrig poll loop (survives SW sleep/wake).
//   - In-memory state is re-hydrated from chrome.storage.session on SW startup.
//   - chrome.storage.session persists for the browser session (cleared on browser
//     restart) and is fast enough for the registry and last-known state.

'use strict';

// ── browser shim (Chrome MV3 uses `chrome`, Firefox uses `browser`) ────────────
const browser = (typeof globalThis.browser !== 'undefined') ? globalThis.browser : chrome;

// ── Tab Registry ───────────────────────────────────────────────────────────────
// Map<tabId, { sessionId, url, title, lastState }>

const registry = new Map();

// The tabId the user has chosen to control (persisted in storage).
let selectedTabId = null;

// A tab that should become selected as soon as it registers (set when the popup
// navigates to a new public instance).
let pendingSelectTabId = null;

// Map<tabId, profileInstanceState> — state to apply to a tab once it registers
// after being opened by popup:load_profile.
const pendingProfileStates = new Map();

// Last known state of the selected tab (used to populate popup on open).
let lastKnownState = null;

// ── Plugin master switch ───────────────────────────────────────────────────────
// When false the extension ignores ubersdr:register messages and stops flrig
// polling — effectively going dormant without needing to be uninstalled.
let pluginEnabled  = true;

// ── flrig settings ─────────────────────────────────────────────────────────────
let flrigEnabled    = false;
let flrigHost       = '127.0.0.1';
let flrigPort       = 12345;
let flrigDirection  = 'both';   // 'sdr-to-rig' | 'rig-to-sdr' | 'both'
let flrigConnected  = false;

// PTT mute: when true, the selected SDR tab is muted while the rig is transmitting.
// Default ON — most users want the SDR muted during TX.
let pttMuteEnabled = true;
let _lastPtt       = false;   // last known PTT state (false = RX, true = TX)

// Active VFO in flrig ('A' or 'B'). Kept in sync with flrig via rig.get_AB polls.
let flrigActiveVfo = 'A';

// Echo prevention — two independent pairs so the two directions don't interfere.
// _lastFlrigFreq/Mode: last values READ from flrig; only push to SDR when changed.
// _lastSdrFreq/Mode:   last values SENT to flrig from SDR; skip if unchanged.
let _lastFlrigFreq = null;
let _lastFlrigMode = null;
let _lastSdrFreq   = null;
let _lastSdrMode   = null;

// Cooldown: after pushing SDR→rig, suppress rig→SDR for a short window to
// prevent the round-trip echo (SDR tunes → flrig updates → poll reads back → SDR tunes again).
const FLRIG_ECHO_COOLDOWN_MS = 2000;
let _sdrToRigLastPushTime = 0;

// Debounce for SDR→rig pushes: accumulate rapid freq/mode changes (e.g. page
// load burst, user dragging) and only push to flrig once things settle.
const SDR_TO_RIG_DEBOUNCE_MS = 150;
let _sdrToRigDebounceTimer = null;
let _pendingSdrFreq = null;
let _pendingSdrMode = null;

// ── Alarm names ────────────────────────────────────────────────────────────────
// MV3 service workers can be killed by Chrome at any time. chrome.alarms survive
// SW restarts and re-wake the SW when they fire.
const ALARM_FLRIG_POLL      = 'flrig_poll';
const ALARM_FLRIG_RECONNECT = 'flrig_reconnect';

// Minimum alarm period Chrome allows is 1 minute for persistent alarms.
// For sub-minute polling we use a self-scheduling approach: the alarm fires once
// per minute as a keepalive/reconnect check, while the actual 100ms poll loop
// runs via setTimeout chains that are re-started each time the SW wakes.
// This is the standard MV3 pattern for high-frequency polling.

// ── Restore persisted settings on startup ─────────────────────────────────────

async function restoreState() {
    const stored = await chrome.storage.local.get([
        'selectedTabId', 'flrigEnabled', 'flrigHost', 'flrigPort', 'flrigDirection',
        'pluginEnabled', 'pttMuteEnabled', 'registrySnapshot', 'lastKnownState',
    ]);
    if (stored.selectedTabId   !== undefined) selectedTabId   = stored.selectedTabId;
    if (stored.flrigEnabled    !== undefined) flrigEnabled    = stored.flrigEnabled;
    if (stored.flrigHost       !== undefined) flrigHost       = stored.flrigHost;
    if (stored.flrigPort       !== undefined) flrigPort       = stored.flrigPort;
    if (stored.flrigDirection  !== undefined) flrigDirection  = stored.flrigDirection;
    if (stored.pluginEnabled   !== undefined) pluginEnabled   = stored.pluginEnabled;
    if (stored.pttMuteEnabled  !== undefined) pttMuteEnabled = stored.pttMuteEnabled;

    // Restore registry snapshot and last known state from local storage.
    // Using storage.local (not storage.session) because session storage requires
    // Chrome 102+ and may not be available; local storage always works and
    // survives the frequent SW sleep/wake cycles in MV3.
    if (stored.lastKnownState) lastKnownState = stored.lastKnownState;
    if (stored.registrySnapshot) {
        for (const entry of stored.registrySnapshot) {
            registry.set(entry.tabId, entry);
        }
    }

    // Re-start flrig polling if it was enabled.
    if (pluginEnabled && flrigEnabled) {
        await flrigConnect();
    }

    // Ask all open tabs to re-register. This handles the race where the SW was
    // killed (losing in-memory registry) and wakes up before the content scripts
    // have had a chance to re-send ubersdr:register. The stored registrySnapshot
    // gives us a best-effort list; content scripts will correct it on re-register.
    if (pluginEnabled) {
        chrome.tabs.query({}).then((tabs) => {
            for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, { type: 'cmd:reregister' }).catch(() => {});
            }
        }).catch(() => {});
    }
}

restoreState();

// Persist registry snapshot to local storage so it survives SW restarts.
// Using storage.local (not storage.session) because session storage requires
// Chrome 102+ and may not be available; local storage always works and
// survives the frequent SW sleep/wake cycles in MV3.
async function persistSession() {
    await chrome.storage.local.set({
        registrySnapshot: Array.from(registry.values()),
        lastKnownState,
    });
}

// ── Profiles ───────────────────────────────────────────────────────────────────
// Profiles are stored as an object keyed by profile name in storage.local under
// the key 'profiles'.  Each profile value is:
//   {
//     name:      string,
//     savedAt:   ISO timestamp,
//     instances: [{ url, vfo, freq, mode, bwLow, bwHigh }],
//   }
//
// The popup sends:
//   popup:save_profile   { name }          — snapshot current registry + state
//   popup:load_profile   { name }          — apply stored instance list
//   popup:delete_profile { name }          — remove a profile
//   popup:get_profiles                     — returns { profiles: { [name]: profile } }

async function getProfiles() {
    const stored = await chrome.storage.local.get('profiles');
    return stored.profiles || {};
}

async function saveProfiles(profiles) {
    await chrome.storage.local.set({ profiles });
}

// ── Tab lifecycle ──────────────────────────────────────────────────────────────

// When the user switches to a browser tab that is a registered UberSDR instance,
// auto-select it in the extension (same effect as clicking it in the popup).
chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (!registry.has(tabId)) return;          // Not an UberSDR tab — ignore
    if (tabId === selectedTabId) return;        // Already selected — nothing to do

    selectedTabId = tabId;
    chrome.storage.local.set({ selectedTabId: tabId });
    lastKnownState = registry.get(tabId).lastState;

    // Switch flrig to the VFO assigned to this tab.
    const tabVfo = registry.get(tabId).vfo || null;
    if (tabVfo && flrigEnabled && flrigConnected) {
        flrigSetAB(tabVfo).catch(() => {});
    }

    // Mute all other UberSDR tabs; unmute the newly active one.
    muteAllExcept(tabId);

    // Reset echo-prevention for the new tab context.
    _lastFlrigFreq = null;
    _lastFlrigMode = null;
    _lastSdrFreq = null;
    _lastSdrMode = null;
    _sdrToRigLastPushTime = Date.now();
    if (_sdrToRigDebounceTimer) {
        clearTimeout(_sdrToRigDebounceTimer);
        _sdrToRigDebounceTimer = null;
    }

    persistSession();
    broadcastRegistry();
    if (lastKnownState) {
        broadcastToPopup({ type: 'state:update', state: lastKnownState });
    }
    // Request a fresh snapshot from the newly active tab.
    chrome.tabs.sendMessage(tabId, { type: 'cmd:get_state' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (registry.has(tabId)) {
        registry.delete(tabId);
        if (selectedTabId === tabId) {
            selectedTabId = null;
            chrome.storage.local.set({ selectedTabId: null });
        }
        if (registry.size === 0) lastKnownState = null;
        persistSession();
        broadcastRegistry();
    }
});

// If a tab navigates away from UberSDR the content script will send a deregister
// message. We also watch onUpdated but only remove the tab if the URL has actually
// changed away from the registered URL — this avoids falsely evicting tabs when
// Chrome fires spurious 'loading' events (e.g. after SW wake/restore).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && registry.has(tabId)) {
        // Only evict if the tab URL has changed to something different.
        // If changeInfo.url is undefined the tab is reloading the same page — keep it.
        if (!changeInfo.url) return;
        const entry = registry.get(tabId);
        try {
            const newHost = new URL(changeInfo.url).host;
            const oldHost = new URL(entry.url).host;
            if (newHost === oldHost) return; // Same host — likely a reload, keep it
        } catch (_) {}
        registry.delete(tabId);
        if (selectedTabId === tabId) {
            selectedTabId = null;
            chrome.storage.local.set({ selectedTabId: null });
        }
        if (registry.size === 0) lastKnownState = null;
        persistSession();
        broadcastRegistry();
    }
});

// ── Message handler ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    // For async handlers we must return true to keep the message channel open.
    const result = handleMessage(msg, sender);
    if (result && typeof result.then === 'function') {
        result.then(sendResponse).catch(() => sendResponse(null));
        return true; // Keep channel open for async response
    }
    // For synchronous handlers that return undefined (fire-and-forget messages
    // like ubersdr:register), we must still call sendResponse to avoid the
    // "message port closed before a response was received" error in Chrome MV3.
    sendResponse(null);
});

function handleMessage(msg, sender) {
    switch (msg.type) {

        // ── Content script: this tab is an UberSDR instance ───────────────────
        case 'ubersdr:register': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId) break;
            if (!pluginEnabled) break;   // Plugin disabled — ignore registration

            // Assign VFO: first tab gets A, second gets B, any further tabs get null
            const existingEntry = registry.has(tabId) ? registry.get(tabId) : null;
            const existingVfo   = existingEntry ? existingEntry.vfo : undefined;
            let assignedVfo;
            if (existingEntry) {
                assignedVfo = existingVfo;
            } else {
                const usedVfos = new Set(
                    Array.from(registry.values()).map(e => e.vfo).filter(v => v != null)
                );
                assignedVfo = (!usedVfos.has('A')) ? 'A'
                            : (!usedVfos.has('B')) ? 'B'
                            : null;
            }

            registry.set(tabId, {
                tabId:        tabId,
                sessionId:    msg.sessionId,
                url:          msg.url,
                title:        msg.title || sender.tab.title || msg.url,
                lastState:    null,
                vfo:          assignedVfo,
                audioStarted: !!msg.audioStarted,
            });

            if (tabId === pendingSelectTabId || selectedTabId === null || !registry.has(selectedTabId)) {
                selectedTabId = tabId;
                pendingSelectTabId = null;
                chrome.storage.local.set({ selectedTabId: tabId });
            }

            persistSession();
            broadcastRegistry();

            chrome.tabs.sendMessage(tabId, { type: 'cmd:get_state' }).catch(() => {});

            if (pendingProfileStates.has(tabId)) {
                const inst = pendingProfileStates.get(tabId);
                pendingProfileStates.delete(tabId);
                if (inst.vfo !== undefined && registry.has(tabId)) {
                    if (inst.vfo !== null) {
                        for (const [otherTabId, entry] of registry) {
                            if (otherTabId !== tabId && entry.vfo === inst.vfo) entry.vfo = null;
                        }
                    }
                    registry.get(tabId).vfo = inst.vfo;
                    broadcastRegistry();
                }
                setTimeout(() => {
                    if (inst.freq  != null) chrome.tabs.sendMessage(tabId, { type: 'cmd:set_freq',      freq: inst.freq }).catch(() => {});
                    if (inst.mode  != null) chrome.tabs.sendMessage(tabId, { type: 'cmd:set_mode',      mode: inst.mode }).catch(() => {});
                    if (inst.bwLow != null && inst.bwHigh != null) {
                        chrome.tabs.sendMessage(tabId, { type: 'cmd:set_bandwidth', low: inst.bwLow, high: inst.bwHigh }).catch(() => {});
                    }
                }, 1500);
            }
            break;
        }

        // ── Content script: tab is navigating away ────────────────────────────
        case 'ubersdr:deregister': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId) break;
            registry.delete(tabId);
            if (selectedTabId === tabId) {
                selectedTabId = null;
                chrome.storage.local.set({ selectedTabId: null });
            }
            if (registry.size === 0) {
                lastKnownState = null;
            }
            persistSession();
            broadcastRegistry();
            break;
        }

        // ── Content script: page title changed ────────────────────────────────
        case 'ubersdr:title_update': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId || !registry.has(tabId)) break;
            registry.get(tabId).title = msg.title;
            broadcastRegistry();
            break;
        }

        // ── Content script: user pressed play ─────────────────────────────────
        case 'ubersdr:audio_started': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId || !registry.has(tabId)) break;
            registry.get(tabId).audioStarted = true;
            broadcastRegistry();
            break;
        }

        // ── Content script: partial state update ──────────────────────────────
        case 'ubersdr:state': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId || !registry.has(tabId)) break;

            const entry = registry.get(tabId);
            entry.lastState = { ...(entry.lastState || {}), ...msg.state };

            if (tabId === selectedTabId) {
                lastKnownState = entry.lastState;
                broadcastToPopup({ type: 'state:update', state: entry.lastState });

                const inVfoCooldown = (Date.now() - _sdrToRigLastPushTime) < FLRIG_ECHO_COOLDOWN_MS;
                const tabVfoForSync = entry.vfo || null;
                if (flrigEnabled && flrigConnected && entry.audioStarted && tabVfoForSync &&
                    (flrigDirection === 'sdr-to-rig' || flrigDirection === 'both')) {
                    if (!inVfoCooldown) {
                        pushSdrStateToFlrig(msg.state);
                    }
                }
            }
            break;
        }

        // ── Content script: full state snapshot ───────────────────────────────
        case 'ubersdr:state_snapshot': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId || !registry.has(tabId)) break;

            const entry = registry.get(tabId);
            entry.lastState = msg.state;

            if (tabId === selectedTabId) {
                lastKnownState = msg.state;
                broadcastToPopup({ type: 'state:snapshot', state: msg.state });
            }
            break;
        }

        // ── Popup: request current registry + state ───────────────────────────
        case 'popup:get_registry': {
            return Promise.resolve({
                tabs:            registrySnapshot(),
                selectedTabId:   selectedTabId,
                lastState:       lastKnownState,
                flrigEnabled:    flrigEnabled,
                flrigHost:       flrigHost,
                flrigPort:       flrigPort,
                flrigDirection:  flrigDirection,
                flrigConnected:  flrigConnected,
                pluginEnabled:   pluginEnabled,
                pttMuteEnabled:  pttMuteEnabled,
                pttActive:       _lastPtt,
            });
        }

        // ── Popup: user selected a different tab ──────────────────────────────
        case 'popup:select_tab': {
            const newTabId = msg.tabId;
            if (registry.has(newTabId)) {
                selectedTabId = newTabId;
                chrome.storage.local.set({ selectedTabId: newTabId });
                lastKnownState = registry.get(newTabId).lastState;

                const tabVfo = registry.get(newTabId).vfo || null;
                if (tabVfo && flrigEnabled && flrigConnected) {
                    flrigSetAB(tabVfo).catch(() => {});
                }

                muteAllExcept(newTabId);
                chrome.tabs.update(newTabId, { active: true }).catch(() => {});

                _lastFlrigFreq = null;
                _lastFlrigMode = null;
                _lastSdrFreq = null;
                _lastSdrMode = null;
                _sdrToRigLastPushTime = Date.now();
                if (_sdrToRigDebounceTimer) {
                    clearTimeout(_sdrToRigDebounceTimer);
                    _sdrToRigDebounceTimer = null;
                }

                persistSession();
                broadcastRegistry();
                if (lastKnownState) {
                    broadcastToPopup({ type: 'state:update', state: lastKnownState });
                }
                chrome.tabs.sendMessage(newTabId, { type: 'cmd:get_state' }).catch(() => {});
            }
            break;
        }

        // ── Popup: flag a tab to become selected once it registers ────────────
        case 'popup:pending_select': {
            if (msg.tabId) pendingSelectTabId = msg.tabId;
            break;
        }

        // ── Popup / bridge: send a command to the selected tab ────────────────
        case 'popup:command': {
            forwardCommandToTab(msg.command);
            break;
        }

        // ── Popup: set VFO assignment for a tab ───────────────────────────────
        case 'popup:set_tab_vfo': {
            const { tabId, vfo } = msg;
            if (tabId && registry.has(tabId) && (vfo === 'A' || vfo === 'B' || vfo === null)) {
                if (vfo !== null) {
                    for (const [otherTabId, entry] of registry) {
                        if (otherTabId !== tabId && entry.vfo === vfo) {
                            entry.vfo = null;
                        }
                    }
                }
                registry.get(tabId).vfo = vfo;
                broadcastRegistry();
                if (vfo && tabId === selectedTabId && flrigEnabled && flrigConnected) {
                    flrigSetAB(vfo);
                }
            }
            break;
        }

        // ── Popup: update flrig settings ──────────────────────────────────────
        case 'popup:set_flrig': {
            flrigEnabled   = !!msg.enabled;
            if (msg.host      !== undefined) flrigHost      = msg.host;
            if (msg.port      !== undefined) flrigPort      = msg.port;
            if (msg.direction !== undefined) flrigDirection = msg.direction;
            chrome.storage.local.set({ flrigEnabled, flrigHost, flrigPort, flrigDirection });

            if (!flrigEnabled) {
                flrigConnected = false;
                stopFlrigPoll();
                broadcastToPopup({ type: 'flrig:status', connected: false, message: 'Disabled' });
            } else {
                // Re-connect if just enabled.
                flrigConnect();
            }
            break;
        }

        // ── Popup: enable / disable PTT-mute feature ──────────────────────────
        case 'popup:set_ptt_mute_enabled': {
            pttMuteEnabled = !!msg.enabled;
            chrome.storage.local.set({ pttMuteEnabled });

            if (!pttMuteEnabled && _lastPtt) {
                if (selectedTabId && registry.has(selectedTabId)) {
                    chrome.tabs.update(selectedTabId, { muted: false }).catch(() => {});
                }
            }
            break;
        }

        // ── Popup: mute / unmute the selected tab ─────────────────────────────
        case 'popup:set_tab_mute': {
            if (selectedTabId && registry.has(selectedTabId)) {
                chrome.tabs.update(selectedTabId, { muted: !!msg.muted }).catch(() => {});
            }
            break;
        }

        // ── Popup: enable / disable the entire plugin ─────────────────────────
        case 'popup:set_plugin_enabled': {
            pluginEnabled = !!msg.enabled;
            chrome.storage.local.set({ pluginEnabled });

            if (!pluginEnabled) {
                registry.clear();
                selectedTabId = null;
                lastKnownState = null;
                chrome.storage.local.set({ selectedTabId: null });

                stopFlrigPoll();
                flrigConnected = false;
                _lastPtt = false;
                persistSession();
                broadcastToPopup({ type: 'flrig:status', connected: false, message: 'Plugin disabled' });
                broadcastToPopup({ type: 'ptt:status', active: false });
            } else {
                if (flrigEnabled) flrigConnect();

                chrome.tabs.query({}).then((tabs) => {
                    for (const tab of tabs) {
                        chrome.tabs.sendMessage(tab.id, { type: 'cmd:reregister' }).catch(() => {});
                    }
                });
            }

            broadcastRegistry();
            break;
        }

        // ── Popup: get all saved profiles ─────────────────────────────────────
        case 'popup:get_profiles': {
            return getProfiles().then(profiles => ({ profiles }));
        }

        // ── Popup: save current registry state as a named profile ─────────────
        case 'popup:save_profile': {
            const profileName = (msg.name || '').trim();
            if (!profileName) break;
            return getProfiles().then(async (profiles) => {
                const instances = Array.from(registry.values()).map(e => ({
                    url:   e.url,
                    vfo:   e.vfo || null,
                    freq:  e.lastState ? e.lastState.freq  : null,
                    mode:  e.lastState ? e.lastState.mode  : null,
                    bwLow: e.lastState ? e.lastState.bwLow : null,
                    bwHigh:e.lastState ? e.lastState.bwHigh: null,
                }));
                profiles[profileName] = {
                    name:      profileName,
                    savedAt:   new Date().toISOString(),
                    instances,
                };
                await saveProfiles(profiles);
                return { ok: true, profiles };
            });
        }

        // ── Popup: delete a named profile ─────────────────────────────────────
        case 'popup:delete_profile': {
            const profileName = (msg.name || '').trim();
            if (!profileName) break;
            return getProfiles().then(async (profiles) => {
                delete profiles[profileName];
                await saveProfiles(profiles);
                return { ok: true, profiles };
            });
        }

        // ── Popup: load a named profile ───────────────────────────────────────
        case 'popup:load_profile': {
            const profileName = (msg.name || '').trim();
            if (!profileName) break;
            return getProfiles().then(async (profiles) => {
                const profile = profiles[profileName];
                if (!profile) return { ok: false, error: 'Profile not found' };

                for (const inst of profile.instances) {
                    const existingEntry = Array.from(registry.values()).find(e => e.url === inst.url);

                    if (existingEntry) {
                        const tabId = existingEntry.tabId;
                        if (inst.vfo !== undefined) {
                            if (inst.vfo !== null) {
                                for (const [otherTabId, entry] of registry) {
                                    if (otherTabId !== tabId && entry.vfo === inst.vfo) {
                                        entry.vfo = null;
                                    }
                                }
                            }
                            existingEntry.vfo = inst.vfo;
                        }
                        if (inst.freq  != null) chrome.tabs.sendMessage(tabId, { type: 'cmd:set_freq',      freq: inst.freq }).catch(() => {});
                        if (inst.mode  != null) chrome.tabs.sendMessage(tabId, { type: 'cmd:set_mode',      mode: inst.mode }).catch(() => {});
                        if (inst.bwLow != null && inst.bwHigh != null) {
                            chrome.tabs.sendMessage(tabId, { type: 'cmd:set_bandwidth', low: inst.bwLow, high: inst.bwHigh }).catch(() => {});
                        }
                    } else {
                        const tab = await chrome.tabs.create({ url: inst.url, active: false }).catch(() => null);
                        if (tab) {
                            pendingProfileStates.set(tab.id, inst);
                        }
                    }
                }

                broadcastRegistry();
                return { ok: true };
            });
        }

        default:
            break;
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function registrySnapshot() {
    return Array.from(registry.values()).map(e => ({
        tabId:        e.tabId,
        sessionId:    e.sessionId,
        url:          e.url,
        title:        e.title,
        selected:     e.tabId === selectedTabId,
        lastState:    e.lastState,
        vfo:          e.vfo || null,
        audioStarted: !!e.audioStarted,
    }));
}

function forwardCommandToTab(command) {
    if (!selectedTabId || !registry.has(selectedTabId)) {
        console.warn('[UberSDR Bridge] No selected tab to forward command to');
        return;
    }
    chrome.tabs.sendMessage(selectedTabId, command).catch((err) => {
        console.warn('[UberSDR Bridge] Failed to send command to tab:', err);
    });
}

function muteAllExcept(activeTabId) {
    if (registry.size < 2) return;
    for (const [tabId] of registry) {
        const shouldMute = tabId !== activeTabId;
        chrome.tabs.update(tabId, { muted: shouldMute }).catch(() => {});
    }
}

function broadcastToPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {
        // Popup is not open — ignore.
    });
}

function broadcastRegistry() {
    broadcastToPopup({ type: 'registry:updated', tabs: registrySnapshot(), selectedTabId });
}

// ── flrig XML-RPC ──────────────────────────────────────────────────────────────

function xmlrpcCall(method, params) {
    const paramXml = params.map(p => {
        if (p !== null && typeof p === 'object' && p.__type) {
            if (p.__type === 'double') return `<param><value><double>${p.value}</double></value></param>`;
            if (p.__type === 'int')    return `<param><value><int>${p.value}</int></value></param>`;
            return `<param><value><string>${p.value}</string></value></param>`;
        }
        if (typeof p === 'number') {
            return Number.isInteger(p)
                ? `<param><value><int>${p}</int></value></param>`
                : `<param><value><double>${p}</double></value></param>`;
        }
        return `<param><value><string>${p}</string></value></param>`;
    }).join('');

    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${paramXml}</params></methodCall>`;

    return fetch(`http://${flrigHost}:${flrigPort}/RPC2`, {
        method:  'POST',
        headers: { 'Content-Type': 'text/xml' },
        body:    body,
    }).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
    }).then(xml => {
        return parseXmlrpcResponse(xml);
    });
}

function parseXmlrpcResponse(xml) {
    const faultMatch = xml.match(/<fault>/);
    if (faultMatch) {
        const msgMatch = xml.match(/<name>faultString<\/name>\s*<value><string>([^<]*)<\/string>/);
        throw new Error(msgMatch ? msgMatch[1] : 'XML-RPC fault');
    }

    if (xml.includes('<array>')) {
        const values = [];
        const re = /<value>(?:<(?:string|double|int|i4)>)?([^<]*)(?:<\/(?:string|double|int|i4)>)?<\/value>/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
            values.push(m[1]);
        }
        return values;
    }

    const dblMatch  = xml.match(/<value><double>([^<]*)<\/double><\/value>/);
    if (dblMatch)  return parseFloat(dblMatch[1]);
    const intMatch  = xml.match(/<value><(?:int|i4)>([^<]*)<\/(?:int|i4)><\/value>/);
    if (intMatch)  return parseInt(intMatch[1], 10);
    const boolMatch = xml.match(/<value><boolean>([^<]*)<\/boolean><\/value>/);
    if (boolMatch) return boolMatch[1] === '1';
    const strMatch  = xml.match(/<value><string>([^<]*)<\/string><\/value>/);
    if (strMatch)  return strMatch[1];
    const bareMatch = xml.match(/<value>([^<]+)<\/value>/);
    if (bareMatch) return bareMatch[1];
    return null;
}

// Mode mapping between flrig (uppercase) and UberSDR (lowercase)
const FLRIG_TO_SDR = {
    'USB': 'usb', 'LSB': 'lsb',
    'CW':  'cwu', 'CWR': 'cwl', 'CWL': 'cwl',
    'AM':  'am',  'SAM': 'sam',
    'FM':  'fm',  'NFM': 'nfm', 'WFM': 'fm',
    'RTTY': 'usb', 'PSK31': 'usb', 'FT8': 'usb',
};
const SDR_TO_FLRIG = {
    'usb': 'USB', 'lsb': 'LSB',
    'cwu': 'CW',  'cwl': 'CWR',
    'am':  'AM',  'sam': 'SAM',
    'fm':  'FM',  'nfm': 'NFM',
};

async function flrigGetFreq() {
    const val = await xmlrpcCall('rig.get_vfo', []);
    return Math.round(parseFloat(val));
}

async function flrigSetFreq(hz) {
    await xmlrpcCall('rig.set_vfo', [{ __type: 'double', value: parseFloat(hz) }]);
}

async function flrigGetMode() {
    return await xmlrpcCall('rig.get_mode', []);
}

async function flrigSetMode(flrigMode) {
    await xmlrpcCall('rig.set_mode', [flrigMode]);
}

async function flrigGetPtt() {
    const val = await xmlrpcCall('rig.get_ptt', []);
    return !!val;
}

async function flrigGetAB() {
    const val = await xmlrpcCall('rig.get_AB', []);
    return (val === 'B') ? 'B' : 'A';
}

async function flrigSetAB(vfo) {
    const v = (vfo === 'B') ? 'B' : 'A';
    await xmlrpcCall('rig.set_AB', [v]);
    flrigActiveVfo = v;
}

// Push SDR state changes → flrig (sdr-to-rig direction).
// Debounced: accumulates rapid changes and only sends to flrig once settled.
function pushSdrStateToFlrig(state) {
    if (state.freq === undefined && state.mode === undefined) return;

    if (state.freq !== undefined) _pendingSdrFreq = state.freq;
    if (state.mode !== undefined) _pendingSdrMode = state.mode;

    if (_sdrToRigDebounceTimer) clearTimeout(_sdrToRigDebounceTimer);
    _sdrToRigDebounceTimer = setTimeout(async () => {
        _sdrToRigDebounceTimer = null;
        const freq = _pendingSdrFreq;
        const mode = _pendingSdrMode;
        try {
            if (selectedTabId && registry.has(selectedTabId)) {
                const tabVfo = registry.get(selectedTabId).vfo || null;
                if (tabVfo && tabVfo !== flrigActiveVfo) {
                    await flrigSetAB(tabVfo);
                    _sdrToRigLastPushTime = Date.now();
                    try {
                        const newVfoFreq = await flrigGetFreq();
                        const newVfoMode = await flrigGetMode();
                        _lastFlrigFreq = Math.round(newVfoFreq);
                        _lastFlrigMode = newVfoMode;
                    } catch (_) {
                        _lastFlrigFreq = null;
                        _lastFlrigMode = null;
                    }
                }
            }
            let pushed = false;
            if (freq !== null && freq !== undefined) {
                if (_lastSdrFreq === null || freq !== _lastSdrFreq) {
                    _lastSdrFreq = freq;
                    await flrigSetFreq(freq);
                    pushed = true;
                }
            }
            if (mode !== null && mode !== undefined) {
                const flrigMode = SDR_TO_FLRIG[mode.toLowerCase()];
                if (flrigMode && flrigMode !== _lastSdrMode) {
                    _lastSdrMode = flrigMode;
                    await flrigSetMode(flrigMode);
                    pushed = true;
                }
            }
            if (pushed) _sdrToRigLastPushTime = Date.now();
        } catch (err) {
            console.warn('[pushSdrStateToFlrig] error:', err);
        }
    }, SDR_TO_RIG_DEBOUNCE_MS);
}

// Poll flrig — runs when connected (for display + optional rig-to-sdr push).
async function pollFlrigToSdr() {
    try {
        const currentVfo = await flrigGetAB();
        if (currentVfo !== flrigActiveVfo) {
            flrigActiveVfo = currentVfo;

            _lastFlrigFreq = null;
            _lastFlrigMode = null;
            _lastSdrFreq   = null;
            _lastSdrMode   = null;
            _sdrToRigLastPushTime = Date.now();
            if (_sdrToRigDebounceTimer) {
                clearTimeout(_sdrToRigDebounceTimer);
                _sdrToRigDebounceTimer = null;
            }

            try {
                const seedFreq = await flrigGetFreq();
                const seedMode = await flrigGetMode();
                _lastFlrigFreq = Math.round(seedFreq);
                _lastFlrigMode = seedMode;
            } catch (_) {}

            const matchingTab = Array.from(registry.values()).find(e => e.vfo === currentVfo);
            if (matchingTab && matchingTab.tabId !== selectedTabId) {
                selectedTabId = matchingTab.tabId;
                chrome.storage.local.set({ selectedTabId });
                lastKnownState = matchingTab.lastState;
                muteAllExcept(selectedTabId);
                chrome.tabs.update(selectedTabId, { active: true }).catch(() => {});
                broadcastRegistry();
                broadcastToPopup({ type: 'vfo:switched', vfo: currentVfo, tabId: selectedTabId });
                if (lastKnownState) broadcastToPopup({ type: 'state:update', state: lastKnownState });
            }
        }

        const [freqRaw, modeRaw] = await Promise.all([
            flrigGetFreq(),
            flrigGetMode(),
        ]);

        const freq    = Math.round(freqRaw);
        const sdrMode = FLRIG_TO_SDR[modeRaw] || null;

        let pttNow = _lastPtt;
        try {
            pttNow = !!(await flrigGetPtt());
        } catch (_) {}

        if (pttNow !== _lastPtt) {
            _lastPtt = pttNow;
            broadcastToPopup({ type: 'ptt:status', active: pttNow });

            if (pttMuteEnabled && selectedTabId && registry.has(selectedTabId)) {
                chrome.tabs.update(selectedTabId, { muted: pttNow }).catch(() => {});
            }
        }

        broadcastToPopup({ type: 'flrig:state', freq, mode: modeRaw, vfo: flrigActiveVfo, ptt: pttNow });

        if (flrigDirection === 'rig-to-sdr' || flrigDirection === 'both') {
            const inCooldown = (Date.now() - _sdrToRigLastPushTime) < FLRIG_ECHO_COOLDOWN_MS;
            if (inCooldown) return;

            const freqChanged = _lastFlrigFreq === null || freq !== _lastFlrigFreq;
            const modeChanged = sdrMode !== null && modeRaw !== _lastFlrigMode;

            if (freqChanged) _lastFlrigFreq = freq;
            if (modeChanged) _lastFlrigMode = modeRaw;

            if (selectedTabId && registry.has(selectedTabId)) {
                if (freqChanged) {
                    _lastSdrFreq = freq;
                    forwardCommandToTab({ type: 'cmd:set_freq', freq });
                }
                if (modeChanged) {
                    _lastSdrMode = modeRaw;
                    forwardCommandToTab({ type: 'cmd:set_mode', mode: sdrMode });
                }
            }
        }
    } catch (err) {
        throw err;
    }
}

// ── flrig poll loop ────────────────────────────────────────────────────────────
// MV3 service workers can be killed by Chrome. We use a self-scheduling
// setTimeout chain (100ms interval) combined with a chrome.alarms keepalive
// (fires every minute) to re-start the chain if the SW was woken by the alarm.
//
// The alarm also serves as the reconnect trigger: if flrig is disconnected,
// each alarm tick attempts a reconnect.

const FLRIG_POLL_INTERVAL_MS = 100;

let _flrigPollActive = false;

function startFlrigPoll() {
    if (_flrigPollActive) return;
    _flrigPollActive = true;
    schedulePollTick();

    // Register a keepalive alarm so Chrome wakes the SW every minute.
    // This re-starts the poll chain if the SW was killed between ticks.
    chrome.alarms.create(ALARM_FLRIG_POLL, { periodInMinutes: 1 });
}

function stopFlrigPoll() {
    _flrigPollActive = false;
    chrome.alarms.clear(ALARM_FLRIG_POLL).catch(() => {});
}

function schedulePollTick() {
    if (!_flrigPollActive) return;
    setTimeout(async () => {
        if (!_flrigPollActive || !flrigEnabled || !flrigConnected || !pluginEnabled) {
            _flrigPollActive = false;
            return;
        }
        try {
            await pollFlrigToSdr();
        } catch (err) {
            flrigConnected = false;
            _flrigPollActive = false;
            stopFlrigPoll();
            broadcastToPopup({ type: 'flrig:status', connected: false, message: 'Lost connection' });
            return;
        }
        schedulePollTick();
    }, FLRIG_POLL_INTERVAL_MS);
}

async function flrigConnect() {
    if (!flrigEnabled || !pluginEnabled) return;
    try {
        await xmlrpcCall('system.listMethods', []);
        flrigConnected = true;
        _lastFlrigFreq = null;
        _lastFlrigMode = null;
        try { flrigActiveVfo = await flrigGetAB(); } catch (_) { flrigActiveVfo = 'A'; }
        broadcastToPopup({ type: 'flrig:status', connected: true, message: 'Connected' });
        startFlrigPoll();
    } catch (err) {
        flrigConnected = false;
        broadcastToPopup({ type: 'flrig:status', connected: false, message: `Unreachable: ${err.message}` });
    }
}

// ── Alarm listener ─────────────────────────────────────────────────────────────
// Handles both the keepalive poll alarm and the reconnect alarm.

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === ALARM_FLRIG_POLL) {
        // Keepalive: if the poll chain died (SW was killed), restart it.
        if (pluginEnabled && flrigEnabled && flrigConnected && !_flrigPollActive) {
            startFlrigPoll();
        }
        // If disconnected, attempt reconnect on each alarm tick (every minute).
        if (pluginEnabled && flrigEnabled && !flrigConnected) {
            await flrigConnect();
        }
    }
});

// Register the reconnect alarm on startup (fires every minute as a fallback).
// The poll loop itself handles reconnect detection; this is a belt-and-suspenders
// safety net for when the SW is woken from sleep with flrig disconnected.
chrome.alarms.create(ALARM_FLRIG_RECONNECT, { periodInMinutes: 1 });
