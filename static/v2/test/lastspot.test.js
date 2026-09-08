// The callsign panel's last-heard line: the query behind it, and what it says.
//
// The line answers "have we heard this station, and when" from the DX cluster
// addon's spot archive, in one row under the QRZ details. Three things here
// that nothing else can reach.
//
// The QUERY is a contract with somebody else's server — ubersdr_dxcluster's
// /api/search — and it is deliberately not the one the search modal builds. It
// matches the callsign exactly rather than as a prefix, and getting that wrong
// does not fail: a prefix search for M0AB finds M0ABC's spots and the panel
// reports them under M0AB, which reads as an answer.
//
// The STATES are three and they must not collapse into two. A station heard
// three weeks ago, a station never heard, and an addon that did not answer are
// different facts, and the last of them has to look like silence rather than
// like "never heard".
//
// And the RENDER, for the reason hookStub.js exists: a component referenced
// before it is imported builds cleanly and blanks the panel.

const assert = require('assert');

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.location = { protocol: 'https:', host: 'rx.example' };
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.AbortController = globalThis.AbortController || class {
    constructor() { this.signal = { aborted: false }; }

    abort() { this.signal.aborted = true; }
};

// Every URL asked for, so a test can assert on the query rather than on what
// came back from it.
const asked = [];
const SPOT = {
    stream: 'cwskimmer', timestamp: '2026-09-07T13:51:46Z', band: '15m',
    callsign: 'ZA1RR', freq_hz: 21016700, snr: 24, country: 'Albania',
    country_code: 'AL', mode: 'CW', spotter: 'MM9PSY', wpm: 27, comment: 'CQ',
};

let answer = { spots: [SPOT] };
globalThis.fetch = (url) => {
    asked.push(String(url));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
};

const {
    deep, render, reset, walk, words,
    LastSpot, DotList, LAST_SPOT_DAYS, dxClusterAvailable, fetchLastSpot, heardHere,
    lastSpotUrl, modeLabel, receiverMode, spotAge,
} = require('./.build/lastspot.cjs');

let pass = 0;
const pending = [];
function mount(Component, props, ctx) {
    const out = render(Component, props, ctx);
    pending.push(...out.cleanups);
    return out;
}
function drain() {
    while (pending.length) {
        const off = pending.pop();
        try { off(); } catch (e) { /* a cleanup that throws is its own failure */ }
    }
}

const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    finally { drain(); }
};

// The fetch is real time, so the render tests are async.
const at = [];
const ta = (name, fn) => at.push([name, fn]);

/** The radio the row tunes, and what it was asked to do. */
const tuned = [];
const radioCtx = {
    actions: {
        tuneTo: (req) => tuned.push(req),
        ensureVisible: () => {},
    },
};

/** The tune button in a rendered row, if it drew one. */
const tuneButton = (tree) => deep(tree).find((n) => (
    n.props && typeof n.props.onClick === 'function'
    && /cs-lastspot__tune/.test(String(n.props.className || ''))
));

const query = (call) => new URLSearchParams(lastSpotUrl(call).split('?')[1]);

// ── The query ───────────────────────────────────────────────────────────────

t('the callsign matches exactly, never as a prefix', () => {
    // The difference from the search modal, and the reason this builds its own
    // query. `callsign=M0AB` is LIKE 'M0AB%' server-side: it finds M0ABC and
    // the panel would print M0ABC's spot under the heading M0AB.
    const q = query('M0AB');
    assert.strictEqual(q.get('callsign_exact'), 'M0AB');
    assert.strictEqual(q.get('callsign'), null);
});

t('the window is the whole retention, not the modal’s day', () => {
    // "Not heard" is only worth saying over everything the archive keeps, and a
    // station heard three weeks ago is the answer that makes the line worth
    // having.
    assert.strictEqual(query('M0AB').get('days'), String(LAST_SPOT_DAYS));
    assert.strictEqual(query('M0AB').get('hours'), null);
});

t('one row, newest first, and no count', () => {
    const q = query('M0AB');
    assert.strictEqual(q.get('limit'), '1');
    assert.strictEqual(q.get('sort'), 'ts');
    assert.strictEqual(q.get('order'), 'desc');
    // The row is the answer. The total is what the count costs, and the addon
    // documents count=none as the cheapest form.
    assert.strictEqual(q.get('count'), 'none');
});

t('the anonymous voice callsign is excluded here too', () => {
    // N0CALL is this receiver noticing that somebody was talking, not a
    // station. A lookup of it would otherwise answer with itself.
    assert.strictEqual(query('M0AB').get('callsign_exclude'), 'N0CALL');
});

t('the callsign is trimmed and upper-cased', () => {
    assert.strictEqual(query(' za1rr ').get('callsign_exact'), 'ZA1RR');
});

t('the URL is the addon proxy path, not the addon host', () => {
    assert.ok(lastSpotUrl('ZA1RR').startsWith('/addon/dxcluster/api/search?'), lastSpotUrl('ZA1RR'));
});

t('the addon has to be listed before any of this is asked for', () => {
    assert.ok(dxClusterAvailable({ addons: ['sstv', 'DXCluster'] }));
    assert.ok(!dxClusterAvailable({ addons: ['sstv'] }));
    assert.ok(!dxClusterAvailable({}));
    assert.ok(!dxClusterAvailable(null));
});

// ── The age ─────────────────────────────────────────────────────────────────

t('the age carries days, which the spots panels do not', () => {
    const now = Date.parse('2026-09-08T12:00:00Z');
    assert.strictEqual(spotAge('2026-09-08T11:59:31Z', now), 'just now');
    assert.strictEqual(spotAge('2026-09-08T11:20:00Z', now), '40m ago');
    assert.strictEqual(spotAge('2026-09-08T04:00:00Z', now), '8h ago');
    // lib/spots.js stops at hours because nothing in those lists is older. This
    // window is a month, and "504h ago" is not an answer anybody reads.
    assert.strictEqual(spotAge('2026-08-18T12:00:00Z', now), '21d ago');
    assert.strictEqual(spotAge('nonsense', now), '');
});

// ── The mode ────────────────────────────────────────────────────────────────
//
// Half the answer the line exists to give. Three of the five streams record it
// as a column; the two that do not keep it in free text, or do not have it.

t('a stream with a mode column is quoted, not parsed', () => {
    assert.strictEqual(modeLabel({ stream: 'decoder', mode: 'FT8' }), 'FT8');
    assert.strictEqual(modeLabel({ stream: 'cwskimmer', mode: 'CW' }), 'CW');
    assert.strictEqual(modeLabel({ stream: 'voice', voice_mode: 'LSB' }), 'LSB');
});

t('an upstream spot’s comment is read for the mode', () => {
    // The two shapes the worldwide cluster actually sends, measured against a
    // week of this receiver's archive.
    assert.strictEqual(modeLabel({ comment: 'FT8 1519Z' }), 'FT8');
    assert.strictEqual(modeLabel({ comment: 'CW 1512Z' }), 'CW');
    // Not only as the first word. A quarter of the upstream comments that name
    // a mode name it in the middle of something else.
    assert.strictEqual(modeLabel({ comment: '100th PKP SSB 1517Z' }), 'SSB');
});

t('WPM means CW, whatever else the comment says', () => {
    // A spot the upstream cluster relayed from somebody else's skimmer: a dB
    // figure and a speed, and no mode word at all. The dB is written the same
    // way a digital decode is, so this has to be decided before anything else.
    assert.strictEqual(modeLabel({ comment: '13 dB 23 WPM CQ' }), 'CW');
});

t('a local spot is voice, which is what a local spot is', () => {
    assert.strictEqual(modeLabel({ stream: 'localspot', comment: '[Voice] Paolo' }), 'Voice');
});

t('a comment with no mode in it stays blank rather than guessing', () => {
    // receiverMode guesses — it has to, or the search modal grows rows that
    // cannot be clicked. This does not: a sideband worked out from the
    // frequency is a decision about the dial, and printing it beside a measured
    // FT8 would make the two look like the same kind of fact.
    assert.strictEqual(modeLabel({ comment: '1515Z' }), '');
    assert.strictEqual(modeLabel({ comment: 'calling dx 1517Z' }), '');
    assert.strictEqual(modeLabel({ comment: 'EU-015 1518Z' }), '');
    assert.strictEqual(modeLabel({ comment: 'WWFF FFF-1351' }), '');
    assert.strictEqual(modeLabel({}), '');
});

t('a grid square is not a mode', () => {
    // Why AM and FM are read only as a leading word and never scanned for:
    // half the Maidenhead field pairs are mode names, and FM15 in an island
    // reference is the commonest comment on the cluster that would have caught
    // one.
    assert.strictEqual(modeLabel({ comment: 'NA-67, Ocracoke Is, NC FM15 1515Z' }), '');
    assert.strictEqual(modeLabel({ comment: 'FM 145500 1515Z' }), 'FM');
});

// ── Whose ear ───────────────────────────────────────────────────────────────

t('the receiver’s own streams are told apart from the world’s', () => {
    // "We heard this station an hour ago" and "somebody in France did" are
    // different claims, and the row's key is which.
    assert.ok(heardHere({ stream: 'decoder' }));
    assert.ok(heardHere({ stream: 'cwskimmer' }));
    assert.ok(heardHere({ stream: 'voice' }));
    assert.ok(heardHere({ stream: 'localspot' }));
    assert.ok(!heardHere({ stream: 'dxcluster' }));
    assert.ok(!heardHere(null));
});

// ── Where it tunes ──────────────────────────────────────────────────────────
//
// The mode the line shows and the mode the dial is put into are worked out from
// the same reading, so a row that says CW cannot tune to LSB.

t('CW takes the sideband its band is worked on', () => {
    assert.strictEqual(receiverMode({ mode: 'CW', freq_hz: 7012700 }), 'cwl');
    assert.strictEqual(receiverMode({ mode: 'CW', freq_hz: 21016700 }), 'cwu');
    // And from a comment, which is how the upstream cluster says it. This is
    // the pair that disagreed while the label and the dial were worked out
    // separately: the row read CW and the receiver went to LSB.
    assert.strictEqual(receiverMode({ comment: 'CW 1512Z', freq_hz: 7012700 }), 'cwl');
    assert.strictEqual(receiverMode({ comment: '13 dB 23 WPM CQ', freq_hz: 21016700 }), 'cwu');
});

t('a digital mode is upper sideband on every band', () => {
    // FT8 on 40 m is 7074 USB. The split that is right for CW would put it on
    // LSB, where it is silent in a way that reads as a broken receiver.
    assert.strictEqual(receiverMode({ mode: 'FT8', freq_hz: 7074000 }), 'usb');
    assert.strictEqual(receiverMode({ mode: 'WSPR', freq_hz: 3568600 }), 'usb');
    assert.strictEqual(receiverMode({ comment: 'FT8 1519Z', freq_hz: 7074000 }), 'usb');
});

t('an upstream or local spot with no mode is SSB, by the band', () => {
    // Somebody was talking, so the only question left is which sideband — and
    // that is a property of the band rather than of the spot.
    assert.strictEqual(receiverMode({ stream: 'dxcluster', comment: '1515Z', freq_hz: 7143000 }), 'lsb');
    assert.strictEqual(receiverMode({ stream: 'dxcluster', comment: 'POTA 1512Z', freq_hz: 14200000 }), 'usb');
    assert.strictEqual(receiverMode({ stream: 'localspot', comment: '[Voice] Paolo', freq_hz: 7157000 }), 'lsb');
    assert.strictEqual(receiverMode({ stream: 'localspot', comment: '[Voice] Club', freq_hz: 14313000 }), 'usb');
});

t('a sideband the spotter named is taken as given', () => {
    assert.strictEqual(receiverMode({ voice_mode: 'LSB', freq_hz: 7150000 }), 'lsb');
    assert.strictEqual(receiverMode({ voice_mode: 'USB', freq_hz: 14250000 }), 'usb');
    // Against the split, deliberately: 3615 USB is unusual and is what the
    // spotter said.
    assert.strictEqual(receiverMode({ comment: 'USB net 1400Z', freq_hz: 3615000 }), 'usb');
});

t('the label and the dial can never disagree', () => {
    // The property this unification exists for, over every comment shape the
    // archive actually holds.
    const DIAL = {
        CW: ['cwl', 'cwu'], USB: ['usb', 'usb'], LSB: ['lsb', 'lsb'],
        SSB: ['lsb', 'usb'], Voice: ['lsb', 'usb'], AM: ['am', 'am'], FM: ['fm', 'fm'],
        '': ['lsb', 'usb'],
    };
    const rows = [
        { mode: 'CW' }, { mode: 'FT8' }, { voice_mode: 'USB' },
        { comment: 'CW 1512Z' }, { comment: '13 dB 23 WPM CQ' }, { comment: 'FT8 1519Z' },
        { comment: '100th PKP SSB 1517Z' }, { comment: '[Voice] Paolo' },
        { comment: 'FM 145500' }, { comment: '1515Z' }, { comment: 'POTA' },
    ];
    for (const base of rows) {
        for (const [i, hz] of [7100000, 14200000].entries()) {
            const spot = { ...base, freq_hz: hz };
            const label = modeLabel(spot);
            const dial = receiverMode(spot);
            const want = DIAL[label] || (label ? ['usb', 'usb'] : null);
            assert.ok(want, `no expectation for label ${label}`);
            assert.strictEqual(dial, want[i], `${JSON.stringify(spot)} → ${label} but ${dial}`);
        }
    }
});

// ── The separators ──────────────────────────────────────────────────────────
//
// Both rows this panel added wrap in a side dock, and a middot typed between
// two values ends up at the end of a line with nothing after it to separate.
// DotList draws them in the gap instead and takes away whichever one lands at a
// wrap. The measurement is DOM, so what is checked here is the part that is
// not: which items get drawn, and which of them the CSS will put a dot on.

const parts = (tree) => deep(tree).filter((n) => (
    n.props && /\bdots__part\b/.test(String(n.props.className || ''))
));

t('a value the lookup did not carry is left out, not drawn empty', () => {
    // A country with no CQ or ITU zone would otherwise be three items, and the
    // CSS puts a dot before every item after the first — so an empty one is a
    // dot with nothing on either side of it.
    reset();
    const { tree } = render(DotList, { parts: ['EU', '', null] });
    assert.strictEqual(parts(tree).length, 1);
    assert.strictEqual(words(tree), 'EU');
});

t('the dots are on by default, and taken away only by a measurement', () => {
    // The first render has not been laid out — every element measures zero — and
    // a separator that blinks in on the second frame is worse than one that
    // blinks out. So nothing is marked as beginning a line until something has
    // measured that it does.
    reset();
    const { tree } = render(DotList, { parts: ['EU', 'CQ 14', 'ITU 27'] });
    const items = parts(tree);
    assert.strictEqual(items.length, 3);
    for (const it of items.slice(1)) {
        assert.ok(!/dots__part--line/.test(it.props.className), it.props.className);
    }
});

t('the rule that removes a dot can actually beat the one that draws it', () => {
    // The bug this is here for shipped looking exactly like a broken
    // measurement: the class was on the element, the hook was right about which
    // parts began a line, and the dot was drawn at the start of every wrapped
    // line anyway.
    //
    // `.dots__part + .dots__part::before` is two classes and a pseudo-element,
    // (0,2,1). A bare `.dots__part--line::before` is one class and a
    // pseudo-element, (0,1,1), and loses — so `content: none` never applied.
    // Nothing in JavaScript can see that, which is why it is checked here.
    const fs = require('fs');
    const path = require('path');
    // Comments out first: the note above the rule below names both selectors,
    // and a `[^{}]*` reading back from a brace happily swallows it — which
    // counted the classes in the prose and made a broken rule measure as a
    // winning one. This check had that bug before the CSS did.
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ');

    // Classes, attribute selectors and pseudo-classes count as one each;
    // pseudo-elements as an element. The pseudo-elements come out of the
    // selector first, because `::before` ends in something that reads exactly
    // like the pseudo-class `:before` and counting it as one was this check's
    // own version of the bug it is here to catch — it made the two rules tie,
    // and the tie-break passed.
    const specificity = (sel) => {
        const els = (sel.match(/::[\w-]+/g) || []).length;
        const rest = sel.replace(/::[\w-]+/g, '');
        const cls = (rest.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?/g) || []).length;
        return [cls, els];
    };
    const ruleFor = (marker) => {
        const re = new RegExp(`([^{}]*${marker}[^{}]*)\\{([^}]*)\\}`, 'g');
        return [...css.matchAll(re)];
    };

    const draws = ruleFor('dots__part\\s*\\+\\s*\\.dots__part::before')
        .find((m) => /content:\s*'·'/.test(m[2]));
    assert.ok(draws, 'the dot is no longer drawn by an adjacent-sibling rule');

    const removes = [...css.matchAll(/([^{}]*dots__part--line[^{}]*)\{([^}]*)\}/g)]
        .find((m) => /content:\s*none/.test(m[2]));
    assert.ok(removes, 'nothing takes the dot away from a part that begins a line');

    const [dc, dp] = specificity(draws[1]);
    const [rc, rp] = specificity(removes[1]);
    assert.ok(rc > dc || (rc === dc && rp >= dp),
        `the removing rule (${rc},${rp}) cannot beat the drawing rule (${dc},${dp})`);
    // A tie is settled by document order, so it has to come second.
    if (rc === dc && rp === dp) {
        assert.ok(css.indexOf(removes[0]) > css.indexOf(draws[0]),
            'the removing rule ties on specificity but is written first, so it loses');
    }
});

t('the caller’s class is kept, not replaced', () => {
    // kv__v is what makes it a reading in the list — right-aligned, monospace.
    // Dropping it would leave the row looking like a paragraph.
    reset();
    const { tree } = render(DotList, { parts: ['EU'], className: 'kv__v' });
    const box = deep(tree).find((n) => n.props && /\bdots\b/.test(String(n.props.className || '')));
    assert.ok(box, 'no dots box');
    assert.ok(/kv__v/.test(box.props.className), box.props.className);
});

// ── The fetch ───────────────────────────────────────────────────────────────

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

ta('an empty callsign asks nothing', async () => {
    asked.length = 0;
    assert.strictEqual(await fetchLastSpot(''), null);
    assert.deepStrictEqual(asked, []);
});

ta('nothing found is null, which is an answer', async () => {
    // Not a throw: "we have never heard this station" is a fact worth printing,
    // and only a failure is worth staying quiet about.
    answer = { spots: [] };
    assert.strictEqual(await fetchLastSpot('ZA1RR'), null);
    answer = { spots: [SPOT] };
});

ta('the addon’s own error is a rejection', async () => {
    const was = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
        ok: false, status: 503, json: () => Promise.resolve({ error: 'search is busy' }),
    });
    await assert.rejects(() => fetchLastSpot('ZA1RR'), /search is busy/);
    globalThis.fetch = was;
});

// ── The render ──────────────────────────────────────────────────────────────

ta('without the addon there is no row and no request', async () => {
    reset();
    asked.length = 0;
    const { tree } = mount(LastSpot, { call: 'ZA1RR', enabled: false }, radioCtx);
    await settle();
    assert.strictEqual(tree, null);
    assert.deepStrictEqual(asked, [], asked.join('\n'));
    drain();
});

ta('a spot reads as an age, a frequency and a mode', async () => {
    reset();
    asked.length = 0;
    answer = { spots: [SPOT] };
    mount(LastSpot, { call: 'ZA1RR', enabled: true }, radioCtx);
    await settle();

    assert.strictEqual(asked.length, 1, asked.join('\n'));
    assert.ok(/callsign_exact=ZA1RR/.test(asked[0]), asked[0]);

    // A second call with the hook state kept: the promise that resolved above
    // wrote into the same slots, so this render is the one showing the answer.
    // hookStub is not a renderer and does not do this for us.
    const { tree } = mount(LastSpot, { call: 'ZA1RR', enabled: true }, radioCtx);
    const text = words(tree);
    assert.ok(/Last heard/.test(text), text);
    assert.ok(/ago|just now/.test(text), text);
    assert.ok(/21016\.7/.test(text), text);
    assert.ok(/CW/.test(text), text);

    // The rest of the row is on the tooltip rather than in the line — the panel
    // is about the operator and this is a footnote to it.
    const cell = deep(tree).find((n) => n.props && /15m/.test(String(n.props.title || '')));
    assert.ok(cell, 'the row carried no tooltip');
    assert.ok(/de MM9PSY/.test(cell.props.title), cell.props.title);
    drain();
});

ta('the frequency tunes the receiver to the spot', async () => {
    reset();
    tuned.length = 0;
    answer = { spots: [SPOT] };
    mount(LastSpot, { call: 'ZA1RR', enabled: true }, radioCtx);
    await settle();
    const { tree } = mount(LastSpot, { call: 'ZA1RR', enabled: true }, radioCtx);

    const btn = tuneButton(tree);
    assert.ok(btn, 'the frequency was not a button');
    // 21016.7 kHz CW is above 10 MHz, so CW-U. The line says CW and the
    // tooltip says where that puts the dial.
    assert.ok(/CWU/.test(btn.props.title), btn.props.title);

    btn.props.onClick();
    assert.deepStrictEqual(tuned, [{ frequency: 21016700, mode: 'cwu' }]);
    drain();
});

ta('a spot this receiver cannot reach is text, not a dead button', async () => {
    // Shown all the same — that the station was heard is the answer — but there
    // is nowhere to send you, and a button that does nothing is worse than a
    // reading.
    reset();
    tuned.length = 0;
    answer = { spots: [{ ...SPOT, freq_hz: 144300000, band: '2m' }] };
    mount(LastSpot, { call: 'ZA1RR', enabled: true }, radioCtx);
    await settle();
    const { tree } = mount(LastSpot, { call: 'ZA1RR', enabled: true }, radioCtx);
    assert.ok(/144300\.0/.test(words(tree)), words(tree));
    assert.ok(!tuneButton(tree), 'an out-of-range spot drew a tune button');
    answer = { spots: [SPOT] };
    drain();
});

ta('never heard is said, not left blank', async () => {
    reset();
    answer = { spots: [] };
    mount(LastSpot, { call: 'ZZ9ZZZ', enabled: true }, radioCtx);
    await settle();
    const { tree } = mount(LastSpot, { call: 'ZZ9ZZZ', enabled: true }, radioCtx);
    const text = words(tree);
    assert.ok(new RegExp(`not heard in ${LAST_SPOT_DAYS} days`).test(text), text);
    answer = { spots: [SPOT] };
    drain();
});

ta('an addon that did not answer says nothing at all', async () => {
    // The state that must not collapse into "never heard". A search that failed
    // knows nothing about the station, and printing "not heard in 30 days" for
    // it would be inventing a fact about this receiver.
    reset();
    const was = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({
        ok: false, status: 503, json: () => Promise.resolve({ error: 'search is busy' }),
    });
    mount(LastSpot, { call: 'ZA1RR', enabled: true }, radioCtx);
    await settle();
    const { tree } = mount(LastSpot, { call: 'ZA1RR', enabled: true }, radioCtx);
    assert.strictEqual(tree, null);
    assert.strictEqual(walk(tree).length, 0);
    globalThis.fetch = was;
    drain();
});

(async () => {
    for (const [name, fn] of at) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
        finally { drain(); }
    }
    console.log(`\n${pass} passed`);
})();
