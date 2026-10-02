// fldigi's MFSK interleaver (src/mfsk/interleave.cxx), which MFSK16, MFSK32
// and THOR all use, to the element.
//
// A symbol's bits go in together, `size` of them, and come out spread over
// the next size × depth symbols: `depth` square tables, each size × size, a
// symbol's bits shifted in along one edge and read out along a diagonal — so
// a burst that wipes out a few symbols leaves the Viterbi decoder a scatter of
// single bad bits, which it mends, rather than a run, which it cannot. The
// deinterleaver reads the other diagonal, which undoes it.
//
// Elements are numbers, so the same code moves hard bits (0 and 1) going out
// and soft ones (a confidence, 0 for none) coming in. A receiver's tables
// start full of "don't know" — fldigi's PUNCTURE — so what comes out before
// the first real symbols have worked through says nothing either way.

export class Interleaver {
    /** `forward` interleaves (a transmitter's); otherwise it undoes one. */
    constructor(size, depth, forward, fill = 0) {
        this.size = size;
        this.depth = depth;
        this.forward = forward;
        this.fill = fill;
        this.table = new Float64Array(size * size * depth);
        this.flush();
    }

    /** Everything forgotten: the receiver's "don't know", or zeros. */
    flush() { this.table.fill(this.fill); }

    /** One symbol's `size` elements, rearranged in place (interleave::symbols). */
    symbols(syms) {
        const { size, depth, table } = this;
        for (let k = 0; k < depth; k++) {
            const base = size * size * k;
            for (let i = 0; i < size; i++) {
                const row = base + size * i;
                for (let j = 0; j < size - 1; j++) table[row + j] = table[row + j + 1];
                table[row + size - 1] = syms[i];
            }
            for (let i = 0; i < size; i++) {
                syms[i] = this.forward ? table[base + size * i + size - i - 1] : table[base + size * i + i];
            }
        }
        return syms;
    }
}
