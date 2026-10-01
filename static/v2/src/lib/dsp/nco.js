// A numerically controlled oscillator, and multiplying a signal by it.
//
// Multiplying a complex signal by e^(+j2*pi*f*t) moves everything in it up by
// f; a negative f moves it down. That one operation is two jobs in a
// demodulator: sliding the wanted piece of spectrum down to zero before the
// filter, and translating what the filter passed to audio after it — where only
// the real part is wanted, which is mixReal.

/**
 * The oscillator's state is its phase, carried between blocks so a block
 * boundary is not a phase step, and wrapped once a block rather than per
 * sample: unbounded phase loses precision after an hour or two of listening,
 * and Math.cos of a number that large is no longer the cosine of the angle
 * meant.
 */
export class Nco {
    constructor({ frequencyHz = 0 } = {}) {
        this.frequencyHz = frequencyHz;
        this.phase = 0;
    }

    reset() {
        this.phase = 0;
    }

    _step(rate) {
        return (2 * Math.PI * this.frequencyHz) / rate;
    }

    /** out = in * e^(j*phase), complex in and complex out. */
    mix(inI, inQ, outI, outQ, frames, rate) {
        const step = this._step(rate);
        let phase = this.phase;
        for (let k = 0; k < frames; k++) {
            const c = Math.cos(phase);
            const s = Math.sin(phase);
            phase += step;
            const i = inI[k];
            const q = inQ[k];
            outI[k] = i * c - q * s;
            outQ[k] = i * s + q * c;
        }
        this.phase = phase % (2 * Math.PI);
    }

    /** out = Re{in * e^(j*phase)}: the real part only, for audio. */
    mixReal(inI, inQ, out, frames, rate) {
        const step = this._step(rate);
        let phase = this.phase;
        for (let k = 0; k < frames; k++) {
            const c = Math.cos(phase);
            const s = Math.sin(phase);
            phase += step;
            out[k] = inI[k] * c - inQ[k] * s;
        }
        this.phase = phase % (2 * Math.PI);
    }
}
