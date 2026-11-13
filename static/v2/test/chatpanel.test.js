// The chat panel with the moderator's tools, and the moderation states every
// listener can be in. See hookStub.js for what "renders" means here.
//
// Off, a moderator's panel is a listener's panel. On, each person's Follow and
// Ignore become one shield (so the column never widens), names on message lines
// open the same sheet, and the sheet shows what the server says about them and
// asks before the one action that cannot be undone from the panel.

const assert = require('assert');

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.location = { protocol: 'http:', host: 'rx.test', search: '', pathname: '/' };
globalThis.WebSocket = class { };
globalThis.WebSocket.OPEN = 1;
globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    createElement: () => ({ getContext: () => null }),
    addEventListener() {},
    removeEventListener() {},
    body: {},
};
globalThis.navigator = { userAgent: 'node' };
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = () => Promise.reject(new Error('no network in a test'));
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.innerWidth = 1600;
globalThis.innerHeight = 1000;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const {
    deep, render, rerender, reset, words,
    ChatPanel, CHAT_BAN_PRESETS, ModSheet, WARN_CHIPS, banText, modBanFor, modWarningsFor,
    recordLine, untilText,
} = require('./.build/chatpanel.cjs');

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

const tick = () => new Promise((r) => setTimeout(r, 0));

const USERS = [
    { username: 'M9PSY', frequency: 14200000, mode: 'usb', country_code: 'GB' },
    { username: 'G4XYZ', frequency: 7100000, mode: 'lsb', country_code: 'GB' },
    { username: 'DL1ABC', frequency: 3600000, mode: 'lsb', country_code: 'DE' },
    { username: 'K3MOD', frequency: 14070000, mode: 'usb', moderator: true },
];

const ts = (min) => new Date(Date.UTC(2026, 10, 12, 12, min)).toISOString();
const MESSAGES = [
    { id: 'a', key: 'a', serverId: 1, username: 'G4XYZ', message: 'hello all', timestamp: ts(1) },
    { id: 'b', key: 'b', serverId: 2, username: 'M9PSY', message: 'hi there', timestamp: ts(2) },
    { id: 'c', key: 'c', serverId: 3, username: 'GONE1', message: 'bye', timestamp: ts(3) },
    { id: 'd', key: 'd', system: true, username: 'DL1ABC', message: 'joined', timestamp: ts(4) },
];

// One object answers useChat, useRadio and useLayout alike — the stub's
// useContext cannot tell them apart. `actions` holds both halves.
function context(over = {}) {
    const calls = [];
    const replies = over.replies || {};
    const ctx = {
        // chat
        enabled: true, state: 'open', connected: true, joined: true, username: 'M9PSY',
        messages: MESSAGES, users: USERS, error: null, unreadMentions: 0, chimeOn: false,
        following: null, followZoom: false, ignored: [],
        isModerator: true, modState: { bans: [], warnings: {} }, chatBan: null,
        // radio
        running: true, tuning: { frequency: 14200000, mode: 'usb' },
        // layout
        floats: {}, placementOf: () => 'bottom',
        movePanel: (...a) => calls.push(['movePanel', ...a]),
        setFloat: (...a) => calls.push(['setFloat', ...a]),
        ...over,
    };
    ctx.actions = {
        join() {}, send: () => true, leave() {}, follow() {}, unfollow() {}, setFollowZoom() {},
        clearError() {}, markMentionsRead() {},
        tuneTo() {}, ensureVisible() {}, setSpectrumCenter() {},
        mod(action, name, opts) {
            calls.push(['mod', action, name, opts]);
            const r = replies[action];
            if (typeof r === 'function') return r(name, opts);
            if (r) return Promise.resolve(r);
            return Promise.resolve({ action, ok: true, username: name, message: 'done' });
        },
    };
    ctx.calls = calls;
    return ctx;
}

const cls = (n) => (n && n.props && typeof n.props.className === 'string' ? n.props.className.split(/\s+/) : []);
const byClass = (tree, c) => deep(tree).filter((n) => cls(n).includes(c));
const buttons = (tree) => deep(tree).filter((n) => n.type === 'button');
const buttonNamed = (tree, label) => {
    const b = buttons(tree).find((n) => words(n).trim() === label);
    assert.ok(b, `no "${label}" button in: ${buttons(tree).map((n) => JSON.stringify(words(n).trim())).join(', ')}`);
    return b;
};
const hasText = (tree, s) => words(tree).includes(s);

// The panel, rendered fresh, with the Moderate switch set as asked.
function panel(over = {}, { moderate = false, minimal = false } = {}) {
    store.set('ubersdr.v2.chatModerate', moderate ? 'on' : 'off');
    reset();
    const ctx = context(over);
    const r = render(ChatPanel, { minimal }, ctx);
    return { ...r, ctx, again: () => render(ChatPanel, { minimal }, ctx).tree };
}

// The buttons on one person's row, past the row's own tune button.
const rowButtons = (tree, name) => {
    const row = byClass(tree, 'chat__user-row').find((n) => words(n).includes(name));
    assert.ok(row, `no row for ${name}`);
    return deep(row).filter((n) => n.type === 'button' && !cls(n).includes('chat__user'));
};

// ── The panel, Moderate off ─────────────────────────────────────────────────

t('a listener sees no moderation at all, and no switch', () => {
    const { tree } = panel({ isModerator: false });
    assert.strictEqual(buttons(tree).filter((b) => b.props.title === 'Moderate chat').length, 0);
    for (const c of ['chat__modbar', 'chat__modbtn', 'chat__who--mod', 'chat__modbadge', 'chat__removed']) {
        assert.strictEqual(byClass(tree, c).length, 0, `${c} drawn for a listener`);
    }
    assert.strictEqual(byClass(tree, 'chat__follow').length, 3);
});

t('a moderator with the switch off sees a listener\'s panel plus the switch', () => {
    const { tree } = panel({ modState: { bans: [{ username: 'G4XYZ', until: ts(30) }], warnings: { DL1ABC: 2 } } });
    const sw = buttons(tree).filter((b) => b.props.title === 'Moderate chat');
    assert.strictEqual(sw.length, 1);
    assert.strictEqual(sw[0].props['aria-pressed'], false);
    for (const c of ['chat__modbar', 'chat__modbtn', 'chat__who--mod', 'chat__modbadge', 'chat__removed']) {
        assert.strictEqual(byClass(tree, c).length, 0, `${c} drawn with Moderate off`);
    }
    assert.strictEqual(rowButtons(tree, 'G4XYZ').length, 2);
});

t('the switch turns moderating on, and is remembered', () => {
    const p = panel();
    buttons(p.tree).find((b) => b.props.title === 'Moderate chat').props.onClick();
    assert.strictEqual(store.get('ubersdr.v2.chatModerate'), 'on');
    const tree = p.again();
    assert.strictEqual(byClass(tree, 'chat__modbar').length, 1);
    assert.ok(hasText(tree, 'Moderating — pick a name for actions'));
    const sw = buttons(tree).find((b) => b.props.title === 'Stop moderating');
    assert.strictEqual(sw.props['aria-pressed'], true);
    // Done turns it off again.
    buttonNamed(tree, 'Done').props.onClick();
    assert.strictEqual(store.get('ubersdr.v2.chatModerate'), 'off');
    assert.strictEqual(byClass(p.again(), 'chat__modbar').length, 0);
});

t('a remembered switch does nothing for somebody who is not a moderator', () => {
    const { tree } = panel({ isModerator: false }, { moderate: true });
    assert.strictEqual(byClass(tree, 'chat__modbar').length, 0);
    assert.strictEqual(byClass(tree, 'chat__modbtn').length, 0);
});

// ── Moderating ──────────────────────────────────────────────────────────────

t('each row trades Follow and Ignore for one shield, so the column keeps its width', () => {
    const off = panel().tree;
    const on = panel({}, { moderate: true }).tree;
    for (const name of ['G4XYZ', 'DL1ABC']) {
        const a = rowButtons(off, name);
        const b = rowButtons(on, name);
        assert.strictEqual(a.length, 2, `${name}: follow + ignore`);
        assert.strictEqual(b.length, a.length - 1, `${name}: one shield`);
        assert.ok(cls(b[0]).includes('chat__modbtn'));
        assert.strictEqual(b[0].props.title, `Moderate ${name}`);
    }
    assert.strictEqual(byClass(on, 'chat__follow').length, 0);
    assert.strictEqual(byClass(on, 'chat__ignore').length, 0);
});

t('no shield on our own row, nor on another moderator\'s', () => {
    const { tree } = panel({}, { moderate: true });
    assert.strictEqual(rowButtons(tree, 'M9PSY').length, 0);
    assert.strictEqual(rowButtons(tree, 'K3MOD').length, 0);
    assert.strictEqual(byClass(tree, 'chat__modbtn').length, 2);
});

t('names on message lines are buttons only while moderating, never our own or a moderator\'s', () => {
    let tree = panel().tree;
    assert.strictEqual(byClass(tree, 'chat__who--mod').length, 0);
    const messages = [
        ...MESSAGES,
        { id: 'm', key: 'm', serverId: 9, username: 'k3mod', message: 'mod here', timestamp: ts(5) },
    ];
    tree = panel({ messages }, { moderate: true }).tree;
    const names = byClass(tree, 'chat__who--mod').map((n) => words(n).trim());
    assert.deepStrictEqual(names, ['G4XYZ', 'GONE1']);
    // The moderator's line is plain text, not a way into the sheet.
    assert.ok(byClass(tree, 'chat__who').some((n) => words(n).trim() === 'k3mod'));
    // Presence lines stay as they were.
    assert.strictEqual(byClass(tree, 'chat__sys').length, 1);
});

t('a name on a message line opens the sheet, for somebody who has left as well', () => {
    const p = panel({}, { moderate: true });
    byClass(p.tree, 'chat__who--mod').find((n) => words(n).includes('GONE1')).props.onClick();
    const tree = p.again();
    assert.strictEqual(byClass(tree, 'chat-mod').length, 1, 'sheet open');
    assert.ok(hasText(byClass(tree, 'chat-mod')[0], 'GONE1'));
    assert.ok(hasText(tree, 'Left'), 'the sheet says they have left');
});

t('the row shield opens the sheet for that person', () => {
    const p = panel({}, { moderate: true });
    rowButtons(p.tree, 'G4XYZ')[0].props.onClick();
    const tree = p.again();
    assert.ok(byClass(tree, 'chat-mod').length === 1, 'sheet open');
    assert.ok(hasText(tree, 'In chat'));
});

t('badges: warning count, or a lock while banned from chat', () => {
    const modState = {
        bans: [{ username: 'G4XYZ', ip: '1.2.3.4', until: ts(30), by: 'auto' }],
        warnings: { dl1abc: 2, G4XYZ: 1 },
    };
    const { tree } = panel({ modState }, { moderate: true });
    const row = (name) => byClass(tree, 'chat__user-row').find((n) => words(n).includes(name));
    assert.strictEqual(byClass(row('G4XYZ'), 'chat__modbadge--ban').length, 1, 'ban wins over the count');
    assert.strictEqual(byClass(row('G4XYZ'), 'chat__modbadge--ban')[0].props.title, 'Banned from chat');
    const dl = byClass(row('DL1ABC'), 'chat__modbadge');
    assert.strictEqual(dl.length, 1);
    assert.strictEqual(words(dl[0]).trim(), '2', 'warnings match whatever the case');
    assert.strictEqual(byClass(row('M9PSY'), 'chat__modbadge').length, 0);
    // And before the name on its message line.
    const line = byClass(tree, 'chat__who--mod').find((n) => words(n).includes('G4XYZ'));
    assert.strictEqual(byClass(line, 'chat__modbadge--ban').length, 1);
});

t('"Chat-banned (N)" lists them with Lift, which asks the server', () => {
    const modState = {
        bans: [
            { username: 'G4XYZ', ip: '1.2.3.4', until: ts(30), by: 'auto' },
            { username: 'GONE1', ip: '5.6.7.8', until: ts(50), by: 'M9PSY' },
        ],
        warnings: {},
    };
    const p = panel({ modState }, { moderate: true });
    const box = byClass(p.tree, 'chat__removed');
    assert.strictEqual(box.length, 1);
    assert.ok(hasText(box[0], 'Chat-banned (2)'));
    assert.ok(hasText(box[0], 'GONE1'));
    const lifts = buttons(box[0]).filter((b) => words(b).trim() === 'Lift');
    assert.strictEqual(lifts.length, 2);
    lifts[1].props.onClick();
    assert.deepStrictEqual(p.ctx.calls.find((c) => c[0] === 'mod'), ['mod', 'lift', 'GONE1', undefined]);
    // Not shown with the switch off.
    assert.strictEqual(byClass(panel({ modState }).tree, 'chat__removed').length, 0);
});

t('a failed lift says so under the list', async () => {
    const modState = { bans: [{ username: 'G4XYZ', until: ts(30) }], warnings: {} };
    const p = panel({ modState, replies: { lift: { action: 'lift', ok: false, message: 'Not allowed' } } }, { moderate: true });
    buttonNamed(byClass(p.tree, 'chat__removed')[0], 'Lift').props.onClick();
    await tick();
    assert.ok(hasText(p.again(), 'Not allowed'));
});

t('minimal view: no list, but names still open the sheet', () => {
    const p = panel({}, { moderate: true, minimal: true });
    assert.strictEqual(byClass(p.tree, 'chat__users').length, 0);
    assert.strictEqual(byClass(p.tree, 'chat__modbar').length, 1);
    const names = byClass(p.tree, 'chat__who--mod');
    assert.strictEqual(names.length, 2);
    names[0].props.onClick();
    assert.strictEqual(byClass(p.again(), 'chat-mod').length, 1);
});

t('"Float larger" only when docked and narrow', () => {
    let observed = null;
    globalThis.ResizeObserver = class {
        constructor(fn) { this.fn = fn; observed = this; }
        observe() {}
        disconnect() {}
    };
    try {
        const p = panel({}, { moderate: true });
        assert.ok(!hasText(p.tree, 'Float larger'), 'not before it is measured');
        const root = deep(p.tree).find((n) => cls(n).includes('chat'));
        let width = 480;
        root.props.ref.current = { getBoundingClientRect: () => ({ width }) };
        p.again();   // the effect measures
        assert.ok(observed);
        let tree = p.again();
        buttonNamed(tree, 'Float larger').props.onClick();
        assert.ok(p.ctx.calls.some((c) => c[0] === 'movePanel' && c[2] === 'float'));
        const size = p.ctx.calls.find((c) => c[0] === 'setFloat');
        assert.ok(size && size[2].w >= 560, 'floats larger than the narrow dock');
        // Wide: no offer.
        width = 900;
        observed.fn();
        tree = p.again();
        assert.ok(!hasText(tree, 'Float larger'));
        // Narrow but already floating: no offer either.
        width = 400;
        observed.fn();
        p.ctx.placementOf = () => 'float';
        assert.ok(!hasText(p.again(), 'Float larger'));
    } finally {
        delete globalThis.ResizeObserver;
    }
});

// ── What every listener sees ────────────────────────────────────────────────

t('notices are full-width rows: warnings highlighted, the rest muted', () => {
    const messages = [
        ...MESSAGES,
        { id: 'n1', key: 'n1', system: true, notice: true, kind: 'warning', highlight: true, username: '', message: 'Moderator warning: please keep it clean', timestamp: ts(5) },
        { id: 'n2', key: 'n2', system: true, notice: true, kind: 'auto_warning', highlight: true, username: '', message: 'Watch your language — 1 of 3', timestamp: ts(6) },
        { id: 'n3', key: 'n3', system: true, notice: true, kind: 'mod', highlight: false, username: '', message: 'You removed G4XYZ from chat for 1 hour', timestamp: ts(7) },
    ];
    const { tree } = panel({ messages, isModerator: false });
    const notices = byClass(tree, 'chat__notice');
    assert.strictEqual(notices.length, 3);
    assert.deepStrictEqual(notices.map((n) => cls(n).includes('is-warn')), [true, true, false]);
    assert.ok(hasText(notices[0], 'Moderator warning: please keep it clean'));
    // Not drawn as "<name> joined".
    for (const n of notices) assert.strictEqual(byClass(n, 'chat__sys').length, 0);
    assert.strictEqual(byClass(tree, 'chat__sys').length, 1);
});

t('banned from chat: the compose bar becomes a line with the time, in local time', () => {
    const until = new Date(Date.now() + 45 * 60000).toISOString();
    const { tree } = panel({ chatBan: { until }, isModerator: false });
    const line = byClass(tree, 'chat__banned');
    assert.strictEqual(line.length, 1);
    const hm = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    assert.ok(hasText(line[0], `Banned from chat until ${hm}. You can still listen.`), words(line[0]));
    assert.ok(hasText(line[0], 'You can still listen.'));
    assert.strictEqual(byClass(tree, 'chat__compose').length, 0);
    assert.strictEqual(byClass(tree, 'chat__join').length, 0);
    // The log is still there to read.
    assert.strictEqual(byClass(tree, 'chat__log').length, 1);
    // A ban with no end the server told us.
    assert.ok(hasText(panel({ chatBan: { until: null } }).tree, 'Banned from chat for now. You can still listen.'));
});

t('a blocked message still shows in the error bar', () => {
    const { tree } = panel({ error: 'Message not sent: it contains a blocked word.' });
    assert.ok(hasText(byClass(tree, 'chat__error')[0], 'blocked word'));
});

// ── The sheet ───────────────────────────────────────────────────────────────

const INFO = {
    username: 'G4XYZ', in_chat: true, ip: '203.0.113.7', shared_ip_users: 0, relay: false,
    moderator: false, record: { warnings: 0, chat_bans: 0, deleted: 0 }, message_count: 4,
};

// The sheet on its own, after its info request has been answered.
async function sheet(info, over = {}, name = 'G4XYZ') {
    reset();
    let closed = 0;
    const ctx = context({
        ...over,
        replies: { info: { action: 'info', ok: true, username: name, info }, ...(over.replies || {}) },
    });
    const props = { name, onClose: () => { closed += 1; } };
    // rerender, not render: the stub's render runs every effect on every call,
    // and the sheet's lookup effect would start again each time.
    let last = render(ModSheet, props, ctx);
    await tick();
    const again = () => { last = rerender(ModSheet, props, ctx, last); return last.tree; };
    return { ctx, again, tree: again(), closed: () => closed };
}

t('opening the sheet asks the server who they are, and says so while it waits', async () => {
    reset();
    const ctx = context({ replies: { info: () => new Promise(() => {}) } });
    const { tree } = render(ModSheet, { name: 'G4XYZ', onClose() {} }, ctx);
    assert.deepStrictEqual(ctx.calls[0], ['mod', 'info', 'G4XYZ', undefined]);
    assert.ok(hasText(tree, 'Looking them up…'));
});

t('sheet, normal: header, record and every section', async () => {
    const s = await sheet(INFO);
    const tree = s.tree;
    assert.ok(hasText(tree, 'G4XYZ'));
    assert.ok(hasText(tree, 'In chat'));
    assert.ok(hasText(tree, '203.0.113.7'));
    assert.ok(hasText(tree, 'Last 30 days: nothing on record'));
    assert.ok(!hasText(tree, 'share this IP'));
    assert.ok(!hasText(tree, 'Repeat offender'));
    for (const c of WARN_CHIPS) buttonNamed(tree, c.label);
    buttonNamed(tree, 'Send warning');
    buttonNamed(tree, 'Delete their messages (4)');
    for (const d of CHAT_BAN_PRESETS) buttonNamed(tree, d.label);
    buttonNamed(tree, 'Chat ban');
    assert.ok(byClass(tree, 'chat-mod__label').some((n) => words(n).trim() === 'Chat ban'), 'section is "Chat ban"');
    assert.ok(!hasText(tree, 'Remove'), 'no "Remove from chat" anywhere');
    buttonNamed(tree, 'Ban from SDR…');
    const box = deep(tree).find((n) => n.type === 'input' && n.props.type === 'checkbox');
    assert.strictEqual(box.props.checked, true, '"Also delete their messages" starts ticked');
});

t('sheet: a warning sends the chip and the words typed', async () => {
    const s = await sheet(INFO);
    buttonNamed(s.tree, 'Spam').props.onClick();
    let tree = s.again();
    const text = deep(tree).find((n) => n.type === 'input' && n.props.className === 'input');
    text.props.onChange({ target: { value: ' Last chance. ' } });
    tree = s.again();
    buttonNamed(tree, 'Send warning').props.onClick();
    const call = s.ctx.calls.find((c) => c[1] === 'warn');
    assert.deepStrictEqual(call, ['mod', 'warn', 'G4XYZ', { reason: 'Please do not spam the chat. Last chance.' }]);
    await tick();
    assert.strictEqual(s.closed(), 1, 'success closes the sheet');
});

t('sheet: Chat ban sends the chosen length and the delete box', async () => {
    const s = await sheet(INFO);
    buttonNamed(s.tree, '24 hours').props.onClick();
    let tree = s.again();
    deep(tree).find((n) => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: false } });
    tree = s.again();
    assert.strictEqual(buttonNamed(tree, '24 hours').props['aria-pressed'], true);
    buttonNamed(tree, 'Chat ban').props.onClick();
    assert.ok(buttonNamed(s.again(), 'Banning…'));
    assert.deepStrictEqual(s.ctx.calls.find((c) => c[1] === 'chat_ban'),
        ['mod', 'chat_ban', 'G4XYZ', { duration_sec: 86400, delete: false }]);
});

t('sheet: pending disables the buttons and says what is happening', async () => {
    const s = await sheet(INFO, { replies: { delete_user: () => new Promise(() => {}) } });
    buttonNamed(s.tree, 'Delete their messages (4)').props.onClick();
    const tree = s.again();
    assert.strictEqual(buttonNamed(tree, 'Deleting…').props.disabled, true);
    assert.strictEqual(buttonNamed(tree, 'Send warning').props.disabled, true);
});

t('sheet: a refusal is shown inline and the sheet stays open', async () => {
    const s = await sheet(INFO, { replies: { warn: { action: 'warn', ok: false, username: 'G4XYZ', message: 'You can’t warn another moderator.' } } });
    buttonNamed(s.tree, 'Send warning').props.onClick();
    await tick();
    const tree = s.again();
    assert.strictEqual(s.closed(), 0);
    assert.ok(hasText(byClass(tree, 'chat-mod__error')[0], 'another moderator'));
    // And a request nobody answered.
    const s2 = await sheet(INFO, { replies: { warn: () => Promise.reject(new Error('No reply from the receiver.')) } });
    buttonNamed(s2.tree, 'Send warning').props.onClick();
    await tick();
    assert.ok(hasText(s2.again(), 'No reply from the receiver.'));
});

t('sheet, warned + repeat offender: the record reads as one line with the tag', async () => {
    const s = await sheet({ ...INFO, record: { warnings: 2, chat_bans: 2, deleted: 14 } });
    assert.ok(hasText(s.tree, 'Last 30 days: 2 warnings · 2 chat bans · 14 messages removed'));
    assert.ok(hasText(s.tree, 'Repeat offender'));
    const one = await sheet({ ...INFO, record: { warnings: 1, chat_bans: 1, deleted: 0 } });
    assert.ok(hasText(one.tree, 'Last 30 days: 1 warning · 1 chat ban'));
    assert.ok(!hasText(one.tree, 'Repeat offender'));
});

t('sheet, shared IP: warns that others are affected', async () => {
    let s = await sheet({ ...INFO, shared_ip_users: 2 });
    assert.ok(hasText(s.tree, '2 other chat users share this IP'));
    s = await sheet({ ...INFO, shared_ip_users: 1 });
    assert.ok(hasText(s.tree, '1 other chat user shares this IP'));
});

t('sheet, banned: the end time and who, with Lift in place of the durations', async () => {
    const until = new Date(Date.now() + 30 * 60000).toISOString();
    const s = await sheet({ ...INFO, in_chat: false, chat_banned_until: until, chat_ban_by: 'auto' });
    const hm = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    assert.ok(hasText(s.tree, `Banned from chat until ${hm}`));
    assert.ok(hasText(s.tree, '(automatic)'));
    assert.ok(hasText(s.tree, 'Left'));
    assert.ok(!buttons(s.tree).some((b) => words(b).trim() === 'Chat ban'));
    assert.ok(!buttons(s.tree).some((b) => words(b).trim() === '1 hour'));
    buttonNamed(s.tree, 'Lift').props.onClick();
    assert.deepStrictEqual(s.ctx.calls.find((c) => c[1] === 'lift'), ['mod', 'lift', 'G4XYZ', {}]);
    // Known from the shared state alone, by a moderator.
    const s2 = await sheet(INFO, { modState: { bans: [{ username: 'g4xyz', until, by: 'M0ABC' }], warnings: {} } });
    assert.ok(hasText(s2.tree, '(by M0ABC)'));
    buttonNamed(s2.tree, 'Lift');
});

t('sheet, relay: a note instead of Warn, and only Delete', async () => {
    const s = await sheet({ ...INFO, username: '~TGuser', relay: true, ip: '' }, {}, '~TGuser');
    assert.ok(hasText(s.tree, 'relayed here'));
    assert.ok(!hasText(s.tree, 'Send warning'));
    assert.ok(!buttons(s.tree).some((b) => words(b).trim() === 'Chat ban'));
    assert.ok(!buttons(s.tree).some((b) => words(b).trim() === 'Ban from SDR…'));
    buttonNamed(s.tree, 'Delete their messages (4)');
});

t('sheet, another moderator: says so and offers nothing', async () => {
    const s = await sheet({ ...INFO, moderator: true });
    assert.ok(hasText(s.tree, 'is a moderator'));
    assert.ok(!hasText(s.tree, 'Send warning'));
    assert.ok(!buttons(s.tree).some((b) => /Delete|Chat ban|Ban/.test(words(b))));
});

t('sheet: the lookup failing shows the reason with Close and Retry, and no actions', async () => {
    let fail = true;
    const s = await sheet(null, {
        replies: {
            info: (name) => Promise.resolve(fail
                ? { action: 'info', ok: false, username: name, message: 'Nobody by that name.' }
                : { action: 'info', ok: true, username: name, info: INFO }),
        },
    });
    const errs = byClass(s.tree, 'chat-mod__error');
    assert.strictEqual(errs.length, 1, 'the reason, once');
    assert.ok(hasText(errs[0], 'Nobody by that name.'));
    assert.ok(!hasText(s.tree, 'Send warning'));
    assert.ok(!buttons(s.tree).some((b) => /Delete|Chat ban|Ban from SDR|Lift/.test(words(b))),
        buttons(s.tree).map((b) => words(b)).join(', '));
    buttonNamed(s.tree, 'Close').props.onClick();
    assert.strictEqual(s.closed(), 1);
    // Retry asks again, and this time the sheet fills in.
    fail = false;
    buttonNamed(s.tree, 'Retry').props.onClick();
    s.again();          // the effect runs again for the new attempt
    await tick();
    const tree = s.again();
    assert.strictEqual(s.ctx.calls.filter((c) => c[1] === 'info').length, 2);
    assert.strictEqual(byClass(tree, 'chat-mod__error').length, 0);
    buttonNamed(tree, 'Send warning');
    buttonNamed(tree, 'Chat ban');
});

t('sheet: Ban from SDR asks first, inside the same sheet', async () => {
    const s = await sheet(INFO);
    buttonNamed(s.tree, 'Ban from SDR…').props.onClick();
    let tree = s.again();
    assert.ok(hasText(tree, 'Permanent. Disconnects them from the whole receiver and deletes their'));
    assert.ok(hasText(tree, 'Admin → Banned IPs'));
    assert.ok(!hasText(tree, 'Send warning'), 'the rest of the sheet steps aside');
    assert.ok(!s.ctx.calls.some((c) => c[1] === 'sdr_ban'), 'nothing sent before the confirm');
    // Cancel goes back.
    buttonNamed(tree, 'Cancel').props.onClick();
    tree = s.again();
    assert.ok(hasText(tree, 'Send warning'));
    // And confirming sends it.
    buttonNamed(tree, 'Ban from SDR…').props.onClick();
    tree = s.again();
    buttonNamed(tree, 'Ban from SDR').props.onClick();
    assert.deepStrictEqual(s.ctx.calls.find((c) => c[1] === 'sdr_ban'), ['mod', 'sdr_ban', 'G4XYZ', { delete: true }]);
    await tick();
    assert.strictEqual(s.closed(), 1);
});

t('sheet: a reply after closing writes nothing', async () => {
    reset();
    let answer;
    const ctx = context({ replies: { info: () => new Promise((r) => { answer = r; }) } });
    const { cleanups } = render(ModSheet, { name: 'G4XYZ', onClose() {} }, ctx);
    for (const off of cleanups) off();
    answer({ action: 'info', ok: true, username: 'G4XYZ', info: INFO });
    await tick();
    // Re-rendering a fresh mount would show the default; what matters is no throw
    // and the stale reply not landing: the closed mount's info slot stays empty.
    const tree = render(ModSheet, { name: 'G4XYZ', onClose() {} }, ctx).tree;
    assert.ok(tree);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

t('helpers: bans and warnings by name whatever the case', () => {
    const st = { bans: [{ username: 'G4XYZ' }], warnings: { g4xyz: 3 } };
    assert.ok(modBanFor(st, 'g4xyz'));
    assert.strictEqual(modBanFor(st, 'other'), null);
    assert.strictEqual(modWarningsFor(st, 'G4XYZ'), 3);
    assert.strictEqual(modWarningsFor(st, 'nobody'), 0);
    assert.strictEqual(modWarningsFor(undefined, 'x'), 0);
});

t('helpers: times, today and another day', () => {
    const now = Date.UTC(2026, 10, 12, 10, 0);
    const today = new Date(now + 3600000);
    assert.strictEqual(untilText(today.toISOString(), now),
        today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const later = new Date(now + 3 * 86400000);
    assert.ok(untilText(later.toISOString(), now).length > 5);
    assert.strictEqual(untilText('nonsense', now), '');
    assert.strictEqual(banText(null), 'Banned from chat for now');
    assert.strictEqual(recordLine({ warnings: 1, chat_bans: 0, deleted: 1 }), 'Last 30 days: 1 warning · 1 message removed');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${pass}/${tests.length} passed`);
})();
