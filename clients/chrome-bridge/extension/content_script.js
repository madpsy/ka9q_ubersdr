// UberSDR Bridge — Content Script (Chrome MV3)
// Injected into every page (ISOLATED world). Detects UberSDR pages by listening
// for CustomEvents dispatched by page_world.js (MAIN world), then registers with
// the background service worker and relays state changes / commands bidirectionally.
//
// Cross-world communication uses CustomEvent / dispatchEvent throughout.
// window.postMessage is NOT used — it does not reliably cross the MAIN/ISOLATED
// world boundary in Chrome MV3.

(function () {
    'use strict';

    // ── browser shim ───────────────────────────────────────────────────────────
    // Firefox exposes a Promise-based `browser` API.
    // Chrome exposes `chrome.*` which returns Promises in Chrome 99+ but older
    // versions use callbacks. We build a minimal Promise-based shim so the rest
    // of the content script can use `.catch()` safely on all Chrome versions.
    const browser = (typeof globalThis.browser !== 'undefined') ? globalThis.browser : {
        runtime: {
            sendMessage: (msg) => new Promise((resolve, reject) => {
                try {
                    chrome.runtime.sendMessage(msg, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else {
                            resolve(response);
                        }
                    });
                } catch (e) {
                    reject(e);
                }
            }),
            onMessage: chrome.runtime.onMessage,
        },
    };

    // page_world.js is declared in manifest.json as a MAIN-world content script —
    // no scripting API call needed.  This ISOLATED-world script only needs to:
    //   1. Listen for CustomEvents dispatched by page_world.js
    //   2. Forward messages to/from the background service worker

    console.log('[UberSDR Bridge] content_script.js loaded — url:', window.location.href);

    // ── Listen for CustomEvents from the page world (MAIN → ISOLATED) ──────────

    let initialised   = false;
    let _sessionId    = null;
    let _audioStarted = false;

    // page_world.js fires '__ubersdr_detected' when it confirms radioAPI is present.
    window.addEventListener('__ubersdr_detected', function (e) {
        const detail = e.detail || {};
        console.log('[UberSDR Bridge] content_script received __ubersdr_detected, sessionId:', detail.sessionId);
        if (initialised) return;
        initialised   = true;
        _sessionId    = detail.sessionId;
        _audioStarted = !!detail.audioStarted;
        init(detail.sessionId, detail.audioStarted);
    });

    // page_world.js fires '__ubersdr_state' for incremental state updates.
    window.addEventListener('__ubersdr_state', function (e) {
        const detail = e.detail || {};
        browser.runtime.sendMessage({
            type:  'ubersdr:state',
            state: detail,
        }).catch(() => {});
    });

    // page_world.js fires '__ubersdr_state_snapshot' in response to cmd:get_state.
    window.addEventListener('__ubersdr_state_snapshot', function (e) {
        const detail = e.detail || {};
        browser.runtime.sendMessage({
            type:  'ubersdr:state_snapshot',
            state: detail,
        }).catch(() => {});
    });

    // page_world.js fires '__ubersdr_audio_started' when the play overlay is dismissed.
    window.addEventListener('__ubersdr_audio_started', function () {
        _audioStarted = true;
        browser.runtime.sendMessage({
            type: 'ubersdr:audio_started',
        }).catch(() => {});
    });

    // ── Initialisation (called once radioAPI is confirmed present) ─────────────

    function init(sessionId, audioStarted) {
        const pageUrl   = window.location.href;
        const pageTitle = document.title;

        // Tell the background script this tab is an UberSDR instance.
        browser.runtime.sendMessage({
            type:         'ubersdr:register',
            sessionId:    sessionId,
            url:          pageUrl,
            title:        pageTitle,
            audioStarted: !!audioStarted,
        }).catch(() => {
            // Background may not be ready yet — not fatal.
        });

        // Watch for document.title changes and keep the background registry in sync.
        const titleEl = document.querySelector('title');
        if (titleEl) {
            new MutationObserver(function () {
                browser.runtime.sendMessage({
                    type:  'ubersdr:title_update',
                    title: document.title,
                }).catch(() => {});
            }).observe(titleEl, { childList: true });
        }

        // Deregister on unload.
        window.addEventListener('beforeunload', function () {
            browser.runtime.sendMessage({
                type:      'ubersdr:deregister',
                sessionId: sessionId,
            }).catch(() => {});
        });

        // Listen for commands from the background script.
        browser.runtime.onMessage.addListener(handleCommand);

        console.log('[UberSDR Bridge] Content script active — session:', sessionId);
    }

    // ── Command handler ────────────────────────────────────────────────────────
    // Commands arrive from background.js. Forward them into the page world via
    // CustomEvent so page_world.js can call radioAPI directly.

    function handleCommand(msg) {
        if (!msg || !msg.type) return;

        // Re-register request: background asks us to re-send ubersdr:register
        // so it can rediscover already-open tabs after the plugin is re-enabled.
        if (msg.type === 'cmd:reregister') {
            if (initialised) {
                browser.runtime.sendMessage({
                    type:         'ubersdr:register',
                    sessionId:    _sessionId,
                    url:          window.location.href,
                    title:        document.title,
                    audioStarted: _audioStarted,
                }).catch(() => {});
            }
            return;
        }

        // Relay the command into the page world via CustomEvent.
        // page_world.js listens for '__ubersdr_cmd' and reads e.detail.
        window.dispatchEvent(new CustomEvent('__ubersdr_cmd', { detail: msg }));
    }

    // ── Ping page_world.js ─────────────────────────────────────────────────────
    // page_world.js (MAIN world) may have already fired '__ubersdr_detected'
    // before this content script (ISOLATED world) set up its listeners — a race
    // condition inherent to the two-world injection model.
    // We send a ping so page_world.js re-sends 'detected' if it already activated.
    // Use setTimeout(0) to ensure the ping fires after all synchronous setup is
    // complete and the CustomEvent listeners are definitely registered.
    setTimeout(function () {
        console.log('[UberSDR Bridge] content_script sending ping to page_world');
        window.dispatchEvent(new CustomEvent('__ubersdr_ping'));
    }, 0);

})();
