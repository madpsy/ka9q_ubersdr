// Panels hidden by the client rather than by the receiver.
//
// The failure worth guarding against is silent: a malformed list that hides
// everything, or hides nothing when it should hide something, both look like a
// working interface until somebody goes to find a panel.

const assert = require('assert');
const { panelHiddenByHost } = require('./.build/hostpanels.cjs');

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

console.log(`\n${pass} ok`);
