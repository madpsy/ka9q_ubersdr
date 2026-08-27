// The monitor's idea of how far the receiver tunes.
//
// This is Electron's renderer and there is no browser in a test run, so rather than boot
// the page the tuning-range block is lifted out of multi_monitor.js as it ships and run
// against a document stubbed to the handful of elements it touches. Slicing by the names
// it defines means a rename fails the slice loudly rather than quietly testing nothing.
//
// Why it is worth testing at all: this page expressed its limits in MHz (`max="30"` on
// three inputs, `mhz > 30` in the rig-follow gate), which is why a repo-wide search for
// 30000000 never found them. On a 129.6 Msps receiver every one of those refused 6 m
// while the spectrum plainly showed it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'monitor', 'multi_monitor.js'), 'utf8');
const MARKUP = fs.readFileSync(path.join(__dirname, '..', 'monitor', 'index.html'), 'utf8');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const ta = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const start = SOURCE.indexOf('const FALLBACK_MIN_FREQ_HZ');
const end = SOURCE.indexOf('// Frequency state');
assert.ok(start > 0, 'the tuning-range block was not found in multi_monitor.js');
assert.ok(end > start, 'could not find the end of the tuning-range block');
const BLOCK = SOURCE.slice(start, end);

// --- the smallest document that runs it --------------------------------------

function makeEl(id) {
    return {
        id,
        min: '', max: '', value: '', innerHTML: '', textContent: '',
        _class: '',
        classList: {
            add(c) { this._owner._class = (this._owner._class + ' ' + c).trim(); },
            remove(c) {
                this._owner._class = this._owner._class.split(/\s+/)
                    .filter((x) => x && x !== c).join(' ');
            },
        },
    };
}

function makeSandbox(over = {}) {
    const els = {};
    for (const id of ['freqSlider', 'freqInput', 'snrModalFreqInput', 'freqDisplay', 'modeIndicator']) {
        els[id] = makeEl(id);
        els[id].classList._owner = els[id];
    }
    const markers = { innerHTML: '' };

    const sandbox = {
        document: {
            getElementById: (id) => els[id] || null,
            querySelector: (sel) => (sel === '.freq-markers' ? markers : null),
        },
        // Referenced by revalidateFrequency, which lives in the slice but reads state
        // defined further down the file.
        DEFAULT_FREQ_HZ: 14100000,
        currentFreqHz: 14100000,
        currentMode: 'usb',
        isFreqValid: true,
        resolveMode: () => 'usb',
        Number, Math, String, JSON, console,
        ...over,
    };
    vm.createContext(sandbox);
    vm.runInContext(BLOCK, sandbox);
    sandbox._els = els;
    sandbox._markers = markers;
    // minFreqHz/maxFreqHz are `let` at the top of the block, so they live in the
    // context's lexical scope rather than becoming properties of the sandbox object.
    // Evaluating in the same context is how a test reads them.
    sandbox._range = () => vm.runInContext('({ min: minFreqHz, max: maxFreqHz })', sandbox);
    return sandbox;
}

const FALLBACK = { min: 10000, max: 30000000 };

// --- the fallback contract ---------------------------------------------------

t('before anything is said, the range is 10 kHz - 30 MHz', () => {
    const s = makeSandbox();
    assert.strictEqual(s._range().min, FALLBACK.min);
    assert.strictEqual(s._range().max, FALLBACK.max);
});

t('a receiver that publishes no range leaves it alone', () => {
    const s = makeSandbox();
    s.applyTuningRange(undefined);
    s.applyTuningRange(null);
    s.applyTuningRange({});
    assert.strictEqual(s._range().min, FALLBACK.min);
    assert.strictEqual(s._range().max, FALLBACK.max);
});

t('zero, null and a string are not limits', () => {
    const s = makeSandbox();
    s.applyTuningRange({ min_frequency: 0, max_frequency: 0 });
    assert.deepStrictEqual([s._range().min, s._range().max], [FALLBACK.min, FALLBACK.max]);
    s.applyTuningRange({ min_frequency: null, max_frequency: null });
    assert.deepStrictEqual([s._range().min, s._range().max], [FALLBACK.min, FALLBACK.max]);
    s.applyTuningRange({ min_frequency: '10000', max_frequency: 'lots' });
    assert.deepStrictEqual([s._range().min, s._range().max], [FALLBACK.min, FALLBACK.max]);
});

t('each edge falls back on its own', () => {
    const s = makeSandbox();
    s.applyTuningRange({ max_frequency: 60000000 });
    assert.deepStrictEqual([s._range().min, s._range().max], [10000, 60000000]);
});

t('an inverted range is refused wholesale', () => {
    const s = makeSandbox();
    assert.strictEqual(s.applyTuningRange({ min_frequency: 60000000, max_frequency: 10000 }), false);
    assert.deepStrictEqual([s._range().min, s._range().max], [FALLBACK.min, FALLBACK.max]);
    assert.strictEqual(s.applyTuningRange({ min_frequency: 30000000, max_frequency: 30000000 }), false);
    assert.deepStrictEqual([s._range().min, s._range().max], [FALLBACK.min, FALLBACK.max]);
});

t('adopting the same range again reports no change', () => {
    const s = makeSandbox();
    assert.strictEqual(s.applyTuningRange({ min_frequency: 10000, max_frequency: 30000000 }), false);
    assert.strictEqual(s.applyTuningRange({ min_frequency: 10000, max_frequency: 60000000 }), true);
});

// --- the controls follow -----------------------------------------------------

t('the three frequency inputs are resized, in MHz', () => {
    const s = makeSandbox();
    s.applyTuningRange({ min_frequency: 10000, max_frequency: 60000000 });
    for (const id of ['freqSlider', 'freqInput', 'snrModalFreqInput']) {
        assert.strictEqual(s._els[id].max, '60', `${id} max`);
        assert.strictEqual(s._els[id].min, '0.01', `${id} min`);
    }
});

t('the slider tick labels name the new frequencies', () => {
    const s = makeSandbox();
    s.applyTuningRange({ min_frequency: 10000, max_frequency: 60000000 });
    const html = s._markers.innerHTML;
    // Six intervals across 60 MHz: 0, 10, 20, 30, 40, 50, 60.
    assert.ok(/>0</.test(html), 'starts at 0');
    assert.ok(/>60</.test(html), 'ends at 60');
    assert.ok(/>30</.test(html), 'has a midpoint');
    assert.ok(/left:100.00%/.test(html), 'the last marker is at the right edge');
});

t('and still read 0..30 on an ordinary receiver', () => {
    const s = makeSandbox();
    s.applyTuningRange({ min_frequency: 10000, max_frequency: 30000000 });
    const html = s._markers.innerHTML;
    for (const n of [0, 5, 10, 15, 20, 25, 30]) {
        assert.ok(new RegExp(`>${n}<`).test(html), `marker ${n}`);
    }
});

// --- the in-range test the rest of the page uses -----------------------------

t('6 m is out of range on a 30 MHz receiver and in range on a 60', () => {
    const s = makeSandbox();
    assert.strictEqual(s.freqInRangeMhz(50.313), false);
    s.applyTuningRange({ min_frequency: 10000, max_frequency: 60000000 });
    assert.strictEqual(s.freqInRangeMhz(50.313), true);
});

t('the bottom edge is the server 10 kHz, not the old 0.1 MHz', () => {
    const s = makeSandbox();
    // 0.05 MHz = 50 kHz: inside 10 kHz, outside the 0.1 MHz this page used to enforce.
    assert.strictEqual(s.freqInRangeMhz(0.05), true);
    assert.strictEqual(s.freqInRangeMhz(0.005), false);
});

// --- the deferred check on a restored frequency ------------------------------

t('a frequency the receiver covers survives revalidation', () => {
    const s = makeSandbox({ currentFreqHz: 21074000 });
    s.revalidateFrequency();
    assert.strictEqual(s.currentFreqHz, 21074000);
});

t('a 6 m link survives once the wide range is known', () => {
    // The case the deferral exists for: restoreFreqFromURL accepted 50.313 MHz
    // unvalidated, and by the time this runs the receiver has said it reaches 60.
    const s = makeSandbox({ currentFreqHz: 50313000 });
    s.applyTuningRange({ min_frequency: 10000, max_frequency: 60000000 });
    s.revalidateFrequency();
    assert.strictEqual(s.currentFreqHz, 50313000);
});

t('and is replaced by the default when the receiver cannot reach it', () => {
    const s = makeSandbox({ currentFreqHz: 50313000 });
    s.revalidateFrequency();   // still the 30 MHz fallback
    assert.strictEqual(s.currentFreqHz, 14100000);
    // Reset to the default, not clamped to the band edge: clamping looks like success
    // and silently leaves the user somewhere they never asked for.
    assert.notStrictEqual(s.currentFreqHz, 30000000);
});

// --- the fetch ---------------------------------------------------------------

ta('a receiver that answers is adopted', async () => {
    const s = makeSandbox();
    s.fetch = async () => ({
        ok: true,
        json: async () => ({ tuning_range: { min_frequency: 10000, max_frequency: 60000000 } }),
    });
    await s.loadTuningRange();
    assert.strictEqual(s._range().max, 60000000);
});

ta('a receiver that cannot be reached leaves the fallback in force', async () => {
    const s = makeSandbox({ currentFreqHz: 50313000 });
    s.fetch = async () => { throw new Error('ECONNREFUSED'); };
    await s.loadTuningRange();
    assert.strictEqual(s._range().max, FALLBACK.max);
    // And the deferred check still ran, so a frequency nothing validated does not
    // survive a failed fetch.
    assert.strictEqual(s.currentFreqHz, 14100000);
});

ta('a 404 leaves the fallback in force', async () => {
    const s = makeSandbox();
    s.fetch = async () => ({ ok: false, status: 404 });
    await s.loadTuningRange();
    assert.strictEqual(s._range().max, FALLBACK.max);
});

ta('a body that is not JSON leaves the fallback in force', async () => {
    const s = makeSandbox();
    s.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
    await s.loadTuningRange();
    assert.strictEqual(s._range().max, FALLBACK.max);
});

// --- the markup the block reaches into ---------------------------------------

t('every element the block looks up exists in index.html', () => {
    for (const id of ['freqSlider', 'freqInput', 'snrModalFreqInput']) {
        assert.ok(MARKUP.includes(`id="${id}"`), `index.html has #${id}`);
    }
    assert.ok(/class="freq-markers"/.test(MARKUP), 'index.html has .freq-markers');
});

t('index.html no longer hardcodes the old 0.1-30 MHz bounds', () => {
    // The markup carries the fallback, which applyTuningRange rewrites — but the
    // bottom must be the server's 10 kHz, not this page's old 0.1 MHz.
    assert.ok(!/min="0\.1"/.test(MARKUP), 'no input still starts at 0.1 MHz');
});

setTimeout(() => console.log(`\n${pass} ok`), 0);
