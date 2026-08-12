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

// --- which style a receiver starts on ------------------------------------------------
//
// 'toast' in a browser, for the permission prompt's sake: it is one shot, and a page that
// spends it before being asked has spent it for the session. A host that answers the
// Notification API itself has already established that permission on its own terms, and is
// the case 'auto' was written for — a phone in a pocket rather than a tab on a screen.

t('a browser starts on toasts', () => {
    delete globalThis.window;
    assert.strictEqual(n.defaultStyle(), 'toast');
    globalThis.window = {};
    assert.strictEqual(n.defaultStyle(), 'toast');
    globalThis.window = { ubersdrDesktop: { upstreamOrigin: 'https://rx.example' } };
    assert.strictEqual(n.defaultStyle(), 'toast', 'a host that says nothing about notifications');
    delete globalThis.window;
});

t('a host that owns the notifications starts on auto', () => {
    for (const state of ['granted', 'default', 'denied']) {
        globalThis.window = { ubersdrDesktop: { notifications: state } };
        assert.strictEqual(n.defaultStyle(), 'auto', state);
    }
    delete globalThis.window;
});

// --- toast or desktop ----------------------------------------------------------------
//
// A toast only exists while somebody is looking at the page, which is when it is least
// needed: the notifications worth having arrive while the tab is behind something else. So
// deliveryFor decides, once per notification, and every branch that cannot deliver a desktop
// notification has to end at a toast rather than at silence.

const deliver = (over = {}) => n.deliveryFor({
    style: 'auto', permission: 'granted', supported: true, visible: false, ...over,
});

t('the in-page choice is always a toast', () => {
    assert.strictEqual(deliver({ style: 'toast' }), 'toast');
    assert.strictEqual(deliver({ style: 'toast', visible: true }), 'toast');
});

t('the desktop choice is the desktop, seen or not', () => {
    assert.strictEqual(deliver({ style: 'native' }), 'native');
    assert.strictEqual(deliver({ style: 'native', visible: true }), 'native');
});

t('auto is the desktop while the tab is hidden and a toast while it is not', () => {
    // The whole reason for having it: a toast behind a hidden tab is a notification nobody
    // received, and a system popup over a tab you are already reading is worse than the toast
    // it duplicates.
    assert.strictEqual(deliver({ style: 'auto', visible: false }), 'native');
    assert.strictEqual(deliver({ style: 'auto', visible: true }), 'toast');
});

t('without permission every choice falls back to a toast', () => {
    // Never asked, or refused — and browsers do not ask twice. A setting that reads as
    // configured and delivers nothing is the one outcome to make impossible.
    for (const permission of ['default', 'denied', 'unsupported']) {
        assert.strictEqual(deliver({ style: 'native', permission }), 'toast', permission);
        assert.strictEqual(deliver({ style: 'auto', permission }), 'toast', permission);
    }
});

t('without the API at all it is a toast, which is every plain-HTTP receiver', () => {
    assert.strictEqual(deliver({ supported: false }), 'toast');
    assert.strictEqual(deliver({ style: 'native', supported: false }), 'toast');
});

t('nonsense, and nothing at all, is a toast', () => {
    assert.strictEqual(n.deliveryFor(), 'toast');
    assert.strictEqual(deliver({ style: 'carrier pigeon' }), 'toast');
});

t('the style is remembered, and an unknown one is not', () => {
    assert.strictEqual(n.notificationSettings().style, 'toast', 'toasts until asked otherwise');
    n.setNotificationSettings({ style: 'auto' });
    assert.strictEqual(n.notificationSettings().style, 'auto');
    n.setNotificationSettings({ style: 'semaphore' });
    assert.strictEqual(n.notificationSettings().style, 'auto', 'kept, rather than replaced');
});

t('a notification carries where it is going, and the history keeps it either way', () => {
    // In node there is no Notification API, so this is the plain-HTTP case: toast, and the
    // desktop flag off.
    const id = n.pushNotification({ source: 'rotator', title: 'Rotator stopped' });
    assert.ok(id > 0);
    const s = n.notificationState();
    assert.strictEqual(s.history[0].native, false);
    assert.strictEqual(s.toasts.length, 1, 'and it went to the page, since nothing else can');
});

// --- per-source switches -------------------------------------------------------------

t('every source is on until somebody says otherwise', () => {
    // Stored as a list of the muted ones, so a source added later arrives switched on
    // without a migration — otherwise every new notification would be invisible to
    // everybody who had ever touched this panel.
    for (const src of n.NOTICE_SOURCES) {
        assert.strictEqual(n.sourceEnabled(src.id), true, src.id);
    }
    assert.deepStrictEqual(n.notificationSettings().muted, []);
});

t('a muted source raises nothing at all, history included', () => {
    // Stronger than the master switch on purpose: that one is about being interrupted
    // now and keeps the record, while this says "I do not want to know" — and a log of
    // things nobody wants to know is not worth keeping.
    n.setSourceEnabled('rotator', false);
    assert.strictEqual(n.pushNotification({ source: 'rotator', title: 'Rotator stopped' }), 0);
    const s = n.notificationState();
    assert.strictEqual(s.toasts.length, 0);
    assert.strictEqual(s.history.length, 0);
});

t('muting one leaves the others alone', () => {
    n.setSourceEnabled('rotator', false);
    assert.ok(n.pushNotification({ source: 'antenna', title: 'Antenna grounded' }) > 0);
    assert.strictEqual(n.sourceEnabled('antenna'), true);
});

t('unmuting brings it back', () => {
    n.setSourceEnabled('rotator', false);
    n.setSourceEnabled('rotator', true);
    assert.ok(n.pushNotification({ source: 'rotator', title: 'Rotator stopped' }) > 0);
    assert.deepStrictEqual(n.notificationSettings().muted, []);
});

t('muting the same source twice does not list it twice', () => {
    n.setSourceEnabled('rotator', false);
    n.setSourceEnabled('rotator', false);
    assert.deepStrictEqual(n.notificationSettings().muted, ['rotator']);
});

t('an unregistered source is never silenced', () => {
    // The failure of somebody forgetting to register a source should be a notification
    // that gets through, not one that vanishes.
    assert.strictEqual(n.sourceEnabled('something-new'), true);
    assert.ok(n.pushNotification({ source: 'something-new', title: 'Hello' }) > 0);
});

t('a source with no id at all is not mutable, and does not corrupt the list', () => {
    n.setSourceEnabled('', false);
    assert.deepStrictEqual(n.notificationSettings().muted, []);
});

t('a source is named by its registry entry, not by its id', () => {
    assert.strictEqual(n.sourceLabel('antenna'), 'Antenna switch');
    // And an unregistered one is shown as whatever it called itself, rather than blank.
    assert.strictEqual(n.sourceLabel('something-new'), 'something-new');
    assert.strictEqual(n.sourceLabel(undefined), '');
});

t('every registered source has a label, a note and a panel', () => {
    // The label and the note are what the switch reads; the panel is where its icon comes
    // from, and a notification that cannot be recognised without being read is a
    // notification a toast has no time for.
    for (const src of n.NOTICE_SOURCES) {
        assert.ok(src.id && src.label && src.note && src.panel, JSON.stringify(src));
    }
});

t('chat has two sources, because its two halves are wanted differently', () => {
    // Being spoken to is always worth an interruption; somebody arriving is worth one on a
    // quiet receiver and not on a busy one. One switch would have meant choosing between
    // missing your name and a toast every few minutes.
    const chat = n.NOTICE_SOURCES.filter((src) => src.panel === 'chat').map((src) => src.id);
    assert.deepStrictEqual(chat, ['chat-mention', 'chat-join']);
    // Independently mutable, which is the whole reason for the split.
    n.setSourceEnabled('chat-join', false);
    assert.strictEqual(n.sourceEnabled('chat-join'), false);
    assert.strictEqual(n.sourceEnabled('chat-mention'), true);
    assert.strictEqual(n.pushNotification({ source: 'chat-join', title: 'G0ABC joined chat' }), 0);
    assert.ok(n.pushNotification({ source: 'chat-mention', title: 'G0ABC mentioned you' }) > 0);
});

t('two different mentions are two notifications, not one with a count', () => {
    // Unkeyed on purpose: a key collapses repeats, and two people asking you two different
    // things are two things to answer.
    n.pushNotification({ source: 'chat-mention', title: 'G0ABC mentioned you', body: 'you around?' });
    n.pushNotification({ source: 'chat-mention', title: 'M0XYZ mentioned you', body: 'what is that on 40?' });
    const s = n.notificationState();
    assert.strictEqual(s.history.length, 2);
    assert.strictEqual(s.history[0].count, 1);
});

t('a source names the panel its icon comes from', () => {
    // An id rather than the icon itself: the store is a plain module, and importing the
    // panel registry into it would point a lib at the panels that use it. See NoticeIcon.
    assert.strictEqual(n.sourcePanel('rotator'), 'rotator');
    assert.strictEqual(n.sourcePanel('antenna'), 'antenna');
    // The two halves of chat are separate switches over one panel.
    assert.strictEqual(n.sourcePanel('chat-mention'), 'chat');
    assert.strictEqual(n.sourcePanel('chat-join'), 'chat');
    assert.strictEqual(n.sourcePanel(undefined), '');
});

t('a source with no switch of its own may still name a panel', () => {
    // Not everything that raises a notification needs a per-source switch — the
    // Notifications panel's own test button raises one, and it should wear that
    // panel's icon like any other. Such a source names the panel directly.
    //
    // Lowercased, because the source doubles as the label printed on the toast
    // and so is written the way it should read.
    assert.strictEqual(n.sourcePanel('Notifications'), 'notifications');
    assert.strictEqual(n.sourceLabel('Notifications'), 'Notifications', 'and the label is untouched');
    // A name that is neither a switch nor a panel resolves to a panel that does
    // not exist, and NoticeIcon draws nothing rather than the wrong glyph.
    assert.strictEqual(n.sourcePanel('something-new'), 'something-new');
});

if (process.exitCode) console.log('\nnotification tests FAILED');
else console.log(`\nall ${pass} notification tests passed`);
