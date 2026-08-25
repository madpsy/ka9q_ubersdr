// The receiver's own frequency accuracy.
//
// /api/description carries a `frequency_reference` block when the operator has the
// monitor running: the receiver listens to a standard station on a known frequency and
// reports how far off its own oscillator turned out to be. A v1 widget put that in the
// corner of the page (widgets/frequency.widget.html); this is the same fact in the
// spectrum toolbar, where the frequencies it applies to are.
//
// It is worth having on screen because it qualifies everything else there. A receiver
// twenty hertz out will have you tuning a CW signal to the wrong note and logging a
// frequency nobody else measured, and none of that shows anywhere until something is
// compared with something.
//
// The block only carries an offset once the monitor has averaged some history — the
// server sends `enabled` alone until then — so "no badge" means either that the
// operator does not run it or that it has not measured anything yet. Neither is worth
// a placeholder.

// Where the bands are, in hertz of error.
//
// Zero is zero: the monitor reports a rounded average, and a receiver reading exactly
// its reference is the thing the badge exists to confirm. Up to five hertz is fine for
// voice and for finding a signal, which is what most listening is; beyond that a CW
// note is audibly wrong and a logged frequency is wrong with it.
export const FREQ_OK_HZ = 0;
export const FREQ_WARN_HZ = 5;

/** 'good' | 'warn' | 'bad', or '' when there is nothing to say. */
export function offsetBand(hz) {
    if (hz == null || !Number.isFinite(Number(hz))) return '';
    const v = Math.abs(Number(hz));
    if (v <= FREQ_OK_HZ) return 'good';
    if (v <= FREQ_WARN_HZ) return 'warn';
    return 'bad';
}

/**
 * The offset the receiver is reporting, or null.
 *
 * Null covers every way of not knowing: no monitor, a monitor with no history yet, and
 * a field that arrived as something other than a number. The badge is absent in all
 * three, because a frequency accuracy of "unknown" is what every receiver without this
 * has, and none of them says so.
 */
export function freqOffset(serverInfo) {
    const ref = serverInfo && serverInfo.frequency_reference;
    if (!ref || typeof ref !== 'object') return null;
    const hz = Number(ref.frequency_offset);
    return ref.frequency_offset == null || !Number.isFinite(hz) ? null : hz;
}

/** The badge's text: signed, and in whole hertz, which is the precision on offer. */
export function offsetLabel(hz) {
    if (hz == null) return '';
    const n = Math.round(hz);
    if (n === 0) return '0 Hz';
    return `${n > 0 ? '+' : ''}${n} Hz`;
}

/**
 * The sentence behind it, which is where the detail goes.
 *
 * A badge reading "+7 Hz" is a number without a claim attached; the tooltip is where it
 * says whose error it is and what it means for what is on screen.
 */
export function offsetTitle(serverInfo) {
    const hz = freqOffset(serverInfo);
    if (hz == null) return '';
    const ref = serverInfo.frequency_reference || {};
    const parts = [];
    const band = offsetBand(hz);
    if (band === 'good') {
        parts.push('The receiver is on frequency against its reference station.');
    } else {
        parts.push(`Everything on screen reads ${offsetLabel(hz)} away from where it actually is,`
            + ' measured against a reference station.');
    }
    const expected = Number(ref.expected_frequency);
    if (Number.isFinite(expected) && expected > 0) {
        parts.push(`Reference: ${(expected / 1e6).toFixed(3)} MHz.`);
    }
    const snr = Number(ref.snr);
    if (Number.isFinite(snr)) parts.push(`Reference SNR ${snr.toFixed(1)} dB.`);
    return parts.join(' ');
}

// ── The marks on the spectrum ───────────────────────────────────────────────
//
// The badge says the receiver is a few hertz out; these say where. Two lines on
// the frequency the reference station transmits on: where it should be, and
// where this receiver is actually hearing it. The gap between them *is* the
// error, drawn at the scale of whatever the view is showing, which is the one
// place the number becomes something you can see rather than read.

/**
 * Where to draw, or null when there is nothing to draw.
 *
 * `expectedHz` is the station's true frequency, `actualHz` where this receiver
 * puts it. The offset is taken as the difference rather than trusted from the
 * server's own field: the two must agree or the picture would contradict the
 * badge beside it, and the subtraction is the definition.
 *
 * Null whenever the monitor is off, has not measured yet, or reports a
 * frequency that cannot be drawn — the same three cases the badge is absent
 * for, plus a missing expected frequency, which is the one the marks need and
 * the badge does not.
 */
export function refMarks(serverInfo) {
    const ref = serverInfo && serverInfo.frequency_reference;
    if (!ref || typeof ref !== 'object' || !ref.enabled) return null;

    const expectedHz = Number(ref.expected_frequency);
    if (!Number.isFinite(expectedHz) || expectedHz <= 0) return null;

    const offset = freqOffset(serverInfo);
    if (offset == null) return null;

    const detected = Number(ref.detected_frequency);
    const actualHz = Number.isFinite(detected) && detected > 0 ? detected : expectedHz + offset;

    return { expectedHz, actualHz, offsetHz: actualHz - expectedHz };
}

// How much clear space the two lines need before both are worth drawing, in CSS
// px between them.
//
// The same reasoning as the passband edges' own gap, and the same number: below
// it the two halos touch and what you see is one fat line rather than two, so
// the second is not telling you anything — worse, it makes the first look like
// it is somewhere it is not. A four hertz error on a 30 MHz view is a
// ten-thousandth of a pixel; the marks only separate once the span is down to a
// few kilohertz, which is exactly when the error is worth looking at.
export const REF_MIN_GAP_PX = 5;

/**
 * Whether the 'actual' line is far enough from the expected one to draw.
 *
 * A zero offset is not a near miss, it is the two being the same frequency, and
 * one line is the honest picture of that.
 */
export function refMarksSeparate(marks, spanHz, widthPx) {
    if (!marks || !(spanHz > 0) || !(widthPx > 0)) return false;
    if (!marks.offsetHz) return false;
    return Math.abs(marks.offsetHz / spanHz) * widthPx >= REF_MIN_GAP_PX;
}

/**
 * The tooltip for a reference line.
 *
 * `which` is 'expected' or 'actual'. Both name the station and the error; they
 * differ in which of the two frequencies they lead with, because the question
 * being asked of a line is "what is this one".
 */
export function refMarkTitle(serverInfo, which) {
    const marks = refMarks(serverInfo);
    if (!marks) return '';
    const ref = serverInfo.frequency_reference || {};
    const mhz = (hz) => `${(hz / 1e6).toFixed(6)} MHz`;

    const parts = [];
    if (which === 'actual') {
        parts.push(`Reference station as this receiver hears it: ${mhz(marks.actualHz)}.`);
        parts.push(`It transmits on ${mhz(marks.expectedHz)}, so the receiver reads`
            + ` ${offsetLabel(marks.offsetHz)} ${marks.offsetHz > 0 ? 'high' : 'low'}.`);
    } else if (!marks.offsetHz) {
        parts.push(`Reference station: ${mhz(marks.expectedHz)}.`);
        parts.push('This receiver is hearing it exactly there.');
    } else {
        parts.push(`Reference station transmits on ${mhz(marks.expectedHz)}.`);
        parts.push(`This receiver hears it ${offsetLabel(marks.offsetHz)} away,`
            + ` at ${mhz(marks.actualHz)}.`);
    }

    const snr = Number(ref.snr);
    if (Number.isFinite(snr)) parts.push(`Reference SNR ${snr.toFixed(1)} dB.`);
    return parts.join(' ');
}

/**
 * The one line the spectrum's hover readout shows for a reference mark.
 *
 * Short, because it sits in a box beside the cursor and peak readings and has to
 * be read at a glance; the sentence with the detail is refMarkTitle, on the
 * element's own tooltip for anyone who stops on it.
 *
 * `mark` is 'ref-expected' or 'ref-actual', as the hit test names them.
 */
export function refTipText(serverInfo, mark) {
    const marks = refMarks(serverInfo);
    if (!marks) return '';
    const mhz = (hz) => `${(hz / 1e6).toFixed(6)} MHz`;
    if (mark === 'ref-actual') return `Reference here: ${mhz(marks.actualHz)} (${offsetLabel(marks.offsetHz)})`;
    if (!marks.offsetHz) return `Reference: ${mhz(marks.expectedHz)} — on frequency`;
    return `Reference: ${mhz(marks.expectedHz)} (reads ${offsetLabel(marks.offsetHz)} off)`;
}

// ── The pill on the marker bar ──────────────────────────────────────────────
//
// The lines above are on the spectrum, where the error is a distance. This is
// the same station on the marker bar, where it is a label among the others —
// so that the frequency the receiver measures itself against is findable at a
// glance rather than only visible once you are zoomed in far enough to see two
// lines apart.

/**
 * Whether this receiver has a frequency reference at all.
 *
 * The capability, not the measurement: `refMarks` additionally needs the monitor
 * to have averaged something, and a settings toggle that appeared and vanished
 * with the first lock would be a control nobody could find twice. Same shape and
 * same job as packetAvailable and voiceSkimmerAvailable, which gate their own
 * switches this way.
 */
export function freqRefAvailable(serverInfo) {
    const ref = serverInfo && serverInfo.frequency_reference;
    return !!(ref && typeof ref === 'object' && ref.enabled);
}

/**
 * Where the pill goes, in hertz — or null when there is nothing to mark.
 *
 * The receiver's own frequency, not the station's: the marker bar shares the
 * spectrum's scale, so the pill has to sit over the peak in the trace beneath
 * it. Those are the same pixel until the span is down to a few kilohertz, and
 * from there on the difference is the point.
 */
export function refMarkerFreq(serverInfo) {
    const marks = refMarks(serverInfo);
    return marks ? marks.actualHz : null;
}

/** What the pill says. Short, because the bar gives a label about forty pixels. */
export const REF_MARKER_LABEL = 'Ref';

/**
 * The pill's hover line — the spectrum marks' own wording, because the bar's tip
 * and the spectrum's readout are the same box doing the same job, and the
 * reference should not describe itself two ways on one screen.
 */
export function refMarkerTip(serverInfo) {
    const marks = refMarks(serverInfo);
    if (!marks) return '';
    return refTipText(serverInfo, marks.offsetHz ? 'ref-actual' : 'ref-expected');
}

/**
 * The pill's place, as the one-element array `assignRows` takes for space that is
 * already claimed. Empty when there is nothing to draw or it is off screen.
 *
 * Row 0 — the near row, against the spectrum — and laid out before every other
 * layer, which is what "the reference outranks the rest" amounts to: seeded into
 * the layers below, a bookmark or a spot on the same frequency is pushed up to
 * the top row instead of sharing the space or covering it. That collision is the
 * normal case rather than an edge one, because a receiver measures itself against
 * a standard station and a standard station is exactly the kind of frequency
 * somebody has published a bookmark for.
 */
export function refMarkerLayout({ freq, startFreq, endFreq, width, labelWidth }) {
    if (freq == null || !(width > 0) || !(labelWidth > 0)) return [];
    const span = endFreq - startFreq;
    if (!(span > 0) || freq < startFreq || freq > endFreq) return [];
    return [{ x: ((freq - startFreq) / span) * width, width: labelWidth, row: 0 }];
}
