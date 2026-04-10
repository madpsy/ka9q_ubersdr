// UberSDR Bridge — Background Script (Event Page, Manifest V2)
//
// Responsibilities:
//   1. Maintain a registry of UberSDR tabs (registered by content_script.js)
//   2. Track which tab the user has selected as the "active" target
//   3. Relay commands from the popup to the selected tab's content script
//   4. Relay state updates from content scripts to the popup (if open)
//   5. Optionally relay state to/from a local HTTP bridge server on localhost

'use strict';

// ── Tab Registry ───────────────────────────────────────────────────────────────
// Map<tabId, { sessionId, url, title, lastState }>

const registry = new Map();

// The tabId the user has chosen to control (persisted in storage).
let selectedTabId = null;

// Last known state of the selected tab (used to populate popup on open).
let lastKnownState = null;

// ── Bridge server settings (defaults) ─────────────────────────────────────────
let bridgeEnabled = false;
let bridgeUrl     = 'http://localhost:7373';
let bridgeSecret  = '';

// ── Restore persisted settings on startup ─────────────────────────────────────

browser.storage.local.get(['selectedTabId', 'bridgeEnabled', 'bridgeUrl', 'bridgeSecret'])
    .then((stored) => {
        if (stored.selectedTabId !== undefined) selectedTabId = stored.selectedTabId;
        if (stored.bridgeEnabled  !== undefined) bridgeEnabled  = stored.bridgeEnabled;
        if (stored.bridgeUrl      !== undefined) bridgeUrl      = stored.bridgeUrl;
        if (stored.bridgeSecret   !== undefined) bridgeSecret   = stored.bridgeSecret;
    });

// ── Tab lifecycle ──────────────────────────────────────────────────────────────

browser.tabs.onRemoved.addListener((tabId) => {
    if (registry.has(tabId)) {
        registry.delete(tabId);
        if (selectedTabId === tabId) {
            selectedTabId = null;
            browser.storage.local.set({ selectedTabId: null });
        }
        broadcastToPopup({ type: 'registry:updated', tabs: registrySnapshot() });
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
        broadcastToPopup({ type: 'registry:updated', tabs: registrySnapshot() });
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

            registry.set(tabId, {
                tabId:     tabId,
                sessionId: msg.sessionId,
                url:       msg.url,
                title:     msg.title || sender.tab.title || msg.url,
                lastState: null,
            });

            // Auto-select if this is the only tab.
            if (selectedTabId === null || !registry.has(selectedTabId)) {
                selectedTabId = tabId;
                browser.storage.local.set({ selectedTabId: tabId });
            }

            broadcastToPopup({ type: 'registry:updated', tabs: registrySnapshot() });

            // Ask the newly registered tab for a full state snapshot.
            browser.tabs.sendMessage(tabId, { type: 'cmd:get_state' }).catch(() => {});
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
            broadcastToPopup({ type: 'registry:updated', tabs: registrySnapshot() });
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
                if (bridgeEnabled) relayStateToBridge(entry.lastState);
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
                if (bridgeEnabled) relayStateToBridge(msg.state);
            }
            break;
        }

        // ── Popup: request current registry + state ───────────────────────────
        case 'popup:get_registry': {
            return Promise.resolve({
                tabs:          registrySnapshot(),
                selectedTabId: selectedTabId,
                lastState:     lastKnownState,
                bridgeEnabled: bridgeEnabled,
                bridgeUrl:     bridgeUrl,
            });
        }

        // ── Popup: user selected a different tab ──────────────────────────────
        case 'popup:select_tab': {
            const newTabId = msg.tabId;
            if (registry.has(newTabId)) {
                selectedTabId = newTabId;
                browser.storage.local.set({ selectedTabId: newTabId });
                lastKnownState = registry.get(newTabId).lastState;
                // Request fresh state from the newly selected tab.
                browser.tabs.sendMessage(newTabId, { type: 'cmd:get_state' }).catch(() => {});
                broadcastToPopup({ type: 'registry:updated', tabs: registrySnapshot() });
            }
            break;
        }

        // ── Popup / bridge: send a command to the selected tab ────────────────
        case 'popup:command': {
            forwardCommandToTab(msg.command);
            break;
        }

        // ── Popup: update bridge server settings ──────────────────────────────
        case 'popup:set_bridge': {
            bridgeEnabled = !!msg.enabled;
            if (msg.url)    bridgeUrl    = msg.url;
            if (msg.secret !== undefined) bridgeSecret = msg.secret;
            browser.storage.local.set({ bridgeEnabled, bridgeUrl, bridgeSecret });
            break;
        }

        default:
            break;
    }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function registrySnapshot() {
    return Array.from(registry.values()).map(e => ({
        tabId:      e.tabId,
        sessionId:  e.sessionId,
        url:        e.url,
        title:      e.title,
        selected:   e.tabId === selectedTabId,
        lastState:  e.lastState,
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

// Send a message to the popup if it is currently open.
// Uses browser.runtime.sendMessage; the popup listens with onMessage.
function broadcastToPopup(msg) {
    browser.runtime.sendMessage(msg).catch(() => {
        // Popup is not open — ignore.
    });
}

// ── Bridge server relay ────────────────────────────────────────────────────────
// POST state updates to the local bridge server so external apps can read them.

async function relayStateToBridge(state) {
    if (!bridgeEnabled || !bridgeUrl) return;
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (bridgeSecret) headers['X-UberSDR-Secret'] = bridgeSecret;

        await fetch(`${bridgeUrl}/ubersdr/state`, {
            method:  'POST',
            headers: headers,
            body:    JSON.stringify(state),
        });
    } catch (err) {
        // Bridge server not running — silently ignore.
    }
}

// ── Bridge server polling ──────────────────────────────────────────────────────
// Poll the bridge server for commands queued by external apps.

const BRIDGE_POLL_INTERVAL_MS = 500;

async function pollBridgeForCommands() {
    if (!bridgeEnabled || !bridgeUrl || !selectedTabId) return;
    try {
        const headers = {};
        if (bridgeSecret) headers['X-UberSDR-Secret'] = bridgeSecret;

        const res = await fetch(`${bridgeUrl}/ubersdr/commands`, { headers });
        if (!res.ok) return;

        const commands = await res.json();
        if (!Array.isArray(commands)) return;

        for (const cmd of commands) {
            forwardCommandToTab(cmd);
        }
    } catch (err) {
        // Bridge server not running — silently ignore.
    }
}

setInterval(pollBridgeForCommands, BRIDGE_POLL_INTERVAL_MS);
