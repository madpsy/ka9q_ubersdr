// Why a connection was refused, and therefore what to do about it.
//
// The sockets used to make this judgement inline, with one regex between them:
// audio retried when the reason matched /maximum/i and gave up otherwise, and
// the spectrum did not retry at all. Both readings are wrong in the same
// direction — they treat "come back in a moment" as fatal — and the result is
// the complaint this module exists for: the page looks live, the waterfall is
// blank, the audio is silent, and only a reload fixes it.
//
// There are four genuinely different answers, and they need four different
// behaviours rather than one retry flag:
//
//   'retry'     the receiver is busy, we asked too often, or the network
//               hiccuped. Nothing is wrong with this client and nothing needs
//               the operator. Keep the backoff running; it will come back on
//               its own, which is the whole point of having one.
//
//   'reregister' the server does not recognise this id — not because it has
//               finished with it, but because it has forgotten it. It drops a
//               registration five minutes after the id's last session ends, and
//               a restart drops every one of them at once. One POST to
//               /connection under the *same* id fixes it, and because the id
//               does not change, neither does the server's clock for this
//               session. So: re-register, then carry on with the backoff. This
//               is the difference between a receiver that restarts and comes
//               back on its own and one that leaves a dead page behind it.
//
//   'identity'  this session id is finished. The server reclaims an idle
//               session by *kicking the UUID* and then refusing it for an hour
//               (KickUserBySessionID), and it forgets the id's registration
//               five minutes after the last session ends. Either way every
//               endpoint answers the same id with the same refusal for as long
//               as it takes, so retrying is not slow — it is arithmetic that
//               never comes out. What is needed is a *new* id, and only
//               starting the receiver mints one. So: stop, honestly, and let
//               the next thing the operator does start a fresh session.
//
//   'blocked'   this client is not welcome: a ban, or a password the receiver
//               did not accept. Neither waiting nor restarting changes it, so
//               say so and stop.
//
// Matched on the server's words because that is what reaches the client. The
// status code is checked first where there is one — 410 for a kicked UUID and
// 403 for a ban are unambiguous — with the text as the fallback for the paths
// that arrive over the websocket instead of over /connection, where there is no
// status at all. Anything unrecognised is 'retry': guessing "fatal" strands a
// working receiver for ever, guessing "retry" costs a reconnect that fails.

/** @typedef {'retry'|'reregister'|'identity'|'blocked'} FailureKind */

// The server's phrasings, from main.go's handleConnectionCheck and the three
// websocket handlers. Substrings rather than whole strings: several of them
// carry counts ("Maximum unique users reached (2 of 2)").

// The one refusal a client can answer for itself. Checked before IDENTITY,
// which is where it used to live: the two are worded differently by the server
// on purpose — this one is a 400 and means "who?", the others are a 403 or a
// 410 and mean "no".
const REREGISTER = [
    'invalid session',                  // the id's registration has been forgotten
];

const IDENTITY = [
    'session has been terminated',      // kicked UUID, /connection 410 and the sockets' 403
    'invalid or missing user_session_id',
    'session ip mismatch',              // the id was bound to a different address
    'no active audio session',          // an extension attaching under a dead id
];

const BLOCKED = [
    'has been banned',                  // IP ban and User-Agent ban both end this way
    'requires a password',
    'invalid bypass password',
    'unauthorized',
];

// Named so the retry path is explicit rather than merely the default: these are
// the ones we positively expect to recover, and a reader should not have to
// infer that from an absence.
const RETRY = [
    'maximum',                          // unique users, or unique users per IP
    'rate limit',
    'too many',                         // session creation churn, connection rate
    'daily time limit',
    'connection check failed',          // the fetch itself did not complete
];

function has(haystack, needles) {
    return needles.some((n) => haystack.includes(n));
}

/**
 * Classify a refusal.
 *
 * @param {string} reason  what the server said, in whatever form reached us.
 * @param {number} [status] the HTTP status, when the refusal came from
 *                          /connection. 0 or absent for a websocket-borne one.
 * @returns {FailureKind}
 */
export function failureKind(reason, status) {
    // 410 Gone is only ever the kicked-UUID reply, and 403 covers the bans and
    // the password. 503 and 429 are capacity and rate limiting, both temporary
    // by definition. Checked before the text so a future rewording cannot
    // silently turn a fatal answer into an endless retry.
    if (status === 410) return 'identity';
    if (status === 429 || status === 503) return 'retry';

    const text = String(reason || '').toLowerCase();

    // Before IDENTITY, which it reads as a special case of: the id is unknown
    // to the server rather than finished with, and asking again under the same
    // id is what makes it known. Everything below is something the client
    // cannot talk its way out of.
    if (has(text, REREGISTER)) return 'reregister';

    // Before the 403 fallback: a mismatched session id is answered with 403 and
    // is an identity problem, not a ban — restarting fixes it and nothing else
    // does.
    if (has(text, IDENTITY)) return 'identity';
    if (has(text, BLOCKED)) return 'blocked';
    if (status === 403) return 'blocked';
    if (has(text, RETRY)) return 'retry';
    return 'retry';
}

/**
 * Whether the backoff should keep trying after this refusal.
 *
 * The one question the sockets actually ask, kept as its own name so the call
 * sites read as intent rather than as a string comparison. True for
 * 'reregister' as well: that one costs a POST on the way past, but the answer
 * to it is still another attempt rather than a stopped receiver.
 */
export function shouldRetry(reason, status) {
    const kind = failureKind(reason, status);
    return kind === 'retry' || kind === 'reregister';
}

/**
 * What to tell the operator, for the two kinds that end the session.
 *
 * Phrased as what happened and what to do, not as an error code. 'retry' and
 * 'reregister' have no message on purpose: nothing has gone wrong that the
 * operator can act on — both recover without them — and a notice for every
 * transient reconnect would train them to ignore all of them.
 */
export function failureMessage(kind, reason) {
    if (kind === 'identity') {
        return 'The receiver ended this session. Press Listen to start a new one.';
    }
    if (kind === 'blocked') {
        return reason ? `This receiver refused the connection: ${reason}` : 'This receiver refused the connection.';
    }
    return '';
}
