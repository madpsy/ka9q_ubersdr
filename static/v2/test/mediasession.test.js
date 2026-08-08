// Media Session: the parts that decide what the OS shows and what the browser
// needs, both of which are wrong in ways nothing throws about.
//
// The marker matching is the interesting half. A lock-screen album line reading
// "G4ABC" when the dial is 3 kHz away from that spot is not an error anywhere —
// it is a tolerance and a mode-family comparison quietly disagreeing — and the
// only place it shows up is on a phone in someone's pocket.

const assert = require('assert');
const {
    MARKER_TOLERANCE_HZ, callsignOf, collectMarkers, countryOf, findMarkers, modeFamily,
} = require('./.build/markernav.cjs');
const { buildMetadata, formatFrequency, markerLabel, sameMetadata } = require('./.build/mediametadata.cjs');
const { detectSupport, resolveAnchor } = require('./.build/mediasupport.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- what the browser needs -------------------------------------------------

const CHROME_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126 Mobile/15E148 Safari/604.1';
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Edg/126';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

t('desktop Chrome needs no element at all — the context is enough', () => {
    // Pinned: v1 uses this path on desktop Chrome and the controls do appear,
    // so a change here would be a regression rather than a fix.
    const s = detectSupport(CHROME_DESKTOP, { hasMediaSession: true, hasContextSink: true });
    assert.strictEqual(s.anchor, 'none');
    // Opt-in off Apple, so nobody gets a media widget they did not ask for.
    assert.strictEqual(s.defaultEnabled, false);
});

t('Android Chrome needs the URL stream, not the bridge', () => {
    const s = detectSupport(CHROME_ANDROID, { hasMediaSession: true, hasContextSink: true });
    assert.strictEqual(s.anchor, 'stream');
    assert.strictEqual(s.androidChrome, true);
});

t('Apple takes the bridge and is on by default', () => {
    const s = detectSupport(SAFARI_IOS, { hasMediaSession: true, hasContextSink: false });
    assert.strictEqual(s.anchor, 'bridge');
    assert.strictEqual(s.defaultEnabled, true);
});

t('Chrome on a Mac is Chrome, not Apple — no bridge', () => {
    // The bug this pins: its user agent says Macintosh, so it was read as Apple
    // and handed the bridge, which Chromium never raises controls for. The same
    // browser on Linux took the 'none' path and worked, which is what made it
    // look like a Mac problem rather than a detection one.
    const s = detectSupport(CHROME_MAC, { hasMediaSession: true, hasContextSink: true });
    assert.strictEqual(s.anchor, 'none');
    assert.strictEqual(s.blink, true);
    // Still an Apple platform for the default-on decision, which is about where
    // lock-screen control matters and not about which element to play.
    assert.strictEqual(s.apple, true);
});

t('Blink on Windows needs the URL stream, as it does on Android', () => {
    // An audible AudioContext alone raises the controls on Linux and macOS but
    // not the Windows SMTC widget, which wants a real media resource behind the
    // session. Measured, not reasoned: 'none' shows nothing there.
    for (const [name, ua] of [['Chrome', CHROME_WIN], ['Edge', EDGE_WIN]]) {
        const s = detectSupport(ua, { hasMediaSession: true, hasContextSink: true });
        assert.strictEqual(s.anchor, 'stream', `${name} on Windows`);
        assert.strictEqual(s.windows, true);
    }
});

t('Blink elsewhere is unchanged — Windows is the exception, not the rule', () => {
    // The stream anchor costs the scope, the recorder and the audio filters, so
    // it is only taken where nothing else works.
    for (const ua of [CHROME_DESKTOP, CHROME_MAC]) {
        assert.strictEqual(detectSupport(ua, { hasMediaSession: true, hasContextSink: true }).anchor, 'none');
    }
});

t('Firefox on Windows is left on the bridge', () => {
    // Not Blink, so none of the above applies to it — and nothing has been
    // measured there to justify moving it.
    const s = detectSupport(FIREFOX_WIN, { hasMediaSession: true, hasContextSink: false });
    assert.strictEqual(s.anchor, 'bridge');
    assert.strictEqual(s.blink, false);
    assert.strictEqual(s.windows, true);
});

t('Safari on the same Mac still takes the bridge', () => {
    const s = detectSupport(SAFARI_MAC, { hasMediaSession: true, hasContextSink: false });
    assert.strictEqual(s.anchor, 'bridge');
    assert.strictEqual(s.blink, false);
});

t('Chrome on iOS is WebKit wearing a badge, and needs what Safari needs', () => {
    const s = detectSupport(CHROME_IOS, { hasMediaSession: true, hasContextSink: false });
    assert.strictEqual(s.anchor, 'bridge');
    assert.strictEqual(s.blink, false);
});

t('Android Chrome takes the URL stream even where it cannot sink a context', () => {
    // Reaching the bridge first would have caught this too: no Android browser
    // can point an AudioContext at an output device, and the bridge is exactly
    // what Chrome ignores there.
    const s = detectSupport(CHROME_ANDROID, { hasMediaSession: true, hasContextSink: false });
    assert.strictEqual(s.anchor, 'stream');
});

t('a browser that cannot sink an AudioContext takes the bridge', () => {
    // This is the Firefox case, detected by capability rather than by name.
    const s = detectSupport(FIREFOX, { hasMediaSession: true, hasContextSink: false });
    assert.strictEqual(s.anchor, 'bridge');
    assert.strictEqual(s.apple, false);
});

t('no Media Session API means never on by default', () => {
    const s = detectSupport(SAFARI_IOS, { hasMediaSession: false, hasContextSink: false });
    assert.strictEqual(s.available, false);
    assert.strictEqual(s.defaultEnabled, false);
});

t('a forced anchor wins over detection, and junk falls back to it', () => {
    const chrome = detectSupport(CHROME_DESKTOP, { hasMediaSession: true, hasContextSink: true });
    assert.strictEqual(resolveAnchor(chrome, 'auto'), 'none');
    assert.strictEqual(resolveAnchor(chrome, 'stream'), 'stream', 'the override is the point');
    assert.strictEqual(resolveAnchor(chrome, ''), 'none');
    // A stored value from a future version that no longer exists must not
    // silently disable the feature.
    assert.strictEqual(resolveAnchor(chrome, 'nonsense'), 'none');
});

// --- frequency formatting ---------------------------------------------------

t('frequency reads as MHz.kHz.Hz with every group padded', () => {
    assert.strictEqual(formatFrequency(21242500), '21.242.500 MHz');
    assert.strictEqual(formatFrequency(7125000), '7.125.000 MHz');
    // The padding is the point: 7.5.0 would be unreadable and 7.050.000 is not
    // the same frequency as 7.5.000.
    assert.strictEqual(formatFrequency(7005000), '7.005.000 MHz');
    assert.strictEqual(formatFrequency(145525000), '145.525.000 MHz');
    assert.strictEqual(formatFrequency(0), '');
});

// --- marker matching --------------------------------------------------------

const spot = (frequency, callsign, kind) => ({ frequency, callsign, kind });
const mark = (frequency, name, mode) => ({ frequency, name, mode });

t('a spot inside the tolerance is the current marker, outside it is not', () => {
    const m = collectMarkers({ cw: [spot(7005000, 'G4ABC', 'cw')] });
    const on = findMarkers(m, 7005000 + MARKER_TOLERANCE_HZ, 'cwl');
    assert.ok(on.current, 'at the edge of the window it still counts');
    assert.strictEqual(on.current.name, 'G4ABC');

    const off = findMarkers(m, 7005000 + MARKER_TOLERANCE_HZ + 1, 'cwl');
    assert.strictEqual(off.current, null);
    // Just outside the window it becomes a neighbour instead — which is what
    // makes ⏭ able to step onto it.
    assert.ok(off.prev);
});

t('the mode family has to match, so a CW spot is not an SSB marker', () => {
    const m = collectMarkers({ cw: [spot(7005000, 'G4ABC', 'cw')] });
    assert.ok(findMarkers(m, 7005000, 'cwu').current, 'cwu and cwl are one family');
    assert.strictEqual(findMarkers(m, 7005000, 'lsb').current, null);
});

t('a bookmark with no mode matches whatever you are listening in', () => {
    const m = collectMarkers({ bookmarks: [mark(7100000, 'Net')] });
    assert.strictEqual(findMarkers(m, 7100000, 'lsb').current.name, 'Net');
    assert.strictEqual(findMarkers(m, 7100000, 'am').current.name, 'Net');
});

t('a live spot beats a bookmark on the same frequency', () => {
    // Both match; the spot is who is there now, the bookmark is what it always
    // is, and the lock screen should say the former.
    const m = collectMarkers({
        dx: [spot(14200000, 'VK3XYZ', 'dx')],
        bookmarks: [mark(14200000, 'Calling', 'usb')],
    });
    assert.strictEqual(findMarkers(m, 14200000, 'usb').current.name, 'VK3XYZ');
});

// --- confirmed voice, under the voice type ----------------------------------

const heard = (hz, callsign, mode) => ({ hz, callsign, mode, cc: 'GB', country: 'Scotland' });
const detected = (hz, mode) => ({ frequency: hz, mode });

t('a confirmed callsign steps as a voice marker, not a type of its own', () => {
    // Stepping between "voices" is one activity. A separate nav type would have
    // made you tick two boxes to do it, describing where the data came from
    // rather than what you were looking for.
    const m = collectMarkers({ confirmed: [heard(14205000, 'MM3NDH', 'usb')] });
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].type, 'voice');
    assert.strictEqual(findMarkers(m, 14205000, 'usb', ['voice']).current.name, 'MM3NDH');
    // And it is filtered out with the rest of the voice markers.
    assert.strictEqual(findMarkers(m, 14100000, 'usb', ['dx']).next, null);
});

t('a confirmed callsign is a callsign, so it is worth a lookup', () => {
    const m = collectMarkers({ confirmed: [heard(14205000, 'MM3NDH', 'usb')] });
    assert.strictEqual(callsignOf(m[0]), 'MM3NDH');
    assert.strictEqual(m[0].countryCode, 'GB');
});

t('a confirmed callsign outranks a bare detection on the same frequency', () => {
    // Both will often be there — the skimmer confirms what the detector heard —
    // and when they are, the dial should be labelled with the name.
    const m = collectMarkers({
        voice: [detected(14205000, 'usb')],
        confirmed: [heard(14205000, 'MM3NDH', 'usb')],
    });
    assert.strictEqual(findMarkers(m, 14205000, 'usb', ['voice']).current.name, 'MM3NDH');
});

t('prev and next are the nearest either side, in any mode', () => {
    const m = collectMarkers({
        bookmarks: [mark(7000000, 'low'), mark(7050000, 'near-low'), mark(7150000, 'near-high'), mark(7300000, 'high')],
    });
    const r = findMarkers(m, 7100000, 'lsb');
    assert.strictEqual(r.current, null);
    assert.strictEqual(r.prev.name, 'near-low');
    assert.strictEqual(r.next.name, 'near-high');
});

t('navTypes filters the neighbours but never the marker you are on', () => {
    const m = collectMarkers({
        cw: [spot(7005000, 'G4ABC', 'cw')],
        bookmarks: [mark(7100000, 'Net')],
    });
    // Stepping through bookmarks only, while sitting on a CW spot.
    const r = findMarkers(m, 7005000, 'cwl', ['bookmark-server']);
    assert.strictEqual(r.current.name, 'G4ABC', 'the dial is still labelled');
    assert.strictEqual(r.next.name, 'Net');

    const noBookmarks = findMarkers(m, 7005000, 'cwl', ['cw']);
    assert.strictEqual(noBookmarks.next, null, 'the bookmark is filtered out');
});

t('mode families collapse the pairs that mean the same thing', () => {
    assert.strictEqual(modeFamily('cwu'), modeFamily('cwl'));
    assert.strictEqual(modeFamily('sam'), modeFamily('am'));
    assert.strictEqual(modeFamily('nfm'), modeFamily('fm'));
    assert.notStrictEqual(modeFamily('usb'), modeFamily('lsb'));
});

// --- what the OS shows ------------------------------------------------------

t('the three lines carry receiver, dial and marker', () => {
    const meta = buildMetadata({
        frequency: 14175000,
        mode: 'usb',
        receiver: 'M0ABC',
        marker: { name: 'VK3XYZ', type: 'dx' },
        lookup: null,
    });
    assert.strictEqual(meta.title, 'UberSDR • M0ABC');
    assert.strictEqual(meta.artist, '14.175.000 MHz • USB • VK3XYZ');
    assert.strictEqual(meta.album, 'VK3XYZ');
});

t('with no marker the album says so rather than going blank', () => {
    const meta = buildMetadata({ frequency: 7100000, mode: 'lsb', receiver: '', marker: null });
    assert.strictEqual(meta.title, 'UberSDR');
    assert.strictEqual(meta.artist, '7.100.000 MHz • LSB');
    assert.strictEqual(meta.album, 'Live SDR');
});

t('a bookmark contributes its name but not a callsign to the dial line', () => {
    const meta = buildMetadata({
        frequency: 7100000, mode: 'lsb', receiver: 'M0ABC',
        marker: { name: 'Sunday net', type: 'bookmark-server' },
    });
    assert.strictEqual(meta.artist, '7.100.000 MHz • LSB', 'a bookmark name is not a callsign');
    assert.strictEqual(meta.album, 'Sunday net');
});

t('a lookup enriches a callsign marker, and only a callsign marker', () => {
    const lookup = { firstName: 'Dave', country: 'England' };
    assert.strictEqual(markerLabel({ name: 'G4ABC', type: 'cw' }, lookup), 'G4ABC — Dave, England');
    assert.strictEqual(markerLabel({ name: 'Sunday net', type: 'bookmark-local' }, lookup), 'Sunday net');
    // A partial result should not leave a dangling separator.
    assert.strictEqual(markerLabel({ name: 'G4ABC', type: 'dx' }, { firstName: 'Dave' }), 'G4ABC — Dave');
    assert.strictEqual(markerLabel({ name: 'G4ABC', type: 'dx' }, {}), 'G4ABC');
});

t('the dedup notices a photo arriving after the text is already set', () => {
    // This is the case that matters: the lookup lands seconds after the tuning
    // change, the three lines are unchanged, and the artwork still has to be
    // pushed or the operator photo never appears.
    const text = { title: 'UberSDR', artist: '7.005.000 MHz • CWL • G4ABC', album: 'G4ABC' };
    assert.ok(sameMetadata({ ...text, photo: '' }, { ...text, photo: '' }));
    assert.ok(!sameMetadata({ ...text, photo: '/api/lookup/image/x' }, { ...text, photo: '' }));
    assert.ok(!sameMetadata(text, null));
});

// --- what is worth looking up ------------------------------------------------

t('a marker whose name is not a callsign is not looked up', () => {
    // The bug: voice activity with no station decoded is labelled "Voice 20m",
    // and being a callsign *type* was the only test — so the lookup service was
    // asked about it, and spent a request and a rate-limit slot saying no.
    assert.strictEqual(callsignOf({ type: 'voice', name: 'Voice 20m', call: '' }), '');
    // "Voice" on its own is five letters and passes any callsign pattern you
    // care to write, which is why the label is not what gets read.
    assert.strictEqual(callsignOf({ type: 'voice', name: 'Voice', call: '' }), '');
    assert.strictEqual(callsignOf({ type: 'dx', name: 'DL1ABC' }), '', 'no call field, no lookup');
    assert.strictEqual(callsignOf({ type: 'cw', name: 'CQ DX', call: 'CQ DX' }), '');
});

t('a callsign marker gives its callsign, normalised', () => {
    assert.strictEqual(callsignOf({ type: 'dx', call: 'dl1abc' }), 'DL1ABC');
    assert.strictEqual(callsignOf({ type: 'voice', call: 'GM4XYZ' }), 'GM4XYZ');
    // A portable callsign reduces to its longest part, as the lookup wants.
    assert.strictEqual(callsignOf({ type: 'cw', call: 'F/GM4XYZ/P' }), 'GM4XYZ');
});

t('a bookmark is never looked up, whatever it is called', () => {
    // "GB3TEST" as a bookmark name is a repeater, not a station to look up.
    assert.strictEqual(callsignOf({ type: 'bookmark-server', name: 'GB3TEST', call: '' }), '');
    assert.strictEqual(callsignOf({ type: 'bookmark-local', name: 'DL1ABC', call: '' }), '');
    assert.strictEqual(callsignOf(null), '');
});

t('collectMarkers keeps the callsign apart from the label', () => {
    // The voice marker the bug came from: labelled by band, with no station.
    const m = collectMarkers({
        voice: [{ start_freq: 14200000, mode: 'usb', band: '20m' }],
        bookmarks: [{ frequency: 7100000, name: 'GB3TEST' }],
    });
    const voice = m.find((x) => x.type === 'voice');
    assert.ok(voice.name.startsWith('Voice'), voice.name);
    assert.strictEqual(voice.call, '');
    assert.strictEqual(callsignOf(voice), '');
    assert.strictEqual(callsignOf(m.find((x) => x.type === 'bookmark-server')), '');
});

t('a decoded station does reach the lookup', () => {
    const m = collectMarkers({ voice: [{ start_freq: 14200000, mode: 'usb', dx_callsign: 'GM4XYZ' }] });
    assert.strictEqual(callsignOf(m[0]), 'GM4XYZ');
});

t('a marker carries its country, so a neighbour needs no lookup', () => {
    // The prev/next buttons show a flag. Fetching one per marker would be a
    // request for every marker the dial passes.
    const m = collectMarkers({
        dx: [{ frequency: 14200000, callsign: 'DL1ABC', countryCode: 'DE', kind: 'dx' }],
        voice: [{ start_freq: 7100000, mode: 'lsb', dx_callsign: 'GM4XYZ', dx_country_code: 'GB' }],
        bookmarks: [{ frequency: 3700000, name: 'net' }],
    });
    assert.strictEqual(countryOf(m.find((x) => x.type === 'dx')), 'DE');
    assert.strictEqual(countryOf(m.find((x) => x.type === 'voice')), 'GB');
    assert.strictEqual(countryOf(m.find((x) => x.type === 'bookmark-server')), '');
    assert.strictEqual(countryOf(null), '');
});

console.log(`\n${pass} Media Session checks passed`);
