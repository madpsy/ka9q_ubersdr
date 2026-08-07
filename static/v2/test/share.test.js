// Sharing a frequency as a link.
//
// The link is the one thing in this app that crosses between people, between the
// two frontends, and between builds — so the parameter names are v1's and a link
// made today has to keep working when opened by whatever the recipient has. The
// round trip is the property that matters: what the sender was hearing is what
// the recipient gets.
//
// The other half is what must *not* be in it. This page can be opened with
// ?password=, and a share button that copied the address bar would put that in a
// group chat.

const assert = require('assert');
const {
    SHARE_KEYS, SHARE_TARGETS, _resetUrlView, buildShareUrl, readShareUrl, shareText,
} = require('./.build/share.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const TUNING = { frequency: 14175000, mode: 'usb', bandwidthLow: 100, bandwidthHigh: 2800 };
const VIEW = { centerFreq: 14180000, binBandwidth: 7.324 };
const AT = { origin: 'https://rx.example', pathname: '/v2/' };

const query = (url) => url.slice(url.indexOf('?'));

// --- the round trip -------------------------------------------------------------

t('what was shared is what is read back', () => {
    const url = buildShareUrl({ ...AT, tuning: TUNING, view: VIEW });
    const back = readShareUrl(query(url));
    assert.strictEqual(back.frequency, 14175000);
    assert.strictEqual(back.mode, 'usb');
    assert.strictEqual(back.bandwidthLow, 100);
    assert.strictEqual(back.bandwidthHigh, 2800);
    assert.deepStrictEqual(back.view, { frequency: 14180000, binBandwidth: 7.324 });
});

t('the parameter names are v1\'s', () => {
    // Two frontends serve the same receiver and the recipient may not be using
    // the one that made the link — or know there is a choice.
    const url = buildShareUrl({ ...AT, tuning: TUNING, view: VIEW });
    for (const key of SHARE_KEYS) {
        assert.ok(url.includes(`${key}=`), `${key} missing from ${url}`);
    }
    assert.ok(url.startsWith('https://rx.example/v2/?'), url);
});

t('a deep zoom survives being written down', () => {
    // At the bottom of the ladder a bin is a fraction of a hertz. Rounded to an
    // integer it would land the recipient on a different rung from the sender.
    const url = buildShareUrl({ ...AT, tuning: TUNING, view: { centerFreq: 7100000, binBandwidth: 0.573 } });
    assert.strictEqual(readShareUrl(query(url)).view.binBandwidth, 0.573);
});

// --- what must not be in it -------------------------------------------------------

t('nothing else in the address bar comes along', () => {
    // Built from the origin and the path, never from the current URL: a
    // ?password= in the bar (see radio/session.js) must not be handed to whoever
    // the link is sent to, and no panel or theme state belongs in it either.
    const url = buildShareUrl({ ...AT, tuning: TUNING, view: VIEW });
    assert.ok(!/password/i.test(url), url);
    const q = new URLSearchParams(query(url));
    assert.deepStrictEqual([...q.keys()].sort(), [...SHARE_KEYS].sort());
});

t('a view the server has not described yet is not invented', () => {
    // Before the spectrum socket answers there is no view to share, and sending
    // zeros would put the recipient somewhere the sender never was.
    const url = buildShareUrl({ ...AT, tuning: TUNING, view: { centerFreq: 0, binBandwidth: 0 } });
    assert.ok(!url.includes('zoom_'), url);
    assert.ok(!buildShareUrl({ ...AT, tuning: TUNING }).includes('zoom_'), 'no view at all');
});

// --- reading somebody else's link ---------------------------------------------------

t('half a link still tunes what it can', () => {
    // Links get typed, forwarded and truncated by chat clients.
    assert.deepStrictEqual(readShareUrl('?freq=7100000'), { frequency: 7100000 });
    assert.deepStrictEqual(readShareUrl(''), {});
    assert.deepStrictEqual(readShareUrl('?nonsense=1'), {});
});

t('rubbish is left out rather than guessed at', () => {
    assert.strictEqual(readShareUrl('?freq=abc').frequency, undefined);
    assert.strictEqual(readShareUrl('?freq=-100').frequency, undefined);
    assert.strictEqual(readShareUrl('?mode=banana').mode, undefined);
    assert.strictEqual(readShareUrl('?mode=USB').mode, undefined, 'the vocabulary is lower case');
});

t('a filter is applied as a pair or not at all', () => {
    // One edge on its own lands against whatever the other happens to be, which
    // for a CW filter arriving into an AM default is a passband the receiver
    // refuses outright.
    assert.strictEqual(readShareUrl('?bwl=100').bandwidthLow, undefined);
    assert.strictEqual(readShareUrl('?bwh=2800').bandwidthHigh, undefined);
    assert.strictEqual(readShareUrl('?bwl=2800&bwh=100').bandwidthLow, undefined, 'inverted');
    const both = readShareUrl('?mode=usb&bwl=300&bwh=2400');
    assert.strictEqual(both.bandwidthLow, 300);
    assert.strictEqual(both.bandwidthHigh, 2400);
});

t('a filter wider than the mode allows is clamped, not refused', () => {
    // A link from a build with different limits, or a hand-edited one. The signal
    // is still worth hearing at the widest the mode has.
    const out = readShareUrl('?mode=usb&bwl=-99999&bwh=99999');
    assert.ok(out.bandwidthLow > -99999);
    assert.ok(out.bandwidthHigh < 99999);
    assert.ok(out.bandwidthHigh > out.bandwidthLow);
});

t('a view needs both halves', () => {
    // A centre without a span is a pan and a span without a centre is a zoom; the
    // link is meant to reproduce a picture, not half of one.
    assert.strictEqual(readShareUrl('?zoom_freq=14180000').view, undefined);
    assert.strictEqual(readShareUrl('?zoom_bw=7.3').view, undefined);
    assert.strictEqual(readShareUrl('?zoom_freq=14180000&zoom_bw=0').view, undefined);
});

t('v2\'s older ?frequency= is still honoured', () => {
    assert.strictEqual(readShareUrl('?frequency=10000000').frequency, 10000000);
    // ...and the short name wins where a link somehow carries both.
    assert.strictEqual(readShareUrl('?freq=7100000&frequency=10000000').frequency, 7100000);
});

// --- the words that go with it --------------------------------------------------------

t('the text says what is on the other end of the link', () => {
    // In a chat window the URL is opaque: a row of query parameters says nothing,
    // and "have a listen to this" with no frequency in it does not get clicked.
    assert.strictEqual(
        shareText({ tuning: TUNING, receiver: { callsign: 'M9PSY' } }),
        'Listening to 14.175 MHz USB on M9PSY',
    );
    assert.strictEqual(shareText({ tuning: TUNING }), 'Listening to 14.175 MHz USB');
    assert.strictEqual(shareText({}), 'Listening');
});

// --- where it can be sent ---------------------------------------------------------------

t('every target builds a usable absolute link', () => {
    const url = 'https://rx.example/v2/?freq=14175000';
    const text = 'Listening to 14.175 MHz USB';
    for (const target of SHARE_TARGETS) {
        const href = target.href(url, text);
        assert.ok(/^(https:|mailto:)/.test(href), `${target.id}: ${href}`);
        // The link has to survive being embedded, which means being encoded:
        // an unescaped ? or & in a query parameter truncates it at the far end.
        assert.ok(href.includes(encodeURIComponent(url)), `${target.id} lost the url`);
        assert.ok(target.id && target.label, JSON.stringify(target));
    }
});

t('the targets are all plain web intents', () => {
    // No SDK, no script of theirs on this page: a share button must not be how a
    // tracker gets onto a receiver's front end.
    const ids = SHARE_TARGETS.map((x) => x.id);
    assert.deepStrictEqual(new Set(ids).size, ids.length, 'no duplicates');
    assert.ok(ids.includes('email'), 'email is the one everybody has');
});

// --- the view a link arrived with --------------------------------------------------------

t('a link\'s view is handed over once', () => {
    // Powering the receiver off and on again within a visit should come back to
    // the view you left, not the one the link arrived with.
    globalThis.location = { search: '?zoom_freq=14180000&zoom_bw=7.324' };
    _resetUrlView();
    const { takeUrlView } = require('./.build/share.cjs');
    assert.deepStrictEqual(takeUrlView(), { frequency: 14180000, binBandwidth: 7.324 });
    assert.strictEqual(takeUrlView(), null, 'and not a second time');
});

t('no view in the link is not an error', () => {
    globalThis.location = { search: '?freq=7100000' };
    _resetUrlView();
    const { takeUrlView } = require('./.build/share.cjs');
    assert.strictEqual(takeUrlView(), null);
});

console.log(`\n${pass} ok`);
