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
// Race condition: both this script and page_world.js run at document_idle,
// so '__ubersdr_detected' may fire before our listener is registered.
// We handle this by:
//   a) Checking __ubersdrBridgeActive + radioAPI synchronously (already fully active)
//   b) Listening for '__ubersdr_detected' for the normal async path
//   c) Polling with setTimeout as a belt-and-suspenders fallback
//
// Exposes:
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

    // Case 1: __ubersdrBridgeActive is already set AND radioAPI is present —
    // the extension fully activated before this script ran (event already fired).
    if (window.__ubersdrBridgeActive && window.radioAPI && window.userSessionID) {
        onDetected({});
    }

    // Case 2: normal async path — extension fires '__ubersdr_detected' after
    // confirming radioAPI is present (up to 8 s after page load).
    window.addEventListener('__ubersdr_detected', function (e) {
        onDetected(e && e.detail ? e.detail : {});
    });

    // Case 3: belt-and-suspenders poll — catches the race where __ubersdrBridgeActive
    // is set but radioAPI arrived between Case 1 check and the event listener setup,
    // or where the event fired in the same microtask tick before our listener was ready.
    // Poll for up to 10 s in case radioAPI is slow to appear.
    var _pollCount = 0;
    var _pollMax   = 40; // 40 × 250 ms = 10 s
    function poll() {
        if (window.uberSDRBridgeDetected) return; // already done
        _pollCount++;
        if (window.__ubersdrBridgeActive && window.radioAPI && window.userSessionID) {
            onDetected({});
            return;
        }
        if (_pollCount < _pollMax) {
            setTimeout(poll, 250);
        }
    }
    setTimeout(poll, 250);
})();
