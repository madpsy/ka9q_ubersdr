// Compatibility layer for the v1 popup pages. Renders nothing.
//
// See legacyBridge.js for why this exists. In short: voice-activity.html,
// callsign_lookup.html and channels-map.html reach into `window.opener` for
// globals v1 published and v2 does not, so under v2 they open, show their data,
// and then do nothing when you act on it. This puts that surface back.
//
// Three separate mechanisms, because v1 grew three:
//
//   globals      functions and data the popups call/read directly on the
//                opener. Published here against v2's radio actions.
//   inbound      postMessages the lookup page sends us: set the rotator, pick
//                an antenna, ask for a status push. The password stays on this
//                side, which is the point of the message rather than letting
//                the popup POST for itself.
//   outbound     rotator and antenna status pushed to the lookup page while it
//                is open, so it can show the beam heading and the switch.
//
// The status polling runs only while a lookup popup is actually open. The
// hardware panels do their own polling and are unmounted when collapsed, so
// this cannot lean on them — but nor should it add two more request loops to
// every session that never opens the popup.

import React, { useEffect, useRef } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { getSessionId } from '../radio/session.js';
import { antSwitchStatusMessage, callsignLookupWindow, rotatorStatusMessage } from './legacyBridge.js';

// v1's cadences (rotator-ui.js): the rotator pushes on its 1 s poll, the
// antenna switch on its own slower one.
const ROTATOR_MS = 1000;
const ANT_MS = 5000;

// The same localStorage keys v1 and the v2 hardware panels use, so a password
// typed anywhere is honoured here too (see panels/hardwareAuth.jsx).
const ROTCTL_PW = 'rotctl_password';
const ANT_PW = 'ant_switch_password';

function password(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
}

function post(win, payload) {
    if (!win) return;
    try { win.postMessage(payload, window.location.origin); } catch (e) { /* closed */ }
}

export default function LegacyBridge() {
    const { tuning, serverInfo, actions } = useRadio();

    // The globals are installed once but must call through to the latest
    // actions and read the latest state, so everything goes via refs.
    const ref = useRef({});
    ref.current = { tuning, serverInfo, actions };

    const rotatorOn = !!(serverInfo && serverInfo.rotator && serverInfo.rotator.enabled);
    const antOn = !!(serverInfo && serverInfo.ant_switch && serverInfo.ant_switch.enabled);

    // --- globals the popups call and read ---------------------------------
    useEffect(() => {
        const w = window;

        // app.js: setFrequency(hz). voice-activity.html and the DX cluster
        // pages call this directly.
        w.setFrequency = (hz) => {
            const n = Number(hz);
            if (Number.isFinite(n)) ref.current.actions.setFrequency(n);
        };

        // app.js: setMode(mode, preserveBandwidth). The second argument is not
        // decoration — voice-activity.html passes false explicitly to get the
        // mode's default passband, which is what v2's setMode does. `true` has
        // to put the current passband back.
        w.setMode = (mode, preserveBandwidth) => {
            const { actions: a, tuning: t } = ref.current;
            if (preserveBandwidth) {
                a.tuneTo({ mode, bandwidthLow: t.bandwidthLow, bandwidthHigh: t.bandwidthHigh });
            } else {
                a.setMode(mode);
            }
        };

        // app.js: tuneToChannel(freq, mode, bwLow, bwHigh) — channels-map.html.
        // One tune rather than three calls, so the receiver never passes
        // through an intermediate mode/passband combination on the way.
        w.tuneToChannel = (frequency, mode, bandwidthLow, bandwidthHigh) => {
            ref.current.actions.tuneTo({ frequency, mode, bandwidthLow, bandwidthHigh });
        };

        return () => {
            delete w.setFrequency;
            delete w.setMode;
            delete w.tuneToChannel;
        };
    }, []);

    // /api/description, under the name v1 gave it. channels-map.html reads the
    // receiver's position from this to centre its map.
    useEffect(() => {
        if (serverInfo) window.instanceDescription = serverInfo;
    }, [serverInfo]);

    // callsign_lookup.html needs the session UUID to call /api/lookup. It
    // normally arrives in the URL; the global is what v1 builds that URL from.
    useEffect(() => {
        window.userSessionID = getSessionId();
    }, []);

    // --- inbound: messages from the lookup popup --------------------------
    useEffect(() => {
        const onMessage = (event) => {
            // Same-origin only. The popup is served from this host and nothing
            // else has any business driving the antenna.
            if (event.origin !== window.location.origin) return;
            const msg = event.data;
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'rotator_set_bearing') {
                const azimuth = parseFloat(msg.bearing);
                const pw = password(ROTCTL_PW);
                if (!Number.isFinite(azimuth) || !pw) return;
                fetch('/api/rotctl/position', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pw, azimuth }),
                }).then((r) => {
                    // A rejected password is cleared here as well as in the
                    // panel, or the popup's Set button silently fails forever.
                    if (r.status === 401) localStorage.removeItem(ROTCTL_PW);
                }).catch(() => { /* the popup gets no ack either way */ });
                return;
            }

            if (msg.type === 'ant_switch_select') {
                const antenna = parseInt(msg.antenna, 10);
                const pw = password(ANT_PW);
                if (Number.isNaN(antenna) || !pw) return;
                fetch('/api/ant-switch/command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: pw, command: 'select', antenna }),
                }).then((r) => {
                    if (r.status === 401) localStorage.removeItem(ANT_PW);
                }).catch(() => { /* ignore */ });
                return;
            }

            // Sent on open, so the popup does not sit blank until the next
            // poll comes round.
            if (msg.type === 'request_ant_switch_status') {
                const win = callsignLookupWindow();
                if (!win || !antOn) return;
                fetch('/api/ant-switch/status')
                    .then((r) => (r.ok ? r.json() : null))
                    .then((d) => { if (d) post(win, antSwitchStatusMessage(d, password(ANT_PW))); })
                    .catch(() => { /* ignore */ });
            }
        };

        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [antOn]);

    // --- outbound: status pushed while the popup is open ------------------
    useEffect(() => {
        if (!rotatorOn && !antOn) return undefined;
        let cancelled = false;
        let rotatorTimer = null;
        let antTimer = null;

        const pushRotator = () => {
            const win = callsignLookupWindow();
            if (!win) return;
            fetch('/api/rotctl/status')
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => {
                    if (cancelled || !d) return;
                    post(callsignLookupWindow(), rotatorStatusMessage(d, password(ROTCTL_PW)));
                })
                .catch(() => { /* the popup keeps its last reading */ });
        };

        const pushAnt = () => {
            const win = callsignLookupWindow();
            if (!win) return;
            fetch('/api/ant-switch/status')
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => {
                    if (cancelled || !d) return;
                    post(callsignLookupWindow(), antSwitchStatusMessage(d, password(ANT_PW)));
                })
                .catch(() => { /* ignore */ });
        };

        if (rotatorOn) rotatorTimer = setInterval(pushRotator, ROTATOR_MS);
        if (antOn) antTimer = setInterval(pushAnt, ANT_MS);

        return () => {
            cancelled = true;
            clearInterval(rotatorTimer);
            clearInterval(antTimer);
        };
    }, [rotatorOn, antOn]);

    return null;
}
