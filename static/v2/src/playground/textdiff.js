// What a decoder got wrong: the text that was sent against the text that came
// out, character by character.
//
// The two are lined up by edit distance — the fewest substitutions, extra
// characters and missing characters that turn one into the other — with two
// allowances for how a decoder is actually watched. It runs behind the
// transmitter, so sent text it has not reached yet is still to come rather
// than missing; and it prints noise before a signal starts and after one
// stops, which is shown but is not the message's errors.

// The most of each side lined up at once. The sent side runs ahead, so it
// keeps more. Lining up is (SENT_WINDOW × RECEIVED_WINDOW) work.
export const SENT_WINDOW = 1200;
export const RECEIVED_WINDOW = 800;
// Correct characters in a row that say the message has begun.
const RUN = 3;

/** Text as compared: runs of spacing as one space, and capitals, as asked. */
export function normaliseText(text, { ignoreSpacing = true, ignoreCase = true } = {}) {
    let t = String(text).replace(/\r/g, '');
    if (ignoreSpacing) t = t.replace(/\s+/g, ' ');
    if (ignoreCase) t = t.toUpperCase();
    return t;
}

/**
 * Lines up `received` against `sent`. Returns `{ segments, errors, compared,
 * cer, pending }`:
 *
 *   segments  [{ kind, text, sent? }] in reading order, kind one of
 *             'same'     received as sent
 *             'wrong'    received in place of `sent`
 *             'extra'    received where nothing was sent
 *             'missing'  sent, and not received (`text` is what was sent)
 *             'noise'    received before the message began, or after it ended
 *   errors    wrong + extra + missing characters
 *   compared  how many sent characters the received text covers
 *   cer       errors / compared — the character error rate — or null
 *   pending   sent characters not reached yet
 *
 * Both are compared as given: normaliseText() them first. With `freeSpace`, a
 * space missing or extra costs nothing and is not an error — decoders differ
 * honestly about gaps (CW's word spacing is a judgement; RTTY prints nothing
 * while it idles between repeats), and the letters are what was sent.
 */
export function alignText(sent, received, { freeSpace = false } = {}) {
    const a = sent.slice(-SENT_WINDOW);
    const b = received.slice(-RECEIVED_WINDOW);
    const n = a.length;
    const m = b.length;
    const w = m + 1;
    // Costs fit 16 bits: none can exceed n + m.
    const D = new Uint16Array((n + 1) * w);
    // The sent side may start anywhere — its window reaches further back —
    // so skipping its beginning is free. Received characters before the
    // first sent one each cost one.
    const SPACE = 32;
    const gapCost = (code) => (freeSpace && code === SPACE ? 0 : 1);
    for (let j = 1; j <= m; j++) D[j] = D[j - 1] + gapCost(b.charCodeAt(j - 1));
    for (let i = 1; i <= n; i++) {
        const row = i * w;
        const up = row - w;
        D[row] = 0;
        const ca = a.charCodeAt(i - 1);
        const delCost = gapCost(ca);
        for (let j = 1; j <= m; j++) {
            const cb = b.charCodeAt(j - 1);
            const diag = D[up + j - 1] + (ca === cb ? 0 : 1);
            const del = D[up + j] + delCost;
            const ins = D[row + j - 1] + gapCost(cb);
            D[row + j] = diag < del ? (diag < ins ? diag : ins) : (del < ins ? del : ins);
        }
    }
    // The received text ends wherever in the sent it has got to: what is
    // after that is still to come. Ties go to the earliest, so trailing
    // noise is not taken for text not yet sent.
    let end = 0;
    for (let i = 1; i <= n; i++) if (D[i * w + m] < D[end * w + m]) end = i;

    // Back from there, preferring a match, then a substitution. Each step is
    // [kind, received or sent character, the sent one it was wrong for,
    // whether it used up a sent character].
    const ops = [];
    let i = end;
    let j = m;
    while (j > 0) {
        if (i === 0) {
            ops.push(['extra', b[j - 1], null, false]);
            j--;
            continue;
        }
        const here = D[i * w + j];
        const cb = b.charCodeAt(j - 1);
        const same = a.charCodeAt(i - 1) === cb;
        if (here === D[(i - 1) * w + j - 1] + (same ? 0 : 1)) {
            ops.push(same ? ['same', b[j - 1], null, true] : ['wrong', b[j - 1], a[i - 1], true]);
            i--;
            j--;
        } else if (here === D[i * w + j - 1] + gapCost(cb)) {
            // A free space is printed as it came, and is no error.
            ops.push([gapCost(cb) ? 'extra' : 'same', b[j - 1], null, false]);
            j--;
        } else {
            // A free one missing is simply not shown.
            ops.push([gapCost(a.charCodeAt(i - 1)) ? 'missing' : 'skip', a[i - 1], null, true]);
            i--;
        }
    }
    ops.reverse();
    const start = i;

    // Before the message is first received right is noise; so is anything
    // extra after it last is, once the whole of it has been. Right means a run of RUN: noise
    // hits a character by chance often enough, three in a row rarely.
    const run = Math.min(RUN, n, m);
    // Matched against something sent: a free extra space is no evidence.
    const runAt = (k) => {
        for (let r = 0; r < run; r++) if (!ops[k + r] || ops[k + r][0] !== 'same' || !ops[k + r][3]) return false;
        return true;
    };
    let first = -1;
    for (let k = 0; k < ops.length && first < 0; k++) if (runAt(k)) first = k;
    let last = -1;
    for (let k = ops.length - run; k >= 0 && last < 0; k--) if (runAt(k)) last = k + run - 1;
    const segments = [];
    let errors = 0;
    ops.forEach((o, k) => {
        let kind = o[0];
        if (kind === 'skip') return;
        if (first < 0 || k < first) kind = kind === 'missing' ? null : 'noise';
        else if (k > last && end === n && kind === 'extra') kind = 'noise';
        if (!kind) return;
        if (kind === 'wrong' || kind === 'extra' || kind === 'missing') errors++;
        const prev = segments[segments.length - 1];
        // Runs of one kind as one segment; a wrong character keeps its own,
        // to say what it should have been.
        if (prev && prev.kind === kind && kind !== 'wrong') prev.text += o[1];
        else segments.push(kind === 'wrong' ? { kind, text: o[1], sent: o[2] } : { kind, text: o[1] });
    });
    // From the first sent character the received text reached, to where it
    // has got to.
    let reached = start;
    if (first >= 0) {
        let at = start;
        for (let k = 0; k < first; k++) if (ops[k][3]) at++;
        reached = at;
    }
    const compared = first >= 0 ? end - reached : 0;
    return {
        segments,
        errors,
        compared,
        cer: compared > 0 ? errors / compared : null,
        pending: n - end,
    };
}
