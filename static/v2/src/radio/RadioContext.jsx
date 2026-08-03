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
import {
    AGC_CONTROLS, MAX_FREQ, MIN_FREQ, MODE_BY_ID, MODES, bandwidthLimits, defaultAGC, hasAGCSettings,
    SQUELCH_AUTO_SAMPLES, SQUELCH_HANG_MS, SQUELCH_MIN, SQUELCH_SENTINEL, snapStep,
    autoSquelchValue, squelchEnabled, squelchThreshold,
} from './constants.js';
import { clamp } from '../lib/format.js';
import { defaultParams, toWire } from '../lib/dsp.js';
import { throttle } from '../lib/throttle.js';

const RadioContext = createContext(null);

// Centre frequency for a zoom step: keeps `aboutHz` (the cursor) over the same
// point on screen, then pulls the view back inside 0–30 MHz so neither edge
// hangs off the end of the band.
function zoomCenter(conn, newBinBW, aboutHz) {
    const newSpan = newBinBW * conn.binCount;
    const span = conn.span;
    let center = conn.centerFreq;
    if (aboutHz != null && span > 0) {
        center = aboutHz - (aboutHz - center) * (newSpan / span);
    }
    const half = newSpan / 2;
    const lo = Math.max(MIN_FREQ, half);
    const hi = Math.max(lo, MAX_FREQ - half);
    return clamp(center, lo, hi);
}

const SETTINGS_KEY = 'ubersdr.v2.radio';

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

function initialTuning() {
    const saved = loadSettings();
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
    };
}

export function RadioProvider({ children }) {
    const saved = useMemo(loadSettings, []);
    const start = useMemo(initialTuning, []);

    const [tuning, setTuning] = useState(start);
    const [audioState, setAudioState] = useState('idle');
    const [spectrumState, setSpectrumState] = useState('idle');
    const [view, setView] = useState({ centerFreq: 0, binCount: 0, binBandwidth: 0, span: 0, defaultBinBandwidth: 0, defaultBinCount: 0 });
    const [running, setRunning] = useState(false);
    const [serverInfo, setServerInfo] = useState(null);
    // How long this session may run, from /connection: { maxSec, startedAt }.
    // maxSec 0 means unlimited; null until the first session starts.
    const [session, setSession] = useState({ maxSec: null, startedAt: 0 });
    const [log, setLog] = useState([]);
    const [audio, setAudio] = useState({
        volume: saved.volume != null ? saved.volume : 0.7,
        muted: !!saved.muted,
        bufferSec: saved.bufferSec != null ? saved.bufferSec : 0.2,
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

    // Mutable, high-rate values. Never a dependency of a render.
    const meters = useRef({
        basebandPower: null,
        noiseDensity: null,
        snr: null,
        level: 0,
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

    useEffect(() => {
        fetch('/api/description')
            .then((r) => r.json())
            .then((d) => setServerInfo(d))
            .catch(() => { /* non-fatal — the UI just shows fewer details */ });
    }, []);

    // Persist the parts of the session worth restoring.
    useEffect(() => {
        saveSettings({
            frequency: tuning.frequency,
            mode: tuning.mode,
            bandwidthLow: tuning.bandwidthLow,
            bandwidthHigh: tuning.bandwidthHigh,
            volume: audio.volume,
            muted: audio.muted,
            bufferSec: audio.bufferSec,
            squelchValue,
            dspFilter: dsp.filter,
            dspParams: dsp.params,
            followTuning,
        });
    }, [tuning, audio, squelchValue, dsp, followTuning]);

    // ---- actions --------------------------------------------------------

    const sendTune = useMemo(() => throttle((params) => audioConn.tune(params), 70), []);
    // Dragging the squelch slider would otherwise emit a command per pixel and
    // trip the server's command rate limit.
    const sendGate = useMemo(() => throttle((minSnr) => audioConn.setAudioGate({ minSnr }), 90), []);
    const sendAgc = useMemo(() => throttle((values) => audioConn.setAGC(values), 120), []);
    // Dragging a DSP slider must not emit a command per pixel.
    const sendDspParams = useMemo(() => throttle((params) => audioConn.setDSPParams(params), 120), []);

    const actions = useMemo(() => {
        const recenterIfNeeded = (freq) => {
            if (!followRef.current || !spectrumConn.connected) return;
            const span = spectrumConn.span;
            if (!span) return;
            const edge = span * 0.35;
            if (Math.abs(freq - spectrumConn.centerFreq) > edge) {
                spectrumConn.setView(clamp(freq, MIN_FREQ, MAX_FREQ), null);
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
            recenterIfNeeded(next.frequency);
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
                        setSession({ maxSec: r.maxSessionTime, startedAt: Date.now() });
                    }
                }, () => { /* the countdown just stays as it was */ });
                const t = tuningRef.current;
                await audioConn.connect(t);
                await spectrumConn.connect({});
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

            toggleMute() {
                setAudio((a) => {
                    const muted = !a.muted;
                    player.setMuted(muted);
                    return { ...a, muted };
                });
            },

            setBufferSec(sec) {
                player.setBufferSec(sec);
                setAudio((a) => ({ ...a, bufferSec: sec }));
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
                c.setView(zoomCenter(c, next, aboutHz), next);
            },

            zoomOut(aboutHz) {
                const c = spectrumConn;
                if (!c.binCount || !c.binBandwidth) return;
                const next = c.binBandwidth * 2;
                // Reaching full span goes through `reset`, which also hands the
                // session back to the shared radiod channel instead of leaving a
                // private one allocated at default parameters.
                if (next >= c.fullSpanBinBandwidth()) {
                    c.reset();
                    return;
                }
                c.setView(zoomCenter(c, next, aboutHz), next);
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
        audio, squelch, agc, dsp, followTuning,
        catalog: { ...catalog, local: localMarks },
        actions, meters, spectrumConn, audioConn, player,
        modes: MODES,
    }), [tuning, audioState, spectrumState, view, running, serverInfo, log, session, audio, squelch, agc, dsp, followTuning, catalog, localMarks, actions]);

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
