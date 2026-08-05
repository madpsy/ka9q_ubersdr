// The page side of the API, with no page in it.
//
// Everything stateful about serving clients lives here — who is attached, what
// they subscribed to, what they have already been told, how often they may be
// told again — and none of it touches the DOM, React, or the receiver. The
// transport and the receiver arrive as injected functions, which is what makes
// the whole protocol testable without a browser.
//
// BridgeHost.jsx supplies:
//
//   send(msg)              put a message on the wire
//   describe()             the descriptor for `announce`
//   snapshot(topic)        current value of a topic
//   command(name, args)    run a curated command; may throw BridgeError
//   run(fn, event)         dispatch into the function catalogue
//   enabled()              is the operator's switch on
//   now()                  clock, injectable so tests are not timing-dependent
//
// State reaches clients as *patches*: `publish` diffs against what each client
// was last sent and puts only the changed fields on the wire. That is what
// makes a 10 Hz meter affordable, and it means a client that subscribes late
// still starts from a full snapshot — `subscribe` returns one.

import {
    BridgeError, CLIENT_TYPES, ERR, LIVE_TOPICS, MSG, TOPICS,
    announceMessage, closingMessage, codeOf, decodeMessage, errorMessage, okMessage, problemWith,
    stateMessage,
} from './protocol.js';

// The signal topic is the only one that changes faster than anyone can read.
// Ten a second is plenty for a meter and cheap enough for several clients; a
// client that wants less says so with `minIntervalMs`.
export const SIGNAL_MIN_MS = 100;

// Enough for an extension, a userscript and a spare, and a bound on what a
// runaway page can make us hold.
export const MAX_CLIENTS = 8;

const DEFAULT_INTERVAL = { signal: SIGNAL_MIN_MS };

/** Fields of `next` that differ from `prev`. Shallow, by value. */
export function diff(prev, next) {
    const out = {};
    if (!next || typeof next !== 'object') return out;
    for (const [k, v] of Object.entries(next)) {
        const before = prev ? prev[k] : undefined;
        const same = before === v
            || (before !== null && v !== null
                && typeof before === 'object' && typeof v === 'object'
                && JSON.stringify(before) === JSON.stringify(v));
        if (!same) out[k] = v;
    }
    return out;
}

export function createHost(deps) {
    const now = deps.now || (() => Date.now());
    const send = deps.send;
    const enabled = deps.enabled || (() => true);

    // client id -> { subs: Map(topic -> {minIntervalMs, lastAt, sent, pending}), seenAt }
    const clients = new Map();
    // topic -> most recent published value, so a flush can recompute a patch
    // from what is true now rather than from a queued stale one.
    const latest = new Map();

    function subFor(client, topic, minIntervalMs) {
        const entry = clients.get(client);
        if (!entry) return null;
        let sub = entry.subs.get(topic);
        if (!sub) {
            sub = {
                minIntervalMs: minIntervalMs != null ? minIntervalMs : (DEFAULT_INTERVAL[topic] || 0),
                lastAt: 0,
                sent: null,
                pending: false,
            };
            entry.subs.set(topic, sub);
        } else if (minIntervalMs != null) {
            sub.minIntervalMs = minIntervalMs;
        }
        return sub;
    }

    /**
     * Make room for an arriving client.
     *
     * Refusing the newcomer was the obvious rule and the wrong one: client ids
     * are per-injection, so an extension reloaded eight times during an
     * afternoon's development would leave eight dead registrations behind and
     * then refuse the ninth — the live one — with no way back short of
     * reloading the page.
     *
     * A client that said hello and never subscribed goes first, because that is
     * what a dead registration looks like; otherwise the least recently heard
     * from. The evicted client is told, so a client that *is* alive treats it
     * as it treats the page closing and says hello again.
     */
    function evictOne() {
        let victim = null;
        let victimScore = null;
        for (const [id, entry] of clients) {
            // Idle registrations sort before subscribers, then by age.
            const score = [entry.subs.size ? 1 : 0, entry.seenAt];
            if (!victim || score[0] < victimScore[0]
                || (score[0] === victimScore[0] && score[1] < victimScore[1])) {
                victim = id;
                victimScore = score;
            }
        }
        if (!victim) return;
        clients.delete(victim);
        send(closingMessage(victim));
    }

    function pushTo(client, topic, sub, value, at) {
        const patch = diff(sub.sent, value);
        if (!Object.keys(patch).length) {
            sub.pending = false;
            return false;
        }
        if (at - sub.lastAt < sub.minIntervalMs) {
            // Held, not dropped: the value is in `latest`, and tick() sends the
            // patch as soon as the interval is up. Dropping would leave a meter
            // frozen on a stale reading the moment the signal went quiet.
            sub.pending = true;
            return false;
        }
        send(stateMessage(topic, patch, client));
        sub.sent = { ...(sub.sent || {}), ...patch };
        sub.lastAt = at;
        sub.pending = false;
        return true;
    }

    /** Called by the page whenever a topic's value may have changed. */
    function publish(topic, value) {
        latest.set(topic, value);
        if (!enabled()) return;
        const at = now();
        for (const [id, entry] of clients) {
            const sub = entry.subs.get(topic);
            if (sub) pushTo(id, topic, sub, value, at);
        }
    }

    /** Send anything held back by a rate limit whose interval has now passed. */
    function tick() {
        if (!enabled()) return;
        const at = now();
        for (const [id, entry] of clients) {
            for (const [topic, sub] of entry.subs) {
                if (!sub.pending) continue;
                const value = latest.get(topic);
                if (value !== undefined) pushTo(id, topic, sub, value, at);
            }
        }
    }

    function snapshotOf(topic) {
        const value = deps.snapshot(topic);
        if (LIVE_TOPICS.includes(topic)) latest.set(topic, value);
        return value;
    }

    function broadcastAnnounce() {
        if (!enabled()) return;
        send(announceMessage(deps.describe()));
    }

    function handleRequest(msg) {
        const { client, id, type } = msg;

        // Every message from an unknown client registers it — including the
        // first `command`, so a client that skipped `hello` still works. The
        // handshake is a convenience, not a gate.
        if (!clients.has(client)) {
            if (clients.size >= MAX_CLIENTS) evictOne();
            clients.set(client, { subs: new Map(), seenAt: now() });
        }
        clients.get(client).seenAt = now();

        switch (type) {
            case MSG.HELLO:
                send(announceMessage(deps.describe(), client));
                return;

            case MSG.BYE:
                clients.delete(client);
                send(okMessage(id, client, { attached: clients.size }));
                return;

            case MSG.SUBSCRIBE: {
                const topics = topicList(msg.topics, LIVE_TOPICS);
                const min = msg.minIntervalMs === undefined ? null : Number(msg.minIntervalMs);
                if (min !== null && (!Number.isFinite(min) || min < 0)) {
                    send(errorMessage(id, client, ERR.BAD_ARGS, 'minIntervalMs must be a positive number'));
                    return;
                }
                const value = {};
                for (const topic of topics) {
                    const sub = subFor(client, topic, min);
                    const snap = snapshotOf(topic);
                    // Seeded, so the first patch after this is a real delta
                    // rather than a repeat of what we just sent.
                    sub.sent = snap;
                    sub.lastAt = now();
                    value[topic] = snap;
                }
                send(okMessage(id, client, value));
                return;
            }

            case MSG.UNSUBSCRIBE: {
                const topics = topicList(msg.topics, LIVE_TOPICS);
                const entry = clients.get(client);
                for (const topic of topics) entry.subs.delete(topic);
                send(okMessage(id, client, { subscribed: [...entry.subs.keys()] }));
                return;
            }

            case MSG.GET: {
                const wanted = msg.topic === undefined || msg.topic === '*' ? LIVE_TOPICS : [msg.topic];
                for (const topic of wanted) {
                    if (!TOPICS.includes(topic)) {
                        send(errorMessage(id, client, ERR.BAD_ARGS,
                            `no topic "${topic}" — one of ${TOPICS.join(', ')}`));
                        return;
                    }
                }
                const value = {};
                for (const topic of wanted) value[topic] = snapshotOf(topic);
                // A single named topic answers with the topic itself, not a map
                // of one: `get {topic:'tuning'}` should give you the tuning.
                send(okMessage(id, client, wanted.length === 1 && msg.topic ? value[wanted[0]] : value));
                return;
            }

            case MSG.COMMAND:
                if (typeof msg.name !== 'string') {
                    send(errorMessage(id, client, ERR.BAD_ARGS, 'name is required'));
                    return;
                }
                settle(id, client, () => deps.command(msg.name, msg.args || {}));
                return;

            case MSG.RUN:
                if (typeof msg.fn !== 'string') {
                    send(errorMessage(id, client, ERR.BAD_ARGS, 'fn is required'));
                    return;
                }
                settle(id, client, () => deps.run(msg.fn, msg.event || { kind: 'trigger' }));
                return;

            default:
                send(errorMessage(id, client, ERR.UNKNOWN_TYPE,
                    `no message type "${type}" — one of ${CLIENT_TYPES.join(', ')}`));
        }
    }

    // Commands may be synchronous or not; either way exactly one reply goes
    // out, and a thrown BridgeError keeps its code while anything else becomes
    // `failed` with its message. Nothing is swallowed.
    function settle(id, client, work) {
        let value;
        try {
            value = work();
        } catch (e) {
            send(errorMessage(id, client, codeOf(e), e.message));
            return;
        }
        if (value && typeof value.then === 'function') {
            value.then(
                (v) => send(okMessage(id, client, v)),
                (e) => send(errorMessage(id, client, codeOf(e), e.message)),
            );
            return;
        }
        send(okMessage(id, client, value));
    }

    function topicList(given, fallback) {
        if (given === undefined || given === null) return fallback;
        const list = Array.isArray(given) ? given : [given];
        const bad = list.find((t) => !LIVE_TOPICS.includes(t));
        if (bad) throw new BridgeError(ERR.BAD_ARGS, `no live topic "${bad}"`);
        return list;
    }

    return {
        /** An inbound client message: the raw `detail` string, or the object. */
        handle(raw) {
            const msg = typeof raw === 'string' ? decodeMessage(raw) : raw;
            // Not addressed to us, not our protocol, or too malformed to reply
            // to: dropped without a word. Everything else gets exactly one
            // reply, including a message type we do not know.
            if (problemWith(msg)) return;
            if (!enabled()) {
                send(errorMessage(msg.id, msg.client, ERR.DISABLED,
                    'the browser bridge is switched off on this receiver page'));
                return;
            }
            try {
                handleRequest(msg);
            } catch (e) {
                send(errorMessage(msg.id, msg.client, codeOf(e), e.message));
            }
        },

        publish,
        tick,

        /** Descriptor to everyone: on mount, and whenever it changes. */
        announce: broadcastAnnounce,

        /** The page is going away. */
        closing() {
            if (clients.size) send(closingMessage());
            clients.clear();
        },

        /** Attached client ids — what the "something is driving this" badge counts. */
        clients() {
            return [...clients.keys()];
        },

        /** Test seam: forget everyone, keep the deps. */
        reset() {
            clients.clear();
            latest.clear();
        },
    };
}
