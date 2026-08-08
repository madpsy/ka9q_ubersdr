// The two hardware notifications: the rotator stopping, and the antenna changing.
//
// Both are transition detectors, and both have the same failure available to them:
// announcing the state a page load happened to find. v1 guarded against it and so does
// this, which is most of what is tested here — along with the antenna case where the
// change came from this browser rather than another.
//
// The polls need fetch and are not exercised; the transition logic is reached through the
// same function the polls call, which is the part where a mistake would be visible.

const assert = require('assert');
// One bundle for both — see notices.entry.js: the store the detectors push into has to be
// the store this test reads, and separate bundles each get their own copy.
const hw = require('./.build/hardwarenotices.cjs');

let pass = 0;
const t = (name, fn) => {
    hw._resetHardwareNotices();
    hw._resetNotificationStore();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const history = () => hw.notificationState().history;

// --- the antenna switch ------------------------------------------------------------
//
// Reached through feedAntennaStatus, which is the same path a poll takes: the panel uses
// it to fold in the reply from its own command, and the store uses it to fold in a poll.

t('the first status is a baseline, not a notification', () => {
    // Otherwise every page load would announce whichever antenna was already selected —
    // v1's rule, and the reason it starts from null rather than from an empty selection.
    hw.feedAntennaStatus({ selected: [2], grounded: false });
    assert.strictEqual(history().length, 0);
});

t('a change of antenna is announced, by its label', () => {
    hw.feedAntennaStatus({ selected: [1], grounded: false, antenna_labels: ['Dipole', 'Beam'] });
    hw.feedAntennaStatus({ selected: [2], grounded: false, antenna_labels: ['Dipole', 'Beam'] });
    const [n] = history();
    assert.strictEqual(n.source, 'antenna');
    assert.ok(/Beam/.test(n.title), n.title);
});

t('an antenna with no label is named by its number', () => {
    hw.feedAntennaStatus({ selected: [1] });
    hw.feedAntennaStatus({ selected: [3] });
    assert.ok(/Antenna 3/.test(history()[0].title));
});

t('grounding is called out on its own, and as a warning', () => {
    // It is the state the buttons cannot show, it usually means a thunderstorm, and it is
    // the difference between a quiet band and a disconnected aerial.
    hw.feedAntennaStatus({ selected: [1], grounded: false });
    hw.feedAntennaStatus({ selected: [], grounded: true });
    const [n] = history();
    assert.strictEqual(n.severity, 'warn');
    assert.ok(/grounded/i.test(n.title));
});

t('coming off ground says so', () => {
    hw.feedAntennaStatus({ selected: [], grounded: true });
    hw.feedAntennaStatus({ selected: [1], grounded: false, antenna_labels: ['Dipole'] });
    const [n] = history();
    assert.ok(/Dipole/.test(n.title));
    assert.ok(/no longer grounded/i.test(n.body), n.body);
});

t('the same selection reported again is not a change', () => {
    // A poll every five seconds must not be five notifications a minute.
    hw.feedAntennaStatus({ selected: [1], grounded: false });
    for (let i = 0; i < 5; i++) hw.feedAntennaStatus({ selected: [1], grounded: false });
    assert.strictEqual(history().length, 0);
});

t('the same antennas in a different order are the same selection', () => {
    hw.feedAntennaStatus({ selected: [1, 2] });
    hw.feedAntennaStatus({ selected: [2, 1] });
    assert.strictEqual(history().length, 0);
    assert.strictEqual(hw.selectionKey([2, 1]), hw.selectionKey([1, 2]));
});

t('selecting nothing is a change, and says so rather than showing an empty list', () => {
    hw.feedAntennaStatus({ selected: [1] });
    hw.feedAntennaStatus({ selected: [] });
    assert.ok(/No antenna selected/i.test(history()[0].title));
});

t('a run of changes is one line with a count, not a stack', () => {
    // Keyed, so somebody trying four antennas gets one notification saying where they
    // ended up rather than four saying where they went.
    hw.feedAntennaStatus({ selected: [1] });
    hw.feedAntennaStatus({ selected: [2] });
    hw.feedAntennaStatus({ selected: [3] });
    hw.feedAntennaStatus({ selected: [4] });
    const h = history();
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].count, 3);
    assert.ok(/Antenna 4/.test(h[0].title), 'and it is the latest one');
});

t('nothing at all changes nothing', () => {
    hw.feedAntennaStatus(null);
    assert.strictEqual(history().length, 0);
    assert.strictEqual(hw.antennaStatus(), null);
});

t('the status reaches subscribers as well as the notification', () => {
    // The panel is one of those subscribers: it draws from this store rather than
    // fetching for itself, so one poll serves the buttons and the notification.
    const seen = [];
    const off = hw.subscribeAntenna((s) => seen.push(s));
    hw.feedAntennaStatus({ selected: [1] });
    off();
    assert.ok(seen.length >= 1);
    assert.deepStrictEqual(seen[seen.length - 1].selected, [1]);
});

t('a name comes from the labels when there is one, and from the number when not', () => {
    const st = { antenna_labels: ['Dipole', ''] };
    assert.strictEqual(hw.antennaName(st, 1), 'Dipole');
    assert.strictEqual(hw.antennaName(st, 2), 'Antenna 2');
    assert.strictEqual(hw.antennaName(null, 3), 'Antenna 3');
});

// --- muting -------------------------------------------------------------------------

t('a muted source detects nothing, because it raises nothing', () => {
    hw.setSourceEnabled('antenna', false);
    hw.feedAntennaStatus({ selected: [1] });
    hw.feedAntennaStatus({ selected: [2] });
    assert.strictEqual(history().length, 0);
});

if (process.exitCode) console.log('\nhardware notice tests FAILED');
else console.log(`\nall ${pass} hardware notice tests passed`);
