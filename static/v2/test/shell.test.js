// Which layout is drawn.
//
// The rule that matters is the one that is not a preference: a narrow screen
// gets the simple layout whatever is stored, because three docks and a spectrum
// do not fit in 390 px. A stored choice that could make the receiver unusable
// is the failure to guard against — and it is reachable, because the apps share
// one settings blob between a phone and a desktop.

const assert = require('assert');
const { resolveShell, shellChoosable } = require('./.build/displaycontext.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('a narrow screen is minimal whatever is stored', () => {
    for (const stored of ['full', 'minimal', 'auto', undefined, null, 'nonsense']) {
        assert.strictEqual(resolveShell(stored, true), 'minimal', String(stored));
    }
});

t('with room, unchosen means the docks', () => {
    assert.strictEqual(resolveShell('auto', false), 'full');
    assert.strictEqual(resolveShell(undefined, false), 'full');
    assert.strictEqual(resolveShell(null, false), 'full');
});

t('with room, the choice decides', () => {
    assert.strictEqual(resolveShell('minimal', false), 'minimal');
    assert.strictEqual(resolveShell('full', false), 'full');
});

t('anything unrecognised is the docks, not a blank screen', () => {
    // A settings file written by a newer version, or by hand.
    for (const bad of ['tabs', 42, {}, [], true]) {
        assert.strictEqual(resolveShell(bad, false), 'full', String(bad));
    }
});

t('the choice is offered on a touchscreen with room, and nowhere else', () => {
    // A tablet: both layouts fit and only one of them suits a fingertip.
    assert.strictEqual(shellChoosable({ touch: true, roomy: true }), true);
    // A phone has room for one layout, so there is nothing to choose.
    assert.strictEqual(shellChoosable({ touch: true, roomy: false }), false);
    // A desktop is what the docks are for; the setting still exists, it is
    // just not put in front of somebody who did not ask.
    assert.strictEqual(shellChoosable({ touch: false, roomy: true }), false);
});

t('a tablet keeps the choice when it is turned over', () => {
    // `roomy` asks about the device, not the moment: an 11-inch iPad is 820 px
    // wide in portrait and 1180 in landscape, and a control that came and went
    // with the orientation would be missing exactly when somebody in portrait
    // went looking for it.
    const portrait = { width: 820, height: 1180 };
    const landscape = { width: 1180, height: 820 };
    const roomy = (d) => d.width > 900 || d.height > 900;
    for (const d of [portrait, landscape]) {
        assert.strictEqual(shellChoosable({ touch: true, roomy: roomy(d) }), true);
    }
    // A handset stays out of it in both orientations.
    for (const d of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
        assert.strictEqual(shellChoosable({ touch: true, roomy: roomy(d) }), false);
    }
});

console.log(`\n${pass} ok`);
