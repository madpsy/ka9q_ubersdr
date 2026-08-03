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
import { MAX_FREQ, MIN_FREQ, MODE_BY_ID, MODES, SQUELCH_ALWAYS_OPEN } from './constants.js';
import { clamp } from '../lib/format.js';
import { throttle } from '../lib/throttle.js';

const RadioContext = createContext(null);

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
    const [squelch, setSquelch] = useState({
        enabled: !!saved.squelchEnabled,
        threshold: saved.squelchThreshold != null ? saved.squelchThreshold : 6,
    });
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
        offs.push(audioConn.on('open', () => pushLog('info', 'Audio stream connected')));

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
            squelchEnabled: squelch.enabled,
            squelchThreshold: squelch.threshold,
            dspFilter: dsp.filter,
            dspEnabled: dsp.enabled,
            followTuning,
        });
    }, [tuning, audio, squelch, dsp, followTuning]);

    // ---- actions --------------------------------------------------------

    const sendTune = useMemo(() => throttle((params) => audioConn.tune(params), 70), []);

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
                if (squelch.enabled) audioConn.setSquelch(squelch.threshold);
                else audioConn.openSquelch();
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

            setSquelch(enabled, threshold) {
                setSquelch({ enabled, threshold });
                if (enabled) audioConn.setSquelch(threshold);
                else audioConn.setSquelch(SQUELCH_ALWAYS_OPEN, SQUELCH_ALWAYS_OPEN);
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
                const bins = spectrumConn.binCount || view.binCount;
                if (!bins) return;
                const maxSpan = (spectrumConn.defaultBinCount || bins) * (spectrumConn.defaultBinBandwidth || 1);
                const span = clamp(spanHz, 2000, maxSpan || spanHz);
                spectrumConn.setView(null, span / bins);
            },

            zoomBy(factor, aboutHz) {
                const bins = spectrumConn.binCount;
                if (!bins) return;
                const span = spectrumConn.span;
                const maxSpan = (spectrumConn.defaultBinCount || bins) * (spectrumConn.defaultBinBandwidth || 0) || span;
                const newSpan = clamp(span * factor, 2000, maxSpan);
                let center = spectrumConn.centerFreq;
                if (aboutHz != null && newSpan !== span) {
                    // Keep the cursor over the same frequency while the span changes.
                    center = aboutHz - (aboutHz - center) * (newSpan / span);
                }
                spectrumConn.setView(clamp(center, MIN_FREQ, MAX_FREQ), newSpan / bins);
            },

            resetSpectrum() { spectrumConn.reset(); },

            centerOnTuned() { spectrumConn.setView(tuningRef.current.frequency, null); },

            clearLog() { setLog([]); },
            log: pushLog,
        };
    }, [squelch.enabled, squelch.threshold, view.binCount]);

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
