// Haptic feedback: the pure parts.
//
// Two things here are worth pinning down. The first is that a pattern is never
// rounded to zero — a 0 ms pulse is accepted by the platform and silently
// dropped, so 'light' would read as broken rather than subtle on the shortest
// kinds. The second is the delegation table: hapticKindFor is what lets one
// listener cover the whole app, and every way of getting it wrong is quiet —
// a disabled button that buzzes, or a switch that feels like a plain tap.

const assert = require('assert');

const {
    HAPTIC_MODES, HAPTIC_SCOPES, hapticKindFor, hapticPattern, scopeEnabled, shouldFire,
} = require('./.build/haptics.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A stand-in for the DOM bits hapticKindFor touches. `closest` walks the chain
// built by `child()` and matches on the handful of selector forms in PRESSABLE.
function el({ tag = 'DIV', role, cls = '', disabled, type, haptic, ariaDisabled, parent } = {}) {
    const node = {
        tagName: tag,
        className: cls,
        disabled,
        type,
        dataset: haptic ? { haptic } : {},
        parent,
        getAttribute(name) {
            if (name === 'role') return role || null;
            if (name === 'aria-disabled') return ariaDisabled || null;
            return null;
        },
    };
    node.matches = (sel) => sel.split(',').map((s) => s.trim()).some((s) => {
        if (s === '[data-haptic]') return !!node.dataset.haptic;
        if (s.startsWith('[role=')) return role === s.slice(7, -2);
        if (s.startsWith('input[type=')) return tag === 'INPUT' && type === s.slice(12, -2);
        if (s === 'a[href]') return tag === 'A';
        return s.toUpperCase() === tag;
    });
    node.closest = (sel) => {
        for (let n = node; n; n = n.parent) if (n.matches(sel)) return n;
        return null;
    };
    return node;
}

// ---- patterns -------------------------------------------------------------

t('off is silent', () => {
    for (const kind of ['tap', 'tune', 'step', 'bump']) {
        assert.strictEqual(hapticPattern(kind, 'off'), null);
    }
});

t('an unknown mode is silent, not a default', () => {
    assert.strictEqual(hapticPattern('tap', undefined), null);
    assert.strictEqual(hapticPattern('tap', 'gentle'), null);
});

t('an unknown kind is silent', () => {
    assert.strictEqual(hapticPattern('explode', 'medium'), null);
});

t('every pulse stays in UI-tap territory', () => {
    // A control says "pressed", not "look at me". Nothing single-pulse may run
    // past 30 ms even at 'strong', or it starts reading as a notification.
    for (const mode of HAPTIC_MODES.filter((m) => m !== 'off')) {
        for (const kind of ['tap', 'toggle', 'select', 'step', 'tune', 'grab']) {
            const p = hapticPattern(kind, mode);
            assert.ok(typeof p === 'number', `${kind}/${mode} should be one pulse`);
            assert.ok(p > 0 && p <= 30, `${kind}/${mode} = ${p} ms out of range`);
        }
    }
});

t('light is weaker than medium is weaker than strong', () => {
    for (const kind of ['tap', 'tune', 'step']) {
        const l = hapticPattern(kind, 'light');
        const m = hapticPattern(kind, 'medium');
        const s = hapticPattern(kind, 'strong');
        assert.ok(l < m && m < s, `${kind}: ${l} ${m} ${s} not increasing`);
    }
});

t('nothing rounds away to nothing', () => {
    // `step` is the shortest kind and 'light' the smallest scale, which is
    // where a plain Math.round would land on 0 first.
    for (const mode of HAPTIC_MODES.filter((m) => m !== 'off')) {
        for (const kind of ['tap', 'toggle', 'select', 'step', 'tune', 'grab', 'bump']) {
            const p = hapticPattern(kind, mode);
            const parts = Array.isArray(p) ? p : [p];
            for (const ms of parts) assert.ok(ms >= 1, `${kind}/${mode} produced ${ms}`);
        }
    }
});

t('bump is the two-part one', () => {
    const p = hapticPattern('bump', 'medium');
    assert.ok(Array.isArray(p) && p.length === 3, 'bump should be pulse/gap/pulse');
});

// ---- rate limiting --------------------------------------------------------

t('the first pulse of a kind always fires', () => {
    assert.strictEqual(shouldFire('step', 1000, 0), true);
    assert.strictEqual(shouldFire('tap', 0, 0), true);
});

t('a repeating gesture is thinned, not silenced', () => {
    // A pinch can ask for a rung every PINCH_MS; back-to-back pulses stop being
    // separate events and become a buzz.
    assert.strictEqual(shouldFire('step', 1010, 1000), false);
    assert.strictEqual(shouldFire('step', 1040, 1000), true);
});

t('a press and its click do not double up', () => {
    // pointerdown and the compatibility click are milliseconds apart.
    assert.strictEqual(shouldFire('tap', 1005, 1000), false);
    assert.strictEqual(shouldFire('tap', 1100, 1000), true);
});

t('one-off kinds get the longer gap', () => {
    assert.strictEqual(shouldFire('tune', 1030, 1000), false);
    assert.strictEqual(shouldFire('tune', 1050, 1000), true);
});

// ---- scopes ---------------------------------------------------------------

t('the two scopes are switched independently', () => {
    const state = { ui: false, spectrum: true };
    assert.strictEqual(scopeEnabled('ui', state), false);
    assert.strictEqual(scopeEnabled('spectrum', state), true);
});

t('a scope is off only when it says so', () => {
    // Silence has to be asked for. A caller that passes a scope nobody has a
    // switch for, or state that has not loaded yet, gets feedback rather than
    // a control that quietly does nothing.
    assert.strictEqual(scopeEnabled('ui', null), true);
    assert.strictEqual(scopeEnabled('ui', {}), true);
    assert.strictEqual(scopeEnabled('somethingnew', { ui: false }), true);
    assert.strictEqual(scopeEnabled('ui', { ui: undefined }), true);
});

t('both scopes are named, so the panel and the callers agree', () => {
    assert.deepStrictEqual(HAPTIC_SCOPES, ['ui', 'spectrum']);
});

// ---- delegation -----------------------------------------------------------

t('a button is a tap', () => {
    assert.strictEqual(hapticKindFor(el({ tag: 'BUTTON' })), 'tap');
});

t('a press on a button\'s icon still finds the button', () => {
    const btn = el({ tag: 'BUTTON' });
    assert.strictEqual(hapticKindFor(el({ tag: 'SPAN', parent: btn })), 'tap');
});

t('a switch is heavier than a tap', () => {
    assert.strictEqual(hapticKindFor(el({ tag: 'BUTTON', role: 'switch' })), 'toggle');
});

t('picking one of a set is its own weight', () => {
    for (const cls of ['segmented__item', 'palette is-active', 'tabbar__item', 'chip chip--button', 'list__row']) {
        assert.strictEqual(hapticKindFor(el({ tag: 'BUTTON', cls })), 'select', cls);
    }
});

t('a class that merely contains one of those names is not a match', () => {
    assert.strictEqual(hapticKindFor(el({ tag: 'BUTTON', cls: 'palette-grid' })), 'tap');
});

t('a slider is a grab', () => {
    assert.strictEqual(hapticKindFor(el({ tag: 'INPUT', type: 'range' })), 'grab');
});

t('a disabled control is silent', () => {
    assert.strictEqual(hapticKindFor(el({ tag: 'BUTTON', disabled: true })), null);
    assert.strictEqual(hapticKindFor(el({ tag: 'BUTTON', ariaDisabled: 'true' })), null);
});

t('plain markup is silent', () => {
    assert.strictEqual(hapticKindFor(el({ tag: 'DIV' })), null);
    assert.strictEqual(hapticKindFor(null), null);
});

t('data-haptic opts in and names the kind', () => {
    assert.strictEqual(hapticKindFor(el({ tag: 'SPAN', haptic: 'tap' })), 'tap');
    assert.strictEqual(hapticKindFor(el({ tag: 'SPAN', haptic: 'grab' })), 'grab');
});

t('data-haptic="off" takes a control out', () => {
    // For controls that fire their own, so a press and its result are not two
    // pulses on top of each other.
    assert.strictEqual(hapticKindFor(el({ tag: 'BUTTON', haptic: 'off' })), null);
});

console.log(`\n${pass} passed`);
