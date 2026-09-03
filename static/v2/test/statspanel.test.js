// The Stats panel actually renders, in the states it has.
//
// The class this catches is the one nothing else here can: a component used
// before it is defined, a helper called with its arguments the other way round,
// a reading destructured before the check that there is one. All of those build
// cleanly, pass the arithmetic tests next door, and blank the panel.
//
// It matters more than usual here because almost everything the panel draws is
// absent at some point in a normal session and present at another: the band
// spectrum stream exists only while that panel is open, the host process stats
// only in the native clients, the address only after a fetch has landed, and
// every rate only after two samples. Each of those is a branch, and a panel of
// six charts and nine cards has enough of them to be worth pinning down.

const assert = require('assert');

// Before the bundle: the module graph behind the panel reaches the display
// settings, the radio, the chat room and the listener poll, and all of them read
// the browser at import time.
const stored = {};
globalThis.localStorage = {
    getItem: (k) => (k in stored ? stored[k] : null),
    setItem: (k, v) => { stored[k] = String(v); },
    removeItem: (k) => { delete stored[k]; },
};
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
// A clock and a scheduler the test drives.
//
// Every figure on this panel is a counter differenced against the last reading,
// so nothing has a value until two samples have been taken half a second apart.
// Real timers cannot deliver that — the test would have to wait, and a forgotten
// interval would hang node rather than fail it — so time is a variable and the
// intervals are a list the test fires by hand.
let clock = 1000;
globalThis.performance = { now: () => clock };
const timers = [];
globalThis.setInterval = (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; };
globalThis.clearInterval = (h) => {
    const i = timers.indexOf(h);
    if (i >= 0) timers.splice(i, 1);
};
globalThis.setTimeout = (fn) => ({ fn });
globalThis.clearTimeout = () => {};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
// The address lookup and the listener poll both fire on mount. A rejection is
// the honest stand-in for a receiver that has not answered yet, which is the
// state the panel spends its first second in anyway.
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
// The panel reads the display's frame cap, which asks whether this is a
// touchscreen — and the overlay control asks whether this is a phone.
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { deep, render, reset, walk, StatsPanel, stats } = require('./.build/statspanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// words() joins only the *string* children of a tree, so a `{count}` rendered as
// a number vanishes from it — and most of this panel's readings are numbers.
// This is the same walk with numbers kept.
function say(node) {
    return deep(node).flatMap((n) => {
        const c = (n.children && n.children.length)
            ? n.children
            : ((n.props && n.props.children != null) ? [n.props.children] : []);
        return c.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
    }).join(' ');
}

/** Every readout card in a tree, as `{label, num, unit}`. */
function cards(tree) {
    return deep(tree)
        .filter((n) => n && n.props && n.props.className === 'readout')
        .map((n) => {
            const parts = deep(n).filter((x) => x && x.props);
            const of = (cls) => {
                const hit = parts.find((x) => String(x.props.className || '') === cls);
                return hit ? say(hit).trim() : '';
            };
            return { label: of('readout__label'), num: of('readout__num'), unit: of('readout__unit') };
        });
}

const cardNamed = (tree, label) => cards(tree).find((c) => c.label === label);

/** The colours the stacked chart's key is drawn in, bottom of the stack first. */
function legendColours(tree) {
    return deep(tree)
        .filter((n) => n && n.props && n.props.className === 'stats-legend__swatch')
        .map((n) => String(n.props.style.background));
}

/**
 * Every chart caption in a tree, whitespace collapsed.
 *
 * The words come out in walk order rather than reading order: say() takes a
 * node's own string children before descending, and the live figure is in a
 * span of its own — so "Net 44 kB/s, last 10 s" is collected as "Net , last 10 s
 * 44 kB/s". That is a fact about the walk and not about the panel, so these
 * assertions ask what a caption contains rather than how it reads.
 */
function captions(tree) {
    return deep(tree)
        .filter((n) => n && n.props && String(n.props.className || '').startsWith('sparkline__label'))
        .map((n) => say(n).replace(/\s+/g, ' ').trim());
}

const captionFor = (tree, label) => captions(tree).find((c) => c.startsWith(label));

// One object answers useRadio, useDisplay and useChat: the stub's useContext has
// no way to tell three contexts apart, and none of the three cares.
function context(over = {}) {
    const { meters, ...rest } = over;
    return {
        running: true,
        audio: { bufferSec: 0.2 },
        spectrumConn: {
            bytesIn: 0, framesIn: 0, binCount: 1024, binBandwidth: 23.4375, rateDivisor: 1,
        },
        audioConn: { bytesIn: 0 },
        meters: {
            current: {
                queuedSec: 0.12,
                underruns: 0,
                streamRate: 12000,
                channels: 1,
                outLatencySec: 0.021,
                ...(meters || {}),
            },
        },
        // useChat
        users: [],
        // useDisplay
        maxFps: 30,
        spectrumStats: 'left',
        netBits: false,
        set() {},
        ...rest,
    };
}

/**
 * Mount the panel, run it for a few samples, and return what it drew.
 *
 * Two renders, and both are needed. The first mounts and starts the clocks; the
 * ticks then fill the histories and set the cards, which under this stub writes
 * hook state without redrawing; the second render is what reads that state back.
 * That is the panel's real first second, in three lines.
 *
 * The unmount is not optional either. This panel holds four clocks — the meter
 * snapshot, the sample tick, the listener poll and the frame loop — and an
 * interval left running keeps node alive for ever, so a test file that forgot
 * one would hang rather than fail. Tearing it down inside the helper means every
 * test proves the cleanup path as a side effect of using it.
 *
 * @param step  called between ticks with the context, to advance the counters
 *              a socket would have advanced. Rates are differences, so a
 *              context that never moves reports nought — which is a state worth
 *              testing but not the only one.
 */
function mount(ctx = context(), props = {}, { ticks = 3, step } = {}) {
    reset();
    timers.length = 0;
    clock = 1000;
    const first = render(StatsPanel, props, ctx);
    for (let n = 0; n < ticks; n++) {
        clock += SAMPLE_MS;
        if (step) step(ctx);
        for (const h of [...timers]) h.fn();
    }
    const again = render(StatsPanel, props, ctx);
    for (const off of first.cleanups) off();
    for (const off of again.cleanups) off();
    return { tree: again.tree, cleanups: first.cleanups };
}

// The three streams the NET chart stacks: spectrum, audio, band.
const NET_STREAMS = 3;

// The panel's own sample interval. Not imported — it is not exported, and the
// point of a fixed number here is that the test notices if it changes.
const SAMPLE_MS = 500;

// --- it renders at all -------------------------------------------------------

t('the panel renders on a session that has just started', () => {
    const { tree } = mount();
    assert.ok(tree, 'rendered nothing');
    // Six charts: net, feed, fps, buffer — and no CPU or memory, since no host
    // answered. See "only where a host can answer" below.
    assert.strictEqual(captions(tree).length, 4);
});

t('mounting and unmounting leaves nothing running', () => {
    // The frame loop, the meter clock, the sample clock, the listener poll and
    // the address fetch each register one. A throw on the way out leaks a timer
    // per open-and-close, which is invisible until a session has been running
    // for hours. mount() runs them, so the assertion here is that there were
    // some to run.
    assert.ok(mount().cleanups.length >= 3);
});

// --- the cards ---------------------------------------------------------------

t('the standing facts are cards, not charts', () => {
    const { tree } = mount();
    const labels = cards(tree).map((c) => c.label);
    for (const want of [
        'Bins', 'Bin width', 'Users', 'In chat', 'Sample rate', 'Channels',
        'Output latency', 'Poll', 'Your address',
    ]) {
        assert.ok(labels.includes(want), `no ${want} card — got ${labels.join(', ')}`);
    }
});

t('the bin width is worded exactly as the corner readout words it', () => {
    const { tree } = mount();
    // The same formatter, so the two can never disagree about whether 23.4375
    // is "23.4 Hz" or "23 Hz".
    assert.strictEqual(cardNamed(tree, 'Bin width').num, stats.formatHzPerBin(23.4375));
});

t('the audio stream is read off the meters', () => {
    const { tree } = mount();
    assert.strictEqual(cardNamed(tree, 'Sample rate').num, '12');
    assert.strictEqual(cardNamed(tree, 'Sample rate').unit, 'kHz');
    assert.strictEqual(cardNamed(tree, 'Channels').num, '1');
    assert.strictEqual(cardNamed(tree, 'Output latency').num, '21');
});

t('an odd sample rate keeps its decimal rather than rounding to a rate it is not', () => {
    const { tree } = mount(context({ meters: { streamRate: 11025, channels: 2 } }));
    assert.strictEqual(cardNamed(tree, 'Sample rate').num, '11.0');
    assert.strictEqual(cardNamed(tree, 'Channels').num, '2');
});

t('nothing measured yet is a dash, never a zero', () => {
    // A zero here would read as a stream that has stopped, which is a different
    // and much more alarming thing than one that has not started.
    const { tree } = mount(context({
        spectrumConn: { bytesIn: 0, framesIn: 0, binCount: 0, binBandwidth: 0, rateDivisor: 0 },
        meters: { streamRate: 0, channels: 0, outLatencySec: 0, queuedSec: 0, underruns: 0 },
    }));
    for (const label of ['Bins', 'Bin width', 'Sample rate', 'Channels', 'Output latency', 'Poll', 'Users']) {
        assert.strictEqual(cardNamed(tree, label).num, '—', `${label} was not a dash`);
    }
});

t('an empty chat room is a dash, because a closed one looks the same', () => {
    // Nought and "no chat socket at all" — a hidden Chat panel — cannot be told
    // apart from here, so neither is printed as a number.
    assert.strictEqual(cardNamed(mount().tree, 'In chat').num, '—');
    const busy = mount(context({ users: [{}, {}, {}] }));
    assert.strictEqual(cardNamed(busy.tree, 'In chat').num, '3');
});

t('the poll divisor is shown even at full rate', () => {
    // The corner readout leaves this out at 1/1 for want of space. A card that
    // appeared only when something was wrong would move everything under it the
    // moment it did.
    assert.strictEqual(cardNamed(mount().tree, 'Poll').num, '1/1');
    const slow = mount(context({
        spectrumConn: {
            bytesIn: 0, framesIn: 0, binCount: 1024, binBandwidth: 23.4375, rateDivisor: 2,
        },
    }));
    assert.strictEqual(cardNamed(slow.tree, 'Poll').num, '1/2');
});

// --- the charts --------------------------------------------------------------

t('every chart says what it is, and every single trace says over what span', () => {
    const { tree } = mount();
    for (const label of ['Net', 'Feed', 'FPS', 'Buffer']) {
        assert.ok(captionFor(tree, label), `no ${label} caption — got ${captions(tree).join(' | ')}`);
    }
    // Net is the exception and says why in its own test above.
    for (const label of ['Feed', 'FPS', 'Buffer']) {
        assert.ok(captionFor(tree, label).includes('last 10 s'), captionFor(tree, label));
    }
});

t('the buffer caption keeps the queue and the dropouts it always had', () => {
    const { tree } = mount(context({ meters: { queuedSec: 0.145, underruns: 3 } }));
    const c = captionFor(tree, 'Buffer');
    assert.ok(c.includes('145'), c);
    assert.ok(c.includes('3 drops'), c);
});

t('one dropout is a drop, not a drops', () => {
    const { tree } = mount(context({ meters: { underruns: 1 } }));
    const c = captionFor(tree, 'Buffer');
    assert.ok(/\b1 drop\b/.test(c), c);
    assert.ok(!c.includes('drops'), c);
});

t('the stacked chart has a swatch and a name for each of its three streams', () => {
    const { tree } = mount();
    const items = deep(tree).filter((n) => n && n.props && n.props.className === 'stats-legend__item');
    assert.strictEqual(items.length, 3);
    assert.deepStrictEqual(items.map((n) => say(n).trim()), ['Spectrum', 'Audio', 'Band']);
    const colours = legendColours(tree);
    // Three distinct colours, or the legend is decoration rather than a key.
    assert.strictEqual(new Set(colours).size, 3, colours.join(', '));
});

t('the legend cannot be repainted by the operator picking an accent', () => {
    // This is the bug the palette was changed for. --accent is the Display
    // panel's to set, and two of the presets in lib/uiColors.js put it straight
    // on top of a semantic token: Amber's #ffb000 landed on --warn, so Spectrum
    // and Band came out the same colour, and Phosphor's #35e07a lands on
    // --good, which would have done the same to Spectrum and Audio.
    //
    // A literal hex is the whole fix, so a literal hex is what is asserted: no
    // var(), and nothing that could resolve to one.
    for (const c of legendColours(mount().tree)) {
        assert.ok(/^#[0-9a-f]{6}$/i.test(c), `${c} is not a fixed colour`);
    }
});

t('no series borrows a colour that means how something is doing', () => {
    // --good, --warn and --bad say whether a thing is healthy. A stream is not
    // healthy or unhealthy, it is a stream — an amber band would read as a
    // warning about the band spectrum socket. Checked against the stylesheet's
    // own values rather than by eye.
    const SEMANTIC = ['#45d69a', '#f2b544', '#f2646a'];
    for (const c of legendColours(mount().tree)) {
        assert.ok(!SEMANTIC.includes(c.toLowerCase()), `${c} is a semantic colour`);
    }
});

t('only where a host can answer: no process charts in a browser', () => {
    // window.ubersdrAppStats is what the native clients install, and there is
    // none here. Two empty boxes are a worse answer than no boxes.
    const { tree } = mount();
    assert.ok(!captionFor(tree, 'CPU'), 'drew a CPU chart with no host to measure');
    assert.ok(!captionFor(tree, 'Memory'), 'drew a memory chart with no host to measure');
});

// 20 kB of spectrum and 2 kB of audio every half second: 44 kB/s between them.
const TRAFFIC = {
    step: (ctx) => {
        ctx.spectrumConn.bytesIn += 20 * 1024;
        ctx.audioConn.bytesIn += 2 * 1024;
    },
};

t('the net caption names the parts instead of declaring the span', () => {
    // The other charts spend that room on "last 10 s", which they have to
    // because a single trace says nothing about its own timebase. This one has a
    // key under it and three streams to account for, and the panel says what ten
    // seconds looks like directly below.
    const { tree } = mount(context(), {}, TRAFFIC);
    // say() collects a node's own strings before descending, so the figures
    // land after the words they belong to — see captions() above. The parts are
    // asserted individually for that reason, not because the order is in doubt.
    const c = captionFor(tree, 'Net');
    for (const want of ['44', 'kB/s', 'S:', '40', 'A:', '4']) {
        assert.ok(c.includes(want), `${want} missing from ${c}`);
    }
    assert.ok(!c.includes('last 10 s'), c);
});

t('the part letters are coloured as the bands they stand for', () => {
    // Three names in a caption this size is a line of prose, so they are
    // letters — and the colour is what does the naming.
    const { tree } = mount(context(), {}, TRAFFIC);
    const caption = deep(tree).find((n) => n && n.props
        && String(n.props.className || '').startsWith('sparkline__label')
        && say(n).includes('Net'));
    const inked = deep(caption).filter((n) => n && n.props && n.props.style && n.props.style.color);
    assert.deepStrictEqual(inked.map((n) => say(n).trim()), ['S:', 'A:', 'B:']);
    assert.deepStrictEqual(inked.map((n) => n.props.style.color), legendColours(tree));
});

t('all three parts are always there, a stream that is not running included', () => {
    // The band spectrum stream exists only while that panel is open. It still
    // gets a field, reading nought — because the caption is anchored by its
    // right edge, and a part that comes and goes drags every word before it
    // sideways every time the panel is opened or closed. A fixed set of three
    // fields is what holds the line still.
    const c = captionFor(mount(context(), {}, TRAFFIC).tree, 'Net');
    for (const letter of ['S:', 'A:', 'B:']) assert.ok(c.includes(letter), c);
});

t('nothing in the caption can change width as a reading changes', () => {
    // The complaint this answers: every figure is a fixed-width field with
    // tabular figures, so a stream going from 9 to 10 kB/s does not shove the
    // words to its left. Only the total was held still to begin with, and four
    // unheld numbers beside it were enough to make the line walk every sample.
    const { tree } = mount(context(), {}, TRAFFIC);
    const caption = deep(tree).find((n) => n && n.props
        && String(n.props.className || '').startsWith('sparkline__label')
        && say(n).includes('Net'));
    const reserved = deep(caption)
        .filter((n) => n && n.props && /sparkline__(n|unit|value)\b/.test(String(n.props.className || '')));
    // The total, the unit, and one field per stream.
    assert.strictEqual(reserved.length, 2 + NET_STREAMS);
});

t('before the first two samples there is a dash and nothing else', () => {
    // A rate needs two readings. "— B/s ()" would say the sockets are carrying
    // nothing, when what is true is that nobody has looked yet.
    const c = captionFor(mount(context(), {}, { ticks: 0 }).tree, 'Net');
    assert.ok(c.includes('—'), c);
    assert.ok(!c.includes('('), c);
    assert.ok(!c.includes('B/s'), c);
});

t('a counter that has not moved is nought, not a dash', () => {
    // The distinction the cards make — nothing measured yet is a dash — does not
    // apply to a rate that has been measured and came out at zero. A paused
    // socket really is carrying nothing, and that is the reading.
    const c = captionFor(mount().tree, 'Net');
    assert.ok(c.includes('B/s') && /\b0\b/.test(c), c);
    assert.ok(!c.includes('—'), c);
});

t('pressing the net chart swaps bytes for bits, and it is a setting', () => {
    // Both are the same traffic and each answers a different question — bytes
    // are what an hour costs an allowance, bits are whether the link is fast
    // enough — so it is remembered rather than asked again every session.
    const wrote = [];
    const { tree } = mount(context({ set: (v) => wrote.push(v) }), {}, TRAFFIC);
    const press = deep(tree).find((n) => n.type === 'button'
        && String(n.props.className || '').includes('sparkline--press'));
    assert.ok(press, 'the net chart does not take a press');
    press.props.onClick();
    assert.deepStrictEqual(wrote, [{ netBits: true }]);
});

t('in bits the caption is the same traffic in the other unit', () => {
    const { tree } = mount(context({ netBits: true }), {}, TRAFFIC);
    const c = captionFor(tree, 'Net');
    // 44 kB/s is 360 kbit/s. A press that changed the noun and not the number
    // would simply be mislabelling the same figure.
    assert.ok(c.includes('kbit/s'), c);
    assert.ok(c.includes('360'), c);
    assert.ok(!c.includes('kB/s'), c);
});

t('the press says which way it goes, both ways', () => {
    const bytes = mount(context(), {}, TRAFFIC).tree;
    const bits = mount(context({ netBits: true }), {}, TRAFFIC).tree;
    const titleOf = (tree) => deep(tree).find((n) => n.type === 'button'
        && String(n.props.className || '').includes('sparkline--press')).props.title;
    assert.ok(titleOf(bytes).includes('Click for bits a second'), titleOf(bytes));
    assert.ok(titleOf(bits).includes('Click for bytes a second'), titleOf(bits));
});

// --- the minimal view --------------------------------------------------------

t('minimal keeps the two charts with a failure in them, and drops the rest', () => {
    const { tree } = mount(context(), { minimal: true });
    assert.deepStrictEqual(
        captions(tree).map((c) => c.split(' ')[0]),
        ['Net:', 'Buffer:'],
    );
});

t('minimal keeps the legend, because a stacked chart without a key is stripes', () => {
    const { tree } = mount(context(), { minimal: true });
    const items = deep(tree).filter((n) => n && n.props && n.props.className === 'stats-legend__item');
    assert.strictEqual(items.length, 3);
});

t('minimal drops the cards and the setting', () => {
    const { tree } = mount(context(), { minimal: true });
    assert.deepStrictEqual(cards(tree), []);
    assert.ok(!deep(tree).some((n) => n.type === 'select'), 'kept the overlay control');
});

t('minimal still says when the receiver is not running', () => {
    // A cut-down panel is a readout, and "there is nothing to read yet" is the
    // most important thing a readout can say.
    const { tree } = mount(context({ running: false }), { minimal: true });
    const note = deep(tree).find((n) => n && n.props && String(n.props.className || '').startsWith('note'));
    assert.ok(note && say(note).includes('once the receiver is started'));
});

t('a minimal panel is still sampling the charts it is not drawing', () => {
    // So that expanding it shows what just happened, rather than four empty
    // boxes that fill in over the following ten seconds.
    const { tree } = mount(context(), { minimal: true });
    assert.strictEqual(captions(tree).length, 2);
    // The same hook state, read back with the panel expanded: the histories the
    // minimal view never drew are there, and so are the cards.
    const expanded = render(StatsPanel, {}, context());
    for (const off of expanded.cleanups) off();
    assert.ok(cardNamed(expanded.tree, 'Bins').num !== '—', 'the cards had not been sampled');
});

// --- the overlay control -----------------------------------------------------

t('the overlay control is the Display panel switch, not a second one', () => {
    const wrote = [];
    const { tree } = mount(context({ spectrumStats: 'right', set: (v) => wrote.push(v) }));
    const select = deep(tree).find((n) => n.type === 'select');
    assert.ok(select, 'no overlay control');
    assert.strictEqual(select.props.value, 'right');
    assert.deepStrictEqual(
        deep(select).filter((n) => n.type === 'option').map((n) => n.props.value),
        stats.STATS_PLACES,
    );
    // One stored value, so the two controls cannot disagree.
    select.props.onChange({ target: { value: 'off' } });
    assert.deepStrictEqual(wrote, [{ spectrumStats: 'off' }]);
});

t('an unset overlay setting says it is taking the device default', () => {
    const { tree } = mount(context({ spectrumStats: null }));
    const field = deep(tree).find((n) => n && n.props && n.props.className === 'field__hint');
    assert.ok(field && say(field).includes('default for this device'), 'no default hint');
    // And the control still shows the corner that is actually in force.
    const select = deep(tree).find((n) => n.type === 'select');
    assert.strictEqual(select.props.value, stats.statsPlace(null, false));
});

// --- the receiver not being on -----------------------------------------------

t('a stopped receiver says so rather than drawing empty charts silently', () => {
    const { tree } = mount(context({ running: false }));
    const note = deep(tree).find((n) => n && n.props && String(n.props.className || '').startsWith('note'));
    assert.ok(note && say(note).includes('once the receiver is started'), 'no note');
});

t('a running receiver does not', () => {
    const { tree } = mount();
    const note = deep(tree).find((n) => n && n.props && String(n.props.className || '').startsWith('note'));
    assert.ok(!note, 'told a running receiver to start itself');
});

console.log(`${pass} ok`);
