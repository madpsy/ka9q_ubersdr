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
import {
    MAX_FREQ, MIN_FREQ, MODE_BY_ID, MODES,
    SQUELCH_HANG_MS, SQUELCH_MIN, SQUELCH_SENTINEL, squelchEnabled, squelchThreshold,
} from './constants.js';
import { clamp } from '../lib/format.js';
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
    return {
        frequency: clamp(urlFreq > 0 ? urlFreq : (saved.frequency || 7100000), MIN_FREQ, MAX_FREQ),
        mode,
        bandwidthLow: saved.mode === mode && saved.bandwidthLow != null ? saved.bandwidthLow : def.low,
        bandwidthHigh: saved.mode === mode && saved.bandwidthHigh != null ? saved.bandwidthHigh : def.high,
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
    const [agc, setAgc] = useState(null);
    const [dsp, setDsp] = useState({ filter: saved.dspFilter || 'nr2', enabled: !!saved.dspEnabled });
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
            } else if (msg.type === 'agc_state' && msg.agc) {
                // The server reports parameter values but not whether AGC is
                // engaged, so that flag is tracked client-side.
                setAgc((prev) => ({ agcEnable: prev?.agcEnable !== false, ...msg.agc }));
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
            dspEnabled: dsp.enabled,
            followTuning,
        });
    }, [tuning, audio, squelchValue, dsp, followTuning]);

    // ---- actions --------------------------------------------------------

    const sendTune = useMemo(() => throttle((params) => audioConn.tune(params), 70), []);
    // Dragging the squelch slider would otherwise emit a command per pixel and
    // trip the server's command rate limit.
    const sendGate = useMemo(() => throttle((minSnr) => audioConn.setAudioGate({ minSnr }), 90), []);

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

        return {
            async powerOn() {
                const ok = await player.start();
                if (!ok) pushLog('warn', 'Audio context did not start — tap again');
                setRunning(true);
                const t = tuningRef.current;
                await audioConn.connect(t);
                await spectrumConn.connect({});
                audioConn.requestAGC();
            },

            powerOff() {
                audioConn.disconnect();
                spectrumConn.disconnect();
                player.suspend();
                setRunning(false);
            },

            setFrequency(hz) { applyTuning({ frequency: hz }); },

            nudge(delta) { applyTuning({ frequency: tuningRef.current.frequency + delta }); },

            setMode(mode) {
                const def = MODE_BY_ID[mode];
                if (!def) return;
                applyTuning({ mode, bandwidthLow: def.low, bandwidthHigh: def.high });
            },

            setBandwidth(low, high) {
                applyTuning({ bandwidthLow: Math.round(low), bandwidthHigh: Math.round(high) });
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
            setSquelch(value) {
                setSquelchValue(value);
                gateRef.current = squelchEnabled(value) ? squelchThreshold(value) : null;
                sendGate(squelchThreshold(value));
                if (!squelchEnabled(value)) {
                    const m = meters.current;
                    m.squelchOpen = true;
                    m.lastGateOpenAt = performance.now();
                }
            },

            setAgcParams(params) {
                audioConn.setAGC(params);
                setAgc((prev) => ({ ...(prev || {}), ...params }));
            },

            setDsp(filter, enabled) {
                setDsp({ filter, enabled });
                audioConn.setDSP(filter, enabled);
            },

            setFollowTuning,

            // -- spectrum view --
            setSpectrumCenter(hz) {
                spectrumConn.setView(clamp(hz, MIN_FREQ, MAX_FREQ), null);
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
        tuning, audioState, spectrumState, view, running, serverInfo, log,
        audio, squelch, agc, dsp, followTuning,
        actions, meters, spectrumConn, audioConn, player,
        modes: MODES,
    }), [tuning, audioState, spectrumState, view, running, serverInfo, log, audio, squelch, agc, dsp, followTuning, actions]);

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
