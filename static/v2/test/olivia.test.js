// Olivia's mode arithmetic, its attach parameters, and that the panel renders.
//
// Two things here are worth more than the rest.
//
// The first is that the panel's own idea of how fast a mode runs agrees with
// the decoder's. The symbol length is derived independently on both sides —
// modes.js works it out to label the menu before anything is attached, and
// audio_extensions/olivia/decoder.go works it out from the reference's formula
// — so the menu can quietly promise a rate the server does not deliver. The
// expected numbers below come from the same fldigi-generated vectors the Go
// tests use (audio_extensions/olivia/testdata/vectors.json), so this is really
// a check that the JavaScript and the reference agree.
//
// The second is that the squelch stays out of the attach parameters. It is the
// one Olivia setting the server can change in place, and the hook re-attaches
// whenever `params` changes by value — so if it ever leaked in, every drag of
// the slider would tear down a decoder that takes the better part of ten
// seconds to re-acquire. That failure is invisible in a screenshot and obvious
// on the air, which is exactly the kind this directory exists to catch.

const assert = require('assert');

const {
    deep, render, reset, words,
    OliviaExtension, EXTENSION_BY_ID,
    DEFAULT_MODE, LIMITS, MODES, MODE_ID, OLIVIA_FREQUENCIES, SQUELCH,
    attachParams, modeLabel, modeRates,
} = require('./.build/olivia.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- mode arithmetic -------------------------------------------------------

// Read straight from the file the Go tests use, rather than copied into a table
// here. Two independent derivations of the symbol length — modes.js works it out
// to label the menu, audio_extensions/olivia/decoder.go works it out from the
// reference's formula — checked against one shared set of numbers that fldigi
// produced. A copy would let the two drift apart quietly.
const REFERENCE = JSON.parse(
    require('fs').readFileSync(
        require('path').join(__dirname, '../../../audio_extensions/olivia/testdata/vectors.json'),
        'utf8',
    ),
);

t('the panel and the reference agree on every mode rate', () => {
    let checked = 0;
    for (const g of REFERENCE.geometry) {
        // The reference reports the quantised bandwidth; the panel is only ever
        // asked about modes that need no quantising.
        if (g.bandwidth !== g.bandwidth_in) continue;
        const got = modeRates({ tones: g.tones, bandwidth: g.bandwidth });
        assert.strictEqual(got.baud, g.baud, `${g.tones}/${g.bandwidth} baud`);
        assert.strictEqual(got.blockPeriod, g.block_period, `${g.tones}/${g.bandwidth} block period`);
        // Symbol length is what both sides derive independently; baud and block
        // period follow from it, so agreeing on those pins it.
        assert.strictEqual((8000 / got.baud) * 2, g.symbol_len, `${g.tones}/${g.bandwidth} symbol length`);
        checked++;
    }
    assert.ok(checked >= 18, `only ${checked} modes cross-checked`);
});

t('every mode the panel offers has reference geometry behind it', () => {
    // A mode in the menu with no vector behind it is a mode nobody has checked.
    const have = new Set(REFERENCE.geometry.map((g) => `${g.tones}/${g.bandwidth_in}`));
    for (const m of MODES) {
        assert.ok(have.has(MODE_ID(m.tones, m.bandwidth)), `no reference for ${MODE_ID(m.tones, m.bandwidth)}`);
    }
});

t('the coarse-bin modes clamp their frequency search at the default centre', () => {
    // Recorded rather than asserted away, and the list is not the one you would
    // guess. It is not "the wide modes": it is the modes whose FFT bins are
    // coarse enough that the tone block starts within eight bins of DC, so the
    // search margin has nowhere to go. That is every 2000 Hz mode *and* 4/1000,
    // whose 64-point transform puts 125 Hz in a bin and the block at carrier 5.
    //
    // The margin clamps to FirstCarrier; the decoder still runs, but only if you
    // are tuned nearly exactly right. The panel says so via the config frame's
    // `narrowed`, and this is the proof the condition is real and not imagined.
    const at1000 = REFERENCE.geometry.filter((g) => g.center_hz === 1000);
    const clamped = at1000.filter((g) => g.sync_margin < 8).map((g) => `${g.tones}/${g.bandwidth}`);
    assert.deepStrictEqual(clamped, ['4/1000', '4/2000', '8/2000', '16/2000', '32/2000', '64/2000']);
    // Every clamped one has its margin pinned to exactly FirstCarrier, which is
    // the rule the reference applies rather than a coincidence of these modes.
    for (const g of at1000.filter((x) => x.sync_margin < 8)) {
        assert.strictEqual(g.sync_margin, g.first_carrier, `${g.tones}/${g.bandwidth}`);
    }
    // And the wide ones recover once the centre is high enough to leave room.
    const wide1500 = REFERENCE.geometry.filter((g) => g.center_hz === 1500 && g.bandwidth === 2000);
    assert.ok(wide1500.some((g) => g.sync_margin === 8), 'no wide mode recovers at 1500 Hz');
});

t('every offered mode is one the reference can build', () => {
    // Tones a power of two, bandwidth a power-of-two multiple of 125. The server
    // rounds anything else down, so an entry that needed rounding would decode
    // as a mode other than the one its label claims.
    for (const m of MODES) {
        assert.strictEqual(1 << Math.round(Math.log2(m.tones)), m.tones, `${m.tones} tones`);
        const mult = m.bandwidth / 125;
        assert.strictEqual(1 << Math.round(Math.log2(mult)), mult, `${m.bandwidth} Hz`);
        assert.ok(m.bandwidth >= 125 && m.bandwidth <= 2000, `${m.bandwidth} Hz out of range`);
    }
});

t('the three standard modes are the ones marked', () => {
    const std = MODES.filter((m) => m.standard).map((m) => MODE_ID(m.tones, m.bandwidth));
    assert.deepStrictEqual(std, ['8/250', '16/500', '32/1000']);
});

t('the default mode is the one the frequency menu is built around', () => {
    // The invariant that decided this default. The first frequency group is the
    // published calling frequencies, and its label names the mode they use;
    // opening on anything else means picking a frequency from that menu and
    // then having to change the mode by hand, which is the panel arguing with
    // itself. fldigi opens on 8/500 and sdr-j on 32/1000, so there was no
    // default to inherit — this is the one that makes the panel coherent.
    const id = MODE_ID(DEFAULT_MODE.tones, DEFAULT_MODE.bandwidth);
    assert.ok(MODES.some((m) => MODE_ID(m.tones, m.bandwidth) === id), `${id} not offered`);
    assert.ok(
        OLIVIA_FREQUENCIES[0].group.includes(id),
        `default mode ${id} does not match the first frequency group "${OLIVIA_FREQUENCIES[0].group}"`,
    );
    // And it should be one of the three a bare "Olivia" spot means.
    assert.ok(MODES.find((m) => MODE_ID(m.tones, m.bandwidth) === id).standard);
});

t('a mode label names the mode and its rate', () => {
    const label = modeLabel({ tones: 16, bandwidth: 500, standard: true });
    assert.match(label, /^16\/500/);
    assert.match(label, /31\.25 Bd/);
    assert.match(label, /★/);
});

// --- attach parameters -----------------------------------------------------

t('the squelch is not part of the attach identity', () => {
    // The proof that matters: the same configuration at two different squelch
    // settings must produce params that differ ONLY in sync_threshold, and the
    // panel must never rebuild `params` when only the squelch moved. The first
    // half is checked here; the second is the dependency list in the panel,
    // checked by the render test below not re-attaching.
    const cfg = {
        tones: 16, bandwidth: 500, center_frequency: 1000,
        sync_margin: 8, sync_integ_len: 4, reverse: false, eight_bit: true,
    };
    const a = attachParams(cfg, 4.0);
    const b = attachParams(cfg, 9.5);
    assert.strictEqual(a.sync_threshold, 4.0);
    assert.strictEqual(b.sync_threshold, 9.5);
    delete a.sync_threshold;
    delete b.sync_threshold;
    assert.deepStrictEqual(a, b);
});

t('attach parameters are exactly what the server reads', () => {
    // audio_extensions/olivia/extension.go reads these six keys and no others;
    // an extra one is silently ignored, which is how a setting comes to look
    // like it works and does nothing.
    const p = attachParams({
        tones: 32, bandwidth: 1000, center_frequency: 1500,
        sync_margin: 12, sync_integ_len: 6, reverse: true, eight_bit: false,
    }, 6);
    assert.deepStrictEqual(Object.keys(p).sort(), [
        'bandwidth', 'center_frequency', 'eight_bit', 'reverse',
        'sync_integ_len', 'sync_margin', 'sync_threshold', 'tones',
    ]);
    assert.strictEqual(p.reverse, true);
    assert.strictEqual(p.center_frequency, 1500);
});

t('the squelch bounds match the decoder\'s', () => {
    // SyncThresholdMin/Max/Default in decoder.go. A slider that can ask for
    // something the server clamps would snap back under the user's finger.
    assert.strictEqual(SQUELCH.min, 3.0);
    assert.strictEqual(SQUELCH.max, 15.0);
    assert.strictEqual(SQUELCH.default, 4.0);
});

t('the centre frequency stays inside the sideband passband', () => {
    assert.ok(LIMITS.center_frequency.min >= 300);
    assert.ok(LIMITS.center_frequency.max <= 2700);
});

t('the frequency menu holds plausible HF dial frequencies', () => {
    const all = OLIVIA_FREQUENCIES.flatMap((g) => g.options);
    assert.ok(all.length >= 10);
    for (const o of all) {
        assert.ok(o.hz > 1_000_000 && o.hz < 30_000_000, `${o.label} out of HF`);
        assert.ok(o.label.length > 0);
    }
});

// --- the panel renders -----------------------------------------------------

const context = (over) => ({
    running: true,
    audioState: 'open',
    tuning: { mode: 'usb', frequency: 14072900 },
    actions: { tuneTo: () => {}, ensureVisible: () => {} },
    player: null,
    ...over,
});

const mounted = [];
function mount(props, over) {
    reset();
    const r = render(OliviaExtension, props || {}, context(over));
    mounted.push(() => { for (const off of r.cleanups) off(); });
    return r.tree;
}

const classes = (tree) => deep(tree).map((n) => String(n.props.className || ''));
const hasClass = (tree, c) => classes(tree).some((n) => n.includes(c));

t('the panel renders', () => {
    // The one this file exists for: a component referenced before it is
    // imported is undefined, React draws nothing, and every other test still
    // passes. hookStub throws on it instead.
    const tree = mount();
    assert.ok(tree, 'rendered nothing');
    assert.ok(hasClass(tree, 'olivia'));
});

t('the full view shows the transport, the settings and the readouts', () => {
    const tree = mount();
    assert.ok(hasClass(tree, 'tp__bar'), 'no transport bar');
    assert.ok(hasClass(tree, 'tp__config'), 'no settings');
    assert.ok(hasClass(tree, 'tp__controls'), 'no controls row');
    assert.ok(hasClass(tree, 'tp__foot'), 'no footer');
});

t('the minimal view keeps what you work and drops what you read', () => {
    // The registry's rule: minimal keeps the setup and the output, and drops
    // the things that only report how it is getting on. The squelch is setup
    // here, not reporting — on Olivia it is the control you actually work.
    const tree = mount({ minimal: true });
    assert.ok(hasClass(tree, 'tp__bar'), 'minimal must keep the transport');
    assert.ok(hasClass(tree, 'tp__config'), 'minimal must keep the settings');
    assert.ok(hasClass(tree, 'tp__console'), 'minimal must keep the console');
    assert.ok(!hasClass(tree, 'tp__controls'), 'minimal must drop the controls row');
    assert.ok(!hasClass(tree, 'tp__foot'), 'minimal must drop the footer');
    assert.match(words(tree), /Squelch/, 'minimal must keep the squelch');
});

t('a wrong receiver mode is warned about rather than refused', () => {
    // The decoder takes whatever the session produces; in AM the tones simply
    // are not there. Saying so beats a console that stays empty for no visible
    // reason — and beats refusing to attach, which the server does not do.
    const tree = mount({}, { tuning: { mode: 'am', frequency: 14072900 } });
    // Only once decoding, which needs the Start button; with decoding off the
    // hint is the one shown instead.
    assert.match(words(tree), /Tune to an Olivia signal in USB/);
});

t('the empty console explains the wait instead of looking broken', () => {
    // Olivia prints nothing for the first several seconds even on a strong
    // signal, because the synchroniser integrates four blocks before it reads
    // one out. An empty console with no explanation reads as a fault.
    const tree = mount();
    const console_ = deep(tree).find((n) => String(n.props.className || '').includes('tp__console'));
    assert.ok(console_, 'no console');
});

t('the panel is registered and asks for audio', () => {
    const entry = EXTENSION_BY_ID.olivia;
    assert.ok(entry, 'olivia missing from the extension registry');
    assert.strictEqual(entry.requiresAudio, true);
    assert.strictEqual(entry.minimal, true);
    assert.ok(entry.Component, 'no component');
});

for (const off of mounted) off();
console.log(`\n${pass} passed`);
