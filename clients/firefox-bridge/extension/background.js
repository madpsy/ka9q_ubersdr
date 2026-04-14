// UberSDR Bridge — Background Script (Event Page, Manifest V2)
//
// Responsibilities:
//   1. Maintain a registry of UberSDR tabs (registered by content_script.js)
//   2. Track which tab the user has selected as the "active" target
//   3. Relay commands from the popup to the selected tab's content script
//   4. Relay state updates from content scripts to the popup (if open)
//   5. Sync frequency/mode with flrig via XML-RPC (bidirectional, configurable)

'use strict';

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

// ── Restore persisted settings on startup ─────────────────────────────────────

browser.storage.local.get([
    'selectedTabId', 'flrigEnabled', 'flrigHost', 'flrigPort', 'flrigDirection',
    'pluginEnabled', 'pttMuteEnabled',
]).then((stored) => {
    if (stored.selectedTabId   !== undefined) selectedTabId   = stored.selectedTabId;
    if (stored.flrigEnabled    !== undefined) flrigEnabled    = stored.flrigEnabled;
    if (stored.flrigHost       !== undefined) flrigHost       = stored.flrigHost;
    if (stored.flrigPort       !== undefined) flrigPort       = stored.flrigPort;
    if (stored.flrigDirection  !== undefined) flrigDirection  = stored.flrigDirection;
    if (stored.pluginEnabled   !== undefined) pluginEnabled   = stored.pluginEnabled;
    if (stored.pttMuteEnabled  !== undefined) pttMuteEnabled = stored.pttMuteEnabled;
});

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
    const stored = await browser.storage.local.get('profiles');
    return stored.profiles || {};
}

async function saveProfiles(profiles) {
    await browser.storage.local.set({ profiles });
}

// ── Tab lifecycle ──────────────────────────────────────────────────────────────

// When the user switches to a browser tab that is a registered UberSDR instance,
// auto-select it in the extension (same effect as clicking it in the popup).
browser.tabs.onActivated.addListener(({ tabId }) => {
    if (!registry.has(tabId)) return;          // Not an UberSDR tab — ignore
    if (tabId === selectedTabId) return;        // Already selected — nothing to do

    selectedTabId = tabId;
    browser.storage.local.set({ selectedTabId: tabId });
    lastKnownState = registry.get(tabId).lastState;

    // Switch flrig to the VFO assigned to this tab.
    const tabVfo = registry.get(tabId).vfo || null;
    if (tabVfo && flrigEnabled && flrigConnected) {
        flrigSetAB(tabVfo).catch(() => {});
    }

    // Mute all other UberSDR tabs; unmute the newly active one.
    muteAllExcept(tabId);

    // Reset echo-prevention for the new tab context.
    // Clear _lastSdrFreq/Mode so they get re-seeded from flrig's actual current
    // frequency on the next rig→SDR push, preventing the SDR echo from writing
    // the wrong frequency back to flrig.
    _lastFlrigFreq = null;
    _lastFlrigMode = null;
    _lastSdrFreq = null;
    _lastSdrMode = null;
    // Activate the SDR→rig cooldown and cancel any pending debounce so stale
    // SDR state from the previous tab can't overwrite flrig after the switch.
    _sdrToRigLastPushTime = Date.now();
    if (_sdrToRigDebounceTimer) {
        clearTimeout(_sdrToRigDebounceTimer);
        _sdrToRigDebounceTimer = null;
    }

    broadcastRegistry();
    if (lastKnownState) {
        broadcastToPopup({ type: 'state:update', state: lastKnownState });
    }
    // Request a fresh snapshot from the newly active tab.
    browser.tabs.sendMessage(tabId, { type: 'cmd:get_state' }).catch(() => {});
});

browser.tabs.onRemoved.addListener((tabId) => {
    if (registry.has(tabId)) {
        registry.delete(tabId);
        if (selectedTabId === tabId) {
            selectedTabId = null;
            browser.storage.local.set({ selectedTabId: null });
        }
        if (registry.size === 0) lastKnownState = null;
        broadcastRegistry();
    }
});

// If a tab navigates away from UberSDR the content script will send a deregister
// message, but also clean up here just in case.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && registry.has(tabId)) {
        registry.delete(tabId);
        if (selectedTabId === tabId) {
            selectedTabId = null;
            browser.storage.local.set({ selectedTabId: null });
        }
        if (registry.size === 0) lastKnownState = null;
        broadcastRegistry();
    }
});

// ── Message handler ────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {

        // ── Content script: this tab is an UberSDR instance ───────────────────
        case 'ubersdr:register': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId) break;
            if (!pluginEnabled) break;   // Plugin disabled — ignore registration

            // Assign VFO: first tab gets A, second gets B, any further tabs get null
            // (unassigned — both VFOs already in use; user can reassign via dropdown).
            // If the tab is already registered (re-register), keep its existing VFO.
            const existingEntry = registry.has(tabId) ? registry.get(tabId) : null;
            const existingVfo   = existingEntry ? existingEntry.vfo : undefined; // undefined = not yet registered
            let assignedVfo;
            if (existingEntry) {
                // Re-registration: preserve whatever VFO was already assigned (including null).
                assignedVfo = existingVfo;
            } else {
                const usedVfos = new Set(
                    Array.from(registry.values()).map(e => e.vfo).filter(v => v != null)
                );
                assignedVfo = (!usedVfos.has('A')) ? 'A'
                            : (!usedVfos.has('B')) ? 'B'
                            : null; // Both VFOs taken — leave unassigned
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

            // Auto-select if this tab was flagged as pending, or if there is no
            // currently selected tab.
            if (tabId === pendingSelectTabId || selectedTabId === null || !registry.has(selectedTabId)) {
                selectedTabId = tabId;
                pendingSelectTabId = null;
                browser.storage.local.set({ selectedTabId: tabId });
            }

            broadcastRegistry();

            // Ask the newly registered tab for a full state snapshot.
            browser.tabs.sendMessage(tabId, { type: 'cmd:get_state' }).catch(() => {});

            // Apply any pending profile state for this tab (opened by load_profile).
            if (pendingProfileStates.has(tabId)) {
                const inst = pendingProfileStates.get(tabId);
                pendingProfileStates.delete(tabId);
                // Apply VFO assignment.
                if (inst.vfo !== undefined && registry.has(tabId)) {
                    if (inst.vfo !== null) {
                        for (const [otherTabId, entry] of registry) {
                            if (otherTabId !== tabId && entry.vfo === inst.vfo) entry.vfo = null;
                        }
                    }
                    registry.get(tabId).vfo = inst.vfo;
                    broadcastRegistry();
                }
                // Delay the freq/mode/bw commands slightly so the page has time to
                // fully initialise radioAPI after the content script registers.
                setTimeout(() => {
                    if (inst.freq  != null) browser.tabs.sendMessage(tabId, { type: 'cmd:set_freq',      freq: inst.freq }).catch(() => {});
                    if (inst.mode  != null) browser.tabs.sendMessage(tabId, { type: 'cmd:set_mode',      mode: inst.mode }).catch(() => {});
                    if (inst.bwLow != null && inst.bwHigh != null) {
                        browser.tabs.sendMessage(tabId, { type: 'cmd:set_bandwidth', low: inst.bwLow, high: inst.bwHigh }).catch(() => {});
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
                browser.storage.local.set({ selectedTabId: null });
            }
            // Clear stale state when the registry is now empty so the popup
            // doesn't show old values the next time it is opened.
            if (registry.size === 0) {
                lastKnownState = null;
            }
            broadcastRegistry();
            break;
        }

        // ── Content script: page title changed (freq/mode shown in title) ─────
        case 'ubersdr:title_update': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId || !registry.has(tabId)) break;
            registry.get(tabId).title = msg.title;
            broadcastRegistry();
            break;
        }

        // ── Content script: user pressed play (audio-start overlay dismissed) ─
        case 'ubersdr:audio_started': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId || !registry.has(tabId)) break;
            registry.get(tabId).audioStarted = true;
            broadcastRegistry();
            break;
        }

        // ── Content script: partial state update (freq/mode/bw changed) ───────
        case 'ubersdr:state': {
            const tabId = sender.tab ? sender.tab.id : null;
            if (!tabId || !registry.has(tabId)) break;

            const entry = registry.get(tabId);
            entry.lastState = { ...(entry.lastState || {}), ...msg.state };

            if (tabId === selectedTabId) {
                lastKnownState = entry.lastState;
                broadcastToPopup({ type: 'state:update', state: entry.lastState });

                // SDR → rig: only push if audio has started (overlay dismissed)
                // and direction allows it.
                // Also suppress during the VFO-switch cooldown window — the newly
                // selected tab will echo its current state immediately after being
                // activated, and we must not write that back to flrig (which is now
                // on the new VFO and should keep its own frequency).
                const inVfoCooldown = (Date.now() - _sdrToRigLastPushTime) < FLRIG_ECHO_COOLDOWN_MS;
                // Only sync if this tab has a VFO assigned (null = unassigned / '—').
                const tabVfoForSync = entry.vfo || null;
                if (flrigEnabled && flrigConnected && entry.audioStarted && tabVfoForSync &&
                    (flrigDirection === 'sdr-to-rig' || flrigDirection === 'both')) {
                    if (inVfoCooldown) {
                        console.log('[ubersdr:state] suppressed pushSdrStateToFlrig during VFO cooldown — tabId:', tabId, 'freq:', msg.state.freq);
                    } else {
                        console.log('[ubersdr:state] calling pushSdrStateToFlrig — tabId:', tabId,
                            'freq:', msg.state.freq, 'mode:', msg.state.mode,
                            'flrigActiveVfo:', flrigActiveVfo,
                            '_lastSdrFreq:', _lastSdrFreq, '_lastFlrigFreq:', _lastFlrigFreq);
                        pushSdrStateToFlrig(msg.state);
                    }
                }
            }
            break;
        }

        // ── Content script: full state snapshot (response to cmd:get_state) ───
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
                browser.storage.local.set({ selectedTabId: newTabId });
                lastKnownState = registry.get(newTabId).lastState;

                // Switch flrig to the VFO assigned to this tab (if flrig connected
                // and this tab has a VFO assigned).
                // Always call flrigSetAB regardless of our cached flrigActiveVfo —
                // the radio may have been changed manually since the last poll.
                const tabVfo = registry.get(newTabId).vfo || null;
                if (tabVfo && flrigEnabled && flrigConnected) {
                    flrigSetAB(tabVfo).catch(() => {});
                }

                // Mute all other tabs; unmute the newly selected one.
                muteAllExcept(newTabId);

                // Bring the selected browser tab to the foreground.
                browser.tabs.update(newTabId, { active: true }).catch(() => {});

                // Reset echo-prevention for the new tab context.
                // Clear _lastSdrFreq/Mode so they get re-seeded from flrig's
                // actual current frequency on the next rig→SDR push, preventing
                // the SDR echo from writing the wrong frequency back to flrig.
                _lastFlrigFreq = null;
                _lastFlrigMode = null;
                _lastSdrFreq = null;
                _lastSdrMode = null;
                // Activate the SDR→rig cooldown and cancel any pending debounce
                // so stale SDR state from the previous tab can't overwrite flrig.
                _sdrToRigLastPushTime = Date.now();
                if (_sdrToRigDebounceTimer) {
                    clearTimeout(_sdrToRigDebounceTimer);
                    _sdrToRigDebounceTimer = null;
                }

                broadcastRegistry();
                // Push the cached state for the newly selected tab immediately.
                if (lastKnownState) {
                    broadcastToPopup({ type: 'state:update', state: lastKnownState });
                }
                // Also request a fresh snapshot from the tab.
                browser.tabs.sendMessage(newTabId, { type: 'cmd:get_state' }).catch(() => {});
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
            // vfo may be 'A', 'B', or null (unassign).
            if (tabId && registry.has(tabId) && (vfo === 'A' || vfo === 'B' || vfo === null)) {
                // If assigning a real VFO, unassign it from any other tab that currently
                // holds it — each VFO may only be assigned to one tab at a time.
                if (vfo !== null) {
                    for (const [otherTabId, entry] of registry) {
                        if (otherTabId !== tabId && entry.vfo === vfo) {
                            entry.vfo = null;
                        }
                    }
                }
                registry.get(tabId).vfo = vfo;
                broadcastRegistry();
                // If this is the selected tab and a real VFO was assigned, switch flrig.
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
            browser.storage.local.set({ flrigEnabled, flrigHost, flrigPort, flrigDirection });

            if (!flrigEnabled) {
                flrigConnected = false;
                broadcastToPopup({ type: 'flrig:status', connected: false, message: 'Disabled' });
            }
            break;
        }

        // ── Popup: enable / disable PTT-mute feature ──────────────────────────
        case 'popup:set_ptt_mute_enabled': {
            pttMuteEnabled = !!msg.enabled;
            browser.storage.local.set({ pttMuteEnabled });

            // If disabling PTT-mute while the rig is transmitting, unmute the SDR.
            if (!pttMuteEnabled && _lastPtt) {
                if (selectedTabId && registry.has(selectedTabId)) {
                    browser.tabs.update(selectedTabId, { muted: false }).catch(() => {});
                    // browser.tabs.sendMessage(selectedTabId, { type: 'cmd:set_mute', muted: false }).catch(() => {});
                }
            }
            break;
        }

        // ── Popup: enable / disable the entire plugin ─────────────────────────
        case 'popup:set_plugin_enabled': {
            pluginEnabled = !!msg.enabled;
            browser.storage.local.set({ pluginEnabled });

            if (!pluginEnabled) {
                // Clear the registry — stop tracking all tabs.
                registry.clear();
                selectedTabId = null;
                lastKnownState = null;
                browser.storage.local.set({ selectedTabId: null });

                // Stop flrig polling.
                stopFlrigPoll();
                flrigConnected = false;
                _lastPtt = false;
                broadcastToPopup({ type: 'flrig:status', connected: false, message: 'Plugin disabled' });
                broadcastToPopup({ type: 'ptt:status', active: false });
            } else {
                // Re-enable: restart flrig polling if configured.
                if (flrigEnabled) startFlrigPoll();

                // Ask every open tab to re-register so already-open UberSDR
                // instances are rediscovered without needing a page reload.
                // Non-UberSDR tabs will receive the message and ignore it
                // (their content scripts guard on initialised === true).
                browser.tabs.query({}).then((tabs) => {
                    for (const tab of tabs) {
                        browser.tabs.sendMessage(tab.id, { type: 'cmd:reregister' }).catch(() => {});
                    }
                });
            }

            // Broadcast empty registry so popup reflects the cleared state.
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
                // Snapshot every registered tab's URL, VFO assignment, and last
                // known radio state (freq, mode, bwLow, bwHigh).
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
        // For each instance in the profile:
        //   • If a tab with that URL is already open, apply freq/mode/bw to it.
        //   • Otherwise open a new tab and queue the state to apply once it registers.
        case 'popup:load_profile': {
            const profileName = (msg.name || '').trim();
            if (!profileName) break;
            return getProfiles().then(async (profiles) => {
                const profile = profiles[profileName];
                if (!profile) return { ok: false, error: 'Profile not found' };

                for (const inst of profile.instances) {
                    // Find an already-open tab with this URL (exact match).
                    const existingEntry = Array.from(registry.values()).find(e => e.url === inst.url);

                    if (existingEntry) {
                        const tabId = existingEntry.tabId;
                        // Apply VFO assignment.
                        if (inst.vfo !== undefined) {
                            if (inst.vfo !== null) {
                                // Unassign the VFO from any other tab first.
                                for (const [otherTabId, entry] of registry) {
                                    if (otherTabId !== tabId && entry.vfo === inst.vfo) {
                                        entry.vfo = null;
                                    }
                                }
                            }
                            existingEntry.vfo = inst.vfo;
                        }
                        // Apply freq/mode/bw.
                        if (inst.freq  != null) browser.tabs.sendMessage(tabId, { type: 'cmd:set_freq',      freq: inst.freq }).catch(() => {});
                        if (inst.mode  != null) browser.tabs.sendMessage(tabId, { type: 'cmd:set_mode',      mode: inst.mode }).catch(() => {});
                        if (inst.bwLow != null && inst.bwHigh != null) {
                            browser.tabs.sendMessage(tabId, { type: 'cmd:set_bandwidth', low: inst.bwLow, high: inst.bwHigh }).catch(() => {});
                        }
                    } else {
                        // Open a new tab; store the desired state so it can be
                        // applied once the content script registers.
                        const tab = await browser.tabs.create({ url: inst.url, active: false }).catch(() => null);
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
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function registrySnapshot() {
    return Array.from(registry.values()).map(e => ({
        tabId:        e.tabId,
        sessionId:    e.sessionId,
        url:          e.url,
        title:        e.title,
        selected:     e.tabId === selectedTabId,
        lastState:    e.lastState,
        vfo:          e.vfo || null,   // null = unassigned (both VFOs in use)
        audioStarted: !!e.audioStarted,
    }));
}

// Forward a command object to the currently selected UberSDR tab.
function forwardCommandToTab(command) {
    if (!selectedTabId || !registry.has(selectedTabId)) {
        console.warn('[UberSDR Bridge] No selected tab to forward command to');
        return;
    }
    browser.tabs.sendMessage(selectedTabId, command).catch((err) => {
        console.warn('[UberSDR Bridge] Failed to send command to tab:', err);
    });
}

// Mute every registered tab except activeTabId (which gets unmuted).
// Only acts when there are 2+ tabs — single-tab setups are left alone.
// Uses browser tab-level mute (instant, OS mixer) for fastest response.
// radioAPI mute (Web Audio gain ramp) left here for reference but disabled —
// it introduces unmute lag due to the gain ramp.
function muteAllExcept(activeTabId) {
    if (registry.size < 2) return;
    for (const [tabId] of registry) {
        const shouldMute = tabId !== activeTabId;
        browser.tabs.update(tabId, { muted: shouldMute }).catch(() => {});
        // browser.tabs.sendMessage(tabId, { type: 'cmd:set_mute', muted: shouldMute }).catch(() => {});
    }
}

// Send a message to the popup if it is currently open.
function broadcastToPopup(msg) {
    browser.runtime.sendMessage(msg).catch(() => {
        // Popup is not open — ignore.
    });
}

// Broadcast a registry update that always includes the current selectedTabId.
function broadcastRegistry() {
    broadcastToPopup({ type: 'registry:updated', tabs: registrySnapshot(), selectedTabId });
}

// ── flrig XML-RPC ──────────────────────────────────────────────────────────────
// flrig exposes an XML-RPC server (default port 12345).
// We communicate via fetch() POST to http://host:port/RPC2.

function xmlrpcCall(method, params) {
    const paramXml = params.map(p => {
        // Allow explicit type hints: { __type: 'double'|'int'|'string', value: v }
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
    // Extract the value from a simple XML-RPC response.
    // Handles <string>, <double>, <int>, <i4>, <boolean>, <array>,
    // and bare <value>text</value> (no type tag — flrig sometimes omits it).
    const faultMatch = xml.match(/<fault>/);
    if (faultMatch) {
        const msgMatch = xml.match(/<name>faultString<\/name>\s*<value><string>([^<]*)<\/string>/);
        throw new Error(msgMatch ? msgMatch[1] : 'XML-RPC fault');
    }

    // Array response (e.g. get_bw returns [bw2, bw1])
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
    // Bare value with no type tag — treat as string (flrig sometimes does this)
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
    // flrig expects frequency as a <double>, not <int>.
    // Use explicit type hint so xmlrpcCall always serialises as <double>.
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
    // Returns 'A' or 'B' — the currently active VFO in flrig.
    const val = await xmlrpcCall('rig.get_AB', []);
    return (val === 'B') ? 'B' : 'A';
}

async function flrigSetAB(vfo) {
    const v = (vfo === 'B') ? 'B' : 'A';
    await xmlrpcCall('rig.set_AB', [v]);
    flrigActiveVfo = v;
}

// Push SDR state changes → flrig (sdr-to-rig direction).
// Debounced: accumulates rapid changes (page-load burst, user dragging) and
// only sends to flrig once freq/mode has been stable for SDR_TO_RIG_DEBOUNCE_MS.
function pushSdrStateToFlrig(state) {
    // Short-circuit: only act if freq or mode is present in this update.
    if (state.freq === undefined && state.mode === undefined) return;

    // Accumulate the latest values into pending slots.
    if (state.freq !== undefined) _pendingSdrFreq = state.freq;
    if (state.mode !== undefined) _pendingSdrMode = state.mode;

    // Reset the debounce timer.
    if (_sdrToRigDebounceTimer) clearTimeout(_sdrToRigDebounceTimer);
    _sdrToRigDebounceTimer = setTimeout(async () => {
        _sdrToRigDebounceTimer = null;
        const freq = _pendingSdrFreq;
        const mode = _pendingSdrMode;
        console.log('[pushSdrStateToFlrig] debounce fired — freq:', freq, 'mode:', mode,
            'selectedTabId:', selectedTabId, 'flrigActiveVfo:', flrigActiveVfo);
        try {
            // Ensure flrig is on the correct VFO for the selected tab before writing.
            // Skip if the tab has no VFO assigned (null = unassigned).
            // Use the cached flrigActiveVfo — it is updated every 500ms by the poll.
            // We do NOT call flrigGetAB() here on every push (that would add extra
            // XML-RPC calls and cause rate-limiting). The 500ms poll window is short
            // enough that a stale cache only risks one wrong write at most.
            if (selectedTabId && registry.has(selectedTabId)) {
                const tabVfo = registry.get(selectedTabId).vfo || null;
                console.log('[pushSdrStateToFlrig] tabVfo:', tabVfo, 'flrigActiveVfo:', flrigActiveVfo);
                if (tabVfo && tabVfo !== flrigActiveVfo) {
                    console.log('[pushSdrStateToFlrig] VFO mismatch — switching flrig to', tabVfo);
                    await flrigSetAB(tabVfo);
                    // Activate the cooldown immediately on VFO switch so the poll
                    // doesn't push the new VFO's existing frequency back to SDR
                    // before we've had a chance to write the correct value.
                    _sdrToRigLastPushTime = Date.now();
                    // Seed _lastFlrigFreq/_lastFlrigMode with the new VFO's current
                    // values so the poll doesn't see freqChanged=true and spam
                    // cmd:set_freq (which calls autoTune() → rate limiting).
                    // We do this BEFORE writing the new freq below, so the write
                    // will differ from _lastFlrigFreq and actually get sent.
                    try {
                        const newVfoFreq = await flrigGetFreq();
                        const newVfoMode = await flrigGetMode();
                        _lastFlrigFreq = Math.round(newVfoFreq);
                        _lastFlrigMode = newVfoMode;
                        console.log('[pushSdrStateToFlrig] seeded after VFO switch — _lastFlrigFreq:', _lastFlrigFreq, '_lastFlrigMode:', _lastFlrigMode);
                    } catch (_) {
                        _lastFlrigFreq = null;
                        _lastFlrigMode = null;
                        console.log('[pushSdrStateToFlrig] seed failed — cleared _lastFlrigFreq/_lastFlrigMode');
                    }
                }
            }
            let pushed = false;
            if (freq !== null && freq !== undefined) {
                // Only push if the SDR freq differs from what we last sent (1 Hz resolution)
                if (_lastSdrFreq === null || freq !== _lastSdrFreq) {
                    console.log('[pushSdrStateToFlrig] writing freq to flrig:', freq, '(was _lastSdrFreq:', _lastSdrFreq, ')');
                    _lastSdrFreq = freq;
                    await flrigSetFreq(freq);
                    pushed = true;
                } else {
                    console.log('[pushSdrStateToFlrig] freq unchanged, skipping write:', freq);
                }
            }
            if (mode !== null && mode !== undefined) {
                const flrigMode = SDR_TO_FLRIG[mode.toLowerCase()];
                if (flrigMode && flrigMode !== _lastSdrMode) {
                    console.log('[pushSdrStateToFlrig] writing mode to flrig:', flrigMode, '(was _lastSdrMode:', _lastSdrMode, ')');
                    _lastSdrMode = flrigMode;
                    await flrigSetMode(flrigMode);
                    pushed = true;
                }
            }
            // Record the time of the last SDR→rig push so the rig→SDR poll can
            // suppress the round-trip echo for a short cooldown window.
            if (pushed) _sdrToRigLastPushTime = Date.now();
        } catch (err) {
            console.warn('[pushSdrStateToFlrig] error:', err);
            // flrig not reachable — will be caught by reconnect loop
        }
    }, SDR_TO_RIG_DEBOUNCE_MS);
}

// Poll flrig — always runs when connected (for display + optional rig-to-sdr push)
async function pollFlrigToSdr() {
    try {
        // Check if flrig has switched VFO (user pressed A/B on the radio).
        // If so, auto-select the tab assigned to that VFO.
        const currentVfo = await flrigGetAB();
        if (currentVfo !== flrigActiveVfo) {
            console.log('[pollFlrigToSdr] VFO changed:', flrigActiveVfo, '→', currentVfo,
                '| selectedTabId:', selectedTabId,
                '| _lastFlrigFreq:', _lastFlrigFreq, '_lastFlrigMode:', _lastFlrigMode);
            flrigActiveVfo = currentVfo;

            // Always reset echo prevention on VFO switch — _lastFlrigFreq was
            // tracking the old VFO's frequency and must not be used to gate
            // pushes for the new VFO.  Do this unconditionally, before any
            // tab-switch logic, so the rig→SDR push below uses a clean slate.
            _lastFlrigFreq = null;
            _lastFlrigMode = null;
            _lastSdrFreq   = null;
            _lastSdrMode   = null;
            _sdrToRigLastPushTime = Date.now();
            if (_sdrToRigDebounceTimer) {
                clearTimeout(_sdrToRigDebounceTimer);
                _sdrToRigDebounceTimer = null;
            }
            console.log('[pollFlrigToSdr] echo prevention reset. cooldown active until +' + FLRIG_ECHO_COOLDOWN_MS + 'ms');

            // Seed _lastFlrigFreq/_lastFlrigMode with the new VFO's current values
            // so the first post-cooldown poll doesn't see freqChanged=true and
            // immediately push the new VFO's existing frequency to the SDR tab.
            // (The cooldown suppresses the push during the seed fetch, so there's
            // no race: the seed will be in place before the cooldown expires.)
            try {
                const seedFreq = await flrigGetFreq();
                const seedMode = await flrigGetMode();
                _lastFlrigFreq = Math.round(seedFreq);
                _lastFlrigMode = seedMode;
                console.log('[pollFlrigToSdr] seeded new VFO state — _lastFlrigFreq:', _lastFlrigFreq, '_lastFlrigMode:', _lastFlrigMode);
            } catch (_) {
                // Leave as null — the cooldown will still suppress the first push
                console.log('[pollFlrigToSdr] seed fetch failed, leaving _lastFlrigFreq null');
            }

            // Find the tab assigned to this VFO and auto-select it.
            // Only consider tabs with an explicit VFO assignment (null = unassigned / '—').
            const matchingTab = Array.from(registry.values()).find(e => e.vfo === currentVfo);
            console.log('[pollFlrigToSdr] matchingTab for VFO', currentVfo, ':', matchingTab ? matchingTab.tabId : 'none',
                '| current selectedTabId:', selectedTabId);
            if (matchingTab && matchingTab.tabId !== selectedTabId) {
                selectedTabId = matchingTab.tabId;
                browser.storage.local.set({ selectedTabId });
                lastKnownState = matchingTab.lastState;
                // Mute all other tabs; unmute the one now active.
                muteAllExcept(selectedTabId);
                // Bring the matching browser tab to the foreground.
                browser.tabs.update(selectedTabId, { active: true }).catch(() => {});
                broadcastRegistry();
                broadcastToPopup({ type: 'vfo:switched', vfo: currentVfo, tabId: selectedTabId });
                if (lastKnownState) broadcastToPopup({ type: 'state:update', state: lastKnownState });
                console.log('[pollFlrigToSdr] selectedTabId updated to', selectedTabId);
            } else {
                console.log('[pollFlrigToSdr] no tab switch needed (matchingTab already selected or not found)');
            }
        }

        const [freqRaw, modeRaw] = await Promise.all([
            flrigGetFreq(),
            flrigGetMode(),
        ]);

        const freq    = Math.round(freqRaw);
        const sdrMode = FLRIG_TO_SDR[modeRaw] || null;

        // PTT is fetched separately so that rigs which don't support rig.get_ptt
        // don't break the poll loop — a failure here is silently ignored.
        let pttNow = _lastPtt;
        try {
            pttNow = !!(await flrigGetPtt());
        } catch (_) {
            // rig doesn't support get_ptt — leave pttNow as last known value
        }

        // Handle PTT state transitions — mute/unmute the selected SDR tab.
        if (pttNow !== _lastPtt) {
            _lastPtt = pttNow;
            broadcastToPopup({ type: 'ptt:status', active: pttNow });

            if (pttMuteEnabled && selectedTabId && registry.has(selectedTabId)) {
                // TX → mute; RX → unmute.
                // Tab-level mute (browser mixer) for instant response.
                // radioAPI mute (Web Audio gain ramp) left for reference but disabled —
                // it introduces unmute lag due to the gain ramp.
                browser.tabs.update(selectedTabId, { muted: pttNow }).catch(() => {});
                // browser.tabs.sendMessage(selectedTabId, { type: 'cmd:set_mute', muted: pttNow }).catch(() => {});
            }
        }

        // Always broadcast raw flrig values to the popup for display.
        broadcastToPopup({ type: 'flrig:state', freq, mode: modeRaw, vfo: flrigActiveVfo, ptt: pttNow });

        // Only push to SDR if direction allows it.
        if (flrigDirection === 'rig-to-sdr' || flrigDirection === 'both') {
            // Suppress rig→SDR during the cooldown window after a SDR→rig push
            // to prevent the round-trip echo loop.
            const inCooldown = (Date.now() - _sdrToRigLastPushTime) < FLRIG_ECHO_COOLDOWN_MS;
            if (inCooldown) {
                console.log('[pollFlrigToSdr] in cooldown, skipping rig→SDR push. freq from rig:', freq);
                return;
            }

            // Only send to SDR when flrig value has actually changed (1 Hz resolution)
            const freqChanged = _lastFlrigFreq === null || freq !== _lastFlrigFreq;
            const modeChanged = sdrMode !== null && modeRaw !== _lastFlrigMode;

            if (freqChanged) _lastFlrigFreq = freq;
            if (modeChanged) _lastFlrigMode = modeRaw;

            if (selectedTabId && registry.has(selectedTabId)) {
                const selTabVfo = (registry.get(selectedTabId).vfo || 'A');
                if (freqChanged) {
                    console.log('[pollFlrigToSdr] cmd:set_freq → tabId:', selectedTabId,
                        'tabVfo:', selTabVfo, 'flrigActiveVfo:', flrigActiveVfo,
                        'freq:', freq, '_lastFlrigFreq was:', _lastFlrigFreq === freq ? freq : '(just updated)');
                    if (selTabVfo !== flrigActiveVfo) {
                        console.warn('[pollFlrigToSdr] ⚠️ VFO MISMATCH — sending freq', freq,
                            'to tab with VFO', selTabVfo, 'but flrig is on VFO', flrigActiveVfo);
                    }
                    // Also stamp _lastSdrFreq so the SDR echo via ubersdr:state
                    // doesn't immediately push this value back to flrig.
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
        throw err; // Let the reconnect loop handle it
    }
}

// ── flrig reconnect / poll loop ────────────────────────────────────────────────

const FLRIG_RECONNECT_INTERVAL_MS = 10000;
const FLRIG_POLL_INTERVAL_MS      = 100;

let flrigPollTimer     = null;
let flrigReconnectTimer = null;

async function flrigConnect() {
    if (!flrigEnabled || !pluginEnabled) return;
    try {
        // Use system.listMethods as a connection test (standard XML-RPC introspection)
        await xmlrpcCall('system.listMethods', []);
        flrigConnected = true;
        // Reset last-seen so the first poll after (re)connect always syncs
        _lastFlrigFreq = null;
        _lastFlrigMode = null;
        // Read the current VFO from flrig on connect
        try { flrigActiveVfo = await flrigGetAB(); } catch (_) { flrigActiveVfo = 'A'; }
        broadcastToPopup({ type: 'flrig:status', connected: true, message: 'Connected' });
        startFlrigPoll();
    } catch (err) {
        flrigConnected = false;
        broadcastToPopup({ type: 'flrig:status', connected: false, message: `Unreachable: ${err.message}` });
    }
}

function startFlrigPoll() {
    stopFlrigPoll();
    // Always poll for display purposes; direction filtering happens inside pollFlrigToSdr().
    flrigPollTimer = setInterval(async () => {
        if (!flrigEnabled || !flrigConnected || !pluginEnabled) {
            stopFlrigPoll();
            return;
        }
        try {
            await pollFlrigToSdr();
        } catch (err) {
            flrigConnected = false;
            stopFlrigPoll();
            broadcastToPopup({ type: 'flrig:status', connected: false, message: 'Lost connection' });
        }
    }, FLRIG_POLL_INTERVAL_MS);
}

function stopFlrigPoll() {
    if (flrigPollTimer) {
        clearInterval(flrigPollTimer);
        flrigPollTimer = null;
    }
}

// Reconnect loop: every 10s, if enabled but not connected, try to connect.
setInterval(async () => {
    if (pluginEnabled && flrigEnabled && !flrigConnected) {
        await flrigConnect();
    }
}, FLRIG_RECONNECT_INTERVAL_MS);
