// The standalone pages that draw a frequency axis, and whether they follow the receiver.
//
// These three are not part of the v2 bundle and have no build step, but v2 links to all
// of them — BandStatsPanel opens noisefloor.html, legacyBridge opens channels-map.html,
// and lib/spectrogram.js opens spectrogram.html, which loads timetravel.js. Each drew a
// fixed 0-30 MHz axis, so on a 129.6 Msps receiver they mislabelled or silently dropped
// everything above 30 MHz — no error, just wrong.
//
// They are plain browser scripts for a DOM this runner does not have, so each function
// under test is sliced out of the file that ships and run against a stub. Slicing by the
// names they define means a rename fails loudly here rather than quietly testing nothing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

/** Slice one brace-balanced declaration, starting at `opener`, out of `src`. */
function sliceBlock(src, opener, what) {
    const start = src.indexOf(opener);
    assert.ok(start >= 0, `${what}: "${opener}" not found`);
    const from = src.indexOf('{', start);
    assert.ok(from > 0, `${what}: no opening brace`);
    let depth = 0;
    for (let i = from; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`${what}: unbalanced braces`);
}

/** The inline <script> out of an HTML page. */
function inlineScript(file) {
    const html = fs.readFileSync(file, 'utf8');
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    return blocks.map((m) => m[1]).join('\n');
}

// =============================================================================
// timetravel.js — the perspective grid's frequency lines
// =============================================================================

const TIMETRAVEL = fs.readFileSync(path.join(STATIC, 'timetravel.js'), 'utf8');
const ttCtx = { Math, isFinite, console };
vm.createContext(ttCtx);
vm.runInContext(sliceBlock(TIMETRAVEL, 'function ttGridFreqs', 'ttGridFreqs'), ttCtx);
// Copy into an array of *this* realm: the function builds its result inside the vm
// context, and deepStrictEqual compares prototypes, so an identical-looking array from
// another realm would never match.
const ttGridFreqs = (a, b) => Array.from(ttCtx.ttGridFreqs(a, b));

t('timetravel: a 30 MHz receiver still gets the familiar 5 MHz grid', () => {
    assert.deepStrictEqual(ttGridFreqs(0, 30e6), [0, 5e6, 10e6, 15e6, 20e6, 25e6, 30e6]);
});

t('timetravel: a 60 MHz receiver gets lines across all of it, not half', () => {
    const g = ttGridFreqs(0, 60e6);
    assert.strictEqual(g[0], 0);
    assert.strictEqual(g[g.length - 1], 60e6);
    // The bug this replaces: the old fixed array stopped at 30 MHz, so the top half of
    // a 60 MHz display had no reference lines at all.
    assert.ok(g.some((f) => f > 30e6), 'there are lines above 30 MHz');
});

t('timetravel: the lines stay on round numbers a reader can name', () => {
    for (const top of [30e6, 60e6, 45e6, 15e6]) {
        for (const f of ttGridFreqs(0, top)) {
            assert.strictEqual(f % 100000, 0, `${f} on a ${top / 1e6} MHz receiver`);
        }
    }
});

t('timetravel: roughly six intervals whatever the span', () => {
    for (const top of [10e6, 30e6, 60e6, 120e6]) {
        const n = ttGridFreqs(0, top).length;
        assert.ok(n >= 4 && n <= 13, `${n} lines on a ${top / 1e6} MHz receiver`);
    }
});

t('timetravel: a degenerate span draws nothing rather than spinning', () => {
    assert.deepStrictEqual(ttGridFreqs(0, 0), []);
    assert.deepStrictEqual(ttGridFreqs(30e6, 0), []);
    assert.deepStrictEqual(ttGridFreqs(0, NaN), []);
    assert.deepStrictEqual(ttGridFreqs(0, Infinity), []);
});

// =============================================================================
// channels-map.html — the frequency bar
// =============================================================================

const CHANNELS = inlineScript(path.join(STATIC, 'channels-map.html'));

function channelsSandbox(over = {}) {
    const box = { updated: 0 };
    const ctx = {
        Number, Math, console,
        updateMap: () => { box.updated++; },
        ...over,
    };
    vm.createContext(ctx);
    vm.runInContext('let receiverMaxHz = 30000000; let freqBarZoom = 1; let freqBarCenter = 15000000;', ctx);
    if (over.zoom !== undefined) vm.runInContext(`freqBarZoom = ${over.zoom};`, ctx);
    vm.runInContext(sliceBlock(CHANNELS, 'function applyTuningRange', 'channels applyTuningRange'), ctx);
    ctx._read = () => vm.runInContext('({ max: receiverMaxHz, centre: freqBarCenter })', ctx);
    ctx._box = box;
    return ctx;
}

t('channels-map: a wider receiver widens the bar and recentres it', () => {
    const s = channelsSandbox();
    s.applyTuningRange({ max_frequency: 60000000 });
    assert.strictEqual(s._read().max, 60000000);
    assert.strictEqual(s._read().centre, 30000000);
    assert.strictEqual(s._box.updated, 1, 'the bar is redrawn');
});

t('channels-map: nothing said leaves the 0-30 MHz bar alone', () => {
    for (const range of [undefined, null, {}, { max_frequency: 0 },
                         { max_frequency: null }, { max_frequency: '60000000' }]) {
        const s = channelsSandbox();
        s.applyTuningRange(range);
        assert.strictEqual(s._read().max, 30000000, JSON.stringify(range));
        assert.strictEqual(s._box.updated, 0, 'and nothing is redrawn');
    }
});

t('channels-map: the same range again is not a change', () => {
    const s = channelsSandbox();
    s.applyTuningRange({ max_frequency: 30000000 });
    assert.strictEqual(s._box.updated, 0);
});

t('channels-map: a user who has zoomed in is not yanked elsewhere', () => {
    const s = channelsSandbox({ zoom: 8 });
    s.applyTuningRange({ max_frequency: 60000000 });
    assert.strictEqual(s._read().max, 60000000, 'the span still widens');
    assert.strictEqual(s._read().centre, 15000000, 'but the view stays put');
});

// =============================================================================
// noisefloor.js — one span stated in MHz, kHz and Hz
// =============================================================================

const NOISEFLOOR = fs.readFileSync(path.join(STATIC, 'noisefloor.js'), 'utf8');
const nfMethod = sliceBlock(NOISEFLOOR, '    applyTuningRange(range)', 'noisefloor applyTuningRange');

function noisefloorSandbox(over = {}) {
    const els = {};
    const ids = ['wideband-frequency', 'wideband-frequency-input', 'wideband-width',
                 'wideband-width-input', 'wideband-frequency-value', 'wideband-width-value',
                 'wideband-span-label', 'wideband-freq-scale-max', 'wideband-width-scale-max'];
    for (const id of ids) els[id] = { id, min: '', max: '', value: '', textContent: '' };

    const ctx = {
        Number, Math, String, console,
        document: { getElementById: (id) => els[id] || null },
    };
    vm.createContext(ctx);
    // The method as it ships, rebound to a plain object standing in for the page.
    vm.runInContext('var _fn = function ' + nfMethod.trim().replace(/^applyTuningRange/, 'applyTuningRange') + ';', ctx);

    const self = {
        receiverMaxMHz: 30,
        widebandFrequency: 15,
        widebandWidth: 30000,
        wideBandChart: over.chart || null,
    };
    Object.assign(self, over.self || {});
    ctx._self = self;
    ctx._els = els;
    ctx._call = (range) => ctx._fn.call(self, range);
    return ctx;
}

t('noisefloor: a 60 MHz receiver rewrites every unit the page states', () => {
    const s = noisefloorSandbox();
    assert.strictEqual(s._call({ max_frequency: 60000000 }), true);
    assert.strictEqual(s._self.receiverMaxMHz, 60);
    // MHz for the centre control...
    assert.strictEqual(s._els['wideband-frequency'].max, '60');
    assert.strictEqual(s._els['wideband-frequency-input'].max, '60');
    // ...kHz for the width control...
    assert.strictEqual(s._els['wideband-width'].max, '60000');
    assert.strictEqual(s._els['wideband-width-input'].max, '60000');
    // ...and the labels a reader actually sees.
    assert.strictEqual(s._els['wideband-span-label'].textContent, '0-60 MHz');
    assert.strictEqual(s._els['wideband-freq-scale-max'].textContent, '60 MHz');
    assert.strictEqual(s._els['wideband-width-scale-max'].textContent, '60000 kHz');
});

t('noisefloor: a full-span view follows the widened receiver', () => {
    const s = noisefloorSandbox();
    s._call({ max_frequency: 60000000 });
    assert.strictEqual(s._self.widebandFrequency, 30);
    assert.strictEqual(s._self.widebandWidth, 60000);
});

t('noisefloor: a zoomed-in view is left where the user put it', () => {
    const s = noisefloorSandbox({ self: { widebandFrequency: 14.1, widebandWidth: 500 } });
    s._call({ max_frequency: 60000000 });
    assert.strictEqual(s._self.widebandFrequency, 14.1);
    assert.strictEqual(s._self.widebandWidth, 500);
    // The bounds still widen, so the user can now zoom back out to the full 60 MHz.
    assert.strictEqual(s._els['wideband-width'].max, '60000');
});

t('noisefloor: nothing said leaves the page at 0-30 MHz', () => {
    for (const range of [undefined, null, {}, { max_frequency: 0 },
                         { max_frequency: null }, { max_frequency: 'wide' }]) {
        const s = noisefloorSandbox();
        assert.strictEqual(s._call(range), false, JSON.stringify(range));
        assert.strictEqual(s._self.receiverMaxMHz, 30);
    }
});

t('noisefloor: the chart axis is widened in place', () => {
    const chart = { options: { scales: { x: { max: 30 } } }, updated: 0,
                    update() { this.updated++; } };
    const s = noisefloorSandbox({ chart });
    s._call({ max_frequency: 60000000 });
    assert.strictEqual(chart.options.scales.x.max, 60);
    assert.strictEqual(chart.updated, 1);
});

t('noisefloor: a page with no chart yet does not throw', () => {
    const s = noisefloorSandbox({ chart: null });
    assert.strictEqual(s._call({ max_frequency: 60000000 }), true);
});

// =============================================================================
// the markup still carries what the code reaches for
// =============================================================================

t('noisefloor.html has every element applyTuningRange writes to', () => {
    const html = fs.readFileSync(path.join(STATIC, 'noisefloor.html'), 'utf8');
    for (const id of ['wideband-frequency', 'wideband-frequency-input', 'wideband-width',
                      'wideband-width-input', 'wideband-span-label',
                      'wideband-freq-scale-max', 'wideband-width-scale-max']) {
        assert.ok(html.includes(`id="${id}"`), `noisefloor.html has #${id}`);
    }
});

t('no page still hardcodes the span it just learned to ask for', () => {
    const nf = fs.readFileSync(path.join(STATIC, 'noisefloor.js'), 'utf8');
    assert.ok(!/Math\.min\(30,/.test(nf), 'noisefloor.js has no bare 30 MHz clamp');
    assert.ok(!/<= 30\)/.test(nf), 'noisefloor.js has no bare 30 MHz filter');
    const cm = fs.readFileSync(path.join(STATIC, 'channels-map.html'), 'utf8');
    // One survivor is expected and correct: the declaration of the fallback itself.
    const hits = (cm.match(/30000000/g) || []).length;
    assert.strictEqual(hits, 1, `channels-map.html has ${hits} literal spans, want 1`);
});

console.log(`\n${pass} ok`);
