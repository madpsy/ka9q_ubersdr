// Pictures: the Image viewer, and (alongside it) the decoders that make
// pictures — SSTV and weather fax — as blocks.
//
// The viewer's pictures are kept on the page, not here: image events are
// handed on every packet (drainEvents, which workerCore calls for each Image
// viewer and posts with the packet's results) rather than through the
// readings, which are only taken while the window is open — so a picture
// keeps building while nobody is watching. See image/gallery.js.

import { MESSAGE, REAL } from '../block.js';
import { HELL_MODES, HellDecoder } from '../image/hell.js';

// Most image events held between packets: far more than a packet carries.
const MAX_PENDING = 20000;

export const ImageViewerBlock = {
    type: 'image-viewer',
    label: 'Image viewer',
    category: 'Viewers',
    summary: 'Pictures as they arrive — SSTV, weather fax — line by line, the last few kept, each savable as a PNG.',
    inputs: [{ name: 'in', kind: MESSAGE }],
    outputs: [],
    params: {
        keep: { kind: 'number', label: 'Pictures kept', default: 6, min: 1, max: 24, step: 1, control: false },
    },
    create() {
        let pending = [];
        let lines = 0;
        return {
            configure() {},
            reset() { pending = []; },
            read() { return { lines }; },
            /** The image events since the last call, for the page. */
            drainEvents() {
                const out = pending;
                pending = [];
                return out;
            },
            process(ins) {
                const input = ins[0];
                if (!input || !input.list) return 0;
                for (const m of input.list) {
                    if (!m || m.type !== 'image') continue;
                    if (m.event === 'line') lines++;
                    if (pending.length < MAX_PENDING) pending.push(m);
                }
                return 0;
            },
        };
    },
};

/**
 * A decoder of pictures as a block: audio in, image events (and its words for
 * a console) out. `make(params, rate)` builds the decoder; it is rebuilt only
 * when a setting it was built from changes.
 */
export function pictureBlock(make, keyOf) {
    return () => {
        let dec = null;
        let key = '';
        let why = '';
        return {
            configure(p, r) {
                const k = `${keyOf(p)}/${r}`;
                if (k === key) return;
                key = k;
                why = '';
                try { dec = make(p, r); } catch (err) { dec = null; why = (err && err.message) || String(err); }
            },
            reset() { key = ''; },
            read() { return dec ? { ...dec.status(), why } : { state: 'off', why }; },
            activity() { return dec && dec.status().state === 'receiving' ? 1 : 0; },
            process(ins, outs, n) {
                const x = ins[0];
                if (!dec || !x || !x.re) return 0;
                dec.process(x.re, x.n != null ? x.n : n);
                for (const e of dec.drain()) {
                    if (e.type === 'image') { if (outs[0] && outs[0].list) outs[0].list.push(e); }
                    else if (e.type === 'text' && outs[1] && outs[1].list) outs[1].list.push(e);
                }
                return 0;
            },
        };
    };
}

const PICTURE_OUT = [{ name: 'images', kind: MESSAGE }, { name: 'text', kind: MESSAGE }];

export const HellBlock = {
    type: 'hell',
    label: 'Hellschreiber',
    category: 'Radio',
    summary: 'Feld Hell drawn as it arrives — text as pictures of its letters, read by eye, legible through fading and drift. Wire its images to an Image viewer.',
    inputs: [{ name: 'audio', kind: REAL }],
    outputs: PICTURE_OUT,
    activity: 'Drawing',
    params: {
        mode: { kind: 'choice', label: 'Mode', default: 'feld', options: Object.entries(HELL_MODES).map(([value, m]) => ({ value, label: m.label })) },
        toneHz: { kind: 'number', label: 'Tone', unit: 'Hz', default: 1000, min: 100, max: 5000, step: 1, control: false },
        width: { kind: 'number', label: 'Strip length', unit: 'columns', default: 360, min: 40, max: 4000, step: 10, control: false },
        invert: { kind: 'bool', label: 'Invert', default: false, control: false },
    },
    create: pictureBlock(
        (p, r) => new HellDecoder({ sampleRate: r, toneHz: p.toneHz, mode: p.mode, width: p.width, invert: p.invert }),
        (p) => `${p.mode}/${p.toneHz}/${p.width}/${p.invert}`,
    ),
};
