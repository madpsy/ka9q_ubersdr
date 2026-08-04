// Wires the Media Session controller to the app.
//
// The controller is plain JS and knows nothing about React; everything that has
// to be *watched* — the dial, the spots, the mute state, whether the receiver
// is running — is watched here and pushed in. Mounted once at the top of the
// tree, because the lock-screen card has to keep working with every panel shut
// and the receiver in a background tab.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from '../../react.js';
import { useRadio } from '../RadioContext.jsx';
import { useDisplay } from '../../display/DisplayContext.jsx';
import { getSessionId } from '../session.js';
import { subscribeSpots } from '../../lib/spotStore.js';
import { subscribeVoiceActivity } from '../../lib/voiceActivity.js';
import { CALLSIGN_TYPES, NAV_TYPES, collectMarkers, findMarkers } from '../../lib/markerNav.js';
import { MediaSessionController } from './controller.js';
import { ANCHORS, mediaSupport } from './support.js';
import { onLookupResolved, peekLookup, startLookup } from './lookup.js';

const SETTINGS_KEY = 'ubersdr.v2.media';

// What ⏮/⏭ do. 'freq' steps the dial by the tuning step; 'marker' jumps to the
// adjacent spot or bookmark, which on a busy band is the more useful of the two
// and on a dead one does nothing.
export const SKIP_MODES = [
    { value: 'freq', label: 'Tune' },
    { value: 'marker', label: 'Markers' },
];

function loadSettings() {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch (e) {
        return {};
    }
}

function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

const MediaSessionContext = createContext(null);

export function useMediaSession() {
    return useContext(MediaSessionContext);
}

export function MediaSessionProvider({ children }) {
    const support = useMemo(mediaSupport, []);
    const saved = useMemo(loadSettings, []);
    const { tuning, serverInfo, running, audio, session, actions, catalog, player } = useRadio();
    const { tuneStep } = useDisplay();

    const [enabled, setEnabledState] = useState(
        saved.enabled != null ? !!saved.enabled : support.defaultEnabled,
    );
    const [skipMode, setSkipModeState] = useState(saved.skipMode === 'marker' ? 'marker' : 'freq');
    // Which marker types ⏮/⏭ will stop on. Everything, unless narrowed.
    const [navTypes, setNavTypesState] = useState(
        Array.isArray(saved.navTypes) && saved.navTypes.length ? saved.navTypes : null,
    );
    const [anchor, setAnchorState] = useState(
        ANCHORS.includes(saved.anchor) ? saved.anchor : 'auto',
    );
    const [status, setStatus] = useState({
        available: support.available, enabled: false, anchor: support.anchor, state: 'off', streamMode: null, error: '',
    });

    // Marker sources. Subscribed only while the feature is on: the voice
    // activity poll is a request every five seconds, and a feature that is off
    // should cost nothing at all.
    const [dxSpots, setDxSpots] = useState([]);
    const [cwSpots, setCwSpots] = useState([]);
    const [voice, setVoice] = useState([]);

    // Everything the action handlers need, without re-installing them on every
    // render — the handlers are set once when the feature is enabled.
    const live = useRef({});
    live.current = { ...live.current, tuning, tuneStep, skipMode, actions, session, audio };

    const controller = useRef(null);
    if (!controller.current) {
        controller.current = new MediaSessionController({
            player: null,   // filled in below, once the radio context exists
            sessionId: () => getSessionId(),
            onStatus: setStatus,

            // ⏮/⏭. Marker mode falls back to a frequency step when there is no
            // neighbour, so the buttons are never dead on a quiet band.
            step: (dir) => {
                const l = live.current;
                if (l.skipMode === 'marker') {
                    const target = dir < 0 ? l.markers.prev : l.markers.next;
                    if (target) {
                        l.actions.tuneTo({ frequency: target.freq, mode: target.mode || undefined });
                        return;
                    }
                }
                l.actions.stepBy(l.tuneStep || 500, dir);
            },

            setMuted: (muted) => {
                const l = live.current;
                if (!!l.audio.muted !== !!muted) l.actions.toggleMute();
            },

            // The lock-screen dismiss button, so the panel follows suit.
            disable: () => setEnabledState(false),

            // The scrubber shows session time remaining. Unlimited sessions
            // report nothing and the controller falls back to a live duration.
            position: () => {
                const s = live.current.session;
                if (!s || !s.maxSec || !s.startedAt) return null;
                return { duration: s.maxSec, position: (Date.now() - s.startedAt) / 1000 };
            },
        });
    }
    const ctl = controller.current;

    // The player belongs to RadioProvider and is reachable only from inside it,
    // which is why this provider sits below it in the tree.
    ctl.host.player = player;

    useEffect(() => {
        if (!enabled) return undefined;
        return subscribeSpots('dx', setDxSpots);
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return undefined;
        return subscribeSpots('cw', setCwSpots);
    }, [enabled]);

    // The detector runs off the noise floor monitor, so on an instance without
    // it the poll would be a request every five seconds for a 404 — the same
    // gate the Voice activity panel uses to be absent entirely.
    const hasVoice = !!(serverInfo && serverInfo.noise_floor);

    useEffect(() => {
        if (!enabled || !hasVoice) return undefined;
        return subscribeVoiceActivity((state) => {
            setVoice((state && state.activities) || []);
        });
    }, [enabled, hasVoice]);

    // Marker under the dial, plus its neighbours for ⏮/⏭.
    const markers = useMemo(() => {
        if (!enabled) return { current: null, prev: null, next: null };
        const all = collectMarkers({
            dx: dxSpots,
            cw: cwSpots,
            voice,
            bookmarks: catalog.bookmarks || [],
            local: catalog.local || [],
        });
        return findMarkers(all, tuning.frequency, tuning.mode, navTypes);
    }, [enabled, dxSpots, cwSpots, voice, catalog.bookmarks, catalog.local,
        tuning.frequency, tuning.mode, navTypes]);
    live.current.markers = markers;

    // Operator name and photo for a callsign marker.
    const marker = markers.current;
    const wantsLookup = !!(enabled && marker && CALLSIGN_TYPES.has(marker.type) && marker.name
        && serverInfo && serverInfo.lookup_service);

    // The fetch is an effect, not part of the memo below: a memo may be
    // re-evaluated or discarded whenever React likes, and a network request is
    // not something to hang off that.
    useEffect(() => {
        if (wantsLookup) startLookup(marker.name, getSessionId());
    }, [wantsLookup, marker]);

    // Re-read when a lookup lands — it arrives seconds after the tuning change
    // that asked for it, by which point the OS has drawn the card without it.
    const [lookupTick, setLookupTick] = useState(0);
    useEffect(() => onLookupResolved(() => setLookupTick((n) => n + 1)), []);

    const lookup = useMemo(
        () => (wantsLookup ? peekLookup(marker.name) : null),
        [wantsLookup, marker, lookupTick],
    );

    // ---- push state into the controller ------------------------------------

    useEffect(() => {
        ctl.setEnabled(enabled).catch(() => { /* reported through status */ });
    }, [ctl, enabled]);

    useEffect(() => {
        ctl.setRunning(running);
    }, [ctl, running]);

    useEffect(() => {
        ctl.setAnchorOverride(anchor).catch(() => { /* reported through status */ });
    }, [ctl, anchor]);

    useEffect(() => {
        ctl.update({
            frequency: tuning.frequency,
            mode: tuning.mode,
            receiver: (serverInfo && serverInfo.receiver && serverInfo.receiver.callsign) || '',
            marker,
            lookup,
            photo: (lookup && lookup.photo) || '',
        });
    }, [ctl, tuning.frequency, tuning.mode, serverInfo, marker, lookup]);

    // Volume, mute and the output device have to reach the HTTP stream element
    // as well: while it is playing, the AudioContext is silent and that element
    // is what the operator actually hears.
    useEffect(() => {
        ctl.setOutput({ volume: audio.volume, muted: audio.muted, sinkId: audio.sinkId });
    }, [ctl, audio.volume, audio.muted, audio.sinkId]);

    useEffect(() => {
        saveSettings({ enabled, skipMode, navTypes, anchor });
    }, [enabled, skipMode, navTypes, anchor]);

    useEffect(() => () => ctl.destroy(), [ctl]);

    const value = useMemo(() => ({
        support,
        status,
        enabled,
        setEnabled: setEnabledState,
        skipMode,
        setSkipMode: setSkipModeState,
        navTypes,
        setNavTypes: setNavTypesState,
        navTypeOptions: NAV_TYPES,
        anchor,
        setAnchor: setAnchorState,
        // What the panel shows as "now playing", so the operator can see what
        // the lock screen says without picking up the phone.
        marker,
        lookup,
        neighbours: { prev: markers.prev, next: markers.next },
    }), [support, status, enabled, skipMode, navTypes, anchor, marker, lookup, markers.prev, markers.next]);

    return (
        <MediaSessionContext.Provider value={value}>
            {children}
        </MediaSessionContext.Provider>
    );
}
