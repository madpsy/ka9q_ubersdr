// browser-extension-detector.js
// Loaded as a plain (non-module) <script> early in index.html so that
// window.uberSDRBridgeDetected is available to ALL other scripts without
// any import — app.js, widgets, extensions, inline scripts, everything.
//
// The UberSDR browser extensions (Chrome + Firefox) inject page_world.js
// into the MAIN world. That script:
//   1. Sets window.__ubersdrBridgeActive = true immediately on injection
//   2. Dispatches CustomEvent '__ubersdr_detected' once it confirms
//      window.radioAPI and window.userSessionID are present
//
// This detector listens for both signals and exposes:
//   window.uberSDRBridgeDetected  — boolean, false until extension confirmed
//   window.uberSDRBridgeDetail    — object { sessionId, audioStarted } or {}
//   window event 'ubersdr:bridge-detected' — fired once when confirmed

(function () {
    'use strict';

    // Initialise to false immediately so any script can safely read the flag
    // before the extension has had a chance to activate.
    window.uberSDRBridgeDetected = false;
    window.uberSDRBridgeDetail   = {};

    function onDetected(detail) {
        if (window.uberSDRBridgeDetected) return; // fire only once
        window.uberSDRBridgeDetected = true;
        window.uberSDRBridgeDetail   = detail || {};
        window.dispatchEvent(new CustomEvent('ubersdr:bridge-detected', {
            detail: window.uberSDRBridgeDetail,
        }));
    }

    // Case 1: extension was injected before this script ran (rare but possible
    // when the page is served from cache and the extension is already active).
    if (window.__ubersdrBridgeActive) {
        onDetected({});
    }

    // Case 2: normal path — extension probes for window.radioAPI (up to 8 s)
    // and fires '__ubersdr_detected' once confirmed.
    window.addEventListener('__ubersdr_detected', function (e) {
        onDetected(e && e.detail ? e.detail : {});
    });
})();
