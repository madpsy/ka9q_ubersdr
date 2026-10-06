// One sample of everything the stats readout knows, on a clock the caller picks.
//
// Two things want it: the readout in the corner of the waterfall, which words it
// into lines once a second, and the Stats panel, which charts the rates and
// prints the rest on cards. Both need the same gathering — counters differenced
// against the last reading, a listener count on its own poll, an address fetched
// once a page, the host's process stats pulled rather than pushed — and that
// gathering has enough edge cases in it to be worth having once.
//
// Everything is differenced from counters rather than measured directly. The
// packet path and the draw loop increment an integer and nothing more; the rate
// is this hook's problem. That is also why the counters are read off the
// connection objects rather than from `view` — a closure over context state
// would be a second later, and the whole point is to be able to trust these
// numbers.
//
// Nothing here runs unless somebody is looking. The overlay is off by default
// and the Stats panel ships collapsed, and a collapsed panel is not mounted at
// all — so on an ordinary session this hook does not exist, which is what keeps
// the listener poll and the host's own measuring off the bill.

import { useEffect, useRef } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useChat } from '../chat/ChatContext.jsx';
import { readAppStats } from './appStats.js';
import { bandRate } from './bandSpectrum.js';
import { frameTicks } from './frameTicks.js';
import { subscribeListeners } from './listeners.js';
import { fetchMyIp, peekMyIp } from './myip.js';
import { perSecond } from './spectrumStats.js';
import { serverClock } from '../radio/serverClock.js';

// How often the host is asked to measure itself, however often we sample.
const APP_MS = 1000;

// The difference between two readings of AudioConnection.v4Stats, or null when
// either is missing. A counter that went backwards is a new connection object
// starting again from zero, and is read as nothing having happened rather than
// as a negative burst.
function v4Delta(was, at, ms) {
    if (!was || !at) return null;
    const d = { ms };
    for (const k of Object.keys(at)) d[k] = Math.max(0, (at[k] || 0) - (was[k] || 0));
    return d;
}

/**
 * Call `onSample` every `intervalMs` with a sample shaped for statLines().
 *
 * The first tick produces nothing: a rate needs two readings, and inventing one
 * from a counter's absolute value would report a session's whole history as one
 * interval of traffic.
 *
 * `onSample` is held in a ref rather than closed over, so a caller that rebuilds
 * it every render — which is every caller, since it writes to state — does not
 * restart the clock underneath itself.
 *
 * @param intervalMs  how often to sample. The rates are averaged over it, so a
 *                    short interval buys resolution and pays in quantisation:
 *                    a 10/s feed sampled twice a second is five frames a bucket.
 * @param onSample    (sample) => void
 */
export default function useStatsSample(intervalMs, onSample) {
    const { spectrumConn, audioConn, meters } = useRadio();

    // How many of the listeners are in the chat room. Whatever the Chat panel
    // has — there is no second socket to open here, and none to open at all
    // while that panel is hidden, which is when this reads zero and the caller
    // drops the bracket.
    //
    // Mirrored into a ref on every render rather than closed over: a chat
    // message arriving must not rebuild the interval below, and the tick wants
    // the latest value rather than the one from when it was scheduled.
    const chatUsers = useChat().users.length;
    const chatRef = useRef(0);
    chatRef.current = chatUsers;

    const cb = useRef(onSample);
    cb.current = onSample;

    // The address the receiver sees this page on. Asked for once a page and
    // shared with the start map, which asks for the same thing to say hello
    // with — see lib/myip.js. Whichever of the two gets there first pays for it.
    const ip = useRef((peekMyIp() || {}).ip || '');
    useEffect(() => {
        let alive = true;
        fetchMyIp().then((d) => { if (alive && d && d.ip) ip.current = d.ip; });
        return () => { alive = false; };
    }, []);

    // How many people are on the receiver, from the poll the Listeners panel
    // uses. Shared and reference-counted (lib/listeners.js), so this joins the
    // existing loop when that panel is open and starts one of its own — a
    // request every ten seconds — when it is not. Held in a ref and read by the
    // tick below rather than kept in state: it changes on its own schedule and
    // there is no reason for it to redraw the caller off-beat.
    const listeners = useRef(null);
    useEffect(() => subscribeListeners((state) => {
        const n = ((state && state.channels) || []).length;
        // Zero is not a reading — the list always contains this session, so an
        // empty one is a poll that has not landed or has failed. Leaving the
        // last count is better than blinking to a number that cannot be true.
        if (n > 0) listeners.current = n;
    }), []);

    // The host's process stats, at most once a second however fast the caller
    // is ticking.
    //
    // Reading is what makes the host measure — see lib/appStats.js — so a panel
    // sampling twice a second to draw a smooth chart would double what the
    // phone spends on /proc for two figures that barely move in a second. CPU
    // is a rate and needs an interval to mean anything at all; memory that
    // moved in half a second has not moved by much. So the last answer is
    // handed back until it is stale.
    const app = useRef({ at: 0, value: null });

    const prev = useRef(null);
    useEffect(() => {
        prev.current = null;
        const tick = () => {
            const now = performance.now();
            const at = {
                t: now,
                bytes: spectrumConn.bytesIn || 0,
                audio: (audioConn && audioConn.bytesIn) || 0,
                frames: spectrumConn.framesIn || 0,
                ticks: frameTicks(),
                v4: audioConn && audioConn.v4Stats ? { ...audioConn.v4Stats } : null,
            };
            const was = prev.current;
            prev.current = at;
            if (!was) return;
            const ms = at.t - was.t;
            const m = meters.current;
            const appStats = () => {
                if (now - app.current.at >= APP_MS) {
                    app.current = { at: now, value: readAppStats() };
                }
                return app.current.value;
            };
            // Lags are on this page's clock; the estimate is what turns them into
            // ages on the receiver's. No estimate, no age: without one the
            // subtraction is between two different clocks, and the figure would
            // be out by however far out this device happens to be.
            const clk = serverClock(now);
            const lag = audioConn && audioConn.arrivalLag;
            cb.current({
                fps: perSecond(at.ticks - was.ticks, ms),
                framesIn: perSecond(at.frames - was.frames, ms),
                bytesIn: perSecond(at.bytes - was.bytes, ms),
                audioBytes: perSecond(at.audio - was.audio, ms),
                // The lossless path's counters over this interval, as deltas
                // rather than rates: what anybody wants of them is a ratio or a
                // share, which only means something summed over several
                // samples — see the Stats panel's averaging window.
                v4: v4Delta(was.v4, at.v4, ms),
                // Already a rate, measured by the panel that owns that stream —
                // null whenever it is closed, which is whenever the stream is.
                bandBytes: bandRate(),
                binCount: spectrumConn.binCount,
                binHz: spectrumConn.binBandwidth,
                divisor: spectrumConn.rateDivisor,
                // The stream's own figures, not the AudioContext's — see
                // AudioPlayer.streamRate for when those two disagree.
                streamRate: m.streamRate,
                streamChannels: m.channels,
                queuedSec: m.queuedSec,
                outLatSec: m.outLatencySec,
                // What you are hearing: capture to the speaker, the output
                // device included, since that is where the operator hears it.
                heardAgeMs: clk && m.playLag != null
                    ? m.playLag + clk.theta + (m.outLatencySec || 0) * 1000
                    : null,
                // Capture to arrival here, before any of this client's queue.
                arrivalAgeMs: clk && lag != null ? lag + clk.theta : null,
                // How far out either could be: half the best round trip, grown
                // by how long ago that was.
                ageErrMs: clk ? clk.err : null,
                underruns: m.underruns,
                listeners: listeners.current,
                chatUsers: chatRef.current,
                ip: ip.current,
                // Nothing is read here while nobody is looking, which is the
                // point: this is the only figure whose cost is paid outside the
                // page. See the ref above for why it is not read every tick.
                app: appStats(),
            });
        };
        tick();
        const t = setInterval(tick, intervalMs);
        return () => clearInterval(t);
    }, [spectrumConn, audioConn, meters, intervalMs]);
}
