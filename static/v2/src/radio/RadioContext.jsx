// The single place that owns the radio: both WebSockets, the audio player, and
// the control state the panels read and write.
//
// Data is split by update rate:
//   * control state (frequency, mode, filters, connection status) lives in
//     React state — it changes when a human does something;
//   * meters (signal power, audio level, buffer depth) live on a mutable object
//     that components sample with `useMeters`, so 50 packets/second never
//     become 50 renders/second;
//   * spectrum frames never touch React at all — the canvas subscribes to the
//     connection directly.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from '../react.js';
import { AudioConnection } from './audio-connection.js';
import { SpectrumConnection } from './spectrum-connection.js';
import { AudioPlayer } from './audio-player.js';
import { connectionCheck, newSessionId } from './session.js';
import { localBookmarks as localBookmarkStore, onLocalBookmarksChanged } from '../lib/localBookmarks.js';
import { FILTER_DEFAULTS } from './audio-filters.js';
import {
    AGC_CONTROLS, MAX_FREQ, MIN_FREQ, MODE_BY_ID, MODES, bandwidthLimits, defaultAGC, hasAGCSettings,
    SQUELCH_AUTO_SAMPLES, SQUELCH_HANG_MS, SQUELCH_MIN, SQUELCH_SENTINEL, snapStep,
    autoSquelchValue, squelchEnabled, squelchThreshold,
} from './constants.js';
import { clamp } from '../lib/format.js';
import { defaultParams, toWire } from '../lib/dsp.js';
import { throttle } from '../lib/throttle.js';
import { needsRecenter, resumeView, zoomCenter } from '../lib/zoom.js';
import { loadRadioSettings, saveRadioSettings } from '../lib/radioSettings.js';
import { hiddenGroups, onGroupsChanged, visibleBookmarks } from '../lib/bookmarkGroups.js';

const RadioContext = createContext(null);

// Where the dial starts, and whether anybody actually asked for it.
//
// `chosen` is false when nothing but the built-in fallback was available — no
// ?freq/?mode in the URL and nothing saved from a previous visit. Only then
// does the operator's own default apply, once /api/description arrives; see
// applyServerDefaults. A link someone was sent, or the frequency they left the
// receiver on, both outrank it.
function initialTuning() {
    const saved = loadRadioSettings();
    const url = new URLSearchParams(location.search);

    const urlFreq = Number(url.get('freq') || url.get('frequency'));
    const urlMode = url.get('mode');

    const mode = MODE_BY_ID[urlMode] ? urlMode : (MODE_BY_ID[saved.mode] ? saved.mode : 'lsb');
    const def = MODE_BY_ID[mode];
    const restore = saved.mode === mode;
    // A layout saved before the limits changed can hold a wider passband than
    // the mode now allows, so restored edges are clamped too.
    const l = bandwidthLimits(mode);
    return {
        frequency: clamp(urlFreq > 0 ? urlFreq : (saved.frequency || 7100000), MIN_FREQ, MAX_FREQ),
        mode,
        bandwidthLow: clamp(restore && saved.bandwidthLow != null ? saved.bandwidthLow : def.low, l.min, l.max),
        bandwidthHigh: clamp(restore && saved.bandwidthHigh != null ? saved.bandwidthHigh : def.high, l.min, l.max),
        chosen: {
            frequency: urlFreq > 0 || saved.frequency != null,
            mode: !!MODE_BY_ID[urlMode] || !!MODE_BY_ID[saved.mode],
        },
    };
}

export function RadioProvider({ children }) {
    const saved = useMemo(loadRadioSettings, []);
    const start = useMemo(initialTuning, []);

    // `chosen` is not part of the tuning: it says where the tuning came from,
    // and only until the operator's defaults have had their chance.
    const [tuning, setTuning] = useState(() => {
        const { chosen, ...t } = start;
        return t;
    });
    const [audioState, setAudioState] = useState('idle');
    const [spectrumState, setSpectrumState] = useState('idle');
    const [view, setView] = useState({
        centerFreq: 0, binCount: 0, binBandwidth: 0, span: 0,
        defaultBinBandwidth: 0, defaultBinCount: 0,
        // How often the server is polling for us, as a divisor of the full
        // rate. Set by the idle throttle rather than by anything on screen,
        // which is why the Status panel shows it.
        rateDivisor: 1,
    });
    const [running, setRunning] = useState(false);
    const [serverInfo, setServerInfo] = useState(null);
    // How long this session may run, from /connection: { maxSec, startedAt }.
    // maxSec 0 means unlimited; null until the first session starts.
    // maxSec: how long this session may run at all. idleSec: how long it may
    // sit inactive before the server reclaims it — what the idle watch counts
    // against. Both come from the one /connection reply, and 0 means neither.
    const [session, setSession] = useState({ maxSec: null, idleSec: null, startedAt: 0 });
    const [log, setLog] = useState([]);
    const [audio, setAudio] = useState({
        volume: saved.volume != null ? saved.volume : 0.7,
        muted: !!saved.muted,
        // Transient, and deliberately not restored: a session that ended while
        // the rig was transmitting must not start silent.
        ducked: false,
        bufferSec: saved.bufferSec != null ? saved.bufferSec : 0.2,
        // Whether that came from this browser or is just the built-in. The
        // operator's own default only applies to someone who has never chosen,
        // which is v1's rule (ui-config.js seeds localStorage once).
        bufferFromUser: saved.bufferSec != null,
        // Which side of a stereo stream to listen to: 'both' | 'left' | 'right'.
        channel: saved.channel || 'both',
        // Output device ID, '' being the system default. Device IDs are
        // per-origin and survive a reload, so this is worth restoring — and if
        // the device has gone since, setAudioSink falls back to the default.
        sinkId: saved.sinkId || '',
    });
    // One number: the slider position. Its floor doubles as "off", which is how
    // v1 behaves and avoids an enabled flag that can disagree with the value.
    const [squelchValue, setSquelchValue] = useState(
        saved.squelchValue != null ? saved.squelchValue : SQUELCH_MIN,
    );
    // null until the server reports. `agc_state` carries the operator's
    // config.yaml `ssb_agc` values for anything this session has not
    // overridden, so seeding from our own constants would show the wrong
    // numbers on any receiver whose operator changed them.
    // Bands and bookmarks, fetched once and shared: the panels and the marker
    // bar all need them, and this server publishes 2450 bookmarks — not a
    // payload to pull three times. Bookmarks are kept sorted by frequency so
    // the marker bar can binary-search the visible window.
    const [catalog, setCatalog] = useState({ bands: null, bookmarks: null });
    // Which bookmark groups are switched off. Held here rather than read by
    // each consumer so the filtering happens once, at the source.
    const [hidden, setHidden] = useState(hiddenGroups);
    useEffect(() => onGroupsChanged(setHidden), []);
    // Bookmarks saved in this browser (see lib/localBookmarks.js). Separate from
    // `catalog` because they change independently of the server fetch.
    const [localMarks, setLocalMarks] = useState([]);
    const [agc, setAgc] = useState(null);
    // `schemas` is the server's filter list (null until it answers); `params`
    // is keyed by filter name so switching filters and back keeps your settings.
    const [dsp, setDsp] = useState({
        filter: saved.dspFilter || '',
        enabled: false,          // the server decides; a new session starts off
        schemas: null,
        params: saved.dspParams || {},
    });
    const [followTuning, setFollowTuning] = useState(saved.followTuning !== false);
    // Client-side EQ / notch / bandpass. Merged per section so a spec saved
    // before a field existed still loads.
    const [filters, setFilterState] = useState(() => {
        const from = saved.filters || {};
        const merged = {};
        for (const key of Object.keys(FILTER_DEFAULTS)) {
            merged[key] = { ...FILTER_DEFAULTS[key], ...(from[key] || {}) };
        }
        return merged;
    });

    // Mutable, high-rate values. Never a dependency of a render.
    const meters = useRef({
        basebandPower: null,
        noiseDensity: null,
        snr: null,
        level: 0,
        channels: 0,            // channels in the stream now playing
        makeupDb: 0,            // live compressor makeup gain
        clipping: false,        // output hit full scale in the last moment
        peakDb: -Infinity,      // output peak, dBFS
        outLevel: 0,            // smoothed RMS after the volume control, 0..1
        queuedSec: 0,
        underruns: 0,
        frameAgeMs: 0,
        lastFrameAt: 0,
        squelchOpen: true,      // is the server currently passing audio?
        lastGateOpenAt: 0,
        snrHistory: [],         // recent SNR readings, for the squelch auto-set
    });

    const conn = useRef(null);
    if (conn.current === null) {
        conn.current = {
            audio: new AudioConnection(),
            spectrum: new SpectrumConnection(),
            player: new AudioPlayer(),
        };
    }
    const { audio: audioConn, spectrum: spectrumConn, player } = conn.current;

    const pushLog = useRef((level, text) => {
        setLog((prev) => {
            const next = prev.concat({ id: Date.now() + Math.random(), at: new Date(), level, text });
            return next.length > 200 ? next.slice(-200) : next;
        });
    }).current;

    // Keep the latest tuning available to callbacks without re-subscribing.
    const tuningRef = useRef(tuning);
    tuningRef.current = tuning;
    const followRef = useRef(followTuning);
    followRef.current = followTuning;
    // When the last local tune happened, so a lagging server echo cannot snap
    // the dial back while the user is still turning it.
    const lastLocalTune = useRef(0);
    // Active gate threshold in dB SNR, or null when off. Read from the audio
    // packet handler, which must not re-subscribe when the slider moves.
    const gateRef = useRef(null);
    gateRef.current = squelchEnabled(squelchValue) ? squelchThreshold(squelchValue) : null;
    const agcRef = useRef(agc);
    agcRef.current = agc;
    const lastLocalAgc = useRef(0);
    // The first values the server reports, before this session overrides
    // anything — i.e. the operator's configured defaults. `set_agc` persists an
    // override with no way to clear it, so Reset has to replay these rather
    // than push our own constants and pin the wrong values.
    const serverAgcDefaults = useRef(null);
    const agcRefreshTimer = useRef(null);
    const agcDirty = useRef(false);
    const dspRef = useRef(dsp);
    dspRef.current = dsp;

    // Adopts server-reported AGC values, ignoring an echo that would otherwise
    // snap a slider back while it is still being dragged.
    const applyServerAGC = useRef((incoming) => {
        if (!incoming || Date.now() - lastLocalAgc.current < 1500) return;
        const next = { ...agcRef.current };
        let changed = false;
        for (const c of AGC_CONTROLS) {
            if (typeof incoming[c.id] === 'number' && incoming[c.id] !== next[c.id]) {
                next[c.id] = incoming[c.id];
                changed = true;
            }
        }
        if (serverAgcDefaults.current === null) serverAgcDefaults.current = next;
        if (!changed && agcRef.current !== null) return;
        agcRef.current = next;
        setAgc(next);
    }).current;

    // ---- wiring ---------------------------------------------------------

    // Restored settings live in React state, but the player is a plain object
    // that starts at its own defaults — so without this a saved volume, mute or
    // channel choice only took effect the first time you touched the control.
    useEffect(() => {
        player.setVolume(audio.volume);
        player.setMuted(audio.muted);
        player.setBufferSec(audio.bufferSec);
        player.setChannelMode(audio.channel);
        player.setFilters(filters);
        // Only remembered here — there is no context to route until audio
        // starts, and _createContext applies it then.
        player.setSinkId(audio.sinkId).catch(() => { /* reported when it plays */ });
    }, []);   // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const offs = [];

        offs.push(audioConn.on('state', setAudioState));
        offs.push(audioConn.on('opus', ({ data, sampleRate, channels }) => {
            player.pushOpus(data, sampleRate, channels);
        }));
        offs.push(audioConn.on('pcm', ({ planes, sampleRate }) => {
            player.pushPCM(planes, sampleRate);
        }));
        offs.push(audioConn.on('quality', ({ basebandPower, noiseDensity }) => {
            const m = meters.current;
            m.basebandPower = basebandPower;
            m.noiseDensity = noiseDensity;
            m.snr = basebandPower != null && noiseDensity != null ? basebandPower - noiseDensity : null;
            if (m.snr != null) {
                m.snrHistory.push(m.snr);
                if (m.snrHistory.length > SQUELCH_AUTO_SAMPLES) m.snrHistory.shift();
            }

            // Mirror audioGateAllows() so the indicator reflects what the
            // server is doing, including its 500 ms hang timer — otherwise the
            // badge flickers closed on every syllable gap in speech.
            const threshold = gateRef.current;
            const now = performance.now();
            if (threshold == null) {
                m.squelchOpen = true;
                m.lastGateOpenAt = now;
            } else if (m.snr != null && m.snr >= threshold) {
                m.squelchOpen = true;
                m.lastGateOpenAt = now;
            } else {
                m.squelchOpen = now - m.lastGateOpenAt < SQUELCH_HANG_MS;
            }
        }));
        offs.push(audioConn.on('message', (msg) => {
            if (msg.type === 'status') {
                if (Date.now() - lastLocalTune.current < 1500) return;
                setTuning((t) => {
                    const next = {
                        ...t,
                        frequency: msg.frequency || t.frequency,
                        mode: msg.mode || t.mode,
                    };
                    tuningRef.current = next;
                    return next;
                });
                // status carries the AGC block too, which is how a mode change
                // surfaces the operator defaults the server just re-applied.
                applyServerAGC(msg.agc);
            } else if (msg.type === 'agc_state') {
                applyServerAGC(msg.agc);
            } else if (msg.type === 'dsp_filters') {
                const info = msg.info || {};
                setDsp((d) => {
                    const schemas = info.available ? (info.filters || []) : [];
                    // Seed any filter we have no stored params for, so a slider
                    // never starts at a value the filter does not actually have.
                    const params = { ...d.params };
                    for (const f of schemas) {
                        params[f.name] = { ...defaultParams(f), ...(params[f.name] || {}) };
                    }
                    const filter = d.filter && schemas.some((f) => f.name === d.filter)
                        ? d.filter
                        : (schemas[0] ? schemas[0].name : '');
                    const next = { ...d, schemas, params, filter, unavailableReason: info.reason || '' };
                    dspRef.current = next;
                    return next;
                });
            } else if (msg.type === 'dsp_status') {
                const info = msg.info || {};
                setDsp((d) => {
                    const next = { ...d, enabled: !!info.enabled };
                    if (info.filter) next.filter = info.filter;
                    // The server echoes the full merged parameter set, which is
                    // what the filter is actually running with.
                    if (info.filter && info.params) {
                        next.params = {
                            ...d.params,
                            [info.filter]: { ...(d.params[info.filter] || {}), ...info.params },
                        };
                    }
                    dspRef.current = next;
                    return next;
                });
            }
        }));
        offs.push(audioConn.on('error', (e) => pushLog('error', e.message || 'audio error')));
        offs.push(audioConn.on('close', () => pushLog('warn', 'Audio stream closed')));
        offs.push(audioConn.on('open', () => {
            pushLog('info', 'Audio stream connected');
            // A new session starts with the gate disabled, so re-apply it on
            // every open — including reconnects, which would otherwise silently
            // un-squelch the receiver.
            const threshold = gateRef.current;
            audioConn.setAudioGate({ minSnr: threshold == null ? SQUELCH_SENTINEL : threshold });

            // A reconnect makes a fresh session, which starts at the operator's
            // defaults again. Replay the user's AGC only if they actually
            // changed something — pushing on first connect would pin an
            // override before we even know what the defaults are.
            if (agcDirty.current && agcRef.current) audioConn.setAGC(agcRef.current);
            else audioConn.requestAGC();

            // Parameter schemas are per-server, so fetch them once a session is up.
            audioConn.requestDSPFilters();
            const m = meters.current;
            m.squelchOpen = true;
            m.lastGateOpenAt = performance.now();
        }));

        offs.push(spectrumConn.on('state', setSpectrumState));
        offs.push(spectrumConn.on('config', (cfg) => setView(cfg)));
        offs.push(spectrumConn.on('frame', () => {
            const m = meters.current;
            m.lastFrameAt = performance.now();
        }));
        offs.push(spectrumConn.on('error', (e) => pushLog('error', e.message || 'spectrum error')));
        offs.push(spectrumConn.on('open', () => pushLog('info', 'Spectrum connected')));

        return () => offs.forEach((off) => off());
    }, []);

    // Sample player-owned meters on a slow timer; the packet path stays free of
    // any per-frame bookkeeping.
    useEffect(() => {
        const t = setInterval(() => {
            const m = meters.current;
            m.level = player.level;
            m.queuedSec = player.queuedSec;
            m.underruns = player.underruns;
            m.channels = player.channels;
            m.makeupDb = player.makeupDb;
            m.clipping = player.clipping;
            m.peakDb = player.peakDb;
            m.outLevel = player.outLevel;
            m.frameAgeMs = m.lastFrameAt ? performance.now() - m.lastFrameAt : 0;
        }, 100);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            fetch('/api/bands').then((r) => r.json()).catch(() => []),
            fetch('/api/bookmarks').then((r) => r.json()).catch(() => []),
        ]).then(([bands, bookmarks]) => {
            if (cancelled) return;
            setCatalog({
                bands: Array.isArray(bands) ? bands : [],
                bookmarks: Array.isArray(bookmarks)
                    ? [...bookmarks].sort((a, b) => a.frequency - b.frequency)
                    : [],
            });
        });
        return () => { cancelled = true; };
    }, []);

    // The browser's own bookmarks, kept beside the server's so the marker bar
    // can show both. Loaded here rather than in the panel: they belong on the
    // spectrum whether or not the panel has ever been opened, and they must
    // appear and disappear as they are added, imported and deleted — hence the
    // subscription rather than a one-off read.
    useEffect(() => {
        let cancelled = false;
        const load = () => {
            const store = localBookmarkStore();
            store.ready.then(() => {
                if (cancelled) return;
                setLocalMarks(store.getAll()
                    .map((b) => ({ ...b, source: 'local' }))
                    .sort((a, b) => a.frequency - b.frequency));
            }, () => { /* IndexedDB unavailable — no local bookmarks, no error */ });
        };
        load();
        const off = onLocalBookmarksChanged(load);
        return () => { cancelled = true; off(); };
    }, []);

    // The operator's own starting point, for a visitor who did not bring one.
    //
    // v1 does this from the same reply (app.js, the default_frequency /
    // default_mode block) and applies each independently: a receiver that only
    // sets a default mode still gets it. The mode brings its own passband, as
    // v1 spells out band by band — `setMode` here already does that.
    //
    // Applied before anything is running, so it is a starting position rather
    // than a retune: the dial simply reads differently by the time you press
    // Start.
    useEffect(() => {
        fetch('/api/description')
            .then((r) => r.json())
            .then((d) => {
                setServerInfo(d);
                if (!d) return;
                const freq = Number(d.default_frequency);
                const mode = String(d.default_mode || '').toLowerCase();
                const patch = {};
                if (!start.chosen.frequency && freq >= MIN_FREQ && freq <= MAX_FREQ) {
                    patch.frequency = freq;
                }
                if (!start.chosen.mode && MODE_BY_ID[mode]) {
                    patch.mode = mode;
                    // The mode's own passband, not the one the fallback mode
                    // happened to leave behind.
                    patch.bandwidthLow = MODE_BY_ID[mode].low;
                    patch.bandwidthHigh = MODE_BY_ID[mode].high;
                }
                if (!Object.keys(patch).length) return;
                // Straight into the tuning: nothing is connected yet, so there
                // is nobody to tell and nothing to re-centre. The dial simply
                // reads differently by the time Start is pressed, exactly as it
                // would for a frequency restored from a previous visit.
                const next = { ...tuningRef.current, ...patch };
                tuningRef.current = next;
                setTuning(next);
            })
            .catch(() => { /* non-fatal — the UI just shows fewer details */ });
    }, []);

    // Persist the parts of the session worth restoring.
    useEffect(() => {
        saveRadioSettings({
            frequency: tuning.frequency,
            mode: tuning.mode,
            bandwidthLow: tuning.bandwidthLow,
            bandwidthHigh: tuning.bandwidthHigh,
            volume: audio.volume,
            muted: audio.muted,
            bufferSec: audio.bufferSec,
            channel: audio.channel,
            sinkId: audio.sinkId,
            filters,
            squelchValue,
            dspFilter: dsp.filter,
            dspParams: dsp.params,
            followTuning,
            // Where the spectrum was looking, so a reload comes back to it
            // rather than to full span. The zoom is stored as the bin
            // bandwidth rather than a span because that is what the server
            // quantises and what it takes on the wire — a span would be
            // rounded to the nearest rung on reconnect and drift a little
            // further every time. Only written once the server has said what
            // the view is; a zero would ask for the default anyway, but
            // saving one would throw away a good value during startup.
            ...(view.binBandwidth > 0 && view.centerFreq > 0
                ? {
                    spectrumCenter: view.centerFreq,
                    spectrumBinBandwidth: view.binBandwidth,
                    // Kept as well as the bin bandwidth, and only for the check
                    // at connect time: the span is bandwidth × bin count, and
                    // the bin count is not known until the socket is open.
                    spectrumSpan: view.span,
                }
                : {}),
        });
    }, [tuning, audio, squelchValue, dsp, followTuning, filters, view]);

    // ---- actions --------------------------------------------------------

    const sendTune = useMemo(() => throttle((params) => audioConn.tune(params), 70), []);
    // Dragging the squelch slider would otherwise emit a command per pixel and
    // trip the server's command rate limit.
    const sendGate = useMemo(() => throttle((minSnr) => audioConn.setAudioGate({ minSnr }), 90), []);
    const sendAgc = useMemo(() => throttle((values) => audioConn.setAGC(values), 120), []);
    // Dragging a DSP slider must not emit a command per pixel.
    const sendDspParams = useMemo(() => throttle((params) => audioConn.setDSPParams(params), 120), []);

    const actions = useMemo(() => {
        // Move the view only when the passband would leave the screen — the
        // rule itself is in lib/zoom.js, with the rest of the view geometry.
        const recenterIfNeeded = (t) => {
            if (!followRef.current || !spectrumConn.connected) return;
            if (needsRecenter(t, spectrumConn.centerFreq, spectrumConn.span)) {
                spectrumConn.setView(clamp(t.frequency, MIN_FREQ, MAX_FREQ), null);
            }
        };

        // Applied against the ref rather than inside a state updater: pointer
        // moves can outrun rendering, and a state updater must stay pure.
        const applyTuning = (patch) => {
            const next = { ...tuningRef.current, ...patch };
            next.frequency = clamp(Math.round(next.frequency), MIN_FREQ, MAX_FREQ);
            tuningRef.current = next;
            lastLocalTune.current = Date.now();
            setTuning(next);
            sendTune(next);
            // The whole tuning, not just the frequency: a mode change or a
            // widened filter can put the passband off the edge without the dial
            // having moved at all.
            recenterIfNeeded(next);
        };

        const applySquelch = (value) => {
            setSquelchValue(value);
            gateRef.current = squelchEnabled(value) ? squelchThreshold(value) : null;
            sendGate(squelchThreshold(value));
            if (!squelchEnabled(value)) {
                const m = meters.current;
                m.squelchOpen = true;
                m.lastGateOpenAt = performance.now();
            }
        };

        return {
            async powerOn() {
                const ok = await player.start();
                if (!ok) pushLog('warn', 'Audio context did not start — tap again');
                setRunning(true);
                // A new session gets a new identity. Minted before either socket
                // opens so audio and spectrum are paired under the same UUID.
                newSessionId();
                // Registers the UUID and tells us how long this session may run.
                // The sockets share the cached result, so this costs no extra
                // request; v1 reads max_session_time from the same reply.
                connectionCheck().then((r) => {
                    if (r && r.maxSessionTime != null) {
                        setSession({
                            maxSec: r.maxSessionTime,
                            idleSec: r.sessionTimeout,
                            startedAt: Date.now(),
                        });
                    }
                }, () => { /* the countdown just stays as it was */ });
                const t = tuningRef.current;
                await audioConn.connect(t);
                // Resume the view this browser was last on. The socket already
                // carries the pair for reconnects, so a fresh session is the
                // same journey with the values coming from the last visit
                // instead of from the last second.
                //
                // Both or neither: the server applies whichever of the two it
                // is given and keeps what it had for the other, so a centre
                // without a zoom lands on the full-span default and asks for a
                // 30 MHz window somewhere it cannot exist. connect() clamps for
                // the same reason.
                // Read now rather than from the load-time snapshot: powering
                // off and on again within one visit should come back to the
                // view you left, not the one you arrived with.
                const last = loadRadioSettings();
                await spectrumConn.connect(resumeView(last, t));
            },

            powerOff() {
                audioConn.disconnect();
                spectrumConn.disconnect();
                player.suspend();
                setRunning(false);
            },

            setFrequency(hz) { applyTuning({ frequency: hz }); },

            nudge(delta) { applyTuning({ frequency: tuningRef.current.frequency + delta }); },

            // Steps to the next multiple of `step`, rather than adding to
            // whatever odd frequency happens to be tuned.
            stepBy(step, dir) {
                applyTuning({ frequency: snapStep(tuningRef.current.frequency, step, dir) });
            },

            setMode(mode) {
                const def = MODE_BY_ID[mode];
                if (!def) return;
                applyTuning({ mode, bandwidthLow: def.low, bandwidthHigh: def.high });
                // radiod reloads its preset on a mode change and the server
                // waits 500 ms before re-applying the operator's SSB AGC
                // defaults, so ask for the settled values after that.
                if (hasAGCSettings(mode)) {
                    clearTimeout(agcRefreshTimer.current);
                    agcRefreshTimer.current = setTimeout(() => audioConn.requestAGC(), 800);
                }
            },

            // Frequency, mode and passband in one tune. The v1 popup pages set
            // all three together (tuneToChannel), and doing it as separate
            // actions would walk the receiver through an intermediate state —
            // setMode resets the passband, so the old width would be sent for
            // the new mode before the real one arrived.
            tuneTo({ frequency, mode, bandwidthLow, bandwidthHigh }) {
                const t = tuningRef.current;
                const next = MODE_BY_ID[mode] ? mode : t.mode;
                const def = MODE_BY_ID[next];
                const l = bandwidthLimits(next);
                const lo = bandwidthLow != null ? bandwidthLow : (next === t.mode ? t.bandwidthLow : def.low);
                const hi = bandwidthHigh != null ? bandwidthHigh : (next === t.mode ? t.bandwidthHigh : def.high);
                applyTuning({
                    ...(frequency != null ? { frequency } : {}),
                    mode: next,
                    bandwidthLow: clamp(Math.round(lo), l.min, l.max),
                    bandwidthHigh: clamp(Math.round(hi), l.min, l.max),
                });
                // Same reason as setMode: radiod reloads its preset on a mode
                // change and the server re-applies the operator's SSB AGC
                // defaults 500 ms later.
                if (next !== t.mode && hasAGCSettings(next)) {
                    clearTimeout(agcRefreshTimer.current);
                    agcRefreshTimer.current = setTimeout(() => audioConn.requestAGC(), 800);
                }
            },

            setBandwidth(low, high) {
                // Clamped here rather than only in the slider, so a stored or
                // deep-linked passband cannot exceed the mode's limit either.
                const l = bandwidthLimits(tuningRef.current.mode);
                applyTuning({
                    bandwidthLow: clamp(Math.round(low), l.min, l.max),
                    bandwidthHigh: clamp(Math.round(high), l.min, l.max),
                });
            },

            setVolume(v) {
                player.setVolume(v);
                setAudio((a) => ({ ...a, volume: v }));
            },

            // Absolute, and the one the other two are built on.
            //
            // An outside controller has to be able to say "muted" rather than
            // "the other one": PTT mute is driven by "the rig is transmitting:
            // true/false", and a toggle desynchronises permanently the first
            // time a message is missed. Emulating it by reading the current
            // value and toggling if it differs is not the same thing — two
            // controllers doing that at once both read `false`, both toggle,
            // and the receiver ends up unmuted.
            //
            // The player call is outside the updater because it is idempotent
            // and absolute: safe to repeat, unlike the toggle below.
            setMuted(on) {
                const muted = !!on;
                player.setMuted(muted);
                setAudio((a) => (a.muted === muted ? a : { ...a, muted }));
            },

            // Silence that is not the user's mute.
            //
            // For something that has to be quiet for a moment and then stop
            // being quiet — a transmitting rig, a tab you have switched away
            // from, an extension speaking over the audio. It leaves `muted`
            // alone, which is the setting the operator chose and the one this
            // browser remembers, so a transmission cannot end with the receiver
            // permanently muted or with the mute button lying about it.
            //
            // The extensions duck through this rather than muting the browser
            // tab: a tab mute is invisible to the page, so the receiver went on
            // showing itself unmuted while nothing came out of it.
            setDucked(on) {
                const ducked = !!on;
                player.setDucked(ducked);
                setAudio((a) => (a.ducked === ducked ? a : { ...a, ducked }));
            },

            toggleMute() {
                setAudio((a) => {
                    const muted = !a.muted;
                    player.setMuted(muted);
                    return { ...a, muted };
                });
            },

            setBufferSec(sec) {
                player.setBufferSec(sec);
                setAudio((a) => ({ ...a, bufferSec: sec, bufferFromUser: true }));
            },

            // A patch per section: { eq: {...} } leaves notch and bandpass alone.
            setFilters(patch) {
                setFilterState((f) => {
                    const next = {};
                    for (const key of Object.keys(f)) next[key] = { ...f[key], ...(patch[key] || {}) };
                    player.setFilters(next);
                    return next;
                });
            },

            setChannel(mode) {
                player.setChannelMode(mode);
                setAudio((a) => ({ ...a, channel: mode }));
            },

            // Which device the audio comes out of; '' is the system default.
            // Rejects on a device the browser will not route to — a saved one
            // that has since been unplugged, most often — having put playback
            // back on the default first, so the panel never shows a selection
            // that is not the one making sound.
            async setAudioSink(id) {
                const next = id || '';
                try {
                    await player.setSinkId(next);
                } catch (err) {
                    await player.setSinkId('').catch(() => {});
                    setAudio((a) => ({ ...a, sinkId: '' }));
                    pushLog('warn', 'Audio output device unavailable — using system default');
                    throw err;
                }
                setAudio((a) => ({ ...a, sinkId: next }));
            },

            // `value` is the raw slider position; its floor means "off".
            setSquelch: applySquelch,

            // Sits just above the noise the receiver is currently hearing.
            autoSquelch() {
                const value = autoSquelchValue(meters.current.snrHistory);
                if (value == null) return;
                applySquelch(value);
            },

            // v1 pushes all three values on every change, so the server never
            // sees a partial set; mirrored here.
            setAgcParams(patch) {
                const next = { ...agcRef.current, ...patch };
                agcRef.current = next;
                agcDirty.current = true;
                lastLocalAgc.current = Date.now();
                setAgc(next);
                sendAgc(next);
            },

            // Restores the operator's defaults, not ours.
            resetAgc() {
                const next = { ...(serverAgcDefaults.current || defaultAGC()) };
                agcRef.current = next;
                agcDirty.current = true;
                lastLocalAgc.current = Date.now();
                setAgc(next);
                sendAgc(next);
            },

            setDsp(filter, enabled) {
                const d = dspRef.current;
                const params = d.params[filter] || {};
                const next = { ...d, filter, enabled };
                dspRef.current = next;
                setDsp(next);
                // Enabling starts the insert with this filter's current values;
                // the server replies with dsp_status carrying what it applied.
                audioConn.setDSP(filter, enabled, enabled ? params : {});
            },

            setDspParam(name, value) {
                const d = dspRef.current;
                const filter = d.filter;
                if (!filter) return;
                const wire = toWire(value);
                const next = {
                    ...d,
                    params: { ...d.params, [filter]: { ...(d.params[filter] || {}), [name]: wire } },
                };
                dspRef.current = next;
                setDsp(next);
                // Live parameter updates are only valid while the insert runs.
                if (d.enabled) sendDspParams({ [name]: wire });
            },

            resetDspParams() {
                const d = dspRef.current;
                const schema = (d.schemas || []).find((f) => f.name === d.filter);
                if (!schema) return;
                const params = defaultParams(schema);
                const next = { ...d, params: { ...d.params, [d.filter]: params } };
                dspRef.current = next;
                setDsp(next);
                if (d.enabled && Object.keys(params).length) sendDspParams(params);
            },

            setFollowTuning,

            // -- spectrum view --
            setSpectrumCenter(hz) {
                spectrumConn.setView(clamp(hz, MIN_FREQ, MAX_FREQ), null);
            },

            // Guarantee a frequency is on screen without moving the view when
            // it already is. Unlike recenterIfNeeded this ignores the
            // follow-tuning setting: it answers a direct request ("show me this
            // bookmark"), not automatic tracking of the dial. The window is the
            // middle 60% of the span, so a hit near the edge — where the
            // passband would be half cut off — still recentres.
            ensureVisible(hz) {
                const target = clamp(hz, MIN_FREQ, MAX_FREQ);
                const span = spectrumConn.span;
                if (!span || !spectrumConn.centerFreq) {
                    spectrumConn.setView(target, null);
                    return;
                }
                if (Math.abs(target - spectrumConn.centerFreq) > span * 0.3) {
                    spectrumConn.setView(target, null);
                }
            },

            // Centre and zoom together, in one message.
            //
            // For recalling a stored view — a VFO, and anything else that knows
            // both halves. Doing it as a tune and then a setSpan looks
            // equivalent and is not: the recentre that follows the tune is
            // decided against the *old* span, so from a full-span view it
            // correctly does nothing, and the span then shrinks around whatever
            // the spectrum happened to be pointing at. A 205 kHz window closing
            // around 15 MHz leaves a dial at 14.18 MHz three-quarters of a
            // megahertz outside it, with the tune already past and nothing left
            // to move the view.
            setSpectrumView(centerHz, spanHz) {
                const bins = spectrumConn.binCount;
                if (!bins) return;
                const binBW = clamp(
                    spanHz / bins,
                    spectrumConn.minBinBandwidthForUI(),
                    spectrumConn.fullSpanBinBandwidth(),
                );
                spectrumConn.setView(clamp(centerHz, MIN_FREQ, MAX_FREQ), binBW);
            },

            setSpan(spanHz) {
                const bins = spectrumConn.binCount;
                if (!bins) return;
                const binBW = clamp(
                    spanHz / bins,
                    spectrumConn.minBinBandwidthForUI(),
                    spectrumConn.fullSpanBinBandwidth(),
                );
                spectrumConn.setView(null, binBW);
            },

            // Zoom steps halve or double binBandwidth exactly.
            //
            // The server snaps binBandwidth to a fixed ladder (0.5, 1, 2, 5, 10,
            // 20, 50 … 5000 Hz/bin — see user_spectrum_websocket.go). Anything
            // gentler than a factor of two rounds back to the rung it started
            // on, so the view simply never changes. Factor-of-two steps always
            // cross a rung, which is what v1 does too.
            zoomIn(aboutHz) {
                const c = spectrumConn;
                if (!c.binCount || !c.binBandwidth) return;
                const next = c.binBandwidth / 2;
                if (next < c.minBinBandwidthForUI()) return;   // already fully zoomed in
                c.setView(zoomCenter(c, next, aboutHz, tuningRef.current.frequency), next);
            },

            zoomOut(aboutHz) {
                const c = spectrumConn;
                if (!c.binCount || !c.binBandwidth) return;
                const next = c.binBandwidth * 2;
                // Reaching full span goes through `reset`, which also hands the
                // session back to the shared radiod channel instead of leaving a
                // private one allocated at default parameters.
                if (next >= c.fullSpanBinBandwidth()) {
                    // Already there: nothing to hand back, and a held pinch
                    // against the stop would otherwise re-send this several
                    // times a second.
                    if (c.binBandwidth >= c.fullSpanBinBandwidth()) return;
                    c.reset();
                    return;
                }
                c.setView(zoomCenter(c, next, aboutHz, tuningRef.current.frequency), next);
            },

            // Several rungs in one message, which is what a pinch needs.
            //
            // zoomIn and zoomOut move exactly one rung, and the view they read
            // is the last one the *server* confirmed — binBandwidth does not
            // change locally when a zoom is sent. So a gesture that has opened
            // to four times its starting spread cannot ask for the two rungs it
            // means: it can only ask for one and wait for the confirmation
            // before asking for the next. On a desktop wheel that is invisible,
            // because a notch is one rung and a round trip on a LAN is shorter
            // than the gap between notches. Under a thumb on a phone it is the
            // whole experience — every rung costs a round trip over cellular,
            // and a wide pinch spends several of them catching up with fingers
            // that stopped moving long ago.
            //
            // The ladder is unaffected. 2^n is a factor of two taken n times, so
            // it crosses at least n rungs, and the server snaps to the nearest
            // as it does for a single step. Positive n zooms in, matching the
            // sign the pinch already works in.
            zoomSteps(n, aboutHz) {
                const c = spectrumConn;
                if (!c.binCount || !c.binBandwidth || !n) return;
                const full = c.fullSpanBinBandwidth();
                const next = clamp(c.binBandwidth / (2 ** n), c.minBinBandwidthForUI(), full);
                // Full span goes through reset, which hands the private radiod
                // channel back — the same reason zoomOut does it.
                if (next >= full) {
                    if (c.binBandwidth >= full) return;
                    c.reset();
                    return;
                }
                // Against the zoom-in stop, with nothing left to give.
                if (next === c.binBandwidth) return;
                c.setView(zoomCenter(c, next, aboutHz, tuningRef.current.frequency), next);
            },

            resetSpectrum() { spectrumConn.reset(); },

            centerOnTuned() { spectrumConn.setView(tuningRef.current.frequency, null); },

            clearLog() { setLog([]); },
            log: pushLog,
        };
    }, []);

    const squelch = useMemo(() => ({
        value: squelchValue,
        enabled: squelchEnabled(squelchValue),
        threshold: squelchThreshold(squelchValue),
    }), [squelchValue]);

    const value = useMemo(() => ({
        tuning, audioState, spectrumState, view, running, serverInfo, log, session,
        audio, squelch, agc, dsp, followTuning, filters,
        // `bookmarks` and `local` are what *propagates* — the marker bar, the
        // ⏮/⏭ neighbours, the lock screen, the Markers panel — so a hidden
        // group disappears from all of them without any of them knowing the
        // feature exists. The panels that manage groups read `allBookmarks` and
        // `allLocal`: filtering their own lists would hide the switch that
        // turns a group back on.
        catalog: {
            ...catalog,
            bookmarks: visibleBookmarks(catalog.bookmarks, hidden),
            local: visibleBookmarks(localMarks, hidden),
            allBookmarks: catalog.bookmarks,
            allLocal: localMarks,
        },
        actions, meters, spectrumConn, audioConn, player,
        modes: MODES,
    }), [tuning, audioState, spectrumState, view, running, serverInfo, log, session, audio, squelch, agc, dsp, followTuning, filters, catalog, localMarks, hidden, actions]);

    return <RadioContext.Provider value={value}>{children}</RadioContext.Provider>;
}

export function useRadio() {
    const ctx = useContext(RadioContext);
    if (!ctx) throw new Error('useRadio outside RadioProvider');
    return ctx;
}

// Samples the mutable meters object at `hz` and re-renders only the caller.
export function useMeters(hz = 12) {
    const { meters } = useRadio();
    const [snapshot, setSnapshot] = useState(() => ({ ...meters.current }));
    useEffect(() => {
        const t = setInterval(() => setSnapshot({ ...meters.current }), 1000 / hz);
        return () => clearInterval(t);
    }, [hz]);
    return snapshot;
}
