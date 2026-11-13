// Chat moderation, the parts of it that are bookkeeping rather than React.
//
// ChatContext owns the state; this owns what the state *means*: which line a
// server id is, what a deletion or a sync removes, how a notice reads in the log,
// when a chat ban is over, and which reply belongs to which moderator request.
// Kept apart so it can be tested without a renderer — see test/chatmod.test.js.
//
// The protocol is in radio/dxcluster-connection.js.

// What makes two deliveries of the same line the same line, for lines the
// server gave no id — the personalised welcome, and our own presence lines. See
// ChatContext for why the same message is delivered more than once by design.
export const msgKey = (timestamp, username, body) => `${timestamp}|${username}|${body}`;

const isId = (v) => typeof v === 'number' && Number.isFinite(v);

// The key a chat message is filed under. A server id when it has one, so a
// replayed line is recognised whatever its timestamp says and a deletion can find
// it; the old timestamp/name/text key otherwise.
export function messageKey(m) {
    if (isId(m.id)) return `id:${m.id}`;
    return msgKey(m.timestamp, m.username, m.message);
}

// Lines whose server id is in `ids` removed. The same array back when nothing
// matched, so a deletion of somebody else's lines we never had costs no render.
export function applyDeleted(messages, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return messages;
    const gone = new Set(ids);
    const next = messages.filter((m) => !(isId(m.serverId) && gone.has(m.serverId)));
    return next.length === messages.length ? messages : next;
}

// After a replay the server says which ids its buffer still holds. Anything we
// have inside that range that it no longer lists was deleted while we were away
// (or while the socket was reconnecting), and goes. Lines outside the range, and
// lines with no id, are not the sync's business.
export function applySync(messages, sync) {
    if (!sync) return messages;
    const min = Number(sync.min_id);
    const max = Number(sync.max_id);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return messages;
    const keep = new Set(Array.isArray(sync.ids) ? sync.ids : []);
    const next = messages.filter((m) => !(isId(m.serverId)
        && m.serverId >= min && m.serverId <= max && !keep.has(m.serverId)));
    return next.length === messages.length ? messages : next;
}

// RFC3339 -> epoch ms, or null when there is nothing usable.
export function parseUntil(until) {
    if (!until) return null;
    const t = Date.parse(until);
    return Number.isFinite(t) ? t : null;
}

// The chat-ban state for an `until`, or null when it has already passed. A ban
// with no readable end is still a ban — the server said so — and is held until it
// says otherwise (a lift notice, or a successful join).
export function chatBanFrom(until, now = Date.now()) {
    const at = parseUntil(until);
    if (at !== null && at <= now) return null;
    return { until: at === null ? null : new Date(at).toISOString() };
}

// setTimeout takes a signed 32-bit delay; anything longer fires at once.
const MAX_DELAY = 2 ** 31 - 1;

// How long until a chat ban is over, or null for one with no end to wait for.
// A little slack on top, so a re-join after it is not refused by a server whose
// clock is a second behind ours.
export const BAN_SLACK_MS = 2000;
export function banDelay(ban, now = Date.now()) {
    if (!ban) return null;
    const at = parseUntil(ban.until);
    if (at === null) return null;
    return Math.min(MAX_DELAY, Math.max(0, at - now) + BAN_SLACK_MS);
}

let seq = 0;

// A local line in the log: a notice from the server, or the record of something
// this moderator did. `kind` is what the panel styles by — 'warning' and
// 'auto_warning' are highlighted, 'chat_banned' / 'chat_ban_lifted' are status,
// 'mod' is a moderator's own action, 'mod_ended' the end of moderating.
export function localLine(kind, text, now = Date.now()) {
    seq += 1;
    const timestamp = new Date(now).toISOString();
    const key = `local|${kind}|${timestamp}|${seq}`;
    return {
        key,
        id: key,
        system: true,
        notice: true,
        kind,
        highlight: kind === 'warning' || kind === 'auto_warning',
        username: '',
        message: String(text || ''),
        timestamp,
    };
}

/**
 * When a chat ban ends, in local time: "14:05" today, "3 Dec 14:05" on another
 * day. Empty for anything unreadable.
 */
export function untilText(until, now = Date.now()) {
    if (!until) return '';
    const d = new Date(until);
    if (Number.isNaN(d.getTime())) return '';
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date(now).toDateString()) return hm;
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hm}`;
}

// What the two ban notices say. Written here rather than taken from the server,
// because the end time has to be in the listener's own time zone — the server
// sends it as `until` and leaves it out of its text.
export function noticeText(notice, now = Date.now()) {
    const kind = notice && notice.kind;
    if (kind === 'chat_banned') {
        const at = untilText(notice.until, now);
        return `You've been banned from chat ${at ? `until ${at}` : 'for now'}. You can still listen to the receiver.`;
    }
    if (kind === 'chat_ban_lifted') return 'Your chat ban has ended. You can chat again.';
    return (notice && notice.text) || '';
}

export function noticeLine(notice, now = Date.now()) {
    const kind = (notice && notice.kind) || 'info';
    return localLine(kind, noticeText(notice, now), now);
}

// Said once when the server stops treating us as a moderator after it had been:
// the admin sign-in behind it has expired, or the server restarted.
export const MOD_ENDED_TEXT = 'Your admin sign-in has ended — reload the page to moderate again.';

// The log line a moderator's own successful action leaves behind, or null. An
// info lookup changes nothing and leaves nothing.
export function modResultLine(result, now = Date.now()) {
    if (!result || !result.ok || result.action === 'info' || !result.message) return null;
    return localLine('mod', result.message, now);
}

export const EMPTY_MOD_STATE = Object.freeze({ bans: [], warnings: {} });

export function normaliseModState(d) {
    return {
        bans: Array.isArray(d && d.bans) ? d.bans : [],
        warnings: (d && d.warnings && typeof d.warnings === 'object') ? d.warnings : {},
    };
}

const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

export const MOD_TIMEOUT_MS = 10000;

/**
 * Outstanding moderator requests, matched to their replies.
 *
 * The server answers each chat_mod with one chat_mod_result naming the action
 * and the user, and nothing else ties the two together — so a request waits on
 * the first reply with the same pair. Oldest first, which is the order the
 * server answers in.
 *
 * `send(action, username, opts)` returns whether it went — the connection's
 * mod(); timers are injectable for the tests.
 */
export function createModRequests({
    send, timeoutMs = MOD_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
    let pending = [];
    const drop = (p) => {
        pending = pending.filter((x) => x !== p);
        clearTimer(p.timer);
    };
    return {
        request(action, username, opts = {}) {
            return new Promise((resolve, reject) => {
                if (!send(action, username, opts)) {
                    reject(new Error('Not connected to chat. Try again in a moment.'));
                    return;
                }
                const p = { action, username, resolve, reject, timer: null };
                p.timer = setTimer(() => {
                    drop(p);
                    reject(new Error('No reply from the receiver. Check your connection and try again.'));
                }, timeoutMs);
                pending.push(p);
            });
        },
        // A chat_mod_result arrived. Answers whether it matched a request.
        resolve(result) {
            if (!result) return false;
            const p = pending.find((x) => x.action === result.action && sameName(x.username, result.username));
            if (!p) return false;
            drop(p);
            p.resolve(result);
            return true;
        },
        // The socket went: nothing in flight will be answered.
        rejectAll(message = 'Connection to chat lost. Try again in a moment.') {
            const all = pending;
            pending = [];
            for (const p of all) {
                clearTimer(p.timer);
                p.reject(new Error(message));
            }
        },
        get size() { return pending.length; },
    };
}
