// UberSDR Bridge — Page World Script (Chrome MV3)
//
// Declared in manifest.json as a MAIN-world content script so it runs in the
// real page JS context and can access window.radioAPI / window.userSessionID.
//
// Cross-world communication uses CustomEvent / dispatchEvent — this works
// reliably between MAIN and ISOLATED worlds in Chrome MV3.  window.postMessage
// is NOT used because it does not reliably cross the world boundary in MV3.
// This script has NO access to chrome.* or browser.* extension APIs.

(function () {
    'use strict';

    console.log('[UberSDR Bridge] page_world.js loaded — url:', window.location.href);

    // Avoid double-injection on soft navigations.
    if (window.__ubersdrBridgeActive) {
        console.log('[UberSDR Bridge] page_world.js already active, skipping');
        return;
    }
    window.__ubersdrBridgeActive = true;

    const MAX_WAIT_MS   = 8000;
    const POLL_INTERVAL = 250;
    let   waited        = 0;

    function probe() {
        console.log('[UberSDR Bridge] probe() — radioAPI:', !!window.radioAPI, 'userSessionID:', !!window.userSessionID, 'waited:', waited);
        if (window.radioAPI && window.userSessionID) {
            activate();
        } else if (waited < MAX_WAIT_MS) {
            waited += POLL_INTERVAL;
            setTimeout(probe, POLL_INTERVAL);
        } else {
            console.log('[UberSDR Bridge] probe() timed out — not an UberSDR page');
        }
    }

    function activate() {
        // Detect whether the audio-start overlay is still visible.
        // UberSDR hides #audio-start-overlay by adding the 'hidden' CSS class.
        var overlay = document.getElementById('audio-start-overlay');
        var audioStarted = !overlay || overlay.classList.contains('hidden');

        // Tell the content script we found an UberSDR page.
        // Use CustomEvent (dispatchEvent) for cross-world communication — this
        // works reliably between MAIN and ISOLATED worlds in Chrome MV3, unlike
        // window.postMessage which may not cross the world boundary in all cases.
        // We dispatch immediately AND re-dispatch on ping (to handle the race
        // where the content script listener wasn't ready when we first fired).
        function sendDetected() {
            window.dispatchEvent(new CustomEvent('__ubersdr_detected', {
                detail: {
                    sessionId:    window.userSessionID,
                    audioStarted: audioStarted,
                },
            }));
        }

        sendDetected();

        // Listen for ping from content script.
        window.addEventListener('__ubersdr_ping', function () {
            console.log('[UberSDR Bridge] page_world received ping — re-sending detected');
            sendDetected();
        });

        // Watch for the overlay being hidden (user pressed play).
        if (overlay && !audioStarted) {
            var overlayObserver = new MutationObserver(function () {
                if (overlay.classList.contains('hidden')) {
                    overlayObserver.disconnect();
                    window.dispatchEvent(new CustomEvent('__ubersdr_audio_started'));
                }
            });
            overlayObserver.observe(overlay, { attributes: true, attributeFilter: ['class'] });
        }

        // ── Subscribe to radioAPI events and relay them to the content script ──

        window.radioAPI.on('frequency_changed', function (data) {
            window.dispatchEvent(new CustomEvent('__ubersdr_state', { detail: { freq: data.frequency } }));
        });

        window.radioAPI.on('mode_changed', function (data) {
            window.dispatchEvent(new CustomEvent('__ubersdr_state', { detail: { mode: data.mode } }));
        });

        window.radioAPI.on('bandwidth_changed', function (data) {
            window.dispatchEvent(new CustomEvent('__ubersdr_state', { detail: { bwLow: data.low, bwHigh: data.high } }));
        });

        window.radioAPI.on('mute_changed', function (data) {
            window.dispatchEvent(new CustomEvent('__ubersdr_state', { detail: { muted: data.muted } }));
        });

        // ── Listen for commands sent from the content script ───────────────────

        window.addEventListener('__ubersdr_cmd', function (e) {
            var msg = e.detail;
            if (!msg) return;

            switch (msg.type) {

                case 'cmd:get_state': {
                    var freq = window.radioAPI.getFrequency();
                    var mode = window.radioAPI.getMode();
                    var bw   = window.radioAPI.getBandwidth();
                    window.dispatchEvent(new CustomEvent('__ubersdr_state_snapshot', {
                        detail: {
                            freq:      freq,
                            mode:      mode,
                            bwLow:     bw.low,
                            bwHigh:    bw.high,
                            sessionId: window.userSessionID,
                            url:       window.location.href,
                            title:     document.title,
                        },
                    }));
                    break;
                }

                case 'cmd:set_freq': {
                    var hz = parseInt(msg.freq, 10);
                    if (!isNaN(hz) && hz >= 10000 && hz <= 30000000) {
                        // 1. Suppress edge-detection during the update
                        if (window.spectrumDisplay) {
                            window.spectrumDisplay.skipEdgeDetectionTemporary = true;
                        }
                        // 2. Set the input value
                        if (window.setFrequencyInputValue) {
                            window.setFrequencyInputValue(hz);
                        }
                        // 3. Update the big digit readout
                        if (window.updateFrequencyReadout) {
                            window.updateFrequencyReadout();
                        }
                        // 4. Update spectrum cursor
                        if (window.updateSpectrumCursor) {
                            window.updateSpectrumCursor();
                        }
                        // 5. Update band buttons / selector / URL
                        if (window.updateBandButtons) window.updateBandButtons(hz);
                        if (window.updateBandSelector) window.updateBandSelector();
                        if (window.updateURL) window.updateURL();
                        // 6. Notify extensions
                        if (window.radioAPI) window.radioAPI.notifyFrequencyChange(hz);
                        // 7. Send tune message to server
                        if (window.autoTune) {
                            window.autoTune();
                        }
                        // 8. Re-enable edge-detection
                        setTimeout(function () {
                            if (window.spectrumDisplay) {
                                window.spectrumDisplay.skipEdgeDetectionTemporary = false;
                            }
                        }, 2000);
                    }
                    break;
                }

                case 'cmd:set_mode': {
                    var validModes = ['usb', 'lsb', 'cwu', 'cwl', 'am', 'sam', 'fm', 'nfm'];
                    if (validModes.indexOf(msg.mode) !== -1) {
                        window.radioAPI.setMode(msg.mode);
                    }
                    break;
                }

                case 'cmd:set_bandwidth': {
                    var low  = parseInt(msg.low,  10);
                    var high = parseInt(msg.high, 10);
                    if (!isNaN(low) && !isNaN(high)) {
                        window.radioAPI.setBandwidth(low, high);
                    }
                    break;
                }

                case 'cmd:adjust_freq': {
                    var delta = parseInt(msg.delta, 10);
                    if (!isNaN(delta)) {
                        window.radioAPI.adjustFrequency(delta);
                    }
                    break;
                }

                case 'cmd:set_mute': {
                    window.radioAPI.setMuted(!!msg.muted);
                    break;
                }
            }
        });

        // ── Poll signal quality globals every 500 ms ──────────────────────────
        var _lastDbfs = null;
        setInterval(function () {
            var dbfs = window.currentBasebandPower;
            var noise = window.currentNoiseDensity;
            if (typeof dbfs !== 'number' || dbfs <= -900) return;
            if (_lastDbfs !== null && Math.abs(dbfs - _lastDbfs) < 0.5) return;
            _lastDbfs = dbfs;
            var snr = (typeof noise === 'number' && noise > -900)
                ? Math.max(0, dbfs - noise)
                : null;
            window.dispatchEvent(new CustomEvent('__ubersdr_state', {
                detail: { dbfs: dbfs, snr: snr },
            }));
        }, 500);

        console.log('[UberSDR Bridge] Page-world script active — session:', window.userSessionID);
    }

    probe();
})();
