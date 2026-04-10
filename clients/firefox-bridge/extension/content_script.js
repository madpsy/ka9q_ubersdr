// UberSDR Bridge — Content Script
// Injected into every page. Detects UberSDR pages by probing for window.radioAPI
// and window.userSessionID, then registers with the background script and
// relays state changes / commands bidirectionally.

(function () {
    'use strict';

    // ── Detection ──────────────────────────────────────────────────────────────
    // UberSDR pages expose window.radioAPI (from extensions.js) and
    // window.userSessionID (from app.js). Wait up to 5 s for them to appear.

    const MAX_WAIT_MS = 5000;
    const POLL_INTERVAL_MS = 250;
    let waited = 0;

    function waitForUberSDR() {
        if (window.radioAPI && window.userSessionID) {
            init();
        } else if (waited < MAX_WAIT_MS) {
            waited += POLL_INTERVAL_MS;
            setTimeout(waitForUberSDR, POLL_INTERVAL_MS);
        }
        // If we reach MAX_WAIT_MS without finding radioAPI this is not an UberSDR page — do nothing.
    }

    waitForUberSDR();

    // ── Initialisation ─────────────────────────────────────────────────────────

    function init() {
        const sessionId = window.userSessionID;
        const pageUrl   = window.location.href;
        const pageTitle = document.title;

        // Tell the background script this tab is an UberSDR instance.
        browser.runtime.sendMessage({
            type:      'ubersdr:register',
            sessionId: sessionId,
            url:       pageUrl,
            title:     pageTitle,
        }).catch(() => {
            // Background may not be ready yet — not fatal.
        });

        // ── Subscribe to radioAPI events ───────────────────────────────────────
        // radioAPI.on() is the canonical event bus used by all in-page extensions.

        window.radioAPI.on('frequency_changed', (data) => {
            sendState({ freq: data.frequency });
        });

        window.radioAPI.on('mode_changed', (data) => {
            sendState({ mode: data.mode });
        });

        window.radioAPI.on('bandwidth_changed', (data) => {
            sendState({ bwLow: data.low, bwHigh: data.high });
        });

        // ── Deregister on unload ───────────────────────────────────────────────
        window.addEventListener('beforeunload', () => {
            browser.runtime.sendMessage({
                type:      'ubersdr:deregister',
                sessionId: sessionId,
            }).catch(() => {});
        });

        // ── Listen for commands from background ────────────────────────────────
        browser.runtime.onMessage.addListener(handleCommand);

        console.log('[UberSDR Bridge] Content script active — session:', sessionId);
    }

    // ── State helpers ──────────────────────────────────────────────────────────

    function getFullState() {
        const freq = window.radioAPI.getFrequency();
        const mode = window.radioAPI.getMode();
        const bw   = window.radioAPI.getBandwidth();
        return {
            freq:    freq,
            mode:    mode,
            bwLow:   bw.low,
            bwHigh:  bw.high,
            sessionId: window.userSessionID,
            url:     window.location.href,
            title:   document.title,
        };
    }

    function sendState(partial) {
        browser.runtime.sendMessage({
            type:  'ubersdr:state',
            state: partial,
        }).catch(() => {});
    }

    // ── Command handler ────────────────────────────────────────────────────────
    // Commands arrive from background.js (relayed from the popup or bridge server).

    function handleCommand(msg) {
        if (!msg || !msg.type) return;

        switch (msg.type) {

            case 'cmd:get_state': {
                // Popup or bridge server is asking for a full state snapshot.
                const state = getFullState();
                browser.runtime.sendMessage({
                    type:  'ubersdr:state_snapshot',
                    state: state,
                }).catch(() => {});
                break;
            }

            case 'cmd:set_freq': {
                const hz = parseInt(msg.freq, 10);
                if (!isNaN(hz) && hz >= 10000 && hz <= 30000000) {
                    // Use window.setFrequency (app.js) which handles autoTune, URL update etc.
                    if (window.setFrequency) {
                        window.setFrequency(hz);
                    } else {
                        window.radioAPI.setFrequency(hz);
                    }
                }
                break;
            }

            case 'cmd:set_mode': {
                const validModes = ['usb', 'lsb', 'cwu', 'cwl', 'am', 'sam', 'fm', 'nfm'];
                if (validModes.includes(msg.mode)) {
                    window.radioAPI.setMode(msg.mode);
                }
                break;
            }

            case 'cmd:set_bandwidth': {
                const low  = parseInt(msg.low,  10);
                const high = parseInt(msg.high, 10);
                if (!isNaN(low) && !isNaN(high)) {
                    window.radioAPI.setBandwidth(low, high);
                }
                break;
            }

            case 'cmd:adjust_freq': {
                const delta = parseInt(msg.delta, 10);
                if (!isNaN(delta)) {
                    window.radioAPI.adjustFrequency(delta);
                }
                break;
            }

            default:
                break;
        }
    }

})();
