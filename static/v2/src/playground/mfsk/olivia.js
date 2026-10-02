// Olivia and Contestia: the Walsh–Hadamard code and the receiver's search for
// where the code blocks are — Pawel Jalocha's MFSK_SoftDecoder and
// MFSK_Receiver::ProcessSymbol (fldigi src/include/jalocha/pj_mfsk.h), kept in
// the shape the reference has them, because every step is part of the code.
//
// ── The code ────────────────────────────────────────────────────────────────
//
// Olivia sends log2(tones) characters at a time — one per bit of the symbol —
// over a block of 64 symbols (Contestia: 32). Each character, 7 bits (6),
// becomes 64 (32) ±1 chips: a row of a Hadamard matrix, negated for the top
// half of the alphabet. The chips are scrambled against a fixed sequence that
// starts further along for each character (13 places for Olivia, 5 for
// Contestia), and laid diagonally: character i's chip t goes in bit
// (i + t) mod bits of symbol t. Each symbol's bits are Gray-coded to a tone.
//
// Receiving it backwards: each tone's energy says how likely each bit of the
// symbol is a 1 (MFSK_Demodulator::SoftDecode), the diagonal and the
// scrambling come off, and a forward Hadamard transform turns 64 soft chips
// into 64 scores, one per row — the largest in size is the character, its
// sign the half of the alphabet. How far it stands above the rest is how sure.
//
// ── Why one stage ───────────────────────────────────────────────────────────
//
// Olivia has no preamble and no sync. The receiver runs a decoder for every
// frequency offset it is allowed to search (±margin, in half-tone steps) and
// both half-symbol timings, each decoding a whole block afresh on every
// symbol, and integrates each one's signal-to-noise over a few blocks; then
// it prints the block the best of them decoded, from the best of the 128
// (Contestia: 64) block phases. So the soft demapping, the Hadamard decode
// and the search are one loop: a demapper in front of it would have to hand
// on every offset's bits, which is the spectrum it was given. That is why the
// detector before this hands on the tone energies, and this is the stage
// that does everything with them.

const FHT_SHIFT_OLIVIA = 13;
const FHT_SHIFT_CONTESTIA = 5;

/**
 * The scrambling sequence, as ±1: bit i of the reference's 64-bit constant
 * (ScramblingCodeOlivia, ScramblingCodeContestia), given as its two halves.
 */
function scrambleSigns(hi, lo) {
    const out = new Int8Array(64);
    for (let i = 0; i < 64; i++) out[i] = ((i < 32 ? lo >>> i : hi >>> (i - 32)) & 1) ? -1 : 1;
    return out;
}
const SCRAMBLE_OLIVIA = scrambleSigns(0xE257E6D0, 0x291574EC);
const SCRAMBLE_CONTESTIA = scrambleSigns(0, 0xEDB88320);

/**
 * pj_fht.h FHT: the forward Hadamard transform in place. Note b + a and b − a,
 * not a + b and a − b: either is a Hadamard transform, but they order the
 * rows differently, and the code is in the order.
 */
export function walshHadamard(data, len) {
    for (let step = 1; step < len; step *= 2) {
        for (let ptr = 0; ptr < len; ptr += 2 * step) {
            for (let p = ptr; p - ptr < step; p++) {
                const a = data[p];
                const b = data[p + step];
                data[p] = b + a;
                data[p + step] = b - a;
            }
        }
    }
}

/** pj_gray.h BinaryCode: from a Gray code back to the number. */
export function binaryCode(gray) {
    let g = gray;
    g ^= g >> 16;
    g ^= g >> 8;
    g ^= g >> 4;
    g ^= g >> 2;
    g ^= g >> 1;
    return g;
}

/** pj_lowpass3.h LowPass3_Filter, as parallel arrays: three first-order stages with feedback. */
class LowPass3 {
    constructor(n) {
        this.o1 = new Float64Array(n);
        this.o2 = new Float64Array(n);
        this.out = new Float64Array(n);
    }

    clear() { this.o1.fill(0); this.o2.fill(0); this.out.fill(0); }

    run(i, x, weight, feedback = 0.1) {
        const w = 2 * weight;
        const d1 = (x - this.o1[i]) * w;
        const d12 = (this.o1[i] - this.o2[i]) * w;
        const d23 = (this.o2[i] - this.out[i]) * w;
        this.o1[i] += d1;
        this.o2[i] += d12;
        this.out[i] += d23;
        this.o2[i] += d23 * feedback;
        return this.out[i];
    }
}

/** MFSK_SoftDecoder: one candidate's sliding block of soft bits, decoded whole on every symbol. */
class SoftBlockDecoder {
    constructor(bits, perBlock, contestia) {
        this.bits = bits;
        this.perBlock = perBlock;
        this.contestia = contestia;
        this.shift = contestia ? FHT_SHIFT_CONTESTIA : FHT_SHIFT_OLIVIA;
        this.scramble = contestia ? SCRAMBLE_CONTESTIA : SCRAMBLE_OLIVIA;
        this.input = new Float64Array(perBlock * bits);
        this.fht = new Float64Array(perBlock);
        this.chars = new Uint8Array(bits);
        this.ptr = 0;
        this.signal = 0;
        this.noise = 0;
    }

    reset() { this.input.fill(0); this.ptr = 0; }

    /** MFSK_SoftDecoder::Input — one symbol's soft bits. */
    push(symbol) {
        for (let b = 0; b < this.bits; b++) this.input[this.ptr++] = symbol[b];
        if (this.ptr >= this.input.length) this.ptr -= this.input.length;
    }

    /** MFSK_SoftDecoder::DecodeCharacter. */
    _character(freqBit) {
        const { bits, perBlock, input, fht, scramble } = this;
        const len = input.length;
        const wrap = perBlock - 1;
        let ptr = this.ptr;
        let rotate = freqBit;
        let codeBit = (freqBit * this.shift) & wrap;
        for (let t = 0; t < perBlock; t++) {
            fht[t] = input[ptr + rotate] * scramble[codeBit];
            codeBit = (codeBit + 1) & wrap;
            if (++rotate >= bits) rotate -= bits;
            ptr += bits;
            if (ptr >= len) ptr -= len;
        }
        walshHadamard(fht, perBlock);
        let peak = 0;
        let pos = 0;
        let sq = 0;
        for (let t = 0; t < perBlock; t++) {
            const s = fht[t];
            sq += s * s;
            if (Math.abs(s) > Math.abs(peak)) { peak = s; pos = t; }
        }
        let c = pos + (peak < 0 ? perBlock : 0);
        sq -= peak * peak;
        if (this.contestia && c > 0) {
            if (c === 59) c = 32;
            else if (c === 60) c = 13;
            else if (c === 61) c = 8;
            else c += 32;
        }
        this.chars[freqBit] = c;
        this.noise += sq / (perBlock - 1);
        this.signal += Math.abs(peak);
    }

    /** MFSK_SoftDecoder::Process. */
    decode() {
        this.signal = 0;
        this.noise = 0;
        for (let b = 0; b < this.bits; b++) this._character(b);
        this.signal /= this.bits;
        this.noise /= this.bits;
    }
}

/**
 * MFSK_Receiver's search and decision (ProcessSymbol), fed frames of tone
 * energies two to a symbol: `tones`, `margin` (the search either side, in
 * half-tone steps — fldigi's SyncMargin), `contestia`, `integration` (blocks
 * the search integrates over, SyncIntegLen) and `threshold` (the S/N a block
 * needs to be printed, SyncThreshold). A frame is 2 × tones − 1 + 2 × margin
 * energies, tone k of offset o at o + 2k.
 */
export class OliviaReceiver {
    constructor({ tones, margin, contestia, integration, threshold }) {
        this.bits = Math.round(Math.log2(tones));
        this.tones = 1 << this.bits;
        this.margin = margin;
        this.contestia = !!contestia;
        this.integration = integration;
        this.threshold = threshold;
        this.perBlock = this.contestia ? 32 : 64;
        this.offsets = 2 * margin + 1;
        this.phases = 2 * this.perBlock;
        this.width = 2 * this.tones - 1 + 2 * margin;
        this.decoders = [0, 1].map(() => Array.from({ length: this.offsets }, () => new SoftBlockDecoder(this.bits, this.perBlock, this.contestia)));
        // DecodePipe: for each block phase, the last `integration` blocks
        // every offset decoded, oldest next to be overwritten.
        this.pipe = Array.from({ length: this.phases }, () => ({
            rows: Array.from({ length: integration }, () => Array.from({ length: this.offsets }, () => new Uint8Array(this.bits))),
            ptr: 0,
        }));
        this.syncSignal = new LowPass3(this.phases * this.offsets);
        this.syncNoise = new LowPass3(this.phases * this.offsets);
        this.symbol = new Float64Array(this.bits);
        this.reset();
    }

    reset() {
        for (const row of this.decoders) for (const d of row) d.reset();
        for (const p of this.pipe) { p.ptr = 0; for (const r of p.rows) for (const c of r) c.fill(0); }
        this.syncSignal.clear();
        this.syncNoise.clear();
        this.phase = 0;
        this.slice = 0;
        this.bestSignal = 0;
        this.bestPhase = 0;
        this.bestOffset = 0;
        this.snr = 0;
    }

    /** MFSK_Demodulator::SoftDecode: the energies of one offset's tones to soft bits. */
    _soft(energy, at, offset) {
        const { bits, tones, symbol } = this;
        symbol.fill(0);
        let total = 0;
        for (let i = 0; i < tones; i++) {
            const idx = binaryCode(i);
            let e = energy[at + offset + 2 * i];
            e *= e;
            total += e;
            for (let b = 0, mask = 1; b < bits; b++, mask <<= 1) {
                if (idx & mask) symbol[b] -= e; else symbol[b] += e;
            }
        }
        if (total > 0) for (let b = 0; b < bits; b++) symbol[b] /= total;
        return symbol;
    }

    /**
     * One frame (a half symbol) of energies from `energy[at]`. Returns the
     * characters of a block when one is ready and passes the threshold,
     * else null.
     */
    frame(energy, at = 0) {
        const { offsets, phase } = this;
        const weight = 1 / this.integration;
        const row = this.pipe[phase];
        const store = row.rows[row.ptr];
        let bestSliceSignal = 0;
        let bestSliceOffset = 0;
        for (let o = 0; o < offsets; o++) {
            const d = this.decoders[this.slice][o];
            d.push(this._soft(energy, at, o));
            d.decode();
            store[o].set(d.chars);
            const k = phase * offsets + o;
            this.syncNoise.run(k, d.noise, weight);
            const s = this.syncSignal.run(k, d.signal, weight);
            if (s > bestSliceSignal) { bestSliceSignal = s; bestSliceOffset = o; }
        }
        row.ptr = (row.ptr + 1) % this.integration;

        if (phase === this.bestPhase) {
            this.bestSignal = bestSliceSignal;
            this.bestOffset = bestSliceOffset;
        } else if (bestSliceSignal > this.bestSignal) {
            this.bestSignal = bestSliceSignal;
            this.bestPhase = phase;
            this.bestOffset = bestSliceOffset;
        }

        let out = null;
        let dist = phase - this.bestPhase;
        if (dist < 0) dist += this.phases;
        if (dist === this.phases >> 1) {
            // The noise of the winning candidate. (The reference reads its
            // pointer after the loop has walked it past the row — a filter
            // of the next phase, or past the end — which is not what it
            // means; all of them integrate the same noise, near enough.)
            const noise = Math.sqrt(this.syncNoise.out[this.bestPhase * offsets + this.bestOffset]);
            this.snr = noise === 0 ? 0 : this.bestSignal / noise;
            if (this.snr >= this.threshold) {
                const best = this.pipe[this.bestPhase];
                out = Array.from(best.rows[best.ptr][this.bestOffset]);
            }
            if (this.snr > 100) this.snr = 0;
        }

        this.slice ^= 1;
        if (++this.phase >= this.phases) this.phase = 0;
        return out;
    }

    /** How far off the signal is, in half-tone steps (FrequencyOffset, before scaling). */
    get offsetSteps() { return this.bestOffset - this.margin; }
}
