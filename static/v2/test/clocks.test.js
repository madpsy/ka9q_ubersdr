// World clocks.
//
// Two things worth pinning. The city list is data an operator's saved selection
// points into, so an id that changes silently empties somebody's panel. And the
// zone lookup goes through Intl, where the failure is quiet: an unknown zone
// throws, and a clock that answered midnight instead would be a lie told
// convincingly.

const assert = require('assert');
const clocks = require('./.build/clocks.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const store = new Map();
global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

// --- the city list -----------------------------------------------------------

t('every city has a unique id and a zone the runtime knows', () => {
    const ids = new Set();
    for (const c of clocks.CLOCK_CITIES) {
        assert.ok(c.id && c.label && c.tz, JSON.stringify(c));
        assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
        ids.add(c.id);
        // A zone name with a typo throws here rather than on somebody's screen.
        assert.ok(clocks.zoneParts(c.tz), `${c.label}: ${c.tz} is not a zone`);
    }
});

t('the defaults are all real cities', () => {
    // A default naming an id that does not exist would open the panel empty.
    for (const id of clocks.DEFAULT_CLOCKS) {
        assert.ok(clocks.clockCity(id), `${id} is not in the list`);
    }
    assert.strictEqual(clocks.DEFAULT_CLOCKS.length, 6, 'the widget shows six');
});

t('the widget\'s six are all offered', () => {
    for (const label of ['Zulu', 'Los Angeles', 'New York', 'London', 'Tokyo', 'Sydney']) {
        assert.ok(clocks.CLOCK_CITIES.some((c) => c.label === label), label);
    }
});

// --- the saved selection -----------------------------------------------------

t('with nothing saved, the defaults are shown', () => {
    clocks._clearClocks();
    assert.deepStrictEqual(clocks.savedClocks().map((c) => c.id), clocks.DEFAULT_CLOCKS);
});

t('a selection survives being saved and read back', () => {
    clocks._clearClocks();
    clocks.saveClocks(['tokyo', 'london']);
    assert.deepStrictEqual(clocks.savedClocks().map((c) => c.id), ['tokyo', 'london']);
});

t('an empty selection is respected, not treated as unset', () => {
    // Removing the last clock must not spring the defaults back.
    clocks._clearClocks();
    clocks.saveClocks([]);
    assert.deepStrictEqual(clocks.savedClocks(), []);
});

t('a city that no longer exists is dropped, not shown blank', () => {
    clocks._clearClocks();
    clocks.saveClocks(['london', 'atlantis', 'tokyo']);
    assert.deepStrictEqual(clocks.savedClocks().map((c) => c.id), ['london', 'tokyo']);
});

t('the same city twice is one clock', () => {
    // The id is the React key, so a duplicate is a rendering bug as well as a
    // wasted cell.
    clocks._clearClocks();
    clocks.saveClocks(['london', 'london']);
    assert.deepStrictEqual(clocks.savedClocks().map((c) => c.id), ['london']);
});

t('the list is capped', () => {
    clocks._clearClocks();
    clocks.saveClocks(clocks.CLOCK_CITIES.map((c) => c.id));
    assert.strictEqual(clocks.savedClocks().length, clocks.MAX_CLOCKS);
});

t('a corrupt or nonsense saved value falls back to the defaults', () => {
    for (const bad of ['{not json', '"a string"', '42', 'null']) {
        clocks._clearClocks();
        global.localStorage.setItem('ubersdr.v2.clocks', bad);
        assert.deepStrictEqual(clocks.savedClocks().map((c) => c.id), clocks.DEFAULT_CLOCKS, bad);
    }
});

t('the display mode is remembered, and anything odd reads as analogue', () => {
    clocks._clearClocks();
    assert.strictEqual(clocks.savedClockMode(), 'analogue');
    clocks.saveClockMode('digital');
    assert.strictEqual(clocks.savedClockMode(), 'digital');
    clocks.saveClockMode('sundial');
    assert.strictEqual(clocks.savedClockMode(), 'analogue');
});

// --- reading a zone ----------------------------------------------------------

const AT = new Date('2026-08-05T15:50:52Z');   // British Summer Time

t('a zone is read at the right wall-clock time', () => {
    assert.deepStrictEqual(clocks.zoneParts('UTC', AT), { hour: 15, minute: 50, second: 52 });
    // BST, so London is an hour ahead of UTC in August — the DST case Intl is
    // here to handle.
    assert.deepStrictEqual(clocks.zoneParts('Europe/London', AT), { hour: 16, minute: 50, second: 52 });
    assert.deepStrictEqual(clocks.zoneParts('Asia/Tokyo', AT), { hour: 0, minute: 50, second: 52 });
});

t('a zone with a half-hour offset is not rounded away', () => {
    assert.deepStrictEqual(clocks.zoneParts('Asia/Kolkata', AT), { hour: 21, minute: 20, second: 52 });
});

t('midnight is hour 0, never 24', () => {
    // en-GB can format midnight as "24", which would put the hour hand two full
    // turns round the face.
    const midnight = new Date('2026-08-05T00:00:30Z');
    assert.strictEqual(clocks.zoneParts('UTC', midnight).hour, 0);
});

t('a zone the browser does not know is null, not midnight', () => {
    assert.strictEqual(clocks.zoneParts('Mars/Olympus_Mons', AT), null);
    assert.strictEqual(clocks.zoneParts('', AT), null);
});

// --- what is drawn -----------------------------------------------------------

t('daylight is 06:00 to 18:00, for the face tint', () => {
    assert.strictEqual(clocks.isDaylight({ hour: 6, minute: 0, second: 0 }), true);
    assert.strictEqual(clocks.isDaylight({ hour: 17, minute: 59, second: 59 }), true);
    assert.strictEqual(clocks.isDaylight({ hour: 18, minute: 0, second: 0 }), false);
    assert.strictEqual(clocks.isDaylight({ hour: 5, minute: 59, second: 59 }), false);
    assert.strictEqual(clocks.isDaylight(null), false);
});

t('the time is padded, with and without seconds', () => {
    const p = { hour: 4, minute: 5, second: 6 };
    assert.strictEqual(clocks.formatClock(p, false), '04:05');
    assert.strictEqual(clocks.formatClock(p, true), '04:05:06');
    assert.strictEqual(clocks.formatClock(null, true), '--:--');
});

t('the hands carry the fraction below them', () => {
    // Twelve o'clock exactly.
    let a = clocks.handAngles({ hour: 12, minute: 0, second: 0 });
    assert.strictEqual(a.hour, 0);
    assert.strictEqual(a.minute, 0);

    // Half past three: the hour hand is halfway to four, not pointing at three.
    a = clocks.handAngles({ hour: 3, minute: 30, second: 0 });
    assert.strictEqual(a.minute, 180);
    assert.ok(a.hour > 90 && a.hour < 120, `hour hand at ${a.hour}°`);
    assert.strictEqual(a.hour, (3.5 / 12) * 360);
});

t('the second hand goes right round and starts again', () => {
    assert.strictEqual(clocks.handAngles({ hour: 0, minute: 0, second: 0 }).second, 0);
    assert.strictEqual(clocks.handAngles({ hour: 0, minute: 0, second: 15 }).second, 90);
    assert.strictEqual(clocks.handAngles({ hour: 0, minute: 0, second: 45 }).second, 270);
});

t('afternoon reads on a twelve-hour face', () => {
    const pm = clocks.handAngles({ hour: 15, minute: 0, second: 0 });
    const am = clocks.handAngles({ hour: 3, minute: 0, second: 0 });
    assert.strictEqual(pm.hour, am.hour);
});

t('no reading points the hands at twelve rather than throwing', () => {
    assert.deepStrictEqual(clocks.handAngles(null), { hour: 0, minute: 0, second: 0 });
});

console.log(`\n${pass} ok`);
