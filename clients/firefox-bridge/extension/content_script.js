// UberSDR Bridge — Content Script
// Injected into every page. Detects UberSDR pages by probing for window.radioAPI
// and window.userSessionID, then registers with the background script and
// relays state changes / commands bidirectionally.
//
// IMPORTANT — Firefox content script isolation:
// Content scripts run in a sandboxed JS world. They cannot directly access
// window.radioAPI or window.userSessionID set by the page's own scripts.
// To cross this boundary we:
//   1. Inject a <script> element into the page DOM (runs in the real page world)
//      to detect radioAPI and subscribe to its events, then relay data back via
//      window.postMessage.
//   2. Send commands to the page world the same way (postMessage → injected
//      listener calls window.radioAPI / window.setFrequency directly).

(function () {
    'use strict';

    // ── Inject page-world script ───────────────────────────────────────────────
    // This script runs inside the real page JS context (not the content-script
    // sandbox) so it can see window.radioAPI and window.userSessionID.

    function injectPageScript() {
        const script = document.createElement('script');
        script.id = '__ubersdr_bridge_injected__';
        script.textContent = `
(function () {
    'use strict';

    // Avoid double-injection on soft navigations.
    if (window.__ubersdrBridgeActive) return;
    window.__ubersdrBridgeActive = true;

    const MAX_WAIT_MS    = 8000;
    const POLL_INTERVAL  = 250;
    let   waited         = 0;

    function probe() {
        if (window.radioAPI && window.userSessionID) {
            activate();
        } else if (waited < MAX_WAIT_MS) {
            waited += POLL_INTERVAL;
            setTimeout(probe, POLL_INTERVAL);
        }
        // If we reach MAX_WAIT_MS without finding radioAPI this is not an
        // UberSDR page — do nothing.
    }

    function activate() {
        // Detect whether the audio-start overlay is still visible.
        // UberSDR hides #audio-start-overlay by adding the 'hidden' CSS class
        // (audioStartOverlay.classList.add('hidden')) — NOT via style.display.
        var overlay = document.getElementById('audio-start-overlay');
        var audioStarted = !overlay || overlay.classList.contains('hidden');

        // Tell the content script we found an UberSDR page.
        window.postMessage({
            __ubersdr:    true,
            type:         'detected',
            sessionId:    window.userSessionID,
            audioStarted: audioStarted,
        }, '*');

        // Watch for the overlay being hidden (user pressed play).
        // We observe the 'class' attribute because app.js uses classList.add('hidden').
        if (overlay && !audioStarted) {
            var overlayObserver = new MutationObserver(function () {
                if (overlay.classList.contains('hidden')) {
                    overlayObserver.disconnect();
                    window.postMessage({ __ubersdr: true, type: 'audio_started' }, '*');
                }
            });
            overlayObserver.observe(overlay, { attributes: true, attributeFilter: ['class'] });
        }

        // ── Subscribe to radioAPI events and relay them to the content script ──

        window.radioAPI.on('frequency_changed', function (data) {
            window.postMessage({ __ubersdr: true, type: 'state', state: { freq: data.frequency } }, '*');
        });

        window.radioAPI.on('mode_changed', function (data) {
            window.postMessage({ __ubersdr: true, type: 'state', state: { mode: data.mode } }, '*');
        });

        window.radioAPI.on('bandwidth_changed', function (data) {
            window.postMessage({ __ubersdr: true, type: 'state', state: { bwLow: data.low, bwHigh: data.high } }, '*');
        });

        window.radioAPI.on('mute_changed', function (data) {
            window.postMessage({ __ubersdr: true, type: 'state', state: { muted: data.muted } }, '*');
        });

        // ── Listen for commands sent from the content script ───────────────────

        window.addEventListener('message', function (e) {
            if (!e.data || !e.data.__ubersdr_cmd) return;
            var msg = e.data;

            switch (msg.type) {

                case 'cmd:get_state': {
                    var freq = window.radioAPI.getFrequency();
                    var mode = window.radioAPI.getMode();
                    var bw   = window.radioAPI.getBandwidth();
                    window.postMessage({
                        __ubersdr: true,
                        type:      'state_snapshot',
                        state: {
                            freq:      freq,
                            mode:      mode,
                            bwLow:     bw.low,
                            bwHigh:    bw.high,
                            sessionId: window.userSessionID,
                            url:       window.location.href,
                            title:     document.title,
                        },
                    }, '*');
                    break;
                }

                case 'cmd:set_freq': {
                    var hz = parseInt(msg.freq, 10);
                    if (!isNaN(hz) && hz >= 10000 && hz <= 30000000) {
                        // Mirror the changeFrequencyByStep() pattern from band-freq-toggle.js:
                        // disable edge-detection first so the spectrum doesn't auto-scroll
                        // away, then update the input, readout, and send the tune message.

                        // 1. Suppress edge-detection during the update
                        if (window.spectrumDisplay) {
                            window.spectrumDisplay.skipEdgeDetectionTemporary = true;
                        }

                        // 2. Set the input value (data-hz-value attribute + display)
                        if (window.setFrequencyInputValue) {
                            window.setFrequencyInputValue(hz);
                        }

                        // 3. Update the big digit readout
                        if (window.updateFrequencyReadout) {
                            window.updateFrequencyReadout();
                        }

                        // 4. Update spectrum cursor (moves the red tuning line)
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

                        // 8. Re-enable edge-detection after spectrum has updated
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
        // app.js writes window.currentBasebandPower / window.currentNoiseDensity
        // from each audio packet; we relay them as state updates.
        var _lastDbfs = null;
        setInterval(function () {
            var dbfs = window.currentBasebandPower;
            var noise = window.currentNoiseDensity;
            if (typeof dbfs !== 'number' || dbfs <= -900) return;
            // Only send when value has changed by more than 0.5 dB to reduce noise
            if (_lastDbfs !== null && Math.abs(dbfs - _lastDbfs) < 0.5) return;
            _lastDbfs = dbfs;
            var snr = (typeof noise === 'number' && noise > -900)
                ? Math.max(0, dbfs - noise)
                : null;
            window.postMessage({
                __ubersdr: true,
                type: 'state',
                state: { dbfs: dbfs, snr: snr },
            }, '*');
        }, 500);

        console.log('[UberSDR Bridge] Page-world script active — session:', window.userSessionID);
    }

    probe();
})();
        `;

        (document.head || document.documentElement).appendChild(script);
        script.remove(); // Remove the element; the code has already run.
    }

    // ── Listen for messages from the page world ────────────────────────────────

    let initialised = false;

    window.addEventListener('message', function (e) {
        if (!e.data || !e.data.__ubersdr) return;
        const msg = e.data;

        switch (msg.type) {

            case 'detected': {
                if (initialised) break;
                initialised = true;
                init(msg.sessionId, msg.audioStarted);
                break;
            }

            case 'state': {
                browser.runtime.sendMessage({
                    type:  'ubersdr:state',
                    state: msg.state,
                }).catch(() => {});
                break;
            }

            case 'state_snapshot': {
                browser.runtime.sendMessage({
                    type:  'ubersdr:state_snapshot',
                    state: msg.state,
                }).catch(() => {});
                break;
            }

            case 'audio_started': {
                browser.runtime.sendMessage({
                    type: 'ubersdr:audio_started',
                }).catch(() => {});
                break;
            }
        }
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
    // postMessage so the injected script can call radioAPI directly.

    function handleCommand(msg) {
        if (!msg || !msg.type) return;
        // Relay the command into the page world (add sentinel so the injected
        // listener can distinguish it from other postMessage traffic).
        window.postMessage(Object.assign({}, msg, { __ubersdr_cmd: true }), '*');
    }

    // ── Kick off detection ─────────────────────────────────────────────────────
    injectPageScript();

})();
