// The time-signal decoder's wire format, and the readouts built from it.
//
// Decoding happens on the server: audio_extensions/clock/extension.go feeds the
// session's audio to an `ubersdr-clock` subprocess, which is AetherSDR's
// AetherClock chain behind a stdio front end. It emits newline-delimited JSON
// and the Go side forwards each line verbatim as a binary frame — the newer
// audio-extension convention (see ../protocol.js), so unlike the CW and
// teleprinter decoders there is no packed binary format to unpick here.
//
// Five event types: state, time, frame, second, diag. Everything below turns
// one of those into something a panel can draw, and none of it touches React,
// because the interesting parts — what the offset means, which acquisition
// stage is failing, how the alignment overlay lines up — are exactly the parts
// worth testing without a renderer.

// ── tuning ──────────────────────────────────────────────────────────────────

// WWV/WWVH are received by tuning USB 1 kHz BELOW the carrier, which puts the
// carrier at 1000 Hz audio, the 100 Hz BCD subcarrier sidebands at 900/1100 Hz
// and the seconds tick at its 2000 Hz (WWV) / 2200 Hz (WWVH) image. WWVB's
// 60 kHz carrier lands at ~1000 Hz from a 0.059 MHz dial.
//
// The dial frequency is what is stored, so these are already offset — there is
// no arithmetic at tune time and nothing to get the sign of wrong.
export const CARRIER_OFFSET_HZ = 1000;

export const CLOCK_FREQUENCIES = [
    {
        // WWVH (Kauai) shares only these four with WWV (Fort Collins). Split
        // out rather than labelled "WWV / WWVH" throughout, because on 20 and
        // 25 MHz there is no WWVH to hear and the decoder's station tag will
        // never say WWVH there — a menu implying otherwise sends someone
        // hunting for a signal that does not exist.
        group: 'WWV / WWVH',
        options: [
            { hz: 2_499_000, label: '2.5 MHz', carrier: 2_500_000 },
            { hz: 4_999_000, label: '5 MHz', carrier: 5_000_000 },
            { hz: 9_999_000, label: '10 MHz', carrier: 10_000_000 },
            { hz: 14_999_000, label: '15 MHz', carrier: 15_000_000 },
        ],
    },
    {
        group: 'WWV only',
        options: [
            { hz: 19_999_000, label: '20 MHz', carrier: 20_000_000 },
            // NIST has run 25 MHz as an experimental broadcast since 2014 —
            // real, but intermittent and at lower power, so it is worth
            // offering and worth saying so before someone concludes the
            // decoder is broken.
            { hz: 24_999_000, label: '25 MHz (experimental)', carrier: 25_000_000 },
        ],
    },
    {
        group: 'WWVB',
        options: [
            { hz: 59_000, label: '60 kHz', carrier: 60_000 },
        ],
    },
];

// The passband has to reach 2.2 kHz or the WWV/WWVH tick image is cut off, and
// the tick is the only thing the decoder gets a second edge from — a narrower
// filter leaves it in `acquiring` for ever with nothing to say why. 0 to 3 kHz
// is also the span the tone spectrum draws.
export const CLOCK_MODE = 'usb';
export const CLOCK_BANDWIDTH = { low: 0, high: 3000 };

// Below this the dial is taken to be on WWVB. Matches wwvbCeilingHz in
// audio_extensions/clock/extension.go, which decides which decoder to spawn —
// the panel must agree with it or it will label a station the server is not
// decoding.
export const WWVB_CEILING_HZ = 1_000_000;

export function stationFor(dialHz) {
    return Number.isFinite(dialHz) && dialHz > 0 && dialHz < WWVB_CEILING_HZ ? 'wwvb' : 'wwv';
}

/** The menu entry the receiver is on, or null. Tolerant of a few Hz of drift. */
export function tunedClockOption(dialHz, tolerance = 200) {
    if (!Number.isFinite(dialHz)) return null;
    for (const g of CLOCK_FREQUENCIES) {
        for (const o of g.options) {
            if (Math.abs(o.hz - dialHz) <= tolerance) return o;
        }
    }
    return null;
}

// ── frames ──────────────────────────────────────────────────────────────────

const utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

/**
 * One binary frame as the event it carries, or null.
 *
 * Null covers a truncated frame, one that is not JSON, and one whose `type` is
 * not a string — the same contract as every other decoder's frame reader. A
 * single bad frame is dropped rather than taking the panel down with it.
 */
export function decodeFrame(data) {
    let text;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = utf8 ? utf8.decode(new Uint8Array(data)) : '';
    else if (ArrayBuffer.isView(data)) text = utf8 ? utf8.decode(data) : '';
    else return null;

    let ev;
    try {
        ev = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
    if (typeof ev.type !== 'string') return null;
    return ev;
}

// ── state and station ───────────────────────────────────────────────────────

export const STATE_LABELS = {
    nosignal: 'No signal',
    acquiring: 'Acquiring',
    locked: 'Locked',
};

// `wait` rather than `on` for acquiring: the decoder is working and has not
// got there, which is a different thing from running normally.
export const STATE_TONES = { nosignal: 'off', acquiring: 'wait', locked: 'on' };

export const STATION_LABELS = {
    wwv: 'WWV', wwvh: 'WWVH', wwvb: 'WWVB', unknown: 'Unknown',
};

export function stateLabel(state) { return STATE_LABELS[state] || 'Stopped'; }
export function stateTone(state) { return STATE_TONES[state] || 'off'; }

/**
 * How the station tag reads while the decoder is still deciding.
 *
 * WWV and WWVH share one decoder and are told apart by which tick band folds to
 * an impulse, which takes a few seconds of clean signal — so `unknown` is a
 * real state and not a failure, and saying "Colorado or Hawaii" is more honest
 * than picking one.
 */
export function stationLabel(station) {
    return STATION_LABELS[station] || STATION_LABELS.unknown;
}

// ── the offset ──────────────────────────────────────────────────────────────

// Where a clock stops being interesting and starts being wrong. NTP keeps a
// machine inside a few ms; tens of ms is a machine with no NTP but a decent
// crystal; past a second something is actually broken.
export const OFFSET_GOOD_MS = 50;
export const OFFSET_WARN_MS = 1000;

export function offsetTone(ms) {
    if (!Number.isFinite(ms)) return 'off';
    const a = Math.abs(ms);
    if (a <= OFFSET_GOOD_MS) return 'good';
    if (a <= OFFSET_WARN_MS) return 'warn';
    return 'bad';
}

/**
 * An offset for display, sign and all.
 *
 * A signed number is the whole point — "your clock is 340 ms SLOW" and "340 ms
 * fast" are opposite faults — so the sign is never dropped, and a true minus
 * sign is used rather than a hyphen because these are set beside each other in
 * a column and a hyphen does not line up.
 */
export function formatOffset(ms) {
    if (!Number.isFinite(ms)) return '—';
    const sign = ms < 0 ? '−' : '+';
    const a = Math.abs(ms);
    if (a < 1000) return `${sign}${a.toFixed(a < 10 ? 1 : 0)} ms`;
    if (a < 60000) return `${sign}${(a / 1000).toFixed(a < 10000 ? 2 : 1)} s`;
    const mins = a / 60000;
    if (mins < 60) return `${sign}${mins.toFixed(1)} min`;
    return `${sign}${(mins / 60).toFixed(1)} h`;
}

/**
 * Which way round the error is, in words.
 *
 * The sign convention is the decoder's: offset = broadcast time − clock, so a
 * positive offset means the clock reads earlier than the broadcast, i.e. it is
 * behind. Nobody should have to derive that from a sign while looking at it.
 */
export function offsetSense(ms) {
    if (!Number.isFinite(ms) || Math.abs(ms) < 1) return 'in step';
    return ms > 0 ? 'behind' : 'ahead';
}

// ── the time itself ─────────────────────────────────────────────────────────

/**
 * The broadcast time now, advanced from the last decode.
 *
 * A `time` event is a snapshot at one second edge, and WWV/WWVH only produce
 * one per minute — so a display that showed the event verbatim would sit frozen
 * for a minute at a time, on a panel whose entire subject is what the time is.
 * Advancing it by the elapsed wall time gives a clock that ticks.
 *
 * Using the browser's clock to measure that elapsed time is fine even when the
 * browser's clock is the thing being found wrong: what is borrowed is an
 * INTERVAL of at most a minute, not an absolute reading, and no clock bad
 * enough to matter here is also losing seconds per minute. The absolute instant
 * still comes entirely from the radio.
 */
export function correctedNowMs(time, nowMs) {
    if (!time || !Number.isFinite(time.utc_ms) || !Number.isFinite(time.at)) return null;
    if (!Number.isFinite(nowMs)) return null;
    return time.utc_ms + (nowMs - time.at);
}

/**
 * Whether the browser is already on UTC.
 *
 * Worth knowing because showing "14:32:07 BST" beside "14:32:07 UTC" is a
 * readout that has learned nothing — in that case there is one clock to show,
 * not two.
 */
export function localIsUtc(offsetMinutes) {
    const off = Number.isFinite(offsetMinutes)
        ? offsetMinutes
        : (typeof Date === 'function' ? new Date().getTimezoneOffset() : 0);
    return off === 0;
}

/**
 * A time of day, in a named zone or the browser's own.
 *
 * `timeZone: undefined` means the browser's zone — which is the point of this
 * whole readout. A browser's clock can be hours wrong while its timezone is
 * still right: they are separate settings, and the zone is the half we can
 * trust. So the instant comes from the radio and the zone from the browser,
 * and neither contributes what it is bad at.
 *
 * en-GB with hour12 false rather than the browser's locale: this sits beside a
 * UTC readout and under a decoder that speaks in 24-hour time, and a lone
 * "2:32:07 pm" in the middle of that is harder to compare, not friendlier.
 */
export function formatClock(ms, timeZone) {
    if (!Number.isFinite(ms)) return '--:--:--';
    try {
        return new Date(ms).toLocaleTimeString('en-GB', {
            timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
    } catch (e) {
        return '--:--:--';
    }
}

/** The date, for when a zone puts the receiver on a different day to the user. */
export function formatDay(ms, timeZone) {
    if (!Number.isFinite(ms)) return '';
    try {
        return new Date(ms).toLocaleDateString('en-GB', {
            timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        });
    } catch (e) {
        return '';
    }
}

/**
 * What to call the browser's zone — 'BST', 'GMT+5:30', whatever it offers.
 *
 * An unlabelled local time next to a UTC one is ambiguous in exactly the way
 * this panel exists to remove, so a bare offset is better than nothing and
 * 'Local' is the last resort.
 */
export function zoneLabel(timeZone) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' })
            .formatToParts(new Date());
        const found = parts.find((p) => p.type === 'timeZoneName');
        if (found && found.value) return found.value;
    } catch (e) { /* fall through */ }
    return 'Local';
}

// ── the classified-second strip ─────────────────────────────────────────────

export const SYMBOL_LABELS = ['0', '1', 'M'];
export const SYMBOL_NAMES = ['binary zero', 'binary one', 'marker'];

// One broadcast minute. The strip holds exactly a frame so the marker pattern
// — a marker every tenth second — is visible as a pattern rather than a list.
export const STRIP_LENGTH = 60;

/**
 * Add one classified second to the strip.
 *
 * Kept as a flat ring rather than indexed by second-of-frame: before the frame
 * anchors, `second_of_frame` is −1 for every second, and an array indexed by it
 * would show one cell flickering instead of the run of symbols that is the only
 * evidence the decoder is doing anything at all during those minutes.
 */
export function appendSecond(strip, ev, cap = STRIP_LENGTH) {
    if (!ev || typeof ev.symbol !== 'number') return strip;
    const out = strip.concat([{
        // edge_sample is monotonic and unique per second, which makes it a
        // better React key than an index into a shifting window.
        id: Number.isFinite(ev.edge_sample) ? ev.edge_sample : (strip.length ? strip[strip.length - 1].id + 1 : 0),
        symbol: ev.symbol,
        confidence: Number.isFinite(ev.confidence) ? ev.confidence : 0,
        secondOfFrame: Number.isFinite(ev.second_of_frame) ? ev.second_of_frame : -1,
    }]);
    return out.length > cap ? out.slice(out.length - cap) : out;
}

// A classification margin below this is a guess. It is the decoder's own
// per-frame trust floor (minBitConfidence in TimeFrameVoter), so the strip
// greys exactly the seconds the voter discounts.
export const WEAK_CONFIDENCE = 0.05;

export function symbolTone(cell) {
    if (!cell) return 'none';
    if (cell.confidence < WEAK_CONFIDENCE) return 'weak';
    return cell.symbol === 2 ? 'marker' : 'bit';
}

// ── the acquisition funnel ──────────────────────────────────────────────────

/**
 * Why a lock is not happening yet, as ordered stages.
 *
 * This is the part of the decoder worth surfacing. A time-signal decoder that
 * is not working looks exactly like one that is working on a dead band — it
 * says nothing either way — and the single most common cause is a receive
 * filter too narrow to pass the tick image, which is invisible unless
 * something says "no tick". The binary reports each stage of its own
 * acquisition; this turns that into a list with the first failing stage
 * marked, because the first failure is the only one worth acting on.
 */
export function funnelStages(diag, station) {
    if (!diag) return [];
    const wwvb = station === 'wwvb';

    const stages = [
        {
            id: 'carrier',
            label: wwvb ? 'Carrier tone' : 'Second tick',
            ok: !!diag.tone_detected,
            detail: Number.isFinite(diag.tone_snr_db) ? `${diag.tone_snr_db.toFixed(1)} dB` : null,
            hint: wwvb
                ? 'No 60 kHz carrier in the audio. Tune USB to 0.059 MHz.'
                : 'No seconds tick. The tick is recovered from its 2000 Hz (WWV) or '
                  + '2200 Hz (WWVH) image, so the passband has to reach 2.2 kHz — a '
                  + 'narrow SSB filter cuts it off and nothing downstream can start.',
        },
        {
            id: 'timing',
            label: 'Second edge',
            ok: !!diag.phase_locked,
            detail: Number.isFinite(diag.delay_est_ms) ? `${diag.delay_est_ms.toFixed(1)} ms` : null,
            hint: 'The tick is there but its phase has not settled. Usually fading; '
                + 'give it a minute, or try another frequency.',
        },
        {
            id: 'frame',
            label: 'Frame sync',
            ok: !!diag.anchored,
            detail: diag.bad_frame_streak > 0 ? `${diag.bad_frame_streak} bad` : null,
            hint: 'Seconds are being classified but the minute has not been located. '
                + 'This needs about two clean minutes.',
        },
        {
            id: 'vote',
            label: 'Vote',
            ok: (diag.refusal === 'none' || !diag.refusal) && diag.frames_in_window >= 2,
            detail: Number.isFinite(diag.frames_in_window) && Number.isFinite(diag.window_size)
                ? `${diag.frames_in_window}/${diag.window_size}` : null,
            hint: refusalHint(diag.refusal, diag.frames_in_window),
        },
    ];

    // Only the first failure is actionable — a later stage cannot pass while an
    // earlier one is down, so marking all of them red says nothing.
    let blocked = false;
    for (const s of stages) {
        s.blocked = blocked;
        if (!s.ok && !blocked) { s.first = true; blocked = true; }
    }
    return stages;
}

export const REFUSAL_HINTS = {
    quality_floor: 'The window agrees, but not confidently enough to certify a time. '
        + 'This is the gate that stops a deep fade being reported as a good decode.',
    plausibility: 'A time was decoded, but it is more than a day from the receiver’s '
        + 'clock. Either the receiver’s clock is badly wrong, or — far more likely — '
        + 'the decode is a coherent misread. Refusing it is correct.',
    staleness: 'No recent frame is valid. The signal was there and has gone.',
    contested: 'The frames in the window disagree with each other.',
};

export function refusalHint(refusal, framesInWindow) {
    if (refusal && REFUSAL_HINTS[refusal]) return REFUSAL_HINTS[refusal];
    if (Number.isFinite(framesInWindow) && framesInWindow < 2) {
        return 'Still collecting. Two consecutive good minutes are the minimum.';
    }
    return null;
}

// ── the alignment display ───────────────────────────────────────────────────

/**
 * The received envelope and the matched template, both scaled to 0..1.
 *
 * The template arrives zero-mean — it is what the matched filter correlates
 * against, not a picture — so its minimum is negative and it has to be rescaled
 * before it can be drawn over the envelope. The envelope arrives already
 * normalised by the decoder against its own running peak, and is only clamped.
 *
 * `shift` is the decoder's window_shift, in series samples: where the received
 * pulse actually sits relative to the template's nominal position. The template
 * is drawn shifted by it, so the two stay honest to each other while the
 * decoder absorbs sample-clock drift. Drawing them unshifted would show a
 * permanent misalignment that is not real.
 */
export function alignmentSeries(second) {
    if (!second || !Array.isArray(second.envelope) || !second.envelope.length) return null;

    const envelope = second.envelope.map((v) => clamp01(v / 1.5));

    let expected = null;
    if (Array.isArray(second.expected) && second.expected.length) {
        let min = Infinity;
        let max = -Infinity;
        for (const v of second.expected) {
            if (!Number.isFinite(v)) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const span = max - min;
        expected = span > 1e-9
            ? second.expected.map((v) => clamp01((v - min) / span))
            : second.expected.map(() => 0);
    }

    return {
        envelope,
        expected,
        shift: Number.isFinite(second.windowShift) ? second.windowShift
            : (Number.isFinite(second.window_shift) ? second.window_shift : 0),
        seriesRate: second.series_rate || second.seriesRate || envelope.length,
        symbol: Number.isFinite(second.symbol) ? second.symbol : -1,
    };
}

function clamp01(v) {
    if (!Number.isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/**
 * A series as an SVG polyline `points` string.
 *
 * `offset` shifts the series right by that many samples, for drawing the
 * template where the decoder actually matched it.
 */
export function polylinePoints(series, width, height, offset = 0) {
    if (!series || !series.length) return '';
    const n = series.length;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
        const x = ((i + offset) / (n - 1)) * width;
        const y = height - clamp01(series[i]) * height;
        pts[i] = `${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return pts.join(' ');
}

// ── frame detail ────────────────────────────────────────────────────────────

/**
 * DUT1, in the form the broadcast means it: UT1 − UTC to a tenth of a second.
 *
 * Sent as signed tenths. Zero is a real value and not a missing one — it means
 * the Earth is currently in step with the atomic scale to within 0.1 s — so it
 * is shown rather than blanked.
 */
export function formatDut1(tenths) {
    if (!Number.isFinite(tenths)) return null;
    const s = tenths / 10;
    return `${s > 0 ? '+' : (s < 0 ? '−' : '')}${Math.abs(s).toFixed(1)} s`;
}

/** The day-of-year and two-digit year as a date, or null if either is missing. */
export function formatDate(doy, year2) {
    if (!Number.isFinite(doy) || !Number.isFinite(year2) || doy < 1 || doy > 366) return null;
    const d = new Date(Date.UTC(2000 + year2, 0, doy));
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

/**
 * The flag bits a frame carries that voting does not touch.
 *
 * Returned as a list rather than a set of booleans because that is how it is
 * drawn — a row of chips, only the ones that are set — and because leap_year is
 * WWVB-only and simply does not exist on a WWV frame.
 */
export function frameFlags(frame) {
    if (!frame) return [];
    const out = [];
    if (frame.leap_pending) {
        out.push({ id: 'leap', label: 'Leap second pending', tone: 'warn' });
    }
    if (frame.leap_year) out.push({ id: 'leapyear', label: 'Leap year', tone: 'info' });
    if (frame.dst1 || frame.dst2) {
        // The two bits are a schedule, not a state: DST1 is the status at 00:00Z
        // today and DST2 at 24:00Z, so the pair says whether a change happens
        // during today and which way round.
        const label = frame.dst1 && frame.dst2 ? 'US DST in effect'
            : (frame.dst2 ? 'US DST starts today' : 'US DST ends today');
        out.push({ id: 'dst', label, tone: 'info' });
    }
    return out;
}
