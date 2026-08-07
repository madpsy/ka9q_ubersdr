// Which panel gets the keyboard back when a dock reopens.
//
// The bug this is for: the bottom dock collapsed to a rail, a chat box and a cluster
// command line in it, and every peek at the rail handing the keyboard to the cluster
// because it focused on mount. So the rules worth pinning down are about *not* taking
// focus — from another panel, from outside the dock, from an element that already has it.
//
// There is no DOM in node, so the elements below are the smallest thing that answers the
// three questions this module asks of them: what panel am I in, what can be focused
// inside me, and what has focus now.

const assert = require('assert');
const df = require('./.build/dockfocus.cjs');

let pass = 0;
const t = (name, fn) => {
    df._resetDockFocus();
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A stand-in for a section and the input inside it.
function panel(id, { hasMark = true } = {}) {
    const input = { focused: 0, focus() { this.focused += 1; } };
    const section = {
        id,
        matches: (sel) => sel.includes('data-panel'),
        querySelector: (sel) => (sel.includes('data-dock-focus') ? (hasMark ? input : null) : input),
        getAttribute: (name) => (name === 'data-panel' ? id : null),
    };
    const el = { closest: (sel) => (sel === '[data-panel]' ? section : null) };
    return { section, input, el };
}

// A dock body holding some panels.
function body(panels) {
    return {
        contains: (node) => panels.some((p) => p.input === node || p.section === node),
        querySelector: (sel) => {
            const m = /data-panel="([^"]+)"/.exec(sel);
            if (!m) return null;
            const hit = panels.find((p) => p.section.id === m[1]);
            return hit ? hit.section : null;
        },
    };
}

// document.activeElement, which the module reads.
function withActive(el, fn) {
    global.document = { activeElement: el, body: {} };
    try { return fn(); } finally { delete global.document; }
}

// --- remembering ------------------------------------------------------------------

t('focus landing in a panel is remembered against its dock', () => {
    const chat = panel('chat');
    df.noteDockFocus('bottom', chat.el);
    assert.strictEqual(df.dockFocusPanel('bottom'), 'chat');
});

t('each dock remembers its own', () => {
    df.noteDockFocus('bottom', panel('chat').el);
    df.noteDockFocus('left', panel('spots').el);
    assert.strictEqual(df.dockFocusPanel('bottom'), 'chat');
    assert.strictEqual(df.dockFocusPanel('left'), 'spots');
});

t('the latest one wins, because it is where you were last', () => {
    df.noteDockFocus('bottom', panel('chat').el);
    df.noteDockFocus('bottom', panel('dxcluster').el);
    assert.strictEqual(df.dockFocusPanel('bottom'), 'dxcluster');
});

t('something that is not in a panel is not remembered', () => {
    // The top bar's frequency box, say: focus leaving the dock is not a note about the
    // dock.
    df.noteDockFocus('bottom', { closest: () => null });
    df.noteDockFocus('bottom', null);
    assert.strictEqual(df.dockFocusPanel('bottom'), '');
});

// --- giving it back ------------------------------------------------------------------

t('the panel that had it gets it back', () => {
    const chat = panel('chat');
    const dxc = panel('dxcluster');
    df.noteDockFocus('bottom', chat.el);
    withActive(null, () => {
        assert.strictEqual(df.restoreDockFocus('bottom', body([chat, dxc])), true);
    });
    assert.strictEqual(chat.input.focused, 1);
    assert.strictEqual(dxc.input.focused, 0, 'and the other one does not');
});

t('a panel says which of its inputs, and is believed', () => {
    // A panel with a callsign field and a command line has to be able to say that the
    // command line is the one — see data-dock-focus in DXClusterPanel.
    const marked = panel('dxcluster', { hasMark: true });
    df.noteDockFocus('bottom', marked.el);
    withActive(null, () => df.restoreDockFocus('bottom', body([marked])));
    assert.strictEqual(marked.input.focused, 1);
});

t('a dock that never had focus does not take it', () => {
    const chat = panel('chat');
    withActive(null, () => {
        assert.strictEqual(df.restoreDockFocus('bottom', body([chat])), false);
    });
    assert.strictEqual(chat.input.focused, 0);
});

t('a panel that is no longer in the dock is not chased', () => {
    // Dragged to another dock, or hidden, between the note and the restore.
    const chat = panel('chat');
    df.noteDockFocus('bottom', chat.el);
    withActive(null, () => {
        assert.strictEqual(df.restoreDockFocus('bottom', body([panel('spots')])), false);
    });
});

t('focus outside the dock is left alone', () => {
    // The whole point of the guard: a dock reopening must not pull the keyboard out of
    // the frequency box, a floating window or another dock.
    const chat = panel('chat');
    const elsewhere = { closest: () => null };
    df.noteDockFocus('bottom', chat.el);
    withActive(elsewhere, () => {
        assert.strictEqual(df.restoreDockFocus('bottom', body([chat])), false);
    });
    assert.strictEqual(chat.input.focused, 0);
});

t('focus already inside the dock is taken back, because the peek moved it', () => {
    // A remount can leave focus on something in the dock that is not where it was —
    // that is the cluster grabbing it. Inside the dock counts as free.
    const chat = panel('chat');
    const dxc = panel('dxcluster');
    df.noteDockFocus('bottom', chat.el);
    withActive(dxc.input, () => {
        assert.strictEqual(df.restoreDockFocus('bottom', body([chat, dxc])), true);
    });
    assert.strictEqual(chat.input.focused, 1);
});

t('the element that already has focus is not refocused', () => {
    // Idempotent: the dock's body attaches on every render of it, and moving the caret
    // in an input somebody is typing into would be worse than doing nothing.
    const chat = panel('chat');
    df.noteDockFocus('bottom', chat.el);
    withActive(chat.input, () => {
        assert.strictEqual(df.restoreDockFocus('bottom', body([chat])), false);
    });
    assert.strictEqual(chat.input.focused, 0);
});

t('forgetting means the next reopen takes nothing', () => {
    const chat = panel('chat');
    df.noteDockFocus('bottom', chat.el);
    df.forgetDockFocus('bottom');
    withActive(null, () => df.restoreDockFocus('bottom', body([chat])));
    assert.strictEqual(chat.input.focused, 0);
});

t('nothing to restore into is not an error', () => {
    df.noteDockFocus('bottom', panel('chat').el);
    withActive(null, () => {
        assert.strictEqual(df.restoreDockFocus('bottom', null), false);
    });
});

if (process.exitCode) console.log('\ndock focus tests FAILED');
else console.log(`\nall ${pass} dock focus tests passed`);
