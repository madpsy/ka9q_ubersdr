// Where each listening VFO sits in the stereo field.
//
// With several VFOs playing at once the ear needs them apart, and the cheapest
// way to keep them apart is space: lowest frequency on the left, highest on the
// right, the rest evenly between. Two VFOs are hard left and hard right, three
// add one in the middle, four sit at -1, -1/3, +1/3 and +1. The main receiver
// takes part like any other — it is one of the voices being placed.
//
// An operator can pin a VFO instead ('left', 'right', 'both'). A pinned one
// keeps its side whatever the frequencies do, and takes a position out of the
// spread so the Auto ones are placed in what is left: with one pinned left and
// two on Auto among three positions, the two Auto ones get the middle and the
// right. 'both' is the middle of the field and takes no position — it is not
// a side — so the spread is over the VFOs that have one.
//
// The order is sticky. Two VFOs a few hertz apart, one of them being tuned
// across the other, would otherwise swap ears on every step of the drag; they
// trade places only once one is clearly past the other (HYSTERESIS_HZ). That is
// why the previous assignment is an input.
//
// Pure: no audio, no store. radio/subReceivers.js feeds it and applies the
// result.

/** How far past another a VFO must be before the two trade sides. */
export const HYSTERESIS_HZ = 100;

const PIN_PAN = { left: -1, right: 1, both: 0 };

/** n positions spread evenly across -1..+1; one is the middle. */
export function panPositions(n) {
    if (n <= 0) return [];
    if (n === 1) return [0];
    const out = [];
    for (let i = 0; i < n; i++) out.push(-1 + (2 * i) / (n - 1));
    return out;
}

/**
 * Pans for a set of listening VFOs.
 *
 * @param {Array<{id: string, frequency: number, out?: string}>} vfos
 *        every VFO being heard, main included. `out` is 'auto' (or absent),
 *        'left', 'right' or 'both'.
 * @param {{order?: string[]}|null} [prev]  the last result, for the hysteresis.
 * @returns {{pans: Object<string, number>, order: string[]}}
 *        `order` is the Auto VFOs low to high as placed — hand it back next
 *        time.
 */
export function vfoPans(vfos, prev = null) {
    const list = (vfos || []).filter((v) => v && v.id != null);
    const pans = {};
    const sided = list.filter((v) => v.out !== 'both');
    for (const v of list) if (v.out === 'both') pans[v.id] = 0;

    const free = panPositions(sided.length);
    // Pins take their end of what is free: a left pin the leftmost position
    // still open, a right pin the rightmost. Their own pan is the side itself.
    for (const v of sided) {
        if (v.out === 'left') { free.shift(); pans[v.id] = PIN_PAN.left; }
        else if (v.out === 'right') { free.pop(); pans[v.id] = PIN_PAN.right; }
    }

    const auto = sided.filter((v) => v.out !== 'left' && v.out !== 'right');
    const freq = new Map(auto.map((v) => [v.id, Number(v.frequency) || 0]));
    const order = stickyOrder(auto, freq, prev && prev.order);
    order.forEach((id, i) => { pans[id] = free[i] != null ? free[i] : 0; });
    return { pans, order };
}

// The Auto VFOs low to high, starting from the last order and changing it only
// where a pair is out of place by more than the hysteresis.
function stickyOrder(auto, freq, prevOrder) {
    const byFreq = (a, b) => (freq.get(a) - freq.get(b)) || (a < b ? -1 : a > b ? 1 : 0);
    const order = (prevOrder || []).filter((id) => freq.has(id));
    // Newcomers go where their frequency puts them.
    const fresh = auto.map((v) => v.id).filter((id) => !order.includes(id)).sort(byFreq);
    for (const id of fresh) {
        let at = order.findIndex((o) => freq.get(o) > freq.get(id));
        if (at < 0) at = order.length;
        order.splice(at, 0, id);
    }
    // A bubble pass, repeated until it settles: only a clear inversion swaps.
    // At most four entries, so the cost is nothing.
    let moved = true;
    while (moved) {
        moved = false;
        for (let i = 0; i + 1 < order.length; i++) {
            if (freq.get(order[i]) > freq.get(order[i + 1]) + HYSTERESIS_HZ) {
                [order[i], order[i + 1]] = [order[i + 1], order[i]];
                moved = true;
            }
        }
    }
    return order;
}
