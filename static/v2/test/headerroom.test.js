// Spare room in a panel's title bar, and whether one more control belongs in it.
//
// Two properties matter, and the first one is why this exists at all: the answer
// must not depend on how hard the title has already been squeezed. A bar's
// title is an ellipsis in a flexible box, so measuring it by its box gives a
// figure that shrinks in step with the bar and never reports that anything is
// too wide — which is how the zoom pair came to be judged against the panel's
// width instead, and how it then failed to appear in side docks that plainly had
// room for it.
//
// The second is the usual one: the control's own width is part of the slack it
// is being judged against, so the answer has to hold still with it up and with
// it down.

const assert = require('assert');
const { fitsInHeader, measureSlack } = require('./.build/headerroom.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- element-shaped objects --------------------------------------------------

// A title is `text` wide when it has the room, and squeezed to whatever is left
// when it does not — reporting the full text in scrollWidth either way, which is
// the browser behaviour this leans on.
function title({ text, box }) {
    return {
        elastic: true,
        matches: (sel) => sel === '.title',
        offsetWidth: Math.min(text, box),
        scrollWidth: text,
    };
}

function fixed(w) {
    return { matches: () => false, offsetWidth: w, scrollWidth: w };
}

// The row: fixed controls, one title, and whatever the bar is wide enough for.
// The title gets what is left after everything else, which is what a `flex: 1`
// ellipsis does.
function head({ width, gap = 4, pad = 0, text, fixeds }) {
    const others = fixeds.reduce((s, w) => s + w, 0);
    const n = fixeds.length + 1;
    const forTitle = width - pad - others - gap * (n - 1);
    const kids = [...fixeds.map(fixed), title({ text, box: Math.max(0, forTitle) })];
    return { children: kids, clientWidth: width, gap, pad };
}

global.getComputedStyle = (node) => ({
    columnGap: `${node.gap || 0}px`,
    paddingLeft: `${(node.pad || 0) / 2}px`,
    paddingRight: `${(node.pad || 0) / 2}px`,
});

const ZOOM = 38;
// A dock section's header: chevron, icon, the title, then the reorder pair, the
// minimal toggle and the move menu.
const CHROME = [14, 16, 34, 22, 22];

t('slack is what is left, and it goes negative when the title is squeezed', () => {
    const roomy = head({ width: 300, text: 60, fixeds: CHROME });
    assert.ok(measureSlack(roomy, '.title') > 0, 'a wide bar has room to spare');

    const tight = head({ width: 140, text: 120, fixeds: CHROME });
    assert.ok(measureSlack(tight, '.title') < 0, 'a squeezed title is a bar over its budget');
});

t('the answer does not change with how squeezed the title already is', () => {
    // The bug this pins. Measured by its box, the title of the second bar is
    // narrower than the first and the two would look equally comfortable.
    const short = head({ width: 200, text: 50, fixeds: CHROME });
    const long = head({ width: 200, text: 300, fixeds: CHROME });
    assert.ok(measureSlack(short, '.title') > measureSlack(long, '.title'),
        'a longer title in the same bar must read as less room, not the same');
});

t('a long title is what takes the room, not only a narrow dock', () => {
    // Same 260px bar either way: the pair belongs in one and not the other,
    // which is precisely what a threshold on the panel's width cannot say.
    const audio = head({ width: 260, text: 40, fixeds: CHROME });
    const callsign = head({ width: 260, text: 190, fixeds: CHROME });
    assert.strictEqual(fitsInHeader(measureSlack(audio, '.title'), ZOOM, false), true);
    assert.strictEqual(fitsInHeader(measureSlack(callsign, '.title'), ZOOM, false), false);
});

t('a default side dock has room for it — the case that was reported broken', () => {
    // 320px dock, less 8px of body padding either side and a scrollbar, is about
    // 285 of section; the header is that less its own trim. Every one of the
    // panel titles fits with the pair up.
    for (const text of [40, 60, 90]) {
        const bar = head({ width: 275, text, fixeds: CHROME });
        assert.strictEqual(
            fitsInHeader(measureSlack(bar, '.title'), ZOOM, false), true,
            `a ${text}px title in a default side dock should keep the zoom pair`,
        );
    }
    // And the far end of it, which is the behaviour that was asked for rather
    // than a shortcoming: the longest panel titles in a dock at that width leave
    // under the pair's own width, so they lose it and keep their name.
    const longest = head({ width: 275, text: 130, fixeds: CHROME });
    assert.strictEqual(fitsInHeader(measureSlack(longest, '.title'), ZOOM, false), false);
});

t('shown or hidden, the answer holds still', () => {
    // The control's width is part of what it is judged against, so the two
    // states have to agree — at every width, and with every length of title.
    const unstable = [];
    for (let width = 80; width <= 600; width += 1) {
        for (const text of [30, 60, 90, 140, 260]) {
            const hidden = head({ width, text, fixeds: CHROME });
            const shownBar = head({ width, text, fixeds: [...CHROME, ZOOM] });
            const a = fitsInHeader(measureSlack(hidden, '.title'), ZOOM, false);
            const b = fitsInHeader(measureSlack(shownBar, '.title'), ZOOM, true);
            // Landing in the same state from either side is what "holds still"
            // means: whichever it is in now, one more measurement leaves it
            // there.
            if (a && !b) unstable.push(`${width}px/${text}px title`);
        }
    }
    assert.deepStrictEqual(unstable, [], `flip-flops at ${unstable.slice(0, 5)}`);
});

t('a bar with no room at all does not carry it', () => {
    const bar = head({ width: 120, text: 90, fixeds: CHROME });
    assert.strictEqual(fitsInHeader(measureSlack(bar, '.title'), ZOOM, false), false);
    // ...and one already showing it gives it up rather than eating the title.
    const shownBar = head({ width: 120, text: 90, fixeds: [...CHROME, ZOOM] });
    assert.strictEqual(fitsInHeader(measureSlack(shownBar, '.title'), ZOOM, true), false);
});

console.log(`\n${pass} header room checks passed`);
