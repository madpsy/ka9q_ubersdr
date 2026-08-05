// What each topic looks like on the wire.
//
// Pure: a plain object in, a plain object out. BridgeHost gathers the pieces
// from React and calls these; nothing here knows where they came from, which is
// what lets every field of the published API be pinned by a test.
//
// Two rules the whole thing depends on:
//
//   * Fixed shape. A topic always carries the same keys, so a client can diff,
//     merge and rely on a field existing. Missing values are null, never
//     absent.
//   * Rounded at the source. Signal values are rounded to a tenth of a dB here
//     rather than at the receiving end, because the patch diffing upstream is
//     by value: unrounded floats would put a "change" on the wire ten times a
//     second forever, and the rate limit would be spending its budget on noise.

import { MODES, bandwidthLimits } from '../radio/constants.js';
import { HAM_BANDS } from '../lib/bands.js';
import { dbfsToSUnits } from '../lib/format.js';
import { catalogue } from '../controls/functions.js';

const num = (v) => (Number.isFinite(v) ? v : null);
const round = (v, dp) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

// The server's "nothing here" reading. v1 and v2 both use values below -900 to
// mean no measurement rather than a very quiet one, and a client plotting -999
// as a signal level would draw a cliff.
const isReading = (v) => Number.isFinite(v) && v > -900;

export function tuningSnapshot(src) {
    const t = src.tuning || {};
    return {
        frequency: num(t.frequency),
        mode: t.mode || null,
        bandwidthLow: num(t.bandwidthLow),
        bandwidthHigh: num(t.bandwidthHigh),
        vfo: src.vfo || null,
        band: src.band || null,
    };
}

export function audioSnapshot(src) {
    const a = src.audio || {};
    const sq = src.squelch || {};
    return {
        volume: num(a.volume),
        muted: !!a.muted,
        // Silenced for a moment by something other than the user's mute — a
        // transmitting rig, an extension speaking over it. Reported separately
        // so a client showing a mute button shows the *mute*, and nothing has
        // to guess why the audio stopped.
        ducked: !!a.ducked,
        channel: a.channel || 'both',
        bufferSec: num(a.bufferSec),
        squelch: {
            value: num(sq.value),
            enabled: !!sq.enabled,
            threshold: num(sq.threshold),
            // Whether the gate is passing audio *now* — a live reading, not a
            // setting, and the one a client actually watches.
            open: src.squelchOpen === undefined ? null : !!src.squelchOpen,
        },
    };
}

export function signalSnapshot(src) {
    const m = src.meters || {};
    const dbfs = isReading(m.basebandPower) ? m.basebandPower : null;
    return {
        dbfs: round(dbfs, 1),
        noise: isReading(m.noiseDensity) ? round(m.noiseDensity, 1) : null,
        snr: isReading(m.snr) ? round(m.snr, 1) : null,
        // The S-meter reading the page is showing, so a client's meter agrees
        // with the one on screen rather than re-deriving it from dBFS with a
        // different curve — which is exactly what the old extension did.
        s: dbfs === null ? null : round(dbfsToSUnits(dbfs), 1),
        level: round(m.level, 3),
        clipping: !!m.clipping,
    };
}

export function spectrumSnapshot(src) {
    const v = src.view || {};
    return {
        centerFreq: num(v.centerFreq),
        span: num(v.span),
        binBandwidth: num(v.binBandwidth),
        binCount: num(v.binCount),
        follow: !!src.follow,
    };
}

export function sessionSnapshot(src) {
    const s = src.session || {};
    return {
        id: src.sessionId || null,
        receiverId: src.receiverId || null,
        // v2's word for "audio is playing" — the old page called this
        // audioStarted and read it off an overlay's CSS class.
        running: !!src.running,
        maxSec: num(s.maxSec),
        idleSec: num(s.idleSec),
        startedAt: num(s.startedAt),
    };
}

export function pageSnapshot(src) {
    return { url: src.url || null, title: src.title || null };
}

// --- reference data ---------------------------------------------------------

/**
 * Every mode with its default passband and the widest one the receiver allows.
 *
 * A client that lets someone type passband edges needs the limits, and a client
 * that lists modes should list *these* rather than a copy that goes stale the
 * day a mode is added.
 */
export function modesSnapshot() {
    return MODES.map((m) => {
        const limits = bandwidthLimits(m.id);
        return {
            id: m.id,
            label: m.label,
            group: m.group,
            default: { low: m.low, high: m.high },
            limits: { min: limits.min, max: limits.max, sideband: limits.sideband },
        };
    });
}

export function bandsSnapshot() {
    return HAM_BANDS.map(([name, min, max]) => ({ name, min, max }));
}

/**
 * The mappable function catalogue, which is what `run` addresses.
 *
 * The same list the MIDI, FlexControl and keyboard panels show, so a client can
 * offer everything this receiver can do without a protocol change when the list
 * grows. `needs` says which ones this instance actually has hardware for.
 */
export function functionsSnapshot(src) {
    return catalogue(src.dspSchemas || null, src.hardware || null).map((f) => ({
        id: f.id,
        label: f.label,
        group: f.group,
        encoder: !!f.encoder,
        repeat: !!f.repeat,
        needs: f.needs || null,
    }));
}

export const SNAPSHOTS = {
    tuning: tuningSnapshot,
    audio: audioSnapshot,
    signal: signalSnapshot,
    spectrum: spectrumSnapshot,
    session: sessionSnapshot,
    page: pageSnapshot,
    modes: modesSnapshot,
    bands: bandsSnapshot,
    functions: functionsSnapshot,
};

export function snapshotFor(topic, src) {
    const fn = SNAPSHOTS[topic];
    return fn ? fn(src || {}) : null;
}

// --- the descriptor ---------------------------------------------------------

/**
 * What `announce` carries: who this is, what it can do, and how to talk to it.
 *
 * `receiver.id` is the instance's `public_uuid` from /api/description — stable
 * across sessions and reloads, unlike the session id. A client keeping a list
 * of receivers should key on that; one tracking a live connection wants the
 * session id. Both are here because they answer different questions.
 */
export function describePage(src) {
    const info = src.serverInfo || {};
    const rx = info.receiver || {};
    return {
        app: 'ubersdr',
        ui: 'v2',
        api: src.api,
        receiver: {
            id: info.public_uuid || null,
            name: rx.name || null,
            callsign: rx.callsign || null,
            location: rx.location || null,
            url: rx.public_url || null,
            serverVersion: info.version || null,
        },
        session: sessionSnapshot(src),
        page: pageSnapshot(src),
        capabilities: src.capabilities || [],
        topics: src.topics || [],
        commands: src.commands || [],
    };
}
