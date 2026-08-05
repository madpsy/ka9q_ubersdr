// The other end: a client of the page API.
//
// This is what `window.UberSDR` is, and it is deliberately not a shortcut into
// the host — it talks over the same two CustomEvents an extension uses, so an
// in-page consumer and a content script exercise exactly the same code path and
// cannot drift apart. It is also the reference implementation: a browser
// extension's content script is this file plus the plumbing that forwards to
// its own background page.
//
// Everything that expects an answer returns a promise. A request that is never
// answered rejects on a timeout rather than hanging, because the page it is
// talking to might have navigated away mid-question.
//
// The client keeps a merged copy of every topic it has subscribed to: patches
// arrive as deltas, and reassembling them is work every client would otherwise
// repeat.

import { EVENT_FROM_PAGE, EVENT_TO_PAGE, MSG, PROTOCOL, decodeMessage, encodeMessage, clientMessage } from './protocol.js';

export const DEFAULT_TIMEOUT_MS = 5000;

let counter = 0;

function newClientId() {
    counter += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `c${counter}-${rand}`;
}

/**
 * @param target        window, or anything with add/removeEventListener and dispatchEvent
 * @param options.id            client id; generated when absent
 * @param options.timeoutMs     how long to wait for a reply
 * @param options.CustomEvent   constructor, for environments without a DOM
 */
export function createClient(target, options = {}) {
    const id = options.id || newClientId();
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const EventCtor = options.CustomEvent || globalThis.CustomEvent;
    const setTimer = options.setTimeout || globalThis.setTimeout;
    const clearTimer = options.clearTimeout || globalThis.clearTimeout;

    let seq = 0;
    let closed = false;
    const pending = new Map();          // id -> { resolve, reject, timer }
    const topics = new Map();           // topic -> merged state
    const listeners = new Map();        // topic | 'announce' | 'closing' -> Set(fn)
    let descriptor = null;

    function emit(name, value) {
        const set = listeners.get(name);
        if (!set) return;
        for (const fn of Array.from(set)) {
            try { fn(value); } catch (e) { console.error('[ubersdr] listener threw', e); }
        }
    }

    function onMessage(ev) {
        const msg = decodeMessage(ev.detail);
        if (!msg || msg.v !== PROTOCOL || msg.from !== 'page') return;
        // Replies are addressed; broadcasts are not. A message addressed to
        // somebody else is not ours to read.
        if (msg.client && msg.client !== id) return;

        if (msg.type === MSG.RESULT) {
            const waiting = pending.get(msg.id);
            if (!waiting) return;
            pending.delete(msg.id);
            clearTimer(waiting.timer);
            if (msg.ok) waiting.resolve(msg.value);
            else {
                const err = new Error((msg.error && msg.error.message) || 'request failed');
                err.code = msg.error && msg.error.code;
                waiting.reject(err);
            }
            return;
        }

        if (msg.type === MSG.STATE) {
            const merged = { ...(topics.get(msg.topic) || {}), ...msg.patch };
            topics.set(msg.topic, merged);
            emit(msg.topic, merged);
            return;
        }

        if (msg.type === MSG.ANNOUNCE) {
            descriptor = msg;
            // A fresh announce means the page has (re)started: whatever we
            // thought we knew about its state is from a previous life.
            topics.clear();
            emit('announce', msg);
            return;
        }

        if (msg.type === MSG.CLOSING) {
            descriptor = null;
            emit('closing', null);
        }
    }

    target.addEventListener(EVENT_FROM_PAGE, onMessage);

    function send(type, fields) {
        if (closed) return Promise.reject(new Error('client is closed'));
        seq += 1;
        const msgId = seq;
        const message = clientMessage(id, msgId, type, fields);
        const promise = new Promise((resolve, reject) => {
            const timer = setTimer(() => {
                pending.delete(msgId);
                const err = new Error(`no reply to "${type}" after ${timeoutMs} ms`);
                err.code = 'timeout';
                reject(err);
            }, timeoutMs);
            pending.set(msgId, { resolve, reject, timer });
        });
        target.dispatchEvent(new EventCtor(EVENT_TO_PAGE, { detail: encodeMessage(message) }));
        return promise;
    }

    /** `on(topic|'announce'|'closing', fn)` — returns an unsubscribe. */
    function on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return () => {
            const set = listeners.get(name);
            if (set) set.delete(fn);
        };
    }

    return {
        id,

        /**
         * Ask the page to describe itself.
         *
         * The reply to `hello` is an `announce`, which is a broadcast rather
         * than an addressed result — so it arrives through the announce
         * listener, not the pending map. Rejecting on timeout is how a client
         * concludes it is not on an UberSDR page: there is nothing to poll.
         */
        hello() {
            return new Promise((resolve, reject) => {
                let timer = null;
                const off = on('announce', (d) => {
                    off();
                    clearTimer(timer);
                    resolve(d);
                });
                timer = setTimer(() => {
                    off();
                    const err = new Error('no announce — this is not an UberSDR v2 page');
                    err.code = 'timeout';
                    reject(err);
                }, timeoutMs);
                send(MSG.HELLO, {}).catch(() => { /* the announce is the answer */ });
            });
        },

        subscribe(list, opts = {}) {
            return send(MSG.SUBSCRIBE, {
                topics: list,
                ...(opts.minIntervalMs !== undefined ? { minIntervalMs: opts.minIntervalMs } : {}),
            }).then((value) => {
                for (const [topic, snap] of Object.entries(value || {})) topics.set(topic, snap);
                return value;
            });
        },

        unsubscribe(list) { return send(MSG.UNSUBSCRIBE, { topics: list }); },
        get(topic) { return send(MSG.GET, topic === undefined ? {} : { topic }); },
        command(name, args) { return send(MSG.COMMAND, { name, args: args || {} }); },
        run(fn, event) { return send(MSG.RUN, { fn, event: event || { kind: 'trigger' } }); },
        bye() { return send(MSG.BYE, {}); },

        /** Last known value of a topic, reassembled from its patches. */
        state(topic) { return topics.get(topic) || null; },

        /** The last announce, or null if the page has not answered yet. */
        describe() { return descriptor; },

        on,

        close() {
            closed = true;
            target.removeEventListener(EVENT_FROM_PAGE, onMessage);
            for (const [, waiting] of pending) {
                clearTimer(waiting.timer);
                waiting.reject(new Error('client is closed'));
            }
            pending.clear();
            listeners.clear();
        },
    };
}
