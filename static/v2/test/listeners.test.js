// The listener list behind the Listeners panel and channels-map.html.
//
// The shape matters twice over: the panel reads our field names, and the map
// page reads the server's own off the same objects. Getting either wrong is
// silent — the panel goes blank, or the map drops every pin.

const assert = require('assert');
const { activeLabel, endpoint, normaliseChannels, tunable } = require('./.build/listeners.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const reply = {
    active_sessions: 3,
    channels: [
        { index: 0, frequency: 14074000, mode: 'usb', bandwidth_low: 50, bandwidth_high: 2800, last_active: '2026-08-04T12:00:00Z', country: 'Germany', country_code: 'DE', latitude: 52.5, longitude: 13.4, chat_username: 'DL1ABC' },
        { index: 1, frequency: 7100000, mode: 'lsb', bandwidth_low: -2800, bandwidth_high: -50, last_active: '2026-08-04T11:59:00Z' },
        { index: 2, frequency: 10000000, mode: 'IQ', bandwidth_low: -12000, bandwidth_high: 12000, last_active: '2026-08-04T11:00:00Z' },
    ],
};

t('the session id goes on the request, because it is what puts you first', () => {
    // The server's session key, not the browser's UUID: /stats matches it
    // against session.ID, and the UUID matches nothing — which would leave the
    // first row (somebody else) wearing your marker.
    assert.strictEqual(endpoint('abc-123'), '/stats?session_id=abc-123');
    // No audio session, so nothing to hoist and nobody to mark.
    assert.strictEqual(endpoint(''), '/stats');
    assert.strictEqual(endpoint(null), '/stats');
    assert.strictEqual(normaliseChannels(reply, false).some((c) => c.you), false);
});

t('the first entry is you, and only when we asked as somebody', () => {
    const list = normaliseChannels(reply, true);
    assert.strictEqual(list[0].you, true);
    assert.strictEqual(list[1].you, false);
});

t('a channel carries what the panel draws', () => {
    const [me] = normaliseChannels(reply, true);
    assert.strictEqual(me.frequency, 14074000);
    assert.strictEqual(me.mode, 'usb');
    assert.strictEqual(me.bandwidthLow, 50);
    assert.strictEqual(me.bandwidthHigh, 2800);
    assert.strictEqual(me.country, 'Germany');
    assert.strictEqual(me.countryCode, 'DE');
    assert.strictEqual(me.chatUsername, 'DL1ABC');
    assert.strictEqual(me.lat, 52.5);
    assert.strictEqual(typeof me.lastActive, 'number');
});

t('the server entry survives untouched, for the map', () => {
    // channels-map.html reads bandwidth_low, country_code and the rest off
    // window.activeChannels. Handing it our names would empty every popup.
    const [me] = normaliseChannels(reply, true);
    assert.strictEqual(me.raw, reply.channels[0]);
    assert.strictEqual(me.raw.bandwidth_low, 50);
    assert.strictEqual(me.raw.country_code, 'DE');
});

t('a missing or malformed reply is an empty list, not a crash', () => {
    assert.deepStrictEqual(normaliseChannels(null, true), []);
    assert.deepStrictEqual(normaliseChannels({}, true), []);
    assert.deepStrictEqual(normaliseChannels({ channels: 'nope' }, true), []);
    const [odd] = normaliseChannels({ channels: [{}] }, false);
    assert.strictEqual(odd.frequency, 0);
    assert.strictEqual(odd.mode, '');
    assert.strictEqual(odd.lastActive, null);
});

t('you cannot tune to yourself, or to an IQ channel', () => {
    const [me, other, iq] = normaliseChannels(reply, true);
    assert.strictEqual(tunable(me), false, 'your own row goes nowhere');
    assert.strictEqual(tunable(other), true);
    assert.strictEqual(tunable(iq), false, 'IQ has no audio to listen to');
    assert.strictEqual(tunable(null), false);
});

t('ages read as v1 words them, and never run backwards', () => {
    const now = Date.parse('2026-08-04T12:00:00Z');
    assert.strictEqual(activeLabel(now - 5000, now), '5s ago');
    assert.strictEqual(activeLabel(now - 59000, now), '59s ago');
    assert.strictEqual(activeLabel(now - 60000, now), '1m ago');
    assert.strictEqual(activeLabel(now - 3600000, now), '1h ago');
    // A browser clock behind the server's must not print "-3s ago".
    assert.strictEqual(activeLabel(now + 3000, now), '0s ago');
    assert.strictEqual(activeLabel(null, now), '');
});

console.log(`\n${pass} listener checks passed`);
