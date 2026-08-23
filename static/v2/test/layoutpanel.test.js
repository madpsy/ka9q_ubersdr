// The Layout panel renders, and its grouping loses nothing.
//
// The panel is the only place an operator can bring a hidden panel back, so a
// panel missing from the list here is a panel that cannot be turned on again.
// Grouping the list is what makes that possible to get wrong: a group holds an
// id, the registry holds a panel, and nothing but this checks that the two
// still agree. See hookStub.js for what "renders" means here.

const assert = require('assert');

// Before the bundle: the module graph behind a panel reaches the display
// settings and the radio, and both read the browser at import time.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const {
    deep, render, reset, walk, words,
    LayoutPanel, PANEL_BY_ID, PANELS, DEFAULTS, GROUPS, SOLO, allGroupsFor,
} = require('./.build/layoutpanel.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
};

// One object answers useLayout, useDisplay, useRadio and useExtensions alike —
// the stub's useContext has no way to tell contexts apart, and none of the four
// wants anything the others would mind seeing.
function context(over) {
    return {
        sections: {},
        floats: {},
        placementOf: () => 'left',
        movePanel() {},
        setSectionHidden() {},
        resetLayout() {},
        ...DEFAULTS,
        set() {},
        // useRadio's half, and useExtensions'. A panel gate reads the
        // description this receiver published and the extension list, and both
        // arrive through the same stub object — see usePanelApplies.
        serverInfo: {},
        list: [],
        ...over,
    };
}

// The panels the manager actually lists: everything but itself, and only what
// this stub receiver claims to offer. The same gate the panel applies, against
// the same stub, so the two cannot drift.
const listed = () => {
    const ctx = context();
    return PANELS.filter(
        (p) => p.id !== 'layout' && (!p.requires || p.requires(ctx.serverInfo, { extensions: ctx })),
    );
};

// --- the grouping ------------------------------------------------------------

t('every panel is in exactly one group', () => {
    const groups = allGroupsFor(listed());
    const seen = groups.flatMap((g) => g.items.map((p) => p.id));
    assert.strictEqual(seen.length, new Set(seen).size, 'a panel listed twice');
    assert.deepStrictEqual(
        listed().map((p) => p.id).filter((id) => !seen.includes(id)),
        [],
        'a panel the manager would list is in no group at all',
    );
});

t('the solo panel is not silently dropped', () => {
    // It is in no group by design — see SOLO — which is exactly the case the
    // Ungrouped bucket exists for. Off the end of Setup, where the phone puts
    // spare panels, it would read as a Setup panel.
    const groups = allGroupsFor(listed());
    const spare = groups.find((g) => g.id === 'ungrouped');
    assert.ok(spare, 'there is an Ungrouped group');
    assert.ok(spare.items.some((p) => p.id === SOLO));
    assert.strictEqual(groups[groups.length - 1].id, 'ungrouped', 'and it comes last');
});

t('an empty group is not shown', () => {
    const tune = GROUPS.find((g) => g.id === 'tune');
    const only = listed().filter((p) => tune.panels.includes(p.id));
    const groups = allGroupsFor(only);
    assert.deepStrictEqual(groups.map((g) => g.id), ['tune']);
});

t('a panel claiming a group this build does not have lands in Ungrouped', () => {
    const odd = { id: 'oddity', title: 'Oddity', group: 'nosuchgroup' };
    const groups = allGroupsFor([...listed(), odd]);
    const spare = groups.find((g) => g.id === 'ungrouped');
    assert.ok(spare.items.some((p) => p.id === 'oddity'));
});

// --- the panel ---------------------------------------------------------------

t('it renders, grouped and collapsed', () => {
    reset();
    const { tree } = render(LayoutPanel, {}, context());
    const text = words(tree);
    assert.ok(text.includes('Collapse all'), 'the collapse control is there');
    assert.ok(text.includes('Expand all'));
    // Only the groups this stub receiver has any panels for: a group with
    // nothing in it is not drawn, which is most of them against a bare
    // /api/description.
    for (const g of allGroupsFor(listed())) {
        assert.ok(text.includes(g.title), `the ${g.title} group is there`);
    }
    // Collapsed means collapsed: no panel rows drawn until a group is opened.
    assert.strictEqual(deep(tree).filter((n) => n.props?.className === 'layout-row').length, 0);
});

t('opening a group draws its rows', () => {
    reset();
    let out = render(LayoutPanel, {}, context());
    const heads = deep(out.tree).filter((n) => n.props?.className === 'layout-group__head');
    assert.strictEqual(heads.length, allGroupsFor(listed()).length, 'a head per group');
    heads[0].props.onClick();
    out = render(LayoutPanel, {}, context());
    const rows = deep(out.tree).filter((n) => n.props?.className === 'layout-row').length;
    assert.ok(rows > 0, 'the first group opened');
    assert.strictEqual(rows, allGroupsFor(listed())[0].items.length);
});

t('All lists every panel at once', () => {
    reset();
    let out = render(LayoutPanel, {}, context());
    // The Grouped/All pair is the Segmented with an 'all' option. walk rather
    // than deep: deep calls a function component instead of pushing it, and
    // Segmented is one — its props are only visible in the tree as returned.
    const seg = walk(out.tree).find((n) => n.props?.options?.some?.((o) => o.value === 'all'));
    assert.ok(seg, 'the Grouped/All toggle is drawn');
    seg.props.onChange('all');
    out = render(LayoutPanel, {}, context());
    const rows = deep(out.tree).filter((n) => n.props?.className === 'layout-row').length;
    assert.strictEqual(rows, listed().length);
    // And with no grouping there is nothing to collapse.
    assert.ok(!words(out.tree).includes('Collapse all'));
});

// --- the minimal view --------------------------------------------------------

t('the header offers a minimal view at all', () => {
    // Without this the toggle never appears and the branch below is dead code.
    assert.strictEqual(PANEL_BY_ID.layout.minimal, true);
});

t('minimal keeps the list and drops everything set once', () => {
    reset();
    const { tree } = render(LayoutPanel, { minimal: true }, context());
    const text = words(tree);
    assert.ok(!text.includes('Float opacity'), 'no opacity slider');
    assert.ok(!text.includes('always solid'), 'nor the line under it');
    assert.ok(!text.includes('Grouped'), 'no grouped/flat choice');
    assert.ok(!text.includes('Reset layout'));
    assert.ok(!walk(tree).some((n) => n.props?.className === 'divider'));
    // What it is for: the groups, and the collapse pair that works them.
    assert.ok(text.includes('Collapse all'));
    const heads = deep(tree).filter((n) => n.props?.className === 'layout-group__head');
    assert.strictEqual(heads.length, allGroupsFor(listed()).length);
});

t('minimal drops a custom panel\'s provenance line', () => {
    reset();
    const mine = { id: 'mine', title: 'Mine', group: 'shack', custom: { callsign: 'M0ABC', version: '1.2' } };
    const props = {
        panel: mine, hidden: false, onShown() {}, placement: 'left', onPlace() {},
    };
    // The row component itself, both ways round: no custom panel ships in this
    // build, so the provenance line has to be provoked rather than found. Open a
    // group first — a collapsed one draws no rows to take the component from.
    let out = render(LayoutPanel, {}, context());
    walk(out.tree).find((n) => n.props?.className === 'layout-group__head').props.onClick();
    out = render(LayoutPanel, {}, context());
    const Row = walk(out.tree).find((n) => typeof n.type === 'function' && n.props?.panel).type;
    reset();
    assert.ok(words(Row({ ...props })).includes('M0ABC'), 'the full row says who wrote it');
    reset();
    assert.ok(!words(Row({ ...props, minimal: true })).includes('M0ABC'));
});

t('the count beside a group is how many of it are on', () => {
    reset();
    const off = Object.fromEntries(listed().map((p) => [p.id, { hidden: true }]));
    const { tree } = render(LayoutPanel, {}, context({ sections: off }));
    const counts = deep(tree).filter((n) => n.props?.className === 'layout-group__count');
    assert.ok(counts.length > 0);
    for (const c of counts) assert.strictEqual(c.props.children[0], 0, 'all hidden reads as 0');
});

console.log(`\n${pass} passed`);
