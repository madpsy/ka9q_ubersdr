// Panels hidden by the client rather than by the receiver.
//
// The failure worth guarding against is silent: a malformed list that hides
// everything, or hides nothing when it should hide something, both look like a
// working interface until somebody goes to find a panel.

const assert = require('assert');
const {
    panelHiddenByHost, surfaceOfferedByHost, dialLinksOfferedByHost, dialLinkForHost,
    bridgeSwitchHiddenByHost,
} = require('./.build/hostpanels.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

t('no host, no list, nothing hidden', () => {
    assert.strictEqual(panelHiddenByHost(null, 'games'), false);
    assert.strictEqual(panelHiddenByHost({}, 'games'), false);
    assert.strictEqual(panelHiddenByHost({ hidePanels: [] }, 'games'), false);
});

t('a listed panel is hidden, and only that one', () => {
    const host = { hidePanels: ['games', 'shortcuts'] };
    assert.strictEqual(panelHiddenByHost(host, 'games'), true);
    assert.strictEqual(panelHiddenByHost(host, 'shortcuts'), true);
    assert.strictEqual(panelHiddenByHost(host, 'chat'), false);
});

t('names match regardless of case', () => {
    assert.strictEqual(panelHiddenByHost({ hidePanels: ['Games'] }, 'games'), true);
    assert.strictEqual(panelHiddenByHost({ hidePanels: ['games'] }, 'GAMES'), true);
});

t('a list that is not a list hides nothing', () => {
    // A client mistake must cost the operator no panels: losing the interface
    // silently is worse than ignoring a flag that was written wrongly.
    for (const bad of ['games', true, 1, { games: true }]) {
        assert.strictEqual(panelHiddenByHost({ hidePanels: bad }, 'games'), false);
    }
});

t('rubbish inside the list is ignored, the rest still counts', () => {
    const host = { hidePanels: [null, 42, undefined, 'games'] };
    assert.strictEqual(panelHiddenByHost(host, 'games'), true);
    assert.strictEqual(panelHiddenByHost(host, 'chat'), false);
});

// --- controllers the host can drive ------------------------------------------

t('no list offers every surface', () => {
    for (const host of [null, {}, { controlSurfaces: 'dial' }, { controlSurfaces: true }]) {
        for (const id of ['flexcontrol', 'rc28', 'midi', 'gamepad', 'dial']) {
            assert.strictEqual(surfaceOfferedByHost(host, id), true, JSON.stringify(host) + ' ' + id);
        }
    }
});

t('a list offers what it names, and off always', () => {
    const host = { controlSurfaces: ['Dial', 7] };
    assert.strictEqual(surfaceOfferedByHost(host, 'dial'), true);
    assert.strictEqual(surfaceOfferedByHost(host, 'off'), true);
    for (const id of ['flexcontrol', 'rc28', 'midi', 'gamepad']) {
        assert.strictEqual(surfaceOfferedByHost(host, id), false, id);
    }
});

t('dial links: both unless the host narrows them', () => {
    assert.deepStrictEqual(dialLinksOfferedByHost(null), ['bluetooth', 'usb']);
    assert.deepStrictEqual(dialLinksOfferedByHost({ dialLinks: ['bluetooth'] }), ['bluetooth']);
    assert.deepStrictEqual(dialLinksOfferedByHost({ dialLinks: ['usb', 'bluetooth'] }), ['bluetooth', 'usb']);
    // A list naming nothing real is a mistake, read as no list.
    assert.deepStrictEqual(dialLinksOfferedByHost({ dialLinks: ['carrier pigeon'] }), ['bluetooth', 'usb']);
});

t('a saved USB link is overridden where the host has no USB', () => {
    const app = { dialLinks: ['bluetooth'] };
    assert.strictEqual(dialLinkForHost(app, 'usb'), 'bluetooth');
    assert.strictEqual(dialLinkForHost(app, undefined), 'bluetooth');
    assert.strictEqual(dialLinkForHost(null, 'usb'), 'usb');
    assert.strictEqual(dialLinkForHost(null, 'nonsense'), 'bluetooth');
});

t('the bridge switch hides only on an explicit false', () => {
    assert.strictEqual(bridgeSwitchHiddenByHost(null), false);
    assert.strictEqual(bridgeSwitchHiddenByHost({}), false);
    assert.strictEqual(bridgeSwitchHiddenByHost({ bridgeSwitch: 0 }), false);
    assert.strictEqual(bridgeSwitchHiddenByHost({ bridgeSwitch: false }), true);
});

console.log(`\n${pass} ok`);
