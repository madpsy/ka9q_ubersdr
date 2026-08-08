// The notification store.
//
// The interface any panel uses is one function, so the tests are mostly about the
// promises that function makes: that raising one is safe from anywhere, that the history
// survives the toasts being switched off, and that a key coalesces instead of stacking —
// which is the difference between a reconnecting stream saying so once and saying so
// forty times.

const assert = require('assert');
const n = require('./.build/notifications.cjs');

let pass = 0;
const t = (name, fn) => {
    n._resetNotifications();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

// --- raising one ---------------------------------------------------------------

t('a notification appears as a toast and in the history', () => {
    const id = n.pushNotification({ title: 'Recorder', body: 'Finished', source: 'Recorder' }, NOW);
    assert.ok(id > 0);
    const s = n.notificationState();
    assert.strictEqual(s.toasts.length, 1);
    assert.strictEqual(s.history.length, 1);
    assert.strictEqual(s.toasts[0].title, 'Recorder');
    assert.strictEqual(s.toasts[0].at, NOW);
});

t('a body on its own is enough, and a title on its own is too', () => {
    assert.ok(n.pushNotification({ title: 'Just a heading' }) > 0);
    assert.ok(n.pushNotification({ body: 'Just a sentence' }) > 0);
    assert.strictEqual(n.notificationState().history.length, 2);
});

t('nothing to say raises nothing', () => {
    // A toast with no words is a coloured box.
    assert.strictEqual(n.pushNotification({}), 0);
    assert.strictEqual(n.pushNotification({ title: '   ', body: '' }), 0);
    assert.strictEqual(n.pushNotification(), 0);
    assert.strictEqual(n.notificationState().history.length, 0);
});

t('an unrecognised severity is information rather than a broken colour', () => {
    n.pushNotification({ title: 'x', severity: 'catastrophe' });
    assert.strictEqual(n.notificationState().history[0].severity, 'info');
    assert.strictEqual(n.severityOf('bad'), 'bad');
    assert.strictEqual(n.severityOf(undefined), 'info');
});

t('the newest is first in both lists, because that is how they are read', () => {
    n.pushNotification({ title: 'first' }, NOW);
    n.pushNotification({ title: 'second' }, NOW + 1000);
    assert.deepStrictEqual(n.notificationState().history.map((x) => x.title), ['second', 'first']);
    assert.deepStrictEqual(n.notificationState().toasts.map((x) => x.title), ['second', 'first']);
});

// --- not shouting -------------------------------------------------------------------

t('a key coalesces instead of stacking, and counts', () => {
    // The case this exists for: a stream that drops every few seconds saying so once,
    // with a number, rather than filling the screen with one sentence.
    for (let i = 0; i < 4; i++) {
        n.pushNotification({ key: 'stream', title: 'Band spectrum', body: 'Reconnecting' });
    }
    const s = n.notificationState();
    assert.strictEqual(s.toasts.length, 1);
    assert.strictEqual(s.history.length, 1);
    assert.strictEqual(s.toasts[0].count, 4);
});

t('the count survives the toast having gone', () => {
    // Dismissed, or timed out, and then it happens again: it is still the fifth time.
    n.pushNotification({ key: 'stream', title: 'Band spectrum' });
    n.dismissAll();
    n.pushNotification({ key: 'stream', title: 'Band spectrum' });
    assert.strictEqual(n.notificationState().toasts[0].count, 2);
});

t('different keys are different notifications', () => {
    n.pushNotification({ key: 'a', title: 'A' });
    n.pushNotification({ key: 'b', title: 'B' });
    assert.strictEqual(n.notificationState().toasts.length, 2);
});

t('no key means no coalescing: two identical events are two events', () => {
    n.pushNotification({ title: 'Strike' });
    n.pushNotification({ title: 'Strike' });
    assert.strictEqual(n.notificationState().history.length, 2);
});

t('only a few toasts at once, and it is the oldest that goes', () => {
    // Beyond three they are a wall rather than a message, and the oldest is the one
    // nobody is reading.
    for (let i = 0; i < 6; i++) n.pushNotification({ title: `n${i}` });
    const s = n.notificationState();
    assert.strictEqual(s.toasts.length, n.TOAST_MAX);
    assert.deepStrictEqual(s.toasts.map((x) => x.title), ['n5', 'n4', 'n3']);
    assert.strictEqual(s.history.length, 6, 'the history keeps them all');
});

t('the history has a ceiling too', () => {
    for (let i = 0; i < n.HISTORY_MAX + 10; i++) n.pushNotification({ title: `n${i}` });
    assert.strictEqual(n.notificationState().history.length, n.HISTORY_MAX);
});

// --- switched off -------------------------------------------------------------------

t('with toasts off, the history still records everything', () => {
    // The switch is about the interface interrupting you. A receiver that also stopped
    // recording what happened would be answering a different question — and the panel is
    // where you go to find out what you missed.
    n.setNotificationSettings({ enabled: false });
    n.pushNotification({ title: 'Quiet one' });
    const s = n.notificationState();
    assert.strictEqual(s.toasts.length, 0);
    assert.strictEqual(s.history.length, 1);
});

t('switching them off clears what is already on screen', () => {
    // Three toasts left up after the switch went off would read as a switch that does
    // not work.
    n.pushNotification({ title: 'Up' });
    n.setNotificationSettings({ enabled: false });
    assert.strictEqual(n.notificationState().toasts.length, 0);
});

// --- the settings -------------------------------------------------------------------

t('the defaults are on, top right, five seconds', () => {
    const s = n.notificationSettings();
    assert.strictEqual(s.enabled, true, 'a system that must be switched on is one nobody has');
    assert.strictEqual(s.place, 'top-right');
    assert.strictEqual(s.seconds, 5);
});

t('a place or a time that is not on offer is refused, not stored', () => {
    n.setNotificationSettings({ place: 'middle-of-the-spectrum', seconds: 900 });
    const s = n.notificationSettings();
    assert.strictEqual(s.place, 'top-right');
    assert.strictEqual(s.seconds, 5);
});

t('a patch changes one setting and leaves the others', () => {
    n.setNotificationSettings({ place: 'bottom-centre' });
    n.setNotificationSettings({ seconds: 15 });
    const s = n.notificationSettings();
    assert.strictEqual(s.place, 'bottom-centre');
    assert.strictEqual(s.seconds, 15);
    assert.strictEqual(s.enabled, true);
});

t('every place is one of the six, and each has a label', () => {
    assert.strictEqual(n.NOTICE_PLACES.length, 6);
    for (const p of n.NOTICE_PLACES) {
        assert.ok(/^(top|bottom)-(left|centre|right)$/.test(p.id), p.id);
        assert.ok(p.label.length > 0);
    }
});

// --- how long -----------------------------------------------------------------------

t('a toast lasts as long as the setting says', () => {
    n.setNotificationSettings({ seconds: 8 });
    n.pushNotification({ title: 'x' });
    assert.strictEqual(n.toastMs(n.notificationState().toasts[0]), 8000);
});

t('zero seconds means it waits to be dismissed', () => {
    // Offered because a notification somebody has to act on should not disappear while
    // they are reading it.
    n.setNotificationSettings({ seconds: 0 });
    n.pushNotification({ title: 'x' });
    assert.strictEqual(n.toastMs(n.notificationState().toasts[0]), 0);
    assert.ok(n.NOTICE_TIMES.includes(0));
});

t('a caller can override the setting for one that has to be acted on', () => {
    n.setNotificationSettings({ seconds: 3 });
    n.pushNotification({ title: 'Disk full', timeout: 0 });
    assert.strictEqual(n.toastMs(n.notificationState().toasts[0]), 0, 'sticky despite a 3s setting');
    n.pushNotification({ title: 'Brief', timeout: 2 });
    assert.strictEqual(n.toastMs(n.notificationState().toasts[0]), 2000);
});

// --- dismissing ---------------------------------------------------------------------

t('dismissing one leaves the others and the history', () => {
    const a = n.pushNotification({ title: 'A' });
    n.pushNotification({ title: 'B' });
    n.dismissNotification(a);
    const s = n.notificationState();
    assert.deepStrictEqual(s.toasts.map((x) => x.title), ['B']);
    assert.strictEqual(s.history.length, 2);
});

t('dismissing an id that is not there changes nothing', () => {
    n.pushNotification({ title: 'A' });
    let calls = 0;
    const off = n.onNotifications(() => { calls += 1; });
    n.dismissNotification(9999);
    off();
    assert.strictEqual(calls, 0, 'and does not even notify');
});

t('clearing takes the history as well, which the panel button says it does', () => {
    n.pushNotification({ title: 'A' });
    n.clearNotifications();
    const s = n.notificationState();
    assert.strictEqual(s.toasts.length, 0);
    assert.strictEqual(s.history.length, 0);
});

// --- subscribers --------------------------------------------------------------------

t('subscribers hear about a notification, and can stop hearing', () => {
    const seen = [];
    const off = n.onNotifications((s) => seen.push(s.history.length));
    n.pushNotification({ title: 'A' });
    off();
    n.pushNotification({ title: 'B' });
    assert.deepStrictEqual(seen, [1]);
});

t('a subscriber that throws does not stop the others or the notification', () => {
    let heard = 0;
    const offBad = n.onNotifications(() => { throw new Error('bad subscriber'); });
    const offGood = n.onNotifications(() => { heard += 1; });
    assert.ok(n.pushNotification({ title: 'A' }) > 0);
    offBad();
    offGood();
    assert.strictEqual(heard, 1);
});

if (process.exitCode) console.log('\nnotification tests FAILED');
else console.log(`\nall ${pass} notification tests passed`);
