// The background script, driven for real.
//
// Everything here is the path the Radio Control panel's settings take once they
// leave the page: content script → background → flrig. Nothing executed this
// half before, which is how a `tabId` that was never declared came to sit in a
// case statement and throw on every settings message — the panel changed, the
// extension carried on with the old host, and nothing anywhere said why.

const assert = require('assert');
const path = require('path');
const { makeBackground } = require('./bgharness.js');

const EXT = path.join(__dirname, '..', 'extension');
const LIVE_PORT = 12345;        // the only port the stub flrig answers on

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/** A registered, selected UberSDR tab. */
async function withTab(opts) {
    const bg = makeBackground(EXT, opts);
    await bg.say(7, {
        type: 'ubersdr:register',
        sessionId: 's1',
        receiver: { callsign: 'M9PSY', name: 'Test RX' },
        url: 'https://rx/v2/',
        title: 'M9PSY',
        audioStarted: true,
    });
    await bg.settle();
    return bg;
}

const rc = (over = {}) => ({
    transport: 'flrig',
    connect: true,
    direction: 'sdr-to-radio',
    syncFrequency: true,
    syncMode: true,
    muteOnTx: true,
    config: { host: '127.0.0.1', port: LIVE_PORT },
    ...over,
});

t('the panel\'s host and port are what the extension connects to', async () => {
    const bg = await withTab({ flrigPort: LIVE_PORT });
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc() });
    await bg.settle();

    assert.strictEqual(bg.store.flrigHost, '127.0.0.1');
    assert.strictEqual(bg.store.flrigPort, LIVE_PORT);
    assert.strictEqual(bg.store.flrigEnabled, true, 'connect:true enables the link');
    assert.ok(bg.fetchCalls.length, 'it actually tried to reach flrig');
    assert.ok(bg.fetchCalls.every(([url]) => url.includes('127.0.0.1:' + LIVE_PORT)));
});

t('a changed address is applied, and reached instead of the old one', async () => {
    const bg = await withTab({ flrigPort: LIVE_PORT });
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc() });
    await bg.settle();
    const before = bg.fetchCalls.length;

    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc({ config: { host: '10.0.0.9', port: 999 } }) });
    await bg.settle();

    assert.strictEqual(bg.store.flrigHost, '10.0.0.9');
    assert.strictEqual(bg.store.flrigPort, 999);
    const after = bg.fetchCalls.slice(before);
    assert.ok(after.length, 'the new address was tried');
    assert.ok(after.every(([url]) => url.includes('10.0.0.9:999')), 'and the old one was dropped');
});

t('the direction follows the panel, in the extension\'s own words', async () => {
    // The panel says sdr-to-radio / radio-to-sdr; this side has always said
    // sdr-to-rig / rig-to-sdr. One of them has to translate.
    const bg = await withTab({ flrigPort: LIVE_PORT });
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc({ direction: 'radio-to-sdr' }) });
    await bg.settle();
    assert.strictEqual(bg.store.flrigDirection, 'rig-to-sdr');

    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc({ direction: 'sdr-to-radio' }) });
    await bg.settle();
    assert.strictEqual(bg.store.flrigDirection, 'sdr-to-rig');
});

t('disconnecting from the panel switches the link off', async () => {
    const bg = await withTab({ flrigPort: LIVE_PORT });
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc() });
    await bg.settle();
    assert.strictEqual(bg.store.flrigEnabled, true);

    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc({ connect: false }) });
    await bg.settle();
    assert.strictEqual(bg.store.flrigEnabled, false);
});

t('choosing another transport releases flrig', async () => {
    // Serial, or somebody else's transport: ours has stopped being the one in
    // use and must not go on holding the rig.
    const bg = await withTab({ flrigPort: LIVE_PORT });
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc() });
    await bg.settle();
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc({ transport: 'serial' }) });
    await bg.settle();
    assert.strictEqual(bg.store.flrigEnabled, false);
});

t('mute-on-transmit follows the panel too', async () => {
    const bg = await withTab({ flrigPort: LIVE_PORT });
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc({ muteOnTx: false }) });
    await bg.settle();
    assert.strictEqual(bg.store.pttMuteEnabled, false);
});

t('a tab that is not the selected one does not drive the link', async () => {
    // There is one flrig and one selected tab. A second receiver's panel
    // describing a link it does not have must not move this one.
    const bg = await withTab({ flrigPort: LIVE_PORT });
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc() });
    await bg.settle();
    await bg.say(99, { type: 'ubersdr:radiocontrol', rc: rc({ config: { host: '8.8.8.8', port: 1 } }) });
    await bg.settle();
    assert.strictEqual(bg.store.flrigHost, '127.0.0.1', 'the other tab was ignored');
});

t('the selected tab is offered the transport, and told what the rig is doing', async () => {
    const bg = await withTab({ flrigPort: LIVE_PORT });
    assert.ok(bg.sentTo(7, 'cmd:radio_offer').some((m) => m.offer === true),
        'the tab being synced is offered FLRig');
    await bg.say(7, { type: 'ubersdr:radiocontrol', rc: rc() });
    await bg.settle();
    assert.ok(bg.sentTo(7, 'cmd:radio_status').length, 'and hears back about the link');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
    }
    console.log(`\n${pass} ok`);
    // The background arms timers and a keepalive alarm; nothing here unloads it.
    process.exit(process.exitCode || 0);
})();
