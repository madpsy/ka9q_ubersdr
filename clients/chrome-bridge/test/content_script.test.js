// The content script, against a real v2 page.
//
// Everything the extension depends on the page for, and everything the page
// depends on the extension for. The receiver actions at the far end are the
// real command layer, so a test that presses a popup button here ends in the
// call the receiver would actually make.

const assert = require('assert');
const { makePage } = require('./harness.js');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A page that has announced itself and has us registered.
function attached(over) {
    const p = makePage(over);
    p.toBackground.length = 0;          // drop the registration noise
    return p;
}

// --- detection ---------------------------------------------------------------

t('a page that is not an UberSDR is left entirely alone', () => {
    // The whole cost on every other page in the browser: one idle listener.
    // No polling, no timers, no injected script, nothing sent anywhere — and
    // nothing in the console. This runs on every site you visit, so a
    // "looking for an UberSDR…" line would be noise on all of them.
    const p = makePage({ silent: true });
    assert.deepStrictEqual(p.toBackground, []);
    assert.deepStrictEqual(p.logs, []);
    assert.deepStrictEqual(p.warnings, []);
});

t('finding a receiver says so once, and only once', () => {
    const p = makePage();
    assert.strictEqual(p.logs.length, 1, p.logs.join('|'));
    assert.match(p.logs[0], /attached to M9PSY — Test RX \(API 1\.0\)/);

    // Not again on every patch that follows.
    p.advance(1000);
    p.publish('tuning', { frequency: 7100000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700, vfo: 'A', band: '40m' });
    p.advance(1000);
    p.publish('signal', { dbfs: -50, noise: -110, snr: 60, s: 11, level: 0.9, clipping: false });
    assert.strictEqual(p.logs.length, 1, p.logs.join('|'));
});

t('an UberSDR page registers itself without being asked twice', () => {
    const p = makePage();
    const reg = p.sent('ubersdr:register');
    assert.strictEqual(reg.length, 1);
    assert.strictEqual(reg[0].sessionId, 'sess-1');
    assert.strictEqual(reg[0].url, 'https://rx.example/v2/');
    assert.deepStrictEqual(reg[0].receiver.id, 'uuid-1');
    assert.strictEqual(reg[0].audioStarted, true);
});

t('the tab is labelled by its receiver, not by the document title', () => {
    // v2 rewrites the title on every turn of the dial. A title-derived label
    // flickered and said nothing the state row does not already show.
    const p = makePage();
    assert.strictEqual(p.sent('ubersdr:register')[0].title, 'M9PSY — Test RX');
});

t('a page whose server has not answered yet still gets a usable label', () => {
    const p = makePage({ receiver: null });
    assert.strictEqual(p.sent('ubersdr:register')[0].title, 'M9PSY UberSDR - 14.074 MHz USB');
});

t('a page speaking a later API major is left alone rather than half-driven', () => {
    const p = makePage({ api: { major: 2, minor: 0 } });
    assert.deepStrictEqual(p.sent('ubersdr:register'), []);
    assert.ok(p.warnings.some((w) => /API v2/.test(w)), p.warnings.join('|'));
});

t('the page is subscribed to, with the meter asked for less often', () => {
    const p = makePage();
    // The registration snapshot proves the subscribe landed and came back.
    const snap = p.sent('ubersdr:state_snapshot');
    assert.ok(snap.length >= 1);
    assert.strictEqual(snap[0].state.freq, 14074000);
    assert.strictEqual(snap[0].state.mode, 'usb');
});

// --- page → background -------------------------------------------------------

t('a tuning change arrives as the flat state the popup already speaks', () => {
    const p = attached();
    p.advance(1000);
    p.publish('tuning', {
        frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50,
        vfo: 'A', band: '40m',
    });
    const msgs = p.sent('ubersdr:state');
    assert.strictEqual(msgs.length, 1);
    assert.deepStrictEqual(msgs[0].state, {
        freq: 7100000, mode: 'lsb', bwLow: -2700, bwHigh: -50, band: '40m',
    });
});

t('only what changed is forwarded', () => {
    const p = attached();
    p.advance(1000);
    p.publish('tuning', {
        frequency: 14074000, mode: 'lsb', bandwidthLow: 50, bandwidthHigh: 2700,
        vfo: 'A', band: '20m',
    });
    assert.deepStrictEqual(p.sent('ubersdr:state')[0].state, { mode: 'lsb' });
});

t('a signal reading that does not exist is forwarded as null, not as a level', () => {
    // The popup shows "—" for this. Sending a very negative number instead
    // would draw a cliff on the meter, and dropping it would freeze the meter
    // on the last real reading.
    const p = attached();
    p.advance(1000);
    p.publish('signal', { dbfs: null, noise: null, snr: null, s: null, level: null, clipping: false });
    const state = p.sent('ubersdr:state')[0].state;
    assert.strictEqual(state.dbfs, null);
    assert.strictEqual(state.snr, null);
});

t('the S value comes from the page, so both meters agree', () => {
    // Rather than being re-derived in the popup from a dBFS curve that could
    // drift out of step with the one on screen.
    const p = attached();
    p.advance(1000);
    p.publish('signal', { dbfs: -53, noise: -110, snr: 57, s: 11, level: 0.8, clipping: false });
    const state = p.sent('ubersdr:state')[0].state;
    assert.strictEqual(state.s, 11);
    assert.strictEqual(state.dbfs, -53);
});

t('a tuning value that is not known is dropped rather than sent as null', () => {
    // The popup would print an empty frequency and throw on a null mode.
    const p = attached();
    p.advance(1000);
    p.publish('tuning', { frequency: null, mode: null, bandwidthLow: null, bandwidthHigh: null, vfo: null, band: null });
    assert.deepStrictEqual(p.sent('ubersdr:state'), []);
});

t('audio starting and stopping are both reported', () => {
    // v1 could only ever report the start: it watched a CSS class that is
    // removed once. A receiver switched off must stop being treated as live.
    const p = attached();
    p.advance(1000);
    p.publish('session', { id: 'sess-1', running: false });
    assert.deepStrictEqual(p.sent('ubersdr:audio_started'), [{ type: 'ubersdr:audio_started', running: false }]);
    p.advance(1000);
    p.publish('session', { id: 'sess-1', running: true });
    assert.strictEqual(p.sent('ubersdr:audio_started')[1].running, true);
});

// --- background → page -------------------------------------------------------

t('setting a frequency ends in the receiver being tuned', () => {
    const p = attached();
    p.fromBackground({ type: 'cmd:set_freq', freq: 7100000 });
    assert.deepStrictEqual(p.calls, [['tuneTo', { frequency: 7100000 }]]);
});

t('a step button moves relative to where the dial is', () => {
    const p = attached();
    p.fromBackground({ type: 'cmd:adjust_freq', delta: -1000 });
    assert.deepStrictEqual(p.calls, [['tuneTo', { frequency: 14073000 }]]);
});

t('a profile is applied as one tune, not three', () => {
    // Sending frequency, mode and passband separately walks the receiver
    // through intermediate mode/passband pairs on the way, which is audible.
    const p = attached();
    p.fromBackground({ type: 'cmd:tune', freq: 7100000, mode: 'lsb', low: -2700, high: -50 });
    assert.strictEqual(p.calls.length, 1);
    assert.deepStrictEqual(p.calls[0], ['tuneTo', {
        frequency: 7100000, mode: 'lsb', bandwidthLow: -2700, bandwidthHigh: -50,
    }]);
});

t('a partial profile tunes only what it carries', () => {
    const p = attached();
    p.fromBackground({ type: 'cmd:tune', freq: 7100000 });
    assert.deepStrictEqual(p.calls[0], ['tuneTo', { frequency: 7100000 }]);
});

t('an empty tune does nothing rather than erroring at the page', () => {
    const p = attached();
    p.fromBackground({ type: 'cmd:tune' });
    assert.deepStrictEqual(p.calls, []);
    assert.deepStrictEqual(p.warnings, []);
});

t('mode and passband reach the receiver', () => {
    const p = attached();
    p.fromBackground({ type: 'cmd:set_mode', mode: 'cwu' });
    p.fromBackground({ type: 'cmd:set_bandwidth', low: 300, high: 2400 });
    assert.deepStrictEqual(p.calls, [['setMode', 'cwu'], ['setBandwidth', 300, 2400]]);
});

t('mute is absolute, and is the operator\'s own mute', () => {
    // A toggle desynchronises permanently the first time a message is missed.
    const p = attached();
    p.fromBackground({ type: 'cmd:set_mute', muted: true });
    assert.deepStrictEqual(p.calls, [['setMuted', true]]);
    p.fromBackground({ type: 'cmd:set_mute', muted: false });
    assert.deepStrictEqual(p.calls[1], ['setMuted', false]);
});

t('PTT and tab switching duck, and never touch the mute', () => {
    // Ducking is silence that is not the operator's setting: a transmission
    // that ended badly must not leave the receiver muted for good, and the
    // popup's mute button must not be made to lie about what it is showing.
    const p = attached();
    p.fromBackground({ type: 'cmd:set_duck', ducked: true });
    p.fromBackground({ type: 'cmd:set_duck', ducked: false });
    assert.deepStrictEqual(p.calls, [['setDucked', true], ['setDucked', false]]);
    assert.ok(!p.calls.some((c) => c[0] === 'setMuted' || c[0] === 'toggleMute'),
        'ducking touched the mute');
});

t('a refused command is reported and nothing is sent to the background', () => {
    const p = attached();
    p.fromBackground({ type: 'cmd:set_freq', freq: 40000000 });
    assert.deepStrictEqual(p.calls, []);
    assert.deepStrictEqual(p.toBackground, []);
    assert.ok(p.warnings.some((w) => /bad_args/.test(w) && /40000000/.test(w)), p.warnings.join('|'));
});

t('asking for the state answers with all of it', () => {
    const p = attached();
    p.fromBackground({ type: 'cmd:get_state' });
    const snap = p.sent('ubersdr:state_snapshot');
    assert.strictEqual(snap.length, 1);
    assert.strictEqual(snap[0].state.freq, 14074000);
    assert.strictEqual(snap[0].state.muted, false);
    assert.strictEqual(snap[0].state.dbfs, -73);
});

t('commands before the page has answered are ignored, not thrown', () => {
    const p = makePage({ silent: true });
    p.fromBackground({ type: 'cmd:set_freq', freq: 7100000 });
    p.fromBackground({ type: 'cmd:get_state' });
    assert.deepStrictEqual(p.toBackground, []);
});

t('re-registering finds a tab that was already open', () => {
    // What the background sends when the extension is switched back on.
    const p = attached();
    p.fromBackground({ type: 'cmd:reregister' });
    assert.strictEqual(p.sent('ubersdr:register').length, 1);
});

// --- lifecycle ---------------------------------------------------------------

t('the page going away deregisters the tab, and we do not chase it', () => {
    const p = attached();
    p.host.closing();                   // broadcast: page unloading or bridge off
    assert.strictEqual(p.sent('ubersdr:deregister').length, 1);
    // No hello: a page that has gone will announce itself if it comes back, and
    // a bridge that was switched off would only answer "disabled".
    p.toBackground.length = 0;
    p.host.announce();
    assert.strictEqual(p.sent('ubersdr:register').length, 1, 'an announce still re-registers us');
});

t('a churn of other clients does not dislodge a subscribed extension', () => {
    // The page keeps at most eight clients and drops the stalest to make room.
    // A subscriber outranks a registration that never subscribed, which is what
    // a dead one looks like — so a developer reloading their own extension
    // repeatedly cannot evict this one.
    const p = attached();
    const mine = p.host.clients().find((c) => c.startsWith('firefox-bridge-'));
    assert.ok(mine, 'the extension never registered with the page');
    for (let i = 0; i < 12; i++) {
        p.advance(10);
        p.window.dispatchEvent(new p.CE('ubersdr.to-page', {
            detail: JSON.stringify({ v: 1, from: 'client', client: 'other' + i, id: 1, type: 'hello' }),
        }));
    }
    assert.ok(p.host.clients().includes(mine), 'the extension was evicted by idle clients');
    assert.deepStrictEqual(p.sent('ubersdr:deregister'), []);
});

t('being let go to make room brings us straight back', () => {
    // When the page does evict a client it addresses a closing to it. The page
    // is still there and still willing, so introduce ourselves again — unlike
    // the broadcast closing, which means it has gone.
    const p = attached();
    const mine = p.host.clients().find((c) => c.startsWith('firefox-bridge-'));
    p.window.dispatchEvent(new p.CE('ubersdr.from-page', {
        detail: JSON.stringify({ v: 1, from: 'page', type: 'closing', client: mine }),
    }));
    assert.strictEqual(p.sent('ubersdr:deregister').length, 1, 'never noticed being evicted');
    assert.strictEqual(p.sent('ubersdr:register').length, 1, 'never came back');
});

t('unloading the tab deregisters it', () => {
    const p = attached();
    p.unload();
    assert.strictEqual(p.sent('ubersdr:deregister').length, 1);
});

t('a switched-off bridge is reported, not mistaken for a broken page', () => {
    const p = makePage({ enabled: false });
    assert.deepStrictEqual(p.sent('ubersdr:register'), []);
    assert.ok(p.warnings.some((w) => /disabled/.test(w)), p.warnings.join('|'));
});

t('another client on the same page is not overheard', () => {
    const p = attached();
    // A result addressed to somebody else must not be read as ours — it would
    // be mistaken for our own subscribe coming back.
    p.window.dispatchEvent(new p.CE('ubersdr.from-page', {
        detail: JSON.stringify({
            v: 1, from: 'page', type: 'result', id: 1, client: 'somebody-else',
            ok: true, value: { tuning: { frequency: 1 } },
        }),
    }));
    assert.deepStrictEqual(p.toBackground, []);
});

t('junk on the channel is ignored', () => {
    const p = attached();
    p.window.dispatchEvent(new p.CE('ubersdr.from-page', { detail: 'not json' }));
    p.window.dispatchEvent(new p.CE('ubersdr.from-page', { detail: JSON.stringify({ v: 99, from: 'page', type: 'announce' }) }));
    p.window.dispatchEvent(new p.CE('ubersdr.from-page', { detail: JSON.stringify({ v: 1, from: 'client', type: 'announce' }) }));
    assert.deepStrictEqual(p.toBackground, []);
});

console.log(`\n${pass} ok`);
