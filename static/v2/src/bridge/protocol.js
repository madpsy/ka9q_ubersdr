// The v2 page API — the wire format.
//
// This is the contract between an UberSDR v2 page and anything that wants to
// drive it from outside: a browser extension, a userscript, another tab. It is
// deliberately a *message* protocol rather than a JavaScript object, because
// the primary consumer is a browser extension's content script, which runs in
// an isolated world and cannot touch the page's objects at all. `window.UberSDR`
// (see BridgeHost.jsx) is a thin local wrapper over these same messages so that
// in-page consumers do not have to talk in envelopes; both go through one core.
//
// Transport: two CustomEvents on `window`, one per direction, with the message
// as a **JSON string** in `detail`.
//
//     window.dispatchEvent(new CustomEvent('ubersdr.to-page',   { detail })) // client → page
//     window.dispatchEvent(new CustomEvent('ubersdr.from-page', { detail })) // page → client
//
// A string, not an object, and this is not fussiness: page→content `detail` is
// structured-cloned in Chrome and Xray-wrapped in Firefox, and the two differ
// in what survives. A string is identical on both, which is what lets one
// content script serve both browsers. window.postMessage is not used — it is
// forgeable by any frame and does not reliably cross MV3's world boundary.
//
// There is no authentication and the design does not pretend otherwise:
// anything already running in this page is same-origin and could drive the
// receiver directly. The boundary that matters is the origin, and CustomEvents
// do not cross it.
//
// Versioning, in three levels, because they change for different reasons:
//
//   PROTOCOL   the envelope. A receiver ignores a message whose `v` it does not
//              know, silently — that is what makes a future change safe.
//   API.major     the meaning of the messages. Incompatible change.
//   API.minor     additive: a new command, topic, or capability.
//
// Clients check `v` and `api.major` for compatibility and **`capabilities` for
// everything else**. Feature-detecting on version numbers is how a protocol
// rots; the capability list is there so it never has to happen.

export const PROTOCOL = 1;
// 1.1 adds the `layout` topic and the `panel` command; 1.2 the `radiocontrol`
// topic and the `radio` command; 1.7 the `lock` command and `tuning.locked`.
// All additive, so a 1.0 client is unaffected. Capabilities remain the way to
// test for them.
export const API_VERSION = { major: 1, minor: 7 };

export const EVENT_TO_PAGE = 'ubersdr.to-page';
export const EVENT_FROM_PAGE = 'ubersdr.from-page';

export const MSG = {
    // client → page
    HELLO: 'hello',
    BYE: 'bye',
    SUBSCRIBE: 'subscribe',
    UNSUBSCRIBE: 'unsubscribe',
    GET: 'get',
    COMMAND: 'command',
    RUN: 'run',
    // page → client
    ANNOUNCE: 'announce',
    STATE: 'state',
    RESULT: 'result',
    CLOSING: 'closing',
};

export const CLIENT_TYPES = [
    MSG.HELLO, MSG.BYE, MSG.SUBSCRIBE, MSG.UNSUBSCRIBE, MSG.GET, MSG.COMMAND, MSG.RUN,
];

// Topics that change while you watch, and can be subscribed to.
export const LIVE_TOPICS = [
    'tuning', 'audio', 'signal', 'spectrum', 'session', 'page', 'layout', 'radiocontrol',
    'sdrcontrol', 'vfos', 'markers', 'spots',
];

// Reference data: fetched with `get`, never pushed, because it only changes
// when the page reloads. Keeping it out of `announce` keeps that message small
// enough to broadcast freely.
export const STATIC_TOPICS = ['modes', 'bands', 'functions'];

export const TOPICS = [...LIVE_TOPICS, ...STATIC_TOPICS];

// Only codes the page actually sends. A published enum with values nothing
// emits invites clients to write handlers that can never run; adding one later
// is an additive change and costs a minor version.
//
// Clients should treat an unrecognised code as a failure rather than assuming
// this list is closed.
export const ERR = {
    UNKNOWN_TYPE: 'unknown_type',   // no such message type
    UNSUPPORTED: 'unsupported',     // known, but not available here
    BAD_ARGS: 'bad_args',           // malformed or out of range
    DISABLED: 'disabled',           // the operator has switched the bridge off
    FAILED: 'failed',               // it threw; `message` says what
};

/**
 * The error a command or a handler throws to produce a specific reply.
 *
 * Anything else that escapes becomes `failed` with its message, so a bug is
 * reported to the client rather than swallowed — a command that silently does
 * nothing is the failure this API exists to replace.
 */
export class BridgeError extends Error {
    constructor(code, message) {
        super(message || code);
        this.name = 'BridgeError';
        this.code = code;
    }
}

/**
 * The reply code for a thrown error.
 *
 * Duck-typed rather than `instanceof`: a BridgeError thrown by a module in a
 * different bundle — the tests, an extension sharing this file — is a different
 * class object with the same shape, and identity would quietly demote it to
 * `failed`. The name and the code are the contract.
 */
export function codeOf(e) {
    return e && e.name === 'BridgeError' && typeof e.code === 'string' ? e.code : ERR.FAILED;
}

// --- envelope ---------------------------------------------------------------

export function encodeMessage(msg) {
    return JSON.stringify(msg);
}

/** Parse `detail`. Never throws: junk on the channel is not our problem. */
export function decodeMessage(detail) {
    if (typeof detail !== 'string') return null;
    try {
        const m = JSON.parse(detail);
        return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
    } catch (e) {
        return null;
    }
}

/**
 * Why this inbound message is not one we can answer, or null if it is fine.
 *
 * Envelope only — an unknown `type` is a *reply* (`unknown_type`), not a drop,
 * because the sender is addressable and deserves to be told. Anything failing
 * this check is dropped without a word: it is either not ours or too malformed
 * to reply to.
 *
 * Every client message carries an `id`, including `hello`, so that every
 * message has exactly one reply and a client never waits on something that was
 * never coming.
 */
export function problemWith(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'not a message';
    if (msg.v !== PROTOCOL) return `protocol version ${msg.v}`;
    if (msg.from !== 'client') return 'not from a client';
    if (typeof msg.client !== 'string' || !msg.client) return 'no client id';
    if (!Number.isFinite(msg.id)) return 'no request id';
    return null;
}

// --- page → client ----------------------------------------------------------

/**
 * `descriptor` is spread into the envelope rather than nested: it is the
 * message, and a client that has just received one wants `msg.receiver`, not
 * `msg.descriptor.receiver`. `client` addresses a reply to one client; omitted,
 * it is a broadcast.
 */
export function announceMessage(descriptor, client) {
    return {
        v: PROTOCOL,
        from: 'page',
        type: MSG.ANNOUNCE,
        ...(client ? { client } : {}),
        ...descriptor,
    };
}

/**
 * Addressed, not broadcast.
 *
 * Patches are computed per subscriber — against what *that* client was last
 * sent, at the rate *it* asked for — so a broadcast would hand one client's
 * delta to another whose picture of the topic is different, and be merged into
 * it as though it were true. Two extensions on one page is the ordinary case,
 * not the exotic one.
 */
export function stateMessage(topic, patch, client) {
    return { v: PROTOCOL, from: 'page', type: MSG.STATE, client, topic, patch };
}

export function okMessage(id, client, value) {
    const m = { v: PROTOCOL, from: 'page', type: MSG.RESULT, id, client, ok: true };
    if (value !== undefined) m.value = value;
    return m;
}

export function errorMessage(id, client, code, message) {
    return {
        v: PROTOCOL,
        from: 'page',
        type: MSG.RESULT,
        id,
        client,
        ok: false,
        error: { code, message: message || code },
    };
}

/**
 * The page is going away — or, addressed to one client, that client is being
 * let go to make room. A client treats both the same way: forget what you knew,
 * and say hello again if you are still interested.
 */
export function closingMessage(client) {
    return { v: PROTOCOL, from: 'page', type: MSG.CLOSING, ...(client ? { client } : {}) };
}

// --- client → page ----------------------------------------------------------
//
// Used by window.UberSDR, by the tests, and as the reference for what an
// extension should put on the wire.

export function clientMessage(client, id, type, fields) {
    return { v: PROTOCOL, from: 'client', client, id, type, ...(fields || {}) };
}
