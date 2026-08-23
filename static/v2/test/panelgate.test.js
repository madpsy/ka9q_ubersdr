// Every surface that lists panels asks whether the panel applies.
//
// `usePanelApplies` is the one answer to "does this panel belong on the receiver
// we are connected to" — the operator's custom panels above all, which belong to
// one receiver while the arrangement that places them is shared across all of
// them. A surface that lists panels without asking shows a panel the receiver
// has never heard of, and what the operator sees is a window that draws and then
// says it could not be loaded.
//
// This is a source check rather than a render test on purpose. The bug it exists
// for is a *missing* call, and no amount of exercising the three surfaces that
// do ask would say anything about the fourth that does not. FloatingLayer was
// that fourth for real: the docks, the mobile tab bar and the layout manager all
// gated, the floating layer did not, and a floating custom panel opened on the
// wrong receiver sat there failing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// Every module that turns the panel registry into something on screen. Adding a
// surface means adding it here, which is the point: the list is the claim.
const SURFACES = [
    'components/Dock.jsx',
    'components/FloatingLayer.jsx',
    'components/MobileShell.jsx',
    'panels/LayoutPanel.jsx',
];

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

for (const rel of SURFACES) {
    t(`${rel} asks whether a panel applies`, () => {
        const src = read(rel);
        assert.ok(/usePanelApplies/.test(src),
            `${rel} lists panels but never imports usePanelApplies`);
        // Imported and not called is the same bug with a clean import line.
        assert.ok(/=\s*usePanelApplies\(\)/.test(src),
            `${rel} imports usePanelApplies but does not call it`);
    });
}

t('the surfaces named here are the ones that read the registry', () => {
    // The other half of the claim: if a module reaches PANELS or PANEL_BY_ID to
    // decide what to show, it has to be in the list above. Catches a fifth
    // surface arriving without a gate — the exact way the fourth one arrived.
    const found = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!/\.jsx?$/.test(entry.name)) continue;
            const src = fs.readFileSync(full, 'utf8');
            // A listing is an iteration over the registry. Reading one entry by
            // id — PANEL_BY_ID[something] — is a lookup, not a listing, and
            // several modules legitimately do it.
            if (/PANELS\s*\.\s*(map|filter|find|forEach)/.test(src)
                || /\bfor\s*\(\s*const\s+\w+\s+of\s+PANELS\b/.test(src)) {
                found.push(path.relative(SRC, full));
            }
        }
    };
    walk(SRC);

    // Reads the registry for something other than deciding what to draw, so the
    // gate does not apply. Each one is here with its reason rather than by a
    // pattern, so that a new name appearing is a decision somebody makes.
    const NOT_A_SURFACE = {
        'panels/registry.jsx': 'where the gate lives',
        // Reconciles a stored layout against every registered panel. It must
        // see them all: gating here would drop the placement of a panel this
        // receiver does not serve, and parking it is exactly the point.
        'layout/LayoutContext.jsx': 'reconciliation, not display',
        // The `layout` topic of the page API. Listed here deliberately and not
        // silently: it reports every registered panel, while the Layout panel
        // showing the same thing on screen is gated — so a bridge client can be
        // told about a custom panel belonging to another receiver. Left as it
        // is because changing it changes a documented API, not because it is
        // obviously right.
        'bridge/BridgeHost.jsx': 'page API surface, gated differently',
    };

    const ungated = found.filter((rel) => {
        if (NOT_A_SURFACE[rel]) return false;
        if (SURFACES.includes(rel)) return false;
        return !/usePanelApplies/.test(read(rel));
    });
    assert.deepStrictEqual(ungated, [],
        `these list the registry without the gate: ${ungated.join(', ')}`);
});

console.log(`\n${pass} ok`);
