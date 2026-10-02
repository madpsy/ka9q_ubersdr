// Where the playground's Clock blocks get the time: the page's half (blocks/
// clock.js is the graph's).
//
// Three clocks, in the order they are to be believed, each with how far out it
// could be:
//
//   ntp       the NTP addon, which decodes WWV, DCF77, MSF and the rest off the
//             air on this receiver (lib/ntpTime.js). Measured here the way the
//             Time panel measures it — a burst of timed requests, then one every
//             POLL_MS — and only while a Clock needs it. Not every receiver has
//             the addon; where it is missing this clock is simply not offered.
//   receiver  the receiver host's own clock, measured from the audio socket's
//             pings (radio/serverClock.js). Only as right as that host is — the
//             receiver says whether it thinks it is synchronised.
//   device    this machine's Date.now(). No way to know how far out it is.
//
// And a fourth thing that is not a clock but a stamp: each packet of IQ says
// when its first sample was captured (capture_time.go), on the radiod host's
// clock, counted from a GPSDO-locked A/D — so within a stream the stamps are
// exact to the sample. A Clock aligned to the signal uses those, corrected to
// the addon's time where both can be measured.
//
// packetTime() is what goes to the worker with every packet: all of it, so each
// Clock block chooses for itself.

import { POLL_MS, BURST_GAP_MS, WINDOW, addSample, bestEstimate, clockAsleep, newClock } from '../lib/ntpTime.js';
import { takeNtpSample } from '../lib/ntpSample.js';
import { serverClock } from '../radio/serverClock.js';

export class TimeSource {
    /** `sample(seq)` takes one addon measurement; a parameter for the tests. */
    constructor({ sample = takeNtpSample, now = () => performance.now(), wall = () => Date.now(), receiver = serverClock } = {}) {
        this._sample = sample;
        this._now = now;
        this._wall = wall;
        this._receiver = receiver;
        this.ntpOffered = false;
        this.hostSynced = false;
        this.clock = newClock();
        this.ntpFailed = false;
        this._wanted = false;
        this._timer = null;
        this._seq = 0;
        this._burst = 0;
        this._wallMinusPerf = null;
    }

    /** What this receiver offers: the addon or not, and whether its clock says it is synchronised. */
    configure({ ntp = false, hostSynced = false } = {}) {
        const was = this.ntpOffered;
        this.ntpOffered = !!ntp;
        this.hostSynced = !!hostSynced;
        if (this.ntpOffered !== was) this._reschedule();
    }

    /** Whether a Clock needs the addon measured at all. */
    want(on) {
        if (!!on === this._wanted) return;
        this._wanted = !!on;
        this._reschedule();
    }

    _reschedule() {
        clearTimeout(this._timer);
        this._timer = null;
        if (!this._wanted || !this.ntpOffered) return;
        this._burst = WINDOW - 1;
        this._schedule(0);
    }

    _schedule(ms) {
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._run(), ms);
    }

    async _run() {
        this._timer = null;
        if (!this._wanted || !this.ntpOffered) return;
        // The monotonic clock against the wall: the two coming apart means the
        // machine slept, and every sample before it describes a clock gone.
        const wmp = this._wall() - this._now();
        if (clockAsleep(wmp, this._wallMinusPerf)) {
            this.clock = newClock();
            this._burst = WINDOW - 1;
        }
        this._wallMinusPerf = wmp;
        try {
            const { sample } = await this._sample(++this._seq);
            if (sample) this.clock = addSample(this.clock, sample);
            this.ntpFailed = false;
        } catch (err) {
            // One failure is a dropped request; several, and the addon is not
            // answering — said on the card, and the next clock used meanwhile.
            if (!this.clock.list.length) this.ntpFailed = true;
        }
        if (!this._wanted || !this.ntpOffered) return;
        if (this._burst > 0) { this._burst--; this._schedule(BURST_GAP_MS); } else this._schedule(POLL_MS);
    }

    /** The addon's time as `{ theta, err }` (performance.now() + theta = UTC ms), or null. */
    ntp(perf = this._now()) {
        if (!this.ntpOffered) return null;
        const est = bestEstimate(this.clock, perf);
        return est ? { theta: est.theta, err: est.err } : null;
    }

    /**
     * Everything a packet's Clock blocks might want, for a packet `packetMs`
     * long that ends now and whose first sample was captured at `captureMs`
     * (radiod host clock), or null.
     *
     * `now` is each clock's reading at the packet's start — for a Clock that
     * follows the page; `capture` and `hostToUtc` are for one that follows the
     * signal: the stamp, and how far the receiver's clock is from the addon's
     * where both are measured.
     */
    packetTime(packetMs, captureMs = null) {
        const perf = this._now() - packetMs;
        const ntp = this.ntp(perf);
        const rx = this._receiver ? this._receiver(perf) : null;
        const hostToUtc = ntp && rx ? { off: ntp.theta - rx.theta, err: ntp.err + rx.err } : null;
        return {
            ntp: ntp ? { t0: perf + ntp.theta, err: ntp.err } : null,
            receiver: rx ? { t0: perf + rx.theta, err: rx.err } : null,
            device: { t0: this._wall() - packetMs, err: null },
            capture: Number.isFinite(captureMs) && captureMs > 0 ? captureMs : null,
            hostToUtc,
            hostSynced: this.hostSynced,
            ntpOffered: this.ntpOffered,
            ntpFailed: this.ntpFailed,
        };
    }

    stop() {
        this._wanted = false;
        clearTimeout(this._timer);
        this._timer = null;
    }
}
