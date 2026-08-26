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
import { connectionCheck, startSessionId } from './session.js';
// Logging only — the socket belongs to its own module. See the wiring effect.
import { dxcluster } from './dxcluster-connection.js';
import { reviveReason } from './socket-health.js';
import { localBookmarks as localBookmarkStore, onLocalBookmarksChanged } from '../lib/localBookmarks.js';
import { FILTER_DEFAULTS } from './audio-filters.js';
import { NB_DEFAULTS } from '../lib/noiseBlanker.js';
import { NR_DEFAULTS } from '../lib/nr.js';
import { getRmNoise, rmCredentials, rmModeSupported } from '../lib/rmnoise.js';
import {
    AGC_CONTROLS, MAX_FREQ, MIN_FREQ, MODE_BY_ID, MODES, applyTuningRange, bandwidthLimits, defaultAGC,
    hasAGCSettings,
    isIQ, SQUELCH_AUTO_SAMPLES, SQUELCH_HANG_MS, SQUELCH_MIN, SQUELCH_SENTINEL, snapStep,
    autoSquelchValue, squelchEnabled, squelchThreshold,
} from './constants.js';
import { clamp } from '../lib/format.js';
import { defaultParams, toWire } from '../lib/dsp.js';
import { throttle } from '../lib/throttle.js';
import { needsRecenter, resumeView, zoomCenter } from '../lib/zoom.js';
import { loadRadioSettings, saveRadioSettings } from '../lib/radioSettings.js';
import { hiddenGroups, onGroupsChanged, visibleBookmarks } from '../lib/bookmarkGroups.js';
import { readShareUrl, takeUrlView } from '../lib/share.js';
import { shouldWake } from '../lib/wake.js';
import { setFeedsAllowed } from '../lib/serverFeeds.js';
import { failureMessage } from '../lib/connectFailure.js';
import { clearEventLog, logEvent } from '../lib/eventLog.js';
import {
    CHECK_MS as SAM_CHECK_MS, createWatch as createSamWatch, notePower as noteSamPower,
    resetWatch as resetSamWatch, shouldFallBack as samShouldFallBack,
} from '../lib/samFallback.js';

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
    // Everything a shared link can say about the radio, already validated and
    // clamped — see lib/share.js, which is also what writes them.
    const link = readShareUrl(location.search);

    const mode = link.mode || (MODE_BY_ID[saved.mode] ? saved.mode : 'lsb');
    const def = MODE_BY_ID[mode];
    const restore = saved.mode === mode;
    // A layout saved before the limits changed can hold a wider passband than
    // the mode now allows, so restored edges are clamped too.
    const l = bandwidthLimits(mode);
    // A link's filter beats the saved one, as its frequency and mode do: the
    // whole point of being sent one is to hear what the sender was hearing, and
    // on a narrow signal the filter is half of that.
    const low = link.bandwidthLow != null ? link.bandwidthLow
        : (restore && saved.bandwidthLow != null ? saved.bandwidthLow : def.low);
    const high = link.bandwidthHigh != null ? link.bandwidthHigh
        : (restore && saved.bandwidthHigh != null ? saved.bandwidthHigh : def.high);
    return {
        // Deliberately unclamped. The receiver's range is not known yet — it arrives with
        // /api/description, below — and clamping is lossy: a 6 m share link squeezed to
        // 30 MHz here can never be recovered, because the number it was sent to convey is
        // gone. Nothing tunes to this on its own; it is the dial's starting position until
        // Start is pressed, and the description handler clamps it once the real limits are
        // in. Every path that actually tunes clamps for itself.
        frequency: link.frequency > 0 ? link.frequency : (saved.frequency || 7100000),
        mode,
        bandwidthLow: clamp(low, l.min, l.max),
        bandwidthHigh: clamp(high, l.min, l.max),
        chosen: {
            frequency: link.frequency > 0 || saved.frequency != null,
            mode: !!link.mode || !!MODE_BY_ID[saved.mode],
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
    // Why the last session ended, when it was not the operator who ended it —
    // { kind, message, at }, or null. Set by noteFailure and cleared by the
    // next start, so it describes the reason there is nothing running now
    // rather than accumulating a history.
    const [lost, setLost] = useState(null);
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
        // Audio wire format: 'opus' | 'pcm-zstd'. Opus unless this browser has
        // been through the bandwidth warning and chosen otherwise.
        format: saved.audioFormat === 'pcm-zstd' ? 'pcm-zstd' : 'opus',
        // Output device ID, '' being the system default. Device IDs are
        // per-origin and survive a reload, so this is worth restoring — and if
        // the device has gone since, setAudioSink falls back to the default.
        sinkId: saved.sinkId || '',
    });
    // One number: the slider position. Its floor doubles as "off", which is how
    // v1 behaves and avoids an enabled flag that can disagree with the value.
    // `squelchValueDb`, not the `squelchValue` this used to be saved under.
    //
    // The old key held a threshold on the server's pre-version-3 figure, which
    // was S/N0 in dB·Hz — around 34 dB above the true SNR on a 2.65 kHz filter,
    // and by a different amount on every other filter width. There is no way to
    // convert one: the value does not record the bandwidth it was set at. Rather
    // than guess and leave people either permanently muted or with no squelch at
    // all, the old key is ignored and the gate starts off, which is also what a
    // new browser gets.
    const [squelchValue, setSquelchValue] = useState(
        saved.squelchValueDb != null ? saved.squelchValueDb : SQUELCH_MIN,
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
    // Client-side noise blanker and NR, merged the same way for the same
    // reason. Separate from `filters` because the player stages them
    // separately: these sit before the chain, and rebuild ScriptProcessors
    // rather than biquads.
    const [noise, setNoiseState] = useState(() => ({
        nb: { ...NB_DEFAULTS, ...((saved.noise || {}).nb || {}) },
        nr: { ...NR_DEFAULTS, ...((saved.noise || {}).nr || {}) },
    }));

    // Mutable, high-rate values. Never a dependency of a render.
    const meters = useRef({
        basebandPower: null,
        noisePower: null,        // noise in the passband, dBFS — same units as basebandPower
        snr: null,
        level: 0,
        channels: 0,            // channels in the stream now playing
        streamRate: 0,          // Hz the stream arrives at
        contextRate: 0,         // Hz the AudioContext runs at — see player.streamRate
        makeupDb: 0,            // live compressor makeup gain
        clipping: false,        // output hit full scale in the last moment
        peakDb: -Infinity,      // output peak, dBFS
        outLevel: 0,            // smoothed RMS after the volume control, 0..1
        queuedSec: 0,
        outLatencySec: 0,       // what the audio hardware adds after the queue
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

    // The log lives in lib/eventLog.js now, not in this state.
    //
    // It had to: everything else on the page that opens a connection — the
    // three EventSource feeds, the audio extensions, the spectrogram loader —
    // is outside this provider and could not reach `setLog`, so the panel only
    // ever showed the two sockets this file happens to own. It also means a
    // burst of reconnect lines no longer re-renders every consumer of
    // useRadio(); the panel subscribes to the store by itself.
    //
    // Kept as a local name because this file calls it a dozen times, and still
    // published as actions.log for anything holding the context.
    const pushLog = logEvent;

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
    // Watches basebandPower for the carrier going away while in SAM — see
    // lib/samFallback.js. A ref because it is fed from the packet handler, which
    // must not re-subscribe and must not re-render anything.
    const samWatch = useRef(createSamWatch());
    // A tune into IQ waiting to be confirmed. The request is held whole rather
    // than as a mode string, because tuneTo carries a frequency and a passband
    // that would otherwise be lost across the dialog. In a ref so the actions
    // object can read it without becoming a dependency of its own memo; the
    // state beside it exists only to put the dialog on screen.
    const pendingIQ = useRef(null);
    const [iqPrompt, setIqPrompt] = useState(null);
    // Whether the current mode is IQ, for the packet handlers — they subscribe
    // once and cannot see the tuning state.
    const iqRef = useRef(false);
    // Read by wake(), which lives in the actions object and so cannot see the
    // state.
    const runningRef = useRef(running);
    runningRef.current = running;
    // Whether this visit has ever been through the front door. wake() will not
    // open the first session of a visit: the Start overlay is where the audio
    // gesture, the capacity check and the bypass password live, and a receiver
    // that is full has to say so there rather than fail silently under a thumb.
    // See StartOverlay, and actions.wake.
    const everStarted = useRef(false);
    // powerOn is async and a gesture is many events, so without this a single
    // drag would start several sessions.
    const waking = useRef(false);

    // What ends a session that the operator did not end.
    //
    // Both sockets can discover that this session is over: the server reclaims
    // an idle one by blacklisting its id for an hour, and after that every
    // reconnect with the same id is refused for as long as it takes. Nothing
    // used to act on that. `running` stayed true, so the power button read
    // "on", wake() refused to fire — it will not start a session while one is
    // supposedly running — and the two sockets retried an id that could never
    // be accepted until they gave up and wrote a line in the log. The page
    // looked live, was dead, and only a reload cleared it. That is the
    // "shift-refresh to get the audio back" this exists to end.
    //
    // So a session the server has finished with is *finished*: stop, which
    // releases what is left of the slot, drops the feeds and flips the power
    // button. Starting again mints a new id, and because wake() is live again
    // the next thing the operator touches does exactly that — they do not have
    // to know any of this happened. `lost` is kept so something can say so.
    //
    // Only the two kinds that mean it. A 'retry' failure is a busy receiver or
    // a rate limit, both of which the backoff is already handling: ending the
    // session over one would turn a ten-second wait into a stopped receiver.
    // 'reregister' is the same judgement for a different reason — the server
    // has forgotten this id rather than finished with it, and the socket puts
    // that right by itself on the next attempt. Ending the session over one
    // would mean a receiver restart still cost the operator a press of Listen,
    // which is exactly what it used to cost.
    const noteFailure = useRef((e) => {
        const kind = e && e.failure;
        if (!kind || kind === 'retry' || kind === 'reregister') return;
        if (!runningRef.current) return;
        // Eagerly, not left to the re-render powerOff triggers. Both sockets
        // can discover the same dead session in one tick, and the second one
        // would otherwise still read `running` as true — stamping a fresh
        // `lost` over a notice the operator may have just dismissed, and
        // powering off something already off.
        runningRef.current = false;
        setLost({ kind, message: failureMessage(kind, e.message), at: Date.now() });
        actionsRef.current.powerOff();
    }).current;

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
        player.setNoise(noise);
        // Belongs to the socket rather than the player, and for the same
        // reason: the first connect of the visit has to ask for the restored
        // format, not the built-in one.
        audioConn.setFormat(audio.format);
        // Only remembered here — there is no context to route until audio
        // starts, and _createContext applies it then.
        player.setSinkId(audio.sinkId).catch(() => { /* reported when it plays */ });
    }, []);   // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const offs = [];

        // The three sockets all report their closes to the log the same way,
        // and the ones worth explaining are the ones nothing actually closed —
        // a handshake nobody answered, a connection that died while the machine
        // was asleep. See socket-health.js: without this they are all the same
        // bare 1006 as a dropped network, which is the one thing they are not.
        const why = (ev) => {
            const text = reviveReason(ev && ev.reason);
            return text ? ` — ${text}` : '';
        };

        offs.push(audioConn.on('state', setAudioState));
        offs.push(audioConn.on('opus', ({ data, sampleRate, channels }) => {
            player.pushOpus(data, sampleRate, channels);
        }));
        offs.push(audioConn.on('pcm', ({ planes, sampleRate, channels }) => {
            // `channels` is the count the *header* declared, which is not the
            // same question as how many planes came back — see _noteStream.
            player.pushPCM(planes, sampleRate, channels);
        }));
        offs.push(audioConn.on('quality', ({ basebandPower, noisePower }) => {
            // Dropped outright in IQ. One full-header packet arrives after the
            // mode change carrying a genuine reading, and taking it would pin
            // every meter to a number that then never moves — see the blanking
            // effect. A ref because this handler is subscribed once and must not
            // re-subscribe on every retune.
            if (iqRef.current) return;
            // Before anything else: the figure only counts as evidence when it
            // changes, and the packet handler is the only place it is seen raw.
            noteSamPower(samWatch.current, basebandPower, Date.now());
            const m = meters.current;
            m.basebandPower = basebandPower;
            m.noisePower = noisePower;
            // Both figures are powers over the same passband on protocol
            // version 3, so this subtraction is an SNR in dB. It was not on
            // version 2, where the server sent the noise *density* N0 in
            // dBFS/Hz and the difference came out as S/N0 in dB·Hz — about
            // 34 dB high on a 2.65 kHz filter, and moving with the filter
            // width, which is what made the squelch shift between modes.
            m.snr = basebandPower != null && noisePower != null ? basebandPower - noisePower : null;
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
        // Quoting the server, except for the one refusal whose words are now
        // wrong. "Invalid session. Please refresh the page and try again" is
        // advice for a client that had no way back; this one registers again on
        // the next attempt and says so when it does — see logReregister below.
        // Left in the log as the server wrote it, that line asks the operator
        // to reload a page that is already fixing itself.
        const logFailure = (fallback) => (e) => {
            if (!e || e.failure !== 'reregister') pushLog('error', (e && e.message) || fallback);
            noteFailure(e);
        };
        offs.push(audioConn.on('error', logFailure('audio error')));
        // With the code, because that is the one thing that separates the
        // cases: 1000 is somebody closing deliberately, 1006 is the connection
        // being torn out from under us, and the difference is the difference
        // between "the receiver ended this" and "the network did".
        offs.push(audioConn.on('close', (ev) => pushLog(
            'warn', `Audio stream closed${ev && ev.code ? ` (${ev.code})` : ''}`
                + why(ev),
        )));
        offs.push(audioConn.on('open', () => {
            pushLog('info', 'Audio stream connected');
            // Anything tuned while the socket was still opening commanded
            // nothing: send() drops into a socket that is not open yet, and the
            // connect URL carries the tuning as it stood when connect() read
            // it. Ordinary now that a control can wake the receiver — the whole
            // point is that the gesture is not made to wait — so replay the
            // current tuning if it has moved on from what the server was asked
            // for. Compared rather than sent unconditionally so a plain
            // reconnect still costs no command.
            const asked = audioConn.params;
            const now = tuningRef.current;
            if (!asked || asked.frequency !== now.frequency || asked.mode !== now.mode
                || asked.bandwidthLow !== now.bandwidthLow
                || asked.bandwidthHigh !== now.bandwidthHigh) {
                audioConn.tune(now);
            }
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
        offs.push(spectrumConn.on('error', logFailure('spectrum error')));
        offs.push(spectrumConn.on('open', () => pushLog('info', 'Spectrum connected')));
        // The audio socket has always logged its closures and this one never
        // did, which made the panel actively misleading: a spectrum that
        // dropped and came back showed two "Spectrum connected" lines in a row
        // and nothing between them, so a reconnect was indistinguishable from
        // the display having been started twice.
        offs.push(spectrumConn.on('close', (ev) => pushLog(
            'warn', `Spectrum closed${ev && ev.code ? ` (${ev.code})` : ''}` + why(ev),
        )));

        // What happened in the gap.
        //
        // Both sockets report every state change, and the panel logged only the
        // two ends of one — connected, closed. So the interesting part, the
        // eight seconds between a socket going and coming back, was blank, and
        // whether that was one retry or six was not recoverable from anything
        // on screen. The backoff is the rate limit here: these lines arrive at
        // 1 s, 1.6 s, 2.6 s and so on to a 30 s ceiling, so a socket that is
        // genuinely struggling says so without flooding.
        const logRetries = (conn, what) => conn.on('state', (state) => {
            if (state !== 'reconnecting') return;
            pushLog('warn', `${what} reconnecting (attempt ${conn.attempts})`);
        });
        offs.push(logRetries(audioConn, 'Audio stream'));
        offs.push(logRetries(spectrumConn, 'Spectrum'));

        // The one request a reconnect is allowed to make, and the only account
        // of it. A registration lapses without any event of its own — the
        // server simply stops recognising the id, five minutes after this
        // session's last socket ended or the instant it restarts — and the
        // refusal that follows either arrives as a line the operator cannot act
        // on ("Invalid session") or, on the endpoints that refuse before the
        // upgrade, as nothing at all. So the recovery says so itself, or a POST
        // in the middle of an outage has no explanation anywhere.
        const logReregister = (conn, what) => conn.on('reregister', () => {
            pushLog('warn', `${what}: session no longer registered — registering it again`);
        });
        offs.push(logReregister(audioConn, 'Audio stream'));
        offs.push(logReregister(spectrumConn, 'Spectrum'));
        offs.push(logReregister(dxcluster, 'DX cluster'));

        // The spot/chat socket, which reported nothing at all.
        //
        // It is owned by its own module rather than by this context — panels
        // come and go and the socket must not follow them — so nothing here
        // touches its lifecycle. This is only the log: it is the third
        // connection the page makes, it is the one whose "Reconnecting…" the
        // operator can actually see on the Spots panel, and having no record of
        // it meant that badge could not be lined up against anything else that
        // happened.
        offs.push(dxcluster.on('open', () => pushLog('info', 'DX cluster connected')));
        offs.push(dxcluster.on('close', (ev) => pushLog(
            'warn', `DX cluster closed${ev && ev.code ? ` (${ev.code})` : ''}` + why(ev),
        )));
        offs.push(dxcluster.on('error', (e) => pushLog('error', e.message || 'DX cluster error')));
        offs.push(logRetries(dxcluster, 'DX cluster'));

        return () => offs.forEach((off) => off());
    }, []);

    // The one place the server-feed gate is set. Every recurring request in the
    // app — the streams, the decoder polls, the shared stores — hangs off this,
    // so Stop stops them and both ways back (the power button and a wake from
    // touching a control) start them again, without any of them knowing about
    // the receiver at all. See lib/serverFeeds.js.
    useEffect(() => { setFeedsAllowed(running); }, [running]);

    // Sample player-owned meters on a slow timer; the packet path stays free of
    // any per-frame bookkeeping.
    useEffect(() => {
        const t = setInterval(() => {
            const m = meters.current;
            m.level = player.level;
            m.queuedSec = player.queuedSec;
            m.outLatencySec = player.outputLatencySec;
            m.underruns = player.underruns;
            m.channels = player.streamChannels;
            m.streamRate = player.streamRate;
            m.contextRate = player.sampleRate;
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
                // Before setServerInfo, and that order is the whole mechanism. The range
                // lives in live module bindings (see applyTuningRange), which re-render
                // nobody on their own; this setState does, and by then it is already the
                // new value that the render reads. Reversed, every panel would draw its
                // bands and limits once more against the 30 MHz default.
                if (d) applyTuningRange(d.tuning_range);
                setServerInfo(d);
                if (!d) return;
                // The starting frequency, now that there is something to measure it
                // against — initialTuning left it alone on purpose. A share link for a
                // band this receiver cannot reach lands on the nearest edge, which is the
                // same thing every tune does, just deferred until the limits are known.
                const held = tuningRef.current.frequency;
                const fitted = clamp(held, MIN_FREQ, MAX_FREQ);
                if (fitted !== held) tuningRef.current = { ...tuningRef.current, frequency: fitted };
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

    // The client NR's noise profile belongs to the frequency it was learned on;
    // carrying it across a retune subtracts the old channel's noise from the
    // new one. v1 resets it on every frequency change, and so does this.
    useEffect(() => { player.resetNoiseLearning(); }, [tuning.frequency]);

    // An I/Q stream is not audio, and the client DSP has to come out of circuit
    // before any of it arrives — see AudioPlayer.setIQ for what that means and
    // why. Here rather than in the Noise or Filter panels for the reason the RM
    // Noise gate below is: a collapsed panel is unmounted, so a gate living in
    // one would leave the whole chain in circuit for anyone who had folded it
    // away. The player keeps the settings, so this reverses itself on the way
    // out without the panels knowing anything happened.
    useEffect(() => {
        const iq = isIQ(tuning.mode);
        iqRef.current = iq;
        player.setIQ(iq);
        // The rate and channel count belong to the mode, so the old mode's are
        // wrong the instant it changes — and they are only refreshed when a
        // packet arrives. A stream that has stopped (or a server that has
        // stopped sending, which is what a dead streaming goroutine looks like
        // from here) would otherwise leave the last mode's figures on screen
        // reading as current. Blank until the new mode's first packet says.
        player.forgetStream();
        const sm = meters.current;
        sm.streamRate = 0;
        sm.channels = 0;
        if (!iq) return;
        // Blank the signal meters, and keep them blank — see the guard in the
        // 'quality' handler.
        //
        // IQ does carry one real reading: the server sends a full header on the
        // first packet after the mode change and minimal ones from then on, so
        // basebandPower and noisePower arrive once and never again. Showing that
        // is the worst of the three options — a needle sitting at a plausible
        // number, never moving, indistinguishable from a steady signal. Reading
        // nothing is the honest one, and every meter already draws null as '--'.
        //
        // The history goes too, or the squelch's Auto would set a threshold from
        // samples taken in another mode once IQ is left again.
        const m = meters.current;
        m.basebandPower = null;
        m.noisePower = null;
        m.snr = null;
        m.snrHistory.length = 0;
        // The server does not gate IQ at all, so the indicator must not claim it
        // is holding anything closed.
        m.squelchOpen = true;
        m.lastGateOpenAt = performance.now();
    }, [tuning.mode]);

    // RM Noise is trained on voice bandwidth; on AM, FM and the rest what comes
    // back is not worth hearing, so it takes itself out of the way. Switched
    // off rather than left running, because a stage that is "on" and doing
    // nothing useful is a claim the toolbar tag would repeat.
    //
    // Here rather than in the Noise panel, where it was: a collapsed dock
    // section is unmounted, so a gate that lives in a panel is a gate that
    // stops watching the moment somebody folds the panel away — and the mode
    // is far more often changed from the Multipad or the top bar than from in
    // front of this setting.
    useEffect(() => {
        if (!noise.nr.enabled || noise.nr.type !== 'rmn') return;
        if (!rmModeSupported(tuning.mode)) {
            actions.setNoise({ nr: { enabled: false } });
            return;
        }
        // Supported, so the other half: the service trains a model per kind of
        // signal, and the mode is what says which of them to ask for. Here for
        // the same reason the gate above is — the panel that shows the model is
        // usually not on screen when the mode changes.
        getRmNoise().matchModel(tuning.mode);
    }, [tuning.mode, noise.nr.enabled, noise.nr.type]);

    // Choosing the network engine is the instruction to connect, wherever it
    // was chosen from: the Noise panel, its cut-down view, or the Multipad's
    // dropdown. It lives here rather than in the panel because the panel is not
    // always mounted to do it — the same lesson as the mode gate above, and as
    // the marker lookup elsewhere.
    //
    // Once per selection. Three things stop it trying again, and each was a way
    // of hammering an endpoint that rate-limits by IP: `rmTried` for the
    // attempt itself, `stopped` for the operator having pressed Disconnect, and
    // `authFailed` for rmnoise.com having said no to this password.
    const rmTried = useRef(false);
    useEffect(() => {
        const wanted = noise.nr.enabled && noise.nr.type === 'rmn'
            && rmModeSupported(tuning.mode);
        const rm = getRmNoise();
        if (!wanted) { rmTried.current = false; return; }
        if (rmTried.current || rm.ready || rm.connecting || rm.stopped || rm.authFailed) return;
        const { username, password } = rmCredentials();
        if (!username || !password) return;      // the panel asks for them
        rmTried.current = true;
        rm.connect({ mode: tuning.mode }).catch(() => { /* the bridge keeps the message */ });
    }, [noise.nr.enabled, noise.nr.type, tuning.mode]);

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
            audioFormat: audio.format,
            filters,
            noise,
            squelchValueDb: squelchValue,
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
    }, [tuning, audio, squelchValue, dsp, followTuning, filters, noise, view]);

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
            // A mode change makes every reading so far irrelevant: they were
            // taken in another mode. Arriving in SAM has to earn its own packet
            // before the clock can start, or a quiet spell in AM would put SAM
            // straight back out again. See resetWatch.
            if (next.mode !== tuningRef.current.mode) resetSamWatch(samWatch.current);
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

        // radiod reloads its preset on a mode change and the server waits 500 ms
        // before re-applying the operator's SSB AGC defaults, so ask for the
        // settled values after that.
        const refreshAGCSoon = (mode) => {
            if (!hasAGCSettings(mode)) return;
            clearTimeout(agcRefreshTimer.current);
            agcRefreshTimer.current = setTimeout(() => audioConn.requestAGC(), 800);
        };

        const commitMode = (mode) => {
            const def = MODE_BY_ID[mode];
            if (!def) return;
            applyTuning({ mode, bandwidthLow: def.low, bandwidthHigh: def.high });
            refreshAGCSoon(mode);
        };

        const commitTune = ({ frequency, mode, bandwidthLow, bandwidthHigh }) => {
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
            if (next !== t.mode) refreshAGCSoon(next);
        };

        // Entering IQ is worth stopping for once: it is the only mode that costs
        // the receiver's owner six times the bandwidth of Opus, and the only one
        // where the audio chain, the squelch and the S-meter all go away. So it
        // is confirmed rather than simply selected.
        //
        // The gate sits here, in front of both tuning actions, because the mode
        // can be set from four places on screen plus a control surface plus the
        // bridge, and a confirmation living in one of the panels would be a
        // confirmation the other five walked straight past.
        //
        // Only on the way *in*, and only from a non-IQ mode: leaving IQ, or
        // retuning while already there, costs nothing and asking again would be
        // a dialog in the way of the answer. Returns true when it took the
        // request, meaning the caller must not act on it.
        const gateIQ = (pending) => {
            if (!isIQ(pending.mode) || isIQ(tuningRef.current.mode)) return false;
            pendingIQ.current = pending;
            setIqPrompt({ mode: pending.mode });
            return true;
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

        // Hoisted out of the actions object so wake() can call it — see there.
        const powerOn = async () => {
            everStarted.current = true;
            // Whatever ended the last session is history the moment a new one
            // is asked for, and this is the only place that can know that —
            // including when the start *is* the operator answering the notice.
            setLost(null);
            const ok = await player.start();
            if (!ok) pushLog('warn', 'Audio context did not start — tap again');
            setRunning(true);
            // The identity for this session, settled before either socket opens
            // so audio and spectrum are paired under the same UUID.
            //
            // A new one every time but the first, which adopts the id the Start
            // overlay already registered when it asked whether there was room —
            // that is what makes a page load cost one /connection request
            // rather than two. See startSessionId.
            startSessionId();
            // Registers the UUID and tells us how long this session may run.
            // Usually a cache hit on the overlay's own check, and the sockets
            // share it too; v1 reads max_session_time from the same reply.
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
            // A link's view wins the first time, and only the first time —
            // takeUrlView hands it over once. Powering off and on again
            // within the visit should come back to the view you left, not
            // the one the link arrived with.
            await spectrumConn.connect(takeUrlView() || resumeView(last, t));
        };

        return {
            powerOn,

            // Power on because the operator reached for a control, rather than
            // because they pressed the power button.
            //
            // The receiver can be off with the whole interface still live and
            // usable — the idle watch stops it after a long silence and leaves
            // everything on screen, and the power button is a toggle — and in
            // that state every control still moves, still updates, and commands
            // nothing: applyTuning sends into a closed socket and send() drops
            // it. Reaching for a control is the operator saying they are back,
            // so this takes them at their word rather than making them find the
            // power button first and repeat themselves.
            //
            // Safe to call from any pointer handler, however often: it is a
            // no-op while the receiver is running, while another wake is still
            // connecting, and before the first manual start of the visit. It
            // deliberately does not await — a wake must never delay the gesture
            // that triggered it, and the commands that gesture produces are
            // picked up by the tune replayed on 'open'. The three conditions are
            // shouldWake, in lib/wake.js, with the reasoning for each.
            wake() {
                if (!shouldWake({
                    running: runningRef.current,
                    connecting: waking.current,
                    everStarted: everStarted.current,
                })) return false;
                waking.current = true;
                pushLog('info', 'Receiver woken by a control');
                Promise.resolve(powerOn()).catch(() => { /* logged by the socket */ })
                    .then(() => { waking.current = false; });
                return true;
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
                if (gateIQ({ kind: 'mode', mode })) return;
                commitMode(mode);
            },

            // Answers to the dialog gateIQ puts up. Confirm replays the request
            // it held, whichever of the two actions made it.
            confirmIQ() {
                const p = pendingIQ.current;
                pendingIQ.current = null;
                setIqPrompt(null);
                if (!p) return;
                if (p.kind === 'tune') commitTune(p.req);
                else commitMode(p.mode);
            },

            cancelIQ() {
                pendingIQ.current = null;
                setIqPrompt(null);
            },

            // Frequency, mode and passband in one tune. The v1 popup pages set
            // all three together (tuneToChannel), and doing it as separate
            // actions would walk the receiver through an intermediate state —
            // setMode resets the passband, so the old width would be sent for
            // the new mode before the real one arrived.
            tuneTo(req) {
                const next = MODE_BY_ID[req.mode] ? req.mode : tuningRef.current.mode;
                if (gateIQ({ kind: 'tune', mode: next, req })) return;
                commitTune(req);
            },

            setBandwidth(low, high) {
                // IQ's passband is fixed at the full ±6 kHz baseband.
                //
                // The server would accept a narrower one — plain iq takes edges,
                // unlike the wide variants — but the *stream* would not change:
                // GetSampleRateForMode returns 12 kHz for iq whatever the filter
                // says. So narrowing only band-limits the samples, and the
                // recording still claims 12 kHz of spectrum while most of it is
                // empty, with nothing in the WAV to say so. That is a quiet way
                // to ruin a capture, and the whole point of the mode is the
                // capture. clients/go/frontend does the same.
                //
                // Refused here rather than only in the sliders because the
                // spectrum's edge drag, the Multipad, the top bar, a control
                // surface and the bridge all arrive through this one action.
                if (isIQ(tuningRef.current.mode)) return;
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

            // A patch per stage: { nb: {...} } leaves the NR settings alone.
            setNoise(patch) {
                setNoiseState((n) => {
                    const next = {
                        nb: { ...n.nb, ...(patch.nb || {}) },
                        nr: { ...n.nr, ...(patch.nr || {}) },
                    };
                    player.setNoise(next);
                    return next;
                });
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

            // Opus or lossless PCM. The server takes the format from the
            // connect URL and holds it for the life of the socket, so this is
            // the one audio setting that costs a reconnect — a second or so of
            // silence, and the tuning, squelch, AGC and DSP are replayed on the
            // way back up by the 'open' handler.
            async setAudioFormat(format) {
                const before = audioConn.format;
                const next = audioConn.setFormat(format);
                setAudio((a) => (a.format === next ? a : { ...a, format: next }));
                if (next === before || !runningRef.current) return;
                audioConn.disconnect();
                await audioConn.connect(tuningRef.current);
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

            clearLog() { clearEventLog(); },
            log: pushLog,
        };
    }, []);

    // Read by noteFailure, which is subscribed to the sockets once on mount and
    // so holds the first render's closure for the life of the page.
    const actionsRef = useRef(null);
    actionsRef.current = actions;

    // SAM gives up on a carrier that has stopped moving — see lib/samFallback.js
    // for why that is measured as a number holding still rather than as packets
    // failing to arrive.
    //
    // Only while running: with the receiver stopped there are no packets, the
    // figure holds still by definition, and the mode would be changed out from
    // under an operator who is not listening to anything.
    useEffect(() => {
        if (!running) return undefined;
        const id = setInterval(() => {
            if (!samShouldFallBack(samWatch.current, tuningRef.current.mode, Date.now())) return;
            // setMode resets the watch through applyTuning, so this cannot fire
            // twice for one carrier.
            actions.setMode('am');
            pushLog('info', 'SAM: no carrier — switched to AM');
        }, SAM_CHECK_MS);
        return () => clearInterval(id);
    }, [running, actions]);

    const squelch = useMemo(() => ({
        value: squelchValue,
        enabled: squelchEnabled(squelchValue),
        threshold: squelchThreshold(squelchValue),
    }), [squelchValue]);

    const value = useMemo(() => ({
        tuning, audioState, spectrumState, view, running, serverInfo, session, lost,
        audio, squelch, agc, dsp, followTuning, filters, noise,
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
        iqPrompt,
    }), [tuning, audioState, spectrumState, view, running, serverInfo, session, lost, audio, squelch, agc, dsp, followTuning, filters, noise, catalog, localMarks, hidden, actions, iqPrompt]);

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
