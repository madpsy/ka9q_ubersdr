// A graph as a string short enough to put in a link, and back.
//
//   pg1.z.<base64url of deflate-raw(JSON)>     where the browser can compress
//   pg1.j.<base64url of JSON>                  where it cannot
//
// `pg1` is this encoding's version, separate from the graph format's own `v`
// inside: the wrapping and the contents can each change without the other.
//
// What goes in is serializeGraph's form — defaults left out — with every output
// device taken out as well. A device id is something this browser made up for
// this machine; on anyone else's it names nothing, and a graph that arrived
// pointing at one would play on the receiver's output anyway, so carrying it
// would only make the link longer and say something about the sender's
// hardware.
//
// Decoding is defensive throughout, because a link is anybody's input: an
// over-long code is refused before it is read, the decompressed size is capped
// so a small link cannot expand into a large allocation, and everything that
// comes out goes through parseGraph like any stored graph.

import { BLOCK_BY_TYPE } from './blocks/index.js';
import { parseGraph, serializeGraph } from './graph.js';

export const SHARE_PREFIX = 'pg1';
// Longest code accepted, and largest JSON one may expand to. A graph of a
// hundred blocks is a few kilobytes of JSON; these are an order of magnitude
// past anything real.
export const MAX_CODE_LENGTH = 32 * 1024;
export const MAX_JSON_BYTES = 256 * 1024;

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function pipe(bytes, stream, limit) {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
    const parts = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
            reader.cancel().catch(() => {});
            throw new Error('too large');
        }
        parts.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** The graph with every device parameter back at its default. */
function withoutDevices(graph) {
    return {
        ...graph,
        nodes: graph.nodes.map((n) => {
            const type = BLOCK_BY_TYPE[n.type];
            if (!type) return n;
            const params = { ...n.params };
            for (const [name, spec] of Object.entries(type.params)) {
                if (spec.kind === 'device') params[name] = spec.default;
            }
            return { ...n, params };
        }),
    };
}

/** A graph as a share code. */
export async function encodeShare(graph) {
    const json = JSON.stringify(serializeGraph(withoutDevices(graph)));
    const bytes = new TextEncoder().encode(json);
    if (canCompress()) {
        const z = await pipe(bytes, new CompressionStream('deflate-raw'), Infinity);
        return `${SHARE_PREFIX}.z.${toBase64Url(z)}`;
    }
    return `${SHARE_PREFIX}.j.${toBase64Url(bytes)}`;
}

/** A share code as `{ graph, errors }`. Never throws. */
export async function decodeShare(code) {
    const fail = (message) => ({ graph: null, errors: [{ message }] });
    if (typeof code !== 'string') return fail('Not a playground link.');
    const text = code.trim();
    if (text.length > MAX_CODE_LENGTH) return fail('That link is too long to be a playground graph.');
    const m = /^pg(\d+)\.([zj])\.([A-Za-z0-9_-]+)$/.exec(text);
    if (!m) return fail('Not a playground link.');
    if (`pg${m[1]}` !== SHARE_PREFIX) {
        return fail(Number(m[1]) > 1 ? 'This link was made by a newer version of the playground.' : 'Not a playground link.');
    }
    let bytes;
    try {
        bytes = fromBase64Url(m[3]);
        if (m[2] === 'z') {
            if (!canCompress()) return fail('This browser cannot read compressed playground links.');
            bytes = await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_JSON_BYTES);
        } else if (bytes.length > MAX_JSON_BYTES) {
            return fail('That link is too large to be a playground graph.');
        }
    } catch (err) {
        return fail(err && err.message === 'too large'
            ? 'That link is too large to be a playground graph.'
            : 'That link is damaged.');
    }
    let raw;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch (err) {
        return fail('That link is damaged.');
    }
    return parseGraph(raw);
}
