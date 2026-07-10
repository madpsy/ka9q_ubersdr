/**
 * QRSS Grabber - Down-converting capture AudioWorklet
 *
 * Runs on the audio rendering thread and taps the post-demod mono audio. It
 * digitally down-converts a chosen centre frequency to baseband (complex mix),
 * low-pass filters, and decimates — a standard "zoom FFT" front end. The result
 * is a stream of complex (I/Q) samples at a low rate, representing a narrow band
 * [centre − decSR/2 … centre + decSR/2] of the audio, which the main thread
 * turns into the waterfall via a complex FFT.
 *
 * This lets the display zoom onto a signal anywhere in the passband (e.g. the
 * QRSS window around 1.4 kHz), not just the low end.
 *
 * processorOptions:
 *   fc     {number}       centre (audio) frequency to translate to 0 Hz
 *   inSR   {number}       input sample rate (Hz)
 *   decim  {number}       integer decimation factor D (outputRate = inSR / D)
 *   coeffs {Float32Array} anti-alias FIR taps (cutoff ≈ decSR/2), sum-normalised
 *   batch  {number}       complex samples to accumulate before posting
 */
class QrssDDCProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this._fc = o.fc || 0;
        this._inSR = o.inSR || sampleRate || 48000;
        this._decim = Math.max(1, o.decim | 0);
        this._coeffs = o.coeffs || new Float32Array([1]);
        this._nt = this._coeffs.length;
        this._batch = Math.max(1, o.batch | 0) || 512;

        // Complex FIR history (circular) for I and Q
        this._hI = new Float32Array(this._nt);
        this._hQ = new Float32Array(this._nt);
        this._hp = 0;
        this._phase = 0;                       // NCO phase (radians)
        this._dphase = 2 * Math.PI * this._fc / this._inSR;
        this._decPhase = 0;

        // Output batch (interleaved I,Q)
        this._out = new Float32Array(this._batch * 2);
        this._outPos = 0;

        this._running = false;
        this.port.onmessage = (e) => {
            if (e.data && e.data.command === 'start') this._running = true;
            else if (e.data && e.data.command === 'stop') this._running = false;
        };
    }

    _filter(hist) {
        const c = this._coeffs, n = this._nt;
        let acc = 0, idx = this._hp;
        for (let k = 0; k < n; k++) { acc += c[k] * hist[idx]; idx = idx === 0 ? n - 1 : idx - 1; }
        return acc;
    }

    process(inputs) {
        if (!this._running) return true;
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const ch = input[0];
        if (!ch) return true;

        const n = this._nt;
        for (let i = 0; i < ch.length; i++) {
            const x = ch[i];
            // Mix down by fc: multiply real input by e^{-j·phase}
            const cosP = Math.cos(this._phase), sinP = Math.sin(this._phase);
            this._phase += this._dphase;
            if (this._phase > Math.PI) this._phase -= 2 * Math.PI;      // keep bounded
            else if (this._phase < -Math.PI) this._phase += 2 * Math.PI;

            this._hp = this._hp === n - 1 ? 0 : this._hp + 1;
            this._hI[this._hp] = x * cosP;
            this._hQ[this._hp] = -x * sinP;

            if (++this._decPhase >= this._decim) {
                this._decPhase = 0;
                this._out[this._outPos++] = this._filter(this._hI);
                this._out[this._outPos++] = this._filter(this._hQ);
                if (this._outPos >= this._out.length) {
                    const copy = this._out.slice(0, this._outPos);
                    this.port.postMessage({ iq: copy }, [copy.buffer]);
                    this._out = new Float32Array(this._batch * 2);
                    this._outPos = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('qrss-ddc-processor', QrssDDCProcessor);
