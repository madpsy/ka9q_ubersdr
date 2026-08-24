// The operator's page-load notice: what it will draw, and where it must not.
//
// Two things here are worth a test rather than a reading. The first is the link,
// which is the only field of a notice that can send a listener anywhere and the
// only one whose value came out of a config file. The second is the host rule,
// which is a promise made to two app stores: a notice carrying a link is not
// drawn in the iOS or Android clients, because a donate button inside an app is
// a payment link the stores require to go through their own billing — while the
// words on their own break no rule and are shown there like anywhere else. That
// rule is written so the apps have nothing to remember — they set no flag and no
// link can appear — and a test that only checked "the flag hides it" would not
// catch it being rewritten the other way up.

const assert = require('assert');

// Before the bundle: the component reaches the display settings, which read the
// browser at import time.
// A real store, because "once per visitor" is the one behaviour here that is
// kept in localStorage and the one worth proving across a reload.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
};
globalThis.document = {
    body: {},
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
// useMediaQuery reads this. `hover` decides whether the notice will hold its
// countdown for a pointer — a phone must answer no, which is what the timing
// tests below turn on.
let hoverCapable = true;
globalThis.matchMedia = (q) => ({
    matches: /hover/.test(q) ? hoverCapable : false,
    addEventListener() {}, removeEventListener() {},
});
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const {
    deep, render, reset, walk, words,
    OperatorNotice, parseNotice, parseNotices, noticeLinkOk, noticeLinksAllowedByHost,
} = require('./.build/opnotice.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// What the server would send for a plain maintenance notice.
const WIRE = {
    id: 'abc123',
    severity: 'warning',
    title: 'Antenna maintenance',
    text: 'Reception may be impacted until 18:00 UTC.',
    timeout_seconds: 3,
    dismissible: true,
    repeat: 'every-load',
};

/**
 * Mount, then render again.
 *
 * The stub calls a component once and runs the effects it registered; it does
 * not re-render when one of them sets state. This notice decides on mount
 * whether it is showing — the "once per visitor" question is asked there, not in
 * the render — so the first call always returns null and the second is the one
 * with something in it. Two calls with the hook state kept between them, which
 * is exactly what a mount followed by the re-render it caused is.
 */
// `running` is the radio's, and it is what the start overlay hides on: these are
// drawn once the front door is open and not over it. Every test that is not
// about that starts from a receiver already running.
const mount = (wire, running = true) => {
    reset();
    const notices = parseNotices([].concat(wire || []));
    const context = { server: { notices }, running };
    render(OperatorNotice, {}, context);
    return render(OperatorNotice, {}, context);
};

const withUserAgent = (ua, fn) => {
    const before = globalThis.navigator.userAgent;
    globalThis.navigator = { userAgent: ua };
    try { return fn(); } finally { globalThis.navigator = { userAgent: before }; }
};

const withHost = (host, fn) => {
    const had = 'ubersdrDesktop' in globalThis.window;
    const before = globalThis.window.ubersdrDesktop;
    if (host === undefined) delete globalThis.window.ubersdrDesktop;
    else globalThis.window.ubersdrDesktop = host;
    try { return fn(); } finally {
        if (had) globalThis.window.ubersdrDesktop = before;
        else delete globalThis.window.ubersdrDesktop;
    }
};

// The pair this exists for: a temporary outage warning and a standing donate
// button. They are different messages with different clocks, and one card
// holding both would read as "donate towards the outage".
const PAIR = [
    { id: 'warn1', severity: 'warning', title: 'Antenna maintenance', text: 'Reception may be impacted until 18:00 UTC.', timeout_seconds: 5, repeat: 'every-load', dismissible: true },
    { id: 'give1', severity: 'info', title: 'Support this receiver', text: 'Running costs are met by listeners like you.', link_url: 'https://www.paypal.com/donate?hosted_button_id=ABC', link_label: 'Donate', timeout_seconds: 0, repeat: 'once', dismissible: true },
];

// ── The host rule ───────────────────────────────────────────────────────────

t('an ordinary browser may offer a link', () => {
    assert.strictEqual(withHost(undefined, noticeLinksAllowedByHost), true);
});

t('an app may offer one only by saying so', () => {
    // The mobile clients: window.ubersdrDesktop is set, `noticeLinks` is not.
    // There is nothing for them to remember and no receiver-side setting helps.
    assert.strictEqual(withHost({ autoStart: true, chat: false }, noticeLinksAllowedByHost), false);
    // Anything short of the flag itself, in case a future host sets something
    // adjacent and expects it to count.
    for (const host of [{ noticeLinks: 'true' }, { noticeLinks: 1 }, { noticeLinks: {} }, { notice: true }]) {
        assert.strictEqual(withHost(host, noticeLinksAllowedByHost), false);
    }
    // The desktop client, which is not published to a store and opts in.
    assert.strictEqual(withHost({ noticeLinks: true }, noticeLinksAllowedByHost), true);
});

t('an app is told about the antenna, and not asked for money', () => {
    // The whole of the rule, in the case it exists for: a phone client gets the
    // outage warning and not the donate button. Nothing about the notice itself
    // differs — the same list, read by a client that may not draw a link.
    store.clear();
    const { tree } = withHost({ autoStart: true }, () => mount(PAIR));
    assert.ok(tree, 'the app was shown nothing at all');

    const cards = deep(tree).filter((n) => typeof n.props?.className === 'string'
        && n.props.className.startsWith('opnotice '));
    assert.strictEqual(cards.length, 1, `an app drew ${cards.length} cards`);
    const said = words(tree);
    assert.ok(said.includes('Antenna maintenance'), said);
    assert.ok(!said.includes('Donate'), said);
    assert.strictEqual(deep(tree).filter((n) => n.type === 'a').length, 0, 'a link reached an app');
});

t('an app does not use up the one showing of a notice it never showed', () => {
    // The donate button is "once". If the app counted it as seen, opening the
    // same receiver in a browser afterwards would find it already spent.
    store.clear();
    withHost({ autoStart: true }, () => mount(PAIR));
    assert.deepStrictEqual(JSON.parse(store.get('ubersdr.v2.notices-seen')), []);
});

t('an app whose document-start script never ran is still not asked for money', () => {
    // The gap this closes. `window.ubersdrDesktop` is set by a document-start
    // script, and an Android WebView too old for DOCUMENT_START_SCRIPT never
    // runs one — leaving the page looking exactly like an ordinary browser.
    // The user agent is set on the WebView itself and is there regardless, so
    // it is asked as well.
    store.clear();
    const ua = 'Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36 Chrome/83 Mobile Safari/537.36 UberSDR-Android/0.7.9';
    const { tree } = withUserAgent(ua, () => withHost(undefined, () => mount(PAIR)));
    assert.ok(tree, 'the app was shown nothing at all');
    assert.strictEqual(deep(tree).filter((n) => n.type === 'a').length, 0,
        'a link reached an app whose host object was missing');
    assert.ok(words(tree).includes('Antenna maintenance'), words(tree));
});

t('the desktop client is not caught by the same test', () => {
    // Its token is UberSDR-Desktop/, which must not read as a phone app: it is
    // downloaded rather than published to a store, and it says so with the flag.
    const ua = 'Mozilla/5.0 Chrome/120 Electron/28 UberSDR-Desktop/0.9.5';
    assert.strictEqual(
        withUserAgent(ua, () => withHost({ noticeLinks: true }, noticeLinksAllowedByHost)),
        true,
    );
});

// ── The clients themselves ──────────────────────────────────────────────────
//
// Everything above tests the page against a host that was described to it. What
// follows tests the descriptions: that the real clients still are what those
// tests assume. Both of the ways this promise can break silently live in files
// no other test in this directory reads —
//
//   * a mobile client gaining `noticeLinks: true`, which is one plausible line
//     in a Swift or Java string builder and would put a donate link in a store
//     build;
//   * the user-agent token being renamed, which would leave the fallback above
//     matching nothing and the whole rule resting on the injection again.
//
// Read as source rather than imported: the Swift and Java are not runnable here,
// and what is being asserted is what a reviewer would look for anyway.

const fs = require('fs');
const path = require('path');
const repo = path.join(__dirname, '..', '..', '..');
const source = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

const IOS_RECEIVER = 'clients/capacitor/ios/UberSdrPlugin/sources/ReceiverViewController.swift';
const ANDROID_RECEIVER = 'clients/capacitor/android/app/src/main/java/org/ubersdr/mobile/ReceiverActivity.java';

t('neither mobile client claims it may show links', () => {
    // The flag must be absent, not set to false: the page requires === true, so
    // absence is what carries the rule, and a client that mentions the name at
    // all is a client somebody has been editing near this.
    for (const rel of [IOS_RECEIVER, ANDROID_RECEIVER]) {
        assert.ok(
            !/noticeLinks/.test(source(rel)),
            `${rel} mentions noticeLinks — a mobile client must never claim it may draw a link, `
            + 'because a donate button inside an app is a payment link the stores require to go '
            + 'through their own billing. See noticeLinksAllowedByHost.',
        );
    }
});

t('the desktop client still opts in explicitly', () => {
    // The other half: if this were dropped, the desktop client would silently
    // stop showing operators' donate buttons and nothing else would say so.
    assert.ok(
        /noticeLinks:\s*true/.test(source('clients/electron/receiver-preload.js')),
        'the desktop preload no longer sets noticeLinks: true',
    );
});

t('the user-agent fallback still matches what the apps actually send', () => {
    // Built from the real source rather than from a copy of the token here,
    // which is the whole point: a rename in useragent.js has to fail this test
    // rather than quietly stop matching.
    const ua = source('clients/capacitor/src/useragent.js');
    const names = [...ua.matchAll(/(?:android|ios):\s*'([^']+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(names.sort(), ['Android', 'iOS'],
        'the platform names in clients/capacitor/src/useragent.js have changed');
    assert.ok(/`UberSDR\$\{NAME \? `-\$\{NAME\}`/.test(ua),
        'the product token is no longer UberSDR-<Platform>/<version>');

    for (const name of names) {
        const agent = `Mozilla/5.0 (whatever) AppleWebKit/537.36 UberSDR-${name}/9.9.9`;
        assert.strictEqual(
            withUserAgent(agent, () => withHost(undefined, noticeLinksAllowedByHost)),
            false,
            `a ${name} app user agent no longer withholds links`,
        );
    }
});

t('the desktop token is not one of them', () => {
    // Read from its own source for the same reason. If the desktop client were
    // ever renamed to something the mobile pattern matched, it would stop
    // showing links and the flag it sets would look broken.
    const desktop = source('clients/electron/useragent.js');
    const token = (desktop.match(/const PRODUCT = `([^`$]+)/) || [])[1];
    assert.ok(token && token.startsWith('UberSDR'), `unexpected desktop token: ${token}`);
    const agent = `Mozilla/5.0 Chrome/120 Electron/28 ${token}9.9.9`;
    assert.strictEqual(
        withUserAgent(agent, () => withHost({ noticeLinks: true }, noticeLinksAllowedByHost)),
        true,
        'the desktop client is being treated as a phone app',
    );
});

t('a text-only notice reaches an app', () => {
    store.clear();
    const { tree } = withHost({ autoStart: true }, () => mount(WIRE));
    assert.ok(tree, 'a message with no link was withheld from an app');
    assert.ok(words(tree).includes('Antenna maintenance'), words(tree));
});

// ── The link ────────────────────────────────────────────────────────────────

t('only http, https and mailto survive', () => {
    for (const good of [
        'https://www.paypal.com/donate?hosted_button_id=ABC',
        'http://192.168.1.10:8080/notes',
        'mailto:operator@example.com',
    ]) assert.strictEqual(noticeLinkOk(good), true, good);

    for (const bad of [
        'javascript:alert(1)',
        'JAVASCRIPT:alert(1)',
        'data:text/html,<script>x</script>',
        // Protocol-relative: no scheme to reject, and a browser follows it.
        '//evil.example/donate',
        // Relative, which would resolve against the receiver's own page.
        '/admin/',
        'donate.html',
        '',
    ]) assert.strictEqual(noticeLinkOk(bad), false, bad);
});

t('a bad link is dropped and the words are kept', () => {
    const n = parseNotice({ ...WIRE, link_url: 'javascript:alert(1)', link_label: 'Donate' });
    assert.strictEqual(n.link, null);
    assert.strictEqual(n.text, WIRE.text);
});

// ── What parseNotice will hand the component ────────────────────────────────

t('nothing to say is no notice', () => {
    assert.strictEqual(parseNotice(null), null);
    assert.strictEqual(parseNotice({}), null);
    assert.strictEqual(parseNotice({ title: '  ', text: '' }), null);
});

t('an unknown severity is drawn as info rather than not at all', () => {
    assert.strictEqual(parseNotice({ ...WIRE, severity: 'catastrophic' }).severity, 'info');
});

t('one that can neither time out nor close is given a close button', () => {
    // Whatever the config said: the alternative is a box over somebody's
    // spectrum for as long as the tab is open.
    const n = parseNotice({ ...WIRE, timeout_seconds: 0, dismissible: false });
    assert.strictEqual(n.seconds, 0);
    assert.strictEqual(n.dismissible, true);
});

t('a timeout out of range is clamped, not dropped', () => {
    assert.strictEqual(parseNotice({ ...WIRE, timeout_seconds: 9999 }).seconds, 60);
    assert.strictEqual(parseNotice({ ...WIRE, timeout_seconds: -5 }).seconds, 0);
    assert.strictEqual(parseNotice({ ...WIRE, timeout_seconds: 'soon' }).seconds, 3);
});

// ── The render ──────────────────────────────────────────────────────────────

t('a browser draws the words, the tone and the button', () => {
    const { tree } = withHost(undefined, () => mount({
        ...WIRE,
        link_url: 'https://www.paypal.com/donate?hosted_button_id=ABC',
        link_label: 'Donate',
    }));
    assert.ok(tree, 'nothing was drawn');

    const text = words(tree);
    assert.ok(text.includes('Antenna maintenance'), text);
    assert.ok(text.includes('Donate'), text);

    const nodes = deep(tree);
    const box = nodes.find((n) => typeof n.props?.className === 'string' && n.props.className.startsWith('opnotice '));
    assert.ok(box, 'no notice box');
    assert.ok(box.props.className.includes('is-warning'), box.props.className);

    const link = nodes.find((n) => n.type === 'a');
    assert.ok(link, 'no link element');
    assert.strictEqual(link.props.href, 'https://www.paypal.com/donate?hosted_button_id=ABC');
    assert.strictEqual(link.props.target, '_blank');
    // noopener keeps the new tab from reaching back through window.opener;
    // noreferrer keeps which receiver somebody came from out of it.
    assert.ok(link.props.rel.includes('noopener'), link.props.rel);
    assert.ok(link.props.rel.includes('noreferrer'), link.props.rel);
});

t('the operator cannot inject an element, only text', () => {
    const { tree } = withHost(undefined, () => mount({ ...WIRE, text: '<img src=x onerror=alert(1)>' }));
    // It reaches the tree as a string, which React escapes. What must not exist
    // anywhere in this component is the other route.
    assert.ok(words(tree).includes('<img src=x onerror=alert(1)>'));
    for (const n of deep(tree)) {
        assert.ok(!n.props || n.props.dangerouslySetInnerHTML === undefined,
            'the notice has an innerHTML path — see ui_config_notice.go for why it must not');
    }
});

// ── The countdown, and what may stop it ─────────────────────────────────────
//
// A five-second notice that stayed half a minute on a phone is what these are
// for. A touch synthesises `mouseenter` and no `mouseleave` follows until the
// pointer moves to another element — the next tap somewhere else — so the hold
// went on and never came off. See the note on `hoverable`.
//
// The hold is not visible in the rendered tree, so it is observed where it acts:
// on the timer. A held card is one whose timeout was cleared.

const cardOf = (tree) => deep(tree).find((n) => typeof n.props?.className === 'string'
    && n.props.className.startsWith('opnotice '));

// A five-second notice, as reported.
const FIVE = { ...WIRE, id: 'five', timeout_seconds: 5 };

/** Run `fn` with the clock recorded rather than running. */
function withRecordedTimers(fn) {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const set = [];
    const cleared = [];
    globalThis.setTimeout = (cb, ms) => { set.push({ id: set.length + 1, cb, ms }); return set.length; };
    globalThis.clearTimeout = (id) => { cleared.push(id); };
    try {
        return fn({ set, cleared });
    } finally {
        globalThis.setTimeout = realSet;
        globalThis.clearTimeout = realClear;
    }
}

const showing = (context) => {
    reset();
    render(OperatorNotice, {}, context);
    return render(OperatorNotice, {}, context);
};

t('the countdown is the one the operator set', () => {
    store.clear();
    withRecordedTimers(({ set }) => {
        withHost(undefined, () => showing({ server: { notices: parseNotices([FIVE]) }, running: true }));
        assert.strictEqual(set.length, 1, `scheduled ${set.length} timers, want 1`);
        assert.strictEqual(set[0].ms, 5000);
    });
});

t('a touch does not stop the clock', () => {
    store.clear();
    hoverCapable = false;                       // a phone: (hover: hover) is no
    try {
        withRecordedTimers(({ set, cleared }) => {
            const context = { server: { notices: parseNotices([FIVE]) }, running: true };
            const { tree } = showing(context);
            assert.strictEqual(set.length, 1, 'the notice never got a clock');

            // A WebView synthesising a mouse enter over the card — a tap, or one
            // dispatched at the last touch point as the card appeared under it.
            // No leave will ever follow.
            cardOf(tree).props.onPointerEnter({ pointerType: 'mouse' });
            render(OperatorNotice, {}, context);

            assert.deepStrictEqual(cleared, [],
                'the clock was stopped by a touch, and nothing would ever restart it');
        });
    } finally {
        hoverCapable = true;
    }
});

t('a finger on a machine that also has a mouse does not stop it either', () => {
    // The hybrid: the query says the device can hover, and the pointer that
    // arrived is still a finger.
    store.clear();
    withRecordedTimers(({ cleared }) => {
        const context = { server: { notices: parseNotices([FIVE]) }, running: true };
        const { tree } = showing(context);
        cardOf(tree).props.onPointerEnter({ pointerType: 'touch' });
        render(OperatorNotice, {}, context);
        assert.deepStrictEqual(cleared, []);
    });
});

t('a real pointer still holds it, and letting go starts it again', () => {
    // The behaviour being protected: a few seconds is not long to read a
    // sentence and decide whether to press the link in it.
    store.clear();
    withRecordedTimers(({ set, cleared }) => {
        const context = { server: { notices: parseNotices([FIVE]) }, running: true };
        const { tree } = showing(context);

        cardOf(tree).props.onPointerEnter({ pointerType: 'mouse' });
        render(OperatorNotice, {}, context);
        assert.deepStrictEqual(cleared, [1], 'a mouse over the card did not hold it');

        cardOf(tree).props.onPointerLeave();
        render(OperatorNotice, {}, context);
        assert.strictEqual(set.length, 2, 'letting go did not start the clock again');
        assert.strictEqual(set[1].ms, 5000);
    });
});

// ── Not until the front door is open ────────────────────────────────────────

t('nothing is drawn while the start overlay is up', () => {
    store.clear();
    const { tree } = withHost(undefined, () => mount(PAIR, false));
    assert.strictEqual(tree, null);
});

t('a "once" notice is not spent behind the overlay', () => {
    // The failure worth guarding: counted as shown while nobody could see it,
    // a once-per-visitor notice would be gone for good without ever appearing.
    store.clear();
    withHost(undefined, () => mount(PAIR, false));
    assert.deepStrictEqual(JSON.parse(store.get('ubersdr.v2.notices-seen') || '[]'), []);
});

t('they appear when the receiver starts', () => {
    // The same component, the same notices, the overlay gone — which is what
    // pressing Start does, and what the apps do to themselves on load.
    store.clear();
    reset();
    const notices = parseNotices(PAIR);
    const waiting = { server: { notices }, running: false };
    render(OperatorNotice, {}, waiting);
    assert.strictEqual(render(OperatorNotice, {}, waiting).tree, null);

    const started = { server: { notices }, running: true };
    render(OperatorNotice, {}, started);
    const { tree } = render(OperatorNotice, {}, started);
    assert.ok(tree, 'nothing appeared after the receiver started');
    assert.ok(words(tree).includes('Antenna maintenance'), words(tree));
});

// ── More than one ───────────────────────────────────────────────────────────

t('both are drawn, in the order the operator wrote them', () => {
    store.clear();
    const { tree } = withHost(undefined, () => mount(PAIR));
    assert.ok(tree, 'nothing was drawn');

    const cards = deep(tree).filter((n) => typeof n.props?.className === 'string'
        && n.props.className.startsWith('opnotice '));
    assert.strictEqual(cards.length, 2, `drew ${cards.length} cards`);
    assert.ok(cards[0].props.className.includes('is-warning'), cards[0].props.className);
    assert.ok(cards[1].props.className.includes('is-info'), cards[1].props.className);

    const said = words(tree);
    assert.ok(said.includes('Antenna maintenance'), said);
    assert.ok(said.includes('Donate'), said);

    // Only the one with a link has a button — the warning must not inherit it.
    const links = deep(tree).filter((n) => n.type === 'a');
    assert.strictEqual(links.length, 1);
    assert.ok(links[0].props.href.includes('paypal'), links[0].props.href);
});

t('a card already seen does not suppress its neighbour', () => {
    // The donate button is "once"; the outage warning is "every load". A
    // returning visitor gets the warning and not the button — the failure this
    // guards against is one stored id silencing the whole layer.
    store.clear();
    assert.strictEqual(deep(withHost(undefined, () => mount(PAIR)).tree)
        .filter((n) => typeof n.props?.className === 'string' && n.props.className.startsWith('opnotice ')).length, 2);

    const second = withHost(undefined, () => mount(PAIR));
    const cards = deep(second.tree).filter((n) => typeof n.props?.className === 'string'
        && n.props.className.startsWith('opnotice '));
    assert.strictEqual(cards.length, 1, 'the every-load warning went with the once-only donate button');
    assert.ok(words(second.tree).includes('Antenna maintenance'), words(second.tree));
});

t('what is remembered is pruned to what the receiver still offers', () => {
    store.clear();
    withHost(undefined, () => mount(PAIR));
    assert.deepStrictEqual(JSON.parse(store.get('ubersdr.v2.notices-seen')), ['give1']);

    // The operator deletes the donate button and adds a different once-only
    // message. The old id goes with it rather than sitting in the browser for
    // the life of the install.
    const later = [{ id: 'thanks1', text: 'Thank you — the antenna is back.', repeat: 'once' }];
    withHost(undefined, () => mount(later));
    assert.deepStrictEqual(JSON.parse(store.get('ubersdr.v2.notices-seen')), ['thanks1']);
});

t('a malformed entry does not take the others with it', () => {
    store.clear();
    const list = parseNotices([PAIR[0], { title: '   ', text: '' }, PAIR[1]]);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[1].id, 'give1');
});

t('no more than three are drawn', () => {
    store.clear();
    const many = [1, 2, 3, 4, 5].map((i) => ({ id: `n${i}`, text: `Message ${i}` }));
    assert.strictEqual(parseNotices(many).length, 3);
});

// ── "Once per visitor", and the end of it ───────────────────────────────────

t('a notice already seen is not shown again', () => {
    store.clear();
    const once = { ...WIRE, repeat: 'once' };
    assert.ok(withHost(undefined, () => mount(once)).tree, 'it was not shown the first time');

    // The next page load, with the same notice still set.
    assert.strictEqual(withHost(undefined, () => mount(once)).tree, null);
});

t('an edited notice is shown again even to somebody who dismissed the last one', () => {
    // The whole point of the id being a digest of the wording. An operator who
    // moves "back at 16:00" to "back at 18:00" has said something new, and the
    // people who most need to hear it are exactly the ones who read the first
    // one and closed it.
    store.clear();
    const before = { ...WIRE, id: 'aaa', repeat: 'once', text: 'Back on air at 16:00 UTC.' };
    assert.ok(withHost(undefined, () => mount(before)).tree);
    assert.strictEqual(withHost(undefined, () => mount(before)).tree, null);

    const after = { ...WIRE, id: 'bbb', repeat: 'once', text: 'Back on air at 18:00 UTC.' };
    const shown = withHost(undefined, () => mount(after));
    assert.ok(shown.tree, 'the reworded notice was swallowed by the old one having been seen');
    assert.ok(words(shown.tree).includes('18:00'), words(shown.tree));

    // And the new one now takes the old one's place, rather than both being
    // remembered — one operator, one notice at a time.
    assert.strictEqual(withHost(undefined, () => mount(after)).tree, null);
});

t('every-load ignores what was seen before', () => {
    store.clear();
    store.set('ubersdr.v2.notices-seen', JSON.stringify([WIRE.id]));
    const { tree } = withHost(undefined, () => mount(WIRE));
    assert.ok(tree, 'an every-load notice was suppressed by a stored id');
});

t('no notice, no layer', () => {
    const { tree } = withHost(undefined, () => mount([]));
    assert.strictEqual(tree, null);
});

t('a notice with no server config at all', () => {
    reset();
    render(OperatorNotice, {}, { server: undefined });
    const { tree } = render(OperatorNotice, {}, { server: undefined });
    assert.strictEqual(tree, null);
});

console.log(`\n${pass} passed`);
