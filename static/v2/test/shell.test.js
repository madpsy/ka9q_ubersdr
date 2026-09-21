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

t('a television that has not been asked gets the simple layout', () => {
    // It has the room for the docks and no way to work them: three of them and
    // a spectrum, at arm's length, from four arrow keys.
    for (const unchosen of [undefined, null, 'auto', 'nonsense', '']) {
        assert.strictEqual(resolveShell(unchosen, false, true), 'minimal', String(unchosen));
    }
});

t('...but a television that has been asked is obeyed', () => {
    // A default, not a rule — which is the whole difference between this and
    // `narrow`. Somebody who wants the docks on a television can have them.
    assert.strictEqual(resolveShell('full', false, true), 'full');
    assert.strictEqual(resolveShell('minimal', false, true), 'minimal');
});

t('and the television default does not leak into anything else', () => {
    // The flag is the third argument and every older caller passes two, so an
    // absent one has to mean "not a television" rather than undefined-ish
    // anything.
    assert.strictEqual(resolveShell(null, false), 'full');
    assert.strictEqual(resolveShell(null, false, false), 'full');
    assert.strictEqual(resolveShell(undefined, false, undefined), 'full');
});

t('anything unrecognised is the docks, not a blank screen', () => {
    // A settings file written by a newer version, or by hand.
    for (const bad of ['tabs', 42, {}, [], true]) {
        assert.strictEqual(resolveShell(bad, false), 'full', String(bad));
    }
});

t('the choice is offered where the docks are awkward, and nowhere else', () => {
    // A tablet: both layouts fit and only one of them suits a fingertip.
    assert.strictEqual(shellChoosable({ touch: true, roomy: true, hover: false }), true);
    // A phone has room for one layout, so there is nothing to choose.
    assert.strictEqual(shellChoosable({ touch: true, roomy: false, hover: false }), false);
    // A desktop is what the docks are for; the setting still exists, it is
    // just not put in front of somebody who did not ask.
    assert.strictEqual(shellChoosable({ touch: false, roomy: true, hover: true }), false);
    // A convertible laptop keeps it: the primary pointer is the trackpad, but
    // the screen can still be poked, which is the half that makes a dock
    // awkward. `touch` is any-pointer for exactly this machine.
    assert.strictEqual(shellChoosable({ touch: true, roomy: true, hover: true }), true);
});

t('and a television is offered it too', () => {
    // The machine neither half of the old rule described: nothing to poke it
    // with, nothing to rest on it, and plenty of room. It was taking the
    // desktop's answer by default and had no way to say otherwise.
    assert.strictEqual(shellChoosable({ touch: false, roomy: true, hover: false }), true);
    // Not keyed on the television *test* — only on there being no hovering
    // pointer — so a set-top box that isTelevision() fails to recognise still
    // gets the control. That is the point: the control is what makes a wrong
    // default survivable, so it cannot rest on the signal the default rests on.
});

t('a television with no room is still just a phone-shaped screen', () => {
    // A stick driving a 720p panel reports 1280x720, which is roomy. One
    // driving something smaller, or a browser window on a TV that is not
    // maximised, is not — and there the simple layout is not a preference at
    // all, it is the only one that fits.
    assert.strictEqual(shellChoosable({ touch: false, roomy: false, hover: false }), false);
    assert.strictEqual(resolveShell(null, true, true), 'minimal');
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
