// Which refusals are worth waiting out, and which end the session.
//
// The reason this is a table rather than a couple of spot checks: getting one of
// these wrong is invisible until somebody is stuck. Read a temporary refusal as
// fatal and a working receiver goes dead until the page is reloaded — the
// original complaint. Read a fatal one as temporary and the client retries a
// session id the server has blacklisted for an hour, once per backoff step,
// for ever.
//
// The strings are the server's own, copied from main.go's handleConnectionCheck
// and the three websocket handlers. If one of them is reworded there and not
// here, the fallback is 'retry' — which is the safe direction, but the test
// below that pins the exact phrasings is what should fail first.

const assert = require('assert');
const { failureKind, failureMessage, shouldRetry } = require('./.build/connectfailure.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- the server's actual words ----------------------------------------------

const CASES = [
    // [reason, status, kind]
    // Capacity and rate limiting: the receiver is busy or we asked too often.
    // Both clear on their own, and both used to strand the page.
    ['Maximum unique users reached (2 of 2)', 503, 'retry'],
    ['Maximum unique users per IP reached (2)', 503, 'retry'],
    ['Rate limit exceeded. Please wait before trying again.', 429, 'retry'],
    ['too many session attempts; please wait a moment before reconnecting', 0, 'retry'],
    ['Too Many Requests - Connection rate limit exceeded', 429, 'retry'],
    ['Daily time limit reached (60 minutes per 24 hours). Please try again later.', 429, 'retry'],
    ['connection check failed', 0, 'retry'],

    // The id is finished. Retrying it cannot work — a kicked UUID is refused
    // for an hour — so the session has to be replaced, not resumed.
    ['Your session has been terminated. Please refresh the page.', 410, 'identity'],
    ['Your session has been terminated. Please refresh the page.', 403, 'identity'],
    ['Invalid session. Please refresh the page and try again.', 400, 'identity'],
    ['Invalid or missing user_session_id', 400, 'identity'],
    ['Session IP mismatch. Please refresh the page and try again.', 403, 'identity'],
    ['no active audio session found', 0, 'identity'],

    // Not welcome. Neither waiting nor restarting helps.
    ['Your IP address has been banned', 403, 'blocked'],
    ['Your browser or client has been banned', 403, 'blocked'],
    ['This receiver requires a password to access', 403, 'blocked'],
    ['Invalid bypass password', 403, 'blocked'],
    ['Unauthorized', 401, 'blocked'],
];

t('every refusal the server can send is classified', () => {
    for (const [reason, status, want] of CASES) {
        assert.strictEqual(
            failureKind(reason, status), want,
            `${JSON.stringify(reason)} (${status}) should be ${want}`,
        );
    }
});

t('a session id refused with 403 is replaced, not treated as a ban', () => {
    // Both arrive as 403 and only the text separates them. Getting this the
    // wrong way round tells somebody they are banned when they are not, and —
    // worse — stops offering them the one thing that would fix it.
    assert.strictEqual(failureKind('Session IP mismatch. Please refresh the page and try again.', 403), 'identity');
    assert.strictEqual(failureKind('Your IP address has been banned', 403), 'blocked');
});

t('the status settles it before the wording does', () => {
    // So a rewording server-side cannot silently turn a fatal answer into an
    // endless retry.
    assert.strictEqual(failureKind('something nobody has written yet', 410), 'identity');
    assert.strictEqual(failureKind('something nobody has written yet', 429), 'retry');
    assert.strictEqual(failureKind('something nobody has written yet', 503), 'retry');
});

t('an unrecognised refusal is retried rather than fatal', () => {
    // The safe direction: a needless reconnect costs a round trip, a wrong
    // "fatal" costs the operator their receiver until they reload.
    assert.strictEqual(failureKind('', 0), 'retry');
    assert.strictEqual(failureKind(undefined, undefined), 'retry');
    assert.strictEqual(failureKind('the gronk exploded', 500), 'retry');
});

t('case and surrounding text do not matter', () => {
    assert.strictEqual(failureKind('YOUR SESSION HAS BEEN TERMINATED', 0), 'identity');
    assert.strictEqual(failureKind('Failed to create spectrum session: too many session attempts', 0), 'retry');
});

// --- the shorthand the sockets use ------------------------------------------

t('shouldRetry agrees with the classification', () => {
    for (const [reason, status, want] of CASES) {
        assert.strictEqual(shouldRetry(reason, status), want === 'retry', reason);
    }
});

// --- what the operator is told ----------------------------------------------

t('an ended session is explained as something to act on', () => {
    const msg = failureMessage('identity', 'Your session has been terminated.');
    assert.ok(/Listen/.test(msg), msg);
    // Not "reload the page": there is a way back that is not a reload, and
    // telling somebody to reload was the client admitting it had none.
    assert.ok(!/reload|refresh/i.test(msg), msg);
});

t('a refusal quotes the receiver, and survives having nothing to quote', () => {
    assert.ok(/banned/.test(failureMessage('blocked', 'Your IP address has been banned')));
    assert.ok(failureMessage('blocked', '').length > 0);
});

t('a transient failure says nothing at all', () => {
    // Nothing has gone wrong that the operator can act on, and a notice per
    // reconnect trains people to ignore all of them.
    assert.strictEqual(failureMessage('retry', 'Rate limit exceeded'), '');
});

if (!process.exitCode) console.log(`\n${pass} passed`);
