// What a playground block is.
//
// The playground lets an operator wire the receiver's IQ stream through blocks
// of their own choosing — GNU Radio's model, in the browser. The arithmetic in
// those blocks is not new: every one of them wraps a primitive in lib/dsp/,
// which is the same code the IQ Demod panel's demodulators are built from (see
// DemodChain in lib/iqDemod.js). A block adds only what a graph needs on top of
// a primitive: named, typed ports, declared parameters, and a rule for the rate
// it puts out.
//
// ── A block type ─────────────────────────────────────────────────────────────
//
//   {
//     type:     'lowpass',            stable id, stored in saved and shared
//                                     graphs — never rename one
//     label, category, summary        for the palette
//     inputs:   [{ name, kind, optional?, audio? }]  `audio: false` marks a
//                                     real port that is not sound — a key
//                                     level, a power — so it is never watched
//                                     for clipping
//     outputs:  [{ name, kind }]
//     params:   { name: ParamSpec }
//     rate(inRate, params)            the rate it puts out; same as in if absent
//     maxOut(n, params, inRate)       most frames it can put out for n in; n if
//                                     absent
//     upgrade(stored)                 optional: stored params from an older
//                                     graph, made to mean what they meant then
//     create()                        a fresh instance
//   }
//
// `kind` is 'complex' or 'real'. A wire may only join two ports of the same
// kind, and every input of one block must arrive at the same rate.
//
// ── An instance ──────────────────────────────────────────────────────────────
//
//   configure(params, rate)   at build, and again on any parameter or rate
//                             change. `rate` is the rate arriving at its inputs
//                             (for a source, the stream's). Keeps its history
//                             where it can, so moving a slider sounds like a
//                             control moving and not like a restart — the same
//                             rule DemodChain.configure keeps.
//   process(ins, outs, n, stream)
//                             `ins` are its input buffers, aligned and n frames
//                             long, or null for an optional input left
//                             unconnected. Writes `outs` and returns how many
//                             frames it wrote; every output carries that count.
//                             `stream` is the receiver's packet, for sources.
//   reset()                   forget everything carried between blocks
//   read()                    optional: readings for the interface, such as a
//                             meter's level
//   command(name)             optional: a one-off action from the interface —
//                             a scope's 'arm', 'stop' and 'run' — as against a
//                             setting, which a saved graph would come back in
//   load(data)                optional: something to play from, handed over
//                             whole — an IQ player's file
//   framesFor(frames, rate)   optional, sources: how many frames to make for a
//                             packet of `frames` at the clock's `rate`, for a
//                             source that runs at a rate of its own
//   latency()                 optional: how late its output is, in samples at
//                             its input rate — an FIR's half-length, say. Absent
//                             means none. A type whose delay is not one number
//                             (an IIR's varies with frequency) says so in its
//                             `latencyNote`.
//
// ── Buffers ──────────────────────────────────────────────────────────────────
//
// { re, im } of Float64Array, `im` null on a real port. Doubles because the
// stages these wrap were written to keep every intermediate in a double, and
// lib/dsp's equivalence with the original rests on it — see DemodChain.

export const COMPLEX = 'complex';
export const REAL = 'real';

// ── control and message ports ────────────────────────────────────────────────
//
// Two kinds of port that carry something other than samples.
//
//   control   one number, current until it changes — a slider's position, a
//             counter's last reading. The buffer is { value, seq }: `seq` goes
//             up each time a new value is put out, so a reader can tell "a new
//             reading that happens to equal the old" from "nothing new" (an
//             integrator must add the first and not the second).
//   message   events: a list of plain objects put out during one packet, empty
//             the next unless more happen — a detector's findings, a
//             decoder's text.
//
// Neither has a rate, so neither takes part in a block's rate check or in
// lining inputs up. Control wires may close a loop — a counter steering the
// shift in front of it is a frequency lock, not a mistake — and are read as
// they stood at the start of the packet.
//
// Any number or on/off parameter can also be given a control input of its
// own: a node's `controls` lists which (see inputsOf). A spec with
// `control: false` cannot — one that changes a rate, say, which a control
// moving sixty times a second would rebuild the graph on.
export const CONTROL = 'control';
export const MESSAGE = 'message';

// ── bits ────────────────────────────────────────────────────────────────────
//
// A stream of decisions: one 0 or 1 per bit, at the bit rate, which is what a
// digital demodulator's slicer puts out and a character decoder takes in. It
// is a stream like any other — it has a rate, and two inputs of it are lined
// up — kept as its own kind so a bit stream cannot be wired into a filter, nor
// audio into a Varicode decoder. Held in `re`, as 0 and 1.
export const BITS = 'bits';

/** Whether a kind carries samples (or bits), as against control values or messages. */
export const isStream = (kind) => kind === COMPLEX || kind === REAL || kind === BITS;

/** Whether a parameter can be driven by a control input. */
export function controllable(spec) {
    return !!spec && (spec.kind === 'number' || spec.kind === 'bool') && spec.control !== false;
}

/** The port name of a parameter's control input. */
export const controlPort = (param) => `set:${param}`;

/**
 * A node's inputs: its type's, and a control input for each parameter it has
 * exposed. Exposed ones are optional and carry the parameter's name.
 */
export function inputsOf(node, def) {
    if (!def) return [];
    const extra = [];
    for (const name of node.controls || []) {
        const spec = def.params[name];
        if (!controllable(spec)) continue;
        extra.push({ name: controlPort(name), kind: CONTROL, optional: true, param: name, label: spec.label });
    }
    return extra.length ? [...def.inputs, ...extra] : def.inputs;
}

/** A node's outputs: its type's. Here for symmetry with inputsOf. */
export function outputsOf(node, def) {
    return def ? def.outputs : [];
}

/** A buffer for a port of `kind`, holding at least `size` frames. */
export function makeBuffer(kind, size) {
    if (kind === CONTROL) return { kind, value: null, seq: 0, n: 0 };
    if (kind === MESSAGE) return { kind, list: [], n: 0 };
    return {
        re: new Float64Array(size),
        im: kind === COMPLEX ? new Float64Array(size) : null,
        n: 0,
    };
}

/** Put a new value on a control output. */
export function emitControl(buf, value) {
    buf.value = value;
    buf.seq++;
}

/** Grow `buf` in place to hold at least `size` frames. Contents are not kept. */
export function ensureBuffer(buf, size) {
    if (!buf.re) return buf;
    if (buf.re.length >= size) return buf;
    buf.re = new Float64Array(size);
    if (buf.im) buf.im = new Float64Array(size);
    return buf;
}

// ── parameters ───────────────────────────────────────────────────────────────
//
// A ParamSpec:
//
//   { kind: 'number', label, unit?, default, min, max, step?, live? }
//   { kind: 'bool',   label, default }
//   { kind: 'choice', label, default, options: [{ value, label }] }
//   { kind: 'device', label, default: '' }
//   { kind: 'text',   label, default, max? }
//
// A device is an audio output, by the id the browser gives it, '' meaning the
// receiver's own output. It is a string the browser invented for this machine,
// so it means nothing anywhere else: a shared graph is shared without them
// (see share.js), and one that names a device this browser cannot find plays
// on the receiver's output instead.
//
// `live` marks a number that costs nothing to change — a frequency, a gain —
// as against one that redesigns a filter. The editor can drag a live one on
// every frame and should commit the other on release.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** One parameter's value as the block will accept it, or its default. */
export function sanitizeParam(spec, value) {
    switch (spec.kind) {
        case 'bool':
            return typeof value === 'boolean' ? value : spec.default;
        case 'choice':
            return spec.options.some((o) => o.value === value) ? value : spec.default;
        case 'device':
            return typeof value === 'string' ? value.slice(0, 512) : spec.default;
        case 'text':
            return typeof value === 'string' ? value.slice(0, spec.max || 200) : spec.default;
        default: {
            const v = Number(value);
            if (value === null || value === undefined || value === '' || !Number.isFinite(v)) return spec.default;
            return clamp(v, spec.min, spec.max);
        }
    }
}

/** Every parameter of `type`, from what was stored, with defaults filling gaps. */
export function sanitizeParams(type, raw) {
    const stored = raw && typeof raw === 'object' ? raw : {};
    const src = type.upgrade ? type.upgrade(stored) : stored;
    const out = {};
    for (const [name, spec] of Object.entries(type.params || {})) {
        out[name] = sanitizeParam(spec, src[name]);
    }
    return out;
}

/** Copy `n` frames of `from` into `to`, both of the same kind. */
export function copyInto(from, to, n) {
    to.re.set(from.re.subarray(0, n));
    if (to.im && from.im) to.im.set(from.im.subarray(0, n));
}
