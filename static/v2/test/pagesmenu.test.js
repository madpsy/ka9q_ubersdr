// The pages menu, pruned against what a receiver actually has.
//
// Worth pinning because two menus render this one answer — the top bar's logo
// menu and the desktop client's native Links menu — and because every rule here
// is a decision about what NOT to show. A `depends_on` that wrongly passes puts
// a dead page in front of somebody; one that wrongly fails hides a feature the
// receiver has, and neither announces itself.

const assert = require('assert');
const { buildGroups, fileToLink, isEnabled } = require('./.build/pagesmenu.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const file = (name, path, extra = {}) => ({ name, path, ...extra });

// --- isEnabled ---------------------------------------------------------------

t('no condition means always', () => {
    assert.strictEqual(isEnabled('', {}), true);
    assert.strictEqual(isEnabled(null, null), true);
});

t('a condition with nothing to check against fails rather than passes', () => {
    // The description has not arrived yet. Showing everything until it does
    // would flash pages the receiver has not got.
    assert.strictEqual(isEnabled('ft8', null), false);
});

t('a feature is on when the description says so, in any of its shapes', () => {
    assert.strictEqual(isEnabled('ft8', { ft8: true }), true);
    assert.strictEqual(isEnabled('ft8', { ft8: { enabled: true } }), true);
    assert.strictEqual(isEnabled('ft8', { ft8: [1] }), true);
    assert.strictEqual(isEnabled('ft8', { ft8: 'yes' }), true);
});

t('and off for every way of saying no', () => {
    assert.strictEqual(isEnabled('ft8', {}), false);
    assert.strictEqual(isEnabled('ft8', { ft8: false }), false);
    assert.strictEqual(isEnabled('ft8', { ft8: 0 }), false);
    assert.strictEqual(isEnabled('ft8', { ft8: { enabled: false } }), false);
    // An empty list is a feature with nothing in it, which is nothing to show.
    assert.strictEqual(isEnabled('ft8', { ft8: [] }), false);
});

t('addons: is checked against the addon list, not a key', () => {
    assert.strictEqual(isEnabled('addons:navtex', { addons: ['navtex', 'wefax'] }), true);
    assert.strictEqual(isEnabled('addons:navtex', { addons: ['wefax'] }), false);
    assert.strictEqual(isEnabled('addons:navtex', { navtex: true }), false);
});

// --- fileToLink --------------------------------------------------------------

t('an instance page is rooted; an absolute URL is left alone', () => {
    assert.strictEqual(fileToLink(file('Map', 'channels-map.html')).url, '/channels-map.html');
    assert.strictEqual(fileToLink(file('Map', '/channels-map.html')).url, '/channels-map.html');
    assert.strictEqual(fileToLink(file('Docs', 'https://example.org/x')).url, 'https://example.org/x');
});

t('external and downloads open outside, instance pages in a popup', () => {
    assert.strictEqual(fileToLink(file('Map', 'channels-map.html')).external, false);
    assert.strictEqual(fileToLink(file('Docs', 'https://example.org/x')).external, true);
    // A popup window is a poor place to land a file save.
    assert.strictEqual(fileToLink(file('Log', 'log.csv', { download: true })).external, true);
});

// --- buildGroups -------------------------------------------------------------

const menu = {
    groups: [
        {
            group: 'Tools',
            files: [file('Map', 'channels-map.html'), file('FT8', 'ft8.html', { depends_on: 'ft8' })],
            subgroups: [
                { name: 'Deep', files: [file('Skimmer', 'cw.html', { depends_on: 'cw_skimmer' })] },
            ],
        },
        { group: 'Gone', depends_on: 'nothing_here', files: [file('X', 'x.html')] },
        { group: 'Empty', files: [file('Y', 'y.html', { depends_on: 'absent' })], subgroups: [] },
    ],
};

t('a group whose condition fails is dropped whole', () => {
    const groups = buildGroups(menu, { ft8: true, cw_skimmer: true });
    assert.deepStrictEqual(groups.map((g) => g.name), ['Tools']);
});

t('a group left with nothing in it is dropped too', () => {
    // "Empty" has one file and it is conditional: with the condition unmet the
    // group is a heading over nothing, which is worse than its absence.
    const groups = buildGroups(menu, { ft8: true, cw_skimmer: true });
    assert.ok(!groups.some((g) => g.name === 'Empty'));
});

t('files and subgroups are pruned by their own conditions', () => {
    const groups = buildGroups(menu, {});
    assert.deepStrictEqual(groups.map((g) => g.name), ['Tools']);
    assert.deepStrictEqual(groups[0].links.map((l) => l.label), ['Map']);
    assert.deepStrictEqual(groups[0].subgroups, [], 'the subgroup emptied and went');

    const full = buildGroups(menu, { ft8: true, cw_skimmer: true });
    assert.deepStrictEqual(full[0].links.map((l) => l.label), ['Map', 'FT8']);
    assert.deepStrictEqual(full[0].subgroups.map((s) => s.name), ['Deep']);
});

t('add-ons are appended as their own group, last', () => {
    const groups = buildGroups(menu, { addons: ['navtex', 'wefax'] });
    const last = groups[groups.length - 1];
    assert.strictEqual(last.name, '🔌 Add-ons');
    assert.deepStrictEqual(last.links.map((l) => l.label), ['NAVTEX', 'WEFAX']);
    assert.deepStrictEqual(last.links.map((l) => l.url), ['/addon/navtex/', '/addon/wefax/']);
});

t('no add-ons means no add-ons group', () => {
    assert.ok(!buildGroups(menu, { addons: [] }).some((g) => g.name === '🔌 Add-ons'));
    assert.ok(!buildGroups(menu, {}).some((g) => g.name === '🔌 Add-ons'));
});

t('nothing to show is an empty list rather than a throw', () => {
    assert.deepStrictEqual(buildGroups({}, {}), []);
    assert.deepStrictEqual(buildGroups({ groups: [] }, null), []);
    // A receiver too old to answer /api/pages-menu at all.
    assert.deepStrictEqual(buildGroups(null, null), []);
});

console.log(`\n${pass} passed`);
