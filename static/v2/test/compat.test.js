// The v1 compatibility layer.
//
// The message payloads here are a contract with pages that cannot be changed,
// so the shapes are asserted field by field against what static/rotator-ui.js
// sends — callsign_lookup.html destructures them without guards, and a missing
// key is a TypeError inside a page we do not control.

const assert = require('assert');

// The module reads `window` at import time (the popup registry mirrors itself
// into window._callsignLookupWindow), so stand one up first.
const calls = [];
global.window = {
    location: { origin: 'https://rx.example' },
    open: (url, name, features) => {
        calls.push({ url, name, features });
        return { closed: false, posted: [], focused: 0, postMessage(m) { this.posted.push(m); }, focus() { this.focused++; } };
    },
};

const b = require('./.build/compat.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const reset = () => { calls.length = 0; b._setLookupWindow(null); };

// Callsign normalisation itself is covered in callsign.test.js — the bridge
// shares that one rule rather than carrying its own.

// --- lookup URL -------------------------------------------------------------

t('the lookup URL carries the session UUID /api/lookup requires', () => {
    assert.strictEqual(b.lookupUrl('abc-123'), '/callsign_lookup.html?uuid=abc-123');
});

t('a callsign given up front rides in the URL too', () => {
    assert.strictEqual(b.lookupUrl('abc', 'M0ABC'), '/callsign_lookup.html?uuid=abc&callsign=M0ABC');
    assert.strictEqual(b.lookupUrl(null, 'M0ABC'), '/callsign_lookup.html?callsign=M0ABC');
    assert.strictEqual(b.lookupUrl(), '/callsign_lookup.html');
});

t('URL parameters are escaped', () => {
    assert.ok(b.lookupUrl('a b&c').includes('uuid=a+b%26c'));
});

// --- popup registry ---------------------------------------------------------

t('opening with no popup up makes one, at v1\'s size', () => {
    reset();
    b.openCallsignLookup({ uuid: 'u1' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, '/callsign_lookup.html?uuid=u1');
    assert.strictEqual(calls[0].name, 'callsign_lookup');
    assert.ok(calls[0].features.includes('width=520'));
    assert.ok(calls[0].features.includes('height=800'));
});

t('opening again reuses the window rather than reloading it', () => {
    reset();
    const win = b.openCallsignLookup({ uuid: 'u1' });
    b.openCallsignLookup({ uuid: 'u1', callsign: 'GB4XYZ/P' });
    assert.strictEqual(calls.length, 1, 'a second window was opened');
    assert.deepStrictEqual(win.posted, [{ type: 'callsign_lookup', uuid: 'u1', callsign: 'GB4XYZ' }]);
    assert.strictEqual(win.focused, 1);
});

t('the window is published where voice-activity.html looks for it', () => {
    reset();
    const win = b.openCallsignLookup({ uuid: 'u1' });
    // voice-activity.html reads window.opener._callsignLookupWindow.
    assert.strictEqual(window._callsignLookupWindow, win);
});

t('a closed popup is not treated as open', () => {
    reset();
    const win = b.openCallsignLookup({ uuid: 'u1' });
    assert.strictEqual(b.callsignLookupWindow(), win);
    win.closed = true;
    assert.strictEqual(b.callsignLookupWindow(), null);
    // ...and the next open makes a fresh one.
    b.openCallsignLookup({ uuid: 'u1' });
    assert.strictEqual(calls.length, 2);
});

// --- routing a callsign to an open popup ------------------------------------

t('a spot click reaches an open popup, normalised', () => {
    reset();
    const win = b.openCallsignLookup({ uuid: 'u1' });
    assert.strictEqual(b.lookupCallsign('F/GB4XYZ/P'), true);
    assert.deepStrictEqual(win.posted, [{ type: 'callsign_lookup', callsign: 'GB4XYZ' }]);
});

t('a spot click with no popup open opens nothing', () => {
    reset();
    assert.strictEqual(b.lookupCallsign('M0ABC'), false);
    assert.strictEqual(calls.length, 0, 'clicking a spot must never spawn a window');
});

t('a spot with no callsign is a no-op', () => {
    reset();
    b.openCallsignLookup({ uuid: 'u1' });
    assert.strictEqual(b.lookupCallsign(''), false);
    assert.strictEqual(b.lookupCallsign(null), false);
});

// --- message payloads -------------------------------------------------------

t('rotator status matches what the lookup page destructures', () => {
    const m = b.rotatorStatusMessage({ connected: true, moving: true, position: { azimuth: 123.7 } }, 'pw');
    assert.deepStrictEqual(m, {
        type: 'rotator_status', enabled: true, connected: true, azimuth: 124, moving: true, hasPassword: true,
    });
});

t('an unknown azimuth is null, not NaN — the page tests it against null', () => {
    assert.strictEqual(b.rotatorStatusMessage({ connected: false }, '').azimuth, null);
    assert.strictEqual(b.rotatorStatusMessage({ position: {} }, '').azimuth, null);
    assert.strictEqual(b.rotatorStatusMessage(null, '').azimuth, null);
});

t('azimuth 0 survives — it is due north, not "missing"', () => {
    assert.strictEqual(b.rotatorStatusMessage({ position: { azimuth: 0 } }, '').azimuth, 0);
});

t('hasPassword is a boolean, so the Set button shows only when it can work', () => {
    assert.strictEqual(b.rotatorStatusMessage({}, '').hasPassword, false);
    assert.strictEqual(b.rotatorStatusMessage({}, 'secret').hasPassword, true);
});

t('ant switch status carries every field the page destructures', () => {
    const m = b.antSwitchStatusMessage({
        enabled: true, num_antennas: 4, antenna_labels: ['A', 'B'], selected: [2],
        grounded: false, thunderstorm: true,
    }, 'pw');
    assert.deepStrictEqual(m, {
        type: 'ant_switch_status', enabled: true, num_antennas: 4, antenna_labels: ['A', 'B'],
        selected: [2], grounded: false, thunderstorm: true, hasPassword: true,
    });
});

t('an absent ant switch still yields a fully-formed message', () => {
    const m = b.antSwitchStatusMessage(null, '');
    // The page does `const { num_antennas, antenna_labels, selected, ... } =`
    // and then iterates the arrays, so these must not be undefined.
    assert.deepStrictEqual(m.antenna_labels, []);
    assert.deepStrictEqual(m.selected, []);
    assert.strictEqual(m.num_antennas, 0);
    assert.strictEqual(m.enabled, false);
    assert.strictEqual(m.hasPassword, false);
});

// --- coverage against the real v1 pages -------------------------------------
//
// The pages are in this repo but cannot be changed — other deployments and the
// v1 frontend run them. So instead of trusting the manifest, read what they
// actually reach for and check it is all accounted for. A new `opener.X` added
// to one of them fails here rather than silently doing nothing in v2.

const fs = require('fs');
const path = require('path');

const PAGES = ['voice-activity.html', 'callsign_lookup.html', 'channels-map.html']
    .map((f) => path.join(__dirname, '..', '..', f));

const sources = PAGES.map((f) => fs.readFileSync(f, 'utf8'));
const all = sources.join('\n');

t('every v1 page the bridge serves is still present', () => {
    PAGES.forEach((f, i) => {
        assert.ok(sources[i].length > 1000, `${path.basename(f)} is missing or truncated`);
    });
});

t('every window.opener global the v1 pages read is published or declared', () => {
    const known = new Set([...b.LEGACY_GLOBALS, ...b.LEGACY_UNSUPPORTED]);
    // Properties of the *window* object, not of the page's own scope.
    const found = new Set(
        [...all.matchAll(/\bopener\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    );
    // Intrinsics the bridge does not have to supply.
    for (const skip of ['closed', 'postMessage', 'document', 'location']) found.delete(skip);
    // wsprPredictions is read by voice-activity.html only in single-band mode,
    // for a decorative badge row; it is optional there and absent is handled.
    found.delete('wsprPredictions');

    const missing = [...found].filter((n) => !known.has(n));
    assert.deepStrictEqual(missing, [], `unhandled opener globals: ${missing.join(', ')}`);
});

t('every message the v1 pages post to the opener is handled', () => {
    const handled = new Set(b.LEGACY_MESSAGES);
    // { type: 'x' } inside a postMessage argument.
    const found = new Set(
        [...all.matchAll(/postMessage\(\s*\{[^}]*type:\s*'([a-z_]+)'/g)].map((m) => m[1]),
    );
    // Sent to the lookup popup, not to the opener — the bridge is the sender
    // for these, and its payloads are asserted above.
    for (const outbound of ['rotator_status', 'ant_switch_status', 'callsign_lookup']) found.delete(outbound);

    const missing = [...found].filter((n) => !handled.has(n));
    assert.deepStrictEqual(missing, [], `unhandled inbound messages: ${missing.join(', ')}`);
});

t('the manifest matches what the bridge actually installs', () => {
    // Both halves of the bridge: the component installs the globals that need
    // React state behind them, and legacyBridge.js the ones tied to a popup's
    // lifetime (the lookup window, and the map's channel list).
    const compat = path.join(__dirname, '..', 'src', 'compat');
    const src = fs.readFileSync(path.join(compat, 'LegacyBridge.jsx'), 'utf8')
        + fs.readFileSync(path.join(compat, 'legacyBridge.js'), 'utf8');
    for (const name of b.LEGACY_GLOBALS) {
        assert.ok(
            new RegExp(`(w|window)\\.${name}\\s*=`).test(src),
            `${name} is in the manifest but the bridge never assigns it`,
        );
    }
    for (const type of b.LEGACY_MESSAGES) {
        assert.ok(src.includes(`'${type}'`), `${type} is in the manifest but the bridge never handles it`);
    }
});

if (process.exitCode) console.log('\ncompat tests FAILED');
else console.log(`\nall ${pass} compat tests passed`);
