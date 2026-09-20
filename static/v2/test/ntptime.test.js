// The Time panel: the NTP client arithmetic it runs, and that it renders.
//
// The arithmetic is the part worth testing hardest, because every one of its errors is
// silent. A sign the wrong way round, a millisecond/second confusion, a sample window that
// never empties — none of them throws, and all of them produce a clock that looks exactly
// like a clock and is wrong. So the round trip is solved here against synthetic replies
// whose true offset is known by construction, including the asymmetric case, which is the
// one error this arithmetic cannot see and must therefore be shown to be honest about.
//
// The render half is the other class: a component used before it is defined, or a helper
// called with its arguments the other way round, builds cleanly and blanks the panel the
// moment somebody opens it. See hookStub.js.

const assert = require('assert');

// A machine that is not on UTC, fixed rather than inherited: the clock swap only exists
// where the two readings differ, so a test box that happened to be on UTC would silently
// assert nothing. Set before the bundle is required, and read by new Date() from then on.
process.env.TZ = 'Europe/London';

// Before the bundle: the panel reaches the layout and display settings on the way in, and
// both read the browser at import time.
const prefs = new Map();
globalThis.localStorage = {
    getItem: (k) => (prefs.has(k) ? prefs.get(k) : null),
    setItem: (k, v) => prefs.set(k, String(v)),
    removeItem: (k) => prefs.delete(k),
};
globalThis.document = globalThis.document || {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
    addEventListener: () => {},
    removeEventListener: () => {},
    hidden: false,
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const {
    render, reset, deep, words,
    TimePanel, PANELS, PANEL_BY_ID, GROUPS,
    DIAL_MIN_MS, MAX_SAMPLE_AGE_MS, STATUS_MAX_MS, STATUS_MIN_MS, STEP_MS, WINDOW,
    addSample, addonUrl, bestEstimate, carriedTheta, clockAsleep, clockParts, deviceError,
    deviceLabel, deviceTone, deviceWithin, dialEdge, dialPos, dialSpan, dispersionTone,
    CLOCK_KEYS, browserZone, clockFaces, faceDateAt, facePartsAt, faceFor, faceText,
    formatDur, formatMs, localIsUtc, newClock, nextFaceKey, nextSecondDelay, ntpAvailable,
    offsetText, receiverOffsetMin, referenceKey, referenceOf, sampleFrom, saveBigClock,
    saveShowRef, saveShowMs, savedBigClock, savedShowRef, savedShowMs, servingNote,
    staleStatus, stationMix, statusUrl, timeUrl, utcOffsetText, zoneOffsetMin,
} = require('./.build/ntptime.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};
// The panel reaches the radio context for one thing: the receiver's timezone, from
// /api/description. A receiver in a zone of its own by default, so the three clocks are
// three and the cycle has somewhere to go; the tests that care pass their own.
const RX_ZONE = 'America/New_York';
const context = (receiver) => ({
    serverInfo: receiver === null ? null : {
        receiver: receiver || { timezone: RX_ZONE, timezone_offset: -300 },
    },
});

const near = (got, want, tol, what) => assert.ok(
    Math.abs(got - want) <= tol,
    `${what || 'value'}: got ${got}, wanted ${want} ±${tol}`,
);

// ── The round trip ───────────────────────────────────────────────────────────

/**
 * A reply from a server whose clock is `theta` ms ahead of this page's monotonic clock,
 * reached over a path that takes `out` ms one way and `back` the other.
 *
 * Everything the panel gets is here: the two instants it measured itself (sent, got) and
 * the two the server stamped, which is exactly what /api/time carries — in seconds, as the
 * addon sends them.
 */
function roundTrip({ sent = 1000, theta = 500000, out = 25, back = 25, proc = 5 } = {}) {
    const rx = sent + out + theta;
    const tx = rx + proc;
    const got = sent + out + proc + back;
    return {
        sent,
        got,
        reply: {
            roundtrip: { receive: rx / 1000, transmit: tx / 1000 },
            clock_offset_ms: 0,
            clock_rate_ppm: 0,
        },
    };
}

t('a symmetric path recovers the offset exactly', () => {
    const { sent, got, reply } = roundTrip({ theta: 500000, out: 25, back: 25 });
    const s = sampleFrom(reply, sent, got);
    near(s.theta, 500000, 0.001, 'theta');
    near(s.delay, 50, 0.001, 'delay');
});

t('an asymmetric path is wrong by half the asymmetry, and no more', () => {
    // 20 ms out, 30 ms back: no timestamp can say which way the delay went, so the estimate
    // lands (out − back) / 2 = −5 ms from the truth. That is the error `err` exists to
    // bound, and half the round trip — 25 ms — does bound it.
    const { sent, got, reply } = roundTrip({ theta: 500000, out: 20, back: 30 });
    const s = sampleFrom(reply, sent, got);
    near(s.theta, 499995, 0.001, 'theta');
    near(s.delay, 50, 0.001, 'delay');
    const clock = addSample(newClock(), s);
    const est = bestEstimate(clock, s.at);
    near(est.err, 25, 0.001, 'err');
    assert.ok(Math.abs(est.theta - 500000) <= est.err, 'the truth is inside the bound');
});

t('the time the server held the request is not delay', () => {
    // 500 ms of processing between receive and transmit is the server thinking, not the
    // path. Counted as delay it would double the claimed uncertainty for nothing.
    const { sent, got, reply } = roundTrip({ out: 25, back: 25, proc: 500 });
    near(sampleFrom(reply, sent, got).delay, 50, 0.001, 'delay');
});

t('a reply with no round trip is not a sample', () => {
    assert.strictEqual(sampleFrom(null, 0, 1), null);
    assert.strictEqual(sampleFrom({}, 0, 1), null);
    assert.strictEqual(sampleFrom({ roundtrip: {} }, 0, 1), null);
});

// ── The filter ───────────────────────────────────────────────────────────────

const sample = (over) => ({
    theta: 0, delay: 10, at: 1000, srvOffset: null, srvRate: 0, ...over,
});

t('the least delayed sample wins, not the newest', () => {
    // The whole point of keeping eight: a sample that got through quickly has less room
    // for asymmetry in it, and is a better answer than a more recent slow one.
    let clock = newClock();
    clock = addSample(clock, sample({ theta: 10, delay: 100, at: 1000 }));
    clock = addSample(clock, sample({ theta: 12, delay: 4, at: 1100 }));
    clock = addSample(clock, sample({ theta: 30, delay: 200, at: 1200 }));
    const est = bestEstimate(clock, 1200);
    near(est.theta, 12, 0.001, 'theta');
    near(est.delay, 4, 0.001, 'delay');
});

t('the bound decays as the page clock wanders away from the sample', () => {
    const clock = addSample(newClock(), sample({ delay: 10, at: 0 }));
    const fresh = bestEstimate(clock, 0);
    const old = bestEstimate(clock, 60000);
    near(fresh.err, 5, 0.001, 'fresh');
    // 60 s at 15 ppm is 0.9 ms on top of the 5.
    near(old.err, 5.9, 0.001, 'aged');
    assert.ok(old.err > fresh.err);
});

t('jitter is the scatter of the others about the one chosen, and null alone', () => {
    let clock = addSample(newClock(), sample({ theta: 0, delay: 2, at: 1000 }));
    assert.strictEqual(bestEstimate(clock, 1000).jitter, null, 'one sample has nothing to scatter');
    clock = addSample(clock, sample({ theta: 3, delay: 50, at: 1001 }));
    clock = addSample(clock, sample({ theta: -3, delay: 50, at: 1002 }));
    near(bestEstimate(clock, 1002).jitter, 3, 0.001, 'jitter');
});

t('a sample that cannot honestly disagree is kept; one that can clears the window', () => {
    const start = addSample(newClock(), sample({ theta: 0, delay: 10, at: 1000 }));
    // Inside 10/2 + 5.0015 + STEP_MS.
    const near1 = addSample(start, sample({ theta: 20, delay: 10, at: 1100 }));
    assert.strictEqual(near1.list.length, 2, 'a plausible sample joins the window');
    // A second that says the clock is a whole second out cannot be reconciled with the
    // first: one of them describes a clock that no longer exists, and the older one loses.
    const stepped = addSample(start, sample({ theta: 1000, delay: 10, at: 1100 }));
    assert.strictEqual(stepped.list.length, 1, 'a stepped clock empties the window');
    near(bestEstimate(stepped, 1100).theta, 1000, 0.001, 'the new clock is the one kept');
    assert.ok(STEP_MS > 0);
});

t('the window is bounded by count and by age', () => {
    let clock = newClock();
    for (let i = 0; i < WINDOW + 5; i++) {
        clock = addSample(clock, sample({ theta: 0, delay: 10, at: 1000 + i }));
    }
    assert.strictEqual(clock.list.length, WINDOW, 'count');

    // Nothing arriving for longer than the window is worth: the old readings go rather
    // than being carried forward for ever at a quietly growing error.
    const aged = addSample(clock, sample({ theta: 0, delay: 10, at: 1000 + 2 * MAX_SAMPLE_AGE_MS }));
    assert.strictEqual(aged.list.length, 1, 'age');
});

t('a sample is carried across a change in the server’s own estimate', () => {
    const s = sample({ theta: 100, at: 1000, srvOffset: 50 });
    // The server has since said its own clock is 20 ms further out than when this sample
    // was taken, and nothing about the rate accounts for it. That 20 ms is a change to the
    // served time and the sample has to move with it.
    near(carriedTheta(s, { list: [s], srvOffset: 70, srvAt: 2000, srvRate: 0 }), 120, 0.001, 'step');
    // The same, less the part that is just the daemon's clock running at its measured rate,
    // which the page's clock already follows: 10 ppm over a second is 0.01 ms.
    near(carriedTheta(s, { list: [s], srvOffset: 70, srvAt: 2000, srvRate: 10 }), 119.99, 0.001, 'rate');
});

t('the machine having slept is detectable, and a first reading is not', () => {
    assert.strictEqual(clockAsleep(1000, null), false, 'nothing to compare against');
    assert.strictEqual(clockAsleep(1000, 1000.5), false, 'ordinary scheduling');
    assert.strictEqual(clockAsleep(1000, 4000), true, 'three seconds of nothing');
});

// ── This device ──────────────────────────────────────────────────────────────

t('the device error is the wall clock against the corrected time', () => {
    // performance.now() is 200, the offset to the broadcast is 500, so the broadcast reads
    // 700. This machine's wall clock says 1000, so it is 300 ms fast.
    near(deviceError({ theta: 500 }, 1000, 200), 300.5, 0.001, 'fast');
    near(deviceError({ theta: 500 }, 400, 200), -299.5, 0.001, 'slow');
    assert.strictEqual(deviceError(null, 1000, 200), null);
});

t('the likely error is quoted, capped by the bound', () => {
    near(deviceWithin({ err: 10, jitter: 3 }), 3.5, 0.001, 'jitter is the likely one');
    near(deviceWithin({ err: 10, jitter: null }), 10.5, 0.001, 'alone, the bound is all there is');
    // The scatter can come out above the bound when the other samples were slower ones.
    // The bound still holds.
    near(deviceWithin({ err: 2, jitter: 8 }), 2.5, 0.001, 'capped');
});

t('a clock inside the measurement’s own uncertainty is not called fast or slow', () => {
    assert.strictEqual(deviceLabel(2, 3.2), 'within ±3 ms');
    assert.strictEqual(deviceLabel(-2, 3.2), 'within ±3 ms');
    assert.strictEqual(deviceLabel(0.2, 0.4), 'within ±0.4 ms');
    assert.strictEqual(deviceLabel(null, 3), 'measuring…');
});

t('a clock outside it is called by how far and which way', () => {
    assert.strictEqual(deviceLabel(300.4, 3), '300 ms fast');
    assert.strictEqual(deviceLabel(-1500, 3), '1.5 s slow');
    assert.strictEqual(deviceLabel(120000, 3), '2m fast');
});

t('20 ms is the floor on a clock being fine, whatever the measurement claims', () => {
    // Below that the error is smaller than the jitter of the path it was measured over.
    assert.strictEqual(deviceTone(15, 1), 'ok');
    assert.strictEqual(deviceTone(100, 1), 'warn');
    assert.strictEqual(deviceTone(900, 1), 'bad');
    assert.strictEqual(deviceTone(null, 1), 'dim');
});

t('dispersion keeps the addon’s own thresholds', () => {
    assert.strictEqual(dispersionTone(10), 'ok');
    assert.strictEqual(dispersionTone(100), 'warn');
    assert.strictEqual(dispersionTone(300), 'bad');
    assert.strictEqual(dispersionTone(null), 'dim');
});

// ── The dial ─────────────────────────────────────────────────────────────────

t('the dial is wide enough for the marker and for the band', () => {
    assert.strictEqual(dialSpan(0, 0), DIAL_MIN_MS, 'a correct clock still gets a scale');
    assert.strictEqual(dialSpan(60, 1), 100, 'the marker fits with room to spare');
    assert.strictEqual(dialSpan(0, 40), 250, 'a wide band is not pinned to the edges');
    assert.strictEqual(dialSpan(3000, 0), 5000, 'and it keeps going');
});

t('the dial places the broadcast at the centre and clamps at the ends', () => {
    assert.strictEqual(dialPos(0, 50), 0.5);
    assert.strictEqual(dialPos(50, 50), 1);
    assert.strictEqual(dialPos(-50, 50), 0);
    assert.strictEqual(dialPos(5000, 50), 1, 'a wildly wrong clock sits on the edge, not off it');
    assert.strictEqual(dialEdge(50), '50ms');
    assert.strictEqual(dialEdge(2500), '2.5s');
});

// ── Where the time came from ─────────────────────────────────────────────────

const radioSource = (station, inUse = true) => ({ kind: 'radio', in_use: inUse, station });

t('the station mix is what is true, not the refid', () => {
    // The refid is one four-character label and has to name a single station. Two of three
    // sources on WWV and one on WWVH is not "WWVH", however the refid reads.
    const mix = stationMix([radioSource('wwv'), radioSource('wwv'), radioSource('wwvh')]);
    assert.strictEqual(mix.text, 'WWV + WWVH');
    assert.strictEqual(mix.detail, '2 × WWV, 1 × WWVH');
});

t('only sources actually in the answer count towards the mix', () => {
    assert.strictEqual(stationMix([radioSource('wwv', false)]), null);
    assert.strictEqual(stationMix([{ kind: 'ntp', in_use: true }]), null);
    assert.strictEqual(stationMix([]), null);
    assert.strictEqual(stationMix(null), null);
});

t('an unsynchronised server says so rather than naming a station', () => {
    assert.strictEqual(referenceOf(null, null).kind, 'none');
    const r = referenceOf({ synchronised: false, stratum: 16 }, null);
    assert.strictEqual(r.kind, 'none');
    assert.strictEqual(r.sub, 'unsynchronised');
});

t('a radio reference names its stations and the receivers behind them', () => {
    const r = referenceOf(
        { synchronised: true, stratum: 1, refid: 'WWV', sources_used: 2 },
        {
            served: { used_names: ['local-10', 'local-15'], sources_candidate: 3 },
            sources: [radioSource('wwv'), radioSource('wwv')],
        },
    );
    assert.strictEqual(r.kind, 'radio');
    assert.strictEqual(r.text, 'WWV');
    assert.strictEqual(r.sub, 'local-10, local-15');
    assert.ok(r.detail.includes('refid WWV'));
});

t('a failover to the network is not dressed up as stratum 1', () => {
    // The served stratum is 1 only while a radio source is in the answer. Saying it
    // regardless would be the one lie here that somebody would act on.
    const r = referenceOf(
        { synchronised: true, stratum: 4, refid: '162.159.200.123', sources_used: 1 },
        { served: { used_names: ['time.cloudflare.com'] }, sources: [{ kind: 'ntp', in_use: true }] },
    );
    assert.strictEqual(r.kind, 'ntp');
    assert.strictEqual(r.text, 'NTP');
    assert.strictEqual(r.sub, 'time.cloudflare.com');
});

t('before the source document has been read, the stratum still says which class', () => {
    const radio = referenceOf({ synchronised: true, stratum: 1, refid: 'WWV' }, null);
    assert.strictEqual(radio.kind, 'radio');
    assert.strictEqual(radio.text, 'WWV');
    const net = referenceOf({ synchronised: true, stratum: 3, refid: '1.2.3.4' }, null);
    assert.strictEqual(net.kind, 'ntp');
    assert.strictEqual(net.sub, '1.2.3.4');
});

t('the arrangement working is worth no words at all', () => {
    assert.strictEqual(servingNote(null), null);
    assert.strictEqual(servingNote({ clock: { serving: 'primary' } }), null);
});

t('the arrangement not working is', () => {
    assert.deepStrictEqual(
        servingNote({ clock: { serving: 'secondary', secondary: 'ntp' } }),
        { tone: 'bad', text: 'failed over to ntp' },
    );
    assert.strictEqual(servingNote({ clock: { serving: 'coasting' } }).tone, 'warn');
    assert.strictEqual(
        servingNote({ clock: { serving: 'primary', failover_in_seconds: 12.4 } }).text,
        'failing over in 12s',
    );
});

// ── Reading the expensive document as rarely as it can be read ───────────────

t('the status document is read once, then only when the reference moves', () => {
    const key = referenceKey({ synchronised: true, stratum: 1, refid: 'WWV', sources_used: 2 });
    assert.strictEqual(key, '1|1|WWV|2');

    assert.strictEqual(staleStatus(null, key, 0), true, 'the first read');
    assert.strictEqual(staleStatus(key, key, 1000), false, 'nothing has changed');
    assert.strictEqual(staleStatus(key, key, STATUS_MAX_MS), true, 'a source may have come or gone');

    const moved = referenceKey({ synchronised: true, stratum: 4, refid: '1.2.3.4', sources_used: 1 });
    assert.notStrictEqual(moved, key);
    assert.strictEqual(staleStatus(key, moved, 1000), false, 'not more often than the floor');
    assert.strictEqual(staleStatus(key, moved, STATUS_MIN_MS), true, 'a failover is worth a read');
});

// ── Formatting ───────────────────────────────────────────────────────────────

t('the clock is split so the fraction can be drawn smaller', () => {
    const at = Date.UTC(2026, 8, 20, 18, 42, 7, 394);
    assert.deepStrictEqual(clockParts(at, true), { hms: '18:42:07', frac: '394' });
});

t('the offset from UTC reads the way a person writes it', () => {
    assert.strictEqual(utcOffsetText({ getTimezoneOffset: () => 0 }), 'UTC+00:00');
    assert.strictEqual(utcOffsetText({ getTimezoneOffset: () => -60 }), 'UTC+01:00');
    assert.strictEqual(utcOffsetText({ getTimezoneOffset: () => 330 }), 'UTC−05:30');
    assert.strictEqual(localIsUtc({ getTimezoneOffset: () => 0 }), true);
    assert.strictEqual(localIsUtc({ getTimezoneOffset: () => -60 }), false);
});

t('durations and millisecond figures are sized to what they are', () => {
    assert.strictEqual(formatDur(4), '4s');
    assert.strictEqual(formatDur(300), '5m');
    assert.strictEqual(formatDur(7200), '2.0h');
    assert.strictEqual(formatDur(null), 'never');
    assert.strictEqual(formatMs(4.23), '4.2');
    assert.strictEqual(formatMs(42.3), '42');
    assert.strictEqual(formatMs(null), '—');
});

// ── The addon, and the panel ─────────────────────────────────────────────────

t('the panel belongs to a receiver that runs the addon and to no other', () => {
    assert.strictEqual(ntpAvailable({ addons: ['sstv', 'ntp', 'lightning'] }), true);
    assert.strictEqual(ntpAvailable({ addons: ['NTP'] }), true, 'however it is cased');
    assert.strictEqual(ntpAvailable({ addons: ['lightning'] }), false);
    assert.strictEqual(ntpAvailable({ addons: [] }), false);
    assert.strictEqual(ntpAvailable({}), false);
    assert.strictEqual(ntpAvailable(null), false);
    assert.strictEqual(addonUrl(), '/addon/ntp/');
    assert.strictEqual(statusUrl(), '/addon/ntp/api/status');
    // The sequence number defeats any cache between here and the daemon. A cached time is
    // not a time.
    assert.strictEqual(timeUrl(7), '/addon/ntp/api/time?seq=7');
});

t('it is registered, gated on the addon, and named in exactly one group', () => {
    const p = PANEL_BY_ID.time;
    assert.ok(p, 'no `time` panel in the registry');
    assert.strictEqual(p.title, 'Time');
    assert.strictEqual(p.minimal, true, 'the panel declares a minimal view');
    assert.strictEqual(typeof p.requires, 'function');
    assert.strictEqual(p.requires({ addons: ['ntp'] }), true);
    assert.strictEqual(p.requires({ addons: [] }), false);
    assert.ok(PANELS.includes(p));

    const groups = GROUPS.filter((g) => g.panels.includes('time')).map((g) => g.id);
    assert.deepStrictEqual(groups.length, 1, `named in ${groups.length} groups: ${groups}`);
});

// The receiver is stopped and nothing is on screen, which is the state the panel mounts in:
// the feed gate starts closed. So this proves the render path without opening a connection,
// which is also the assertion that it does not open one.
t('it renders, and mounting it while the receiver is stopped fetches nothing', () => {
    reset();
    let fetched = 0;
    const was = globalThis.fetch;
    globalThis.fetch = () => { fetched++; return Promise.reject(new Error('no')); };
    try {
        const { tree, cleanups } = render(TimePanel, {}, context());
        assert.ok(tree, 'rendered nothing at all');
        const classes = deep(tree).map((n) => (n.props && n.props.className) || '').join(' ');
        assert.ok(classes.includes('tm__hms'), 'no clock in the panel');
        assert.ok(classes.includes('tm__ref-pill'), 'no reference in the panel');
        assert.ok(classes.includes('tm__dev-v'), 'nothing about this device');
        assert.strictEqual(fetched, 0, 'a stopped receiver was polled anyway');
        for (const off of cleanups) off();
    } finally {
        globalThis.fetch = was;
    }
});

t('the minimal view drops the workbench and keeps the four things', () => {
    reset();
    const full = render(TimePanel, {}, context());
    const fullText = words(full.tree);
    const fullClasses = deep(full.tree).map((n) => (n.props && n.props.className) || '').join(' ');
    for (const off of full.cleanups) off();

    reset();
    const min = render(TimePanel, { minimal: true }, context());
    const minText = words(min.tree);
    const minClasses = deep(min.tree).map((n) => (n.props && n.props.className) || '').join(' ');
    for (const off of min.cleanups) off();

    // Kept: the clock, the local reading, the reference and this device. Those four are the
    // panel — "what time is it, is my clock right, and says who".
    assert.ok(minClasses.includes('tm__hms'), 'the clock went');
    assert.ok(minClasses.includes('tm__ref-pill'), 'the reference went');
    assert.ok(minClasses.includes('tm__dev-v'), 'this device went');

    // Dropped: the figures, the date and the way out to the addon's own page.
    assert.ok(fullText.includes('Stratum') && fullText.includes('Spread'), 'the figures are in the full view');
    assert.ok(!minText.includes('Stratum'), 'the figures survived into the minimal view');
    assert.ok(fullText.includes('Open Time'), 'no way out to the addon page');
    assert.ok(!minText.includes('Open Time'), 'the link survived into the minimal view');
    assert.ok(fullClasses.includes('tm__date'), 'no date in the full view');
    assert.ok(!minClasses.includes('tm__date'), 'the date survived into the minimal view');
});

// ── The two switches ─────────────────────────────────────────────────────────

t('the once-a-second redraw aims just past the boundary, never before it', () => {
    // Landing early paints the second before, and the clock then reads a second slow until
    // the next redraw — which is the whole failure this margin exists to prevent.
    assert.ok(nextSecondDelay(1000.0) > 1000, 'a whole second away');
    assert.ok(nextSecondDelay(1999.0) > 1, 'a millisecond away, still past it');
    for (const t0 of [0, 1, 499.5, 999.9, 1500, 123456.7]) {
        const wait = nextSecondDelay(t0);
        const landed = t0 + wait;
        assert.ok(wait > 0, `wait must be positive at ${t0}`);
        assert.ok(
            Math.floor(landed / 1000) > Math.floor(t0 / 1000),
            `redraw at ${t0} landed in the same second`,
        );
    }
});

t('both switches default on and are remembered', () => {
    prefs.clear();
    assert.strictEqual(savedShowMs(), true, 'the fraction is the point of the panel');
    assert.strictEqual(savedShowRef(), true, 'a time whose source is not stated is worth less');

    saveShowMs(false);
    saveShowRef(false);
    assert.strictEqual(savedShowMs(), false);
    assert.strictEqual(savedShowRef(), false);
    saveShowMs(true);
    saveShowRef(true);
    assert.strictEqual(savedShowMs(), true);
    assert.strictEqual(savedShowRef(), true);
    prefs.clear();
});

t('a storage that throws leaves both switches on rather than off', () => {
    // Private browsing, or a locked-down embed. A panel that quietly lost its milliseconds
    // because it could not read a preference would look broken.
    const was = globalThis.localStorage;
    globalThis.localStorage = {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('denied'); },
    };
    try {
        assert.strictEqual(savedShowMs(), true);
        assert.strictEqual(savedShowRef(), true);
        saveShowMs(false);        // must not throw out of the panel
        saveShowRef(false);
    } finally {
        globalThis.localStorage = was;
    }
});

t('the full view carries both switches and the minimal view carries neither', () => {
    prefs.clear();
    reset();
    const full = render(TimePanel, {}, context());
    const switches = deep(full.tree).filter((n) => n.props && n.props.role === 'switch');
    for (const off of full.cleanups) off();
    assert.strictEqual(switches.length, 2, 'wanted the ms and source switches');
    assert.deepStrictEqual(
        deep(full.tree).filter((n) => (n.props || {}).className === 'switch__label')
            .map((n) => n.props.children),
        ['ms', 'source'],
    );

    reset();
    const min = render(TimePanel, { minimal: true }, context());
    const minSwitches = deep(min.tree).filter((n) => n.props && n.props.role === 'switch');
    for (const off of min.cleanups) off();
    assert.strictEqual(minSwitches.length, 0, 'the cut-down view grew a control');
});

const classesOf = (tree) => deep(tree).map((n) => (n.props && n.props.className) || '').join(' ');

t('turning the source off drops it from both views — one switch, one meaning', () => {
    prefs.clear();
    saveShowRef(false);
    try {
        for (const props of [{ minimal: true }, {}]) {
            reset();
            const r = render(TimePanel, props, context());
            const classes = classesOf(r.tree);
            for (const off of r.cleanups) off();
            const where = props.minimal ? 'the cut-down view' : 'the full view';
            assert.ok(!classes.includes('tm__ref-pill'), `the reference stayed in ${where}`);
            // Everything else stands: it is one of the four that is optional, not the panel.
            assert.ok(classes.includes('tm__hms'), `the clock went with it in ${where}`);
            assert.ok(classes.includes('tm__dev-v'), `this device went with it in ${where}`);
        }
    } finally {
        prefs.clear();
    }
});

t('a failover is spelled out in the full view only, and never behind the source switch', () => {
    // "Failed over to ntp" is not a label, it is news, so the source switch does not cover
    // it. The cut-down view drops it all the same and loses nothing: the pill there is
    // already amber and already reads NTP.
    const note = servingNote({ clock: { serving: 'secondary', secondary: 'ntp' } });
    assert.ok(note, 'the fixture must actually describe a failover');

    // Asserted on the source rather than on a render: the note only appears once
    // /api/status has been read, which the hook stub has no way to reach. Written to fail
    // loudly if either gate moves.
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src', 'panels', 'TimePanel.jsx'), 'utf8',
    );
    assert.ok(/\{showRef && \(/.test(src), 'the reference pill is no longer behind the switch');
    const gate = src.match(/\{([^{}]*)&& <div className=\{`tm__note is-\$\{note\.tone\}/);
    assert.ok(gate, 'the failover note is not where this test can see it');
    assert.ok(!/showRef/.test(gate[1]), 'the failover note has been put behind the source switch');
    assert.ok(/!minimal/.test(gate[1]), 'the failover note is still drawn in the cut-down view');
});

// ── The three clocks ─────────────────────────────────────────────────────────

t('a zone resolves to its offset, and a name the engine does not know resolves to null', () => {
    const jan = Date.UTC(2026, 0, 15, 12, 0, 0);
    const jul = Date.UTC(2026, 6, 15, 12, 0, 0);
    assert.strictEqual(zoneOffsetMin('UTC', jan), 0);
    assert.strictEqual(zoneOffsetMin('Europe/London', jan), 0);
    // The whole reason the name is preferred to the server's number: it moves on its own.
    assert.strictEqual(zoneOffsetMin('Europe/London', jul), 60);
    assert.strictEqual(zoneOffsetMin('America/New_York', jan), -300);
    assert.strictEqual(zoneOffsetMin('America/New_York', jul), -240);
    // Not every offset is a whole hour, and one that came back rounded would be wrong by
    // three quarters of an hour in the places that have one.
    assert.strictEqual(zoneOffsetMin('Asia/Kathmandu', jan), 345);
    assert.strictEqual(zoneOffsetMin('Australia/Eucla', jan), 525);
    // Midnight, which is the hour some engines report as 24 rather than 0.
    assert.strictEqual(zoneOffsetMin('UTC', Date.UTC(2026, 0, 15, 0, 0, 30)), 0);

    assert.strictEqual(zoneOffsetMin('Mars/Olympus', jan), null);
    assert.strictEqual(zoneOffsetMin('', jan), null);
    assert.strictEqual(zoneOffsetMin(undefined, jan), null);
});

t('the receiver prefers its zone name to the number, and says nothing where it has neither', () => {
    const jul = Date.UTC(2026, 6, 15, 12, 0, 0);
    // The number is what /api/description worked out when it answered; the name is what is
    // true now. A session left open across a summer-time change has a stale number.
    assert.strictEqual(receiverOffsetMin({ timezone: 'Europe/London', timezone_offset: 0 }, jul), 60);
    // A server too old to send the name, or an operator who left it unset.
    assert.strictEqual(receiverOffsetMin({ timezone_offset: -300 }, jul), -300);
    assert.strictEqual(receiverOffsetMin({ timezone: '', timezone_offset: 90 }, jul), 90);
    // Nothing at all is not a guess.
    assert.strictEqual(receiverOffsetMin({}, jul), null);
    assert.strictEqual(receiverOffsetMin(null, jul), null);
    assert.strictEqual(receiverOffsetMin({ timezone: 'Mars/Olympus' }, jul), null);
});

t('an offset reads the way a person writes it, whole hour or not', () => {
    assert.strictEqual(offsetText(0), 'UTC+00:00');
    assert.strictEqual(offsetText(60), 'UTC+01:00');
    assert.strictEqual(offsetText(-330), 'UTC−05:30');
    assert.strictEqual(offsetText(345), 'UTC+05:45');
});

t('the three clocks are three, in order, and UTC is always one of them', () => {
    // The test box is on Europe/London — see the top of this file.
    const jul = Date.UTC(2026, 6, 15, 12, 0, 0);
    const faces = clockFaces({ timezone: 'America/New_York' }, jul);
    assert.deepStrictEqual(faces.map((f) => f.key), ['utc', 'rx', 'me']);
    assert.deepStrictEqual(faces.map((f) => f.label), ['UTC', 'receiver', 'you']);
    assert.deepStrictEqual(faces.map((f) => f.offsetMin), [0, -240, 60]);
    assert.strictEqual(faces[1].zone, 'America/New_York');
    assert.strictEqual(faces[2].zone, browserZone());
});

t('clocks that read the same are one clock, and say which they are', () => {
    const jul = Date.UTC(2026, 6, 15, 12, 0, 0);
    const jan = Date.UTC(2026, 0, 15, 12, 0, 0);

    // The common case by a long way: the operator has left the receiver on UTC. Showing
    // the same figure twice looks like a bug, so it is one line that says it is both.
    const onUtc = clockFaces({ timezone: 'UTC' }, jul);
    assert.deepStrictEqual(onUtc.map((f) => f.label), ['UTC · receiver', 'you']);
    assert.deepStrictEqual(onUtc[0].keys, ['utc', 'rx']);

    // Listening to a receiver in your own zone — the owner's case.
    const athome = clockFaces({ timezone: 'Europe/London' }, jul);
    assert.deepStrictEqual(athome.map((f) => f.label), ['UTC', 'receiver · you']);
    assert.deepStrictEqual(athome[1].keys, ['rx', 'me']);
    assert.strictEqual(athome[1].offsetMin, 60);

    // In winter that same pair is UTC as well, and all three become one.
    const winter = clockFaces({ timezone: 'Europe/London' }, jan);
    assert.strictEqual(winter.length, 1, 'three clocks reading the same are one clock');
    assert.strictEqual(winter[0].label, 'UTC · receiver · you');
    assert.deepStrictEqual(winter[0].keys, ['utc', 'rx', 'me']);

    // A receiver that has not said leaves two, which is what the panel showed before it
    // knew about receivers at all.
    const quiet = clockFaces({}, jul);
    assert.deepStrictEqual(quiet.map((f) => f.label), ['UTC', 'you']);
});

t('a face says where it is, and UTC is never elaborated into nonsense', () => {
    const faces = clockFaces({ timezone: 'America/New_York' }, Date.UTC(2026, 6, 15, 12));
    const [utc, rx, me] = faces;
    assert.strictEqual(faceText(utc, true), 'UTC', 'UTC · UTC+00:00 tells nobody anything');
    assert.strictEqual(faceText(rx, true), 'receiver · America/New_York');
    assert.strictEqual(faceText(rx, false), 'receiver', 'the cut-down view has no room for it');
    assert.strictEqual(faceText(me, true), `you · ${browserZone()}`);
    // A receiver whose name is unknown still says where it is, from the number.
    const [, byNumber] = clockFaces({ timezone_offset: 330 }, Date.UTC(2026, 6, 15, 12));
    assert.strictEqual(faceText(byNumber, true), 'receiver · UTC+05:30');
    assert.strictEqual(faceText(null, true), '');
});

t('a face reads the time in its own zone, and carries its own date', () => {
    // 01:30 UTC on the 21st is 21:30 on the 20th in New York — the date belongs to the
    // reading, or the panel is wrong about the day for five hours out of every twenty-four.
    const at = Date.UTC(2026, 8, 21, 1, 30, 7, 394);
    const [utc, rx] = clockFaces({ timezone: 'America/New_York' }, at);
    assert.deepStrictEqual(facePartsAt(utc, at), { hms: '01:30:07', frac: '394' });
    assert.deepStrictEqual(facePartsAt(rx, at), { hms: '21:30:07', frac: '394' });
    assert.ok(faceDateAt(utc, at).includes('21 Sep'), `UTC date: ${faceDateAt(utc, at)}`);
    assert.ok(faceDateAt(rx, at).includes('20 Sep'), `receiver date: ${faceDateAt(rx, at)}`);
});

t('the cycle goes round them all and a remembered clock that merged still lands somewhere', () => {
    const faces = clockFaces({ timezone: 'America/New_York' }, Date.UTC(2026, 6, 15, 12));
    assert.strictEqual(nextFaceKey(faces, 'utc'), 'rx');
    assert.strictEqual(nextFaceKey(faces, 'rx'), 'me');
    assert.strictEqual(nextFaceKey(faces, 'me'), 'utc');

    // The receiver is on UTC, so 'rx' is not a face of its own any more — the one that
    // stands for it is the merged UTC line, and the cycle carries on from there rather
    // than dropping somebody back at the start.
    const merged = clockFaces({ timezone: 'UTC' }, Date.UTC(2026, 6, 15, 12));
    assert.strictEqual(faceFor(merged, 'rx'), merged[0]);
    assert.strictEqual(nextFaceKey(merged, 'rx'), 'me');
    assert.strictEqual(nextFaceKey(merged, 'me'), 'utc');

    // Nothing to cycle through: one face, and it is the answer to every key.
    const one = clockFaces({ timezone: 'UTC' }, Date.UTC(2026, 0, 15, 12));
    for (const key of CLOCK_KEYS) assert.strictEqual(faceFor(one, key), one[0]);
    assert.strictEqual(nextFaceKey(one, 'utc'), 'utc');
    assert.strictEqual(faceFor([], 'utc'), null);
});

t('the big clock is UTC by default, and which one it is is remembered', () => {
    prefs.clear();
    assert.strictEqual(savedBigClock(), 'utc', 'the panel is for the broadcast second');
    for (const key of CLOCK_KEYS) {
        saveBigClock(key);
        assert.strictEqual(savedBigClock(), key);
    }
    // Anything else — an older build's value, or a hand-edited store — is UTC again.
    saveBigClock('nonsense');
    assert.strictEqual(savedBigClock(), 'utc');
    prefs.clear();

    const was = globalThis.localStorage;
    globalThis.localStorage = {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('denied'); },
    };
    try {
        assert.strictEqual(savedBigClock(), 'utc', 'a locked-down embed gets the default');
        assert.strictEqual(saveBigClock('me'), 'me', 'must not throw out of the panel');
    } finally {
        globalThis.localStorage = was;
    }
});

const nowOf = (tree) => deep(tree).find((n) => ((n.props || {}).className || '').includes('tm__now'));
const labels = (tree) => deep(tree)
    .filter((n) => ((n.props || {}).className || '') === 'tm__local-k')
    .map((n) => n.props.children);
const zoneOf = (tree) => {
    const n = deep(tree).find((x) => ((x.props || {}).className || '') === 'tm__zone');
    return n ? n.props.children : undefined;
};

t('the panel draws all three clocks, the big one and the other two', () => {
    for (const props of [{}, { minimal: true }]) {
        prefs.clear();
        reset();
        const where = props.minimal ? 'the cut-down view' : 'the full view';
        const r = render(TimePanel, props, context());

        // UTC is big to start with, so the two lines under it are the other two.
        const rest = labels(r.tree);
        assert.strictEqual(rest.length, 2, `wanted two clocks under the big one in ${where}`);
        assert.ok(String(rest[0]).startsWith('receiver'), `no receiver clock in ${where}`);
        assert.ok(String(rest[1]).startsWith('you'), `no clock for this device in ${where}`);
        // Each of them has a figure of its own to be written into.
        const figures = deep(r.tree).filter((n) => ((n.props || {}).className || '') === 'tm__local-v');
        assert.strictEqual(figures.length, 2, `a clock with nowhere to draw itself in ${where}`);
        // The zone is spelled out where there is room and not where there is not.
        if (props.minimal) {
            assert.deepStrictEqual(rest, ['receiver', 'you'], 'the cut-down view grew zone names');
        } else {
            assert.ok(String(rest[0]).includes(RX_ZONE), `the receiver's zone is not named in ${where}`);
            assert.strictEqual(zoneOf(r.tree), 'UTC', 'the date is not labelled UTC');
        }
        for (const off of r.cleanups) off();
        prefs.clear();
    }
});

t('clicking the big clock cycles the three, and where it stopped is remembered', () => {
    prefs.clear();
    reset();
    const first = render(TimePanel, {}, context());
    const now = nowOf(first.tree);
    assert.ok(now, 'no clock in the panel');
    assert.strictEqual(now.props.role, 'button', 'the clock is not clickable');
    assert.ok(now.props.className.includes('is-cycle'), 'no affordance on the clock');
    assert.ok(String(now.props.title).includes('Click for receiver'), `title: ${now.props.title}`);
    now.props.onClick();
    for (const off of first.cleanups) off();
    assert.strictEqual(savedBigClock(), 'rx', 'the click was not remembered');

    // The receiver is big now, so UTC and this device are the two underneath it.
    const second = render(TimePanel, {}, context());
    assert.deepStrictEqual(labels(second.tree).map((v) => String(v).split(' · ')[0]), ['UTC', 'you']);
    assert.ok(String(zoneOf(second.tree)).startsWith('receiver'), `date label: ${zoneOf(second.tree)}`);
    nowOf(second.tree).props.onClick();
    for (const off of second.cleanups) off();
    assert.strictEqual(savedBigClock(), 'me');

    const third = render(TimePanel, {}, context());
    assert.deepStrictEqual(labels(third.tree).map((v) => String(v).split(' · ')[0]), ['UTC', 'receiver']);
    nowOf(third.tree).props.onClick();
    for (const off of third.cleanups) off();
    assert.strictEqual(savedBigClock(), 'utc', 'the cycle did not come back round');
    prefs.clear();
});

t('a receiver on UTC is one line with the rest, not the same figure drawn twice', () => {
    prefs.clear();
    reset();
    const r = render(TimePanel, {}, context({ timezone: 'UTC', timezone_offset: 0 }));
    const rest = labels(r.tree);
    assert.strictEqual(rest.length, 1, `wanted one clock under the big one, got ${rest}`);
    assert.ok(String(rest[0]).startsWith('you'), `the line under the clock reads ${rest[0]}`);
    assert.strictEqual(zoneOf(r.tree), 'UTC · receiver', 'the merge is not spelled out');
    // Still worth a click: there are two readings.
    assert.strictEqual(nowOf(r.tree).props.role, 'button');
    for (const off of r.cleanups) off();
    prefs.clear();
});

t('where all three read the same there is nothing to click and nothing drawn twice', () => {
    const wasTz = process.env.TZ;
    process.env.TZ = 'UTC';
    prefs.clear();
    // Even with another clock remembered, because it is the readings that decide.
    saveBigClock('rx');
    try {
        reset();
        const full = render(TimePanel, {}, context({ timezone: 'UTC', timezone_offset: 0 }));
        const now = nowOf(full.tree);
        assert.ok(now, 'no clock at all');
        assert.strictEqual(now.props.role, undefined, 'offered a cycle that goes nowhere');
        assert.strictEqual(now.props.onClick, undefined, 'the clock is still clickable');
        assert.ok(!now.props.className.includes('is-cycle'), 'the affordance is still drawn');
        assert.strictEqual(
            deep(full.tree).filter((n) => ((n.props || {}).className || '') === 'tm__local-v').length,
            0,
            'the same figure is drawn more than once',
        );
        // The full view says what that one clock is on the date line, so it needs no
        // second line to repeat it.
        assert.strictEqual(zoneOf(full.tree), 'UTC · receiver · you');
        assert.deepStrictEqual(labels(full.tree), []);
        for (const off of full.cleanups) off();

        // The cut-down view has no date line, so the label goes on one of its own — this
        // is where "they are all the same here" would otherwise go unsaid.
        reset();
        const min = render(TimePanel, { minimal: true }, context({ timezone: 'UTC' }));
        assert.deepStrictEqual(labels(min.tree), ['UTC · receiver · you']);
        for (const off of min.cleanups) off();
    } finally {
        process.env.TZ = wasTz;
        prefs.clear();
    }
});

t('a receiver that has not said its zone leaves the two clocks there always were', () => {
    prefs.clear();
    reset();
    // An old server, or one whose operator left the zone unset. The browser's own zone
    // would be a plausible-looking wrong answer, so there is no receiver clock at all.
    const r = render(TimePanel, {}, context({}));
    assert.deepStrictEqual(labels(r.tree).map((v) => String(v).split(' · ')[0]), ['you']);
    assert.strictEqual(nowOf(r.tree).props.role, 'button', 'UTC and this device still swap');
    for (const off of r.cleanups) off();

    // And before /api/description has answered at all.
    reset();
    const early = render(TimePanel, {}, context(null));
    assert.deepStrictEqual(labels(early.tree).map((v) => String(v).split(' · ')[0]), ['you']);
    for (const off of early.cleanups) off();
    prefs.clear();
});

console.log(`\n${pass} passed`);
