// Chat moderation on the client: what the socket turns the server's chat_* messages
// into, what the log does with deletions, syncs and notices, when a chat ban ends,
// and that the provider wires it all up without blanking the panel.

const assert = require('assert');

const store = new Map();
global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
global.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.location = { protocol: 'http:', host: 'rx.test', search: '', pathname: '/' };
global.WebSocket = class { };
global.WebSocket.OPEN = 1;
global.window = global;

const {
    render, rerender, reset, ChatProvider, DXClusterConnection, dxcluster, mod,
} = require('./.build/chatmod.cjs');

let pass = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---- the connection --------------------------------------------------------

const conn = () => {
    const c = new DXClusterConnection();
    const seen = [];
    for (const ev of ['message', 'deleted', 'sync', 'notice', 'moderator', 'modState', 'modResult', 'error']) {
        c.on(ev, (d) => seen.push([ev, d]));
    }
    return { c, seen };
};

t('chat_message carries the server id through, and the welcome has none', () => {
    const { c, seen } = conn();
    c._onMessage({ type: 'chat_message', data: { id: 42, username: 'G4XYZ', message: 'hi', timestamp: 'T' } });
    c._onMessage({ type: 'chat_message', data: { username: 'Server', message: 'welcome', timestamp: 'T' } });
    assert.deepStrictEqual(seen[0], ['message', { id: 42, username: 'G4XYZ', message: 'hi', timestamp: 'T' }]);
    assert.strictEqual(seen[1][1].id, undefined);
});

t('the new chat_ types map to their events', () => {
    const { c, seen } = conn();
    c._onMessage({ type: 'chat_messages_deleted', data: { ids: [1, 2] } });
    c._onMessage({ type: 'chat_sync', data: { min_id: 3, max_id: 9, ids: [3, 5] } });
    c._onMessage({ type: 'chat_sync', data: {} });
    c._onMessage({ type: 'chat_notice', data: { kind: 'warning', text: 'Be nice' } });
    c._onMessage({ type: 'chat_moderator', data: { enabled: true } });
    c._onMessage({ type: 'chat_mod_state', data: { bans: [], warnings: { A: 1 } } });
    c._onMessage({ type: 'chat_mod_result', data: { action: 'warn', ok: true, message: 'm', username: 'A' } });
    assert.deepStrictEqual(seen, [
        ['deleted', [1, 2]],
        ['sync', { min_id: 3, max_id: 9, ids: [3, 5] }],
        ['sync', { min_id: 0, max_id: 0, ids: [] }],
        ['notice', { kind: 'warning', text: 'Be nice' }],
        ['moderator', true],
        ['modState', { bans: [], warnings: { A: 1 } }],
        ['modResult', { action: 'warn', ok: true, message: 'm', username: 'A' }],
    ]);
});

t('chat_error passes its code and until along', () => {
    const { c, seen } = conn();
    c._onMessage({ type: 'chat_error', error: 'Banned', code: 'chat_banned', until: '2030-01-01T00:00:00Z' });
    c._onMessage({ type: 'chat_error', error: 'username not set' });
    assert.deepStrictEqual(seen[0], ['error', { message: 'Banned', code: 'chat_banned', until: '2030-01-01T00:00:00Z' }]);
    assert.deepStrictEqual(seen[1], ['error', { message: 'username not set', code: '', until: '' }]);
});

t('mod() sends chat_mod, and refuses with no socket', () => {
    const { c } = conn();
    assert.strictEqual(c.mod('warn', 'A'), false);
    const sent = [];
    c.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    assert.strictEqual(c.mod('chat_ban', 'G4XYZ', { duration_sec: 3600, reason: 'spam', delete: true }), true);
    assert.deepStrictEqual(sent[0], {
        type: 'chat_mod', action: 'chat_ban', username: 'G4XYZ', duration_sec: 3600, reason: 'spam', delete: true,
    });
    c.ws = null;
});

// ---- the pure bookkeeping --------------------------------------------------

const line = (serverId) => ({ key: `id:${serverId}`, serverId });

t('messageKey: server id when there is one, the old key otherwise', () => {
    assert.strictEqual(mod.messageKey({ id: 7, timestamp: 'T', username: 'A', message: 'x' }), 'id:7');
    assert.strictEqual(mod.messageKey({ timestamp: 'T', username: 'A', message: 'x' }), 'T|A|x');
});

t('applyDeleted removes those ids and leaves id-less lines alone', () => {
    const msgs = [line(1), line(2), { key: 'welcome', serverId: null }, line(3)];
    assert.deepStrictEqual(mod.applyDeleted(msgs, [2, 3]).map((m) => m.key), ['id:1', 'welcome']);
    assert.strictEqual(mod.applyDeleted(msgs, [99]), msgs);
    assert.strictEqual(mod.applyDeleted(msgs, []), msgs);
});

t('applySync drops unlisted ids inside the range only', () => {
    const msgs = [line(1), line(4), line(5), line(6), line(10), { key: 'sys', serverId: null }];
    const out = mod.applySync(msgs, { min_id: 4, max_id: 6, ids: [4, 6] });
    assert.deepStrictEqual(out.map((m) => m.key), ['id:1', 'id:4', 'id:6', 'id:10', 'sys']);
    // An empty buffer drops nothing we hold.
    assert.strictEqual(mod.applySync(msgs, { min_id: 0, max_id: 0, ids: [] }), msgs);
});

t('notices become local system lines; warnings are highlighted', () => {
    const w = mod.noticeLine({ kind: 'warning', text: 'Moderator warning: keep it clean' }, 0);
    assert.strictEqual(w.system, true);
    assert.strictEqual(w.kind, 'warning');
    assert.strictEqual(w.highlight, true);
    assert.strictEqual(w.message, 'Moderator warning: keep it clean');
    assert.strictEqual(w.id, w.key);
    assert.strictEqual(mod.noticeLine({ kind: 'auto_warning', text: 'x' }).highlight, true);
    assert.strictEqual(mod.noticeLine({ kind: 'chat_banned', text: 'x' }).highlight, false);
    assert.notStrictEqual(mod.noticeLine({ kind: 'warning', text: 'a' }, 0).key, w.key);
});

t('ban notices are written here, with the end in local time', () => {
    const now = Date.now();
    const until = new Date(now + 3600000).toISOString();
    const hm = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // The server's text has no time in it any more; ours does, from `until`.
    const b = mod.noticeLine({ kind: 'chat_banned', text: 'You have been banned from chat.', until }, now);
    assert.strictEqual(b.message, `You've been banned from chat until ${hm}. You can still listen to the receiver.`);
    assert.strictEqual(b.kind, 'chat_banned');
    assert.strictEqual(mod.noticeLine({ kind: 'chat_banned', text: 'x' }, now).message,
        "You've been banned from chat for now. You can still listen to the receiver.");
    assert.strictEqual(mod.noticeLine({ kind: 'chat_ban_lifted', text: 'x' }, now).message,
        'Your chat ban has ended. You can chat again.');
    // Everything else is the server's own words.
    assert.strictEqual(mod.noticeLine({ kind: 'auto_warning', text: 'Watch it — 1 of 3' }).message, 'Watch it — 1 of 3');
    // Another day carries the date.
    const later = new Date(now + 3 * 86400000).toISOString();
    assert.ok(mod.untilText(later, now).endsWith(new Date(later).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    assert.ok(mod.untilText(later, now).length > 5);
});

t('chat ban: future until is a ban, past is none, unreadable is open-ended', () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    assert.deepStrictEqual(mod.chatBanFrom('2030-01-01T01:00:00Z', now), { until: '2030-01-01T01:00:00.000Z' });
    assert.strictEqual(mod.chatBanFrom('2029-12-31T23:00:00Z', now), null);
    assert.deepStrictEqual(mod.chatBanFrom('', now), { until: null });
    assert.strictEqual(mod.banDelay({ until: '2030-01-01T01:00:00Z' }, now), 3600000 + mod.BAN_SLACK_MS);
    assert.strictEqual(mod.banDelay({ until: null }, now), null);
    assert.strictEqual(mod.banDelay(null, now), null);
    // Thirty days does not fit setTimeout; it must not fire at once.
    assert.strictEqual(mod.banDelay({ until: '2030-02-15T00:00:00Z' }, now), 2 ** 31 - 1);
});

t('a moderator result leaves a line, except info and failures', () => {
    assert.strictEqual(mod.modResultLine({ action: 'warn', ok: true, message: 'You warned A' }).message, 'You warned A');
    assert.strictEqual(mod.modResultLine({ action: 'warn', ok: true, message: 'x' }).kind, 'mod');
    assert.strictEqual(mod.modResultLine({ action: 'info', ok: true, message: 'x' }), null);
    assert.strictEqual(mod.modResultLine({ action: 'warn', ok: false, message: 'x' }), null);
});

const fakeTimers = () => {
    const timers = new Map();
    let n = 0;
    return {
        timers,
        setTimer: (fn) => { n += 1; timers.set(n, fn); return n; },
        clearTimer: (id) => timers.delete(id),
        fire: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    };
};

t('requests are answered by the matching action and name', async () => {
    const ft = fakeTimers();
    const sent = [];
    const r = mod.createModRequests({ send: (...a) => { sent.push(a); return true; }, ...ft });
    const ban = r.request('chat_ban', 'G4XYZ', { duration_sec: 900 });
    const warn = r.request('warn', 'M0ABC');
    assert.deepStrictEqual(sent[0], ['chat_ban', 'G4XYZ', { duration_sec: 900 }]);
    assert.strictEqual(r.resolve({ action: 'warn', username: 'G4XYZ', ok: true }), false);
    assert.strictEqual(r.resolve({ action: 'warn', username: 'm0abc', ok: true, message: 'w' }), true);
    assert.strictEqual(r.resolve({ action: 'chat_ban', username: 'G4XYZ', ok: false, message: 'no' }), true);
    assert.strictEqual((await warn).message, 'w');
    assert.strictEqual((await ban).ok, false);
    assert.strictEqual(r.size, 0);
    assert.strictEqual(ft.timers.size, 0);
});

t('requests time out with a friendly message, and fail at once when not connected', async () => {
    const ft = fakeTimers();
    const r = mod.createModRequests({ send: () => true, ...ft });
    const p = r.request('warn', 'A');
    ft.fire();
    await assert.rejects(p, /No reply from the receiver/);
    const off = mod.createModRequests({ send: () => false, ...ft });
    await assert.rejects(off.request('warn', 'A'), /Not connected to chat/);
    const lost = r.request('lift', 'B');
    r.rejectAll();
    await assert.rejects(lost, /Connection to chat lost/);
});

// ---- the provider ------------------------------------------------------------

// One object answers every useContext under hookStub, so it carries both the
// radio's and the layout's fields. Not running: nothing acquires the socket.
const ctx = () => ({
    serverInfo: { chat_enabled: true },
    tuning: { frequency: 14074000, mode: 'usb', bandwidthLow: 0, bandwidthHigh: 3000 },
    running: false,
    view: { binCount: 1024, binBandwidth: 10 },
    actions: {},
    sections: {},
});

const mount = () => {
    reset();
    let r = render(ChatProvider, { children: null }, ctx());
    const value = () => r.tree.props.value;
    const again = () => { r = rerender(ChatProvider, { children: null }, ctx(), r); };
    const unmount = () => { for (const off of r.cleanups) off(); };
    return { value, again, unmount };
};

const at = (id, username, message) => ({ id, username, message, timestamp: `2030-01-01T00:00:0${id}Z` });

t('provider renders and exposes the moderation fields', () => {
    const m = mount();
    const v = m.value();
    assert.strictEqual(v.isModerator, false);
    assert.deepStrictEqual(v.modState, { bans: [], warnings: {} });
    assert.strictEqual(v.chatBan, null);
    assert.strictEqual(typeof v.actions.mod, 'function');
    m.unmount();
});

t('provider: replay dedupes by id, delete and sync remove lines', () => {
    const m = mount();
    dxcluster.emit('message', at(1, 'A', 'one'));
    dxcluster.emit('message', at(2, 'B', 'two'));
    dxcluster.emit('message', at(3, 'A', 'three'));
    dxcluster.emit('message', { username: 'Server', message: 'welcome', timestamp: 'W' });
    // The replay again, same ids.
    dxcluster.emit('message', at(1, 'A', 'one'));
    dxcluster.emit('message', at(2, 'B', 'two'));
    m.again();
    assert.deepStrictEqual(m.value().messages.map((x) => x.message), ['one', 'two', 'three', 'welcome']);
    assert.strictEqual(m.value().messages[0].serverId, 1);
    dxcluster.emit('deleted', [2]);
    m.again();
    assert.deepStrictEqual(m.value().messages.map((x) => x.message), ['one', 'three', 'welcome']);
    dxcluster.emit('sync', { min_id: 1, max_id: 3, ids: [3] });
    m.again();
    assert.deepStrictEqual(m.value().messages.map((x) => x.message), ['three', 'welcome']);
    m.unmount();
});

t('provider: notices, moderator state and results', async () => {
    const m = mount();
    dxcluster.emit('notice', { kind: 'warning', text: 'Moderator warning: keep it clean' });
    dxcluster.emit('moderator', true);
    dxcluster.emit('modState', { bans: [{ username: 'X' }], warnings: { X: 2 } });
    m.again();
    const v = m.value();
    const last = v.messages[v.messages.length - 1];
    assert.strictEqual(last.kind, 'warning');
    assert.strictEqual(last.highlight, true);
    assert.strictEqual(v.isModerator, true);
    assert.strictEqual(v.modState.warnings.X, 2);

    const sent = [];
    dxcluster.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
    const p = v.actions.mod('chat_ban', 'G4XYZ', { duration_sec: 3600 });
    assert.strictEqual(sent[0].type, 'chat_mod');
    dxcluster.emit('modResult', { action: 'chat_ban', ok: true, username: 'G4XYZ', message: 'G4XYZ is banned from chat for 1 hour' });
    assert.strictEqual((await p).ok, true);
    m.again();
    const msgs = m.value().messages;
    assert.strictEqual(msgs[msgs.length - 1].message, 'G4XYZ is banned from chat for 1 hour');
    assert.strictEqual(msgs[msgs.length - 1].kind, 'mod');
    dxcluster.ws = null;

    // The socket going ends moderator mode.
    dxcluster.emit('close');
    m.again();
    assert.strictEqual(m.value().isModerator, false);
    assert.deepStrictEqual(m.value().modState, { bans: [], warnings: {} });
    m.unmount();
});

t('provider: a chat_banned error sets the ban and does not re-join', () => {
    const m = mount();
    const sends = [];
    const orig = dxcluster.setUsername;
    dxcluster.setUsername = (n) => { sends.push(n); return true; };
    try {
        store.set('ubersdr.v2.chatName', 'G4XYZ');
        m.unmount();
        const m2 = mount();
        const until = new Date(Date.now() + 3600000).toISOString();
        dxcluster.emit('error', { message: 'You are banned from chat', code: 'chat_banned', until });
        // The error the auto re-join exists for, arriving while banned.
        dxcluster.emit('error', { message: 'username not set', code: '', until: '' });
        m2.again();
        assert.strictEqual(m2.value().chatBan.until, new Date(Date.parse(until)).toISOString());
        assert.deepStrictEqual(sends, []);
        // A (re)subscription while banned: no join is sent, the name is kept.
        dxcluster.emit('subscribed', { stream: 'chat', enabled: true, error: '' });
        m2.again();
        assert.deepStrictEqual(sends, []);
        assert.strictEqual(m2.value().joined, true);
        // Lifted: back in under the same name, once.
        dxcluster.emit('notice', { kind: 'chat_ban_lifted', text: 'You can chat again' });
        dxcluster.emit('notice', { kind: 'chat_ban_lifted', text: 'You can chat again' });
        m2.again();
        assert.strictEqual(m2.value().chatBan, null);
        assert.deepStrictEqual(sends, ['G4XYZ']);
        m2.unmount();
    } finally {
        dxcluster.setUsername = orig;
        store.clear();
    }
});

t('provider: a chat_banned notice sets the ban, the lift clears it', () => {
    const m = mount();
    dxcluster.emit('notice', { kind: 'chat_banned', text: 'Banned from chat until 14:05', until: new Date(Date.now() + 60000).toISOString() });
    m.again();
    assert.ok(m.value().chatBan && m.value().chatBan.until);
    dxcluster.emit('notice', { kind: 'chat_ban_lifted', text: 'You can chat again' });
    m.again();
    assert.strictEqual(m.value().chatBan, null);
    m.unmount();
});

// A remembered name, joined on the subscription, as a reload would have it.
const joinedAs = (name) => {
    store.set('ubersdr.v2.chatName', name);
    const sends = [];
    const orig = dxcluster.setUsername;
    dxcluster.setUsername = (n) => { sends.push(n); return true; };
    const m = mount();
    dxcluster.emit('subscribed', { stream: 'chat', enabled: true, error: '' });
    dxcluster.emit('presence', { kind: 'joined', username: name, timestamp: 'T0' });
    m.again();
    const done = () => { m.unmount(); dxcluster.setUsername = orig; store.clear(); };
    return { m, sends, done };
};

t('provider: "username not set" while chat-banned is swallowed and keeps us joined', () => {
    const { m, sends, done } = joinedAs('G4XYZ');
    try {
        assert.deepStrictEqual(sends, ['G4XYZ']);
        assert.strictEqual(m.value().joined, true);
        dxcluster.emit('notice', { kind: 'chat_banned', text: 'Banned', until: new Date(Date.now() + 60000).toISOString() });
        // The socket reconnects mid-ban and the server no longer has us.
        dxcluster.emit('error', { message: 'username not set', code: '', until: '' });
        dxcluster.emit('error', { message: 'username not set', code: '', until: '' });
        m.again();
        assert.strictEqual(m.value().error, null, 'nothing on screen');
        assert.strictEqual(m.value().joined, true, 'still joined, so the name is kept');
        assert.deepStrictEqual(sends, ['G4XYZ'], 'no re-join during the ban');
        // Lifted: back in under the same name.
        dxcluster.emit('notice', { kind: 'chat_ban_lifted', text: 'x' });
        m.again();
        assert.strictEqual(m.value().chatBan, null);
        assert.deepStrictEqual(sends, ['G4XYZ', 'G4XYZ']);
        const last = m.value().messages[m.value().messages.length - 1];
        assert.strictEqual(last.message, 'Your chat ban has ended. You can chat again.');
    } finally { done(); }
});

t('provider: the ban expiring on its own re-joins after a swallowed error', async () => {
    const { m, sends, done } = joinedAs('G4XYZ');
    try {
        // Already over by the time the timer is set: banDelay is just the slack.
        dxcluster.emit('notice', { kind: 'chat_banned', text: 'Banned', until: new Date(Date.now() + 50).toISOString() });
        dxcluster.emit('error', { message: 'username not set', code: '', until: '' });
        m.again();
        assert.strictEqual(m.value().joined, true);
        m.again();   // runs the ban timer's effect
        await new Promise((r) => setTimeout(r, 50 + mod.BAN_SLACK_MS + 100));
        m.again();
        assert.strictEqual(m.value().chatBan, null);
        assert.deepStrictEqual(sends, ['G4XYZ', 'G4XYZ']);
    } finally { done(); }
});

t('provider: "username not set" with no ban still drops a refused name back to the form', () => {
    const { m, done } = joinedAs('G4XYZ');
    try {
        // Spend the automatic re-joins.
        for (let i = 0; i < 4; i++) {
            dxcluster.emit('presence', { kind: 'joined', username: 'G4XYZ', timestamp: `T${i + 1}` });
            dxcluster.emit('error', { message: 'username not set', code: '', until: '' });
        }
        m.again();
        assert.strictEqual(m.value().error, 'username not set');
        assert.strictEqual(m.value().joined, false);
    } finally { done(); }
});

t('provider: losing moderator after having it leaves one line; never having it, none', () => {
    const m = mount();
    const count = () => m.value().messages.filter((x) => x.kind === 'mod_ended').length;
    // An ordinary listener is told "not a moderator" after every join.
    dxcluster.emit('moderator', false);
    m.again();
    assert.strictEqual(count(), 0);
    dxcluster.emit('moderator', true);
    // A dropped socket is not the server changing its mind.
    dxcluster.emit('close');
    dxcluster.emit('moderator', false);
    m.again();
    assert.strictEqual(count(), 1);
    const line = m.value().messages.find((x) => x.kind === 'mod_ended');
    assert.strictEqual(line.message, 'Your admin sign-in has ended — reload the page to moderate again.');
    assert.strictEqual(line.notice, true);
    assert.strictEqual(m.value().isModerator, false);
    // Said once, not on every later join.
    dxcluster.emit('moderator', false);
    m.again();
    assert.strictEqual(count(), 1);
    m.unmount();
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok    ' + name); pass++; }
        catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e.message)); process.exitCode = 1; }
    }
    console.log(`\n${pass}/${tests.length} chatmod tests passed`);
})();
